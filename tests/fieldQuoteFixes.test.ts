/**
 * Field fix batch (2026-09-21), items 1-3 — the tech quote routes
 * (health-record.ts POST/GET/PATCH /quotes, /quote-lines) pinned against the
 * CRM's own rules rather than a second copy of them.
 *
 *   1. Re-issuing an edited quote REVISES the live estimate (same number,
 *      revision + 1) instead of minting a second estimate number — mirrors
 *      app.ts's POST /price-book/drafts/:draftId/issue exactly.
 *   2. No labor hours or labor dollars reach the phone, on either a line or
 *      an option summary — hours stay in the office.
 *   3. A quantity of zero is refused everywhere; a negative quantity is
 *      refused on an ordinary quote and allowed on a change order — the
 *      route only stops blocking, assertQuantityAllowed (server-side) still
 *      decides.
 *
 * Builds its own price-book fixture rather than depending on an imported
 * catalog (Kyle's 2026-09-15 ruling — see tests/helpers/priceBookFixture.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "FFB";
const GOOD = "FFB001";

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;
const draftIds: string[] = [];

async function cleanEstimatesFor(ids: string[]) {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: ids } } });
  const estIds = ests.map((e) => e.id);
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(GOOD)]);

  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, phone: "615-555-0199" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "21 Field Fix Way", city: "Murfreesboro", state: "TN", postalCode: "37127" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" },
  });
  visitId = visit.id;

  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `ffb-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.visitAssignment.create({ data: { visitId, technicianId } });
});

afterAll(async () => {
  await cleanEstimatesFor(draftIds);
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([GOOD]);
});

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);

/**
 * A fresh draft on the shared visit, created directly rather than through
 * POST /visits/:visitId/quote — that route resumes any existing
 * `status: "draft"` row on the visit (by design, so a tech doesn't lose
 * work), and this file's other describes leave drafts behind in that
 * status. Direct creation keeps each test's draft its own.
 */
async function newDraft(title: string): Promise<string> {
  const d = await prisma.priceBookDraftEstimate.create({ data: { title, supplierId: "HD", visitId } });
  draftIds.push(d.id);
  return d.id;
}

describe("item 2 — no labor hours or labor dollars reach the field quote", () => {
  it("strips laborHours from the line and laborHours/laborDollars from the option summary", async () => {
    const open = await auth(request(app).post(`/health-record/visits/${visitId}/quote`)).send({});
    expect(open.status).toBe(201);
    const draftId = open.body.data.draftId as string;
    draftIds.push(draftId);

    const line = await auth(request(app).post(`/health-record/quotes/${draftId}/lines`)).send({
      itemId: GOOD, quantity: 2, quantitySource: "COUNT",
    });
    expect(line.status).toBe(201);

    const quote = await auth(request(app).get(`/health-record/quotes/${draftId}`));
    expect(quote.status).toBe(200);
    expect(quote.body.data.isChangeOrder).toBe(false);
    const l = quote.body.data.lines[0];
    expect(l).not.toHaveProperty("laborHours");
    expect(l.lineTotal).toBeGreaterThan(0);
    const optA = quote.body.data.options.find((o: { option: string }) => o.option === "A");
    expect(optA).not.toHaveProperty("laborHours");
    expect(optA).not.toHaveProperty("laborDollars");
    expect(optA).toHaveProperty("subtotal");
  });
});

describe("item 1 — re-issue revises instead of minting a second estimate", () => {
  it("keeps the same number and bumps the revision on a second issue", async () => {
    const draftId = await newDraft(`${MARK} re-issue`);

    const line = await auth(request(app).post(`/health-record/quotes/${draftId}/lines`)).send({
      itemId: GOOD, quantity: 1, quantitySource: "COUNT",
    });
    const lineId = line.body.data.lineId as string;

    const first = await auth(request(app).post(`/health-record/quotes/${draftId}/issue`)).send({});
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const firstEstimateId = first.body.data.estimateId as string;
    const firstNumber = first.body.data.number as string;

    // Editing a line reopens the (already-issued) draft — reopenForEditIfUnsigned.
    const edited = await auth(request(app).patch(`/health-record/quote-lines/${lineId}`)).send({ quantity: 2 });
    expect(edited.status).toBe(200);

    const second = await auth(request(app).post(`/health-record/quotes/${draftId}/issue`)).send({});
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.data.number).toBe(firstNumber);
    expect(second.body.data.estimateId).not.toBe(firstEstimateId);

    const rows = await prisma.issuedEstimate.findMany({
      where: { draftId },
      orderBy: { revision: "asc" },
      include: { supersededBy: { select: { id: true } } },
    });
    expect(rows.length).toBe(2);
    expect(rows[0].id).toBe(firstEstimateId);
    expect(rows[0].supersededBy?.id).toBe(rows[1].id);
    expect(rows[1].revision).toBe(rows[0].revision + 1);
    expect(rows[1].number).toBe(firstNumber);

    const live = await prisma.issuedEstimate.findFirst({ where: { draftId, supersededBy: null, status: { not: "void" } } });
    expect(live?.id).toBe(second.body.data.estimateId);
  });
});

describe("item 3 — a quantity of zero is refused everywhere; negative only on a change order", () => {
  it("refuses zero, refuses negative on an ordinary quote, allows negative on a change order", async () => {
    const draftId = await newDraft(`${MARK} quantity`);

    const zero = await auth(request(app).post(`/health-record/quotes/${draftId}/lines`)).send({
      itemId: GOOD, quantity: 0, quantitySource: "COUNT",
    });
    expect(zero.status).toBe(422);
    expect(zero.body.error.message).toMatch(/cannot be zero/i);

    const negative = await auth(request(app).post(`/health-record/quotes/${draftId}/lines`)).send({
      itemId: GOOD, quantity: -1, quantitySource: "COUNT",
    });
    expect(negative.status).toBe(400);
    expect(negative.body.error.message).toMatch(/change order/i);

    const added = await auth(request(app).post(`/health-record/quotes/${draftId}/lines`)).send({
      itemId: GOOD, quantity: 1, quantitySource: "COUNT",
    });
    expect(added.status).toBe(201);
    const lineId = added.body.data.lineId as string;

    const patchZero = await auth(request(app).patch(`/health-record/quote-lines/${lineId}`)).send({ quantity: 0 });
    expect(patchZero.status).toBe(422);
    const patchNegative = await auth(request(app).patch(`/health-record/quote-lines/${lineId}`)).send({ quantity: -1 });
    expect(patchNegative.status).toBe(400);
    expect(patchNegative.body.error.message).toMatch(/change order/i);

    // Now the change-order side: a draft whose changeOrderForId points at a
    // real issued estimate is where a negative quantity is legal.
    const issued = await auth(request(app).post(`/health-record/quotes/${draftId}/issue`)).send({});
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const rootEstimateId = issued.body.data.estimateId as string;

    const coDraft = await prisma.priceBookDraftEstimate.create({
      data: { title: `${MARK} change order`, supplierId: "HD", visitId, changeOrderForId: rootEstimateId },
    });
    draftIds.push(coDraft.id);

    const coQuote = await auth(request(app).get(`/health-record/quotes/${coDraft.id}`));
    expect(coQuote.status).toBe(200);
    expect(coQuote.body.data.isChangeOrder).toBe(true);

    const coNegative = await auth(request(app).post(`/health-record/quotes/${coDraft.id}/lines`)).send({
      itemId: GOOD, quantity: -1, quantitySource: "COUNT",
    });
    expect(coNegative.status, JSON.stringify(coNegative.body)).toBe(201);

    const coZero = await auth(request(app).post(`/health-record/quotes/${coDraft.id}/lines`)).send({
      itemId: GOOD, quantity: 0, quantitySource: "COUNT",
    });
    expect(coZero.status).toBe(422);
  });
});
