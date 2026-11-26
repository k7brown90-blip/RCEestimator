/**
 * Twilio SMS/MMS helper service.
 * Requires env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 *
 * Gracefully degrades if Twilio is not configured — logs warnings instead of throwing.
 */

import { prisma } from "../lib/prisma";
import { logSystemEvent } from "./systemEvents";
import { KYLE_PHONE } from "./kylePhone";
import { hubAudit, isFirstTextTo, last10, logSystemSms, SYSTEM_ACTOR, type SmsLogContext } from "./hub";
import { isInternalSmsNumber, smsBlockReason } from "./smsGuards";
import { getSmsPurposeLabels } from "./ownerSettings";
import { inRehearsal, noteRehearsalSkip } from "./rehearsal";
import { composeSms } from "../../shared/sms/compose";
import { isMessageClass, messageCategoryFor, type MessageClass } from "../../shared/hub/messageCategories";
import { isSendBlockReason, type SendBlockReason } from "../../shared/hub/sendBlocks";

export { KYLE_PHONE };

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
 * The STOP gate for a recipient phone number. (Kyle 2026-11-26: "REMOVE THE SMS CONSENT GATE COMPLETELY ... Keep STOP handling
 * only: if a person replies STOP, mark them opted out and stop texting them. That is the ONLY reason a text should ever be blocked.")
 *
 * The Twilio number is used only to schedule, reschedule and confirm appointments with people who contacted Red Cedar first, so no
 * consent checkbox is needed. `smsConsent` on a Customer or Lead now has ONE meaning: `false` = the person replied STOP
 * (routes/inboundSms.ts writes it, and writes `true` on START); `null` and `true` both mean the person may be texted.
 *
 * A phone number whose LATEST logged STOP/START reply (InboundMessage) is a STOP is "stopped" even if no row says so (a lead created after the STOP). A phone number that matches ANY known Lead or Customer whose `smsConsent` is `false` is "stopped" (a STOP belongs to the person, not
 * to one row, so one stopped row is enough). A number that matches a record and none of them is stopped is "ok". A phone number with NO
 * matching Lead/Customer record at all (e.g. a technician's number, dispatched via the same Twilio line) is "unknown_number" and is left
 * alone here; the hub's send function refuses it outside the 36-hour reply window (services/hubSend.ts).
 *
 * Matching is done on normalized last-10-digits in JS rather than a SQL `contains`, because stored formats vary ("+16155550101" vs
 * "(615) 555-0101") and a punctuated row would slip past a digits-only substring match. The Lead/Customer tables are small, so the
 * full scan is cheap. Exported so the hub's send function asks the SAME question this gate does instead of re-reading the column itself.
 */
export async function smsRecipientStatus(to: string): Promise<"ok" | "stopped" | "unknown_number"> {
  const toDigits = to.replace(/\D/g, "").slice(-10);
  if (toDigits.length < 10) return "unknown_number";

  const [customers, leads, optKeywords] = await Promise.all([
    prisma.customer.findMany({ where: { phone: { not: null } }, select: { phone: true, smsConsent: true } }),
    prisma.lead.findMany({ where: { phone: { not: null } }, select: { phone: true, smsConsent: true } }),
    // The log of STOP / START replies (routes/inboundSms.ts). A STOP from a number that was on no record when it arrived, or whose
    // record was later deleted, sets no row to false; this log is the only place it lives, so it is read here too (the same rule the
    // 20261126100000_sms_stop_only migration uses: the LATEST keyword for the number decides).
    prisma.inboundMessage.findMany({
      where: { handledAs: { in: ["opt_out", "opt_in"] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { fromPhone: true, handledAs: true },
    }),
  ]);

  // A latest STOP for this number blocks it whatever the rows say, including a Lead or Customer created AFTER the STOP.
  const latestKeyword = optKeywords.find((m) => m.fromPhone.replace(/D/g, "").slice(-10) === toDigits);
  if (latestKeyword?.handledAs === "opt_out") return "stopped";

  const matched = [...customers, ...leads].filter((r) => {
    const digits = (r.phone ?? "").replace(/\D/g, "");
    return digits.length >= 10 && digits.slice(-10) === toDigits;
  });

  if (matched.length === 0) return "unknown_number"; // not a known contact - not gated here
  return matched.some((r) => r.smsConsent === false) ? "stopped" : "ok";
}

export async function isStopped(to: string): Promise<boolean> {
  return (await smsRecipientStatus(to)) === "stopped";
}

/**
 * What every text must say about itself (work order agent-team, U9). `messageClass` and `category` are
 * REQUIRED keys of the options object, not a new position: opts stays the third argument (the alerting
 * tests read `calls[0][2]`). The class is checked against the send type's own class in the one registry
 * (shared/hub/messageCategories.ts), and the header label and the footer come from the registry and
 * the one composer (shared/sms/compose.ts), never from the caller.
 */
export interface SmsHubContext extends SmsLogContext {
  /**
   * The reason (header label key) the caller believes this text has. INFORMATION ONLY: the label that
   * prints, and the purposeKey stored, always come from the send type in the registry, so a caller can
   * never choose them. Kept so a refused text can name its reason on the "call or email instead" card
   * (step 6) without that card re-deriving it.
   */
  purposeKey?: string | null;
  /**
   * Only the hub's send function (services/hubSend.ts) sets this: the HubMessage that IS this text.
   * sendSms composes and sends for it but writes no second row, and a refusal is settled on that row
   * by hubSend itself, so there is never a duplicate line or a duplicate audit entry.
   */
  messageId?: string | null;
}

export interface SmsMeta {
  /** transactional, marketing or internal. A text with no class is refused (never thrown). */
  messageClass: MessageClass;
  /** The send type: a key of the registry. Class and purposeKey are derived from it. */
  category: string;
  /** The date or window a transactional header names. Default: the moment of sending. */
  when?: { start: Date; end?: Date | null } | null;
  /** Who the text is about, so it is filed in the right conversation. None: not filed (SystemEvent only). */
  hub?: SmsHubContext;
}

export interface SendSmsOptions extends SmsMeta {
  statusCallback?: string;
}

export interface SmsSent {
  sid: string;
  status?: string;
  /** The exact words that went out: header, body and footer as composed. */
  sentText: string;
  footerIncluded: boolean;
}

/**
 * Send an SMS message via Twilio REST API.
 * Uses fetch directly to avoid requiring the twilio npm package at build time.
 *
 * This is the single choke point for outbound SMS, so every rule is enforced here and no send path needs
 * its own check. A refusal returns null - the value every caller already handles for "Twilio
 * unavailable" - and is NEVER thrown:
 *
 *   1. the class and send type must be present and agree (a text with neither is refused and logged);
 *   2. marketing is refused (no marketing opt-in exists yet);
 *   3. an INTERNAL text goes only to Kyle, the operator alert number or an active technician (ruling A);
 *   4. a customer-class text keeps ONE gate, STOP (Kyle 2026-11-26): a recipient matching a known Lead or Customer that replied STOP
 *      (`smsConsent === false`) is skipped; a lookup that fails also blocks. Nothing else about consent is asked: a lead or customer
 *      who was never asked is textable. There is NO bypass: a direct reply to a text the person just sent is checked too (Kyle 2026-11-26: STOP is the only reason a text is blocked, and it always is);
 *   5. the one opt-out question (smsBlockReason, a stub until step 6);
 *   6. the ONE composer (shared/sms/compose.ts) writes the header and the footer; a body that already
 *      carries either is refused for the two customer classes.
 *
 * A text that goes out comes back as {sid, status, sentText, footerIncluded}. It is then written into the
 * conversation it belongs to (services/hub.ts logSystemSms) AWAITED, not fire-and-forget, so the next
 * text to the same number sees it and the "first text carries Reply STOP" rule is deterministic. A
 * refusal writes a "blocked" line plus ONE send_blocked audit row (never for a text hubSend owns). The
 * env gates that switch a whole leg off live in the callers and write nothing.
 *
 * Inside a rehearsal (services/rehearsal.ts, a test account's approval) nothing is sent at all.
 */
export async function sendSms(
  to: string,
  body: string,
  opts: SendSmsOptions,
): Promise<SmsSent | null> {
  // 1. Meta first: a text that cannot say what it is gets no further, and cannot be logged against a class.
  if (!opts || !isMessageClass(opts.messageClass) || typeof opts.category !== "string" || !opts.category) {
    console.warn("[Twilio] SMS refused: no class or send type was given — skipping send to", to);
    logSystemEvent("warn", "twilio", "SMS refused: it was sent without a class and a send type (nothing was texted)");
    await hubAudit(prisma, {
      actorKey: SYSTEM_ACTOR.key, actorDisplay: SYSTEM_ACTOR.display, action: "send_blocked", entityType: "sms",
      afterText: "no_class", details: { reason: "no_class", messageClass: null, category: null, channel: "sms", toLast4: last10(to)?.slice(-4) ?? null },
    }).catch(() => undefined);
    return null;
  }

  // A rehearsal (a test account's approval) texts nobody.
  if (inRehearsal()) {
    noteRehearsalSkip("sms", `${opts.messageClass} / ${opts.category}`);
    return null;
  }

  const config = getConfig();
  if (!config) {
    console.warn("[Twilio] Not configured — skipping SMS to", to);
    return null;
  }

  const hub = opts.hub;
  const toPhone10 = last10(to);
  const owned = Boolean(hub?.messageId);
  /** A refusal: one console line, one blocked line + one audit row (unless hubSend owns the row), null. */
  const refuse = async (reason: SendBlockReason, note: string): Promise<null> => {
    console.warn(`[Twilio] ${note} — skipping send to`, to);
    if (!owned) {
      await logSystemSms({
        context: hub, to, messageClass: opts.messageClass, category: opts.category, body, outcome: "blocked", blockReason: reason,
      });
    }
    return null;
  };

  const entry = messageCategoryFor(opts.category);
  if (!entry) return refuse("no_class", "SMS has an unknown send type");
  if (entry.messageClass !== opts.messageClass) return refuse("class_mismatch", "SMS class does not match its send type");

  if (opts.messageClass === "marketing") return refuse("marketing_not_opted_in", "Red Cedar never sends marketing by text");

  if (opts.messageClass === "internal") {
    // Ruling A: an internal text skips the STOP gate and the footer, so it may only go to the people
    // who work here. Anyone else (a customer) is refused as internal.
    if (!(await isInternalSmsNumber(to).catch(() => false))) return refuse("internal_not_allowed", "Internal SMS to a number that is not Kyle, the alert number or a technician");
  } else {
    // On a failed lookup, err on the side of NOT texting: a skipped text is recoverable (Kyle calls); a text to someone who
    // replied STOP is the failure this gate exists to prevent.
    const stopped = await isStopped(to).catch((err) => {
      console.error("[Twilio] STOP lookup failed - blocking send to", to, err);
      return true;
    });
    if (stopped) return refuse("replied_stop", "Recipient replied STOP");
    const optedOut = await smsBlockReason(to).catch(() => null);
    if (optedOut) return refuse(isSendBlockReason(optedOut) ? optedOut : "opted_out", "Recipient may not be texted");
  }

  // 6. The words: the ONE composer, the same call the hub's "Sends as:" preview makes, with the same inputs.
  const when = opts.when ?? { start: new Date() };
  const firstText = opts.messageClass === "internal" || !toPhone10
    ? true
    : await isFirstTextTo(prisma, toPhone10, { id: hub?.messageId ?? null }).catch(() => true);
  const composed = composeSms({
    messageClass: opts.messageClass, purposeKey: entry.purposeKey, footer: entry.footer, body,
    when, firstText, labels: await getSmsPurposeLabels().catch(() => undefined),
  });
  if (!composed.ok) return refuse(composed.reason, `SMS refused by the composer (${composed.reason})`);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");

  const params = new URLSearchParams({
    To: to,
    From: config.phoneNumber,
    Body: composed.text,
  });
  if (opts.statusCallback) params.append("StatusCallback", opts.statusCallback);

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
    // Persisted, not just consoled — SMS failures are silent by design at the
    // call sites (fire-and-forget), which is exactly how a broken send path
    // stays invisible for weeks. The event row is the tripwire.
    logSystemEvent("error", "twilio", `SMS send failed (HTTP ${res.status}) to ${to}`, {
      status: res.status,
      response: text.slice(0, 2000),
    });
    return null;
  }

  const data = await res.json() as { sid: string; status?: string };
  if (!owned) {
    await logSystemSms({
      context: hub, to, messageClass: opts.messageClass, category: opts.category, body, outcome: "sent",
      sentText: composed.text, footerIncluded: composed.footerIncluded, headerAt: when.start,
      eventStart: opts.when ? opts.when.start : null, eventEnd: opts.when?.end ?? null, providerMessageId: data.sid,
    });
  }
  return { sid: data.sid, status: data.status, sentText: composed.text, footerIncluded: composed.footerIncluded };
}

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
