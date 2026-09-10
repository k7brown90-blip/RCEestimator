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
 */

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
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
    };
  } catch {
    return null;
  }
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
