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
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import { money } from "../lib/utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
  const { data: stripeStatus } = useQuery({ queryKey: ["stripeStatus"], queryFn: () => api.stripeStatus() });
  const { data: payments } = useQuery({
    queryKey: ["payments", year],
    queryFn: () => api.paymentsList(year),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Financials" subtitle="Bills, revenue, and the company's accounting reports" />

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
        <p className="mb-2 text-xs text-rce-muted">
          Invoiced = signed work (accrual). Collected = money received (cash). Net = invoiced − expenses.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rce-border text-left text-xs uppercase text-rce-soft">
                <th className="py-1 pr-2">Month</th>
                <th className="py-1 pr-2 text-right">Invoiced</th>
                <th className="py-1 pr-2 text-right">Collected</th>
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

      {/* ── Report 3: job profitability — real labor now (Phase 5) ── */}
      <section className="card p-4">
        <h2 className="text-lg font-semibold">Job profitability</h2>
        <p className="mb-2 text-xs text-rce-muted">
          Completed jobs: quoted vs materials vs clocked labor. Hours come from the field app's
          time clock.
        </p>
        {(profitability ?? []).length === 0 && (
          <p className="text-sm text-rce-muted">No completed jobs in {year} yet — margins appear as jobs close.</p>
        )}
        <ul className="space-y-1">
          {(profitability ?? []).map((j) => (
            <li key={j.visitId} className="rounded-lg border border-rce-border px-3 py-2 text-sm">
              <div className="flex items-center justify-between">
                <Link to={`/visits/${j.visitId}`} className="font-medium hover:text-rce-accent">
                  {j.customer} — {j.jobType ?? "job"}
                </Link>
                <span className={`font-semibold tabular-nums ${j.margin !== null && j.margin < 0 ? "text-red-600" : ""}`}>
                  {j.margin !== null ? money(j.margin) : "—"}
                </span>
              </div>
              <p className="text-xs text-rce-muted">
                {j.address} · quoted {j.quoted !== null ? money(j.quoted) : "—"} · materials {money(j.materialSpend)}
                {" · labor "}{j.laborHours > 0 ? `${j.laborHours}h (${money(j.laborCost)})` : "not clocked"}
                {j.completedAt && ` · closed ${new Date(j.completedAt).toLocaleDateString()}`}
              </p>
            </li>
          ))}
        </ul>
      </section>

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

      {/* ── Go-live checklist (Phase 5) ── */}
      {stripeStatus && (
        <section className="card p-4">
          <h2 className="text-lg font-semibold">Stripe go-live</h2>
          <p className="mb-2 text-xs text-rce-muted">
            {stripeStatus.keyMode === "live"
              ? "Live mode — real cards, real money."
              : "Test mode — no real money moves. The steps below are yours to click in the Stripe Dashboard; the app picks the changes up from its settings."}
          </p>
          <ul className="space-y-1 text-sm">
            <li>{stripeStatus.configured ? "✅" : "⬜"} Stripe connected ({stripeStatus.keyMode} mode)</li>
            <li>{stripeStatus.webhookSecretSet ? "✅" : "⬜"} Webhook receiving payments</li>
            <li>{stripeStatus.keyMode === "live" ? "✅" : "⬜"} Live keys installed — create a <b>restricted</b> key (rk_) in the Dashboard, plus a live webhook endpoint, and swap both on Railway</li>
            <li>{stripeStatus.restrictedKey ? "✅" : "⬜"} Using a restricted key (least privilege){!stripeStatus.restrictedKey && " — currently a full secret key"}</li>
            <li>{stripeStatus.automaticTax ? "✅" : "⬜"} Sales tax — register Tennessee in Dashboard → Tax (head office + registration), then flip it on here; until then no tax is collected</li>
            <li>✅ 3% card fee — real and disclosed: the pay page offers bank transfer at face value or card +3%</li>
          </ul>
        </section>
      )}

      {/* ── Company bills ── */}
      <BillsCard bills={bills ?? []} onChange={() => {
        void queryClient.invalidateQueries({ queryKey: ["companyBills"] });
        void queryClient.invalidateQueries({ queryKey: ["financials", year] });
      }} />

      {/* ── Payments ── */}
      <PaymentsCard payments={payments ?? []} onChange={() => {
        void queryClient.invalidateQueries({ queryKey: ["payments", year] });
        void queryClient.invalidateQueries({ queryKey: ["financials", year] });
      }} />
    </div>
  );
}

function BillsCard({ bills, onChange }: { bills: import("../lib/api").CompanyBillRow[]; onChange: () => void }) {
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
      } as Omit<import("../lib/api").CompanyBillRow, "id" | "createdAt">),
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

function PaymentsCard({ payments, onChange }: { payments: import("../lib/api").PaymentRow[]; onChange: () => void }) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "check" | "other">("check");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const record = useMutation({
    mutationFn: () => api.recordPayment({ amount: Number(amount), method, note: note.trim() || undefined }),
    onSuccess: () => { setAmount(""); setNote(""); setError(null); onChange(); },
    onError: (err) => setError((err as Error).message),
  });

  return (
    <section className="card p-4">
      <h2 className="text-lg font-semibold">Payments received</h2>
      <p className="mb-2 text-xs text-rce-muted">
        Stripe payments record themselves when a customer pays online. Cash and checks get entered here.
      </p>
      <ul className="space-y-1">
        {payments.map((p) => (
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
      <div className="mt-3 flex flex-wrap gap-2">
        <input className="field w-28" type="number" step="0.01" placeholder="Amount $" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <select className="field" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
          <option value="check">check</option>
          <option value="cash">cash</option>
          <option value="other">other</option>
        </select>
        <input className="field flex-1" placeholder="Note (invoice #, customer)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button
          className="btn btn-primary text-sm"
          disabled={!(Number(amount) > 0) || record.isPending}
          onClick={() => record.mutate()}
        >
          Record payment
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </section>
  );
}
