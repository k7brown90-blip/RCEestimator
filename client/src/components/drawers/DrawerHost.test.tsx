/**
 * Drawer state in the URL (2026-09-20, drawers plan Phase 1 — lib/drawers.ts).
 *
 * The rule under test: a drawer does not navigate. Opening one from a list adds ONE query key
 * to the current route; closing it removes only that key; the host page's own params
 * (`?archived`, `?address`, `?year`) and its pathname are exactly as they were on both sides.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useLocation } from "react-router-dom";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../../test/renderWithProviders";
import { DrawerHost } from "./DrawerHost";
import { PurchasesCard } from "../PurchaseOrders";
import { api } from "../../lib/api";
import type { PurchaseOrderDetail, PurchaseOrderSummary, Visit } from "../../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Reads the router's current location into the DOM so a test can assert on it. */
function LocationProbe() {
  const { pathname, search } = useLocation();
  return <p data-testid="location">{pathname}{search}</p>;
}

const po: PurchaseOrderSummary = {
  id: "po-1", number: "PO-2026-0001", purpose: "truck_stock", destinationType: "truck", truckId: "truck-1", truckName: "Truck 12",
  jobId: null, jobLabel: null, accountId: null, accountName: null, supplier: "Home Depot", status: "purchased", notes: null,
  openedBy: "owner", openedByTechnicianId: null, openedAt: "2026-09-18T12:00:00.000Z", purchasedAt: "2026-09-18T12:00:00.000Z",
  verifiedAt: null, closedAt: null, cancelledAt: null, sentAt: null, landedAt: null, createdAt: "2026-09-18T12:00:00.000Z",
  receiptCount: 0, proofCount: 0, cardSpendCount: 1, cardMatched: true, cardTotal: 651.73, offCardAmount: null, offCardMethod: null,
  offCardNote: null, offCardAt: null, moneyTotal: 651.73, afterTheFact: false, lines: [],
};
const poDetail: PurchaseOrderDetail = { ...po, events: [], receipts: [], cardSpends: [] };

const visit: Visit = {
  id: "visit-1", propertyId: "prop-1", customerId: "cust-1", mode: "service_diagnostic", status: "estimate",
  visitDate: "2026-09-10T12:00:00.000Z", property: { id: "prop-1", customerId: "cust-1", name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } as Visit["property"],
  customer: { id: "cust-1", name: "Jane Homeowner" } as Visit["customer"],
};

function mockPo() {
  vi.spyOn(api, "purchaseOrder").mockResolvedValue(poDetail);
  vi.spyOn(api, "receiptsNeedingPo").mockResolvedValue([]);
}

describe("DrawerHost", () => {
  it("renders nothing when the URL names no drawer", () => {
    renderWithProviders(<><DrawerHost /><LocationProbe /></>, { route: "/jobs?archived=1" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector("[data-drawer]")).toBeNull();
  });

  it("opens the P.O. drawer from ?po= and closing it keeps the host page's own params and path", async () => {
    mockPo();
    renderWithProviders(<><DrawerHost /><LocationProbe /></>, { route: "/jobs?archived=1&address=prop-1&po=po-1" });

    await waitFor(() => expect(api.purchaseOrder).toHaveBeenCalledWith("po-1"));
    const dialog = await screen.findByRole("dialog", { name: "PO-2026-0001" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Not navigated: same path, same filters, only the drawer's own key gone.
    expect(screen.getByTestId("location")).toHaveTextContent("/jobs?archived=1&address=prop-1");
  });

  it("opens from a list row without navigating, adding only its own key to the URL", async () => {
    mockPo();
    vi.spyOn(api, "purchaseOrders").mockImplementation((params) =>
      Promise.resolve(params?.status === "verified" ? [] : [po]));
    vi.spyOn(api, "pendingReceipts").mockResolvedValue([]);
    vi.spyOn(api, "jobs").mockResolvedValue([]);

    renderWithProviders(<><PurchasesCard /><DrawerHost /><LocationProbe /></>, { route: "/financials?year=2026" });

    fireEvent.click(await screen.findByRole("button", { name: /purchases/i }));
    // The row itself opens the drawer (2026-09-21); the separate "Open in drawer" button went
    // with the expand-in-place panel it sat beside.
    fireEvent.click(await screen.findByRole("button", { name: /PO-2026-0001/ }));

    expect(await screen.findByRole("dialog", { name: "PO-2026-0001" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/financials?year=2026&po=po-1");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/financials?year=2026");
  });

  it("stacks two drawers in URL order and closing the top one reveals the one beneath", async () => {
    mockPo();
    vi.spyOn(api, "visit").mockResolvedValue(visit);
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(null);

    renderWithProviders(<><DrawerHost /><LocationProbe /></>, { route: "/calendar?job=visit-1&po=po-1" });

    const dialogs = await screen.findAllByRole("dialog");
    expect(dialogs).toHaveLength(2);
    expect(await screen.findByRole("dialog", { name: "12 Main St" })).toBeInTheDocument();

    // Escape goes to the one opened last (the P.O.), never both.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    expect(screen.getByRole("dialog", { name: "12 Main St" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/calendar?job=visit-1");
  });
});
