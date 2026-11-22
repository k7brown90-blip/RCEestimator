/**
 * The ONE composer for the words of a customer text (work order agent-team, addendum 4a/4b, BA7 item 6):
 * shared/sms/compose.ts. Pure, so the card's "Sends as:" preview and the text that goes out can be the same
 * call. Pins the header, the footer rule per class, the double-brand / double-footer refusals and the
 * America/Chicago header time.
 */
import { describe, expect, it } from "vitest";
import { composeSms, formatHeaderWhen, SMS_FOOTER } from "../shared/sms/compose";
import { MESSAGE_CATEGORY_LIST, registryProblems } from "../shared/hub/messageCategories";
import { AUTO_SEND_CATEGORIES } from "../shared/hub/autoSendCategories";
import { cardHeaderLine } from "../shared/hub/cards";

// Mon Nov 23 2026, 8:00-10:00 AM Central (CST, UTC-6).
const START = new Date("2026-11-23T14:00:00Z");
const END = new Date("2026-11-23T16:00:00Z");

const base = { footer: "first" as const, body: "We will be there Monday.", when: { start: START, end: END }, firstText: false };

describe("formatHeaderWhen", () => {
  it("prints a window inside one half of the day the way Kyle wrote it, in Chicago time", () => {
    expect(formatHeaderWhen(START, END)).toBe("Mon 11/23, 8-10 AM");
  });
  it("keeps both meridians when the window crosses noon, and shows minutes only when not zero", () => {
    expect(formatHeaderWhen(new Date("2026-11-23T17:00:00Z"), new Date("2026-11-23T19:30:00Z"))).toBe("Mon 11/23, 11 AM-1:30 PM");
  });
  it("prints a single moment when there is no end", () => {
    expect(formatHeaderWhen(START)).toBe("Mon 11/23, 8 AM");
  });
});

describe("composeSms: transactional", () => {
  it("starts 'Red Cedar Electric: <label> <when>' with the label from the purpose", () => {
    const r = composeSms({ ...base, messageClass: "transactional", purposeKey: "appointment_confirmation" });
    expect(r).toMatchObject({ ok: true, footerIncluded: false });
    if (r.ok) {
      expect(r.header).toBe("Red Cedar Electric: Appointment Confirmation Mon 11/23, 8-10 AM");
      expect(r.text).toBe("Red Cedar Electric: Appointment Confirmation Mon 11/23, 8-10 AM\nWe will be there Monday.");
    }
  });

  it("puts the STOP footer on the first text to a number, and not on later ones", () => {
    const first = composeSms({ ...base, messageClass: "transactional", purposeKey: "consultation", firstText: true });
    const later = composeSms({ ...base, messageClass: "transactional", purposeKey: "consultation", firstText: false });
    expect(first.ok && first.text.endsWith(`\n${SMS_FOOTER}`)).toBe(true);
    expect(first.ok && first.footerIncluded).toBe(true);
    expect(later.ok && later.text.includes("STOP")).toBe(false);
  });

  it("uses an edited label when Kyle has set one, and the default otherwise", () => {
    const r = composeSms({ ...base, messageClass: "transactional", purposeKey: "reschedule", labels: { reschedule: "Moved" } });
    expect(r.ok && r.header.startsWith("Red Cedar Electric: Moved ")).toBe(true);
  });

  it("refuses a transactional text with no purpose, or one that is not a purpose at all", () => {
    expect(composeSms({ ...base, messageClass: "transactional", purposeKey: null })).toMatchObject({ ok: false, reason: "no_purpose" });
    expect(composeSms({ ...base, messageClass: "transactional", purposeKey: "review_request" })).toMatchObject({ ok: false, reason: "no_purpose" });
  });
});

describe("composeSms: marketing and internal", () => {
  it("marketing never wears a job label and always carries the footer, by class", () => {
    const r = composeSms({ ...base, messageClass: "marketing", purposeKey: "consultation", footer: "never", firstText: false });
    expect(r.ok && r.header).toBe("Red Cedar Electric:");
    expect(r.ok && r.text).toBe(`Red Cedar Electric:\nWe will be there Monday.\n${SMS_FOOTER}`);
  });

  it("internal gets the prefix and nothing else, and may quote a customer who typed 'reply stop?'", () => {
    const r = composeSms({ ...base, messageClass: "internal", purposeKey: null, footer: "never", body: 'CUSTOMER SMS — Jane: "reply stop?"' });
    expect(r.ok && r.text).toBe('Red Cedar Electric:\nCUSTOMER SMS — Jane: "reply stop?"');
    expect(r.ok && r.footerIncluded).toBe(false);
  });
});

describe("composeSms: refusals", () => {
  it("refuses a null or unknown class", () => {
    expect(composeSms({ ...base, messageClass: null, purposeKey: "consultation" })).toMatchObject({ ok: false, reason: "no_class" });
    expect(composeSms({ ...base, messageClass: "bogus" as never, purposeKey: "consultation" })).toMatchObject({ ok: false, reason: "no_class" });
  });
  it("refuses a body that already carries the brand or the footer (customer classes only)", () => {
    expect(composeSms({ ...base, messageClass: "transactional", purposeKey: "consultation", body: "Red Cedar Electric: hi" })).toMatchObject({ ok: false, reason: "double_brand" });
    expect(composeSms({ ...base, messageClass: "transactional", purposeKey: "consultation", body: "See you. Reply STOP to opt out." })).toMatchObject({ ok: false, reason: "double_footer" });
    expect(composeSms({ ...base, messageClass: "marketing", purposeKey: null, body: "Reply STOP" })).toMatchObject({ ok: false, reason: "double_footer" });
  });
  it("refuses an empty body", () => {
    expect(composeSms({ ...base, messageClass: "transactional", purposeKey: "consultation", body: "   " })).toMatchObject({ ok: false, reason: "empty_body" });
  });
});

describe("the registry and the card header", () => {
  it("is self-consistent and has no review entry", () => {
    expect(registryProblems()).toEqual([]);
    expect(MESSAGE_CATEGORY_LIST.some((c) => /review/i.test(c.key))).toBe(false);
  });

  it("builds the card's header line from the frozen class and purpose, never from agent words", () => {
    expect(cardHeaderLine({ channel: "sms", messageClass: "transactional", purposeKey: "appointment_confirmation", category: "confirmation_request" }))
      .toBe("Text · Transactional — Appointment Confirmation");
    expect(cardHeaderLine({ channel: "sms", messageClass: "marketing", purposeKey: null, category: null })).toBe("Text · Marketing");
    expect(cardHeaderLine({ channel: "email", messageClass: "transactional", purposeKey: "thread_reply", category: "thread_reply" })).toBe("Email · Transactional — Reply");
    expect(cardHeaderLine({ channel: "in_app", messageClass: null, purposeKey: null, category: null })).toBe("Message · Internal only");
    expect(cardHeaderLine({ channel: "sms", messageClass: null, purposeKey: null, category: null })).toBe("Text · No class set");
  });

  it("autoSendCategories is a filtered view of the registry, not a second list", () => {
    const eligible = MESSAGE_CATEGORY_LIST.filter((c) => c.autoSendEligible).map((c) => c.key);
    expect(AUTO_SEND_CATEGORIES.map((c) => c.key)).toEqual(eligible);
    expect(eligible.length).toBeGreaterThan(0);
  });
});
