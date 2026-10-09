/**
 * Photos on the estimate, the issue step's extra checkboxes, and raising a change order from the
 * job - from the FIELD door, pinned against the CRM door (2026-10-08, one-estimating-system plan,
 * Phase 2 unit E).
 *
 *   PHOTOS. A photo taken while building a quote is a VisitPhoto on the job, uploaded by the field's
 *   existing PUT /visits/:visitId/photos/:photoId. The Quote screen LISTS the photos that can ride
 *   the estimate email (THIS JOB only - Kyle, 2026-10-09, ruling 2; the CRM's picker keeps the
 *   whole account), previews them, takes back the ones this technician added, and posts the ticked ids to the same
 *   sendEstimateEmail the CRM's send calls (so the scoping - another customer's id is refused - is
 *   the one in photoAttachments, not a second copy).
 *
 *   ISSUE EXTRAS. includeGenerator / addToCurrentJob / depositRequired are ONE schema
 *   (issueExtrasBodySchema) behind both issue routes; the "no generator sizing on file" refusal is
 *   graduateDraft's and reads the same from either door.
 *
 *   CHANGE ORDER. POST /health-record/visits/:visitId/change-order finds the job's signed estimate
 *   from the visit and runs createChangeOrderDraft - the same rules as the CRM's
 *   POST /issued-estimates/:id/change-order - then reopens, never duplicates, an open one.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import sharp from "sharp";
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
import { sendBrandedEmail } from "../src/services/confirmationEmail";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "FIELDQEXTRA";
const ITEM = "FQX-EA"; // flat $70 each (priceBookFixture)

let customerId: string;
let otherCustomerId: string;
let propertyId: string;
let property2Id: string;
let otherPropertyId: string;
let technicianId: string;
let techToken: string;
let strangerId: string;
let strangerToken: string;
const visitIds: string[] = [];
const draftIds: string[] = [];
const capacityIds: string[] = [];
const reportIds: string[] = [];
let png: Buffer;

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
  png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#c33" } }).png().toBuffer();
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "fieldqextra@example.com", phone: "615-555-0191" },
  });
  customerId = customer.id;
  const other = await prisma.customer.create({ data: { name: `${MARK} Other`, email: "fieldqextra-other@example.com", phone: "615-555-0192" } });
  otherCustomerId = other.id;
  propertyId = (await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "3 Extras Way", city: "Murfreesboro", state: "TN", postalCode: "37127" },
  })).id;
  property2Id = (await prisma.property.create({
    data: { customerId, name: `${MARK} Rental`, addressLine1: "9 Second Street", city: "Smyrna", state: "TN", postalCode: "37167" },
  })).id;
  otherPropertyId = (await prisma.property.create({
    data: { customerId: otherCustomerId, name: `${MARK} Elsewhere`, addressLine1: "5 Other Road", city: "Nashville", state: "TN", postalCode: "37201" },
  })).id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `fieldqextra-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  const stranger = await prisma.technician.create({ data: { name: `${MARK} Stranger`, accessToken: `fieldqextra-stranger-${customer.id}` } });
  strangerId = stranger.id;
  strangerToken = stranger.accessToken;
});

afterAll(async () => {
  await cleanEstimatesFor(draftIds);
  await prisma.capacityCheck.deleteMany({ where: { id: { in: capacityIds } } });
  await prisma.diagnosticReport.deleteMany({ where: { id: { in: reportIds } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftOption.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: visitIds } } });
  await prisma.technician.deleteMany({ where: { id: { in: [technicianId, strangerId] } } });
  await prisma.visit.deleteMany({ where: { customerId: { in: [customerId, otherCustomerId] } } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, property2Id, otherPropertyId] } } });
  await prisma.customer.deleteMany({ where: { id: { in: [customerId, otherCustomerId] } } });
  await deleteAtomics([ITEM]);
});

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);
const asStranger = (r: request.Test) => r.set("Authorization", `Bearer ${strangerToken}`);

async function newVisit(label: string, opts: { assigned?: boolean; owner?: string; property?: string } = {}) {
  const visit = await prisma.visit.create({
    data: {
      customerId: opts.owner ?? customerId,
      propertyId: opts.property ?? propertyId,
      mode: "onsite",
      purpose: `${MARK} ${label}`,
      status: "scheduled",
    },
  });
  visitIds.push(visit.id);
  if (opts.assigned !== false) await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId } });
  return visit.id;
}

async function addPhoto(visitId: string, id: string, by: string | null, caption: string | null = null) {
  await prisma.visitPhoto.create({
    data: { id, visitId, technicianId: by, mimeType: "image/png", sizeBytes: png.length, caption, data: png },
  });
  return id;
}

async function draftWithLine(visitId: string, title: string, qty = 1) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: ITEM, quantity: qty });
  return d;
}

async function issueFromField(draftId: string, body: Record<string, unknown> = {}) {
  const res = await auth(request(app).post(`/health-record/quotes/${draftId}/issue`)).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { estimateId: string; number: string; customerUrl: string };
}

async function signInPerson(estimateId: string) {
  const res = await request(app)
    .post(`/issued-estimates/${estimateId}/sign-in-person`)
    .send({ signerName: "Mrs Extras", signatureImage: TEST_SIGNATURE, selectedOptions: ["A"] });
  expect(res.body, JSON.stringify(res.body)).toMatchObject({ signed: true });
}

/** A visit with a quote issued from the field and signed in person: a job with a signed root. */
async function signedJob(label: string) {
  const visitId = await newVisit(label);
  const d = await draftWithLine(visitId, label);
  const issued = await issueFromField(d.id);
  await signInPerson(issued.estimateId);
  const root = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: issued.estimateId } });
  return { visitId, draftId: d.id, root };
}

/** Every key in a JSON tree. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}
const SECRET_KEY = /hours|labou?r|rate|cost|markup|synchrony|token|data$/i;

// ─── Photos on the estimate ───────────────────────────────────────────────────

describe("GET /health-record/quotes/:draftId/photos - THIS JOB's photos on the phone (Kyle, 2026-10-09, ruling 2)", () => {
  it("lists only the photos on this job, newest first - not the rest of the account, and never another customer's", async () => {
    const visitId = await newVisit("photos-list");
    const d = await draftWithLine(visitId, "photos-list");
    const mine = await addPhoto(visitId, `${MARK}-mine`, technicianId, "panel before");
    const office = await addPhoto(visitId, `${MARK}-office`, null, "from the office");
    const otherTech = await addPhoto(visitId, `${MARK}-other-tech`, strangerId, "another tech");
    // Same customer, a DIFFERENT job (another property) - on the account, not on this job.
    const rentalVisit = await newVisit("photos-rental", { assigned: false, property: property2Id });
    const rental = await addPhoto(rentalVisit, `${MARK}-rental`, null, "rental panel");
    const elsewhereVisit = await newVisit("photos-elsewhere", { assigned: false, owner: otherCustomerId, property: otherPropertyId });
    const foreign = await addPhoto(elsewhereVisit, `${MARK}-foreign`, null, "someone else's house");

    const res = await auth(request(app).get(`/health-record/quotes/${d.id}/photos`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.max).toBe(10);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.visitId).toBe(visitId);
    const byId = new Map<string, any>(res.body.data.photos.map((p: any) => [p.id, p]));
    expect([...byId.keys()].sort()).toEqual([mine, office, otherTech].sort());
    expect(byId.has(rental)).toBe(false);
    expect(byId.has(foreign)).toBe(false);

    // Which are on this visit, and which this technician may take back.
    expect(byId.get(mine)).toMatchObject({ onThisVisit: true, canRemove: true, caption: "panel before", visitId });
    expect(byId.get(office)).toMatchObject({ onThisVisit: true, canRemove: false });
    expect(byId.get(otherTech)).toMatchObject({ onThisVisit: true, canRemove: false });

    // Metadata only: no bytes, no hours, no costs.
    for (const key of keysOf(res.body.data.photos)) {
      if (key === "address") continue;
      expect(key, key).not.toMatch(SECRET_KEY);
    }
  });

  it("a consultation that became a job: the job's own visit rides the same chain the job's hours and P.O.s use", async () => {
    const { visitId, draftId, root } = await signedJob("photos-chain");
    // "Schedule for later": the sold job is its own visit, linked by the signed estimate's jobVisitId.
    const jobVisit = await newVisit("photos-chain-job", { assigned: false, property: property2Id });
    await prisma.issuedEstimate.update({ where: { id: root.id }, data: { jobVisitId: jobVisit } });
    const onConsult = await addPhoto(visitId, `${MARK}-chain-consult`, technicianId);
    const onJob = await addPhoto(jobVisit, `${MARK}-chain-job`, null);
    const unrelatedVisit = await newVisit("photos-chain-unrelated", { assigned: false });
    const unrelated = await addPhoto(unrelatedVisit, `${MARK}-chain-unrelated`, null);

    const res = await auth(request(app).get(`/health-record/quotes/${draftId}/photos`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids = res.body.data.photos.map((p: any) => p.id);
    expect([...ids].sort()).toEqual([onConsult, onJob].sort());
    expect(ids).not.toContain(unrelated);
    // Only the photo taken on THIS visit by THIS technician can be taken back from here.
    expect(res.body.data.photos.find((p: any) => p.id === onJob)).toMatchObject({ onThisVisit: false, canRemove: false });
  });

  it("is the technician's own quote only: a stranger and a missing token are refused", async () => {
    const visitId = await newVisit("photos-own");
    const d = await draftWithLine(visitId, "photos-own");
    expect((await asStranger(request(app).get(`/health-record/quotes/${d.id}/photos`))).status).toBe(403);
    expect((await request(app).get(`/health-record/quotes/${d.id}/photos`)).status).toBe(401);
    expect((await asStranger(request(app).get(`/health-record/quotes/${d.id}/photos/x/preview`))).status).toBe(403);
    expect((await asStranger(request(app).delete(`/health-record/quotes/${d.id}/photos/x`))).status).toBe(403);
  });

  it("serves a small JPEG preview of a photo on this job; 403 for another job on the account; 404 for another customer's photo", async () => {
    const visitId = await newVisit("photos-preview");
    const d = await draftWithLine(visitId, "photos-preview");
    const mine = await addPhoto(visitId, `${MARK}-prev`, technicianId);
    const rentalVisit = await newVisit("photos-prev-rental", { assigned: false, property: property2Id });
    const otherJob = await addPhoto(rentalVisit, `${MARK}-prev-rental`, null);
    const elsewhereVisit = await newVisit("photos-prev-elsewhere", { assigned: false, owner: otherCustomerId, property: otherPropertyId });
    const foreign = await addPhoto(elsewhereVisit, `${MARK}-prev-foreign`, null);

    const ok = await auth(request(app).get(`/health-record/quotes/${d.id}/photos/${mine}/preview`)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toMatch(/image\/jpeg/);
    expect((await sharp(ok.body as Buffer).metadata()).format).toBe("jpeg");

    // Ruling 2: on the account, but not on this job -> 403, and no bytes.
    const outside = await auth(request(app).get(`/health-record/quotes/${d.id}/photos/${otherJob}/preview`));
    expect(outside.status).toBe(403);
    expect(outside.body.error.message).toMatch(/not on this job/);
    // Another customer's photo is unchanged: not found.
    const refused = await auth(request(app).get(`/health-record/quotes/${d.id}/photos/${foreign}/preview`));
    expect(refused.status).toBe(404);
  });

  it("the exit: a technician can take back a photo THEY added to THIS job - nobody else's, no other job's", async () => {
    const visitId = await newVisit("photos-remove");
    const d = await draftWithLine(visitId, "photos-remove");
    const mine = await addPhoto(visitId, `${MARK}-rm-mine`, technicianId);
    const theirs = await addPhoto(visitId, `${MARK}-rm-theirs`, strangerId);
    const office = await addPhoto(visitId, `${MARK}-rm-office`, null);
    const rentalVisit = await newVisit("photos-rm-rental", { assigned: false, property: property2Id });
    const otherJob = await addPhoto(rentalVisit, `${MARK}-rm-rental`, technicianId);

    for (const id of [theirs, office, otherJob]) {
      const res = await auth(request(app).delete(`/health-record/quotes/${d.id}/photos/${id}`));
      expect(res.status, id).toBe(403);
      expect(res.body.error.message).toMatch(/Only the technician who took a photo can remove it/);
      expect(await prisma.visitPhoto.count({ where: { id } })).toBe(1);
    }
    const gone = await auth(request(app).delete(`/health-record/quotes/${d.id}/photos/${mine}`));
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect(await prisma.visitPhoto.count({ where: { id: mine } })).toBe(0);
    expect((await auth(request(app).delete(`/health-record/quotes/${d.id}/photos/${mine}`))).status).toBe(404);
  });
});

describe("POST /health-record/issued-estimates/:id/email - the ticked photos ride the email; the truck is this job only, the CRM is the account", () => {
  it("the field door refuses a tick from another job or customer and sends nothing; this job's photos go; the CRM door still takes any photo on the account", async () => {
    const visitId = await newVisit("photos-email");
    const d = await draftWithLine(visitId, "photos-email");
    const here = await addPhoto(visitId, `${MARK}-em-here`, technicianId);
    const rentalVisit = await newVisit("photos-em-rental", { assigned: false, property: property2Id });
    const rental = await addPhoto(rentalVisit, `${MARK}-em-rental`, null);
    const elsewhereVisit = await newVisit("photos-em-elsewhere", { assigned: false, owner: otherCustomerId, property: otherPropertyId });
    const foreign = await addPhoto(elsewhereVisit, `${MARK}-em-foreign`, null);
    const issued = await issueFromField(d.id);

    const send = vi.mocked(sendBrandedEmail);
    send.mockClear();
    // Ruling 2 (Kyle, 2026-10-09): another job's photo is REFUSED, not silently dropped - nothing is sent.
    for (const ids of [[here, rental], [here, foreign], [rental]]) {
      const refused = await auth(request(app).post(`/health-record/issued-estimates/${issued.estimateId}/email`)).send({ photoIds: ids });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error.message).toMatch(/not on this job/);
    }
    expect(send).not.toHaveBeenCalled();

    const field = await auth(request(app).post(`/health-record/issued-estimates/${issued.estimateId}/email`)).send({ photoIds: [here] });
    expect(field.status, JSON.stringify(field.body)).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const fieldCall = send.mock.calls[0][0] as { attachments?: Array<{ filename: string }> };
    expect(fieldCall.attachments).toHaveLength(1);

    // The CRM's picker keeps the account-wide scope (Kyle, 2026-10-01): the rental photo rides, the other customer's does not.
    send.mockClear();
    const crm = await request(app).post(`/issued-estimates/${issued.estimateId}/send`).send({ photoIds: [here, rental, foreign] });
    expect(crm.status, JSON.stringify(crm.body)).toBe(200);
    const crmCall = send.mock.calls[0][0] as { attachments?: Array<{ filename: string }> };
    expect(crmCall.attachments).toHaveLength(2);
  });

  it("nothing is attached unless ticked: no body, or an empty tick, sends no photos", async () => {
    const visitId = await newVisit("photos-email-none");
    const d = await draftWithLine(visitId, "photos-email-none");
    await addPhoto(visitId, `${MARK}-em-none`, technicianId);
    const issued = await issueFromField(d.id);
    const send = vi.mocked(sendBrandedEmail);
    for (const body of [{}, { photoIds: [] }]) {
      send.mockClear();
      const res = await auth(request(app).post(`/health-record/issued-estimates/${issued.estimateId}/email`)).send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const call = send.mock.calls[0][0] as { attachments?: unknown[] };
      expect(call.attachments ?? []).toHaveLength(0);
    }
  });

  it("holds the cap of ten on this door too, and a stranger is still refused", async () => {
    const visitId = await newVisit("photos-email-cap");
    const d = await draftWithLine(visitId, "photos-email-cap");
    const issued = await issueFromField(d.id);
    const eleven = Array.from({ length: 11 }, (_, i) => `${MARK}-cap-${i}`);
    const over = await auth(request(app).post(`/health-record/issued-estimates/${issued.estimateId}/email`)).send({ photoIds: eleven });
    expect(over.status).toBeGreaterThanOrEqual(400);
    expect(over.status).toBeLessThan(500);
    const stranger = await asStranger(request(app).post(`/health-record/issued-estimates/${issued.estimateId}/email`)).send({ photoIds: [] });
    expect(stranger.status).toBe(403);
  });
});

// ─── The issue step's extra checkboxes ────────────────────────────────────────

describe("issue: generator one-pager and 'add to current job' - one schema, both doors", () => {
  it("includeGenerator with nothing on file is refused with the SAME words from the CRM door and the field door, writing nothing", async () => {
    const visitId = await newVisit("gen-refuse", { assigned: true });
    const d = await draftWithLine(visitId, "gen-refuse");
    const crm = await request(app).post(`/price-book/drafts/${d.id}/issue`).send({ accountId: customerId, serviceAddressId: propertyId, includeGenerator: true });
    const field = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send({ includeGenerator: true });
    expect(crm.status).toBe(409);
    expect(field.status).toBe(409);
    expect(field.body.reasons).toEqual(crm.body.reasons);
    expect(field.body.reasons[0]).toMatch(/No generator sizing recommendation is on file for this address/);
    expect(await prisma.issuedEstimate.count({ where: { draftId: d.id } })).toBe(0);
  });

  it("includeGenerator with a recommendation on file freezes it onto the estimate - same from both doors; unticked leaves it off", async () => {
    const id = `${MARK}-cap-${customerId}`;
    capacityIds.push(id);
    await prisma.capacityCheck.create({
      data: {
        id, propertyId, customerId, method: "220.83", serviceAmps: 200, calculatedAmps: 120, loadPct: 60, fits: true,
        inputJson: "{}", resultJson: "{}", generatorJson: JSON.stringify({ note: "extras test recommendation" }),
      },
    });
    const v1 = await newVisit("gen-field");
    const d1 = await draftWithLine(v1, "gen-field");
    const f = await issueFromField(d1.id, { includeGenerator: true });
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: f.estimateId } })).generatorJson).toBe(JSON.stringify({ note: "extras test recommendation" }));

    const v2 = await newVisit("gen-crm");
    const d2 = await draftWithLine(v2, "gen-crm");
    const crm = await request(app).post(`/price-book/drafts/${d2.id}/issue`).send({ accountId: customerId, serviceAddressId: propertyId, includeGenerator: true });
    expect(crm.status, JSON.stringify(crm.body)).toBe(201);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: crm.body.estimateId } })).generatorJson).toBe(JSON.stringify({ note: "extras test recommendation" }));

    const v3 = await newVisit("gen-off");
    const d3 = await draftWithLine(v3, "gen-off");
    const off = await issueFromField(d3.id, { includeGenerator: false });
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: off.estimateId } })).generatorJson).toBeNull();
  });

  it("a wrong-typed box is refused by both doors (one schema), writing nothing", async () => {
    const visitId = await newVisit("extras-schema");
    const d = await draftWithLine(visitId, "extras-schema");
    const field = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send({ includeGenerator: "yes" });
    const crm = await request(app).post(`/price-book/drafts/${d.id}/issue`).send({ accountId: customerId, serviceAddressId: propertyId, addToCurrentJob: "no" });
    for (const res of [field, crm]) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(await prisma.issuedEstimate.count({ where: { draftId: d.id } })).toBe(0);
  });

  it("addToCurrentJob is stored on a change order from the field (both values), and ignored on an ordinary estimate", async () => {
    const job = await signedJob("addto");
    const opened = await auth(request(app).post(`/health-record/visits/${job.visitId}/change-order`)).send({});
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const coDraft = opened.body.data.draftId as string;
    draftIds.push(coDraft);
    await addLine(prisma, coDraft, { itemId: ITEM, quantity: 2 });
    const off = await issueFromField(coDraft, { addToCurrentJob: false });
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: off.estimateId } })).addToCurrentJob).toBe(false);
    // The deposit default for a change order is OFF (the shared default), same as the office.
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: off.estimateId } })).depositRequired).toBe(false);

    const job2 = await signedJob("addto-on");
    const opened2 = await auth(request(app).post(`/health-record/visits/${job2.visitId}/change-order`)).send({});
    const coDraft2 = opened2.body.data.draftId as string;
    draftIds.push(coDraft2);
    await addLine(prisma, coDraft2, { itemId: ITEM, quantity: 1 });
    const on = await issueFromField(coDraft2, { addToCurrentJob: true });
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: on.estimateId } })).addToCurrentJob).toBe(true);

    const v = await newVisit("addto-ordinary");
    const d = await draftWithLine(v, "addto-ordinary");
    const plain = await issueFromField(d.id, { addToCurrentJob: true });
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: plain.estimateId } })).addToCurrentJob).toBe(false);
  });
});

// ─── Raise a change order from the job ────────────────────────────────────────

describe("POST /health-record/visits/:visitId/change-order - the CRM's createChangeOrderDraft, from the job", () => {
  it("makes the same draft the CRM button makes (root, account, job, title, supplier) and opens on the Quote screen's payload", async () => {
    const job = await signedJob("co-parity");
    const res = await auth(request(app).post(`/health-record/visits/${job.visitId}/change-order`)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ changeOrderFor: job.root.number, resumed: false });
    const field = await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: res.body.data.draftId } });
    draftIds.push(field.id);

    // The office's door, against a SECOND signed job: since 2026-10-08 (Phase 3 unit C) the office
    // reopens the open change order for an invoice exactly as the field does, so the two doors are
    // compared on two invoices that each have none open yet (the reopen rule is pinned in
    // fieldSignInPerson.test.ts).
    const officeJob = await signedJob("co-parity-office");
    const crm = await request(app).post(`/issued-estimates/${officeJob.root.id}/change-order`).send({});
    expect(crm.status, JSON.stringify(crm.body)).toBe(201);
    const office = await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: crm.body.draftId } });
    draftIds.push(office.id);
    for (const key of ["supplierId", "status"] as const) {
      expect(field[key], key).toEqual(office[key]);
    }
    expect(office.customerId).toBe(field.customerId);
    expect(office.title).toBe(`Change order — ${officeJob.root.number}`);
    expect(office.changeOrderForId).toBe(officeJob.root.id);
    // The one difference, on purpose: the office files it on the signed JOB (a visit nobody is
    // assigned to yet right after the signature); the field files it on the visit the technician is on.
    expect(office.visitId).toBe(officeJob.root.jobVisitId);
    expect(field.visitId).toBe(job.visitId);
    expect(field.changeOrderForId).toBe(job.root.id);
    expect(field.title).toBe(`Change order — ${job.root.number}`);

    // The phone opens it by id: a change order, naming the invoice, with room for a minus quantity.
    const quote = await auth(request(app).get(`/health-record/quotes/${field.id}`));
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    expect(quote.body.data).toMatchObject({ isChangeOrder: true, changeOrderFor: job.root.number });
    const credit = await auth(request(app).post(`/health-record/quotes/${field.id}/lines`)).send({ itemId: ITEM, quantity: -1 });
    expect(credit.status, JSON.stringify(credit.body)).toBeLessThan(300);

    // The signed original is untouched, and the response holds no hours or costs.
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: job.root.id } })).signedAt).not.toBeNull();
    for (const key of keysOf(res.body.data)) expect(key, key).not.toMatch(SECRET_KEY);
  });

  it("an open change order is REOPENED, never duplicated; once it is signed the next press starts a new one", async () => {
    const job = await signedJob("co-resume");
    const first = await auth(request(app).post(`/health-record/visits/${job.visitId}/change-order`)).send({});
    expect(first.status).toBe(201);
    const draftId = first.body.data.draftId as string;
    draftIds.push(draftId);
    const again = await auth(request(app).post(`/health-record/visits/${job.visitId}/change-order`)).send({});
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data).toMatchObject({ draftId, resumed: true });
    expect(await prisma.priceBookDraftEstimate.count({ where: { changeOrderForId: job.root.id } })).toBe(1);

    // Issued but still waiting on the customer: still the open one.
    await addLine(prisma, draftId, { itemId: ITEM, quantity: 1 });
    const issued = await issueFromField(draftId, { addToCurrentJob: false });
    const waiting = await auth(request(app).post(`/health-record/visits/${job.visitId}/change-order`)).send({});
    expect(waiting.body.data).toMatchObject({ draftId, resumed: true });

    // Signed: it is done - a new press raises a fresh change order.
    await signInPerson(issued.estimateId);
    const next = await auth(request(app).post(`/health-record/visits/${job.visitId}/change-order`)).send({});
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(next.body.data.resumed).toBe(false);
    expect(next.body.data.draftId).not.toBe(draftId);
    draftIds.push(next.body.data.draftId);
  });

  it("refuses with the office's own sentences: nothing quoted, never signed, void", async () => {
    // Nothing quoted on the visit.
    const empty = await newVisit("co-empty");
    const none = await auth(request(app).post(`/health-record/visits/${empty}/change-order`)).send({});
    expect(none.status).toBe(409);
    expect(none.body.error.message).toMatch(/Nothing has been quoted on this job yet/);

    // Issued, not signed: the CRM door's exact refusal.
    const visitId = await newVisit("co-unsigned");
    const d = await draftWithLine(visitId, "co-unsigned");
    const issued = await issueFromField(d.id);
    const crm = await request(app).post(`/issued-estimates/${issued.estimateId}/change-order`).send({});
    const field = await auth(request(app).post(`/health-record/visits/${visitId}/change-order`)).send({});
    expect(crm.status).toBe(409);
    expect(field.status).toBe(409);
    expect(field.body.error.message).toBe(crm.body.error);
    expect(field.body.error.message).toMatch(/has not been signed/);

    // Void: no new work on an invoice that is off the books.
    const job = await signedJob("co-void");
    await prisma.issuedEstimate.update({ where: { id: job.root.id }, data: { status: "void", voidedAt: new Date(), voidReason: "test" } });
    const voided = await auth(request(app).post(`/health-record/visits/${job.visitId}/change-order`)).send({});
    expect(voided.status).toBe(409);
    expect(voided.body.error.message).toMatch(/void|not been signed|Nothing has been quoted/);
    expect(await prisma.priceBookDraftEstimate.count({ where: { changeOrderForId: job.root.id } })).toBe(0);
  });

  it("is assignment-gated: a stranger gets 403, and no token gets 401; nothing is written", async () => {
    const job = await signedJob("co-gate");
    const stranger = await asStranger(request(app).post(`/health-record/visits/${job.visitId}/change-order`)).send({});
    expect(stranger.status).toBe(403);
    expect((await request(app).post(`/health-record/visits/${job.visitId}/change-order`).send({})).status).toBe(401);
    expect(await prisma.priceBookDraftEstimate.count({ where: { changeOrderForId: job.root.id } })).toBe(0);
  });

  it("a diagnostic's own resolutions change order is not 'the open one': the button starts a separate change order", async () => {
    const job = await signedJob("co-diag");
    const diag = await prisma.priceBookDraftEstimate.create({
      data: { title: `${MARK} Resolutions`, changeOrderForId: job.root.id, customerId, visitId: job.visitId, supplierId: "HD" },
    });
    draftIds.push(diag.id);
    const report = await prisma.diagnosticReport.create({
      data: {
        id: `${MARK}-report-${diag.id}`, visitId: job.visitId, propertyId, customerId, reportDate: new Date("2026-10-01T00:00:00Z"),
        complaint: "Dead outlets", circuitLabel: "Kitchen", coverage: "whole_circuit", status: "complete", changeOrderDraftId: diag.id,
      },
    });
    reportIds.push(report.id);
    const res = await auth(request(app).post(`/health-record/visits/${job.visitId}/change-order`)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.draftId).not.toBe(diag.id);
    draftIds.push(res.body.data.draftId);
  });

  it("files the change order on the visit the technician is on, even when the signed job is a visit they are not assigned to", async () => {
    const job = await signedJob("co-elsewhere");
    const otherJob = await newVisit("co-elsewhere-job", { assigned: false });
    await prisma.issuedEstimate.update({ where: { id: job.root.id }, data: { jobVisitId: otherJob } });
    const res = await auth(request(app).post(`/health-record/visits/${job.visitId}/change-order`)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    draftIds.push(res.body.data.draftId);
    expect((await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: res.body.data.draftId } })).visitId).toBe(job.visitId);
    // And the phone can open it: the draft's visit is the technician's.
    expect((await auth(request(app).get(`/health-record/quotes/${res.body.data.draftId}`))).status).toBe(200);
  });

  it("the change order has its own way out on the Quote screen: an empty one can be deleted, and the next press makes a new one", async () => {
    const job = await signedJob("co-delete");
    const first = await auth(request(app).post(`/health-record/visits/${job.visitId}/change-order`)).send({});
    const draftId = first.body.data.draftId as string;
    const del = await auth(request(app).delete(`/health-record/quotes/${draftId}`));
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    const next = await auth(request(app).post(`/health-record/visits/${job.visitId}/change-order`)).send({});
    expect(next.status).toBe(201);
    expect(next.body.data.draftId).not.toBe(draftId);
    draftIds.push(next.body.data.draftId);
  });
});

// ─── The upload route may not be used to take over another tech's photo (2026-10-08 security review) ───

describe("PUT /health-record/visits/:visitId/photos/:photoId - assignment and ownership", () => {
  const put = (t: (r: request.Test) => request.Test, visitId: string, photoId: string, body: Buffer = png) =>
    t(request(app).put(`/health-record/visits/${visitId}/photos/${photoId}`)).set("Content-Type", "image/png").send(body);

  it("a technician NOT on the visit cannot file a photo on it", async () => {
    const visitId = await newVisit("put-unassigned");
    const res = await put(asStranger, visitId, `${MARK}-put-unassigned`);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await prisma.visitPhoto.count({ where: { id: `${MARK}-put-unassigned` } })).toBe(0);
  });

  it("the assigned technician files a photo, and a retry of the same id on the same visit is still fine (idempotent)", async () => {
    const visitId = await newVisit("put-own");
    const id = `${MARK}-put-own`;
    expect((await put(auth, visitId, id)).status).toBe(201);
    expect((await put(auth, visitId, id)).status).toBe(201);
    expect(await prisma.visitPhoto.count({ where: { id } })).toBe(1);
  });

  it("a photo id that belongs to ANOTHER technician or ANOTHER visit cannot be overwritten, so it cannot be taken over and then deleted", async () => {
    // Tech B (the stranger) took a photo on a visit the stranger is on; the Quote screen's photo list shows its id.
    const strangersVisit = await newVisit("put-take-theirs", { assigned: false });
    await prisma.visitAssignment.create({ data: { visitId: strangersVisit, technicianId: strangerId } });
    const theirs = await addPhoto(strangersVisit, `${MARK}-put-theirs`, strangerId, "theirs");
    const before = await prisma.visitPhoto.findUniqueOrThrow({ where: { id: theirs } });

    // Tech A (the tech) is assigned to their own visit and PUTs a different image over that id.
    const myVisit = await newVisit("put-take-mine");
    const other = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#33c" } }).png().toBuffer();
    const res = await put(auth, myVisit, theirs, other);
    expect(res.status, JSON.stringify(res.body)).toBe(403);

    const after = await prisma.visitPhoto.findUniqueOrThrow({ where: { id: theirs } });
    expect(after.visitId).toBe(strangersVisit);
    expect(after.technicianId).toBe(strangerId);
    expect(Buffer.compare(after.data, before.data)).toBe(0);

    // And the delete that depended on the takeover is refused: it is not the tech's photo, nor this job's.
    const d = await draftWithLine(myVisit, "put-take-mine");
    const del = await auth(request(app).delete(`/health-record/quotes/${d.id}/photos/${theirs}`));
    expect([403, 404]).toContain(del.status);
    expect(await prisma.visitPhoto.count({ where: { id: theirs } })).toBe(1);

    // The same tech's own photo id, sent against a DIFFERENT visit of theirs, is also not moved.
    const mineId = await addPhoto(myVisit, `${MARK}-put-mine-moved`, technicianId);
    const myOther = await newVisit("put-take-mine-2");
    expect((await put(auth, myOther, mineId)).status).toBe(403);
    expect((await prisma.visitPhoto.findUniqueOrThrow({ where: { id: mineId } })).visitId).toBe(myVisit);
  });
});
