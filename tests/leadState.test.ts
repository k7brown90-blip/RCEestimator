import { describe, expect, it } from "vitest";
import { reconcileLeadState } from "../src/services/leadState";

/**
 * Status and the call outcome ("Funnel state") must say the same thing about lost
 * (plan lead-intake-fixes, B4). Pure rules; the routes that call them are tested in
 * leadIntakeFixes.test.ts.
 */

const open = { status: "new", leadStatus: "new" };

describe("reconcileLeadState", () => {
  it("Status set to lost makes the outcome lost", () => {
    expect(reconcileLeadState(open, { status: "lost", leadStatus: "new" })).toEqual({ status: "lost", leadStatus: "lost" });
    expect(reconcileLeadState(open, { status: "lost" })).toEqual({ status: "lost", leadStatus: "lost" });
  });

  it("a new lead entered Status lost (the 12 Yelp imports) is stored lost in both", () => {
    expect(reconcileLeadState(null, { status: "lost", leadStatus: "new" })).toEqual({ status: "lost", leadStatus: "lost" });
  });

  it("outcome set to lost makes Status lost", () => {
    expect(reconcileLeadState(open, { leadStatus: "lost" })).toEqual({ status: "lost", leadStatus: "lost" });
  });

  it("Status reopened from lost sends the outcome back to new", () => {
    const lost = { status: "lost", leadStatus: "lost" };
    expect(reconcileLeadState(lost, { status: "contacted" })).toEqual({ status: "contacted", leadStatus: "new" });
    // The edit form re-sends the stored outcome with the new Status.
    expect(reconcileLeadState(lost, { status: "contacted", leadStatus: "lost" })).toEqual({ status: "contacted", leadStatus: "new" });
    expect(reconcileLeadState(lost, { status: "new", leadStatus: "lost" })).toEqual({ status: "new", leadStatus: "new" });
  });

  it("Status reopened keeps a real call outcome the editor picked", () => {
    const lost = { status: "lost", leadStatus: "lost" };
    expect(reconcileLeadState(lost, { status: "contacted", leadStatus: "planning" })).toEqual({ status: "contacted", leadStatus: "planning" });
  });

  it("an outcome moved off lost while Status is lost reopens the lead as contacted", () => {
    expect(reconcileLeadState({ status: "lost", leadStatus: "lost" }, { leadStatus: "booked" }))
      .toEqual({ status: "contacted", leadStatus: "booked" });
  });

  it("a save that moves neither column heals a pair that disagrees on lost", () => {
    // Status says lost, outcome still new (the form always sends both).
    expect(reconcileLeadState({ status: "lost", leadStatus: "new" }, { status: "lost", leadStatus: "new" }))
      .toEqual({ status: "lost", leadStatus: "lost" });
    // Outcome says lost, Status still new: the Closed tab already reads it as lost.
    expect(reconcileLeadState({ status: "new", leadStatus: "lost" }, { status: "new", leadStatus: "lost" }))
      .toEqual({ status: "lost", leadStatus: "lost" });
  });

  it("a write that touches neither column changes nothing", () => {
    expect(reconcileLeadState({ status: "lost", leadStatus: "new" }, {})).toEqual({ status: "lost", leadStatus: "new" });
  });

  it("never demotes a converted lead", () => {
    const converted = { status: "converted", leadStatus: "won" };
    expect(reconcileLeadState(converted, { leadStatus: "lost" })).toEqual({ status: "converted", leadStatus: "lost" });
    expect(reconcileLeadState(converted, { status: "converted", leadStatus: "won" })).toEqual(converted);
  });

  it("leaves a row holding won alone — it is not an error and not rewritten", () => {
    // Savannah writes "won"; deleting an account resets a converted lead to status new with "won".
    const won = { status: "new", leadStatus: "won" };
    expect(reconcileLeadState(won, { status: "new", leadStatus: "won" })).toEqual(won);
    expect(reconcileLeadState(won, { status: "contacted", leadStatus: "won" })).toEqual({ status: "contacted", leadStatus: "won" });
  });

  it("ordinary moves between open outcomes change nothing else", () => {
    expect(reconcileLeadState(open, { status: "contacted", leadStatus: "unresolved" })).toEqual({ status: "contacted", leadStatus: "unresolved" });
    expect(reconcileLeadState({ status: "contacted", leadStatus: "unresolved" }, { leadStatus: "planning" }))
      .toEqual({ status: "contacted", leadStatus: "planning" });
  });
});
