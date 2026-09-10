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
 */

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { PhotoLightbox } from "../components/PhotoLightbox";
import { api, fetchProtectedObjectUrl } from "../lib/api";
import type { CompanyBillRow, JobProfitRow, JobReceiptRow, PaymentRow } from "../lib/api";
import type { InvoiceSummary } from "../lib/types";
import { money } from "../lib/utils";
import { ReceiptReviewList } from "../components/ReceiptReviewList";
import { BouncedEmailsCard } from "../components/BouncedEmailsCard";
import { BounceBadge } from "../components/BounceBadge";
import { DeliveryChip } from "../components/DeliveryChip";
import { PurchasesCard } from "../components/PurchaseOrders";
import { BalancesStrip, TrucksCard } from "../components/TrucksCards";

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
  // Kyle, 2026-09-08: "It is not clear where to confirm field inputs" — every account's
  // receipts waiting for review, first thing on Financials.
  const { data: pendingReceipts } = useQuery({ queryKey: ["receipt-review"], queryFn: api.pendingReceipts });

  return (
    <div className="space-y-6">
      <PageHeader title="Financials" subtitle="Bills, revenue, invoices, and the company's accounting reports" />

      {/* ── Money on hand (Kyle, 2026-09-09): Payments balance + each truck's financial account ── */}
      <BalancesStrip />

      <ReceiptReviewList
        title="Receipts to review (all accounts)"
        rows={(pendingReceipts ?? []).map((r) => ({
          id: r.id, vendor: r.vendor, amount: r.amount, category: r.category, receivedAt: r.receivedAt,
          jobLabel: r.jobLabel, accountId: r.accountId ?? undefined, accountName: r.accountName ?? undefined,
          purchaseOrderNumber: r.purchaseOrderNumber, needsPo: r.needsPo, cardMatched: r.cardMatched,
        }))}
      />

      {/* ── Bounced emails (Kyle, 2026-09-09: "very few are actually getting through") — every
          customer email Gmail could not deliver, with a Resolve door and a Check-now poll. ── */}
      <BouncedEmailsCard />

      {/* ── Purchases (Kyle, 2026-09-09): the PO is the document — number, purchase, receipt photo ── */}
      <PurchasesCard />

      {/* ── Trucks (Kyle, 2026-09-09): per-truck card spend this month; the ledger lives at /trucks ── */}
      <TrucksCard />

      <div className="flex items-center gap-2">
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
          Expenses land in the month on the receipt or bill. Net = invoiced − expenses.
          Est. materials = frozen material on signed jobs with no confirmed receipts yet; Projected net subtracts it.
          Money still owed is per invoice (billed − paid), not per month — see Outstanding below.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rce-border text-left text-xs uppercase text-rce-soft">
                <th className="py-1 pr-2">Month</th>
                <th className="py-1 pr-2 text-right">Invoiced</th>
                <th className="py-1 pr-2 text-right">Collected</th>
                <th className="py-1 pr-2 text-right">Expenses</th>
                <th className="py-1 pr-2 text-right">Net</th>
                <th className="py-1 pr-2 text-right">Est. materials</th>
                <th className="py-1 text-right">Projected net</th>
              </tr>
            </thead>
            <tbody>
              {(summary?.months ?? []).map((m) => (
                <tr key={m.month} className="border-b border-rce-border/50">
                  <td className="py-1 pr-2">{MONTHS[m.month]}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{money(m.invoiced)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{money(m.collected)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{money(m.expenses)}</td>
                  <td className={`py-1 pr-2 text-right font-medium tabular-nums ${m.net < 0 ? "text-red-600" : ""}`}>
                    {money(m.net)}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-rce-muted">{money(m.estMaterials)}</td>
                  <td className={`py-1 text-right font-medium tabular-nums ${m.projectedNet < 0 ? "text-red-600" : ""}`}>
                    {money(m.projectedNet)}
                  </td>
                </tr>
              ))}
              {summary && (
                <tr className="font-semibold">
                  <td className="py-1 pr-2">Total</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{money(summary.totals.invoiced)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{money(summary.totals.collected)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{money(summary.totals.expenses)}</td>
                  <td className={`py-1 pr-2 text-right tabular-nums ${summary.totals.net < 0 ? "text-red-600" : ""}`}>
                    {money(summary.totals.net)}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-rce-muted">{money(summary.totals.estMaterials)}</td>
                  <td className={`py-1 text-right tabular-nums ${summary.totals.projectedNet < 0 ? "text-red-600" : ""}`}>
                    {money(summary.totals.projectedNet)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Report 2: expenses by category ── */}
      <section className="card p-4">
        <h2 className="text-lg font-semibold">Expenses by category</h2>
        <p className="mb-2 text-xs text-rce-muted">
          Receipts (materials, gas, maintenance, overhead) plus company bills — the Schedule C shape.
        </p>
        {(summary?.expensesByCategory ?? []).length === 0 && (
          <p className="text-sm text-rce-muted">No expenses recorded for {year} yet.</p>
        )}
        <ul className="space-y-1">
          {(summary?.expensesByCategory ?? []).map((c) => (
            <li key={c.category} className="flex items-center justify-between rounded-lg border border-rce-border px-3 py-2 text-sm">
              <span className="capitalize">{c.category.replace("bill:", "bills — ")}</span>
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
                <li key={item.name} className="flex items-center justify-between rounded-lg border border-rce-border px-3 py-1.5 text-sm">
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
      <BillsCard bills={bills ?? []} onChange={() => {
        void queryClient.invalidateQueries({ queryKey: ["companyBills"] });
        void queryClient.invalidateQueries({ queryKey: ["financials", year] });
      }} />

      {/* ── Payments + invoices (Kyle, 2026-09-07: outstanding list, then search → account → property → job) ── */}
      <PaymentsCard
        year={year}
        payments={payments ?? []}
        invoices={invoices ?? []}
        stripeConfigured={summary?.stripeConfigured ?? true}
        onChange={() => {
          void queryClient.invalidateQueries({ queryKey: ["payments", year] });
          void queryClient.invalidateQueries({ queryKey: ["financials", year] });
          void queryClient.invalidateQueries({ queryKey: ["invoices"] });
          void queryClient.invalidateQueries({ queryKey: ["jobProfitability", year] });
        }}
      />
    </div>
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
          <div><span className="text-xs text-rce-soft">Materials</span><p className="font-semibold tabular-nums">{money(job.materialSpend)}</p></div>
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
                <span className="font-medium">{r.vendor ?? "unknown vendor"}</span>
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
                <span className="font-medium"><span className="tabular-nums">{o.number}</span> · {o.supplier}</span>
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

function BillsCard({ bills, onChange }: { bills: CompanyBillRow[]; onChange: () => void }) {
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
        automatically. One-off spends belong on a job's receipts instead.
      </p>
      <ul className="space-y-1">
        {bills.map((b) => (
          <li key={b.id} className="flex items-center justify-between rounded-lg border border-rce-border px-3 py-2 text-sm">
            <span>
              <span className="font-medium">{b.name}</span>
              <span className="ml-2 text-xs text-rce-muted">
                {b.cadence.replace("_", " ")} · {b.category}
              </span>
            </span>
            <span className="flex items-center gap-2">
              <span className="font-medium tabular-nums">{money(b.amount)}</span>
              <button
                className="text-xs text-red-600 underline"
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
        <input className="field w-44" placeholder="Bill name" value={name} onChange={(e) => setName(e.target.value)} />
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
function PaymentsCard({
  year, payments, invoices, stripeConfigured, onChange,
}: {
  year: number;
  payments: PaymentRow[];
  invoices: InvoiceSummary[];
  stripeConfigured: boolean;
  onChange: () => void;
}) {
  const totals = useMemo(() => ({
    outstanding: invoices.reduce((s, inv) => s + Math.max(inv.balance, 0), 0),
    collected: invoices.reduce((s, inv) => s + inv.collected, 0),
  }), [invoices]);

  // ── Outstanding: signed, unvoided, unsuperseded, balance still owed ──
  const outstanding = useMemo(() => invoices.filter((inv) => inv.balance > 0.009), [invoices]);
  const [outstandingLimit, setOutstandingLimit] = useState(PAGE_SIZE);
  const [openOutstandingId, setOpenOutstandingId] = useState<string | null>(null);

  // ── Search → account → property → job → invoices ──
  const [search, setSearch] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [jobKey, setJobKey] = useState<string | null>(null);
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);

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

  const reset = () => { setAccountId(null); setPropertyId(null); setJobKey(null); setOpenInvoiceId(null); };

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
          <InvoiceRow
            key={inv.id}
            inv={inv}
            open={openOutstandingId === inv.id}
            onToggle={() => setOpenOutstandingId(openOutstandingId === inv.id ? null : inv.id)}
            stripeConfigured={stripeConfigured}
            onChange={onChange}
          />
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
        ...(account ? [{ label: account.name, onClick: property ? () => { setPropertyId(null); setJobKey(null); setOpenInvoiceId(null); } : undefined }] : []),
        ...(property ? [{ label: property.label, onClick: jobRow ? () => { setJobKey(null); setOpenInvoiceId(null); } : undefined }] : []),
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
            <InvoiceRow
              key={inv.id}
              inv={inv}
              open={openInvoiceId === inv.id}
              onToggle={() => setOpenInvoiceId(openInvoiceId === inv.id ? null : inv.id)}
              stripeConfigured={stripeConfigured}
              onChange={onChange}
            />
          ))}
        </ul>
      )}

      {/* ── Ledger ── */}
      <button
        type="button"
        className="mt-4 text-xs font-medium text-rce-accent hover:underline"
        onClick={() => setShowLedger((v) => !v)}
      >
        {showLedger ? "Hide" : "Show"} {year} payment ledger ({payments.length})
      </button>
      {showLedger && (
        <div className="mt-2">
          <ul className="space-y-1">
            {payments.slice(0, ledgerLimit).map((p) => (
              <li key={p.id} className="flex items-center justify-between rounded-lg border border-rce-border px-3 py-2 text-sm">
                <span>
                  <span className="font-medium capitalize">{p.method}</span>
                  <span className="ml-2 text-xs text-rce-muted">
                    {p.paidAt ? new Date(p.paidAt).toLocaleDateString() : ""}
                    {p.customer ? ` · ${p.customer.name}` : ""}
                    {p.note ? ` · ${p.note}` : ""}
                    {p.status !== "paid" ? ` · ${p.status}` : ""}
                  </span>
                </span>
                <span className="font-medium tabular-nums">{money(p.amount)}</span>
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

/** One invoice, collapsed to a line; opens in place into the full panel. */
function InvoiceRow({
  inv, open, onToggle, stripeConfigured, onChange,
}: {
  inv: InvoiceSummary;
  open: boolean;
  onToggle: () => void;
  stripeConfigured: boolean;
  onChange: () => void;
}) {
  const s = STATUS_META[inv.paymentStatus];
  return (
    <li className={`rounded-lg border ${open ? "border-rce-accent" : "border-rce-border"}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-sm">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{inv.customer.name}</span>
            <span className={`rounded px-1.5 py-0.5 text-[11px] ${s.tone}`}>{s.label}</span>
          </span>
          <span className="block text-xs text-rce-muted">
            {inv.number}{inv.revision > 1 ? ` rev ${inv.revision}` : ""} · {inv.title} · {inv.serviceAddress}
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
          {(inv.warrantyCovered ?? 0) > 0 && (
            <span className="block text-[11px] text-green-700">warranty −{money(inv.warrantyCovered ?? 0)}</span>
          )}
          {inv.paymentStatus === "paid" ? (
            <span className="block text-xs text-emerald-700">paid{inv.lastPaidAt ? ` ${new Date(inv.lastPaidAt).toLocaleDateString()}` : ""}</span>
          ) : (
            <span className="block text-xs font-medium text-red-700">owes {money(inv.balance)}</span>
          )}
        </span>
      </button>
      {open && <InvoicePanel inv={inv} stripeConfigured={stripeConfigured} onChange={onChange} />}
    </li>
  );
}

/**
 * The expanded invoice: job details, the customer's contact info, and the ways to bill.
 * The email buttons call the SAME routes the visit's payment panel uses — they send the
 * request in writing; nobody's session ever opens the customer's /pay page (Kyle, 2026-09-01).
 */
function InvoicePanel({ inv, stripeConfigured, onChange }: { inv: InvoiceSummary; stripeConfigured: boolean; onChange: () => void }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "check" | "zelle" | "other">("check");
  const [kind, setKind] = useState<"deposit" | "final" | "other">("final");
  const [note, setNote] = useState("");

  const paid = inv.paymentStatus === "paid";
  const depositOpen = inv.paymentStatus === "unpaid" || inv.paymentStatus === "partial";
  const depositRemaining = Math.max(0, Math.round((inv.depositDue - inv.totalPaid) * 100) / 100);

  const emailRequest = useMutation({
    mutationFn: (which: "deposit" | "balance") =>
      which === "deposit" ? api.emailDepositRequest(inv.id) : api.emailBalanceRequest(inv.id),
    onSuccess: (r, which) => {
      setError(null);
      setNotice(`${which === "deposit" ? "Deposit request" : "Final bill"} emailed to ${r.to} — ${money(r.amount)} due.`);
      onChange();
    },
    onError: (err) => { setNotice(null); setError((err as Error).message); },
  });
  const remind = useMutation({
    mutationFn: () => api.sendPaymentReminder(inv.id),
    onSuccess: (r) => { setError(null); setNotice(`Reminder emailed to ${r.to} — ${money(r.amount)} open.`); onChange(); },
    onError: (err) => { setNotice(null); setError((err as Error).message); },
  });
  const record = useMutation({
    mutationFn: () => api.recordPayment({
      amount: Number(amount), method, kind, estimateId: inv.id, customerId: inv.customer.id, note: note.trim() || undefined,
    }),
    onSuccess: () => { setRecording(false); setAmount(""); setNote(""); setError(null); setNotice("Payment recorded."); onChange(); },
    onError: (err) => { setNotice(null); setError((err as Error).message); },
  });

  return (
    <div className="border-t border-rce-border px-3 py-3 text-sm">
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <div className="text-xs text-rce-soft">Account</div>
          <div className="font-medium">{inv.customer.name}</div>
          <div className="text-xs text-rce-muted">{inv.customerPhone ?? "no phone on file"} · {inv.customerEmail ?? "no email on file"}</div>
          <div className="text-xs text-rce-muted">{inv.serviceAddress}</div>
        </div>
        <div>
          <div className="text-xs text-rce-soft">Invoice</div>
          <div className="font-medium">{inv.number}{inv.revision > 1 ? ` rev ${inv.revision}` : ""} — {inv.title}</div>
          <div className="text-xs text-rce-muted">
            signed {new Date(inv.signedAt).toLocaleDateString()}
            {inv.signedChannel === "in_person" ? " in person" : inv.signedChannel === "email" ? " from the emailed link" : ""}
            {inv.sentTo ? ` · sent to ${inv.sentTo}` : " · not emailed"}
            {inv.job ? ` · job ${inv.job.status.replaceAll("_", " ")}` : " · job not created yet"}
          </div>
        </div>
      </div>

      <div className="mt-2 grid gap-2 md:grid-cols-4">
        <div><span className="text-xs text-rce-soft">Billed</span><p className="font-semibold tabular-nums">{money(inv.billedTotal)}</p></div>
        <div><span className="text-xs text-rce-soft">Paid</span><p className="font-semibold tabular-nums">{money(inv.totalPaid)}</p></div>
        <div><span className="text-xs text-rce-soft">Balance</span><p className={`font-semibold tabular-nums ${inv.balance > 0.009 ? "text-red-700" : ""}`}>{money(inv.balance)}</p></div>
        <div>
          <span className="text-xs text-rce-soft">Deposit (⅓)</span>
          <p className="font-semibold tabular-nums">
            {money(inv.depositDue)} <span className={`ml-1 rounded px-1.5 py-0.5 text-[11px] font-normal ${STATUS_META[inv.paymentStatus].tone}`}>{STATUS_META[inv.paymentStatus].label}</span>
          </p>
        </div>
      </div>
      {(inv.warrantyCovered ?? 0) > 0 && (
        <p className="mt-1 text-xs text-green-700">
          Billed is the homeowner share — warranty −{money(inv.warrantyCovered ?? 0)}
          {inv.warrantyClaim
            ? ` billed to ${inv.warrantyClaim.company} (claim ${inv.warrantyClaim.claimNumber}${inv.warrantyClaim.authNumber ? `, auth ${inv.warrantyClaim.authNumber}` : ""})`
            : ""}
        </p>
      )}
      {inv.discountTotal > 0 && (
        <p className="mt-1 text-xs text-emerald-700">includes {money(inv.discountTotal)} discount credit (retired 3% programme)</p>
      )}
      {inv.remindersSent > 0 && (
        <p className="mt-1 text-xs text-rce-muted">
          reminded {inv.remindersSent}x{inv.lastReminderAt ? ` · last ${new Date(inv.lastReminderAt).toLocaleDateString()}` : ""}
        </p>
      )}

      {!paid && (
        <div className="mt-3 flex flex-wrap gap-2">
          {stripeConfigured && depositOpen && depositRemaining > 0 && (
            <button className="btn btn-primary text-sm" disabled={emailRequest.isPending} onClick={() => emailRequest.mutate("deposit")}>
              Email deposit request — {money(depositRemaining)}
            </button>
          )}
          {stripeConfigured && (
            <button className="btn btn-primary text-sm" disabled={emailRequest.isPending} onClick={() => emailRequest.mutate("balance")}>
              Email balance request — {money(inv.balance)}
            </button>
          )}
          <button className="btn btn-secondary text-sm" disabled={remind.isPending} onClick={() => remind.mutate()}>
            {remind.isPending ? "Sending…" : "Send reminder"}
          </button>
          <button
            className="btn btn-secondary text-sm"
            onClick={() => {
              setRecording((v) => !v);
              setKind(depositOpen ? "deposit" : "final");
              setAmount((depositOpen ? depositRemaining : inv.balance).toFixed(2));
            }}
          >
            Record payment (cash/check/Zelle)
          </button>
        </div>
      )}
      {!stripeConfigured && !paid && (
        <p className="mt-2 text-xs text-amber-900">Stripe isn't configured — the email buttons are off; cash/check recording still works.</p>
      )}

      {recording && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rce-border p-3">
          <input className="field w-28" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <select className="field" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="check">check</option>
            <option value="cash">cash</option>
            <option value="zelle">Zelle</option>
            <option value="other">other</option>
          </select>
          <select className="field" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="deposit">deposit</option>
            <option value="final">final</option>
            <option value="other">other</option>
          </select>
          <input className="field flex-1" placeholder="Note (check #, etc.)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn btn-primary text-sm" disabled={!(Number(amount) > 0) || record.isPending} onClick={() => record.mutate()}>
            {record.isPending ? "Recording…" : "Record"}
          </button>
          <button className="btn text-sm" onClick={() => { setRecording(false); setError(null); }}>Cancel</button>
        </div>
      )}
      {notice && <p className="mt-2 text-xs text-green-700">{notice}</p>}
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
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
        <input className="field flex-1" placeholder="Note (what it was for)" value={note} onChange={(e) => setNote(e.target.value)} />
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
