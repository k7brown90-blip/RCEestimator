/**
 * What "Email to customer" / "Sign now" on the presentation screen will DO. The rule moved to
 * shared/presentIssue.ts (Phase 3 unit B, 2026-10-08) so the field app's "Show the customer" screen
 * asks the SAME function and cannot drift from this one. This file only re-exports it, so the CRM's
 * imports and tests are unchanged.
 */

export * from "../../../shared/presentIssue";
