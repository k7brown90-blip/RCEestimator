import { describe, expect, it } from "vitest";
import { buildColumns, findColumn, flattenOrder, moveToColumn, reorderWithin, sameColumns } from "./lineOrder";

/*
  The move rules behind drag-and-drop on the Review tab (Kyle, 2026-10-08). No pointer, no DOM: a
  column is one option's lines in order, and the saved order is every column flattened A first.
*/

const letters = ["A", "B", "C", "D"] as const;
const optionOf = (m: Record<string, "A" | "B" | "C" | "D">) => (id: string) => m[id];

describe("buildColumns / flattenOrder", () => {
  const lines = [{ id: "l1" }, { id: "l2" }, { id: "l3" }, { id: "l4" }];
  const cols = buildColumns(letters, lines, optionOf({ l1: "A", l2: "B", l3: "A", l4: "C" }));

  it("groups lines by option, keeps their saved order, and gives an empty option a column", () => {
    expect(cols).toEqual({ A: ["l1", "l3"], B: ["l2"], C: ["l4"], D: [] });
  });

  it("flattens to the full ordered list the server wants, options in letter order", () => {
    expect(flattenOrder(cols, letters)).toEqual([
      { lineId: "l1", option: "A" },
      { lineId: "l3", option: "A" },
      { lineId: "l2", option: "B" },
      { lineId: "l4", option: "C" },
    ]);
  });

  it("files a line with no known option under the first option rather than losing it", () => {
    const c = buildColumns(letters, [{ id: "x" }], () => undefined);
    expect(c.A).toEqual(["x"]);
    const stray = buildColumns(["A", "B"], [{ id: "y" }], () => "D");
    expect(stray.A).toEqual(["y"]);
  });
});

describe("moveToColumn (dragging over another option)", () => {
  const cols = { A: ["l1", "l3"], B: ["l2"], C: [], D: [] };

  it("drops beside the line it is over — before it, or after it on the lower half", () => {
    expect(moveToColumn(cols, "l1", "l2", false)).toEqual({ A: ["l3"], B: ["l1", "l2"], C: [], D: [] });
    expect(moveToColumn(cols, "l1", "l2", true)).toEqual({ A: ["l3"], B: ["l2", "l1"], C: [], D: [] });
  });

  it("goes to the end of an option it is dropped on directly — an empty one included", () => {
    expect(moveToColumn(cols, "l2", "D", false)).toEqual({ A: ["l1", "l3"], B: [], C: [], D: ["l2"] });
    expect(moveToColumn(cols, "l3", "B", false).B).toEqual(["l2", "l3"]);
  });

  it("returns the same object when nothing changes", () => {
    expect(moveToColumn(cols, "l1", "l3", false)).toBe(cols); // same option
    expect(moveToColumn(cols, "l1", "l1", false)).toBe(cols);
    expect(moveToColumn(cols, "l1", "nope", false)).toBe(cols);
  });
});

describe("reorderWithin (dropping inside one option)", () => {
  const cols = { A: ["l1", "l2", "l3"], B: ["l4"] };

  it("puts the line where the one it was dropped on is", () => {
    expect(reorderWithin(cols, "l3", "l1")).toEqual({ A: ["l3", "l1", "l2"], B: ["l4"] });
    expect(reorderWithin(cols, "l1", "l3")).toEqual({ A: ["l2", "l3", "l1"], B: ["l4"] });
  });

  it("changes nothing on a drop onto itself, onto an option, or onto a line in another option", () => {
    expect(reorderWithin(cols, "l1", "l1")).toBe(cols);
    expect(reorderWithin(cols, "l1", "A")).toBe(cols);
    expect(reorderWithin(cols, "l1", "l4")).toBe(cols);
  });
});

describe("sameColumns / findColumn", () => {
  it("compares position as well as membership", () => {
    const a = { A: ["l1", "l2"], B: [] };
    expect(sameColumns(a, { A: ["l1", "l2"], B: [] }, ["A", "B"])).toBe(true);
    expect(sameColumns(a, { A: ["l2", "l1"], B: [] }, ["A", "B"])).toBe(false);
    expect(sameColumns(a, { A: ["l1"], B: ["l2"] }, ["A", "B"])).toBe(false);
  });

  it("finds the option holding a line, and treats an option letter as itself", () => {
    const c = { A: ["l1"], B: ["l2"] };
    expect(findColumn(c, "l2")).toBe("B");
    expect(findColumn(c, "A")).toBe("A");
    expect(findColumn(c, "zzz")).toBeNull();
  });
});
