/**
 * Protocol v2 reference data seed — idempotent, append-only aware.
 *
 * Seeds three reference sets from the master protocol:
 *  - Thermal thresholds (§7.2 / Step 6): NETA MTS Table 100.18 framework —
 *    fully specified by the protocol, seeded as verified-by-citation.
 *  - Torque specs (§7.1): compiled values seeded with sourceConfidence flags
 *    and NO verificationDate. ⚠ The protocol requires each value verified
 *    against current official manufacturer spec sheets before production
 *    reliance; verification stamps verificationDate/verifiedSource on the row.
 *  - Code requirements (§1.3): the edition-gated rules the code-era resolver
 *    reads. Starter set covering SPD, GFCI expansions, AFCI, TR receptacles,
 *    emergency disconnect.
 *
 * Idempotency: rows are keyed by a deterministic id so re-running upserts
 * rather than duplicates. Append-only policy applies to REVISIONS (new row +
 * supersededById), which this seed never performs.
 *
 * Run: npx tsx scripts/seedProtocolV2Reference.ts  (or `railway run ...`)
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ── Thermal thresholds — §7.2, NETA MTS Table 100.18 framework ───────────────

const THERMAL = [
  {
    id: "thermal-comparative-monitor",
    method: "comparative",
    deltaTMinC: 1,
    deltaTMaxC: 3,
    classification: "MONITOR",
    recommendedAction: "Possible deficiency — re-check at next inspection interval.",
    standardCitation: "NETA MTS Table 100.18 framework (as referenced by Fluke Corporation)",
  },
  {
    id: "thermal-comparative-fail",
    method: "comparative",
    deltaTMinC: 4,
    deltaTMaxC: 15,
    classification: "FAIL",
    recommendedAction: "Probable deficiency — repair as time permits.",
    standardCitation: "NETA MTS Table 100.18 framework (as referenced by Fluke Corporation)",
  },
  {
    id: "thermal-comparative-fail-immediate",
    method: "comparative",
    deltaTMinC: 15,
    deltaTMaxC: null,
    classification: "FAIL_IMMEDIATE",
    recommendedAction: "Major discrepancy — repair immediately.",
    standardCitation: "NETA MTS Table 100.18 framework (as referenced by Fluke Corporation)",
  },
  {
    id: "thermal-absolute-fail-immediate",
    method: "absolute",
    deltaTMinC: 40,
    deltaTMaxC: null,
    classification: "FAIL_IMMEDIATE",
    recommendedAction: ">40 °C above ambient — repair immediately.",
    standardCitation: "NETA MTS Table 100.18 framework (as referenced by Fluke Corporation)",
  },
];

// ── Torque specs — §7.1. UNVERIFIED until checked against official sheets ────

interface TorqueSeed {
  id: string;
  manufacturer: string | null; // null = generic fallback
  model: string | null;
  torqueValue: number;
  torqueUnit: "in_lb" | "ft_lb";
  breakerRatingMinA?: number;
  breakerRatingMaxA?: number;
  conductorSizeMin?: string;
  conductorSizeMax?: string;
  sourceCitation: string;
  sourceConfidence: "manufacturer_doc" | "cross_reference" | "field_reported";
}

const TORQUE: TorqueSeed[] = [
  // Square D / Schneider
  { id: "tq-sqd-qo", manufacturer: "Square D / Schneider Electric", model: "QO/QOB", torqueValue: 32.5, torqueUnit: "in_lb", sourceCitation: "Schneider FAQ FA128927 (range 20–45 in-lb by amperage — midpoint seeded; use panel label)", sourceConfidence: "manufacturer_doc" },
  { id: "tq-sqd-nq-200", manufacturer: "Square D / Schneider Electric", model: "NQ Panelboard MLO 200A", torqueValue: 27.5, torqueUnit: "in_lb", sourceCitation: "Schneider FAQ FA232163 (25–30 in-lb)", sourceConfidence: "manufacturer_doc" },
  { id: "tq-sqd-f-frame", manufacturer: "Square D / Schneider Electric", model: "F Frame", torqueValue: 80.4, torqueUnit: "in_lb", sourceCitation: "Cross-reference table (6.7 ft-lb)", sourceConfidence: "cross_reference" },
  { id: "tq-sqd-k-frame", manufacturer: "Square D / Schneider Electric", model: "K Frame", torqueValue: 250.8, torqueUnit: "in_lb", sourceCitation: "Cross-reference table (20.9 ft-lb)", sourceConfidence: "cross_reference" },
  { id: "tq-sqd-l-frame", manufacturer: "Square D / Schneider Electric", model: "L Frame", torqueValue: 375.6, torqueUnit: "in_lb", sourceCitation: "Cross-reference table (31.3 ft-lb)", sourceConfidence: "cross_reference" },
  { id: "tq-sqd-m-frame", manufacturer: "Square D / Schneider Electric", model: "M Frame", torqueValue: 300, torqueUnit: "in_lb", sourceCitation: "Cross-reference table (25.0 ft-lb)", sourceConfidence: "cross_reference" },
  // Eaton / Cutler-Hammer
  { id: "tq-eaton-general", manufacturer: "Eaton / Cutler-Hammer", model: null, torqueValue: 27.5, torqueUnit: "in_lb", sourceCitation: "Eaton torque specification page (20–35 in-lb by wire size — midpoint seeded)", sourceConfidence: "manufacturer_doc" },
  { id: "tq-eaton-ch-14-10", manufacturer: "Eaton / Cutler-Hammer", model: "CH series", conductorSizeMin: "14 AWG", conductorSizeMax: "10 AWG", torqueValue: 20, torqueUnit: "in_lb", sourceCitation: "Field-documented", sourceConfidence: "field_reported" },
  { id: "tq-eaton-f-frame", manufacturer: "Eaton / Cutler-Hammer", model: "F Frame", torqueValue: 120, torqueUnit: "in_lb", sourceCitation: "Legacy table (10.0 ft-lb)", sourceConfidence: "cross_reference" },
  { id: "tq-eaton-j-frame", manufacturer: "Eaton / Cutler-Hammer", model: "J Frame", torqueValue: 274.8, torqueUnit: "in_lb", sourceCitation: "Legacy table (22.9 ft-lb)", sourceConfidence: "cross_reference" },
  { id: "tq-eaton-k-frame-lt250", manufacturer: "Eaton / Cutler-Hammer", model: "K Frame (<250 MCM)", torqueValue: 274.8, torqueUnit: "in_lb", sourceCitation: "Legacy table (22.9 ft-lb)", sourceConfidence: "cross_reference" },
  { id: "tq-eaton-k-frame-gte250", manufacturer: "Eaton / Cutler-Hammer", model: "K Frame (>=250 MCM)", torqueValue: 375.6, torqueUnit: "in_lb", sourceCitation: "Legacy table (31.3 ft-lb)", sourceConfidence: "cross_reference" },
  { id: "tq-eaton-large-lugs", manufacturer: "Eaton / Cutler-Hammer", model: "Large lugs 4/0-500 kcmil", conductorSizeMin: "4/0 AWG", conductorSizeMax: "500 kcmil", torqueValue: 375, torqueUnit: "in_lb", sourceCitation: "Eaton marine torque doc (up to 375 in-lb)", sourceConfidence: "manufacturer_doc" },
  // Siemens
  { id: "tq-siemens-15a", manufacturer: "Siemens", model: "Standard 15A breakers", conductorSizeMin: "14 AWG", conductorSizeMax: "6 AWG", torqueValue: 25, torqueUnit: "in_lb", sourceCitation: "Field-documented", sourceConfidence: "field_reported" },
  // GE
  { id: "tq-ge-thql", manufacturer: "GE", model: "THQL series", torqueValue: 45, torqueUnit: "in_lb", sourceCitation: "GE technical documentation", sourceConfidence: "manufacturer_doc" },
  { id: "tq-ge-tqd", manufacturer: "GE", model: "TQD series", torqueValue: 200, torqueUnit: "in_lb", sourceCitation: "GE technical support", sourceConfidence: "manufacturer_doc" },
  // Generic fallback — flagged lowest confidence by nature
  { id: "tq-generic-le30", manufacturer: null, model: null, breakerRatingMaxA: 30, torqueValue: 36, torqueUnit: "in_lb", sourceCitation: "Generic cross-brand fallback (§7.1) — lowest confidence; panel label overrides", sourceConfidence: "cross_reference" },
  { id: "tq-generic-35-70", manufacturer: null, model: null, breakerRatingMinA: 35, breakerRatingMaxA: 70, torqueValue: 45, torqueUnit: "in_lb", sourceCitation: "Generic cross-brand fallback (§7.1) — lowest confidence; panel label overrides", sourceConfidence: "cross_reference" },
  { id: "tq-generic-ge75", manufacturer: null, model: null, breakerRatingMinA: 75, torqueValue: 50, torqueUnit: "in_lb", sourceCitation: "Generic cross-brand fallback (§7.1) — lowest confidence; panel label overrides", sourceConfidence: "cross_reference" },
];

// ── Code requirements — §1.3 starter set for the code-era resolver ───────────

const CODE_REQUIREMENTS = [
  {
    id: "req-spd-dwelling-service",
    necArticle: "230.67",
    necEditionIntroduced: "2020",
    requirementType: "spd",
    appliesTo: "dwelling unit services",
    isRetroactive: false,
    description: "Surge protective device (Type 1 or 2) required for dwelling unit services. On a 2017 AHJ this is never a code citation — UPGRADE only. 230.67(D) makes it required when service equipment is replaced.",
  },
  {
    id: "req-gfci-kitchen-receptacles",
    necArticle: "210.8(A)(6)",
    necEditionIntroduced: "pre2017",
    requirementType: "gfci_location",
    appliesTo: "kitchen countertop receptacles",
    isRetroactive: false,
    description: "GFCI protection for kitchen countertop receptacles (long-standing; present well before 2017).",
  },
  {
    id: "req-gfci-bathroom",
    necArticle: "210.8(A)(1)",
    necEditionIntroduced: "pre2017",
    requirementType: "gfci_location",
    appliesTo: "bathroom receptacles",
    isRetroactive: false,
    description: "GFCI protection for bathroom receptacles (long-standing).",
  },
  {
    id: "req-gfci-laundry",
    necArticle: "210.8(A)(10)",
    necEditionIntroduced: "2017",
    requirementType: "gfci_location",
    appliesTo: "laundry area receptacles",
    isRetroactive: false,
    description: "GFCI protection extended to laundry areas in the 2017 cycle.",
  },
  {
    id: "req-afci-dwelling-expansion",
    necArticle: "210.12(A)",
    necEditionIntroduced: "pre2017",
    requirementType: "afci_coverage",
    appliesTo: "dwelling unit habitable rooms and specified areas",
    isRetroactive: false,
    description: "AFCI coverage for specified dwelling circuits; scope has expanded across cycles. Gaps relative to a NEWER edition than install are UPGRADE, never FAIL.",
  },
  {
    id: "req-tr-receptacles",
    necArticle: "406.12",
    necEditionIntroduced: "pre2017",
    requirementType: "tr_receptacle",
    appliesTo: "dwelling unit 15A/20A 125V receptacles",
    isRetroactive: false,
    description: "Tamper-resistant receptacles in dwelling units (introduced 2008 cycle — pre-platform-baseline). A pre-2008 install without TR is compliant as installed: UPGRADE.",
  },
  {
    id: "req-emergency-disconnect",
    necArticle: "230.85",
    necEditionIntroduced: "2020",
    requirementType: "emergency_disconnect",
    appliesTo: "one- and two-family dwelling services",
    isRetroactive: false,
    description: "Outdoor emergency disconnect for one- and two-family dwelling services, introduced in the 2020 cycle.",
  },
];

async function main() {
  for (const t of THERMAL) {
    await prisma.thermalThreshold.upsert({ where: { id: t.id }, create: t, update: {} });
  }
  console.log(`Thermal thresholds: ${THERMAL.length} ensured.`);

  const manufacturerIds = new Map<string, string>();
  for (const seed of TORQUE) {
    let panelModelId: string | null = null;
    if (seed.manufacturer) {
      let mId = manufacturerIds.get(seed.manufacturer);
      if (!mId) {
        const m = await prisma.panelManufacturer.upsert({
          where: { name: seed.manufacturer },
          create: { name: seed.manufacturer },
          update: {},
        });
        mId = m.id;
        manufacturerIds.set(seed.manufacturer, mId);
      }
      if (seed.model) {
        const model = await prisma.panelModel.upsert({
          where: { manufacturerId_modelDesignation: { manufacturerId: mId, modelDesignation: seed.model } },
          create: { manufacturerId: mId, modelDesignation: seed.model },
          update: {},
        });
        panelModelId = model.id;
      }
    }
    const { id, manufacturer: _m, model: _mo, ...fields } = seed;
    await prisma.torqueSpec.upsert({
      where: { id },
      create: { id, panelModelId, ...fields },
      update: {}, // append-only: existing rows are never modified by the seed
    });
  }
  console.log(`Torque specs: ${TORQUE.length} ensured (⚠ unverified — verificationDate null until checked against official sheets).`);

  for (const r of CODE_REQUIREMENTS) {
    await prisma.codeRequirement.upsert({ where: { id: r.id }, create: r, update: {} });
  }
  console.log(`Code requirements: ${CODE_REQUIREMENTS.length} ensured.`);

  // Known hazard panel lines (Step 2 obsolete/hazard flagging)
  const hazardLines: Array<[string, string]> = [
    ["Federal Pacific Electric", "Stab-Lok"],
    ["Zinsco / Sylvania", "Magnetrip"],
    ["Challenger", "Type A/C"],
  ];
  for (const [maker, model] of hazardLines) {
    const m = await prisma.panelManufacturer.upsert({ where: { name: maker }, create: { name: maker }, update: {} });
    await prisma.panelModel.upsert({
      where: { manufacturerId_modelDesignation: { manufacturerId: m.id, modelDesignation: model } },
      create: { manufacturerId: m.id, modelDesignation: model, isObsoleteLine: true, hazardFlag: true, notes: "Hazard-classified line — bus damage here is FAIL-replacement with no repair path (§8.6)." },
      update: {},
    });
  }
  console.log(`Hazard panel lines: ${hazardLines.length} ensured.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
