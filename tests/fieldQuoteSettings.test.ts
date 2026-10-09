/**
 * The field Quote screen's estimate-level controls — discount, option names, one-or-the-other mode
 * and copy-an-option — ONE service, two doors (Kyle, 2026-10-08; one-estimating-system plan,
 * Phase 2, unit A).
 *
 * Each rule is a function in src/services/atomicEstimateService.ts (setDraftDiscount, setOptionMeta,
 * setOptionsMode, copyOptionLines). The CRM routes (src/app.ts) and the tech routes
 * (src/routes/health-record.ts, behind quoteDraftForTech) are thin wrappers. Pinned here from BOTH
 * doors so a check that exists on one and not the other fails a test:
 *
 *   - a stranger technician (visit not assigned to them) gets 403 and writes NOTHING;
 *   - a refusal is worded the same and carries the same status on both doors;
 *   - the discount is sent as FINISHED DOLLARS by the server (money.discount) — rate and $250 cap
 *     from discounts.ts — so the phone does no arithmetic (2026-09-24 Unit A trap 2);
 *   - the one-or-the-other range comes from the server too;
 *   - the field payload carries NO labour hours, labour dollars or rates (constants.md "Field app").
 *
 * Kyle, 2026-09-29: the discount, option names and option mode stay editable on a SIGNED estimate in
 * the service (they reach the customer only through "Save changes to the estimate"); copying an
 * option does not. The field screen greys all of them on a signed quote because the truck cannot
 * press that button — that is a screen rule, so it is not asserted here, but the service rules are.
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
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: vi.fn().mockResolvedValue(true), sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { addLine, addOption, createDraft } from "../src/services/atomicEstimateService";
import { DISCOUNT_CAP, discountFor, programmeFor } from "../src/services/discounts";
import { buildQuoteMoney } from "../src/services/quoteMoney";
import type { ComputedEstimate } from "../src/services/atomicEstimateEngine";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "FIELDQSET";
const ITEM = "FQS-EA"; // flat $70 each (priceBookFixture), so a line's price is easy to read

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;
let strangerId: string;
let strangerToken: string;
const draftIds: string[] = [];

async function cleanEstimatesFor(ids: string[]) {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: ids } } });
  const estIds = ests.map((e) => e.id);
  await prisma.payment.deleteMany({ where: { estimateId: { in: estIds } } });
  const jobIds = [...new Set(ests.map((e) => e.jobVisitId).filter((v): v is string => Boolean(v)))];
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: jobIds } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateOption.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null, changeOrderForId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.visit.deleteMany({ where: { id: { in: jobIds } } });
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ITEM, { unit: "ea" })]);
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "fieldqset@example.com", phone: "615-555-0177" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "1 Field Quote Way", city: "Murfreesboro", state: "TN", postalCode: "37127" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" },
  });
  visitId = visit.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `fieldqset-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.visitAssignment.create({ data: { visitId, technicianId } });
  const stranger = await prisma.technician.create({ data: { name: `${MARK} Stranger`, accessToken: `fieldqset-stranger-${customer.id}` } });
  strangerId = stranger.id;
  strangerToken = stranger.accessToken;
});

afterAll(async () => {
  await cleanEstimatesFor(draftIds);
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftOption.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId } });
  await prisma.technician.deleteMany({ where: { id: { in: [technicianId, strangerId] } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ITEM]);
});

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);
const asStranger = (r: request.Test) => r.set("Authorization", `Bearer ${strangerToken}`);

async function newDraft(title: string) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  return d;
}

/** A draft with one line in option A (quantity `qty`, $70 each). */
async function draftWithLine(title: string, qty = 1) {
  const d = await newDraft(title);
  await addLine(prisma, d.id, { itemId: ITEM, quantity: qty });
  return d;
}

async function signedDraft(title: string) {
  const d = await draftWithLine(title);
  const issued = await request(app)
    .post(`/price-book/drafts/${d.id}/issue`)
    .send({ accountId: customerId, serviceAddressId: propertyId });
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  const res = await request(app)
    .post(`/issued-estimates/${issued.body.estimateId}/sign-in-person`)
    .send({ signerName: "Mrs Field Quote", signatureImage: TEST_SIGNATURE, selectedOptions: ["A"] });
  expect(res.body, JSON.stringify(res.body)).toMatchObject({ signed: true });
  return d;
}

const draftRow = (id: string) => prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id } });
const quotePayload = async (id: string) => (await auth(request(app).get(`/health-record/quotes/${id}`))).body.data;

// ─── Discount ─────────────────────────────────────────────────────────────────

describe("PUT /health-record/quotes/:draftId/discount — the CRM's setDraftDiscount", () => {
  it("military: the programme is stored and the payload carries the computed DOLLARS and the amount after", async () => {
    const d = await draftWithLine("disc-military");
    const res = await auth(request(app).put(`/health-record/quotes/${d.id}/discount`).send({ type: "military" }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ success: true, data: { discountType: "military", discountPercent: null } });

    const q = await quotePayload(d.id);
    // $70 line + the $200 trip (priceBookFixture's jobFixedCost) = $270; 5% = $13.50; after = $256.50.
    expect(q.money.discount).toMatchObject({ type: "military", percent: 5, label: "Military discount (5%)", terms: "5% off, capped at $250" });
    expect(q.money.discount.rows).toEqual([
      { label: "Option A", base: 270, comboSaving: 0, amount: 13.5, capped: false, after: 256.5 },
    ]);
    expect(q.money.discountedTotal).toBe(256.5);
    // The ordinary total is unchanged — the discount is shown beside it, never baked into it.
    expect(q.total).toBe(270);
  });

  it("the amount IS the CRM's: the same discountFor(), on the same base the CRM's compute payload gives", async () => {
    const d = await draftWithLine("disc-same-as-crm", 3);
    await auth(request(app).put(`/health-record/quotes/${d.id}/discount`).send({ type: "senior" }));
    const q = await quotePayload(d.id);

    const crm = await request(app).get(`/price-book/drafts/${d.id}/compute`);
    expect(crm.status).toBe(200);
    // The CRM door reads the same programme off the same draft ...
    expect(crm.body.discount).toMatchObject({ type: "senior", percent: 5, cap: DISCOUNT_CAP });
    // ... and the finished figure equals what discounts.ts says for the CRM's own numbers.
    const crmBase = crm.body.options.find((o: { option: string }) => o.option === "A").subtotal + crm.body.computed.jobFixedCost;
    const expected = discountFor(programmeFor("senior"), crmBase)!;
    expect(q.money.discount.rows[0].amount).toBe(expected.amount);
    expect(q.money.discount.rows[0].base).toBe(expected.base);
    expect(q.money.discountedTotal).toBe(Math.round((expected.base - expected.amount) * 100) / 100);
  });

  it("military / senior stop at the $250 cap, and the row says it was capped", async () => {
    const d = await draftWithLine("disc-cap", 100); // 100 x $70 = $7,000 -> 5% would be $360
    await auth(request(app).put(`/health-record/quotes/${d.id}/discount`).send({ type: "military" }));
    const row = (await quotePayload(d.id)).money.discount.rows[0];
    expect(row.amount).toBe(DISCOUNT_CAP);
    expect(row.capped).toBe(true);
  });

  it("custom: any percentage up to 50 is uncapped; the box's figure comes back", async () => {
    const d = await draftWithLine("disc-custom", 100);
    const res = await auth(request(app).put(`/health-record/quotes/${d.id}/discount`).send({ type: "custom", percent: 7.5 }));
    expect(res.body.data).toEqual({ discountType: "custom", discountPercent: 7.5 });
    const q = await quotePayload(d.id);
    expect(q.money.discount).toMatchObject({ type: "custom", percent: 7.5, terms: "7.5% off, no cap", label: "Discount (7.5%)" });
    expect(q.money.discount.rows[0]).toMatchObject({ base: 7200, amount: 540, capped: false, after: 6660 });
  });

  it("Clear: type null removes it from the draft and from the payload", async () => {
    const d = await draftWithLine("disc-clear");
    await auth(request(app).put(`/health-record/quotes/${d.id}/discount`).send({ type: "military" }));
    const cleared = await auth(request(app).put(`/health-record/quotes/${d.id}/discount`).send({ type: null }));
    expect(cleared.status).toBe(200);
    const row = await draftRow(d.id);
    expect(row.discountType).toBeNull();
    expect(row.discountPercent).toBeNull();
    const q = await quotePayload(d.id);
    expect(q.money.discount).toBeNull();
    expect(q.money.discountedTotal).toBeNull();
  });

  it("a custom percentage outside 0 < p <= 50 is refused with the SAME words and status on both doors, writing nothing", async () => {
    const d = await draftWithLine("disc-bounds");
    for (const percent of [0, -5, 50.01, 80]) {
      const crm = await request(app).put(`/price-book/drafts/${d.id}/discount`).send({ type: "custom", percent });
      const tech = await auth(request(app).put(`/health-record/quotes/${d.id}/discount`).send({ type: "custom", percent }));
      expect(crm.status).toBe(400);
      expect(tech.status).toBe(crm.status);
      expect(tech.body.error.message).toBe(crm.body.error);
      expect(tech.body.error.message).toMatch(/above 0 and at most 50/);
    }
    expect((await draftRow(d.id)).discountType).toBeNull();
  });

  it("a stranger technician gets 403 and the discount is NOT written; so does an unknown draft", async () => {
    const d = await draftWithLine("disc-stranger");
    const res = await asStranger(request(app).put(`/health-record/quotes/${d.id}/discount`).send({ type: "military" }));
    expect(res.status).toBe(403);
    expect((await draftRow(d.id)).discountType).toBeNull();
    const gone = await auth(request(app).put(`/health-record/quotes/no-such-draft/discount`).send({ type: "military" }));
    expect(gone.status).toBe(403);
    // No token at all: not reachable.
    const bare = await request(app).put(`/health-record/quotes/${d.id}/discount`).send({ type: "military" });
    expect([401, 403]).toContain(bare.status);
  });

  it("SIGNED draft: the service still takes it (Kyle, 2026-09-29 — it reaches the customer through a revision), identically on both doors", async () => {
    const d = await signedDraft("disc-signed");
    const tech = await auth(request(app).put(`/health-record/quotes/${d.id}/discount`).send({ type: "military" }));
    expect(tech.status).toBe(200);
    const crm = await request(app).put(`/price-book/drafts/${d.id}/discount`).send({ type: "senior" });
    expect(crm.status).toBe(200);
    // The draft stays finalized (it is not reopened) so the revise that follows finds it as expected.
    expect((await draftRow(d.id)).status).toBe("finalized");
  });
});

describe("buildQuoteMoney — the finished figures, without a database", () => {
  const computed = (over: Partial<ComputedEstimate> = {}): ComputedEstimate => ({
    billedLaborRate: 100,
    lines: [
      { id: "1", option: "A", laborHours: 1, laborDollars: 100, materialSell: 50, complete: true },
      { id: "2", option: "B", laborHours: 1, laborDollars: 100, materialSell: 250, complete: true },
    ],
    combinationDiscounts: {},
    jobFixedCost: 0,
    ...over,
  } as unknown as ComputedEstimate);

  it("no programme: no discount, the range only in one-or-the-other mode with two priced options", () => {
    const off = buildQuoteMoney(computed(), { discountType: null, discountPercent: null, exclusiveOptions: false });
    expect(off).toMatchObject({ exclusiveOptions: false, range: null, discount: null, discountedTotal: null, pickable: ["A", "B"] });
    const either = buildQuoteMoney(computed(), { discountType: null, discountPercent: null, exclusiveOptions: true });
    expect(either.range).toEqual({ min: 150, max: 350 });
    // One option only: nothing to choose between, so no range even with the box ticked.
    const one = buildQuoteMoney(computed({ lines: [{ id: "1", option: "A", laborHours: 1, laborDollars: 100, materialSell: 50, complete: true }] as never }), { discountType: null, discountPercent: null, exclusiveOptions: true });
    expect(one.range).toBeNull();
  });

  it("whole job in the ordinary mode; one row per option in one-or-the-other; combined-options saving is in the base", () => {
    const whole = buildQuoteMoney(computed(), { discountType: "military", discountPercent: null, exclusiveOptions: false });
    // 150 + 350 = 500; 5% = 25.
    expect(whole.discount!.rows).toEqual([{ label: "whole job", base: 500, comboSaving: 0, amount: 25, capped: false, after: 475 }]);
    expect(whole.discountedTotal).toBe(475);

    const each = buildQuoteMoney(computed(), { discountType: "custom", discountPercent: 10, exclusiveOptions: true });
    expect(each.discount!.rows.map((r) => [r.label, r.amount, r.after])).toEqual([["Option A", 15, 135], ["Option B", 35, 315]]);
    expect(each.discountedTotal).toBeNull();
    expect(each.discountedRange).toEqual({ min: 135, max: 315 });

    const combo = buildQuoteMoney(
      computed({ combinationDiscounts: { "A+B": { applied: true, reduction: 20 } } as never }),
      { discountType: "custom", discountPercent: 10, exclusiveOptions: false },
    );
    expect(combo.discount!.rows[0]).toMatchObject({ base: 480, comboSaving: 20, amount: 48, after: 432 });
  });

  it("an unpriced option leaves the range and the discount undecided, never zero", () => {
    const unpriced = computed({ billedLaborRate: null as never });
    const m = buildQuoteMoney(unpriced, { discountType: "military", discountPercent: null, exclusiveOptions: true });
    expect(m.range).toBeNull();
    expect(m.discount!.rows).toEqual([]);
    expect(m.discount!.pricedOnceComplete).toBe(true);
  });
});

// ─── One-or-the-other mode ────────────────────────────────────────────────────

describe("PUT /health-record/quotes/:draftId/options-mode — the CRM's setOptionsMode", () => {
  it("ticks the box on the draft, and the payload sends the min-max range (server-computed)", async () => {
    const d = await draftWithLine("mode");
    await addLine(prisma, d.id, { itemId: ITEM, quantity: 3, option: "B" });
    const res = await auth(request(app).put(`/health-record/quotes/${d.id}/options-mode`).send({ exclusive: true }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ success: true, data: { exclusiveOptions: true } });
    // The CRM door reads the same flag.
    expect((await request(app).get(`/price-book/drafts/${d.id}/options-mode`)).body).toEqual({ exclusiveOptions: true });
    const q = await quotePayload(d.id);
    expect(q.money.exclusiveOptions).toBe(true);
    expect(q.money.range).toEqual({ min: 70, max: 210 }); // 1 x $70 .. 3 x $70, trip not in an option's subtotal
    expect(q.money.pickable).toEqual(["A", "B"]);

    // Unticking goes back to adding up.
    await auth(request(app).put(`/health-record/quotes/${d.id}/options-mode`).send({ exclusive: false }));
    const after = await quotePayload(d.id);
    expect(after.money.exclusiveOptions).toBe(false);
    expect(after.money.range).toBeNull();
  });

  // A body that fails the schema: the CRM answers 400 {error:"Validation failed"}, the tech router's own
  // handler answers 422 with the field and the reason in the tech envelope (pre-existing, 2026-10-08
  // Phase 0 note) — different codes, the same rule, and the phone can read the message.
  it("a non-boolean body is refused on both doors; a stranger gets 403 and nothing is written", async () => {
    const d = await draftWithLine("mode-refused");
    expect((await request(app).put(`/price-book/drafts/${d.id}/options-mode`).send({ exclusive: "yes" })).status).toBe(400);
    const refused = await auth(request(app).put(`/health-record/quotes/${d.id}/options-mode`).send({ exclusive: "yes" }));
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toMatch(/exclusive/);
    const stranger = await asStranger(request(app).put(`/health-record/quotes/${d.id}/options-mode`).send({ exclusive: true }));
    expect(stranger.status).toBe(403);
    expect((await draftRow(d.id)).exclusiveOptions).toBe(false);
  });
});

// ─── Option names ─────────────────────────────────────────────────────────────

describe("PUT /health-record/quotes/:draftId/options/:option — the CRM's setOptionMeta", () => {
  it("names an option and describes it; both doors and the payload see it; an empty save takes it off", async () => {
    const d = await draftWithLine("meta");
    await addOption(prisma, d.id); // D
    const res = await auth(request(app).put(`/health-record/quotes/${d.id}/options/d`).send({ label: "  Whole-house rewire ", note: "Every room, new panel" }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ option: "D", label: "Whole-house rewire", note: "Every room, new panel" });
    const crm = await request(app).get(`/price-book/drafts/${d.id}/options`);
    expect(crm.body).toContainEqual({ option: "D", label: "Whole-house rewire", note: "Every room, new panel" });
    const entry = (await quotePayload(d.id)).optionSet.options.find((o: { option: string }) => o.option === "D");
    expect(entry).toMatchObject({ label: "Whole-house rewire", note: "Every room, new panel" });

    const cleared = await auth(request(app).put(`/health-record/quotes/${d.id}/options/D`).send({ label: "", note: "" }));
    expect(cleared.body.data).toEqual({ option: "D", label: null, note: null });
  });

  it("A, B and C can be named too", async () => {
    const d = await draftWithLine("meta-abc");
    const res = await auth(request(app).put(`/health-record/quotes/${d.id}/options/B`).send({ label: "Exterior pathway lights" }));
    expect(res.status).toBe(200);
    expect((await quotePayload(d.id)).optionSet.options.find((o: { option: string }) => o.option === "B").label).toBe("Exterior pathway lights");
  });

  it("an unknown letter is a 400 with the CRM's wording; an over-long name is refused on both doors", async () => {
    const d = await draftWithLine("meta-bad");
    const crm = await request(app).put(`/price-book/drafts/${d.id}/options/Z`).send({ label: "x" });
    const tech = await auth(request(app).put(`/health-record/quotes/${d.id}/options/Z`).send({ label: "x" }));
    expect(tech.status).toBe(400);
    expect(crm.status).toBe(400);
    expect(tech.body.error.message).toBe(crm.body.error);
    const long = "x".repeat(121);
    expect((await request(app).put(`/price-book/drafts/${d.id}/options/A`).send({ label: long })).status).toBe(400);
    const tooLong = await auth(request(app).put(`/health-record/quotes/${d.id}/options/A`).send({ label: long }));
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.error.message).toMatch(/label/);
    expect(await prisma.priceBookDraftOption.count({ where: { draftId: d.id } })).toBe(0);
  });

  it("a stranger gets 403 and no name is written", async () => {
    const d = await draftWithLine("meta-stranger");
    const res = await asStranger(request(app).put(`/health-record/quotes/${d.id}/options/A`).send({ label: "Stolen" }));
    expect(res.status).toBe(403);
    expect(await prisma.priceBookDraftOption.count({ where: { draftId: d.id } })).toBe(0);
  });

  it("SIGNED draft: still takes a name on both doors (it reaches the customer through a revision)", async () => {
    const d = await signedDraft("meta-signed");
    expect((await auth(request(app).put(`/health-record/quotes/${d.id}/options/A`).send({ label: "Signed name" }))).status).toBe(200);
    expect((await request(app).put(`/price-book/drafts/${d.id}/options/A`).send({ label: "Signed name 2" })).status).toBe(200);
  });
});

// ─── Copy one option into another ─────────────────────────────────────────────

describe("POST /health-record/quotes/:draftId/options/copy — the CRM's copyOptionLines", () => {
  it("appends the source's lines to the target (never replaces) and says how many; the CRM sees them", async () => {
    const d = await draftWithLine("copy", 2);
    await addLine(prisma, d.id, { itemId: ITEM, quantity: 9, option: "B" });
    const res = await auth(request(app).post(`/health-record/quotes/${d.id}/options/copy`).send({ from: "A", to: "B" }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ success: true, data: { copied: 1, from: "A", to: "B" } });
    const inB = await prisma.priceBookDraftLine.findMany({ where: { draftId: d.id, option: "B" }, orderBy: { sortOrder: "asc" } });
    expect(inB.map((l) => l.quantity)).toEqual([9, 2]); // the original B line first, the copy after it
    const q = await quotePayload(d.id);
    expect(q.optionSet.options.find((o: { option: string }) => o.option === "B").lineCount).toBe(2);
    const review = await request(app).get(`/price-book/drafts/${d.id}/review`);
    expect(review.body.optionSet.options.find((o: { option: string }) => o.option === "B").lineCount).toBe(2);
  });

  it("copies into an added option (D) too", async () => {
    const d = await draftWithLine("copy-d");
    await addOption(prisma, d.id);
    const res = await auth(request(app).post(`/health-record/quotes/${d.id}/options/copy`).send({ from: "A", to: "D" }));
    expect(res.status).toBe(201);
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id, option: "D" } })).toBe(1);
  });

  it("same option and empty source are refused with the SAME words and status on both doors, writing nothing", async () => {
    const d = await draftWithLine("copy-refused");
    const before = await prisma.priceBookDraftLine.count({ where: { draftId: d.id } });
    for (const body of [{ from: "A", to: "A" }, { from: "C", to: "B" }]) {
      const crm = await request(app).post(`/price-book/drafts/${d.id}/options/copy`).send(body);
      const tech = await auth(request(app).post(`/health-record/quotes/${d.id}/options/copy`).send(body));
      expect(crm.status).toBe(400);
      expect(tech.status).toBe(400);
      expect(tech.body.error.message).toBe(crm.body.error);
    }
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id } })).toBe(before);
    // A letter that is not an option at all is a parse error, on both.
    expect((await request(app).post(`/price-book/drafts/${d.id}/options/copy`).send({ from: "A", to: "Z" })).status).toBe(400);
    expect((await auth(request(app).post(`/health-record/quotes/${d.id}/options/copy`).send({ from: "A", to: "Z" }))).status).toBe(422);
  });

  it("SIGNED draft: a hard refusal from both doors, the same sentence, nothing copied", async () => {
    const d = await signedDraft("copy-signed");
    await prisma.priceBookDraftOption.create({ data: { draftId: d.id, option: "D" } });
    const before = await prisma.priceBookDraftLine.count({ where: { draftId: d.id } });
    const crm = await request(app).post(`/price-book/drafts/${d.id}/options/copy`).send({ from: "A", to: "D" });
    const tech = await auth(request(app).post(`/health-record/quotes/${d.id}/options/copy`).send({ from: "A", to: "D" }));
    expect(crm.status).toBe(400);
    expect(tech.status).toBe(400);
    expect(tech.body.error.message).toMatch(/is SIGNED\. A signed agreement is never edited/);
    expect(tech.body.error.message).toBe(crm.body.error);
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id } })).toBe(before);
    // The payload carries the same sentence as lockedReason, so the screen can grey the button first.
    expect((await quotePayload(d.id)).optionSet.lockedReason).toBe(tech.body.error.message);
  });

  it("a stranger gets 403 and nothing is copied", async () => {
    const d = await draftWithLine("copy-stranger");
    const res = await asStranger(request(app).post(`/health-record/quotes/${d.id}/options/copy`).send({ from: "A", to: "B" }));
    expect(res.status).toBe(403);
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id, option: "B" } })).toBe(0);
  });
});

// ─── What the phone is never sent ─────────────────────────────────────────────

describe("the field quote payload carries no labour and no Red Cedar cost", () => {
  it("no hours, labour dollars, rates, costs or Synchrony anywhere in the JSON — with a discount and a range on", async () => {
    const d = await draftWithLine("no-labour", 4);
    await addLine(prisma, d.id, { itemId: ITEM, quantity: 2, option: "B" });
    await auth(request(app).put(`/health-record/quotes/${d.id}/discount`).send({ type: "custom", percent: 10 }));
    await auth(request(app).put(`/health-record/quotes/${d.id}/options-mode`).send({ exclusive: true }));
    const data = await quotePayload(d.id);
    expect(data.money.discount.rows.length).toBeGreaterThan(0);
    expect(data.money.range).not.toBeNull();

    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, child] of Object.entries(v)) {
          keys.push(k);
          walk(child);
        }
      }
    };
    // PHASE 5 (2026-10-08, deliberate): the field's "Show the customer" screen now carries the
    // in-app financing estimator's FINISHED figures - plan descriptions with APR/term, the fee as a
    // line, the monthly payment - and each plan's Synchrony disclosure text verbatim (Kyle: credit
    // terms may appear on the field presentation screen, only with the lender's disclosure). That
    // one subtree, `money.financing`, is allowed to say "apr", "fee" and "Synchrony"; everything
    // else on the phone is held to the old rule, and the subtree itself is pinned key for key below
    // so Synchrony's discount rate (Red Cedar's cost) cannot ride in with it.
    const { financing, ...moneyWithoutFinancing } = data.money;
    walk({ ...data, money: moneyWithoutFinancing });
    const forbidden = keys.filter((k) => /hours|labou?r(?!Provisional)|rate(?!Provisional)|cost|markup|synchrony|apr|fee/i.test(k));
    expect(forbidden).toEqual([]);
    expect(JSON.stringify({ ...data, money: moneyWithoutFinancing })).not.toMatch(/synchrony/i);

    // The financing subtree: exactly the customer-safe keys, no rate, no factor, no sort/active flags.
    expect(financing).toBeTruthy();
    const finKeys = new Set<string>();
    const walkFin = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walkFin);
      else if (v && typeof v === "object") {
        for (const [k, child] of Object.entries(v)) {
          if (!/^(A|B|C|D|E|F|G|H)(\+[A-H])*$/.test(k)) finKeys.add(k);
          walkFin(child);
        }
      }
    };
    walkFin(financing);
    expect([...finKeys].sort()).toEqual([
      "apr", "bySelection", "deposit", "description", "disclosure", "fee", "financed", "fromMonthly",
      "fromPlanNumber", "important", "explanation", "monthly", "months", "offers", "planNumber", "plans", "terms", "type",
    ].sort());
    expect(JSON.stringify(financing)).not.toMatch(/discountRate|paymentFactor|"active"|sortOrder/);
  });
});
