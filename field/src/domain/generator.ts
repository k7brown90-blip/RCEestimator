/**
 * The P031 generator sizing engine lives in `app/shared/loadcalc/` beside the
 * Article 220 engine it consumes — the server renders the customer one-pager
 * from the same code (one fact, one home).
 *
 * This re-export keeps field imports on the `domain/` path like its siblings.
 */
export * from '../../../shared/loadcalc/generator'
export * from '../../../shared/loadcalc/generatorData'
