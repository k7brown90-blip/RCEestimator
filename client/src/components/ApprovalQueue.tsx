/**
 * The "Needs approval" queue (work order agent-team, U4/TC3): Messages -> the "Needs approval" chip lists
 * every draft waiting for a decision as an ApprovalCard, oldest first, with Approve, Edit and Reject on the
 * card itself. Click path from the Dashboard: Messages (left nav) -> "Needs approval (n)" -> "Approve and
 * send" (two clicks, then the "Send this email to ...?" confirm).
 *
 * Someone without the approve_drafts power can read what is waiting; every button is greyed and the power's
 * sentence is printed above the list. A decision's result stays on screen as a banner after the card leaves
 * the queue, so "Approved — SMS disabled" or "Not sent: No marketing text opt-in on record" is never missed.
 */
import { useState } from "react";
import { useHubApprovals } from "../lib/hubQueries";
import type { HubDecision } from "../lib/types";
import { sendBlockText } from "../../../shared/hub/sendBlocks";
import type { ApprovalCardView } from "../../../shared/hub/views";
import { ApprovalCard } from "./ApprovalCard";

/** One sentence about what a decision did, from the server's answer. */
export function decisionBanner(result: HubDecision, card: ApprovalCardView): string {
  const who = card.recipient ?? "the customer";
  const send = result.send;
  if (!send) return "Rejected. Nothing was sent.";
  if (send.status === "sent") return `Sent to ${who}.`;
  if (send.status === "posted") return "Posted.";
  if (send.status === "approved") return "Approved — texting is turned off, so it is held until texting is turned on. You can press Send now then, or Reject it.";
  if (send.status === "blocked") return `Not sent: ${sendBlockText(send.error)}`;
  return `Could not be sent: ${send.error ?? "see the delivery log"}. It stays on the conversation; you can try again.`;
}

export function ApprovalQueue() {
  const { data, isLoading, error } = useHubApprovals({ status: "pending" });
  const [banner, setBanner] = useState<string | null>(null);
  const cards = data?.cards ?? [];

  return (
    <div className="space-y-3" aria-label="Needs approval">
      {data && !data.canApprove && (
        <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="approval-queue-lock">
          You can read what is waiting. {data.approveReason}
        </p>
      )}
      {banner && (
        <p className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900" role="status" data-testid="decision-banner">{banner}</p>
      )}
      {error && <p className="text-sm text-red-600">Could not load the drafts: {(error as Error).message}</p>}
      {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}
      {cards.map((card) => (
        <ApprovalCard
          key={card.id}
          card={card}
          canApprove={data?.canApprove ?? false}
          approveReason={data?.approveReason ?? null}
          showThreadLink
          onDecided={(result, c) => setBanner(decisionBanner(result, c))}
        />
      ))}
      {!isLoading && !error && cards.length === 0 && <p className="text-sm text-rce-muted">Nothing is waiting for approval.</p>}
    </div>
  );
}
