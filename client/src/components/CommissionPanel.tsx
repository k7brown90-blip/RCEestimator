import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type CommissionQuote, type CommissionRow } from "../lib/api";
import { money } from "../lib/utils";

/**
 * Commission on this job (Kyle, 2026-10-08, decision 10 of the one-estimating-system plan).
 *
 * "Tech commission = share of PROFIT only: revenue minus all costs and fees on the job." Every
 * term is its own visible row — shown rather than asserted — for each technician who worked the
 * job (or is assigned to it):
 *
 *   revenue (+ financing fee) − material − fees (permits, inspections, Synchrony's cut, Stripe's
 *   fee per card payment) − labor at total cost (every tech's hours × frozen rate × (1 + employer
 *   cost % from Settings → Payroll)) = profit, floored at $0 for the commission.
 *
 * Anything MISSING — a tech with no hourly rate, the employer cost % not set, a card fee Stripe
 * could not give, hours still pending (a tech still clocked in, a flagged session awaiting
 * confirmation — 2026-10-09) — is said in words and the "Record commission" button is greyed with
 * that reason (CLAUDE.md click-through rule 5), never computed around as $0. A job-profit
 * commission is recorded once per tech per job: with one on the books the button is greyed
 * "Already recorded" and the server refuses too (2026-10-09). A recorded commission is VOIDED here
 * ("Void…": a reason, then a confirm) — never deleted (2026-10-09, money history is kept). The
 * voided row stays listed, struck through, "Voided <date> — <reason>", and no longer counts
 * anywhere, so "Record commission" comes back after a void.
 */

const pct = (n: number) => `${n}%`;

/**
 * Why "Record commission" is greyed, or null when it can be clicked. Pure, so it is testable.
 * `recorded` is this technician's commissions already on this job: a job-profit commission is
 * recorded ONCE per tech per job (review finding, 2026-10-09 — the quote never subtracts what is
 * already booked, so a second press would double the payout). The server refuses the same case.
 */
export function commissionBlock(quote: CommissionQuote, recorded: Pick<CommissionRow, "basis" | "amount" | "voidedAt">[] = []): string | null {
  // A voided commission is not on the books — it never blocks re-recording.
  const already = recorded.find((c) => c.basis === "job_profit" && !c.voidedAt);
  if (already) return `Already recorded — ${money(already.amount)} from this job's profit is on the books. Void it first (with a reason) to re-record.`;
  if (!quote.percentSet) return "No commission % is set for this technician — type one on their Team page first.";
  if (quote.amount == null) {
    return quote.missing.length > 0
      ? `The profit cannot be worked out yet: ${quote.missing.join("; ")}.`
      : "The profit cannot be worked out yet.";
  }
  return null;
}

export function CommissionPanel({ visitId }: { visitId: string }) {
  const { data: time } = useQuery({ queryKey: ["jobTime", visitId], queryFn: () => api.jobTime(visitId) });
  const { data: recorded } = useQuery({ queryKey: ["jobCommissions", visitId], queryFn: () => api.jobCommissions(visitId) });

  if (!time) return null;
  const techs = time.technicians.filter((t) => t.technicianId !== "unassigned");

  return (
    <article className="card rounded-2xl border border-rce-border/70 p-5">
      <h2 className="text-lg font-semibold">Commission on this job</h2>
      <p className="mt-1 text-xs text-rce-muted">
        A share of PROFIT only: revenue (plus any financing fee) minus material, fees (permits, inspections, Synchrony's cut,
        card processing) and labor at its total cost — every tech's hours × hourly rate × (1 + employer cost %). A job that
        lost money pays $0, never less.
      </p>
      {techs.length === 0 ? (
        <p className="mt-3 text-sm text-rce-muted">No technician has hours on this job yet, so there is no one to pay a commission to.</p>
      ) : (
        <div className="mt-3 space-y-3">
          {techs.map((t) => (
            <TechCommission
              key={t.technicianId}
              visitId={visitId}
              technicianId={t.technicianId}
              name={t.name}
              recorded={(recorded ?? []).filter((c) => c.technicianId === t.technicianId)}
            />
          ))}
        </div>
      )}
    </article>
  );
}

function TechCommission({ visitId, technicianId, name, recorded }: {
  visitId: string; technicianId: string; name: string; recorded: CommissionRow[];
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data: quote } = useQuery({
    queryKey: ["commissionQuote", visitId, technicianId],
    queryFn: () => api.commissionQuote(visitId, technicianId),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["jobCommissions", visitId] });
    void queryClient.invalidateQueries({ queryKey: ["commissionQuote", visitId, technicianId] });
    void queryClient.invalidateQueries({ queryKey: ["payrollWeek"] });
    void queryClient.invalidateQueries({ queryKey: ["financials"] });
  };
  const record = useMutation({
    mutationFn: () => api.createCommission({ technicianId, visitId, basis: "job_profit" }),
    onSuccess: () => { setError(null); refresh(); },
    onError: (err) => setError((err as Error).message),
  });
  const voidIt = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.voidCommission(id, reason),
    onSuccess: () => { setError(null); refresh(); },
    onError: (err) => setError((err as Error).message),
  });

  if (!quote) {
    return (
      <div className="rounded-lg border border-rce-border p-3 text-sm">
        <Link to={`/team/${technicianId}`} className="font-semibold hover:text-rce-accent">{name}</Link>
        <span className="ml-2 text-xs text-rce-muted">working out the basis…</span>
      </div>
    );
  }

  const block = commissionBlock(quote, recorded);
  const confirmAndVoid = (c: CommissionRow) => {
    const reason = window.prompt("Why is this commission being voided? The reason is kept on the row and goes on the trail.");
    if (!reason || !reason.trim()) return;
    if (!window.confirm(`Void the ${money(c.amount)} commission for ${name}? It stays on the list, marked void, and stops counting in payroll.`)) return;
    voidIt.mutate({ id: c.id, reason: reason.trim() });
  };
  const lost = quote.profit != null && quote.profit < 0;

  return (
    <div className="rounded-lg border border-rce-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={`/team/${technicianId}`} className="font-semibold hover:text-rce-accent">{name}</Link>
        <span className="text-xs text-rce-muted">
          {quote.percentSet
            ? `${pct(quote.percent!)} of job profit`
            : <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">commission % not set</span>}
        </span>
      </div>

      <table className="mt-2 w-full text-xs">
        <tbody>
          <Row label="Revenue" amount={quote.revenue} note={quote.financingFee > 0 ? `includes the financing fee ${money(quote.financingFee)}` : undefined} />
          <Row label="− Material" amount={quote.materialCost} note={quote.materialSource === "po" ? "from the job's P.O.s" : quote.materialSource === "none" ? "none on the P.O.s" : quote.materialSource} />
          {quote.feeRows.map((f) => (
            <Row key={`${f.kind}-${f.id}`} label={`− ${f.label}`} amount={f.amount} note={f.category} />
          ))}
          {quote.feeProblems.map((p) => (
            <tr key={p.paymentId}>
              <td className="py-0.5 pr-2">− Card processing fee on the {money(p.amount)} card payment</td>
              <td className="py-0.5 text-right"><span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">could not be read</span></td>
              <td className="py-0.5 pl-2 text-rce-soft">{p.reason}</td>
            </tr>
          ))}
          {quote.feeRows.length === 0 && quote.feeProblems.length === 0 && <Row label="− Fees" amount={0} note="no permit, inspection, Synchrony or card fees on this job" />}
          {quote.laborRows.map((r) => (
            <tr key={r.technicianId}>
              <td className="py-0.5 pr-2">− Labor: {r.name}, {r.hours}h</td>
              <td className="py-0.5 text-right">
                {r.total != null
                  ? money(r.total)
                  : <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">{r.rateMissing ? "rate not set" : "employer cost % not set"}</span>}
              </td>
              <td className="py-0.5 pl-2 text-rce-soft">
                {r.wage != null ? `wages ${money(r.wage)}` : "wages unknown"}
                {quote.employerCostSet ? ` × (1 + ${quote.employerCostPercent}%)` : " × (1 + employer cost % not set)"}
              </td>
            </tr>
          ))}
          {quote.laborRows.length === 0 && <Row label="− Labor at total cost" amount={0} note="no hours on this job" />}
          <tr className="border-t border-rce-border font-semibold">
            <td className="py-1 pr-2">= Profit</td>
            <td className={`py-1 text-right ${lost ? "text-red-700" : ""}`}>
              {quote.profit != null
                ? money(quote.profit)
                : <span className="rounded bg-amber-100 px-1.5 py-0.5 font-normal text-amber-800">missing</span>}
            </td>
            <td className="py-1 pl-2 font-normal text-rce-soft">
              {lost ? "the job lost money — the commission is taken on $0, never less" : quote.missing.length > 0 ? quote.missing.join("; ") : ""}
            </td>
          </tr>
          <tr className="font-semibold">
            <td className="py-1 pr-2">Commission</td>
            <td className="py-1 text-right">{quote.amount != null ? money(quote.amount) : "—"}</td>
            <td className="py-1 pl-2 font-normal text-rce-soft">
              {quote.amount != null && quote.percent != null ? `${pct(quote.percent)} of ${money(quote.commissionableProfit)}` : ""}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary px-2 py-0.5 text-xs min-h-0"
          disabled={block != null || record.isPending}
          title={block ?? `Record ${money(quote.amount)} for ${name} from this job's profit`}
          onClick={() => record.mutate()}
        >
          Record commission
        </button>
        {block && <span className="text-xs text-amber-800">{block}</span>}
      </div>

      {recorded.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {recorded.map((c) => c.voidedAt ? (
            <li key={c.id} className="flex flex-wrap items-center gap-2 text-rce-muted">
              <span className="font-semibold line-through">{money(c.amount)}</span>
              <span className="line-through">
                {c.percent != null ? `${pct(c.percent)} of job profit · ` : ""}recorded {new Date(c.earnedAt).toLocaleDateString()}
              </span>
              <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-800">
                Voided {new Date(c.voidedAt).toLocaleDateString()}{c.voidReason ? ` — ${c.voidReason}` : ""}
              </span>
            </li>
          ) : (
            <li key={c.id} className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{money(c.amount)}</span>
              <span className="text-rce-muted">
                {c.percent != null ? `${pct(c.percent)} of job profit · ` : ""}recorded {new Date(c.earnedAt).toLocaleDateString()}
              </span>
              {c.reason && <span className="text-rce-soft">override: {c.reason}</span>}
              <button
                type="button"
                className="btn btn-secondary px-2 py-0.5 text-xs min-h-0"
                disabled={voidIt.isPending}
                title="Void this commission — keeps the row, marked void, with your reason"
                onClick={() => confirmAndVoid(c)}
              >
                Void…
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function Row({ label, amount, note }: { label: string; amount: number | null; note?: string }) {
  return (
    <tr>
      <td className="py-0.5 pr-2">{label}</td>
      <td className="py-0.5 text-right">{money(amount)}</td>
      <td className="py-0.5 pl-2 text-rce-soft">{note ?? ""}</td>
    </tr>
  );
}
