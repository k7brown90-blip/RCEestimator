/**
 * The two single-record reads the drawers added (2026-09-20, drawers plan Phase 1), and the
 * one thing they must never carry.
 *
 * PUNCHLIST B4: `IssuedEstimate.token` is the customer's unrevokable read-and-sign link. It
 * must never enter a drawer payload. Before this build the per-account estimate list spread the
 * whole Prisma row and shipped every estimate's token to the account page; the serializer both
 * routes now share strips it. Pinned here for the list AND the new record route, so a future
 * "tidy" back to `...e` fails loudly.
 *
 * The receipt record must never carry the image bytes — `hasImage` says whether to offer the
 * viewer; the bytes come from /receipts/:id/image on demand.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "DRWREC";
const ATOMIC = "DRW001";

let customerId: string;
let propertyId: string;
let visitId: string;
let draftId: string;
let estimateId: string;
let receiptId: string;

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ATOMIC)]);

  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "drwrec-customer@example.com", phone: "615-555-0177" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "9 Drawer Ct", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "estimate" },
  });
  visitId = visit.id;

  const draft = await createDraft(prisma, { title: `${MARK} quote`, supplierId: "HD", visitId });
  draftId = draft.id;
  await addLine(prisma, draft.id, { itemId: ATOMIC, quantity: 1, quantitySource: "COUNT" });
  const graduated = await graduateDraft(prisma, { draftId: draft.id, accountId: customerId, serviceAddressId: propertyId });
  if (!graduated.ok) throw new Error("graduation failed");
  estimateId = graduated.estimateId;

  const receipt = await prisma.receipt.create({
    data: {
      jobId: visitId, category: "materials", vendor: `${MARK} Depot`, amount: 42.5, source: "tech_pwa", status: "pending_review",
      imageData: Buffer.from("not-really-a-jpeg"), imageMime: "image/jpeg",
      lineItems: JSON.stringify([{ name: "wire nuts", qty: 2, unitCost: 21.25 }]),
    },
  });
  receiptId = receipt.id;
});

afterAll(async () => {
  await prisma.receipt.deleteMany({ where: { id: receiptId } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId } });
  await prisma.issuedEstimate.deleteMany({ where: { id: estimateId } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: draftId } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ATOMIC]);
});

describe("GET /issued-estimates/:id/record — the estimate drawer's read", () => {
  it("returns the account-row projection with money and no capability token", async () => {
    const res = await request(app).get(`/issued-estimates/${estimateId}/record`);
    expect(res.status).toBe(200);
    const est = res.body.estimate;
    expect(est.id).toBe(estimateId);
    expect(est.customerId).toBe(customerId);
    expect(est.serviceAddressId).toBe(propertyId);
    expect(est.draftId).toBe(draftId);
    expect(typeof est.billedTotal).toBe("number");
    expect(est.status).toBe("draft");
    // The whole point.
    expect(est).not.toHaveProperty("token");
    expect(res.body).not.toHaveProperty("customerLink");
    expect(JSON.stringify(res.body)).not.toMatch(/"token"/);
  });

  it("404s an unknown id", async () => {
    const res = await request(app).get("/issued-estimates/not-a-real-id/record");
    expect(res.status).toBe(404);
  });
});

describe("GET /accounts/:accountId/estimates — the list the drawer's projection is shared with", () => {
  it("no longer ships the token with every row", async () => {
    const res = await request(app).get(`/accounts/${customerId}/estimates`);
    expect(res.status).toBe(200);
    expect(res.body.estimates.length).toBeGreaterThan(0);
    for (const row of res.body.estimates) {
      expect(row).not.toHaveProperty("token");
      expect(typeof row.billedTotal).toBe("number");
    }
    expect(res.body.estimates.map((r: { id: string }) => r.id)).toContain(estimateId);
  });

  it("the operator-preview route still hands over the link (unchanged, deliberate)", async () => {
    const res = await request(app).get(`/issued-estimates/${estimateId}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.customerLink).toBe("string");
    // PUNCHLIST B5: the same preview route used to spread the raw row, so `token` — the
    // capability the customerLink is built from — rode along beside it. customerLink is the
    // only thing a caller should ever get.
    expect(res.body.estimate).not.toHaveProperty("token");
    expect(JSON.stringify(res.body)).not.toMatch(/"token":"/);
  });
});

describe("GET /health-record-admin/receipts/:id — the receipt drawer's read", () => {
  it("returns the receipt with its labels and never the image bytes", async () => {
    const res = await request(app).get(`/health-record-admin/receipts/${receiptId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(receiptId);
    expect(res.body.vendor).toBe(`${MARK} Depot`);
    expect(res.body.amount).toBe(42.5);
    expect(res.body.status).toBe("pending_review");
    expect(res.body.hasImage).toBe(true);
    expect(res.body.imageMime).toBe("image/jpeg");
    expect(res.body).not.toHaveProperty("imageData");
    expect(res.body.lineItems).toEqual([{ name: "wire nuts", qty: 2, unitCost: 21.25 }]);
    expect(res.body.jobId).toBe(visitId);
    expect(res.body.accountId).toBe(customerId);
    expect(res.body.jobLabel).toContain("9 Drawer Ct");
    // Materials, no P.O., not waived: flagged the same way the review queue flags it.
    expect(res.body.purchaseOrderId).toBeNull();
    expect(res.body.needsPo).toBe(true);
  });

  it("404s an unknown id", async () => {
    const res = await request(app).get("/health-record-admin/receipts/not-a-real-id");
    expect(res.status).toBe(404);
  });
});
