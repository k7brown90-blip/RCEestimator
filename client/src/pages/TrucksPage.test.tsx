/**
 * TrucksPage test (supplier-returns plan, Unit 5, 2026-09-23).
 *
 * Kyle: "Do we need a test file on the trucks page? Do we need to pin PO's and refund
 * lists." TrucksPage carries the control that attaches a refund to a P.O. — the one place
 * a silent mistake puts money on the wrong job — and had NO test file at all. The picker
 * defect that shipped in Units 1-4 (both stock-return P.O. pickers offered P.O.s that had
 * NOT landed) proved the risk is real: it passed the client suite because nothing covered
 * it, and a PurchasingPage.test.tsx fixture had `landedAt: null` and expected that P.O. IN
 * the returns picker, pinning the bug as correct behaviour.
 *
 * Covers: the "Refunds not on a P.O." list's exact membership rule (RefundsNotOnPo,
 * TrucksPage.tsx ~line 370), its empty state, the attach control's exact payload to
 * api.updateCardSpend, negative-money rendering, and that unlink/ignore still send what
 * they always sent.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { TrucksPage } from "./TrucksPage";
import { api } from "../lib/api";
import type {
  CardSpendRow,
  PurchaseOrderSummary,
  TruckDetail,
  TruckRecord,
  TruckRow,
  TrucksResponse,
} from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const truckRow: TruckRow = {
  id: "truck-1",
  name: "Truck 1",
  technicianId: null,
  technicianName: "Jane Tech",
  isActive: true,
  stripeCardId: "ic_1",
  cardLast4: "4242",
  stripeFinancialAccountId: "fa_1",
  notes: null,
  balance: null,
  mtd: { fuel: 0, maintenance: 0, materials: 0, tool: 0, other: 0 },
  unmatchedMaterials: 0,
  stockValue: 0,
  toolCount: 0,
};

const trucksResponse: TrucksResponse = {
  balancesAvailable: true,
  balancesReason: null,
  trucks: [truckRow],
  unassigned: null,
};

const truckRecord: TruckRecord = {
  id: "truck-1",
  name: "Truck 1",
  technicianId: null,
  isActive: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  stripeCardId: "ic_1",
  cardLast4: "4242",
  stripeFinancialAccountId: "fa_1",
  notes: null,
  technician: null,
};

function cardSpend(overrides: Partial<CardSpendRow>): CardSpendRow {
  return {
    id: "cs-1",
    stripeTransactionId: "txn_1",
    stripeCardId: "ic_1",
    truckId: "truck-1",
    truckName: "Truck 1",
    kind: "materials",
    // A refund: negative dollars.
    amount: -42.5,
    currency: "usd",
    merchantName: "Home Depot",
    merchantCategory: null,
    merchantCity: null,
    merchantState: null,
    settlement: "posted",
    purchaseOrderId: null,
    purchaseOrderNumber: null,
    purchaseOrderStatus: null,
    purchaseOrderAfterTheFact: false,
    purchaseOrderJobId: null,
    proven: false,
    needsProof: false,
    status: "unmatched",
    ignoredReason: null,
    note: null,
    occurredAt: "2026-09-20T12:00:00.000Z",
    createdAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

function po(overrides: Partial<PurchaseOrderSummary>): PurchaseOrderSummary {
  return {
    id: "po-1",
    number: "PO-2026-0001",
    purpose: "truck_stock",
    destinationType: "truck",
    truckId: "truck-1",
    truckName: "Truck 1",
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
    proofCount: 0,
    cardSpendCount: 1,
    cardMatched: true,
    cardTotal: 0,
    offCardAmount: null,
    offCardMethod: null,
    offCardNote: null,
    offCardAt: null,
    moneyTotal: 0,
    afterTheFact: false,
    lines: [],
    ...overrides,
  };
}

function detail(overrides: Partial<TruckDetail>): TruckDetail {
  return {
    truck: truckRecord,
    year: 2026,
    ledger: [],
    needingReceipt: [],
    purchaseOrders: [],
    balance: null,
    balancesAvailable: true,
    balancesReason: null,
    stockValue: 0,
    toolCount: 0,
    ...overrides,
  };
}

/** Common mocks every test needs before the truck's row can even render. */
function mockTrucks(truckDetail: TruckDetail) {
  vi.spyOn(api, "trucks").mockResolvedValue(trucksResponse);
  vi.spyOn(api, "technicians").mockResolvedValue([]);
  vi.spyOn(api, "truck").mockResolvedValue(truckDetail);
  vi.spyOn(api, "purchaseOrders").mockResolvedValue([]);
}

async function openTruck() {
  renderWithProviders(<TrucksPage />);
  fireEvent.click(await screen.findByText("Truck 1"));
}

/**
 * The "Refunds not on a P.O." queue and the Ledger table below it both read from the same
 * materials rows array, so a row's merchant name and money can appear TWICE on the page —
 * once in the queue, once in the ledger. Every assertion about queue MEMBERSHIP must be
 * scoped to the queue's own container or it proves nothing (a row "not in the queue" can
 * still legitimately show up in the ledger).
 */
async function refundsQueue(): Promise<HTMLElement> {
  const heading = await screen.findByText(/Refunds not on a P\.O\./);
  return heading.closest("div") as HTMLElement;
}

describe("TrucksPage — Refunds not on a P.O.", () => {
  it("holds only negative, non-ignored materials rows with no P.O., excluding every other kind of row", async () => {
    const validRefund = cardSpend({ id: "cs-valid", amount: -42.5, merchantName: "Valid Refund" });
    const positiveMaterials = cardSpend({ id: "cs-positive", amount: 88.4, merchantName: "Positive Materials Charge" });
    const ignoredRefund = cardSpend({ id: "cs-ignored", amount: -10, status: "ignored", merchantName: "Ignored Refund" });
    const attachedRefund = cardSpend({
      id: "cs-attached", amount: -15, purchaseOrderId: "po-9", purchaseOrderNumber: "PO-2026-0009", merchantName: "Already Attached Refund",
    });
    const fuelRefund = cardSpend({ id: "cs-fuel", amount: -20, kind: "fuel", merchantName: "Fuel Refund" });

    mockTrucks(detail({
      ledger: [
        { kind: "materials", total: 0, rows: [validRefund, positiveMaterials, ignoredRefund, attachedRefund] },
        { kind: "fuel", total: -20, rows: [fuelRefund] },
      ],
    }));

    await openTruck();

    const queue = await refundsQueue();
    expect(within(queue).getByText(/Refunds not on a P\.O\. \(1\)/)).toBeInTheDocument();
    expect(within(queue).getByText("Valid Refund")).toBeInTheDocument();
    expect(within(queue).queryByText("Positive Materials Charge")).not.toBeInTheDocument();
    expect(within(queue).queryByText("Ignored Refund")).not.toBeInTheDocument();
    expect(within(queue).queryByText("Already Attached Refund")).not.toBeInTheDocument();
    expect(within(queue).queryByText("Fuel Refund")).not.toBeInTheDocument();
  });

  it("shows the empty state when nothing qualifies", async () => {
    const positiveMaterials = cardSpend({ id: "cs-positive", amount: 88.4, merchantName: "Positive Materials Charge" });
    mockTrucks(detail({ ledger: [{ kind: "materials", total: 88.4, rows: [positiveMaterials] }] }));

    await openTruck();

    const queue = await refundsQueue();
    expect(within(queue).getByText(/Refunds not on a P\.O\. \(0\)/)).toBeInTheDocument();
    expect(within(queue).getByText("Every refund is on a P.O.")).toBeInTheDocument();
  });

  it("renders a refund as negative money — never flipped positive for display", async () => {
    const refund = cardSpend({ id: "cs-refund", amount: -42.5, merchantName: "Valid Refund" });
    mockTrucks(detail({ ledger: [{ kind: "materials", total: -42.5, rows: [refund] }] }));

    await openTruck();

    const queue = await refundsQueue();
    // If the amount were ever flipped positive for display, this exact string would not be found.
    expect(within(queue).getByText(/-\$42\.50/)).toBeInTheDocument();
  });

  it("attach sends the real P.O. id and the typed reason to api.updateCardSpend — the exact payload", async () => {
    const refund = cardSpend({ id: "cs-refund", amount: -42.5, merchantName: "Valid Refund" });
    mockTrucks(detail({ ledger: [{ kind: "materials", total: -42.5, rows: [refund] }] }));
    vi.spyOn(api, "purchaseOrders").mockResolvedValue([po({ id: "po-1", number: "PO-2026-0001", supplier: "Home Depot" })]);
    const updateCardSpend = vi.spyOn(api, "updateCardSpend").mockResolvedValue(refund);

    await openTruck();

    const queue = await refundsQueue();
    const row = within(queue).getByText("Valid Refund").closest("li")!;
    // The P.O. select is empty until useLivePurchaseOrders resolves — wait for the option to
    // exist or fireEvent.change silently no-ops (the value it's given matches no <option>).
    await within(row).findByRole("option", { name: /PO-2026-0001/ });
    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "po-1" } });
    fireEvent.change(within(row).getByPlaceholderText("Reason (required)"), { target: { value: "returned to store" } });
    fireEvent.click(within(row).getByRole("button", { name: "Attach" }));

    await waitFor(() => expect(updateCardSpend).toHaveBeenCalledWith("cs-refund", {
      purchaseOrderId: "po-1", reason: "returned to store",
    }));
  });
});

describe("TrucksPage — existing card-spend edit behaviour still holds", () => {
  it("unlink still sends purchaseOrderId: null with a reason", async () => {
    const linked = cardSpend({
      id: "cs-linked", amount: 120, purchaseOrderId: "po-9", purchaseOrderNumber: "PO-2026-0009", merchantName: "Linked Materials",
    });
    mockTrucks(detail({ ledger: [{ kind: "materials", total: 120, rows: [linked] }] }));
    const updateCardSpend = vi.spyOn(api, "updateCardSpend").mockResolvedValue(linked);
    vi.spyOn(window, "prompt").mockReturnValue("charge landed on the wrong P.O.");

    await openTruck();

    expect(await screen.findByText("Linked Materials")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.click(screen.getByRole("button", { name: "unlink from P.O." }));

    await waitFor(() => expect(updateCardSpend).toHaveBeenCalledWith("cs-linked", {
      purchaseOrderId: null, reason: "charge landed on the wrong P.O.",
    }));
  });

  it("ignore still takes a reason and sends status: 'ignored'", async () => {
    const needsReceipt = cardSpend({
      id: "cs-needs-receipt", amount: 88.4, merchantName: "Needs Receipt Charge",
    });
    mockTrucks(detail({ needingReceipt: [needsReceipt] }));
    const updateCardSpend = vi.spyOn(api, "updateCardSpend").mockResolvedValue({ ...needsReceipt, status: "ignored" });

    await openTruck();

    expect(await screen.findByText("Needs Receipt Charge")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    fireEvent.change(screen.getByPlaceholderText("Reason (required)"), { target: { value: "duplicate swipe" } });
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));

    await waitFor(() => expect(updateCardSpend).toHaveBeenCalledWith("cs-needs-receipt", {
      status: "ignored", reason: "duplicate swipe",
    }));
  });
});
