/**
 * The "Unsaved changes" tag on a folded Settings row (Kyle, 2026-11-26, "A card with a live warning (agents off, events not being
 * sent, unsaved changes) opens by itself"): a folded card never hides typing that has not been saved. Put it in the card's `summary`
 * and pass the same flag as `attention`.
 */
export function UnsavedNote({ show }: { show: boolean }) {
  if (!show) return null;
  return <span className="ml-2 font-semibold text-amber-800" data-testid="unsaved-note">Unsaved changes</span>;
}
