/**
 * "or from $X/mo with financing" and the Synchrony plan cards it opens (Phase 5 unit B, 2026-10-08).
 *
 * The component calculates nothing: it is handed the server's finished `money.financing` and prints
 * the ticked selection's row. These tests pin what the OFFICE sees when it stands in front of the
 * customer - the headline under the total, the four cards in Kyle's order with Synchrony's own
 * labels, the fee on its own line, each plan's disclosure verbatim - and that Red Cedar's cost
 * (Synchrony's discount rate) is nowhere in the rendered output.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FinancingLine } from "./FinancingSheet";
import { buildQuoteFinancing, type FinancingPlan } from "../../../shared/financing";
import { DEFAULT_FINANCING_PLANS } from "../../../src/services/financingPlanDefaults";

const PLANS = DEFAULT_FINANCING_PLANS as FinancingPlan[];
// The real rates are 6.1 / 7.25 / 7.1 / 10.6. They are the strings the markup must never contain
// as a token (dollar amounts like 6183.00 or 217.50 do not match: no digit before, none after).
const RATE_TOKEN = /(?<![\d.])(6\.1|7\.25|7\.1|10\.6)(?![\d])/;

const FINANCING = buildQuoteFinancing(PLANS, { A: 9000, "A+B": 4500 })!;

function open(selected: string[] = ["A"]) {
  const utils = render(<FinancingLine financing={FINANCING} selected={selected} label={`Option ${selected.join(" + ")}`} total={9000} />);
  fireEvent.click(screen.getByRole("button", { name: /with financing/ }));
  return utils;
}

describe("FinancingLine", () => {
  it("is the line 'or from $109/mo with financing' - the lowest monthly of the four plans", () => {
    render(<FinancingLine financing={FINANCING} selected={["A"]} label="Option A" total={9000} />);
    expect(screen.getByRole("button", { name: "or from $109/mo with financing" })).toBeInTheDocument();
    // Closed: no card, no figure beyond the headline.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders nothing when no plan is on offer, nothing is ticked, or the selection has no figures", () => {
    const { container, rerender } = render(<FinancingLine financing={null} selected={["A"]} label="Option A" total={9000} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<FinancingLine financing={FINANCING} selected={[]} label="" total={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<FinancingLine financing={FINANCING} selected={["C"]} label="Option C" total={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<FinancingLine financing={undefined} selected={["A"]} label="Option A" total={9000} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("follows the selection: a different tick looks up a different row of the server's table", () => {
    const { rerender } = render(<FinancingLine financing={FINANCING} selected={["A"]} label="Option A" total={9000} />);
    const a = screen.getByRole("button", { name: /with financing/ }).textContent;
    rerender(<FinancingLine financing={FINANCING} selected={["B", "A"]} label="Options A + B" total={4500} />);
    expect(screen.getByRole("button", { name: /with financing/ }).textContent).not.toBe(a);
  });

  it("opens the four plan cards in Kyle's order: 965, 964, 920, 924", () => {
    open();
    const dialog = screen.getByRole("dialog", { name: "Financing options" });
    const cards = within(dialog).getAllByRole("region");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Plan 965", "Plan 964", "Plan 920", "Plan 924"]);
  });

  it("each card: Synchrony's own label for the monthly figure, the term, and deposit / fee / financed", () => {
    open();
    const by = (n: string) => screen.getByRole("region", { name: `Plan ${n}` });
    // $9,000: deposit 3000, balance 6000. Plan 965: fee 183.00, financed 6183.00, 1.75% -> $109.
    const c965 = by("965");
    expect(within(c965).getByText("Plan 965 — 11.99% APR until paid in full")).toBeInTheDocument();
    expect(within(c965).getByText("11.99% APR · 86 months")).toBeInTheDocument();
    expect(within(c965).getByText("Fixed monthly payment")).toBeInTheDocument();
    expect(within(c965).getByTestId("monthly-965").textContent).toBe("$109/mo");
    expect(within(c965).getByText("Deposit (one third, paid up front)").nextSibling?.textContent).toBe("$3000.00");
    expect(within(c965).getByText("Financing fee — Plan 965").nextSibling?.textContent).toBe("$183.00");
    expect(within(c965).getByText("Amount financed").nextSibling?.textContent).toBe("$6183.00");

    const c920 = by("920");
    expect(within(c920).getByText("Suggested equal monthly payment")).toBeInTheDocument();
    expect(within(c920).getByText("6 month promotion")).toBeInTheDocument();
    expect(within(c920).getByTestId("monthly-920").textContent).toBe("$1036/mo");
    expect(within(c920).getByText("Financing fee — Plan 920").nextSibling?.textContent).toBe("$213.00");

    expect(within(by("924")).getByTestId("monthly-924").textContent).toBe("$351/mo");
    expect(within(by("964")).getByTestId("monthly-964").textContent).toBe("$109/mo");
  });

  it("carries EACH plan's Synchrony disclosure verbatim, in full, inside that plan's card", () => {
    open();
    for (const p of PLANS) {
      const card = screen.getByRole("region", { name: `Plan ${p.planNumber}` });
      expect(within(card).getByText(p.disclosure.explanation)).toBeInTheDocument();
      expect(within(card).getByText(p.disclosure.important)).toBeInTheDocument();
      expect(within(card).getByText(p.disclosure.terms)).toBeInTheDocument();
      expect(within(card).getByText(`Synchrony's terms for Plan ${p.planNumber}`)).toBeInTheDocument();
    }
  });

  it("says nothing is chosen or recorded, and shows the selection and its total", () => {
    open();
    expect(screen.getByText(/Nothing is chosen or recorded here/)).toBeInTheDocument();
    expect(screen.getByText(/Option A · total \$9000\.00/)).toBeInTheDocument();
  });

  it("never renders Synchrony's discount rate, by name or by value, and no total-with-interest figure", () => {
    open();
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/discount ?rate/i);
    expect(html).not.toMatch(RATE_TOKEN);
    expect(html).not.toMatch(/total payments? with interest/i);
  });

  it("closes: the Close button and Escape both put the sheet away", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /with financing/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("FinancingLine - the sheet is not trapped inside the page's blurred bottom bar", () => {
  it("renders the dialog on <body>, outside the element that holds the line (review finding, 2026-10-08)", () => {
    // PresentationPage / Estimate Intake put this line in a `backdrop-blur` bar; a backdrop-filter makes
    // that bar the containing block of any inline `position: fixed` child, so an inline overlay filled
    // only the bar. jsdom cannot compute layout - what it CAN pin is that the overlay is not inside it.
    const { container } = render(
      <div className="backdrop-blur" data-testid="bar">
        <FinancingLine financing={FINANCING} selected={["A"]} label="Option A" total={9000} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /with financing/ }));
    const dialog = screen.getByRole("dialog", { name: "Financing options" });
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });
});

describe("FinancingLine - a home-warranty claim", () => {
  // $9,000 job, $3,000 covered by the warranty company: the cards are worked on the homeowner's $6,000.
  const COVERED = buildQuoteFinancing(PLANS, { A: 9000 }, 3000)!;

  it("says the coverage and the homeowner's share, so the one-third deposit is a third of the number beside it", () => {
    render(<FinancingLine financing={COVERED} selected={["A"]} label="Option A" total={9000} />);
    fireEvent.click(screen.getByRole("button", { name: /with financing/ }));
    expect(screen.getByText(/Option A · total \$9000\.00 · warranty covers \$3000\.00 · your share \$6000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Estimated monthly payments on your share shown/)).toBeInTheDocument();
    const c965 = screen.getByRole("region", { name: "Plan 965" });
    expect(within(c965).getByText("Deposit (one third, paid up front)").nextSibling?.textContent).toBe("$2000.00");
  });

  it("without a claim the header is the plain total and the note is the original sentence", () => {
    open();
    expect(screen.queryByText(/warranty covers/)).toBeNull();
    expect(screen.getByText(/Estimated monthly payments on the total shown/)).toBeInTheDocument();
  });
});
