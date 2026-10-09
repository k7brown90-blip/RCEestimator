/**
 * Why "Raise a change order" is unavailable, in Kyle's words, or null when it is available - ONE
 * sentence per refusal for both apps (Phase 2 unit E, 2026-10-08). The CRM's RaiseChangeOrderButton
 * (job, estimate and invoice drawers) and the field Job site screen's button both read it, and both
 * mirror what the server refuses (createChangeOrderDraft in services/issuedEstimateService.ts), so
 * the button never promises what the route will say no to. Greyed WITH the reason, never hidden:
 * a hidden button teaches the user the feature does not exist (CLAUDE.md click-through rule 5).
 */
export function changeOrderBlockReason(t: {
  /** Is there an estimate on this record at all? */
  hasEstimate: boolean;
  status?: string | null;
  /** Is there an agreement to change? A boolean: the refusal only needs to know whether something was signed. */
  signed: boolean;
}): string | null {
  if (!t.hasEstimate) return "No signed estimate on this record yet.";
  if (t.status === "void") return "This invoice is void — a voided record takes no new work.";
  if (t.status === "lost") return "This estimate is marked lost — reopen it first.";
  if (!t.signed) return "Nothing is signed yet. Change orders are for work already agreed — edit the estimate instead.";
  return null;
}
