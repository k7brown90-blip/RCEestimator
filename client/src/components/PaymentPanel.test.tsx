/**
 * The payment panel holds the ONE control that emails the whole invoice (2026-09-29).
 *
 * Kyle, after the Hoover job: "The invoices for Tony Hoover that were sent yesterday did not add
 * into a single invoice to be sent with the total diagnostics amount plus resolutions (fix)."
 *
 * The money had rolled up correctly the whole time. What went wrong was the NAMES: this button
 * was "Email final bill" — a stage of a job, not the thing it sends — while the invoice drawer's
 * per-document send was "Email invoice…". Kyle went looking for a combined invoice under the word
 * "invoice", pressed the wrong one, and got one frozen document.
 *
 * These pin the words. A rename back to something that does not name the invoice should fail here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { PaymentPanel } from "./PaymentPanel";
import { api } from "../lib/api";
import type { PaymentInfo } from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The Hoover shape: one invoice, two documents — a diagnostic and its resolutions change order. */
function info(overrides: Partial<PaymentInfo> = {}): PaymentInfo {
  return {
    estimateId: "root-1",
    number: "2026-1093",
    billedTotal: 349.86,
    depositDue: 116.62,
    depositRequired: true,
    documents: [
      { id: "root-1", number: "2026-1093", revision: 1, title: "Kitchen circuit diagnostic", kind: "invoice", signedAt: "2026-09-28T17:53:33.000Z", billedTotal: 199.86, depositRequired: true },
      { id: "co-1", number: "2026-1097", revision: 1, title: "Resolutions — kitchen circuit", kind: "change_order", signedAt: "2026-09-28T19:08:30.000Z", billedTotal: 150, depositRequired: false },
    ],
    depositPaid: 116.62,
    totalPaid: 116.62,
    balance: 233.24,
    depositSatisfied: true,
    paidInFull: false,
    payUrl: "https://example.test/pay/tok",
    depositPayUrl: "https://example.test/pay/tok?type=deposit",
    stripeConfigured: true,
    payments: [],
    ...overrides,
  };
}

describe("PaymentPanel", () => {
  it("names the invoice and its balance on the whole-invoice send — never 'final bill'", async () => {
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());

    renderWithProviders(<PaymentPanel jobId="visit-1" />);

    expect(await screen.findByRole("button", { name: "Email invoice 2026-1093 — $233.24 due" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /final bill/i })).not.toBeInTheDocument();
  });

  it("says the two documents are ONE invoice, and lists what it is made of", async () => {
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());

    renderWithProviders(<PaymentPanel jobId="visit-1" />);

    // The heading is what stops the list reading as two separate bills.
    expect(await screen.findByText("Invoice 2026-1093 is made up of:")).toBeInTheDocument();
    expect(screen.getByText("Invoice 2026-1093 — Kitchen circuit diagnostic")).toBeInTheDocument();
    expect(screen.getByText("Change order 2026-1097 — Resolutions — kitchen circuit")).toBeInTheDocument();
  });

  it("confirms the send in the same words as the button, naming how many documents went", async () => {
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
    const send = vi.spyOn(api, "emailBalanceRequest").mockResolvedValue({ ok: true, to: "tony@example.com", amount: 233.24 });

    renderWithProviders(<PaymentPanel jobId="visit-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Email invoice 2026-1093 — $233.24 due" }));
    // The ROOT's id — a change order has no invoice of its own.
    await waitFor(() => expect(send).toHaveBeenCalledWith("root-1"));
    expect(await screen.findByText(/Invoice 2026-1093 emailed to tony@example.com — all 2 documents, \$233\.24 due\./)).toBeInTheDocument();
  });

  it("on a single-document invoice, still names the invoice and drops the document list", async () => {
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({
      documents: [{ id: "root-1", number: "2026-1093", revision: 1, title: "Kitchen circuit diagnostic", kind: "invoice", signedAt: "2026-09-28T17:53:33.000Z", billedTotal: 349.86, depositRequired: true }],
    }));

    renderWithProviders(<PaymentPanel jobId="visit-1" />);

    expect(await screen.findByRole("button", { name: "Email invoice 2026-1093 — $233.24 due" })).toBeInTheDocument();
    expect(screen.queryByText(/is made up of:/)).not.toBeInTheDocument();
  });
});
