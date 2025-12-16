async function fetchInviteProfile(waid) {
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
