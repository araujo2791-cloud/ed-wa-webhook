const express = require("express");
const app = express();
app.use(express.json({ type: "*/*" }));

// ===== BOOT LOG (sirve para confirmar que Render corre ESTE archivo) =====
console.log("BOOTING APP - index.js - BUILD:", new Date().toISOString());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ED_WA_Verify_2025";
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const SMARTERASP_API_BASE = process.env.SMARTERASP_API_BASE; // https://eduardoydina.edusite.com.mx
const SMARTERASP_API_KEY = process.env.SMARTERASP_API_KEY;   // tu SmarterAspApiKey

// DEBUG: si pones DEBUG_RESET_SESSION=1, el bot reinicia sesión en cada mensaje
const DEBUG_RESET_SESSION = (process.env.DEBUG_RESET_SESSION || "").trim() === "1";

// Sesiones en RAM
const sessions = new Map();

app.get("/healthz", (req, res) => res.status(200).send("ok"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  // Responde 200 rápido
  res.sendStatus(200);

  try {
    const body = req.body;

    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const waid = msg.from; // ej: 5218112275379
    const text = (msg?.text?.body || "").trim();

    // ===== logs obligatorios =====
    console.log("========== WEBHOOK HIT ==========");
    console.log("[BOT] waid:", waid);
    console.log("[BOT] text:", text);
    console.log("[BOT] DEBUG_RESET_SESSION:", DEBUG_RESET_SESSION);
    console.log("[BOT] SMARTERASP_API_BASE:", SMARTERASP_API_BASE);
    console.log("[BOT] SMARTERASP_API_KEY exists:", !!SMARTERASP_API_KEY);

    // Obtén sesión
    let s = sessions.get(waid);

    // Si quieres reiniciar siempre (para pruebas)
    if (DEBUG_RESET_SESSION && s) {
      sessions.delete(waid);
      s = null;
      console.log("[BOT] Session RESET for waid:", waid);
    }

    if (!s) {
      s = { state: "NEW", profile: null, temp: {} };
      sessions.set(waid, s);
    }

    console.log("[BOT] state:", s.state);
    console.log("[BOT] hasProfileBefore:", !!s.profile);

    // Cargar perfil si no existe
    if (!s.profile) {
      console.log("[BOT] calling fetchInviteProfile...");
      s.profile = await fetchInviteProfile(waid);
      console.log("[BOT] fetchInviteProfile result:", s.profile);
    }

    // Si no está registrado
    if (!s.profile) {
      await sendText(waid, "Hola 👋 No encontré tu invitación con este número. Por favor comunícate con Eduardo o Dina para apoyarte.");
      console.log("=================================");
      return;
    }

    const nombre = s.profile.nombre || "👋";
    const code = s.profile.code || "";
    const link = s.profile.url || "https://eduardoydina.edusite.com.mx/";
    const cupo = Number(s.profile.cupoInvitados || 1);

    const input = text;

    // START
    if (s.state === "NEW") {
      await sendText(
        waid,
        `Hola ${nombre} 👋 Soy *E&D Assistant*.

¿Qué te gustaría hacer?
1) Ver invitación
2) Confirmar asistencia (RSVP)
3) Ayuda`
      );
      s.state = "MENU";
      console.log("[BOT] state -> MENU");
      console.log("=================================");
      return;
    }

    // MENU
    if (s.state === "MENU") {
      if (input === "1") {
        await sendText(waid, `Aquí está tu invitación:\n${link}\n\nTu código de acceso es: *${code}*`);
        console.log("=================================");
        return;
      }
      if (input === "2") {
        await sendText(
          waid,
          `Perfecto ✅
¿Podrás asistir?

1) Sí asistiré
2) Lo siento, no podré`
        );
        s.state = "RSVP_ASISTE";
        console.log("[BOT] state -> RSVP_ASISTE");
        console.log("=================================");
        return;
      }
      if (input === "3" || input.toUpperCase() === "AYUDA") {
        await sendText(
          waid,
          `Claro 🙂 Responde con:
1 = Ver invitación
2 = Confirmar asistencia

O dime tu duda y te ayudo.`
        );
        console.log("=================================");
        return;
      }

      await sendText(waid, `Para avanzar responde 1, 2 o 3 🙂`);
      console.log("=================================");
      return;
    }

    // RSVP: ASISTE?
    if (s.state === "RSVP_ASISTE") {
      if (input === "1") {
        s.temp.asistira = true;
        await sendText(waid, `Genial 🎉 ¿Cuántos invitados confirmas? (1 a ${cupo})`);
        s.state = "RSVP_NUM";
        console.log("[BOT] state -> RSVP_NUM");
        console.log("=================================");
        return;
      }
      if (input === "2") {
        s.temp.asistira = false;

        await postRsvpToSmarterAsp({
          waid,
          asistira: false,
          numInvitados: 0,
          mensaje: ""
        });

        await sendText(waid, `Gracias por avisarnos, ${nombre} 🙏 Si cambias de plan, aquí estaré.`);
        s.state = "MENU";
        s.temp = {};
        console.log("[BOT] state -> MENU (no asiste)");
        console.log("=================================");
        return;
      }

      await sendText(waid, `Responde 1 = Sí asistiré o 2 = No podré 🙂`);
      console.log("=================================");
      return;
    }

    // RSVP: NUM INVITADOS
    if (s.state === "RSVP_NUM") {
      const n = parseInt(input, 10);
      if (!Number.isFinite(n) || n < 1 || n > cupo) {
        await sendText(waid, `Por favor envíame un número del 1 al ${cupo}.`);
        console.log("=================================");
        return;
      }

      s.temp.numInvitados = n;

      await sendText(
        waid,
        `Perfecto ✅ Confirmas *${n}* invitado(s).
¿Quieres dejar un mensaje para los novios? (opcional)

1) Sí, escribir mensaje
2) No, enviar sin mensaje`
      );
      s.state = "RSVP_MSG_DECIDE";
      console.log("[BOT] state -> RSVP_MSG_DECIDE");
      console.log("=================================");
      return;
    }

    // RSVP: QUIERE MENSAJE?
    if (s.state === "RSVP_MSG_DECIDE") {
      if (input === "1") {
        await sendText(waid, "Escribe tu mensaje (máximo 500 caracteres) 🙂");
        s.state = "RSVP_MSG_WRITE";
        console.log("[BOT] state -> RSVP_MSG_WRITE");
        console.log("=================================");
        return;
      }
      if (input === "2") {
        await postRsvpToSmarterAsp({
          waid,
          asistira: true,
          numInvitados: s.temp.numInvitados,
          mensaje: ""
        });

        await sendText(waid, `¡Listo! 🎉 Confirmación registrada.\n\nNos vemos en la boda 💛`);
        s.state = "MENU";
        s.temp = {};
        console.log("[BOT] state -> MENU (asiste sin mensaje)");
        console.log("=================================");
        return;
      }

      await sendText(waid, `Responde 1 = Escribir mensaje o 2 = Enviar sin mensaje 🙂`);
      console.log("=================================");
      return;
    }

    // RSVP: CAPTURA MENSAJE
    if (s.state === "RSVP_MSG_WRITE") {
      const msgText = (input || "").slice(0, 500);

      await postRsvpToSmarterAsp({
        waid,
        asistira: true,
        numInvitados: s.temp.numInvitados,
        mensaje: msgText
      });

      await sendText(waid, `¡Gracias! 🎉 Confirmación registrada.\n\nMensaje recibido 💌`);
      s.state = "MENU";
      s.temp = {};
      console.log("[BOT] state -> MENU (asiste con mensaje)");
      console.log("=================================");
      return;
    }

    // fallback
    s.state = "MENU";
    await sendText(waid, `¿Te ayudo con algo más? Responde 1, 2 o 3 🙂`);
    console.log("[BOT] fallback -> MENU");
    console.log("=================================");
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

// === SmarterASP calls ===
async function fetchInviteProfile(waid) {
  console.log("[SmarterASP][Invite] ENTER fetchInviteProfile waid =", waid);

  if (!SMARTERASP_API_BASE || !SMARTERASP_API_KEY) {
    console.log("[SmarterASP] Missing base/key");
    return null;
  }

  const url = `${SMARTERASP_API_BASE}/Api/WhatsApp/Invite?waid=${encodeURIComponent(waid)}`;

  let resp;
  let text;
  try {
    resp = await fetch(url, { headers: { "X-API-KEY": SMARTERASP_API_KEY } });
    text = await resp.text();
  } catch (e) {
    console.log("[SmarterASP][Invite] Network error:", e?.message || e);
    return null;
  }

  console.log("[SmarterASP][Invite] url:", url);
  console.log("[SmarterASP][Invite] status:", resp.status);
  console.log("[SmarterASP][Invite] body:", text);

  if (!resp.ok) return null;

  try {
    return JSON.parse(text);
  } catch (e) {
    console.log("[SmarterASP][Invite] JSON parse error:", e?.message || e);
    return null;
  }
}

async function postRsvpToSmarterAsp(payload) {
  console.log("[SmarterASP][RSVP] ENTER postRsvpToSmarterAsp payload =", payload);

  if (!SMARTERASP_API_BASE || !SMARTERASP_API_KEY) {
    console.log("[SmarterASP] Missing base/key");
    return;
  }

  const url = `${SMARTERASP_API_BASE}/Api/WhatsApp/RSVP`;

  let resp;
  let text;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "X-API-KEY": SMARTERASP_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    text = await resp.text();
  } catch (e) {
    console.log("[SmarterASP][RSVP] Network error:", e?.message || e);
    return;
  }

  console.log("[SmarterASP][RSVP] url:", url);
  console.log("[SmarterASP][RSVP] status:", resp.status);
  console.log("[SmarterASP][RSVP] body:", text);
}

// === WA send ===
async function sendText(to, message) {
  if (!WA_TOKEN || !PHONE_NUMBER_ID) {
    console.error("Faltan variables WA_TOKEN o PHONE_NUMBER_ID");
    return;
  }

  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: message }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  console.log("Send response:", resp.status, data);
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Webhook running on port", port));
