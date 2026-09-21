/**
 * JobCloseoutPanel render smoke test (Phase A, 2026-09-20 "drawers and tab
 * purpose" plan).
 *
 * Note for later phases: this panel reads its P.O. list through
 * `api.jobPurchaseOrders` and renders `po.items` (JobCloseoutPanel.tsx:267,
 * :281) — a DIFFERENT projection than PurchaseOrders.tsx's PoDetailPanel,
 * which reads `po.lines` from `api.purchaseOrder`. Trap 2 in the drawers plan
 * names this split explicitly. This test fixes today's `items` shape so a
 * Phase-0 rename shows up here as a failure, not a silent break.
 *
 * Phase 0 (2026-09-20): `items` was kept deliberately (not renamed to `lines`)
 * — see the plan's dispatch report — but the projection GAINED money
 * (`cardTotal`, `offCardAmount`, `moneyTotal`, `proofCount`), computed by the
 * same rule as jobCosting.ts's `poMaterialByJob`. Updated consciously here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { JobCloseoutPanel } from "./JobCloseoutPanel";
import { api } from "../lib/api";
import type { JobMaterialsView } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const materials: JobMaterialsView = {
  jobId: "visit-1",
  truck: { id: "truck-1", name: "Truck 12" },
  estimate: null,
  suggested: [],
  shortages: [],
  lines: [],
  stock: null,
  receipts: [],
  materialCost: 0,
  materialSource: "none",
  po: null,
  estimateMaterial: null,
};

describe("JobCloseoutPanel", () => {
  it("renders the close-out controls and the job's purchase orders", async () => {
    vi.spyOn(api, "jobMaterials").mockResolvedValue(materials);
    vi.spyOn(api, "jobPurchaseOrders").mockResolvedValue([
      {
        id: "po-1",
        number: "PO-2026-0007",
        supplier: "Home Depot",
        purpose: "truck_stock",
        status: "purchased",
        createdAt: "2026-09-18T12:00:00.000Z",
        cardTotal: 245.5,
        offCardAmount: null,
        moneyTotal: 245.5,
        proofCount: 0,
        items: [{ name: "12-2 NM-B", qty: 250, unit: "ft" }],
      } as never,
    ]);

    renderWithProviders(<JobCloseoutPanel visitId="visit-1" status="in_progress" />);

    expect(screen.getByText("Job close-out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mark job complete/i })).toBeInTheDocument();

    expect(await screen.findByText("PO-2026-0007")).toBeInTheDocument();
    expect(screen.getByText(/250× 12-2 NM-B/)).toBeInTheDocument();
    // The money and its proof state (Phase 0, 2026-09-20) render per P.O.
    expect(screen.getByText("$245.50")).toBeInTheDocument();
    expect(screen.getByText("needs a receipt")).toBeInTheDocument();
  });

  it("shows Reopen job instead of the completion button once the job is completed", async () => {
    vi.spyOn(api, "jobMaterials").mockResolvedValue(materials);
    vi.spyOn(api, "jobPurchaseOrders").mockResolvedValue([]);

    renderWithProviders(<JobCloseoutPanel visitId="visit-1" status="completed" />);

    expect(await screen.findByText(/lives in the Completed section/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reopen job/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mark job complete/i })).not.toBeInTheDocument();
  });
});
