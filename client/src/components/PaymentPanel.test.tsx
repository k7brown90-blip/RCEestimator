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
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

    renderWithProviders(<PaymentPanel jobId="visit-1" />);

    expect(await screen.findByRole("button", { name: "Email invoice 2026-1093 — $233.24 due" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /final bill/i })).not.toBeInTheDocument();
  });

  /*
   * Item B (2026-10-01 plan, "manual-sends-archiving-and-one-calendar"): the financing link and
   * the Google review ask, sendable on their own, alongside the invoice send. Mutation-checked:
   * deleting either button from PaymentPanel.tsx fails the matching "present" test below.
   */
  describe("financing — standalone send (Kyle, 2026-10-01)", () => {
    it("is present beside the invoice send and calls the financing endpoint with the estimate id", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      const send = vi.spyOn(api, "emailFinancing").mockResolvedValue({ ok: true, to: "tony@example.com" });

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      const button = await screen.findByRole("button", { name: "Email the financing link" });
      fireEvent.click(button);
      // The ROOT invoice id — PaymentPanel never has a change order's id to send with.
      await waitFor(() => expect(send).toHaveBeenCalledWith("root-1"));
    });

    it("shows when it was last sent, and relabels to a deliberate re-send once it has gone", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
      vi.spyOn(api, "emailDeliveries").mockImplementation(async (q) =>
        q?.estimateId === "root-1"
          ? [{
              id: "d1", provider: "resend", status: "sent", statusAt: null,
              to: "tony@example.com", error: null, createdAt: "2026-09-20T12:00:00.000Z",
              providerMessageId: null, subject: "Financing", kind: "financing",
              estimateNumber: "2026-1093", issuedEstimateId: "root-1", visitId: null,
              leadId: null, customerId: null, estimate: null,
            }]
          : [],
      );

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      // The last-sent line reads the existing delivery before any click.
      expect(await screen.findByText(/Financing last emailed to tony@example\.com on/)).toBeInTheDocument();
      // And the button already reads as a deliberate re-send, not the first-time label.
      expect(screen.getByRole("button", { name: "Send the financing link again" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Email the financing link" })).not.toBeInTheDocument();
    });

    it("relabels after a successful send so a second press is deliberate", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      vi.spyOn(api, "emailFinancing").mockResolvedValue({ ok: true, to: "tony@example.com" });

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      fireEvent.click(await screen.findByRole("button", { name: "Email the financing link" }));
      expect(await screen.findByText("Financing link emailed to tony@example.com.")).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Send the financing link again" })).toBeInTheDocument();
    });

    it("surfaces a refusal instead of swallowing it", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      vi.spyOn(api, "emailFinancing").mockRejectedValue(new Error("No customer email on file — add one to the account first."));

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      fireEvent.click(await screen.findByRole("button", { name: "Email the financing link" }));
      expect(await screen.findByText("No customer email on file — add one to the account first.")).toBeInTheDocument();
    });
  });

  describe("review request — standalone send, keyed by the job (Kyle, 2026-10-01)", () => {
    it("is present and calls the review endpoint with the job id, when the panel has one", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      const send = vi.spyOn(api, "emailReviewRequest").mockResolvedValue({ ok: true, to: "tony@example.com" });

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      const button = await screen.findByRole("button", { name: "Email a review request" });
      expect(button).not.toBeDisabled();
      fireEvent.click(button);
      await waitFor(() => expect(send).toHaveBeenCalledWith("visit-1"));
      expect(await screen.findByRole("button", { name: "Send the review request again" })).toBeInTheDocument();
    });

    it("is greyed with the reason, not hidden, when the panel only has an estimate id", async () => {
      // InvoiceDrawer / AccountDetailPage / SigningModePage open PaymentPanel this way —
      // no jobId, because a drawer opened off an invoice doesn't carry one.
      vi.spyOn(api, "estimatePaymentInfo").mockResolvedValue(info());
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      const send = vi.spyOn(api, "emailReviewRequest");

      renderWithProviders(<PaymentPanel estimateId="root-1" />);

      const button = await screen.findByRole("button", { name: "Email a review request" });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", expect.stringContaining("needs an open JOB"));
      expect(send).not.toHaveBeenCalled();
    });

    it("surfaces the server's refusal reason (completed / dedupe / 90-day rule) rather than swallowing it", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      vi.spyOn(api, "emailReviewRequest").mockRejectedValue(new Error("This job is not marked complete yet."));

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      fireEvent.click(await screen.findByRole("button", { name: "Email a review request" }));
      expect(await screen.findByText("This job is not marked complete yet.")).toBeInTheDocument();
    });
  });

  it("says the two documents are ONE invoice, and lists what it is made of", async () => {
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

    renderWithProviders(<PaymentPanel jobId="visit-1" />);

    // The heading is what stops the list reading as two separate bills.
    expect(await screen.findByText("Invoice 2026-1093 is made up of:")).toBeInTheDocument();
    expect(screen.getByText("Invoice 2026-1093 — Kitchen circuit diagnostic")).toBeInTheDocument();
    expect(screen.getByText("Change order 2026-1097 — Resolutions — kitchen circuit")).toBeInTheDocument();
  });

  it("confirms the send in the same words as the button, naming how many documents went", async () => {
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
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
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

    renderWithProviders(<PaymentPanel jobId="visit-1" />);

    expect(await screen.findByRole("button", { name: "Email invoice 2026-1093 — $233.24 due" })).toBeInTheDocument();
    expect(screen.queryByText(/is made up of:/)).not.toBeInTheDocument();
  });
});
