import { afterAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { prisma } from "../src/lib/prisma";
import {
  abaValid, agentDateTime, agentRespond, authorFirstName, decodeCursor, encodeCursor, isSensitiveKey, KEYSET_ORDER_BY,
  luhnValid, paginate, pageParamsSchema, scrub, scrubMessageText, scrubTrainingText, type AgentToolOutput,
} from "../src/agentApi/respond";
import { marketingOriginalSchema, projectMessageRead, projectScoutTrainingMessage } from "../src/agentApi/profiles";
import { AGENT_ERRORS, AgentApiError, toAgentError } from "../src/agentApi/errors";
import { chicagoToday, dayOf, toChicagoIso } from "../shared/calendarDay";
import { makePerson, cleanupCrmLoginFixtures } from "./helpers/crmLoginFixture";

/**
 * Work order agent-team, K-U4: ONE response layer. Field profiles are zod schemas (stripping is the
 * allowlist), scrub() removes secrets and, for restricted profiles, contact details, and every key
 * gets ONE message profile (team answer 4) that never shows a customer's phone, email or street.
 */

afterAll(cleanupCrmLoginFixtures);

const PLANTED = {
  ein: "47-1234567",
  routing: "021000021",
  account: "account number 000123456789",
  card: "4242 4242 4242 4242",
  card2: "4111111111111111",
  ending: "Visa ending 4242",
  stripeFa: "fa_1Nabc123XyZ456",
  stripeAcct: "acct_1Nabc123XyZ",
  whsec: "whsec_Abc123def456Ghi789",
  sk: "sk_live_AbCdEf1234567890",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.sig_ABC-123",
  techToken: "TechTok3nAbCdEfGhIjKlMnOpQrStUv12",
  agentKey: "rce_live_" + "AbCd1234".repeat(5) + "xyz",
  qr: "QRPAYLOAD-ABCDEFGH-12345678",
  qrUrl: "https://crm.example.com/pay/QRPAYLOAD-ABCDEFGH-12345678",
  unsub: "UnsubT0kenAbCdEfGhIjKlMnOpQ12345",
  hex: "a3f5c9d2b8e14f6a9c0d7e8f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
};

function fixture() {
  return {
    id: "ckabc123def456ghi789jkl01",
    nested: {
      note: `Customer paid with ${PLANTED.card} and ${PLANTED.card2}. ${PLANTED.ending}. EIN ${PLANTED.ein}. Routing ${PLANTED.routing}. ${PLANTED.account}.`,
      ids: [PLANTED.stripeFa, PLANTED.stripeAcct, PLANTED.whsec, PLANTED.sk],
      tokenText: `jwt ${PLANTED.jwt} tech ${PLANTED.techToken} key ${PLANTED.agentKey} hex ${PLANTED.hex} unsub ${PLANTED.unsub}`,
      deeper: [{ text: `scan ${PLANTED.qrUrl}` }],
    },
    qr: PLANTED.qr,
    unsubscribeToken: PLANTED.unsub,
    passwordHash: "$2a$10$abcdefghijklmnopqrstuv",
    stripeCustomerId: "cus_ABCDEFGH12345",
    accessToken: PLANTED.techToken,
    last4: "4242",
    routingNumber: PLANTED.routing,
    pin: "1234",
    shipping: "FedEx", // "pin" inside "shipping" must NOT drop the key
    mapping: "kept",
  };
}

const NEVER: string[] = [
  PLANTED.ein, PLANTED.routing, "000123456789", "4242 4242 4242 4242", "4111111111111111", "ending 4242", PLANTED.stripeFa,
  PLANTED.stripeAcct, PLANTED.whsec, PLANTED.sk, PLANTED.jwt, PLANTED.techToken, PLANTED.agentKey, PLANTED.qr, PLANTED.unsub, PLANTED.hex,
];

describe("scrub(): secrets never survive, for any profile", () => {
  it.each([[false], [true]])("withholdContact=%s: no planted secret survives anywhere in nested objects, arrays or text", (withholdContact) => {
    const out = JSON.stringify(scrub(fixture(), { withholdContact }));
    for (const secret of NEVER) expect(out, secret).not.toContain(secret);
    expect(out).toContain("kept"); // non-secret keys and text survive
    expect(out).toContain("FedEx");
    expect(out).toContain("ckabc123def456ghi789jkl01"); // a cuid is exempt
  });

  it("drops secret-looking KEYS, by word, without eating innocent ones", () => {
    const out = scrub(fixture(), {}) as Record<string, unknown>;
    for (const k of ["qr", "unsubscribeToken", "passwordHash", "stripeCustomerId", "accessToken", "last4", "routingNumber", "pin"]) {
      expect(out, k).not.toHaveProperty(k);
    }
    expect(out).toHaveProperty("shipping");
    expect(out).toHaveProperty("mapping");
    expect(isSensitiveKey("secretHash")).toBe(true);
    expect(isSensitiveKey("account_number")).toBe(true);
    expect(isSensitiveKey("stripeAccountId")).toBe(true);
    expect(isSensitiveKey("signature")).toBe(true);
    expect(isSensitiveKey("opinion")).toBe(false);
    expect(isSensitiveKey("createdAt")).toBe(false);
  });

  it("removes exact secret values it is handed (a technician token, a webhook secret), whatever they look like", () => {
    const out = JSON.stringify(scrub({ text: "use abc-def-ghi-jkl-mno to sign in" }, { secrets: ["abc-def-ghi-jkl-mno"] }));
    expect(out).not.toContain("abc-def-ghi-jkl-mno");
  });

  it("leaves UUIDs, cuids, ISO times and ordinary words alone", () => {
    const value = { a: "123e4567-e89b-12d3-a456-426614174000", b: "ckabc123def456ghi789jkl01", c: "2026-11-23T09:00:00-06:00", d: "Telecommunications" };
    expect(scrub(value, { withholdContact: true })).toEqual(value);
  });

  it("checks card numbers by Luhn and routing numbers by the ABA checksum, so ordinary digits stay", () => {
    expect(luhnValid("4242424242424242")).toBe(true);
    expect(luhnValid("4242424242424241")).toBe(false);
    expect(abaValid("021000021")).toBe(true);
    expect(abaValid("123456789")).toBe(false);
    expect(scrub({ t: "invoice 1234567890123 total" }, {})).toEqual({ t: "invoice 1234567890123 total" });
    expect(scrub({ t: "order 123456789" }, {})).toEqual({ t: "order 123456789" });
  });
});

describe("restricted profiles never carry a phone, email or street", () => {
  const free = "Call John at (615) 903-5947 or john.smith@example.com, he lives at 4410 Old Hickory Blvd Apt 2, Franklin TN.";
  it("a phone, an email and a street planted in every free-text field are gone from nested output", () => {
    const value = {
      city: "Franklin", notes: free, nested: { items: [{ text: free }, { text: `second: ${free}` }] },
      attachment: { name: "photo of 123 Main St house.jpg", caption: "615.555.0101" },
    };
    const out = JSON.stringify(scrub(value, { withholdContact: true }));
    for (const bad of ["615) 903-5947", "903-5947", "john.smith@example.com", "4410 Old Hickory Blvd", "123 Main St", "615.555.0101"]) {
      expect(out, bad).not.toContain(bad);
    }
    expect(out).toContain("[withheld]");
    expect(out).toContain("Franklin");
  });

  it("an unrestricted (crm:read) record read keeps contact details: it is the message profile that never does", () => {
    const out = scrub({ phone: "(615) 903-5947" }, { withholdContact: false });
    expect(out).toEqual({ phone: "(615) 903-5947" });
  });
});

describe("scrubMessageText: three passes, for EVERY key (team answer 4)", () => {
  const linked = {
    phones: ["615-903-5947"], emails: ["customer@example.org"], addresses: ["88 Cedar Hollow Court, Franklin, TN 37064"],
  };

  it("pass 1: phone and email patterns", () => {
    const out = scrubMessageText("text me 615.903.5947, +1 (931) 555-0100 or a@b.co");
    expect(out).toBe("text me [withheld], [withheld] or [withheld]");
  });

  it("pass 2: a US street address, with the common suffixes", () => {
    for (const street of ["123 Main St", "4410 Old Hickory Blvd", "9 Lone Oak Rd", "2200 Murfreesboro Pike", "17 Cedar Way", "5 Birch Cir", "310 Elm Dr.", "42 Hillsboro Hwy", "7 Pine Ln", "81 Oak Ct", "100 Franklin Ave"]) {
      const out = scrubMessageText(`The job is at ${street} on Tuesday`);
      expect(out, street).toBe("The job is at [withheld] on Tuesday");
    }
    expect(scrubMessageText("Arrive 9 AM, 4 hours, 2 panels")).toBe("Arrive 9 AM, 4 hours, 2 panels");
  });

  it("pass 3: the linked record's own phone, email and address strings, exact and case-insensitive, even where the patterns would miss", () => {
    const text = "Contact CUSTOMER@example.org, phone 903-5947 (615) or 88 cedar hollow court, franklin, tn 37064 please";
    const out = scrubMessageText(text, linked);
    expect(out).not.toMatch(/customer@example\.org/i);
    expect(out).not.toContain("cedar hollow");
    expect(out).not.toContain("37064");
    expect(out).toContain("please");
  });

  it("a phone written with odd punctuation still goes when the record's number is known", () => {
    expect(scrubMessageText("call 6 1 5 . 9 0 3 - 5 9 4 7", linked)).not.toMatch(/9 0 3/);
    expect(scrubMessageText("call 615 903 5947 now", linked)).toBe("call [withheld] now");
  });

  it("runs on nested message-like objects through scrub(withholdContact + linked)", () => {
    const thread = { title: "Quote for 88 Cedar Hollow Court", messages: [{ body: "reach me at customer@example.org" }, { body: "or 615-903-5947" }] };
    const out = JSON.stringify(scrub(thread, { withholdContact: true, linked }));
    expect(out).not.toMatch(/Cedar Hollow|customer@example|903-5947/);
  });
});

describe("review fixes: scrub gaps", () => {
  it("#2 a card typed with its expiry, CVV or a leading digit is still found inside the digit run", () => {
    for (const text of [
      "Card 4242 4242 4242 4242 12/28 CVV 123",
      "card 4242 4242 4242 4242 123",
      "4242424242424242 12",
      "pay 4242 4242 4242 4242 07 2028",
      "qty 3 4242 4242 4242 4242",
      "2 4242424242424242",
      "4242-4242-4242-4242 exp 1228",
    ]) {
      const out = scrub({ t: text }, {}).t;
      expect(out, text).not.toContain("4242 4242");
      expect(out, text).not.toContain("4242424242424242");
      expect(out, text).not.toContain("4242-4242");
      expect(out, text).toContain("[redacted]");
    }
    expect(scrub({ t: "Card 4242 4242 4242 4242 12/28 CVV 123" }, {}).t).toBe("Card [redacted] 12/28 CVV 123");
    // Ordinary digit groups stay.
    expect(scrub({ t: "call 615 555 1234 ext 12" }, {}).t).toBe("call 615 555 1234 ext 12");
    expect(scrub({ t: "invoice 1042 total 250 qty 3" }, {}).t).toBe("invoice 1042 total 250 qty 3");
  });

  it("#3 local street forms are withheld: Hollow, Cove, Ridge, Trace, Bend, Chase, Pt, numbered roads, house letters, boxes", () => {
    for (const street of [
      "205 Fox Hollow", "6 Shady Cove", "55 Oak Cv", "15 Deer Ridge", "1121 Wildwood Trace", "312 Maple Bend", "42 Hunters Chase",
      "9 Elm Pt", "701 Broadway", "3401 West End", "1234 Highway 31", "12 Old Hwy 96", "1200 Martin Luther King Jr Blvd",
      "123-A Main St", "44B Cedar Ln", "PO Box 123", "P.O. Box 77", "RR 2 Box 15", "800 State Route 840", "17 US 31",
    ]) {
      const out = scrubMessageText(`Send it to ${street} please`);
      expect(out, street).toBe("Send it to [withheld] please");
      expect(scrub({ t: `at ${street} today` }, { withholdContact: true }).t, street).toBe("at [withheld] today");
    }
    expect(scrubMessageText("Arrive 9 AM, 4 hours, 2 panels, 3 in a row")).toBe("Arrive 9 AM, 4 hours, 2 panels, 3 in a row");
  });

  it("#3 the linked address's street line goes by itself, not only the whole stored string", () => {
    const linked = { addresses: ["88 Cedar Hollow Court, Franklin, TN 37064"] };
    expect(scrubMessageText("meet at 88 Cedar Hollow tomorrow", linked)).toBe("meet at [withheld] tomorrow");
    expect(scrubMessageText("88 cedar hollow court is the place", linked)).toBe("[withheld] is the place");
    expect(scrubMessageText("the 88 Cedar house", linked)).toBe("the [withheld] house");
    expect(scrubMessageText("88 pizzas for Cedar Hollow", linked)).not.toContain("[withheld] for");
    const out = JSON.stringify(scrub({ title: "Quote: 88 Cedar Hollow" }, { withholdContact: true, linked }));
    expect(out).not.toContain("Cedar Hollow");
    // Scout's training text uses the same pass.
    expect(scrubTrainingText("at 88 Cedar Hollow", { addresses: linked.addresses, names: [] })).toBe("at [withheld]");
  });

  it("#8 'US' and 'SR' are roads only in capitals, after a house number or Old, with a number after: '3 of us 2 hours' survives", () => {
    for (const text of ["It took 3 of us 2 hours", "Job needs 2 of us 3 visits", "It took 3 of US 2 hours", "we need 4 us 12 times"]) {
      expect(scrubMessageText(text), text).toBe(text);
      expect(scrub({ t: text }, { withholdContact: true }).t, text).toBe(text);
    }
    for (const street of ["1234 US 31", "12 Old Hwy 96", "800 SR 840", "12 Old SR 96", "44 US-31", "5 Highway 31"]) {
      expect(scrubMessageText(`at ${street} today`), street).toBe("at [withheld] today");
      expect(scrub({ t: `at ${street} today` }, { withholdContact: true }).t, street).toBe("at [withheld] today");
    }
  });

  it("#9 a directional street line needs its street word: wattages like '100 W' survive, '100 W Main' goes", () => {
    const linked = { addresses: ["100 W Main St, Franklin, TN 37064"] };
    expect(scrubMessageText("Installed 6 x 100 W LED wafers, 100 w total", linked)).toBe("Installed 6 x 100 W LED wafers, 100 w total");
    expect(scrubMessageText("meet at 100 W Main tomorrow", linked)).toBe("meet at [withheld] tomorrow");
    expect(scrubMessageText("meet at 100 w main st tomorrow", linked)).toBe("meet at [withheld] tomorrow");
    expect(scrub({ t: "two 1500 W heaters" }, { withholdContact: true, linked: { addresses: ["1500 W Mallory Ln, Franklin, TN"] } }).t).toBe("two 1500 W heaters");
    expect(scrubMessageText("1500 W Mallory please", { addresses: ["1500 W Mallory Ln"] })).toBe("[withheld] please");
    // A non-directional first street word is unchanged.
    expect(scrubMessageText("88 Cedar Hollow tomorrow", { addresses: ["88 Cedar Hollow Court"] })).toBe("[withheld] tomorrow");
    // A lone directional (no second word on the record) keeps the old behaviour.
    expect(scrubMessageText("at 100 W", { addresses: ["100 W"] })).toBe("at [withheld]");
  });

  it("#4 phones with slashes, Unicode dashes and spaced dashes are withheld, with or without a linked record", () => {
    const linked = { phones: ["615-903-5947"] };
    for (const phone of [
      "615–903–5947", "615 - 903 - 5947", "615 / 903 / 5947", "615/903-5947", "615—903—5947", "(615) 903‑5947", "615‐903‐5947", "+1 615 903 5947",
    ]) {
      expect(scrubMessageText(`call ${phone} now`), phone).toBe("call [withheld] now");
      expect(scrubMessageText(`call ${phone} now`, linked), phone).toBe("call [withheld] now");
      expect(scrub({ t: `call ${phone} now` }, { withholdContact: true }).t, phone).toBe("call [withheld] now");
      expect(scrubTrainingText(`call ${phone} now`, { phones: linked.phones, names: [] }), phone).toBe("call [withheld] now");
    }
    // Dates and short numbers are not phones.
    expect(scrubMessageText("on 11/21/2026 at 9 - 5 for 2026-11-23")).toBe("on 11/21/2026 at 9 - 5 for 2026-11-23");
  });

  it("#5 a signed-document link is a capability URL; the generate-* automation routes are not", () => {
    const pdf = "https://crm.x.com/api/documents/clx1abc2def3ghi4jkl5mno6p/pdf";
    const sign = "https://crm.x.com/documents/clx1abc2def3ghi4jkl5mno6p/sign";
    const out = scrub({ a: `see ${pdf}`, b: `and ${sign}` }, {});
    expect(JSON.stringify(out)).not.toContain("clx1abc2def3ghi4jkl5mno6p");
    expect(out.a).toBe("see https://crm.x.com/api/documents/[redacted]/pdf");
    expect(scrub({ t: "/documents/generate-contract-for-job" }, {}).t).toBe("/documents/generate-contract-for-job");
    expect(scrub({ t: "https://crm.x.com/sign/clx1abc2def3ghi4jkl5mno6p" }, {}).t).toBe("https://crm.x.com/sign/[redacted]");
  });
});

describe("message read and Scout training profiles", () => {
  const raw = {
    id: "m1", threadId: "t1", authorType: "customer", authorDisplay: "John and Sandy Lewis",
    subject: "Panel at 88 Cedar Hollow Court", body: "Hi, I'm John, call 615-903-5947 or mail j@lewis.com",
    createdAt: new Date("2026-11-23T15:00:00Z"),
  };
  const linked = { phones: ["615-903-5947"], emails: ["j@lewis.com"], addresses: ["88 Cedar Hollow Court"] };

  it("one profile for every key: first name at most, no contact, Chicago time", () => {
    const out = projectMessageRead(raw, linked, true);
    expect(out).toEqual({
      id: "m1", threadId: "t1", authorType: "customer", authorFirstName: "John",
      subject: "Panel at [withheld]", body: "Hi, I'm John, call [withheld] or mail [withheld]", createdAt: "2026-11-23T09:00:00-06:00",
    });
  });

  it("a first name is a ceiling, not a grant: a profile that allows no names carries none, and an unnamed author is null (never 'there')", () => {
    expect(projectMessageRead(raw, linked, false).authorFirstName).toBeNull();
    expect(projectMessageRead({ ...raw, authorDisplay: null }, linked, true).authorFirstName).toBeNull();
    expect(authorFirstName("  ", true)).toBeNull();
  });

  it("scout-training: the every-key text pass plus the customers' full names, and no refs or attachments", () => {
    const out = projectScoutTrainingMessage(
      { id: "m9", threadId: "t9", apprenticeName: "Casey Jones", authorType: "scout",
        body: "At the Lewis job John Lewis said call 615-903-5947. Dana Whitfield at 12 Pine Ln agreed.",
        createdAt: new Date("2026-11-23T15:00:00Z") },
      { phones: ["615-903-5947"], emails: [], addresses: [], names: ["John Lewis", "Dana Whitfield"] },
    );
    expect(Object.keys(out).sort()).toEqual(["apprenticeFirstName", "authorType", "createdAt", "messageId", "text", "threadId"]);
    expect(out.apprenticeFirstName).toBe("Casey");
    expect(out.text).not.toMatch(/John Lewis|Dana Whitfield|903-5947|12 Pine Ln/);
    expect(out.text).toContain("Lewis job");
    expect(out.createdAt).toBe("2026-11-23T09:00:00-06:00");
    // never weaker than the every-key pass
    const text = "reach j@lewis.com or 14 Elm St";
    expect(scrubTrainingText(text)).toBe(scrubMessageText(text));
  });

  it("marketing-original: opaque ref, stage, jobType, city, month, copy state, access-hole boxes; no ids, caption, customer, address or GPS", () => {
    const ok = marketingOriginalSchema.parse({
      photoRef: "Zk3p9QwErTyUiOpAs", stage: "after", jobType: "Panel upgrade", city: "Franklin", month: "2026-11", copyState: "none",
      accessHoles: [{ x: 10, y: 20, w: 30, h: 40 }],
      visitPhotoId: "cm123", visitId: "v1", caption: "Mrs Smith's panel", customer: "Smith", address: "1 Main St", gps: { lat: 1, lng: 2 },
    });
    expect(Object.keys(ok).sort()).toEqual(["accessHoles", "city", "copyState", "jobType", "month", "photoRef", "stage"]);
    expect(marketingOriginalSchema.safeParse({ ...ok, month: "2026-13" }).success).toBe(false);
    expect(marketingOriginalSchema.safeParse({ ...ok, photoRef: "short" }).success).toBe(false);
    expect(marketingOriginalSchema.safeParse({ ...ok, stage: "during" }).success).toBe(false);
  });
});

describe("agentRespond: the profile follows the scope that authorised the call", () => {
  const tool: AgentToolOutput = {
    name: "get_lead",
    profiles: [
      { scope: "crm:read", schema: z.object({ id: z.string(), name: z.string(), phone: z.string(), source: z.string() }), withholdContact: false },
      { scope: "reports:read", schema: z.object({ id: z.string(), source: z.string(), phone: z.string() }), withholdContact: true },
    ],
  };
  const raw = { id: "l1", name: "Pat Doe", phone: "615-555-0101", source: "Yelp", internalNote: "never shown", stripeCustomerId: "cus_ABCDEFGH12345" };

  it("crm:read gets its fields (zod stripped the rest), reports:read gets the restricted ones with contact withheld", async () => {
    const admin = await agentRespond({ scopes: ["crm:read", "hub:read"] }, tool, raw);
    expect(admin.scopeUsed).toBe("crm:read");
    expect(admin.data).toEqual({ id: "l1", name: "Pat Doe", phone: "615-555-0101", source: "Yelp" });
    const research = await agentRespond({ scopes: ["reports:read"] }, tool, raw);
    expect(research.scopeUsed).toBe("reports:read");
    expect(research.data).toEqual({ id: "l1", source: "Yelp", phone: "[withheld]" });
  });

  it("priority order decides when a key holds both scopes; a key with neither is scope_denied", async () => {
    expect((await agentRespond({ scopes: ["reports:read", "crm:read"] }, tool, raw)).scopeUsed).toBe("crm:read");
    await expect(agentRespond({ scopes: ["hub:read"] }, tool, raw)).rejects.toMatchObject({ code: "scope_denied" });
  });

  it("removes a live technician token wherever it appears in an answer", async () => {
    const person = await makePerson("Token Holder");
    const tech = await prisma.technician.findUnique({ where: { id: person.id } });
    const out = await agentRespond({ scopes: ["crm:read"] }, tool, { ...raw, source: `via ${tech!.accessToken}` });
    expect(JSON.stringify(out.data)).not.toContain(tech!.accessToken);
  });

  it("a record that does not fit its own profile is our bug: a plain error, not shown", async () => {
    await expect(agentRespond({ scopes: ["crm:read"] }, tool, { id: 5 })).rejects.toThrow(/does not fit/);
    const e = toAgentError(new Error("secret detail"), "GET /x");
    expect(e.status).toBe(500);
    expect(JSON.stringify(e.body)).not.toContain("secret detail");
  });
});

describe("errors: always { code, reason, retryable }", () => {
  it("every catalog entry has a status, a reason and a retryable flag", () => {
    for (const [code, entry] of Object.entries(AGENT_ERRORS)) {
      expect(entry.status, code).toBeGreaterThanOrEqual(400);
      expect(entry.reason.length, code).toBeGreaterThan(5);
      expect(typeof entry.retryable, code).toBe("boolean");
    }
  });

  it("an AgentApiError keeps its code and the screen's own reason text; a ZodError names fields, never values", () => {
    const e = toAgentError(new AgentApiError("forbidden", { reason: "Only Kyle can change price book prices." }));
    expect(e).toEqual({ status: 403, body: { code: "forbidden", reason: "Only Kyle can change price book prices.", retryable: false } });
    const z1 = z.object({ qty: z.number() }).safeParse({ qty: "SECRET-VALUE" });
    const ze = toAgentError(z1.error);
    expect(ze.status).toBe(400);
    expect(ze.body.code).toBe("bad_request");
    expect(ze.body.reason).toContain("qty");
    expect(JSON.stringify(ze.body)).not.toContain("SECRET-VALUE");
  });
});

describe("Chicago time", () => {
  it("writes ISO 8601 with the zone's own offset, across both daylight-saving changes", () => {
    expect(toChicagoIso(new Date("2026-11-23T15:00:00Z"))).toBe("2026-11-23T09:00:00-06:00");
    expect(toChicagoIso(new Date("2026-06-15T15:00:00Z"))).toBe("2026-06-15T10:00:00-05:00");
    // Fall back, 2026-11-01: 06:59:59Z is still CDT (01:59:59 -05:00); 07:00Z is 01:00 CST (-06:00).
    expect(toChicagoIso(new Date("2026-11-01T06:59:59Z"))).toBe("2026-11-01T01:59:59-05:00");
    expect(toChicagoIso(new Date("2026-11-01T07:00:00Z"))).toBe("2026-11-01T01:00:00-06:00");
    // Spring forward, 2027-03-14: 07:59:59Z is 01:59:59 CST; 08:00Z is 03:00 CDT.
    expect(toChicagoIso(new Date("2027-03-14T07:59:59Z"))).toBe("2027-03-14T01:59:59-06:00");
    expect(toChicagoIso(new Date("2027-03-14T08:00:00Z"))).toBe("2027-03-14T03:00:00-05:00");
    // Midnight does not print as 24.
    expect(toChicagoIso(new Date("2026-11-23T06:00:00Z"))).toBe("2026-11-23T00:00:00-06:00");
  });

  it("round-trips: parsing the output gives the same instant", () => {
    for (const iso of ["2026-11-01T06:59:59Z", "2026-11-01T07:00:00Z", "2027-03-14T07:59:59Z", "2027-03-14T08:00:00Z", "2026-07-04T17:30:15Z"]) {
      expect(new Date(toChicagoIso(new Date(iso))).toISOString()).toBe(new Date(iso).toISOString().replace(".000Z", ".000Z"));
    }
  });

  it("input must carry an offset: a naive time is refused and answered bad_time", () => {
    expect(agentDateTime.safeParse("2026-11-23T09:00:00-06:00").success).toBe(true);
    expect(agentDateTime.safeParse("2026-11-23T15:00:00Z").success).toBe(true);
    const naive = agentDateTime.safeParse("2026-11-23T09:00:00");
    expect(naive.success).toBe(false);
    const e = toAgentError(naive.error);
    expect(e.status).toBe(400);
    expect(e.body.code).toBe("bad_time");
  });

  it("a stored calendar day is output as YYYY-MM-DD (dayOf), a noon-UTC typed day never shifting", () => {
    expect(dayOf(new Date("2026-11-15T12:00:00Z"))).toBe("2026-11-15");
    expect(chicagoToday(new Date("2026-11-23T05:59:00Z"))).toBe("2026-11-22");
  });
});

describe("pagination: keyset on (createdAt desc, id desc)", () => {
  type Row = { id: string; createdAt: Date; kind: string };
  const rows: Row[] = [];
  for (let i = 0; i < 201; i += 1) {
    // Pairs share a createdAt, so the id tiebreak is exercised.
    rows.push({ id: `r${String(i).padStart(4, "0")}`, createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, Math.floor(i / 2))), kind: i % 2 ? "a" : "b" });
  }
  const sorted = () => [...rows].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : -1));
  const lt = (r: Row, after: { createdAt: Date; id: string }) =>
    r.createdAt < after.createdAt || (r.createdAt.getTime() === after.createdAt.getTime() && r.id < after.id);
  const fetchFrom = (filter?: string) => async ({ after, take }: { after: { OR: [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lt: string } }] } | null; take: number }) => {
    const pos = after ? { createdAt: after.OR[1].createdAt, id: after.OR[1].id.lt } : null;
    return sorted().filter((r) => (!filter || r.kind === filter) && (!pos || lt(r, pos))).slice(0, take);
  };

  it("201 rows page as 50/50/50/50/1 with no repeats", async () => {
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const res = await paginate({ cursor }, null, fetchFrom());
      sizes.push(res.items.length);
      seen.push(...res.items.map((r) => r.id));
      if (!res.next_cursor) break;
      cursor = res.next_cursor;
    }
    expect(sizes).toEqual([50, 50, 50, 50, 1]);
    expect(new Set(seen).size).toBe(201);
    expect(seen).toEqual(sorted().map((r) => r.id));
  });

  it("limit 201 is a validation error (bad_request), limit 0 too, and 200 is the maximum", async () => {
    expect(pageParamsSchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(pageParamsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(pageParamsSchema.parse({ limit: 200 }).limit).toBe(200);
    expect(pageParamsSchema.parse({}).limit).toBe(50);
    await expect(paginate({ limit: 201 }, null, fetchFrom())).rejects.toThrow();
    const e = toAgentError(await paginate({ limit: 201 }, null, fetchFrom()).catch((x) => x));
    expect(e.body.code).toBe("bad_request");
  });

  it("rows inserted between pages never duplicate a row", async () => {
    const first = await paginate({ limit: 50 }, null, fetchFrom());
    rows.push({ id: "zzzz-new", createdAt: new Date(Date.UTC(2026, 11, 1)), kind: "a" }); // newer than everything
    try {
      const second = await paginate({ limit: 50, cursor: first.next_cursor! }, null, fetchFrom());
      const ids = new Set(first.items.map((r) => r.id));
      for (const r of second.items) expect(ids.has(r.id), r.id).toBe(false);
      expect(second.items).toHaveLength(50);
    } finally {
      rows.pop();
    }
  });

  it("a cursor is opaque base64url, belongs to its own filters, and a bad one is bad_cursor", async () => {
    const first = await paginate({ limit: 10 }, { kind: "a" }, fetchFrom("a"));
    expect(first.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(() => decodeCursor(first.next_cursor!, { kind: "b" })).toThrow(AgentApiError);
    expect(() => decodeCursor("not-a-cursor", null)).toThrow(AgentApiError);
    expect(decodeCursor(first.next_cursor!, { kind: "a" }).id).toBe(first.items[9].id);
    expect(encodeCursor(rows[0], null)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(KEYSET_ORDER_BY).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });
});

describe("agent output schemas stay closed (source scan)", () => {
  const dir = path.join(__dirname, "..", "src", "agentApi");
  const BANNED = [/\.passthrough\s*\(/, /\blooseObject\s*\(/, /\.loose\s*\(/, /\.catchall\s*\(/, /\bz\.record\s*\(/, /\bz\.any\s*\(/, /\bz\.unknown\s*\(/, /\bz\.custom\s*\(/];

  it("no file under src/agentApi uses passthrough, looseObject, record, any or unknown", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      for (const re of BANNED) expect(re.test(src), `${f} matches ${re}`).toBe(false);
    }
  });

  it("the scan itself catches what it should", () => {
    for (const bad of ["z.object({}).passthrough()", "z.looseObject({})", "z.record(z.string(), z.string())", "z.any()", "z.unknown()"]) {
      expect(BANNED.some((re) => re.test(bad)), bad).toBe(true);
    }
  });
});
