import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/services/twilio");
vi.mock("googleapis");

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { findCustomerMatches, findLeadMatches, phoneDigits10 } from "../src/services/customerMatch";

/**
 * Finding the account a caller already has.
 *
 * The test that earns the whole module is the first one: the same phone number
 * is stored four different ways in this database, and one query has to find all
 * of them. Normalized-equality misses three; `contains "6155550101"` misses two.
 */

const PHONE = "6155550101";
const NAME_PREFIX = "CM Test";

beforeEach(async () => {
  await prisma.visit.deleteMany({ where: { customer: { name: { startsWith: NAME_PREFIX } } } });
  await prisma.property.deleteMany({ where: { customer: { name: { startsWith: NAME_PREFIX } } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: NAME_PREFIX } } });
});

afterAll(async () => {
  await prisma.visit.deleteMany({ where: { customer: { name: { startsWith: NAME_PREFIX } } } });
  await prisma.property.deleteMany({ where: { customer: { name: { startsWith: NAME_PREFIX } } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: NAME_PREFIX } } });
});

describe("phoneDigits10", () => {
  it("reduces every stored format to the same ten digits", () => {
    for (const raw of ["+16155550101", "6155550101", "(615) 555-0101", "615-555-0101", "1-615-555-0101"]) {
      expect(phoneDigits10(raw)).toBe(PHONE);
    }
  });

  it("returns null rather than a short string when there aren't ten digits", () => {
    // A partial number must not match everything ending in those digits.
    expect(phoneDigits10("555-0101")).toBeNull();
    expect(phoneDigits10("")).toBeNull();
    expect(phoneDigits10(null)).toBeNull();
  });
});

describe("findCustomerMatches", () => {
  it("finds the same number however it was stored", async () => {
    const formats = ["+16155550101", "6155550101", "(615) 555-0101", "615-555-0101"];
    for (const [index, phone] of formats.entries()) {
      await prisma.customer.create({ data: { name: `${NAME_PREFIX} Format ${index}`, phone } });
    }

    const matches = await findCustomerMatches({ phone: "615-555-0101", limit: 10 });
    const found = matches.filter((m) => m.name.startsWith(NAME_PREFIX));
    expect(found.length).toBe(4);
    expect(found.every((m) => m.matchedOn.includes("phone"))).toBe(true);
  });

  it("excludes a different number that happens to share the last four", async () => {
    // The SQL narrows on the last four; this is what proves the JS confirm runs.
    await prisma.customer.create({ data: { name: `${NAME_PREFIX} Real`, phone: "615-555-0101" } });
    await prisma.customer.create({ data: { name: `${NAME_PREFIX} Decoy`, phone: "615-559-0101" } });

    const matches = await findCustomerMatches({ phone: PHONE, limit: 10 });
    const names = matches.map((m) => m.name);
    expect(names).toContain(`${NAME_PREFIX} Real`);
    expect(names).not.toContain(`${NAME_PREFIX} Decoy`);
  });

  it("matches email regardless of case or surrounding whitespace", async () => {
    await prisma.customer.create({ data: { name: `${NAME_PREFIX} Email`, email: "Sam@Example.COM" } });
    const matches = await findCustomerMatches({ email: "  sam@example.com  " });
    expect(matches.some((m) => m.name === `${NAME_PREFIX} Email`)).toBe(true);
  });

  it("never treats a shared surname as a duplicate on its own", async () => {
    // Two households called Smith is ordinary. Prompting on it would invite
    // filing one family's job under the other.
    await prisma.customer.create({ data: { name: `${NAME_PREFIX} Smith`, phone: "615-555-7777" } });
    const matches = await findCustomerMatches({ name: `${NAME_PREFIX} Smith` });
    expect(matches).toEqual([]);
  });

  it("counts a name only alongside a real identifier", async () => {
    await prisma.customer.create({
      data: { name: `${NAME_PREFIX} Both`, phone: "615-555-0101", email: "both@example.com" },
    });
    const [match] = await findCustomerMatches({
      phone: PHONE, email: "both@example.com", name: `${NAME_PREFIX} Both`,
    });
    expect(match.matchedOn.sort()).toEqual(["email", "name", "phone"]);
  });

  it("ranks a phone-and-email match above a phone-only one", async () => {
    await prisma.customer.create({
      data: { name: `${NAME_PREFIX} Strong`, phone: PHONE, email: "strong@example.com" },
    });
    await prisma.customer.create({ data: { name: `${NAME_PREFIX} Weak`, phone: PHONE } });

    const matches = await findCustomerMatches({ phone: PHONE, email: "strong@example.com", limit: 10 });
    const ours = matches.filter((m) => m.name.startsWith(NAME_PREFIX));
    expect(ours[0].name).toBe(`${NAME_PREFIX} Strong`);
    expect(ours[0].score).toBeGreaterThan(ours[1].score);
  });

  it("carries the account's addresses, so the picker needs no second request", async () => {
    const customer = await prisma.customer.create({
      data: { name: `${NAME_PREFIX} Addresses`, phone: PHONE },
    });
    for (const line1 of ["100 Cedar Ln", "220 Oak St"]) {
      await prisma.property.create({
        data: {
          customerId: customer.id, name: line1, addressLine1: line1,
          city: "Murfreesboro", state: "TN", postalCode: "37130",
        },
      });
    }

    const [match] = await findCustomerMatches({ phone: PHONE });
    expect(match.properties.length).toBe(2);
    expect(match.properties.map((p) => p.addressLine1).sort()).toEqual(["100 Cedar Ln", "220 Oak St"]);
  });

  it("returns nothing when there's nothing to go on", async () => {
    // An empty query must not return the whole customer table.
    expect(await findCustomerMatches({})).toEqual([]);
    expect(await findCustomerMatches({ phone: "", email: "", name: "" })).toEqual([]);
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 8; i += 1) {
      await prisma.customer.create({ data: { name: `${NAME_PREFIX} Many ${i}`, phone: PHONE } });
    }
    expect((await findCustomerMatches({ phone: PHONE, limit: 3 })).length).toBe(3);
  });
});

/**
 * The lead form's two extras (plan lead-intake-fixes F2): a same-name account with nothing else in
 * common, and the leads that already exist. Both are OPT-IN, because other callers take the
 * FIRST match and attach the caller to that account - a name must never reach them on its own.
 */
describe("findCustomerMatches - includeNameOnly (the lead form only)", () => {
  it("is OFF by default: an exact full-name account with no phone or email is still not a match", async () => {
    await prisma.customer.create({ data: { name: `${NAME_PREFIX} Eric Ward`, phone: "615-555-7777" } });
    expect(await findCustomerMatches({ name: `${NAME_PREFIX} Eric Ward` })).toEqual([]);
    // ...nor with a DIFFERENT phone, which is what the voice agent sends for a new number.
    expect(await findCustomerMatches({ name: `${NAME_PREFIX} Eric Ward`, phone: "615-555-0000" })).toEqual([]);
  });

  it("ON: surfaces the exact full name, as a name-only match, ignoring case and spacing", async () => {
    await prisma.customer.create({ data: { name: `${NAME_PREFIX} Eric Ward`, phone: "615-555-7777" } });
    const matches = await findCustomerMatches({ name: `  ${NAME_PREFIX.toLowerCase()}   ERIC  ward `, includeNameOnly: true });
    expect(matches.map((m) => m.name)).toEqual([`${NAME_PREFIX} Eric Ward`]);
    expect(matches[0].matchedOn).toEqual(["name"]);
  });

  it("ON: a partial name never counts on its own, so the panel does not flash while someone types Eric", async () => {
    await prisma.customer.create({ data: { name: `${NAME_PREFIX} Frederick Ward`, phone: "615-555-7777" } });
    await prisma.customer.create({ data: { name: `${NAME_PREFIX} Eric Ward Jr`, phone: "615-555-7778" } });
    expect(await findCustomerMatches({ name: `${NAME_PREFIX} Eric`, includeNameOnly: true })).toEqual([]);
    expect(await findCustomerMatches({ name: `${NAME_PREFIX} Eric Ward`, includeNameOnly: true })).toEqual([]);
  });

  it("ON: ranks the name-only account BELOW a phone or email hit", async () => {
    await prisma.customer.create({ data: { name: `${NAME_PREFIX} Same Name`, phone: "615-555-7777" } });
    await prisma.customer.create({ data: { name: `${NAME_PREFIX} Other Name`, phone: PHONE } });
    const matches = await findCustomerMatches({ name: `${NAME_PREFIX} Same Name`, phone: PHONE, includeNameOnly: true, limit: 10 });
    const ours = matches.filter((m) => m.name.startsWith(NAME_PREFIX));
    expect(ours.map((m) => m.name)).toEqual([`${NAME_PREFIX} Other Name`, `${NAME_PREFIX} Same Name`]);
    expect(ours[0].matchedOn).toEqual(["phone"]);
    expect(ours[1].matchedOn).toEqual(["name"]);
    expect(ours[0].score).toBeGreaterThan(ours[1].score);
  });
});

describe("findLeadMatches", () => {
  const LEAD = `${NAME_PREFIX} Lead`;
  beforeEach(async () => { await prisma.lead.deleteMany({ where: { name: { startsWith: NAME_PREFIX } } }); });
  afterAll(async () => { await prisma.lead.deleteMany({ where: { name: { startsWith: NAME_PREFIX } } }); });

  it("finds a lead by the last ten digits whatever the stored format, and not by a shared last four", async () => {
    await prisma.lead.create({ data: { name: `${LEAD} Punctuated`, phone: "(615) 555-0101" } });
    await prisma.lead.create({ data: { name: `${LEAD} Plus`, phone: "+16155550101" } });
    await prisma.lead.create({ data: { name: `${LEAD} Decoy`, phone: "615-559-0101" } });
    const matches = await findLeadMatches({ phone: "615.555.0101", limit: 10 });
    const names = matches.map((m) => m.name);
    expect(names).toContain(`${LEAD} Punctuated`);
    expect(names).toContain(`${LEAD} Plus`);
    expect(names).not.toContain(`${LEAD} Decoy`);
    expect(matches[0].matchedOn).toEqual(["phone"]);
  });

  it("matches email exactly (any case) and the EXACT full name, not a partial one", async () => {
    await prisma.lead.create({ data: { name: `${LEAD} Email`, email: "Sol@Example.com" } });
    await prisma.lead.create({ data: { name: `${LEAD} Sol Steiner` } });
    await prisma.lead.create({ data: { name: `${LEAD} Sol Steiner Sr` } });
    expect((await findLeadMatches({ email: " sol@example.COM " })).map((m) => m.name)).toEqual([`${LEAD} Email`]);
    const byName = await findLeadMatches({ name: `${LEAD} sol  steiner` });
    expect(byName.map((m) => m.name)).toEqual([`${LEAD} Sol Steiner`]);
    expect(byName[0].matchedOn).toEqual(["name"]);
    expect(await findLeadMatches({ name: `${LEAD} Sol` })).toEqual([]);
  });

  it("lists open and lost leads, never a converted one, and never the lead being edited", async () => {
    const open = await prisma.lead.create({ data: { name: `${LEAD} A`, phone: PHONE, status: "new" } });
    await prisma.lead.create({ data: { name: `${LEAD} B`, phone: PHONE, status: "contacted" } });
    await prisma.lead.create({ data: { name: `${LEAD} C`, phone: PHONE, status: "lost", leadStatus: "lost" } });
    await prisma.lead.create({ data: { name: `${LEAD} D`, phone: PHONE, status: "converted", leadStatus: "won" } });
    const all = await findLeadMatches({ phone: PHONE, limit: 10 });
    expect(all.map((m) => m.name).sort()).toEqual([`${LEAD} A`, `${LEAD} B`, `${LEAD} C`]);
    expect(all.find((m) => m.name.endsWith(" C"))!.status).toBe("lost");
    const others = await findLeadMatches({ phone: PHONE, excludeLeadId: open.id, limit: 10 });
    expect(others.map((m) => m.name).sort()).toEqual([`${LEAD} B`, `${LEAD} C`]);
  });

  it("puts a phone or email hit above a name-only one, and returns nothing for nothing", async () => {
    await prisma.lead.create({ data: { name: `${LEAD} Same`, email: "x@example.com" } });
    await prisma.lead.create({ data: { name: `${LEAD} Other`, phone: PHONE } });
    const matches = await findLeadMatches({ name: `${LEAD} Same`, phone: PHONE, limit: 10 });
    expect(matches.map((m) => m.name)).toEqual([`${LEAD} Other`, `${LEAD} Same`]);
    expect(await findLeadMatches({})).toEqual([]);
    expect(await findLeadMatches({ phone: "", email: " ", name: "" })).toEqual([]);
  });
});

describe("GET /crm/customer-matches - the lead form's flags", () => {
  const NAME = `${NAME_PREFIX} Route Person`;
  beforeEach(async () => { await prisma.lead.deleteMany({ where: { name: { startsWith: NAME_PREFIX } } }); });
  afterAll(async () => { await prisma.lead.deleteMany({ where: { name: { startsWith: NAME_PREFIX } } }); });

  it("without the flags: the account list as before, no name-only account, and an empty leadMatches", async () => {
    await prisma.customer.create({ data: { name: NAME, phone: "615-555-7777" } });
    await prisma.lead.create({ data: { name: NAME, phone: "615-555-7777" } });
    const res = await request(app).get(`/crm/customer-matches?name=${encodeURIComponent(NAME)}`).expect(200);
    expect(res.body.matches).toEqual([]);
    expect(res.body.leadMatches).toEqual([]);
  });

  it("with includeNameOnly and includeLeads: the same-name account, the lead, and the lead being edited left out", async () => {
    await prisma.customer.create({ data: { name: NAME, phone: "615-555-7777" } });
    const mine = await prisma.lead.create({ data: { name: NAME } });
    const other = await prisma.lead.create({ data: { name: NAME, source: "web" } });
    const url = `/crm/customer-matches?name=${encodeURIComponent(NAME)}&includeNameOnly=1&includeLeads=1&excludeLeadId=${mine.id}`;
    const res = await request(app).get(url).expect(200);
    expect(res.body.matches.map((m: { name: string }) => m.name)).toEqual([NAME]);
    expect(res.body.matches[0].matchedOn).toEqual(["name"]);
    expect(res.body.leadMatches.map((m: { leadId: string }) => m.leadId)).toEqual([other.id]);
    expect(res.body.leadMatches[0]).toMatchObject({ name: NAME, status: "new", matchedOn: ["name"] });
    expect(typeof res.body.leadMatches[0].receivedAt).toBe("string");
  });
});

describe("GET /crm/customer-matches", () => {
  it("serves the matches to the picker", async () => {
    await prisma.customer.create({ data: { name: `${NAME_PREFIX} Api`, phone: "(615) 555-0101" } });
    const res = await request(app).get(`/crm/customer-matches?phone=${PHONE}`).expect(200);
    expect(res.body.matches.some((m: { name: string }) => m.name === `${NAME_PREFIX} Api`)).toBe(true);
  });

  it("400s when given nothing to search on", async () => {
    await request(app).get("/crm/customer-matches").expect(400);
  });
});
