/**
 * Sales tax INSIDE every sell, and the automatic reprice that gets the book there (Kyle).
 *
 *   2026-11-24: "sell = hours x shop rate + (cost x (1 + tax rate)) x 1.3" - answers: labor rate "The shop rate in Settings",
 *   sales tax "Tax in sell, all items".   2026-11-25: reprice "Automatically on deploy".
 *
 * Pinned here, through the real services and routes:
 *   1. The formula: $10.00 pre-tax at 9.75% -> cost + tax $10.98 -> x 1.30 = $14.27; 0.5 h x $100 + $14.27 = $64.27. The markup TIER is read off
 *      the PRE-TAX cost. An assembly is taxed ONCE, on its rolled-up pre-tax cost.
 *   2. The $3,000+ job material cap is measured on the cost WITH tax, so it does not trim the tax back out.
 *   3. The reprice: it runs once for a new rate and not again for the same rate; never on a missing or unusable saved rate; it leaves a
 *      hand-priced item exactly as it was and lists it; it writes a PriceBookEdit row per changed column; concurrent runs do it once.
 *   4. Saving the tax rate (PUT /crm/settings/purchasing) reprices, and says how many items and how many hand-priced ones it left alone.
 *   5. An issued estimate is frozen (not a column moves); an open draft reads the new prices.
 *
 * Builds its own price-book rows (tests/helpers/priceBookFixture.ts) and tears down what it made; the settings and Rate Config cells it
 * borrows are put back.
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
import { addLine, computeDraft, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { computeEstimate, resolveCatalogAtSupplier, type DraftLineInput, type EngineAtomic } from "../src/services/atomicEstimateEngine";
import { createAssembly } from "../src/services/priceBookAssembly";
import { computePricing, createAtomic, loadPricingContext } from "../src/services/priceBookCatalog";
import { BOOK_TAX_CELL, TAX_REPRICE_EDITOR, repriceBookForTaxRate } from "../src/services/priceBookTaxReprice";
import { capMaterial, JOB_MATERIAL_BANDS } from "../src/services/materialMarkupCap";
import { getSalesTaxRate, readSavedSalesTaxRate } from "../src/services/purchasingSettings";
import type { MarkupTiers, RateConfig } from "../src/services/priceBookPricing";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "PTX";
const F_MATLAB = `${MARK}-MATLAB`; // material + labor, cost $10.00, priced the old way (no tax)
const F_MATONLY = `${MARK}-MATONLY`; // material only, cost $80.00
const F_LABOR = `${MARK}-LABOR`; // labour only: no cost, no tax
const F_HAND = `${MARK}-HAND`; // a hand-set price that follows no formula
const F_ASM = `${MARK}-ASM`; // an assembly, rolled-up pre-tax cost $32.00
const F_LIVE = `${MARK}-LIVE`; // priced live at a supplier: cost, no stored sells
const SEEDED = [F_MATLAB, F_MATONLY, F_LABOR, F_HAND, F_ASM, F_LIVE];

const TIER_KEYS = ["markupTier1", "markupTier2", "markupTier3", "markupTier4", "markupTier5"];
const savedTiers = new Map<string, number | null | "absent">();
let savedPurchasing: string | "absent" = "absent";
let savedBookCell: number | null | "absent" = "absent";
const made: string[] = []; // items created through createAtomic / createAssembly, for teardown

const setPurchasing = (value: unknown) =>
  prisma.companySetting.upsert({ where: { key: "purchasing" }, create: { key: "purchasing", valueJson: JSON.stringify(value) }, update: { valueJson: JSON.stringify(value) } });
const bookCell = async () => (await prisma.priceBookRateConfig.findUnique({ where: { key: BOOK_TAX_CELL } }))?.numberValue ?? null;
const atomic = (itemId: string) => prisma.priceBookAtomic.findUniqueOrThrow({ where: { itemId } });
const mine = (rows: Array<{ itemId: string }>) => rows.filter((r) => SEEDED.includes(r.itemId));
const editCount = () => prisma.priceBookEdit.count({ where: { itemId: { in: SEEDED }, editedBy: TAX_REPRICE_EDITOR } });

beforeAll(async () => {
  await ensurePriceBookGates();
  for (const key of TIER_KEYS) {
    const row = await prisma.priceBookRateConfig.findUnique({ where: { key } });
    savedTiers.set(key, row ? row.numberValue : "absent");
    await prisma.priceBookRateConfig.upsert({ where: { key }, create: { key, label: `${key} (test)`, workbookRow: 0, numberValue: 1.3 }, update: { numberValue: 1.3 } });
  }
  const purchasing = await prisma.companySetting.findUnique({ where: { key: "purchasing" } });
  savedPurchasing = purchasing ? purchasing.valueJson : "absent";
  const cell = await prisma.priceBookRateConfig.findUnique({ where: { key: BOOK_TAX_CELL } });
  savedBookCell = cell ? cell.numberValue : "absent";
  await prisma.priceBookRateConfig.deleteMany({ where: { key: BOOK_TAX_CELL } }); // the book as it was before 2026-11-25: priced with no tax in it
  await setPurchasing({ salesTaxRate: 0.0975 });

  // The book as it stands BEFORE the tax goes in: price = cost x 1.30, sell = hours x $100 + price.
  await seedAtomics([
    quotableAtomic(F_MATLAB, {
      description: `${MARK} material and labor`, companyCost: 10, companyPrice: 13,
      laborNormal: 0.5, laborDifficult: 0.75, laborVeryDifficult: 1, sellNormal: 63, sellDifficult: 88, sellVeryDifficult: 113,
    }),
    quotableAtomic(F_MATONLY, {
      description: `${MARK} material only`, rowType: "MATERIAL ONLY", companyCost: 80, companyPrice: 104,
      laborNormal: null, laborDifficult: null, laborVeryDifficult: null, sellNormal: 104, sellDifficult: 104, sellVeryDifficult: 104,
    }),
    quotableAtomic(F_LABOR, {
      description: `${MARK} labor only`, rowType: "LABOR ONLY", companyCost: null, companyPrice: null,
      laborNormal: 0.5, laborDifficult: 0.75, laborVeryDifficult: 1, sellNormal: 50, sellDifficult: 75, sellVeryDifficult: 100,
    }),
    // cost $10, but the price was set by hand: $20 where the formula says $13
    quotableAtomic(F_HAND, {
      description: `${MARK} hand priced`, companyCost: 10, companyPrice: 20,
      laborNormal: 0.5, laborDifficult: 0.75, laborVeryDifficult: 1, sellNormal: 99, sellDifficult: 99, sellVeryDifficult: 99,
    }),
    quotableAtomic(F_ASM, {
      description: `${MARK} assembly`, rowType: "ASSEMBLY", companyCost: 32, companyPrice: 41.6,
      laborNormal: 1, laborDifficult: 1.5, laborVeryDifficult: 2, sellNormal: 141.6, sellDifficult: 191.6, sellVeryDifficult: 241.6,
    }),
    // priced live at a supplier by the engine: a cost, a stored marked-up price, and NO stored sell
    quotableAtomic(F_LIVE, {
      description: `${MARK} supplier priced`, companyCost: 4, companyPrice: 5.2,
      laborNormal: null, laborDifficult: null, laborVeryDifficult: null, sellNormal: null, sellDifficult: null, sellVeryDifficult: null,
    }),
  ]);
});

afterAll(async () => {
  const drafts = await prisma.priceBookDraftEstimate.findMany({ where: { title: { startsWith: MARK } }, select: { id: true } });
  const draftIds = drafts.map((d) => d.id);
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
  await prisma.visit.deleteMany({ where: { purpose: { startsWith: MARK } } });
  await prisma.property.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: MARK } } });
  const all = [...SEEDED, ...made];
  await prisma.priceBookItemComponent.deleteMany({ where: { OR: [{ parentItemId: { in: all } }, { childItemId: { in: all } }] } });
  await prisma.priceBookEdit.deleteMany({ where: { itemId: { in: all } } });
  await deleteAtomics(all);
  for (const [key, was] of savedTiers) {
    if (was === "absent") await prisma.priceBookRateConfig.deleteMany({ where: { key } });
    else await prisma.priceBookRateConfig.update({ where: { key }, data: { numberValue: was } });
  }
  if (savedPurchasing === "absent") await prisma.companySetting.deleteMany({ where: { key: "purchasing" } });
  else await prisma.companySetting.update({ where: { key: "purchasing" }, data: { valueJson: savedPurchasing } });
  if (savedBookCell === "absent") await prisma.priceBookRateConfig.deleteMany({ where: { key: BOOK_TAX_CELL } });
  else await prisma.priceBookRateConfig.upsert({ where: { key: BOOK_TAX_CELL }, create: { key: BOOK_TAX_CELL, label: "restored", workbookRow: 0, numberValue: savedBookCell }, update: { numberValue: savedBookCell } });
  await ensurePriceBookGates();
});

describe("the formula: tax inside the sell (Kyle 2026-11-24, 'Tax in sell, all items')", () => {
  const TIERS: MarkupTiers = { tier1: 1.3, tier2: 1.3, tier3: 1.3, tier4: 1.3, tier5: 1.3 };

  it("$10.00 pre-tax at 9.75% -> cost + tax $10.98 -> x 1.30 = $14.27; 0.5 h x $100 + $14.27 = $64.27", () => {
    const p = computePricing({ rowType: "MATERIAL + LABOR", companyCost: 10, laborNormal: 0.5, laborDifficult: null, laborVeryDifficult: null }, TIERS, 100, 0.0975);
    expect(p.companyCostWithTax).toBe(10.98); // round2(10.975)
    expect(p.companyPrice).toBe(14.27); // 10 x 1.0975 x 1.3 = 14.2675, rounded once
    expect(p.sellNormal).toBe(64.27);
    expect(p.markupTier).toBe("T3");
  });

  it("a rate of 0 is the old book exactly", () => {
    const p = computePricing({ rowType: "MATERIAL + LABOR", companyCost: 10, laborNormal: 0.5, laborDifficult: null, laborVeryDifficult: null }, TIERS, 100, 0);
    expect([p.companyCostWithTax, p.companyPrice, p.sellNormal]).toEqual([10, 13, 63]);
  });

  it("the markup TIER is chosen on the PRE-TAX cost: $9.99 stays T2 although $9.99 + tax is over $10", () => {
    const p = computePricing({ rowType: "MATERIAL ONLY", companyCost: 9.99, laborNormal: null, laborDifficult: null, laborVeryDifficult: null }, TIERS, 100, 0.0975);
    expect(p.markupTier).toBe("T2");
    expect(p.companyCostWithTax).toBe(10.96);
  });

  it("the shop rate in Settings is the labour rate, not a typed $150", () => {
    const at100 = computePricing({ rowType: "MATERIAL + LABOR", companyCost: 10, laborNormal: 1, laborDifficult: null, laborVeryDifficult: null }, TIERS, 100, 0.0975);
    const at125 = computePricing({ rowType: "MATERIAL + LABOR", companyCost: 10, laborNormal: 1, laborDifficult: null, laborVeryDifficult: null }, TIERS, 125, 0.0975);
    expect(at100.sellNormal).toBe(114.27);
    expect(at125.sellNormal).toBe(139.27);
  });

  it("every writer reads the SAME rate from the one reader: createAtomic and createAssembly price with Settings' 9.75%", async () => {
    expect(await getSalesTaxRate()).toBe(0.0975);
    expect((await loadPricingContext(prisma)).taxRate).toBe(0.0975);
    const a = await createAtomic(prisma, { itemId: `${MARK}-NEWA`, description: `${MARK} new A`, category: `${MARK} cat`, rowType: "MATERIAL + LABOR", companyCost: 10, laborNormal: 0.5 }, "test");
    const b = await createAtomic(prisma, { itemId: `${MARK}-NEWB`, description: `${MARK} new B`, category: `${MARK} cat`, rowType: "MATERIAL + LABOR", companyCost: 4, laborNormal: 0.1 }, "test");
    made.push(`${MARK}-NEWA`, `${MARK}-NEWB`);
    if (!a.ok || !b.ok) throw new Error("create failed");
    expect(await atomic(`${MARK}-NEWA`)).toMatchObject({ companyCost: 10, companyCostWithTax: 10.98, companyPrice: 14.27, sellNormal: 64.27 });
  });

  it("an assembly is taxed ONCE, on its rolled-up pre-tax cost - never tax on a component's tax or price", async () => {
    // 2 x $10 + 3 x $4 = $32.00 pre-tax
    const asm = await createAssembly(prisma, {
      itemId: `${MARK}-NEWASM`, description: `${MARK} new assembly`, category: `${MARK} cat`,
      components: [{ childItemId: `${MARK}-NEWA`, quantity: 2 }, { childItemId: `${MARK}-NEWB`, quantity: 3 }],
    }, "test");
    made.push(`${MARK}-NEWASM`);
    expect(asm.ok).toBe(true);
    const row = await atomic(`${MARK}-NEWASM`);
    expect(row.companyCost).toBe(32);
    expect(row.companyCostWithTax).toBe(35.12); // 32 x 1.0975
    expect(row.companyPrice).toBe(45.66); // 32 x 1.0975 x 1.3 = 45.656
    // The tax-on-tax answer, had a component's tax-in cost been summed and taxed again, is a different number.
    const a = await atomic(`${MARK}-NEWA`);
    const b = await atomic(`${MARK}-NEWB`);
    const twice = Math.round(((a.companyCostWithTax ?? 0) * 2 + (b.companyCostWithTax ?? 0) * 3) * 1.0975 * 1.3 * 100) / 100;
    expect(twice).not.toBe(row.companyPrice);
    expect(row.sellNormal).toBe(Math.round((row.laborNormal! * 100 + 45.66) * 100) / 100);
  });
});

describe("the $3,000+ material cap is measured on the cost WITH tax", () => {
  const RC: RateConfig = {
    billedLaborRate: 100, inspectionCoordination: 0, inspectionFolded: 0, utilityStandby: 0, permitFee: null, jobFixedCost: 200, activeSupplier: "HD",
    markupTiers: { tier1: 1.3, tier2: 1.3, tier3: 1.3, tier4: 1.3, tier5: 1.3 },
    // Kyle's live schedule: the $3,000+ ceiling was raised to the flat markup (applyMaterialMarkup.ts, "Market standard is 30%").
    jobBands: { b1: 1.3, b2: 1.3, b3: 1.3, b4: 1.3, max1: 250, max2: 1000, max3: 3000 },
  };

  it("1,000 ft of $3.10/ft wire (a $3,100 job) keeps its tax: the sell is not trimmed to 1.30 x the pre-tax cost", () => {
    const priced = computePricing({ rowType: "MATERIAL ONLY", companyCost: 3.1, laborNormal: null, laborDifficult: null, laborVeryDifficult: null }, RC.markupTiers, 100, 0.0975);
    expect(priced.companyPrice).toBe(4.42); // 3.10 x 1.0975 x 1.3 = 4.423
    const wire: EngineAtomic = {
      itemId: "PTX-WIRE", description: "THHN #12 AWG building wire", unit: "ft", rowType: "MATERIAL ONLY",
      laborNormal: null, laborDifficult: null, laborVeryDifficult: null, laborUnitBasis: "E", laborUnitDivisor: 1, laborUnitBasisRaw: "E",
      costBasisUsed: 3.1, sellPricePerUnit: priced.companyPrice, necaUnitBasis: null, source: "in-app",
      sellNormal: priced.sellNormal, sellDifficult: priced.sellDifficult, sellVeryDifficult: priced.sellVeryDifficult, companyCost: 3.1, companyPrice: priced.companyPrice,
    };
    const resolved = resolveCatalogAtSupplier([wire], [], "HD", RC.markupTiers, 0.0975);
    const lines: DraftLineInput[] = [{ itemId: "PTX-WIRE", quantity: 1000, quantitySource: "MEASURED_LENGTH", difficulty: "NORMAL" }];
    const out = computeEstimate(lines, resolved, RC, "HD");
    const line = out.lines[0]!;
    expect(line.inMaterialCap).toBe(true);
    expect(line.materialCost).toBe(3100); // still the PRE-TAX cost: job costing and the frozen line read this
    expect(line.materialCostWithTax).toBe(3402.25); // 3.10 x 1.0975 x 1000: the cap's basis
    expect(out.materialCaps["A"]?.applied).toBe(false);
    expect(out.materialSell).toBe(4420);

    // The same job measured on the pre-tax cost WOULD have been trimmed to 1.30 x $3,100 = $4,030, stripping $390 of the tax.
    const preTax = capMaterial(3100, 4420, JOB_MATERIAL_BANDS.map((b) => ({ ...b, ceiling: 1.3 })));
    expect(preTax.applied).toBe(true);
    expect(preTax.cappedSell).toBe(4030);
  });
});

describe("the automatic reprice", () => {
  // Kyle 2026-11-24: "a company setting (default 9.75%, editable in Settings)". This test used to pin that a MISSING setting skips the start-up
  // reprice ("the 9.75% fallback is not a saved number"). A setting that was never saved IS the default now: see "never saved" below. What is
  // still skipped is a setting that holds something that is not a rate - a percent typed where a fraction belongs, text, unreadable JSON.
  it("does nothing, and says so, when what is saved is not a usable rate (a percent, text, unreadable JSON): nothing is guessed and the row is left as it is", async () => {
    const before = JSON.stringify(await atomic(F_MATLAB));
    for (const garbled of [JSON.stringify({ salesTaxRate: 9.75 }), JSON.stringify({ salesTaxRate: "9.75%" }), JSON.stringify({ salesTaxRate: -0.1 }), "{not json"]) {
      await prisma.companySetting.upsert({ where: { key: "purchasing" }, create: { key: "purchasing", valueJson: garbled }, update: { valueJson: garbled } });
      expect(await readSavedSalesTaxRate(), garbled).toBeNull();
      const none = await repriceBookForTaxRate(prisma, { trigger: "test" });
      expect(none.status, garbled).toBe("skipped_no_saved_rate");
      expect(JSON.stringify(await atomic(F_MATLAB)), garbled).toBe(before);
      expect(await bookCell(), garbled).toBeNull();
      expect((await prisma.companySetting.findUniqueOrThrow({ where: { key: "purchasing" } })).valueJson, garbled).toBe(garbled);
    }
    await setPurchasing({ salesTaxRate: 0.0975 });
  });

  it("brings the book to 9.75% once: formula items repriced, hand-priced and no-cost items untouched, hand-priced listed", async () => {
    const handBefore = JSON.stringify(await atomic(F_HAND));
    const laborBefore = JSON.stringify(await atomic(F_LABOR));
    const r = await repriceBookForTaxRate(prisma, { trigger: "test" });
    expect(r.status).toBe("repriced");
    expect(r.previousRate).toBe(0);
    expect(r.newRate).toBe(0.0975);
    expect(await bookCell()).toBe(0.0975);

    // cost + tax $10.98, price $14.27, sells hours x $100 + $14.27
    expect(await atomic(F_MATLAB)).toMatchObject({ companyCost: 10, companyCostWithTax: 10.98, companyPrice: 14.27, sellNormal: 64.27, sellDifficult: 89.27, sellVeryDifficult: 114.27, markupTier: "T3" });
    // material only: 80 x 1.0975 = 87.8; x 1.3 = 114.14, every sell column
    expect(await atomic(F_MATONLY)).toMatchObject({ companyCost: 80, companyCostWithTax: 87.8, companyPrice: 114.14, sellNormal: 114.14, sellDifficult: 114.14, sellVeryDifficult: 114.14 });
    // an assembly: taxed once on its stored pre-tax cost $32.00 -> $35.12 -> $45.66, sells 1/1.5/2 h x $100 + $45.66
    expect(await atomic(F_ASM)).toMatchObject({ companyCost: 32, companyCostWithTax: 35.12, companyPrice: 45.66, sellNormal: 145.66, sellDifficult: 195.66, sellVeryDifficult: 245.66 });
    // priced live at a supplier: cost-with-tax and marked-up price follow, and no sell column is invented
    expect(await atomic(F_LIVE)).toMatchObject({ companyCost: 4, companyCostWithTax: 4.39, companyPrice: 5.71, sellNormal: null, sellDifficult: null, sellVeryDifficult: null });

    // untouched, byte for byte
    expect(JSON.stringify(await atomic(F_HAND))).toBe(handBefore);
    expect(JSON.stringify(await atomic(F_LABOR))).toBe(laborBefore);

    // hand-priced items are listed with the reason; nothing else of mine is
    expect(mine(r.handPriced).map((h) => h.itemId)).toEqual([F_HAND]);
    expect(r.handPriced.find((h) => h.itemId === F_HAND)?.why).toMatch(/marked-up price/);
    expect(r.handPricedCount).toBeGreaterThanOrEqual(1);
    expect(r.itemsRepriced).toBeGreaterThanOrEqual(4);
    expect(r.assembliesRepriced).toBeGreaterThanOrEqual(1);
    expect(r.editsWritten).toBeGreaterThanOrEqual(10);

    // a PriceBookEdit per changed column, by the system, naming the old and new rate
    const e = await prisma.priceBookEdit.findMany({ where: { itemId: F_MATLAB, editedBy: TAX_REPRICE_EDITOR }, orderBy: { field: "asc" } });
    expect(e.map((x) => [x.field, x.oldValue, x.newValue])).toEqual([
      ["companyCostWithTax", null, "10.98"],
      ["companyPrice", "13", "14.27"],
      ["markupTier", null, "T3"], // the fixture row never had its tier written; the reprice writes the whole formula
      ["sellDifficult", "88", "89.27"],
      ["sellNormal", "63", "64.27"],
      ["sellVeryDifficult", "113", "114.27"],
    ]);
    expect(e[0]!.note).toContain("0% -> 9.75%");
    expect(await prisma.priceBookEdit.count({ where: { itemId: { in: [F_HAND, F_LABOR] }, editedBy: TAX_REPRICE_EDITOR } })).toBe(0);
  });

  it("runs ONCE for a rate: the second run for the same rate changes nothing and writes nothing", async () => {
    const edits = await editCount();
    const snap = JSON.stringify(await prisma.priceBookAtomic.findMany({ where: { itemId: { in: SEEDED } }, orderBy: { itemId: "asc" } }));
    const again = await repriceBookForTaxRate(prisma, { trigger: "test" });
    expect(again.status).toBe("current");
    expect(again.itemsRepriced).toBe(0);
    expect(await editCount()).toBe(edits);
    expect(JSON.stringify(await prisma.priceBookAtomic.findMany({ where: { itemId: { in: SEEDED } }, orderBy: { itemId: "asc" } }))).toBe(snap);
  });

  it("two runs at once for a new rate: one reprices, the other finds it done (the advisory lock)", async () => {
    await setPurchasing({ salesTaxRate: 0.1 });
    const edits = await editCount();
    const [a, b] = await Promise.all([repriceBookForTaxRate(prisma, { trigger: "test" }), repriceBookForTaxRate(prisma, { trigger: "test" })]);
    expect([a.status, b.status].sort()).toEqual(["current", "repriced"]);
    // 10 x 1.10 = 11.00; x 1.3 = 14.30; 0.5 h x $100 + 14.30 = 64.30
    expect(await atomic(F_MATLAB)).toMatchObject({ companyCostWithTax: 11, companyPrice: 14.3, sellNormal: 64.3 });
    // exactly ONE set of edits for the move: F_MATLAB's cost+tax, price and three sells change once each (5), not twice
    expect(await prisma.priceBookEdit.count({ where: { itemId: F_MATLAB, editedBy: TAX_REPRICE_EDITOR, note: { contains: "9.75% -> 10%" } } })).toBe(5);
    expect(await editCount()).toBeGreaterThan(edits);
    await setPurchasing({ salesTaxRate: 0.0975 });
  });

  // Kyle 2026-11-24, "a company setting (default 9.75%, editable in Settings)": with NO rate ever saved, the start-up reprice uses the default,
  // SAVES it as the Settings -> Purchasing rate in the same transaction, and reprices. (Carried fix from the tax-in-sell batch.)
  it("never saved: the start-up run uses the default 9.75%, saves it as the setting in the same transaction, and reprices the book", async () => {
    // Put the book at 10% so there is something to move, then take the setting away entirely (a production database with no purchasing row).
    await setPurchasing({ salesTaxRate: 0.1 });
    await repriceBookForTaxRate(prisma, { trigger: "test" });
    expect(await atomic(F_MATLAB)).toMatchObject({ companyCostWithTax: 11, companyPrice: 14.3, sellNormal: 64.3 });
    await prisma.companySetting.deleteMany({ where: { key: "purchasing" } });
    expect(await readSavedSalesTaxRate()).toBeNull();

    const r = await repriceBookForTaxRate(prisma, { trigger: "startup" });
    expect(r).toMatchObject({ status: "repriced", previousRate: 0.1, newRate: 0.0975, savedTheDefault: true });
    expect(await atomic(F_MATLAB)).toMatchObject({ companyCostWithTax: 10.98, companyPrice: 14.27, sellNormal: 64.27 });
    expect(await bookCell()).toBe(0.0975);
    // The default is now a SAVED number: Settings shows 9.75%, and the strict reader finds it.
    expect(JSON.parse((await prisma.companySetting.findUniqueOrThrow({ where: { key: "purchasing" } })).valueJson)).toEqual({ salesTaxRate: 0.0975 });
    expect(await readSavedSalesTaxRate()).toBe(0.0975);
    // The next run finds nothing to do and does not say it saved the default again.
    const again = await repriceBookForTaxRate(prisma, { trigger: "startup" });
    expect(again.status).toBe("current");
    expect(again.savedTheDefault).toBe(false);

    // A row that exists but was never given a rate (some other purchasing field only) is also "never saved": the default is merged in, the rest kept.
    await prisma.companySetting.update({ where: { key: "purchasing" }, data: { valueJson: JSON.stringify({ note: "keep me" }) } });
    await prisma.priceBookRateConfig.deleteMany({ where: { key: BOOK_TAX_CELL } });
    const merged = await repriceBookForTaxRate(prisma, { trigger: "startup" });
    expect(merged.status).toBe("repriced");
    expect(merged.savedTheDefault).toBe(true);
    expect(JSON.parse((await prisma.companySetting.findUniqueOrThrow({ where: { key: "purchasing" } })).valueJson)).toEqual({ note: "keep me", salesTaxRate: 0.0975 });
    expect(await atomic(F_MATLAB)).toMatchObject({ companyCostWithTax: 10.98, companyPrice: 14.27, sellNormal: 64.27 });
    // Leave the fixture as the next describe expects it: the book at 10%, Settings saying 9.75%.
    await setPurchasing({ salesTaxRate: 0.1 });
    await repriceBookForTaxRate(prisma, { trigger: "test" });
    await setPurchasing({ salesTaxRate: 0.0975 });
  });
});

describe("saving the sales tax rate reprices the book, and the screen is told how many", () => {
  it("PUT /crm/settings/purchasing: a different rate reprices and reports items repriced and hand-priced left alone", async () => {
    const res = await request(app).put("/crm/settings/purchasing").send({ salesTaxRate: 0.0975 });
    expect(res.status).toBe(200);
    expect(res.body.reprice).toMatchObject({ status: "repriced", previousRate: 0.1, newRate: 0.0975 });
    expect(res.body.reprice.itemsRepriced).toBeGreaterThanOrEqual(4);
    expect(res.body.reprice.handPricedCount).toBeGreaterThanOrEqual(1);
    expect(mine(res.body.reprice.handPriced).map((h: { itemId: string }) => h.itemId)).toEqual([F_HAND]);
    expect(await atomic(F_MATLAB)).toMatchObject({ companyCostWithTax: 10.98, companyPrice: 14.27, sellNormal: 64.27 });
    expect(await bookCell()).toBe(0.0975);
  });

  it("saving the SAME rate again repriced nothing: 'already priced at that rate'", async () => {
    const res = await request(app).put("/crm/settings/purchasing").send({ salesTaxRate: 0.0975 });
    expect(res.status).toBe(200);
    expect(res.body.reprice).toMatchObject({ status: "current", itemsRepriced: 0 });
  });

  it("refuses a percent typed where a fraction belongs, and saves nothing", async () => {
    const res = await request(app).put("/crm/settings/purchasing").send({ salesTaxRate: 9.75 });
    expect(res.status).toBe(400);
    expect(await readSavedSalesTaxRate()).toBe(0.0975);
    expect((await request(app).put("/crm/settings/purchasing").send({})).status).toBe(400);
  });

  it("another settings card does not reprice", async () => {
    const edits = await editCount();
    const existing = await prisma.companySetting.findUnique({ where: { key: "operatingHours" } });
    const res = await request(app).put("/crm/settings/operatingHours").send(existing ? JSON.parse(existing.valueJson) : { note: "x" });
    expect(res.status).toBe(200);
    expect(res.body.reprice).toBeUndefined();
    expect(await editCount()).toBe(edits);
    if (!existing) await prisma.companySetting.deleteMany({ where: { key: "operatingHours" } });
  });
});

describe("the reprice against edits and gaps (review fixes, Kyle 2026-11-24 'Tax in sell, all items')", () => {
  const priceAt = async (cost: number, taxRate: number) => {
    const ctx = await loadPricingContext(prisma);
    return computePricing(
      { rowType: "MATERIAL + LABOR", companyCost: cost, laborNormal: 0.5, laborDifficult: 0.75, laborVeryDifficult: 1 },
      ctx.tiers, ctx.rate, taxRate,
    );
  };
  const priced = (p: Awaited<ReturnType<typeof priceAt>>) => ({
    markupTier: p.markupTier, companyCostWithTax: p.companyCostWithTax, companyPrice: p.companyPrice,
    sellNormal: p.sellNormal, sellDifficult: p.sellDifficult, sellVeryDifficult: p.sellVeryDifficult,
  });

  it("an item edit that commits while the reprice is waiting is read by it, not overwritten with prices from the old cost", async () => {
    expect(await bookCell()).toBe(0.0975);
    // A writer (a CRM edit, an approved agent proposal) moves F_MATLAB's cost $10 -> $20 with its prices at the book's 9.75%, and has not committed yet.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let wrote!: () => void;
    const written = new Promise<void>((r) => { wrote = r; });
    const edited = priced(await priceAt(20, 0.0975));
    const writer = prisma.$transaction(async (tx) => {
      await tx.priceBookAtomic.update({ where: { itemId: F_MATLAB }, data: { companyCost: 20, ...edited } });
      wrote();
      await gate;
    });
    await written;

    // Kyle saves 10% meanwhile. The reprice must wait for the edit to commit before it reads a single row.
    let finished = false;
    const run = repriceBookForTaxRate(prisma, { trigger: "test", saveSetting: JSON.stringify({ salesTaxRate: 0.1 }) }).then((r) => { finished = true; return r; });
    await new Promise((r) => setTimeout(r, 600));
    expect(finished, "the reprice is waiting on the uncommitted edit").toBe(false);
    release();
    await writer;
    const r = await run;
    expect(r.status).toBe("repriced");

    // 20 x 1.10 = 22.00; x 1.3 = 28.60; 0.5 h x $100 + 28.60 = 78.60. Had the stale $10 read been written: 11 / 14.30 / 64.30.
    expect(await atomic(F_MATLAB)).toMatchObject({ companyCost: 20, companyCostWithTax: 22, companyPrice: 28.6, sellNormal: 78.6 });
    expect(mine(r.handPriced).map((h) => h.itemId)).toEqual([F_HAND]);
    // the audit trail's old value is the committed edit's, not the pre-edit price
    const e = await prisma.priceBookEdit.findFirstOrThrow({ where: { itemId: F_MATLAB, editedBy: TAX_REPRICE_EDITOR, field: "companyPrice", note: { contains: "9.75% -> 10%" } }, orderBy: { createdAt: "desc" } });
    expect(e.oldValue).toBe(String(edited.companyPrice));

    // put the fixture back: cost $10 at 9.75%
    await repriceBookForTaxRate(prisma, { trigger: "test", saveSetting: JSON.stringify({ salesTaxRate: 0.0975 }) });
    await prisma.priceBookAtomic.update({ where: { itemId: F_MATLAB }, data: { companyCost: 10, ...priced(await priceAt(10, 0.0975)) } });
    expect(await atomic(F_MATLAB)).toMatchObject({ companyCost: 10, companyCostWithTax: 10.98, companyPrice: 14.27, sellNormal: 64.27 });
  });

  it("an item written while no rate was saved (priced at the 9.75% fallback) is repriced by the first save, not called hand-priced", async () => {
    // The state after a deploy with no Settings -> Purchasing row: the book has no recorded rate, and every editor prices at the fallback.
    await prisma.companySetting.deleteMany({ where: { key: "purchasing" } });
    await prisma.priceBookRateConfig.deleteMany({ where: { key: BOOK_TAX_CELL } });
    expect(await readSavedSalesTaxRate()).toBeNull();
    const gap = await createAtomic(prisma, { itemId: `${MARK}-GAP`, description: `${MARK} written in the gap`, category: `${MARK} cat`, rowType: "MATERIAL + LABOR", companyCost: 10, laborNormal: 0.5 }, "test");
    made.push(`${MARK}-GAP`);
    if (!gap.ok) throw new Error("create failed");
    expect(await atomic(`${MARK}-GAP`)).toMatchObject({ companyCostWithTax: 10.98, companyPrice: 14.27, sellNormal: 64.27 }); // the fallback's price

    // Kyle saves 8%: 10 x 1.08 = 10.80; x 1.3 = 14.04; 0.5 h x $100 + 14.04 = 64.04
    const res = await request(app).put("/crm/settings/purchasing").send({ salesTaxRate: 0.08 });
    expect(res.status).toBe(200);
    expect(res.body.reprice).toMatchObject({ status: "repriced", previousRate: 0, newRate: 0.08 });
    expect(await atomic(`${MARK}-GAP`)).toMatchObject({ companyCostWithTax: 10.8, companyPrice: 14.04, sellNormal: 64.04 });
    expect(await atomic(F_MATLAB)).toMatchObject({ companyCostWithTax: 10.8, companyPrice: 14.04, sellNormal: 64.04 });
    // listed as hand-priced: only the genuinely hand-set one
    expect(res.body.reprice.handPriced.map((h: { itemId: string }) => h.itemId)).not.toContain(`${MARK}-GAP`);
    expect(mine(res.body.reprice.handPriced).map((h: { itemId: string }) => h.itemId)).toEqual([F_HAND]);

    // the next change is judged at the new recorded rate and moves it again
    await request(app).put("/crm/settings/purchasing").send({ salesTaxRate: 0.0975 });
    expect(await atomic(`${MARK}-GAP`)).toMatchObject({ companyCostWithTax: 10.98, companyPrice: 14.27, sellNormal: 64.27 });
  });

  it("the save rides in the reprice transaction: a reprice that fails saves NOTHING, and Settings and the book still agree", async () => {
    expect(await readSavedSalesTaxRate()).toBe(0.0975);
    const before = JSON.stringify(await prisma.priceBookAtomic.findMany({ where: { itemId: { in: SEEDED } }, orderBy: { itemId: "asc" } }));
    const edits = await editCount();
    type TxFn = (tx: unknown) => Promise<unknown>;
    const real = prisma.$transaction.bind(prisma) as unknown as (fn: TxFn, opts?: { timeout?: number }) => Promise<unknown>;
    // fail AFTER every write has been made inside the reprice's own transaction (the 300 s one), so only a rollback can undo them
    const spy = vi.spyOn(prisma, "$transaction") as unknown as { mockImplementation: (f: (fn: TxFn, opts?: { timeout?: number }) => Promise<unknown>) => void; mockRestore: () => void };
    spy.mockImplementation((fn, opts) =>
      opts?.timeout === 300_000
        ? real(async (tx: unknown) => { await fn(tx); throw new Error("simulated failure after the writes"); }, opts)
        : real(fn, opts));
    let res;
    try {
      res = await request(app).put("/crm/settings/purchasing").send({ salesTaxRate: 0.12 });
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/NOT saved/);
    expect(res.body.reprice.status).toBe("failed");
    expect(await readSavedSalesTaxRate()).toBe(0.0975); // not 0.12
    expect(await bookCell()).toBe(0.0975);
    expect(JSON.stringify(await prisma.priceBookAtomic.findMany({ where: { itemId: { in: SEEDED } }, orderBy: { itemId: "asc" } }))).toBe(before);
    expect(await editCount()).toBe(edits);
  });
});

describe("issued estimates are frozen; an open draft reads the new prices", () => {
  it("a rate change leaves every column of an issued estimate and its lines alone, and moves the open draft", async () => {
    const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "ptx@example.com", phone: "615-555-0177" } });
    const property = await prisma.property.create({ data: { customerId: customer.id, name: `${MARK} House`, addressLine1: "9 Tax Ln", city: "La Vergne", state: "TN", postalCode: "37086" } });
    const visit = await prisma.visit.create({ data: { customerId: customer.id, propertyId: property.id, mode: "onsite", purpose: `${MARK} job`, status: "estimate" } });

    const open = await createDraft(prisma, { title: `${MARK} open`, supplierId: "HD", visitId: visit.id });
    await addLine(prisma, open.id, { itemId: F_MATLAB, quantity: 1, quantitySource: "COUNT" });
    const toIssue = await createDraft(prisma, { title: `${MARK} issued`, supplierId: "HD", visitId: visit.id });
    await addLine(prisma, toIssue.id, { itemId: F_MATLAB, quantity: 2, quantitySource: "COUNT" });
    const g = await graduateDraft(prisma, { draftId: toIssue.id, accountId: customer.id, serviceAddressId: property.id });
    if (!g.ok) throw new Error(g.reasons.join("; "));

    const frozen = async () => JSON.stringify(await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: g.estimateId }, include: { lines: { orderBy: { id: "asc" } }, events: { orderBy: { id: "asc" } } } }));
    const issuedBefore = await frozen();
    const issuedLine = await prisma.issuedEstimateLine.findFirstOrThrow({ where: { estimateId: g.estimateId } });
    expect(issuedLine.unitPrice).toBe(64.27); // 9.75% already inside the sell
    expect(issuedLine.materialCost).toBe(20); // job cost stays PRE-TAX: 2 x $10.00
    expect(issuedLine.materialCostWithTax).toBe(21.95); // the cap's frozen basis: 2 x $10.975
    const unitSell = async () => (await computeDraft(prisma, open.id)).computed.lines[0]!.sellPerUnit;
    expect(await unitSell()).toBe(64.27);

    const r = await request(app).put("/crm/settings/purchasing").send({ salesTaxRate: 0.11 });
    expect(r.body.reprice.status).toBe("repriced");
    expect(r.body.reprice.openDrafts).toBeGreaterThanOrEqual(1);
    expect(await frozen()).toBe(issuedBefore); // not a column moved
    expect(await unitSell()).toBe(64.43); // 10 x 1.11 x 1.3 = 14.43 + $50

    await request(app).put("/crm/settings/purchasing").send({ salesTaxRate: 0.0975 });
    expect(await unitSell()).toBe(64.27);
  });
});
