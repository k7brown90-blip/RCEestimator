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
import type { PaymentInfo } from "../../lib/api";
import type { JobMaterialsView, PbIssuedEstimate, Visit } from "../../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function LocationProbe() {
  const { search } = useLocation();
  return <p data-testid="location">{search}</p>;
}

function PathProbe() {
  const { pathname, search } = useLocation();
  return <p data-testid="path">{pathname}{search}</p>;
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

const paymentInfo = {
  estimateId: "est-1", number: "EST-2026-0001", billedTotal: 4200, depositDue: 0, depositRequired: false,
  documents: [], depositPaid: 0, totalPaid: 0, balance: 4200, depositSatisfied: true, paidInFull: false,
  payUrl: "", depositPayUrl: "", stripeConfigured: false, payments: [],
} as unknown as PaymentInfo;

describe("JobDrawer", () => {
  it("shows a consultation-stage visit with its scheduler and no close-out", async () => {
    vi.spyOn(api, "visit").mockResolvedValue(visit("estimate"));
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(null);
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    vi.spyOn(api, "accountNotes").mockResolvedValue([]);

    renderWithProviders(<><DrawerHost /><LocationProbe /></>, { route: "/jobs?job=visit-1" });

    expect(await screen.findByRole("dialog", { name: "12 Main St" })).toBeInTheDocument();
    // "Workspace", not "Full page" (2026-09-29): under Kyle's ruling /visits/:id is the INTERNAL
    // side of the job, not a fuller version of this drawer. The old label said the drawer was the
    // lesser surface, which is the inversion the ruling corrects.
    expect(screen.getByRole("link", { name: /Workspace/ })).toHaveAttribute("href", "/visits/visit-1");
    // No signed invoice on a consultation-stage visit, so no invoice door.
    expect(screen.queryByRole("button", { name: /^Invoice / })).not.toBeInTheDocument();
    // ONE SCHEDULER (2026-10-01, plan item E3): the drawer no longer opens its own picker. It
    // shows the booking state and ONE door to the Calendar with this job already selected.
    const door = await screen.findByRole("link", { name: "Book on the Calendar" });
    expect(door).toHaveAttribute("href", "/calendar?schedule=visit-1");
    expect(screen.getByText("Not booked yet.")).toBeInTheDocument();
    // The inline scheduler is gone: no "Book Estimate Visit" button, no second month grid.
    expect(screen.queryByRole("button", { name: "Book Estimate Visit" })).not.toBeInTheDocument();
    expect(screen.queryByText("Su")).not.toBeInTheDocument();
    expect(screen.queryByText(/Pick a start date/)).not.toBeInTheDocument();
    // Close-out is job furniture and is absent here.
    expect(screen.queryByText("Job close-out")).not.toBeInTheDocument();
    // An unsigned visit keeps its way out.
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    // The record carries its own actions (2026-09-20 communications build).
    expect(screen.getByRole("button", { name: "Send email" })).toBeInTheDocument();
  });

  /*
    ONE SCHEDULER (2026-10-01, plan item E3). Kyle: "the date picker would only come up in one
    scheduling page and not the other." This drawer was one of the pages where it did not — it
    rendered `JobScheduler` idle, a button that opened a second month grid inside the drawer.
    Now a booked job shows its date and ONE door; clicking it leaves for the Calendar with
    `?schedule=<visitId>`, which CalendarPage consumes by opening the reschedule picker.
  */
  it("a scheduled job shows its date and 'Reschedule or cancel on the Calendar', which lands on /calendar?schedule=<id>", async () => {
    vi.spyOn(api, "visit").mockResolvedValue({
      ...visit("scheduled"),
      scheduledStart: "2026-10-15T13:00:00.000Z",
      scheduledEnd: "2026-10-15T21:00:00.000Z",
      estimatedDurationDays: 1,
    });
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(null);
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    vi.spyOn(api, "accountNotes").mockResolvedValue([]);
    vi.spyOn(api, "jobMaterials").mockResolvedValue(materials);
    vi.spyOn(api, "jobPurchaseOrders").mockResolvedValue([]);
    vi.spyOn(api, "receiptsNeedingPo").mockResolvedValue([]);
    vi.spyOn(api, "landingDefaults").mockRejectedValue(new Error("not in this test"));

    renderWithProviders(<><DrawerHost /><PathProbe /></>, { route: "/jobs?job=visit-1" });

    const dialog = await screen.findByRole("dialog", { name: "12 Main St" });
    expect(within(dialog).getByText("Scheduled")).toBeInTheDocument();
    expect(within(dialog).getByText(/Thursday, October 15, 2026/)).toBeInTheDocument();
    // No picker in the drawer, in either mode.
    expect(within(dialog).queryByRole("button", { name: /^reschedule$/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Su")).not.toBeInTheDocument();

    const door = within(dialog).getByRole("link", { name: "Reschedule or cancel on the Calendar" });
    expect(door).toHaveAttribute("href", "/calendar?schedule=visit-1");
    fireEvent.click(door);

    expect(screen.getByTestId("path")).toHaveTextContent("/calendar?schedule=visit-1");
    // Leaving /jobs dropped `?job=`, so the drawer closed behind the navigation.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("sends a follow-up email about the job, tagged to the visit", async () => {
    vi.spyOn(api, "visit").mockResolvedValue(visit("estimate"));
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(null);
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    vi.spyOn(api, "accountNotes").mockResolvedValue([]);
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
    vi.spyOn(api, "accountNotes").mockResolvedValue([]);

    renderWithProviders(<><DrawerHost /><LocationProbe /></>, { route: "/accounts/cust-1?job=visit-1" });

    expect(await screen.findByText("Job close-out")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /PO-2026-0001/ }));

    await waitFor(() => expect(api.purchaseOrder).toHaveBeenCalledWith("po-1"));
    expect(screen.getByTestId("location")).toHaveTextContent("?job=visit-1&po=po-1");
    expect(await screen.findByRole("dialog", { name: "PO-2026-0001" })).toBeInTheDocument();
  });

  it("PUNCHLIST K7: opens the invoice's estimate drawer from the job — the door the estimate drawer already had in reverse", async () => {
    vi.spyOn(api, "visit").mockResolvedValue(visit("contracted"));
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(paymentInfo);
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    vi.spyOn(api, "accountNotes").mockResolvedValue([]);
    vi.spyOn(api, "jobMaterials").mockResolvedValue(materials);
    vi.spyOn(api, "jobPurchaseOrders").mockResolvedValue([]);
    vi.spyOn(api, "receiptsNeedingPo").mockResolvedValue([]);
    vi.spyOn(api, "landingDefaults").mockRejectedValue(new Error("not in this test"));
    vi.spyOn(api, "estimateRecord").mockResolvedValue({
      estimate: { id: "est-1", draftId: "draft-1", customerId: "cust-1", serviceAddressId: "prop-1", number: "EST-2026-0001", revision: 1,
        status: "signed", title: "Panel upgrade", customerName: "Jane Homeowner", customerEmail: "jane@example.com",
        serviceAddress: "12 Main St, Smyrna", billedTotal: 4200, total: 4200, createdAt: "2026-09-10T12:00:00.000Z",
        sentAt: "2026-09-10T12:00:00.000Z", sentTo: "jane@example.com", firstViewedAt: null,
        signedAt: "2026-09-12T12:00:00.000Z", signerName: "Jane", jobVisitId: "visit-1",
      } as PbIssuedEstimate,
    });

    renderWithProviders(<><DrawerHost /><LocationProbe /></>, { route: "/jobs?job=visit-1" });

    const estimateDoor = await screen.findByRole("button", { name: "Estimate" });
    fireEvent.click(estimateDoor);

    await waitFor(() => expect(api.estimateRecord).toHaveBeenCalledWith("est-1"));
    expect(screen.getByTestId("location")).toHaveTextContent("?job=visit-1&estimate=est-1");
    expect(await screen.findByRole("dialog", { name: "Panel upgrade" })).toBeInTheDocument();
  });

  /*
    THE JOB NAMES ITS INVOICE AND OPENS IT (2026-09-29, findability audit B5).

    The job drawer carried the money but no invoice IDENTITY and no door to the invoice record —
    so from the screen the office is on when a technician rings, there was no route to the PDFs,
    the reminder, the signed copy or the delivery state. `paymentInfo.estimateId` is the ROOT, so
    this door cannot land on the change-order dead end EstimateDrawer's did before today.
  */
  it("names the job's invoice and opens its drawer", async () => {
    vi.spyOn(api, "visit").mockResolvedValue(visit("contracted"));
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(paymentInfo);
    vi.spyOn(api, "estimatePaymentInfo").mockResolvedValue(null);
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    vi.spyOn(api, "accountNotes").mockResolvedValue([]);
    vi.spyOn(api, "jobMaterials").mockResolvedValue(materials);
    vi.spyOn(api, "jobPurchaseOrders").mockResolvedValue([]);
    vi.spyOn(api, "receiptsNeedingPo").mockResolvedValue([]);
    vi.spyOn(api, "landingDefaults").mockRejectedValue(new Error("not in this test"));
    vi.spyOn(api, "invoices").mockResolvedValue([{
      remindersSent: 0, lastReminderAt: null, id: "est-1", number: "EST-2026-0001", revision: 1,
      title: "Panel upgrade", customer: { id: "cust-1", name: "Jane Homeowner" },
      customerPhone: null, customerEmail: "jane@example.com", propertyId: "prop-1",
      job: { id: "visit-1", jobType: "Panel upgrade", purpose: null, status: "contracted", scheduledStart: null },
      serviceAddress: "12 Main St, Smyrna", signedAt: "2026-09-12T12:00:00.000Z", signedChannel: "email",
      sentAt: "2026-09-12T12:00:00.000Z", sentTo: "jane@example.com", billedTotal: 4200, depositDue: 0,
      totalPaid: 0, discountTotal: 0, collected: 0, balance: 4200, lastPaidAt: null, paymentStatus: "unpaid",
    } as never]);

    renderWithProviders(<><DrawerHost /><LocationProbe /></>, { route: "/jobs?job=visit-1" });

    // Named after the invoice, so the operator knows which one before clicking.
    const invoiceDoor = await screen.findByRole("button", { name: "Invoice EST-2026-0001" });
    fireEvent.click(invoiceDoor);

    expect(screen.getByTestId("location")).toHaveTextContent("?job=visit-1&invoice=est-1");
    expect(await screen.findByRole("dialog", { name: "Invoice EST-2026-0001" })).toBeInTheDocument();
  });

  /*
    WHAT THE LAST CALLER SAID (plan item F, 2026-10-01). Kyle, filed from a job page: "I have no
    place to record notes from the customer conversation that can be accessed by admin and other
    personnel." Ruled account-based. So the drawer shows the ACCOUNT's log — the newest note may
    be about a different job, and that is the point — and a note added here is tagged to this job.
  */
  it("shows the account's conversation log on the job, and a note added here is tagged to this job", async () => {
    vi.spyOn(api, "visit").mockResolvedValue(visit("estimate"));
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(null);
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    vi.spyOn(api, "accountNotes").mockResolvedValue([{
      id: "note-1", customerId: "cust-1", visitId: "visit-0", body: "Said the breaker trips when the dryer runs.", takenBy: "Eric",
      createdAt: "2026-09-30T14:05:00.000Z", updatedAt: "2026-09-30T14:05:00.000Z",
      visit: { id: "visit-0", jobType: "Service call", purpose: null, visitDate: "2026-09-20T12:00:00.000Z", property: { addressLine1: "12 Main St" } },
    }]);
    const add = vi.spyOn(api, "addAccountNote").mockResolvedValue({
      id: "note-2", customerId: "cust-1", visitId: "visit-1", body: "Gate code is 4411.", takenBy: "Kyle",
      createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z", visit: null,
    });

    renderWithProviders(<><DrawerHost /><LocationProbe /></>, { route: "/jobs?job=visit-1" });
    const dialog = await screen.findByRole("dialog", { name: "12 Main St" });

    // The account's log is read by the visit's customer, not by the visit.
    await waitFor(() => expect(api.accountNotes).toHaveBeenCalledWith("cust-1"));
    const log = within(dialog).getByRole("group", { name: "Conversation notes" });
    expect(log).toHaveTextContent("Said the breaker trips when the dryer runs.");
    expect(log).toHaveTextContent("Taken by Eric");
    expect(log).toHaveTextContent("about Service call — 12 Main St");

    fireEvent.click(within(log).getByRole("button", { name: "Add note" }));
    expect(within(log).getByText("Filed on the account and tagged to this job.")).toBeInTheDocument();
    fireEvent.change(within(log).getByLabelText("What was said"), { target: { value: "Gate code is 4411." } });
    fireEvent.change(within(log).getByLabelText("Taken by"), { target: { value: "Kyle" } });
    fireEvent.click(within(log).getByRole("button", { name: "Save note" }));

    await waitFor(() => expect(add).toHaveBeenCalledWith("cust-1", { body: "Gate code is 4411.", takenBy: "Kyle", visitId: "visit-1" }));
  });
});
