/**
 * The draft's LIFECYCLE from both doors — title & scope, delete, copy to new, and revising an
 * issued estimate from the field (2026-10-08, one-estimating-system plan, Phase 2 unit B).
 *
 * Each rule is ONE service function: setDraftDetails / deleteDraft / duplicateDraft /
 * workingDraftForVisit (atomicEstimateService.ts) and getDraftLifecycle / issueDraft
 * (issuedEstimateService.ts). The CRM routes (src/app.ts) and the tech routes
 * (src/routes/health-record.ts, behind quoteDraftForTech) are thin wrappers. Pinned from BOTH doors:
 *
 *   - the draft's title and scope ARE the estimate's: a first issue reads them, and a revision
 *     re-reads them (the audit found no route could edit either after creation);
 *   - delete is refused with the SAME sentence on both doors once anything was issued, and that
 *     sentence rides in both payloads as `lifecycle.deleteReason` so the buttons grey before the press;
 *   - "Build the quote" RESUMES an issued draft (audit §1.3: it used to start a new draft and a new
 *     number), skips a change order, a diagnostic's resolutions draft and a voided one, and the
 *     field's Issue then REVISES (same number, revision +1) instead of minting a second estimate;
 *   - the job brief carries an issued-but-unsigned estimate so the "not signed yet" panel can render,
 *     while `choicePending` stays false and "Complete work now" stays refused (closing-out plan Unit 4);
 *   - the customer link is built with estimateLink and the raw token never reaches the phone.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
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
import { addLine, createDraft, draftDeleteReason, setOptionMeta, workingDraftForVisit } from "../src/services/atomicEstimateService";
import { getDraftLifecycle, lostReopenReason } from "../src/services/issuedEstimateService";
import { FIELD_SIGNED_REVISE_REASON } from "../shared/draftLifecycle";
import { estimateLink } from "../src/services/issuedEstimateSend";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "FIELDQLIFE";
const ITEM = "FQL-EA"; // flat $70 each (priceBookFixture)

let customerId: string;
let propertyId: string;
let technicianId: string;
let techToken: string;
let strangerId: string;
let strangerToken: string;
const visitIds: string[] = [];
const draftIds: string[] = [];
const reportIds: string[] = [];

async function cleanEstimatesFor(ids: string[]) {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: ids } } });
  const estIds = ests.map((e) => e.id);
  await prisma.payment.deleteMany({ where: { estimateId: { in: estIds } } });
  const jobIds = [...new Set(ests.map((e) => e.jobVisitId).filter((v): v is string => Boolean(v)))];
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: jobIds } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateOption.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.priceBookDraftEstimate.updateMany({ where: { changeOrderForId: { in: estIds } }, data: { changeOrderForId: null } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null, changeOrderForId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.visit.deleteMany({ where: { id: { in: jobIds } } });
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ITEM, { unit: "ea" })]);
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "fieldqlife@example.com", phone: "615-555-0178" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "2 Lifecycle Way", city: "Murfreesboro", state: "TN", postalCode: "37127" },
  });
  propertyId = property.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `fieldqlife-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  const stranger = await prisma.technician.create({ data: { name: `${MARK} Stranger`, accessToken: `fieldqlife-stranger-${customer.id}` } });
  strangerId = stranger.id;
  strangerToken = stranger.accessToken;
});

afterAll(async () => {
  await cleanEstimatesFor(draftIds);
  await prisma.diagnosticReport.deleteMany({ where: { id: { in: reportIds } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftOption.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: visitIds } } });
  await prisma.technician.deleteMany({ where: { id: { in: [technicianId, strangerId] } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ITEM]);
});

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);
const asStranger = (r: request.Test) => r.set("Authorization", `Bearer ${strangerToken}`);

/** A fresh visit assigned to the tech — the "visit's quote" rules are about the newest draft, so each case gets its own. */
async function newVisit(label: string, status = "scheduled") {
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} ${label}`, status },
  });
  visitIds.push(visit.id);
  await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId } });
  return visit.id;
}

async function newDraft(visitId: string, title: string, extra: Record<string, unknown> = {}) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  if (Object.keys(extra).length > 0) await prisma.priceBookDraftEstimate.update({ where: { id: d.id }, data: extra });
  return d;
}

/** A draft with one $70 line on the given visit. */
async function draftWithLine(visitId: string, title: string, qty = 1) {
  const d = await newDraft(visitId, title);
  await addLine(prisma, d.id, { itemId: ITEM, quantity: qty });
  return d;
}

/** Issue from the FIELD door; returns the issue response data. */
async function issueFromField(draftId: string) {
  const res = await auth(request(app).post(`/health-record/quotes/${draftId}/issue`)).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { estimateId: string; number: string; customerUrl: string; unpriced: string[] };
}

async function signInPerson(estimateId: string) {
  const res = await request(app)
    .post(`/issued-estimates/${estimateId}/sign-in-person`)
    .send({ signerName: "Mrs Lifecycle", signatureImage: TEST_SIGNATURE, selectedOptions: ["A"] });
  expect(res.body, JSON.stringify(res.body)).toMatchObject({ signed: true });
}

const draftRow = (id: string) => prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id } });
const quotePayload = async (id: string) => {
  const res = await auth(request(app).get(`/health-record/quotes/${id}`));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
};
const openVisitQuote = async (visitId: string) => {
  const res = await auth(request(app).post(`/health-record/visits/${visitId}/quote`)).send({});
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  return res.body.data as { draftId: string; resumed: boolean };
};

/** Every key in a JSON tree, for the "no token on the wire" check. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}

// ─── Title & scope ────────────────────────────────────────────────────────────

describe("PUT /health-record/quotes/:draftId/details — the CRM's setDraftDetails", () => {
  it("sets the title and the scope from the field; both payloads show them; issuing uses the DRAFT's values", async () => {
    const visitId = await newVisit("details");
    const d = await draftWithLine(visitId, "details");
    const res = await auth(request(app).put(`/health-record/quotes/${d.id}/details`))
      .send({ title: "Panel change — 2 Lifecycle Way", jobDescription: "  Replace the 100A panel with a 200A panel.  " });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ id: d.id, title: "Panel change — 2 Lifecycle Way", jobDescription: "Replace the 100A panel with a 200A panel." });

    const q = await quotePayload(d.id);
    expect(q.title).toBe("Panel change — 2 Lifecycle Way");
    expect(q.jobDescription).toBe("Replace the 100A panel with a 200A panel.");
    const review = await request(app).get(`/price-book/drafts/${d.id}/review`);
    expect(review.body.draft).toMatchObject({ title: "Panel change — 2 Lifecycle Way", jobDescription: "Replace the 100A panel with a 200A panel." });

    const issued = await issueFromField(d.id);
    const est = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: issued.estimateId } });
    expect(est.title).toBe("Panel change — 2 Lifecycle Way");
    expect(est.scopeText).toBe("Replace the 100A panel with a 200A panel.");
  });

  it("the CRM door edits the same fields; a scope saved empty is cleared; either field alone is an edit", async () => {
    const visitId = await newVisit("details-crm");
    const d = await newDraft(visitId, "details-crm", { jobDescription: "old scope" });
    const only = await request(app).put(`/price-book/drafts/${d.id}/details`).send({ title: "Renamed from the office" });
    expect(only.status, JSON.stringify(only.body)).toBe(200);
    expect(await draftRow(d.id)).toMatchObject({ title: "Renamed from the office", jobDescription: "old scope" });
    const cleared = await request(app).put(`/price-book/drafts/${d.id}/details`).send({ jobDescription: "" });
    expect(cleared.status).toBe(200);
    expect((await draftRow(d.id)).jobDescription).toBeNull();
  });

  it("a renamed draft reaches the customer on 'Save changes to the estimate': the revision carries the DRAFT's title, same number", async () => {
    const visitId = await newVisit("details-revise");
    const d = await draftWithLine(visitId, "details-revise");
    const first = await issueFromField(d.id);
    const crm = await request(app).put(`/price-book/drafts/${d.id}/details`).send({ title: "Title edited after issue", jobDescription: "New scope." });
    expect(crm.status).toBe(200);
    // The edit reopened the unsigned draft; the field's Issue is now "Save changes to the estimate".
    expect((await getDraftLifecycle(prisma, d.id)).hasUnsavedChanges).toBe(true);
    const second = await issueFromField(d.id);
    expect(second.number).toBe(first.number);
    const rev = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: second.estimateId } });
    expect(rev.revision).toBe(2);
    expect(rev.title).toBe("Title edited after issue");
    expect(rev.scopeText).toBe("New scope.");
    // Same via the office's own Revise button.
    await request(app).put(`/price-book/drafts/${d.id}/details`).send({ title: "Edited again" });
    const revised = await request(app).post(`/issued-estimates/${second.estimateId}/revise`).send({});
    expect(revised.status, JSON.stringify(revised.body)).toBe(201);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: revised.body.estimateId } })).title).toBe("Edited again");
  });

  it("a title handed to the CRM issue route is written onto the draft first — the draft stays the record", async () => {
    const visitId = await newVisit("details-issue-body");
    const d = await draftWithLine(visitId, "details-issue-body");
    const res = await request(app).post(`/price-book/drafts/${d.id}/issue`)
      .send({ accountId: customerId, serviceAddressId: propertyId, title: "From the issue body", scopeText: "Body scope" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await draftRow(d.id)).toMatchObject({ title: "From the issue body", jobDescription: "Body scope" });
    expect(await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: res.body.estimateId } })).toMatchObject({ title: "From the issue body", scopeText: "Body scope" });
  });

  it("an empty title and an empty body are refused on both doors, writing nothing; a stranger gets 403", async () => {
    const visitId = await newVisit("details-refuse");
    const d = await newDraft(visitId, "details-refuse");
    for (const body of [{ title: "   " }, {}]) {
      const crm = await request(app).put(`/price-book/drafts/${d.id}/details`).send(body);
      const field = await auth(request(app).put(`/health-record/quotes/${d.id}/details`)).send(body);
      expect(crm.status, JSON.stringify(crm.body)).toBeGreaterThanOrEqual(400);
      expect(crm.status).toBeLessThan(500);
      expect(field.status, JSON.stringify(field.body)).toBeGreaterThanOrEqual(400);
      expect(field.status).toBeLessThan(500);
    }
    const stranger = await asStranger(request(app).put(`/health-record/quotes/${d.id}/details`)).send({ title: "Stolen" });
    expect(stranger.status).toBe(403);
    expect((await draftRow(d.id)).title).toBe(`${MARK} details-refuse`);
  });

  it("SIGNED draft: both doors still take a title (it reaches the customer only through a revision), and the draft stays finalized", async () => {
    const visitId = await newVisit("details-signed");
    const d = await draftWithLine(visitId, "details-signed");
    const issued = await issueFromField(d.id);
    await signInPerson(issued.estimateId);
    const crm = await request(app).put(`/price-book/drafts/${d.id}/details`).send({ title: "Office title on signed" });
    expect(crm.status, JSON.stringify(crm.body)).toBe(200);
    const field = await auth(request(app).put(`/health-record/quotes/${d.id}/details`)).send({ title: "Field title on signed" });
    expect(field.status, JSON.stringify(field.body)).toBe(200);
    expect(await draftRow(d.id)).toMatchObject({ title: "Field title on signed", status: "finalized" });
  });
});

// ─── Delete ───────────────────────────────────────────────────────────────────

describe("DELETE /health-record/quotes/:draftId — the CRM's deleteDraft", () => {
  it("deletes a never-issued quote with its lines and option names; the CRM door does the same", async () => {
    const visitId = await newVisit("delete");
    const d = await draftWithLine(visitId, "delete");
    await setOptionMeta(prisma, d.id, "B", { label: "Lights", note: null });
    const res = await auth(request(app).delete(`/health-record/quotes/${d.id}`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ deleted: true, title: `${MARK} delete` });
    expect(await prisma.priceBookDraftEstimate.findUnique({ where: { id: d.id } })).toBeNull();
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id } })).toBe(0);
    expect(await prisma.priceBookDraftOption.count({ where: { draftId: d.id } })).toBe(0);

    const d2 = await draftWithLine(visitId, "delete-crm");
    const crm = await request(app).delete(`/price-book/drafts/${d2.id}`);
    expect(crm.status, JSON.stringify(crm.body)).toBe(200);
    expect(crm.body).toEqual({ deleted: true, title: `${MARK} delete-crm` });
  });

  it("once anything was issued: refused with the SAME sentence and status on both doors, and that sentence is lifecycle.deleteReason in both payloads", async () => {
    const visitId = await newVisit("delete-issued");
    const d = await draftWithLine(visitId, "delete-issued");
    const issued = await issueFromField(d.id);
    const reason = await draftDeleteReason(prisma, d.id);
    expect(reason).toContain(`Estimate ${issued.number} was issued from this quote`);
    expect(reason).toContain("from the Estimates page in the office");

    const field = await auth(request(app).delete(`/health-record/quotes/${d.id}`));
    const crm = await request(app).delete(`/price-book/drafts/${d.id}`);
    expect(field.status).toBe(409);
    expect(crm.status).toBe(409);
    expect(field.body.error.message).toBe(reason);
    expect(crm.body.error).toBe(reason);
    expect(await prisma.priceBookDraftEstimate.findUnique({ where: { id: d.id } })).not.toBeNull();

    expect((await quotePayload(d.id)).lifecycle.deleteReason).toBe(reason);
    expect((await request(app).get(`/price-book/drafts/${d.id}/review`)).body.lifecycle.deleteReason).toBe(reason);

    // The office deletes the unsigned estimate (Kyle, 2026-08-22) — and then the quote can go.
    expect((await request(app).delete(`/issued-estimates/${issued.estimateId}`)).status).toBe(200);
    expect((await auth(request(app).delete(`/health-record/quotes/${d.id}`))).status).toBe(200);
  });

  it("a stranger gets 403 and nothing is deleted; a diagnostic that pointed at the draft is unlinked by a delete", async () => {
    const visitId = await newVisit("delete-stranger");
    const d = await draftWithLine(visitId, "delete-stranger");
    expect((await asStranger(request(app).delete(`/health-record/quotes/${d.id}`))).status).toBe(403);
    expect(await prisma.priceBookDraftEstimate.findUnique({ where: { id: d.id } })).not.toBeNull();

    const report = await prisma.diagnosticReport.create({
      data: {
        id: `${MARK}-report-${d.id}`, visitId, propertyId, customerId, reportDate: new Date("2026-10-01T00:00:00Z"),
        complaint: "Kitchen outlets dead", circuitLabel: "Kitchen", coverage: "whole_circuit", status: "complete",
        changeOrderDraftId: d.id,
      },
    });
    reportIds.push(report.id);
    expect((await auth(request(app).delete(`/health-record/quotes/${d.id}`))).status).toBe(200);
    expect((await prisma.diagnosticReport.findUniqueOrThrow({ where: { id: report.id } })).changeOrderDraftId).toBeNull();
  });
});

// ─── Copy to a new quote ──────────────────────────────────────────────────────

describe("POST /health-record/quotes/:draftId/duplicate — the CRM's duplicateDraft", () => {
  it("copies the lines, names and discount onto a NEW draft on the same visit, which 'Build the quote' then opens", async () => {
    const visitId = await newVisit("copy");
    const d = await draftWithLine(visitId, "copy", 2);
    await setOptionMeta(prisma, d.id, "A", { label: "The call-out", note: null });
    await auth(request(app).put(`/health-record/quotes/${d.id}/discount`)).send({ type: "senior" });
    const issued = await issueFromField(d.id);
    await signInPerson(issued.estimateId);

    const res = await auth(request(app).post(`/health-record/quotes/${d.id}/duplicate`)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const copyId: string = res.body.data.draftId;
    draftIds.push(copyId);
    expect(copyId).not.toBe(d.id);
    expect(res.body.data.title).toBe(`${MARK} copy`);
    const copy = await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: copyId }, include: { lines: true, optionMeta: true } });
    expect(copy).toMatchObject({ visitId, status: "draft", discountType: "senior" });
    expect(copy.lines.map((l) => [l.itemId, l.quantity])).toEqual([[ITEM, 2]]);
    expect(copy.optionMeta.map((o) => [o.option, o.label])).toEqual([["A", "The call-out"]]);

    // The copy is the tech's quote (same visit) and the newest, so it is what the visit resumes.
    expect((await quotePayload(copyId)).lifecycle.issued).toBeNull();
    expect(await openVisitQuote(visitId)).toEqual({ draftId: copyId, resumed: true });
    // The signed original is untouched.
    expect((await draftRow(d.id)).status).toBe("finalized");
    expect((await asStranger(request(app).post(`/health-record/quotes/${d.id}/duplicate`)).send({})).status).toBe(403);
  });
});

// ─── The visit's quote: resume, revise, skip ──────────────────────────────────

describe("POST /health-record/visits/:visitId/quote — workingDraftForVisit", () => {
  it("RESUMES an issued draft; the payload names the estimate with its customer link (estimateLink, never the token)", async () => {
    const visitId = await newVisit("resume");
    const { draftId, resumed } = await openVisitQuote(visitId);
    draftIds.push(draftId);
    expect(resumed).toBe(false);
    await auth(request(app).post(`/health-record/quotes/${draftId}/lines`)).send({ itemId: ITEM, quantity: 1 });
    const issued = await issueFromField(draftId);
    expect((await draftRow(draftId)).status).toBe("finalized");

    // Before 2026-10-08 this created a second draft here.
    expect(await openVisitQuote(visitId)).toEqual({ draftId, resumed: true });
    const q = await quotePayload(draftId);
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: issued.estimateId } });
    expect(q.lifecycle).toEqual({
      status: "finalized",
      // issuedAt / validDays / figuresKey (Phase 7 unit U7): the validity window the phone judges by
      // its own clock, and the server-made fingerprint of the frozen figures it echoes on a signature.
      issued: { estimateId: issued.estimateId, number: issued.number, revision: 1, status: "draft", signedAt: null, issuedAt: row.createdAt.toISOString(), validDays: row.validDays, figuresKey: expect.stringMatching(/^[0-9a-f]{64}$/), archived: false, customerUrl: estimateLink(row.token) },
      hasUnsavedChanges: false,
      reviseReason: null,
      deleteReason: expect.stringContaining(issued.number),
      copyReason: null,
    });
    expect(keysOf(q).has("token")).toBe(false);
    // The CRM's review and compute payloads carry the same answer (no link there — the CRM has its own detail route).
    const review = await request(app).get(`/price-book/drafts/${draftId}/review`);
    const compute = await request(app).get(`/price-book/drafts/${draftId}/compute`);
    expect(review.body.lifecycle).toEqual({ ...q.lifecycle, issued: { ...q.lifecycle.issued, customerUrl: null } });
    expect(compute.body.lifecycle).toEqual(review.body.lifecycle);
  });

  it("an edit from the field reopens the draft (hasUnsavedChanges) and Issue REVISES — same number, revision 2, one draft", async () => {
    const visitId = await newVisit("revise");
    const { draftId } = await openVisitQuote(visitId);
    draftIds.push(draftId);
    await auth(request(app).post(`/health-record/quotes/${draftId}/lines`)).send({ itemId: ITEM, quantity: 1 });
    const first = await issueFromField(draftId);

    const resumed = await openVisitQuote(visitId);
    const add = await auth(request(app).post(`/health-record/quotes/${resumed.draftId}/lines`)).send({ itemId: ITEM, quantity: 3 });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    const q = await quotePayload(draftId);
    expect(q.lifecycle).toMatchObject({ status: "draft", hasUnsavedChanges: true, issued: { number: first.number, revision: 1 } });

    const second = await issueFromField(draftId);
    expect(second.number).toBe(first.number);
    expect(second.estimateId).not.toBe(first.estimateId);
    const rows = await prisma.issuedEstimate.findMany({ where: { draftId }, orderBy: { revision: "asc" } });
    expect(rows.map((r) => r.revision)).toEqual([1, 2]);
    expect(rows[1].supersedesId).toBe(rows[0].id);
    expect(await prisma.priceBookDraftEstimate.count({ where: { visitId, changeOrderForId: null } })).toBe(1);
    expect((await quotePayload(draftId)).lifecycle).toMatchObject({ status: "finalized", hasUnsavedChanges: false, issued: { revision: 2 } });
  });

  it("skips a change-order draft and a diagnostic's resolutions draft; a VOIDED estimate's draft is left behind", async () => {
    // Change order: the signed root's draft is the visit's quote (locked), never the change order on top of it.
    const visitId = await newVisit("skip-co");
    const d = await draftWithLine(visitId, "skip-co");
    const issued = await issueFromField(d.id);
    await signInPerson(issued.estimateId);
    const co = await newDraft(visitId, "skip-co change order", { changeOrderForId: issued.estimateId });
    expect(await workingDraftForVisit(prisma, visitId)).toEqual({ id: d.id, status: "finalized" });
    expect(await openVisitQuote(visitId)).toEqual({ draftId: d.id, resumed: true });
    expect(co.id).not.toBe(d.id);

    // Diagnostic with no signed root: an ordinary-looking draft, identified by the report that owns it.
    const visit2 = await newVisit("skip-diag");
    const diag = await newDraft(visit2, "Resolutions — Kitchen");
    const report = await prisma.diagnosticReport.create({
      data: {
        id: `${MARK}-report-${diag.id}`, visitId: visit2, propertyId, customerId, reportDate: new Date("2026-10-01T00:00:00Z"),
        complaint: "Dead outlets", circuitLabel: "Kitchen", coverage: "whole_circuit", status: "complete", changeOrderDraftId: diag.id,
      },
    });
    reportIds.push(report.id);
    expect(await workingDraftForVisit(prisma, visit2)).toBeNull();
    const opened = await openVisitQuote(visit2);
    draftIds.push(opened.draftId);
    expect(opened.resumed).toBe(false);
    expect(opened.draftId).not.toBe(diag.id);
    // Its own door still works: the quote payload opens the resolutions draft by id.
    expect((await quotePayload(diag.id)).draftId).toBe(diag.id);

    // Void: the draft stays as the record, but the visit starts a fresh quote.
    const visit3 = await newVisit("skip-void");
    const v = await draftWithLine(visit3, "skip-void");
    const vi = await issueFromField(v.id);
    await prisma.issuedEstimate.update({ where: { id: vi.estimateId }, data: { status: "void", voidedAt: new Date(), voidReason: "test" } });
    const fresh = await openVisitQuote(visit3);
    draftIds.push(fresh.draftId);
    expect(fresh.resumed).toBe(false);
    expect(fresh.draftId).not.toBe(v.id);
  });

  it("LOST: resumed, reviseReason says reopen it first, and the field's Issue is refused with the same words", async () => {
    const visitId = await newVisit("lost");
    const d = await draftWithLine(visitId, "lost");
    const issued = await issueFromField(d.id);
    // Marked lost the way the office's route does it (the route itself first wants the estimate SENT).
    await prisma.issuedEstimate.update({ where: { id: issued.estimateId }, data: { status: "lost", lostAt: new Date(), lostReason: "price" } });
    expect(await openVisitQuote(visitId)).toEqual({ draftId: d.id, resumed: true });
    const q = await quotePayload(d.id);
    expect(q.lifecycle.reviseReason).toBe(lostReopenReason(issued.number));
    expect(q.lifecycle.issued.status).toBe("lost");
    const again = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send({});
    expect(again.status).toBe(409);
    expect(again.body.reasons).toEqual([lostReopenReason(issued.number)]);
  });

  it("SIGNED (ruling 1, Kyle 2026-10-09): resumed and locked; the FIELD is refused with Kyle's exact sentence, the CRM payload shows no refusal and the office CAN still revise", async () => {
    const visitId = await newVisit("signed");
    const d = await draftWithLine(visitId, "signed");
    const issued = await issueFromField(d.id);
    await signInPerson(issued.estimateId);
    expect(await openVisitQuote(visitId)).toEqual({ draftId: d.id, resumed: true });
    const q = await quotePayload(d.id);
    expect(q.lifecycle.reviseReason).toBe(FIELD_SIGNED_REVISE_REASON);
    expect(FIELD_SIGNED_REVISE_REASON).toBe("Signed — the office changes a signed estimate; raise a change order for new work");
    expect(q.lifecycle.issued.signedAt).toBeTruthy();
    expect(q.optionSet.lockedReason).toContain("SIGNED");
    const again = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send({});
    expect(again.status).toBe(409);
    expect(again.body.reasons).toEqual([q.lifecycle.reviseReason]);
    // The office is NOT refused: its review payload carries no signed refusal and its own Save changes still revises.
    expect((await request(app).get(`/price-book/drafts/${d.id}/review`)).body.lifecycle.reviseReason).toBeNull();
    expect((await getDraftLifecycle(prisma, d.id)).reviseReason).toBeNull();
    expect((await getDraftLifecycle(prisma, d.id, "field")).reviseReason).toBe(FIELD_SIGNED_REVISE_REASON);
    // The CRM's Issue route is still refused (it would only replace the signed copy) - and points at the revise button.
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: issued.estimateId } });
    const crmIssue = await request(app).post(`/price-book/drafts/${d.id}/issue`).send({ accountId: row.customerId, serviceAddressId: row.serviceAddressId });
    expect(crmIssue.status).toBe(409);
    expect(crmIssue.body.reasons.join(" ")).toMatch(/SIGNED/);
    expect(crmIssue.body.reasons.join(" ")).toMatch(/Save changes to the estimate/);
    expect(crmIssue.body.reasons.join(" ")).not.toBe(FIELD_SIGNED_REVISE_REASON);
    // ...while the office's own "Save changes to the estimate" (POST /revise) revises the signed estimate.
    const officeRevise = await request(app).post(`/issued-estimates/${issued.estimateId}/revise`).send({});
    expect(officeRevise.status, JSON.stringify(officeRevise.body)).toBe(201);
    expect(officeRevise.body.revision).toBe(2);
  });
});

// ─── The job brief: issued, not signed yet ────────────────────────────────────

describe("GET /health-record/visits/:visitId/job-brief — an issued, unsigned estimate rides the brief", () => {
  it("carries the unsigned estimate with its link; choicePending is false; Complete work now is refused", async () => {
    const visitId = await newVisit("brief", "estimate");
    const d = await draftWithLine(visitId, "brief");
    const issued = await issueFromField(d.id);
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: issued.estimateId } });

    const brief = await auth(request(app).get(`/health-record/visits/${visitId}/job-brief`));
    expect(brief.status, JSON.stringify(brief.body)).toBe(200);
    expect(brief.body.data.estimate).toMatchObject({ number: issued.number, signedAt: null, customerUrl: estimateLink(row.token) });
    expect(brief.body.data.estimate.lines).toEqual([{ description: expect.any(String), quantity: 1, option: "A" }]);
    expect(keysOf(brief.body).has("token")).toBe(false);
    expect(brief.body.data.choicePending).toBe(false);

    const now = await auth(request(app).post(`/health-record/visits/${visitId}/complete-work-now`)).send({});
    expect(now.status).toBe(409);
    expect(now.body.error.message).toContain("customer signs first");

    // Lost or void, the brief shows nothing — the panel must not offer a signing link for a dead quote.
    await prisma.issuedEstimate.update({ where: { id: issued.estimateId }, data: { status: "lost", lostAt: new Date() } });
    expect((await auth(request(app).get(`/health-record/visits/${visitId}/job-brief`))).body.data.estimate).toBeNull();
  });
});

// ─── 2026-10-08 review: copy refusal, stale reject/resolve, the brief's estimate id ────────────

import { COPY_REFUSED_CHANGE_ORDER, COPY_REFUSED_DIAGNOSTIC } from "../shared/draftLifecycle";

describe("Copy to a new quote is refused for a change order and a diagnostic's draft, on both doors", () => {
  it("a change order: same sentence and status from the field and the CRM, nothing created, the visit's quote unchanged, and the sentence rides lifecycle.copyReason", async () => {
    const visitId = await newVisit("copy-co");
    const d = await draftWithLine(visitId, "copy-co");
    const issued = await issueFromField(d.id);
    await signInPerson(issued.estimateId);
    const co = await newDraft(visitId, "copy-co change order", { changeOrderForId: issued.estimateId });
    await addLine(prisma, co.id, { itemId: ITEM, quantity: -1 }).catch(() => undefined); // credit line (change orders only)
    const before = await prisma.priceBookDraftEstimate.count({ where: { visitId } });

    const field = await auth(request(app).post(`/health-record/quotes/${co.id}/duplicate`)).send({});
    const crm = await request(app).post(`/price-book/drafts/${co.id}/duplicate`).send({});
    expect(field.status, JSON.stringify(field.body)).toBe(400);
    expect(crm.status).toBe(400);
    expect(field.body.error.message).toBe(COPY_REFUSED_CHANGE_ORDER);
    expect(crm.body.error).toBe(COPY_REFUSED_CHANGE_ORDER);
    expect(await prisma.priceBookDraftEstimate.count({ where: { visitId } })).toBe(before);
    expect(await openVisitQuote(visitId)).toEqual({ draftId: d.id, resumed: true });

    expect((await quotePayload(co.id)).lifecycle.copyReason).toBe(COPY_REFUSED_CHANGE_ORDER);
    expect((await request(app).get(`/price-book/drafts/${co.id}/review`)).body.lifecycle.copyReason).toBe(COPY_REFUSED_CHANGE_ORDER);
    // An ordinary quote is not affected.
    expect((await quotePayload(d.id)).lifecycle.copyReason).toBeNull();
  });

  it("a diagnostic's resolutions draft: refused with its own sentence; nothing created", async () => {
    const visitId = await newVisit("copy-diag");
    const diag = await newDraft(visitId, "Resolutions — Garage");
    const report = await prisma.diagnosticReport.create({
      data: {
        id: `${MARK}-report-copy-${diag.id}`, visitId, propertyId, customerId, reportDate: new Date("2026-10-01T00:00:00Z"),
        complaint: "Dead outlets", circuitLabel: "Garage", coverage: "whole_circuit", status: "complete", changeOrderDraftId: diag.id,
      },
    });
    reportIds.push(report.id);
    const field = await auth(request(app).post(`/health-record/quotes/${diag.id}/duplicate`)).send({});
    expect(field.status, JSON.stringify(field.body)).toBe(400);
    expect(field.body.error.message).toBe(COPY_REFUSED_DIAGNOSTIC);
    expect((await request(app).post(`/price-book/drafts/${diag.id}/duplicate`).send({})).status).toBe(400);
    expect(await prisma.priceBookDraftEstimate.count({ where: { visitId } })).toBe(1);
    expect((await quotePayload(diag.id)).lifecycle.copyReason).toBe(COPY_REFUSED_DIAGNOSTIC);
  });
});

describe("a stale Reject / Resolve on an ISSUED draft is refused WITHOUT reopening it", () => {
  it("reject a line that is already confirmed: 409 on both doors, and the issued, unsigned draft stays finalized with no unsaved changes", async () => {
    const visitId = await newVisit("stale-reject");
    const d = await draftWithLine(visitId, "stale-reject");
    const issued = await issueFromField(d.id);
    const line = await prisma.priceBookDraftLine.findFirstOrThrow({ where: { draftId: d.id } });
    expect((await draftRow(d.id)).status).toBe("finalized");

    const field = await auth(request(app).post(`/health-record/quote-lines/${line.id}/reject`)).send({});
    const crm = await request(app).post(`/price-book/lines/${line.id}/reject`).send({});
    expect(field.status, JSON.stringify(field.body)).toBe(409);
    expect(crm.status).toBe(409);

    expect((await draftRow(d.id)).status).toBe("finalized");
    const life = await getDraftLifecycle(prisma, d.id);
    expect(life.hasUnsavedChanges).toBe(false);
    expect(life.issued?.estimateId).toBe(issued.estimateId);
    expect(await prisma.priceBookDraftLine.count({ where: { id: line.id } })).toBe(1);
  });

  it("resolve a question that is already answered: 409 on both doors, who answered is kept, and the draft is not reopened", async () => {
    const visitId = await newVisit("stale-resolve");
    const d = await draftWithLine(visitId, "stale-resolve");
    await issueFromField(d.id);
    const q = await prisma.priceBookDraftQuestion.create({
      data: { draftId: d.id, question: "Which circuit?", raisedBy: "ai:test-model", resolvedAt: new Date(), resolvedBy: "human:crm-session", resolutionNote: "The kitchen one." },
    });
    const field = await auth(request(app).post(`/health-record/quote-questions/${q.id}/resolve`)).send({ resolutionNote: "Garage" });
    const crm = await request(app).post(`/price-book/questions/${q.id}/resolve`).send({ resolutionNote: "Garage" });
    expect(field.status, JSON.stringify(field.body)).toBe(409);
    expect(crm.status).toBe(409);
    const row = await prisma.priceBookDraftQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.resolvedBy).toBe("human:crm-session");
    expect(row.resolutionNote).toBe("The kitchen one.");
    expect((await draftRow(d.id)).status).toBe("finalized");
    expect((await getDraftLifecycle(prisma, d.id)).hasUnsavedChanges).toBe(false);
  });
});

describe("the job brief's estimate carries its id (the Job site panel emails it)", () => {
  it("id is the issued estimate's id; the token is still not on the wire", async () => {
    const visitId = await newVisit("brief-id", "estimate");
    const d = await draftWithLine(visitId, "brief-id");
    const issued = await issueFromField(d.id);
    const brief = await auth(request(app).get(`/health-record/visits/${visitId}/job-brief`));
    expect(brief.body.data.estimate.id).toBe(issued.estimateId);
    expect(keysOf(brief.body).has("token")).toBe(false);
  });
});
