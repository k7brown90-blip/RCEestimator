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
 * ── THIS PANEL HOLDS THE ONLY WHOLE-INVOICE SEND (renamed 2026-09-29) ────────────────────────
 * "Email invoice NNNN — $X due" sends every document on the invoice, one total, paid-to-date,
 * the balance and one pay link (sendBalanceRequestEmail, which resolves to the root). It was
 * called "Email final bill" — a stage of a job, not the thing it sends — so when Kyle went
 * looking for a combined invoice after the Hoover job he pressed "Email invoice…" on the invoice
 * drawer instead and got one frozen document. That button is now "Email the signed copy…".
 * If a third send is ever added here, name it after what arrives in the customer's inbox.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { api } from "../lib/api";
import { money } from "../lib/utils";
import type { PaymentInfo } from "../lib/api";
import { WarrantyClaimTracker } from "./WarrantyCoveragePanel";
import { GOOGLE_REVIEW_URL } from "../../../shared/reviewRequestUrl";

export function PaymentPanel({ jobId, estimateId }: { jobId?: string; estimateId?: string }) {
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
  const [notice, setNotice] = useState<string | null>(null);

  const emailRequest = useMutation({
    mutationFn: (kind: "deposit" | "balance") =>
      kind === "deposit"
        ? api.emailDepositRequest(info!.estimateId)
        : api.emailBalanceRequest(info!.estimateId),
    onSuccess: (r, kind) => {
      setError(null);
      // Reads back the words on the button (2026-09-29), so the confirmation names the same
      // thing the operator clicked rather than an older internal name for it.
      setNotice(
        kind === "deposit"
          ? `Deposit request emailed to ${r.to} — $${r.amount.toFixed(2)} due.`
          : `Invoice ${info!.number} emailed to ${r.to}${info!.documents.length > 1 ? ` — all ${info!.documents.length} documents, ` : " — "}$${r.amount.toFixed(2)} due.`,
      );
    },
    onError: (err) => { setNotice(null); setError((err as Error).message); },
  });

  /*
   * FINANCING AND THE REVIEW ASK, STANDALONE (Kyle, 2026-10-01: "I also need to have the
   * financing link available to email on its own along with a google review request to email on
   * its own" / "These links should be available along side the invoice email button" / "These
   * should be a manual send both from the field app and from the CRM").
   *
   * Each reads its own "last sent" off GET /email-deliveries (api.emailDeliveries, already used
   * by SendEmailPanel) filtered to the kind the server stamps it with (financingEmail.ts /
   * reviewRequest.ts) — a security review on 2026-10-01 found financing had NO repeat guard at
   * all (every press re-emails), and Kyle has already been hit by duplicate customer emails
   * twice in a fortnight (two invoice emails on the Hoover job 2026-09-28, two deposit requests
   * on Arlene's 2026-09-30). The fix is UI, deliberately, not a server-side block — financing is
   * resent on request legitimately — so the button must SHOW when it last went and relabel to
   * "send again" once it has, the same remedy field/QuoteScreen.tsx shipped yesterday.
   */
  const financingDeliveries = useQuery({
    queryKey: ["email-deliveries", "estimate", info?.estimateId, "financing"],
    queryFn: () => api.emailDeliveries({ estimateId: info!.estimateId, limit: 10 }),
    enabled: Boolean(info?.estimateId),
  });
  const lastFinancing = financingDeliveries.data?.find((d) => d.kind === "financing") ?? null;

  const financingSend = useMutation({
    mutationFn: () => api.emailFinancing(info!.estimateId),
    onSuccess: (r) => {
      setError(null);
      setNotice(`Financing link emailed to ${r.to}.`);
      void queryClient.invalidateQueries({ queryKey: ["email-deliveries", "estimate", info!.estimateId, "financing"] });
    },
    onError: (err) => { setNotice(null); setError((err as Error).message); },
  });

  // Keyed by the JOB (a Visit.id), not the estimate — the review route needs one, and this
  // panel is sometimes opened from an estimate alone (InvoiceDrawer, AccountDetailPage,
  // SigningModePage) with no jobId at all. Greyed with the reason when that happens, never
  // hidden (CLAUDE.md click-through rule 5).
  const reviewDeliveries = useQuery({
    queryKey: ["email-deliveries", "job", jobId, "review_request"],
    queryFn: () => api.emailDeliveries({ visitId: jobId, limit: 10 }),
    enabled: Boolean(jobId),
  });
  const lastReview = reviewDeliveries.data?.find((d) => d.kind === "review_request") ?? null;

  const reviewSend = useMutation({
    mutationFn: () => api.emailReviewRequest(jobId!),
    onSuccess: (r) => {
      setError(null);
      setNotice(`Review request emailed to ${r.to}.`);
      void queryClient.invalidateQueries({ queryKey: ["email-deliveries", "job", jobId, "review_request"] });
    },
    // The server's refusal (job not completed, already asked on this job, this customer asked
    // within 90 days, no email on file) is readable text — surfaced as-is, never swallowed.
    onError: (err) => { setNotice(null); setError((err as Error).message); },
  });

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
            {/*
              SAY THAT THIS IS THE INVOICE (Kyle, 2026-09-29).

              This is the ONE control that emails the whole invoice — every document on it, one
              total, paid-to-date, the balance and one pay link (sendBalanceRequestEmail, which
              resolves to the root). It was called "Email final bill", which named a STAGE of a
              job rather than the thing it sends. So when Kyle went looking for a combined
              invoice after the Hoover job he found "Email invoice…" instead — the per-document
              signed copy — and got one document. The button now names the invoice and says what
              is due on it.
            */}
            <button
              className="btn btn-primary text-sm"
              disabled={emailRequest.isPending}
              onClick={() => emailRequest.mutate("balance")}
            >
              Email invoice {info.number} — {money(info.balance)} due
            </button>
            <button className="btn btn-secondary text-sm" onClick={() => setShowQr(showQr === "balance" ? null : "balance")}>
              {showQr === "balance" ? "Hide QR" : "Balance QR (in person)"}
            </button>
          </>
        )}
        {/*
          FINANCING, ON ITS OWN — alongside the invoice send, per Kyle's own words (see the
          header comment above). Relabels to "send again" once it has gone (never resets on a
          refetch — `lastFinancing` keeps reading true after this component remounts) so a
          second press reads as a decision, not a stale default.
        */}
        <button
          type="button"
          className="btn btn-secondary text-sm"
          disabled={financingSend.isPending}
          title="Emails the Synchrony financing link and an invitation to apply — no rates, terms or approval odds stated"
          onClick={() => financingSend.mutate()}
        >
          {financingSend.isPending
            ? "Sending…"
            // Relabels off EITHER signal: `lastFinancing` (a delivery already on file when the
            // panel opened) or `financingSend.isSuccess` (a send made just now, in this
            // session, before the invalidated query has had a chance to round-trip and
            // refetch) — so the relabel is never a beat behind the send that triggered it.
            : (lastFinancing || financingSend.isSuccess)
              ? "Send the financing link again"
              : "Email the financing link"}
        </button>
        {/*
          THE REVIEW ASK, ON ITS OWN — bypasses the automation gate because a human pressed it
          (Kyle switched AUTOMATED_CUSTOMER_SENDS_REVIEW_REQUESTS off 2026-10-01; until this
          button existed, no review request could reach a customer at all). Keyed by the JOB, so
          it's greyed with the reason — not hidden — when this panel only has an estimateId
          (InvoiceDrawer, AccountDetailPage, SigningModePage all open PaymentPanel that way).
        */}
        <button
          type="button"
          className="btn btn-secondary text-sm"
          disabled={!jobId || reviewSend.isPending}
          title={
            !jobId
              ? "This needs an open JOB, not just an estimate — send the review request from the job's own screen."
              : "Emails the Google review ask — refused unless the job is completed, this job hasn't already asked, and this customer hasn't been asked in the last 90 days"
          }
          onClick={() => reviewSend.mutate()}
        >
          {reviewSend.isPending
            ? "Sending…"
            : (lastReview || reviewSend.isSuccess)
              ? "Send the review request again"
              : "Email a review request"}
        </button>
        <button type="button" className="btn btn-secondary text-sm" onClick={toggleReviewQr}>
          {showReviewQr ? "Hide QR" : "Review QR (in person)"}
        </button>
        {!info.paidInFull && (
          <>
            {info.depositRequired && depositRemaining > 0 && (
              <button
                className="btn btn-secondary text-sm"
                onClick={() => { setRecording("deposit"); setKind("deposit"); setAmount(depositRemaining.toFixed(2)); }}
              >
                Record deposit (cash/check/Zelle)
              </button>
            )}
            <button
              className="btn btn-secondary text-sm"
              onClick={() => { setRecording("final"); setKind("final"); setAmount(info.balance.toFixed(2)); }}
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

      {/*
        LAST SENT (security review, 2026-10-01): financing had no repeat guard at all — every
        press re-emailed the customer — so showing when it last went is the whole remedy for
        that finding, same pattern as SendAssessmentReport's "Last sent to…" line.
      */}
      {lastFinancing && (
        <p className="mt-2 text-xs text-rce-muted">
          Financing last emailed to {lastFinancing.to} on {new Date(lastFinancing.createdAt).toLocaleDateString()}.
        </p>
      )}
      {lastReview && (
        <p className="mt-1 text-xs text-rce-muted">
          Review request last emailed to {lastReview.to} on {new Date(lastReview.createdAt).toLocaleDateString()}.
        </p>
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
      {notice && <p className="mt-2 text-xs text-green-700">{notice}</p>}
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}

      {/* The warranty company's side (Kyle, 2026-09-10): claim dates + "Record RELY payment",
          posted against the claim — never against the homeowner's balance above. */}
      {info.warranty && (
        <WarrantyClaimTracker
          estimateId={info.estimateId}
          onChanged={() => { void queryClient.invalidateQueries({ queryKey }); void queryClient.invalidateQueries({ queryKey: ["jobs"] }); }}
        />
      )}

      {info.payments.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-rce-muted">
          {info.payments.map((p) => (
            <li key={p.id}>
              {money(p.amount)} · {p.method} · {p.payer === "warranty" ? `${info.warranty?.claim.company ?? "warranty company"}` : p.kind}
              {p.checkNumber ? ` · check #${p.checkNumber}` : ""}
              {p.paidAt ? ` · ${new Date(p.paidAt).toLocaleDateString()}` : ""} · {p.status}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
