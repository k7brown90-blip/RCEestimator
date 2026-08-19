/**
 * A record of what was sold has to contain what was sold.
 *
 * Kyle, 2026-08-19: *"the labor units and line item pricing will have to show for the company
 * copy. The goal is to have a material list and labor unit assesment for the puprose of ordering
 * and scheduling the job."* And: *"The PDF for the company can save as a copy on the customers
 * account under that job."*
 *
 * ── WHY THE SNAPSHOT HAD TO GROW ───────────────────────────────────────────────────────────────
 *
 * `IssuedEstimateLine` stored a description, a quantity and a combined unit price. That is enough
 * for the customer's document and nothing else. A company copy needs the hours to schedule
 * against and the material to order, and neither was recorded — so the only way to produce one
 * would have been to rebuild it from the DRAFT.
 *
 * That is precisely what an issued estimate exists to prevent. The draft is allowed to change; a
 * document saved against a job is a record of what was agreed. Rebuilding one from the other
 * would mean a company copy that silently disagrees with the customer copy it was issued
 * alongside, and nothing would say so.
 *
 * `option` matters for the same reason. Without it a frozen estimate forgets which option each
 * line was in, and work presented as three options comes back as one flat list.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP = path.resolve(__dirname, "..");
const schema = fs.readFileSync(path.join(APP, "prisma/schema.prisma"), "utf8");
const service = fs.readFileSync(path.join(APP, "src/services/issuedEstimateService.ts"), "utf8");

function issuedLineModel(): string {
  const at = schema.indexOf("model IssuedEstimateLine {");
  expect(at, "IssuedEstimateLine not found — this test is checking nothing").toBeGreaterThan(-1);
  return schema.slice(at, schema.indexOf("}", at));
}

describe("the frozen line carries what the company copy needs", () => {
  const model = issuedLineModel();

  it("records the option the line was sold under", () => {
    expect(model).toMatch(/option\s+PriceBookOption/);
  });

  it("records labour hours and material, nullably", () => {
    // Nullable on purpose. Null means "not recorded"; 0 means "none". A customer-supplied ceiling
    // fan genuinely has 0 material, and rows issued before this existed genuinely have neither.
    // Collapsing the two would assert that old jobs had no labour.
    expect(model).toMatch(/laborHours\s+Float\?/);
    expect(model).toMatch(/materialSell\s+Float\?/);
  });

  it("keeps the customer-facing fields it always had", () => {
    // The presence half: a schema check that only looked for new columns would pass on a model
    // that had lost the old ones.
    expect(model).toMatch(/description\s+String/);
    expect(model).toMatch(/quantity\s+Float/);
    expect(model).toMatch(/lineTotal\s+Float/);
  });
});

describe("graduation actually populates them", () => {
  it("copies the option and both figures from the computed line", () => {
    // A column that exists and is never written is worse than no column: the company document
    // would render blanks and look like the work had no labour.
    const at = service.indexOf("lines.push({");
    expect(at, "the frozen-line push was not found").toBeGreaterThan(-1);
    const block = service.slice(at, at + 700);
    expect(block).toContain("option: l.option");
    expect(block).toContain("laborHours: l.laborHours");
    expect(block).toContain("materialSell: l.materialSell");
  });

  it("passes the values through rather than defaulting a missing one to zero", () => {
    // "Never make up a number." A null labour figure means the engine had none; writing 0 would
    // claim the work takes no time, and that claim would then be frozen into a signed record.
    const at = service.indexOf("lines.push({");
    const block = service.slice(at, at + 700);
    expect(block).not.toMatch(/laborHours:\s*l\.laborHours\s*\?\?\s*0/);
    expect(block).not.toMatch(/materialSell:\s*l\.materialSell\s*\?\?\s*0/);
  });
});
