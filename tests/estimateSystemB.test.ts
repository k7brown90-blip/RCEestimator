/**
 * Estimate flow — System B (CSV catalog) integration tests.
 *
 * Replaces the retired NEC-era suites (estimateScenarios/atomicModel), which
 * tested DEV-/CIR-/PNL- codes and the /nec-check endpoint removed by the
 * "Retire NEC compliance layer" migration. These tests run against the CURRENT
 * catalog (LINE/RI/TRIM/DIAG codes seeded from the three CSV files).
 *
 * Costing constants (from seedAtomicUnits.ts / CSVs):
 * - $115/hr standard labor, $90/hr LF cable/conduit
 * - LINE-002 (new_work): 2.00 hrs, $210 material
 * - RI-001 new_work: 0.10 hrs, $0.75 · RI-001 old_work: 0.15 hrs, $3.25
 * - TRIM-029 (shared): 1.00 hrs, $0 material
 * - DIAG-001 (service): 1.00 hrs, $0 material
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

async function cleanup() {
  await prisma.itemModifier.deleteMany();
  await prisma.estimateItem.deleteMany();
  await prisma.supportItem.deleteMany();
  await prisma.estimateOption.deleteMany();
  await prisma.estimate.deleteMany();
  await prisma.visit.deleteMany();
  await prisma.systemSnapshot.deleteMany();
  await prisma.property.deleteMany();
  await prisma.customer.deleteMany();
}

beforeEach(cleanup);
afterAll(cleanup);

async function bootstrapEstimateContext() {
  const customer = await prisma.customer.create({
    data: { name: "Test Homeowner", email: "test@example.com" },
  });
  const property = await prisma.property.create({
    data: {
      customerId: customer.id,
      name: "Test House",
      addressLine1: "456 Elm St",
      city: "Murfreesboro",
      state: "TN",
      postalCode: "37127",
    },
  });
  const visit = await prisma.visit.create({
    data: {
      propertyId: property.id,
      customerId: customer.id,
      mode: "service_diagnostic",
      purpose: "System B test",
    },
  });
  const estRes = await request(app)
    .post("/estimates")
    .send({ visitId: visit.id, propertyId: property.id, title: "System B Test" })
    .expect(201);
  const optRes = await request(app)
    .post(`/estimates/${estRes.body.id}/options`)
    .send({ optionLabel: "Option A" })
    .expect(201);
  return { estimateId: estRes.body.id as string, optionId: optRes.body.id as string };
}

describe("catalog reads (System B)", () => {
  it("GET /atomic-units returns seeded LINE/RI/TRIM units", async () => {
    const res = await request(app).get("/atomic-units").expect(200);
    const codes = res.body.map((u: { code: string }) => u.code);
    expect(codes).toContain("LINE-002");
    expect(codes).toContain("TRIM-029");
  });

  it("retired NEC-era codes are gone from the active catalog", async () => {
    const res = await request(app).get("/atomic-units").expect(200);
    const codes = new Set(res.body.map((u: { code: string }) => u.code));
    for (const retired of ["DEV-001", "CIR-001", "GND-001", "EQP-001"]) {
      expect(codes.has(retired)).toBe(false);
    }
  });
});

describe("item creation and costing", () => {
  it("creates a LINE-002 panel item at catalog labor and material", async () => {
    const { estimateId, optionId } = await bootstrapEstimateContext();
    const res = await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "LINE-002", quantity: 1 })
      .expect(201);
    // 2.00 hrs × $115 = $230 labor; $210 material
    expect(res.body.item.laborCost).toBe(230);
    expect(res.body.item.materialCost).toBe(210);
    expect(res.body.item.totalCost).toBe(440);
  });

  it("disambiguates duplicate codes by catalog (RI-001 new_work vs old_work)", async () => {
    const { estimateId, optionId } = await bootstrapEstimateContext();
    const newWork = await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "RI-001", catalog: "new_work", quantity: 1 })
      .expect(201);
    // 0.10 hrs × $115 = $11.50 labor; $0.75 material
    expect(newWork.body.item.laborCost).toBe(11.5);
    expect(newWork.body.item.materialCost).toBe(0.75);

    const oldWork = await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "RI-001", catalog: "old_work", quantity: 1 })
      .expect(201);
    // 0.15 hrs × $115 = $17.25 labor; $3.25 material
    expect(oldWork.body.item.laborCost).toBe(17.25);
    expect(oldWork.body.item.materialCost).toBe(3.25);
  });

  it("applies quantity and item modifiers to labor", async () => {
    const { estimateId, optionId } = await bootstrapEstimateContext();
    const res = await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({
        atomicUnitCode: "TRIM-029",
        quantity: 2,
        modifiers: [
          { modifierType: "CONDITION", modifierValue: "obstructed", laborMultiplier: 1.2, materialMult: 1.0 },
        ],
      })
      .expect(201);
    // 1.00 hrs × 2 × 1.2 × $115 = $276 labor; $0 material
    expect(res.body.item.laborCost).toBe(276);
    expect(res.body.item.materialCost).toBe(0);
    expect(res.body.item.modifiers.length).toBe(1);
  });

  it("rejects an unknown atomic-unit code with 404", async () => {
    const { estimateId, optionId } = await bootstrapEstimateContext();
    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "DEV-001", quantity: 1 })
      .expect(404);
  });

  it("rejects an item on an option that does not belong to the estimate", async () => {
    const a = await bootstrapEstimateContext();
    const b = await bootstrapEstimateContext();
    await request(app)
      .post(`/estimates/${a.estimateId}/options/${b.optionId}/items`)
      .send({ atomicUnitCode: "LINE-002", quantity: 1 })
      .expect(404);
  });
});

describe("option totals", () => {
  it("recalculates option totals after item add and delete", async () => {
    const { estimateId, optionId } = await bootstrapEstimateContext();
    const created = await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "LINE-002", quantity: 1 })
      .expect(201);

    const option = await prisma.estimateOption.findUnique({ where: { id: optionId } });
    expect(option?.subtotalLabor).toBe(230);
    expect(option?.totalCost).toBeGreaterThanOrEqual(440); // material markup may apply

    await request(app)
      .delete(`/estimates/${estimateId}/options/${optionId}/items/${created.body.item.id}`)
      .expect(204);
    const after = await prisma.estimateOption.findUnique({ where: { id: optionId } });
    expect(after?.subtotalLabor).toBe(0);
  });
});

describe("support item generation (pattern-based triggers)", () => {
  it("panel mount triggers PERMIT and PANEL_LABELING", async () => {
    const { estimateId, optionId } = await bootstrapEstimateContext();
    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "LINE-002", quantity: 1 })
      .expect(201);

    const res = await request(app)
      .post(`/estimates/${estimateId}/support-items/generate`)
      .expect(200);
    const types = res.body.supportItems.map((s: { supportType: string }) => s.supportType);
    expect(types).toContain("PERMIT");
    expect(types).toContain("PANEL_LABELING");

    const permit = res.body.supportItems.find((s: { supportType: string }) => s.supportType === "PERMIT");
    expect(permit.otherCost).toBe(350);
  });

  it("meter base triggers UTILITY_COORD at 2.0 hrs × $115", async () => {
    const { estimateId, optionId } = await bootstrapEstimateContext();
    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "LINE-006", quantity: 1 })
      .expect(201);

    const res = await request(app)
      .post(`/estimates/${estimateId}/support-items/generate`)
      .expect(200);
    const utility = res.body.supportItems.find(
      (s: { supportType: string }) => s.supportType === "UTILITY_COORD",
    );
    expect(utility).toBeDefined();
    expect(utility.laborCost).toBe(230);
  });

  it("device-only scope generates no support items (NECA units are all-inclusive)", async () => {
    const { estimateId, optionId } = await bootstrapEstimateContext();
    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "TRIM-029", quantity: 1 })
      .expect(201);

    const res = await request(app)
      .post(`/estimates/${estimateId}/support-items/generate`)
      .expect(200);
    expect(res.body.generated).toBe(0);
  });

  it("regeneration preserves overridden support items", async () => {
    const { estimateId, optionId } = await bootstrapEstimateContext();
    await request(app)
      .post(`/estimates/${estimateId}/options/${optionId}/items`)
      .send({ atomicUnitCode: "LINE-002", quantity: 1 })
      .expect(201);
    const first = await request(app)
      .post(`/estimates/${estimateId}/support-items/generate`)
      .expect(200);
    const permit = first.body.supportItems.find(
      (s: { supportType: string }) => s.supportType === "PERMIT",
    );

    await request(app)
      .patch(`/estimates/${estimateId}/support-items/${permit.id}`)
      .send({ isOverridden: true, overrideNote: "City permit is $425 here", otherCost: 425 })
      .expect(200);

    await request(app).post(`/estimates/${estimateId}/support-items/generate`).expect(200);
    const list = await request(app).get(`/estimates/${estimateId}/support-items`).expect(200);
    const kept = list.body.find((s: { id: string }) => s.id === permit.id);
    expect(kept).toBeDefined();
    expect(kept.isOverridden).toBe(true);
    expect(kept.otherCost).toBe(425);
  });
});
