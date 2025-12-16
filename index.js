const express = require("express");
const app = express();

app.use(express.json({ type: "*/*" }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ED_WA_Verify_2025";
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const SMARTERASP_BASE_URL = process.env.SMARTERASP_BASE_URL;
const SMARTERASP_API_KEY = process.env.SMARTERASP_API_KEY;

app.get("/healthz", (req, res) => res.status(200).send("ok"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    res.sendStatus(200);

    const body = req.body;
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from; // wa_id (ej: 5218112275379)

    // Texto normal
    const text = msg?.text?.body?.trim() || "";

    // Quick Reply button
    const quickReplyId = msg?.button?.payload || msg?.interactive?.button_reply?.id || "";
    const quickReplyTitle = msg?.interactive?.button_reply?.title || "";

    const intent =
      (text || "").toUpperCase() ||
      (quickReplyId || "").toUpperCase() ||
      (quickReplyTitle || "").toUpperCase();

    if (intent === "AYUDA") {
      await sendText(from,
        "¡Hola! 👋 Soy el bot de E&D.\n\nPara ver tu invitación, escribe *INVITACION*."
      );
      return;
    }

    if (intent === "INVITACION" || intent === "VER_INVITACION") {
      const data = await getInvite(from);
      if (!data) {
        await sendText(from,
          "Aún no encuentro tu invitación 😕\nConfírmame tu número (con lada) o escríbenos y te ayudamos."
        );
        return;
      }

      const nombre = data.nombre ? ` ${data.nombre}` : "";
      await sendText(from,
        `Perfecto${nombre} 🙌\n\nTu *identificador de invitación* es: *${data.code}*\nEntra aquí: ${data.url}`
      );
      return;
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

async function getInvite(waid) {
  if (!SMARTERASP_BASE_URL || !SMARTERASP_API_KEY) {
    console.error("Faltan SMARTERASP_BASE_URL o SMARTERASP_API_KEY");
    return null;
  }

  const url = `${SMARTERASP_BASE_URL}/Api/WhatsApp/Invite?waid=${encodeURIComponent(waid)}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: { "X-API-KEY": SMARTERASP_API_KEY }
  });

  if (!resp.ok) {
    console.log("Invite lookup failed:", resp.status);
    return null;
  }
  return await resp.json();
}

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
