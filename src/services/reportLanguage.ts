/**
 * Protocol v2 report language — the sentences that make the record defensible.
 *
 * Each block here implements a "must appear in every report" requirement from
 * the master protocol (§3.3 method limits, §6 sampling disclosure, §8.7 honest
 * limit, §11.3 disclaimer, Step 13 voltage-drop phrasing). They are code, not
 * template prose, because the wording is load-bearing: "exceeds the efficiency
 * benchmark described in an Informational Note" is defensible; "code
 * violation" for the same reading hands away the document's credibility
 * (90.5(C)). Tests pin the phrases.
 */

// ── Grounding instrument (§3.3) ──────────────────────────────────────────────
//
// Company instrument: EXTECH Earth Ground Resistance Tester Kit — a 3-point
// fall-of-potential tester with auxiliary spikes (confirmed by Kyle,
// 2026-08-02). Fall-of-potential is the strongest claim of the three methods:
// true electrode resistance. The method is still stored per inspection so a
// record made with a different instrument keeps its own honest wording forever.

export type GroundingTestMethod =
  | "fall_of_potential_3point"
  | "clamp_on_loop"
  | "bonding_continuity"
  | "not_recorded";

export const COMPANY_GROUNDING_METHOD: GroundingTestMethod = "fall_of_potential_3point";

const GROUNDING_LANGUAGE: Record<GroundingTestMethod, string> = {
  fall_of_potential_3point:
    "Grounding electrode resistance was measured by the 3-point fall-of-potential method (EXTECH earth " +
    "ground resistance tester with auxiliary test spikes). This method measures true electrode resistance " +
    "and requires adequate spacing for the auxiliary spikes; readings taken where spacing was constrained " +
    "are identified in the record.",
  clamp_on_loop:
    "Grounding measurements were taken with a clamp-on ground electrode tester. This method measures " +
    "electrode-system loop resistance — the electrode in series with the utility ground path — not the " +
    "isolated resistance of the electrode itself.",
  bonding_continuity:
    "Grounding measurements were taken with a low-resistance bonding tester. These readings verify " +
    "bonding and continuity path resistance only; they are not a measurement of grounding electrode " +
    "resistance and are not represented as one.",
  not_recorded:
    "The grounding measurement instrument for this assessment was not recorded; grounding readings in " +
    "this record are presented as comparative indications only.",
};

export function groundingMethodLanguage(method: string | null | undefined): string {
  return GROUNDING_LANGUAGE[(method as GroundingTestMethod) ?? "not_recorded"] ?? GROUNDING_LANGUAGE.not_recorded;
}

// ── §3.3 energized terminations — required wherever main lugs appear ────────

export function energizedTerminationLanguage(labels: string[]): string {
  const list = labels.length > 0 ? ` (${labels.join("; ")})` : "";
  return (
    `Service-side terminations${list} were assessed by thermal imaging under load and structured visual ` +
    "examination. Torque verification was not performed on these terminations, as they remain energized " +
    "with the service main open. Red Cedar Electric does not coordinate utility disconnects for torque " +
    "verification; this is a deliberate, disclosed scope boundary. Load-side devices in the same " +
    "equipment were de-energized and torque-verified where sampled."
  );
}

// ── Torque method limit (§3.3) ───────────────────────────────────────────────

export const TORQUE_METHOD_LIMIT =
  "Torque verification on an in-service termination detects a loose connection — the fastener moves " +
  "before reaching specification. A fastener that does not move confirms the connection is at or above " +
  "specification; it does not confirm correct original installation.";

// ── Voltage drop (Step 13) — advisory, never "violation" ────────────────────

export function voltageDropLanguage(measuredPct: number, benchmarkPct = 3): string {
  if (measuredPct <= benchmarkPct) {
    return `Measured voltage drop ${measuredPct}% is within the ${benchmarkPct}% efficiency benchmark described in NEC 210.19(A) Informational Note No. 4.`;
  }
  return (
    `Measured voltage drop ${measuredPct}% exceeds the efficiency benchmark described in NEC 210.19(A) ` +
    "Informational Note No. 4. Informational Notes are explanatory material and are not enforceable code " +
    "requirements (NEC 90.5(C)); this reading is reported as an efficiency observation, not a code violation."
  );
}

// ── Rule 4 — out-of-condition readings are volunteered, not hidden ──────────

export function methodConditionsLanguage(count: number): string {
  return (
    `${count} reading${count === 1 ? "" : "s"} in this record ${count === 1 ? "was" : "were"} taken outside ` +
    "the conditions specified by the cited method standard and are identified as such where they appear. " +
    "They are reported as indicative values and were not used as the sole basis of any classification."
  );
}

// ── §6 sampling disclosure ───────────────────────────────────────────────────

export interface SamplingDisclosureRow {
  category: string;
  totalCount: number;
  testedCount: number;
  basis: string;
  expandedDueToFail: boolean;
  untestedLocations?: string | null;
}

export function samplingDisclosure(row: SamplingDisclosureRow): string {
  const expansion = row.expandedDueToFail
    ? " A deficiency found within the sample expanded testing to 100% of this category."
    : "";
  const untested = row.untestedLocations ? ` Untested locations: ${row.untestedLocations}.` : "";
  return (
    `${capitalize(row.category)}: ${row.testedCount} of ${row.totalCount} tested. Sampling basis: ${row.basis}.` +
    expansion +
    untested
  );
}

// ── §8.7 honest limit — bus corrosion has no published numeric criterion ────

export const BUS_CORROSION_HONEST_LIMIT =
  "No manufacturer or standards body publishes a numeric acceptance criterion for corrosion on " +
  "residential panelboard bus. Bus conditions in this record are graded against Red Cedar Electric's " +
  "documented physical criteria and comparative thermal measurement at recorded load — a company " +
  "standard, disclosed as such.";

// ── §11.3 required disclaimer ────────────────────────────────────────────────

export function reportDisclaimer(dateStr: string): string {
  return (
    `This assessment reflects the condition of the electrical system only at the specific date (${dateStr}), ` +
    "load, and ambient conditions recorded, and covers the components and sample scope stated. It is not a " +
    "prediction of remaining service life, a guarantee that equipment will not fail, or an exhaustive " +
    "examination of components not listed."
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
