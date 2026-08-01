/**
 * Twilio SMS/MMS helper service.
 * Requires env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 *
 * Gracefully degrades if Twilio is not configured — logs warnings instead of throwing.
 */

import { prisma } from "../lib/prisma";

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
 * Consent gate for a recipient phone number.
 *
 * The website's SMS consent checkbox is the ONLY opt-in channel we tell
 * customers (and Twilio's A2P reviewers) about — there is no verbal opt-in
 * flow anywhere in the call system, so the code must not behave as if there
 * were one. A phone number that matches a known Lead or Customer is therefore
 * blocked unless that record's `smsConsent` is explicitly `true`; `false` and
 * `null` ("never asked") are both treated as "not opted in."
 *
 * A phone number with NO matching Lead/Customer record at all (e.g. a
 * technician's number, dispatched via the same Twilio line) is not a consumer
 * consent scenario and is left alone — this function only governs sends to
 * people in the CRM.
 *
 * Matching is done on normalized last-10-digits in JS rather than a SQL
 * `contains`, because stored formats vary ("+16155550101" vs
 * "(615) 555-0101") and a punctuated row would slip past a digits-only
 * substring match. The Lead/Customer tables are small, so the full scan is cheap.
 */
async function isBlockedByConsent(to: string): Promise<boolean> {
  const toDigits = to.replace(/\D/g, "").slice(-10);
  if (toDigits.length < 10) return false;

  const [customers, leads] = await Promise.all([
    prisma.customer.findMany({ where: { phone: { not: null } }, select: { phone: true, smsConsent: true } }),
    prisma.lead.findMany({ where: { phone: { not: null } }, select: { phone: true, smsConsent: true } }),
  ]);

  const matched = [...customers, ...leads].find((r) => {
    const digits = (r.phone ?? "").replace(/\D/g, "");
    return digits.length >= 10 && digits.slice(-10) === toDigits;
  });

  if (!matched) return false; // not a known consumer contact — not gated here
  return matched.smsConsent !== true;
}

/**
 * Send an SMS message via Twilio REST API.
 * Uses fetch directly to avoid requiring the twilio npm package at build time.
 *
 * This is the single choke point for outbound SMS, so consent is enforced here:
 * a recipient matching a known Lead or Customer whose `smsConsent` is not
 * `true` is skipped and the call returns null — the same value every caller
 * already handles for "Twilio unavailable", so no send path needs its own
 * check. This is a default-deny gate (matches our compliance filing's claim
 * that the website checkbox is the only opt-in channel), not a decline-only
 * gate — a phone lead who was simply never asked does not get texted either.
 *
 * `bypassConsentCheck` is for direct replies to a message the recipient just
 * sent us (the inbound-SMS router) — answering an inbound text is not a
 * campaign message. Sends to Kyle are always internal and never gated.
 */
export async function sendSms(
  to: string,
  body: string,
  opts?: { bypassConsentCheck?: boolean },
): Promise<{ sid: string } | null> {
  const config = getConfig();
  if (!config) {
    console.warn("[Twilio] Not configured — skipping SMS to", to);
    return null;
  }

  const isInternal = to.replace(/\D/g, "").slice(-10) === KYLE_PHONE.replace(/\D/g, "").slice(-10);
  if (!isInternal && !opts?.bypassConsentCheck) {
    // On a failed lookup, err on the side of NOT texting — a skipped
    // confirmation is recoverable (Kyle calls); a send to someone who hasn't
    // opted in is the compliance failure this gate exists to prevent.
    const blocked = await isBlockedByConsent(to).catch((err) => {
      console.error("[Twilio] Consent lookup failed — blocking send to", to, err);
      return true;
    });
    if (blocked) {
      console.warn("[Twilio] Recipient has not opted in to SMS — skipping send to", to);
      return null;
    }
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
 * Download an MMS media attachment from Twilio's media URL (requires basic
 * auth with the account credentials). Returns null when Twilio is not
 * configured or the fetch fails.
 */
export async function fetchTwilioMedia(mediaUrl: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const config = getConfig();
  if (!config) {
    console.warn("[Twilio] Not configured — cannot fetch media", mediaUrl);
    return null;
  }
  // Only ever fetch from Twilio's own API host — the URL arrives from an
  // inbound webhook and must not become an SSRF vector.
  let parsed: URL;
  try {
    parsed = new URL(mediaUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.twilio.com") {
    console.warn("[Twilio] Refusing to fetch media from non-Twilio URL:", mediaUrl);
    return null;
  }

  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
  const res = await fetch(parsed.toString(), { headers: { Authorization: `Basic ${auth}` }, redirect: "follow" });
  if (!res.ok) {
    console.error("[Twilio] Media fetch failed:", res.status);
    return null;
  }
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

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
