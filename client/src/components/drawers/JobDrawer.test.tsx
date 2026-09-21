/**
 * The job drawer re-hosts the visit workspace's job furniture — scheduler, payment, close-out —
 * and its close-out's P.O. rows open the P.O. drawer on top.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useLocation } from "react-router-dom";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../../test/renderWithProviders";
import { DrawerHost } from "./DrawerHost";
import { api } from "../../lib/api";
import type { JobMaterialsView, Visit } from "../../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function LocationProbe() {
  const { search } = useLocation();
  return <p data-testid="location">{search}</p>;
}

function visit(status: string): Visit {
  return {
    id: "visit-1", propertyId: "prop-1", customerId: "cust-1", mode: "service_diagnostic", status, jobType: "Panel upgrade",
    visitDate: "2026-09-10T12:00:00.000Z",
    property: { id: "prop-1", customerId: "cust-1", name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } as Visit["property"],
    customer: { id: "cust-1", name: "Jane Homeowner" } as Visit["customer"],
    estimates: [],
  };
}

const materials = {
  jobId: "visit-1", truck: { id: "truck-1", name: "Truck 12" }, estimate: null, suggested: [], shortages: [], lines: [],
  stock: null, receipts: [], materialCost: 0, materialSource: "none", po: null, estimateMaterial: null,
} as unknown as JobMaterialsView;

describe("JobDrawer", () => {
  it("shows a consultation-stage visit with its scheduler and no close-out", async () => {
    vi.spyOn(api, "visit").mockResolvedValue(visit("estimate"));
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(null);
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

    renderWithProviders(<><DrawerHost /><LocationProbe /></>, { route: "/jobs?job=visit-1" });

    expect(await screen.findByRole("dialog", { name: "12 Main St" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Full page/ })).toHaveAttribute("href", "/visits/visit-1");
    // JobScheduler's idle state offers to book; close-out is job furniture and is absent here.
    expect(await screen.findByRole("button", { name: "Book Estimate Visit" })).toBeInTheDocument();
    expect(screen.queryByText("Job close-out")).not.toBeInTheDocument();
    // An unsigned visit keeps its way out.
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    // The record carries its own actions (2026-09-20 communications build).
    expect(screen.getByRole("button", { name: "Send email" })).toBeInTheDocument();
  });

  it("sends a follow-up email about the job, tagged to the visit", async () => {
    vi.spyOn(api, "visit").mockResolvedValue(visit("estimate"));
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(null);
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);
    vi.spyOn(api, "sendRecordEmail").mockResolvedValue({ sent: true, to: "jane@example.com", suppressed: false });

    renderWithProviders(<><DrawerHost /><LocationProbe /></>, { route: "/jobs?job=visit-1" });
    const dialog = await screen.findByRole("dialog", { name: "12 Main St" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Send email" }));
    fireEvent.change(within(dialog).getByLabelText("Subject"), { target: { value: "Your appointment" } });
    fireEvent.change(within(dialog).getByLabelText("Message"), { target: { value: "See you Tuesday." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(api.sendRecordEmail).toHaveBeenCalledWith({
      target: "job", id: "visit-1", to: null, subject: "Your appointment", body: "See you Tuesday.",
    }));
  });

  it("shows close-out on contracted work and opens a P.O. drawer from its P.O. row", async () => {
    vi.spyOn(api, "visit").mockResolvedValue(visit("contracted"));
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(null);
    vi.spyOn(api, "jobMaterials").mockResolvedValue(materials);
    vi.spyOn(api, "jobPurchaseOrders").mockResolvedValue([{
      id: "po-1", number: "PO-2026-0001", purpose: "truck_stock", status: "purchased", supplier: "Home Depot", sentAt: null,
      createdAt: "2026-09-18T12:00:00.000Z", receiptCount: 0, cardTotal: 651.73, offCardAmount: null, moneyTotal: 651.73, proofCount: 0, items: [],
    } as Awaited<ReturnType<typeof api.jobPurchaseOrders>>[number]]);
    vi.spyOn(api, "purchaseOrder").mockResolvedValue({
      id: "po-1", number: "PO-2026-0001", purpose: "truck_stock", destinationType: "truck", truckId: "truck-1", truckName: "Truck 12",
      jobId: "visit-1", jobLabel: "Panel upgrade", accountId: "cust-1", accountName: "Jane Homeowner", supplier: "Home Depot", status: "purchased",
      notes: null, openedBy: "owner", openedByTechnicianId: null, openedAt: "2026-09-18T12:00:00.000Z", purchasedAt: null, verifiedAt: null,
      closedAt: null, cancelledAt: null, sentAt: null, landedAt: null, createdAt: "2026-09-18T12:00:00.000Z", receiptCount: 0, proofCount: 0,
      cardSpendCount: 0, cardMatched: false, cardTotal: 0, offCardAmount: null, offCardMethod: null, offCardNote: null, offCardAt: null,
      moneyTotal: 0, afterTheFact: false, lines: [], events: [], receipts: [], cardSpends: [],
    });
    vi.spyOn(api, "receiptsNeedingPo").mockResolvedValue([]);
    // The landing panel's read is not under test; a rejected read renders its own error line.
    vi.spyOn(api, "landingDefaults").mockRejectedValue(new Error("not in this test"));
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

    renderWithProviders(<><DrawerHost /><LocationProbe /></>, { route: "/accounts/cust-1?job=visit-1" });

    expect(await screen.findByText("Job close-out")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /PO-2026-0001/ }));

    await waitFor(() => expect(api.purchaseOrder).toHaveBeenCalledWith("po-1"));
    expect(screen.getByTestId("location")).toHaveTextContent("?job=visit-1&po=po-1");
    expect(await screen.findByRole("dialog", { name: "PO-2026-0001" })).toBeInTheDocument();
  });
});
