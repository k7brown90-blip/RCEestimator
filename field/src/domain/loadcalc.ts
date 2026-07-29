/**
 * The NEC Article 220 engine now lives in `app/shared/loadcalc/`, because the
 * CRM needs it for phone quoting and the server needs it to enforce the 220.87
 * gate — a guard that ran only in the browser would not be a guard.
 *
 * This re-export keeps the ~40 existing `domain/loadcalc` imports working. Point
 * new code at the shared module directly.
 */
export * from '../../../shared/loadcalc/loadcalc'
