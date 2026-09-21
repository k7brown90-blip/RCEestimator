/**
 * PurchaseOrders render smoke test (Phase A, 2026-09-20 "drawers and tab
 * purpose" plan) — PurchasesCard + PoDetailPanel.
 *
 * Pins two behaviours later phases must not break:
 *  - PurchasesCard lists the open/purchased P.O.s (Kyle, 2026-09-09).
 *  - "The P.O. is the money, the receipt is proof" (Kyle, 2026-09-19):
 *    `poNeedsProof` fires the "needs proof" prompt whenever a P.O. has money
 *    and zero proof — this is the exact client-side mirror of the trap named
 *    in the drawers plan for the FIELD app (PurchaseOrderPanel.tsx:371).
 *
 * A row opens the P.O.'s DRAWER (2026-09-21 — the expand-in-place PoDetailPanel under the row
 * was the duplicate Phase 6 deleted), so the third test mounts DrawerHost beside the card and
 * proves the drawer shows the same lines and money the inline panel used to.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { PurchasesCard } from "./PurchaseOrders";
import { DrawerHost } from "./drawers/DrawerHost";
import { api } from "../lib/api";
import type { PurchaseOrderDetail, PurchaseOrderSummary } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const needsProofPo: PurchaseOrderSummary = {
  id: "po-1",
  number: "PO-2026-0001",
  purpose: "truck_stock",
  destinationType: "truck",
  truckId: "truck-1",
  truckName: "Truck 12",
  jobId: null,
  jobLabel: null,
  accountId: null,
  accountName: null,
  supplier: "Home Depot",
  status: "purchased",
  notes: null,
  openedBy: "owner",
  openedByTechnicianId: null,
  openedAt: "2026-09-18T12:00:00.000Z",
  purchasedAt: "2026-09-18T12:00:00.000Z",
  verifiedAt: null,
  closedAt: null,
  cancelledAt: null,
  sentAt: null,
  landedAt: null,
  createdAt: "2026-09-18T12:00:00.000Z",
  receiptCount: 0,
  // THE MONEY (Kyle, 2026-09-19): moneyTotal > 0 and proofCount === 0 must
  // trigger "needs proof" — the exact rule PurchaseOrderPanel.tsx:371 mirrors
  // on the field's copy of this same server payload.
  proofCount: 0,
  cardSpendCount: 1,
  cardMatched: true,
  cardTotal: 651.73,
  offCardAmount: null,
  offCardMethod: null,
  offCardNote: null,
  offCardAt: null,
  moneyTotal: 651.73,
  afterTheFact: false,
  lines: [],
};

const poDetail: PurchaseOrderDetail = {
  ...needsProofPo,
  events: [],
  receipts: [],
  cardSpends: [],
};

function mockPurchaseOrders() {
  vi.spyOn(api, "purchaseOrders").mockImplementation((params) => {
    if (params?.status === "verified") return Promise.resolve([]);
    return Promise.resolve([needsProofPo]);
  });
  vi.spyOn(api, "receiptsNeedingPo").mockResolvedValue([]);
  vi.spyOn(api, "pendingReceipts").mockResolvedValue([]);
  vi.spyOn(api, "jobs").mockResolvedValue([]);
  vi.spyOn(api, "purchaseOrder").mockResolvedValue(poDetail);
}

describe("PurchasesCard", () => {
  it("shows a needs-proof prompt in the folded summary when money exists and proofCount is 0", async () => {
    mockPurchaseOrders();
    renderWithProviders(<PurchasesCard />);

    // The summary line lives outside CollapsibleCard's body, so it is visible
    // even folded (CollapsibleCard.tsx: "whatever a card shows in its summary
    // must come from a query that lives OUTSIDE the body").
    expect(await screen.findByText(/1 needs proof/)).toBeInTheDocument();
  });

  it("lists open P.O.s and repeats the needs-proof prompt on the row once opened", async () => {
    mockPurchaseOrders();
    renderWithProviders(<PurchasesCard />);

    fireEvent.click(await screen.findByRole("button", { name: /purchases/i }));

    expect(await screen.findByText("Open and purchased (1)")).toBeInTheDocument();
    expect(screen.getByText("PO-2026-0001")).toBeInTheDocument();
    expect(screen.getByText(/\$651\.73 at Home Depot — attach the receipt/)).toBeInTheDocument();
  });

  it("opens the P.O.'s drawer on a row click and the drawer shows its lines and money", async () => {
    mockPurchaseOrders();
    vi.spyOn(api, "landingDefaults").mockRejectedValue(new Error("not in this test"));
    renderWithProviders(<><PurchasesCard /><DrawerHost /></>);

    fireEvent.click(await screen.findByRole("button", { name: /purchases/i }));
    const row = await screen.findByText("PO-2026-0001");
    fireEvent.click(row);

    await waitFor(() => expect(api.purchaseOrder).toHaveBeenCalledWith("po-1"));
    const dialog = await screen.findByRole("dialog", { name: "PO-2026-0001" });
    expect(dialog).toBeInTheDocument();
    expect(await screen.findByText("Lines (0)")).toBeInTheDocument();
    expect(screen.getByText(/Money — \$651\.73/)).toBeInTheDocument();
    // Nothing expanded in place under the row: the panel renders once, in the drawer.
    expect(screen.getAllByText("Lines (0)")).toHaveLength(1);
  });

  it("does not prompt for proof once the receipt has landed (proofCount > 0)", async () => {
    vi.spyOn(api, "purchaseOrders").mockImplementation((params) => {
      if (params?.status === "verified") return Promise.resolve([]);
      return Promise.resolve([{ ...needsProofPo, proofCount: 1, receiptCount: 1 }]);
    });
    vi.spyOn(api, "receiptsNeedingPo").mockResolvedValue([]);
    vi.spyOn(api, "pendingReceipts").mockResolvedValue([]);

    renderWithProviders(<PurchasesCard />);

    await screen.findByText(/1 to land/);
    expect(screen.queryByText(/needs proof/)).not.toBeInTheDocument();
  });
});
