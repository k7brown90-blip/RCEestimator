/**
 * The customer signs on the TECHNICIAN'S PHONE, and "Raise a change order" is one rule in both
 * apps (2026-10-08, one-estimating-system plan, Phase 3 unit C).
 *
 *   SIGN IN PERSON. POST /health-record/issued-estimates/:id/sign-in-person is a thin wrapper
 *   around `signInPerson` (services/inPersonSigning.ts) - the same function the office's
 *   POST /issued-estimates/:id/sign-in-person calls, with the same body schema. Every rule that
 *   decides whether a signature is acceptable lives in applySignature; these tests pin that the
 *   phone's door reaches it: assignment-gated, sign-once, expired / lost / void / superseded
 *   refused, the options validated, the channel recorded as in-person (never "email"), the tech
 *   named, and the three side effects (notify Kyle, make the job, put away the options not chosen)
 *   run exactly once.
 *
 *   CHANGE ORDER. The office's button used to always create; the field's reopened an open change
 *   order. Both doors now go through createChangeOrderDraft, which reopens the open one for the
 *   invoice. Where a NEW one is filed still differs on purpose (office: the job; field: the
 *   technician's visit).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
// Counting Kyle's "it was signed" notification is how "side effects run once" is pinned.
vi.mock("../src/services/issuedEstimateSend", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/issuedEstimateSend")>();
  return { ...mod, notifyOwnerSigned: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { notifyOwnerSigned } from "../src/services/issuedEstimateSend";
import { addLine, createDraft, setOptionsMode } from "../src/services/atomicEstimateService";
import { CONSENT_TEXT } from "../shared/consentText";
import { CONSENT_TEXT as SERVICE_CONSENT_TEXT } from "../src/services/issuedEstimateService";
import { billedTotalOf } from "../src/services/stripePayments";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "FIELDSIGN";
const ITEM = "FSG-EA"; // flat $70 each (priceBookFixture)

let customerId: string;
let technicianId: string;
let techToken: string;
let strangerId: string;
let strangerToken: string;
const visitIds: string[] = [];
const propertyIds: string[] = [];
const draftIds: string[] = [];
let propertySeq = 0;

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
    data: { name: `${MARK} Customer`, email: "fieldsign@example.com", phone: "615-555-0171" },
  });
  customerId = customer.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `fieldsign-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  const stranger = await prisma.technician.create({ data: { name: `${MARK} Stranger`, accessToken: `fieldsign-stranger-${customer.id}` } });
  strangerId = stranger.id;
  strangerToken = stranger.accessToken;
});

afterAll(async () => {
  await cleanEstimatesFor(draftIds);
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftOption.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: visitIds } } });
  await prisma.technician.deleteMany({ where: { id: { in: [technicianId, strangerId] } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ITEM]);
});

beforeEach(() => {
  vi.mocked(notifyOwnerSigned).mockClear();
});

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);
const asStranger = (r: request.Test) => r.set("Authorization", `Bearer ${strangerToken}`);

/** Each fixture gets its OWN address so one test's signature never archives another test's estimate. */
async function newProperty() {
  propertySeq += 1;
  const p = await prisma.property.create({
    data: { customerId, name: `${MARK} House ${propertySeq}`, addressLine1: `${propertySeq} Signing Way`, city: "Murfreesboro", state: "TN", postalCode: "37127" },
  });
  propertyIds.push(p.id);
  return p.id;
}

async function newVisit(label: string, opts: { assigned?: boolean; propertyId?: string } = {}) {
  const visit = await prisma.visit.create({
    data: {
      customerId,
      propertyId: opts.propertyId ?? (await newProperty()),
      mode: "onsite",
      purpose: `${MARK} ${label}`,
      status: "scheduled",
    },
  });
  visitIds.push(visit.id);
  if (opts.assigned !== false) await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId } });
  return visit;
}

/** A quote built on a visit and issued from the field: Option A (and B when asked), optionally one-or-the-other. */
async function issuedQuote(label: string, opts: { optionB?: boolean; exclusive?: boolean; propertyId?: string; assigned?: boolean } = {}) {
  const visit = await newVisit(label, { propertyId: opts.propertyId, assigned: opts.assigned });
  const d = await createDraft(prisma, { title: `${MARK} ${label}`, supplierId: "HD", visitId: visit.id });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: ITEM, quantity: 1 });
  if (opts.optionB) await addLine(prisma, d.id, { itemId: ITEM, quantity: 2, option: "B" });
  if (opts.exclusive) await setOptionsMode(prisma, d.id, true);
  const res = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const estimateId = res.body.data.estimateId as string;
  return { visit, draftId: d.id, estimateId, number: res.body.data.number as string, propertyId: visit.propertyId };
}

const NAME = "Mrs Panel";
const signBody = (extra: Record<string, unknown> = {}) => ({ signerName: NAME, signatureImage: TEST_SIGNATURE, selectedOptions: ["A"], ...extra });
const signFromPhone = (estimateId: string, body: Record<string, unknown> = signBody()) =>
  auth(request(app).post(`/health-record/issued-estimates/${estimateId}/sign-in-person`))
    .set("User-Agent", "FieldPhone/9.9")
    .set("X-Forwarded-For", "203.0.113.7")
    .send(body);

const row = (id: string) => prisma.issuedEstimate.findUniqueOrThrow({ where: { id }, include: { options: true } });
const SECRET_KEY = /hours|labou?r|rate|cost|markup|synchrony|token|data$/i;
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}

// ─── The signature ────────────────────────────────────────────────────────────

describe("POST /health-record/issued-estimates/:id/sign-in-person - the customer signs on the tech's phone", () => {
  it("records an IN-PERSON signature, names the tech, captures IP and browser, and shows the exact consent text", async () => {
    const q = await issuedQuote("happy");
    const res = await signFromPhone(q.estimateId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ signed: true, estimateId: q.estimateId, number: q.number, selectedOptions: ["A"] });

    const est = await row(q.estimateId);
    // Never "email": this is the in-person channel.
    expect(est.signedChannel).toBe("in_person");
    expect(est.status).toBe("signed");
    expect(est.signedAt).not.toBeNull();
    expect(est.signerName).toBe(NAME);
    expect(est.signatureImage).toBe(TEST_SIGNATURE);
    expect(est.signerIp).toBe("203.0.113.7");
    expect(est.signerUserAgent).toBe("FieldPhone/9.9");
    expect(est.selectedOptions).toEqual(["A"]);
    // What the customer read on the phone IS what is recorded: one string, in shared/.
    expect(est.consentText).toBe(CONSENT_TEXT);
    expect(SERVICE_CONSENT_TEXT).toBe(CONSENT_TEXT);
    // Ruling 4 (Kyle, 2026-10-09): the exact sentence, spelled out so a drift in the constant is caught here.
    expect(est.consentText).toBe(
      "By typing my full name and tapping Accept & Sign, I agree to the scope and the price on this estimate, and I authorize Red Cedar Electric LLC to perform the work described. I understand this is an electronic signature with the same effect as a written one.",
    );

    // The signature is the customer's; the audit line says whose phone it was drawn on.
    const signed = await prisma.issuedEstimateEvent.findFirstOrThrow({ where: { estimateId: q.estimateId, type: "signed" } });
    expect(signed.actor).toBe("customer:in-person");
    expect(signed.detail).toContain(`tech:${technicianId}`);
    expect(signed.detail).toContain("in person");
  });

  it("answers with the figures the signed screen shows (the server's total, the options taken) and nothing internal", async () => {
    const q = await issuedQuote("figures", { optionB: true });
    const res = await signFromPhone(q.estimateId, signBody({ selectedOptions: ["B"] }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const est = await row(q.estimateId);
    const billed = billedTotalOf({
      total: est.total,
      tripCharge: est.tripCharge,
      selectedOptions: est.selectedOptions.map(String),
      comboCapJson: est.comboCapJson,
      discountJson: est.discountJson,
      warrantyJson: est.warrantyJson,
      optionsSubtotals: est.options.map((o) => ({ option: o.option, subtotal: o.subtotal })),
    });
    expect(res.body.data.total).toBe(billed);
    expect(res.body.data.total).toBeGreaterThan(0);
    expect(res.body.data.selectedOptions).toEqual(["B"]);
    // Only Option B was bought: the total is that option plus the trip, not the whole quote.
    expect(est.selectedOptions).toEqual(["B"]);
    // No token, hours, costs or rates ride the response.
    for (const key of keysOf(res.body.data)) expect(key, key).not.toMatch(SECRET_KEY);
    expect(JSON.stringify(res.body)).not.toContain(est.token);
  });

  it("runs the three side effects ONCE: Kyle is told, the job exists, the options not chosen are put away", async () => {
    const propertyId = await newProperty();
    const rival = await issuedQuote("rival", { propertyId });
    // "Presented" = sent to the customer; only presented, unsigned estimates are put away on a signature.
    await prisma.issuedEstimate.update({ where: { id: rival.estimateId }, data: { status: "sent" } });
    const q = await issuedQuote("winner", { propertyId });

    const res = await signFromPhone(q.estimateId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(notifyOwnerSigned).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyOwnerSigned).mock.calls[0][1]).toBe(q.estimateId);

    // The job: one new visit minted from the signed quote, linked on the estimate.
    const est = await row(q.estimateId);
    expect(est.jobVisitId).toBeTruthy();
    expect(res.body.data.jobVisitId).toBe(est.jobVisitId);
    const job = await prisma.visit.findUniqueOrThrow({ where: { id: est.jobVisitId! } });
    expect(job.status).toBe("contracted");
    expect(job.propertyId).toBe(propertyId);

    // The other presented, unsigned estimate at this address is put away, by the tech.
    const put = await row(rival.estimateId);
    expect(put.archivedAt).not.toBeNull();
    expect(res.body.data.archivedNumbers).toEqual([rival.number]);
    const trail = await prisma.issuedEstimateEvent.findFirstOrThrow({ where: { estimateId: rival.estimateId, type: "archived" } });
    expect(trail.actor).toBe(`tech:${technicianId}`);

    // A second press changes nothing: refused, no second notification, no second job.
    const again = await signFromPhone(q.estimateId);
    expect(again.status).toBe(400);
    expect(notifyOwnerSigned).toHaveBeenCalledTimes(1);
    expect((await row(q.estimateId)).jobVisitId).toBe(est.jobVisitId);
    expect(await prisma.visit.count({ where: { customerId, purpose: `${MARK} winner`, status: "contracted" } })).toBe(1);
  });

  it("is the SAME signature the office's screen takes: every recorded column matches the CRM route's", async () => {
    const viaPhone = await issuedQuote("parity-phone", { optionB: true });
    const viaOffice = await issuedQuote("parity-office", { optionB: true });
    const phone = await signFromPhone(viaPhone.estimateId, signBody({ selectedOptions: ["A", "B"] }));
    const office = await request(app)
      .post(`/issued-estimates/${viaOffice.estimateId}/sign-in-person`)
      .send(signBody({ selectedOptions: ["A", "B"] }));
    expect(phone.status).toBe(201);
    expect(office.status).toBe(200);
    expect(office.body).toMatchObject({ signed: true });

    const a = await row(viaPhone.estimateId);
    const b = await row(viaOffice.estimateId);
    for (const key of ["signedChannel", "status", "consentText", "selectedOptions", "comboCapJson", "discountJson", "total", "tripCharge", "archivedAt"] as const) {
      expect(a[key], key).toEqual(b[key]);
    }
    expect(a.jobVisitId).toBeTruthy();
    expect(b.jobVisitId).toBeTruthy();
    // The office's actor strings are unchanged by the move into the service.
    const jobEvents = await prisma.issuedEstimateEvent.findMany({ where: { estimateId: viaOffice.estimateId }, select: { type: true, actor: true } });
    expect(jobEvents.find((e) => e.type === "signed")?.actor).toBe("customer:in-person");
    expect(jobEvents.find((e) => e.type === "signed")).toBeTruthy();
  });
});

// ─── Who may sign ─────────────────────────────────────────────────────────────

describe("the phone's door is assignment-gated", () => {
  it("a stranger tech gets 403, no token gets 401, an unknown id 404 - and nothing is signed or sent", async () => {
    const q = await issuedQuote("gate");
    const stranger = await asStranger(request(app).post(`/health-record/issued-estimates/${q.estimateId}/sign-in-person`)).send(signBody());
    expect(stranger.status).toBe(403);
    expect((await request(app).post(`/health-record/issued-estimates/${q.estimateId}/sign-in-person`).send(signBody())).status).toBe(401);
    expect((await auth(request(app).post(`/health-record/issued-estimates/does-not-exist/sign-in-person`)).send(signBody())).status).toBe(404);
    const est = await row(q.estimateId);
    expect(est.signedAt).toBeNull();
    expect(est.status).not.toBe("signed");
    expect(notifyOwnerSigned).not.toHaveBeenCalled();
    expect(await prisma.issuedEstimateEvent.count({ where: { estimateId: q.estimateId, type: "signed" } })).toBe(0);
  });

  it("a tech assigned only to the JOB visit (jobVisitId) may sign; one assigned to neither may not", async () => {
    const q = await issuedQuote("job-visit-only");
    // The quote was issued from this tech's visit; take the assignment away. Assigned to no visit of
    // this estimate: refused (fail-closed, the estimate's visits are an allow-list).
    await prisma.visitAssignment.deleteMany({ where: { visitId: q.visit.id } });
    expect((await signFromPhone(q.estimateId)).status).toBe(403);
    // The estimate becomes a job's root on another visit this tech IS assigned to.
    const job = await newVisit("job-visit-only-job");
    await prisma.issuedEstimate.update({ where: { id: q.estimateId }, data: { jobVisitId: job.id } });
    const ok = await signFromPhone(q.estimateId);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });
});

// ─── What is refused ──────────────────────────────────────────────────────────

describe("the same refusals as the office's door, and nothing is written when it says no", () => {
  async function expectUntouched(estimateId: string) {
    const est = await row(estimateId);
    expect(est.signedAt).toBeNull();
    expect(est.signatureImage).toBeNull();
    expect(notifyOwnerSigned).not.toHaveBeenCalled();
    expect(await prisma.issuedEstimateEvent.count({ where: { estimateId, type: "signed" } })).toBe(0);
  }

  it("signed once: the second signature is refused and the first stands", async () => {
    const q = await issuedQuote("once");
    expect((await signFromPhone(q.estimateId)).status).toBe(201);
    const second = await signFromPhone(q.estimateId, signBody({ signerName: "Somebody Else" }));
    expect(second.status).toBe(400);
    expect(second.body.error.message).toMatch(/already been signed/);
    expect((await row(q.estimateId)).signerName).toBe(NAME);
    expect(notifyOwnerSigned).toHaveBeenCalledTimes(1);
  });

  it("an expired estimate is refused with the date", async () => {
    const q = await issuedQuote("expired");
    await prisma.issuedEstimate.update({ where: { id: q.estimateId }, data: { createdAt: new Date(Date.now() - 400 * 86_400_000) } });
    const res = await signFromPhone(q.estimateId);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/expired on/);
    await expectUntouched(q.estimateId);
  });

  it("a LOST estimate is refused (the office reopens it first)", async () => {
    const q = await issuedQuote("lost");
    await prisma.issuedEstimate.update({ where: { id: q.estimateId }, data: { status: "lost" } });
    const res = await signFromPhone(q.estimateId);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/has been closed/);
    await expectUntouched(q.estimateId);
  });

  it("a VOID estimate is refused", async () => {
    const q = await issuedQuote("void");
    await prisma.issuedEstimate.update({ where: { id: q.estimateId }, data: { status: "void", voidedAt: new Date(), voidReason: "test" } });
    const res = await signFromPhone(q.estimateId);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/is void/);
    await expectUntouched(q.estimateId);
  });

  it("a SUPERSEDED revision is refused - the customer signs the newer one", async () => {
    const q = await issuedQuote("superseded");
    const newer = await issuedQuote("superseded-newer");
    await prisma.issuedEstimate.update({ where: { id: newer.estimateId }, data: { supersedesId: q.estimateId } });
    const res = await signFromPhone(q.estimateId);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/replaced by a newer revision/);
    await expectUntouched(q.estimateId);
  });

  it("needs a drawn signature and a real name", async () => {
    const q = await issuedQuote("mark");
    const noMark = await signFromPhone(q.estimateId, { signerName: NAME, selectedOptions: ["A"] });
    expect(noMark.status).toBe(400);
    const junk = await signFromPhone(q.estimateId, signBody({ signatureImage: "data:image/png;base64,AAAA" }));
    expect(junk.status).toBe(400);
    const oneLetter = await signFromPhone(q.estimateId, signBody({ signerName: "A" }));
    expect(oneLetter.status).toBe(400);
    expect(oneLetter.body.error.message).toMatch(/full name/);
    // An empty name never reaches the service: the shared body schema refuses it. The tech router's
    // own error handler answers a schema failure 422 (as it does for every field route); the CRM's says 400.
    const blank = await signFromPhone(q.estimateId, signBody({ signerName: "   " }));
    expect(blank.status).toBe(422);
    await expectUntouched(q.estimateId);
  });

  it("validates the body with the CRM route's schema: oversize image, too many options", async () => {
    const q = await issuedQuote("schema");
    // Schema failures: 422 from the tech router's handler, 400 from the CRM's - the same schema, the same refusal.
    const huge = await signFromPhone(q.estimateId, signBody({ signatureImage: "data:image/png;base64," + "A".repeat(400_001) }));
    expect(huge.status).toBe(422);
    const tooMany = await signFromPhone(q.estimateId, signBody({ selectedOptions: ["A", "B", "C", "D", "E", "F", "G", "H", "A"] }));
    expect(tooMany.status).toBe(422);
    const crmTooMany = await request(app).post(`/issued-estimates/${q.estimateId}/sign-in-person`).send(signBody({ selectedOptions: ["A", "B", "C", "D", "E", "F", "G", "H", "A"] }));
    expect(crmTooMany.status).toBe(400);
    // The CRM door answers the same.
    const crmHuge = await request(app).post(`/issued-estimates/${q.estimateId}/sign-in-person`).send(signBody({ signatureImage: "data:image/png;base64," + "A".repeat(400_001) }));
    expect(crmHuge.status).toBe(400);
    await expectUntouched(q.estimateId);
  });
});

// ─── The options chosen ───────────────────────────────────────────────────────

describe("the options the customer ticked are validated on the server", () => {
  it("records exactly the options taken; a letter that was never offered is discarded, not stored", async () => {
    const q = await issuedQuote("options", { optionB: true });
    const res = await signFromPhone(q.estimateId, signBody({ selectedOptions: ["B", "H"] }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await row(q.estimateId)).selectedOptions).toEqual(["B"]);
  });

  it("refuses an empty choice and a choice that matches nothing offered; silence means all of them", async () => {
    const empty = await issuedQuote("none", { optionB: true });
    const none = await signFromPhone(empty.estimateId, signBody({ selectedOptions: [] }));
    expect(none.status).toBe(400);
    expect(none.body.error.message).toMatch(/choose at least one option/);
    const nothingOffered = await signFromPhone(empty.estimateId, signBody({ selectedOptions: ["G"] }));
    expect(nothingOffered.status).toBe(400);
    expect((await row(empty.estimateId)).signedAt).toBeNull();

    const silent = await issuedQuote("silent", { optionB: true });
    const body = signBody();
    delete (body as Record<string, unknown>).selectedOptions;
    const all = await signFromPhone(silent.estimateId, body);
    expect(all.status, JSON.stringify(all.body)).toBe(201);
    expect((await row(silent.estimateId)).selectedOptions.slice().sort()).toEqual(["A", "B"]);
  });

  it("one-or-the-other: exactly one option, not two, and not none", async () => {
    const q = await issuedQuote("exclusive", { optionB: true, exclusive: true });
    const two = await signFromPhone(q.estimateId, signBody({ selectedOptions: ["A", "B"] }));
    expect(two.status).toBe(400);
    expect(two.body.error.message).toMatch(/one-or-the-other/);
    expect((await row(q.estimateId)).signedAt).toBeNull();
    const one = await signFromPhone(q.estimateId, signBody({ selectedOptions: ["B"] }));
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect((await row(q.estimateId)).selectedOptions).toEqual(["B"]);
  });
});

// ─── The frozen discount is the cent the screen showed ───────────────────────

describe("the programme discount frozen at signing is the shared pricer's figure", () => {
  /** Two options at chosen subtotals, military 5%, no combined-options saving, no trip. */
  async function quoteAt(label: string, a: number, b: number) {
    const q = await issuedQuote(label, { optionB: true });
    await prisma.issuedEstimateOption.updateMany({ where: { estimateId: q.estimateId, option: "A" }, data: { subtotal: a } });
    await prisma.issuedEstimateOption.updateMany({ where: { estimateId: q.estimateId, option: "B" }, data: { subtotal: b } });
    // Take the material out of the combined-options band so the saving is exactly zero.
    await prisma.issuedEstimateLine.updateMany({ where: { estimateId: q.estimateId }, data: { inMaterialCap: false } });
    await prisma.issuedEstimate.update({ where: { id: q.estimateId }, data: { tripCharge: 0, discountType: "military", discountPercent: null } });
    return q;
  }

  it("A $1,234.56 + B $1.34: the page and the phone show $61.80 and the signature freezes $61.80 (the unrounded float sum froze $61.79)", async () => {
    const q = await quoteAt("round-up", 1234.56, 1.34);
    const res = await signFromPhone(q.estimateId, signBody({ selectedOptions: ["A", "B"] }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const est = await row(q.estimateId);
    expect(JSON.parse(est.discountJson!)).toMatchObject({ amount: 61.8, base: 1235.9, type: "military" });
  });

  it("A $85.15 + B $0.15: $4.26 (the old sum froze $4.27) - and the office's recorded acceptance takes the same figure", async () => {
    const q = await quoteAt("round-down", 85.15, 0.15);
    const res = await signFromPhone(q.estimateId, signBody({ selectedOptions: ["A", "B"] }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(JSON.parse((await row(q.estimateId)).discountJson!).amount).toBe(4.26);

    const other = await quoteAt("round-down-office", 85.15, 0.15);
    // The office's acceptance only takes an estimate that has been SENT.
    await prisma.issuedEstimate.update({ where: { id: other.estimateId }, data: { status: "sent", sentAt: new Date() } });
    const accepted = await request(app)
      .post(`/issued-estimates/${other.estimateId}/accept`)
      .send({ acceptedVia: "phone", acceptedBy: "Mrs Panel", selectedOptions: ["A", "B"] });
    expect(accepted.status, JSON.stringify(accepted.body)).toBeLessThan(300);
    expect(JSON.parse((await row(other.estimateId)).discountJson!).amount).toBe(4.26);
  });
});

// ─── Change order: one rule, two doors ────────────────────────────────────────

describe("Raise a change order - both doors reopen the open change order for the invoice", () => {
  /** A job with a signed root, signed through the phone's door; its signed job visit is `root.jobVisitId`. */
  async function signedJob(label: string) {
    const q = await issuedQuote(label);
    expect((await signFromPhone(q.estimateId)).status).toBe(201);
    return { ...q, root: await row(q.estimateId) };
  }
  const raiseFromField = (visitId: string) => auth(request(app).post(`/health-record/visits/${visitId}/change-order`)).send({});
  const raiseFromOffice = (estimateId: string) => request(app).post(`/issued-estimates/${estimateId}/change-order`).send({});

  it("the OFFICE button reopens the open change order instead of starting a second, and reports it (200, resumed)", async () => {
    const job = await signedJob("co-office-twice");
    const first = await raiseFromOffice(job.root.id);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.resumed).toBe(false);
    draftIds.push(first.body.draftId);
    const again = await raiseFromOffice(job.root.id);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ draftId: first.body.draftId, resumed: true });
    expect(await prisma.priceBookDraftEstimate.count({ where: { changeOrderForId: job.root.id } })).toBe(1);
    // Raised against the change order's own estimate id resolves to the same root and the same draft.
  });

  it("the office reopens a change order the FIELD started (filed on the tech's visit), and the field reopens its own", async () => {
    const job = await signedJob("co-field-then-office");
    const field = await raiseFromField(job.visit.id);
    expect(field.status, JSON.stringify(field.body)).toBe(201);
    draftIds.push(field.body.data.draftId);
    const office = await raiseFromOffice(job.root.id);
    expect(office.status, JSON.stringify(office.body)).toBe(200);
    expect(office.body).toMatchObject({ draftId: field.body.data.draftId, resumed: true });
    const fieldAgain = await raiseFromField(job.visit.id);
    expect(fieldAgain.status).toBe(200);
    expect(fieldAgain.body.data).toMatchObject({ draftId: field.body.data.draftId, resumed: true });
    expect(await prisma.priceBookDraftEstimate.count({ where: { changeOrderForId: job.root.id } })).toBe(1);
  });

  it("the field reopens a change order the OFFICE started when it is filed on the technician's visit (the job IS this visit)", async () => {
    const job = await signedJob("co-office-then-field");
    // "Complete work now": the consultation becomes the job, so the signed job IS the tech's visit.
    await prisma.issuedEstimate.update({ where: { id: job.root.id }, data: { jobVisitId: job.visit.id } });
    const office = await raiseFromOffice(job.root.id);
    expect(office.status).toBe(201);
    draftIds.push(office.body.draftId);
    expect((await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: office.body.draftId } })).visitId).toBe(job.visit.id);
    const field = await raiseFromField(job.visit.id);
    expect(field.status, JSON.stringify(field.body)).toBe(200);
    expect(field.body.data).toMatchObject({ draftId: office.body.draftId, resumed: true });
    expect(await prisma.priceBookDraftEstimate.count({ where: { changeOrderForId: job.root.id } })).toBe(1);
  });

  it("an office-filed change order on a visit the tech is NOT standing on is not duplicated - the phone is told why", async () => {
    const job = await signedJob("co-office-elsewhere");
    const office = await raiseFromOffice(job.root.id);
    expect(office.status).toBe(201);
    draftIds.push(office.body.draftId);
    // Filed on the minted job visit, which is not the visit this tech stands on.
    expect((await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: office.body.draftId } })).visitId).not.toBe(job.visit.id);
    const field = await raiseFromField(job.visit.id);
    expect(field.status).toBe(409);
    expect(field.body.error.message).toMatch(/already open/);
    // It does not guess who started it: the draft may be the tech's own, on another of their visits.
    expect(field.body.error.message).not.toMatch(/started in the office/);
    expect(await prisma.priceBookDraftEstimate.count({ where: { changeOrderForId: job.root.id } })).toBe(1);
  });

  it("a change order the TECH raised on the estimate visit is reopened from the job visit when the same tech is assigned there (assignment, not visit equality)", async () => {
    const job = await signedJob("co-field-two-visits");
    const fromEstimateVisit = await raiseFromField(job.visit.id);
    expect(fromEstimateVisit.status, JSON.stringify(fromEstimateVisit.body)).toBe(201);
    draftIds.push(fromEstimateVisit.body.data.draftId);
    const jobVisitId = job.root.jobVisitId!;
    expect(jobVisitId).not.toBe(job.visit.id);
    // Later the same tech is assigned to the minted job visit and presses "Raise a change order" there.
    await prisma.visitAssignment.create({ data: { visitId: jobVisitId, technicianId } });
    const fromJobVisit = await raiseFromField(jobVisitId);
    expect(fromJobVisit.status, JSON.stringify(fromJobVisit.body)).toBe(200);
    expect(fromJobVisit.body.data).toMatchObject({ draftId: fromEstimateVisit.body.data.draftId, resumed: true });
    expect(await prisma.priceBookDraftEstimate.count({ where: { changeOrderForId: job.root.id } })).toBe(1);
  });

  it("a signed change order is done: the next press on EITHER door starts a fresh one", async () => {
    const job = await signedJob("co-signed-then-new");
    const first = await raiseFromOffice(job.root.id);
    draftIds.push(first.body.draftId);
    await addLine(prisma, first.body.draftId, { itemId: ITEM, quantity: 1 });
    // The office files it on the job; the field issues from the visit it is on - put it there for the issue.
    await prisma.priceBookDraftEstimate.update({ where: { id: first.body.draftId }, data: { visitId: job.visit.id } });
    const issue = await auth(request(app).post(`/health-record/quotes/${first.body.draftId}/issue`)).send({ addToCurrentJob: false });
    expect(issue.status, JSON.stringify(issue.body)).toBe(201);
    expect((await signFromPhone(issue.body.data.estimateId, signBody())).status).toBe(201);

    const office = await raiseFromOffice(job.root.id);
    expect(office.status, JSON.stringify(office.body)).toBe(201);
    expect(office.body.draftId).not.toBe(first.body.draftId);
    draftIds.push(office.body.draftId);
  });

  it("still refuses with the same sentences on both doors: never signed", async () => {
    const q = await issuedQuote("co-unsigned");
    const crm = await raiseFromOffice(q.estimateId);
    const field = await raiseFromField(q.visit.id);
    expect(crm.status).toBe(409);
    expect(field.status).toBe(409);
    expect(field.body.error.message).toBe(crm.body.error);
  });
});
