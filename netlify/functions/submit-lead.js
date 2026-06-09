/* ============================================================
   submit-lead — server-side lead proxy
   Browser form  ->  this Netlify function  ->  GoHighLevel webhook

   Why this exists:
   The site form used to POST straight to GHL from the browser with
   mode:"no-cors". That made the response opaque, so the page always
   showed "success" even when GHL never ingested the lead. Running the
   call server-side removes the CORS problem entirely (the browser only
   ever talks to our own origin) and lets us read GHL's real response.
   ============================================================ */

const GHL_WEBHOOK_URL =
  "https://services.leadconnectorhq.com/hooks/9bqEMGwXZkp5g248JRl5/webhook-trigger/be6c3724-15f4-43d1-9965-edc009b147be";

exports.handler = async function (event) {
  // Only POST is allowed.
  if (event.httpMethod !== "POST") {
    console.log("[submit-lead] Rejected non-POST method:", event.httpMethod);
    return json(405, { ok: false, error: "Method not allowed" });
  }

  // Read all incoming fields dynamically. The site sends JSON, but we
  // also tolerate form-encoded bodies so this keeps working if the
  // front end ever changes.
  let lead;
  try {
    const raw = event.body || "";
    const ctype = (
      event.headers["content-type"] ||
      event.headers["Content-Type"] ||
      ""
    ).toLowerCase();
    if (ctype.includes("application/json")) {
      lead = JSON.parse(raw || "{}");
    } else {
      lead = Object.fromEntries(new URLSearchParams(raw));
    }
  } catch (err) {
    console.log("[submit-lead] Failed to parse body:", err.message);
    return json(400, { ok: false, error: "Invalid request body" });
  }

  console.log(
    "[submit-lead] Incoming fields:",
    JSON.stringify(Object.keys(lead))
  );

  // Spam guard 1 — honeypot. Bots fill the hidden "company" field; real
  // users never see it. Drop silently (report success, send nothing).
  if (lead.company && String(lead.company).trim() !== "") {
    console.log("[submit-lead] Honeypot tripped — dropping as spam.");
    return json(200, { ok: true, dropped: "spam" });
  }

  // Spam guard 2 — require a real 10-digit US phone so junk never
  // becomes a GHL contact.
  const digitsAll = String(lead.phone || "").replace(/\D/g, "");
  const digits =
    digitsAll.length === 11 && digitsAll[0] === "1"
      ? digitsAll.slice(1)
      : digitsAll;
  if (digits.length !== 10) {
    console.log("[submit-lead] Rejected invalid phone:", lead.phone);
    return json(422, {
      ok: false,
      error: "A valid 10-digit phone number is required.",
    });
  }
  lead.phone_raw = lead.phone;
  lead.phone = "+1" + digits; // normalize to E.164 so GHL dedupes cleanly

  // Stamp server-side context. Don't trust the client for these.
  lead.source = lead.source || "restorationmedix.com";
  lead.submitted_at = new Date().toISOString();

  // Forward EVERY field to GHL as application/x-www-form-urlencoded.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(lead)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }

  console.log(
    "[submit-lead] Forwarding to GHL:",
    JSON.stringify({
      name: lead.name,
      phone: lead.phone,
      service: lead.service,
      zip: lead.zip,
      page: lead.page,
    })
  );

  try {
    const ghlRes = await fetch(GHL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const bodyText = await ghlRes.text();
    console.log(
      "[submit-lead] GHL responded:",
      ghlRes.status,
      bodyText.slice(0, 500)
    );

    if (!ghlRes.ok) {
      return json(502, {
        ok: false,
        error: "Lead service rejected the submission",
        status: ghlRes.status,
      });
    }
    return json(200, { ok: true });
  } catch (err) {
    console.log("[submit-lead] Error forwarding to GHL:", err.message);
    return json(502, { ok: false, error: "Could not reach lead service" });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}
