/**
 * "Raise a change order" — one control, every surface that shows a signed invoice.
 *
 * Kyle, 2026-09-29: "We need the drawer to be an action tool where as the tabs are the
 * informative tools … have the features expand to all areas not just one hard to find place."
 *
 * ── WHY THIS COMPONENT EXISTS ────────────────────────────────────────────────────────────────
 * Until now the only way to raise a change order in the CRM was a button at the bottom of the
 * Review tab of the estimate builder, inside `IssueAndSendPanel`, which renders only when the
 * URL carries `?draft=` — the draft that produced that signed estimate. And nothing linked
 * there: "Edit in builder" and the account page's "Edit" are both gated on `status === "draft"`,
 * so once an estimate was SENT or SIGNED no screen in the app could reach its draft. In
 * practice the only reliable path in the whole system was the field app's diagnostic screen.
 * See .claude/plans/2026-09-29-estimate-invoice-findability-audit.md, Finding 3.
 *
 * So this is the same action, hosted by the three drawers a person actually stands in when a
 * tech calls to say the job grew: the JOB, the ESTIMATE and the INVOICE. One component, so the
 * next change to it lands on all three at once.
 *
 * ── GREYED WITH THE REASON, NEVER HIDDEN ─────────────────────────────────────────────────────
 * CLAUDE.md click-through rule 5, and the reason it is a rule: a hidden button teaches the user
 * the feature does not exist, so they go and do the damaging thing instead — on 2026-09-23 a
 * hidden "Add line" on a closed P.O. produced a second P.O. for the same trip. Every refusal
 * the server can give has a matching `block` sentence here, so the button never promises what
 * `POST /issued-estimates/:id/change-order` will refuse.
 *
 * ── THE SERVER PICKS THE ROOT, NOT THIS ──────────────────────────────────────────────────────
 * Given a change order's id the route resolves `changeOrderForId ?? id` itself, so the money
 * group stays one level deep. Callers pass whatever estimate they are showing; they do not have
 * to know which one is the root.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

export type ChangeOrderTarget = {
  /** The signed estimate (or change order) to raise against. Null = nothing signed here. */
  estimateId: string | null;
  /** Its status, for the refusal wording. */
  status?: string | null;
  /**
   * Is there an agreement to change? A BOOLEAN, not a date, deliberately: the only thing the
   * refusal needs is whether something was signed, and a caller that holds no signature date
   * (the job drawer holds a payment summary, not the estimate row) must not have to invent one
   * to satisfy this type.
   */
  signed: boolean;
};

/**
 * Why the action is unavailable, in Kyle's words, or null when it is available.
 * Mirrors the server's refusals in app.ts POST /issued-estimates/:id/change-order.
 */
export function changeOrderBlock(t: ChangeOrderTarget): string | null {
  if (!t.estimateId) return "No signed estimate on this record yet.";
  if (t.status === "void") return "This invoice is void — a voided record takes no new work.";
  if (t.status === "lost") return "This estimate is marked lost — reopen it first.";
  if (!t.signed) return "Nothing is signed yet. Change orders are for work already agreed — edit the estimate instead.";
  return null;
}

export function RaiseChangeOrderButton({
  target,
  className = "btn btn-secondary text-sm",
  label = "Raise a change order",
}: {
  target: ChangeOrderTarget;
  className?: string;
  label?: string;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const block = changeOrderBlock(target);

  /*
    D3 (2026-09-29): the builder's copy of this was a bare `void api.pbChangeOrder(...).then()`
    with no catch, no pending state and no error surface — a refusal did nothing at all and the
    operator had no way to tell a "no" from a dead button. This one reports.
  */
  const raise = useMutation({
    mutationFn: () => api.pbChangeOrder(target.estimateId as string),
    onSuccess: (r) => {
      setError(null);
      // Straight into the empty change-order draft, on the Review tab where the lines are
      // added and the document is issued. Negative counts are accepted there and nowhere else.
      navigate(`/estimate-intake?draft=${encodeURIComponent(r.draftId)}&tab=review`);
    },
    onError: (err) => setError((err as Error).message),
  });

  return (
    <>
      <button
        type="button"
        className={className}
        // Greyed, with the reason on screen below — not hidden.
        disabled={Boolean(block) || raise.isPending}
        title={block ?? "Adds agreed work to this invoice — one balance, one payment"}
        onClick={() => raise.mutate()}
      >
        {raise.isPending ? "Raising…" : label}
      </button>
      {block && <p className="w-full text-xs text-rce-soft">{block}</p>}
      {error && <p className="w-full text-xs text-red-700">{error}</p>}
    </>
  );
}
