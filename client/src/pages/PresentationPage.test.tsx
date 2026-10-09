/**
 * The Presentation page shows the SERVER's price for what is ticked — it adds nothing up itself
 * (2026-10-08, one-estimating-system plan, Phase 3 unit A: one presentation math).
 *
 * Kyle, 2026-08-19: "On the presentation screen all options will be presented, each with a check
 * box. Once checked it will add the total for all options selected and count as a single job." The
 * adding is the server's now: the compute payload carries `money.selections` (shared/quoteMoney.ts,
 * the same table the field's quote payload and the customer's page use) and this screen looks the
 * tick up.
 *
 * HOW THIS PROVES IT: every figure in the fixture's `money` table is deliberately NOT what the
 * option subtotals, the trip and the programme add up to. If the page did its own arithmetic it
 * would print the arithmetic; it prints the table.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "../test/renderWithProviders";
import { PresentationPage } from "./PresentationPage";
import { api } from "../lib/api";
import type { PbComputeResponse } from "../lib/types";
import type { QuoteMoney, SelectionPrice } from "../../../shared/quoteMoney";
import { buildQuoteFinancing, type FinancingPlan } from "../../../shared/financing";
import { DEFAULT_FINANCING_PLANS } from "../../../src/services/financingPlanDefaults";

beforeEach(() => {
  // The sticky bar measures itself; jsdom has no ResizeObserver.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const price = (key: string, over: Partial<SelectionPrice>): SelectionPrice => ({
  key, options: key.split("+") as SelectionPrice["options"], subtotal: 0, trip: 0, comboSaving: 0, base: 0, discount: 0, discountCapped: false, total: 0, ...over,
});

/** Totals that are NOT the sum of anything on screen: the page cannot get them by adding. */
const MONEY: QuoteMoney = {
  exclusiveOptions: false,
  range: null,
  discount: { type: "military", percent: 5, label: "Military discount (5%)", terms: "5% off, capped at $250", rows: [], pricedOnceComplete: false },
  discountedTotal: 999.99,
  discountedRange: null,
  pickable: ["A", "B"],
  selections: {
    A: price("A", { subtotal: 700, trip: 200, base: 900, discount: 0, total: 721.11 }),
    B: price("B", { subtotal: 350, trip: 200, base: 550, total: 333.33 }),
    "A+B": price("A+B", { subtotal: 1050, trip: 200, comboSaving: 12.34, base: 1237.66, discount: 5.55, total: 999.99 }),
  },
};

function response(money: QuoteMoney): PbComputeResponse {
  const line = (option: "A" | "B", itemId: string, description: string) => ({
    id: itemId, option, itemId, description, quantity: 2, unit: "ea", laborHours: 3.5, laborDollars: 350,
    materialSell: 350, materialCost: 120, gaps: [], complete: true,
  });
  return {
    discount: { type: "military", rate: 0.05, cap: 250, percent: 5 },
    computed: {
      billedLaborRate: 100,
      jobFixedCost: 200,
      lines: [line("A", "a1", "Ceiling fan install"), line("B", "b1", "Bond the water line")],
      combinationDiscounts: {},
    } as never,
    options: [
      { option: "A", lineCount: 1, laborHours: 3.5, laborDollars: 350, materialSell: 350, subtotal: 700, complete: true },
      { option: "B", lineCount: 1, laborHours: 3.5, laborDollars: 0, materialSell: 350, subtotal: 350, complete: true },
      { option: "C", lineCount: 0, laborHours: 0, laborDollars: 0, materialSell: 0, subtotal: 0, complete: false },
    ],
    money,
  };
}

function show(money: QuoteMoney) {
  vi.spyOn(api, "pbCompute").mockResolvedValue(response(money));
  // The page must NOT need the separate one-or-the-other fetch any more: it reads money.exclusiveOptions.
  const mode = vi.spyOn(api, "pbOptionsMode").mockResolvedValue({ exclusiveOptions: false });
  renderWithProviders(
    <Routes><Route path="/present/:draftId" element={<PresentationPage />} /></Routes>,
    { route: "/present/draft-1?account=acct-1&address=addr-1" },
  );
  return { mode };
}

describe("PresentationPage — Customer view, the total comes from the server's table", () => {
  it("opens on everything ticked and prints the server's A+B total, saving and discount (not its own sum)", async () => {
    const { mode } = show(MONEY);
    expect(await screen.findByText("$999.99")).toBeTruthy();
    // 700 + 350 + 200 trip is $1250.00 — the page must not be the one to say so.
    expect(screen.queryByText("$1250.00")).toBeNull();
    expect(screen.getByText(/multi-option discount/i).textContent).toContain("$12.34");
    expect(screen.getByText(/Military discount \(5%\)/).textContent).toContain("$5.55");
    expect(screen.getByText(/includes \$200\.00 fixed/)).toBeTruthy();
    expect(mode).not.toHaveBeenCalled();
  });

  it("unticking an option looks the smaller combination up", async () => {
    show(MONEY);
    await screen.findByText("$999.99");
    fireEvent.click(screen.getByRole("checkbox", { name: /Option B/ }));
    expect(await screen.findByText("$721.11")).toBeTruthy();
    expect(screen.queryByText("$999.99")).toBeNull();
    // A alone has no combined-options saving and no discount in the table: neither line shows.
    expect(screen.queryByText(/multi-option discount/i)).toBeNull();
    expect(screen.queryByText(/Military discount/)).toBeNull();
  });

  it("unticking the LAST option shows \"Nothing selected\" and no total - the same tap as the phone (shared toggleSelection), never a silent re-tick of everything", async () => {
    show(MONEY);
    await screen.findByText("$999.99");
    fireEvent.click(screen.getByRole("checkbox", { name: /Option B/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Option A/ }));
    expect(await screen.findByText("Nothing selected")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Option A/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: /Option B/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText("$999.99")).toBeNull();
    // Nothing ticked is nothing to sign: greyed WITH the reason before the press.
    expect((screen.getByRole("button", { name: "Sign now" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Tick at least one option/)).toBeTruthy();
    // Ticking one again brings its own price back.
    fireEvent.click(screen.getByRole("checkbox", { name: /Option A/ }));
    expect(await screen.findByText("$721.11")).toBeTruthy();
  });

  it("each option's header price is the server's table figure, not the compute payload's own subtotal", async () => {
    show({ ...MONEY, selections: { ...MONEY.selections, A: price("A", { subtotal: 701.01, trip: 200, base: 901.01, total: 721.11 }) } });
    await screen.findByText("$999.99");
    expect(screen.getByText("$701.01")).toBeTruthy();
    expect(screen.queryByText("$700.00")).toBeNull();
  });

  it("a tick the server could not price (an unpriced option) shows a dash, never a made-up number", async () => {
    const { "A+B": _both, ...withoutBoth } = MONEY.selections;
    show({ ...MONEY, selections: withoutBoth });
    await waitFor(() => expect(screen.getByText("Total")).toBeTruthy());
    expect(screen.queryByText("$999.99")).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("one-or-the-other: radio buttons, starts on the FIRST option, and picking B shows B's own total", async () => {
    show({ ...MONEY, exclusiveOptions: true });
    expect(await screen.findByText("$721.11")).toBeTruthy();
    expect(screen.getByText(/customer picks exactly ONE/i)).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    fireEvent.click(screen.getByRole("radio", { name: /Option B/ }));
    expect(await screen.findByText("$333.33")).toBeTruthy();
  });

  it("the customer view carries no hours or cost; the Company view (CRM only) still does", async () => {
    show(MONEY);
    await screen.findByText("$999.99");
    expect(document.body.textContent).not.toMatch(/3\.50 hr/);
    expect(document.body.textContent).not.toMatch(/cost \$120/);
    fireEvent.click(screen.getByRole("button", { name: "Company view" }));
    expect(await screen.findByText(/Material list/)).toBeTruthy();
    expect(document.body.textContent).toMatch(/3\.50 hr/);
  });
});

/*
  Phase 5 unit B (2026-10-08): "or from $X/mo with financing" under the total. The page LOOKS UP the
  ticked selection in the server's `money.financing`; the deposit, fee, financed and monthly figures
  below come from the one shared calculator run over the SAME totals the table above carries, so
  the headline is the real lowest monthly of the four plans, not a number the page made up.
*/
describe("PresentationPage - financing under the total", () => {
  const FIN = buildQuoteFinancing(DEFAULT_FINANCING_PLANS as FinancingPlan[], { A: 721.11, B: 333.33, "A+B": 999.99 })!;
  const withFin = (over: Partial<QuoteMoney> = {}): QuoteMoney => ({ ...MONEY, financing: FIN, ...over });
  const fromOf = (key: string) => `or from $${FIN.bySelection[key].fromMonthly}/mo with financing`;

  it("shows the headline for what is ticked and re-reads it when a box is unticked", async () => {
    show(withFin());
    await screen.findByText("$999.99");
    expect(screen.getByRole("button", { name: fromOf("A+B") })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Option B/ }));
    expect(await screen.findByRole("button", { name: fromOf("A") })).toBeTruthy();
    expect(screen.queryByRole("button", { name: fromOf("A+B") })).toBeNull();
  });

  it("opens the plan cards with each disclosure, and the rates are nowhere on the page", async () => {
    show(withFin());
    await screen.findByText("$999.99");
    fireEvent.click(screen.getByRole("button", { name: fromOf("A+B") }));
    const dialog = await screen.findByRole("dialog", { name: "Financing options" });
    expect(within(dialog).getAllByRole("region").map((c) => c.getAttribute("aria-label"))).toEqual(["Plan 965", "Plan 964", "Plan 920", "Plan 924"]);
    for (const p of DEFAULT_FINANCING_PLANS) expect(within(dialog).getByText(p.disclosure.terms)).toBeTruthy();
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/discount ?rate/i);
    expect(html).not.toMatch(/(?<![\d.])(6\.1|7\.25|7\.1|10\.6)(?![\d])/);
  });

  it("is absent when no plan is on offer, when nothing is ticked, and the total is untouched", async () => {
    show(MONEY); // no `financing` key at all
    await screen.findByText("$999.99");
    expect(screen.queryByRole("button", { name: /with financing/ })).toBeNull();
  });

  it("nothing ticked: no financing line (never '$0/mo')", async () => {
    show(withFin());
    await screen.findByText("$999.99");
    fireEvent.click(screen.getByRole("checkbox", { name: /Option B/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Option A/ }));
    expect(await screen.findByText("Nothing selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /with financing/ })).toBeNull();
  });

  it("records no plan choice: opening the cards calls no API beyond the one compute", async () => {
    const { mode } = show(withFin());
    await screen.findByText("$999.99");
    const issue = vi.spyOn(api, "pbIssue");
    fireEvent.click(screen.getByRole("button", { name: fromOf("A+B") }));
    await screen.findByRole("dialog");
    expect(issue).not.toHaveBeenCalled();
    expect(mode).not.toHaveBeenCalled();
  });
});
