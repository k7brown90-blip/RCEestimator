/**
 * Settings -> "Financing plans (Synchrony)" (2026-10-08, one-estimating-system plan, Phase 5 unit A).
 *
 * The office edits Synchrony's plans here: add, edit, remove, reorder, switch off. The discount rate
 * is Red Cedar's cost and is labelled so; nothing is saved until "Save financing plans", and a server
 * refusal (a rate typed as a fraction, an active plan with no disclosure) is shown where the office
 * is looking, not swallowed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { FinancingPlansSection } from "./FinancingPlansSection";
import { api } from "../lib/api";
import type { FinancingPlan } from "../../../shared/financing";

afterEach(() => vi.restoreAllMocks());

const plans = (): FinancingPlan[] => [
  {
    planNumber: "965", type: "reduced_apr", description: "11.99% APR until paid in full", months: 86, apr: 11.99,
    paymentFactorPct: 1.75, discountRatePct: 6.1, active: true, sortOrder: 1,
    disclosure: { explanation: "EXPL 965 ", important: "IMPORTANT 965", terms: "TERMS 965  " },
  },
  {
    planNumber: "924", type: "deferred_interest", description: "No interest if paid in full within 18 months", months: 18, apr: null,
    paymentFactorPct: 2.5, discountRatePct: 10.6, active: true, sortOrder: 2,
    disclosure: { explanation: "EXPL 924", important: "IMPORTANT 924", terms: "TERMS 924" },
  },
];

function show(list = plans()) {
  vi.spyOn(api, "financingPlans").mockResolvedValue({ plans: list });
  const save = vi.spyOn(api, "saveCompanySetting").mockResolvedValue({ key: "financingPlans", value: [], updatedAt: "" });
  renderWithProviders(<FinancingPlansSection />);
  return { save };
}

const card = (i: number) => within(screen.getByTestId(`financing-plan-${i}`));

describe("FinancingPlansSection", () => {
  it("lists the plans in order and labels the discount rate as Red Cedar's cost, never shown to customers", async () => {
    show();
    expect(await screen.findByText(/Plan 965/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Financing plans (Synchrony)" })).toBeTruthy();
    expect(screen.getAllByText(/Synchrony.s charge to Red Cedar/).length).toBe(2);
    expect(screen.getAllByText(/never shown to customers/).length).toBe(2);
    expect((card(0).getByDisplayValue("6.1") as HTMLInputElement).type).toBe("number");
    // The APR box exists for a reduced-APR plan and not for a deferred-interest one.
    expect(card(0).getByDisplayValue("11.99")).toBeTruthy();
    expect(card(1).queryByText(/Customer.s APR/)).toBeNull();
    expect(card(1).getByText("Promo length (months)")).toBeTruthy();
    expect(card(0).getByText("Fixed-payment term (months)")).toBeTruthy();
  });

  it("Save is greyed WITH its reason until something changes", async () => {
    show();
    await screen.findByText(/Plan 965/);
    const saveBtn = screen.getByRole("button", { name: "Save financing plans" }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    expect(saveBtn.title).toBe("Nothing changed yet");
    fireEvent.change(card(0).getByDisplayValue("6.1"), { target: { value: "6.4" } });
    expect(saveBtn.disabled).toBe(false);
    expect(screen.getByText(/Unsaved changes/)).toBeTruthy();
  });

  it("Move down reorders, and Save sends the plans in that order with numbers parsed", async () => {
    const { save } = show();
    await screen.findByText(/Plan 965/);
    fireEvent.click(card(0).getByRole("button", { name: "Move down" }));
    fireEvent.click(screen.getByRole("button", { name: "Save financing plans" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [key, sent] = save.mock.calls[0] as [string, FinancingPlan[]];
    expect(key).toBe("financingPlans");
    expect(sent.map((p) => p.planNumber)).toEqual(["924", "965"]);
    expect(sent.map((p) => p.sortOrder)).toEqual([1, 2]);
    expect(sent[0]).toMatchObject({ type: "deferred_interest", months: 18, apr: null, paymentFactorPct: 2.5, discountRatePct: 10.6, active: true });
    expect(sent[1]).toMatchObject({ type: "reduced_apr", months: 86, apr: 11.99, discountRatePct: 6.1 });
    // The disclosure goes back exactly as it was pasted - not trimmed.
    expect(sent[1].disclosure).toEqual({ explanation: "EXPL 965 ", important: "IMPORTANT 965", terms: "TERMS 965  " });
  });

  it("the first plan cannot move up and the last cannot move down - greyed with the reason", async () => {
    show();
    await screen.findByText(/Plan 965/);
    const up = card(0).getByRole("button", { name: "Move up" }) as HTMLButtonElement;
    const down = card(1).getByRole("button", { name: "Move down" }) as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    expect(up.title).toBe("Already first");
    expect(down.disabled).toBe(true);
    expect(down.title).toBe("Already last");
  });

  it("Remove takes a plan out of the list (held until Save); Discard changes brings it back", async () => {
    const { save } = show();
    await screen.findByText(/Plan 965/);
    fireEvent.click(card(0).getByRole("button", { name: "Remove" }));
    expect(screen.queryByText(/Plan 965/)).toBeNull();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(await screen.findByText(/Plan 965/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("switching a plan off says so on the plan and saves active: false", async () => {
    const { save } = show();
    await screen.findByText(/Plan 965/);
    fireEvent.click(card(0).getByRole("checkbox", { name: /Offer to customers/ }));
    expect(card(0).getByText(/Off . customers do not see it/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save financing plans" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect((save.mock.calls[0][1] as FinancingPlan[])[0].active).toBe(false);
  });

  it("Add a plan appends a blank plan that is OFF until switched on", async () => {
    show();
    await screen.findByText(/Plan 965/);
    fireEvent.click(screen.getByRole("button", { name: "Add a plan" }));
    expect(screen.getByText("New plan")).toBeTruthy();
    expect((card(2).getByRole("checkbox", { name: /Offer to customers/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("shows the server's refusal beside the buttons and stays unsaved", async () => {
    const { save } = show();
    save.mockRejectedValueOnce(new Error("Plan 965: Discount rate is 0.061 - that looks like a fraction. Type it as a percent (for example 6.1)."));
    await screen.findByText(/Plan 965/);
    fireEvent.change(card(0).getByDisplayValue("6.1"), { target: { value: "0.061" } });
    fireEvent.click(screen.getByRole("button", { name: "Save financing plans" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("looks like a fraction");
    expect(screen.getByText(/Unsaved changes/)).toBeTruthy();
  });
});
