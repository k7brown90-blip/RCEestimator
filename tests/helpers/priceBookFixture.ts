/**
 * A minimal price-book fixture, built on demand by the tests that need one.
 *
 * Kyle's standing rule, 2026-09-15: *"There should be no seeding any pricebook data ever at all.
 * All pricing now lives in the app and all creation and edits are done in the app only."* This
 * helper does not import anything from disk — it writes the two or three rows a test actually
 * needs through the same tables the app itself writes (`PriceBookSupplier`, `PriceBookAtomic`,
 * `PriceBookRateConfig`), and each caller tears down what it created.
 *
 * NOT wired into tests/globalSetup.ts. Undeclared global seeding is what left these eight files
 * depending on an importer that no longer exists (commit `eaec200`, 2026-09-12) — see
 * .claude/plans/2026-09-15-tests-build-their-own-price-data.md. Every caller invokes this
 * explicitly from its own beforeAll and cleans up in its own afterAll, the same shape as the
 * existing self-sufficient fixtures in tests/catalogRepoint.test.ts, tests/invoices.test.ts, etc.
 */

import { prisma } from "../../src/lib/prisma";

/** `createDraft` refuses any supplier not registered here (atomicEstimateService.ts:369-376). */
export const HD_SUPPLIER_ID = "HD";

/** Kyle's actual current numbers (laborRate.ts: $100/hr from 2026-09-01; Rate Config jobFixedCost
 * is the $200 trip charge every issued-estimate test that reaches graduation asserts against). */
const BILLED_LABOR_RATE = 100;
const JOB_FIXED_COST = 200;

/**
 * Ensures the HD supplier and the Rate Config rows that `createDraft` / `graduateDraft` read
 * exist. Neither is a "price book" row in Kyle's sense — HD is a plain supplier record and Rate
 * Config is the app's own billed-rate/trip-charge config, not a catalog of priced items — but
 * both are structural dependencies the deleted importer used to leave behind
 * (tests/globalSetup.ts seeds neither; see scripts/seedAtomicUnits.ts). Without
 * `billedLaborRate`, a flat-priced ("Kyle's tab") line's `laborDollars` comes back null and gets
 * reported as unpriced even though it has a real sell price — see
 * atomicEstimateEngine.ts:504-562. Without `jobFixedCost`, every issued estimate's trip charge
 * is silently 0 instead of $200 (issuedEstimateService.ts:289).
 *
 * Upserted, and deliberately never deleted by teardown: `fileParallelism: false` means these
 * eight files run sequentially against one database, several of them need HD/Rate Config, and
 * whichever runs first must not remove it out from under whichever runs next. Idempotent, so
 * calling this from every file's own beforeAll is safe and is the point — no file trusts a
 * previous file to have left it behind.
 */
export async function ensurePriceBookGates(): Promise<void> {
  await prisma.priceBookSupplier.upsert({
    where: { id: HD_SUPPLIER_ID },
    create: { id: HD_SUPPLIER_ID, name: "Home Depot (test fixture)", quotable: "YES" },
    update: { quotable: "YES" },
  });
  await prisma.priceBookRateConfig.upsert({
    where: { key: "billedLaborRate" },
    create: {
      key: "billedLaborRate",
      label: "Billed labor rate (test fixture)",
      workbookRow: 0,
      numberValue: BILLED_LABOR_RATE,
    },
    update: { numberValue: BILLED_LABOR_RATE },
  });
  await prisma.priceBookRateConfig.upsert({
    where: { key: "jobFixedCost" },
    create: {
      key: "jobFixedCost",
      label: "Trip and job setup (test fixture)",
      workbookRow: 0,
      numberValue: JOB_FIXED_COST,
    },
    update: { numberValue: JOB_FIXED_COST },
  });
}

export interface AtomicFixtureRow {
  itemId: string;
  description?: string | null;
  category?: string | null;
  sector?: string | null;
  unit?: string | null;
  rowType?: string | null;
  laborNormal?: number | null;
  laborDifficult?: number | null;
  laborVeryDifficult?: number | null;
  laborUnitBasis?: string | null;
  laborUnitDivisor?: number | null;
  costBasisUsed?: number | null;
  source?: string;
  sellNormal?: number | null;
  sellDifficult?: number | null;
  sellVeryDifficult?: number | null;
  companyCost?: number | null;
  companyPrice?: number | null;
}

/**
 * A fully quotable, flat-priced ("Kyle's tab", P030) row: a real sell price at every difficulty,
 * so the line prices complete with no `PriceBookSupplierPrice` needed at all — flat rows skip
 * supplier cost resolution entirely (`isFlatPriced` in atomicEstimateEngine.ts:504-562, and
 * `resolveCatalogAtSupplier` at :1041-1044). This mirrors how every item in Kyle's real catalog
 * is actually priced today (constants.md, "What actually sets a quoted price").
 */
export function quotableAtomic(itemId: string, overrides: Partial<AtomicFixtureRow> = {}): AtomicFixtureRow {
  return {
    itemId,
    description: `Fixture item ${itemId} — fully quotable`,
    category: "DEVICES",
    unit: "ea",
    rowType: "MATERIAL + LABOR",
    source: "kyles-tab",
    laborNormal: 0.3,
    laborDifficult: 0.4,
    laborVeryDifficult: 0.55,
    laborUnitBasis: "E",
    laborUnitDivisor: 1,
    companyCost: 20,
    companyPrice: 40,
    sellNormal: 70,
    sellDifficult: 80,
    sellVeryDifficult: 95,
    ...overrides,
  };
}

/**
 * A row with every labour column blank — the shape Kyle hit on 2026-08-17: NECA publishes no
 * unit for the product, so the labour cell is genuinely empty rather than zero. NOT flat priced
 * (no sell* column), so the engine falls through to the NECA path and raises NO_LABOUR_VALUE.
 */
export function noLabourAtomic(itemId: string, overrides: Partial<AtomicFixtureRow> = {}): AtomicFixtureRow {
  return {
    itemId,
    description: `Fixture item ${itemId} — no published labour`,
    category: "DIAGNOSTIC",
    unit: "ea",
    rowType: "MATERIAL + LABOR",
    laborNormal: null,
    laborDifficult: null,
    laborVeryDifficult: null,
    laborUnitBasis: null,
    laborUnitDivisor: null,
    costBasisUsed: null,
    sellNormal: null,
    sellDifficult: null,
    sellVeryDifficult: null,
    ...overrides,
  };
}

/** Insert caller-specified atomic rows, replacing anything already sitting at those ids. */
export async function seedAtomics(rows: AtomicFixtureRow[]): Promise<void> {
  const ids = rows.map((r) => r.itemId);
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: ids } } });
  await prisma.priceBookAtomic.createMany({ data: rows });
}

/** Teardown for whatever seedAtomics created. Safe to call even if some ids were never created. */
export async function deleteAtomics(itemIds: string[]): Promise<void> {
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: itemIds } } });
}
