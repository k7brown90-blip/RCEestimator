/**
 * Take payment — the admin's charge surface. (Kyle, 2026-08-25: "I don't see
 * anywhere to even charge a deposit on the admin side.")
 *
 * Charging a card never means typing a card number into the CRM — that would
 * put card data in scope of this app. And it never means opening the
 * customer's payment portal in the admin's browser either (Kyle, 2026-09-01:
 * "it should email the final bill not try and log in as the customer") — the
 * buttons EMAIL the deposit request / the invoice with the pay link; the QR
 * stays for the customer's own phone across the counter. Cash and checks get
 * recorded here too, and a recorded deposit opens the scheduling gate the
 * same as a card one.
 *
 * ── THE EMAILS LIVE IN ONE PLACE NOW (Kyle, 2026-10-27) ─────────────────────────────────────────────
 * "Multiple email buttons are created and in use. This is confusing and difficult and causes user
 * error. A rule of thumb is there is one tool for one task." This card used to carry five email
 * buttons - "Email invoice NNNN - $X due", "Email deposit request", "Email the financing link",
 * "Email a review request" - beside the drawer's "Email the signed copy" and "Send reminder". They
 * are ONE control: the "Email the customer" panel at the bottom of this card (SendEmailPanel with
 * a `record` built by invoiceEmailRecord below): pick what you are sending - Invoice, Deposit
 * request (only while a deposit is due), Financing link, Review request, Message - then who it goes
 * to (customer on file, a saved contact, a typed address, plus CC), and press the one Send button,
 * which names both ("Send invoice 2026-1104 to jane@example.com"). The invoice it sends is ONE
 * email: the itemized PDF, the amount due, the pay link, due upon receipt; sent again to the same
 * address while still unpaid it is worded as a friendly reminder.
 * Balance QR and Review QR are not email - they are the in-person ways and stay beside Take payment.
 *
 * The one panel is mounted HERE so every surface that shows this card (invoice drawer, job drawer,
 * visit workspace, signing page) ends with exactly one email control. A host that already carries
 * the panel for the same record passes `emailPanel={false}` (InvoiceRow does, for its own document).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { api } from "../lib/api";
import { money } from "../lib/utils";
import type { PaymentInfo } from "../lib/api";
import { WarrantyClaimTracker } from "./WarrantyCoveragePanel";
import { RefundedPaymentNote, VoidPaymentButton, VoidedPaymentNote } from "./VoidPaymentButton";
import { FINANCING_IN_PROGRESS, financingInProgress, SynchronyFinancing } from "./SynchronyFinancing";
import { GOOGLE_REVIEW_URL } from "../../../shared/reviewRequestUrl";
import { SendEmailPanel } from "./SendEmailPanel";
import type { EmailRecord } from "./SendEmailPanel";

/**
 * The kinds the one "Email the customer" panel offers for an invoice (Kyle, 2026-10-27). Invoice,
 * Financing link and Message always; the Deposit request only while a deposit is due (and greyed
 * with the reason while a financing fee has closed the deposit pay link); the Review request is
 * greyed with its reason until the job is complete and not yet asked. Pure - the host only mounts it.
 */
export function invoiceEmailRecord(info: PaymentInfo): EmailRecord {
  const e = info.email ?? null;
  const financing = financingInProgress(info);
  const depositRemaining = Math.max(0, info.depositDue - info.depositPaid);
  const depositDue = info.stripeConfigured && info.depositRequired && !info.depositSatisfied && depositRemaining > 0;
  const reviewBlock = !e?.jobId
    ? "A review request needs the job - this invoice has no job yet."
    : e.jobStatus !== "completed"
      ? "A review request can go once the job is marked complete."
      : e.reviewRequestedAt
        ? "A review request has already been sent for this job."
        : null;
  return {
    estimateId: info.estimateId,
    number: info.number,
    visitId: e?.jobId ?? null,
    invoiceOwing: !info.paidInFull && !financing,
    kinds: [
      { kind: "invoice", label: info.paidInFull ? `Invoice ${info.number} — paid in full` : `Invoice ${info.number} — ${money(info.balance)} due` },
      ...(depositDue ? [{ kind: "deposit" as const, label: `Deposit request — ${money(depositRemaining)}`, blocked: financing ? FINANCING_IN_PROGRESS : null }] : []),
      { kind: "financing", label: "Financing link" },
      { kind: "review", label: "Review request", blocked: reviewBlock },
      { kind: "message", label: "Message" },
    ],
  };
}

export function PaymentPanel({ jobId, estimateId, emailPanel = true }: {
  jobId?: string;
  estimateId?: string;
  /** Mount the one "Email the customer" panel inside this card (default). A host that carries it itself passes false. */
  emailPanel?: boolean;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["paymentInfo", jobId ?? estimateId];
  const { data: info } = useQuery<PaymentInfo | null>({
    queryKey,
    queryFn: () => (jobId ? api.jobPaymentInfo(jobId) : api.estimatePaymentInfo(estimateId!)),
    refetchInterval: 15_000, // a webhook can land any second while the customer pays
  });
  const [showQr, setShowQr] = useState<"deposit" | "balance" | null>(null);
  // The review QR (Kyle, 2026-10-01) — generated client-side from GOOGLE_REVIEW_URL, never
  // stored or fetched from a route; see shared/reviewRequestUrl.ts for why. Separate from
  // `showQr`/`qrSrc` above because those read a server-rendered SVG off a token-scoped pay URL;
  // this one is a data: URI this component draws itself, so it needs its own toggle and cache.
  const [showReviewQr, setShowReviewQr] = useState(false);
  const [reviewQrSrc, setReviewQrSrc] = useState<string | null>(null);
  const [recording, setRecording] = useState<"deposit" | "final" | null>(null);
  const [amount, setAmount] = useState("");
  // Methods the system can't detect (Kyle, 2026-08-25): cash, check, Zelle — or other.
  const [method, setMethod] = useState<"cash" | "check" | "zelle" | "other">("check");
  // Which payment this is, defaulted by the button pressed and changeable; and the note (a check
  // number, what it was for) the ledger shows. Both came here from the Financials invoice panel
  // when that panel was retired for the invoice drawer (2026-09-21) — this is now the one place
  // a payment against an invoice is recorded by hand.
  const [kind, setKind] = useState<"deposit" | "final" | "other">("final");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const toggleReviewQr = () => {
    if (showReviewQr) { setShowReviewQr(false); return; }
    setShowReviewQr(true);
    if (!reviewQrSrc) {
      void QRCode.toDataURL(GOOGLE_REVIEW_URL, { margin: 1, width: 240 }).then(setReviewQrSrc);
    }
  };

  // The deposit is optional (Kyle, 2026-09-20): the manual override lives where the money is shown.
  const setDeposit = useMutation({
    mutationFn: (depositRequired: boolean) => api.pbSetTerms(info!.estimateId, { depositRequired }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["schedule"] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const record = useMutation({
    mutationFn: () =>
      api.recordPayment({
        amount: Number(amount),
        method,
        kind,
        estimateId: info?.estimateId,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      setRecording(null); setAmount(""); setNote(""); setError(null);
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => setError((err as Error).message),
  });

  if (!info) return null;

  const depositRemaining = Math.max(0, info.depositDue - info.depositPaid);
  /*
    FINANCING IN PROGRESS (Kyle, 2026-10-08; SynchronyFinancing.tsx). While a financing fee is on
    the invoice AND NOT YET PAID the balance carries it and ONLY the Synchrony payment may close
    it: every card, QR, deposit-request and record-cash/check control below is greyed WITH this
    reason (never hidden — CLAUDE.md click-through rule 5). The server refuses the same things:
    chargeableAmount (card, QR, pay page), POST /financials/payments (cash/check/Zelle) and the
    deposit-request route. Once the Synchrony payment is recorded the fee is LOCKED and paid —
    anything still owed after that (a deposit check that bounced and was voided) is plain invoice
    money, and every control reopens for it (review finding, 2026-10-09: the lock used to close
    every rail, and the only way to collect that money was to void real Synchrony money).
  */
  const financing = financingInProgress(info);
  const closed = financing ? { disabled: true, title: FINANCING_IN_PROGRESS } : {};
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
        ) : !info.depositRequired ? (
          <span className="rounded bg-rce-accentBg px-2 py-0.5 text-xs font-semibold uppercase text-rce-accentDark">No deposit</span>
        ) : info.depositSatisfied ? (
          <span className="rounded bg-rce-accentBg px-2 py-0.5 text-xs font-semibold uppercase text-rce-accentDark">Deposit paid</span>
        ) : (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold uppercase text-amber-800">Deposit required</span>
        )}
      </div>

      {/* One invoice, one payment (Kyle, 2026-09-20): what the total is made of when signed
          change orders have joined it. Each document stays its own frozen record. */}
      {info.documents.length > 1 && (
        /* Named as ONE invoice (2026-09-29): the heading is what stops the list below reading as
           a list of separate bills, which is exactly how Kyle read the Hoover job's two emails. */
        <ul className="mt-2 space-y-0.5 text-xs text-rce-muted">
          <li className="pb-0.5 font-medium text-rce-soft">Invoice {info.number} is made up of:</li>
          {info.documents.map((d) => (
            <li key={d.id} className="flex justify-between gap-2">
              <span>{d.kind === "change_order" ? "Change order" : "Invoice"} {d.number} — {d.title}</span>
              <span className="tabular-nums">{money(d.billedTotal)}</span>
            </li>
          ))}
        </ul>
      )}

      {info.warranty ? (
        /* One account, two payers (Kyle, 2026-09-10): the homeowner's line and the warranty
           company's line. Every button on this panel is the HOMEOWNER's money; the warranty
           company's check is recorded on the estimate's warranty panel and never lands here. */
        <div className="mt-1 text-sm text-rce-muted">
          <p>
            <span className="font-medium text-rce-soft">Homeowner:</span> billed {money(info.billedTotal)} · {info.depositRequired ? `Deposit (⅓) ${money(info.depositDue)}` : "no deposit"}
            {info.totalPaid > 0 && ` · paid ${money(info.totalPaid)}`}
            {" · "}balance <b>{money(info.balance)}</b>
          </p>
          <p className="text-xs text-green-700">
            <span className="font-medium">{info.warranty.claim.company}:</span> covered {money(info.warranty.covered)}
            {" · "}paid {money(info.warranty.paid)} · balance <b>{money(info.warranty.balance)}</b>
            {" · "}claim {info.warranty.claim.claimNumber}{info.warranty.claim.authNumber ? `, auth ${info.warranty.claim.authNumber}` : ""}
            {info.warranty.balance <= 0.01 ? " · paid" : ""}
          </p>
        </div>
      ) : (
        <p className="mt-1 text-sm text-rce-muted">
          Total {money(info.billedTotal)} · {info.depositRequired ? `Deposit (⅓) ${money(info.depositDue)}` : "no deposit"}
          {info.totalPaid > 0 && ` · Paid ${money(info.totalPaid)}`}
          {" · "}Balance <b>{money(info.balance)}</b>
        </p>
      )}
      {/* The financing fee as its own line (Kyle, 2026-10-08: "never folded in") — the balance above already includes it. */}
      {info.financingFee && (
        <p className="mt-1 text-sm text-rce-muted">
          Financing fee — Plan {info.financingFee.planNumber}: <b>{money(info.financingFee.fee)}</b> (included in the balance)
        </p>
      )}
      {info.depositRequired && !info.depositSatisfied && (
        <p className="mt-1 text-xs text-amber-800">
          This job can't be scheduled until the deposit is in — charge it below or record the cash/check.
        </p>
      )}
      {/* The manual override (Kyle, 2026-09-20: "a deposit required check box for a manual
          override"). Turning it off opens scheduling; turning it on asks the ⅓ before. */}
      {!info.paidInFull && (
        <label className="mt-1 flex items-center gap-2 text-xs text-rce-soft">
          <input
            type="checkbox"
            checked={info.depositRequired}
            disabled={setDeposit.isPending}
            onChange={(e) => setDeposit.mutate(e.target.checked)}
          />
          Deposit required (⅓ before scheduling)
        </label>
      )}

      {!info.stripeConfigured && (
        <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
          Stripe isn't configured — card charging is off; cash/check recording still works.
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {info.stripeConfigured && info.depositRequired && !info.depositSatisfied && depositRemaining > 0 && (
          <>
            <button className="btn btn-secondary text-sm" {...closed} onClick={() => setShowQr(showQr === "deposit" ? null : "deposit")}>
              {showQr === "deposit" ? "Hide QR" : "Deposit QR (in person)"}
            </button>
          </>
        )}
        {info.stripeConfigured && !info.paidInFull && (
          <>
            {/* The QR / pay page NEVER shows a fee-inclusive balance: closed while financing (the server refuses too). */}
            <button className="btn btn-secondary text-sm" {...closed} onClick={() => setShowQr(showQr === "balance" ? null : "balance")}>
              {showQr === "balance" ? "Hide QR" : "Balance QR (in person)"}
            </button>
          </>
        )}
        <button type="button" className="btn btn-secondary text-sm" onClick={toggleReviewQr}>
          {showReviewQr ? "Hide QR" : "Review QR (in person)"}
        </button>
        {!info.paidInFull && (
          <>
            {info.depositRequired && depositRemaining > 0 && (
              <button
                className="btn btn-secondary text-sm"
                {...closed}
                onClick={() => { setRecording("deposit"); setKind("deposit"); setAmount(depositRemaining.toFixed(2)); }}
              >
                Record deposit (cash/check/Zelle)
              </button>
            )}
            {/* The prefill is the plain balance — never a fee-inclusive one; closed outright while financing. */}
            <button
              className="btn btn-secondary text-sm"
              {...closed}
              onClick={() => { setRecording("final"); setKind("final"); setAmount((info.balanceBeforeFee ?? info.balance).toFixed(2)); }}
            >
              Record payment (cash/check/Zelle)
            </button>
          </>
        )}
      </div>

      {/*
        THE ONE EMAIL CONTROL (Kyle, 2026-10-27) - see the header. Click path from the Dashboard:
        Invoices -> the invoice -> "Email the customer" -> pick Invoice / Deposit request / Financing
        link / Review request / Message -> To and CC -> the one Send button naming both.
      */}
      {emailPanel && info.email && (
        <div className="mt-3">
          <SendEmailPanel
            target={info.email.jobId ? "job" : "account"}
            id={info.email.jobId ?? info.email.customerId}
            primaryEmail={info.email.customerEmail}
            accountIdForContacts={info.email.customerId}
            record={invoiceEmailRecord(info)}
          />
        </div>
      )}

      {/*
        PAY BALANCE WITH SYNCHRONY (Kyle, 2026-10-08, decisions 7, 8, 12): pick the plan, add the
        financing fee, later record the Synchrony payment; remove the fee with a reason until then.
        Only on a signed invoice with a balance — the component greys itself with the reason.
      */}
      {(!info.paidInFull || info.financingFee) && <SynchronyFinancing info={info} queryKey={queryKey} />}

      {qrSrc && !financing && (
        <div className="mt-3 inline-block rounded-lg border border-rce-border bg-white p-3">
          <img src={qrSrc} alt="Scan to pay" className="h-56 w-56" />
          <p className="mt-1 text-center text-xs text-rce-muted">
            Customer scans with their phone camera — opens the secure payment page.
          </p>
        </div>
      )}

      {showReviewQr && (
        <div className="mt-3 inline-block rounded-lg border border-rce-border bg-white p-3">
          {reviewQrSrc ? (
            <img src={reviewQrSrc} alt="Scan to leave a Google review" className="h-56 w-56" />
          ) : (
            <p className="flex h-56 w-56 items-center justify-center text-xs text-rce-muted">Generating…</p>
          )}
          <p className="mt-1 text-center text-xs text-rce-muted">
            Customer scans with their phone camera — opens the Google review page directly.
          </p>
        </div>
      )}

      {recording && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rce-border p-3">
          <span className="text-sm font-medium">{recording === "deposit" ? "Deposit" : "Payment"} received:</span>
          <input className="field w-28" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <select className="field" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="check">check</option>
            <option value="cash">cash</option>
            <option value="zelle">Zelle</option>
            <option value="other">other</option>
          </select>
          <select className="field" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} title="Which payment this is">
            <option value="deposit">deposit</option>
            <option value="final">final</option>
            <option value="other">other</option>
          </select>
          <input className="field min-w-0 flex-1" placeholder="Note (check #, etc.)" value={note} onChange={(e) => setNote(e.target.value)} />
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
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}

      {/* The warranty company's side (Kyle, 2026-09-10): claim dates + "Record RELY payment",
          posted against the claim — never against the homeowner's balance above. */}
      {info.warranty && (
        <WarrantyClaimTracker
          estimateId={info.estimateId}
          onChanged={() => { void queryClient.invalidateQueries({ queryKey }); void queryClient.invalidateQueries({ queryKey: ["jobs"] }); }}
        />
      )}

      {/* Every payment on the invoice, with its exit (Kyle, 2026-10-08, decision 11): "Void…" per
          row, reason required, administrator only — the CRM session. A voided row stays here,
          struck through, so the ledger shows it was recorded and taken back. */}
      {info.payments.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-rce-muted">
          {info.payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2">
              <span className={p.voidedAt ? "line-through" : undefined}>
                {money(p.amount)} · {p.method} · {p.payer === "warranty" ? `${info.warranty?.claim.company ?? "warranty company"}` : p.kind}
                {p.checkNumber ? ` · check #${p.checkNumber}` : ""}
                {/* A Synchrony row (2026-10-09): the plan, the authorization number, and what landed after Synchrony's cut. */}
                {p.method === "synchrony" && p.financingPlanNumber ? ` · Plan ${p.financingPlanNumber}` : ""}
                {p.method === "synchrony" && p.financingAuthNumber ? ` · auth #${p.financingAuthNumber}` : ""}
                {p.method === "synchrony" && p.financingNet != null ? ` · net funded ${money(p.financingNet)} (Synchrony's cut ${money(p.financingCut ?? 0)})` : ""}
                {p.paidAt ? ` · ${new Date(p.paidAt).toLocaleDateString()}` : ""} · {p.status}
              </span>
              <VoidedPaymentNote voidedAt={p.voidedAt} voidReason={p.voidReason} />
              {/* A card refund made in Stripe, recorded by the webhook (Kyle, 2026-10-09, ruling 7):
                  "Refunded $X on <date>" on the row. No button — the refund is MADE in Stripe. */}
              <RefundedPaymentNote payment={p} />
              <VoidPaymentButton payment={p} onVoided={() => { void queryClient.invalidateQueries({ queryKey }); }} />
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
