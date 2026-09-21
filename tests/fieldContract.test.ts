/**
 * Contract tests pinning three server payloads against the field PWA's declared
 * interfaces (Phase A, 2026-09-20 "drawers and tab purpose" plan — the safety
 * net before any drawer/rewrite work starts).
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * The field app trusts every server response with NO runtime validation:
 * `crmRequest` does `body?.data as T` (field/src/lib/crmSync.ts:89-107) — a
 * cast, not a check. Three serializers go to the phone verbatim, and the
 * drawers plan named the exact failure mode: rename a field on the server and
 * the client compiles, deploys, and just reads `undefined` forever.
 *
 * `PurchaseOrderPanel.tsx:371` computes
 *   `poNeedsProof = po.moneyTotal > 0 && po.proofCount === 0`
 * — drop either key and that becomes `undefined > 0` -> `false`, so the
 * "attach the receipt" prompt stops appearing on a tech's phone with no error
 * anywhere. `MaterialsUsedStep.tsx:112` does `data.materialCost.toFixed(2)`,
 * which throws instead — also worth pinning, just louder.
 *
 * Follows tests/visitModes.test.ts's pattern (pin a real server response
 * against what the client expects, not a restated copy of either side) and
 * tests/purchaseOrders.test.ts / tests/landingPrices.test.ts for tech-router
 * fixture setup (technician + visitAssignment + Bearer auth).
 *
 * Three server functions, three field routes, three field interfaces:
 *   serializePurchaseOrder (src/services/purchaseOrders.ts:618), narrowed by
 *     fieldPoView (src/routes/health-record.ts:1428) for
 *     GET /health-record/visits/:visitId/purchase-orders (health-record.ts:1494)
 *     -> FieldPurchaseOrder (field/src/lib/crmSync.ts:647-667)
 *   jobMaterials (src/services/jobMaterials.ts:570), returned verbatim by
 *     GET /health-record/visits/:visitId/materials (health-record.ts:1690)
 *     -> FieldJobMaterials (field/src/lib/crmSync.ts:577-588)
 *   landingDefaults (src/services/inventory.ts:599), returned verbatim by
 *     GET /health-record/purchase-orders/:id/landing (health-record.ts:1815)
 *     -> FieldLanding (field/src/lib/crmSync.ts:948-961)
 *
 * FOUR now, since 2026-09-20: serializeDiagnosticReport
 * (src/services/diagnosticReport.ts), returned verbatim by
 * POST /health-record/diagnostic-reports and the two diagnostic GETs
 * -> DiagnosticReportView (shared/diagnostics.ts). This one is the least
 * forgiving of the four: DiagnosticScreen renders `money.overage[tier]` and
 * `coverageStatement` directly, so a dropped key does not throw — it prints a
 * report that silently claims nothing about coverage, which is the one sentence
 * the whole feature exists to produce.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials() {}
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }) },
        events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }) },
      }),
    },
  };
});

import { app } from "../src/app";
import { createPurchaseOrder, defaultTruckId } from "../src/services/purchaseOrders";

const newId = () => crypto.randomUUID().replaceAll("-", "");
const VENDOR = "FCT-test Home Depot";

let customerId: string;
let jobId: string;
let technicianId: string;
let techToken: string;
let truckId: string;

beforeAll(async () => {
  truckId = await defaultTruckId();
  const customer = await prisma.customer.create({ data: { name: "Field Contract Customer", phone: "+16155509999" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "FCT House", addressLine1: "9 Contract Ln", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  const visit = await prisma.visit.create({
    data: { customerId, propertyId: property.id, mode: "service_diagnostic", purpose: "Contract test job", jobType: "Service", status: "in_progress", visitDate: new Date() },
  });
  jobId = visit.id;

  const tech = await prisma.technician.create({ data: { name: "FCT Test Tech", accessToken: `fct-test-${newId()}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.visitAssignment.create({ data: { visitId: jobId, technicianId } });
});

afterAll(async () => {
  await prisma.receipt.updateMany({ where: { purchaseOrderId: { not: null } }, data: { purchaseOrderId: null } });
  await prisma.receipt.deleteMany({ where: { vendor: VENDOR } });
  await prisma.cardSpend.deleteMany({ where: { stripeCardId: "card_fct_test" } });
  await prisma.purchaseOrder.deleteMany({ where: { jobId } });
  await prisma.visitAssignment.deleteMany({ where: { visitId: jobId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { customerId } });
  await prisma.customer.delete({ where: { id: customerId } });
});

describe("FieldPurchaseOrder — GET /health-record/visits/:visitId/purchase-orders", () => {
  it("carries moneyTotal, proofCount, cardTotal, offCardAmount and receiptCount with the right types, and the needs-proof rule reads true", async () => {
    const po = await createPurchaseOrder({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId, jobId,
      lines: [{ name: "20A breaker", qty: 2, unit: "ea" }],
    });
    // Money with no proof yet — the exact state PurchaseOrderPanel.tsx:371 prompts on.
    await prisma.cardSpend.create({
      data: {
        stripeTransactionId: `fct_test_${newId()}`, stripeCardId: "card_fct_test", kind: "materials",
        amount: 42.5, merchantName: VENDOR, purchaseOrderId: po.id, occurredAt: new Date(),
      },
    });

    const res = await request(app)
      .get(`/health-record/visits/${jobId}/purchase-orders`)
      .set("Authorization", `Bearer ${techToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.orders).toHaveLength(1);
    const order = res.body.data.orders[0];

    // FieldPurchaseOrder (field/src/lib/crmSync.ts:647-667) — every key the phone reads.
    expect(order).toMatchObject({
      id: po.id,
      number: po.number,
      purpose: "truck_stock",
      status: "open",
      supplier: "Home Depot",
      jobId,
    });
    expect(typeof order.number).toBe("string");
    expect(typeof order.status).toBe("string");
    expect(typeof order.supplier).toBe("string");
    expect(order.jobLabel === null || typeof order.jobLabel === "string").toBe(true);
    expect(order.truckName === null || typeof order.truckName === "string").toBe(true);

    // The four money/proof keys named in the drawers plan's trap 1 — pinned by
    // TYPE, not just presence, since `undefined > 0` silently evaluates to
    // `false` and would pass a presence-only check for the wrong reason.
    expect(typeof order.receiptCount).toBe("number");
    expect(typeof order.proofCount).toBe("number");
    expect(typeof order.cardTotal).toBe("number");
    expect(order.offCardAmount === null || typeof order.offCardAmount === "number").toBe(true);
    expect(typeof order.moneyTotal).toBe("number");

    expect(order.cardTotal).toBe(42.5);
    expect(order.moneyTotal).toBe(42.5);
    expect(order.proofCount).toBe(0);
    expect(order.receiptCount).toBe(0);

    // The exact rule PurchaseOrderPanel.tsx:371 evaluates on the phone.
    const poNeedsProof = order.moneyTotal > 0 && order.proofCount === 0;
    expect(poNeedsProof).toBe(true);

    // items (not `lines` — the field's own shape, per fieldPoView) carries the line.
    expect(Array.isArray(order.items)).toBe(true);
    expect(order.items[0]).toMatchObject({ name: "20A breaker", qty: 2 });

    expect(typeof order.openedAt).toBe("string");
    expect(typeof order.createdAt).toBe("string");
    expect(order.sentAt === null || typeof order.sentAt === "string").toBe(true);
  });

  it("clears the needs-proof prompt once a receipt with a file lands on it", async () => {
    const po = await createPurchaseOrder({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId, jobId,
      lines: [{ name: "AFCI breaker", qty: 1, unit: "ea" }],
    });
    await prisma.cardSpend.create({
      data: {
        stripeTransactionId: `fct_test_${newId()}`, stripeCardId: "card_fct_test", kind: "materials",
        amount: 45, merchantName: VENDOR, purchaseOrderId: po.id, occurredAt: new Date(),
      },
    });
    // A receipt with a file — the PROOF. proofCount only counts these, never a bare row.
    await prisma.receipt.create({
      data: {
        id: newId(), jobId, purchaseOrderId: po.id, category: "materials", vendor: VENDOR,
        amount: 45, status: "confirmed", source: "manual", imageMime: "image/jpeg", imageData: Buffer.from("fake-jpeg-bytes"),
      },
    });

    const res = await request(app)
      .get(`/health-record/visits/${jobId}/purchase-orders`)
      .set("Authorization", `Bearer ${techToken}`);
    expect(res.status).toBe(200);
    const order = res.body.data.orders.find((o: { id: string }) => o.id === po.id);
    expect(order.proofCount).toBe(1);
    expect(order.moneyTotal > 0 && order.proofCount === 0).toBe(false);
  });

  it("401s a request with no technician token, and 403s a visit not assigned to this technician", async () => {
    const noAuth = await request(app).get(`/health-record/visits/${jobId}/purchase-orders`);
    expect(noAuth.status).toBe(401);

    const strangerTech = await prisma.technician.create({ data: { name: "FCT Stranger", accessToken: `fct-test-stranger-${newId()}` } });
    const forbidden = await request(app)
      .get(`/health-record/visits/${jobId}/purchase-orders`)
      .set("Authorization", `Bearer ${strangerTech.accessToken}`);
    expect(forbidden.status).toBe(403);
    await prisma.technician.delete({ where: { id: strangerTech.id } });
  });
});

describe("FieldJobMaterials — GET /health-record/visits/:visitId/materials", () => {
  it("carries materialCost as a number and materialSource in the field's exact union", async () => {
    const res = await request(app)
      .get(`/health-record/visits/${jobId}/materials`)
      .set("Authorization", `Bearer ${techToken}`);

    expect(res.status).toBe(200);
    const data = res.body.data;

    // FieldJobMaterials (field/src/lib/crmSync.ts:577-588). MaterialsUsedStep.tsx:112 does
    // `data.materialCost.toFixed(2)` — a string here throws on the phone instead of just
    // misreading a number, so the type check matters as much as the value.
    expect(typeof data.materialCost).toBe("number");
    expect(["po", "none"]).toContain(data.materialSource);
    expect(data.truck).toMatchObject({ id: expect.any(String), name: expect.any(String) });
    expect(Array.isArray(data.suggested)).toBe(true);
    expect(Array.isArray(data.shortages)).toBe(true);
    expect(Array.isArray(data.lines)).toBe(true);
    expect(data.stock === null || typeof data.stock === "object").toBe(true);
    expect(data.estimate === null || typeof data.estimate === "object").toBe(true);
  });

  it("403s a visit not assigned to this technician", async () => {
    const strangerTech = await prisma.technician.create({ data: { name: "FCT Stranger 2", accessToken: `fct-test-stranger2-${newId()}` } });
    const res = await request(app)
      .get(`/health-record/visits/${jobId}/materials`)
      .set("Authorization", `Bearer ${strangerTech.accessToken}`);
    expect(res.status).toBe(403);
    await prisma.technician.delete({ where: { id: strangerTech.id } });
  });
});

describe("FieldLanding — GET /health-record/purchase-orders/:id/landing", () => {
  it("carries receiptTotal, receiptCount and suggestedLines with the right types", async () => {
    // A standalone truck-stock PO with no lines and no receipt — the emptiest
    // real shape landingDefaults returns (suggestedLines only populates when
    // po.lines.length === 0, so this also exercises that branch).
    const po = await createPurchaseOrder({ supplier: "NES", openedBy: "owner", actor: "test", truckId, lines: [] });

    const res = await request(app)
      .get(`/health-record/purchase-orders/${po.id}/landing`)
      .set("Authorization", `Bearer ${techToken}`);

    expect(res.status).toBe(200);
    const data = res.body.data;

    // FieldLanding (field/src/lib/crmSync.ts:948-961).
    expect(typeof data.receiptTotal).toBe("number");
    expect(typeof data.receiptCount).toBe("number");
    expect(Array.isArray(data.suggestedLines)).toBe(true);
    expect(typeof data.matchedTotal).toBe("number");
    expect(typeof data.taxTotal).toBe("number");
    expect(typeof data.linesTotal).toBe("number");
    expect(typeof data.balanced).toBe("boolean");
    expect(Array.isArray(data.receiptLines)).toBe(true);
    expect(Array.isArray(data.lines)).toBe(true);
    expect(data.blocker === null || typeof data.blocker === "string").toBe(true);
    expect(data.purchaseOrder).toMatchObject({ id: po.id, number: po.number, purpose: "truck_stock" });

    expect(data.receiptTotal).toBe(0);
    expect(data.receiptCount).toBe(0);
    expect(data.suggestedLines).toEqual([]);
  });

  it("landing needs a technician token but no visit assignment (it is not scoped to a visit)", async () => {
    const po = await createPurchaseOrder({ supplier: "NES", openedBy: "owner", actor: "test", truckId, lines: [] });
    const noAuth = await request(app).get(`/health-record/purchase-orders/${po.id}/landing`);
    expect(noAuth.status).toBe(401);
  });
});

describe("DiagnosticReportView — POST /health-record/diagnostic-reports", () => {
  it("carries the coverage statement, the per-tier money block and the outlet array the phone renders", async () => {
    const reportId = newId();
    const outletId = newId();
    const res = await request(app)
      .post("/health-record/diagnostic-reports")
      .set("Authorization", `Bearer ${techToken}`)
      .send({
        reportId,
        visitId: jobId,
        reportDate: new Date().toISOString(),
        complaint: "Half the kitchen is dead",
        circuitLabel: "Kitchen SABC",
        coverage: "whole_circuit",
        breakerInspected: true,
        quotedNormal: 1,
        status: "in_progress",
        outlets: [{
          id: outletId, sequence: 1, locationLabel: "Kitchen, east wall",
          deviceType: "receptacle", difficulty: "VERY_DIFFICULT", photoIds: [newId()],
        }],
      });

    expect(res.status).toBe(201);
    const view = res.body.data;

    // The sentence the report prints on its face. A string here, always — the
    // phone shows it verbatim and would render "undefined" without complaint.
    expect(typeof view.coverageStatement).toBe("string");
    expect(view.coverageStatement).toMatch(/WHOLE-CIRCUIT COVERAGE/);
    expect(["whole_circuit", "partial"]).toContain(view.coverage);
    expect(["in_progress", "complete", "void"]).toContain(view.status);

    // money: three tier maps of numbers. DiagnosticScreen indexes these by tier
    // name, so a missing key reads `undefined` and prints nothing.
    for (const block of ["quoted", "examined", "overage"] as const) {
      for (const tier of ["NORMAL", "DIFFICULT", "VERY_DIFFICULT"] as const) {
        expect(typeof view.money[block][tier]).toBe("number");
      }
    }
    expect(typeof view.money.overageTotal).toBe("number");
    expect(typeof view.money.examinedTotal).toBe("number");
    expect(typeof view.money.quotedTotal).toBe("number");
    expect(view.money.examined).toEqual({ NORMAL: 0, DIFFICULT: 0, VERY_DIFFICULT: 1 });

    expect(typeof view.defectCount).toBe("number");
    expect(typeof view.fixedCount).toBe("number");
    expect(typeof view.deliveryCount).toBe("number");
    expect(view.completedAt === null || typeof view.completedAt === "string").toBe(true);
    expect(view.changeOrderDraftId === null || typeof view.changeOrderDraftId === "string").toBe(true);

    expect(Array.isArray(view.outlets)).toBe(true);
    const outlet = view.outlets[0];
    expect(outlet).toMatchObject({ id: outletId, sequence: 1, deviceType: "receptacle", difficulty: "VERY_DIFFICULT" });
    expect(Array.isArray(outlet.photoIds)).toBe(true);
    expect(typeof outlet.terminationsTightened).toBe("boolean");
    expect(typeof outlet.corrosion).toBe("boolean");
    expect(typeof outlet.equipmentDefective).toBe("boolean");
    expect(outlet.vPhaseGround === null || typeof outlet.vPhaseGround === "number").toBe(true);
    expect(outlet.deviceLabel === null || typeof outlet.deviceLabel === "string").toBe(true);

    await prisma.diagnosticOutlet.deleteMany({ where: { reportId } });
    await prisma.diagnosticReport.delete({ where: { id: reportId } });
  });
});
