/**
 * The invoice drawer: the GET /invoices row plus PaymentPanel, the reminder, the PDF copies and
 * the email-the-invoice control.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../test/renderWithProviders";
import { DrawerHost } from "./DrawerHost";
import { api } from "../../lib/api";
import type { InvoiceSummary } from "../../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const inv: InvoiceSummary = {
  remindersSent: 1, lastReminderAt: "2026-09-15T12:00:00.000Z", id: "est-1", number: "EST-2026-0001", revision: 1, title: "Panel upgrade",
  customer: { id: "acct-1", name: "Jane Homeowner" }, customerPhone: "615-555-0101", customerEmail: "jane@example.com", propertyId: "prop-1",
  job: { id: "visit-1", jobType: "Panel upgrade", purpose: null, status: "scheduled", scheduledStart: "2026-09-22T13:00:00.000Z" },
  serviceAddress: "12 Main St, Smyrna", signedAt: "2026-09-12T12:00:00.000Z", signedChannel: "email", sentAt: "2026-09-12T12:00:00.000Z",
  sentTo: "jane@example.com", billedTotal: 4200, depositDue: 1400, totalPaid: 1400, discountTotal: 0, collected: 1400, balance: 2800,
  lastPaidAt: "2026-09-13T12:00:00.000Z", paymentStatus: "deposit_paid", payToken: "never-rendered",
};

describe("InvoiceDrawer", () => {
  it("shows the invoice's contact, signing and money lines with the reminder and PDF actions", async () => {
    vi.spyOn(api, "invoices").mockResolvedValue([inv]);
    vi.spyOn(api, "estimatePaymentInfo").mockResolvedValue(null);
    vi.spyOn(api, "sendPaymentReminder").mockResolvedValue({ ok: true, to: "jane@example.com", amount: 2800 });

    renderWithProviders(<DrawerHost />, { route: "/financials?invoice=est-1" });

    expect(await screen.findByRole("dialog", { name: "Invoice EST-2026-0001" })).toBeInTheDocument();
    expect(screen.getByText(/615-555-0101 · jane@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/signed 9\/12\/2026 from the emailed link/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Customer copy (PDF)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Our copy (PDF)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Job: Panel upgrade/ })).toBeInTheDocument();
    // The capability link on the row is never rendered.
    expect(document.body.textContent).not.toContain("never-rendered");

    fireEvent.click(screen.getByRole("button", { name: "Send reminder" }));
    await waitFor(() => expect(api.sendPaymentReminder).toHaveBeenCalledWith("est-1"));
    expect(await screen.findByText(/Reminder emailed to jane@example.com/)).toBeInTheDocument();
  });

  it("says so when the id is not a live invoice", async () => {
    vi.spyOn(api, "invoices").mockResolvedValue([]);
    vi.spyOn(api, "estimatePaymentInfo").mockResolvedValue(null);

    renderWithProviders(<DrawerHost />, { route: "/financials?invoice=est-gone" });

    expect(await screen.findByText(/No live invoice has this id/)).toBeInTheDocument();
  });
});
