/**
 * Twilio SMS/MMS helper service.
 * Requires env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 *
 * Gracefully degrades if Twilio is not configured — logs warnings instead of throwing.
 */

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
}

function getConfig(): TwilioConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  // Prefer TWILIO_SMS_NUMBER (615 SMS line) over TWILIO_PHONE_NUMBER (731 voice line)
  const phoneNumber = process.env.TWILIO_SMS_NUMBER ?? process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !phoneNumber) {
    return null;
  }

  return { accountSid, authToken, phoneNumber };
}

/**
 * Send an SMS message via Twilio REST API.
 * Uses fetch directly to avoid requiring the twilio npm package at build time.
 */
export async function sendSms(to: string, body: string): Promise<{ sid: string } | null> {
  const config = getConfig();
  if (!config) {
    console.warn("[Twilio] Not configured — skipping SMS to", to);
    return null;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");

  const params = new URLSearchParams({
    To: to,
    From: config.phoneNumber,
    Body: body,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[Twilio] Failed to send SMS:", res.status, text);
    return null;
  }

  const data = await res.json() as { sid: string };
  return { sid: data.sid };
}

/** Kyle's phone number — the only number that can dispatch via SMS */
export const KYLE_PHONE = "+19706661626";

/**
 * Validate an inbound Twilio webhook request.
 * For now, just checks that the From number matches Kyle's.
 * TODO: Add Twilio signature validation for production security.
 */
export function isFromKyle(from: string): boolean {
  // Normalize: strip spaces, dashes, parens
  const normalized = from.replace(/[\s\-()]/g, "");
  return normalized === KYLE_PHONE || normalized === "9706661626" || normalized === "+19706661626";
}
