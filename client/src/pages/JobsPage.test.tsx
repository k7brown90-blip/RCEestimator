/**
 * JobsPage render smoke test (Phase A, 2026-09-20 "drawers and tab purpose"
 * plan). Pins the active-jobs list and the "Needs next step" queue (Phase 4,
 * reused by the drawers plan's per-tab attention strips) rendering together.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { renderWithProviders } from "../test/renderWithProviders";
import { JobsPage } from "./JobsPage";
import { api, type AwaitingDepositJob } from "../lib/api";
import type { JobSummary } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const job: JobSummary = {
  visitId: "visit-1",
  visitDate: "2026-09-10T12:00:00.000Z",
  mode: "service_diagnostic",
  status: "in_progress",
  jobType: "Panel upgrade",
  technicians: [],
  property: { id: "prop-1", name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN" },
  customer: { id: "cust-1", name: "Jane Homeowner" },
  estimate: { id: "est-1", title: "Panel upgrade", status: "accepted", revision: 1, totalCost: 4200, hasAcceptance: true },
  costs: {
    estimatedCost: 4200,
    materialCost: 800,
    laborHours: 6,
    laborRate: 65,
    laborCost: 390,
    overhead: 100,
    totalCost: 1290,
    revenue: 4200,
    grossProfit: 2910,
    margin: 69,
  } as JobSummary["costs"],
};

function LocationProbe() {
  const { search } = useLocation();
  return <p data-testid="search">{search}</p>;
}

const unpaid: AwaitingDepositJob = {
  visitId: "visit-unpaid",
  customerId: "cust-3",
  customerName: "Pat Unpaid",
  propertyId: "prop-3",
  address: "7 Elm St, Smyrna, TN",
  jobType: "Service upgrade",
  purpose: null,
  estimateNumber: "0000-TEST3",
};

describe("JobsPage", () => {
  it("carries the labelled Signed — awaiting deposit section, whose Take payment opens the job drawer; the Jobs list itself is unchanged (Kyle, 2026-11-27)", async () => {
    vi.spyOn(api, "jobs").mockResolvedValue([job]);
    vi.spyOn(api, "properties").mockResolvedValue([]);
    vi.spyOn(api, "needsNextStep").mockResolvedValue([]);
    vi.spyOn(api, "awaitingDeposit").mockResolvedValue([unpaid]);

    renderWithProviders(<><JobsPage /><LocationProbe /></>);

    expect(await screen.findByRole("heading", { name: "Signed — awaiting deposit (1)" })).toBeInTheDocument();
    expect(screen.getByText("Pat Unpaid")).toBeInTheDocument();
    // Not a job card: the Jobs list holds only what was already on it.
    expect(screen.getByText("12 Main St — Jane Homeowner")).toBeInTheDocument();
    expect(screen.queryByText(/Pat Unpaid —/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Take payment" }));
    expect(screen.getByTestId("search")).toHaveTextContent("job=visit-unpaid");
  });

  it("hides the section when nothing is waiting on a deposit", async () => {
    vi.spyOn(api, "jobs").mockResolvedValue([job]);
    vi.spyOn(api, "properties").mockResolvedValue([]);
    vi.spyOn(api, "needsNextStep").mockResolvedValue([]);
    const spy = vi.spyOn(api, "awaitingDeposit").mockResolvedValue([]);

    renderWithProviders(<JobsPage />);

    await screen.findByText("12 Main St — Jane Homeowner");
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByText(/Signed — awaiting deposit/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Take payment" })).not.toBeInTheDocument();
  });

  it("the empty state points at the awaiting-deposit section only when it has rows", async () => {
    vi.spyOn(api, "jobs").mockResolvedValue([]);
    vi.spyOn(api, "properties").mockResolvedValue([]);
    vi.spyOn(api, "needsNextStep").mockResolvedValue([]);
    vi.spyOn(api, "awaitingDeposit").mockResolvedValue([unpaid]);

    renderWithProviders(<JobsPage />);

    expect(await screen.findByText("No active jobs. A job appears here once its estimate is signed and the deposit is paid. Signed jobs still waiting on a deposit are listed above.")).toBeInTheDocument();
  });

  it("renders the active jobs list and the needs-next-step queue", async () => {
    vi.spyOn(api, "awaitingDeposit").mockResolvedValue([]);
    vi.spyOn(api, "jobs").mockResolvedValue([job]);
    vi.spyOn(api, "properties").mockResolvedValue([]);
    vi.spyOn(api, "needsNextStep").mockResolvedValue([
      {
        visitId: "visit-2",
        customerId: "cust-2",
        customerName: "Bob Closed",
        propertyId: "prop-2",
        address: "5 Oak Ln",
        jobType: "Service call",
        purpose: null,
        completedAt: "2026-09-16T12:00:00.000Z",
      },
    ]);

    renderWithProviders(<JobsPage />);

    expect(screen.getByText("Jobs")).toBeInTheDocument();
    expect(await screen.findByText("12 Main St — Jane Homeowner")).toBeInTheDocument();
    expect(screen.getByText(/Needs next step — 1 closed job waiting on you/)).toBeInTheDocument();
    expect(screen.getByText(/Bob Closed — Service call/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mark complete/i })).toBeInTheDocument();
  });

  it("shows the empty state when there are no active jobs", async () => {
    vi.spyOn(api, "awaitingDeposit").mockResolvedValue([]);
    vi.spyOn(api, "jobs").mockResolvedValue([]);
    vi.spyOn(api, "properties").mockResolvedValue([]);
    vi.spyOn(api, "needsNextStep").mockResolvedValue([]);

    renderWithProviders(<JobsPage />);

    expect(await screen.findByText(/No active jobs/)).toBeInTheDocument();
    // Nothing is waiting on a deposit, so the empty state does not point at a section that is not there.
    expect(screen.queryByText(/still waiting on a deposit/)).not.toBeInTheDocument();
  });
});
