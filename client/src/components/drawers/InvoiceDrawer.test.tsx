/**
 * The invoice drawer: the GET /invoices row plus PaymentPanel, the PDF copies and the ONE email
 * control.
 *
 * UPDATED 2026-10-27 (one email tool): this drawer's "Send reminder" and "Email the signed copy…"
 * (and the payment card's "Email invoice NNNN - $X due") are the single "Email the customer" panel
 * now, so the two cases that pinned "Send reminder" (including its financing grey-out, which moved
 * to the panel: a financed balance is never chased - see PaymentPanel.test) were rewritten to pin
 * the one control and the walk through it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../test/renderWithProviders";
import { DrawerHost } from "./DrawerHost";
import { api } from "../../lib/api";
import type { InvoiceSummary } from "../../lib/types";
import type { PaymentInfo } from "../../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

const inv: InvoiceSummary = {
  remindersSent: 1, lastReminderAt: "2026-09-15T12:00:00.000Z", id: "est-1", number: "EST-2026-0001", revision: 1, title: "Panel upgrade",
  draftId: "draft-1", accountProperties: [{ id: "prop-1", name: "Jane Homeowner House", addressLine1: "12 Main St", city: "Smyrna" }],
  customer: { id: "acct-1", name: "Jane Homeowner" }, customerPhone: "615-555-0101", customerEmail: "jane@example.com", propertyId: "prop-1",
  job: { id: "visit-1", jobType: "Panel upgrade", purpose: null, status: "scheduled", scheduledStart: "2026-09-22T13:00:00.000Z" },
  serviceAddress: "12 Main St, Smyrna", signedAt: "2026-09-12T12:00:00.000Z", signedChannel: "email", sentAt: "2026-09-12T12:00:00.000Z",
  sentTo: "jane@example.com", billedTotal: 4200, depositDue: 1400, totalPaid: 1400, discountTotal: 0, collected: 1400, balance: 2800,
  lastPaidAt: "2026-09-13T12:00:00.000Z", paymentStatus: "deposit_paid",
};

/** The payment card's PaymentInfo for `inv` (the card is where the one email panel lives, 2026-10-27). */
const paymentInfo = (over: Partial<PaymentInfo> = {}): PaymentInfo => ({
  estimateId: "est-1", number: "EST-2026-0001", billedTotal: 4200, depositDue: 1400, depositRequired: true,
  documents: [{ id: "est-1", number: "EST-2026-0001", revision: 1, title: "Panel upgrade", kind: "invoice", signedAt: "2026-09-12T12:00:00.000Z", billedTotal: 4200, depositRequired: true }],
  depositPaid: 1400, totalPaid: 1400, balance: 2800, depositSatisfied: true, paidInFull: false,
  payUrl: "https://example.test/pay/tok", depositPayUrl: "https://example.test/pay/tok?type=deposit", stripeConfigured: true,
  email: { customerId: "acct-1", customerEmail: "jane@example.com", jobId: "visit-1", jobStatus: "scheduled", reviewRequestedAt: null },
  payments: [], ...over,
});

describe("InvoiceDrawer", () => {
  it("shows the invoice's contact, signing and money lines with the PDF actions - and exactly ONE email control (2026-10-27)", async () => {
    vi.spyOn(api, "invoices").mockResolvedValue([inv]);
    vi.spyOn(api, "estimatePaymentInfo").mockResolvedValue(paymentInfo());
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

    renderWithProviders(<DrawerHost />, { route: "/financials?invoice=est-1" });

    expect(await screen.findByRole("dialog", { name: "Invoice EST-2026-0001" })).toBeInTheDocument();
    expect(screen.getByText(/615-555-0101 · jane@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/signed 9\/12\/2026 from the emailed link/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Customer copy (PDF)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Our copy (PDF)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Job: Panel upgrade/ })).toBeInTheDocument();
    // The capability link on the row is never rendered.
    expect(document.body.textContent).not.toContain("never-rendered");

    // ONE email control: "Email the customer". The three buttons that all emailed this invoice are gone.
    expect(await screen.findAllByRole("button", { name: "Email the customer" })).toHaveLength(1);
    for (const gone of [/^Send reminder/, /^Email the signed copy/, /^Hide email/, /^Email invoice /, /^Email deposit request/, /^Email the financing link/, /^Email a review request/]) {
      expect(screen.queryByRole("button", { name: gone })).not.toBeInTheDocument();
    }
  });

  it("the walk: Email the customer -> Invoice -> pick a contact + CC -> 'Send invoice NNNN to …' sends it there, and a second send says it is a reminder", async () => {
    vi.spyOn(api, "invoices").mockResolvedValue([inv]);
    vi.spyOn(api, "estimatePaymentInfo").mockResolvedValue(paymentInfo());
    vi.spyOn(api, "accountContacts").mockResolvedValue([
      { id: "c1", accountId: "acct-1", label: "Property manager", email: "pm@example.com", phone: null },
    ] as never);
    vi.spyOn(api, "account").mockResolvedValue({ id: "acct-1", name: "Jane Homeowner", properties: [] } as never);
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    const send = vi.spyOn(api, "sendCustomerEmail").mockResolvedValue({ sent: true, kind: "invoice", to: "pm@example.com", cc: ["jane@example.com"], amount: 2800, reminder: false });

    renderWithProviders(<DrawerHost />, { route: "/financials?invoice=est-1" });

    fireEvent.click(await screen.findByRole("button", { name: "Email the customer" }));
    // The kind: Invoice (with what is due), pre-selected.
    expect(await screen.findByRole("radio", { name: "Invoice EST-2026-0001 — $2,800.00 due" })).toBeChecked();
    // Who: the customer on file by default, the saved contact on offer, and a CC.
    expect(await screen.findByRole("button", { name: "Send invoice EST-2026-0001 to jane@example.com" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Send to"), { target: { value: "pm@example.com" } });
    fireEvent.change(screen.getByLabelText("Add CC"), { target: { value: "jane@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invoice EST-2026-0001 to pm@example.com" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      kind: "invoice", estimateId: "est-1", to: "pm@example.com", cc: ["jane@example.com"],
    })));
    expect(await screen.findByText(/Invoice EST-2026-0001 emailed to pm@example\.com, cc jane@example\.com — \$2,800\.00 due\./)).toBeInTheDocument();
  });

  it("says plainly that a second send to the same address goes out as a friendly reminder", async () => {
    vi.spyOn(api, "invoices").mockResolvedValue([inv]);
    vi.spyOn(api, "estimatePaymentInfo").mockResolvedValue(paymentInfo());
    vi.spyOn(api, "account").mockResolvedValue({ id: "acct-1", name: "Jane Homeowner", properties: [] } as never);
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);
    vi.spyOn(api, "emailDeliveries").mockImplementation(async (q) => q?.estimateId === "est-1"
      ? [{
          id: "d1", provider: "resend", status: "delivered", statusAt: null, to: "jane@example.com", error: null, createdAt: "2026-09-20T12:00:00.000Z",
          providerMessageId: null, subject: "Your invoice", kind: "invoice", estimateNumber: "EST-2026-0001", issuedEstimateId: "est-1", visitId: null,
          leadId: null, customerId: null, estimate: null,
        }]
      : []);

    renderWithProviders(<DrawerHost />, { route: "/financials?invoice=est-1" });

    fireEvent.click(await screen.findByRole("button", { name: "Email the customer" }));
    expect(await screen.findByText(/already went to jane@example\.com on .* sending it again goes out worded as a friendly reminder/)).toBeInTheDocument();
  });

  it("says so when the id is not a live invoice", async () => {
    vi.spyOn(api, "invoices").mockResolvedValue([]);
    vi.spyOn(api, "estimatePaymentInfo").mockResolvedValue(null);

    renderWithProviders(<DrawerHost />, { route: "/financials?invoice=est-gone" });

    expect(await screen.findByText(/No live invoice has this id/)).toBeInTheDocument();
  });

  it("reads an office acceptance (2026-09-24) as 'accepted … by text, recorded by the office', never 'signed'", async () => {
    vi.spyOn(api, "invoices").mockResolvedValue([{ ...inv, signedChannel: "office", acceptedVia: "text" }]);
    vi.spyOn(api, "estimatePaymentInfo").mockResolvedValue(null);

    renderWithProviders(<DrawerHost />, { route: "/financials?invoice=est-1" });

    expect(await screen.findByText(/accepted 9\/12\/2026 by text, recorded by the office/)).toBeInTheDocument();
    expect(screen.queryByText(/signed 9\/12\/2026/)).not.toBeInTheDocument();
  });
});
