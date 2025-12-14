const express = require("express");
const app = express();

// IMPORTANTÍSIMO: para leer JSON del webhook
app.use(express.json({ type: "*/*" }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ED_WA_Verify_2025";
const WA_TOKEN = process.env.WA_TOKEN; // Token largo (permanente o de sistema)
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // Tu Phone Number ID

app.get("/healthz", (req, res) => res.status(200).send("ok"));

// Verificación de Meta (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Recepción de eventos (POST)
app.post("/webhook", async (req, res) => {
  try {
    // Siempre responde 200 rápido para que Meta no reintente
    res.sendStatus(200);

    const body = req.body;

    // Mensajes entrantes
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from; // wa_id del remitente (ej: 5218112275379)
    const text = msg?.text?.body?.trim() || "";

    // Respuesta simple si escribe AYUDA
    if (text.toUpperCase() === "AYUDA") {
      await sendText(from, "¡Hola! 👋 Soy el bot de E&D. Si quieres confirmar tu asistencia, entra a: https://eduardoydina.edusite.com.mx/");
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

async function sendText(to, message) {
  if (!WA_TOKEN || !PHONE_NUMBER_ID) {
    console.error("Faltan variables de entorno WA_TOKEN o PHONE_NUMBER_ID");
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
