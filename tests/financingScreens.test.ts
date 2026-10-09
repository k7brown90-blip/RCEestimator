/**
 * The financing estimator ON THE SCREENS (Phase 5 unit B, 2026-10-08, one-estimating-system plan).
 *
 * Kyle: "the tool that service titan has which allows you to input the job total cost, the plan they
 * select and it shows them their monthly payment." Unit A built the calculator and put its finished
 * figures on every payload; this pins how the words are chosen (shared/financingDisplay.ts, read by
 * the CRM, the field and the customer's page) and what the CUSTOMER'S PAGE (/e/:token) says.
 *
 * What is pinned, and why each absence is paired with a presence:
 *   - the headline "or from $X/mo with financing" and the four plan cards, in Kyle's order
 *     (965, 964, 920, 924), each with Synchrony's own label for the monthly figure, the term, the
 *     deposit / financing-fee / amount-financed lines and THAT plan's disclosure VERBATIM and whole;
 *   - every figure on the page is the shared calculator's, over the page's own total - and the
 *     script that repaints on a tick only swaps text (no arithmetic, no rate);
 *   - Red Cedar's cost (the Synchrony discount rate) is in neither the markup nor the script, and
 *     "total payments with interest" is nowhere;
 *   - no block on a signed or closed estimate, or one with no frozen plans; a single-option page
 *     shows it without needing a script.
 * The EMAIL tests (issuedEstimate.test.ts, financingEmail.test.ts) are untouched and still pin the
 * emails term-free.
 */

import { describe, expect, it } from "vitest";
import { renderEstimatePage, escapeHtml } from "../src/services/issuedEstimateRender";
import type { IssuedEstimateWithLines } from "../src/services/issuedEstimateService";
import { DEFAULT_FINANCING_PLANS } from "../src/services/financingPlanDefaults";
import { buildQuoteFinancing, financingFigures, type FinancingPlan } from "../shared/financing";
import {
  breakdownRows,
  cheapestSelection,
  financingOffersFor,
  fromLine,
  monthlyLabel,
  planTitle,
  selectionFinancing,
  termLine,
  wholeDollars,
} from "../shared/financingDisplay";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Distinct, never-otherwise-appearing rates, so a leak cannot hide behind a coincidence. */
const SECRET_RATES = [7.7771, 7.7772, 7.7773, 7.7774];
const plans = (): FinancingPlan[] =>
  (clone(DEFAULT_FINANCING_PLANS) as FinancingPlan[]).map((p, i) => ({ ...p, discountRatePct: SECRET_RATES[i] }));
const snapshot = (list: FinancingPlan[] = plans()) => JSON.stringify({ plans: list });

// ─── the page fixture (no database: the render is a pure function of the row) ─────────────────

type Opt = "A" | "B" | "C";
const line = (option: Opt, description: string, lineTotal: number, quantity = 1) => ({
  id: `${option}-${description}`, estimateId: "e1", itemId: description, description, quantity,
  unitPrice: lineTotal / quantity, lineTotal, sortOrder: 0, option,
  laborHours: 2, materialSell: lineTotal / 2, materialCost: lineTotal / 4, flatPriced: false, inMaterialCap: true,
});
const option = (o: Opt, subtotal: number, lineCount: number, label: string | null) => ({
  id: `o-${o}`, estimateId: "e1", option: o, label, note: null, subtotal, lineCount,
});

function estimate(over: Partial<Record<string, unknown>> = {}): IssuedEstimateWithLines {
  return {
    id: "e1", number: "2026-1021", revision: 1, status: "draft", token: "t".repeat(64),
    customerName: "Adnan Mehmedovic", customerEmail: null, customerPhone: null,
    serviceAddress: "2 Ingram Blvd, La Vergne, TN, 37086", title: "Panel work", scopeText: null, includedText: null,
    validDays: 30, workSubtotal: 1610.69, tripCharge: 0, tripWaived: true, total: 1610.69,
    createdAt: new Date("2026-08-20T21:47:00Z"), signedAt: null, signerName: null, signatureImage: null,
    selectedOptions: [], supersededBy: null,
    lines: [line("A", "ACAR diagnostic", 467.83), line("B", "Exterior pathway light", 792.14, 6), line("C", "Flood light removal", 350.72)],
    options: [option("A", 467.83, 1, "Diagnostic"), option("B", 792.14, 1, "Pathway lights"), option("C", 350.72, 1, null)],
    financingPlansJson: snapshot(),
    ...over,
  } as unknown as IssuedEstimateWithLines;
}

/** `var <name> = <json>;` as the page script was handed it. */
function embedded<T>(html: string, name: string): T {
  const m = html.match(new RegExp(`var ${name} = (.*);\\r?\\n`));
  if (!m) throw new Error(`page has no "var ${name}"`);
  return JSON.parse(m[1]) as T;
}

const PAGE_TOTAL = 1610.69; // A + B + C, no trip, no discount, no combination saving on the fixture's lines
const totalOnPage = (html: string) => Number(/id="grandTotal">\$([0-9.]+)</.exec(html)?.[1]);

// ─── shared/financingDisplay.ts: the words and the lookups ────────────────────────────────────

describe("shared/financingDisplay - what a plan card says", () => {
  // The REAL rates (Settings defaults) for every figure we assert; SECRET_RATES only where a leak is hunted.
  const fin = buildQuoteFinancing(DEFAULT_FINANCING_PLANS, { A: 9000, "A+B": 8643 })!;

  it("uses Synchrony's own label for the monthly figure of each plan type", () => {
    expect(monthlyLabel("reduced_apr")).toBe("Fixed monthly payment");
    expect(monthlyLabel("deferred_interest")).toBe("Suggested equal monthly payment");
  });

  it("states the APR and payoff months for a reduced plan, the promo length for a deferred one", () => {
    const by = (n: string) => fin.plans.find((p) => p.planNumber === n)!;
    expect(termLine(by("965"))).toBe("11.99% APR · 86 months");
    expect(termLine(by("964"))).toBe("10.99% APR · 82 months");
    expect(termLine(by("920"))).toBe("6 month promotion");
    expect(termLine(by("924"))).toBe("18 month promotion");
    expect(planTitle(by("965"))).toBe("Plan 965 — 11.99% APR until paid in full");
  });

  it("the headline is whole dollars, the lowest monthly, and wording lives here once", () => {
    // $9,000: 965 and 964 are both $109 (1.75% of the financed amount rounded up); 965 is listed first.
    const sel = selectionFinancing(fin, ["A"])!;
    expect(sel.fromMonthly).toBe(109);
    expect(sel.fromPlanNumber).toBe("965");
    expect(fromLine(sel)).toBe("or from $109/mo with financing");
    expect(wholeDollars(175)).toBe("$175");
  });

  it("the figures on a card are exactly the calculator's, nothing re-derived (the $175-not-$176 pin is in financingEstimator.test.ts)", () => {
    const f = buildQuoteFinancing(DEFAULT_FINANCING_PLANS, { A: 10000 })!;
    const o = f.bySelection.A.offers.find((x) => x.planNumber === "965")!;
    expect(o).toEqual(financingFigures(DEFAULT_FINANCING_PLANS[0], 1_000_000));
  });

  it("a card's three labelled lines: deposit, the fee as its OWN line naming the plan, amount financed", () => {
    const rows = breakdownRows({ planNumber: "965", deposit: 3000, fee: 183, financed: 6183 });
    expect(rows).toEqual([
      { key: "deposit", label: "Deposit (one third, paid up front)", value: "$3000.00" },
      { key: "fee", label: "Financing fee — Plan 965", value: "$183.00" },
      { key: "financed", label: "Amount financed", value: "$6183.00" },
    ]);
  });

  it("offers for a selection come in Settings order, each plan joined to its own figures and disclosure", () => {
    const got = financingOffersFor(fin, ["A"])!;
    expect(got.offers.map((o) => o.planNumber)).toEqual(["965", "964", "920", "924"]);
    for (const o of got.offers) {
      const plan = DEFAULT_FINANCING_PLANS.find((p) => p.planNumber === o.planNumber)!;
      expect(o.disclosure).toEqual(plan.disclosure);
      expect(o.monthly).toBe(financingFigures(plan, 900_000).monthly);
    }
  });

  it("nothing ticked, an unpriced selection, or no financing at all gives null - never $0/mo", () => {
    expect(financingOffersFor(fin, [])).toBeNull();
    expect(financingOffersFor(fin, ["B"])).toBeNull(); // not in the table
    expect(financingOffersFor(null, ["A"])).toBeNull();
    expect(financingOffersFor(undefined, ["A"])).toBeNull();
  });

  it("cheapestSelection picks the lowest headline among alternatives (Estimate Intake, one-or-the-other)", () => {
    const f = buildQuoteFinancing(DEFAULT_FINANCING_PLANS, { A: 9000, B: 3000 })!;
    expect(cheapestSelection(f, [["A"], ["B"]])!.key).toBe("B");
    expect(cheapestSelection(f, [["C"]])).toBeNull();
  });

  it("the rendered strings never carry a rate: the types hold none and the output names none", () => {
    const text = JSON.stringify(fin) + monthlyLabel("reduced_apr") + breakdownRows({ planNumber: "965", deposit: 1, fee: 1, financed: 1 }).map((r) => r.label).join();
    expect(text).not.toMatch(/discountRate|discount rate/i);
    for (const v of SECRET_RATES) expect(text).not.toContain(String(v));
  });
});

// ─── the customer's page ───────────────────────────────────────────────────────────────────────

describe("/e/:token - the plan cards", () => {
  const html = renderEstimatePage(estimate());
  const total = totalOnPage(html);

  it("sanity: the fixture's page total is what the figures below are worked from", () => {
    expect(total).toBe(PAGE_TOTAL);
  });

  it("shows 'or from $X/mo with financing' under the total, with the lowest monthly of the four plans", () => {
    const expected = Math.min(...plans().map((p) => financingFigures(p, Math.round(total * 100)).monthly));
    expect(html).toContain('id="finBlock"');
    expect(html).toContain(`>${escapeHtml(fromLine({ fromMonthly: expected }))}</summary>`);
    // Under the totals, not above them.
    expect(html.indexOf('id="grandTotal"')).toBeLessThan(html.indexOf('id="finBlock"'));
  });

  it("has the four plan cards in Kyle's order: 965, 964, 920, 924", () => {
    const at = ["965", "964", "920", "924"].map((n) => html.indexOf(`data-plan="${n}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html.match(/class="fincard"/g)).toHaveLength(4);
  });

  it("prints Synchrony's own label for the monthly payment: Fixed on 964/965, Suggested equal on 920/924", () => {
    expect(html.split("<span>Fixed monthly payment</span>").length - 1).toBe(2);
    expect(html.split("<span>Suggested equal monthly payment</span>").length - 1).toBe(2);
  });

  it("each card's figures are the shared calculator's over the page's own total (first look, scripts off)", () => {
    for (const p of plans()) {
      const f = financingFigures(p, Math.round(total * 100));
      const card = html.slice(html.indexOf(`data-plan="${p.planNumber}"`), html.indexOf("</details>", html.indexOf(`data-plan="${p.planNumber}"`)));
      expect(card).toContain(`data-fin="monthly">${wholeDollars(f.monthly)}/mo<`);
      expect(card).toContain(`data-fin="deposit">$${f.deposit.toFixed(2)}<`);
      expect(card).toContain(`data-fin="fee">$${f.fee.toFixed(2)}<`);
      expect(card).toContain(`data-fin="financed">$${f.financed.toFixed(2)}<`);
      expect(card).toContain(`Financing fee — Plan ${p.planNumber}`);
      expect(card).toContain("Deposit (one third, paid up front)");
      expect(card).toContain("Amount financed");
      expect(card).toContain(escapeHtml(termLine(p)));
    }
  });

  it("carries EACH plan's Synchrony disclosure verbatim and whole, inside that plan's card", () => {
    for (const p of plans()) {
      const start = html.indexOf(`data-plan="${p.planNumber}"`);
      const next = html.indexOf('class="fincard"', start + 10);
      const card = html.slice(start, next === -1 ? undefined : next);
      expect(card).toContain(escapeHtml(p.disclosure.explanation));
      expect(card).toContain(escapeHtml(p.disclosure.important));
      expect(card).toContain(escapeHtml(p.disclosure.terms));
    }
    // And the plan-specific parts really differ (so the check above is not vacuous).
    expect(html).toContain("Fixed monthly payments required for 86 months");
    expect(html).toContain("Fixed monthly payments required for 82 months");
    expect(html).toContain("No Interest if Paid in Full within 6 Months");
    expect(html).toContain("No Interest if Paid in Full within 18 Months");
  });

  it("never shows Synchrony's discount rate (name or value) and never 'total payments with interest'", () => {
    expect(html).not.toMatch(/discountRate|discount rate|paymentFactor|financingPlans/i);
    for (const v of SECRET_RATES) expect(html).not.toContain(String(v));
    expect(html).not.toMatch(/total payments? with interest/i);
  });

  it("the repaint script only swaps text: reads the precomputed table, no Math, no multiplication, no rate", () => {
    const script = html.slice(html.indexOf("var financing = "), html.indexOf("</script>", html.indexOf("var financing = ")));
    expect(script).toContain("financing.bySelection[picked]");
    expect(script).toContain("textContent");
    expect(script).not.toMatch(/Math\./);
    expect(script).not.toMatch(/[*]|parseFloat|\bparseInt\b/);
    expect(script).not.toMatch(/discountRate|paymentFactor/);
    // The embedded table has finished dollar figures only.
    const fin = embedded<{ plans: Array<Record<string, unknown>>; bySelection: Record<string, { offers: Array<Record<string, unknown>> }> }>(html, "financing");
    expect(Object.keys(fin.bySelection["A+B+C"].offers[0]).sort()).toEqual(["deposit", "fee", "financed", "monthly", "planNumber"]);
    expect(Object.keys(fin.plans[0]).sort()).toEqual(["apr", "description", "disclosure", "months", "planNumber", "type"]);
  });

  it("the block is a <details>, so it opens with scripts off, and it does not print", () => {
    expect(html).toContain('<details class="fin" id="finBlock"');
    expect(html).toMatch(/\.printbar,\.sign,\.fin\{display:none !important;\}/);
  });

  it("nothing on the page records or asks for a plan choice", () => {
    expect(html).not.toMatch(/name="plan|planChoice|choose (a|your) plan|select (a|your) plan/i);
  });
});

describe("/e/:token - when there is no financing block", () => {
  it("a signed estimate shows none (the screen offers what can still be acted on)", () => {
    const html = renderEstimatePage(estimate({ signedAt: new Date("2026-08-21T10:00:00Z"), signerName: "A M", selectedOptions: ["A", "C"] }));
    expect(html).not.toContain('id="finBlock"');
    expect(html).not.toContain("Synchrony");
    expect(html).toContain("Accepted &amp; signed"); // paired: the page itself rendered
  });

  it("the in-person signing page shows none: its iframe cannot run the script that follows the ticks", () => {
    const email = renderEstimatePage(estimate());
    const inPerson = renderEstimatePage(estimate(), { channel: "in_person" });
    expect(email).toContain('id="finBlock"'); // paired: the block exists on the email door
    expect(inPerson).not.toContain('id="finBlock"');
    expect(inPerson).not.toContain("Synchrony");
    expect(inPerson).not.toContain("var financing");
  });

  it("a closed (lost) estimate shows none", () => {
    const html = renderEstimatePage(estimate({ status: "lost" }));
    expect(html).not.toContain('id="finBlock"');
    expect(html).toContain("This estimate has been closed");
  });

  it("an estimate with no frozen plans (issued before they existed, or none on offer) shows none", () => {
    for (const none of [null, undefined, JSON.stringify({ plans: [] })]) {
      const html = renderEstimatePage(estimate({ financingPlansJson: none }));
      expect(html).not.toContain('id="finBlock"');
      expect(html).not.toContain("var financing");
      expect(html).toContain("ESTIMATE TOTAL"); // paired: the page rendered
    }
  });

  it("inactive plans in the snapshot are left out of the cards", () => {
    const list = plans();
    list[0].active = false;
    list[3].active = false;
    const html = renderEstimatePage(estimate({ financingPlansJson: snapshot(list) }));
    expect(html.match(/class="fincard"/g)).toHaveLength(2);
    expect(html).toContain('data-plan="964"');
    expect(html).toContain('data-plan="920"');
    expect(html).not.toContain('data-plan="965"');
  });
});

describe("/e/:token - a single-option estimate", () => {
  const single = estimate({
    lines: [line("A", "ACAR diagnostic", 467.83)],
    options: [option("A", 467.83, 1, "Diagnostic")],
    total: 467.83,
    workSubtotal: 467.83,
  });

  it("still shows the cards (statically - there are no tick boxes to repaint for)", () => {
    const html = renderEstimatePage(single);
    const f = financingFigures(plans()[0], 46_783);
    expect(html).not.toContain('class="optpick"');
    expect(html).toContain('id="finBlock"');
    expect(html).toContain(`data-fin="monthly">${wholeDollars(f.monthly)}/mo<`);
    expect(html.match(/class="fincard"/g)).toHaveLength(4);
    // No repaint script is needed, so none is sent (and the rates are still nowhere).
    expect(html).not.toContain("var financing");
    for (const v of SECRET_RATES) expect(html).not.toContain(String(v));
  });
});

describe("/e/:token - home-warranty coverage", () => {
  it("finances only the homeowner's share: the headline is lower than without the claim", () => {
    const base = renderEstimatePage(estimate());
    const covered = renderEstimatePage(
      estimate({ warrantyJson: JSON.stringify({ company: "Frontdoor", claimNumber: "C-1", coveredAmount: 600 }) }),
    );
    const from = (h: string) => Number(/>or from \$(\d+)\/mo with financing</.exec(h)?.[1]);
    expect(from(covered)).toBeLessThan(from(base));
    const homeowner = Math.round((PAGE_TOTAL - 600) * 100);
    expect(from(covered)).toBe(Math.min(...plans().map((p) => financingFigures(p, homeowner).monthly)));
  });
});
