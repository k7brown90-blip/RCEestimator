/**
 * FinancialsPage render smoke test (Phase A, 2026-09-20 "drawers and tab
 * purpose" plan). Financials was "the grab bag" the plan singled out — P&L,
 * invoices, payments, bills, but also purchasing, receipt review and stock
 * landing. Phase 3 (tab separation, build #5, 2026-09-20) cut those three off
 * this page for Purchasing & Stock. This test pins both halves of that: every
 * query the money-only page fires on mount renders without throwing, the
 * Purchases card and receipt review are GONE from here (and their queries are
 * not fired from this page), and the one-release pointer to the new tab is
 * where the cards used to be.
 *
 * Every `api.*` call below was found by grepping FinancialsPage.tsx and its
 * always-mounted children (BalancesSection, TrucksSection, MonthEndSweepCard,
 * JobProfitabilityCard, FinancialsAttention) for unconditional `useQuery` calls.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { FinancialsPage } from "./FinancialsPage";
import { api } from "../lib/api";
import type { FinancialsSummary, ReceiptInsights } from "../lib/api";
import type { InvoiceSummary } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const summary: FinancialsSummary = {
  year: 2026,
  stripeConfigured: true,
  feesAvailable: true,
  // Payroll (2026-09-21): its own column and inside expenses — 1800 = 1300 materials + 120 fees + 380 payroll.
  // Bank (2026-09-21): statement lines classified as expenses — its own column, inside expenses. 1800 = 1300 materials + 120 fees + 380 payroll + 0 bank.
  months: [{ month: 8, invoiced: 4200, collected: 4100, stripeFees: 120, payroll: 380, bank: 0, expenses: 1800, net: 2400 }],
  totals: { invoiced: 4200, collected: 4100, stripeFees: 120, payroll: 380, bank: 0, expenses: 1800, net: 2400 },
  bank: { accounts: 0, unclassified: 0, unclassifiedOut: 0, lastImportAt: null },
  expensesByCategory: [
    { category: "materials", monthly: Array(12).fill(0), total: 1300 },
    { category: "payroll:wages", monthly: Array(12).fill(0), total: 305 },
    { category: "payroll:commissions", monthly: Array(12).fill(0), total: 75 },
  ],
  payrollUnratedHours: 0,
};

const insights: ReceiptInsights = {
  year: 2026,
  receiptsParsed: 3,
  topItems: [],
  priceDrift: [],
};

/** A signed invoice with a balance owed — the shape /invoices rolls up server-side. */
function invoice(overrides: Partial<InvoiceSummary>): InvoiceSummary {
  return {
    id: "inv-1",
    number: "EST-2026-0007",
    revision: 1,
    title: "Panel upgrade",
    signedAt: "2026-09-01T12:00:00.000Z",
    signedChannel: "email",
    sentTo: "jane@example.com",
    remindersSent: 0,
    lastReminderAt: null,
    customer: { id: "acct-1", name: "Jane Homeowner" },
    customerPhone: null,
    customerEmail: "jane@example.com",
    propertyId: "prop-1",
    serviceAddress: "12 Main St, Smyrna",
    job: null,
    billedTotal: 4200,
    totalPaid: 0,
    balance: 4200,
    collected: 0,
    depositDue: 1400,
    paymentStatus: "unpaid",
    discountTotal: 0,
    lastPaidAt: null,
    ...overrides,
  } as InvoiceSummary;
}

function mockEverything(invoices: InvoiceSummary[] = []) {
  vi.spyOn(api, "financialsSummary").mockResolvedValue(summary);
  vi.spyOn(api, "jobProfitability").mockResolvedValue([]);
  vi.spyOn(api, "companyBills").mockResolvedValue([]);
  vi.spyOn(api, "receiptInsights").mockResolvedValue(insights);
  vi.spyOn(api, "paymentsList").mockResolvedValue([]);
  vi.spyOn(api, "invoices").mockResolvedValue(invoices);
  // Purchasing's queries — spied so the assertion below can prove this page no longer fires them.
  vi.spyOn(api, "pendingReceipts").mockResolvedValue([]);
  vi.spyOn(api, "financialsBalances").mockResolvedValue({
    payments: { available: 500, pending: 0 },
    financialAccounts: [],
    available: true,
    readAt: "2026-09-18T12:00:00.000Z",
  });
  vi.spyOn(api, "trucks").mockResolvedValue({ trucks: [], balancesAvailable: true, balancesReason: null, unassigned: null });
  vi.spyOn(api, "financialsSweep").mockResolvedValue({
    asOf: "2026-09-18T12:00:00.000Z",
    stripeAvailable: true,
    stripeReason: null,
    main: null,
    trucks: [],
    destination: null,
    canSweep: false,
    reason: "No excess to sweep.",
    recent: [],
  });
  vi.spyOn(api, "purchaseOrders").mockResolvedValue([]);
  vi.spyOn(api, "receiptsNeedingPo").mockResolvedValue([]);
  vi.spyOn(api, "jobs").mockResolvedValue([]);
  vi.spyOn(api, "accounts").mockResolvedValue([]);
  vi.spyOn(api, "warrantyReceivables").mockResolvedValue({
    rows: [],
    totals: { count: 0, open: 0, overdue: 0, covered: 0, paid: 0, balance: 0 },
  });
  // The bank statements (2026-09-21): registry, statements, the queue, confirmations — all mounted on this page.
  vi.spyOn(api, "bankAccounts").mockResolvedValue([]);
  vi.spyOn(api, "bankStatements").mockResolvedValue([]);
  vi.spyOn(api, "bankLines").mockResolvedValue([]);
  vi.spyOn(api, "bankConfirmations").mockResolvedValue({ year: 2026, coveredMonths: [], bills: [], purchaseOrders: [], unconfirmedBillMonths: 0 });
}

describe("FinancialsPage", () => {
  it("renders every always-mounted money card without throwing, with the P&L totals from the summary", async () => {
    mockEverything();

    renderWithProviders(<FinancialsPage />);

    expect(screen.getByText("Financials")).toBeInTheDocument();
    expect(screen.getByText("Monthly P&L")).toBeInTheDocument();
    // The always-mounted card row (Kyle's "money on hand", trucks, sweep).
    expect(await screen.findByRole("button", { name: /balances/i })).toBeInTheDocument();
    // Anchored: the sweep card's own summary also says "0 trucks", so a bare
    // /trucks/i would match two CollapsibleCard headers.
    expect(screen.getByRole("button", { name: /^trucks/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /month-end sweep/i })).toBeInTheDocument();

    // The P&L total row reads straight off financialsSummary.totals — with one
    // month of data the month row and the total row show the same figures, so
    // each appears twice (once per row) rather than the table being empty.
    expect(await screen.findAllByText("$4,200.00")).toHaveLength(2);
    expect(screen.getAllByText("$2,400.00")).toHaveLength(2);
  });

  it("shows payroll on the P&L: its own column, a wages and a commissions row by category, and the rule in the explainer (2026-09-21)", async () => {
    mockEverything();

    renderWithProviders(<FinancialsPage />);

    // The column, and the month + total rows reading it off the summary.
    // The header is static markup; the rows arrive with the summary query, so wait on a value.
    expect(await screen.findAllByText("$380.00")).toHaveLength(2);
    expect(screen.getByRole("columnheader", { name: "Payroll" })).toBeInTheDocument();
    // Expenses-by-category: wages and commissions are visible apart, so Kyle can see what changed.
    expect(screen.getByText("payroll — wages")).toBeInTheDocument();
    expect(screen.getByText("$305.00")).toBeInTheDocument();
    expect(screen.getByText("payroll — commissions")).toBeInTheDocument();
    expect(screen.getByText("$75.00")).toBeInTheDocument();
    // The only place the rule is written down for Kyle: worked, not paid; counted once.
    expect(screen.getByText(/in the month the hours were/)).toBeInTheDocument();
    expect(screen.getByText(/never added here twice/)).toBeInTheDocument();
    // No unrated hours, no warning.
    expect(screen.queryByText(/no hourly rate on file/)).not.toBeInTheDocument();
  });

  it("says so when payroll hours have no rate on file, rather than booking $0 silently (rule 6)", async () => {
    mockEverything();
    vi.spyOn(api, "financialsSummary").mockResolvedValue({ ...summary, payrollUnratedHours: 6.5 });

    renderWithProviders(<FinancialsPage />);

    expect(await screen.findByText(/6\.5h of payroll time in 2026 has no hourly rate on file and counts as \$0/)).toBeInTheDocument();
  });

  it("no longer hosts purchasing — the Purchases card is gone and a pointer to Purchasing & Stock stands in its place (2026-09-20)", async () => {
    mockEverything();

    renderWithProviders(<FinancialsPage />);

    await screen.findByRole("button", { name: /balances/i });
    expect(screen.queryByRole("button", { name: /^purchases/i })).not.toBeInTheDocument();
    // The review card's own title — the pointer below also says "receipts to review", in prose.
    expect(screen.queryByText("Receipts to review (all accounts)")).not.toBeInTheDocument();
    // The pointer, for one release: Kyle's thumb knows where the card was.
    const pointer = screen.getByRole("link", { name: /purchasing & stock/i });
    expect(pointer).toHaveAttribute("href", "/purchasing");
    // And the page does not fetch purchasing's queues any more — moving the card must not
    // leave this page fetching what it no longer shows.
    expect(api.purchaseOrders).not.toHaveBeenCalled();
    expect(api.receiptsNeedingPo).not.toHaveBeenCalled();
    expect(api.pendingReceipts).not.toHaveBeenCalled();
  });

  it("carries the bank statements (2026-09-21): a Bank column on the P&L, the queue and the missing bills on the attention strip, and the cards", async () => {
    mockEverything();
    vi.spyOn(api, "financialsSummary").mockResolvedValue({
      ...summary,
      months: [{ ...summary.months[0], bank: 250, expenses: 2050, net: 2150 }],
      totals: { ...summary.totals, bank: 250, expenses: 2050, net: 2150 },
      bank: { accounts: 4, unclassified: 2, unclassifiedOut: 315.5, lastImportAt: "2026-09-30T12:00:00.000Z" },
    });
    vi.spyOn(api, "bankLines").mockImplementation(async (params = {}) => (params.classification === "unclassified"
      ? [
        { id: "l1", accountId: "a", accountName: "Chase Checking", accountPurpose: "operating", statementId: "s", postedAt: "2026-09-08T12:00:00.000Z", amount: -250, description: "ACME INSURANCE", bankRef: null, bankType: null, runningBalance: null, payeeKey: "ACME INSURANCE", classification: "unclassified", category: null, transferKind: null, counterpartyAccountId: null, counterpartyName: null, matchedKind: null, matchedId: null, matchedMonth: null, matchedLabel: null, reason: null, hint: null, classifiedBy: null, classifiedAt: null, candidates: { bills: [], purchaseOrders: [], payments: [] } },
        { id: "l2", accountId: "a", accountName: "Chase Checking", accountPurpose: "operating", statementId: "s", postedAt: "2026-09-09T12:00:00.000Z", amount: -65.5, description: "SOME VENDOR", bankRef: null, bankType: null, runningBalance: null, payeeKey: "SOME VENDOR", classification: "unclassified", category: null, transferKind: null, counterpartyAccountId: null, counterpartyName: null, matchedKind: null, matchedId: null, matchedMonth: null, matchedLabel: null, reason: null, hint: null, classifiedBy: null, classifiedAt: null, candidates: { bills: [], purchaseOrders: [], payments: [] } },
      ]
      : []));
    vi.spyOn(api, "bankConfirmations").mockResolvedValue({
      year: 2026, coveredMonths: ["2026-09"], unconfirmedBillMonths: 1, purchaseOrders: [],
      bills: [{ billId: "bill-sw", name: "Software Co", month: "2026-09", scheduled: 49, status: "unconfirmed", line: null, card: null }],
    });

    renderWithProviders(<FinancialsPage />);

    const strip = await screen.findByRole("region", { name: /needs attention/i });
    expect(within(strip).getByText("2 bank lines to classify")).toBeInTheDocument();
    expect(within(strip).getByText("1 bill not seen on a statement")).toBeInTheDocument();
    expect(within(strip).getByText(/Software Co — \$49\.00 scheduled for 2026-09, not on the bank statement/)).toBeInTheDocument();
    // The P&L: the Bank column, the month and total rows reading it, and the honesty line about the queue.
    expect(screen.getByRole("columnheader", { name: "Bank" })).toBeInTheDocument();
    expect(await screen.findAllByText("$250.00")).toHaveLength(2);
    expect(screen.getByText(/2 bank lines \(\$315\.50 out\) are not classified yet and are not in Expenses/)).toBeInTheDocument();
    // The cards are mounted.
    expect(screen.getByRole("button", { name: /bank lines to classify/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^bank statements/i })).toBeInTheDocument();
  });

  it("opens with its own attention strip: money owed, and money that cannot arrive", async () => {
    mockEverything([
      invoice({ id: "inv-owed", number: "EST-2026-0007", balance: 4200 }),
      invoice({
        id: "inv-bounced", number: "EST-2026-0008", balance: 900,
        customer: { id: "acct-2", name: "Bob Bounce" },
        lastBounceAt: "2026-09-18T12:00:00.000Z",
        lastDelivery: { provider: "resend", status: "bounced", statusAt: "2026-09-18T12:00:00.000Z", to: "bob@example.com", error: "mailbox full", createdAt: "2026-09-18T11:59:00.000Z" },
      }),
      // Paid in full — not outstanding, so not in any count.
      invoice({ id: "inv-paid", number: "EST-2026-0009", balance: 0, totalPaid: 500, billedTotal: 500, paymentStatus: "paid" }),
    ]);
    vi.spyOn(api, "warrantyReceivables").mockResolvedValue({
      rows: [
        {
          estimateId: "est-w", number: "EST-2026-0005", title: "Water heater", company: "RELY", claimNumber: "C-1", authNumber: null,
          account: { id: "acct-3", name: "Patricia Warranty" }, covered: 370, paid: 0, balance: 370, status: "overdue",
          daysOutstanding: 41, submittedAt: "2026-08-10T12:00:00.000Z", expectedAt: "2026-09-01T12:00:00.000Z",
          approvedAt: null, receivedAt: null, depositedAt: null, checkNumber: null,
        },
      ],
      totals: { count: 1, open: 1, overdue: 1, covered: 370, paid: 0, balance: 370 },
    } as Awaited<ReturnType<typeof api.warrantyReceivables>>);

    renderWithProviders(<FinancialsPage />);

    const strip = await screen.findByRole("region", { name: /needs attention/i });
    expect(within(strip).getByText("2 invoices outstanding · $5,100.00 owed")).toBeInTheDocument();
    expect(within(strip).getByText("1 invoice email bounced")).toBeInTheDocument();
    expect(within(strip).getByText("1 warranty claim overdue")).toBeInTheDocument();
    // Rows are the money that cannot arrive — the bounced invoice and the overdue claim —
    // never the plain outstanding one, which is this tab's normal state.
    expect(within(strip).getByText(/Bob Bounce — owes \$900\.00, invoice email bounced/)).toBeInTheDocument();
    expect(within(strip).getByText(/RELY owes \$370\.00 on Patricia Warranty/)).toBeInTheDocument();
    expect(within(strip).queryByText(/Jane Homeowner/)).not.toBeInTheDocument();
  });
});
