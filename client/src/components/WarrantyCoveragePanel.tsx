/**
 * Home-warranty coverage on an issued estimate. (Kyle, 2026-09-09)
 *
 *   "The warranty company is covering $370 of this bill. I need to get a
 *    signature from the home owner first to clarify they owe the remainder and
 *    be able to show on the invoice sent to her that the warranty is covering
 *    what ever their chosen amount is with the claim number."
 *
 * The homeowner stays the customer of record and signs; the warranty company
 * is a second payer. The credit on the customer's page, the invoice, and the
 * PDF is generated from THIS record — it is never typed as a discount — and
 * the ⅓ deposit and balance are computed on the homeowner share.
 *
 * Editable only while the estimate is unsigned. Once signed the claim is
 * frozen with the price (the server answers 409); "Save changes to the
 * estimate" makes a new revision that carries the claim forward, unsigned,
 * where it can be changed.
 *
 * After signing the claim becomes a RECEIVABLE (Kyle, 2026-09-10: "Patricia's
 * warranty portion of the job is not getting tracked and doesn't have a
 * system to record its payment to that job when that check comes in") — the
 * WarrantyClaimTracker below: submitted / expected / approved / received /
 * deposited / check #, every change with a reason, and the form that records
 * the warranty company's check against the claim (never the homeowner).
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { PaymentInfo } from "../lib/api";
import { money } from "../lib/utils";
import type { WarrantyClaim } from "../lib/types";

function parseClaim(json: string | null | undefined): WarrantyClaim | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Partial<WarrantyClaim>;
    if (!raw || typeof raw.claimNumber !== "string" || typeof raw.coveredAmount !== "number") return null;
    return {
      company: raw.company || "RELY Home",
      claimNumber: raw.claimNumber,
      authNumber: raw.authNumber ?? null,
      coveredAmount: raw.coveredAmount,
      note: raw.note ?? null,
      setAt: raw.setAt ?? "",
      submittedAt: raw.submittedAt ?? null,
      expectedAt: raw.expectedAt ?? null,
      approvedAt: raw.approvedAt ?? null,
      receivedAt: raw.receivedAt ?? null,
      depositedAt: raw.depositedAt ?? null,
      checkNumber: raw.checkNumber ?? null,
      events: Array.isArray(raw.events) ? raw.events : [],
    };
  } catch {
    return null;
  }
}

/** ISO → the value an <input type="date"> holds ("2026-09-10"), or "". */
const dateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");
/** "2026-09-10" → an ISO timestamp at local noon (so the date never slips a day in either zone), or null. */
const dateOut = (v: string) => (v ? new Date(`${v}T12:00:00`).toISOString() : null);

/**
 * The warranty receivable on a SIGNED estimate (Kyle, 2026-09-10). Reads the same
 * payment-info query the Take-payment panel does, so both show one set of numbers.
 */
export function WarrantyClaimTracker({ estimateId, onChanged }: { estimateId: string; onChanged?: () => void }) {
  const queryClient = useQueryClient();
  const queryKey = ["paymentInfo", estimateId];
  const { data: info } = useQuery<PaymentInfo | null>({
    queryKey,
    queryFn: () => api.estimatePaymentInfo(estimateId),
  });
  const claim = info?.warranty?.claim ?? null;

  // ── Claim tracking ──
  const [submittedAt, setSubmittedAt] = useState("");
  const [expectedAt, setExpectedAt] = useState("");
  const [approvedAt, setApprovedAt] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [depositedAt, setDepositedAt] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [trackError, setTrackError] = useState<string | null>(null);
  const [trackNotice, setTrackNotice] = useState<string | null>(null);
  useEffect(() => {
    setSubmittedAt(dateInput(claim?.submittedAt));
    setExpectedAt(dateInput(claim?.expectedAt));
    setApprovedAt(dateInput(claim?.approvedAt));
    setReceivedAt(dateInput(claim?.receivedAt));
    setDepositedAt(dateInput(claim?.depositedAt));
    setCheckNumber(claim?.checkNumber ?? "");
    setNote(claim?.note ?? "");
  }, [
    estimateId, claim?.submittedAt, claim?.expectedAt, claim?.approvedAt, claim?.receivedAt,
    claim?.depositedAt, claim?.checkNumber, claim?.note,
  ]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey: ["invoices"] });
    void queryClient.invalidateQueries({ queryKey: ["warrantyReceivables"] });
    void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    onChanged?.();
  };

  const track = useMutation({
    mutationFn: () =>
      api.pbWarrantyTracking(estimateId, {
        submittedAt: dateOut(submittedAt),
        // Left blank with a submitted date → the server fills submitted + 45 days.
        ...(expectedAt || !submittedAt ? { expectedAt: dateOut(expectedAt) } : {}),
        approvedAt: dateOut(approvedAt),
        receivedAt: dateOut(receivedAt),
        depositedAt: dateOut(depositedAt),
        checkNumber: checkNumber.trim() || null,
        note: note.trim() || null,
        reason: reason.trim(),
      }),
    onSuccess: (r) => {
      setTrackError(null);
      setTrackNotice(r.changed ? "Claim tracking saved." : "Nothing changed.");
      setReason("");
      refresh();
    },
    onError: (err) => { setTrackNotice(null); setTrackError((err as Error).message); },
  });

  // ── Record the warranty company's payment ──
  const [paying, setPaying] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"check" | "ach" | "other">("check");
  const [payCheck, setPayCheck] = useState("");
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [payError, setPayError] = useState<string | null>(null);
  const [payNotice, setPayNotice] = useState<string | null>(null);
  const record = useMutation({
    mutationFn: () =>
      api.recordPayment({
        amount: Number(amount),
        method,
        kind: "final",
        payer: "warranty",
        checkNumber: payCheck.trim() || null,
        paidAt: dateOut(paidOn) ?? undefined,
        estimateId,
      }),
    onSuccess: () => {
      setPayError(null);
      setPayNotice(`${claim?.company ?? "Warranty"} payment of ${money(Number(amount))} recorded against the claim.`);
      setPaying(false); setAmount(""); setPayCheck("");
      refresh();
    },
    onError: (err) => { setPayNotice(null); setPayError((err as Error).message); },
  });

  if (!info || !info.warranty || !claim) return null;
  const w = info.warranty;
  const status = w.balance <= 0.01 ? "paid" : !claim.submittedAt ? "not submitted"
    : claim.expectedAt && Date.parse(claim.expectedAt) < Date.now() ? "overdue" : "submitted";
  const tone = status === "paid" ? "bg-emerald-100 text-emerald-800" : status === "overdue" ? "bg-amber-100 text-amber-900"
    : status === "submitted" ? "bg-sky-100 text-sky-900" : "bg-red-100 text-red-900";

  return (
    <div className="mt-2 rounded-lg border border-rce-border p-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-rce-soft">Claim tracking — {claim.company}</p>
        <span className={`rounded px-1.5 py-0.5 text-[11px] ${tone}`}>{status}</span>
      </div>
      <p className="mt-1">
        covered <b>{money(w.covered)}</b> · paid {money(w.paid)} · balance <b>{money(w.balance)}</b>
        {" · "}claim {claim.claimNumber}{claim.authNumber ? ` · auth ${claim.authNumber}` : ""}
      </p>
      <p className="mt-1 text-[11px] text-rce-muted">
        The warranty company's share is chased on its own — the homeowner's balance never includes it and the
        homeowner is never reminded about it. Expected defaults to submitted + 45 days (RELY's agreement).
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <label><span className="block text-rce-soft">Submitted</span><input className="field w-full" type="date" value={submittedAt} onChange={(e) => setSubmittedAt(e.target.value)} /></label>
        <label><span className="block text-rce-soft">Expected</span><input className="field w-full" type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} placeholder="submitted + 45 days" /></label>
        <label><span className="block text-rce-soft">Approved</span><input className="field w-full" type="date" value={approvedAt} onChange={(e) => setApprovedAt(e.target.value)} /></label>
        <label><span className="block text-rce-soft">Check received</span><input className="field w-full" type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} /></label>
        <label><span className="block text-rce-soft">Deposited</span><input className="field w-full" type="date" value={depositedAt} onChange={(e) => setDepositedAt(e.target.value)} /></label>
        <label><span className="block text-rce-soft">Check #</span><input className="field w-full" value={checkNumber} maxLength={40} onChange={(e) => setCheckNumber(e.target.value)} /></label>
        <label className="sm:col-span-3"><span className="block text-rce-soft">Note (internal)</span><input className="field w-full" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
        <label className="sm:col-span-2"><span className="block text-rce-soft">Reason for this change *</span><input className="field w-full" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. claim submitted on the RELY portal today" /></label>
        <div className="flex items-end">
          <button type="button" className="btn btn-secondary w-full text-sm" disabled={!reason.trim() || track.isPending} onClick={() => track.mutate()}>
            {track.isPending ? "Saving…" : "Save tracking"}
          </button>
        </div>
      </div>
      {trackNotice && <p className="mt-1 text-green-700">{trackNotice}</p>}
      {trackError && <p className="mt-1 text-red-700">{trackError}</p>}

      {w.balance > 0.01 && (
        <div className="mt-2">
          {!paying ? (
            <button
              type="button"
              className="btn btn-primary text-sm"
              onClick={() => { setPaying(true); setAmount(w.balance.toFixed(2)); setPayCheck(checkNumber); setPayError(null); }}
            >
              Record {claim.company} payment — {money(w.balance)}
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-rce-border p-2">
              <span className="font-medium">{claim.company} paid:</span>
              <input className="field w-28" type="number" step="0.01" min={0.01} max={w.balance + 0.01} value={amount} onChange={(e) => setAmount(e.target.value)} />
              <select className="field" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option value="check">check</option>
                <option value="ach">ACH / direct deposit</option>
                <option value="other">other</option>
              </select>
              <input className="field w-28" placeholder="Check #" value={payCheck} maxLength={40} onChange={(e) => setPayCheck(e.target.value)} />
              <input className="field" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
              <button type="button" className="btn btn-primary text-sm" disabled={!(Number(amount) > 0) || record.isPending} onClick={() => record.mutate()}>
                {record.isPending ? "Recording…" : "Record"}
              </button>
              <button type="button" className="btn text-sm" onClick={() => { setPaying(false); setPayError(null); }}>Cancel</button>
            </div>
          )}
        </div>
      )}
      {payNotice && <p className="mt-1 text-green-700">{payNotice}</p>}
      {payError && <p className="mt-1 text-red-700">{payError}</p>}

      {(claim.events?.length ?? 0) > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-rce-muted">Trail ({claim.events!.length})</summary>
          <ul className="mt-1 space-y-0.5 text-[11px] text-rce-muted">
            {[...claim.events!].reverse().map((ev, i) => (
              <li key={`${ev.at}-${i}`}>
                {new Date(ev.at).toLocaleString()} · {ev.kind}{ev.detail ? ` — ${ev.detail}` : ""}{ev.reason ? ` · reason: ${ev.reason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function WarrantyCoveragePanel({
  estimateId,
  estimateNumber,
  warrantyJson,
  signed,
  onChanged,
}: {
  estimateId: string;
  estimateNumber: string;
  warrantyJson: string | null | undefined;
  signed: boolean;
  onChanged: () => void;
}) {
  const existing = parseClaim(warrantyJson);
  const [open, setOpen] = useState(Boolean(existing));
  const [company, setCompany] = useState(existing?.company ?? "RELY Home");
  const [claimNumber, setClaimNumber] = useState(existing?.claimNumber ?? "");
  const [authNumber, setAuthNumber] = useState(existing?.authNumber ?? "");
  const [coveredAmount, setCoveredAmount] = useState(existing ? String(existing.coveredAmount) : "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [result, setResult] = useState<{ homeownerTotal: number; depositDue: number; covered: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A different estimate (or a refetch after save) re-seeds the form from the record.
  useEffect(() => {
    const c = parseClaim(warrantyJson);
    setCompany(c?.company ?? "RELY Home");
    setClaimNumber(c?.claimNumber ?? "");
    setAuthNumber(c?.authNumber ?? "");
    setCoveredAmount(c ? String(c.coveredAmount) : "");
    setNote(c?.note ?? "");
    if (c) setOpen(true);
  }, [estimateId, warrantyJson]);

  const save = useMutation({
    mutationFn: () =>
      api.pbSetWarranty(estimateId, {
        company: company.trim() || "RELY Home",
        claimNumber: claimNumber.trim(),
        authNumber: authNumber.trim() || null,
        coveredAmount: Number(coveredAmount),
        note: note.trim() || null,
      }),
    onSuccess: (r) => {
      setError(null);
      setResult({ homeownerTotal: r.homeownerTotal, depositDue: r.depositDue, covered: r.warrantyCovered });
      onChanged();
    },
    onError: (err) => { setResult(null); setError((err as Error).message); },
  });

  const clear = useMutation({
    mutationFn: () => api.pbSetWarranty(estimateId, null),
    onSuccess: () => {
      setError(null);
      setResult(null);
      setOpen(false);
      onChanged();
    },
    onError: (err) => setError((err as Error).message),
  });

  const amountNumber = Number(coveredAmount);
  const canSave = claimNumber.trim().length > 0 && claimNumber.trim().length <= 40
    && Number.isFinite(amountNumber) && amountNumber > 0 && !save.isPending;

  // Signed: read-only. The claim is frozen with the price.
  if (signed) {
    if (!existing) return null;
    return (
      <div className="rounded-lg border border-rce-border p-2 text-xs">
        <p className="font-semibold text-rce-soft">Warranty coverage</p>
        <p className="mt-1">
          <b>{existing.company}</b> · claim {existing.claimNumber}
          {existing.authNumber ? ` · auth ${existing.authNumber}` : ""} · covering <b>{money(existing.coveredAmount)}</b>
        </p>
        {existing.note && <p className="mt-1 text-rce-muted">{existing.note}</p>}
        <p className="mt-1 text-rce-muted">
          Frozen with the signature — save changes to the estimate (a new revision) to change it.
        </p>
        {/* The receivable (Kyle, 2026-09-10): dates, check, and the warranty company's payment. */}
        <WarrantyClaimTracker estimateId={estimateId} onChanged={onChanged} />
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className="text-xs text-rce-accent underline" onClick={() => setOpen(true)}>
        Add home-warranty coverage (claim + amount the warranty company pays)…
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-rce-border p-2">
      <p className="text-xs font-semibold text-rce-soft">Warranty coverage on {estimateNumber}</p>
      <p className="mt-1 text-[11px] text-rce-muted">
        The warranty company's share comes off as a credit line with the claim number; the homeowner
        signs for and owes the remainder, and the ⅓ deposit is a third of that.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-xs">
          <span className="block text-rce-soft">Warranty company</span>
          <input className="field w-full" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="RELY Home" />
        </label>
        <label className="text-xs">
          <span className="block text-rce-soft">Claim / work-order number *</span>
          <input className="field w-full" value={claimNumber} maxLength={40} onChange={(e) => setClaimNumber(e.target.value)} placeholder="343467219" />
        </label>
        <label className="text-xs">
          <span className="block text-rce-soft">Authorization number</span>
          <input className="field w-full" value={authNumber} maxLength={60} onChange={(e) => setAuthNumber(e.target.value)} placeholder="auth45978673" />
        </label>
        <label className="text-xs">
          <span className="block text-rce-soft">Covered amount ($) *</span>
          <input
            className="field w-full"
            type="number"
            inputMode="decimal"
            min={0.01}
            step={0.01}
            value={coveredAmount}
            onChange={(e) => setCoveredAmount(e.target.value)}
            placeholder="370.00"
          />
        </label>
        <label className="text-xs sm:col-span-2">
          <span className="block text-rce-soft">Note (internal)</span>
          <input className="field w-full" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="3 hrs labor + $70 toward fan; other issues not covered" />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary text-sm" disabled={!canSave} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : existing ? "Update coverage" : "Save coverage"}
        </button>
        {existing && (
          <button type="button" className="btn btn-secondary text-sm" disabled={clear.isPending} onClick={() => clear.mutate()}>
            {clear.isPending ? "Clearing…" : "Clear"}
          </button>
        )}
        {!existing && (
          <button type="button" className="text-xs text-rce-soft underline" onClick={() => setOpen(false)}>cancel</button>
        )}
      </div>
      {result && (
        <p className="mt-2 text-xs text-green-700">
          Homeowner total after coverage <b>{money(result.homeownerTotal)}</b> · deposit ⅓ = <b>{money(result.depositDue)}</b>
          {" "}· {money(result.covered)} billed to {company.trim() || "RELY Home"}.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}
