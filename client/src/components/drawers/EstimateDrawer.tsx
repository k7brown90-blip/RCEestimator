/**
 * The estimate drawer (2026-09-20). The account page's estimate row, with its actions, wherever
 * the estimate is clicked: View (the company PDF), Edit (a DRAFT, in the builder), Copy to new,
 * Delete (unsigned), Void (signed), Resend (sent, unsigned), and — once signed — the door to its
 * invoice and its job.
 *
 * ── WHAT THIS DRAWER DOES NOT DO, ON PURPOSE (drawers plan, trap 6) ─────────────────────────
 * No Issue, no Revise, no Change order. Issuing a draft that already has a live estimate
 * silently becomes a REVISION — same number, revision +1 — and the customer's existing link
 * stops working (app.ts, /issued-estimates/:id/revise). Those belong in the builder, with its
 * confirms and its paper trail, so Edit LINKS OUT to it and nothing here can issue.
 *
 * Reads GET /issued-estimates/:id/record — the account-row projection with no capability token
 * in it (PUNCHLIST B4) — never /issued-estimates/:id, whose payload carries the customer's link.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api, openProtectedPdf } from "../../lib/api";
import { useDrawerParams } from "../../lib/drawers";
import { useEstimateRecord } from "../../lib/recordQueries";
import { LEAD_LOST_REASONS } from "../../lib/types";
import { money } from "../../lib/utils";
import { BounceBadge } from "../BounceBadge";
import { DeliveryChip } from "../DeliveryChip";
import { Drawer } from "../Drawer";
import { SendToPicker } from "../SendToPicker";
import { OpenDrawerButton } from "./OpenDrawerButton";

const STATUS_TONE: Record<string, string> = {
  draft: "bg-amber-100 text-amber-900",
  sent: "bg-sky-100 text-sky-900",
  viewed: "bg-sky-100 text-sky-900",
  signed: "bg-emerald-100 text-emerald-900",
  expired: "bg-amber-100 text-amber-900",
  lost: "bg-zinc-200 text-zinc-700",
  void: "bg-rce-border/50 text-rce-soft",
};

/** Sent, viewed or expired: out with the customer, unsigned — the only places "lost" starts from. */
const LOSABLE = new Set(["sent", "viewed", "expired"]);

export function EstimateDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const drawers = useDrawerParams();
  const { data, isLoading, error } = useEstimateRecord(id);
  const e = data?.estimate ?? null;

  const refresh = () => {
    for (const key of [["estimate-record", id], ["account-estimates"], ["estimate-chain"], ["invoices"], ["jobs"], ["account-summary"]]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };

  const [followUp, setFollowUp] = useState<string | null>(null);
  const deleteEstimate = useMutation({
    mutationFn: () => api.deleteIssuedEstimate(id),
    onSuccess: () => { refresh(); onClose(); },
    onError: (err) => setFollowUp((err as Error).message),
  });
  // Void (2026-09-17): cancels the job too; refunds and open P.O.s are left to Kyle by hand and
  // the response says which — kept on the drawer until it is closed.
  const voidEstimate = useMutation({
    mutationFn: (reason: string) => api.voidIssuedEstimate(id, reason),
    onSuccess: (r) => {
      refresh();
      const parts: string[] = [];
      if (r.jobAction === "cancelled" || r.jobAction === "cancelled_unscheduled") parts.push("Job cancelled.");
      else if (r.jobAction === "already_cancelled") parts.push("Job was already cancelled.");
      else if (r.jobAction === "left_open_other_estimates") parts.push("Job left open — other signed work still belongs to it.");
      if (r.paymentsTotal > 0) parts.push(`Refund $${r.paymentsTotal.toFixed(2)} in Stripe by hand if owed (non-refundable up to the existing cap).`);
      if (r.openPurchaseOrders.length > 0) parts.push(`Cancel open P.O.(s) by hand: ${r.openPurchaseOrders.map((p) => p.number).join(", ")}.`);
      setFollowUp(parts.join(" ") || "Voided.");
    },
    onError: (err) => setFollowUp((err as Error).message),
  });
  // New estimate from this one (Kyle, 2026-08-31): duplicate the draft and land in the builder on
  // the copy — the sent estimate itself is untouched. This NAVIGATES, by design: the builder is
  // the only place a document can be issued from.
  const duplicateDraft = useMutation({
    mutationFn: () => api.pbDuplicateDraft(e!.draftId),
    onSuccess: (copy) => {
      navigate(
        `/estimate-intake?account=${encodeURIComponent(e!.customerId)}` +
          `&address=${encodeURIComponent(e!.serviceAddressId)}` +
          `&draft=${encodeURIComponent(copy.id)}&tab=review`,
      );
    },
    onError: (err) => setFollowUp((err as Error).message),
  });

  // Lost (Kyle, 2026-09-20: "they either hire someone else or end up not moving forward") — the
  // customer's decision, NOT void. Same shape as Void beside it: a reason is required, from the
  // list leads already use, so the loss report is one report. Reopen is the way back.
  const [losing, setLosing] = useState(false);
  const [lostReason, setLostReason] = useState("");
  const [lostNotes, setLostNotes] = useState("");
  const markLost = useMutation({
    mutationFn: () => api.markEstimateLost(id, { reason: lostReason, notes: lostNotes.trim() || null }),
    onSuccess: () => { refresh(); setLosing(false); setLostReason(""); setLostNotes(""); setFollowUp("Marked lost."); },
    onError: (err) => setFollowUp((err as Error).message),
  });
  const reopen = useMutation({
    mutationFn: () => api.reopenEstimate(id),
    onSuccess: (r) => { refresh(); setFollowUp(`Reopened — back to ${r.status}.`); },
    onError: (err) => setFollowUp((err as Error).message),
  });

  // Resend to a chosen address (Kyle, 2026-08-25) — the same customer link goes out again.
  const [resending, setResending] = useState(false);
  const [to, setTo] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: () => api.pbIssuedSend(id, { to }),
    onSuccess: (r) => { setFollowUp(`Re-sent to ${r.to}.`); refresh(); },
    onError: (err) => setFollowUp((err as Error).message),
  });

  const unfinished = e?.status === "draft";
  const lost = e?.status === "lost";
  // Live = not void and not lost: nothing is sent, changed or invoiced on either until reopened.
  const live = e ? e.status !== "void" && !lost : false;

  return (
    <Drawer
      title={e ? e.title : "Estimate"}
      subtitle={e ? `${e.number}${e.revision > 1 ? ` rev ${e.revision}` : ""} · ${e.serviceAddress ?? "address missing"}` : undefined}
      onClose={onClose}
      headerActions={e ? <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium uppercase ${STATUS_TONE[e.status] ?? ""}`}>{e.status}</span> : null}
    >
      {error && <p className="text-sm text-red-600">Could not load this estimate: {(error as Error).message}</p>}
      {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}
      {e && (
        <div className="space-y-3 pb-4 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Link to={`/accounts/${e.customerId}`} className="btn btn-secondary px-2 py-0.5 text-xs min-h-0">{e.customerName} →</Link>
            {e.signedAt && live && <OpenDrawerButton kind="invoice" id={e.id} onOpen={drawers.open} label="Invoice & payment" />}
            {e.jobVisitId && <OpenDrawerButton kind="job" id={e.jobVisitId} onOpen={drawers.open} label="Job" />}
          </div>

          <div className="rounded-lg border border-rce-border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 text-xs text-rce-muted">
                <p>{e.customerEmail ?? "no email on this estimate"}</p>
                <p>issued {new Date(e.createdAt).toLocaleDateString()}{e.sentAt ? ` · sent ${new Date(e.sentAt).toLocaleDateString()}${e.sentTo ? ` to ${e.sentTo}` : ""}` : " · not sent"}</p>
                {e.signedAt && (
                  <p>signed {new Date(e.signedAt).toLocaleDateString()}{e.signerName ? ` by ${e.signerName}` : ""}{e.signedChannel === "in_person" ? " in person" : e.signedChannel === "email" ? " from the emailed link" : ""}</p>
                )}
                {e.supersededBy && <p>superseded by rev {e.supersededBy.revision}</p>}
                {e.changeOrderForId && <p>change order{e.changeOrderForNumber ? ` → invoice ${e.changeOrderForNumber}` : ""}</p>}
                {lost && (
                  <p className="font-semibold text-zinc-700">
                    Lost{e.lostAt ? ` ${new Date(e.lostAt).toLocaleDateString()}` : ""}{e.lostReason ? ` — ${e.lostReason}` : ""}{e.lostNotes ? `: "${e.lostNotes}"` : ""}
                  </p>
                )}
                {/* Kyle, 2026-08-22: "Is there any way to know if our emails have been read?" */}
                {e.sentAt && !e.signedAt && (
                  e.firstViewedAt ? (
                    <p className="font-semibold text-green-700">
                      Viewed {new Date(e.firstViewedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      {new Date(e.firstViewedAt).getTime() - new Date(e.sentAt).getTime() < 120_000 ? " · seconds after sending — possibly a mail scanner" : ""}
                    </p>
                  ) : (
                    <p className="text-amber-800">Not opened yet</p>
                  )
                )}
                {(e.lastBounceAt || e.lastDelivery) && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {e.lastBounceAt && <BounceBadge at={e.lastBounceAt} reason={e.lastBounceReason} />}
                    <DeliveryChip delivery={e.lastDelivery} />
                  </div>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p className="font-semibold">{money(e.billedTotal ?? e.total)}</p>
                {(e.warrantyCovered ?? 0) > 0 && (
                  <p className="text-[11px] text-green-700">
                    warranty {money(e.warrantyCovered ?? 0)}{e.warranty ? ` · ${e.warranty.company} claim ${e.warranty.claimNumber}` : ""}
                  </p>
                )}
                {e.depositRequired === false && <p className="text-[11px] text-rce-soft">no deposit</p>}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary text-sm" onClick={() => void openProtectedPdf(`/issued-estimates/${e.id}/pdf?audience=company`)}>
              View
            </button>
            {unfinished && (
              <button
                type="button"
                className="btn btn-primary text-sm"
                title="Opens the estimate builder — the only place a document is issued from"
                onClick={() =>
                  navigate(
                    `/estimate-intake?account=${encodeURIComponent(e.customerId)}` +
                      `&address=${encodeURIComponent(e.serviceAddressId)}` +
                      `&draft=${encodeURIComponent(e.draftId)}&tab=review`,
                  )
                }
              >
                Edit in builder
              </button>
            )}
            <button type="button" className="btn btn-secondary text-sm" disabled={duplicateDraft.isPending} onClick={() => duplicateDraft.mutate()}>
              {duplicateDraft.isPending ? "Copying…" : "Copy to new"}
            </button>
            {e.sentAt && !e.signedAt && live && (
              <button type="button" className="btn btn-secondary text-sm" onClick={() => setResending((s) => !s)}>
                {resending ? "Hide resend" : "Resend…"}
              </button>
            )}
            {!e.signedAt && (
              <button
                type="button"
                className="btn btn-danger text-sm"
                disabled={deleteEstimate.isPending}
                onClick={() => { if (window.confirm(`Delete estimate ${e.number}? This cannot be undone.`)) deleteEstimate.mutate(); }}
              >
                Delete
              </button>
            )}
            {!e.signedAt && live && LOSABLE.has(e.status) && !e.supersededBy && (
              <button type="button" className="btn btn-danger text-sm" onClick={() => setLosing((s) => !s)}>
                {losing ? "Cancel mark lost" : "Mark lost…"}
              </button>
            )}
            {lost && (
              <button type="button" className="btn btn-secondary text-sm" disabled={reopen.isPending} onClick={() => reopen.mutate()}>
                {reopen.isPending ? "Reopening…" : "Reopen"}
              </button>
            )}
            {e.signedAt && live && (
              <button
                type="button"
                className="btn btn-danger text-sm"
                disabled={voidEstimate.isPending}
                onClick={() => {
                  const reason = window.prompt(`Reason for voiding estimate ${e.number}?`);
                  if (!reason || !reason.trim()) return;
                  if (window.confirm(`Void estimate ${e.number} and cancel its job? This cannot be undone.\n\nReason: ${reason.trim()}`)) {
                    voidEstimate.mutate(reason.trim());
                  }
                }}
              >
                Void
              </button>
            )}
          </div>

          {losing && (
            <form
              className="space-y-2 rounded-lg border border-rce-border p-3"
              onSubmit={(event) => { event.preventDefault(); markLost.mutate(); }}
            >
              <p className="text-xs text-rce-muted">Why it didn't close — this is what the win rate and the loss report read. Not void: the quote was real, the customer said no.</p>
              <label className="block text-xs font-medium">
                Reason
                <select className="field mt-1" value={lostReason} onChange={(ev) => setLostReason(ev.target.value)} required>
                  <option value="">Pick one</option>
                  {LEAD_LOST_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label className="block text-xs font-medium">
                What they said <span className="text-rce-soft">(optional, internal only)</span>
                <textarea className="field mt-1" rows={2} value={lostNotes} onChange={(ev) => setLostNotes(ev.target.value)} />
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn btn-secondary text-xs" onClick={() => setLosing(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary text-xs" disabled={markLost.isPending || !lostReason}>{markLost.isPending ? "Saving…" : "Save as lost"}</button>
              </div>
            </form>
          )}

          {resending && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-rce-border p-3">
              <SendToPicker accountId={e.customerId} primaryEmail={e.customerEmail} onChange={setTo} />
              <button type="button" className="btn btn-primary text-xs" disabled={resend.isPending} onClick={() => resend.mutate()}>
                {resend.isPending ? "Sending…" : "Resend"}
              </button>
            </div>
          )}

          {followUp && <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">{followUp}</p>}

          {!unfinished && live && (
            <p className="text-xs text-rce-muted">
              Revising this estimate or raising a change order happens in the builder from the account page —
              issuing there replaces the customer's link on purpose, so it is never a one-tap action here.
            </p>
          )}
        </div>
      )}
    </Drawer>
  );
}
