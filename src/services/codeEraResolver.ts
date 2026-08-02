/**
 * Code-era resolver — protocol v2 §1.3.
 *
 * Tennessee enforces no single NEC edition; the edition that governs an
 * assessment is the AHJ's adopted edition at the property, and the edition a
 * FAIL may be judged against is bounded by the property's install era. This
 * module is the ONE place both questions are answered. Nothing anywhere in
 * the app may hardcode a code edition (§1.3).
 *
 * Two distinct questions, deliberately separate:
 *
 * 1. `resolveAhjEdition(property)` — which edition does the AHJ enforce HERE?
 *    Drives SPD/AFCI/GFCI/TR classification between FAIL-if-required vs
 *    UPGRADE-if-only-newer-code. Property.ahjCodeEdition (intake override)
 *    wins; falls back to the jurisdiction's edition mapping.
 *
 * 2. `classifyAgainstRequirement(...)` — hard rule 5 (§12.3): no item may be
 *    classified FAIL against a requirement whose edition postdates the
 *    property's estimated install date, unless the requirement is explicitly
 *    retroactive. The function BLOCKS the illegal classification rather than
 *    discouraging it — an UPGRADE comes back instead, with the reason.
 */

import { prisma } from "../lib/prisma";
import { resolveJurisdiction } from "./jurisdictionResolver";

/** Editions the platform knows, oldest first — order is the comparison. */
const EDITION_ORDER = ["pre2017", "2017", "2020", "2023"] as const;
export type NecEdition = (typeof EDITION_ORDER)[number];

/** Jurisdiction → enforced edition. Mirrors field/src/data/jurisdictions.ts. */
const JURISDICTION_EDITIONS: Record<string, NecEdition> = {
  murfreesboro: "2017",
  brentwood: "2017",
  rutherford: "2017",
  franklin: "2023",
  nashville: "2023",
};

const DEFAULT_EDITION: NecEdition = "2017";

function editionRank(edition: string): number {
  const idx = EDITION_ORDER.indexOf(edition as NecEdition);
  return idx === -1 ? 0 : idx;
}

export interface AhjEditionResolution {
  edition: NecEdition;
  /** Where the answer came from — reports disclose this. */
  source: "property_override" | "jurisdiction" | "default";
  jurisdictionId: string | null;
}

/** The AHJ's enforced NEC edition for a property. */
export async function resolveAhjEdition(propertyId: string): Promise<AhjEditionResolution> {
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
    select: { id: true, ahjCodeEdition: true, jurisdictionId: true, city: true, state: true, postalCode: true },
  });

  if (property.ahjCodeEdition && EDITION_ORDER.includes(property.ahjCodeEdition as NecEdition)) {
    return {
      edition: property.ahjCodeEdition as NecEdition,
      source: "property_override",
      jurisdictionId: property.jurisdictionId,
    };
  }

  const resolved = await resolveJurisdiction({
    jurisdictionId: property.jurisdictionId,
    city: property.city,
    state: property.state,
    postalCode: property.postalCode,
  });
  const jurisdictionId = resolved.jurisdictionId ?? null;
  const mapped = jurisdictionId ? JURISDICTION_EDITIONS[jurisdictionId] : undefined;

  return {
    edition: mapped ?? DEFAULT_EDITION,
    source: mapped ? "jurisdiction" : "default",
    jurisdictionId,
  };
}

export type V2Classification = "pass" | "fail" | "monitor" | "upgrade";

export interface RequirementClassification {
  classification: V2Classification;
  codeEditionApplied: NecEdition;
  /** Present whenever the resolver changed or blocked the caller's intent. */
  reason?: string;
}

/**
 * Classify a code-referenced deficiency, enforcing hard rule 5.
 *
 * `deficient` = the condition the requirement describes is absent/unmet.
 * The caller proposes nothing; the rules decide:
 * - not deficient → pass
 * - deficient + requirement in force at the property's install era → fail
 * - deficient + requirement newer than the install era + not retroactive
 *   → upgrade (blocked from FAIL, with the reason recorded)
 * - deficient + requirement newer + explicitly retroactive → fail
 * - unknown install year → the conservative answer is UPGRADE, disclosed:
 *   without an install era a FAIL against any post-baseline edition cannot
 *   be defended (§1.4 hard rule).
 */
export async function classifyAgainstRequirement(input: {
  propertyId: string;
  codeRequirementId: string;
  deficient: boolean;
}): Promise<RequirementClassification> {
  const requirement = await prisma.codeRequirement.findUniqueOrThrow({
    where: { id: input.codeRequirementId },
  });
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: input.propertyId },
    select: { estimatedInstallYear: true },
  });
  const ahj = await resolveAhjEdition(input.propertyId);

  if (!input.deficient) {
    return { classification: "pass", codeEditionApplied: ahj.edition };
  }

  // Requirement not yet adopted by this AHJ at all → recommendation territory.
  if (editionRank(requirement.necEditionIntroduced) > editionRank(ahj.edition)) {
    return {
      classification: "upgrade",
      codeEditionApplied: ahj.edition,
      reason: `${requirement.necArticle} first appears in NEC ${requirement.necEditionIntroduced}; this AHJ enforces ${ahj.edition}. Not a code requirement here — recommended improvement only.`,
    };
  }

  if (requirement.isRetroactive) {
    return { classification: "fail", codeEditionApplied: ahj.edition };
  }

  const installYear = property.estimatedInstallYear;
  if (installYear == null) {
    return {
      classification: "upgrade",
      codeEditionApplied: ahj.edition,
      reason:
        "Install era unknown — a FAIL against a code provision cannot be defended without knowing the code in " +
        "effect at installation (protocol §1.4). Recorded as UPGRADE; set the property's estimated install year to re-judge.",
    };
  }

  const installEdition = editionForInstallYear(installYear);
  if (editionRank(requirement.necEditionIntroduced) > editionRank(installEdition)) {
    return {
      classification: "upgrade",
      codeEditionApplied: ahj.edition,
      reason: `${requirement.necArticle} was introduced in NEC ${requirement.necEditionIntroduced}, after this installation (~${installYear}, ${installEdition} era), and is not retroactive. Compliant as installed — not a defect (protocol §1.4).`,
    };
  }

  return { classification: "fail", codeEditionApplied: ahj.edition };
}

/**
 * The edition era an install year falls into. Coarse by design: pre-2017
 * installs collapse to "pre2017" because the platform's rule library starts at
 * 2017 — a requirement introduced IN or AFTER 2017 can then never FAIL a
 * pre-2017 install, which is exactly the protection rule 5 demands. Finer
 * pre-2017 resolution can be added if a rule ever needs it.
 */
export function editionForInstallYear(year: number): NecEdition {
  if (year >= 2023) return "2023";
  if (year >= 2020) return "2020";
  if (year >= 2017) return "2017";
  return "pre2017";
}
