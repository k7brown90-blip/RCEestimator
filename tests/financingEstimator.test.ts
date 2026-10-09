/**
 * The in-app Synchrony financing estimator, server half (2026-10-08, one-estimating-system plan,
 * Phase 5 unit A / Detail B build audit A, B, D).
 *
 * Kyle, 2026-10-08: "the tool that service titan has which allows you to input the job total cost,
 * the plan they select and it shows them their monthly payment." One calculator (shared/financing.ts),
 * pure, in integer cents; the server computes and every screen renders its figures.
 *
 * What these pin:
 *   1. The math reproduces Synchrony's own estimator to the dollar ($8,643 -> 964/965 $152, 924
 *      $481, 920 $1,441) and does NOT reproduce its float artefact ($10,000 -> $175, not $176), and
 *      the $9,000 worked table from the plan.
 *   2. The deposit is the SAME number `depositDueOf` charges - never a second rounding.
 *   3. Settings validation: a rate typed as a fraction (0.061) is refused, a plan turned on with no
 *      disclosure text is refused, and the seeded defaults are Kyle's four plans in his order with
 *      Synchrony's text verbatim.
 *   4. The plans are FROZEN onto the estimate at issue: a later Settings edit changes a draft but
 *      never a sent quote, on the customer's page or in the quote payloads.
 *   5. Synchrony's discount rate (Red Cedar's cost) appears in NO customer-safe output: not the
 *      shared views, not the money payloads, not the /e/:token page source, not a CRM route that
 *      returns the estimate row - and no field/client source references the rate's field name
 *      outside the Settings screen.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import {
  buildQuoteFinancing,
  calculateFinancing,
  depositCentsOf,
  financingFeeCents,
  financingFigures,
  financingOffer,
  monthlyPaymentDollars,
  planView,
  type FinancingPlan,
} from "../shared/financing";
import { depositDueOf } from "../src/services/stripePayments";
import { DEFAULT_FINANCING_PLANS } from "../src/services/financingPlanDefaults";
import {
  getActiveFinancingPlans,
  getFinancingPlans,
  plansFromSnapshot,
  snapshotActiveFinancingPlansJson,
  validateFinancingPlans,
} from "../src/services/financingSettings";
import { buildQuoteMoney, getIssuedQuoteMoney, getQuoteMoney } from "../src/services/quoteMoney";
import type { ComputedEstimate } from "../src/services/atomicEstimateEngine";
import type { DraftLifecycle } from "../shared/draftLifecycle";
import type { PrismaClient } from "@prisma/client";

// No PIN_HASH in the test env - pinAuthMiddleware passes through (dev/test mode).
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials() {}
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }) },
        events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }) },
      }),
    },
  };
});

import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { getEstimateByToken, graduateDraft } from "../src/services/issuedEstimateService";
import { renderEstimatePage } from "../src/services/issuedEstimateRender";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const plan = (n: string) => DEFAULT_FINANCING_PLANS.find((p) => p.planNumber === n)!;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ─── 1. The math ─────────────────────────────────────────────────────────────────────────────

describe("the calculator reproduces Synchrony's estimator to the dollar", () => {
  const financed8643 = 864_300;

  it("$8,643 financed: 964 and 965 are $152 (1.75%, up), 924 is $481 (/18, up), 920 is $1,441 (/6, up)", () => {
    expect(monthlyPaymentDollars(plan("964"), financed8643)).toBe(152);
    expect(monthlyPaymentDollars(plan("965"), financed8643)).toBe(152);
    expect(monthlyPaymentDollars(plan("924"), financed8643)).toBe(481);
    expect(monthlyPaymentDollars(plan("920"), financed8643)).toBe(1441);
  });

  it("$10,000 financed on a 1.75% plan is $175 - Synchrony's page shows $176 from a float artefact", () => {
    expect(monthlyPaymentDollars(plan("964"), 1_000_000)).toBe(175);
    expect(monthlyPaymentDollars(plan("965"), 1_000_000)).toBe(175);
    // The artefact itself, so this test explains what it is guarding against.
    expect(0.0175 * 10000).not.toBe(175);
    expect(Math.ceil(0.0175 * 10000)).toBe(176);
  });

  it("a payment one cent over a whole dollar rounds up, exactly on a whole dollar stays", () => {
    // 1.75% of $5,714.28 = $99.9999 -> $100; of $5,714.29 = $100.000075 -> $101
    expect(monthlyPaymentDollars(plan("964"), 571_429)).toBe(101);
    expect(monthlyPaymentDollars(plan("964"), 571_428)).toBe(100);
    expect(monthlyPaymentDollars(plan("924"), 1800_00)).toBe(100);
    expect(monthlyPaymentDollars(plan("924"), 1800_01)).toBe(101);
  });

  it("the payoff period is the plan's stated term, never computed", () => {
    expect(calculateFinancing(plan("965"), 900_000).payoffMonths).toBe(86);
    expect(calculateFinancing(plan("964"), 900_000).payoffMonths).toBe(82);
    expect(calculateFinancing(plan("920"), 900_000).payoffMonths).toBe(6);
    expect(calculateFinancing(plan("924"), 900_000).payoffMonths).toBe(18);
  });
});

describe("the $9,000 job from the plan (deposit $3,000, balance $6,000)", () => {
  const rows: Array<[string, number, number, number]> = [
    // plan, fee, financed, monthly
    ["965", 183.0, 6183.0, 109],
    ["964", 217.5, 6217.5, 109],
    ["920", 213.0, 6213.0, 1036],
    ["924", 318.0, 6318.0, 351],
  ];
  for (const [n, fee, financed, monthly] of rows) {
    it(`plan ${n}: fee $${fee.toFixed(2)}, financed $${financed.toFixed(2)}, $${monthly}/mo`, () => {
      expect(financingFigures(plan(n), 900_000)).toEqual({
        planNumber: n,
        deposit: 3000,
        fee,
        financed,
        monthly,
      });
    });
  }
});

describe("integer cents - the fee rounds once, half up, and never through a float", () => {
  it("fee = half the rate x the balance, to the cent", () => {
    expect(financingFeeCents(600_000, 6.1)).toBe(18_300);
    expect(financingFeeCents(600_000, 7.25)).toBe(21_750);
    // 100 cents x 5% / 2 = 2.5 cents -> 3 (half up); 101 x 5% / 2 = 2.525 -> 3; 99 x 5%/2 = 2.475 -> 2
    expect(financingFeeCents(100, 5)).toBe(3);
    expect(financingFeeCents(101, 5)).toBe(3);
    expect(financingFeeCents(99, 5)).toBe(2);
  });

  it("a zero discount rate means no fee", () => {
    expect(financingFeeCents(600_000, 0)).toBe(0);
  });

  it("the deposit is EXACTLY depositDueOf's - one third, to the cent - for every total in a wide range", () => {
    for (let cents = 1; cents <= 40_000; cents++) {
      expect(depositCentsOf(cents)).toBe(Math.round(depositDueOf(cents / 100) * 100));
    }
    for (const dollars of [0.01, 99.99, 1234.56, 8643, 8999.99, 10000, 12345.67, 99999.99, 250000.01]) {
      expect(depositCentsOf(Math.round(dollars * 100))).toBe(Math.round(depositDueOf(dollars) * 100));
    }
  });

  it("deposit + balance always equal the total, and financed is balance + fee", () => {
    for (const cents of [100_00, 333_33, 8_643_00, 9_000_00, 12_345_67]) {
      const c = calculateFinancing(plan("924"), cents);
      expect(c.depositCents + c.balanceCents).toBe(cents);
      expect(c.financedCents).toBe(c.balanceCents + c.feeCents);
    }
  });
});

// ─── 2. Customer-safe views ──────────────────────────────────────────────────────────────────

describe("the customer-safe output carries no rate", () => {
  const SECRET = 7.7771; // a rate that appears nowhere else in the repo's output
  const secretPlan: FinancingPlan = { ...clone(plan("965")), discountRatePct: SECRET };

  it("planView and financingOffer have exactly the documented keys", () => {
    expect(Object.keys(planView(secretPlan)).sort()).toEqual(["apr", "description", "disclosure", "months", "planNumber", "type"]);
    expect(Object.keys(financingOffer(secretPlan, 900_000)).sort()).toEqual([
      "apr", "deposit", "description", "disclosure", "fee", "financed", "monthly", "months", "planNumber", "type",
    ]);
  });

  it("a deferred-interest plan has no APR", () => {
    expect(planView(plan("924")).apr).toBeNull();
    expect(planView(plan("964")).apr).toBe(10.99);
  });

  it("the finished financing table serialises with neither the rate's name nor its value", () => {
    const fin = buildQuoteFinancing([secretPlan, plan("964")], { A: 900_00 / 100 * 10, "A+B": 1234.56 });
    const text = JSON.stringify(fin);
    expect(text).not.toMatch(/"(discountRatePct|paymentFactorPct|sortOrder|active)"/);
    expect(text).not.toContain(String(SECRET));
  });
});

describe("buildQuoteFinancing - every priced selection, in plan order", () => {
  it("one entry per priced selection; 'from' is the lowest monthly among the active plans", () => {
    const fin = buildQuoteFinancing(DEFAULT_FINANCING_PLANS, { A: 9000, "A+B": 12000 })!;
    expect(fin.plans.map((p) => p.planNumber)).toEqual(["965", "964", "920", "924"]);
    expect(Object.keys(fin.bySelection)).toEqual(["A", "A+B"]);
    expect(fin.bySelection["A"].offers.map((o) => o.monthly)).toEqual([109, 109, 1036, 351]);
    // 965 and 964 tie at $109: the plan shown first (965, the cheapest for Red Cedar) is the headline.
    expect(fin.bySelection["A"].fromMonthly).toBe(109);
    expect(fin.bySelection["A"].fromPlanNumber).toBe("965");
  });

  it("skips inactive plans, and is null when none is active", () => {
    const off = DEFAULT_FINANCING_PLANS.map((p) => ({ ...p, active: p.planNumber === "924" }));
    const fin = buildQuoteFinancing(off, { A: 9000 })!;
    expect(fin.plans.map((p) => p.planNumber)).toEqual(["924"]);
    expect(fin.bySelection["A"].fromMonthly).toBe(351);
    expect(buildQuoteFinancing(DEFAULT_FINANCING_PLANS.map((p) => ({ ...p, active: false })), { A: 9000 })).toBeNull();
  });

  it("a selection with nothing owed is absent - never '$0/mo'", () => {
    const fin = buildQuoteFinancing(DEFAULT_FINANCING_PLANS, { A: 0, B: 9000 })!;
    expect(Object.keys(fin.bySelection)).toEqual(["B"]);
  });

  it("home-warranty coverage comes off first, capped at the selection's total", () => {
    const fin = buildQuoteFinancing(DEFAULT_FINANCING_PLANS, { A: 9000, B: 300 }, 370)!;
    // A: $9,000 - $370 = $8,630; B: covered in full -> nothing to finance
    expect(fin.bySelection["A"].offers[0].deposit).toBe(2876.67);
    expect(fin.bySelection["B"]).toBeUndefined();
  });

  it("says so when coverage reduced the share: the selection carries the coverage and the homeowner's share", () => {
    const fin = buildQuoteFinancing(DEFAULT_FINANCING_PLANS, { A: 9000, B: 300, C: 9000 }, 3000)!;
    // $9,000 with $3,000 covered: the cards are worked on $6,000 and the sheet must be able to say so.
    expect(fin.bySelection["A"].warrantyCovered).toBe(3000);
    expect(fin.bySelection["A"].yourShare).toBe(6000);
    expect(fin.bySelection["A"].offers[0].deposit).toBe(2000);
    // Coverage is capped at the selection's own total.
    expect(fin.bySelection["B"]).toBeUndefined();
    // No claim: the keys are absent altogether (payloads without a claim are byte-for-byte unchanged).
    const plain = buildQuoteFinancing(DEFAULT_FINANCING_PLANS, { A: 9000 })!;
    expect(Object.keys(plain.bySelection["A"]).sort()).toEqual(["fromMonthly", "fromPlanNumber", "offers"]);
  });

  it("sorts by sortOrder, whatever order the list arrives in", () => {
    const shuffled = [plan("924"), plan("965"), plan("920"), plan("964")];
    expect(buildQuoteFinancing(shuffled, { A: 9000 })!.plans.map((p) => p.planNumber)).toEqual(["965", "964", "920", "924"]);
  });
});

// ─── 3. Settings: seeded defaults and validation ─────────────────────────────────────────────

describe("the seeded plan list", () => {
  it("is Kyle's four plans in his order: 965, 964, 920, 924, all on", () => {
    expect(DEFAULT_FINANCING_PLANS.map((p) => p.planNumber)).toEqual(["965", "964", "920", "924"]);
    expect(DEFAULT_FINANCING_PLANS.map((p) => p.sortOrder)).toEqual([1, 2, 3, 4]);
    expect(DEFAULT_FINANCING_PLANS.every((p) => p.active)).toBe(true);
  });

  it("carries Synchrony's rates and terms as Kyle's portal showed them", () => {
    const by = (n: string) => {
      const p = plan(n);
      return [p.type, p.months, p.apr, p.paymentFactorPct, p.discountRatePct];
    };
    expect(by("965")).toEqual(["reduced_apr", 86, 11.99, 1.75, 6.1]);
    expect(by("964")).toEqual(["reduced_apr", 82, 10.99, 1.75, 7.25]);
    expect(by("920")).toEqual(["deferred_interest", 6, null, 2.5, 7.1]);
    expect(by("924")).toEqual(["deferred_interest", 18, null, 2.5, 10.6]);
  });

  it("964 disclosure is the Appendix text verbatim", () => {
    const d = plan("964").disclosure;
    expect(d.explanation).toBe(
      "The estimated required monthly payment shown (which excludes taxes and delivery) equals the amount financed multiplied by 1.75%, rounded to the next highest whole dollar. During the last month(s) of the promo period the required monthly payment may be reduced due to this rounding. The sum of the required monthly payments will equal the cost of the amount financed. If you make the required payments by the due date each month, you should pay off the amount financed within the promo period, if it is the only balance you are paying off. If you have other balances on your account, this payment will be added to any other minimum monthly payments.",
    );
    expect(d.important).toBe(
      "IMPORTANT: The information about the Fixed Monthly Payment shown assumes this promotional financing offer is applied to the amount financed.",
    );
    expect(d.terms).toBe(
      "10.99% APR Until Paid in Full — On qualifying purchases made with your Synchrony Bank Credit Card. $29 account activation fee may apply. Fixed monthly payments required for 82 months. Interest will be charged on the promo purchase from the purchase date at a reduced 10.99% APR, and fixed monthly payments are required until paid in full. These payments are equal to 1.75% of initial total promo purchase amount, rounded up to the next whole dollar. These payments may be higher than the payments that would be required if this purchase was a non-promo purchase. During the last month(s) of the promo period the required monthly payment may be reduced due to the prior months’ rounding. Regular account terms apply to non-promo purchases. New Accounts as of 08/29/25: Purchase APR 26.99%. Min Interest Charge $2. One-time Account Activation Fee of $29 charged at time first purchase posts to account. Existing cardholders: See your credit card agreement terms. Subject to credit approval.",
    );
  });

  it("924 disclosure is the Appendix text verbatim", () => {
    const d = plan("924").disclosure;
    expect(d.explanation).toBe(
      "The Suggested Equal Monthly Payment shown which may exclude taxes and delivery may be greater than the required minimum monthly payment that will be on your billing statement when you use the 18 month promotional financing offer. This estimated payment: Equals the amount financed divided by 18 rounded to the next highest whole dollar. Would pay off the amount financed within 18 months, but only if there are no other balances on your account at any time during the 18 month promotional period and you make your payments on time. Your total payments will equal the amount of the amount financed. If the amount financed is not paid in full within 18 months, interest will be charged to your account from the purchase date and your total payments will be greater than the amount of the amount financed.",
    );
    expect(d.important).toBe(
      "IMPORTANT: The information about the Suggested Equal Monthly Payment shown assumes this promotional financing offer is applied to the Promotional Purchase.",
    );
    expect(d.terms.startsWith("No Interest if Paid in Full within 18 Months — On qualifying purchases made with your Synchrony Bank Credit Card. Interest will be charged to your account from the purchase date if the promotional balance is not paid in full within 18 Months. $29 account activation fee may apply. Fixed Monthly Payments required equal to 2.5% of the highest balance")).toBe(true);
    expect(d.terms.endsWith("New Accounts as of 08/29/25: Purchase APR 26.99%. Min Interest Charge: $2. One-time Account Activation Fee of $29 charged at time first purchase posts to account. Existing cardholders: See your credit card agreement terms. Subject to credit approval.")).toBe(true);
  });

  it("965 is 964's text with 11.99% for 10.99% (both places) and 86 months for 82; explanation and IMPORTANT identical", () => {
    const a = plan("964").disclosure;
    const b = plan("965").disclosure;
    expect(b.explanation).toBe(a.explanation);
    expect(b.important).toBe(a.important);
    expect(b.terms).toBe(a.terms.replace(/10\.99%/g, "11.99%").replace("82 months", "86 months"));
    expect(b.terms.match(/11\.99%/g)).toHaveLength(2);
    expect(b.terms).not.toContain("10.99%");
    expect(b.terms).toContain("Fixed monthly payments required for 86 months.");
  });

  it("920 is 924's text with 6 for 18 everywhere (and nothing else changed)", () => {
    const a = plan("924").disclosure;
    const b = plan("920").disclosure;
    expect(b.explanation).toBe(a.explanation.replace(/18/g, "6"));
    expect(b.important).toBe(a.important);
    expect(b.terms).toBe(a.terms.replace(/18/g, "6"));
    expect(b.explanation).toContain("when you use the 6 month promotional financing offer");
    expect(b.explanation).toContain("divided by 6 rounded");
    expect(b.explanation).toContain("within 6 months");
    expect(b.explanation).toContain("during the 6 month promotional period");
    expect(b.terms).toContain("within 6 Months");
    expect(b.terms).toContain("equal to 2.5% of the highest balance"); // the factor is not a month count
    expect(b.terms).toContain("08/29/25");
    expect(`${b.explanation}${b.terms}`).not.toMatch(/18/);
  });
});

describe("validateFinancingPlans - a wrong number never reaches a customer", () => {
  const valid = () => clone(DEFAULT_FINANCING_PLANS) as FinancingPlan[];
  const errorsOf = (list: unknown) => {
    const r = validateFinancingPlans(list);
    return r.ok ? [] : r.errors;
  };

  it("accepts the seeded defaults unchanged, and the { plans } wrapper", () => {
    const r = validateFinancingPlans(valid());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plans).toEqual(DEFAULT_FINANCING_PLANS);
    expect(validateFinancingPlans({ plans: valid() }).ok).toBe(true);
  });

  it("refuses a discount rate typed as a fraction (0.061), like purchasingSettings refuses 9.75 as a fraction", () => {
    const list = valid();
    list[0].discountRatePct = 0.061;
    expect(errorsOf(list).join(" ")).toMatch(/Plan 965: Discount rate is 0\.061 - that looks like a fraction/);
  });

  it("refuses a payment factor typed as a fraction (0.0175) and an APR typed as one (0.1099)", () => {
    const list = valid();
    list[0].paymentFactorPct = 0.0175;
    list[1].apr = 0.1099;
    const msg = errorsOf(list).join(" | ");
    expect(msg).toMatch(/Plan 965: Payment factor is 0\.0175/);
    expect(msg).toMatch(/Plan 964: APR is 0\.1099/);
  });

  it("allows a 0% discount rate and refuses an absurd one", () => {
    const list = valid();
    list[0].discountRatePct = 0;
    expect(validateFinancingPlans(list).ok).toBe(true);
    list[0].discountRatePct = 61;
    expect(errorsOf(list).join(" ")).toMatch(/Discount rate cannot be more than 40/);
  });

  it("refuses more than four decimals, non-numbers, and non-finite values", () => {
    const list = valid();
    list[0].discountRatePct = 6.123456;
    expect(errorsOf(list).join(" ")).toMatch(/at most four decimal places/);
    const bad = valid() as unknown as Array<Record<string, unknown>>;
    bad[0].discountRatePct = "6.1";
    bad[1].paymentFactorPct = null;
    const msg = errorsOf(bad).join(" | ");
    expect(msg).toMatch(/Plan 965: Discount rate must be a number/);
    expect(msg).toMatch(/Plan 964: Payment factor must be a number/);
  });

  it("refuses an ACTIVE plan with no Synchrony disclosure text (credit terms never without the lender's words)", () => {
    const list = valid();
    list[2].disclosure = { explanation: "", important: "x", terms: "   " };
    const msg = errorsOf(list).join(" | ");
    expect(msg).toMatch(/Plan 920: is turned on but has no disclosure explanation/);
    expect(msg).toMatch(/Plan 920: is turned on but has no disclosure terms/);
    // The same plan switched OFF is a draft and may be saved without text.
    list[2].active = false;
    expect(validateFinancingPlans(list).ok).toBe(true);
  });

  it("refuses duplicate plan numbers, a missing number, a bad type, and bad months", () => {
    const list = valid() as unknown as Array<Record<string, unknown>>;
    list[1].planNumber = "965";
    list[2].type = "free_money";
    list[3].months = 0;
    list.push({ ...clone(list[0]), planNumber: " " });
    const msg = errorsOf(list).join(" | ");
    expect(msg).toMatch(/this plan number is listed twice/);
    expect(msg).toMatch(/type must be "reduced_apr" or "deferred_interest"/);
    expect(msg).toMatch(/months must be a whole number from 1 to 120/);
    expect(msg).toMatch(/needs a plan number/);
  });

  it("renumbers sortOrder 1..n in the order given by sortOrder, and clears the APR on a deferred plan", () => {
    const list = valid();
    list[0].sortOrder = 9;
    list[3].apr = 5; // a deferred plan carries no APR
    const r = validateFinancingPlans(list);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plans.map((p) => p.planNumber)).toEqual(["964", "920", "924", "965"]);
    expect(r.plans.map((p) => p.sortOrder)).toEqual([1, 2, 3, 4]);
    expect(r.plans.find((p) => p.planNumber === "924")!.apr).toBeNull();
  });

  it("keeps the disclosure exactly as pasted - no trim", () => {
    const list = valid();
    list[0].disclosure.terms = "  Pasted exactly.  ";
    const r = validateFinancingPlans(list);
    expect(r.ok && r.plans.find((p) => p.planNumber === "965")!.disclosure.terms).toBe("  Pasted exactly.  ");
  });

  it("refuses a plan number that could break the customer page's card lookup", () => {
    for (const bad of ['9"65', String.raw`96\5`, "9 65", "9']65", "<b>"]) {
      const list = valid();
      list[0].planNumber = bad;
      const r = validateFinancingPlans(list);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.errors.join(" ")).toMatch(/letters, numbers and hyphens/);
    }
    const ok = valid();
    ok[0].planNumber = "965-B";
    expect(validateFinancingPlans(ok).ok).toBe(true);
  });

  it("refuses a non-list and an over-long list", () => {
    expect(validateFinancingPlans("nope").ok).toBe(false);
    expect(validateFinancingPlans({}).ok).toBe(false);
    expect(validateFinancingPlans(Array.from({ length: 13 }, () => valid()[0])).ok).toBe(false);
  });
});

// ─── 4. The money payloads ───────────────────────────────────────────────────────────────────

const line = (id: string, option: string, laborDollars: number, materialSell: number) =>
  ({ id, option, itemId: id, laborHours: 1, laborDollars, materialSell, complete: true }) as never;
const computed = (lines: unknown[]): ComputedEstimate =>
  ({ billedLaborRate: 100, lines, combinationDiscounts: {}, jobFixedCost: 0 }) as unknown as ComputedEstimate;

describe("the quote money payloads carry financing for EVERY priced selection", () => {
  const three = computed([line("1", "A", 5000, 0), line("2", "B", 2500, 500), line("3", "C", 1000, 0)]);
  const draft = { discountType: null, discountPercent: null, exclusiveOptions: false };

  it("financing keys are exactly the selection keys, and each total finances from the server's own figure", () => {
    const money = buildQuoteMoney(three, draft, { plans: DEFAULT_FINANCING_PLANS });
    expect(money.financing).toBeTruthy();
    expect(Object.keys(money.financing!.bySelection).sort()).toEqual(Object.keys(money.selections).sort());
    for (const [key, price] of Object.entries(money.selections)) {
      const expected = financingFigures(plan("965"), Math.round(price.total * 100));
      expect(money.financing!.bySelection[key].offers[0]).toEqual(expected);
    }
    // "From" is the lowest monthly among the active plans for that selection.
    const a = money.financing!.bySelection["A"];
    expect(a.fromMonthly).toBe(Math.min(...a.offers.map((o) => o.monthly)));
  });

  it("a programme discount lowers the figure financed (the payment is on what the customer actually pays)", () => {
    const plain = buildQuoteMoney(three, draft, { plans: DEFAULT_FINANCING_PLANS });
    const mil = buildQuoteMoney(three, { ...draft, discountType: "military" }, { plans: DEFAULT_FINANCING_PLANS });
    expect(mil.selections["A+B+C"].total).toBeLessThan(plain.selections["A+B+C"].total);
    expect(mil.financing!.bySelection["A+B+C"].offers[0].financed).toBeLessThan(plain.financing!.bySelection["A+B+C"].offers[0].financed);
  });

  it("no plans given means no financing key at all (existing payload shape untouched)", () => {
    expect("financing" in buildQuoteMoney(three, draft)).toBe(false);
  });

  it("serialised payload names no rate and no rate value", () => {
    const rated = DEFAULT_FINANCING_PLANS.map((p) => ({ ...p, discountRatePct: 7.7771 }));
    const text = JSON.stringify(buildQuoteMoney(three, draft, { plans: rated }));
    expect(text).not.toMatch(/discountRate|paymentFactor/);
    expect(text).not.toContain("7.7771");
  });
});

// ─── 5. Database: Settings route, snapshot at issue, the page, the leaks ─────────────────────

const MARK = "P5FIN";
const GOOD_A = "BF001";
const GOOD_B = "A008";
let customerId: string;
let propertyId: string;
let visitId: string;
const draftIds: string[] = [];

async function cleanEstimatesFor(ids: string[]) {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: ids } } });
  const estIds = ests.map((e) => e.id);
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
}

const dropSetting = () => prisma.companySetting.deleteMany({ where: { key: "financingPlans" } });

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(GOOD_A), quotableAtomic(GOOD_B)]);
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "p5fin-customer@example.com", phone: "615-555-0150" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "5 Financing Way", city: "La Vergne", state: "TN", postalCode: "37086" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" },
  });
  visitId = visit.id;
});

beforeEach(dropSetting);

afterAll(async () => {
  await dropSetting();
  await cleanEstimatesFor(draftIds);
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([GOOD_A, GOOD_B]);
});

/** A two-option draft, so the customer page offers the picker (and its financing table). */
async function twoOptionDraft(title: string) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: GOOD_A, quantity: 2, option: "A" });
  await addLine(prisma, d.id, { itemId: GOOD_B, quantity: 1, option: "B" });
  return d;
}

async function issue(title: string) {
  const d = await twoOptionDraft(title);
  const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
  expect(g.ok).toBe(true);
  if (!g.ok) throw new Error("did not issue");
  const est = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: g.estimateId } });
  return { draft: d, est };
}

async function pageFor(token: string) {
  const found = await getEstimateByToken(prisma, token);
  if (!found.ok) throw new Error("no estimate for token");
  return renderEstimatePage(found.estimate);
}

/** Pull the JSON the page script was handed: `var <name> = <json>;` on one line. */
function embedded(html: string, name: string): unknown {
  const m = html.match(new RegExp(`var ${name} = (.*);\\r?\\n`));
  if (!m) throw new Error(`page has no "var ${name}"`);
  return JSON.parse(m[1]);
}

describe("Settings: PUT /crm/settings/financingPlans validates on the server", () => {
  it("refuses 0.061 with a 400 that names the plan and the box, and stores nothing", async () => {
    const list = clone(DEFAULT_FINANCING_PLANS) as FinancingPlan[];
    list[0].discountRatePct = 0.061;
    const res = await request(app).put("/crm/settings/financingPlans").send(list);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Plan 965: Discount rate is 0\.061/);
    expect(await prisma.companySetting.findUnique({ where: { key: "financingPlans" } })).toBeNull();
  });

  it("refuses an active plan with no disclosure text", async () => {
    const list = clone(DEFAULT_FINANCING_PLANS) as FinancingPlan[];
    list[1].disclosure.terms = "";
    const res = await request(app).put("/crm/settings/financingPlans").send(list);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Plan 964: is turned on but has no disclosure terms/);
  });

  it("stores a valid list normalised and in display order; GET /crm/financing-plans reads it back", async () => {
    const list = clone(DEFAULT_FINANCING_PLANS) as FinancingPlan[];
    list[3].sortOrder = 0; // 924 moved to the front
    list[0].description = "11.99% APR until paid in full (edited)";
    const res = await request(app).put("/crm/settings/financingPlans").send(list);
    expect(res.status).toBe(200);
    const got = await request(app).get("/crm/financing-plans");
    expect(got.status).toBe(200);
    expect(got.body.plans.map((p: FinancingPlan) => p.planNumber)).toEqual(["924", "965", "964", "920"]);
    expect(got.body.plans.map((p: FinancingPlan) => p.sortOrder)).toEqual([1, 2, 3, 4]);
    expect(got.body.plans[1].description).toBe("11.99% APR until paid in full (edited)");
    expect(await getFinancingPlans()).toEqual(got.body.plans);
  });

  it("an empty list is allowed (financing off) and is not replaced by the defaults", async () => {
    expect((await request(app).put("/crm/settings/financingPlans").send([])).status).toBe(200);
    expect(await getFinancingPlans()).toEqual([]);
    expect(await getActiveFinancingPlans()).toEqual([]);
    expect(await snapshotActiveFinancingPlansJson()).toBeNull();
  });

  it("with no row saved the app reads Kyle's four plans, and GET /crm/settings is unchanged", async () => {
    const got = await request(app).get("/crm/financing-plans");
    expect(got.body.plans.map((p: FinancingPlan) => p.planNumber)).toEqual(["965", "964", "920", "924"]);
    const all = await request(app).get("/crm/settings");
    expect(all.body.financingPlans).toBeUndefined();
  });

  it("a garbled stored row falls back to the defaults rather than hiding financing", async () => {
    await prisma.companySetting.create({ data: { key: "financingPlans", valueJson: "{not json" } });
    expect((await getFinancingPlans()).map((p) => p.planNumber)).toEqual(["965", "964", "920", "924"]);
  });

  it("the plan list is a CRM-session route: with a PIN set, no token is a 401", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    process.env.PIN_HASH = await bcrypt.hash("135790", 10);
    try {
      expect((await request(app).get("/crm/financing-plans")).status).toBe(401);
      expect((await request(app).put("/crm/settings/financingPlans").send([])).status).toBe(401);
    } finally {
      delete process.env.PIN_HASH;
    }
  });
});

describe("the plans are frozen onto the estimate at issue", () => {
  it("stores the active plans (rates included - a server-side column) and reads them back", async () => {
    const { est } = await issue("snapshot");
    expect(est.financingPlansJson).toBeTruthy();
    const plans = plansFromSnapshot(est.financingPlansJson)!;
    expect(plans.map((p) => p.planNumber)).toEqual(["965", "964", "920", "924"]);
    expect(plans[0].discountRatePct).toBe(6.1);
  });

  it("only ACTIVE plans are frozen, and none active freezes nothing", async () => {
    const list = clone(DEFAULT_FINANCING_PLANS) as FinancingPlan[];
    list[0].active = false;
    list[3].active = false;
    await request(app).put("/crm/settings/financingPlans").send(list);
    const { est } = await issue("only-active");
    expect(plansFromSnapshot(est.financingPlansJson)!.map((p) => p.planNumber)).toEqual(["964", "920"]);

    await request(app).put("/crm/settings/financingPlans").send([]);
    const { est: none } = await issue("none-active");
    expect(none.financingPlansJson).toBeNull();
    expect(plansFromSnapshot(none.financingPlansJson)).toBeNull();
    // ... and the page of such an estimate offers no financing.
    const html = await pageFor(none.token);
    // (Phase 5 unit B: with nothing on offer the page carries neither the block nor the table.)
    expect(html).not.toContain("var financing");
    expect(html).not.toContain('id="finBlock"');
    expect(html).toContain("ESTIMATE TOTAL"); // paired: the page itself rendered
  });

  it("a Settings edit after issue never changes a sent estimate - not the page, not the payload", async () => {
    const { est: before } = await issue("frozen-before");
    const htmlBefore = await pageFor(before.token);
    const finBefore = embedded(htmlBefore, "financing") as { plans: Array<{ planNumber: string; description: string }>; bySelection: Record<string, { offers: Array<{ monthly: number }> }> };

    // Kyle edits the plan list: a new description AND a new rate on plan 965, and drops plan 924.
    const list = clone(DEFAULT_FINANCING_PLANS) as FinancingPlan[];
    list[0].description = "CHANGED PLAN TEXT";
    list[0].discountRatePct = 9.4;
    const edited = list.filter((p) => p.planNumber !== "924");
    expect((await request(app).put("/crm/settings/financingPlans").send(edited)).status).toBe(200);

    // The estimate sent earlier still reads its own snapshot.
    const htmlAfter = await pageFor(before.token);
    expect(embedded(htmlAfter, "financing")).toEqual(finBefore);
    expect(htmlAfter).not.toContain("CHANGED PLAN TEXT");
    expect(finBefore.plans.map((p) => p.planNumber)).toEqual(["965", "964", "920", "924"]);
    const money = await getIssuedQuoteMoney(prisma, before.id);
    expect(money!.financing!.plans.map((p) => p.planNumber)).toEqual(["965", "964", "920", "924"]);
    expect(money!.financing!.plans[0].description).not.toContain("CHANGED");

    // A NEW estimate takes the edited list; and a DRAFT (never issued) reads live Settings.
    const { est: after } = await issue("frozen-after");
    const htmlNew = await pageFor(after.token);
    const finNew = embedded(htmlNew, "financing") as typeof finBefore;
    expect(finNew.plans.map((p) => p.planNumber)).toEqual(["965", "964", "920"]);
    expect(finNew.plans[0].description).toBe("CHANGED PLAN TEXT");
    const live = await getQuoteMoney(
      {
        issuedEstimate: { findUnique: async () => null },
        priceBookDraftEstimate: { findUnique: async () => ({ discountType: null, discountPercent: null, exclusiveOptions: false }) },
      } as unknown as PrismaClient,
      "d1",
      computed([line("1", "A", 5000, 0)]),
      { status: "draft", issued: null, hasUnsavedChanges: false, reviseReason: null, deleteReason: null, copyReason: null } as DraftLifecycle,
    );
    expect(live.financing!.plans.map((p) => p.planNumber)).toEqual(["965", "964", "920"]);
  });
});

describe("the customer page /e/:token: finished figures only", () => {
  it("every combination has its financing figures, equal to the shared calculator over the page's own total", async () => {
    const { est } = await issue("page");
    const html = await pageFor(est.token);
    const combos = embedded(html, "combos") as Record<string, { total: number }>;
    const fin = embedded(html, "financing") as { plans: Array<{ planNumber: string; disclosure: { terms: string } }>; bySelection: Record<string, { offers: Array<{ planNumber: string; monthly: number; deposit: number; fee: number; financed: number }>; fromMonthly: number }> };
    expect(Object.keys(fin.bySelection).sort()).toEqual(Object.keys(combos).sort());
    expect(Object.keys(combos).length).toBeGreaterThan(1);
    for (const [key, row] of Object.entries(combos)) {
      const offers = DEFAULT_FINANCING_PLANS.map((p) => financingFigures(p, Math.round(row.total * 100)));
      expect(fin.bySelection[key].offers).toEqual(offers);
      expect(fin.bySelection[key].fromMonthly).toBe(Math.min(...offers.map((o) => o.monthly)));
    }
    // Each plan's Synchrony disclosure rides with the plan, verbatim.
    expect(fin.plans.find((p) => p.planNumber === "964")!.disclosure.terms).toBe(plan("964").disclosure.terms);
  });

  it("the page source never contains Synchrony's discount rate - not its name, not its value", async () => {
    const list = (clone(DEFAULT_FINANCING_PLANS) as FinancingPlan[]).map((p, i) => ({ ...p, discountRatePct: 7.7771 + i * 0.0001 }));
    expect((await request(app).put("/crm/settings/financingPlans").send(list)).status).toBe(200);
    const { est } = await issue("no-rates-in-source");
    // The server-side column DOES hold them (it must, to recompute) ...
    expect(est.financingPlansJson).toContain("7.7771");
    // ... and the page, built from it, does not.
    const html = await pageFor(est.token);
    expect(html).not.toMatch(/discountRate|paymentFactor|financingPlans/);
    for (const v of ["7.7771", "7.7772", "7.7773", "7.7774"]) expect(html).not.toContain(v);
    expect(html).toContain("var financing = {");
  });

  it("a '<' in Settings-typed disclosure text cannot close the page script", async () => {
    const list = clone(DEFAULT_FINANCING_PLANS) as FinancingPlan[];
    list[0].disclosure.important = "IMPORTANT </script><b>x</b>";
    expect((await request(app).put("/crm/settings/financingPlans").send(list)).status).toBe(200);
    const { est } = await issue("script-safe");
    const html = await pageFor(est.token);
    const fin = embedded(html, "financing") as { plans: Array<{ disclosure: { important: string } }> };
    expect(fin.plans[0].disclosure.important).toBe("IMPORTANT </script><b>x</b>");
    expect(html).not.toContain("IMPORTANT </script>");
  });
});

describe("the rate does not ride out on a CRM route that returns the estimate row", () => {
  it("GET /issued-estimates/:id, the account estimate list and the estimate record all drop financingPlansJson", async () => {
    const rated = (clone(DEFAULT_FINANCING_PLANS) as FinancingPlan[]).map((p, i) => ({ ...p, discountRatePct: 7.7771 + i * 0.0001 }));
    expect((await request(app).put("/crm/settings/financingPlans").send(rated)).status).toBe(200);
    const { est } = await issue("leaks");
    expect(est.financingPlansJson).toContain("7.7771");
    const one = await request(app).get(`/issued-estimates/${est.id}`);
    expect(one.status).toBe(200);
    const list = await request(app).get(`/accounts/${customerId}/estimates`);
    expect(list.status).toBe(200);
    const rec = await request(app).get(`/issued-estimates/${est.id}/record`);
    expect(rec.status).toBe(200);
    for (const res of [one, list, rec]) {
      expect(res.text).not.toMatch(/financingPlansJson|discountRatePct/);
      for (const v of ["7.7771", "7.7772", "7.7773", "7.7774"]) expect(res.text).not.toContain(v);
    }
    // The same routes still return the estimate itself.
    expect(one.body.estimate.number).toBe(est.number);
    expect(list.body.estimates.some((e: { id: string }) => e.id === est.id)).toBe(true);
  });
});

// ─── 6. Where the rate's name may appear in the source ───────────────────────────────────────

describe("no field or client source touches Synchrony's discount rate except the Settings screen", () => {
  const ROOT = join(__dirname, "..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };

  it("discountRatePct is named in client/src only by the Settings plan screen (and tests); never in field/src", () => {
    const offenders: string[] = [];
    for (const dir of ["client/src", "field/src"]) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file).replace(/\\/g, "/");
        if (/\.test\.tsx?$/.test(rel)) continue;
        if (rel === "client/src/pages/FinancingPlansSection.tsx") continue;
        if (readFileSync(file, "utf8").includes("discountRatePct")) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("anything in field/ that imports shared/financing imports TYPES only, so no rate arithmetic is bundled", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "field/src"))) {
      if (/\.test\.tsx?$/.test(file)) continue;
      const src = readFileSync(file, "utf8");
      // One import STATEMENT: no other import may start a line between "import" and "from". The field
      // source has no semicolons, so a bare [^;]* ran across lines and flagged a harmless neighbour
      // (a react import above a type-only shared/financing import, Phase 5 unit B).
      for (const m of src.matchAll(/^import\s+(?!type\b)(?:(?!^import\b)[^])*?from\s+["'][^"']*shared\/financing["']/gm)) offenders.push(`${relative(ROOT, file)}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});
