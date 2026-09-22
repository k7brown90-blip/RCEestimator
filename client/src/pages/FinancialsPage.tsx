/**
 * Financials — the dedicated money tab. (Kyle, 2026-08-25: "a new tab dedicated
 * to financial tracking of each job that will produce necessary accounting
 * reports for the company, I will enter all company bills and rolling costs and
 * revenue in here.")
 *
 * Four reports, all of which he asked for by name: monthly P&L, expenses by
 * category, job profitability, and the tax-year CSV export. Revenue shows both
 * invoiced (signed work — accrual) and collected (payments — cash) because they
 * answer different questions and hiding one would make the other look wrong.
 *
 * Kyle, 2026-09-07: the job-profitability and payments cards stopped being lists.
 * "I don't want this turning into a massive run on list. We need to replace this
 * with a simple search bar. It finds the account. Account is selected. The card
 * displays addresses. Address is selected. Jobs at that address are displayed.
 * Job can be selected for exact details, receipts, and P.O.'s. All info stays in
 * the card and doesn't open a new window or tab." Payments received works the
 * same way, with the outstanding invoices pinned above the search — and the
 * Invoices tab folded in here ("merging invoices into the financials tab").
 *
 * MONEY ONLY (tab separation, 2026-09-20). Kyle: "No more merging, instead we need to
 * review what can be separated so each tab is very clear what its for." This tab had
 * become the grab bag — P&L, invoices, payments and bills, but also purchasing, receipt
 * review and stock landing. Those three left for Purchasing & Stock (`PurchasingPage`);
 * a pointer sits where the cards were, for one release. What stays is money: balances,
 * the sweep, the P&L, materials by month, expenses, job profitability, what the receipts
 * say about prices, bills, payments and invoices, warranty receivables — and, since
 * 2026-09-21, the BANK STATEMENTS (Kyle, 2026-09-20: "I can manually upload the bank
 * statements each month from each account"): the four Chase balances beside Stripe's on the
 * Balances card, the queue of statement lines to classify, and the imports themselves. A
 * statement is money — cash on hand and what left it — so it lives here, not on Purchasing.
 */

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { PhotoLightbox } from "../components/PhotoLightbox";
import { api, fetchProtectedObjectUrl } from "../lib/api";
import type { CompanyBillRow, JobProfitRow, JobReceiptRow, PaymentRow, WarrantyReceivableRow } from "../lib/api";
import { MATERIAL_SOURCE_LABEL, type InvoiceSummary, type MaterialsByMonth } from "../lib/types";
import { money } from "../lib/utils";
import { AttentionStrip } from "../components/AttentionStrip";
import { BounceBadge } from "../components/BounceBadge";
import { DeliveryChip } from "../components/DeliveryChip";
import { OpenDrawerButton } from "../components/drawers/OpenDrawerButton";
import { useDrawerParams } from "../lib/drawers";
import { BalancesStrip, TrucksCard } from "../components/TrucksCards";
import { MonthEndSweepCard } from "../components/MonthEndSweepCard";
import { CollapsibleCard } from "../components/CollapsibleCard";
import { BankQueueCard, BankStatementsCard, BillConfirmationNote } from "../components/BankCards";
import type { BankConfirmations } from "../lib/types";

/** Expenses-by-category row labels: bill:x -> "bills — x", payroll:x -> "payroll — x", bank:x -> "bank — x", stripe_fees -> "Stripe fees". */
function categoryLabel(category: string): string {
  if (category === "stripe_fees") return "Stripe fees";
  if (category.startsWith("bill:")) return category.replace("bill:", "bills — ");
  if (category.startsWith("payroll:")) return category.replace("payroll:", "payroll — ");
  if (category.startsWith("bank:")) return category.replace("bank:", "bank — ").replace("_", " ");
  return category;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Rows a card shows before "Show more" — a card never grows on its own. */
const PAGE_SIZE = 8;

export function FinancialsPage() {
  const queryClient = useQueryClient();
  const [year, setYear] = useState(new Date().getFullYear());

  const { data: summary } = useQuery({
    queryKey: ["financials", year],
    queryFn: () => api.financialsSummary(year),
  });
  const { data: profitability } = useQuery({
    queryKey: ["jobProfitability", year],
    queryFn: () => api.jobProfitability(year),
  });
  const { data: bills } = useQuery({ queryKey: ["companyBills"], queryFn: () => api.companyBills() });
  const { data: insights } = useQuery({
    queryKey: ["receiptInsights", year],
    queryFn: () => api.receiptInsights(year),
  });
  const { data: payments } = useQuery({
    queryKey: ["payments", year],
    queryFn: () => api.paymentsList(year),
  });
  // Every signed invoice with its money rolled up server-side (Kyle, 2026-09-07:
  // the Invoices tab now lives inside the Payments received card).
  const { data: invoices } = useQuery({ queryKey: ["invoices"], queryFn: api.invoices });
  // What the bank statements confirm — and which scheduled bill-months they should have and did not (2026-09-21).
  const { data: bankConfirmations } = useQuery({ queryKey: ["bank-confirmations", year], queryFn: () => api.bankConfirmations(year) });

  return (
    <div className="space-y-6">
      <PageHeader title="Financials" subtitle="Money only — the P&L, invoices and payments, bills, fees, and the accounting reports" />

      <FinancialsAttention invoices={invoices ?? []} confirmations={bankConfirmations} />

      {/* Kyle, 2026-09-10: "I like the collapsible idea it will be easier to keep the clutter
          down." Every card above the year selector folds to a header + one-line summary
          (CollapsibleCard); open by default only when it holds something that needs a look. */}

      {/* ── Money on hand (Kyle, 2026-09-09): Payments balance + each truck's financial account ── */}
      <BalancesSection />

      {/* ── Month-end sweep (Kyle, 2026-09-09): excess over the float → Chase, on a click, never scheduled ── */}
      <MonthEndSweepCard />

      {/* The Purchases card and "Receipts to review" stood here until 2026-09-20. A pointer for
          one release — Kyle is the only user and his thumb knows where they were. Delete this
          block once he has landed on the new tab a few times. */}
      <p data-moved-pointer className="rounded-lg border border-dashed border-rce-border px-3 py-2 text-xs text-rce-muted">
        Purchases, receipts to review and P.O. landing moved to{" "}
        <Link to="/purchasing" className="font-medium text-rce-accent hover:underline">Purchasing &amp; Stock →</Link>
      </p>

      {/* ── Trucks (Kyle, 2026-09-09): per-truck card spend this month; the ledger lives at /trucks ── */}
      <TrucksSection />

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-secondary text-sm" onClick={() => setYear((y) => y - 1)}>← {year - 1}</button>
        <span className="text-lg font-bold">{year}</span>
        <button className="btn btn-secondary text-sm" onClick={() => setYear((y) => y + 1)}>{year + 1} →</button>
        <a
          className="btn btn-secondary ml-auto text-sm"
          href={`/api/financials/export?year=${year}`}
          onClick={(e) => {
            // Session-protected download: fetch with the token, hand the file over.
            e.preventDefault();
            const token = localStorage.getItem("rce_token");
            void fetch(`/api/financials/export?year=${year}`, {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            })
              .then((r) => r.blob())
              .then((blob) => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `rce-financials-${year}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              });
          }}
        >
          Export tax-year CSV
        </a>
      </div>

      {summary && !summary.stripeConfigured && (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          Stripe is not configured on the server yet — invoices go out without a "Pay online" button.
          Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET on the Railway service to turn it on.
        </p>
      )}

      {/* ── Report 1: monthly P&L ── */}
      <section className="card p-4">
        <h2 className="text-lg font-semibold">Monthly P&amp;L</h2>
        {/* Kyle, 2026-09-08: "Does it track the payment on the month it is paid or apply it
            toward the month that it was issued?" — say which month each column lands in. */}
        <p className="mb-2 text-xs text-rce-muted">
          Invoiced lands in the month the estimate was <b>signed</b> (accrual). Collected lands in the month the
          payment was <b>received</b> (cash) — a job signed in August and paid in September shows in both months, once each.
          Expenses = card charges (the month of the swipe) + amounts typed on a P.O. marked not-on-card + company bills + Stripe fees + payroll + bank lines classified as expenses.
          A receipt is proof, never money — it changes nothing here. Net = invoiced − expenses.
          Stripe fees are the processing fees Stripe took that month — their own column, and already inside Expenses; Collected is the gross amount the customer paid.
          Payroll = every technician's hours at the rate they were paid (shift time plus any job time the day clock missed, overtime past 40 hours in a Monday–Sunday week) + commissions,
          in the month the hours were <b>worked</b> and the commission was <b>earned</b> — not a pay date. It is its own column and already inside Expenses.
          A flagged clock nobody has confirmed counts nothing until it is answered. Job profitability below shows the same hours per job; they are never added here twice.
          Bank = statement lines you classified as new money out (ACH, autopay, checks, debit card out of Chase), in the month posted — its own column and already inside Expenses.
          A statement line that is a transfer (a set-aside into savings, anything to or from Stripe) or already counted (payroll, a P.O.'s typed amount, a scheduled bill, a payment you recorded) adds nothing here: the P&L has that money by the other route.
          Money still owed is per invoice (billed − paid), not per month — see Outstanding below.
        </p>
        {summary && (summary.bank?.unclassified ?? 0) > 0 && (
          <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {summary.bank!.unclassified} bank line{summary.bank!.unclassified === 1 ? "" : "s"} ({money(summary.bank!.unclassifiedOut)} out) {summary.bank!.unclassified === 1 ? "is" : "are"} not classified yet and {summary.bank!.unclassified === 1 ? "is" : "are"} not in Expenses — classify {summary.bank!.unclassified === 1 ? "it" : "them"} in the Bank lines card below.
          </p>
        )}
        {summary && (summary.payrollUnratedHours ?? 0) > 0 && (
          <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {summary.payrollUnratedHours}h of payroll time in {year} has no hourly rate on file and counts as $0 — set the rate on the Team tab.
          </p>
        )}
        {summary && summary.feesAvailable === false && (
          <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Stripe fees are not in this table yet — {summary.feesReason ?? "Stripe could not be read."}
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rce-border text-left text-xs uppercase text-rce-soft">
                <th className="py-1 pr-2">Month</th>
                <th className="py-1 pr-2 text-right">Invoiced</th>
                <th className="py-1 pr-2 text-right">Collected</th>
                <th className="py-1 pr-2 text-right">Stripe fees</th>
                <th className="py-1 pr-2 text-right">Payroll</th>
                <th className="py-1 pr-2 text-right">Bank</th>
                <th className="py-1 pr-2 text-right">Expenses</th>
                <th className="py-1 text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {(summary?.months ?? []).map((m) => (
                <tr key={m.month} className="border-b border-rce-border/50">
                  <td className="py-1 pr-2">{MONTHS[m.month]}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{money(m.invoiced)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{money(m.collected)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-rce-muted">{money(m.stripeFees ?? 0)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-rce-muted">{money(m.payroll ?? 0)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-rce-muted">{money(m.bank ?? 0)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{money(m.expenses)}</td>
                  <td className={`py-1 text-right font-medium tabular-nums ${m.net < 0 ? "text-red-600" : ""}`}>
                    {money(m.net)}
                  </td>
                </tr>
              ))}
              {summary && (
                <tr className="font-semibold">
                  <td className="py-1 pr-2">Total</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{money(summary.totals.invoiced)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{money(summary.totals.collected)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-rce-muted">{money(summary.totals.stripeFees ?? 0)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-rce-muted">{money(summary.totals.payroll ?? 0)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-rce-muted">{money(summary.totals.bank ?? 0)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{money(summary.totals.expenses)}</td>
                  <td className={`py-1 text-right tabular-nums ${summary.totals.net < 0 ? "text-red-600" : ""}`}>
                    {money(summary.totals.net)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Bank statements (Kyle, 2026-09-20): the queue is the product — what the importer could not
          classify is what keeps the P&L from being "everything that touched the Stripe card". ── */}
      <BankQueueCard year={year} />
      <BankStatementsCard />

      {/* ── Materials: bought / used / inventory value (Kyle, 2026-09-09, Build 4) ── */}
      <MaterialsCard year={year} materials={summary?.materials} />

      {/* ── Report 2: expenses by category ── */}
      <section className="card p-4">
        <h2 className="text-lg font-semibold">Expenses by category</h2>
        <p className="mb-2 text-xs text-rce-muted">
          Card charges and typed P.O. amounts by kind (materials, gas, maintenance, tools, permits), company bills, Stripe processing fees, payroll (wages and commissions), and bank lines classified as expenses — the Schedule C shape.
        </p>
        {(summary?.expensesByCategory ?? []).length === 0 && (
          <p className="text-sm text-rce-muted">No expenses recorded for {year} yet.</p>
        )}
        <ul className="space-y-1">
          {(summary?.expensesByCategory ?? []).map((c) => (
            <li key={c.category} className="flex items-center justify-between gap-3 rounded-lg border border-rce-border px-3 py-2 text-sm">
              <span className="capitalize">{categoryLabel(c.category)}</span>
              <span className="font-medium tabular-nums">{money(c.total)}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Report 3: job profitability — search → account → address → job (Kyle, 2026-09-07) ── */}
      <JobProfitabilityCard year={year} rows={profitability ?? []} />

      {/* ── Receipt insights (Phase 5): the price book learns — by showing, never setting ── */}
      <section className="card p-4">
        <h2 className="text-lg font-semibold">What the receipts say</h2>
        <p className="mb-2 text-xs text-rce-muted">
          Read from {insights?.receiptsParsed ?? 0} itemized receipt(s) in {year}. Most-purchased
          items, and where street prices have drifted from the price book — the book only changes
          when you change it.
        </p>
        {(insights?.topItems ?? []).length === 0 ? (
          <p className="text-sm text-rce-muted">
            No itemized receipts yet — as receipts with line items come in (photo uploads are
            auto-read), the most-used materials surface here.
          </p>
        ) : (
          <>
            <h3 className="text-sm font-semibold text-rce-soft">Most-purchased items</h3>
            <ul className="mt-1 space-y-1">
              {(insights?.topItems ?? []).slice(0, 10).map((item) => (
                <li key={item.name} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rce-border px-3 py-1.5 text-sm">
                  <span>{item.name} <span className="text-xs text-rce-muted">×{item.totalQty} across {item.receipts} receipt(s)</span></span>
                  <span className="text-xs tabular-nums text-rce-muted">
                    {item.avgUnitCost !== null ? `avg ${money(item.avgUnitCost)}/unit` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {(insights?.priceDrift ?? []).length > 0 && (
          <>
            <h3 className="mt-3 text-sm font-semibold text-amber-800">Price drift vs the book (≥5%)</h3>
            <ul className="mt-1 space-y-1">
              {(insights?.priceDrift ?? []).map((d) => (
                <li key={`${d.receiptItem}-${d.bookItem}`} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm">
                  <span className="font-medium">{d.bookItem}</span>{" "}
                  <span className={`font-semibold tabular-nums ${d.driftPct > 0 ? "text-red-700" : "text-green-700"}`}>
                    {d.driftPct > 0 ? "+" : ""}{d.driftPct}%
                  </span>
                  <p className="text-xs text-rce-muted">
                    Book ({d.supplier}): {money(d.bookCost)} · receipts avg: {money(d.receiptAvgCost)} — update the workbook if the street price stuck.
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ── Company bills ── */}
      <BillsCard bills={bills ?? []} confirmations={bankConfirmations} onChange={() => {
        void queryClient.invalidateQueries({ queryKey: ["companyBills"] });
        void queryClient.invalidateQueries({ queryKey: ["financials", year] });
        void queryClient.invalidateQueries({ queryKey: ["bank-confirmations"] });
        void queryClient.invalidateQueries({ queryKey: ["bank-lines"] });
      }} />

      {/* ── Payments + invoices (Kyle, 2026-09-07: outstanding list, then search → account → property → job) ── */}
      <PaymentsCard
        year={year}
        payments={payments ?? []}
        invoices={invoices ?? []}
        onChange={() => {
          void queryClient.invalidateQueries({ queryKey: ["payments", year] });
          void queryClient.invalidateQueries({ queryKey: ["financials", year] });
          void queryClient.invalidateQueries({ queryKey: ["invoices"] });
          void queryClient.invalidateQueries({ queryKey: ["jobProfitability", year] });
          void queryClient.invalidateQueries({ queryKey: ["warrantyReceivables"] });
        }}
      />

      {/* ── Warranty receivables (Kyle, 2026-09-10): the warranty company's share of each covered
          job, chased separately from the homeowner — who is never reminded about it. ── */}
      <WarrantyReceivablesCard />
    </div>
  );
}

// ─── The tab's question: which money is owed, and which can't arrive? ─────────

/** An invoice email that bounced and has not been delivered since. */
function invoiceBounced(inv: InvoiceSummary): boolean {
  if (!inv.lastBounceAt) return false;
  const delivered = inv.lastDelivery?.status === "delivered" ? inv.lastDelivery.createdAt : null;
  return !(delivered && new Date(delivered) > new Date(inv.lastBounceAt));
}

/**
 * Financials' attention strip (2026-09-20). Money owed is this tab's normal state, so it is a
 * count, not a row. The rows are money that CANNOT arrive as things stand: an invoice whose
 * email bounced (the customer never got the bill) and a warranty company's share past due.
 * Both queues are ones this page already fetches — `/invoices` and `/warranty-receivables`.
 */
function FinancialsAttention({ invoices, confirmations }: { invoices: InvoiceSummary[]; confirmations: BankConfirmations | undefined }) {
  const { data: warranty } = useQuery({ queryKey: ["warrantyReceivables"], queryFn: api.warrantyReceivables });
  // The bank queue (2026-09-21): lines the importer could not classify are not in Expenses until Kyle rules on them.
  const { data: bankQueue = [] } = useQuery({ queryKey: ["bank-lines", "unclassified"], queryFn: () => api.bankLines({ classification: "unclassified" }) });
  const drawers = useDrawerParams();
  const outstanding = invoices.filter((inv) => inv.balance > 0.009);
  const owed = outstanding.reduce((sum, inv) => sum + inv.balance, 0);
  const bounced = outstanding.filter(invoiceBounced);
  const overdue = (warranty?.rows ?? []).filter((r) => r.status === "overdue");
  // The prize (PUNCHLIST A6): a scheduled bill a statement covers but never shows — a bill you may have stopped paying.
  const missingBills = (confirmations?.bills ?? []).filter((b) => b.status === "unconfirmed");
  return (
    <AttentionStrip
      chips={[
        { key: "owed", label: `${outstanding.length} invoice${outstanding.length === 1 ? "" : "s"} outstanding · ${money(owed)} owed`, count: outstanding.length },
        { key: "bounced", label: `${bounced.length} invoice email${bounced.length === 1 ? "" : "s"} bounced`, count: bounced.length, tone: "red" },
        { key: "warranty", label: `${overdue.length} warranty claim${overdue.length === 1 ? "" : "s"} overdue`, count: overdue.length, tone: "red" },
        { key: "bank-queue", label: `${bankQueue.length} bank line${bankQueue.length === 1 ? "" : "s"} to classify`, count: bankQueue.length },
        { key: "bills-missing", label: `${missingBills.length} bill${missingBills.length === 1 ? "" : "s"} not seen on a statement`, count: missingBills.length, tone: "red" },
      ]}
      rows={[
        ...missingBills.map((b) => ({
          key: `bill-${b.billId}-${b.month}`,
          text: <>{b.name} — {money(b.scheduled)} scheduled for {b.month}, not on the bank statement</>,
          detail: "Stopped paying it, paid it another way, or the amount changed? Confirm the line in the bank queue, or edit the bill.",
        })),
        ...bounced.map((inv) => ({
          key: `inv-${inv.id}`,
          text: <>{inv.customer.name} — owes {money(inv.balance)}, invoice email bounced</>,
          detail: `${inv.number} · ${inv.title}${inv.customerEmail ? ` · ${inv.customerEmail}` : " · no email on file"}`,
          action: <OpenDrawerButton kind="invoice" id={inv.id} onOpen={drawers.open} />,
        })),
        ...overdue.map((r) => ({
          key: `wty-${r.estimateId}`,
          text: <>{r.company} owes {money(r.balance)} on {r.account.name} — {r.daysOutstanding}d outstanding</>,
          detail: `${r.number} · claim ${r.claimNumber}`,
          action: <Link to={`/accounts/${r.account.id}`} className="btn btn-secondary px-2 py-0.5 text-xs min-h-0">Account</Link>,
        })),
      ]}
      moreText="the rest are in the cards below"
    />
  );
}

// ─── Folded wrappers for the two TrucksCards.tsx cards ────────────────────────

/**
 * BalancesStrip and TrucksCard draw their own card frame and heading, and that file
 * is being reworked in parallel (2026-09-10), so the fold is put on from outside:
 * the wrapper runs the same query the card does (same key, same call — one cache
 * entry) for the header summary, and CollapsibleCard's `nested` flattens the inner
 * frame. When TrucksCards.tsx is free, give both a frameless mode and drop `nested`.
 */
function BalancesSection() {
  const { data } = useQuery({ queryKey: ["financials-balances"], queryFn: api.financialsBalances });
  // The bank side (2026-09-21): the Chase accounts' total AS OF their newest statements, in the header only —
  // each account's own tile lives in the Bank statements card beside its import (Kyle, 2026-09-21).
  const { data: bankAccounts = [] } = useQuery({ queryKey: ["bank-accounts"], queryFn: api.bankAccounts });
  // The strip itself renders nothing until the balances load — same here.
  if (!data) return null;
  const truckCash = data.financialAccounts.reduce((sum, fa) => sum + fa.cashUsd, 0);
  const inBank = bankAccounts.filter((a) => a.isActive && a.balance).reduce((sum, a) => sum + (a.balance?.amount ?? 0), 0);
  const withBalance = bankAccounts.filter((a) => a.isActive && a.balance).length;
  const summary = (data.payments
    ? `Payments ${money(data.payments.available)} available${data.available && data.financialAccounts.length > 0 ? ` · trucks ${money(truckCash)}` : ""}`
    : "Payments balance not readable")
    + (withBalance > 0 ? ` · bank ${money(inBank)} as of the statements` : "");
  return (
    <CollapsibleCard id="balances" title="Balances" summary={summary} defaultOpen compact nested>
      <BalancesStrip />
    </CollapsibleCard>
  );
}

function TrucksSection() {
  const { data } = useQuery({ queryKey: ["trucks"], queryFn: api.trucks });
  const trucks = (data?.trucks ?? []).filter((t) => t.isActive);
  const mtd = trucks.reduce(
    (acc, t) => ({
      fuel: acc.fuel + t.mtd.fuel,
      maintenance: acc.maintenance + t.mtd.maintenance,
      materials: acc.materials + t.mtd.materials,
      unmatched: acc.unmatched + t.unmatchedMaterials,
    }),
    { fuel: 0, maintenance: 0, materials: 0, unmatched: 0 },
  );
  const summary = data ? (
    <>
      {trucks.length} truck{trucks.length === 1 ? "" : "s"} · MTD fuel {money(mtd.fuel)} · maintenance {money(mtd.maintenance)} · materials {money(mtd.materials)}
      {mtd.unmatched > 0 && <span className="text-amber-800"> · {mtd.unmatched} unmatched</span>}
    </>
  ) : undefined;
  return (
    <CollapsibleCard id="trucks" title="Trucks" summary={summary} nested>
      <TrucksCard />
    </CollapsibleCard>
  );
}

// ─── Warranty receivables ─────────────────────────────────────────────────────

const WARRANTY_STATUS_META: Record<WarrantyReceivableRow["status"], { label: string; tone: string }> = {
  "not submitted": { label: "not submitted", tone: "bg-red-100 text-red-900" },
  submitted: { label: "submitted", tone: "bg-sky-100 text-sky-900" },
  overdue: { label: "overdue", tone: "bg-amber-100 text-amber-900" },
  paid: { label: "paid", tone: "bg-emerald-100 text-emerald-900" },
};

/**
 * Kyle, 2026-09-10: "Patricia's warranty portion of the job is not getting tracked and doesn't
 * have a system to record its payment to that job when that check comes in." Every signed,
 * unvoided estimate with a claim — what the company owes, has paid, the dates, and a status —
 * so RELY's $370 is a receivable with a due date, not an invisible credit. Recording the check
 * and the claim dates happens on the estimate (the account page), which each row links to.
 */
function WarrantyReceivablesCard() {
  const { data } = useQuery({ queryKey: ["warrantyReceivables"], queryFn: api.warrantyReceivables });
  const [showPaid, setShowPaid] = useState(false);
  const rows = (data?.rows ?? []).filter((r) => showPaid || r.status !== "paid");
  const paidCount = (data?.rows ?? []).filter((r) => r.status === "paid").length;
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");
  // Kyle, 2026-09-10: open by default only while a warranty company still owes
  // something; once every claim is paid it folds to its one-line summary.
  const open = (data?.totals.open ?? 0) > 0;
  return (
    <CollapsibleCard
      id="warranty-receivables"
      title="Warranty receivables"
      defaultOpen={open}
      summary={data
        ? open
          ? `${data.totals.open} open · ${money(data.totals.balance)}${data.totals.overdue > 0 ? ` · ${data.totals.overdue} overdue` : ""}`
          : data.rows.length > 0 ? "every claim paid" : "no warranty claims"
        : undefined}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-rce-muted">
            The warranty company's share of each covered job — a second payer, chased on its own. The
            homeowner's balance never includes it and the homeowner is never reminded about it.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="rounded-lg border border-rce-border px-3 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-rce-muted">Overdue</div>
            <div className={`font-semibold tabular-nums ${(data?.totals.overdue ?? 0) > 0 ? "text-amber-800" : ""}`}>{data?.totals.overdue ?? 0}</div>
          </div>
          <div className="rounded-lg border border-rce-border px-3 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-rce-muted">Collected</div>
            <div className="font-semibold tabular-nums text-emerald-700">{money(data?.totals.paid ?? 0)}</div>
          </div>
        </div>
      </div>
      {rows.length === 0 && (
        <p className="mt-2 text-sm text-rce-muted">
          {data && data.rows.length > 0 ? "Every warranty claim is paid." : "No warranty claims on signed work."}
        </p>
      )}
      <ul className="mt-2 space-y-1">
        {rows.map((r) => {
          const s = WARRANTY_STATUS_META[r.status];
          return (
            <li key={r.estimateId} className="rounded-lg border border-rce-border px-3 py-2 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/accounts/${r.account.id}`} className="font-medium hover:underline">{r.account.name}</Link>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${s.tone}`}>{s.label}</span>
                    {r.balance > 0.009 && r.daysOutstanding > 0 && (
                      <span className="text-[11px] text-rce-muted">{r.daysOutstanding}d outstanding</span>
                    )}
                  </div>
                  <div className="break-words text-xs text-rce-muted">
                    <Link to={`/accounts/${r.account.id}`} className="hover:underline">{r.number}</Link> · {r.title} · {r.company} claim {r.claimNumber}{r.authNumber ? ` · auth ${r.authNumber}` : ""}
                  </div>
                  <div className="text-xs text-rce-muted">
                    submitted {fmt(r.submittedAt)} · expected {fmt(r.expectedAt)}
                    {r.approvedAt ? ` · approved ${fmt(r.approvedAt)}` : ""}
                    {r.receivedAt ? ` · received ${fmt(r.receivedAt)}` : ""}
                    {r.depositedAt ? ` · deposited ${fmt(r.depositedAt)}` : ""}
                    {r.checkNumber ? ` · check #${r.checkNumber}` : ""}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-semibold tabular-nums">{money(r.covered)}</div>
                  {r.paid > 0 && <div className="text-xs text-emerald-700">paid {money(r.paid)}</div>}
                  {r.balance > 0.009
                    ? <div className="text-xs font-medium text-red-700">owes {money(r.balance)}</div>
                    : <div className="text-xs text-emerald-700">settled</div>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {paidCount > 0 && (
        <button type="button" className="btn btn-secondary mt-2 px-2 py-0.5 text-xs min-h-0" onClick={() => setShowPaid((v) => !v)}>
          {showPaid ? "Hide" : "Show"} paid claims ({paidCount})
        </button>
      )}
    </CollapsibleCard>
  );
}

// ─── Shared drill-down pieces ─────────────────────────────────────────────────

/** "Search › Account › Address › Job" — every crumb but the last steps back inside the card. */
function Breadcrumb({ crumbs }: { crumbs: { label: string; onClick?: () => void }[] }) {
  return (
    <nav className="mt-2 flex flex-wrap items-center gap-1 text-xs text-rce-muted">
      {crumbs.map((crumb, i) => (
        <span key={`${crumb.label}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span>›</span>}
          {crumb.onClick ? (
            <button type="button" className="font-medium text-rce-accent hover:underline" onClick={crumb.onClick}>
              {crumb.label}
            </button>
          ) : (
            <span className="font-medium text-rce-text">{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** A pick-one row inside a drill-down step. */
function PickRow({ onClick, children, right }: { onClick: () => void; children: ReactNode; right?: ReactNode }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-rce-border px-3 py-2 text-left text-sm hover:border-rce-accent"
      >
        <span className="min-w-0">{children}</span>
        {right !== undefined && <span className="shrink-0 text-right">{right}</span>}
      </button>
    </li>
  );
}

/** Digits compared as digits so "(615) 555-0101" and "6155550101" both find the account. */
function matchesQuery(q: string, fields: (string | null | undefined)[], phone?: string | null): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return false;
  const digits = needle.replace(/\D/g, "");
  if (fields.some((f) => (f ?? "").toLowerCase().includes(needle))) return true;
  return digits.length >= 4 && (phone ?? "").replace(/\D/g, "").includes(digits);
}

// ─── Report 3: job profitability ──────────────────────────────────────────────

/**
 * The Materials card (Kyle, 2026-09-09, Build 4 — the costing switch). Compact,
 * collapsed by default, under the Monthly P&L:
 *   bought          — cash view: PO landings (purchase_in at landed cost) plus
 *                     confirmed materials receipts NOT on a PO
 *   used            — cost view: consume − return off trucks at the moving average
 *   inventory value — Σ qty × avg over every location at the END of the month,
 *                     replayed from the ledger
 * Rides /financials/summary as `materials`; /financials/materials?year= on its own.
 */
function MaterialsCard({ year, materials }: { year: number; materials: Omit<MaterialsByMonth, "year"> | undefined }) {
  const latest = materials ? [...materials.months].reverse().find((m) => m.inventoryValue !== 0 || m.bought !== 0 || m.used !== 0) : undefined;
  // Kyle, 2026-09-10: this card had its own show/hide; it rides CollapsibleCard now
  // so every folding card on the page behaves the same way and remembers the same way.
  return (
    <CollapsibleCard
      id="materials"
      title="Materials"
      summary={materials
        ? `${year}: bought ${money(materials.totals.bought)} · used ${money(materials.totals.used)}${latest ? ` · inventory ${money(latest.inventoryValue)} at end of ${MONTHS[latest.month]}` : ""}`
        : undefined}
    >
      {(
        <>
          <p className="my-2 text-xs text-rce-muted">
            <b>Bought</b> = PO landings at landed cost plus materials receipts with no PO (cash out).
            <b> Used</b> = stock consumed onto jobs less returns, at the truck's moving average (what the job cards charge).
            <b> Inventory</b> = what every truck and the warehouse held at month end. A roll bought in one month and used
            the next shows as bought first, used later — once each.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-rce-border text-left text-xs uppercase text-rce-soft">
                  <th className="py-1 pr-2">Month</th>
                  <th className="py-1 pr-2 text-right">Bought</th>
                  <th className="py-1 pr-2 text-right">Used</th>
                  <th className="py-1 text-right">Inventory at month end</th>
                </tr>
              </thead>
              <tbody>
                {(materials?.months ?? []).map((m) => (
                  <tr key={m.month} className="border-b border-rce-border/50">
                    <td className="py-1 pr-2">{MONTHS[m.month]}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{money(m.bought)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{money(m.used)}</td>
                    <td className="py-1 text-right tabular-nums">{money(m.inventoryValue)}</td>
                  </tr>
                ))}
                {materials && (
                  <tr className="font-semibold">
                    <td className="py-1 pr-2">Total</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{money(materials.totals.bought)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{money(materials.totals.used)}</td>
                    <td className="py-1 text-right tabular-nums text-rce-muted">—</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </CollapsibleCard>
  );
}

function JobProfitabilityCard({ year, rows }: { year: number; rows: JobProfitRow[] }) {
  const [search, setSearch] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [visitId, setVisitId] = useState<string | null>(null);
  const { data: accounts = [] } = useQuery({ queryKey: ["accounts"], queryFn: api.accounts });

  // The test account stays out, the same as the report's own server query.
  const realAccounts = useMemo(() => accounts.filter((a) => !a.isTestAccount), [accounts]);
  const matches = useMemo(() => {
    if (!search.trim()) return [];
    return realAccounts
      .filter((a) => matchesQuery(
        search,
        [a.name, a.email, ...(a.properties ?? []).map((p) => `${p.addressLine1} ${p.city}`)],
        a.phone,
      ))
      .slice(0, PAGE_SIZE);
  }, [realAccounts, search]);

  const account = realAccounts.find((a) => a.id === accountId) ?? null;
  const property = account?.properties?.find((p) => p.id === propertyId) ?? null;
  const jobsAtAddress = useMemo(
    () => rows.filter((r) => r.customerId === accountId && r.propertyId === propertyId),
    [rows, accountId, propertyId],
  );
  const job = jobsAtAddress.find((j) => j.visitId === visitId) ?? null;
  const jobCountAt = (pid: string) => rows.filter((r) => r.customerId === accountId && r.propertyId === pid).length;

  const reset = () => { setAccountId(null); setPropertyId(null); setVisitId(null); };

  return (
    <section className="card p-4">
      <h2 className="text-lg font-semibold">Job profitability</h2>
      <p className="mb-2 text-xs text-rce-muted">
        Completed and sold-in-flight jobs in {year}: quoted vs materials vs clocked labor. Find the
        account, pick the address, pick the job. Materials fall back to the signed estimate's frozen
        cost until receipts land.
      </p>

      <Breadcrumb crumbs={[
        { label: "Search", onClick: account ? reset : undefined },
        ...(account ? [{ label: account.name, onClick: property ? () => { setPropertyId(null); setVisitId(null); } : undefined }] : []),
        ...(property ? [{ label: property.addressLine1, onClick: job ? () => setVisitId(null) : undefined }] : []),
        ...(job ? [{ label: job.jobType ?? "job" }] : []),
      ]} />

      {!account && (
        <>
          <input
            className="field mt-2 w-full md:w-80"
            placeholder="Search account by name, phone, email, or address…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search.trim() && matches.length === 0 && (
            <p className="mt-2 text-sm text-rce-muted">No account matches that search.</p>
          )}
          <ul className="mt-2 space-y-1">
            {matches.map((a) => (
              <PickRow key={a.id} onClick={() => setAccountId(a.id)} right={
                <span className="text-xs text-rce-muted">{(a.properties ?? []).length} address(es)</span>
              }>
                <span className="font-medium">{a.name}</span>
                {(a.phone || a.email) && <span className="ml-2 text-xs text-rce-muted">{a.phone ?? a.email}</span>}
              </PickRow>
            ))}
          </ul>
        </>
      )}

      {account && !property && (
        <ul className="mt-2 space-y-1">
          {(account.properties ?? []).map((p) => (
            <PickRow key={p.id} onClick={() => setPropertyId(p.id)} right={
              <span className="text-xs text-rce-muted">{jobCountAt(p.id)} job(s) in {year}</span>
            }>
              <span className="font-medium">{p.addressLine1}</span>
              <span className="ml-2 text-xs text-rce-muted">{p.city}, {p.state}</span>
            </PickRow>
          ))}
          {(account.properties ?? []).length === 0 && (
            <li className="text-sm text-rce-muted">This account has no addresses on file.</li>
          )}
        </ul>
      )}

      {property && !job && (
        <ul className="mt-2 space-y-1">
          {jobsAtAddress.map((j) => (
            <PickRow key={j.visitId} onClick={() => setVisitId(j.visitId)} right={
              <span className={`font-semibold tabular-nums ${j.margin !== null && j.margin < 0 ? "text-red-600" : ""}`}>
                {j.margin !== null ? money(j.margin) : "—"}
              </span>
            }>
              <span className="font-medium">{j.jobType ?? "job"}</span>
              <span className="ml-2 text-xs text-rce-muted">
                {j.completedAt ? `closed ${new Date(j.completedAt).toLocaleDateString()}` : "sold — in flight"}
              </span>
            </PickRow>
          ))}
          {jobsAtAddress.length === 0 && (
            <li className="text-sm text-rce-muted">
              No completed or sold jobs at this address in {year}. Change the year above to look further back.
            </li>
          )}
        </ul>
      )}

      {job && <JobDetail job={job} />}
    </section>
  );
}

/** Exact details, receipts, and purchase orders for one job — all inside the card. */
function JobDetail({ job }: { job: JobProfitRow }) {
  const { visitId } = job;
  const drawers = useDrawerParams();
  const { data: receipts = [] } = useQuery({
    queryKey: ["jobReceipts", visitId],
    queryFn: () => api.jobReceipts(visitId),
  });
  // Same key AND same call as JobCloseoutPanel — one endpoint, one cache entry.
  const { data: orders = [] } = useQuery({
    queryKey: ["jobPOs", visitId],
    queryFn: () => api.jobPurchaseOrders(visitId),
  });
  const [viewing, setViewing] = useState<JobReceiptRow | null>(null);
  const marginPct = job.quoted && job.margin !== null && job.quoted > 0
    ? Math.round((job.margin / job.quoted) * 1000) / 10
    : null;

  return (
    <div className="mt-3 space-y-3">
      <div className="rounded-lg border border-rce-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{job.customer} — {job.jobType ?? "job"}</span>
          <span className="text-xs text-rce-muted">
            {job.address} · {job.completedAt ? `closed ${new Date(job.completedAt).toLocaleDateString()}` : `sold — ${job.status.replaceAll("_", " ")}`}
          </span>
        </div>
        <div className="mt-2 grid gap-2 text-sm md:grid-cols-4">
          <div><span className="text-xs text-rce-soft">Quoted</span><p className="font-semibold tabular-nums">{job.quoted !== null ? money(job.quoted) : "—"}</p></div>
          <div>
            <span className="text-xs text-rce-soft">Materials</span>
            <p className="font-semibold tabular-nums">{money(job.materialSpend)}</p>
            {/* Which rung of THE MATERIAL RULE (Kyle, 2026-09-09, Build 4). */}
            {job.materialSource && <p className="text-[10px] text-rce-muted">{MATERIAL_SOURCE_LABEL[job.materialSource]}</p>}
          </div>
          <div>
            <span className="text-xs text-rce-soft">Labor</span>
            <p className="font-semibold tabular-nums">
              {job.laborHours > 0 ? `${job.laborHours}h · ${money(job.laborCost)}` : "not clocked"}
            </p>
          </div>
          <div>
            <span className="text-xs text-rce-soft">Profit</span>
            <p className={`font-semibold tabular-nums ${job.margin !== null && job.margin < 0 ? "text-red-600" : ""}`}>
              {job.margin !== null ? money(job.margin) : "—"}
              {marginPct !== null && <span className="ml-1 text-xs font-normal text-rce-muted">({marginPct}%)</span>}
            </p>
          </div>
        </div>
        {job.marginBeforeLabor !== null && (
          <p className="mt-1 text-xs text-rce-muted">Before labor: {money(job.marginBeforeLabor)}</p>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-rce-soft">Receipts ({receipts.length})</h3>
        {receipts.length === 0 && <p className="text-sm text-rce-muted">No receipts on this job yet.</p>}
        <ul className="mt-1 space-y-1">
          {receipts.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rce-border px-3 py-1.5 text-sm">
              <span>
                {/* The receipt carries its own actions (2026-09-20): the vendor opens its drawer. */}
                <OpenDrawerButton kind="receipt" id={r.id} onOpen={drawers.open} className="font-medium hover:underline">{r.vendor ?? "unknown vendor"}</OpenDrawerButton>
                <span className="ml-2 text-xs text-rce-muted">
                  {new Date(r.receivedAt).toLocaleDateString()} · {r.category}
                  {r.status !== "confirmed" ? ` · ${r.status.replaceAll("_", " ")}` : ""}
                  {r.lineItems.length > 0 ? ` · ${r.lineItems.length} line item(s)` : ""}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="font-medium tabular-nums">{money(r.amount)}</span>
                {r.hasImage && (
                  <button
                    type="button"
                    className="btn btn-secondary text-xs"
                    onClick={() => setViewing(viewing?.id === r.id ? null : r)}
                  >
                    {viewing?.id === r.id ? "Hide" : "View"}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
        {viewing && <ReceiptViewer receipt={viewing} onClose={() => setViewing(null)} />}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-rce-soft">Purchase orders ({orders.length})</h3>
        {orders.length === 0 && <p className="text-sm text-rce-muted">No purchase orders on this job.</p>}
        <ul className="mt-1 space-y-1">
          {orders.map((o) => (
            <li key={o.id} className="rounded-lg border border-rce-border px-3 py-1.5 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <OpenDrawerButton kind="po" id={o.id} onOpen={drawers.open} className="font-medium hover:underline"><span className="tabular-nums">{o.number}</span> · {o.supplier}</OpenDrawerButton>
                <span className="text-xs text-rce-muted">
                  {o.purpose.replaceAll("_", " ")} · {o.status} · {new Date(o.createdAt).toLocaleDateString()}
                  {o.receiptCount > 0 ? ` · ${o.receiptCount} receipt(s)` : ""}
                </span>
              </div>
              <ul className="mt-1 text-xs text-rce-muted">
                {o.items.map((item, i) => (
                  <li key={`${item.name}-${i}`}>
                    {item.qty} {item.unit ?? ""} {item.name}{item.partNumber ? ` (#${item.partNumber})` : ""}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * The receipt itself. Photos open in the zoomable lightbox (the one Kyle reads nameplates
 * with); anything else (a PDF from MMS) renders inline in the card. Nothing leaves the page.
 */
function ReceiptViewer({ receipt, onClose }: { receipt: JobReceiptRow; onClose: () => void }) {
  const path = `/health-record-admin/receipts/${receipt.id}/image`;
  if ((receipt.imageMime ?? "").startsWith("image/")) {
    return (
      <PhotoLightbox
        path={path}
        alt={`Receipt from ${receipt.vendor ?? "unknown vendor"}`}
        caption={`${receipt.vendor ?? "Receipt"} · ${money(receipt.amount)}`}
        onClose={onClose}
      />
    );
  }
  return <ProtectedFrame path={path} title={`Receipt from ${receipt.vendor ?? "unknown vendor"}`} />;
}

function ProtectedFrame({ path, title }: { path: string; title: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let gone = false;
    fetchProtectedObjectUrl(path)
      .then((next) => { if (gone) URL.revokeObjectURL(next); else { url = next; setSrc(next); } })
      .catch(() => setFailed(true));
    return () => { gone = true; if (url) URL.revokeObjectURL(url); };
  }, [path]);
  if (failed) return <p className="mt-2 text-xs text-red-700">Could not load that receipt.</p>;
  if (!src) return <p className="mt-2 text-xs text-rce-muted">Loading receipt…</p>;
  return <iframe src={src} title={title} className="mt-2 h-96 w-full rounded-lg border border-rce-border bg-white" />;
}

// ─── Company bills ────────────────────────────────────────────────────────────

function BillsCard({ bills, confirmations, onChange }: { bills: CompanyBillRow[]; confirmations: BankConfirmations | undefined; onChange: () => void }) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("overhead");
  const [cadence, setCadence] = useState<"one_time" | "weekly" | "monthly" | "quarterly" | "annual">("monthly");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      api.createCompanyBill({
        name: name.trim(),
        amount: Number(amount),
        category,
        cadence,
        ...(cadence === "one_time" ? { billDate: date } : { startDate: date }),
      } as Omit<CompanyBillRow, "id" | "createdAt">),
    onSuccess: () => { setName(""); setAmount(""); setError(null); onChange(); },
    onError: (err) => setError((err as Error).message),
  });

  return (
    <section className="card p-4">
      <h2 className="text-lg font-semibold">Company bills &amp; rolling costs</h2>
      <p className="mb-2 text-xs text-rce-muted">
        Insurance, truck payment, phone, software — recurring bills land in every period's expenses
        automatically, at the amount here. A bill is a FIXED standing amount: an imported bank statement
        line for it confirms the month (the bill stays the money, once); a month a statement covers with
        no line for the bill is flagged — a bill you may have stopped paying. A bill whose amount changes
        every month does not belong here: leave it to the statement, where its line is the expense.
        One-off spends belong on a job's receipts instead.
      </p>
      <ul className="space-y-1">
        {bills.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rce-border px-3 py-2 text-sm">
            <span>
              <span className="font-medium">{b.name}</span>
              <span className="ml-2 text-xs text-rce-muted">
                {b.cadence.replace("_", " ")} · {b.category}
              </span>
              <span className="ml-2"><BillConfirmationNote billId={b.id} confirmations={confirmations} /></span>
            </span>
            <span className="flex items-center gap-2">
              <span className="font-medium tabular-nums">{money(b.amount)}</span>
              <button
                className="btn btn-danger px-2 py-0.5 text-xs min-h-0"
                onClick={() => void api.deleteCompanyBill(b.id).then(onChange)}
              >
                remove
              </button>
            </span>
          </li>
        ))}
        {bills.length === 0 && <li className="text-sm text-rce-muted">No bills entered yet.</li>}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <input className="field w-44 max-w-full" placeholder="Bill name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="field w-28" type="number" step="0.01" placeholder="Amount $" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <select className="field" value={category} onChange={(e) => setCategory(e.target.value)}>
          {["overhead", "insurance", "vehicle", "software", "marketing", "other"].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select className="field" value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)}>
          <option value="one_time">one-time</option>
          <option value="weekly">weekly</option>
          <option value="monthly">monthly</option>
          <option value="quarterly">quarterly</option>
          <option value="annual">annual</option>
        </select>
        <input className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button
          className="btn btn-primary text-sm"
          disabled={!name.trim() || !(Number(amount) > 0) || add.isPending}
          onClick={() => add.mutate()}
        >
          Add bill
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </section>
  );
}

// ─── Payments received + invoices ─────────────────────────────────────────────

/** The four money states, in the order Kyle chases them. */
const STATUS_META: Record<InvoiceSummary["paymentStatus"], { label: string; tone: string }> = {
  unpaid: { label: "unpaid", tone: "bg-red-100 text-red-900" },
  partial: { label: "partial — under deposit", tone: "bg-amber-100 text-amber-900" },
  deposit_paid: { label: "deposit paid", tone: "bg-sky-100 text-sky-900" },
  paid: { label: "paid in full", tone: "bg-emerald-100 text-emerald-900" },
};

/**
 * Kyle, 2026-09-07: "Payments received will be the same concept. A search bar -> account ->
 * Property -> job -> paid and unpaid invoices shown. Any outstanding unpaid invoices are shown
 * in the list above the search bar, when selected it shows the job details and options to
 * email the invoice with customer contact info."
 *
 * Every dollar here comes from GET /invoices, which rolls money up server-side
 * (billedTotalOf / paymentSummary) — nothing on this card computes money from an estimate total.
 */
/**
 * Payments received & invoices. Every invoice row opens the invoice's DRAWER (`InvoiceDrawer`:
 * PaymentPanel — email the deposit / the final bill, the QR, record cash/check/Zelle, the
 * deposit override, the warranty split — plus the reminder, the PDFs and emailing the invoice).
 * Until 2026-09-21 a row also expanded in place into its own `InvoicePanel` with the same
 * buttons; that was the duplicate the drawers plan's Phase 6 deleted.
 */
function PaymentsCard({
  year, payments, invoices, onChange,
}: {
  year: number;
  payments: PaymentRow[];
  invoices: InvoiceSummary[];
  onChange: () => void;
}) {
  const totals = useMemo(() => ({
    outstanding: invoices.reduce((s, inv) => s + Math.max(inv.balance, 0), 0),
    collected: invoices.reduce((s, inv) => s + inv.collected, 0),
  }), [invoices]);

  // ── Outstanding: signed, unvoided, unsuperseded, balance still owed ──
  const outstanding = useMemo(() => invoices.filter((inv) => inv.balance > 0.009), [invoices]);
  const [outstandingLimit, setOutstandingLimit] = useState(PAGE_SIZE);

  // ── Search → account → property → job → invoices ──
  const [search, setSearch] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [jobKey, setJobKey] = useState<string | null>(null);

  // Accounts are derived from the invoices themselves — only accounts with signed work
  // have anything to show here, and the rows already carry name, phone, email, address.
  const accounts = useMemo(() => {
    const map = new Map<string, { id: string; name: string; phone: string | null; email: string | null; addresses: string[]; count: number }>();
    for (const inv of invoices) {
      const a = map.get(inv.customer.id) ?? {
        id: inv.customer.id, name: inv.customer.name, phone: inv.customerPhone, email: inv.customerEmail, addresses: [], count: 0,
      };
      if (!a.addresses.includes(inv.serviceAddress)) a.addresses.push(inv.serviceAddress);
      a.count += 1;
      map.set(inv.customer.id, a);
    }
    return [...map.values()];
  }, [invoices]);
  const matches = useMemo(() => {
    if (!search.trim()) return [];
    return accounts
      .filter((a) => matchesQuery(search, [a.name, a.email, ...a.addresses], a.phone))
      .slice(0, PAGE_SIZE);
  }, [accounts, search]);

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const accountInvoices = useMemo(() => invoices.filter((inv) => inv.customer.id === accountId), [invoices, accountId]);
  const properties = useMemo(() => {
    const map = new Map<string, { id: string; label: string; count: number }>();
    for (const inv of accountInvoices) {
      const p = map.get(inv.propertyId) ?? { id: inv.propertyId, label: inv.serviceAddress, count: 0 };
      p.count += 1;
      map.set(inv.propertyId, p);
    }
    return [...map.values()];
  }, [accountInvoices]);
  const property = properties.find((p) => p.id === propertyId) ?? null;
  const propertyInvoices = useMemo(() => accountInvoices.filter((inv) => inv.propertyId === propertyId), [accountInvoices, propertyId]);
  // An invoice with no job yet still needs a home in the list — "No job opened yet".
  const jobKeyOf = (inv: InvoiceSummary) => inv.job?.id ?? "none";
  const jobs = useMemo(() => {
    const map = new Map<string, { key: string; label: string; detail: string; count: number }>();
    for (const inv of propertyInvoices) {
      const key = jobKeyOf(inv);
      const j = map.get(key) ?? {
        key,
        label: inv.job ? (inv.job.jobType ?? inv.job.purpose ?? inv.title) : "No job opened yet",
        detail: inv.job ? inv.job.status.replaceAll("_", " ") : "signed, job not created",
        count: 0,
      };
      j.count += 1;
      map.set(key, j);
    }
    return [...map.values()];
  }, [propertyInvoices]);
  const jobRow = jobs.find((j) => j.key === jobKey) ?? null;
  const jobInvoices = useMemo(() => propertyInvoices.filter((inv) => jobKeyOf(inv) === jobKey), [propertyInvoices, jobKey]);

  const reset = () => { setAccountId(null); setPropertyId(null); setJobKey(null); };

  // ── The year's payment ledger + the untied cash/check form, folded away by default ──
  const [showLedger, setShowLedger] = useState(false);
  const [ledgerLimit, setLedgerLimit] = useState(PAGE_SIZE);

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Payments received &amp; invoices</h2>
          <p className="text-xs text-rce-muted">
            Stripe payments record themselves when a customer pays online. Cash and checks get entered
            on the invoice. An invoice is a signed estimate.
          </p>
        </div>
        {/* The totals the old Invoices tab led with (Kyle, 2026-09-07: merged in here). */}
        <div className="flex gap-2">
          <div className="rounded-lg border border-rce-border px-3 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-rce-muted">Outstanding</div>
            <div className="font-semibold tabular-nums">{money(totals.outstanding)}</div>
          </div>
          <div className="rounded-lg border border-rce-border px-3 py-1.5">
            <div className="text-[10px] uppercase tracking-wide text-rce-muted">Collected</div>
            <div className="font-semibold tabular-nums text-emerald-700">{money(totals.collected)}</div>
          </div>
        </div>
      </div>

      {/* ── Outstanding ── */}
      <h3 className="mt-3 text-sm font-semibold text-rce-soft">Outstanding ({outstanding.length})</h3>
      {outstanding.length === 0 && <p className="text-sm text-rce-muted">Nothing is owed. Every signed invoice is paid in full.</p>}
      <ul className="mt-1 space-y-1">
        {outstanding.slice(0, outstandingLimit).map((inv) => (
          <InvoiceRow key={inv.id} inv={inv} />
        ))}
      </ul>
      {outstanding.length > outstandingLimit && (
        <button type="button" className="btn btn-secondary mt-2 text-sm" onClick={() => setOutstandingLimit((n) => n + PAGE_SIZE)}>
          Show more ({outstanding.length - outstandingLimit} more)
        </button>
      )}

      {/* ── Search → account → property → job → invoices ── */}
      <h3 className="mt-4 text-sm font-semibold text-rce-soft">Find an invoice</h3>
      <Breadcrumb crumbs={[
        { label: "Search", onClick: account ? reset : undefined },
        ...(account ? [{ label: account.name, onClick: property ? () => { setPropertyId(null); setJobKey(null); } : undefined }] : []),
        ...(property ? [{ label: property.label, onClick: jobRow ? () => { setJobKey(null); } : undefined }] : []),
        ...(jobRow ? [{ label: jobRow.label }] : []),
      ]} />

      {!account && (
        <>
          <input
            className="field mt-2 w-full md:w-80"
            placeholder="Search account by name, phone, email, or address…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search.trim() && matches.length === 0 && (
            <p className="mt-2 text-sm text-rce-muted">No account with a signed invoice matches that search.</p>
          )}
          <ul className="mt-2 space-y-1">
            {matches.map((a) => (
              <PickRow key={a.id} onClick={() => setAccountId(a.id)} right={
                <span className="text-xs text-rce-muted">{a.count} invoice(s)</span>
              }>
                <span className="font-medium">{a.name}</span>
                {(a.phone || a.email) && <span className="ml-2 text-xs text-rce-muted">{a.phone ?? a.email}</span>}
              </PickRow>
            ))}
          </ul>
        </>
      )}

      {account && !property && (
        <ul className="mt-2 space-y-1">
          {properties.map((p) => (
            <PickRow key={p.id} onClick={() => setPropertyId(p.id)} right={
              <span className="text-xs text-rce-muted">{p.count} invoice(s)</span>
            }>
              <span className="font-medium">{p.label}</span>
            </PickRow>
          ))}
        </ul>
      )}

      {property && !jobRow && (
        <ul className="mt-2 space-y-1">
          {jobs.map((j) => (
            <PickRow key={j.key} onClick={() => setJobKey(j.key)} right={
              <span className="text-xs text-rce-muted">{j.count} invoice(s)</span>
            }>
              <span className="font-medium">{j.label}</span>
              <span className="ml-2 text-xs text-rce-muted">{j.detail}</span>
            </PickRow>
          ))}
        </ul>
      )}

      {jobRow && (
        <ul className="mt-2 space-y-1">
          {jobInvoices.map((inv) => (
            <InvoiceRow key={inv.id} inv={inv} />
          ))}
        </ul>
      )}

      {/* ── Ledger ── */}
      <button
        type="button"
        className="btn btn-secondary mt-4 px-2 py-0.5 text-xs min-h-0"
        onClick={() => setShowLedger((v) => !v)}
      >
        {showLedger ? "Hide" : "Show"} {year} payment ledger ({payments.length})
      </button>
      {showLedger && (
        <div className="mt-2">
          <ul className="space-y-1">
            {payments.slice(0, ledgerLimit).map((p) => (
              <li key={p.id} className="flex items-start justify-between gap-2 rounded-lg border border-rce-border px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium capitalize">{p.method}</span>
                  {/* Whose money (Kyle, 2026-09-10): a warranty company's check is labelled as such. */}
                  {p.payer === "warranty" && (
                    <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-[11px] text-green-800">warranty company</span>
                  )}
                  <span className="ml-2 text-xs text-rce-muted">
                    {p.paidAt ? new Date(p.paidAt).toLocaleDateString() : ""}
                    {p.customer ? ` · ${p.customer.name}` : ""}
                    {p.checkNumber ? ` · check #${p.checkNumber}` : ""}
                    {p.note ? ` · ${p.note}` : ""}
                    {p.status !== "paid" ? ` · ${p.status}` : ""}
                  </span>
                </span>
                <span className="shrink-0 font-medium tabular-nums">{money(p.amount)}</span>
              </li>
            ))}
            {payments.length === 0 && <li className="text-sm text-rce-muted">No payments recorded this year.</li>}
          </ul>
          {payments.length > ledgerLimit && (
            <button type="button" className="btn btn-secondary mt-2 text-sm" onClick={() => setLedgerLimit((n) => n + PAGE_SIZE)}>
              Show more ({payments.length - ledgerLimit} more)
            </button>
          )}
          {/* Money that is not against any invoice — the form that has always been on this card. */}
          <UntiedPaymentForm onChange={onChange} />
        </div>
      )}
    </section>
  );
}

/** One invoice, as a line; the row opens the invoice's drawer. */
function InvoiceRow({ inv }: { inv: InvoiceSummary }) {
  const s = STATUS_META[inv.paymentStatus];
  const drawers = useDrawerParams();
  return (
    <li className="rounded-lg border border-rce-border">
      <button type="button" title="Open this invoice" onClick={() => drawers.open("invoice", inv.id)} className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-sm">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{inv.customer.name}</span>
            <span className={`rounded px-1.5 py-0.5 text-[11px] ${s.tone}`}>{s.label}</span>
          </span>
          <span className="block text-xs text-rce-muted">
            {inv.number}{inv.revision > 1 ? ` rev ${inv.revision}` : ""} · {inv.title} · {inv.serviceAddress}
            {(inv.changeOrders?.length ?? 0) > 0 && ` · + ${inv.changeOrders!.length} change order${inv.changeOrders!.length > 1 ? "s" : ""}`}
          </span>
          {/* Kyle, 2026-09-09: the invoice email came back — say so on the row; and when Resend
              says it was delivered, say that too. */}
          {(inv.lastBounceAt || inv.lastDelivery) && (
            <span className="mt-1 flex flex-wrap items-center gap-1.5">
              {inv.lastBounceAt && <BounceBadge at={inv.lastBounceAt} reason={inv.lastBounceReason} />}
              <DeliveryChip delivery={inv.lastDelivery} />
            </span>
          )}
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-semibold tabular-nums">{money(inv.billedTotal)}</span>
          {inv.paymentStatus === "paid" ? (
            <span className="block text-xs text-emerald-700">paid{inv.lastPaidAt ? ` ${new Date(inv.lastPaidAt).toLocaleDateString()}` : ""}</span>
          ) : (
            <span className="block text-xs font-medium text-red-700">owes {money(inv.balance)}</span>
          )}
          {/* Two payers (Kyle, 2026-09-10): the homeowner's line above; the warranty company's here. */}
          {(inv.warrantyCovered ?? 0) > 0 && (
            <span className="block text-[11px] text-green-700">
              {inv.warrantyClaim?.company ?? "warranty"}: covered {money(inv.warrantyCovered ?? 0)}
              {(inv.warrantyBalance ?? inv.warrantyCovered ?? 0) > 0.009
                ? ` · owes ${money(inv.warrantyBalance ?? inv.warrantyCovered ?? 0)}`
                : " · paid"}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** Cash or a check that is not against any invoice — kept from the card's first version. */
function UntiedPaymentForm({ onChange }: { onChange: () => void }) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "check" | "zelle" | "other">("check");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const record = useMutation({
    mutationFn: () => api.recordPayment({ amount: Number(amount), method, note: note.trim() || undefined }),
    onSuccess: () => { setAmount(""); setNote(""); setError(null); onChange(); },
    onError: (err) => setError((err as Error).message),
  });

  return (
    <div className="mt-3">
      <p className="text-xs text-rce-muted">Record a payment that is not against an invoice:</p>
      <div className="mt-1 flex flex-wrap gap-2">
        <input className="field w-28" type="number" step="0.01" placeholder="Amount $" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <select className="field" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
          <option value="check">check</option>
          <option value="cash">cash</option>
          <option value="zelle">Zelle</option>
          <option value="other">other</option>
        </select>
        <input className="field min-w-0 flex-1" placeholder="Note (what it was for)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button
          className="btn btn-primary text-sm"
          disabled={!(Number(amount) > 0) || record.isPending}
          onClick={() => record.mutate()}
        >
          Record payment
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}
