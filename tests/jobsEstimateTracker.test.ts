/**
 * The Jobs page tracker must count the estimates Kyle actually writes.
 *
 * Kyle, 2026-08-19: *"There have been several test estimates that have been accepted and none are
 * linked to this tracker. Specifically the Review, Sent, and Accepted buttons."*
 *
 * ── WHY NONE OF THEM APPEARED ──────────────────────────────────────────────────────────────────
 *
 * The jobs list read `visit.estimates` — the legacy `Estimate` model — while every estimate
 * written since P027 is an `IssuedEstimate`. The filters were not broken; they were filtering a
 * table he had stopped using. That is why the symptom was "none are linked" rather than "some are
 * missing": no quantity of correct work on his side could ever have shown up.
 *
 * The mapping is the part worth pinning, because the two models name their stages differently and
 * a wrong mapping would put signed work under the wrong button — which looks like working
 * software right up until someone counts their accepted jobs.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP = path.resolve(__dirname, "..");

/** The mapping as implemented in the jobs handler, read from source. */
function trackerStatusFromSource(): (status: string) => string {
  const src = fs.readFileSync(path.join(APP, "src/app.ts"), "utf8");
  const m = /const trackerStatus = \(status: string\): string =>\s*([^;]+);/.exec(src);
  expect(m, "trackerStatus not found in src/app.ts — this test is checking nothing").not.toBeNull();
  // eslint-disable-next-line no-new-func
  return new Function("status", `return ${(m as RegExpExecArray)[1]};`) as (s: string) => string;
}

describe("issued estimate status maps onto the tracker's buttons", () => {
  const map = trackerStatusFromSource();

  it("a SIGNED estimate reads as accepted", () => {
    // The one Kyle named. A signed estimate is sold work and must count as accepted.
    expect(map("signed")).toBe("accepted");
  });

  it("a VIEWED estimate still reads as sent", () => {
    // "Viewed" means the customer opened the link. That is a fact about a sent estimate, not a
    // stage of its own, and giving it its own bucket would empty the Sent filter.
    expect(map("viewed")).toBe("sent");
  });

  it("sent and draft pass through unchanged", () => {
    expect(map("sent")).toBe("sent");
    expect(map("draft")).toBe("draft");
  });

  it("never invents a status for one it does not recognise", () => {
    // An unknown stage passes through as itself rather than being coerced into "accepted".
    // Guessing here would file unsold work as sold.
    expect(map("superseded")).toBe("superseded");
  });
});

describe("the jobs handler actually queries issued estimates", () => {
  const src = fs.readFileSync(path.join(APP, "src/app.ts"), "utf8");

  it("matches a job from BOTH sides of the link", () => {
    // visitId is the visit an estimate was built from; jobVisitId is the job created when it was
    // signed. Matching only one would hide signed work from the job it produced.
    expect(src).toContain("prisma.issuedEstimate.findMany");
    expect(src).toMatch(/OR: \[\{ visitId: \{ in: visitIds \} \}, \{ jobVisitId: \{ in: visitIds \} \}\]/);
  });

  it("excludes voided estimates from the tracker", () => {
    // A voided estimate is not work in any state; counting it would inflate the pipeline.
    //
    // Anchored on the jobVisitId clause, not on the first `issuedEstimate.findMany` in the file.
    // The first version of this test asserted against a DIFFERENT query — the estimate-chain
    // endpoint — and failed while the code was correct. A source-reading test has to identify
    // the call site it means.
    const at = src.indexOf("{ jobVisitId: { in: visitIds } }");
    expect(at, "the jobs handler's issued-estimate query was not found").toBeGreaterThan(-1);
    const query = src.slice(Math.max(0, at - 300), at + 100);
    expect(query).toContain("voidedAt: null");
  });
});
