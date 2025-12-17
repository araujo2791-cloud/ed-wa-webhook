const express = require("express");
const app = express();
app.use(express.json({ type: "*/*" }));

console.log("BOOTING APP - index.js - BUILD:", new Date().toISOString());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ED_WA_Verify_2025";
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WABA_ID = process.env.WABA_ID;

let SMARTERASP_API_BASE = process.env.SMARTERASP_API_BASE;
const SMARTERASP_API_KEY = process.env.SMARTERASP_API_KEY;

const RENDER_BOT_API_KEY = process.env.RENDER_BOT_API_KEY;

const DEBUG_RESET_SESSION = (process.env.DEBUG_RESET_SESSION || "").trim() === "1";

if (!SMARTERASP_API_BASE) {
  SMARTERASP_API_BASE = process.env.SMARTERASP_API_BASE_FALLBACK;
  if (SMARTERASP_API_BASE) {
    console.log("[BOOT] SMARTERASP_API_BASE was undefined, using FALLBACK:", SMARTERASP_API_BASE);
  }
}

if (SMARTERASP_API_BASE && SMARTERASP_API_BASE.endsWith("/")) {
  SMARTERASP_API_BASE = SMARTERASP_API_BASE.slice(0, -1);
}

const sessions = new Map();
let broadcastJob = null;

app.get("/healthz", (req, res) => res.status(200).send("ok"));

function assertBroadcastAuth(req, res) {
  if (!RENDER_BOT_API_KEY) {
    res.status(500).json({ ok: false, error: "Missing RENDER_BOT_API_KEY in Render env" });
    return false;
  }
  const key = (req.headers["x-api-key"] || "").toString().trim();
  if (!key || key !== RENDER_BOT_API_KEY) {
    res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    return false;
  }
  return true;
}

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

    if (!s.profile) {
      console.log("[BOT] calling fetchInviteProfile...");
      s.profile = await fetchInviteProfile(waid, SMARTERASP_API_BASE, SMARTERASP_API_KEY);
      console.log("[BOT] fetchInviteProfile result:", s.profile);
    }

    if (!s.profile) {
      await sendText(waid, "Hola 👋 No encontré tu invitación con este número. Por favor comunícate con Eduardo o Dina para apoyarte.");
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
      return;
    }

    if (s.state === "MENU") {
      if (input === "1" || input.toUpperCase() === "INVITACION") {
        await sendText(waid, `Aquí está tu invitación:\n${link}\n\nTu código de acceso es: *${code}*`);
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
        return;
      }

      await sendText(waid, `Para avanzar responde 1, 2 o 3 🙂`);
      return;
    }

    if (s.state === "RSVP_ASISTE") {
      if (input === "1") {
        s.temp.asistira = true;
        await sendText(waid, `Genial 🎉 ¿Cuántos invitados confirmas? (1 a ${cupo})`);
        s.state = "RSVP_NUM";
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
        return;
      }

      await sendText(waid, `Responde 1 = Sí asistiré o 2 = No podré 🙂`);
      return;
    }

    if (s.state === "RSVP_NUM") {
      const n = parseInt(input, 10);
      if (!Number.isFinite(n) || n < 1 || n > cupo) {
        await sendText(waid, `Por favor envíame un número del 1 al ${cupo}.`);
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
      return;
    }

    if (s.state === "RSVP_MSG_DECIDE") {
      if (input === "1") {
        await sendText(waid, "Escribe tu mensaje (máximo 500 caracteres) 🙂");
        s.state = "RSVP_MSG_WRITE";
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
        return;
      }

      await sendText(waid, `Responde 1 = Escribir mensaje o 2 = Enviar sin mensaje 🙂`);
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
      return;
    }

    s.state = "MENU";
    await sendText(waid, `¿Te ayudo con algo más? Responde 1, 2 o 3 🙂`);
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

/** =========================
 *  DEBUG: listar plantillas visibles para este token/WABA
 *  GET /debug/templates?name=ed_invitation_initial
 *  Header: X-Api-Key: RENDER_BOT_API_KEY
 *  ========================= */
app.get("/debug/templates", async (req, res) => {
  if (!assertBroadcastAuth(req, res)) return;

  if (!WA_TOKEN) return res.status(500).json({ ok: false, error: "Missing WA_TOKEN" });
  if (!WABA_ID) return res.status(500).json({ ok: false, error: "Missing WABA_ID" });

  const name = (req.query?.name || "").toString().trim();
  const baseUrl = `https://graph.facebook.com/v21.0/${WABA_ID}/message_templates`;
  const url = name ? `${baseUrl}?name=${encodeURIComponent(name)}` : baseUrl;

  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` }
    });
    const data = await resp.json();
    return res.status(resp.ok ? 200 : resp.status).json({ ok: resp.ok, url, data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/** =========================
 *  BROADCAST
 *  ========================= */
app.get("/broadcast/status", (req, res) => {
  if (!assertBroadcastAuth(req, res)) return;
  if (!broadcastJob) return res.json({ ok: true, running: false });
  res.json({ ok: true, running: broadcastJob.running, job: broadcastJob });
});

app.post("/broadcast/start", async (req, res) => {
  if (!assertBroadcastAuth(req, res)) return;

  if (!WA_TOKEN || !PHONE_NUMBER_ID) {
    return res.status(500).json({ ok: false, error: "Missing WA_TOKEN or PHONE_NUMBER_ID" });
  }
  if (!SMARTERASP_API_BASE || !SMARTERASP_API_KEY) {
    return res.status(500).json({ ok: false, error: "Missing SMARTERASP_API_BASE or SMARTERASP_API_KEY" });
  }

  const fromId = Number(req.body?.fromId ?? 1);
  const toId = Number(req.body?.toId ?? fromId);

  const templateName = (req.body?.templateName || "").trim();
  const languageCode = (req.body?.languageCode || "").trim();

  const batchSize = Math.max(1, Number(req.body?.batchSize ?? 20));
  const pauseSeconds = Math.max(0, Number(req.body?.pauseSeconds ?? 45));

  const onlyNotConfirmed = (req.body?.onlyNotConfirmed === true);
  const minDaysSinceInitial = Math.max(0, Number(req.body?.minDaysSinceInitial ?? 0));
  const initialTemplateName = (req.body?.initialTemplateName || "ed_invitation_initial").trim();

  const tpl = templateName || "ed_invitation_initial";
  const lang = languageCode || (tpl === "ed_invitation_initial" ? "en_US" : "es_MX");

  if (broadcastJob?.running) {
    return res.status(409).json({ ok: false, error: "A broadcast is already running" });
  }

  const recipients = await fetchRecipients(
    fromId,
    toId,
    onlyNotConfirmed,
    minDaysSinceInitial,
    initialTemplateName,
    SMARTERASP_API_BASE,
    SMARTERASP_API_KEY
  );

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(404).json({ ok: false, error: "No recipients returned from SmarterASP" });
  }

  broadcastJob = {
    running: true,
    startedAt: new Date().toISOString(),
    fromId,
    toId,
    templateName: tpl,
    languageCode: lang,
    batchSize,
    pauseSeconds,
    onlyNotConfirmed,
    minDaysSinceInitial,
    initialTemplateName,
    total: recipients.length,
    sent: 0,
    failed: 0,
    lastError: null
  };

  res.json({ ok: true, message: "Broadcast started", job: broadcastJob });

  (async () => {
    try {
      for (let i = 0; i < recipients.length; i++) {
        const r = recipients[i];

        const to = (r?.to || "").toString().trim();
        const nombre = (r?.nombre || "").toString().trim() || "👋";

        if (!to) {
          broadcastJob.failed++;
          continue;
        }

        try {
          const result = await sendTemplate(to, tpl, lang, [nombre]);
          broadcastJob.sent++;

          await postLogToSmarterAsp({
            usuarioId: r.usuarioId,
            nombreUsuario: r.nombreUsuario,
            waid: null,
            phoneTo: to,
            templateName: tpl,
            languageCode: lang,
            status: "SENT",
            metaMessageId: result?.wamid || null,
            error: ""
          }, SMARTERASP_API_BASE, SMARTERASP_API_KEY);

        } catch (e) {
          broadcastJob.failed++;
          broadcastJob.lastError = e?.message || String(e);

          await postLogToSmarterAsp({
            usuarioId: r.usuarioId,
            nombreUsuario: r.nombreUsuario,
            waid: null,
            phoneTo: to,
            templateName: tpl,
            languageCode: lang,
            status: "FAILED",
            metaMessageId: null,
            error: broadcastJob.lastError
          }, SMARTERASP_API_BASE, SMARTERASP_API_KEY);
        }

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
  if (!base || !key) return null;

  const url = `${base}/Api/WhatsApp/Invite?waid=${encodeURIComponent(waid)}`;

  try {
    const resp = await fetch(url, { headers: { "X-API-KEY": key } });
    const text = await resp.text();
    if (!resp.ok) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function postRsvpToSmarterAsp(payload, base, key) {
  if (!base || !key) return;

  const url = `${base}/Api/WhatsApp/RSVP`;

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "X-API-KEY": key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  } catch {}
}

async function fetchRecipients(fromId, toId, onlyNotConfirmed, minDaysSinceInitial, initialTemplateName, base, key) {
  const url =
    `${base}/Api/WhatsApp/Recipients?fromId=${encodeURIComponent(fromId)}&toId=${encodeURIComponent(toId)}` +
    `&onlyActive=true&onlyWithPhone=true` +
    `&onlyNotConfirmed=${onlyNotConfirmed ? "true" : "false"}` +
    `&minDaysSinceInitial=${encodeURIComponent(minDaysSinceInitial)}` +
    `&initialTemplateName=${encodeURIComponent(initialTemplateName)}`;

  try {
    const resp = await fetch(url, { headers: { "X-API-KEY": key } });
    const text = await resp.text();
    if (!resp.ok) return null;
    const json = JSON.parse(text);
    return json?.recipients || [];
  } catch {
    return null;
  }
}

async function postLogToSmarterAsp(payload, base, key) {
  const url = `${base}/Api/WhatsApp/Log`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "X-API-KEY": key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  } catch {}
}

/** =========================
 *  WA send
 *  ========================= */
async function sendText(to, message) {
  if (!WA_TOKEN || !PHONE_NUMBER_ID) throw new Error("Missing WA_TOKEN or PHONE_NUMBER_ID");
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
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(`sendText failed: ${resp.status} ${JSON.stringify(data)}`);
}

async function sendTemplate(to, templateName, languageCode, vars = []) {
  if (!WA_TOKEN || !PHONE_NUMBER_ID) throw new Error("Missing WA_TOKEN or PHONE_NUMBER_ID");
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
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(`sendTemplate failed: ${resp.status} ${JSON.stringify(data)}`);

  const wamid = data?.messages?.[0]?.id || null;
  return { wamid, raw: data };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Webhook running on port", port));
