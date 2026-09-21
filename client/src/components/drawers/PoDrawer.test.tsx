/**
 * The P.O. drawer re-hosts PoDetailPanel: the same lines / money / receipts / trail, and each
 * receipt row now opens the receipt's own drawer (an echo list made clickable).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useLocation } from "react-router-dom";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../test/renderWithProviders";
import { DrawerHost } from "./DrawerHost";
import { api } from "../../lib/api";
import type { PurchaseOrderDetail } from "../../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function LocationProbe() {
  const { search } = useLocation();
  return <p data-testid="location">{search}</p>;
}

const detail: PurchaseOrderDetail = {
  id: "po-1", number: "PO-2026-0001", purpose: "truck_stock", destinationType: "truck", truckId: "truck-1", truckName: "Truck 12",
  jobId: "visit-9", jobLabel: "Panel upgrade — 12 Main St", accountId: "acct-1", accountName: "Jane Homeowner", supplier: "Home Depot",
  status: "purchased", notes: null, openedBy: "owner", openedByTechnicianId: null, openedAt: "2026-09-18T12:00:00.000Z",
  purchasedAt: "2026-09-18T12:00:00.000Z", verifiedAt: null, closedAt: null, cancelledAt: null, sentAt: null, landedAt: null,
  createdAt: "2026-09-18T12:00:00.000Z", receiptCount: 1, proofCount: 1, cardSpendCount: 1, cardMatched: true, cardTotal: 651.73,
  offCardAmount: null, offCardMethod: null, offCardNote: null, offCardAt: null, moneyTotal: 651.73, afterTheFact: false,
  lines: [{ id: "line-1", name: "12-2 Romex 250ft", qty: 2, unit: "roll", partNumber: null, unitCost: null, qtyLanded: null, landedAt: null, sortOrder: 0 } as PurchaseOrderDetail["lines"][number]],
  events: [{ id: "ev-1", at: "2026-09-18T12:00:00.000Z", actor: "owner", kind: "created", reason: null, before: null, after: null }],
  receipts: [{ id: "rcpt-1", jobId: "visit-9", vendor: "Home Depot", category: "materials", amount: 651.73, status: "confirmed", source: "tech_pwa", receivedAt: "2026-09-18T12:00:00.000Z", hasImage: true }],
  cardSpends: [{ id: "cs-1", merchantName: "THE HOME DEPOT #0731", amount: 651.73, kind: "materials", status: "unmatched", occurredAt: "2026-09-18T12:00:00.000Z", ignoredReason: null, note: null }],
};

describe("PoDrawer", () => {
  it("shows the P.O.'s lines, money, receipts and trail, with doors to its job and account", async () => {
    vi.spyOn(api, "purchaseOrder").mockResolvedValue(detail);
    vi.spyOn(api, "receiptsNeedingPo").mockResolvedValue([]);
    // The landing panel's read is not under test; a rejected read renders its own error line.
    vi.spyOn(api, "landingDefaults").mockRejectedValue(new Error("not in this test"));

    renderWithProviders(<><DrawerHost /><LocationProbe /></>, { route: "/trucks?po=po-1" });

    expect(await screen.findByRole("dialog", { name: "PO-2026-0001" })).toBeInTheDocument();
    expect(await screen.findByText("Lines (1)")).toBeInTheDocument();
    expect(screen.getByText(/12-2 Romex 250ft/)).toBeInTheDocument();
    expect(screen.getByText(/Money — \$651\.73/)).toBeInTheDocument();
    expect(screen.getByText("Receipts (1)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Job: Panel upgrade/ })).toBeInTheDocument();
    // Two doors to the account: the drawer's own and PoHeader's "opened on" link — both the same place.
    for (const link of screen.getAllByRole("link", { name: /Jane Homeowner/ })) {
      expect(link).toHaveAttribute("href", "/accounts/acct-1");
    }
    expect(screen.getByText("Verify")).toBeInTheDocument();
  });

  it("opens the receipt's own drawer from a receipt row, stacked on the P.O.", async () => {
    vi.spyOn(api, "purchaseOrder").mockResolvedValue(detail);
    vi.spyOn(api, "receiptsNeedingPo").mockResolvedValue([]);
    vi.spyOn(api, "landingDefaults").mockRejectedValue(new Error("not in this test"));
    vi.spyOn(api, "receipt").mockResolvedValue({
      id: "rcpt-1", jobId: "visit-9", vendor: "Home Depot", category: "materials", amount: 651.73, source: "tech_pwa",
      receivedAt: "2026-09-18T12:00:00.000Z", accountId: "acct-1", accountName: "Jane Homeowner", jobLabel: "Panel upgrade — 12 Main St",
      purchaseOrderId: "po-1", purchaseOrderNumber: "PO-2026-0001", needsPo: false, status: "confirmed", technicianId: null,
      createdAt: "2026-09-18T12:00:00.000Z", hasImage: false, imageMime: null, lineItems: [], purchaseOrderStatus: "purchased",
      poWaivedAt: null, poWaivedReason: null, reconciliationNote: null,
    });

    renderWithProviders(<><DrawerHost /><LocationProbe /></>, { route: "/trucks?po=po-1" });
    await screen.findByText("Receipts (1)");
    fireEvent.click(screen.getByRole("button", { name: /Home Depot · \$651\.73/ }));

    await waitFor(() => expect(api.receipt).toHaveBeenCalledWith("rcpt-1"));
    expect(screen.getByTestId("location")).toHaveTextContent("?po=po-1&receipt=rcpt-1");
    expect(await screen.findAllByRole("dialog")).toHaveLength(2);
  });
});
