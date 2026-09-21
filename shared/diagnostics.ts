/**
 * THE CIRCUIT DIAGNOSTIC — the contract between the server and the phone.
 *
 * This file is the boundary (CLAUDE.md: "A change to data shape crossing
 * client/server or field/server belongs here, and both sides update together").
 * The field PWA casts every response with no runtime validation
 * (`crmRequest` does `body?.data as T`), so a key renamed on one side and not
 * the other fails SILENTLY on a technician's phone. Both sides import these
 * types, and `tests/fieldContract.test.ts` pins the serialized shape.
 *
 * ── THE RCE DIAGNOSTIC STANDARD (Kyle, 2026-09-20) ────────────────────────────
 * "The standard for RCE is inspect the breaker to the last outlet. The problem
 * may be found at the breaker, or at the last outlet. We check every one to
 * ensure the integrity of that circuit and to protect us. If that circuit was
 * bad and we stop to assume we fixed it all then a week later they call us back
 * for that same circuit with a problem at the next outlet over ... thats a
 * warranty call and money lost for us."
 *
 * SCOPE IS THE CIRCUIT, breaker to last outlet — never a count agreed in
 * advance. The quoted count estimates how big the circuit is; the examined count
 * is what it actually held. `coverage` is the report's own statement of whether
 * the whole circuit was walked and it prints on the FACE of the document —
 * that is the warranty defence on a callback, and it is why `partial` may not be
 * claimed without saying where the walk stopped and why.
 *
 * ── THE LINE THAT DECIDES THE MONEY ───────────────────────────────────────────
 * Wiring fixes made DURING the diagnostic are INCLUDED in the diagnostic price
 * (`fixed` records them, and they go on the customer's report). Faulty or
 * damaged EQUIPMENT is NOT (`equipmentDefective` + `defectDescription`) — that
 * becomes the resolutions change order, quoted from this record with the photos
 * behind it.
 *
 * NO NEW PRICING CONCEPT. `PriceBookDifficulty` already exists and each atomic
 * already carries an authoritative customer price per tier, so three tiers are
 * three lines of ONE diagnostic item. Difficulty is a FIELD OBSERVATION (Kyle,
 * 2026-08-11, schema.prisma:2653), never a blanket setting — which is exactly
 * why outlets found beyond the quoted count are charged at their OWN tier.
 */

// ── The money tiers. Identical to prisma's PriceBookDifficulty, spelled here so
//    the phone never imports @prisma/client. ──
export const DIFFICULTY_TIERS = ["NORMAL", "DIFFICULT", "VERY_DIFFICULT"] as const;
export type DiagnosticDifficulty = (typeof DIFFICULTY_TIERS)[number];

export const DIFFICULTY_LABEL: Record<DiagnosticDifficulty, string> = {
  NORMAL: "Normal access",
  DIFFICULT: "Difficult access",
  VERY_DIFFICULT: "Very difficult access",
};

// ── What is installed at the box. Kyle's list, plus `other` with a typed label:
//    "switch, receptacle, light fixture, splice only, disconnect, etc." ──
export const DEVICE_TYPES = [
  "receptacle",
  "switch",
  "light_fixture",
  "splice_only",
  "disconnect",
  "junction_box",
  "breaker",
  "smoke_alarm",
  "appliance",
  "other",
] as const;
export type DiagnosticDeviceType = (typeof DEVICE_TYPES)[number];

export const DEVICE_LABEL: Record<DiagnosticDeviceType, string> = {
  receptacle: "Receptacle",
  switch: "Switch",
  light_fixture: "Light fixture",
  splice_only: "Splice only",
  disconnect: "Disconnect",
  junction_box: "Junction box",
  breaker: "Breaker",
  smoke_alarm: "Smoke alarm",
  appliance: "Appliance / equipment",
  other: "Other",
};

export const COVERAGE_VALUES = ["whole_circuit", "partial"] as const;
export type DiagnosticCoverage = (typeof COVERAGE_VALUES)[number];

export const REPORT_STATUSES = ["in_progress", "complete", "void"] as const;
export type DiagnosticReportStatus = (typeof REPORT_STATUSES)[number];

/** One outlet, as the phone pushes it and as the server hands it back. */
export interface DiagnosticOutletPayload {
  /** PWA-minted UUID. The idempotency key: a retry lands on the same row. */
  id: string;
  sequence: number;
  locationLabel: string;
  deviceType: DiagnosticDeviceType;
  /** Free text, only when deviceType is `other`. */
  deviceLabel: string | null;
  enclosure: string | null;
  gangs: number | null;
  /** The circuit THIS box turned out to be on — not always the one under test. */
  circuitNumber: string | null;
  difficulty: DiagnosticDifficulty;
  vPhaseGround: number | null;
  vPhaseNeutral: number | null;
  /** Only where applicable — a 240 V device. */
  vPhasePhase: number | null;
  terminationsTightened: boolean;
  corrosion: boolean;
  corrosionNote: string | null;
  findings: string | null;
  /** What was FIXED here, during the diagnostic. Included in the price. */
  fixed: string | null;
  equipmentDefective: boolean;
  defectDescription: string | null;
  /** At least one. An outlet with no photo is a claim, not a record. */
  photoIds: string[];
}

/** The whole report, as the phone pushes it. */
export interface DiagnosticReportPush {
  reportId: string;
  visitId: string;
  reportDate: string;
  complaint: string;
  circuitLabel: string;
  circuitNumber: string | null;
  panelLocation: string | null;
  breakerRating: string | null;
  breakerInspected: boolean;
  coverage: DiagnosticCoverage;
  coverageNote: string | null;
  summary: string | null;
  diagnosticItemId: string | null;
  quotedNormal: number;
  quotedDifficult: number;
  quotedVeryDifficult: number;
  /** in_progress until the tech says the walk is finished. */
  status: Exclude<DiagnosticReportStatus, "void">;
  outlets: DiagnosticOutletPayload[];
  appVersion?: string;
}

export type TierCounts = Record<DiagnosticDifficulty, number>;

export const ZERO_TIERS: TierCounts = { NORMAL: 0, DIFFICULT: 0, VERY_DIFFICULT: 0 };

/** What the signed estimate bought, per tier, frozen onto the report. */
export interface DiagnosticQuoteContext {
  /** The price-book item the outlets are quoted under, when there is one. */
  diagnosticItemId: string | null;
  /** How that item was identified — stated, never guessed at silently. */
  source: "config" | "matched" | "none";
  quoted: TierCounts;
  /** The signed document the counts came off, for the tech to recognise. */
  estimateNumber: string | null;
}

/** The money summary the report, the PDF and the change order all read. */
export interface DiagnosticMoneySummary {
  quoted: TierCounts;
  examined: TierCounts;
  /** max(0, examined - quoted) per tier — the outlets the circuit turned out to hold. */
  overage: TierCounts;
  quotedTotal: number;
  examinedTotal: number;
  overageTotal: number;
}

/** The report as the server serializes it back to the phone and the CRM. */
export interface DiagnosticReportView {
  id: string;
  visitId: string;
  propertyId: string;
  customerId: string;
  technicianName: string | null;
  reportDate: string;
  complaint: string;
  circuitLabel: string;
  circuitNumber: string | null;
  panelLocation: string | null;
  breakerRating: string | null;
  breakerInspected: boolean;
  coverage: DiagnosticCoverage;
  coverageNote: string | null;
  /** The sentence that prints on the face of the document. */
  coverageStatement: string;
  summary: string | null;
  diagnosticItemId: string | null;
  status: DiagnosticReportStatus;
  completedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  changeOrderDraftId: string | null;
  money: DiagnosticMoneySummary;
  /** Outlets carrying damaged/defective equipment — what the change order quotes. */
  defectCount: number;
  /** Outlets where a wiring fix was made during the diagnostic — included. */
  fixedCount: number;
  deliveryCount: number;
  outlets: DiagnosticOutletPayload[];
  updatedAt: string;
}

export function countByTier(outlets: { difficulty: DiagnosticDifficulty }[]): TierCounts {
  const counts: TierCounts = { ...ZERO_TIERS };
  for (const outlet of outlets) counts[outlet.difficulty] += 1;
  return counts;
}

export function sumTiers(counts: TierCounts): number {
  return counts.NORMAL + counts.DIFFICULT + counts.VERY_DIFFICULT;
}

/**
 * The overage, per tier.
 *
 * Kyle's ruling is that the standard PREVENTS the awkward case: you never stop
 * short, so the report always covers the whole circuit and the examined count is
 * simply what the circuit held. Outlets beyond the quoted count are added at
 * their OWN tier — "the count is discovered, not negotiated" — so this is a
 * per-tier subtraction, never a single total. Three normals and two very
 * difficults quoted, then five normals and three very difficults found, is two
 * normals and one very difficult of overage, and they price differently.
 *
 * Negative never occurs: a tier examined fewer times than quoted is 0 here, not
 * a credit. The diagnostic that was bought was the circuit, not a shopping list.
 */
export function overageByTier(quoted: TierCounts, examined: TierCounts): TierCounts {
  return {
    NORMAL: Math.max(0, examined.NORMAL - quoted.NORMAL),
    DIFFICULT: Math.max(0, examined.DIFFICULT - quoted.DIFFICULT),
    VERY_DIFFICULT: Math.max(0, examined.VERY_DIFFICULT - quoted.VERY_DIFFICULT),
  };
}

export function moneySummary(quoted: TierCounts, examined: TierCounts): DiagnosticMoneySummary {
  const overage = overageByTier(quoted, examined);
  return {
    quoted,
    examined,
    overage,
    quotedTotal: sumTiers(quoted),
    examinedTotal: sumTiers(examined),
    overageTotal: sumTiers(overage),
  };
}

/**
 * The warranty sentence, printed on the face of the report.
 *
 * This is the single most load-bearing string in the feature. On a callback a
 * week later, it is what says the whole circuit was opened and tested rather
 * than just the outlet that failed. It never claims coverage the record does not
 * carry: a partial walk says so, says where it stopped, and says the untested
 * part of the circuit is not covered by this document.
 */
export function coverageStatement(input: {
  coverage: DiagnosticCoverage;
  coverageNote: string | null;
  circuitLabel: string;
  breakerInspected: boolean;
  examinedTotal: number;
}): string {
  const outlets = `${input.examinedTotal} ${input.examinedTotal === 1 ? "outlet" : "outlets"}`;
  if (input.coverage === "whole_circuit") {
    const breaker = input.breakerInspected
      ? "The breaker was inspected and every box on the circuit was opened"
      : "Every box on the circuit was opened";
    return (
      `WHOLE-CIRCUIT COVERAGE — ${input.circuitLabel}. ${breaker} and tested, ` +
      `breaker to last outlet: ${outlets} examined. This is the Red Cedar standard; ` +
      `we do not stop at the fault and assume the rest of the circuit is sound.`
    );
  }
  const why = (input.coverageNote ?? "").trim();
  return (
    `PARTIAL COVERAGE — ${input.circuitLabel}. ${outlets} examined; the circuit was NOT ` +
    `walked end to end${why ? `: ${why}` : "."} ` +
    `Anything on this circuit that was not opened and tested is not covered by this report.`
  );
}
