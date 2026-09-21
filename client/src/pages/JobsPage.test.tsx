/**
 * JobsPage render smoke test (Phase A, 2026-09-20 "drawers and tab purpose"
 * plan). Pins the active-jobs list and the "Needs next step" queue (Phase 4,
 * reused by the drawers plan's per-tab attention strips) rendering together.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { JobsPage } from "./JobsPage";
import { api } from "../lib/api";
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

describe("JobsPage", () => {
  it("renders the active jobs list and the needs-next-step queue", async () => {
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
    vi.spyOn(api, "jobs").mockResolvedValue([]);
    vi.spyOn(api, "properties").mockResolvedValue([]);
    vi.spyOn(api, "needsNextStep").mockResolvedValue([]);

    renderWithProviders(<JobsPage />);

    expect(await screen.findByText(/No active jobs/)).toBeInTheDocument();
  });
});
