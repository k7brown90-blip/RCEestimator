import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/services/twilio");
vi.mock("googleapis");

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { findCustomerMatches, phoneDigits10 } from "../src/services/customerMatch";

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
