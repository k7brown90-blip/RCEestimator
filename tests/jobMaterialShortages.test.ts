/**
 * The job's material shortage (Kyle, 2026-09-16/17, Unit P).
 *
 * Debug report: "I am seeing a 'create a P.O.' on each line item that is in the estimate. If I
 * click on each of those then I fear I will create several single item Part orders instead of
 * complete material order for the job." `shortagesForJob` (services/jobMaterials.ts) replaces the
 * per-line prompt with one list, per item, of what the job still needs beyond what a truck already
 * holds, what has already been consumed, and what is already on order:
 *
 *   short = max(0, (neededQty - consumedQty) - onHand - qtyOnOpenPOs)
 *
 * These tests hold to three traps named in the plan:
 *   - an ASSEMBLY line must expand to its real components — it is never itself purchasable and
 *     must never appear in the shortage list;
 *   - qtyOnOpenPOs counts only a PO that has not landed (open/purchased/verified), never a closed
 *     (landed) or cancelled one;
 *   - a signed CHANGE ORDER is a separate IssuedEstimate row from the original and must count
 *     toward the same job's material need, not be silently dropped.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { applyMovement, truckLocationKey } from "../src/services/inventory";
import { consumeForJob, shortagesForJob } from "../src/services/jobMaterials";
import { createPurchaseOrder, defaultTruckId, transitionPurchaseOrder } from "../src/services/purchaseOrders";

const newId = () => crypto.randomUUID().replaceAll("-", "");

const WIRE = "UNITP-WIRE";
const BREAKER = "UNITP-BREAKER";
const STAPLE = "UNITP-STAPLE"; // stays fully covered — must NOT appear in the result
const EVCHG = "UNITP-EVCHG"; // the assembly — must NEVER appear in the result

let truckId: string;
let truckKey: string;
let customerId: string;
let propertyId: string;
let job: string;
let draftId: string;

async function cleanup() {
  await prisma.stockMovement.deleteMany({ where: { jobId: job } });
  await prisma.stockLevel.deleteMany({ where: { locationKey: truckKey, itemId: { in: [WIRE, BREAKER, STAPLE] } } });
  await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { jobId: job } } });
  await prisma.purchaseOrderEvent.deleteMany({ where: { purchaseOrder: { jobId: job } } });
  await prisma.purchaseOrder.deleteMany({ where: { jobId: job } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimate: { number: { startsWith: "0000-UNITP" } } } });
  await prisma.issuedEstimate.deleteMany({ where: { number: { startsWith: "0000-UNITP" } } });
  if (draftId) await prisma.priceBookDraftEstimate.deleteMany({ where: { id: draftId } });
  await prisma.priceBookItemComponent.deleteMany({ where: { parentItemId: EVCHG } });
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: [WIRE, BREAKER, STAPLE, EVCHG] } } });
  if (job) await prisma.visit.deleteMany({ where: { id: job } });
  if (propertyId) await prisma.property.deleteMany({ where: { id: propertyId } });
  if (customerId) await prisma.customer.deleteMany({ where: { id: customerId } });
}

beforeAll(async () => {
  await cleanup();
  truckId = await defaultTruckId();
  truckKey = truckLocationKey(truckId);

  await prisma.priceBookAtomic.createMany({
    data: [
      { itemId: WIRE, description: "Unit P 12-2 NM-B", unit: "ft" },
      { itemId: BREAKER, description: "Unit P 20A breaker", unit: "ea" },
      { itemId: STAPLE, description: "Unit P staple box", unit: "box" },
      { itemId: EVCHG, description: "Unit P EV charger assembly", unit: "ea", rowType: "ASSEMBLY" },
    ],
  });
  // Each EV charger needs 1 breaker and 30 ft of wire.
  await prisma.priceBookItemComponent.createMany({
    data: [
      { parentItemId: EVCHG, childItemId: BREAKER, quantity: 1 },
      { parentItemId: EVCHG, childItemId: WIRE, quantity: 30 },
    ],
  });

  const customer = await prisma.customer.create({ data: { name: "Unit P Shortage Co", phone: "+16155509999" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "Shortage House", addressLine1: "1 Shortage Way", city: "Franklin", state: "TN", postalCode: "37064" },
  });
  propertyId = property.id;
  job = (await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: "Unit P job", jobType: "Unit P job", status: "in_progress", visitDate: new Date() },
  })).id;

  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: "unit-p shortage draft", supplierId: "UNITP-SUP" } });
  draftId = draft.id;

  // The ORIGINAL signed estimate: 100 ft of wire quoted directly, plus 2 EV charger assemblies
  // (each expands to 1 breaker + 30 ft of wire) and one fully-covered staple box line. Linked to
  // the job through jobVisitId, exactly as accountSpine.ts links the estimate that created the job.
  const original = await prisma.issuedEstimate.create({
    data: {
      number: "0000-UNITP-ORIG", token: `unitp-token-${newId()}`, status: "signed", draftId: draft.id,
      customerId, serviceAddressId: propertyId, jobVisitId: job,
      customerName: "Unit P Shortage Co", serviceAddress: "1 Shortage Way, Franklin", title: "Unit P original",
      workSubtotal: 5000, total: 5000, selectedOptions: ["A"], signedAt: new Date(), signedChannel: "email",
    },
  });
  await prisma.issuedEstimateLine.createMany({
    data: [
      { estimateId: original.id, itemId: WIRE, description: "12-2 NM-B", quantity: 100, unitPrice: 1, lineTotal: 100, option: "A", materialCost: 72, materialSell: 100 },
      { estimateId: original.id, itemId: EVCHG, description: "EV charger install", quantity: 2, unitPrice: 500, lineTotal: 1000, option: "A", materialCost: 200, materialSell: 1000 },
      { estimateId: original.id, itemId: STAPLE, description: "Staple box", quantity: 5, unitPrice: 4, lineTotal: 20, option: "A", materialCost: 10, materialSell: 20 },
    ],
  });

  // A signed CHANGE ORDER against the same job: a separate IssuedEstimate row, linked through
  // `visitId` (not `jobVisitId` — see the comment on allSignedEstimatesForJob for why), adding one
  // more breaker.
  const changeOrder = await prisma.issuedEstimate.create({
    data: {
      number: "0000-UNITP-CO", token: `unitp-token-${newId()}`, status: "signed", draftId: draft.id,
      customerId, serviceAddressId: propertyId, visitId: job,
      customerName: "Unit P Shortage Co", serviceAddress: "1 Shortage Way, Franklin", title: "Unit P change order",
      workSubtotal: 300, total: 300, selectedOptions: ["A"], signedAt: new Date(), signedChannel: "email",
    },
  });
  await prisma.issuedEstimateLine.create({
    data: { estimateId: changeOrder.id, itemId: BREAKER, description: "Extra 20A breaker", quantity: 1, unitPrice: 15, lineTotal: 15, option: "A", materialCost: 9.5, materialSell: 15 },
  });

  // Truck holds 50 ft of wire; the job consumes 30 of it, leaving 20 on the truck.
  await applyMovement(prisma, { kind: "count", itemId: WIRE, name: "12-2 NM-B", unit: "ft", qty: 50, unitCost: 0.72, toLocationKey: truckKey, actor: "test" });
  await consumeForJob({ jobId: job, truckId, lines: [{ itemId: WIRE, qty: 30 }], actor: "test" });

  // The staple box is fully covered by truck stock — must drop out of the result entirely.
  await applyMovement(prisma, { kind: "count", itemId: STAPLE, name: "Staple box", unit: "box", qty: 10, unitCost: 3, toLocationKey: truckKey, actor: "test" });

  // Breaker purchase orders on the job: one OPEN (counts), one CLOSED/landed (must not count —
  // its material is already on the truck by the time it's closed) and one CANCELLED (never
  // counts).
  const openPo = await createPurchaseOrder({ supplier: "Test Supply", openedBy: "owner", actor: "test", truckId, jobId: job, lines: [{ itemId: BREAKER, name: "20A breaker", qty: 1 }] });
  expect(openPo.status).toBe("open");

  const closedPo = await createPurchaseOrder({ supplier: "Test Supply", openedBy: "owner", actor: "test", truckId, jobId: job, lines: [{ itemId: BREAKER, name: "20A breaker", qty: 5 }] });
  await transitionPurchaseOrder(closedPo.id, "purchased", { actor: "test" });
  await transitionPurchaseOrder(closedPo.id, "verified", { actor: "test" });
  await transitionPurchaseOrder(closedPo.id, "closed", { actor: "test" });

  const cancelledPo = await createPurchaseOrder({ supplier: "Test Supply", openedBy: "owner", actor: "test", truckId, jobId: job, lines: [{ itemId: BREAKER, name: "20A breaker", qty: 7 }] });
  await transitionPurchaseOrder(cancelledPo.id, "cancelled", { actor: "test", reason: "test cleanup" });
});

afterAll(cleanup);

describe("shortagesForJob", () => {
  it("expands the assembly, merges the change order, and nets consumed + on-hand + open POs — dropping fully-covered and assembly-itself lines", async () => {
    const shortages = await shortagesForJob(job, truckId);
    const byId = new Map(shortages.map((s) => [s.itemId, s]));

    // Assembly must never appear as a shortage line.
    expect(byId.has(EVCHG)).toBe(false);
    // Fully covered by truck stock — dropped, not zero.
    expect(byId.has(STAPLE)).toBe(false);

    // Wire: needed = 100 (direct) + 2*30 (2 EV chargers) = 160. Consumed 30, on-hand (post-consume)
    // 20, no open PO. short = 160 - 30 - 20 - 0 = 110.
    const wire = byId.get(WIRE);
    expect(wire).toBeTruthy();
    expect(wire!.neededQty).toBe(160);
    expect(wire!.consumedQty).toBe(30);
    expect(wire!.onHand).toBe(20);
    expect(wire!.qtyOnOpenPOs).toBe(0);
    expect(wire!.shortBy).toBe(110);
    expect(wire!.unit).toBe("ft");

    // Breaker: needed = 2 (2 EV chargers × 1) + 1 (change order) = 3. Nothing consumed, nothing on
    // hand, and only the OPEN PO's 1 counts (not the closed 5 or the cancelled 7).
    // short = 3 - 0 - 0 - 1 = 2.
    const breaker = byId.get(BREAKER);
    expect(breaker).toBeTruthy();
    expect(breaker!.neededQty).toBe(3);
    expect(breaker!.consumedQty).toBe(0);
    expect(breaker!.onHand).toBe(0);
    expect(breaker!.qtyOnOpenPOs).toBe(1);
    expect(breaker!.shortBy).toBe(2);
  });

  it("returns nothing for a job with no signed estimate", async () => {
    const bareJob = (await prisma.visit.create({
      data: { customerId, propertyId, mode: "onsite", purpose: "Unit P bare job", jobType: "Unit P bare job", status: "in_progress", visitDate: new Date() },
    })).id;
    try {
      expect(await shortagesForJob(bareJob, truckId)).toEqual([]);
    } finally {
      await prisma.visit.delete({ where: { id: bareJob } });
    }
  });
});
