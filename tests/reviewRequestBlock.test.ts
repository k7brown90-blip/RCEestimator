/**
 * reviewRequestBlock (work order agent-team, TM0): the ONE place the review ask's refusals are worded. The four
 * codes are exactly not_complete, already_asked_job, no_email and automation_off. There is NO repeat-customer
 * window (removed 2026-11-21) and NO "Customer happy?" input (addendum v2): a completed, not-yet-asked job with an
 * email on file is askable whatever else is true of the customer.
 */
import { afterEach, describe, expect, it } from "vitest";
import { reviewRequestBlockOf, type ReviewBlockVisit } from "../src/services/reviewRequest";

const visit = (over: Partial<ReviewBlockVisit> = {}): ReviewBlockVisit => ({
  status: "completed", reviewRequestedAt: null, customer: { name: "Jane Homeowner", email: "jane@example.test" }, ...over,
});

afterEach(() => { delete process.env.AUTOMATED_CUSTOMER_SENDS_REVIEW_REQUESTS; });

describe("reviewRequestBlockOf", () => {
  it("not complete, then already asked, then no email, in that order, with the sentences the panel shows", () => {
    expect(reviewRequestBlockOf(visit({ status: "scheduled" }), { manual: true })).toMatchObject({ code: "not_complete", reason: "This job is not marked complete yet." });
    expect(reviewRequestBlockOf(visit({ status: "scheduled", reviewRequestedAt: new Date() }), { manual: true }).code).toBe("not_complete");
    expect(reviewRequestBlockOf(visit({ reviewRequestedAt: new Date() }), { manual: true })).toMatchObject({
      code: "already_asked_job", reason: "A review request has already been sent for this job.",
    });
    expect(reviewRequestBlockOf(visit({ customer: { name: "Jane Homeowner", email: null } }), { manual: true })).toMatchObject({
      code: "no_email", reason: "No email on file for Jane Homeowner — add one to the account first.",
    });
  });

  it("a typed recipient makes the missing account email no obstacle", () => {
    const r = reviewRequestBlockOf(visit({ customer: { name: "Jane Homeowner", email: null } }), { manual: true, hasToOverride: true });
    expect(r.code).toBeNull();
  });

  it("the automation gate stops an automatic ask, never a human's press", () => {
    delete process.env.AUTOMATED_CUSTOMER_SENDS_REVIEW_REQUESTS;
    expect(reviewRequestBlockOf(visit(), {}).code).toBe("automation_off");
    expect(reviewRequestBlockOf(visit(), { manual: true })).toEqual({ code: null, reason: null, firstName: "Jane" });
  });

  it("has no repeat-customer window and takes no happiness input: the only codes are the four", () => {
    const codes = new Set<string | null>();
    for (const v of [visit({ status: "x" }), visit({ reviewRequestedAt: new Date() }), visit({ customer: { name: "A B", email: null } }), visit()]) {
      codes.add(reviewRequestBlockOf(v, {}).code);
    }
    expect([...codes].sort()).toEqual(["already_asked_job", "automation_off", "no_email", "not_complete"]);
  });
});
