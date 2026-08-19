/**
 * Query keys that several pages have to invalidate together.
 *
 * Defined once for the same reason `SCHEDULE_QUERY_KEYS` exists in
 * `components/JobScheduler.tsx`: an address touched on one page is read on three
 * others, and a list that quietly misses one of them is invisible until someone
 * wonders why a property they just added isn't in a dropdown.
 */

/**
 * Everything that reads an account or one of its addresses.
 *
 * `["properties"]` is the one that kept getting missed — `AccountDetailPage`
 * invalidated only the account, so adding an address left it absent from the
 * Jobs page's property picker until a hard reload.
 */
export const ADDRESS_QUERY_KEYS = [
  ["accounts"],
  ["account"],
  ["account-summary"],
  ["properties"],
  ["property"],
] as const;

/*
  ── A QUERY KEY NAMES A RESPONSE SHAPE, NOT A SUBJECT ──────────────────────────────────────────

  2026-08-19: `AccountDetailPage` and `PriceBookIntakePage` both cached under `["account", id]`,
  but they call DIFFERENT endpoints:

    /accounts/:id/summary  ->  { account, properties, jobs, totals, ... }
    /accounts/:id          ->  { id, name, properties, ... }        (no `jobs`)

  Whichever ran last won the cache. Attaching a draft to an account on the intake screen stored
  the second shape; opening that account's page then read it back, passed the `if (!summary)`
  guard because an object was there, and crashed on `summary.jobs.filter` — a white screen on a
  page that had never been touched.

  Nothing about the two keys looked wrong in either file; the collision was only visible with both
  open at once. So the rule is that the key names the ENDPOINT: two different responses never
  share one, however much they are "about" the same thing.
*/
