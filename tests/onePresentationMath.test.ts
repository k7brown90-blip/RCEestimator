/**
 * ONE PRESENTATION MATH — the price of "whatever the customer ticked" is worked out by a single
 * pure function and every screen renders its finished table (Kyle, 2026-10-08, "one estimating
 * system"; plan .claude/plans/2026-10-08-one-estimating-system.md, Phase 3 unit A).
 *
 * Before this the same sum — ticked options + the trip − the combined-options material saving −
 * the programme discount (percentage, then the $250 cap) — was written out three times: in the
 * CRM's lib/presentation.ts + PresentationPage, in Estimate Intake's discount block, and in
 * issuedEstimateRender's combo table. Three copies is how an invoice came to contradict the
 * account row (discounts.ts). Now:
 *
 *   shared/quoteMoney.ts  priceSelection()   the only arithmetic
 *   src/services/quoteMoney.ts               builds a draft's figures, ships `money.selections`
 *                                            in the CRM compute payload AND the field quote payload
 *   issuedEstimateRender.ts                  prices the customer's page with the same function
 *
 * These tests pin that the three surfaces give the same total for the same draft + the same ticks,
 * including the programme discount, its cap, the combined-options saving and one-or-the-other mode,
 * and that the field copy carries customer prices only.
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
import { addLine } from "../src/services/atomicEstimateService";
import { createDraft } from "../src/services/atomicEstimateService";
import { buildQuoteMoney } from "../src/services/quoteMoney";
import { allSelectionCaps } from "../src/services/materialMarkupCap";
import { renderEstimatePage } from "../src/services/issuedEstimateRender";
import type { ComputedEstimate } from "../src/services/atomicEstimateEngine";
import type { IssuedEstimateWithLines } from "../src/services/issuedEstimateService";
import {
  defaultSelection,
  picksOne,
  priceAllSelections,
  priceSelection,
  selectionKey,
  selectionPrice,
  type PricingFigures,
  type QuoteMoney,
} from "../shared/quoteMoney";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

// ─── The pure pricer ─────────────────────────────────────────────────────────────────────────

describe("priceSelection — the only arithmetic", () => {
  const figures = (over: Partial<PricingFigures> = {}): PricingFigures => ({
    options: [
      { option: "A", subtotal: 100 },
      { option: "B", subtotal: 300 },
      { option: "C", subtotal: 50 },
    ],
    tripCharge: 200,
    comboSavings: {},
    programme: null,
    ...over,
  });

  it("adds the ticked options, and the trip ONCE", () => {
    expect(priceSelection(figures(), ["A"])).toMatchObject({ key: "A", subtotal: 100, trip: 200, base: 300, discount: 0, total: 300 });
    expect(priceSelection(figures(), ["A", "B"])).toMatchObject({ key: "A+B", subtotal: 400, trip: 200, base: 600, total: 600 });
    // Order of the ticks is irrelevant; the key is canonical.
    expect(priceSelection(figures(), ["B", "A"])!.key).toBe("A+B");
  });

  it("an empty selection, or one holding an unpriced option, has NO price (never $0)", () => {
    expect(priceSelection(figures(), [])).toBeNull();
    const unpriced = figures({ options: [{ option: "A", subtotal: 100 }, { option: "B", subtotal: null }] });
    expect(priceSelection(unpriced, ["A", "B"])).toBeNull();
    expect(priceSelection(unpriced, ["A"])).not.toBeNull();
    // A stale tick for an option the estimate does not hold prices nothing.
    expect(priceSelection(figures(), ["Z"])).toBeNull();
  });

  it("subtracts the combined-options saving for EXACTLY that combination", () => {
    const f = figures({ comboSavings: { "A+B": 40 } });
    expect(priceSelection(f, ["A", "B"])).toMatchObject({ comboSaving: 40, base: 560, total: 560 });
    expect(priceSelection(f, ["A"])!.comboSaving).toBe(0);
    expect(priceSelection(f, ["A", "B", "C"])!.comboSaving).toBe(0);
  });

  it("the programme discount is a percentage of what is LEFT (after trip and saving), then the cap", () => {
    const military = { rate: 0.05, cap: 250 };
    // (100 + 300 + 200 - 40) = 560; 5% = 28
    expect(priceSelection(figures({ comboSavings: { "A+B": 40 }, programme: military }), ["A", "B"])).toMatchObject({
      base: 560, discount: 28, discountCapped: false, total: 532,
    });
    // 5% of 10,000 = 500 -> capped at 250
    const big = figures({ options: [{ option: "A", subtotal: 10000 }], programme: military });
    expect(priceSelection(big, ["A"])).toMatchObject({ base: 10200, discount: 250, discountCapped: true, total: 9950 });
    // The custom percentage has no cap.
    const custom = figures({ options: [{ option: "A", subtotal: 10000 }], programme: { rate: 0.1, cap: null } });
    expect(priceSelection(custom, ["A"])).toMatchObject({ discount: 1020, discountCapped: false, total: 9180 });
  });

  it("prices every combination once, omitting any that holds an unpriced option", () => {
    expect(Object.keys(priceAllSelections(figures())).sort()).toEqual(["A", "A+B", "A+B+C", "A+C", "B", "B+C", "C"]);
    const partly = figures({ options: [{ option: "A", subtotal: 1 }, { option: "B", subtotal: null }] });
    expect(Object.keys(priceAllSelections(partly))).toEqual(["A"]);
  });

  it("eight options is 255 combinations — and they all price", () => {
    const eight = figures({ options: "ABCDEFGH".split("").map((o) => ({ option: o, subtotal: 10 })) });
    expect(Object.keys(priceAllSelections(eight))).toHaveLength(255);
    expect(priceAllSelections(eight)["A+B+C+D+E+F+G+H"].total).toBe(280);
  });

  it("the screens' small helpers: selectionKey, picksOne, defaultSelection, selectionPrice", () => {
    expect(selectionKey(["C", "A", "A"])).toBe("A+C");
    const m = { exclusiveOptions: true, pickable: ["A", "B"] } as Pick<QuoteMoney, "exclusiveOptions" | "pickable">;
    expect(picksOne(m)).toBe(true);
    expect(defaultSelection(m)).toEqual(["A"]); // one-or-the-other starts on the FIRST option only
    expect(defaultSelection({ ...m, exclusiveOptions: false })).toEqual(["A", "B"]); // otherwise everything ticked
    // One option only: nothing to choose between, even with the box ticked.
    expect(picksOne({ exclusiveOptions: true, pickable: ["A"] })).toBe(false);
    const money = { selections: priceAllSelections(figures()) };
    expect(selectionPrice(money, ["B", "A"])!.total).toBe(600);
    expect(selectionPrice(money, [])).toBeNull();
  });
});

// ─── Same figures -> the same total on the CRM payload and the customer's page ───────────────

type Opt = "A" | "B" | "C";

/** Each option: labour $200 + material sold $1,500 on a $600 cost => $1,700 (and a real gate-3 saving together). */
const LINES: Array<{ option: Opt; laborDollars: number; materialSell: number; materialCost: number }> = [
  { option: "A", laborDollars: 200, materialSell: 1500, materialCost: 600 },
  { option: "B", laborDollars: 200, materialSell: 1500, materialCost: 600 },
  { option: "C", laborDollars: 100, materialSell: 150, materialCost: 100 },
];
const TRIP = 200;

function computedFor(): ComputedEstimate {
  const lines = LINES.map((l, i) => ({
    id: `l${i}`, itemId: `i${i}`, description: `Line ${i}`, quantity: 1, laborHours: 2, complete: true, inMaterialCap: true, gaps: [], ...l,
  }));
  return {
    billedLaborRate: 100,
    lines,
    jobFixedCost: TRIP,
    // The engine's own gate 3: every combination, priced from the lines' material cost and sell.
    combinationDiscounts: allSelectionCaps(lines.map((l) => ({ option: l.option, materialCost: l.materialCost, materialSell: l.materialSell }))),
  } as unknown as ComputedEstimate;
}

function issuedFor(over: Record<string, unknown> = {}): IssuedEstimateWithLines {
  const subtotal = (o: Opt) => LINES.filter((l) => l.option === o).reduce((n, l) => n + l.laborDollars + l.materialSell, 0);
  return {
    id: "e1", number: "2026-9001", revision: 1, status: "draft", token: "t".repeat(64),
    customerName: "A Customer", customerEmail: null, customerPhone: null,
    serviceAddress: "1 Main St, Murfreesboro, TN, 37127",
    title: "One presentation math", scopeText: null, includedText: null, validDays: 30,
    workSubtotal: 0, tripCharge: TRIP, tripWaived: false, total: 0,
    createdAt: new Date("2026-10-08T12:00:00Z"), signedAt: null, signerName: null, signatureImage: null,
    selectedOptions: [], supersededBy: null, exclusiveOptions: false, discountType: null, discountPercent: null,
    lines: LINES.map((l, i) => ({
      id: `l${i}`, estimateId: "e1", itemId: `i${i}`, description: `Line ${i}`, quantity: 1, unitPrice: l.laborDollars + l.materialSell,
      lineTotal: l.laborDollars + l.materialSell, sortOrder: i, option: l.option, laborHours: 2,
      materialSell: l.materialSell, materialCost: l.materialCost, flatPriced: false, inMaterialCap: true,
    })),
    options: (["A", "B", "C"] as Opt[]).map((o) => ({ id: `o-${o}`, estimateId: "e1", option: o, label: null, note: null, subtotal: subtotal(o), lineCount: 1 })),
    ...over,
  } as unknown as IssuedEstimateWithLines;
}

/** The finished price table the customer's page ships to its own tick boxes. */
function pageCombos(est: IssuedEstimateWithLines): Record<string, { total: number; saving: number; discount: number }> {
  const html = renderEstimatePage(est);
  const m = html.match(/var combos = (\{[^;]*\});/);
  expect(m, "the page carries its combination table").not.toBeNull();
  return JSON.parse(m![1]);
}

describe("the CRM presentation's numbers and the customer's page agree, tick for tick", () => {
  const programmes: Array<[string, string | null, number | null]> = [
    ["no discount", null, null],
    ["military 5% (cap $250)", "military", null],
    ["custom 10% (no cap)", "custom", 10],
  ];

  for (const [name, type, percent] of programmes) {
    for (const exclusive of [false, true]) {
      it(`${name}${exclusive ? ", one-or-the-other" : ""}: every combination gives the same total, saving and discount`, () => {
        const money = buildQuoteMoney(computedFor(), { discountType: type, discountPercent: percent, exclusiveOptions: exclusive });
        const combos = pageCombos(issuedFor({ discountType: type, discountPercent: percent, exclusiveOptions: exclusive }));

        // The same set of combinations is on offer ...
        expect(Object.keys(combos).sort()).toEqual(Object.keys(money.selections).sort());
        expect(Object.keys(combos)).toHaveLength(7);
        // ... and every one comes to the same figures.
        for (const [key, price] of Object.entries(money.selections)) {
          expect(combos[key], key).toEqual({ total: price.total, saving: price.comboSaving, discount: price.discount });
        }
        // The combined-options saving is real in this fixture (else the check above proves less).
        expect(money.selections["A+B"].comboSaving).toBeGreaterThan(0);
        expect(money.selections["A"].comboSaving).toBe(0);
        if (type === "military") expect(money.selections["A+B"].discount).toBeGreaterThan(0);
        if (type === null) expect(money.selections["A+B"].discount).toBe(0);
      });
    }
  }

  it("the discount programme's headline rows are cut from that same table", () => {
    const money = buildQuoteMoney(computedFor(), { discountType: "custom", discountPercent: 10, exclusiveOptions: false });
    const whole = money.selections["A+B+C"];
    expect(money.discount!.rows).toEqual([
      { label: "whole job", base: whole.base, comboSaving: whole.comboSaving, amount: whole.discount, capped: false, after: whole.total },
    ]);
    expect(money.discountedTotal).toBe(whole.total);
    const each = buildQuoteMoney(computedFor(), { discountType: "custom", discountPercent: 10, exclusiveOptions: true });
    expect(each.discount!.rows.map((r) => [r.label, r.after])).toEqual([
      ["Option A", each.selections["A"].total], ["Option B", each.selections["B"].total], ["Option C", each.selections["C"].total],
    ]);
  });

  it("the $250 cap shows up identically on both", () => {
    // A $10,000 option: 5% = $500 -> capped at $250 on the CRM payload AND on the page.
    const big = computedFor();
    (big.lines as unknown as Array<{ option: string; materialSell: number }>)[0].materialSell = 9800;
    const money = buildQuoteMoney(big, { discountType: "military", discountPercent: null, exclusiveOptions: false });
    expect(money.selections["A"]).toMatchObject({ discount: 250, discountCapped: true });
    const est = issuedFor({ discountType: "military" });
    (est as unknown as { options: Array<{ option: string; subtotal: number }> }).options[0].subtotal = 10000;
    expect(pageCombos(est)["A"].discount).toBe(250);
    expect(pageCombos(est)["A"].total).toBe(money.selections["A"].total);
  });
});

// ─── The same draft through the CRM route, the field route and the customer's page ───────────

const MARK = "ONEPRESMATH";
const ITEM = "OPM-EA"; // flat $70 each (priceBookFixture), so a line's price is easy to read

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;
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
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "onepresmath@example.com", phone: "615-555-0188" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "1 Presentation Way", city: "Murfreesboro", state: "TN", postalCode: "37127" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({ data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" } });
  visitId = visit.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `onepresmath-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.visitAssignment.create({ data: { visitId, technicianId } });
});

afterAll(async () => {
  await cleanEstimatesFor(draftIds);
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftOption.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ITEM]);
});

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);
const fieldQuote = async (id: string) => (await auth(request(app).get(`/health-record/quotes/${id}`))).body.data;
const crmCompute = async (id: string) => (await request(app).get(`/price-book/drafts/${id}/compute`)).body;

/** A draft with A = 1 x $70, B = 3 x $70, C = 2 x $70 (the $200 trip is the fixture's Rate Config). */
async function threeOptionDraft(title: string) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, option: "A" });
  await addLine(prisma, d.id, { itemId: ITEM, quantity: 3, option: "B" });
  await addLine(prisma, d.id, { itemId: ITEM, quantity: 2, option: "C" });
  return d;
}

/** Issue the draft and read the combination table off the customer's public page. */
async function customerPageCombos(draftId: string) {
  const issued = await request(app).post(`/price-book/drafts/${draftId}/issue`).send({ accountId: customerId, serviceAddressId: propertyId });
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: issued.body.estimateId }, select: { token: true } });
  const page = await request(app).get(`/e/${row.token}`);
  expect(page.status).toBe(200);
  const m = page.text.match(/var combos = (\{[^;]*\});/);
  expect(m, "the customer's page carries its combination table").not.toBeNull();
  return JSON.parse(m![1]) as Record<string, { total: number; saving: number; discount: number }>;
}

describe("one draft, three doors: the CRM compute payload, the field quote payload and /e/:token", () => {
  for (const [label, programme, exclusive] of [
    ["military discount", { type: "military" }, false],
    ["custom 7.5% discount", { type: "custom", percent: 7.5 }, false],
    ["military discount, one-or-the-other", { type: "military" }, true],
    ["no discount", null, false],
  ] as Array<[string, { type: string; percent?: number } | null, boolean]>) {
    it(`${label}: the same total for every ticked combination`, async () => {
      const d = await threeOptionDraft(`doors ${label}`);
      if (programme) {
        expect((await request(app).put(`/price-book/drafts/${d.id}/discount`).send(programme)).status).toBe(200);
      }
      if (exclusive) {
        expect((await request(app).put(`/price-book/drafts/${d.id}/options-mode`).send({ exclusive: true })).status).toBe(200);
      }

      const crm = (await crmCompute(d.id)).money as QuoteMoney;
      const field = (await fieldQuote(d.id)).money as QuoteMoney;
      const page = await customerPageCombos(d.id);

      // $70 x 1 / 3 / 2 per option; the $200 trip is charged ONCE however many are ticked.
      expect(crm.selections["A"].subtotal).toBe(70);
      expect(crm.selections["A+B+C"]).toMatchObject({ subtotal: 420, trip: 200, base: 620 });

      // CRM payload == field payload, whole table, both with the same wording of the programme.
      expect(field.selections).toEqual(crm.selections);
      expect(field.exclusiveOptions).toBe(exclusive);
      expect(crm.exclusiveOptions).toBe(exclusive);
      expect(field.discount).toEqual(crm.discount);

      // The ticks the CRM Presentation page starts on, and the number it would show for them.
      const ticks = defaultSelection(crm);
      expect(ticks).toEqual(exclusive ? ["A"] : ["A", "B", "C"]);
      const shown = selectionPrice(crm, ticks)!;
      expect(selectionPrice(field, ticks)!.total).toBe(shown.total);

      // The customer's page: same combinations, same totals, same discount.
      expect(Object.keys(page).sort()).toEqual(Object.keys(crm.selections).sort());
      for (const [key, price] of Object.entries(crm.selections)) {
        expect(page[key], key).toEqual({ total: price.total, saving: price.comboSaving, discount: price.discount });
      }
      // The one the customer sees first, and the one the CRM presentation shows first, are one number
      // in the ordinary mode (everything ticked); in one-or-the-other the page opens on Option A too.
      expect(page[selectionKey(ticks)].total).toBe(shown.total);

      if (programme?.type === "military") expect(shown.discount).toBeGreaterThan(0);
      if (!programme) expect(shown.discount).toBe(0);
    });
  }

  it("the discount block's rows (Estimate Intake) are the same figures the field payload sends", async () => {
    const d = await threeOptionDraft("doors rows");
    await request(app).put(`/price-book/drafts/${d.id}/discount`).send({ type: "senior" });
    const crm = (await crmCompute(d.id)).money as QuoteMoney;
    const field = (await fieldQuote(d.id)).money as QuoteMoney;
    expect(crm.discount!.rows).toEqual(field.discount!.rows);
    expect(crm.discount!.rows[0]).toMatchObject({ label: "whole job", base: crm.selections["A+B+C"].base, after: crm.selections["A+B+C"].total });
    expect(crm.discountedTotal).toBe(crm.selections["A+B+C"].total);
  });
});

// ─── Financing: the same Synchrony figures through all three doors (Phase 5 unit A) ─────────

describe("one draft, three doors: the financing figures are the same everywhere", () => {
  it("CRM compute == field quote == the customer's page, for every ticked combination, and each is the shared calculator over the server's own total", async () => {
    const d = await threeOptionDraft("doors financing");
    expect((await request(app).put(`/price-book/drafts/${d.id}/discount`).send({ type: "military" })).status).toBe(200);

    const crm = (await crmCompute(d.id)).money as QuoteMoney;
    const field = (await fieldQuote(d.id)).money as QuoteMoney;
    expect(crm.financing).toBeTruthy();
    expect(field.financing).toEqual(crm.financing);
    expect(Object.keys(crm.financing!.bySelection).sort()).toEqual(Object.keys(crm.selections).sort());

    // Every selection's offers are the ONE calculator run over that selection's server total.
    const plans = crm.financing!.plans.map((p) => p.planNumber);
    expect(plans).toEqual(["965", "964", "920", "924"]);
    for (const [key, price] of Object.entries(crm.selections)) {
      const entry = crm.financing!.bySelection[key];
      expect(entry.offers.map((o) => o.planNumber)).toEqual(plans);
      const cents = Math.round(price.total * 100);
      // Deposit is a third to the cent; financed = balance + the fee; the payment rounds UP.
      const deposit = Math.round(cents / 3);
      expect(entry.offers[0].deposit).toBe(deposit / 100);
      expect(entry.offers[0].financed).toBe((cents - deposit + Math.round(((cents - deposit) * 6.1) / 200)) / 100);
      expect(entry.fromMonthly).toBe(Math.min(...entry.offers.map((o) => o.monthly)));
    }

    // The page, issued from the same draft, hands its script the same table.
    const issued = await request(app).post(`/price-book/drafts/${d.id}/issue`).send({ accountId: customerId, serviceAddressId: propertyId });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: issued.body.estimateId }, select: { token: true } });
    const html = (await request(app).get(`/e/${row.token}`)).text;
    const m = html.match(/var financing = (.*);\r?\n/);
    expect(m, "the customer's page carries its financing table").not.toBeNull();
    expect(JSON.parse(m![1])).toEqual(crm.financing);
    // ... and never the rate.
    expect(html).not.toMatch(/discountRate|paymentFactor/);
  });
});

// ─── Customer prices only on the phone ───────────────────────────────────────────────────────

describe("the field payload carries customer prices only (the tech hands the phone to the customer)", () => {
  it("money has exactly the named keys, each selection exactly the named figures", async () => {
    const d = await threeOptionDraft("keys");
    await request(app).put(`/price-book/drafts/${d.id}/discount`).send({ type: "military" });
    const q = await fieldQuote(d.id);

    // `financing` (Phase 5, 2026-10-08): the estimator's finished customer-safe figures - see
    // tests/financingEstimator.test.ts and tests/fieldQuoteSettings.test.ts for what it may carry.
    expect(Object.keys(q.money).sort()).toEqual(
      ["discount", "discountedRange", "discountedTotal", "exclusiveOptions", "financing", "pickable", "range", "selections"],
    );
    for (const price of Object.values(q.money.selections) as Array<Record<string, unknown>>) {
      expect(Object.keys(price).sort()).toEqual(
        ["base", "comboSaving", "discount", "discountCapped", "key", "options", "subtotal", "total", "trip"],
      );
    }
    // No hours, no labour dollars, no Red Cedar cost or sell split anywhere in the money block ...
    const { financing: _financing, ...moneyWithoutFinancing } = q.money;
    void _financing;
    const serialised = JSON.stringify(moneyWithoutFinancing);
    for (const banned of ["laborHours", "laborDollars", "labourHours", "materialCost", "materialSell", "companyCost", "billedLaborRate", "profit"]) {
      expect(serialised, banned).not.toContain(banned);
    }
    // ... and the "company view" figures (materials, hours) are not on the phone at all.
    for (const banned of ["laborHours", "laborDollars", "materialCost", "materialSell", "computed", "combinationDiscounts", "materialCaps"]) {
      expect(JSON.stringify(q), banned).not.toContain(banned);
    }
    // The CRM compute payload is the office's: it still carries the company figures the Company view needs.
    const crm = await crmCompute(d.id);
    expect(crm.computed.lines[0]).toHaveProperty("laborHours");
    expect(crm.computed.lines[0]).toHaveProperty("materialCost");
  });
});
