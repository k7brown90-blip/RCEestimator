/**
 * Edit the billed hourly rate in the app (Kyle, 2026-10-27).
 *
 *   "I want to be able to edit the chosen hourly rate in the app. This way we do not need to code
 *    everytime we need to update."  /  "I want it to stay $100 for now. I just want the ability to
 *    edit it so I can update the price book with our hourly rate when needed."
 *
 * Pinned here:
 *   1. PREVIEW writes nothing - no cell, no sell, no audit row, no draft snapshot.
 *   2. APPLY moves the Rate Config cell, the flat rows' sells, the open drafts' snapshot, and writes
 *      a PriceBookEdit row per changed column - together.
 *   3. Issued estimates and their lines are frozen: not one column moves.
 *   4. A per-dollar GENERAL LABOR unit stays $1.00 a unit; a row the 2026-09-01 conversion already
 *      made labour-only is not converted twice; a hand-set price is left alone and LISTED.
 *   5. A rate other than $100 no longer makes an estimate PROVISIONAL (the rate Kyle saves is the
 *      ruling); a BLANK cell still does.
 *   6. The routes refuse a bad rate with 400 and write nothing.
 *
 * Builds its own price-book rows (tests/helpers/priceBookFixture.ts) and tears down what it made.
 * The Rate Config cell is put back to $100 at the end - no test here may leave the book at another rate.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
vi.mock("stripe", () => ({ default: class MockStripe { constructor() { throw new Error("Stripe must not be constructed in tests"); } } }));
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials() {}
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }) },
        events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }) },
      }),
    },
  };
});
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { addLine, createDraft, loadRateContext } from "../src/services/atomicEstimateService";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { applyBilledRate, billedRateProblem, previewBilledRate } from "../src/services/billedRateChange";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "BRC";
const FORMULA = `${MARK}-FORMULA`;
const MATERIAL = `${MARK}-MATERIAL`;
const PER_DOLLAR = `${MARK}-PERDOLLAR`;
const RATE_AS_MAT = `${MARK}-RATEASMAT`;
const CONVERTED = `${MARK}-CONVERTED`;
const ASSEMBLY = `${MARK}-ASSEMBLY`;
const HAND_SET = `${MARK}-HANDSET`;
const ALL_ITEMS = [FORMULA, MATERIAL, PER_DOLLAR, RATE_AS_MAT, CONVERTED, ASSEMBLY, HAND_SET];
const NEW_RATE = 125;

let customerId: string;
let propertyId: string;
let visitId: string;
const draftIds: string[] = [];

const cell = () => prisma.priceBookRateConfig.findUnique({ where: { key: "billedLaborRate" } });
const atomic = (itemId: string) => prisma.priceBookAtomic.findUniqueOrThrow({ where: { itemId } });
const sells = async (itemId: string) => {
  const a = await atomic(itemId);
  return [a.sellNormal, a.sellDifficult, a.sellVeryDifficult];
};
const edits = () => prisma.priceBookEdit.findMany({ where: { itemId: { in: ALL_ITEMS } }, orderBy: [{ itemId: "asc" }, { field: "asc" }] });
const setCell = (numberValue: number | null) =>
  prisma.priceBookRateConfig.update({ where: { key: "billedLaborRate" }, data: { numberValue } });

/** Everything this test can see of the book - used to prove "nothing moved". */
async function snapshot() {
  return JSON.stringify({
    cell: (await cell())?.numberValue,
    atomics: await prisma.priceBookAtomic.findMany({ where: { itemId: { in: ALL_ITEMS } }, orderBy: { itemId: "asc" } }),
    edits: await edits(),
    drafts: await prisma.priceBookDraftEstimate.findMany({ where: { id: { in: draftIds } }, orderBy: { id: "asc" }, select: { id: true, billedLaborRate: true, rateProvisional: true, status: true } }),
  });
}

beforeAll(async () => {
  await ensurePriceBookGates(); // the cell at $100, HD, trip charge
  await seedAtomics([
    // hours × $100 + $40 material = 70 / 80 / 95
    quotableAtomic(FORMULA, { description: "Formula row" }),
    // a material-only row: sells the marked-up material, no labour line
    quotableAtomic(MATERIAL, {
      description: "Material only", rowType: "MATERIAL ONLY", laborNormal: null, laborDifficult: null, laborVeryDifficult: null,
      companyCost: 10, companyPrice: 12, sellNormal: 12, sellDifficult: 12, sellVeryDifficult: 12,
    }),
    // Kyle's GENERAL LABOR unit: 1/100 hr a unit, so one unit is $1.00
    quotableAtomic(PER_DOLLAR, {
      description: "Per-dollar labor", rowType: "LABOR ONLY", companyCost: null, companyPrice: null,
      laborNormal: 0.01, laborDifficult: 0.01, laborVeryDifficult: 0.01, sellNormal: 1, sellDifficult: 1, sellVeryDifficult: 1,
    }),
    // the sheet's =B*F shape, never converted: the "material" is the old hourly rate itself
    quotableAtomic(RATE_AS_MAT, {
      description: "Rate as material", companyCost: null, companyPrice: 100,
      laborNormal: 0.5, laborDifficult: 1, laborVeryDifficult: 1.5, sellNormal: 50, sellDifficult: 100, sellVeryDifficult: 150,
    }),
    // already converted to labour-only on 2026-09-01: plain hours × rate, converted ZERO more times
    quotableAtomic(CONVERTED, {
      description: "Already labor only", rowType: "LABOR ONLY", companyCost: null, companyPrice: null,
      laborNormal: 1, laborDifficult: 2, laborVeryDifficult: 3, sellNormal: 100, sellDifficult: 200, sellVeryDifficult: 300,
    }),
    // an assembly: its stored sells follow the same formula from its own stored material and hours
    quotableAtomic(ASSEMBLY, {
      description: "Assembly", rowType: "ASSEMBLY", companyCost: 50, companyPrice: 100,
      laborNormal: 0.5, laborDifficult: 0.5, laborVeryDifficult: 0.5, sellNormal: 150, sellDifficult: 150, sellVeryDifficult: 150,
    }),
    // a hand-set number that matches nothing
    quotableAtomic(HAND_SET, { description: "Hand set", sellNormal: 99, sellDifficult: 99, sellVeryDifficult: 99 }),
  ]);
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "brc@example.com", phone: "615-555-0199" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "9 Rate Ln", city: "La Vergne", state: "TN", postalCode: "37086" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({ data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "estimate" } });
  visitId = visit.id;
});

afterAll(async () => {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: draftIds } } });
  const estIds = ests.map((e) => e.id);
  const jobIds = [...new Set(ests.map((e) => e.jobVisitId).filter((v): v is string => Boolean(v)))];
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: jobIds } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null, changeOrderForId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.visit.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.priceBookEdit.deleteMany({ where: { itemId: { in: ALL_ITEMS } } });
  await deleteAtomics(ALL_ITEMS);
  await ensurePriceBookGates(); // the cell back to $100 for whoever runs next
});

describe("the rate check itself", () => {
  it("accepts dollars and cents up to $1,000 and nothing else", () => {
    expect(billedRateProblem(100)).toBeNull();
    expect(billedRateProblem(112.5)).toBeNull();
    expect(billedRateProblem(1000)).toBeNull();
    for (const bad of [0, -1, 1000.01, 100.555, Number.NaN, Number.POSITIVE_INFINITY, "100", null, undefined]) {
      expect(billedRateProblem(bad), String(bad)).not.toBeNull();
    }
  });

  it("the service refuses a bad rate itself, not only the route", async () => {
    await expect(previewBilledRate(prisma, 0)).rejects.toThrow(/more than \$0/);
    await expect(applyBilledRate(prisma, 5000, "test")).rejects.toThrow(/cannot be more than/);
  });
});

describe("a draft and an issued estimate exist before the rate moves", () => {
  let openDraftId: string;
  let issuedBefore: string;
  let issuedDraftId: string;
  let estimateId: string;

  it("sets up an open draft and an issued estimate at $100", async () => {
    const open = await createDraft(prisma, { title: `${MARK} open`, supplierId: "HD", visitId });
    draftIds.push(open.id);
    openDraftId = open.id;
    await addLine(prisma, open.id, { itemId: FORMULA, quantity: 2, quantitySource: "COUNT" });

    const toIssue = await createDraft(prisma, { title: `${MARK} issued`, supplierId: "HD", visitId });
    draftIds.push(toIssue.id);
    issuedDraftId = toIssue.id;
    await addLine(prisma, toIssue.id, { itemId: FORMULA, quantity: 3, quantitySource: "COUNT" });
    const g = await graduateDraft(prisma, { draftId: toIssue.id, accountId: customerId, serviceAddressId: propertyId });
    if (!g.ok) throw new Error(g.reasons.join("; "));
    estimateId = g.estimateId;
    issuedBefore = JSON.stringify(await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: estimateId }, include: { lines: { orderBy: { id: "asc" } }, events: { orderBy: { id: "asc" } } } }));
    expect(issuedBefore).toContain(FORMULA);
    expect((await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: openDraftId } })).billedLaborRate).toBe(100);
  });

  it("PREVIEW writes nothing, and reports what would happen", async () => {
    const before = await snapshot();
    const p = await previewBilledRate(prisma, NEW_RATE);
    expect(await snapshot()).toBe(before);
    // and over HTTP
    const res = await request(app).get("/price-book/billed-rate/preview").query({ rate: NEW_RATE });
    expect(res.status).toBe(200);
    expect(await snapshot()).toBe(before);

    expect(p.currentRate).toBe(100);
    expect(p.newRate).toBe(NEW_RATE);
    // formula, per-dollar, rate-as-material, already-labor-only, assembly reprice; material-only does not
    expect(p.repriceCount).toBeGreaterThanOrEqual(5);
    expect(p.assemblyCount).toBeGreaterThanOrEqual(1);
    expect(p.convertedRows.map((c) => c.itemId)).toEqual(expect.arrayContaining([PER_DOLLAR, RATE_AS_MAT]));
    expect(p.untouched.map((u) => u.itemId)).toContain(HAND_SET);
    expect(p.untouched.find((u) => u.itemId === HAND_SET)?.why).toMatch(/hand-set/);
    expect(p.samples.length).toBeGreaterThan(0);
    expect(p.openDrafts).toBeGreaterThanOrEqual(1);
    expect(res.body.newRate).toBe(NEW_RATE);
  });

  it("GET /price-book/billed-rate reads the cell", async () => {
    const res = await request(app).get("/price-book/billed-rate");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rate: 100 });
  });

  it("APPLY moves the cell, the sells and the open draft's snapshot together, with an audit row per column", async () => {
    const res = await request(app).post("/price-book/billed-rate").send({ rate: NEW_RATE });
    expect(res.status).toBe(200);
    expect(res.body.previousRate).toBe(100);
    expect(res.body.newRate).toBe(NEW_RATE);
    expect(res.body.untouched.map((u: { itemId: string }) => u.itemId)).toContain(HAND_SET);

    // 1. the cell
    expect((await cell())?.numberValue).toBe(NEW_RATE);

    // 2. the sells: hours × 125 + material
    expect(await sells(FORMULA)).toEqual([77.5, 90, 108.75]); // .3/.4/.55 hr × 125 + $40
    expect(await sells(CONVERTED)).toEqual([125, 250, 375]); // already labour-only: hours × rate, no extra "material"
    expect(await sells(ASSEMBLY)).toEqual([162.5, 162.5, 162.5]); // .5 hr × 125 + $100
    expect(await sells(MATERIAL)).toEqual([12, 12, 12]); // material is not the rate's business

    // 3. open drafts' snapshot
    const open = await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: openDraftId } });
    expect(open.billedLaborRate).toBe(NEW_RATE);
    expect(open.rateProvisional).toBe(false);

    // the audit trail: who, field, old -> new, and the note
    const all = await edits();
    const formulaEdits = all.filter((e) => e.itemId === FORMULA);
    expect(formulaEdits.map((e) => [e.field, e.oldValue, e.newValue]).sort()).toEqual([
      ["sellDifficult", "80", "90"],
      ["sellNormal", "70", "77.5"],
      ["sellVeryDifficult", "95", "108.75"],
    ]);
    expect(formulaEdits.every((e) => e.editedBy === "human:crm-session")).toBe(true);
    expect(formulaEdits[0].note).toMatch(/\$100 → \$125\/hr/);
    expect(all.filter((e) => e.itemId === MATERIAL)).toHaveLength(0); // unchanged -> no audit row
    expect(res.body.editsWritten).toBeGreaterThanOrEqual(all.length);
  });

  it("a per-dollar unit stays $1.00 a unit; a still-unconverted rate-as-material row becomes labour-only", async () => {
    const pd = await atomic(PER_DOLLAR);
    expect([pd.sellNormal, pd.sellDifficult, pd.sellVeryDifficult]).toEqual([1, 1, 1]);
    expect(pd.laborNormal).toBeCloseTo(1 / NEW_RATE, 6);
    expect((pd.laborNormal as number) * NEW_RATE).toBeCloseTo(1, 4);

    const ram = await atomic(RATE_AS_MAT);
    expect(ram.rowType).toBe("LABOR ONLY");
    expect(ram.companyPrice).toBeNull();
    expect([ram.sellNormal, ram.sellDifficult, ram.sellVeryDifficult]).toEqual([62.5, 125, 187.5]); // hours × 125, not + a $100 "material"
  });

  it("a hand-set price is left exactly as it was", async () => {
    expect(await sells(HAND_SET)).toEqual([99, 99, 99]);
    expect((await edits()).filter((e) => e.itemId === HAND_SET)).toHaveLength(0);
  });

  it("the issued estimate and its lines have not moved by one column", async () => {
    const after = JSON.stringify(await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: estimateId }, include: { lines: { orderBy: { id: "asc" } }, events: { orderBy: { id: "asc" } } } }));
    expect(after).toBe(issuedBefore);
    void issuedDraftId;
  });

  it("a rate other than $100 does NOT make the estimate provisional", async () => {
    const rc = await loadRateContext(prisma);
    expect(rc.rc.billedLaborRate).toBe(NEW_RATE);
    expect(rc.provisional).toBe(false);
    expect(rc.provisionalReason).toBeNull();

    const computed = await request(app).get(`/price-book/drafts/${openDraftId}/compute`);
    expect(computed.status).toBe(200);
    expect(computed.body.rateProvisional).toBe(false);

    // Finalised on a draft of its own, so the open draft above stays open for the "back to $100" check.
    const toFinalize = await createDraft(prisma, { title: `${MARK} finalize`, supplierId: "HD", visitId });
    draftIds.push(toFinalize.id);
    await addLine(prisma, toFinalize.id, { itemId: FORMULA, quantity: 1, quantitySource: "COUNT" });
    const fin = await request(app).post(`/price-book/drafts/${toFinalize.id}/finalize`).send({ context: "customer" });
    expect(fin.status).toBe(200);
    expect(JSON.stringify(fin.body)).not.toMatch(/PROVISIONAL/);
  });

  it("a BLANK cell still blocks as provisional - a missing number", async () => {
    await setCell(null);
    const rc = await loadRateContext(prisma);
    expect(rc.provisional).toBe(true);
    expect(rc.provisionalReason).toMatch(/blank/);

    const computed = await request(app).get(`/price-book/drafts/${openDraftId}/compute`);
    expect(computed.body.rateProvisional).toBe(true);
    expect(computed.body.provisionalReason).toMatch(/blank/);

    // a preview over a blank cell compares nothing, so it reprices nothing and says so
    const p = await previewBilledRate(prisma, 100);
    expect(p.currentRate).toBeNull();
    expect(p.repriceCount).toBe(0);
    expect(p.untouchedCount).toBeGreaterThanOrEqual(ALL_ITEMS.length - 1);

    await setCell(NEW_RATE);
  });

  it("the way back is the same box: apply $100 and every row returns to its first price", async () => {
    const res = await request(app).post("/price-book/billed-rate").send({ rate: 100 });
    expect(res.status).toBe(200);
    expect((await cell())?.numberValue).toBe(100);
    expect(await sells(FORMULA)).toEqual([70, 80, 95]);
    expect(await sells(CONVERTED)).toEqual([100, 200, 300]);
    expect(await sells(ASSEMBLY)).toEqual([150, 150, 150]);
    expect(await sells(PER_DOLLAR)).toEqual([1, 1, 1]);
    expect((await atomic(PER_DOLLAR)).laborNormal).toBeCloseTo(0.01, 6);
    expect((await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: openDraftId } })).billedLaborRate).toBe(100);
  });
});

describe("the routes refuse a bad rate and write nothing", () => {
  it("POST: zero, negative, over $1,000, three decimals, text, missing", async () => {
    const before = await snapshot();
    for (const body of [{ rate: 0 }, { rate: -5 }, { rate: 1000.01 }, { rate: 100.555 }, { rate: "abc" }, { rate: "100" }, {}]) {
      const res = await request(app).post("/price-book/billed-rate").send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await snapshot()).toBe(before);
  });

  it("GET preview: the same refusals", async () => {
    for (const rate of ["0", "-5", "1001", "100.555", "abc", ""]) {
      const res = await request(app).get("/price-book/billed-rate/preview").query({ rate });
      expect(res.status, rate).toBe(400);
    }
    expect((await request(app).get("/price-book/billed-rate/preview")).status).toBe(400);
  });

  it("the refusal says why, in words", async () => {
    const res = await request(app).post("/price-book/billed-rate").send({ rate: 100.555 });
    expect(JSON.stringify(res.body)).toMatch(/dollars and cents/);
  });
});
