/**
 * WHICH PLATFORM sent a lead — ONE definition, read by the server, the CRM client and the tests
 * (Kyle, 2026-09-20, the four-phase funnel).
 *
 * This is NOT `Lead.source`. `source` records HOW a lead arrived (email | phone | web | manual |
 * referral | savannah_text | retention) and has history on every lead; it is untouched. Platform
 * records WHO SENT IT — the thing the marketing spend goes to — so phase 1 of the funnel
 * (lead -> opportunity, BY PLATFORM) can answer "is Google / Yelp / Nextdoor / Angi worth it".
 *
 * Tagged at intake: the website form sends it where it knows it; Kyle or Savannah picks it on a
 * phone lead. Carried onto the Customer at convert, so phase 4 (lifetime spend, repeat work)
 * can be read by the same dimension. Null = never recorded (every lead before this existed);
 * reports show that as "unknown" rather than guessing.
 */

export const LEAD_PLATFORMS = ["google", "yelp", "nextdoor", "angi", "referral", "repeat_customer", "other"] as const;
export type LeadPlatform = (typeof LEAD_PLATFORMS)[number];

/** How each value reads on a screen. */
export const LEAD_PLATFORM_LABELS: Record<LeadPlatform, string> = {
  google: "Google",
  yelp: "Yelp",
  nextdoor: "Nextdoor",
  angi: "Angi",
  referral: "Referral",
  repeat_customer: "Repeat customer",
  other: "Other",
};

/** The report bucket for a lead or account that was never tagged. */
export const UNKNOWN_PLATFORM = "unknown";

export function isLeadPlatform(value: unknown): value is LeadPlatform {
  return typeof value === "string" && (LEAD_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Loose intake normalisation for the webhook door only: the website is outside this repo and a
 * misspelt value must not cost a lead. "Google Ads" -> google, "Angi Leads" -> angi, anything
 * unrecognised -> null (unknown), never a 400.
 */
export function normalizeLeadPlatform(value: unknown): LeadPlatform | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (isLeadPlatform(v)) return v;
  for (const p of LEAD_PLATFORMS) {
    if (v.startsWith(p)) return p;
  }
  if (v === "repeat" || v === "existing_customer") return "repeat_customer";
  return null;
}

export function platformLabel(value: string | null | undefined): string {
  if (!value) return "Unknown";
  return isLeadPlatform(value) ? LEAD_PLATFORM_LABELS[value] : value;
}
