const express = require("express");
const app = express();
app.use(express.json({ type: "*/*" }));

console.log("BOOTING APP - index.js - BUILD:", new Date().toISOString());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ED_WA_Verify_2025";
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

let SMARTERASP_API_BASE = process.env.SMARTERASP_API_BASE; // requerido
const SMARTERASP_API_KEY = process.env.SMARTERASP_API_KEY;

// NUEVO: Key para proteger /broadcast/*
const RENDER_BOT_API_KEY = process.env.RENDER_BOT_API_KEY;

const DEBUG_RESET_SESSION = (process.env.DEBUG_RESET_SESSION || "").trim() === "1";

// (opcional) fallback si no está definida
if (!SMARTERASP_API_BASE) {
  SMARTERASP_API_BASE = process.env.SMARTERASP_API_BASE_FALLBACK;
  if (SMARTERASP_API_BASE) {
    console.log("[BOOT] SMARTERASP_API_BASE was undefined, using FALLBACK:", SMARTERASP_API_BASE);
  }
}

// limpiar slash final si lo ponen
if (SMARTERASP_API_BASE && SMARTERASP_API_BASE.endsWith("/")) {
  SMARTERASP_API_BASE = SMARTERASP_API_BASE.slice(0, -1);
}

const sessions = new Map();

// Estado del broadcast (en memoria)
let broadcastJob = null;

app.get("/healthz", (req, res) => res.status(200).send("ok"));

/** =========================
 *  WEBHOOK META
 *  ========================= */
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
  res.sendStatus(200);

  try {
    const body = req.body;

    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const waid = msg.from;
    const text = (msg?.text?.body || "").trim();

    console.log("========== WEBHOOK HIT ==========");
    console.log("[BOT] waid:", waid);
    console.log("[BOT] text:", text);
    console.log("[BOT] DEBUG_RESET_SESSION:", DEBUG_RESET_SESSION);
    console.log("[BOT] SMARTERASP_API_BASE:", SMARTERASP_API_BASE);
    console.log("[BOT] SMARTERASP_API_KEY exists:", !!SMARTERASP_API_KEY);

    let s = sessions.get(waid);

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

    if (!s.profile) {
      console.log("[BOT] calling fetchInviteProfile...");
      s.profile = await fetchInviteProfile(waid, SMARTERASP_API_BASE, SMARTERASP_API_KEY);
      console.log("[BOT] fetchInviteProfile result:", s.profile);
    }

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

        await postRsvpToSmarterAsp(
          { waid, asistira: false, numInvitados: 0, mensaje: "" },
          SMARTERASP_API_BASE,
          SMARTERASP_API_KEY
        );

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

    if (s.state === "RSVP_MSG_DECIDE") {
      if (input === "1") {
        await sendText(waid, "Escribe tu mensaje (máximo 500 caracteres) 🙂");
        s.state = "RSVP_MSG_WRITE";
        console.log("[BOT] state -> RSVP_MSG_WRITE");
        console.log("=================================");
        return;
      }
      if (input === "2") {
        await postRsvpToSmarterAsp(
          { waid, asistira: true, numInvitados: s.temp.numInvitados, mensaje: "" },
          SMARTERASP_API_BASE,
          SMARTERASP_API_KEY
        );

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

    if (s.state === "RSVP_MSG_WRITE") {
      const msgText = (input || "").slice(0, 500);

      await postRsvpToSmarterAsp(
        { waid, asistira: true, numInvitados: s.temp.numInvitados, mensaje: msgText },
        SMARTERASP_API_BASE,
        SMARTERASP_API_KEY
      );

      await sendText(waid, `¡Gracias! 🎉 Confirmación registrada.\n\nMensaje recibido 💌`);
      s.state = "MENU";
      s.temp = {};
      console.log("[BOT] state -> MENU (asiste con mensaje)");
      console.log("=================================");
      return;
    }

    s.state = "MENU";
    await sendText(waid, `¿Te ayudo con algo más? Responde 1, 2 o 3 🙂`);
    console.log("[BOT] fallback -> MENU");
    console.log("=================================");
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

/** =========================
 *  BROADCAST (ENVÍO MASIVO DE PLANTILLAS)
 *  ========================= */

// Auth helper para broadcast
function assertBroadcastAuth(req, res) {
  if (!RENDER_BOT_API_KEY) {
    res.status(500).json({ ok: false, error: "Missing RENDER_BOT_API_KEY in Render env" });
    return false;
  }

  const key = (req.headers["x-api-key"] || req.headers["x-api-key".toLowerCase()] || "").toString().trim();
  if (!key || key !== RENDER_BOT_API_KEY) {
    res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    return false;
  }
  return true;
}

// Status del envío
app.get("/broadcast/status", (req, res) => {
  if (!assertBroadcastAuth(req, res)) return;

  if (!broadcastJob) return res.json({ ok: true, running: false });

  res.json({ ok: true, running: broadcastJob.running, job: broadcastJob });
});

// Iniciar envío masivo
// POST /broadcast/start
// Headers: X-Api-Key: <RENDER_BOT_API_KEY>
// Body JSON:
// {
//   "fromId": 1,
//   "toId": 150,
//   "templateName": "ed_invitation_initial",
//   "languageCode": "en",
//   "batchSize": 20,
//   "pauseSeconds": 45
// }
app.post("/broadcast/start", async (req, res) => {
  if (!assertBroadcastAuth(req, res)) return;

  if (!WA_TOKEN || !PHONE_NUMBER_ID) {
    return res.status(500).json({ ok: false, error: "Missing WA_TOKEN or PHONE_NUMBER_ID" });
  }
  if (!SMARTERASP_API_BASE || !SMARTERASP_API_KEY) {
    return res.status(500).json({ ok: false, error: "Missing SMARTERASP_API_BASE or SMARTERASP_API_KEY" });
  }

  const fromId = Number(req.body?.fromId || 1);
  const toId = Number(req.body?.toId || fromId);
  const templateName = (req.body?.templateName || "").trim();
  const languageCode = (req.body?.languageCode || "").trim();
  const batchSize = Math.max(1, Number(req.body?.batchSize || 20));
  const pauseSeconds = Math.max(0, Number(req.body?.pauseSeconds || 45));
  const onlyNotConfirmed = (req.body?.onlyNotConfirmed === true);

  // Defaults basados en tus plantillas
  const tpl = templateName || "ed_invitation_initial";
  const lang =
    languageCode ||
    (tpl === "ed_invitation_initial" ? "en" : "es_MX"); // tu reminder es Spanish (MEX)

  if (broadcastJob?.running) {
    return res.status(409).json({ ok: false, error: "A broadcast is already running" });
  }

  // 1) Obtener recipients desde SmarterASP
  const recipients = await fetchRecipients(fromId, toId, onlyNotConfirmed, SMARTERASP_API_BASE, SMARTERASP_API_KEY);

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(404).json({ ok: false, error: "No recipients returned from SmarterASP" });
  }

  // 2) Crear job en memoria y arrancarlo async
  broadcastJob = {
    running: true,
    startedAt: new Date().toISOString(),
    fromId,
    toId,
    templateName: tpl,
    languageCode: lang,
    batchSize,
    pauseSeconds,
    total: recipients.length,
    sent: 0,
    failed: 0,
    lastError: null
  };

  // Responder rápido y continuar en background
  res.json({ ok: true, message: "Broadcast started", job: broadcastJob });

  // Ejecutar en background
  (async () => {
    try {
      for (let i = 0; i < recipients.length; i++) {
        const r = recipients[i];

        // Esperamos que tu endpoint mande:
        // r.to  -> ej "5218112275379"
        // r.nombre -> ej "Esmeralda"
        const to = (r?.to || "").toString().trim();
        const nombre = (r?.nombre || "").toString().trim() || "👋";

        if (!to) {
          broadcastJob.failed++;
          continue;
        }

        try {
          await sendTemplate(to, tpl, lang, [nombre]); // {{1}} = Nombre
          broadcastJob.sent++;
        } catch (e) {
          broadcastJob.failed++;
          broadcastJob.lastError = e?.message || String(e);
          console.log("[BROADCAST] Send error:", broadcastJob.lastError);
        }

        // Control por bloques
        const isEndOfBatch = ((i + 1) % batchSize === 0) && (i + 1 < recipients.length);
        if (isEndOfBatch && pauseSeconds > 0) {
          console.log(`[BROADCAST] batch pause ${pauseSeconds}s... sent=${broadcastJob.sent} failed=${broadcastJob.failed}`);
          await sleep(pauseSeconds * 1000);
        }
      }
    } catch (e) {
      broadcastJob.lastError = e?.message || String(e);
      console.log("[BROADCAST] Fatal error:", broadcastJob.lastError);
    } finally {
      broadcastJob.running = false;
      broadcastJob.endedAt = new Date().toISOString();
      console.log("[BROADCAST] DONE. sent=", broadcastJob.sent, "failed=", broadcastJob.failed);
    }
  })();
});

/** =========================
 *  SmarterASP calls
 *  ========================= */

async function fetchInviteProfile(waid, base, key) {
  console.log("[SmarterASP][Invite] ENTER fetchInviteProfile waid =", waid);

  if (!base || !key) {
    console.log("[SmarterASP] Missing base/key");
    return null;
  }

  const url = `${base}/Api/WhatsApp/Invite?waid=${encodeURIComponent(waid)}`;

  let resp;
  let text;
  try {
    resp = await fetch(url, { headers: { "X-API-KEY": key } });
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

async function postRsvpToSmarterAsp(payload, base, key) {
  console.log("[SmarterASP][RSVP] ENTER postRsvpToSmarterAsp payload =", payload);

  if (!base || !key) {
    console.log("[SmarterASP] Missing base/key");
    return;
  }

  const url = `${base}/Api/WhatsApp/RSVP`;

  let resp;
  let text;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "X-API-KEY": key,
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

// NUEVO: obtener recipients para broadcast
async function fetchRecipients(fromId, toId, onlyNotConfirmed, base, key) {
  console.log("[SmarterASP][Recipients] ENTER fetchRecipients", { fromId, toId, onlyNotConfirmed });

  const url =
    `${base}/Api/WhatsApp/Recipients?fromId=${encodeURIComponent(fromId)}&toId=${encodeURIComponent(toId)}` +
    `&onlyActive=true&onlyWithPhone=true&onlyNotConfirmed=${onlyNotConfirmed ? "true" : "false"}`;

  let resp;
  let text;
  try {
    resp = await fetch(url, { headers: { "X-API-KEY": key } });
    text = await resp.text();
  } catch (e) {
    console.log("[SmarterASP][Recipients] Network error:", e?.message || e);
    return null;
  }

  console.log("[SmarterASP][Recipients] url:", url);
  console.log("[SmarterASP][Recipients] status:", resp.status);

  if (!resp.ok) {
    console.log("[SmarterASP][Recipients] body:", text);
    return null;
  }

  try {
    const json = JSON.parse(text);
    const list = json?.recipients || [];
    console.log("[SmarterASP][Recipients] count:", list.length);
    return list;
  } catch (e) {
    console.log("[SmarterASP][Recipients] JSON parse error:", e?.message || e);
    return null;
  }
}

/** =========================
 *  WA send (Text + Template)
 *  ========================= */

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
  console.log("SendText response:", resp.status, data);

  if (!resp.ok) {
    throw new Error(`sendText failed: ${resp.status} ${JSON.stringify(data)}`);
  }
}

// NUEVO: envío de plantilla (template)
// vars[0] -> {{1}} (Nombre)
async function sendTemplate(to, templateName, languageCode, vars = []) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  const components = [];
  if (vars && vars.length > 0) {
    components.push({
      type: "body",
      parameters: vars.map(v => ({ type: "text", text: String(v) }))
    });
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components.length ? { components } : {})
    }
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
  console.log("SendTemplate response:", resp.status, data);

  if (!resp.ok) {
    throw new Error(`sendTemplate failed: ${resp.status} ${JSON.stringify(data)}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Webhook running on port", port));
