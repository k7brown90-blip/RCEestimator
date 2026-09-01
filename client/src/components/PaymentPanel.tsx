/**
 * Take payment — the admin's charge surface. (Kyle, 2026-08-25: "I don't see
 * anywhere to even charge a deposit on the admin side.")
 *
 * Charging a card never means typing a card number into the CRM — that would
 * put card data in scope of this app. And it never means opening the
 * customer's payment portal in the admin's browser either (Kyle, 2026-09-01:
 * "it should email the final bill not try and log in as the customer") — the
 * buttons EMAIL the deposit request / final bill with the pay link; the QR
 * stays for the customer's own phone across the counter. Cash and checks get
 * recorded here too, and a recorded deposit opens the scheduling gate the
 * same as a card one.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { money } from "../lib/utils";
import type { PaymentInfo } from "../lib/api";

export function PaymentPanel({ jobId, estimateId }: { jobId?: string; estimateId?: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["paymentInfo", jobId ?? estimateId];
  const { data: info } = useQuery<PaymentInfo | null>({
    queryKey,
    queryFn: () => (jobId ? api.jobPaymentInfo(jobId) : api.estimatePaymentInfo(estimateId!)),
    refetchInterval: 15_000, // a webhook can land any second while the customer pays
  });
  const [showQr, setShowQr] = useState<"deposit" | "balance" | null>(null);
  const [recording, setRecording] = useState<"deposit" | "final" | null>(null);
  const [amount, setAmount] = useState("");
  // Methods the system can't detect (Kyle, 2026-08-25): cash, check, Zelle.
  const [method, setMethod] = useState<"cash" | "check" | "zelle">("check");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const emailRequest = useMutation({
    mutationFn: (kind: "deposit" | "balance") =>
      kind === "deposit"
        ? api.emailDepositRequest(info!.estimateId)
        : api.emailBalanceRequest(info!.estimateId),
    onSuccess: (r, kind) => {
      setError(null);
      setNotice(`${kind === "deposit" ? "Deposit request" : "Final bill"} emailed to ${r.to} — $${r.amount.toFixed(2)} due.`);
    },
    onError: (err) => { setNotice(null); setError((err as Error).message); },
  });

  const record = useMutation({
    mutationFn: () =>
      api.recordPayment({
        amount: Number(amount),
        method,
        kind: recording ?? "other",
        estimateId: info?.estimateId,
      }),
    onSuccess: () => {
      setRecording(null); setAmount(""); setError(null);
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => setError((err as Error).message),
  });

  if (!info) return null;

  const depositRemaining = Math.max(0, info.depositDue - info.depositPaid);
  const qrSrc =
    showQr === "deposit" ? `${info.payUrl}/qr.svg?type=deposit`
    : showQr === "balance" ? `${info.payUrl}/qr.svg`
    : null;

  return (
    <article className="card rounded-2xl border border-rce-border/70 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Take payment — Invoice {info.number}</h2>
        {info.paidInFull ? (
          <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-semibold uppercase text-green-800">Paid in full</span>
        ) : info.depositSatisfied ? (
          <span className="rounded bg-rce-accentBg px-2 py-0.5 text-xs font-semibold uppercase text-rce-accentDark">Deposit paid</span>
        ) : (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold uppercase text-amber-800">Deposit required</span>
        )}
      </div>

      <p className="mt-1 text-sm text-rce-muted">
        Total {money(info.billedTotal)} · Deposit (⅓) {money(info.depositDue)}
        {info.totalPaid > 0 && ` · Paid ${money(info.totalPaid)}`}
        {" · "}Balance <b>{money(info.balance)}</b>
      </p>
      {!info.depositSatisfied && (
        <p className="mt-1 text-xs text-amber-800">
          This job can't be scheduled until the deposit is in — charge it below or record the cash/check.
        </p>
      )}

      {!info.stripeConfigured && (
        <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
          Stripe isn't configured — card charging is off; cash/check recording still works.
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {info.stripeConfigured && !info.depositSatisfied && depositRemaining > 0 && (
          <>
            <button
              className="btn btn-primary text-sm"
              disabled={emailRequest.isPending}
              onClick={() => emailRequest.mutate("deposit")}
            >
              Email deposit request — {money(depositRemaining)}
            </button>
            <button className="btn btn-secondary text-sm" onClick={() => setShowQr(showQr === "deposit" ? null : "deposit")}>
              {showQr === "deposit" ? "Hide QR" : "Deposit QR (in person)"}
            </button>
          </>
        )}
        {info.stripeConfigured && !info.paidInFull && (
          <>
            <button
              className="btn btn-primary text-sm"
              disabled={emailRequest.isPending}
              onClick={() => emailRequest.mutate("balance")}
            >
              Email final bill — {money(info.balance)}
            </button>
            <button className="btn btn-secondary text-sm" onClick={() => setShowQr(showQr === "balance" ? null : "balance")}>
              {showQr === "balance" ? "Hide QR" : "Balance QR (in person)"}
            </button>
          </>
        )}
        {!info.paidInFull && (
          <>
            <button
              className="btn btn-secondary text-sm"
              onClick={() => { setRecording("deposit"); setAmount(depositRemaining.toFixed(2)); }}
            >
              Record deposit (cash/check/Zelle)
            </button>
            <button
              className="btn btn-secondary text-sm"
              onClick={() => { setRecording("final"); setAmount(info.balance.toFixed(2)); }}
            >
              Record payment (cash/check/Zelle)
            </button>
          </>
        )}
      </div>

      {qrSrc && (
        <div className="mt-3 inline-block rounded-lg border border-rce-border bg-white p-3">
          <img src={qrSrc} alt="Scan to pay" className="h-56 w-56" />
          <p className="mt-1 text-center text-xs text-rce-muted">
            Customer scans with their phone camera — opens the secure payment page.
          </p>
        </div>
      )}

      {recording && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rce-border p-3">
          <span className="text-sm font-medium">{recording === "deposit" ? "Deposit" : "Payment"} received:</span>
          <input className="field w-28" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <select className="field" value={method} onChange={(e) => setMethod(e.target.value as "cash" | "check" | "zelle")}>
            <option value="check">check</option>
            <option value="cash">cash</option>
            <option value="zelle">Zelle</option>
          </select>
          <button
            className="btn btn-primary text-sm"
            disabled={!(Number(amount) > 0) || record.isPending}
            onClick={() => record.mutate()}
          >
            {record.isPending ? "Recording…" : "Record"}
          </button>
          <button className="btn text-sm" onClick={() => { setRecording(null); setError(null); }}>Cancel</button>
        </div>
      )}
      {notice && <p className="mt-2 text-xs text-green-700">{notice}</p>}
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}

      {info.payments.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-rce-muted">
          {info.payments.map((p) => (
            <li key={p.id}>
              {money(p.amount)} · {p.method} · {p.kind}
              {p.paidAt ? ` · ${new Date(p.paidAt).toLocaleDateString()}` : ""} · {p.status}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
