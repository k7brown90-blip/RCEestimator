/**
 * The checklist definitions now live in `app/shared/checklist/`, because the
 * server's report generator renders the same narratives the app shows on site
 * — whatWeCheck / whatWeFound / whyItMatters and the reportLabel fragments.
 * A customer document that reworded them independently would drift from the
 * assessment it records (same reasoning as the Article 220 engine's move).
 *
 * This re-export keeps the existing `data/checklist` imports working. Point
 * new code at the shared module directly.
 */
export * from '../../../shared/checklist/checklist'
