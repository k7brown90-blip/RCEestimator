/**
 * One filed invoice copy on the account / property page - and its ONE email control
 * (Kyle, 2026-10-27: "A rule of thumb is there is one tool for one task").
 *
 * The row's own address picker, "Attach photos…" and "Email the signed copy" are the "Email the
 * customer" panel now. A CHANGE-ORDER row keeps its own document (the change-order envelope rules
 * in sendInvoiceEmail), so its Send button says "change order", not "invoice". The payment card
 * under "Take payment…" is mounted without a second panel.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { InvoiceRow } from "./InvoiceRow";
import { api } from "../lib/api";
import type { AccountSummary } from "../lib/types";
import type { PaymentInfo, ReceiptReportOption } from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

const doc = (over: Record<string, unknown> = {}) => ({
  id: "doc-1", type: "estimate_customer", audience: "customer", estimateNumber: "2026-1097", isChangeOrder: true, invoiceNumber: "2026-1093",
  estimateId: "co-1", draftId: null, customerEmail: "tony@example.com", signedByName: "Tony", signedAt: "2026-09-28T19:08:30.000Z",
  createdAt: "2026-09-28T19:08:30.000Z", propertyId: "prop-1", ...over,
}) as unknown as AccountSummary["documents"][number];

const props = [{ id: "prop-1", name: "House", addressLine1: "1 Main St", city: "Smyrna" }];

describe("InvoiceRow - the one email control", () => {
  it("a change-order row emails ITS document through the one panel, and says 'change order' on the button", async () => {
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);
    const send = vi.spyOn(api, "sendCustomerEmail").mockResolvedValue({ sent: true, kind: "invoice", to: "tony@example.com", cc: [], amount: 150, reminder: false });

    renderWithProviders(<InvoiceRow doc={doc()} accountId="acct-1" properties={props} />);

    expect(screen.getAllByRole("button", { name: "Email the customer" })).toHaveLength(1);
    for (const gone of [/^Email the signed copy/, /^Email the signed change order/, /^Attach photos/]) {
      expect(screen.queryByRole("button", { name: gone })).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "Email the customer" }));
    expect(screen.getByRole("radio", { name: /^Change order 2026-1097/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Send change order 2026-1097 to tony@example.com" }));
    // The CHANGE ORDER's own id: the change-order envelope (subject names the invoice root, the attachment is
    // change-order-NNNN.pdf) is applied by the server from the document it is given.
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "invoice", estimateId: "co-1", to: null })));
  });

  it("'Take payment…' opens the payment card WITHOUT a second email control", async () => {
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);
    vi.spyOn(api, "estimatePaymentInfo").mockResolvedValue({
      estimateId: "co-1", number: "2026-1093", billedTotal: 349.86, depositDue: 0, depositRequired: false, documents: [], depositPaid: 0, totalPaid: 0,
      balance: 349.86, depositSatisfied: true, paidInFull: false, payUrl: "", depositPayUrl: "", stripeConfigured: true,
      email: { customerId: "acct-1", customerEmail: "tony@example.com", jobId: null, jobStatus: null, reviewRequestedAt: null }, payments: [],
    } as PaymentInfo);

    renderWithProviders(<InvoiceRow doc={doc({ isChangeOrder: false, estimateNumber: "2026-1093", invoiceNumber: null, estimateId: "root-1" })} accountId="acct-1" properties={props} />);

    fireEvent.click(screen.getByRole("button", { name: "Take payment…" }));
    expect(await screen.findByText(/Take payment — Invoice 2026-1093/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Email the customer" })).toHaveLength(1);
  });

  it("the company copy has no email control at all (the send is offered on the customer copy only)", () => {
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    renderWithProviders(<InvoiceRow doc={doc({ audience: "company" })} accountId="acct-1" properties={props} />);
    expect(screen.queryByRole("button", { name: "Email the customer" })).not.toBeInTheDocument();
  });
});

/*
 * THE RECEIPT ON THE PROPERTY PAGE (Kyle, 2026-10-29): standing on the Property page's invoice row, a
 * paid-in-full ROOT invoice offers "Receipt - Invoice NNNN paid in full" in the same one panel; while
 * owing it is greyed with the reason; a change-order row never offers one (the receipt is the root's).
 */
describe("InvoiceRow - Receipt", () => {
  const reports: ReceiptReportOption[] = [{ id: "completion", kind: "completion", label: "Job Completion Report", date: null, available: true }];
  const rootInfo = (over: Partial<PaymentInfo> = {}) => ({
    estimateId: "root-1", number: "2026-1093", billedTotal: 349.86, depositDue: 0, depositRequired: false, documents: [], depositPaid: 0, totalPaid: 0,
    balance: 349.86, depositSatisfied: true, paidInFull: false, payUrl: "", depositPayUrl: "", stripeConfigured: true,
    email: { customerId: "acct-1", customerEmail: "tony@example.com", jobId: "visit-1", jobStatus: "completed", reviewRequestedAt: null, reports }, payments: [],
    ...over,
  }) as PaymentInfo;
  const rootDoc = () => doc({ isChangeOrder: false, estimateNumber: "2026-1093", invoiceNumber: null, estimateId: "root-1" });
  const quiet = () => {
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);
  };

  it("a paid-in-full root row offers the Receipt (with the job's reports) beside the signed copy, and sends it with the ROOT id", async () => {
    quiet();
    const info = vi.spyOn(api, "estimatePaymentInfo").mockResolvedValue(rootInfo({ paidInFull: true, balance: 0, totalPaid: 349.86 }));
    const send = vi.spyOn(api, "sendCustomerEmail").mockResolvedValue({ sent: true, kind: "receipt", to: "tony@example.com", cc: [] });
    renderWithProviders(<InvoiceRow doc={rootDoc()} accountId="acct-1" properties={props} />);

    await waitFor(() => expect(info).toHaveBeenCalledWith("root-1"));
    fireEvent.click(screen.getByRole("button", { name: "Email the customer" }));
    const receipt = await screen.findByRole("radio", { name: "Receipt — Invoice 2026-1093 paid in full" });
    expect(receipt).toBeEnabled();
    // the row's existing per-document send is kept as it was
    expect(screen.getByRole("radio", { name: "Invoice 2026-1093 — the signed copy" })).toBeInTheDocument();
    fireEvent.click(receipt);
    expect(await screen.findByRole("checkbox", { name: /^Job Completion Report/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Send receipt 2026-1093 to tony@example.com" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "receipt", estimateId: "root-1", reports: ["completion"] })));
  });

  it("while the root invoice is owing the Receipt is shown greyed WITH the reason", async () => {
    quiet();
    const info = vi.spyOn(api, "estimatePaymentInfo").mockResolvedValue(rootInfo());
    renderWithProviders(<InvoiceRow doc={rootDoc()} accountId="acct-1" properties={props} />);

    await waitFor(() => expect(info).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Email the customer" }));
    expect(await screen.findByRole("radio", { name: /^Receipt/ })).toBeDisabled();
    expect(screen.getByText("A receipt can go once the invoice is paid in full.")).toBeInTheDocument();
  });

  it("a change-order row never offers a Receipt, and does not even ask for payment info", async () => {
    quiet();
    const info = vi.spyOn(api, "estimatePaymentInfo").mockResolvedValue(rootInfo({ paidInFull: true, balance: 0 }));
    renderWithProviders(<InvoiceRow doc={doc()} accountId="acct-1" properties={props} />);

    fireEvent.click(screen.getByRole("button", { name: "Email the customer" }));
    expect(screen.queryByRole("radio", { name: /^Receipt/ })).not.toBeInTheDocument();
    expect(info).not.toHaveBeenCalled();
  });
});
