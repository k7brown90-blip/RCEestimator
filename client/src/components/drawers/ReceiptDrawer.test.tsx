/**
 * The receipt drawer: one record, every action a receipt has today — confirm, fix what the
 * reader got wrong, attach / detach / waive its P.O., remove.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../../test/renderWithProviders";
import { DrawerHost } from "./DrawerHost";
import { api } from "../../lib/api";
import type { ReceiptRecord } from "../../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function receipt(overrides: Partial<ReceiptRecord>): ReceiptRecord {
  return {
    id: "rcpt-1", jobId: "visit-9", vendor: "Home Depot", category: "materials", amount: 120.5, source: "tech_pwa",
    receivedAt: "2026-09-18T12:00:00.000Z", accountId: "acct-1", accountName: "Jane Homeowner", jobLabel: "Panel upgrade — 12 Main St",
    purchaseOrderId: null, purchaseOrderNumber: null, needsPo: true, status: "pending_review", technicianId: null,
    createdAt: "2026-09-18T12:00:00.000Z", hasImage: false, imageMime: null, lineItems: [{ name: "12-2 Romex", qty: 1, unitCost: 120.5 }],
    purchaseOrderStatus: null, poWaivedAt: null, poWaivedReason: null, reconciliationNote: null,
    ...overrides,
  };
}

describe("ReceiptDrawer", () => {
  it("shows a pending materials receipt with no P.O.: confirm, the P.O. picker, waive, remove", async () => {
    vi.spyOn(api, "receipt").mockResolvedValue(receipt({}));
    vi.spyOn(api, "purchaseOrders").mockResolvedValue([]);
    vi.spyOn(api, "reviewReceipt").mockResolvedValue({ id: "rcpt-1", jobId: "visit-9", amount: 120.5, status: "confirmed", purchaseOrderId: null });

    renderWithProviders(<DrawerHost />, { route: "/financials?receipt=rcpt-1" });

    const dialog = await screen.findByRole("dialog", { name: "Home Depot" });
    expect(within(dialog).getByText("needs review")).toBeInTheDocument();
    expect(within(dialog).getByText("needs PO")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "No PO — legacy" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Re-parse" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remove receipt" })).toBeInTheDocument();
    expect(within(dialog).getByText(/12-2 Romex/)).toBeInTheDocument();
    expect(within(dialog).getByText("No photo or PDF on this receipt.")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.reviewReceipt).toHaveBeenCalledWith("rcpt-1", { status: "confirmed" }));
  });

  it("saves only the fields that changed", async () => {
    vi.spyOn(api, "receipt").mockResolvedValue(receipt({ status: "confirmed", purchaseOrderId: "po-1", purchaseOrderNumber: "PO-2026-0001", purchaseOrderStatus: "verified", needsPo: false }));
    vi.spyOn(api, "reviewReceipt").mockResolvedValue({ id: "rcpt-1", jobId: "visit-9", amount: 120.5, status: "confirmed", purchaseOrderId: "po-1" });

    renderWithProviders(<DrawerHost />, { route: "/financials?receipt=rcpt-1" });

    const dialog = await screen.findByRole("dialog", { name: "Home Depot" });
    const save = within(dialog).getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Vendor"), { target: { value: "Home Depot #0731" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(api.reviewReceipt).toHaveBeenCalledWith("rcpt-1", { vendor: "Home Depot #0731" }));
    // On its P.O.: the number is a door to the P.O. drawer, and detach is offered.
    expect(within(dialog).getByRole("button", { name: "PO-2026-0001" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "detach" })).toBeInTheDocument();
  });
});
