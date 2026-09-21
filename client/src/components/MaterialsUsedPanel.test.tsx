/**
 * MaterialsUsedPanel render smoke test (Phase A, 2026-09-20 "drawers and tab
 * purpose" plan).
 *
 * Pins the behaviour later phases must not break: the panel shows the job's
 * money figure and says where it came from — THE P.O. IS THE MONEY (Kyle,
 * 2026-09-19, constants.md) — never a receipt total or the estimate's frozen
 * figure, which are display-only here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { MaterialsUsedPanel } from "./MaterialsUsedPanel";
import { api } from "../lib/api";
import type { JobMaterialsView } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const baseView: JobMaterialsView = {
  jobId: "visit-1",
  truck: { id: "truck-1", name: "Truck 12" },
  estimate: { id: "est-1", number: "EST-2026-0001", title: "Panel upgrade" },
  suggested: [],
  shortages: [],
  lines: [
    {
      movementId: "mv-1",
      kind: "consume",
      itemId: "12-2-NMB",
      name: "12-2 NM-B",
      unit: "ft",
      qty: 100,
      unitCost: 0.72,
      cost: 72,
      reason: null,
      actor: "tech:Sam",
      at: "2026-09-18T12:00:00.000Z",
      onVisitId: null,
    },
  ],
  stock: { consumed: 100, returned: 0, net: 100, movementCount: 1 },
  receipts: [],
  // THE MONEY: card charges + typed not-on-card amounts on the job's P.O.s.
  materialCost: 245.5,
  materialSource: "po",
  po: { card: 200, typed: 45.5, net: 245.5, poCount: 1 },
  estimateMaterial: 300,
};

describe("MaterialsUsedPanel", () => {
  it("shows the job's P.O. money summary, not the receipt or estimate figure", async () => {
    vi.spyOn(api, "jobMaterials").mockResolvedValue(baseView);

    renderWithProviders(<MaterialsUsedPanel visitId="visit-1" />);

    expect(await screen.findByText("Materials used")).toBeInTheDocument();
    // materialCost ($245.50), sourced from the job's P.O.s — MATERIAL_SOURCE_LABEL.po.
    expect(await screen.findByText("$245.50")).toBeInTheDocument();
    expect(screen.getByText(/from the job's P\.O\.s/)).toBeInTheDocument();
    // The estimate's frozen figure is shown as a caption, explicitly never cost.
    expect(screen.getByText(/estimate carried \$300\.00 \(an estimate, never cost\)/)).toBeInTheDocument();
    // The consumed line itself renders.
    expect(screen.getByText("12-2 NM-B")).toBeInTheDocument();
  });

  it("says no P.O. money is on the job when materialSource is none", async () => {
    vi.spyOn(api, "jobMaterials").mockResolvedValue({
      ...baseView,
      lines: [],
      stock: null,
      materialCost: 0,
      materialSource: "none",
      po: null,
      estimateMaterial: null,
    });

    renderWithProviders(<MaterialsUsedPanel visitId="visit-1" />);

    await waitFor(() => expect(api.jobMaterials).toHaveBeenCalledWith("visit-1"));
    expect(await screen.findByText(/no P\.O\. money on this job/)).toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });
});
