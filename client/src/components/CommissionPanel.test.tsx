/**
 * "Commission on this job" (Kyle, 2026-10-08, decision 10) — the profit math shown, every term its
 * own row, and the one button that records the commission from it.
 *
 * Pinned: labor at total cost is a visible row with the employer cost % beside it; a job that lost
 * money shows the loss and a $0 commission (never negative); anything MISSING greys "Record
 * commission" WITH the reason (click-through rule 5), never computes around as $0; a recorded
 * commission is VOIDED with a reason (prompt, then confirm) — the row stays, struck through, and
 * "Record commission" comes back.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { CommissionPanel, commissionBlock } from "./CommissionPanel";
import { api, type CommissionQuote, type JobTimeView } from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

const time: JobTimeView = {
  visitId: "v1",
  technicians: [{ technicianId: "t1", name: "Mike", minutes: 240, hours: 4, rate: 20, rateSet: true, cost: 80, rateMissing: false, assigned: true }],
  sessions: [],
  totalMinutes: 240,
  totalHours: 4,
  laborCost: 80,
  anyRateMissing: false,
};

/** Kyle's worked example: $500 job, $215 material, $100 fees, $200 labor → −$15 → $0. */
const lostMoney: CommissionQuote = {
  visitId: "v1", technicianId: "t1",
  revenue: 500, materialCost: 215, materialSource: "po", fees: 100,
  feeRows: [
    { kind: "card", id: "s1", label: "Rutherford County", category: "permit", amount: 50 },
    { kind: "card", id: "s2", label: "State Inspector", category: "inspection", amount: 50 },
  ],
  feeProblems: [], financingFee: 0,
  laborRows: [
    { technicianId: "t1", name: "Mike", hours: 4, wage: 80, rateMissing: false, total: 100 },
    { technicianId: "t2", name: "Dan", hours: 4, wage: 80, rateMissing: false, total: 100 },
  ],
  laborWage: 160, employerCostPercent: 25, employerCostSet: true, laborCost: 200,
  missing: [], profit: -15, commissionableProfit: 0,
  percent: 10, percentSet: true, amount: 0,
};

function mockReads(quote: CommissionQuote) {
  vi.spyOn(api, "jobTime").mockResolvedValue(time);
  vi.spyOn(api, "jobCommissions").mockResolvedValue([]);
  vi.spyOn(api, "commissionQuote").mockResolvedValue(quote);
}

describe("commissionBlock", () => {
  it("names the reason the button is greyed, or null when it can be clicked", () => {
    expect(commissionBlock(lostMoney)).toBeNull();
    expect(commissionBlock({ ...lostMoney, percentSet: false, percent: null, amount: null })).toMatch(/No commission % is set/);
    expect(commissionBlock({ ...lostMoney, amount: null, profit: null, missing: ["employer cost % not set"] })).toMatch(/employer cost % not set/);
  });

  it("a job-profit commission already on the books greys it — once per tech per job (2026-10-09)", () => {
    expect(commissionBlock(lostMoney, [{ basis: "job_profit", amount: 48.5 }])).toMatch(/Already recorded — \$48\.50.*Void it first/);
    // A VOIDED one is not on the books — it does not block.
    expect(commissionBlock(lostMoney, [{ basis: "job_profit", amount: 48.5, voidedAt: "2026-10-10T12:00:00.000Z" }])).toBeNull();
    // A manual commission on the same job is not the job-profit share — it does not block.
    expect(commissionBlock(lostMoney, [{ basis: "manual", amount: 20 }])).toBeNull();
  });

  it("hours still pending come through as the server's missing reason", () => {
    expect(commissionBlock({ ...lostMoney, amount: null, profit: null, missing: ["Mike is still clocked in on this job — the hours are not final"] })).toMatch(/still clocked in/);
  });
});

describe("CommissionPanel", () => {
  it("shows every term as its own row — labor at total cost with the employer % — and $0 on a job that lost money", async () => {
    mockReads(lostMoney);
    renderWithProviders(<CommissionPanel visitId="v1" />);

    expect(await screen.findByText("Revenue")).toBeInTheDocument();
    expect(screen.getByText("$500.00")).toBeInTheDocument();
    expect(screen.getByText("− Material")).toBeInTheDocument();
    expect(screen.getByText("$215.00")).toBeInTheDocument();
    expect(screen.getByText("− Rutherford County")).toBeInTheDocument();
    expect(screen.getByText("− Labor: Mike, 4h")).toBeInTheDocument();
    expect(screen.getByText("− Labor: Dan, 4h")).toBeInTheDocument();
    expect(screen.getAllByText("wages $80.00 × (1 + 25%)")).toHaveLength(2);
    expect(screen.getAllByText("$100.00")).toHaveLength(2);
    expect(screen.getByText("-$15.00")).toBeInTheDocument();
    expect(screen.getByText(/the job lost money — the commission is taken on \$0, never less/)).toBeInTheDocument();
    expect(screen.getByText("10% of $0.00")).toBeInTheDocument();

    const record = vi.spyOn(api, "createCommission").mockResolvedValue({ id: "c1" });
    const button = screen.getByRole("button", { name: "Record commission" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(record).toHaveBeenCalledWith({ technicianId: "t1", visitId: "v1", basis: "job_profit" }));
  });

  it("greys 'Record commission' WITH the reason when something is missing, and shows what", async () => {
    mockReads({
      ...lostMoney,
      laborRows: [{ technicianId: "t1", name: "Mike", hours: 4, wage: 80, rateMissing: false, total: null }],
      laborWage: 80, employerCostPercent: null, employerCostSet: false, laborCost: null,
      missing: ['employer cost % not set — Settings → Payroll → "Employer cost on top of wages (%)"'],
      profit: null, commissionableProfit: null, amount: null,
    });
    renderWithProviders(<CommissionPanel visitId="v1" />);

    const button = await screen.findByRole("button", { name: "Record commission" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringMatching(/employer cost % not set/));
    expect(screen.getAllByText("employer cost % not set").length).toBeGreaterThan(0);
    expect(screen.getByText("missing")).toBeInTheDocument();
  });

  it("a card fee Stripe could not give is shown as a problem, not $0", async () => {
    mockReads({
      ...lostMoney,
      feeProblems: [{ paymentId: "p9", amount: 333.33, reason: "Stripe has not settled this payment yet — its processing fee is not known." }],
      missing: ["the card processing fee on the $333.33 card payment could not be read: Stripe has not settled this payment yet — its processing fee is not known."],
      profit: null, commissionableProfit: null, amount: null,
    });
    renderWithProviders(<CommissionPanel visitId="v1" />);
    expect(await screen.findByText("could not be read")).toBeInTheDocument();
    expect(screen.getByText("− Card processing fee on the $333.33 card payment")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record commission" })).toBeDisabled();
  });

  it("a recorded commission is listed and is voided with a reason, after a confirm", async () => {
    mockReads(lostMoney);
    vi.spyOn(api, "jobCommissions").mockResolvedValue([
      { id: "c1", technicianId: "t1", visitId: "v1", visitLabel: null, basis: "job_profit", percent: 10, amount: 0, note: null, reason: null, earnedAt: "2026-10-09T12:00:00.000Z", paidAt: null },
    ]);
    const voidIt = vi.spyOn(api, "voidCommission").mockResolvedValue({ ok: true, id: "c1" });
    vi.spyOn(window, "prompt").mockReturnValue("Entered twice");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithProviders(<CommissionPanel visitId="v1" />);

    expect(screen.queryByRole("button", { name: "Remove…" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Void…" }));
    await waitFor(() => expect(voidIt).toHaveBeenCalledWith("c1", "Entered twice"));
    expect(confirm).toHaveBeenCalled();
  });

  it("declining the confirm, or giving no reason, voids nothing", async () => {
    mockReads(lostMoney);
    vi.spyOn(api, "jobCommissions").mockResolvedValue([
      { id: "c1", technicianId: "t1", visitId: "v1", visitLabel: null, basis: "job_profit", percent: 10, amount: 0, note: null, reason: null, earnedAt: "2026-10-09T12:00:00.000Z", paidAt: null },
    ]);
    const voidIt = vi.spyOn(api, "voidCommission").mockResolvedValue({ ok: true, id: "c1" });
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("   ");
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWithProviders(<CommissionPanel visitId="v1" />);

    const button = await screen.findByRole("button", { name: "Void…" });
    fireEvent.click(button);
    prompt.mockReturnValue("Wrong job");
    fireEvent.click(button);
    expect(voidIt).not.toHaveBeenCalled();
  });

  it("a voided commission stays listed, struck through with its date and reason, has no Void… button, and 'Record commission' is enabled again", async () => {
    mockReads({ ...lostMoney, amount: 25, commissionableProfit: 250 });
    vi.spyOn(api, "jobCommissions").mockResolvedValue([
      { id: "c1", technicianId: "t1", visitId: "v1", visitLabel: null, basis: "job_profit", percent: 10, amount: 48.5, note: null, reason: null, earnedAt: "2026-10-09T12:00:00.000Z", paidAt: null,
        voidedAt: "2026-10-10T12:00:00.000Z", voidedBy: "human:crm-session", voidReason: "Entered twice" },
    ]);
    renderWithProviders(<CommissionPanel visitId="v1" />);

    expect(await screen.findByText(/Voided .* — Entered twice/)).toBeInTheDocument();
    expect(screen.getByText("$48.50")).toHaveClass("line-through");
    expect(screen.queryByRole("button", { name: "Void…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Record commission" })).toBeEnabled();
    expect(screen.queryByText(/Already recorded/)).toBeNull();
  });

  it("with a job-profit commission already recorded, 'Record commission' is greyed WITH the reason — a second press cannot double the payout", async () => {
    mockReads(lostMoney);
    vi.spyOn(api, "jobCommissions").mockResolvedValue([
      { id: "c1", technicianId: "t1", visitId: "v1", visitLabel: null, basis: "job_profit", percent: 10, amount: 48.5, note: null, reason: null, earnedAt: "2026-10-09T12:00:00.000Z", paidAt: null },
    ]);
    const record = vi.spyOn(api, "createCommission").mockResolvedValue({ id: "c2" });
    renderWithProviders(<CommissionPanel visitId="v1" />);

    const button = await screen.findByRole("button", { name: "Record commission" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringMatching(/Already recorded/));
    expect(screen.getByText(/Already recorded — \$48\.50/)).toBeInTheDocument();
    fireEvent.click(button);
    expect(record).not.toHaveBeenCalled();
    // The exit is right beside it: the recorded row's own "Void…".
    expect(screen.getByRole("button", { name: "Void…" })).toBeEnabled();
  });
});
