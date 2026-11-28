/**
 * Signed - awaiting deposit (Kyle, 2026-11-27: "she signed and hasn't paid so we need to see that").
 * One component, two mounts (Jobs page, Calendar rail). Pins its wording, its rows, and that its one
 * action - Take payment - opens the job's drawer (where the existing Take payment card lives).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { renderWithProviders } from "../test/renderWithProviders";
import { AwaitingDeposit } from "./AwaitingDeposit";
import { api, type AwaitingDepositJob } from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

const row: AwaitingDepositJob = {
  visitId: "job-1",
  customerId: "cust-1",
  customerName: "Pat Homeowner",
  propertyId: "prop-1",
  address: "12 Main St, Smyrna, TN",
  jobType: "Panel upgrade",
  purpose: null,
  estimateNumber: "0000-TEST1",
};

function Probe() {
  const { search } = useLocation();
  return <p data-testid="search">{search}</p>;
}

describe("AwaitingDeposit", () => {
  it("shows the heading with the count, the explanatory line, and each row's customer, address, job type, chip and Take payment", async () => {
    vi.spyOn(api, "awaitingDeposit").mockResolvedValue([row, { ...row, visitId: "job-2", customerName: "Sam Second" }]);
    renderWithProviders(<AwaitingDeposit />);

    expect(await screen.findByRole("heading", { name: "Signed — awaiting deposit (2)" })).toBeInTheDocument();
    expect(screen.getByText("Signed, deposit not in yet. Not on the schedule until it is. Financing customers pay the one-third deposit too.")).toBeInTheDocument();
    expect(screen.getByText("Pat Homeowner")).toBeInTheDocument();
    expect(screen.getAllByText("12 Main St, Smyrna, TN").length).toBe(2);
    expect(screen.getAllByText(/Panel upgrade/).length).toBe(2);
    expect(screen.getAllByText("Deposit unpaid").length).toBe(2);
    expect(screen.getAllByRole("button", { name: "Take payment" }).length).toBe(2);
  });

  it("Take payment opens the job drawer for that row (the existing Take payment card), and goes nowhere else", async () => {
    vi.spyOn(api, "awaitingDeposit").mockResolvedValue([row]);
    renderWithProviders(<><AwaitingDeposit /><Probe /></>);

    fireEvent.click(await screen.findByRole("button", { name: "Take payment" }));
    expect(screen.getByTestId("search")).toHaveTextContent("?job=job-1");
  });

  it("is hidden when nothing is waiting on a deposit", async () => {
    const spy = vi.spyOn(api, "awaitingDeposit").mockResolvedValue([]);
    renderWithProviders(<AwaitingDeposit />);

    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByText(/awaiting deposit/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Take payment" })).not.toBeInTheDocument();
  });

  it("says so when the list cannot be loaded, instead of going quiet", async () => {
    vi.spyOn(api, "awaitingDeposit").mockRejectedValue(new Error("boom"));
    renderWithProviders(<AwaitingDeposit />);

    expect(await screen.findByText(/Couldn't load the signed jobs that are waiting on a deposit/)).toBeInTheDocument();
  });
});
