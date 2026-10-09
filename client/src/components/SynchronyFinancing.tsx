/**
 * "Pay balance with Synchrony" — the financing fee and the Synchrony payment, on the Take-payment
 * panel (Kyle, 2026-10-08, one-estimating-system plan decisions 7, 8 and 12; Phase 6 Unit 6A).
 *
 *   7.  Fee = 50% of the plan's Synchrony rate x the balance after the 1/3 deposit;
 *       financed = balance + fee. Shown as its own line, never folded in.
 *   8.  The 1/3 deposit must be collected first — no no-deposit financing.
 *   12. The plan is chosen HERE, when the balance is paid through Synchrony, not at signing.
 *
 * The flow, in the order the office clicks it:
 *   1. "Pay balance with Synchrony" → the plans the estimate carries, each with its fee on this
 *      balance (the server computes them; no rate ever reaches this app).
 *   2. Pick the plan → "Financing fee — Plan NNN" and "To run on Synchrony" → "Add the financing
 *      fee". The fee is now on the invoice: the balance carries it, the card paths are greyed with
 *      the reason, and the customer's final bill shows the fee line.
 *   3. Later, when Synchrony has approved and the customer has released the funds:
 *      "Record Synchrony payment" — plan (fixed), authorization number, amount (fixed: the whole
 *      financed amount, decision 8 — no partial releases) — closes the balance. The server captures
 *      Synchrony's cut and the net funded from the fee's rate snapshot. Greyed WITH the reason when
 *      the deposit is no longer in or the balance drifted off the fee's base (2026-10-09).
 *   Exit (standing rule): "Remove financing fee", reason required, until the Synchrony payment is
 *   recorded; after that the fee is LOCKED and the exit is voiding the payment (VoidPaymentButton,
 *   administrator only), which unlocks it. Greyed with the reason, never hidden.
 *   A LOCKED fee is PAID (2026-10-09): whatever is still owed after it — a deposit check that
 *   bounced and was voided — is plain invoice money, and card, QR, cash and check reopen for it
 *   (`financingInProgress` below is the one test every closed control reads).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { PaymentInfo } from "../lib/api";
import { money } from "../lib/utils";

/** The sentence every closed card path shows while a fee is applied (the server says the same). */
export const FINANCING_IN_PROGRESS = "Financing in progress — balance is being paid through Synchrony";

/**
 * The one state that closes the other rails (the server's financingFee.ts financingInProgress,
 * same rule): a fee is on the invoice and NOT yet paid through Synchrony. A locked fee (the
 * Synchrony payment is recorded) is paid — anything still owed after it is plain invoice money and
 * every rail is open for it (review finding, 2026-10-09).
 */
export function financingInProgress(info: Pick<PaymentInfo, "financingFee">): boolean {
  return Boolean(info.financingFee && !info.financingFee.locked);
}

/**
 * Decision 7 holds only on the balance the fee was worked on (the server's feeBaseDriftReason, same
 * words): a change order signed after the fee went on, or a payment voided, moves the balance, and
 * "balance + fee" would be a new balance plus a fee worked on the old one. Null when they agree, or
 * when an older server build sends no balanceBeforeFee (the server still refuses the record).
 */
export function synchronyDriftReason(info: Pick<PaymentInfo, "financingFee" | "balanceBeforeFee">): string | null {
  const fee = info.financingFee;
  if (!fee || fee.locked || info.balanceBeforeFee == null) return null;
  if (Math.abs(fee.feeBase - info.balanceBeforeFee) <= 0.01) return null;
  return `The balance changed since the financing fee was added — the fee was worked on $${fee.feeBase.toFixed(2)} and the balance after the deposit is now $${info.balanceBeforeFee.toFixed(2)} (a change order joined the invoice, or a payment was voided). Remove the financing fee (with a reason) and add it again so the fee is worked on the current balance.`;
}

/**
 * Why "Record Synchrony payment" is greyed while a fee is on and not yet paid: the deposit is no
 * longer in (voided, or "Deposit required" unticked — decision 8), or the balance drifted off the
 * fee's base (decision 7). Null when it can be recorded. The server refuses the same things.
 */
export function synchronyRecordBlockedReason(info: Pick<PaymentInfo, "financingFee" | "balanceBeforeFee" | "depositRequired" | "depositSatisfied">): string | null {
  const fee = info.financingFee;
  if (!fee || fee.locked) return null;
  return synchronyDepositReason(info) ?? synchronyDriftReason(info);
}

/** The query keys every money surface reads — all of them refetch after the fee or the payment changes. */
const MONEY_QUERY_KEYS: string[][] = [
  ["paymentInfo"], ["payments"], ["invoices"], ["financials"], ["jobs"], ["schedule"],
  ["jobProfitability"], ["account-summary"], ["accounts"], ["financing-options"],
];

/**
 * Decision 8 (Kyle, 2026-10-08), the same words as the server's financingDepositReason: the 1/3
 * deposit is required on a financed job and must be in. Applies to adding the fee AND to recording
 * the Synchrony payment (Phase 6 Unit 6C) — a deposit voided after the fee went on blocks both.
 */
export function synchronyDepositReason(info: Pick<PaymentInfo, "depositRequired" | "depositSatisfied">): string | null {
  if (!info.depositRequired) return "Financing needs the 1/3 deposit — tick \"Deposit required\" and collect it first (no no-deposit financing).";
  if (!info.depositSatisfied) return "The 1/3 deposit has not been collected yet — financing is for the balance after the deposit.";
  return null;
}

/** Why the button is greyed, before the server is even asked (the server repeats the same rule). */
export function synchronyBlockedReason(info: Pick<PaymentInfo, "paidInFull" | "depositRequired" | "depositSatisfied" | "balance" | "financingFee">): string | null {
  if (info.financingFee) return "A financing fee is already on this invoice.";
  if (info.paidInFull) return "This invoice is paid in full — there is nothing to finance.";
  const deposit = synchronyDepositReason(info);
  if (deposit) return deposit;
  if (!(info.balance > 0)) return "Nothing is owed on this invoice.";
  return null;
}

export function SynchronyFinancing({ info, queryKey }: { info: PaymentInfo; queryKey: unknown[] }) {
  const queryClient = useQueryClient();
  const refetchMoney = () => {
    void queryClient.invalidateQueries({ queryKey });
    for (const key of MONEY_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: key });
  };
  const [choosing, setChoosing] = useState(false);
  const [planNumber, setPlanNumber] = useState<string>("");
  const [recording, setRecording] = useState(false);
  const [authNumber, setAuthNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fee = info.financingFee ?? null;
  const blocked = synchronyBlockedReason(info);
  // The fee is on but the deposit is no longer in (voided, or "Deposit required" unticked), or the
  // balance drifted off the fee's base (a change order joined, a payment was voided): the Synchrony
  // payment cannot be recorded — greyed WITH the reason, and the server refuses it too.
  const recordBlocked = synchronyRecordBlockedReason(info);

  const options = useQuery({
    queryKey: ["financing-options", info.estimateId],
    queryFn: () => api.financingOptions(info.estimateId),
    enabled: choosing && !fee,
  });
  const chosen = options.data?.options.find((o) => o.planNumber === planNumber) ?? options.data?.options[0] ?? null;

  const addFee = useMutation({
    mutationFn: (plan: string) => api.addFinancingFee(info.estimateId, plan),
    onSuccess: (f) => {
      setError(null);
      setNotice(`Financing fee added — Plan ${f.planNumber}: ${money(f.fee)}. The balance now reads ${money(info.balance + f.fee)} and is being paid through Synchrony.`);
      setChoosing(false);
      refetchMoney();
    },
    onError: (err) => { setNotice(null); setError((err as Error).message); },
  });

  const removeFee = useMutation({
    mutationFn: (reason: string) => api.removeFinancingFee(fee!.id, reason),
    onSuccess: () => {
      setError(null);
      setNotice("Financing fee removed — the balance is back to the invoice amount and the pay link is open again.");
      refetchMoney();
    },
    onError: (err) => { setNotice(null); setError((err as Error).message); },
  });

  const recordPayment = useMutation({
    mutationFn: () =>
      api.recordPayment({
        amount: Number(amount),
        method: "synchrony",
        kind: "final",
        estimateId: info.estimateId,
        planNumber: fee!.planNumber,
        authNumber: authNumber.trim(),
      }),
    onSuccess: (row) => {
      setError(null);
      setRecording(false); setAuthNumber(""); setAmount("");
      setNotice(`Synchrony payment recorded — ${money(row.amount)} financed; Synchrony's cut ${money(row.financingCut ?? 0)}, ${money(row.financingNet ?? 0)} funded to Red Cedar.`);
      refetchMoney();
    },
    onError: (err) => { setNotice(null); setError((err as Error).message); },
  });

  const askRemove = () => {
    if (!fee) return;
    const reason = window.prompt(`Why is the ${money(fee.fee)} financing fee (Plan ${fee.planNumber}) being removed? (required — the record is kept)`);
    if (reason == null) return;
    if (!reason.trim()) { window.alert("A reason is required to remove the financing fee."); return; }
    removeFee.mutate(reason.trim());
  };

  return (
    <div className="mt-3 rounded-lg border border-rce-border p-3">
      {!fee && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-secondary text-sm"
              disabled={Boolean(blocked)}
              title={blocked ?? "Pick the Synchrony plan and add the financing fee to this balance"}
              onClick={() => { setChoosing((v) => !v); setError(null); }}
            >
              {choosing ? "Cancel Synchrony" : "Pay balance with Synchrony"}
            </button>
            {blocked && <span className="text-xs text-rce-muted">{blocked}</span>}
          </div>
          {choosing && (
            <div className="mt-2 space-y-2 text-sm">
              {options.isLoading && <p className="text-xs text-rce-muted">Loading the plans…</p>}
              {options.error && <p className="text-xs text-red-700">{(options.error as Error).message}</p>}
              {options.data && options.data.options.length === 0 && (
                <p className="text-xs text-amber-800">No financing plan is switched on for this estimate — turn one on under Settings → Financing plans (Synchrony).</p>
              )}
              {options.data && chosen && (
                <>
                  <p className="text-rce-muted">Balance after the deposit: <b className="text-rce-text">{money(options.data.balance)}</b></p>
                  <label className="flex flex-wrap items-center gap-2">
                    <span>Plan</span>
                    <select className="field" value={chosen.planNumber} onChange={(e) => setPlanNumber(e.target.value)} aria-label="Synchrony plan">
                      {options.data.options.map((o) => (
                        <option key={o.planNumber} value={o.planNumber}>Plan {o.planNumber} — {o.description}</option>
                      ))}
                    </select>
                  </label>
                  <p>
                    Financing fee — Plan {chosen.planNumber}: <b>{money(chosen.fee)}</b>
                    {" · "}To run on Synchrony: <b>{money(chosen.financed)}</b>
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary text-sm"
                    disabled={addFee.isPending || Boolean(options.data.blockedReason)}
                    title={options.data.blockedReason ?? undefined}
                    onClick={() => addFee.mutate(chosen.planNumber)}
                  >
                    {addFee.isPending ? "Adding…" : "Add the financing fee"}
                  </button>
                  {options.data.blockedReason && <p className="text-xs text-amber-800">{options.data.blockedReason}</p>}
                </>
              )}
            </div>
          )}
        </>
      )}

      {fee && (
        <div className="space-y-2 text-sm">
          <p className="font-medium">Financing — Plan {fee.planNumber} ({fee.planDescription})</p>
          <p className="text-rce-muted">
            Financing fee — Plan {fee.planNumber}: <b className="text-rce-text">{money(fee.fee)}</b> on a balance of {money(fee.feeBase)}
            {" · "}Amount to run on Synchrony: <b className="text-rce-text">{money(info.balance)}</b>
          </p>
          {fee.locked
            // Locked = paid (2026-10-09): the fee is inside the Synchrony payment, so anything still owed is plain invoice money and every rail is open for it.
            ? <p className="text-xs text-rce-muted">The financing fee was paid with the Synchrony payment. Anything still owed on this invoice is plain invoice money — card, cash, check and Zelle are open for it.</p>
            : <p className="text-xs text-amber-800">{FINANCING_IN_PROGRESS}. Card, cash and check are closed until the Synchrony payment is recorded or the fee is removed.</p>}
          {recordBlocked && <p className="text-xs text-amber-800">{recordBlocked}</p>}
          {fee.locked ? (
            <p className="text-xs text-green-700">Synchrony payment recorded against this fee.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {!info.paidInFull && (
                <button
                  type="button"
                  className="btn btn-primary text-sm"
                  disabled={Boolean(recordBlocked) && !recording}
                  title={recordBlocked ?? undefined}
                  onClick={() => { setRecording((v) => !v); setAmount(info.balance.toFixed(2)); setError(null); }}
                >
                  {recording ? "Cancel" : "Record Synchrony payment"}
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary text-sm"
                disabled={removeFee.isPending}
                title="Takes the fee off the invoice with a reason — the balance goes back to the invoice amount and the pay link reopens"
                onClick={askRemove}
              >
                Remove financing fee
              </button>
            </div>
          )}
          {fee.locked && (
            <button
              type="button"
              className="btn btn-secondary text-sm"
              disabled
              title="A Synchrony payment is recorded against this fee — void that payment first (administrator only); the fee unlocks when it is voided."
            >
              Remove financing fee
            </button>
          )}
          {recording && !fee.locked && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-rce-border p-3">
              <span className="font-medium">Synchrony paid:</span>
              <span className="text-xs text-rce-muted">Plan {fee.planNumber}</span>
              <input
                className="field w-44"
                placeholder="Synchrony authorization #"
                aria-label="Synchrony authorization number"
                value={authNumber}
                onChange={(e) => setAuthNumber(e.target.value)}
              />
              {/*
                NO PARTIAL RELEASES (Kyle, 2026-10-08, decision 8: "I will not include partial
                releases"). The amount is what is owed — balance plus the fee — and is not editable:
                a smaller figure would lock the fee with money still owed and no rail left to take
                it. The server refuses anything but the full amount (review finding, 2026-10-09).
              */}
              <input className="field w-28" type="number" step="0.01" aria-label="Amount financed" value={amount} readOnly title="Synchrony releases the whole financed amount at once — no partial releases (decision 8). If the customer is financing a different amount, remove the fee and add it again on the right balance." />
              <span className="text-xs text-rce-muted">the whole financed amount — Synchrony releases it at once, no partial releases</span>
              <button
                type="button"
                className="btn btn-primary text-sm"
                disabled={!authNumber.trim() || !(Number(amount) > 0) || recordPayment.isPending}
                title={!authNumber.trim() ? "Type Synchrony's authorization number first" : undefined}
                onClick={() => recordPayment.mutate()}
              >
                {recordPayment.isPending ? "Recording…" : "Record"}
              </button>
            </div>
          )}
        </div>
      )}
      {notice && <p className="mt-2 text-xs text-green-700">{notice}</p>}
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}
