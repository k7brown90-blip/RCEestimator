/**
 * PurchasingPage render test (tab separation, 2026-09-20 — build #5 of the "drawers and tab
 * purpose" plan). This is the Inventory tab renamed Purchasing & Stock, and the tab that GAINED
 * the Purchases card and the receipts-to-review list from Financials.
 *
 * Build #4's predecessor proved a clean `tsc` can hide a page that throws on load, so the moved
 * surfaces are asserted here, on their NEW tab, against the real hooks they fetch through:
 * the Purchases card header (useLivePurchaseOrders + useRecentlyVerifiedPurchaseOrders),
 * "Receipts to review" (usePendingReviewReceipts), and the tab's own attention strip
 * (money with no proof, from the same live-P.O. hook).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { PurchasingPage } from "./PurchasingPage";
import { api } from "../lib/api";
import type { InventoryOverview, PurchaseOrderSummary, ReviewReceiptRow, StockLevelView, StockMovementView } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const overview: InventoryOverview = {
  warehouse: { locationKey: "warehouse", levels: [], value: 0 },
  trucks: [],
  openRequests: [
    {
      id: "req-1", truckId: "truck-1", truckName: "Truck 1", itemId: null, name: "12-2 NM-B",
      qty: 250, unit: "ft", note: null, status: "open", requestedByTechnicianId: null,
      createdAt: "2026-09-18T12:00:00.000Z", resolvedAt: null,
    },
  ],
  unlandedPos: [
    {
      id: "po-land", number: "PO-2026-0031", supplier: "Home Depot", status: "verified", purpose: "truck_stock",
      truckId: "truck-1", truckName: "Truck 1", purchasedAt: "2026-09-17T12:00:00.000Z", receiptCount: 1, lineCount: 3,
    },
  ],
};

function po(overrides: Partial<PurchaseOrderSummary>): PurchaseOrderSummary {
  return {
    id: "po-1",
    number: "PO-2026-0040",
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
    openedAt: "2026-09-19T12:00:00.000Z",
    purchasedAt: "2026-09-19T13:00:00.000Z",
    verifiedAt: null,
    closedAt: null,
    cancelledAt: null,
    sentAt: null,
    landedAt: null,
    createdAt: "2026-09-19T12:00:00.000Z",
    receiptCount: 0,
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
    ...overrides,
  };
}

const warehouseLevel: StockLevelView = {
  id: "level-1",
  locationKey: "warehouse",
  itemId: "hd-12-2-nmb",
  name: "12-2 NM-B",
  unit: "ft",
  qtyOnHand: 100,
  avgUnitCost: 0.42,
  value: 42,
  parLevel: null,
  low: false,
  updatedAt: "2026-09-20T12:00:00.000Z",
};

const pendingReceipt: ReviewReceiptRow = {
  id: "rcpt-1", jobId: "visit-1", vendor: "Lowe's", category: "materials", amount: 88.4, source: "field",
  receivedAt: "2026-09-19T15:00:00.000Z", accountId: "acct-1", accountName: "Jane Homeowner",
  jobLabel: "Panel upgrade — 12 Main St, Smyrna", purchaseOrderId: "po-9", purchaseOrderNumber: "PO-2026-0039", needsPo: false,
};

function mockEverything(opts: { live?: PurchaseOrderSummary[]; pending?: ReviewReceiptRow[] } = {}) {
  vi.spyOn(api, "inventory").mockResolvedValue(overview);
  vi.spyOn(api, "unassignedMaterials").mockResolvedValue([]);
  vi.spyOn(api, "materials").mockResolvedValue([]);
  vi.spyOn(api, "tools").mockResolvedValue([]);
  // The Purchases card's two P.O. lists — live (open,purchased) and recently verified.
  vi.spyOn(api, "purchaseOrders").mockImplementation(async (params) =>
    params?.status === "verified" ? [] : (opts.live ?? []),
  );
  vi.spyOn(api, "receiptsNeedingPo").mockResolvedValue([]);
  vi.spyOn(api, "pendingReceipts").mockResolvedValue(opts.pending ?? []);
}

describe("PurchasingPage", () => {
  it("renders the moved Purchases card and receipt review beside the stock cards", async () => {
    mockEverything({ pending: [pendingReceipt] });

    renderWithProviders(<PurchasingPage />);

    expect(screen.getByRole("heading", { name: "Purchasing & Stock" })).toBeInTheDocument();
    // The Purchases card — moved here from Financials. CollapsibleCard renders its header as a button.
    expect(await screen.findByRole("button", { name: /^purchases/i })).toBeInTheDocument();
    // Receipts to review — moved here from Financials; it only renders when there are rows.
    expect(await screen.findByRole("button", { name: /receipts to review \(all accounts\)/i })).toBeInTheDocument();
    expect(screen.getByText("Lowe's")).toBeInTheDocument();
    // The inventory half is still here.
    expect(await screen.findByRole("heading", { name: "POs to land (1)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Restock requests (1)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Warehouse \(home\)/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Tool register/ })).toBeInTheDocument();
    // Start a P.O. is an in-page anchor now — the card is on this tab, not on Financials.
    const start = screen.getByRole("link", { name: /start a p\.o\./i });
    expect(start).toHaveAttribute("href", "#purchases");
  });

  it("opens with its own attention strip: money with no proof, and the queue counts", async () => {
    mockEverything({
      live: [
        po({ id: "po-1", number: "PO-2026-0040", moneyTotal: 651.73, proofCount: 0 }),
        // Proved — money AND a receipt file — so it is not a row.
        po({ id: "po-2", number: "PO-2026-0041", moneyTotal: 114.01, proofCount: 1, receiptCount: 1 }),
        // No money yet (still open) — nothing to prove.
        po({ id: "po-3", number: "PO-2026-0042", status: "open", moneyTotal: 0, cardTotal: 0, cardSpendCount: 0, cardMatched: false }),
      ],
      pending: [pendingReceipt],
    });

    renderWithProviders(<PurchasingPage />);

    const strip = await screen.findByRole("region", { name: /needs attention/i });
    expect(within(strip).getByText("1 P.O. with money and no receipt ($651.73)")).toBeInTheDocument();
    expect(within(strip).getByText("1 receipt to review")).toBeInTheDocument();
    expect(within(strip).getByText("1 to land")).toBeInTheDocument();
    expect(within(strip).getByText("1 restock request")).toBeInTheDocument();
    // The unproved P.O. is the row, with the attach button right there.
    expect(within(strip).getByText(/PO-2026-0040/)).toBeInTheDocument();
    expect(within(strip).queryByText(/PO-2026-0041/)).not.toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: /attach receipt/i })).toBeInTheDocument();
  });

  it("shows no strip when nothing needs attention", async () => {
    mockEverything();
    vi.spyOn(api, "inventory").mockResolvedValue({ ...overview, openRequests: [], unlandedPos: [] });

    renderWithProviders(<PurchasingPage />);

    expect(await screen.findByRole("heading", { name: "POs to land (0)" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /needs attention/i })).not.toBeInTheDocument();
  });

  // Supplier returns (2026-09-22, plan Unit 3): "Returned to store" on a stock row.
  it("records a supplier return, optionally on a P.O., and never labels it like a job return", async () => {
    // The "Returned to store" picker offers LANDED POs only (defect fix, 2026-09-22) — stock
    // on the truck/warehouse got there by landing, so po-1 needs a landedAt to show up here.
    mockEverything({ live: [po({ id: "po-1", number: "PO-2026-0040", supplier: "Home Depot", status: "closed", landedAt: "2026-09-20T10:00:00.000Z" })] });
    vi.spyOn(api, "inventory").mockResolvedValue({ ...overview, warehouse: { locationKey: "warehouse", levels: [warehouseLevel], value: warehouseLevel.value } });
    const supplierReturn = vi.spyOn(api, "supplierReturn").mockResolvedValue({
      id: "mv-1", kind: "supplier_return", itemId: "hd-12-2-nmb", name: "12-2 NM-B", unit: "ft",
      qty: 20, delta: null, unitCost: 0.42, fromLocationKey: "warehouse", toLocationKey: null,
      purchaseOrderId: "po-1", purchaseOrderLineId: null, jobId: null, correctsId: null,
      reason: "restocking excess", actor: "owner", at: "2026-09-22T12:00:00.000Z",
    });

    renderWithProviders(<PurchasingPage />);

    expect(await screen.findByText("12-2 NM-B")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Returned to store" }));

    fireEvent.change(screen.getByPlaceholderText("100"), { target: { value: "20" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "po-1" } });
    fireEvent.change(screen.getByPlaceholderText("Reason (required)"), { target: { value: "restocking excess" } });
    fireEvent.click(screen.getByRole("button", { name: "Return to store" }));

    await waitFor(() => expect(supplierReturn).toHaveBeenCalledWith({
      itemId: "hd-12-2-nmb", qty: 20, fromLocationKey: "warehouse", purchaseOrderId: "po-1", reason: "restocking excess",
    }));
  });

  // Unit 5, 2026-09-23: the assertion that would have caught the picker defect — a PO
  // that has not landed must never be offered as a stock-return target, only one that has.
  it("offers only landed P.O.s in the Returned to store picker", async () => {
    mockEverything({
      live: [
        po({ id: "po-landed", number: "PO-2026-0040", supplier: "Home Depot", status: "closed", landedAt: "2026-09-20T10:00:00.000Z" }),
        po({ id: "po-unlanded", number: "PO-2026-0099", supplier: "Lowe's", status: "purchased", landedAt: null }),
      ],
    });
    vi.spyOn(api, "inventory").mockResolvedValue({ ...overview, warehouse: { locationKey: "warehouse", levels: [warehouseLevel], value: warehouseLevel.value } });

    renderWithProviders(<PurchasingPage />);

    expect(await screen.findByText("12-2 NM-B")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Returned to store" }));

    const picker = screen.getByRole("combobox");
    expect(within(picker).getByRole("option", { name: /PO-2026-0040/ })).toBeInTheDocument();
    expect(within(picker).queryByRole("option", { name: /PO-2026-0099/ })).not.toBeInTheDocument();
  });

  it("labels a supplier_return movement 'returned to store', distinct from a job return", async () => {
    mockEverything();
    vi.spyOn(api, "inventory").mockResolvedValue({ ...overview, warehouse: { locationKey: "warehouse", levels: [warehouseLevel], value: warehouseLevel.value } });
    const movement: StockMovementView = {
      id: "mv-2", kind: "supplier_return", itemId: "hd-12-2-nmb", name: "12-2 NM-B", unit: "ft",
      qty: 15, delta: null, unitCost: 0.42, fromLocationKey: "warehouse", toLocationKey: null,
      purchaseOrderId: null, purchaseOrderLineId: null, jobId: null, correctsId: null,
      reason: "damaged spool", actor: "owner", at: "2026-09-22T12:00:00.000Z",
    };
    vi.spyOn(api, "inventoryMovements").mockResolvedValue([movement]);

    renderWithProviders(<PurchasingPage />);

    expect(await screen.findByText("12-2 NM-B")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "history" }));

    expect(await screen.findByText(/returned to store/)).toBeInTheDocument();
  });
});
