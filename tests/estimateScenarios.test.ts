/**
 * 24 End-to-End Estimating Scenarios — Phase M4 Deep Validation
 *
 * Groups:
 *   G1 (1–6):   Devices & Lighting
 *   G2 (7–12):  Circuits & Wiring Resolution
 *   G3 (13–18): Panel / Service / Grounding
 *   G4 (19–22): Specialty Equipment
 *   G5 (23–24): Modifiers & Comparisons
 *
 * Mandatory comparison pairs:
 *   7 vs 12  — 20A vs 15A → WIR-002 vs WIR-001
 *   4 vs 23  — Normal vs Difficult access
 *   10 vs 11 — Interior exposed (MC) vs Exterior (UF)
 *   8 vs 24  — Dryer normal vs MyRethread occupied+after-hours
 *
 * Gap 2 (estimate-level modifiers): applied as test-harness subtotal multipliers.
 * Gap 3 (no totals endpoint): totals computed in test harness.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

// ─── Types ───────────────────────────────────────────────────────────────────

type ItemInput = {
  atomicUnitCode: string;
  quantity: number;
  location?: string;
  notes?: string;
  circuitVoltage?: 120 | 240;
  circuitAmperage?: number;
  environment?: "interior" | "exterior" | "underground";
  exposure?: "concealed" | "exposed";
  cableLength?: number;
  needsThreeWire?: boolean;
  modifiers?: Array<{
    modifierType: string;
    modifierValue: string;
    laborMultiplier: number;
    materialMult: number;
  }>;
};

type ReviewPacket = {
  scenario: number;
  name: string;
  jobType: string;
  items: Array<{
    code: string;
    name: string;
    quantity: number;
    laborCost: number;
    materialCost: number;
    totalCost: number;
    resolvedWiringMethod: string | null;
    resolvedCableCode: string | null;
    modifiers: string[];
  }>;
  supportItems: Array<{
    supportType: string;
    description: string;
    laborCost: number;
    otherCost: number;
    totalCost: number;
  }>;
  necPrompts: Array<{
    ruleCode: string;
    severity: string;
    promptText: string;
  }>;
  subtotals: {
    itemLaborTotal: number;
    itemMaterialTotal: number;
    supportLaborTotal: number;
    supportOtherTotal: number;
    materialMarkup30Pct: number;
    engineTotal: number;
  };
  estimateLevelModifiers?: Array<{
    type: string;
    value: string;
    laborMultiplier: number;
  }>;
  reviewTotal?: number;
  scopeSummary: string;
};

// ─── DB Helpers ──────────────────────────────────────────────────────────────

async function clearDb() {
  await prisma.itemModifier.deleteMany();
  await prisma.estimateItem.deleteMany();
  await prisma.supportItem.deleteMany();
  await prisma.assemblyComponent.deleteMany();
  await prisma.estimateAssembly.deleteMany();
  await prisma.changeOrder.deleteMany();
  await prisma.estimateOption.deleteMany();
  await prisma.proposalAcceptance.deleteMany();
  await prisma.signatureRecord.deleteMany();
  await prisma.proposalDelivery.deleteMany();
  await prisma.inspectionStatus.deleteMany();
  await prisma.permitStatus.deleteMany();
  await prisma.estimate.deleteMany();
  await prisma.recommendation.deleteMany();
  await prisma.limitation.deleteMany();
  await prisma.finding.deleteMany();
  await prisma.observation.deleteMany();
  await prisma.customerRequest.deleteMany();
  await prisma.visit.deleteMany();
  await prisma.systemSnapshot.deleteMany();
  await prisma.property.deleteMany();
  await prisma.customer.deleteMany();
}

async function bootstrapEstimateContext() {
  const customer = await prisma.customer.create({
    data: { name: "Test Homeowner", email: "test@example.com" },
  });
  const property = await prisma.property.create({
    data: {
      customerId: customer.id,
      name: "Test House",
      addressLine1: "456 Elm St",
      city: "Vancouver",
      state: "WA",
      postalCode: "98660",
    },
  });
  await prisma.systemSnapshot.create({
    data: { propertyId: property.id, deficienciesJson: "[]", changeLogJson: "[]" },
  });
  const visit = await prisma.visit.create({
    data: {
      propertyId: property.id,
      customerId: customer.id,
      mode: "service_diagnostic",
      purpose: "Scenario test",
    },
  });
  const estRes = await request(app)
    .post("/estimates")
    .send({ visitId: visit.id, propertyId: property.id, title: "Scenario Test" })
    .expect(201);
  const optRes = await request(app)
    .post(`/estimates/${estRes.body.id}/options`)
    .send({ optionLabel: "Option A" })
    .expect(201);
  return { estimateId: estRes.body.id as string, optionId: optRes.body.id as string };
}

// ─── Scenario Runner ─────────────────────────────────────────────────────────

const MATERIAL_MARKUP = 0.30;

async function runScenario(config: {
  scenario: number;
  name: string;
  jobType: string;
  items: ItemInput[];
  scopeSummary: string;
  estimateLevelModifiers?: Array<{
    type: string;
    value: string;
    laborMultiplier: number;
  }>;
}): Promise<ReviewPacket> {
  const { estimateId, optionId } = await bootstrapEstimateContext();

  // Add items
  const createdItems: any[] = [];
  for (const itemDef of config.items) {
    const res = await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send(itemDef)
      .expect(201);
    createdItems.push(res.body.item);
  }

  // Generate support items
  const supportRes = await request(app)
    .post(`/estimates/${estimateId}/support-items/generate`)
    .expect(200);

  // NEC check
  const necRes = await request(app)
    .post(`/estimates/${estimateId}/nec-check`)
    .expect(200);

  // Fetch items with details
  const itemsRes = await request(app)
    .get(`/estimates/${estimateId}/options/${optionId}/items`)
    .expect(200);

  // Fetch support items
  const supportListRes = await request(app)
    .get(`/estimates/${estimateId}/support-items`)
    .expect(200);

  // Build packet
  const items = itemsRes.body.map((i: any) => ({
    code: i.atomicUnit.code,
    name: i.atomicUnit.name,
    quantity: i.quantity,
    laborCost: i.laborCost,
    materialCost: i.materialCost,
    totalCost: i.totalCost,
    resolvedWiringMethod: i.resolvedWiringMethod,
    resolvedCableCode: i.resolvedCableCode,
    modifiers: (i.modifiers ?? []).map(
      (m: any) => `${m.modifierType}:${m.modifierValue} (${m.laborMultiplier}×)`
    ),
  }));

  const supportItems = supportListRes.body.map((s: any) => ({
    supportType: s.supportType,
    description: s.description,
    laborCost: s.laborCost,
    otherCost: s.otherCost,
    totalCost: s.totalCost,
  }));

  const necPrompts = necRes.body.prompts.map((p: any) => ({
    ruleCode: p.ruleCode,
    severity: p.severity,
    promptText: p.promptText,
  }));

  const itemLaborTotal = round2(items.reduce((s: number, i: any) => s + i.laborCost, 0));
  const itemMaterialTotal = round2(items.reduce((s: number, i: any) => s + i.materialCost, 0));
  const supportLaborTotal = round2(supportItems.reduce((s: number, i: any) => s + i.laborCost, 0));
  const supportOtherTotal = round2(supportItems.reduce((s: number, i: any) => s + i.otherCost, 0));
  const materialMarkup30Pct = round2(itemMaterialTotal * MATERIAL_MARKUP);

  const engineTotal = round2(
    itemLaborTotal + itemMaterialTotal + materialMarkup30Pct +
    supportLaborTotal + supportOtherTotal
  );

  const subtotals = {
    itemLaborTotal,
    itemMaterialTotal,
    supportLaborTotal,
    supportOtherTotal,
    materialMarkup30Pct,
    engineTotal,
  };

  // Estimate-level modifiers (Gap 2: test-harness application)
  let reviewTotal: number | undefined;
  if (config.estimateLevelModifiers && config.estimateLevelModifiers.length > 0) {
    let laborMult = 1.0;
    for (const mod of config.estimateLevelModifiers) {
      laborMult *= mod.laborMultiplier;
    }
    const adjustedLabor = round2(itemLaborTotal * laborMult);
    const adjustedSupportLabor = round2(supportLaborTotal * laborMult);
    reviewTotal = round2(
      adjustedLabor + itemMaterialTotal + materialMarkup30Pct +
      adjustedSupportLabor + supportOtherTotal
    );
  }

  const packet: ReviewPacket = {
    scenario: config.scenario,
    name: config.name,
    jobType: config.jobType,
    items,
    supportItems,
    necPrompts,
    subtotals,
    estimateLevelModifiers: config.estimateLevelModifiers,
    reviewTotal,
    scopeSummary: config.scopeSummary,
  };

  // Print review packet
  printReviewPacket(packet);

  return packet;
}

function round2(n: number): number {
  return parseFloat(n.toFixed(2));
}

function printReviewPacket(p: ReviewPacket) {
  const lines: string[] = [];
  lines.push(`\n${"═".repeat(72)}`);
  lines.push(`  SCENARIO ${p.scenario}: ${p.name}`);
  lines.push(`  Job Type: ${p.jobType}`);
  lines.push(`  Scope: ${p.scopeSummary}`);
  lines.push(`${"─".repeat(72)}`);

  lines.push("  LINE ITEMS:");
  for (const item of p.items) {
    const cable = item.resolvedWiringMethod
      ? ` → ${item.resolvedWiringMethod} (${item.resolvedCableCode})`
      : "";
    const mods = item.modifiers.length > 0 ? `  [${item.modifiers.join(", ")}]` : "";
    lines.push(
      `    ${item.code}  ${item.name}  ×${item.quantity}  ` +
      `Labor: $${item.laborCost.toFixed(2)}  Material: $${item.materialCost.toFixed(2)}${cable}${mods}`
    );
  }

  if (p.supportItems.length > 0) {
    lines.push("  SUPPORT ITEMS:");
    for (const s of p.supportItems) {
      const cost = s.laborCost > 0 ? `Labor: $${s.laborCost.toFixed(2)}` : `Other: $${s.otherCost.toFixed(2)}`;
      lines.push(`    ☑ ${s.description}  ${cost}`);
    }
  }

  if (p.necPrompts.length > 0) {
    lines.push("  NEC PROMPTS:");
    for (const n of p.necPrompts) {
      lines.push(`    [${n.severity}] ${n.ruleCode}: ${n.promptText.slice(0, 80)}…`);
    }
  } else {
    lines.push("  NEC PROMPTS: (none for this scope)");
  }

  lines.push(`${"─".repeat(72)}`);
  lines.push(`  SUBTOTALS`);
  lines.push(`    Item Labor:      $${p.subtotals.itemLaborTotal.toFixed(2)}`);
  lines.push(`    Item Material:   $${p.subtotals.itemMaterialTotal.toFixed(2)}`);
  lines.push(`    Material Markup: $${p.subtotals.materialMarkup30Pct.toFixed(2)} (30%)`);
  lines.push(`    Support Labor:   $${p.subtotals.supportLaborTotal.toFixed(2)}`);
  lines.push(`    Support Other:   $${p.subtotals.supportOtherTotal.toFixed(2)}`);
  lines.push(`    Engine Total:    $${p.subtotals.engineTotal.toFixed(2)}`);

  if (p.estimateLevelModifiers && p.estimateLevelModifiers.length > 0) {
    lines.push("  ESTIMATE-LEVEL MODIFIERS (applied in test harness — not yet native engine pricing):");
    for (const m of p.estimateLevelModifiers) {
      const pctStr = m.laborMultiplier > 1
        ? `+${((m.laborMultiplier - 1) * 100).toFixed(0)}%`
        : `${((m.laborMultiplier - 1) * 100).toFixed(0)}%`;
      lines.push(`    ${m.type}: ${m.value} (${pctStr} labor)`);
    }
    lines.push(`    Review Total:    $${p.reviewTotal!.toFixed(2)}`);
  }

  lines.push(`${"═".repeat(72)}\n`);
  console.log(lines.join("\n"));
}

// ─── Modifier shorthand ─────────────────────────────────────────────────────

const DIFFICULT_ACCESS = {
  modifierType: "ACCESS",
  modifierValue: "DIFFICULT",
  laborMultiplier: 1.25,
  materialMult: 1.0,
};

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(async () => {
  await clearDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 1: DEVICES & LIGHTING (Scenarios 1–6)
// ═══════════════════════════════════════════════════════════════════════════════

describe("G1 — Devices & Lighting", () => {
  it("Scenario 1: Replace 6 standard receptacles", async () => {
    const p = await runScenario({
      scenario: 1,
      name: "Replace 6 Standard Receptacles",
      jobType: "Service / Repair",
      items: [
        { atomicUnitCode: "DEV-001", quantity: 6, location: "Kitchen, Living Room" },
      ],
      scopeSummary: "6× receptacle swap in existing boxes, no new circuits",
    });

    expect(p.items).toHaveLength(1);
    expect(p.items[0].code).toBe("DEV-001");
    // Labor: 0.35 × 6 × $115 = $241.50
    expect(p.items[0].laborCost).toBeCloseTo(0.35 * 6 * 115, 1);
    // Material: $8 × 6 = $48
    expect(p.items[0].materialCost).toBeCloseTo(8 * 6, 1);
    // No wiring resolution
    expect(p.items[0].resolvedWiringMethod).toBeNull();
    // NEC-406.12 tamper-resistant advisory should fire
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-406.12")).toBe(true);
    // Support: MOBILIZATION + CLEANUP only (no circuits/panels)
    expect(p.supportItems.some((s) => s.supportType === "MOBILIZATION")).toBe(true);
    expect(p.supportItems.some((s) => s.supportType === "CLEANUP")).toBe(true);
    expect(p.supportItems.some((s) => s.supportType === "PERMIT")).toBe(false);
  });

  it("Scenario 2: GFCI Upgrade — 4 kitchen/bath receptacles", async () => {
    const p = await runScenario({
      scenario: 2,
      name: "GFCI Upgrade — Kitchen/Bath",
      jobType: "Service / Upgrade",
      items: [
        { atomicUnitCode: "DEV-002", quantity: 2, location: "kitchen" },
        { atomicUnitCode: "DEV-002", quantity: 2, location: "bathroom" },
      ],
      scopeSummary: "4× GFCI receptacle upgrade in kitchen and bath locations",
    });

    expect(p.items).toHaveLength(2);
    // Each: 0.45 × 2 × $115 = $103.50
    expect(p.items[0].laborCost).toBeCloseTo(0.45 * 2 * 115, 1);
    expect(p.items[0].materialCost).toBeCloseTo(28 * 2, 1);
    // NEC-210.8-A (GFCI required in kitchen/bath) should fire
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-210.8-A")).toBe(true);
    // NEC-210.11-C1 (kitchen circuits) should fire
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-210.11-C1")).toBe(true);
    // NEC-406.12 tamper-resistant
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-406.12")).toBe(true);
  });

  it("Scenario 3: Replace 3 light fixtures", async () => {
    const p = await runScenario({
      scenario: 3,
      name: "Replace 3 Light Fixtures",
      jobType: "Service / Repair",
      items: [
        { atomicUnitCode: "LUM-001", quantity: 3, location: "Dining Room, Hallway" },
      ],
      scopeSummary: "3× fixture swap in existing boxes, no new circuits",
    });

    expect(p.items).toHaveLength(1);
    // Labor: 0.90 × 3 × $115 = $310.50
    expect(p.items[0].laborCost).toBeCloseTo(0.9 * 3 * 115, 1);
    // Material: $18 × 3 = $54
    expect(p.items[0].materialCost).toBeCloseTo(18 * 3, 1);
    expect(p.items[0].resolvedWiringMethod).toBeNull();
    // No NEC prompts for simple fixture replace
    expect(p.necPrompts.length).toBe(0);
  });

  it("Scenario 4: MyRethread — 4 dimmers + cut-in + cable + 2 splice-throughs", async () => {
    const p = await runScenario({
      scenario: 4,
      name: "MyRethread — Dimmer Multi-Gang Retrofit",
      jobType: "Service / Upgrade",
      items: [
        { atomicUnitCode: "DEV-005", quantity: 4, location: "Living Room / Dining" },
        { atomicUnitCode: "SRV-002", quantity: 1, location: "Living Room" },
        { atomicUnitCode: "WIR-002", quantity: 24, location: "Attic run" },
        { atomicUnitCode: "SRV-007", quantity: 2, location: "Living Room / Dining" },
      ],
      scopeSummary: "4 dimmers in multi-gang cut-in box, 24ft NM-B 12/2, 2 splice-throughs",
    });

    expect(p.items).toHaveLength(4);

    // DEV-005 × 4: labor = 0.50 × 4 × $115 = $230, material = $55 × 4 = $220
    const dimmers = p.items.find((i) => i.code === "DEV-005")!;
    expect(dimmers.laborCost).toBeCloseTo(230, 1);
    expect(dimmers.materialCost).toBeCloseTo(220, 1);

    // SRV-002 × 1: labor = 0.75 × $115 = $86.25, material = $12
    const cutIn = p.items.find((i) => i.code === "SRV-002")!;
    expect(cutIn.laborCost).toBeCloseTo(86.25, 1);
    expect(cutIn.materialCost).toBeCloseTo(12, 1);

    // WIR-002 × 24: labor = 0.05 × 24 × $90 = $108, material = 0.65 × 24 = $15.60
    const cable = p.items.find((i) => i.code === "WIR-002")!;
    expect(cable.laborCost).toBeCloseTo(108, 1);
    expect(cable.materialCost).toBeCloseTo(15.6, 1);

    // SRV-007 × 2: labor = 0.75 × 2 × $115 = $172.50, material = $5 × 2 = $10
    const splice = p.items.find((i) => i.code === "SRV-007")!;
    expect(splice.laborCost).toBeCloseTo(172.5, 1);
    expect(splice.materialCost).toBeCloseTo(10, 1);

    // No permit (no circuits/panels)
    expect(p.supportItems.some((s) => s.supportType === "PERMIT")).toBe(false);
  });

  it("Scenario 5: Ceiling fan install", async () => {
    const p = await runScenario({
      scenario: 5,
      name: "Ceiling Fan Install",
      jobType: "Service / Install",
      items: [
        { atomicUnitCode: "LUM-005", quantity: 1, location: "Master Bedroom" },
      ],
      scopeSummary: "Fan-rated box + fan assembly in existing circuit location",
    });

    expect(p.items).toHaveLength(1);
    // Labor: 1.50 × $115 = $172.50
    expect(p.items[0].laborCost).toBeCloseTo(172.5, 1);
    // Material: $55
    expect(p.items[0].materialCost).toBeCloseTo(55, 1);
    // NEC-314.27 should NOT fire here because the trigger is units_present check
    // and LUM-005 is not in any trigger list in the seed. No NEC prompts expected.
  });

  it("Scenario 6: Replace 4 smoke/CO detectors", async () => {
    const p = await runScenario({
      scenario: 6,
      name: "Replace 4 Smoke/CO Detectors",
      jobType: "Service / Safety",
      items: [
        { atomicUnitCode: "DEV-006", quantity: 4, location: "Bedrooms, Hallway" },
      ],
      scopeSummary: "4× detector swap in existing bases, bedroom + hallway locations",
    });

    expect(p.items).toHaveLength(1);
    // Labor: 0.50 × 4 × $115 = $230
    expect(p.items[0].laborCost).toBeCloseTo(230, 1);
    // Material: $48 × 4 = $192
    expect(p.items[0].materialCost).toBeCloseTo(192, 1);
    // NEC-210.12 (AFCI for bedroom circuits) should fire from "bedroom" location
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-210.12")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 2: CIRCUITS & WIRING RESOLUTION (Scenarios 7–12)
// ═══════════════════════════════════════════════════════════════════════════════

describe("G2 — Circuits & Wiring Resolution", () => {
  it("Scenario 7: Dedicated 120V 20A circuit — interior concealed 40ft", async () => {
    const p = await runScenario({
      scenario: 7,
      name: "Dedicated 120V 20A — Concealed",
      jobType: "New Circuit",
      items: [
        {
          atomicUnitCode: "CIR-001", quantity: 1, location: "Office",
          circuitVoltage: 120, circuitAmperage: 20,
          environment: "interior", exposure: "concealed", cableLength: 40,
        },
        { atomicUnitCode: "EQP-001", quantity: 1, location: "Office" },
      ],
      scopeSummary: "120V 20A branch circuit, 40ft NM-B 12/2, receptacle endpoint",
    });

    const cir = p.items.find((i) => i.code === "CIR-001")!;
    expect(cir.resolvedWiringMethod).toBe("NM-B 12/2");
    expect(cir.resolvedCableCode).toBe("WIR-002");

    // CIR-001 labor: 0.90 × $115 = $103.50
    // Cable labor: 40 × 0.05 × $90 = $180
    // Total labor: $283.50
    expect(cir.laborCost).toBeCloseTo(103.5 + 180, 1);

    // Breaker: 20A single = $18
    // Cable material: 40 × $0.65 = $26
    expect(cir.materialCost).toBeCloseTo(18 + 26, 1);

    // EQP-001: 0.55 × $115 = $63.25, material $12
    const endpt = p.items.find((i) => i.code === "EQP-001")!;
    expect(endpt.laborCost).toBeCloseTo(63.25, 1);
    expect(endpt.materialCost).toBeCloseTo(12, 1);

    // Support: PERMIT + CIRCUIT_TESTING should be present
    expect(p.supportItems.some((s) => s.supportType === "PERMIT")).toBe(true);
    expect(p.supportItems.some((s) => s.supportType === "CIRCUIT_TESTING")).toBe(true);

    // NEC-406.12 from EQP-001
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-406.12")).toBe(true);
  });

  it("Scenario 8: Dryer circuit 240V 30A — needsThreeWire → 10/3", async () => {
    const p = await runScenario({
      scenario: 8,
      name: "Dryer Circuit 240V 30A — 3-Wire",
      jobType: "Appliance Circuit",
      items: [
        {
          atomicUnitCode: "CIR-001", quantity: 1, location: "Laundry",
          circuitVoltage: 240, circuitAmperage: 30,
          environment: "interior", exposure: "concealed", cableLength: 35,
          needsThreeWire: true,
        },
        { atomicUnitCode: "EQP-002", quantity: 1, location: "Laundry" },
      ],
      scopeSummary: "240V 30A dryer circuit, 35ft NM-B 10/3, 240V receptacle endpoint",
    });

    const cir = p.items.find((i) => i.code === "CIR-001")!;
    // Gap 1 fix verification: must resolve to 10/3, NOT 10/2
    expect(cir.resolvedWiringMethod).toBe("NM-B 10/3");
    expect(cir.resolvedCableCode).toBe("WIR-005");

    // CIR-001 labor: 0.90 × $115 = $103.50
    // Cable labor: 35 × 0.06 × $90 = $189
    expect(cir.laborCost).toBeCloseTo(103.5 + 189, 1);

    // Breaker: 30A double = $55
    // Cable material: 35 × $1.10 = $38.50
    expect(cir.materialCost).toBeCloseTo(55 + 38.5, 1);

    // EQP-002: 0.85 × $115 = $97.75, material $55
    const endpt = p.items.find((i) => i.code === "EQP-002")!;
    expect(endpt.laborCost).toBeCloseTo(97.75, 1);

    // NEC-210.11-C2 (laundry circuit) should fire
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-210.11-C2")).toBe(true);
  });

  it("Scenario 9: Range circuit 240V 50A — needsThreeWire → 6/3", async () => {
    const p = await runScenario({
      scenario: 9,
      name: "Range Circuit 240V 50A — 3-Wire",
      jobType: "Appliance Circuit",
      items: [
        {
          atomicUnitCode: "CIR-001", quantity: 1, location: "Kitchen",
          circuitVoltage: 240, circuitAmperage: 50,
          environment: "interior", exposure: "concealed", cableLength: 25,
          needsThreeWire: true,
        },
        { atomicUnitCode: "EQP-002", quantity: 1, location: "Kitchen" },
      ],
      scopeSummary: "240V 50A range circuit, 25ft NM-B 6/3, 240V receptacle endpoint",
    });

    const cir = p.items.find((i) => i.code === "CIR-001")!;
    // Gap 1 fix verification: must resolve to 6/3, NOT 6/2
    expect(cir.resolvedWiringMethod).toBe("NM-B 6/3");
    expect(cir.resolvedCableCode).toBe("WIR-007");

    // Cable labor: 25 × 0.07 × $90 = $157.50
    expect(cir.laborCost).toBeCloseTo(103.5 + 157.5, 1);

    // Breaker: 50A double = $90
    // Cable material: 25 × $2.00 = $50
    expect(cir.materialCost).toBeCloseTo(90 + 50, 1);

    // NEC-210.8-A from kitchen location
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-210.8-A")).toBe(true);
    // NEC-210.11-C1 kitchen circuits
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-210.11-C1")).toBe(true);
  });

  it("Scenario 10: 120V 20A circuit — interior EXPOSED 30ft → MC", async () => {
    const p = await runScenario({
      scenario: 10,
      name: "120V 20A — Interior Exposed (MC Cable)",
      jobType: "New Circuit",
      items: [
        {
          atomicUnitCode: "CIR-001", quantity: 1, location: "Garage",
          circuitVoltage: 120, circuitAmperage: 20,
          environment: "interior", exposure: "exposed", cableLength: 30,
        },
        { atomicUnitCode: "EQP-001", quantity: 1, location: "Garage" },
      ],
      scopeSummary: "120V 20A exposed interior circuit, 30ft MC 12/2, receptacle endpoint",
    });

    const cir = p.items.find((i) => i.code === "CIR-001")!;
    expect(cir.resolvedWiringMethod).toBe("MC 12/2");
    expect(cir.resolvedCableCode).toBe("WIR-008");

    // Cable labor: 30 × 0.06 × $90 = $162
    expect(cir.laborCost).toBeCloseTo(103.5 + 162, 1);

    // Breaker: 20A single = $18
    // Cable material: 30 × $0.85 = $25.50
    expect(cir.materialCost).toBeCloseTo(18 + 25.5, 1);

    // NEC-210.8-A from garage location
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-210.8-A")).toBe(true);
  });

  it("Scenario 11: 120V 20A circuit — EXTERIOR 30ft → UF", async () => {
    const p = await runScenario({
      scenario: 11,
      name: "120V 20A — Exterior (UF Cable)",
      jobType: "New Circuit",
      items: [
        {
          atomicUnitCode: "CIR-001", quantity: 1, location: "exterior patio",
          circuitVoltage: 120, circuitAmperage: 20,
          environment: "exterior", exposure: "exposed", cableLength: 30,
        },
        { atomicUnitCode: "EQP-001", quantity: 1, location: "exterior patio" },
      ],
      scopeSummary: "120V 20A exterior circuit, 30ft UF cable, receptacle endpoint",
    });

    const cir = p.items.find((i) => i.code === "CIR-001")!;
    expect(cir.resolvedWiringMethod).toBe("UF / Direct-Burial");
    expect(cir.resolvedCableCode).toBe("WIR-010");

    // Cable labor: 30 × 0.10 × $90 = $270
    expect(cir.laborCost).toBeCloseTo(103.5 + 270, 1);

    // Breaker: 20A single = $18
    // Cable material: 30 × $3.75 = $112.50
    expect(cir.materialCost).toBeCloseTo(18 + 112.5, 1);

    // NEC-210.8-A from exterior location
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-210.8-A")).toBe(true);
  });

  it("Scenario 12: Dedicated 120V 15A circuit — concealed 40ft → 14/2", async () => {
    const p = await runScenario({
      scenario: 12,
      name: "Dedicated 120V 15A — Concealed",
      jobType: "New Circuit",
      items: [
        {
          atomicUnitCode: "CIR-001", quantity: 1, location: "Bedroom",
          circuitVoltage: 120, circuitAmperage: 15,
          environment: "interior", exposure: "concealed", cableLength: 40,
        },
        { atomicUnitCode: "EQP-001", quantity: 1, location: "Bedroom" },
      ],
      scopeSummary: "120V 15A branch circuit, 40ft NM-B 14/2, receptacle endpoint",
    });

    const cir = p.items.find((i) => i.code === "CIR-001")!;
    expect(cir.resolvedWiringMethod).toBe("NM-B 14/2");
    expect(cir.resolvedCableCode).toBe("WIR-001");

    // Cable labor: 40 × 0.04 × $90 = $144
    expect(cir.laborCost).toBeCloseTo(103.5 + 144, 1);

    // Breaker: 15A single = $12
    // Cable material: 40 × $0.45 = $18
    expect(cir.materialCost).toBeCloseTo(12 + 18, 1);

    // NEC-210.12 (bedroom AFCI)
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-210.12")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 3: PANEL / SERVICE / GROUNDING (Scenarios 13–18)
// ═══════════════════════════════════════════════════════════════════════════════

describe("G3 — Panel / Service / Grounding", () => {
  it("Scenario 13: Main panel replacement", async () => {
    const p = await runScenario({
      scenario: 13,
      name: "Main Panel Replace",
      jobType: "Panel / Service",
      items: [
        { atomicUnitCode: "PNL-001", quantity: 1, location: "Garage" },
      ],
      scopeSummary: "Full main panel replacement — remove old, mount new, reconnect all circuits, label",
    });

    expect(p.items).toHaveLength(1);
    // Labor: 16.0 × $115 = $1,840
    expect(p.items[0].laborCost).toBeCloseTo(16 * 115, 1);
    // Material: $1,650
    expect(p.items[0].materialCost).toBeCloseTo(1650, 1);

    // Support: PANEL_DEMO + LOAD_CALC + PERMIT + MOBILIZATION + CLEANUP
    expect(p.supportItems.some((s) => s.supportType === "PANEL_DEMO")).toBe(true);
    expect(p.supportItems.some((s) => s.supportType === "LOAD_CALC")).toBe(true);
    expect(p.supportItems.some((s) => s.supportType === "PERMIT")).toBe(true);

    // NEC: 230.71 (disconnect), 250.50 (grounding), 285.1 (SPD)
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-230.71")).toBe(true);
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-250.50")).toBe(true);
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-285.1")).toBe(true);
  });

  it("Scenario 14: New subpanel + feeder 60ft", async () => {
    const p = await runScenario({
      scenario: 14,
      name: "New Subpanel + Feeder",
      jobType: "Panel / Service",
      items: [
        { atomicUnitCode: "PNL-003", quantity: 1, location: "Workshop" },
        {
          atomicUnitCode: "CIR-002", quantity: 1, location: "Garage → Workshop",
          circuitVoltage: 240, circuitAmperage: 60,
          environment: "interior", exposure: "concealed", cableLength: 60,
        },
      ],
      scopeSummary: "New subpanel install with 60ft feeder, SER cable",
    });

    const sub = p.items.find((i) => i.code === "PNL-003")!;
    // Labor: 5.0 × $115 = $575
    expect(sub.laborCost).toBeCloseTo(575, 1);
    // Material: $500
    expect(sub.materialCost).toBeCloseTo(500, 1);

    const feeder = p.items.find((i) => i.code === "CIR-002")!;
    // Feeder resolves to SER cable (WIR-009) for same-building
    expect(feeder.resolvedCableCode).toBe("WIR-009");
    expect(feeder.resolvedWiringMethod).toBe("SER 2/0");

    // CIR-002 labor: 3.0 × $115 = $345
    // Cable labor: 60 × 0.08 × $90 = $432
    expect(feeder.laborCost).toBeCloseTo(345 + 432, 1);

    // Breaker: 60A double = $120
    // Cable material: 60 × $4.50 = $270
    expect(feeder.materialCost).toBeCloseTo(120 + 270, 1);

    // PERMIT should fire (CIR-002)
    expect(p.supportItems.some((s) => s.supportType === "PERMIT")).toBe(true);
    // NEC-250.50 from PNL-003
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-250.50")).toBe(true);
  });

  it("Scenario 15: Full service entrance upgrade", async () => {
    const p = await runScenario({
      scenario: 15,
      name: "Full Service Entrance Upgrade",
      jobType: "Panel / Service",
      items: [
        { atomicUnitCode: "SVC-005", quantity: 1, location: "Exterior / Garage" },
        { atomicUnitCode: "SVC-002", quantity: 1, location: "Exterior" },
        { atomicUnitCode: "PNL-001", quantity: 1, location: "Garage" },
        { atomicUnitCode: "GND-001", quantity: 1, location: "Exterior" },
      ],
      scopeSummary: "Service upgrade + meter base + main panel + grounding electrode system",
    });

    expect(p.items).toHaveLength(4);

    // Total labor check:
    // SVC-005: 6.0 × $115 = $690
    // SVC-002: 4.0 × $115 = $460
    // PNL-001: 16.0 × $115 = $1,840
    // GND-001: 4.5 × $115 = $517.50
    const expectedLabor = 690 + 460 + 1840 + 517.5;
    expect(p.subtotals.itemLaborTotal).toBeCloseTo(expectedLabor, 1);

    // Material: $320 + $340 + $1650 + $185 = $2,495
    expect(p.subtotals.itemMaterialTotal).toBeCloseTo(2495, 1);

    // Full support suite: PANEL_DEMO, LOAD_CALC, UTILITY_COORD, PERMIT
    expect(p.supportItems.some((s) => s.supportType === "PANEL_DEMO")).toBe(true);
    expect(p.supportItems.some((s) => s.supportType === "LOAD_CALC")).toBe(true);
    expect(p.supportItems.some((s) => s.supportType === "UTILITY_COORD")).toBe(true);
    expect(p.supportItems.some((s) => s.supportType === "PERMIT")).toBe(true);

    // NEC: 230.71, 250.50, 285.1
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-230.71")).toBe(true);
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-250.50")).toBe(true);
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-285.1")).toBe(true);
  });

  it("Scenario 16: Grounding system — GES + ground rod + bonding", async () => {
    const p = await runScenario({
      scenario: 16,
      name: "Grounding System",
      jobType: "Grounding / Safety",
      items: [
        { atomicUnitCode: "GND-001", quantity: 1, location: "Exterior" },
        { atomicUnitCode: "GND-003", quantity: 1, location: "Exterior" },
        { atomicUnitCode: "GND-002", quantity: 1, location: "Mechanical Room" },
      ],
      scopeSummary: "Full GES + supplemental ground rod + bonding correction",
    });

    expect(p.items).toHaveLength(3);
    // GND-001: 4.5hr × $115 = $517.50, mat $185
    // GND-003: 1.7hr × $115 = $195.50, mat $73
    // GND-002: 2.0hr × $115 = $230, mat $55
    expect(p.subtotals.itemLaborTotal).toBeCloseTo(517.5 + 195.5 + 230, 1);
    expect(p.subtotals.itemMaterialTotal).toBeCloseTo(185 + 73 + 55, 1);
    // No permit for grounding-only scope
    expect(p.supportItems.some((s) => s.supportType === "PERMIT")).toBe(false);
  });

  it("Scenario 17: Panel rework / cleanup", async () => {
    const p = await runScenario({
      scenario: 17,
      name: "Panel Rework / Cleanup",
      jobType: "Service / Maintenance",
      items: [
        { atomicUnitCode: "PNL-004", quantity: 1, location: "Basement" },
      ],
      scopeSummary: "Re-terminate, organize, and label all circuits in existing panel",
    });

    // Labor: 6.0 × $115 = $690
    expect(p.items[0].laborCost).toBeCloseTo(690, 1);
    // Material: $35
    expect(p.items[0].materialCost).toBeCloseTo(35, 1);
    // No PANEL_DEMO (PNL-004 is rework, not replacement)
    expect(p.supportItems.some((s) => s.supportType === "PANEL_DEMO")).toBe(false);
    // No PERMIT for rework-only
    expect(p.supportItems.some((s) => s.supportType === "PERMIT")).toBe(false);
  });

  it("Scenario 18: Service entrance cable + mast/weatherhead", async () => {
    const p = await runScenario({
      scenario: 18,
      name: "Service Cable + Mast Repair",
      jobType: "Panel / Service",
      items: [
        { atomicUnitCode: "SVC-001", quantity: 1, location: "Exterior" },
        { atomicUnitCode: "SVC-004", quantity: 1, location: "Exterior" },
      ],
      scopeSummary: "Replace service entrance cable + mast/weatherhead repair",
    });

    // SVC-001: 6.0hr × $115 = $690, mat $420
    // SVC-004: 5.0hr × $115 = $575, mat $230
    expect(p.subtotals.itemLaborTotal).toBeCloseTo(690 + 575, 1);
    expect(p.subtotals.itemMaterialTotal).toBeCloseTo(420 + 230, 1);

    // PERMIT + LOAD_CALC + UTILITY_COORD should fire
    expect(p.supportItems.some((s) => s.supportType === "PERMIT")).toBe(true);
    expect(p.supportItems.some((s) => s.supportType === "LOAD_CALC")).toBe(true);
    expect(p.supportItems.some((s) => s.supportType === "UTILITY_COORD")).toBe(true);

    // NEC-230.71, NEC-250.50, NEC-285.1
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-230.71")).toBe(true);
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-250.50")).toBe(true);
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-285.1")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 4: SPECIALTY EQUIPMENT (Scenarios 19–22)
// ═══════════════════════════════════════════════════════════════════════════════

describe("G4 — Specialty Equipment", () => {
  it("Scenario 19: EV charger install + 240V 40A circuit + disconnect", async () => {
    const p = await runScenario({
      scenario: 19,
      name: "EV Charger Install",
      jobType: "Equipment / EV",
      items: [
        {
          atomicUnitCode: "CIR-001", quantity: 1, location: "Garage",
          circuitVoltage: 240, circuitAmperage: 40,
          environment: "interior", exposure: "concealed", cableLength: 30,
        },
        { atomicUnitCode: "EQP-006", quantity: 1, location: "Garage" },
        { atomicUnitCode: "EQP-003", quantity: 1, location: "Garage" },
      ],
      scopeSummary: "240V 40A EV circuit + charger mount + disconnect",
    });

    const cir = p.items.find((i) => i.code === "CIR-001")!;
    // 240V 40A concealed → NM-B 10/2 (WIR-004) — 40A ≤ 30 is false, 40A ≤ 50 → needsThreeWire default false → WIR-006
    // Actually: resolveNMBGauge(240, 40, false): 240V, 40A > 30 → amperage ≤ 50 → WIR-006 (6/2)
    expect(cir.resolvedCableCode).toBe("WIR-006");
    expect(cir.resolvedWiringMethod).toBe("NM-B 6/2");

    // Cable labor: 30 × 0.07 × $90 = $189
    expect(cir.laborCost).toBeCloseTo(103.5 + 189, 1);

    // Breaker: 40A double = $70
    // Cable material: 30 × $1.70 = $51
    expect(cir.materialCost).toBeCloseTo(70 + 51, 1);

    // EQP-006 (EV): 3.5hr × $115 = $402.50, mat $45
    const ev = p.items.find((i) => i.code === "EQP-006")!;
    expect(ev.laborCost).toBeCloseTo(402.5, 1);
    expect(ev.materialCost).toBeCloseTo(45, 1);

    // EQP-003 (Disconnect): 1.5hr × $115 = $172.50, mat $95
    const disc = p.items.find((i) => i.code === "EQP-003")!;
    expect(disc.laborCost).toBeCloseTo(172.5, 1);
    expect(disc.materialCost).toBeCloseTo(95, 1);

    // PERMIT (new circuit)
    expect(p.supportItems.some((s) => s.supportType === "PERMIT")).toBe(true);
    // NEC-210.8-A from garage location
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-210.8-A")).toBe(true);
  });

  it("Scenario 20: Hot tub/spa + 240V 50A circuit + disconnect", async () => {
    const p = await runScenario({
      scenario: 20,
      name: "Hot Tub/Spa Install",
      jobType: "Equipment / Spa",
      items: [
        {
          atomicUnitCode: "CIR-001", quantity: 1, location: "exterior patio",
          circuitVoltage: 240, circuitAmperage: 50,
          environment: "exterior", exposure: "exposed", cableLength: 50,
        },
        { atomicUnitCode: "EQP-010", quantity: 1, location: "exterior patio" },
        { atomicUnitCode: "EQP-003", quantity: 1, location: "exterior patio" },
      ],
      scopeSummary: "240V 50A spa circuit, 50ft UF cable, GFCI disconnect + spa connection",
    });

    const cir = p.items.find((i) => i.code === "CIR-001")!;
    // Exterior → UF cable (WIR-010)
    expect(cir.resolvedCableCode).toBe("WIR-010");
    expect(cir.resolvedWiringMethod).toBe("UF / Direct-Burial");

    // Cable labor: 50 × 0.10 × $90 = $450
    expect(cir.laborCost).toBeCloseTo(103.5 + 450, 1);

    // Breaker: 50A double = $90
    // Cable material: 50 × $3.75 = $187.50
    expect(cir.materialCost).toBeCloseTo(90 + 187.5, 1);

    // EQP-010 (Spa): 5.0hr × $115 = $575, mat $150
    const spa = p.items.find((i) => i.code === "EQP-010")!;
    expect(spa.laborCost).toBeCloseTo(575, 1);
    expect(spa.materialCost).toBeCloseTo(150, 1);

    // NEC-680.21 and NEC-680.26 should fire (pool/spa)
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-680.21")).toBe(true);
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-680.26")).toBe(true);
  });

  it("Scenario 21: Generator inlet + interlock kit", async () => {
    const p = await runScenario({
      scenario: 21,
      name: "Generator Inlet + Interlock",
      jobType: "Equipment / Generator",
      items: [
        { atomicUnitCode: "EQP-007", quantity: 1, location: "Exterior wall" },
        { atomicUnitCode: "EQP-008", quantity: 1, location: "Panel" },
      ],
      scopeSummary: "Power inlet box for portable generator + panel interlock kit",
    });

    // EQP-007: 2.5hr × $115 = $287.50, mat $180
    const inlet = p.items.find((i) => i.code === "EQP-007")!;
    expect(inlet.laborCost).toBeCloseTo(287.5, 1);
    expect(inlet.materialCost).toBeCloseTo(180, 1);

    // EQP-008: 2.5hr × $115 = $287.50, mat $150
    const interlock = p.items.find((i) => i.code === "EQP-008")!;
    expect(interlock.laborCost).toBeCloseTo(287.5, 1);
    expect(interlock.materialCost).toBeCloseTo(150, 1);

    // No circuits → no PERMIT
    expect(p.supportItems.some((s) => s.supportType === "PERMIT")).toBe(false);
  });

  it("Scenario 22: Bathroom exhaust fan + 120V 20A circuit", async () => {
    const p = await runScenario({
      scenario: 22,
      name: "Bathroom Exhaust Fan + Circuit",
      jobType: "Fixture / Circuit",
      items: [
        { atomicUnitCode: "LUM-007", quantity: 1, location: "bathroom" },
        {
          atomicUnitCode: "CIR-001", quantity: 1, location: "bathroom",
          circuitVoltage: 120, circuitAmperage: 20,
          environment: "interior", exposure: "concealed", cableLength: 25,
        },
      ],
      scopeSummary: "Bathroom exhaust fan + dedicated 120V 20A circuit, 25ft NM-B 12/2",
    });

    // LUM-007: 2.25hr × $115 = $258.75, mat $140
    const fan = p.items.find((i) => i.code === "LUM-007")!;
    expect(fan.laborCost).toBeCloseTo(258.75, 1);
    expect(fan.materialCost).toBeCloseTo(140, 1);

    const cir = p.items.find((i) => i.code === "CIR-001")!;
    expect(cir.resolvedWiringMethod).toBe("NM-B 12/2");
    expect(cir.resolvedCableCode).toBe("WIR-002");

    // Cable labor: 25 × 0.05 × $90 = $112.50
    expect(cir.laborCost).toBeCloseTo(103.5 + 112.5, 1);

    // Breaker: 20A single = $18
    // Cable material: 25 × $0.65 = $16.25
    expect(cir.materialCost).toBeCloseTo(18 + 16.25, 1);

    // NEC-210.8-A from bathroom location
    expect(p.necPrompts.some((n) => n.ruleCode === "NEC-210.8-A")).toBe(true);
    // PERMIT (new circuit)
    expect(p.supportItems.some((s) => s.supportType === "PERMIT")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 5: MODIFIERS & COMPARISONS (Scenarios 23–24)
// ═══════════════════════════════════════════════════════════════════════════════

describe("G5 — Modifiers & Comparisons", () => {
  it("Scenario 23: MyRethread — DIFFICULT ACCESS on all items", async () => {
    const p = await runScenario({
      scenario: 23,
      name: "MyRethread — Difficult Access",
      jobType: "Service / Upgrade",
      items: [
        {
          atomicUnitCode: "DEV-005", quantity: 4, location: "Living Room / Dining",
          modifiers: [DIFFICULT_ACCESS],
        },
        {
          atomicUnitCode: "SRV-002", quantity: 1, location: "Living Room",
          modifiers: [DIFFICULT_ACCESS],
        },
        {
          atomicUnitCode: "WIR-002", quantity: 24, location: "Attic run",
          modifiers: [DIFFICULT_ACCESS],
        },
        {
          atomicUnitCode: "SRV-007", quantity: 2, location: "Living Room / Dining",
          modifiers: [DIFFICULT_ACCESS],
        },
      ],
      scopeSummary: "Same as Scenario 4 but ALL items have Difficult Access modifier (1.25× labor)",
    });

    // DEV-005 × 4 DIFFICULT: 0.50 × 4 × 1.25 × $115 = $287.50
    const dimmers = p.items.find((i) => i.code === "DEV-005")!;
    expect(dimmers.laborCost).toBeCloseTo(287.5, 1);
    expect(dimmers.modifiers).toContain("ACCESS:DIFFICULT (1.25×)");

    // SRV-002 × 1 DIFFICULT: 0.75 × 1 × 1.25 × $115 = $107.8125 → $107.81
    const cutIn = p.items.find((i) => i.code === "SRV-002")!;
    expect(cutIn.laborCost).toBeCloseTo(107.81, 0);

    // WIR-002 × 24 DIFFICULT: 0.05 × 24 × 1.25 × $90 = $135
    const cable = p.items.find((i) => i.code === "WIR-002")!;
    expect(cable.laborCost).toBeCloseTo(135, 1);

    // SRV-007 × 2 DIFFICULT: 0.75 × 2 × 1.25 × $115 = $215.625 → $215.63
    const splice = p.items.find((i) => i.code === "SRV-007")!;
    expect(splice.laborCost).toBeCloseTo(215.63, 0);
  });

  it("Scenario 24: MyRethread — OCCUPIED + AFTER_HOURS estimate-level modifiers", async () => {
    const p = await runScenario({
      scenario: 24,
      name: "MyRethread — Occupied + After-Hours",
      jobType: "Service / Upgrade",
      items: [
        { atomicUnitCode: "DEV-005", quantity: 4, location: "Living Room / Dining" },
        { atomicUnitCode: "SRV-002", quantity: 1, location: "Living Room" },
        { atomicUnitCode: "WIR-002", quantity: 24, location: "Attic run" },
        { atomicUnitCode: "SRV-007", quantity: 2, location: "Living Room / Dining" },
      ],
      estimateLevelModifiers: [
        { type: "OCCUPANCY", value: "OCCUPIED", laborMultiplier: 1.15 },
        { type: "SCHEDULE", value: "AFTER_HOURS", laborMultiplier: 1.50 },
      ],
      scopeSummary: "Same scope as Scenario 4, occupied home, after-hours schedule",
    });

    // Base item totals should match Scenario 4 exactly
    // Item labor: $230 + $86.25 + $108 + $172.50 = $596.75
    expect(p.subtotals.itemLaborTotal).toBeCloseTo(596.75, 1);
    // Item material: $220 + $12 + $15.60 + $10 = $257.60
    expect(p.subtotals.itemMaterialTotal).toBeCloseTo(257.6, 1);

    // Engine total does NOT include estimate-level modifiers
    expect(p.subtotals.engineTotal).toBeDefined();

    // Review total DOES include estimate-level modifiers
    // Combined labor multiplier: 1.15 × 1.50 = 1.725
    // Adjusted labor: $596.75 × 1.725 = $1,029.39375 → $1,029.39
    // Adjusted support labor also scaled by 1.725
    expect(p.reviewTotal).toBeDefined();
    expect(p.reviewTotal!).toBeGreaterThan(p.subtotals.engineTotal);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MANDATORY COMPARISON PAIRS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Mandatory Comparison Pairs", () => {
  it("Comparison 7 vs 12: 20A (12/2) costs more than 15A (14/2)", async () => {
    // Scenario 7: 120V 20A concealed 40ft
    const p7 = await runScenario({
      scenario: 7, name: "Comparison: 20A Circuit", jobType: "New Circuit",
      items: [
        {
          atomicUnitCode: "CIR-001", quantity: 1,
          circuitVoltage: 120, circuitAmperage: 20,
          environment: "interior", exposure: "concealed", cableLength: 40,
        },
        { atomicUnitCode: "EQP-001", quantity: 1 },
      ],
      scopeSummary: "20A comparison leg",
    });

    await clearDb();

    // Scenario 12: 120V 15A concealed 40ft
    const p12 = await runScenario({
      scenario: 12, name: "Comparison: 15A Circuit", jobType: "New Circuit",
      items: [
        {
          atomicUnitCode: "CIR-001", quantity: 1,
          circuitVoltage: 120, circuitAmperage: 15,
          environment: "interior", exposure: "concealed", cableLength: 40,
        },
        { atomicUnitCode: "EQP-001", quantity: 1 },
      ],
      scopeSummary: "15A comparison leg",
    });

    // 20A uses WIR-002 (12/2), 15A uses WIR-001 (14/2)
    expect(p7.items[0].resolvedCableCode).toBe("WIR-002");
    expect(p12.items[0].resolvedCableCode).toBe("WIR-001");

    // 20A breaker ($18) > 15A breaker ($12)
    // 12/2 cable ($0.65/ft) > 14/2 cable ($0.45/ft)
    expect(p7.subtotals.engineTotal).toBeGreaterThan(p12.subtotals.engineTotal);

    console.log(
      `\n  COMPARISON 7 vs 12:\n` +
      `    20A circuit total: $${p7.subtotals.engineTotal.toFixed(2)} (WIR-002 / 12-2)\n` +
      `    15A circuit total: $${p12.subtotals.engineTotal.toFixed(2)} (WIR-001 / 14-2)\n` +
      `    Delta: $${(p7.subtotals.engineTotal - p12.subtotals.engineTotal).toFixed(2)}\n`
    );
  });

  it("Comparison 4 vs 23: Normal access vs Difficult access (1.25× labor)", async () => {
    // Scenario 4: MyRethread normal
    const p4 = await runScenario({
      scenario: 4, name: "Compare: Normal Access", jobType: "Service / Upgrade",
      items: [
        { atomicUnitCode: "DEV-005", quantity: 4 },
        { atomicUnitCode: "SRV-002", quantity: 1 },
        { atomicUnitCode: "WIR-002", quantity: 24 },
        { atomicUnitCode: "SRV-007", quantity: 2 },
      ],
      scopeSummary: "MyRethread — normal access",
    });

    await clearDb();

    // Scenario 23: MyRethread difficult
    const p23 = await runScenario({
      scenario: 23, name: "Compare: Difficult Access", jobType: "Service / Upgrade",
      items: [
        { atomicUnitCode: "DEV-005", quantity: 4, modifiers: [DIFFICULT_ACCESS] },
        { atomicUnitCode: "SRV-002", quantity: 1, modifiers: [DIFFICULT_ACCESS] },
        { atomicUnitCode: "WIR-002", quantity: 24, modifiers: [DIFFICULT_ACCESS] },
        { atomicUnitCode: "SRV-007", quantity: 2, modifiers: [DIFFICULT_ACCESS] },
      ],
      scopeSummary: "MyRethread — difficult access",
    });

    // Materials should be identical
    expect(p23.subtotals.itemMaterialTotal).toBeCloseTo(p4.subtotals.itemMaterialTotal, 1);

    // Labor should be 25% higher
    expect(p23.subtotals.itemLaborTotal).toBeCloseTo(p4.subtotals.itemLaborTotal * 1.25, 0);

    // Total should be higher
    expect(p23.subtotals.engineTotal).toBeGreaterThan(p4.subtotals.engineTotal);

    console.log(
      `\n  COMPARISON 4 vs 23:\n` +
      `    Normal access total:    $${p4.subtotals.engineTotal.toFixed(2)}\n` +
      `    Difficult access total: $${p23.subtotals.engineTotal.toFixed(2)}\n` +
      `    Labor delta: $${(p23.subtotals.itemLaborTotal - p4.subtotals.itemLaborTotal).toFixed(2)} (+25%)\n`
    );
  });

  it("Comparison 10 vs 11: Interior exposed (MC) vs Exterior (UF)", async () => {
    // Scenario 10: interior exposed 30ft
    const p10 = await runScenario({
      scenario: 10, name: "Compare: Interior Exposed", jobType: "New Circuit",
      items: [
        {
          atomicUnitCode: "CIR-001", quantity: 1,
          circuitVoltage: 120, circuitAmperage: 20,
          environment: "interior", exposure: "exposed", cableLength: 30,
        },
        { atomicUnitCode: "EQP-001", quantity: 1 },
      ],
      scopeSummary: "Interior exposed — MC cable",
    });

    await clearDb();

    // Scenario 11: exterior 30ft
    const p11 = await runScenario({
      scenario: 11, name: "Compare: Exterior", jobType: "New Circuit",
      items: [
        {
          atomicUnitCode: "CIR-001", quantity: 1,
          circuitVoltage: 120, circuitAmperage: 20,
          environment: "exterior", exposure: "exposed", cableLength: 30,
        },
        { atomicUnitCode: "EQP-001", quantity: 1 },
      ],
      scopeSummary: "Exterior — UF cable",
    });

    // MC (WIR-008) vs UF (WIR-010)
    expect(p10.items[0].resolvedCableCode).toBe("WIR-008");
    expect(p11.items[0].resolvedCableCode).toBe("WIR-010");

    // UF is more expensive in both labor and material
    expect(p11.subtotals.engineTotal).toBeGreaterThan(p10.subtotals.engineTotal);

    console.log(
      `\n  COMPARISON 10 vs 11:\n` +
      `    Interior exposed (MC): $${p10.subtotals.engineTotal.toFixed(2)} (${p10.items[0].resolvedWiringMethod})\n` +
      `    Exterior (UF):         $${p11.subtotals.engineTotal.toFixed(2)} (${p11.items[0].resolvedWiringMethod})\n` +
      `    Delta: $${(p11.subtotals.engineTotal - p10.subtotals.engineTotal).toFixed(2)}\n`
    );
  });

  it("Comparison 8 vs 24: Dryer circuit (normal) vs MyRethread (occupied + after-hours)", async () => {
    // Scenario 8: dryer circuit
    const p8 = await runScenario({
      scenario: 8, name: "Compare: Dryer Circuit", jobType: "Appliance Circuit",
      items: [
        {
          atomicUnitCode: "CIR-001", quantity: 1, location: "Laundry",
          circuitVoltage: 240, circuitAmperage: 30,
          environment: "interior", exposure: "concealed", cableLength: 35,
          needsThreeWire: true,
        },
        { atomicUnitCode: "EQP-002", quantity: 1, location: "Laundry" },
      ],
      scopeSummary: "Dryer circuit — normal conditions",
    });

    await clearDb();

    // Scenario 24: MyRethread with estimate-level modifiers
    const p24 = await runScenario({
      scenario: 24, name: "Compare: MyRethread Occupied+After-Hours", jobType: "Service / Upgrade",
      items: [
        { atomicUnitCode: "DEV-005", quantity: 4 },
        { atomicUnitCode: "SRV-002", quantity: 1 },
        { atomicUnitCode: "WIR-002", quantity: 24 },
        { atomicUnitCode: "SRV-007", quantity: 2 },
      ],
      estimateLevelModifiers: [
        { type: "OCCUPANCY", value: "OCCUPIED", laborMultiplier: 1.15 },
        { type: "SCHEDULE", value: "AFTER_HOURS", laborMultiplier: 1.50 },
      ],
      scopeSummary: "MyRethread — occupied, after-hours",
    });

    // Both should produce valid totals
    expect(p8.subtotals.engineTotal).toBeGreaterThan(0);
    expect(p24.reviewTotal).toBeGreaterThan(0);

    // Dryer 10/3 cable is correctly resolved
    expect(p8.items[0].resolvedCableCode).toBe("WIR-005");

    console.log(
      `\n  COMPARISON 8 vs 24:\n` +
      `    Dryer circuit (normal):      Engine Total: $${p8.subtotals.engineTotal.toFixed(2)}\n` +
      `    MyRethread (occupied+AH):    Engine Total: $${p24.subtotals.engineTotal.toFixed(2)}\n` +
      `    MyRethread (occupied+AH):    Review Total: $${p24.reviewTotal!.toFixed(2)}\n` +
      `      (estimate-level modifier applied in test harness — not yet native engine pricing)\n`
    );
  });
});
