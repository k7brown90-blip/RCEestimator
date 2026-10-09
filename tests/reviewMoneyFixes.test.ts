/**
 * The Phase 3-4 review fixes that are about MONEY (2026-10-08, one-estimating-system plan):
 *
 *   1. The discount frozen at signing / office acceptance is taken by the SAME pure pricer every
 *      screen uses (shared/quoteMoney.ts priceSelection, via discounts.ts frozenSelectionDiscount),
 *      so it cannot be a cent off the figure the customer ticked and was shown.
 *   2. The draft's money is built from per-line-ROUNDED subtotals - exactly what issuing freezes -
 *      so the phone's pre-signature total and the signed total agree.
 *   3. When the draft is issued and untouched since (what "Show the customer" / "Present" reuse and
 *      what the signature records), `money` is priced from the issued estimate's FROZEN figures, not
 *      a live recompute of today's catalog / rate / bands.
 *
 * Pure: no database. (Prisma is a stub where a function asks for it.)
 */

import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { frozenSelectionDiscount, programmeFor } from "../src/services/discounts";
import { buildQuoteMoney, getQuoteMoney, pricingFiguresFromComputed } from "../src/services/quoteMoney";
import { pricingFiguresFromIssued } from "../src/services/issuedPricingFigures";
import type { ComputedEstimate } from "../src/services/atomicEstimateEngine";
import { priceSelection, selectionPrice } from "../shared/quoteMoney";
import type { DraftLifecycle } from "../shared/draftLifecycle";

const military = { discountType: "military", discountPercent: null };

describe("frozenSelectionDiscount - the signed discount is the cent the screen showed", () => {
  const est = (a: number, b: number, trip = 0) => ({
    ...military,
    tripCharge: trip,
    options: [
      { option: "A", subtotal: a },
      { option: "B", subtotal: b },
    ],
  });

  it("A $1,234.56 + B $1.34, military 5%: $61.80 (the old unrounded float sum froze $61.79)", () => {
    const e = est(1234.56, 1.34);
    const d = frozenSelectionDiscount(e, ["A", "B"], 0);
    expect(d?.amount).toBe(61.8);
    expect(d?.base).toBe(1235.9);
    // And it IS the pricer's figure, whatever the pricer says.
    const price = priceSelection(
      { options: e.options, tripCharge: 0, comboSavings: {}, programme: { rate: 0.05, cap: 250 } },
      ["A", "B"],
    );
    expect(d?.amount).toBe(price?.discount);
  });

  it("A $85.15 + B $0.15: $4.26 (the old float sum froze $4.27)", () => {
    expect(frozenSelectionDiscount(est(85.15, 0.15), ["A", "B"], 0)?.amount).toBe(4.26);
  });

  it("takes the trip once and the applied combined-options saving off the base, then the cap", () => {
    const d = frozenSelectionDiscount(est(10000, 500, 85), ["A", "B"], 40);
    expect(d).toMatchObject({ base: 10545, amount: 250, capped: true, type: "military", rate: 0.05, cap: 250 });
    // One option only: that option's subtotal + the trip.
    expect(frozenSelectionDiscount(est(100, 300, 200), ["A"], 0)).toMatchObject({ base: 300, amount: 15 });
  });

  it("no programme, or nothing positive to take it of, is no discount", () => {
    expect(frozenSelectionDiscount({ ...est(100, 100), discountType: null }, ["A"], 0)).toBeNull();
    expect(frozenSelectionDiscount(est(0, 0, 0), ["A"], 0)).toBeNull();
  });

  it("a custom percentage has no cap", () => {
    const d = frozenSelectionDiscount({ ...est(10000, 0), discountType: "custom", discountPercent: 10 }, ["A"], 0);
    expect(d).toMatchObject({ amount: 1000, capped: false, cap: null, percent: 10 });
  });

  it("an estimate with no options at all is priced on its trip alone, as it always was", () => {
    const d = frozenSelectionDiscount({ ...military, tripCharge: 200, options: [] }, [], 0);
    expect(d).toMatchObject({ base: 200, amount: 10 });
  });
});

// ─── Draft figures round per line, like graduateDraft ────────────────────────────────────────

const line = (id: string, option: string, laborDollars: number, materialSell: number) =>
  ({ id, option, itemId: id, laborHours: 1, laborDollars, materialSell, complete: true }) as never;

const computed = (lines: unknown[], over: Partial<ComputedEstimate> = {}): ComputedEstimate =>
  ({
    billedLaborRate: 100,
    lines,
    combinationDiscounts: {},
    jobFixedCost: 0,
    ...over,
  }) as unknown as ComputedEstimate;

describe("the draft's money rounds every line first - the figure the customer signs", () => {
  // Two lines of $14.375: summed raw they are $28.75; issuing freezes round2(14.375)=14.38 twice = $28.76.
  const twoHalfCentLines = computed([line("1", "A", 14.375, 0), line("2", "A", 14.375, 0)]);

  it("the option subtotal is the sum of per-line-rounded totals ($28.76, not $28.75)", () => {
    const money = buildQuoteMoney(twoHalfCentLines, { discountType: null, discountPercent: null, exclusiveOptions: false });
    expect(selectionPrice(money, ["A"])?.subtotal).toBe(28.76);
    expect(selectionPrice(money, ["A"])?.total).toBe(28.76);
    expect(pricingFiguresFromComputed(twoHalfCentLines, null).options).toEqual([{ option: "A", subtotal: 28.76 }]);
  });

  it("the one-or-the-other range reads the same rounded subtotals", () => {
    const c = computed([line("1", "A", 14.375, 0), line("2", "A", 14.375, 0), line("3", "B", 10.01, 0)]);
    const money = buildQuoteMoney(c, { discountType: null, discountPercent: null, exclusiveOptions: true });
    expect(money.range).toEqual({ min: 10.01, max: 28.76 });
  });

  it("an option with no billed rate stays unpriced (never a made-up number)", () => {
    const c = computed([line("1", "A", 14.375, 0)], { billedLaborRate: null } as never);
    const money = buildQuoteMoney(c, { discountType: null, discountPercent: null, exclusiveOptions: false });
    expect(selectionPrice(money, ["A"])).toBeNull();
  });
});

// ─── Show what will be signed ────────────────────────────────────────────────────────────────

describe("getQuoteMoney - an issued, unchanged, unsigned draft shows the FROZEN estimate", () => {
  // Issued at A $1,234.56 + B $1.34, military 5%. Today's catalog prices A at $2,000 instead.
  const frozen = {
    tripCharge: 0,
    jobBandsJson: null,
    ...military,
    exclusiveOptions: false,
    options: [
      { option: "A", subtotal: 1234.56 },
      { option: "B", subtotal: 1.34 },
    ],
    lines: [],
  };
  const live = computed([line("1", "A", 2000, 0), line("2", "B", 1.34, 0)]);
  const prismaStub = {
    issuedEstimate: { findUnique: async () => frozen },
    priceBookDraftEstimate: { findUnique: async () => ({ ...military, exclusiveOptions: false }) },
  } as unknown as PrismaClient;

  const lifecycle = (over: Partial<DraftLifecycle> = {}, issued: Partial<NonNullable<DraftLifecycle["issued"]>> = {}): DraftLifecycle => ({
    status: "finalized",
    issued: { estimateId: "est-1", number: "2026-1098", revision: 1, status: "sent", signedAt: null, archived: false, customerUrl: null, ...issued },
    hasUnsavedChanges: false,
    reviseReason: null,
    deleteReason: null,
    copyReason: null,
    ...over,
  });

  it("issued and unchanged: the total is the issued estimate's, not today's recompute", async () => {
    const money = await getQuoteMoney(prismaStub, "d1", live, lifecycle());
    expect(selectionPrice(money, ["A", "B"])).toMatchObject({ subtotal: 1235.9, discount: 61.8, total: 1174.1 });
    expect(selectionPrice(money, ["A"])?.subtotal).toBe(1234.56);
    expect(money.discount?.label).toBe("Military discount (5%)");
  });

  it("the same frozen figures the customer's page prices (pricingFiguresFromIssued)", async () => {
    const money = await getQuoteMoney(prismaStub, "d1", live, lifecycle());
    const { figures } = pricingFiguresFromIssued(frozen as never);
    expect(selectionPrice(money, ["A", "B"])?.total).toBe(priceSelection(figures, ["A", "B"])?.total);
  });

  it("edited since it was issued: the press will issue a fresh freeze of the draft, so the draft is shown", async () => {
    const money = await getQuoteMoney(prismaStub, "d1", live, lifecycle({ status: "draft", hasUnsavedChanges: true }));
    expect(selectionPrice(money, ["A"])?.subtotal).toBe(2000);
  });

  it("signed, lost, or never issued: nothing to sign, so the draft is shown", async () => {
    const signed = await getQuoteMoney(prismaStub, "d1", live, lifecycle({}, { status: "signed", signedAt: "2026-10-08T12:00:00.000Z" }));
    expect(selectionPrice(signed, ["A"])?.subtotal).toBe(2000);
    const lost = await getQuoteMoney(prismaStub, "d1", live, lifecycle({}, { status: "lost" }));
    expect(selectionPrice(lost, ["A"])?.subtotal).toBe(2000);
    const never = await getQuoteMoney(prismaStub, "d1", live, lifecycle({ issued: null, status: "draft" }));
    expect(selectionPrice(never, ["A"])?.subtotal).toBe(2000);
  });

  it("programmeFor is what labels the frozen programme", () => {
    expect(programmeFor("military", null)?.cap).toBe(250);
  });
});
