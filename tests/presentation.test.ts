/**
 * One estimate, two audiences — and the guarantee that they cannot leak into each other.
 *
 * Kyle, 2026-08-19: *"the labor units and line item pricing will have to show for the company
 * copy… The customer only needs the final price of each option or combination of options."*
 *
 * ── WHY BOTH DIRECTIONS ARE ASSERTED ───────────────────────────────────────────────────────────
 *
 * A test that only proves the customer's view has no prices passes on an EMPTY document. That is
 * not a hypothetical: the customer render already has a grep-for-money test, and if the builder
 * silently returned nothing, that test would go green while the screen showed a customer a blank
 * page. So every absence assertion here is paired with a presence assertion on the company view.
 */

import { describe, expect, it } from "vitest";
import {
  buildOptions,
  combinedTotal,
  labourHours,
  materialList,
} from "../client/src/lib/presentation";
import type { PbComputed, PbComputedLine, PbOptionSummary } from "../client/src/lib/types";

function line(over: Partial<PbComputedLine>): PbComputedLine {
  return {
    id: over.itemId ?? "l1",
    option: "A",
    itemId: "item",
    description: "A described thing",
    quantity: 2,
    quantitySource: "COUNT",
    difficulty: "NORMAL",
    unit: "each",
    location: null,
    note: null,
    laborUnitValue: 1,
    laborUnitBasis: "EACH",
    laborUnitDivisor: 1,
    laborHours: 2,
    laborDollars: 300,
    costBasis: 10,
    sellPerUnit: 25,
    materialCost: 20,
    materialSell: 50,
    gaps: [],
    complete: true,
    ...over,
  } as PbComputedLine;
}

const COMPUTED = {
  supplierId: "s",
  billedLaborRate: 150,
  jobFixedCost: 0,
  lines: [
    line({ itemId: "a1", option: "A", description: "Ceiling fan install" }),
    line({ itemId: "a2", option: "A", description: "Fan box, fan-rated" }),
    line({ itemId: "b1", option: "B", description: "Bond the water line" }),
  ],
  laborHours: 6,
  laborDollars: 900,
  materialCost: 60,
  materialSell: 150,
  subtotal: 1050,
  total: 1050,
  gaps: [],
  incompleteLineCount: 0,
  totalLineCount: 3,
  completenessSummary: "COMPLETE",
} as unknown as PbComputed;

const SUMMARIES: PbOptionSummary[] = [
  { option: "A", lineCount: 2, laborHours: 4, laborDollars: 600, materialSell: 100, subtotal: 700, complete: true },
  { option: "B", lineCount: 1, laborHours: 2, laborDollars: 300, materialSell: 50, subtotal: 350, complete: true },
  { option: "C", lineCount: 0, laborHours: 0, laborDollars: 0, materialSell: 0, subtotal: 0, complete: false },
];

describe("the customer's view", () => {
  const options = buildOptions(COMPUTED, SUMMARIES, "customer");

  it("shows what the work IS and how much of it", () => {
    // The presence half. Without this, every assertion below passes on an empty document.
    expect(options).toHaveLength(2);
    const first = options[0].lines[0];
    expect(first.description).toBe("Ceiling fan install");
    expect(first.quantity).toBe(2);
    expect(first.unit).toBe("each");
  });

  it("carries NO money and NO hours on any line — absent, not hidden", () => {
    for (const option of options) {
      for (const l of option.lines) {
        expect(l).not.toHaveProperty("laborHours");
        expect(l).not.toHaveProperty("laborDollars");
        expect(l).not.toHaveProperty("materialSell");
      }
    }
    // Asserted on the serialised form too: this object is handed to a React screen Kyle turns
    // around and shows a customer, so what matters is that the number is not in the page at all.
    expect(JSON.stringify(options)).not.toContain("laborHours");
    expect(JSON.stringify(options)).not.toContain("300");
  });

  it("still gives a total per option, which is the whole point", () => {
    expect(options.find((o) => o.option === "A")!.total).toBe(700);
    expect(options.find((o) => o.option === "B")!.total).toBe(350);
  });

  it("omits an option with no work in it", () => {
    // An empty Option C on a customer's screen is an invitation to ask what is missing.
    expect(options.map((o) => o.option)).toEqual(["A", "B"]);
  });
});

describe("the company's view", () => {
  const options = buildOptions(COMPUTED, SUMMARIES, "company");

  it("carries the line pricing and labour units the customer's does not", () => {
    const first = options[0].lines[0];
    expect(first.laborHours).toBe(2);
    expect(first.laborDollars).toBe(300);
    expect(first.materialSell).toBe(50);
  });

  it("agrees with the customer's view about the work itself", () => {
    // One builder, one data source. The two views may differ in what they SHOW and never in what
    // they say the work is.
    const customer = buildOptions(COMPUTED, SUMMARIES, "customer");
    expect(options.map((o) => o.total)).toEqual(customer.map((o) => o.total));
    expect(options[0].lines.map((l) => l.description)).toEqual(
      customer[0].lines.map((l) => l.description),
    );
  });
});

describe("the material list — what actually gets ordered", () => {
  it("lists only what is in the selected options", () => {
    expect(materialList(COMPUTED, ["A"]).map((r) => r.itemId)).toEqual(["a1", "a2"]);
    expect(materialList(COMPUTED, ["B"]).map((r) => r.itemId)).toEqual(["b1"]);
  });

  it("sums a repeated item rather than listing it twice", () => {
    // The supply house cares how many to put on the truck, not which option asked.
    const twice = { ...COMPUTED, lines: [line({ itemId: "x", quantity: 3 }), line({ itemId: "x", quantity: 4 })] } as PbComputed;
    const rows = materialList(twice, ["A"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(7);
  });

  it("leaves out labour-only rows, which have nothing to order", () => {
    // A customer-supplied ceiling fan install has no material. Listing it would send Kyle looking
    // for a part the customer is bringing.
    const labourOnly = { ...COMPUTED, lines: [line({ itemId: "fan", materialSell: 0 })] } as PbComputed;
    expect(materialList(labourOnly, ["A"])).toHaveLength(0);
  });
});

describe("combining the options the customer ticked", () => {
  const options = buildOptions(COMPUTED, SUMMARIES, "customer");

  it("adds the selected options together", () => {
    expect(combinedTotal(options, ["A"], 0)).toBe(700);
    expect(combinedTotal(options, ["A", "B"], 0)).toBe(1050);
  });

  it("adds a fixed job cost once, not once per option", () => {
    expect(combinedTotal(options, ["A", "B"], 200)).toBe(1250);
  });

  it("prices an empty selection as nothing, not as zero", () => {
    expect(combinedTotal(options, [], 0)).toBeNull();
  });

  it("reports labour hours for scheduling, across the selection", () => {
    expect(labourHours(COMPUTED, ["A"])).toBe(4);
    expect(labourHours(COMPUTED, ["A", "B"])).toBe(6);
  });
});
