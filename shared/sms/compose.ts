/**
 * The ONE composer for the words of a customer text (work order agent-team, addendum 4a/4b and ruling
 * L). A pure function: the same input gives the same text, so the card's "Sends as:" preview and the
 * text that actually goes out come from the SAME call (services/hubSend.ts calls it for both), and
 * sendSms can call it later (U9, batch C5) without a second copy of the rules.
 *
 *   transactional  "Red Cedar Electric: <Label> <date/window>\n<body>"; "Reply STOP to opt out." on the
 *                  first text ever sent to a number (when the send type's footer rule is "first"), or on every text of a
 *                  type whose rule is "always" (the opt-in confirmation).
 *   marketing      "Red Cedar Electric:\n<body>\nReply STOP to opt out." Every marketing text carries the
 *                  footer, by class. It never wears a job label. (Marketing is refused at send until a
 *                  marketing opt-in exists, so this is the shape it will have, not a live text.)
 *   internal       "Red Cedar Electric:\n<body>" and nothing else. An internal text forwards a customer's
 *                  own words, so it is never refused for containing the brand or the footer.
 *
 * The header time prints in America/Chicago, the business's own time (ruling G). A caller never writes
 * the header or the footer itself; a body that already starts with the brand or already carries the
 * footer is REFUSED for the two customer classes (a double header or a double footer is a bug at the
 * caller, and the customer would read it).
 */
import { CALENDAR_DAY_TIME_ZONE } from "../calendarDay";
import type { FooterRule, MessageClass } from "../hub/messageCategories";
import { isSmsPurposeKey, smsPurposeLabel, type SmsPurposeKey } from "./purposes";

export const SMS_BRAND = "Red Cedar Electric:";
export const SMS_FOOTER = "Reply STOP to opt out.";

export interface ComposeSmsInput {
  /** The frozen class of the message. Null (or unknown) is refused: no rule can be applied to it. */
  messageClass: MessageClass | null;
  /** The frozen purpose key (a header label's key). Required for transactional, ignored otherwise. */
  purposeKey: string | null;
  /** The send type's footer rule (shared/hub/messageCategories.ts). A marketing text ignores it: always footer. */
  footer: FooterRule;
  /** The words the person or agent wrote. Never the header, never the footer. */
  body: string;
  /** The date and window the header names (a visit), or the send time when it is not about a visit. */
  when: { start: Date; end?: Date | null };
  /** True when no text has ever gone to this number (the caller decides, deterministically). */
  firstText: boolean;
  /** Edited header labels by purposeKey (Kyle's owner setting, U9). Omitted: the defaults. */
  labels?: Partial<Record<string, string>>;
}

export type ComposeSmsResult =
  | { ok: true; text: string; header: string; footerIncluded: boolean }
  | { ok: false; reason: ComposeRefusal; message: string };

export type ComposeRefusal = "no_class" | "no_purpose" | "empty_body" | "double_brand" | "double_footer";

const BRAND_AT_START = /^\s*red\s+cedar\s+electric\b/i;
const FOOTER_ANYWHERE = /reply\s+stop\b/i;

const clockParts = (d: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { hour: get("hour"), minute: get("minute"), period: get("dayPeriod").toUpperCase() };
};

/** "Mon 11/23" for the day in the business's own zone. */
function dayText(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "numeric", day: "numeric" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("month")}/${get("day")}`;
}

/** "8 AM", or "8:30 AM" when the minutes are not zero. */
function oneClock(d: Date, timeZone: string): string {
  const c = clockParts(d, timeZone);
  return `${c.hour}${c.minute === "00" ? "" : `:${c.minute}`} ${c.period}`;
}

/**
 * The date and time or window a header names: "Mon 11/23, 8-10 AM" for a window inside one half of a
 * day, "Mon 11/23, 11 AM-1 PM" across noon, "Mon 11/23, 8 AM" for a single moment. America/Chicago.
 */
export function formatHeaderWhen(start: Date, end?: Date | null, timeZone: string = CALENDAR_DAY_TIME_ZONE): string {
  const day = dayText(start, timeZone);
  if (!end || end.getTime() <= start.getTime() || dayText(end, timeZone) !== day) return `${day}, ${oneClock(start, timeZone)}`;
  const a = clockParts(start, timeZone);
  const b = clockParts(end, timeZone);
  const from = a.period === b.period ? `${a.hour}${a.minute === "00" ? "" : `:${a.minute}`}` : oneClock(start, timeZone);
  return `${day}, ${from}-${oneClock(end, timeZone)}`;
}

const refuse = (reason: ComposeRefusal, message: string): ComposeSmsResult => ({ ok: false, reason, message });

export function composeSms(input: ComposeSmsInput): ComposeSmsResult {
  const cls = input.messageClass;
  if (cls !== "transactional" && cls !== "marketing" && cls !== "internal") {
    return refuse("no_class", "This text has no class, so no rule can be applied to it.");
  }
  const body = (input.body ?? "").trim();
  if (!body) return refuse("empty_body", "A text needs words.");

  if (cls === "internal") {
    return { ok: true, text: `${SMS_BRAND}\n${body}`, header: SMS_BRAND, footerIncluded: false };
  }

  // The two customer classes: the caller must not have written the header or the footer.
  if (BRAND_AT_START.test(body)) return refuse("double_brand", "The text already starts with the company name. The header is added for you; take it out of the message.");
  if (FOOTER_ANYWHERE.test(body)) return refuse("double_footer", "The text already says \"Reply STOP\". The footer is added for you; take it out of the message.");

  let header = SMS_BRAND;
  let footerIncluded = false;
  if (cls === "transactional") {
    if (!input.purposeKey || !isSmsPurposeKey(input.purposeKey)) return refuse("no_purpose", "This text has no reason label, so it cannot be sent.");
    const label = smsPurposeLabel(input.purposeKey as SmsPurposeKey, input.labels);
    header = `${SMS_BRAND} ${label} ${formatHeaderWhen(input.when.start, input.when.end)}`;
    footerIncluded = input.footer === "always" || (input.footer === "first" && input.firstText);
  } else {
    footerIncluded = true; // every marketing text, by class
  }
  const text = `${header}\n${body}${footerIncluded ? `\n${SMS_FOOTER}` : ""}`;
  return { ok: true, text, header, footerIncluded };
}
