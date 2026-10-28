/**
 * Quote writes that are safe to replay — Phase 7 (offline estimating), unit U1, 2026-10-09.
 *
 * Kyle, 2026-09-22 (Q10): "They would have to be able to do estimates and even the diagnostics,
 * electrical assessment, without service." A phone with no signal keeps each edit in a queue and
 * replays it, one service call each, when signal returns. An answer can be lost on the way back,
 * so every write the phone replays must leave the SAME state when it lands twice, and must be
 * refused — with words, 409 — when the office changed the same thing underneath the tech.
 *
 * Pinned here, all through the tech routes (src/routes/health-record.ts) over the one service
 * (src/services/atomicEstimateService.ts):
 *
 *   - every new or changed route called twice leaves the same state;
 *   - a second draft for a visit → 409 carrying `existingDraftId`;
 *   - an add on a signed draft → the locked reason;
 *   - an `expected` mismatch → 409 naming the field and both values;
 *   - a replayed edit after success → 200;
 *   - a remove of a missing line → 404 `line_gone`; another tech's EXISTING line → 403;
 *   - an out-of-order option letter → 409;
 *   - a database failure on add → 5xx, never a 400 (a queue treats a 400 as a refusal and stops);
 *   - the payload names `supplierId` and a per-line `retired`, and nothing else new.
 *
 * Builds its own price-book fixture (tests/helpers/priceBookFixture.ts; Kyle's 2026-09-15 rule).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
vi.mock("stripe", () => ({ default: class MockStripe { constructor() { throw new Error("Stripe must not be constructed in tests"); } } }));
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
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: vi.fn().mockResolvedValue(true), sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "FQOFF";
const ITEM = "FQOFF-EA";
const RETIRED = "FQOFF-RETIRED";

let customerId: string;
let propertyId: string;
let technicianId: string;
let techToken: string;
let strangerId: string;
let strangerToken: string;
/** The stranger's own visit — a line on it exists but is not ours. */
let strangerVisitId: string;
const visitIds: string[] = [];

async function cleanEstimatesFor(ids: string[]) {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: ids } } });
  const estIds = ests.map((e) => e.id);
  await prisma.payment.deleteMany({ where: { estimateId: { in: estIds } } });
  const jobIds = [...new Set(ests.map((e) => e.jobVisitId).filter((v): v is string => Boolean(v)))];
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: jobIds } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateOption.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null, changeOrderForId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.visit.deleteMany({ where: { id: { in: jobIds } } });
}

/** A fresh visit assigned to our technician — each replay scenario needs a visit with no quote yet. */
async function newVisit(): Promise<string> {
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" },
  });
  visitIds.push(visit.id);
  await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId } });
  return visit.id;
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ITEM, { unit: "ea" }), quotableAtomic(RETIRED, { unit: "ea" })]);
  await prisma.priceBookAtomic.update({ where: { itemId: RETIRED }, data: { retiredAt: new Date() } });

  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "fqoff@example.com", phone: "615-555-0166" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "7 No Signal Lane", city: "Murfreesboro", state: "TN", postalCode: "37127" },
  });
  propertyId = property.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `fqoff-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  const stranger = await prisma.technician.create({ data: { name: `${MARK} Stranger`, accessToken: `fqoff-stranger-${customer.id}` } });
  strangerId = stranger.id;
  strangerToken = stranger.accessToken;
  const strangerVisit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} stranger job`, status: "scheduled" },
  });
  strangerVisitId = strangerVisit.id;
  visitIds.push(strangerVisit.id);
  await prisma.visitAssignment.create({ data: { visitId: strangerVisit.id, technicianId: strangerId } });
});

afterAll(async () => {
  const drafts = await prisma.priceBookDraftEstimate.findMany({ where: { visitId: { in: visitIds } }, select: { id: true } });
  const draftIds = drafts.map((d) => d.id);
  await cleanEstimatesFor(draftIds);
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftOption.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: visitIds } } });
  await prisma.technician.deleteMany({ where: { id: { in: [technicianId, strangerId] } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ITEM, RETIRED]);
});

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);
const asStranger = (r: request.Test) => r.set("Authorization", `Bearer ${strangerToken}`);

/** A draft on a fresh visit, the way the office (or the online phone) makes one. */
async function draftOnFreshVisit(title: string) {
  const visitId = await newVisit();
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  return { visitId, draftId: d.id };
}

async function draftWithLine(title: string, qty = 2) {
  const d = await draftOnFreshVisit(title);
  const line = await addLine(prisma, d.draftId, { itemId: ITEM, quantity: qty });
  return { ...d, lineId: line.id };
}

async function signedDraft(title: string) {
  const d = await draftWithLine(title);
  const issued = await request(app)
    .post(`/price-book/drafts/${d.draftId}/issue`)
    .send({ accountId: customerId, serviceAddressId: propertyId });
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  const res = await request(app)
    .post(`/issued-estimates/${issued.body.estimateId}/sign-in-person`)
    .send({ signerName: "Mrs No Signal", signatureImage: TEST_SIGNATURE, selectedOptions: ["A"] });
  expect(res.body, JSON.stringify(res.body)).toMatchObject({ signed: true });
  return d;
}

/** Issued to the customer, NOT signed: "finalized", and a real edit would reopen it. */
async function issuedDraft(title: string) {
  const d = await draftWithLine(title);
  const issued = await request(app)
    .post(`/price-book/drafts/${d.draftId}/issue`)
    .send({ accountId: customerId, serviceAddressId: propertyId });
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  const row = await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: d.draftId } });
  expect(row.status).toBe("finalized");
  expect(row.finalizedAt).not.toBeNull();
  return d;
}

const draftRow = (id: string) => prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id } });
const lineRow = (id: string) => prisma.priceBookDraftLine.findUnique({ where: { id } });
const draftsOnVisit = (visitId: string) => prisma.priceBookDraftEstimate.count({ where: { visitId } });
const quotePayload = async (id: string) => (await auth(request(app).get(`/health-record/quotes/${id}`))).body.data;

const putLine = (draftId: string, lineId: string, body: Record<string, unknown>) =>
  auth(request(app).put(`/health-record/quotes/${draftId}/lines/${lineId}`)).send(body);

// ─── Start a quote with no signal ─────────────────────────────────────────────

describe("PUT /health-record/visits/:visitId/quote/:draftId — a quote started with no signal", () => {
  it("called twice with the same phone-minted id: 201 then 200, ONE draft, titled and priced as the POST always did", async () => {
    const visitId = await newVisit();
    const draftId = randomUUID();

    const first = await auth(request(app).put(`/health-record/visits/${visitId}/quote/${draftId}`)).send({});
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toEqual({ success: true, data: { draftId, resumed: false } });

    const again = await auth(request(app).put(`/health-record/visits/${visitId}/quote/${draftId}`)).send({});
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toEqual({ success: true, data: { draftId, resumed: true } });

    expect(await draftsOnVisit(visitId)).toBe(1);
    const row = await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: draftId } });
    expect(row.visitId).toBe(visitId);
    expect(row.title).toBe(`${MARK} Customer — 7 No Signal Lane`);
    expect(row.supplierId).toBe("HD");
    expect(row.status).toBe("draft");
  });

  it("the office started this visit's quote first: 409 carrying existingDraftId, and no second draft", async () => {
    const office = await draftOnFreshVisit("office-first");
    const mine = randomUUID();
    const res = await auth(request(app).put(`/health-record/visits/${office.visitId}/quote/${mine}`)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: "conflict",
      message: "The office already started a quote for this visit.",
      existingDraftId: office.draftId,
    });
    expect(await draftsOnVisit(office.visitId)).toBe(1);
    expect(await prisma.priceBookDraftEstimate.findUnique({ where: { id: mine } })).toBeNull();
  });

  it("an id that already belongs to another visit's quote is never adopted (409); a non-UUID id is refused (422)", async () => {
    // The other visit's draft carries a UUID id so the route's UUID check is not what refuses it.
    const elsewhereVisit = await newVisit();
    const uuid = randomUUID();
    await createDraft(prisma, { id: uuid, title: `${MARK} elsewhere`, supplierId: "HD", visitId: elsewhereVisit });
    const visitId = await newVisit();

    const stolen = await auth(request(app).put(`/health-record/visits/${visitId}/quote/${uuid}`)).send({});
    expect(stolen.status, JSON.stringify(stolen.body)).toBe(409);
    expect(stolen.body.error.message).toMatch(/another visit/);
    expect((await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: uuid } })).visitId).toBe(elsewhereVisit);
    expect(await draftsOnVisit(visitId)).toBe(0);

    const bad = await auth(request(app).put(`/health-record/visits/${visitId}/quote/not-a-uuid`)).send({});
    expect(bad.status).toBe(422);
    expect(await draftsOnVisit(visitId)).toBe(0);
  });

  it("a technician the visit is not assigned to gets 403 and writes nothing", async () => {
    const visitId = await newVisit();
    const res = await asStranger(request(app).put(`/health-record/visits/${visitId}/quote/${randomUUID()}`)).send({});
    expect(res.status).toBe(403);
    expect(await draftsOnVisit(visitId)).toBe(0);
  });

  it("POST /visits/:visitId/quote (the online phone) is unchanged: create 201, then resume 200 with the same id", async () => {
    const visitId = await newVisit();
    const first = await auth(request(app).post(`/health-record/visits/${visitId}/quote`)).send({});
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data).toEqual({ draftId: expect.any(String), resumed: false });
    const again = await auth(request(app).post(`/health-record/visits/${visitId}/quote`)).send({});
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ draftId: first.body.data.draftId, resumed: true });
    expect(await draftsOnVisit(visitId)).toBe(1);
    const row = await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: first.body.data.draftId } });
    expect(row.title).toBe(`${MARK} Customer — 7 No Signal Lane`);
  });
});

describe("GET /health-record/visits/:visitId/quote — read-only", () => {
  it("404 while the visit has no quote, twice, and never starts one; 200 with the id once it has", async () => {
    const visitId = await newVisit();
    for (let i = 0; i < 2; i++) {
      const res = await auth(request(app).get(`/health-record/visits/${visitId}/quote`));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
    expect(await draftsOnVisit(visitId)).toBe(0);

    const draftId = randomUUID();
    await auth(request(app).put(`/health-record/visits/${visitId}/quote/${draftId}`)).send({});
    const res = await auth(request(app).get(`/health-record/visits/${visitId}/quote`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { draftId } });
  });

  it("a technician the visit is not assigned to gets 403", async () => {
    const visitId = await newVisit();
    const res = await asStranger(request(app).get(`/health-record/visits/${visitId}/quote`));
    expect(res.status).toBe(403);
  });
});

// ─── Add a line with no signal ────────────────────────────────────────────────

describe("PUT /health-record/quotes/:draftId/lines/:lineId — a line added with no signal", () => {
  it("called twice: 200 both times, ONE row, and the replay writes nothing (the first delivery's quantity stands)", async () => {
    const d = await draftOnFreshVisit("put-line-twice");
    const lineId = randomUUID();
    const first = await putLine(d.draftId, lineId, { itemId: ITEM, quantity: 2, option: "B", note: "by the door" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toEqual({ success: true, data: { lineId } });

    // The same id again, even with a different body: the earlier delivery is the answer.
    const again = await putLine(d.draftId, lineId, { itemId: ITEM, quantity: 9 });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toEqual({ success: true, data: { lineId } });

    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.draftId } })).toBe(1);
    const row = await lineRow(lineId);
    expect(row).toMatchObject({ draftId: d.draftId, itemId: ITEM, quantity: 2, option: "B", note: "by the door", state: "CONFIRMED", confirmedBy: `tech:${technicianId}` });
  });

  it("the same id on ANOTHER quote is refused (409) and never adopted; a non-UUID id is refused (422)", async () => {
    const a = await draftOnFreshVisit("put-line-a");
    const b = await draftOnFreshVisit("put-line-b");
    const lineId = randomUUID();
    expect((await putLine(a.draftId, lineId, { itemId: ITEM, quantity: 1 })).status).toBe(200);

    const stolen = await putLine(b.draftId, lineId, { itemId: ITEM, quantity: 1 });
    expect(stolen.status, JSON.stringify(stolen.body)).toBe(409);
    expect(stolen.body.error.code).toBe("conflict");
    expect((await lineRow(lineId))?.draftId).toBe(a.draftId);
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: b.draftId } })).toBe(0);

    const bad = await putLine(b.draftId, "line-1", { itemId: ITEM, quantity: 1 });
    expect(bad.status).toBe(422);
  });

  it("an add on a SIGNED quote answers the locked reason — raise a change order — and writes nothing", async () => {
    const d = await signedDraft("put-line-signed");
    const res = await putLine(d.draftId, randomUUID(), { itemId: ITEM, quantity: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.message).toMatch(/SIGNED/);
    expect(res.body.error.message).toMatch(/change order/i);
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.draftId } })).toBe(1);
    // The signed draft is not flipped back to "draft" by a refused press.
    expect((await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: d.draftId } })).status).toBe("finalized");
  });

  it("a stranger's quote → 403 and nothing written", async () => {
    const d = await draftOnFreshVisit("put-line-stranger");
    const res = await asStranger(request(app).put(`/health-record/quotes/${d.draftId}/lines/${randomUUID()}`)).send({ itemId: ITEM, quantity: 1 });
    expect(res.status).toBe(403);
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.draftId } })).toBe(0);
  });

  it("refusals are refusals (4xx with words) on both the PUT and the POST: zero, a negative, an unknown item", async () => {
    const d = await draftOnFreshVisit("put-line-refusals");
    const post = (body: Record<string, unknown>) => auth(request(app).post(`/health-record/quotes/${d.draftId}/lines`)).send(body);
    for (const send of [post, (b: Record<string, unknown>) => putLine(d.draftId, randomUUID(), b)]) {
      const zero = await send({ itemId: ITEM, quantity: 0 });
      expect(zero.status).toBe(422);
      const negative = await send({ itemId: ITEM, quantity: -1 });
      expect(negative.status, JSON.stringify(negative.body)).toBe(400);
      expect(negative.body.error).toMatchObject({ code: "bad_request" });
      expect(negative.body.error.message).toMatch(/change order/i);
      const unknown = await send({ itemId: "FQOFF-NOT-A-THING", quantity: 1 });
      expect(unknown.status, JSON.stringify(unknown.body)).toBe(400);
      expect(unknown.body.error.message).toMatch(/not in the atomic catalog/);
    }
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.draftId } })).toBe(0);
  });

  it("a DATABASE failure on add answers 5xx, not 400 — a queue must retry it, not drop it as refused", async () => {
    const d = await draftOnFreshVisit("put-line-db-down");
    const spy = vi.spyOn(prisma.priceBookDraftLine, "create").mockRejectedValueOnce(new Error("connection reset by peer"));
    try {
      const res = await putLine(d.draftId, randomUUID(), { itemId: ITEM, quantity: 1 });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toMatch(/bad_request/);
    } finally {
      spy.mockRestore();
    }
    const spyPost = vi.spyOn(prisma.priceBookDraftLine, "create").mockRejectedValueOnce(new Error("connection reset by peer"));
    try {
      const res = await auth(request(app).post(`/health-record/quotes/${d.draftId}/lines`)).send({ itemId: ITEM, quantity: 1 });
      expect(res.status).toBe(500);
    } finally {
      spyPost.mockRestore();
    }
  });

  it("a RETIRED item is still added (retire means do not offer, not do not price) and the payload says `retired`", async () => {
    const d = await draftOnFreshVisit("put-line-retired");
    const retiredLine = randomUUID();
    const liveLine = randomUUID();
    expect((await putLine(d.draftId, retiredLine, { itemId: RETIRED, quantity: 1 })).status).toBe(200);
    expect((await putLine(d.draftId, liveLine, { itemId: ITEM, quantity: 1 })).status).toBe(200);

    const q = await quotePayload(d.draftId);
    expect(q.supplierId).toBe("HD");
    const byId = new Map((q.lines as Array<{ id: string; retired: boolean; lineTotal: number | null }>).map((l) => [l.id, l]));
    expect(byId.get(retiredLine)).toMatchObject({ retired: true });
    expect(byId.get(liveLine)).toMatchObject({ retired: false });
    // Still priced: the retired item carries its flat price like any other.
    expect(byId.get(retiredLine)!.lineTotal).toBeGreaterThan(0);
    // The flag is a boolean and the date never leaves the office.
    expect(byId.get(retiredLine)).not.toHaveProperty("retiredAt");
    expect(byId.get(retiredLine)).not.toHaveProperty("atomic");
  });
});

// ─── Edit a line: expected ────────────────────────────────────────────────────

describe("PATCH /health-record/quote-lines/:lineId with `expected`", () => {
  it("accepted when the value now equals what the tech saw; the replay (value now equals the new one) is 200 too", async () => {
    const d = await draftWithLine("edit-expected-ok", 2);
    const first = await auth(request(app).patch(`/health-record/quote-lines/${d.lineId}`)).send({ quantity: 5, expected: { quantity: 2 } });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await lineRow(d.lineId))?.quantity).toBe(5);

    const replay = await auth(request(app).patch(`/health-record/quote-lines/${d.lineId}`)).send({ quantity: 5, expected: { quantity: 2 } });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect((await lineRow(d.lineId))?.quantity).toBe(5);
  });

  it("refused 409 naming the field and both values when the office changed it, and nothing is written", async () => {
    const d = await draftWithLine("edit-expected-conflict", 5);
    const res = await auth(request(app).patch(`/health-record/quote-lines/${d.lineId}`)).send({ quantity: 8, expected: { quantity: 3 } });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toEqual({
      code: "conflict",
      message: "Changed at the office since you last saw it: quantity was 3, now 5",
    });
    expect((await lineRow(d.lineId))?.quantity).toBe(5);
  });

  it("a value that went away and came back (2 → 7 → 2) is accepted; a blank note compares equal to a missing one", async () => {
    const d = await draftWithLine("edit-expected-roundtrip", 2);
    // The office (CRM door) changes it and changes it back.
    expect((await request(app).patch(`/price-book/lines/${d.lineId}`).send({ quantity: 7 })).status).toBe(200);
    expect((await request(app).patch(`/price-book/lines/${d.lineId}`).send({ quantity: 2 })).status).toBe(200);
    const res = await auth(request(app).patch(`/health-record/quote-lines/${d.lineId}`)).send({ quantity: 3, expected: { quantity: 2, note: "" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await lineRow(d.lineId))?.quantity).toBe(3);

    // The office set the same new value the tech is sending: accepted.
    expect((await request(app).patch(`/price-book/lines/${d.lineId}`).send({ note: "garage wall" })).status).toBe(200);
    const same = await auth(request(app).patch(`/health-record/quote-lines/${d.lineId}`)).send({ note: "garage wall", expected: { note: null } });
    expect(same.status, JSON.stringify(same.body)).toBe(200);

    // A different note than the one they saw: refused with both values.
    const other = await auth(request(app).patch(`/health-record/quote-lines/${d.lineId}`)).send({ note: "kitchen", expected: { note: null } });
    expect(other.status).toBe(409);
    expect(other.body.error.message).toBe('Changed at the office since you last saw it: note was blank, now "garage wall"');
  });

  it("without `expected` the edit is last-write-wins, exactly as before", async () => {
    const d = await draftWithLine("edit-no-expected", 2);
    const res = await auth(request(app).patch(`/health-record/quote-lines/${d.lineId}`)).send({ quantity: 4 });
    expect(res.status).toBe(200);
    expect((await lineRow(d.lineId))?.quantity).toBe(4);
  });

  it("a line the office removed → 404 line_gone (refused with why), never a 500", async () => {
    const d = await draftWithLine("edit-removed");
    await prisma.priceBookDraftLine.delete({ where: { id: d.lineId } });
    const res = await auth(request(app).patch(`/health-record/quote-lines/${d.lineId}`)).send({ quantity: 4, expected: { quantity: 2 } });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("line_gone");
    expect(res.body.error.message).toMatch(/removed/);
  });
});

// ─── The settings: expected ───────────────────────────────────────────────────

describe("the settings writers with `expected` — discount, option mode, option names, title and scope", () => {
  it("discount: accepted and replay-safe when the programme now is what the tech saw; 409 with both values otherwise", async () => {
    const d = await draftWithLine("discount-expected");
    const send = (body: Record<string, unknown>) => auth(request(app).put(`/health-record/quotes/${d.draftId}/discount`)).send(body);
    for (let i = 0; i < 2; i++) {
      const res = await send({ type: "military", expected: { type: null, percent: null } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toEqual({ discountType: "military", discountPercent: null });
    }
    const conflict = await send({ type: "custom", percent: 10, expected: { type: "senior" } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.message).toBe('Changed at the office since you last saw it: type was "senior", now "military"');
    expect(await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: d.draftId } })).toMatchObject({ discountType: "military", discountPercent: null });
  });

  it("option mode: the same rule", async () => {
    const d = await draftWithLine("mode-expected");
    const send = (body: Record<string, unknown>) => auth(request(app).put(`/health-record/quotes/${d.draftId}/options-mode`)).send(body);
    for (let i = 0; i < 2; i++) {
      const res = await send({ exclusive: true, expected: { exclusive: false } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toEqual({ exclusiveOptions: true });
    }
    const conflict = await send({ exclusive: false, expected: { exclusive: false } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.message).toBe("Changed at the office since you last saw it: exclusive was false, now true");

    // The CRM's door checks `expected` too (Phase 7 U5, 2026-10-10 — it used to drop it), and still writes without it.
    const crmConflict = await request(app).put(`/price-book/drafts/${d.draftId}/options-mode`).send({ exclusive: false, expected: { exclusive: false } });
    expect(crmConflict.status).toBe(409);
    expect(crmConflict.body.error).toBe("Changed at the office since you last saw it: exclusive was false, now true");
    const crmPlain = await request(app).put(`/price-book/drafts/${d.draftId}/options-mode`).send({ exclusive: false });
    expect(crmPlain.status, JSON.stringify(crmPlain.body)).toBe(200);
    expect(crmPlain.body).toEqual({ exclusiveOptions: false });
  });

  it("option names: a name that does not exist yet reads as blank; a renamed option refuses with both names", async () => {
    const d = await draftWithLine("meta-expected");
    const send = (body: Record<string, unknown>) => auth(request(app).put(`/health-record/quotes/${d.draftId}/options/B`)).send(body);
    for (let i = 0; i < 2; i++) {
      const res = await send({ label: "Pathway lights", expected: { label: null, note: null } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toEqual({ option: "B", label: "Pathway lights", note: null });
    }
    const conflict = await send({ label: "Garden lights", expected: { label: "Porch lights" } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.message).toBe('Changed at the office since you last saw it: label was "Porch lights", now "Pathway lights"');
    expect(await prisma.priceBookDraftOption.findUnique({ where: { draftId_option: { draftId: d.draftId, option: "B" } } })).toMatchObject({ label: "Pathway lights" });
  });

  it("title and scope: the same rule, and the CRM's door still writes without `expected`", async () => {
    const d = await draftWithLine("details-expected");
    const send = (body: Record<string, unknown>) => auth(request(app).put(`/health-record/quotes/${d.draftId}/details`)).send(body);
    for (let i = 0; i < 2; i++) {
      const res = await send({ title: "Panel upgrade", expected: { title: `${MARK} details-expected` } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({ title: "Panel upgrade" });
    }
    const conflict = await send({ jobDescription: "Replace the 100A panel", expected: { title: "Service call" } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.message).toBe('Changed at the office since you last saw it: title was "Service call", now "Panel upgrade"');

    const crm = await request(app).put(`/price-book/drafts/${d.draftId}/details`).send({ title: "Panel upgrade (office)" });
    expect(crm.status, JSON.stringify(crm.body)).toBe(200);
    expect(crm.body).toMatchObject({ title: "Panel upgrade (office)" });
  });
});

// ─── A write that would change nothing is not a write ─────────────────────────
//
// The lost-answer replay: the phone's edit landed, the 2xx never came back, the office ISSUED (or
// got SIGNED) the estimate with that edit on it, then the phone sends the edit again. A no-op must
// neither flip the issued draft back to "draft" (phantom "unsaved changes" at the office) nor be
// refused on the signed one (the edit is already on the signed record, and a refusal stops the
// phone's whole chain). Phase 7 review, 2026-10-09.

describe("a replay of an edit already applied writes nothing — issued stays issued, signed answers 200", () => {
  it("a line edit replayed after the office issued the estimate: 200, still finalized, finalizedAt kept", async () => {
    const d = await draftWithLine("noop-issued-line", 2);
    const first = await auth(request(app).patch(`/health-record/quote-lines/${d.lineId}`)).send({ quantity: 5, expected: { quantity: 2 } });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const issued = await request(app).post(`/price-book/drafts/${d.draftId}/issue`).send({ accountId: customerId, serviceAddressId: propertyId });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const before = await draftRow(d.draftId);
    expect(before.status).toBe("finalized");

    const replay = await auth(request(app).patch(`/health-record/quote-lines/${d.lineId}`)).send({ quantity: 5, expected: { quantity: 2 } });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    const after = await draftRow(d.draftId);
    expect(after.status).toBe("finalized");
    expect(after.finalizedAt?.toISOString()).toBe(before.finalizedAt?.toISOString());
    expect((await lineRow(d.lineId))?.quantity).toBe(5);

    // A REAL edit still reopens it, exactly as before.
    const real = await auth(request(app).patch(`/health-record/quote-lines/${d.lineId}`)).send({ quantity: 6, expected: { quantity: 5 } });
    expect(real.status).toBe(200);
    expect((await draftRow(d.draftId)).status).toBe("draft");
  });

  it("the settings and the line order, replayed on an issued estimate: 200 each, still finalized", async () => {
    const d = await draftWithLine("noop-issued-settings", 2);
    const put = (path: string, body: Record<string, unknown>) => auth(request(app).put(`/health-record/quotes/${d.draftId}${path}`)).send(body);
    expect((await put("/discount", { type: "military" })).status).toBe(200);
    expect((await put("/options-mode", { exclusive: true })).status).toBe(200);
    expect((await put("/options/B", { label: "Pathway lights" })).status).toBe(200);
    expect((await put("/details", { title: "Panel upgrade", jobDescription: "Replace the 100A panel" })).status).toBe(200);
    const issued = await request(app).post(`/price-book/drafts/${d.draftId}/issue`).send({ accountId: customerId, serviceAddressId: propertyId });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const before = await draftRow(d.draftId);
    expect(before.status).toBe("finalized");

    const replays: Array<[string, Record<string, unknown>]> = [
      ["/discount", { type: "military", expected: { type: null, percent: null } }],
      ["/options-mode", { exclusive: true, expected: { exclusive: false } }],
      ["/options/B", { label: "Pathway lights", expected: { label: null, note: null } }],
      ["/details", { title: "Panel upgrade", expected: { title: `${MARK} noop-issued-settings` } }],
      ["/line-order", { order: [{ lineId: d.lineId, option: "A", was: "A" }] }],
    ];
    for (const [path, body] of replays) {
      const res = await put(path, body);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    const after = await draftRow(d.draftId);
    expect(after.status).toBe("finalized");
    expect(after.finalizedAt?.toISOString()).toBe(before.finalizedAt?.toISOString());
    expect(after).toMatchObject({ discountType: "military", exclusiveOptions: true, title: "Panel upgrade" });
  });

  it("on a SIGNED estimate a no-op line edit and a no-op order answer 200; a real line edit is still the locked refusal", async () => {
    const d = await signedDraft("noop-signed");
    const same = await auth(request(app).patch(`/health-record/quote-lines/${d.lineId}`)).send({ quantity: 2, expected: { quantity: 2 } });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    const order = await auth(request(app).put(`/health-record/quotes/${d.draftId}/line-order`)).send({ order: [{ lineId: d.lineId, option: "A" }] });
    expect(order.status, JSON.stringify(order.body)).toBe(200);
    expect(order.body.data).toEqual({ saved: 1, changed: 0 });
    expect((await draftRow(d.draftId)).status).toBe("finalized");

    const real = await auth(request(app).patch(`/health-record/quote-lines/${d.lineId}`)).send({ quantity: 3, expected: { quantity: 2 } });
    expect(real.status).toBe(400);
    expect(real.body.error.message).toMatch(/SIGNED/);
    expect((await lineRow(d.lineId))?.quantity).toBe(2);
  });

  it("the CRM door: a line that is gone is refused with a sentence that does not blame the office", async () => {
    const d = await draftWithLine("gone-crm-door");
    await prisma.priceBookDraftLine.delete({ where: { id: d.lineId } });
    const res = await request(app).patch(`/price-book/lines/${d.lineId}`).send({ quantity: 4 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Line ${d.lineId} is no longer on this quote.`);
    expect(res.body.error).not.toMatch(/office/);
  });
});

// ─── Add an option with its letter ────────────────────────────────────────────

describe("POST /health-record/quotes/:draftId/options with `{ option }`", () => {
  it("the next letter twice: 201 created, then 200 already there — one row; an out-of-order letter → 409; no letter still works", async () => {
    const d = await draftWithLine("option-letter");
    const send = (body: Record<string, unknown>) => auth(request(app).post(`/health-record/quotes/${d.draftId}/options`)).send(body);

    const first = await send({ option: "D" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data).toMatchObject({ option: "D", created: true });

    const again = await send({ option: "D" });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data).toMatchObject({ option: "D", created: false });
    expect(await prisma.priceBookDraftOption.count({ where: { draftId: d.draftId, option: "D" } })).toBe(1);

    const skipped = await send({ option: "F" });
    expect(skipped.status, JSON.stringify(skipped.body)).toBe(409);
    expect(skipped.body.error.message).toMatch(/Option F is not the next one to add — the next is E/);
    expect(await prisma.priceBookDraftOption.count({ where: { draftId: d.draftId } })).toBe(1);

    // A, B and C are always on the draft: asking for one is already-there, nothing written.
    const base = await send({ option: "a" });
    expect(base.status).toBe(200);
    expect(base.body.data).toMatchObject({ option: "A", created: false });

    const noLetter = await send({});
    expect(noLetter.status).toBe(201);
    expect(noLetter.body.data).toMatchObject({ option: "E", created: true });

    const unknown = await send({ option: "Z" });
    expect(unknown.status).toBe(400);
  });
});

// ─── Remove a line ────────────────────────────────────────────────────────────

describe("DELETE /health-record/quote-lines/:lineId — line_gone only when the row does not exist", () => {
  it("called twice: 200, then 404 line_gone (the replay treats it as done)", async () => {
    const d = await draftWithLine("delete-twice");
    const first = await auth(request(app).delete(`/health-record/quote-lines/${d.lineId}`));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await auth(request(app).delete(`/health-record/quote-lines/${d.lineId}`));
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("line_gone");
    expect(await lineRow(d.lineId)).toBeNull();

    const never = await auth(request(app).delete(`/health-record/quote-lines/${randomUUID()}`));
    expect(never.status).toBe(404);
    expect(never.body.error.code).toBe("line_gone");
  });

  it("another technician's EXISTING line stays 403 — never line_gone — and is still there", async () => {
    const theirs = await createDraft(prisma, { title: `${MARK} stranger quote`, supplierId: "HD", visitId: strangerVisitId });
    const line = await addLine(prisma, theirs.id, { itemId: ITEM, quantity: 1 });
    const res = await auth(request(app).delete(`/health-record/quote-lines/${line.id}`));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
    expect(await lineRow(line.id)).not.toBeNull();
  });
});

// ─── What the payload names ───────────────────────────────────────────────────

describe("GET /health-record/quotes/:draftId — the two new fields are named, and nothing else leaks", () => {
  it("a line carries exactly its named fields, `retired` included; the draft carries `supplierId`", async () => {
    const d = await draftWithLine("payload-keys");
    const q = await quotePayload(d.draftId);
    expect(q.supplierId).toBe("HD");
    // `customName` added deliberately 2026-10-27 (Kyle: the line's name for the job).
    expect(Object.keys(q.lines[0]).sort()).toEqual([
      "customName", "description", "difficulty", "gaps", "id", "itemId", "lineTotal", "location", "note", "option", "quantity", "quantitySource", "retired", "state",
    ]);
    expect(q.lines[0].retired).toBe(false);
  });
});
