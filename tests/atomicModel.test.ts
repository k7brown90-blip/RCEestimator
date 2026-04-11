/**
 * Atomic Model — Phase M4 Test Suite
 *
 * Covers: catalog reads, EstimateItem CRUD, wiring resolution,
 * modifier application, NEC check, support item generation and override.
 *
 * Catalog tables (AtomicUnit, ModifierDef, NECRule, Preset, JobType) are
 * seeded once by globalSetup.ts and are NOT cleared between tests.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

// ─── DB HELPERS ──────────────────────────────────────────────────────────────

async function clearDb() {
  // Transactional (atomic model) tables — must precede their parent tables
  await prisma.itemModifier.deleteMany();
  await prisma.estimateItem.deleteMany();
  await prisma.supportItem.deleteMany();

  // Legacy assembly tables
  await prisma.assemblyComponent.deleteMany();
  await prisma.estimateAssembly.deleteMany();

  // Estimate ownership chain
  await prisma.changeOrder.deleteMany();
  await prisma.estimateOption.deleteMany();
  await prisma.proposalAcceptance.deleteMany();
  await prisma.signatureRecord.deleteMany();
  await prisma.proposalDelivery.deleteMany();
  await prisma.inspectionStatus.deleteMany();
  await prisma.permitStatus.deleteMany();
  await prisma.estimate.deleteMany();

  // Visit / property / customer
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

async function bootstrapVisit() {
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
      purpose: "Electrical inspection",
    },
  });

  return { customer, property, visit };
}

async function bootstrapEstimate(visitId: string, propertyId: string) {
  const estRes = await request(app)
    .post("/estimates")
    .send({ visitId, propertyId, title: "Test Atomic Estimate" })
    .expect(201);
  const estimateId: string = estRes.body.id;

  const optRes = await request(app)
    .post(`/estimates/${estimateId}/options`)
    .send({ optionLabel: "Option A" })
    .expect(201);
  const optionId: string = optRes.body.id;

  return { estimateId, optionId };
}

// ─── LIFECYCLE ───────────────────────────────────────────────────────────────

beforeEach(async () => {
  await clearDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── CATALOG READS ───────────────────────────────────────────────────────────

describe("Atomic Model — Catalog reads", () => {
  it("GET /atomic-units returns all active units (≥73)", async () => {
    const res = await request(app).get("/atomic-units").expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(73);
  });

  it("GET /atomic-units?tier=1 returns exactly the 30 Tier 1 units", async () => {
    const res = await request(app).get("/atomic-units?tier=1").expect(200);
    expect(res.body.length).toBe(30);
    expect(
      res.body.every((u: { visibilityTier: number }) => u.visibilityTier === 1)
    ).toBe(true);
  });

  it("GET /atomic-units?category=DEVICES returns only DEVICES units", async () => {
    const res = await request(app).get("/atomic-units?category=DEVICES").expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(
      res.body.every((u: { category: string }) => u.category === "DEVICES")
    ).toBe(true);
  });

  it("GET /atomic-units/:code returns correct unit detail for DEV-001", async () => {
    const res = await request(app).get("/atomic-units/DEV-001").expect(200);
    expect(res.body.code).toBe("DEV-001");
    expect(res.body.name).toContain("Receptacle");
    expect(res.body.baseLaborHrs).toBe(0.35);
    expect(res.body.baseLaborRate).toBe(115);
    expect(res.body.visibilityTier).toBe(1);
  });

  it("GET /atomic-units/:code returns 404 for unknown code", async () => {
    await request(app).get("/atomic-units/UNKNOWN-000").expect(404);
  });

  it("GET /modifiers?appliesTo=ITEM includes ACCESS, HEIGHT, and CONDITION types", async () => {
    const res = await request(app).get("/modifiers?appliesTo=ITEM").expect(200);
    const types = new Set(
      res.body.map((m: { modifierType: string }) => m.modifierType)
    );
    expect(types.has("ACCESS")).toBe(true);
    expect(types.has("HEIGHT")).toBe(true);
    expect(types.has("CONDITION")).toBe(true);
  });

  it("GET /presets returns at least 6 active presets", async () => {
    const res = await request(app).get("/presets").expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(6);
    expect(
      res.body.every((p: { isActive: boolean }) => p.isActive)
    ).toBe(true);
  });

  it("GET /job-types returns at least 5 active job types", async () => {
    const res = await request(app).get("/job-types").expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(5);
    expect(
      res.body.every((jt: { isActive: boolean }) => jt.isActive)
    ).toBe(true);
  });

  it("GET /nec-rules returns active rules with ruleCode and severity", async () => {
    const res = await request(app).get("/nec-rules").expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    const first = res.body[0];
    expect(first).toHaveProperty("ruleCode");
    expect(first).toHaveProperty("severity");
    expect(first).toHaveProperty("promptText");
  });
});

// ─── ITEM CREATION AND COSTING ───────────────────────────────────────────────

describe("Atomic Model — Item creation and costing", () => {
  it("circuit item (CIR-001, 20A, concealed, 24ft) resolves NM-B 12/2", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    const res = await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({
        atomicUnitCode: "CIR-001",
        quantity: 1,
        location: "Living Room",
        circuitVoltage: 120,
        circuitAmperage: 20,
        environment: "interior",
        exposure: "concealed",
        cableLength: 24,
      })
      .expect(201);

    expect(res.body.item.resolvedWiringMethod).toBe("NM-B 12/2");
    expect(res.body.item.resolvedCableCode).toBe("WIR-002");
    expect(res.body.suggestEndpoint).toBe(true);
    expect(res.body.resolvedWiringMethod).toMatchObject({
      method: "NM-B 12/2",
      code: "WIR-002",
    });
    // Costs verified against smoke test
    expect(res.body.item.laborCost).toBe(211.5);
    expect(res.body.item.materialCost).toBe(33.6);
    expect(res.body.item.totalCost).toBe(245.1);
  });

  it("rejects circuit item that is missing required cableLength", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    const res = await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({
        atomicUnitCode: "CIR-001",
        quantity: 1,
        circuitVoltage: 120,
        circuitAmperage: 20,
        environment: "interior",
        exposure: "concealed",
        // cableLength intentionally omitted
      })
      .expect(400);

    expect(res.body.field).toBe("cableLength");
  });

  it("creates device item (DEV-001 × 3) with correct labor and material costs", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    const res = await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "DEV-001", quantity: 3 })
      .expect(201);

    // DEV-001: baseLaborHrs=0.35, baseLaborRate=115, baseMaterialCost=8, qty=3
    const expectedLabor = parseFloat((0.35 * 3 * 115).toFixed(2)); // 120.75
    const expectedMaterial = parseFloat((8 * 3).toFixed(2));       // 24.00

    expect(res.body.item.laborCost).toBe(expectedLabor);
    expect(res.body.item.materialCost).toBe(expectedMaterial);
    expect(res.body.item.totalCost).toBe(
      parseFloat((expectedLabor + expectedMaterial).toFixed(2))
    );
    expect(res.body.suggestEndpoint).toBe(false);
    expect(res.body.item.modifiers).toHaveLength(0);
  });

  it("applies ACCESS DIFFICULT modifier multiplier to labor", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    const modsRes = await request(app).get("/modifiers?appliesTo=ITEM").expect(200);
    const difficult = modsRes.body.find(
      (m: { modifierType: string; value: string }) =>
        m.modifierType === "ACCESS" && m.value === "DIFFICULT"
    );
    expect(difficult).toBeDefined();

    const res = await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({
        atomicUnitCode: "DEV-001",
        quantity: 1,
        modifiers: [
          {
            modifierType: difficult.modifierType,
            modifierValue: difficult.value,
            laborMultiplier: difficult.laborMultiplier,
            materialMult: difficult.materialMult,
          },
        ],
      })
      .expect(201);

    const expectedLabor = parseFloat(
      (0.35 * 1 * difficult.laborMultiplier * 115).toFixed(2)
    );
    expect(res.body.item.laborCost).toBe(expectedLabor);
    expect(res.body.item.modifiers).toHaveLength(1);
    expect(res.body.item.modifiers[0].modifierType).toBe("ACCESS");
  });

  it("returns 404 for unknown atomic unit code", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "INVALID-999", quantity: 1 })
      .expect(404);
  });

  it("returns 404 for unknown estimate option", async () => {
    await request(app)
      .post("/estimates/nonexistent/options/nonexistent/items")
      .send({ atomicUnitCode: "DEV-001", quantity: 1 })
      .expect(404);
  });
});

// ─── ITEMS LIST AND DELETE ────────────────────────────────────────────────────

describe("Atomic Model — Items list and delete", () => {
  it("GET items returns items for the option with atomicUnit included", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "DEV-001", quantity: 2 })
      .expect(201);

    const res = await request(app)
      .get(`/estimates/${estimateId}/options/${optionId}/items`)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].quantity).toBe(2);
    expect(res.body[0].atomicUnit.code).toBe("DEV-001");
  });

  it("GET items returns empty array before any items are added", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    const res = await request(app)
      .get(`/estimates/${estimateId}/options/${optionId}/items`)
      .expect(200);

    expect(res.body).toHaveLength(0);
  });

  it("DELETE item removes it and leaves the option empty", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    const createRes = await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "DEV-001", quantity: 1 })
      .expect(201);

    const itemId: string = createRes.body.item.id;

    await request(app)
      .delete(`/estimates/${estimateId}/options/${optionId}/items/${itemId}`)
      .expect(204);

    const listRes = await request(app)
      .get(`/estimates/${estimateId}/options/${optionId}/items`)
      .expect(200);

    expect(listRes.body).toHaveLength(0);
  });

  it("DELETE item returns 404 for unknown item", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    await request(app)
      .delete(`/estimates/${estimateId}/options/${optionId}/items/nonexistent`)
      .expect(404);
  });
});

// ─── NEC CHECK ───────────────────────────────────────────────────────────────

describe("Atomic Model — NEC check", () => {
  it("DEV-001 fires NEC-406.12 tamper-resistant advisory", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "DEV-001", quantity: 1 })
      .expect(201);

    const res = await request(app)
      .post(`/estimates/${estimateId}/nec-check`)
      .expect(200);

    expect(res.body.estimateId).toBe(estimateId);
    expect(Array.isArray(res.body.prompts)).toBe(true);

    const rule406 = res.body.prompts.find(
      (p: { ruleCode: string }) => p.ruleCode === "NEC-406.12"
    );
    expect(rule406).toBeDefined();
    expect(rule406.severity).toBe("ADVISORY");
  });

  it("PNL-001 fires NEC-230.71 and NEC-250.50 prompts", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "PNL-001", quantity: 1 })
      .expect(201);

    const res = await request(app)
      .post(`/estimates/${estimateId}/nec-check`)
      .expect(200);

    const ruleCodes = res.body.prompts.map((p: { ruleCode: string }) => p.ruleCode);
    expect(ruleCodes).toContain("NEC-230.71");
    expect(ruleCodes).toContain("NEC-250.50");
  });

  it("location 'kitchen' fires GFCI and small-appliance circuit prompts", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "DEV-001", quantity: 1, location: "Kitchen countertop" })
      .expect(201);

    const res = await request(app)
      .post(`/estimates/${estimateId}/nec-check`)
      .expect(200);

    const ruleCodes = res.body.prompts.map((p: { ruleCode: string }) => p.ruleCode);
    expect(ruleCodes).toContain("NEC-210.8-A");
    expect(ruleCodes).toContain("NEC-210.11-C1");
  });

  it("returns 404 NEC check for unknown estimate", async () => {
    await request(app)
      .post("/estimates/nonexistent-id/nec-check")
      .expect(404);
  });
});

// ─── SUPPORT ITEM GENERATION ─────────────────────────────────────────────────

describe("Atomic Model — Support item generation", () => {
  it("circuit + device scope generates MOBILIZATION, PERMIT, CIRCUIT_TESTING, CLEANUP", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({
        atomicUnitCode: "CIR-001",
        quantity: 1,
        circuitVoltage: 120,
        circuitAmperage: 20,
        environment: "interior",
        exposure: "concealed",
        cableLength: 24,
      })
      .expect(201);

    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "DEV-001", quantity: 1 })
      .expect(201);

    const res = await request(app)
      .post(`/estimates/${estimateId}/support-items/generate`)
      .expect(200);

    const types = res.body.supportItems.map(
      (s: { supportType: string }) => s.supportType
    ) as string[];

    expect(types).toContain("MOBILIZATION");
    expect(types).toContain("PERMIT");
    expect(types).toContain("CIRCUIT_TESTING");
    expect(types).toContain("CLEANUP");
    expect(types).not.toContain("PANEL_DEMO");
    expect(types).not.toContain("LOAD_CALC");

    const mob = res.body.supportItems.find(
      (s: { supportType: string }) => s.supportType === "MOBILIZATION"
    );
    expect(mob.totalCost).toBe(35);
    expect(mob.isOverridden).toBe(false);

    const permit = res.body.supportItems.find(
      (s: { supportType: string }) => s.supportType === "PERMIT"
    );
    expect(permit.totalCost).toBe(350);

    const testing = res.body.supportItems.find(
      (s: { supportType: string }) => s.supportType === "CIRCUIT_TESTING"
    );
    expect(testing.laborHrs).toBe(0.25); // 1 circuit × 0.25 hr
  });

  it("panel replacement (PNL-001) generates PANEL_DEMO and LOAD_CALC", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "PNL-001", quantity: 1 })
      .expect(201);

    const res = await request(app)
      .post(`/estimates/${estimateId}/support-items/generate`)
      .expect(200);

    const types = res.body.supportItems.map(
      (s: { supportType: string }) => s.supportType
    ) as string[];

    expect(types).toContain("PANEL_DEMO");
    expect(types).toContain("LOAD_CALC");
    expect(types).toContain("PERMIT");
    expect(types).toContain("MOBILIZATION");

    const panelDemo = res.body.supportItems.find(
      (s: { supportType: string }) => s.supportType === "PANEL_DEMO"
    );
    expect(panelDemo.laborHrs).toBe(5.0);

    const loadCalc = res.body.supportItems.find(
      (s: { supportType: string }) => s.supportType === "LOAD_CALC"
    );
    expect(loadCalc.laborHrs).toBe(1.5);
  });

  it("GET support-items returns generated items for the estimate", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "DEV-001", quantity: 1 })
      .expect(201);

    await request(app)
      .post(`/estimates/${estimateId}/support-items/generate`)
      .expect(200);

    const res = await request(app)
      .get(`/estimates/${estimateId}/support-items`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty("supportType");
    expect(res.body[0]).toHaveProperty("totalCost");
    expect(res.body[0]).toHaveProperty("isOverridden");
  });

  it("PATCH support-item marks it overridden with a note", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "DEV-001", quantity: 1 })
      .expect(201);

    const genRes = await request(app)
      .post(`/estimates/${estimateId}/support-items/generate`)
      .expect(200);

    const mobilization = genRes.body.supportItems.find(
      (s: { supportType: string }) => s.supportType === "MOBILIZATION"
    );

    const patchRes = await request(app)
      .patch(`/estimates/${estimateId}/support-items/${mobilization.id}`)
      .send({ isOverridden: true, overrideNote: "Client providing own transport" })
      .expect(200);

    expect(patchRes.body.isOverridden).toBe(true);
    expect(patchRes.body.overrideNote).toBe("Client providing own transport");
  });

  it("re-generating preserves overridden items, replaces auto items", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "DEV-001", quantity: 1 })
      .expect(201);

    // First generate
    const firstRes = await request(app)
      .post(`/estimates/${estimateId}/support-items/generate`)
      .expect(200);

    const mobilization = firstRes.body.supportItems.find(
      (s: { supportType: string }) => s.supportType === "MOBILIZATION"
    );

    // Override one item
    await request(app)
      .patch(`/estimates/${estimateId}/support-items/${mobilization.id}`)
      .send({ isOverridden: true })
      .expect(200);

    // Re-generate
    await request(app)
      .post(`/estimates/${estimateId}/support-items/generate`)
      .expect(200);

    // Overridden item must still exist
    const allItems = await request(app)
      .get(`/estimates/${estimateId}/support-items`)
      .expect(200);

    const survivingItem = allItems.body.find(
      (s: { id: string }) => s.id === mobilization.id
    );
    expect(survivingItem).toBeDefined();
    expect(survivingItem.isOverridden).toBe(true);
  });

  it("DELETE support-item removes it", async () => {
    const { visit, property } = await bootstrapVisit();
    const { estimateId, optionId } = await bootstrapEstimate(visit.id, property.id);

    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "DEV-001", quantity: 1 })
      .expect(201);

    const genRes = await request(app)
      .post(`/estimates/${estimateId}/support-items/generate`)
      .expect(200);

    const itemId: string = genRes.body.supportItems[0].id;
    const initialCount: number = genRes.body.supportItems.length;

    await request(app)
      .delete(`/estimates/${estimateId}/support-items/${itemId}`)
      .expect(204);

    const afterRes = await request(app)
      .get(`/estimates/${estimateId}/support-items`)
      .expect(200);

    expect(afterRes.body.length).toBe(initialCount - 1);
    expect(afterRes.body.find((s: { id: string }) => s.id === itemId)).toBeUndefined();
  });
});
