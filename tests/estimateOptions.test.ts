/**
 * Options A / B / C — per-option subtotals, and the one rule that is easy to get wrong.
 *
 * Kyle, 2026-08-19:
 *
 *   *"Option A - The direct Quote for what the client called for. Option B - Code Violations or
 *    Hazards found during the Electrical assessment. Option C - Any recommendation beyond option A
 *    and B that the tech finds necessary to offer. Each option gives its total separately. Each
 *    option can be selected to give a combined total if they want to do one, two, or all three."*
 *
 *   *"Once checked it will add the total for all options selected and count as a single job."*
 *
 * The rule that needs pinning is the TRIP CHARGE. It is charged once for turning up, and any
 * combination of options signed together is a single job — so it must be added once, after the
 * selection is known, not folded into each option's subtotal. Fold it in and a customer who takes
 * all three pays it three times for one visit, while every option still looks individually
 * correct, which is the kind of error that reaches a signature.
 */

import { describe, expect, it } from "vitest";
import {
  combineOptions,
  summarizeOptions,
  computeEstimate,
  type EngineAtomic,
  type DraftLineInput,
  type RateConfig,
} from "../src/services/atomicEstimateEngine";

const RATE: RateConfig = {
  billedLaborRate: 100,
  jobFixedCost: 200,
  markupTiers: [],
} as unknown as RateConfig;

/** Two simple flat-priced atomics: $100 of labour each, no material. */
function atomics(): Map<string, EngineAtomic> {
  const make = (itemId: string): EngineAtomic =>
    ({
      itemId,
      description: itemId,
      unit: "each",
      laborUnitBasis: "EACH",
      laborUnitDivisor: 1,
      laborNormal: 1,
      laborDifficult: 1,
      laborVeryDifficult: 1,
      supplierPrice: 0,
      materialSellPerUnit: 0,
      rowType: "LABOR",
    }) as unknown as EngineAtomic;
  return new Map([
    ["a1", make("a1")],
    ["b1", make("b1")],
    ["c1", make("c1")],
  ]);
}

function line(itemId: string, option: "A" | "B" | "C", quantity = 1): DraftLineInput {
  return { id: `${option}-${itemId}`, itemId, quantity, quantitySource: "COUNT", difficulty: "NORMAL", option };
}

function computed(inputs: DraftLineInput[]) {
  return computeEstimate(inputs, atomics(), RATE, "supplier");
}

describe("per-option subtotals", () => {
  it("groups each line under the option it was put in", () => {
    const c = computed([line("a1", "A"), line("b1", "B"), line("b1", "B"), line("c1", "C")]);
    const s = summarizeOptions(c);

    expect(s.find((x) => x.option === "A")!.lineCount).toBe(1);
    expect(s.find((x) => x.option === "B")!.lineCount).toBe(2);
    expect(s.find((x) => x.option === "C")!.lineCount).toBe(1);
  });

  it("always reports all three options, even the empty ones", () => {
    // The build screen shows three sections whether or not they have lines in them.
    const s = summarizeOptions(computed([line("a1", "A")]));
    expect(s.map((x) => x.option)).toEqual(["A", "B", "C"]);
    expect(s.find((x) => x.option === "C")!.lineCount).toBe(0);
  });

  it("treats a line with no option as Option A", () => {
    // Every line predates options and was, in effect, "what the client called for".
    const c = computed([{ id: "x", itemId: "a1", quantity: 1, quantitySource: "COUNT", difficulty: "NORMAL" }]);
    expect(c.lines[0].option).toBe("A");
    expect(summarizeOptions(c).find((x) => x.option === "A")!.lineCount).toBe(1);
  });

  it("excludes the trip charge from every option subtotal", () => {
    const s = summarizeOptions(computed([line("a1", "A")]));
    // $100 of labour. The $200 trip charge belongs to the job, not to Option A.
    expect(s.find((x) => x.option === "A")!.subtotal).toBe(100);
  });
});

describe("combining what the customer ticked", () => {
  it("adds the trip charge ONCE across all three options", () => {
    const c = computed([line("a1", "A"), line("b1", "B"), line("c1", "C")]);
    const combined = combineOptions(c, ["A", "B", "C"]);

    expect(combined.subtotal).toBe(300); // 3 x $100 labour
    expect(combined.jobFixedCost).toBe(200);
    expect(combined.total).toBe(500); // NOT 300 + 600
  });

  it("charges the same trip charge for one option as for three", () => {
    // The visit happens once. This is the assertion that catches a per-option fold directly.
    const c = computed([line("a1", "A"), line("b1", "B"), line("c1", "C")]);
    expect(combineOptions(c, ["A"]).jobFixedCost).toBe(combineOptions(c, ["A", "B", "C"]).jobFixedCost);
  });

  it("totals only what was selected", () => {
    const c = computed([line("a1", "A"), line("b1", "B"), line("c1", "C")]);
    expect(combineOptions(c, ["A", "C"]).subtotal).toBe(200);
    expect(combineOptions(c, ["A", "C"]).total).toBe(400);
  });

  it("prices an empty selection as nothing, not as zero", () => {
    // A £0 total invites signing it. No selection has no price.
    const c = computed([line("a1", "A")]);
    const none = combineOptions(c, []);
    expect(none.total).toBeNull();
    expect(none.subtotal).toBeNull();
  });

  it("ignores selected options that carry no lines", () => {
    const c = computed([line("a1", "A")]);
    const combined = combineOptions(c, ["A", "B", "C"]);
    expect(combined.subtotal).toBe(100);
    expect(combined.total).toBe(300);
  });
});
