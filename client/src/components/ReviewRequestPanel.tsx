/**
 * The Google review ask and its manual confirmation — on the ACCOUNT, under Conversation notes.
 *
 * Kyle, 2026-10-02: "Under the conversation notes on the main account I would like a 'send google
 * review request' that emails the google review request. This way we can track if one is done or
 * not. Once once is done we can mark that and that button changes to review confirmed." And,
 * ruled the same day (E2): "I would like the google review to be a manual only marked and there to
 * be a button that sends them a review request. This way when we follow up with them we can send
 * it while we are on the phone with them and request it during a conversation."
 *
 * ── TWO CONTROLS, NOT ONE MORPHING BUTTON ───────────────────────────────────────────────────────
 * E2 settled the ambiguity in Kyle's first sentence: this is a SEND action and a SEPARATE manual
 * record, not one button that turns into the other. Sending never marks a review confirmed —
 * nothing this app does can know a review actually landed, Google doesn't tell us — and marking
 * one confirmed never requires having sent an ask first (a customer can leave one unprompted).
 *
 * ── A SIBLING OF ConversationNotes.tsx, NOT PART OF IT ──────────────────────────────────────────
 * ConversationNotes is explicitly "ONE COMPONENT, TWO SURFACES" (account page + job drawer),
 * reading and writing the account's call log. These two controls are account-wide but have
 * nothing to do with that log, and the job drawer has no use for either (the drawer already has
 * its OWN job-keyed review button in PaymentPanel, for a specific completed visit). Folding this
 * in would make ConversationNotes carry a second, unrelated concern on a surface that doesn't
 * want it. So this is its own component, rendered immediately after ConversationNotes on the
 * account page only — "under the conversation notes," literally.
 *
 * ── WHY THE SEND IS ACCOUNT-KEYED, NOT JOB-KEYED ────────────────────────────────────────────────
 * `PaymentPanel` already has a review-request button, but it needs a Visit.id and is greyed
 * whenever the panel has none — which is EVERY time AccountDetailPage opens it (always by
 * `estimateId`, never `jobId`; see PaymentPanel.test.tsx). A phone call is with a CUSTOMER, not a
 * job, so this button resolves the account's own most recently completed job itself — server-side,
 * authoritatively, via `POST /accounts/:id/email-review-request` — and greys only when there is
 * truly no completed job to resolve (CLAUDE.md click-through rule 5: greyed with a reason, never
 * hidden). Every other guard (no duplicate ask on that job, no repeat ask on this customer within
 * 90 days, email on file) comes back from the server as a plain-English 400, surfaced as-is — a
 * refusal Kyle can read out loud while still on the phone.
 *
 * ── "LAST SENT", THE SAME WAY SendAssessmentReport AND THE FINANCING BUTTON SHOW IT ─────────────
 * Both read past deliveries back from the server so the line survives a reload, not just the
 * current render. `jobId` here is resolved CLIENT-SIDE the same way the server resolves it (the
 * job with the latest `completedAt`) purely to ask "has a review request already gone out for
 * that job" — the query key and fetch are the EXACT text PaymentPanel already uses
 * (`["email-deliveries", "job", jobId, "review_request"]`, `api.emailDeliveries({ visitId: jobId,
 * limit: 10 })`), reused on purpose so this doesn't register as a second, different fetch under a
 * key that already means something (tests/queryKeyCollisions.test.ts).
 *
 * ── THE CONFIRMED MARK IS A FACT, NOT A TOGGLE ──────────────────────────────────────────────────
 * Nothing can detect a review landing, so this records who said so and when
 * (`Customer.reviewConfirmedAt` / `reviewConfirmedBy`) — same house pattern as CustomerNote's
 * `takenBy`: a required, un-prefilled name box, remembered in THIS browser's localStorage (the
 * exact key ConversationNotes already uses) so Kyle types his name once without a prefilled
 * "Kyle" attributing a second admin's work to him. Reversible like everything the app creates:
 * "Unconfirm" clears both fields back to null, the same single-word convention as EstimateDrawer's
 * "Unarchive".
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { AccountJob } from "../lib/types";
import { TAKEN_BY_STORAGE_KEY } from "./ConversationNotes";

function rememberedConfirmedBy(): string {
  try {
    return localStorage.getItem(TAKEN_BY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberConfirmedBy(name: string) {
  try {
    localStorage.setItem(TAKEN_BY_STORAGE_KEY, name);
  } catch {
    // Private window or blocked storage — the mark still saves; the name is just not remembered.
  }
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The visit this account's review-request button would resolve to — latest `completedAt` wins. */
function mostRecentlyCompletedJobId(jobs: AccountJob[]): string | undefined {
  let best: AccountJob | undefined;
  for (const job of jobs) {
    if (!job.completedAt) continue;
    if (!best || new Date(job.completedAt) > new Date(best.completedAt!)) best = job;
  }
  return best?.visitId;
}

export function ReviewRequestPanel({
  accountId,
  jobs,
  reviewConfirmedAt,
  reviewConfirmedBy,
}: {
  accountId: string;
  jobs: AccountJob[];
  reviewConfirmedAt: string | null;
  reviewConfirmedBy: string | null;
}) {
  const queryClient = useQueryClient();
  const jobId = mostRecentlyCompletedJobId(jobs);

  // Reused verbatim from PaymentPanel — same key, same fetch, so a review request sent from
  // either surface shows up as "last sent" on both without this reading as two different queries
  // under one cache key.
  const reviewDeliveries = useQuery({
    queryKey: ["email-deliveries", "job", jobId, "review_request"],
    queryFn: () => api.emailDeliveries({ visitId: jobId, limit: 10 }),
    enabled: Boolean(jobId),
  });
  const lastReview = reviewDeliveries.data?.find((d) => d.kind === "review_request") ?? null;

  const [sendMessage, setSendMessage] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () => api.emailAccountReviewRequest(accountId),
    onSuccess: (r) => {
      setSendMessage(`Review request emailed to ${r.to}.`);
      void queryClient.invalidateQueries({ queryKey: ["email-deliveries", "job", jobId, "review_request"] });
    },
    // The server's refusal (no completed job, already asked on that job, this customer asked
    // within 90 days, no email on file) is readable text — surfaced as-is, never swallowed.
    onError: (err) => setSendMessage((err as Error).message),
  });

  const [confirming, setConfirming] = useState(false);
  const [confirmedByInput, setConfirmedByInput] = useState(rememberedConfirmedBy);
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);

  const confirm = useMutation({
    mutationFn: () => api.setReviewConfirmed(accountId, { confirmedBy: confirmedByInput.trim() }),
    onSuccess: () => {
      rememberConfirmedBy(confirmedByInput.trim());
      setConfirming(false);
      setConfirmMessage(null);
      void queryClient.invalidateQueries({ queryKey: ["account-summary", accountId] });
    },
    onError: (err) => setConfirmMessage((err as Error).message),
  });

  const unconfirm = useMutation({
    mutationFn: () => api.clearReviewConfirmed(accountId),
    onSuccess: () => {
      setConfirmMessage(null);
      void queryClient.invalidateQueries({ queryKey: ["account-summary", accountId] });
    },
    onError: (err) => setConfirmMessage((err as Error).message),
  });

  const sendBlock = jobId ? null : "This account has no completed job yet — a review request needs one to send.";

  return (
    <section className="card mb-5 p-4" aria-label="Google review">
      <h2 className="text-lg font-semibold">Google review</h2>
      <p className="text-xs text-rce-muted">
        Ask for a review while you have them on the phone, and mark it once you see it on Google —
        nothing here can detect a review landing on its own.
      </p>

      <div className="mt-3 space-y-1">
        {lastReview && (
          <p className="text-xs text-rce-soft">
            Last sent to {lastReview.to} on {new Date(lastReview.createdAt).toLocaleDateString()}
          </p>
        )}
        <button
          type="button"
          className="btn btn-secondary text-sm"
          // Greyed with the reason beside it, never hidden (CLAUDE.md click-through rule 5).
          disabled={Boolean(sendBlock) || send.isPending}
          title={sendBlock ?? "Emails this account's Google review link to the customer on their most recently completed job"}
          onClick={() => send.mutate()}
        >
          {send.isPending ? "Sending…" : lastReview ? "Send it again" : "Send a Google review request"}
        </button>
        {sendBlock && <p className="text-xs text-rce-muted">{sendBlock}</p>}
        {sendMessage && <p className="text-xs text-rce-muted">{sendMessage}</p>}
      </div>

      <div className="mt-4 border-t border-rce-border/70 pt-3">
        {reviewConfirmedAt ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-rce-soft">
              Review confirmed {when(reviewConfirmedAt)}
              {reviewConfirmedBy ? ` — marked by ${reviewConfirmedBy}` : ""}
            </p>
            <button
              type="button"
              className="btn btn-secondary text-xs"
              disabled={unconfirm.isPending}
              title="Marks this review unconfirmed again — reversible, nothing here is one-way"
              onClick={() => unconfirm.mutate()}
            >
              {unconfirm.isPending ? "Undoing…" : "Unconfirm"}
            </button>
          </div>
        ) : confirming ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (confirmedByInput.trim()) confirm.mutate();
            }}
          >
            <label className="block text-xs font-medium text-rce-soft">
              Confirmed by
              <input
                className="field mt-1 w-56 max-w-full"
                value={confirmedByInput}
                onChange={(ev) => setConfirmedByInput(ev.target.value)}
                placeholder="Your name"
                autoFocus
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                className="btn btn-primary text-sm"
                disabled={!confirmedByInput.trim() || confirm.isPending}
                title={!confirmedByInput.trim() ? "Say who confirmed it." : "Records that this customer left a review"}
              >
                {confirm.isPending ? "Saving…" : "Mark review confirmed"}
              </button>
              <button type="button" className="btn btn-secondary text-sm" onClick={() => { setConfirming(false); setConfirmMessage(null); }}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="btn btn-secondary text-sm" onClick={() => setConfirming(true)}>
            Mark review confirmed
          </button>
        )}
        {confirmMessage && <p className="mt-1 text-xs text-red-600">{confirmMessage}</p>}
      </div>
    </section>
  );
}
