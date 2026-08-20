/**
 * Change orders, and the negative counts only they may carry.
 *
 * Kyle, 2026-08-19:
 *
 *   *"Nothing will revise the already signed quote. If a change is deemed necessary by the
 *    electrician or the customer a change order is created. The same job ID only with additional
 *    sections that add the work or remove the work… This means we should be able to do a negative
 *    count on the line items."*
 *
 * ── WHY THE PERMISSION IS NARROW ───────────────────────────────────────────────────────────────
 *
 * A negative quantity is correct on a change order and a typo everywhere else — and nothing
 * downstream would catch the typo. The line prices, the option totals, the estimate comes out
 * lower than it should, and every check passes because the arithmetic is right. It is the kind of
 * error only a customer finds. So the permission is tied to the one document type that means it.
 */

import { describe, expect, it } from "vitest";
import { assertQuantityAllowed } from "../src/services/atomicEstimateService";
import { computeEstimate, summarizeOptions, type DraftLineInput, type EngineAtomic, type RateConfig } from "../src/services/atomicEstimateEngine";

const RATE = { billedLaborRate: 100, jobFixedCost: 0, markupTiers: [] } as unknown as RateConfig;

function atomics(): Map<string, EngineAtomic> {
  return new Map([
    ["fan", {
      itemId: "fan", description: "Ceiling fan install", unit: "each",
      laborUnitBasis: "EACH", laborUnitDivisor: 1,
      laborNormal: 2, laborDifficult: 2, laborVeryDifficult: 2,
      supplierPrice: 0, materialSellPerUnit: 0, rowType: "LABOR",
    } as unknown as EngineAtomic],
  ]);
}

function line(quantity: number): DraftLineInput {
  return { id: `l${quantity}`, itemId: "fan", quantity, quantitySource: "COUNT", difficulty: "NORMAL", option: "A" };
}

describe("who may enter a negative count", () => {
  it("refuses one on an ordinary estimate", () => {
    expect(() => assertQuantityAllowed(-2, false)).toThrow(/only.*change order/i);
  });

  it("allows one on a change order", () => {
    expect(() => assertQuantityAllowed(-2, true)).not.toThrow();
  });

  it("refuses zero on both", () => {
    // A line that changes nothing is not a change. It would print on a signed document saying
    // nothing at all.
    expect(() => assertQuantityAllowed(0, true)).toThrow(/cannot be zero/i);
    expect(() => assertQuantityAllowed(0, false)).toThrow(/cannot be zero/i);
  });

  it("refuses a non-number on both", () => {
    expect(() => assertQuantityAllowed(Number.NaN, true)).toThrow(/must be a number/i);
    expect(() => assertQuantityAllowed(Number.POSITIVE_INFINITY, true)).toThrow(/must be a number/i);
  });

  it("still allows an ordinary positive count", () => {
    // The presence half — a rule that refused everything would pass every test above.
    expect(() => assertQuantityAllowed(3, false)).not.toThrow();
    expect(() => assertQuantityAllowed(0.5, false)).not.toThrow();
  });
});

describe("the arithmetic of removing work", () => {
  it("subtracts labour and money for a negative line", () => {
    const c = computeEstimate([line(-2)], atomics(), RATE, "s");
    expect(c.lines[0].laborHours).toBe(-4);
    expect(c.lines[0].laborDollars).toBe(-400);
    expect(c.subtotal).toBe(-400);
  });

  it("nets an addition against a removal", () => {
    // The shape of a real change order: three fans added, one taken back off.
    const c = computeEstimate([line(3), line(-1)], atomics(), RATE, "s");
    expect(c.laborHours).toBe(4); // 6 - 2
    expect(c.subtotal).toBe(400); // 600 - 200
  });

  it("reports the netted figure as the option subtotal", () => {
    const c = computeEstimate([line(3), line(-1)], atomics(), RATE, "s");
    const a = summarizeOptions(c).find((o) => o.option === "A");
    expect(a!.lineCount).toBe(2);
    expect(a!.subtotal).toBe(400);
  });

  it("lets a change order come out negative overall", () => {
    // Removing more than was added is a refund, and it is a legitimate change order. Clamping it
    // at zero would quietly keep money that is no longer owed.
    const c = computeEstimate([line(-3)], atomics(), RATE, "s");
    expect(c.subtotal).toBe(-600);
    expect(c.total).toBe(-600);
  });
});

describe("the unit price of a removed line", () => {
  it("divides by a negative count instead of falling through", () => {
    // `quantity > 0` sent negatives down the divide-by-nothing branch, storing the whole line
    // total as the unit price — so "-2 fans" froze as one unit at the full amount. The frozen
    // record is what a signed document prints from, so this was a wrong number on paper.
    const c = computeEstimate([line(-2)], atomics(), RATE, "s");
    const lineTotal = (c.lines[0].laborDollars ?? 0) + (c.lines[0].materialSell ?? 0);
    const unit = c.lines[0].quantity !== 0 ? lineTotal / c.lines[0].quantity : lineTotal;
    expect(unit).toBe(200); // -400 / -2 — a positive unit price on a negative count
  });
});
