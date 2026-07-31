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
  ["properties"],
  ["property"],
] as const;
