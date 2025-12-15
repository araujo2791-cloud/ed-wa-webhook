const express = require("express");
const crypto = require("crypto");

const app = express();

// Guardamos el raw body para validar firma
app.use(express.json({
  type: "*/*",
  verify: (req, res, buf) => {
    req.rawBody = buf; // Buffer crudo
  }
}));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ED_WA_Verify_2025";
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ✅ App Secret (para validar X-Hub-Signature-256)
const APP_SECRET = process.env.APP_SECRET;

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

// 🔐 Validar firma del request (POST) usando App Secret
function isValidSignature(req) {
  // Si no hay APP_SECRET configurado, no podemos validar => rechazamos
  if (!APP_SECRET) return false;

  const signatureHeader = req.get("x-hub-signature-256") || "";
  if (!signatureHeader.startsWith("sha256=")) return false;

  const raw = req.rawBody || Buffer.from("");

  const expected = "sha256=" + crypto
    .createHmac("sha256", APP_SECRET)
    .update(raw)
    .digest("hex");

  // Comparación segura (evita ataques de timing)
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

// Recepción de eventos (POST)
app.post("/webhook", async (req, res) => {
  try {
    // Siempre responde rápido para que Meta no reintente
    res.sendStatus(200);

    // ✅ Validación estricta
    const ok = isValidSignature(req);
    if (!ok) {
      console.warn("Firma inválida o APP_SECRET no configurado. Ignorando request.");
      return;
    }

    const body = req.body;

    // WhatsApp manda a veces statuses (entregado/leído). Ignóralos.
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (value?.statuses?.length) {
      // console.log("Status update:", value.statuses[0]?.status);
      return;
    }

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from; // wa_id del remitente
    const text = msg?.text?.body?.trim() || "";

    // Respuesta simple si escribe AYUDA
    if (text.toUpperCase() === "AYUDA") {
      await sendText(
        from,
        "¡Hola! 👋 Soy el asistente de Eduardo y Dina - E&D.\n\n" +
        "Para confirmar tu asistencia entra a:\n" +
        "https://eduardoydina.edusite.com.mx/"
      );
    } else {
      await sendText(from, "Escribe *AYUDA* para ver opciones 🙂");
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
