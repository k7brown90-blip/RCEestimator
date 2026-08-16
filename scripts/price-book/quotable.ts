/**
 * Quotability parsing — the workbook's free text mapped onto the enum that enforces the
 * quarantine.
 *
 * Extracted from `importPriceBook.ts` by P018 for one reason: that file runs `main()` on import,
 * so the parser could not be unit-tested without executing a real import. The rules, and the
 * reasoning behind the deliberate YES/NO asymmetry, are documented on `parseQuotable` below.
 */

import { PriceBookQuotable } from "@prisma/client";

/**
 * `NO` optionally followed by a reason. The separator is required so that only a standalone NO
 * qualifies: `NOPE`, `NOT SURE` and `NONE` do not match.
 */
const NO_WITH_REASON = /^NO\b(?:[\s\-–—:].*)?$/;

/**
 * Map a Quotable cell onto the enum. Throws on anything it cannot read.
 *
 * ── WHY `NO - <reason>` IS ACCEPTED (P018) ───────────────────────────────────────────────────
 *
 * Kyle records rulings in the cell where he makes them:
 *
 *   NO - KYLE RULING 2026-08-16 (SUTHERLANDS is not an RCE buying channel)
 *   NO - SUPERSEDED (Kyle ruling 2026-08-12; $2.18 verified)
 *   NO - SUPERSEDED DUPLICATE (same Item x Supplier as row 90; consolidated 2026-08-14)
 *   NO - SUPERSEDED BY KYLE RULING 2026-08-14 (GB001 = 12-terminal PK12GTACP, …)
 *
 * The old rule accepted free text after NEVER but demanded an exact match for NO, so a
 * `NO — NEVER (employer account)` parsed while a `NO - <reason>` was fatal. That asymmetry
 * stopped two production imports on 2026-08-16 (P016 §1, §8) and hid the fact that Kyle had
 * already quarantined the three duplicate price rows the importer kept warning about.
 *
 * ── WHAT IS AND IS NOT LOOSENED ──────────────────────────────────────────────────────────────
 *
 * `decisions/2026-08-14-accuracy-standard-and-pricing-throughput.md`: **"a wrong price outranks a
 * missing one."** This reads a convention; it does not default unknowns.
 *
 *   * `YES` stays EXACT. An annotated YES is still fatal, deliberately — a value that *might*
 *     mean "quotable" is precisely what must never default in. The asymmetry between the two
 *     directions is not an oversight; their costs are not symmetric.
 *   * `NO` must be followed by a separator or end the string.
 *   * NEVER is checked FIRST, so `NO — NEVER (…)` lands on NEVER rather than on plain NO.
 */
export function parseQuotable(raw: string | null, where: string): PriceBookQuotable {
  const v = (raw ?? "").trim().toUpperCase();
  if (v === "YES") return PriceBookQuotable.YES;
  // NEVER before NO — a "NO — NEVER (…)" value satisfies both patterns and must land on NEVER.
  if (v.startsWith("NO") && v.includes("NEVER")) return PriceBookQuotable.NEVER;
  if (NO_WITH_REASON.test(v)) return PriceBookQuotable.NO;
  throw new Error(
    `Unrecognised Quotable value ${JSON.stringify(raw)} at ${where}. ` +
      `Expected "YES", "NO" (optionally followed by a reason, e.g. "NO - SUPERSEDED …"), ` +
      `or a "NO — NEVER" variant. Refusing to guess: an unreadable quotable flag defaulting ` +
      `to YES is how a quarantined price reaches a customer.`
  );
}
