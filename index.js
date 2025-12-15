const express = require("express");
const crypto = require("crypto");

const app = express();

// Para validar firma necesitamos el raw body
app.use(express.json({
  type: "*/*",
  verify: (req, res, buf) => {
    req.rawBody = buf; // buffer crudo
  }
}));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ED_WA_Verify_2025";
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// (Opcional recomendado) App Secret para validar firma
const APP_SECRET = process.env.APP_SECRET || "";

// Utilidad: normalizar texto
function normalizeText(s) {
  return (s || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita acentos
    .toUpperCase();
}

// (Opcional) Validación de firma (X-Hub-Signature-256)
function isValidSignature(req) {
  if (!APP_SECRET) return true; // si no lo pones, no valida
  const sig = req.get("x-hub-signature-256") || "";
  const expected = "sha256=" + crypto
    .createHmac("sha256", APP_SECRET)
    .update(req.rawBody || Buffer.from(""))
    .digest("hex");

  // Comparación segura
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

app.get("/healthz", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) => res.status(200).send("E&D WhatsApp webhook OK"));

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
  // Responde 200 rápido SIEMPRE (Meta odia timeouts)
  res.sendStatus(200);

  try {
    // Validación de firma (si tienes APP_SECRET)
    if (!isValidSignature(req)) {
      console.warn("Firma inválida. Ignorando webhook.");
      return;
    }

    const body = req.body;

    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // 1) A veces llegan status updates (entregados/leídos)
    if (value?.statuses?.length) {
      // Si quieres, loggea algo leve:
      // console.log("Status update:", value.statuses[0]?.status);
      return;
    }

    // 2) Mensajes entrantes
    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from; // wa_id del remitente (ej: 5218112275379)
    const type = msg.type; // text, interactive, etc.

    // Solo manejar texto por ahora
    if (type !== "text") {
      await sendText(from, "Por ahora solo entiendo mensajes de texto. Escribe AYUDA para ver opciones 🙂");
      return;
    }

    const rawText = msg?.text?.body || "";
    const text = normalizeText(rawText);

    // --- Ruteo de comandos ---
    if (text === "AYUDA" || text === "MENU") {
      await sendText(from,
        "¡Hola! 👋 Soy el asistente de Eduardo & Dina.\n\n" +
        "Comandos:\n" +
        "• RSVP / CONFIRMAR – te paso la liga para confirmar\n" +
        "• LINK – liga de la invitación\n" +
        "• HOLA – saludo\n\n" +
        "Liga directa: https://eduardoydina.edusite.com.mx/"
      );
      return;
    }

    if (text === "HOLA" || text === "BUENAS" || text === "HEY") {
      await sendText(from, "¡Hola! 😊 Escribe AYUDA para ver opciones o RSVP para confirmar tu asistencia.");
      return;
    }

    if (text === "RSVP" || text === "CONFIRMAR" || text === "CONFIRMACION") {
      await sendText(from,
        "¡Perfecto! 🎉 Para confirmar tu asistencia entra aquí:\n" +
        "https://eduardoydina.edusite.com.mx/\n\n" +
        "Si tienes tu usuario/clave de invitado, ingrésalos ahí."
      );
      return;
    }

    if (text === "LINK" || text === "LIGA" || text === "INVITACION") {
      await sendText(from, "Aquí está la liga de la invitación 💌:\nhttps://eduardoydina.edusite.com.mx/");
      return;
    }

    // Default (si no entiende)
    await sendText(from, "No entendí ese mensaje 😅 Escribe AYUDA para ver los comandos disponibles.");
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
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  console.log("Send response:", resp.status, data);
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Webhook running on port", port));
