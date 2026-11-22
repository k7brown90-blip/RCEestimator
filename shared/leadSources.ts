/**
 * HOW a lead arrived - the one list. The office door (POST /crm/leads) validates against it, the CRM
 * form offers it, and the signed agent events (services/hubEvents.ts) never send a source outside it:
 * the website door (POST /leads) stores whatever string it is given, so a value that is not on this
 * list reaches an agent as "other", never as the free text it was.
 */
/** `manual` is what the CRM's own form uses; the rest are what writes them today. */
export const LEAD_SOURCES = [
  "manual", "phone", "email", "web", "referral", "savannah_text", "retention",
] as const;
export type LeadSourceValue = (typeof LEAD_SOURCES)[number];

/** The stored source when it is on the list, else "other". */
export function closedLeadSource(value: unknown): LeadSourceValue | "other" {
  return typeof value === "string" && (LEAD_SOURCES as readonly string[]).includes(value) ? (value as LeadSourceValue) : "other";
}
