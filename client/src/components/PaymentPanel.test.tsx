/**
 * UPDATED 2026-10-27 (one email tool): the payment card's email buttons - "Email invoice NNNN - $X
 * due", "Email deposit request", "Email the financing link", "Email a review request" - are the ONE
 * "Email the customer" panel (SendEmailPanel), so the cases below that pinned those buttons now pin
 * the same behaviour through the panel: pick the kind, then the one Send button that names both what
 * and to whom. Deliberately rewritten, not deleted.
 *
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
    // Who the "Email the customer" panel writes to (2026-10-27): the account, the address on file, the job.
    email: { customerId: "acct-1", customerEmail: "tony@example.com", jobId: "visit-1", jobStatus: "completed", reviewRequestedAt: null },
    payments: [],
    ...overrides,
  };
}

/** Open the one panel and pick a kind by its radio. */
async function openPanel(kindName?: RegExp | string) {
  fireEvent.click(await screen.findByRole("button", { name: "Email the customer" }));
  if (kindName) fireEvent.click(await screen.findByRole("radio", { name: kindName }));
}

describe("PaymentPanel", () => {
  it("names the invoice and its balance on the whole-invoice send — never 'final bill', and the old separate email buttons are gone", async () => {
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

    renderWithProviders(<PaymentPanel jobId="visit-1" />);

    await openPanel();
    expect(await screen.findByRole("radio", { name: "Invoice 2026-1093 — $233.24 due" })).toBeChecked();
    expect(screen.queryByRole("button", { name: /final bill/i })).not.toBeInTheDocument();
    // ONE email control: none of the retired buttons, and exactly one Send.
    for (const gone of [/^Email invoice /, /^Email deposit request/, /^Email the financing link/, /^Send the financing link again/, /^Email a review request/, /^Send reminder/, /^Email the signed copy/]) {
      expect(screen.queryByRole("button", { name: gone })).not.toBeInTheDocument();
    }
    expect(screen.getAllByRole("button", { name: /^Send (invoice|deposit|financing|review|message)/ })).toHaveLength(1);
    // The in-person ways are not email and stay.
    expect(screen.getByRole("button", { name: "Balance QR (in person)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review QR (in person)" })).toBeInTheDocument();
  });

  /*
   * Item B (2026-10-01 plan, "manual-sends-archiving-and-one-calendar"): the financing link and
   * the Google review ask, sendable on their own, alongside the invoice send - now kinds of the one panel.
   */
  describe("financing - a kind of the one panel (Kyle, 2026-10-01; one tool 2026-10-27)", () => {
    it("is offered beside the invoice and calls the one email endpoint with the estimate id and the customer on file", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      const send = vi.spyOn(api, "sendCustomerEmail").mockResolvedValue({ sent: true, kind: "financing", to: "tony@example.com", cc: [] });

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      await openPanel("Financing link");
      const button = await screen.findByRole("button", { name: "Send financing link to tony@example.com" });
      fireEvent.click(button);
      // The ROOT invoice id - PaymentPanel never has a change order's id to send with; nothing chosen = the customer on file.
      await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "financing", estimateId: "root-1", to: null })));
      expect(await screen.findByText("Financing link emailed to tony@example.com.")).toBeInTheDocument();
    });

    it("shows when it was last sent, from the thread, before any click", async () => {
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

      await openPanel("Financing link");
      expect(await screen.findByText(/Last sent to tony@example\.com on/)).toBeInTheDocument();
    });

    it("surfaces a refusal instead of swallowing it", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      vi.spyOn(api, "sendCustomerEmail").mockRejectedValue(new Error("No customer email on file — add one to the account first."));

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      await openPanel("Financing link");
      fireEvent.click(await screen.findByRole("button", { name: "Send financing link to tony@example.com" }));
      expect(await screen.findByText("No customer email on file — add one to the account first.")).toBeInTheDocument();
    });
  });

  describe("review request - a kind of the one panel, keyed by the job (Kyle, 2026-10-01)", () => {
    it("is offered and calls the one email endpoint with the job id, when the job is complete", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      const send = vi.spyOn(api, "sendCustomerEmail").mockResolvedValue({ sent: true, kind: "review", to: "tony@example.com", cc: [] });

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      await openPanel("Review request");
      fireEvent.click(await screen.findByRole("button", { name: "Send review request to tony@example.com" }));
      await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "review", visitId: "visit-1" })));
      expect(await screen.findByText("Review request emailed to tony@example.com.")).toBeInTheDocument();
    });

    it("is greyed with the reason, not hidden, when the invoice has no job yet", async () => {
      // InvoiceDrawer / AccountDetailPage / SigningModePage open PaymentPanel by estimate id: the
      // server tells the panel the job (or that there is none) in `email`.
      vi.spyOn(api, "estimatePaymentInfo").mockResolvedValue(info({ email: { customerId: "acct-1", customerEmail: "tony@example.com", jobId: null, jobStatus: null, reviewRequestedAt: null } }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      const send = vi.spyOn(api, "sendCustomerEmail");

      renderWithProviders(<PaymentPanel estimateId="root-1" />);

      await openPanel();
      const radio = await screen.findByRole("radio", { name: "Review request" });
      expect(radio).toBeDisabled();
      expect(screen.getByText(/needs the job - this invoice has no job yet/)).toBeInTheDocument();
      expect(send).not.toHaveBeenCalled();
    });

    it("is greyed with the reason until the job is complete", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({ email: { customerId: "acct-1", customerEmail: "tony@example.com", jobId: "visit-1", jobStatus: "scheduled", reviewRequestedAt: null } }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      renderWithProviders(<PaymentPanel jobId="visit-1" />);
      await openPanel();
      expect(await screen.findByRole("radio", { name: "Review request" })).toBeDisabled();
      expect(screen.getByText(/once the job is marked complete/)).toBeInTheDocument();
    });

    it("surfaces the server's refusal reason (completed / dedupe / 90-day rule) rather than swallowing it", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      vi.spyOn(api, "sendCustomerEmail").mockRejectedValue(new Error("Tony was already asked for a review within the last 90 days."));

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      await openPanel("Review request");
      fireEvent.click(await screen.findByRole("button", { name: "Send review request to tony@example.com" }));
      expect(await screen.findByText("Tony was already asked for a review within the last 90 days.")).toBeInTheDocument();
    });
  });

  describe("deposit request - a kind of the one panel, only while a deposit is due", () => {
    it("is not offered once the deposit is in", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info()); // depositSatisfied: true
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      renderWithProviders(<PaymentPanel jobId="visit-1" />);
      await openPanel();
      expect(await screen.findByRole("radio", { name: /^Invoice 2026-1093/ })).toBeInTheDocument();
      expect(screen.queryByRole("radio", { name: /^Deposit request/ })).not.toBeInTheDocument();
    });

    it("is offered while a deposit is due, and sends the deposit ask", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({ depositPaid: 0, totalPaid: 0, balance: 349.86, depositSatisfied: false }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      const send = vi.spyOn(api, "sendCustomerEmail").mockResolvedValue({ sent: true, kind: "deposit", to: "tony@example.com", cc: [], amount: 116.62 });
      renderWithProviders(<PaymentPanel jobId="visit-1" />);
      await openPanel(/^Deposit request — \$116\.62/);
      fireEvent.click(await screen.findByRole("button", { name: "Send deposit request to tony@example.com" }));
      await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "deposit", estimateId: "root-1" })));
      expect(await screen.findByText(/Deposit request emailed to tony@example\.com — \$116\.62 deposit requested\./)).toBeInTheDocument();
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

  it("sends the invoice through the one panel, to the root, and says what went and what was owed", async () => {
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    const send = vi.spyOn(api, "sendCustomerEmail").mockResolvedValue({ sent: true, kind: "invoice", to: "tony@example.com", cc: [], amount: 233.24, reminder: false });

    renderWithProviders(<PaymentPanel jobId="visit-1" />);

    await openPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Send invoice 2026-1093 to tony@example.com" }));
    // The ROOT's id - a change order has no invoice of its own.
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "invoice", estimateId: "root-1", to: null })));
    expect(await screen.findByText("Invoice 2026-1093 emailed to tony@example.com — $233.24 due.")).toBeInTheDocument();
  });

  it("on a single-document invoice, still names the invoice and drops the document list", async () => {
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({
      documents: [{ id: "root-1", number: "2026-1093", revision: 1, title: "Kitchen circuit diagnostic", kind: "invoice", signedAt: "2026-09-28T17:53:33.000Z", billedTotal: 349.86, depositRequired: true }],
    }));
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

    renderWithProviders(<PaymentPanel jobId="visit-1" />);

    await openPanel();
    expect(await screen.findByRole("radio", { name: "Invoice 2026-1093 — $233.24 due" })).toBeInTheDocument();
    expect(screen.queryByText(/is made up of:/)).not.toBeInTheDocument();
  });

  it("emailPanel={false} leaves the card with NO email control (a host that carries its own panel)", async () => {
    vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    renderWithProviders(<PaymentPanel jobId="visit-1" emailPanel={false} />);
    expect(await screen.findByText(/Take payment — Invoice 2026-1093/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Email the customer" })).not.toBeInTheDocument();
  });

  /*
   * Void a recorded payment (Kyle, 2026-10-08, decision 11): "Void…" on every row of the list,
   * reason required, the row kept and struck through. Administrator only — this panel is the
   * CRM's; the field app has no such control.
   */
  describe("void a recorded payment (Kyle, 2026-10-08)", () => {
    const rows = () => [
      { id: "pay-1", amount: 116.62, method: "check", kind: "deposit", status: "paid", paidAt: "2026-09-28T18:00:00.000Z", payer: "customer", checkNumber: "4411", voidedAt: null, voidReason: null },
      { id: "pay-2", amount: 50, method: "cash", kind: "other", status: "paid", paidAt: "2026-09-29T18:00:00.000Z", payer: "customer", checkNumber: null, voidedAt: "2026-09-30T12:00:00.000Z", voidReason: "Keyed twice" },
      { id: "pay-3", amount: 233.24, method: "stripe", kind: "final", status: "paid", paidAt: "2026-09-30T18:00:00.000Z", payer: "customer", checkNumber: null, voidedAt: null, voidReason: null },
    ];

    it("offers 'Void…' on a cash/check row, asks for the reason, confirms, and posts it", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({ payments: rows() }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      const voidCall = vi.spyOn(api, "voidPayment").mockResolvedValue({ ok: true, id: "pay-1", voidedAt: "2026-10-09T12:00:00.000Z", voidedBy: "human:crm-session", voidReason: "Check was for another job" });
      vi.spyOn(window, "prompt").mockReturnValue("Check was for another job");
      vi.spyOn(window, "confirm").mockReturnValue(true);

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      const buttons = await screen.findAllByRole("button", { name: "Void…" });
      // One per live row (the check and the card); the voided row has none.
      expect(buttons).toHaveLength(2);
      fireEvent.click(buttons[0]);
      await waitFor(() => expect(voidCall).toHaveBeenCalledWith("pay-1", "Check was for another job"));
    });

    it("never posts without a reason — cancelling the prompt, or an empty reason, voids nothing", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({ payments: rows() }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      const voidCall = vi.spyOn(api, "voidPayment").mockResolvedValue({ ok: true, id: "pay-1", voidedAt: "x", voidedBy: "human:crm-session", voidReason: "" });
      const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
      vi.spyOn(window, "alert").mockImplementation(() => {});
      vi.spyOn(window, "confirm").mockReturnValue(true);

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      const [button] = await screen.findAllByRole("button", { name: "Void…" });
      fireEvent.click(button);
      prompt.mockReturnValue("   ");
      fireEvent.click(button);
      expect(voidCall).not.toHaveBeenCalled();
    });

    it("keeps a voided row listed, struck through, with when and why", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({ payments: rows() }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      const note = await screen.findByText(/Voided .*— Keyed twice/);
      expect(note).toBeInTheDocument();
      const struck = screen.getByText(/\$50\.00 · cash/);
      expect(struck.className).toContain("line-through");
    });

    it("greys 'Void…' on a Stripe row with the reason — a card payment is refunded in Stripe", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({ payments: rows() }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      const buttons = await screen.findAllByRole("button", { name: "Void…" });
      const card = buttons[1];
      expect(card).toBeDisabled();
      expect(card).toHaveAttribute("title", expect.stringMatching(/refunded in Stripe/));
      expect(buttons[0]).toBeEnabled();
    });
  });

  /*
   * Pay balance with Synchrony (Kyle, 2026-10-08, decisions 7, 8, 12; Phase 6 Unit 6A): the fee
   * is added here, the Synchrony payment is recorded here, and while the fee is on the invoice
   * every card / QR / cash-check control is greyed WITH the reason. No plan rate ever reaches this
   * app — the server hands the panel finished dollar figures.
   */
  describe("pay balance with Synchrony (Kyle, 2026-10-08)", () => {
    const fee = () => ({
      id: "fee-1", planNumber: "965", planDescription: "11.99% APR until paid in full",
      fee: 7.11, feeBase: 233.24, appliedAt: "2026-10-09T12:00:00.000Z", locked: false, lockedByPaymentId: null,
    });

    it("is greyed with the reason until the 1/3 deposit is collected — no no-deposit financing", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({ depositPaid: 0, totalPaid: 0, balance: 349.86, depositSatisfied: false }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      const options = vi.spyOn(api, "financingOptions");

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      const button = await screen.findByRole("button", { name: "Pay balance with Synchrony" });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", expect.stringMatching(/deposit has not been collected/));
      expect(options).not.toHaveBeenCalled();
    });

    it("picks the plan from the server's figures and adds the fee", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info());
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      vi.spyOn(api, "financingOptions").mockResolvedValue({
        estimateId: "root-1", number: "2026-1093", balance: 233.24, blockedReason: null, applied: null,
        options: [
          { planNumber: "965", description: "11.99% APR until paid in full", fee: 7.11, financed: 240.35 },
          { planNumber: "924", description: "No interest if paid in full within 18 months", fee: 12.36, financed: 245.6 },
        ],
      });
      const add = vi.spyOn(api, "addFinancingFee").mockResolvedValue(fee());

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      fireEvent.click(await screen.findByRole("button", { name: "Pay balance with Synchrony" }));
      expect(await screen.findByText(/Financing fee — Plan 965:/)).toBeInTheDocument();
      expect(screen.getByText("$240.35")).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("Synchrony plan"), { target: { value: "924" } });
      expect(await screen.findByText(/Financing fee — Plan 924:/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Add the financing fee" }));
      await waitFor(() => expect(add).toHaveBeenCalledWith("root-1", "924"));
    });

    it("with the fee on: its own line, the card and cash paths greyed with the reason, and the Synchrony payment recorded with the authorization number", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({ balance: 240.35, balanceBeforeFee: 233.24, financingFee: fee() }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      const record = vi.spyOn(api, "recordPayment").mockResolvedValue({
        id: "pay-9", amount: 240.35, method: "synchrony", status: "paid", note: null, paidAt: "2026-10-09T12:00:00.000Z", createdAt: "2026-10-09T12:00:00.000Z",
        financingPlanNumber: "965", financingAuthNumber: "SYN-1", financingNet: 225.69, financingCut: 14.66,
      });

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      // Its own line beside the balance, and again in the Synchrony block with its base.
      expect(await screen.findAllByText(/Financing fee — Plan 965:/)).toHaveLength(2);
      for (const name of ["Balance QR (in person)", "Record payment (cash/check/Zelle)"]) {
        const b = screen.getByRole("button", { name });
        expect(b, name).toBeDisabled();
        expect(b, name).toHaveAttribute("title", expect.stringContaining("Financing in progress"));
      }
      // The FINAL INVOICE stays sendable (Phase 6 Unit 6C): a financed customer is owed the same
      // "due upon receipt" document; the email carries the fee line and no pay link. It is the Invoice
      // kind of the one panel (2026-10-27).
      fireEvent.click(screen.getByRole("button", { name: "Email the customer" }));
      expect(screen.getByRole("radio", { name: "Invoice 2026-1093 — $240.35 due" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Record Synchrony payment" }));
      const recordButton = screen.getByRole("button", { name: "Record" });
      expect(recordButton).toBeDisabled(); // no authorization number yet
      fireEvent.change(screen.getByLabelText("Synchrony authorization number"), { target: { value: "SYN-1" } });
      expect(recordButton).toBeEnabled();
      fireEvent.click(recordButton);
      await waitFor(() => expect(record).toHaveBeenCalledWith(expect.objectContaining({ method: "synchrony", amount: 240.35, estimateId: "root-1", planNumber: "965", authNumber: "SYN-1" })));
      expect(await screen.findByText(/Synchrony payment recorded — \$240\.35 financed; Synchrony's cut \$14\.66, \$225\.69 funded/)).toBeInTheDocument();
    });

    it("the final invoice can be emailed while financing — it is the document that is due upon receipt", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({ balance: 240.35, balanceBeforeFee: 233.24, financingFee: fee() }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      const send = vi.spyOn(api, "sendCustomerEmail").mockResolvedValue({ sent: true, kind: "invoice", to: "tony@example.com", cc: [], amount: 240.35, reminder: false });

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      await openPanel();
      fireEvent.click(await screen.findByRole("button", { name: "Send invoice 2026-1093 to tony@example.com" }));
      await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "invoice", estimateId: "root-1" })));
    });

    it("while financing the deposit request is greyed WITH the reason, and a second invoice send is not worded as a reminder", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({
        depositPaid: 0, totalPaid: 0, depositSatisfied: false, balance: 357.0, balanceBeforeFee: 349.86, financingFee: fee(),
      }));
      vi.spyOn(api, "emailDeliveries").mockImplementation(async (q) => q?.estimateId === "root-1"
        ? [{
            id: "d9", provider: "resend", status: "sent", statusAt: null, to: "tony@example.com", error: null, createdAt: "2026-09-20T12:00:00.000Z",
            providerMessageId: null, subject: "Your invoice", kind: "invoice", estimateNumber: "2026-1093", issuedEstimateId: "root-1", visitId: null,
            leadId: null, customerId: null, estimate: null,
          }]
        : []);
      renderWithProviders(<PaymentPanel jobId="visit-1" />);
      await openPanel();
      expect(await screen.findByRole("radio", { name: /^Deposit request/ })).toBeDisabled();
      expect(screen.getAllByText(/Financing in progress/).length).toBeGreaterThan(0);
      // Last sent shown, but NOT the reminder warning - a balance being paid through Synchrony is never chased.
      expect(await screen.findByText(/Last sent to tony@example\.com on/)).toBeInTheDocument();
      expect(screen.queryByText(/worded as a friendly reminder/)).not.toBeInTheDocument();
    });

    it("fee on but the deposit no longer in (voided): 'Record Synchrony payment' is greyed with the deposit reason", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({
        depositPaid: 0, totalPaid: 0, depositSatisfied: false, balance: 357.0, balanceBeforeFee: 349.86, financingFee: fee(),
      }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      const button = await screen.findByRole("button", { name: "Record Synchrony payment" });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", expect.stringMatching(/deposit has not been collected/));
      // The reason is also written on the screen, not only in a tooltip.
      expect(screen.getAllByText(/deposit has not been collected yet/).length).toBeGreaterThan(0);
    });

    it("removes the fee with a reason, and never without one", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({ balance: 240.35, balanceBeforeFee: 233.24, financingFee: fee() }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
      const remove = vi.spyOn(api, "removeFinancingFee").mockResolvedValue({ ok: true, id: "fee-1", removedAt: "x", removeReason: "Declined" });
      const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
      vi.spyOn(window, "alert").mockImplementation(() => {});

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      const button = await screen.findByRole("button", { name: "Remove financing fee" });
      fireEvent.click(button);
      prompt.mockReturnValue("  ");
      fireEvent.click(button);
      expect(remove).not.toHaveBeenCalled();
      prompt.mockReturnValue("Declined by Synchrony");
      fireEvent.click(button);
      await waitFor(() => expect(remove).toHaveBeenCalledWith("fee-1", "Declined by Synchrony"));
    });

    it("a LOCKED fee is paid: a deposit voided after the Synchrony payment reopens card, QR and record-payment for the plain balance (2026-10-09)", async () => {
      // $349.86 invoice; $116.62 deposit was voided after the $240.35 Synchrony payment landed — $116.62 is owed, fee included in what was paid.
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({
        depositPaid: 0, totalPaid: 240.35, balance: 116.62, balanceBeforeFee: 109.51, depositSatisfied: true,
        financingFee: { ...fee(), locked: true, lockedByPaymentId: "pay-9" },
      }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      expect(await screen.findByText("Synchrony payment recorded against this fee.")).toBeInTheDocument();
      expect(screen.getByText(/Anything still owed on this invoice is plain invoice money/)).toBeInTheDocument();
      for (const name of ["Balance QR (in person)", "Record payment (cash/check/Zelle)"]) {
        const b = screen.getByRole("button", { name });
        expect(b, name).toBeEnabled();
        expect(b, name).not.toHaveAttribute("title", expect.stringContaining("Financing in progress"));
      }
      expect(screen.queryByRole("button", { name: "Record Synchrony payment" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove financing fee" })).toBeDisabled();
    });

    it("the balance drifted off the fee's base (a change order joined): 'Record Synchrony payment' is greyed with the reason, and the exit", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({ balance: 390.35, balanceBeforeFee: 383.24, financingFee: fee() }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      const button = await screen.findByRole("button", { name: "Record Synchrony payment" });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", expect.stringMatching(/balance changed since the financing fee was added/));
      expect(screen.getByText(/worked on \$233\.24 and the balance after the deposit is now \$383\.24/)).toBeInTheDocument();
      expect(screen.getByText(/Remove the financing fee \(with a reason\) and add it again/)).toBeInTheDocument();
    });

    it("the amount financed is the whole balance and cannot be edited — no partial releases (decision 8)", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({ balance: 240.35, balanceBeforeFee: 233.24, financingFee: fee() }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      fireEvent.click(await screen.findByRole("button", { name: "Record Synchrony payment" }));
      const amount = screen.getByLabelText("Amount financed") as HTMLInputElement;
      expect(amount.value).toBe("240.35");
      expect(amount).toHaveAttribute("readonly");
      expect(amount).toHaveAttribute("title", expect.stringMatching(/no partial releases/));
      expect(screen.getByText(/no partial releases/)).toBeInTheDocument();
    });

    it("once a Synchrony payment is recorded the fee is locked: 'Remove financing fee' greyed with the reason, the row says plan, auth and net", async () => {
      vi.spyOn(api, "jobPaymentInfo").mockResolvedValue(info({
        balance: 0, balanceBeforeFee: -7.11, paidInFull: true, totalPaid: 356.97,
        financingFee: { ...fee(), locked: true, lockedByPaymentId: "pay-9" },
        payments: [{ id: "pay-9", amount: 240.35, method: "synchrony", kind: "final", status: "paid", paidAt: "2026-10-09T12:00:00.000Z", payer: "customer", checkNumber: null, voidedAt: null, voidReason: null, financingPlanNumber: "965", financingAuthNumber: "SYN-1", financingNet: 225.69, financingCut: 14.66 }],
      }));
      vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);

      renderWithProviders(<PaymentPanel jobId="visit-1" />);

      const button = await screen.findByRole("button", { name: "Remove financing fee" });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", expect.stringMatching(/void that payment first/));
      expect(screen.queryByRole("button", { name: "Record Synchrony payment" })).not.toBeInTheDocument();
      expect(screen.getByText(/\$240\.35 · synchrony · final · Plan 965 · auth #SYN-1 · net funded \$225\.69 \(Synchrony's cut \$14\.66\)/)).toBeInTheDocument();
      // The exit is the administrator's void on the row (6B) — still offered.
      expect(screen.getByRole("button", { name: "Void…" })).toBeEnabled();
    });
  });
});
