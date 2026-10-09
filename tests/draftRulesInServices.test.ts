/**
 * One estimating system, two doors (Kyle, 2026-10-08) — Phase 0, unit 0b.
 *
 * Every draft-level rule that used to live inline in a CRM route (app.ts) now lives in a service
 * function that the tech route (routes/health-record.ts) will share. These tests pin the part of
 * that move that CHANGES behaviour, which is exactly the part a refactor could lose:
 *
 *   1. THE SIGNED-DRAFT GUARD. `reopenForEditIfUnsigned` was applied by the line functions and
 *      skipped by discount, option mode, option names, copy-option and questions. Copy-option and
 *      questions now reopen an unsigned draft honestly and refuse a signed one with the same words
 *      the line routes use — copying an option into a finalized draft used to leave it
 *      "finalized" with lines it was never finalized with. The discount, option mode and option
 *      names are DELIBERATELY still editable on a signed draft (Kyle, 2026-09-29: they take
 *      effect only through "Save changes to the estimate", a new revision the customer signs
 *      again): they reopen an unsigned draft, and on a signed one they save WITHOUT touching its
 *      status, so the revise that follows still finds it finalized.
 *
 *   2. ISSUE DECIDES ONCE. The CRM's issue route and the tech's issue route each had a copy of the
 *      "is there a live estimate?" lookup, and "live" excluded only void — so a SIGNED or a LOST
 *      estimate counted as live and Issue quietly revised it. `issueDraft` refuses both, with the
 *      same reason from either door.
 *
 * Builds its own price-book fixture (tests/helpers/priceBookFixture.ts); real drafts, real
 * signatures, the same shape as tests/revisionKeepsTheInvoice.test.ts.
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
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "ONESYS";
const ITEM = "ONESYS1";

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;
const draftIds: string[] = [];

async function cleanEstimatesFor(ids: string[]) {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: ids } } });
  const estIds = ests.map((e) => e.id);
  await prisma.payment.deleteMany({ where: { estimateId: { in: estIds } } });
  const jobIds = [...new Set(ests.map((e) => e.jobVisitId).filter((v): v is string => Boolean(v)))];
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: jobIds } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null, changeOrderForId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.visit.deleteMany({ where: { id: { in: jobIds } } });
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ITEM)]);
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "onesys@example.com", phone: "615-555-0166" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "1 One System Way", city: "Murfreesboro", state: "TN", postalCode: "37127" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" },
  });
  visitId = visit.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `onesys-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.visitAssignment.create({ data: { visitId, technicianId } });
});

afterAll(async () => {
  await cleanEstimatesFor(draftIds);
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftOption.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ITEM]);
});

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);

/** A priced draft on the shared visit, one line in option A. */
async function quotableDraft(title: string) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, quantitySource: "COUNT" });
  return d;
}

async function issueFromOffice(draftId: string) {
  const res = await request(app)
    .post(`/price-book/drafts/${draftId}/issue`)
    .send({ accountId: customerId, serviceAddressId: propertyId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { estimateId: string; number: string; revision: number };
}

async function signInPerson(estimateId: string) {
  const res = await request(app)
    .post(`/issued-estimates/${estimateId}/sign-in-person`)
    .send({ signerName: "Mrs One System", signatureImage: TEST_SIGNATURE, selectedOptions: ["A"] });
  expect(res.body, `the signature was refused: ${JSON.stringify(res.body)}`).toMatchObject({ signed: true });
}

/** A draft that has been issued (so it is "finalized") and then SIGNED — the one that stays shut. */
async function signedDraft(title: string) {
  const d = await quotableDraft(title);
  const issued = await issueFromOffice(d.id);
  await signInPerson(issued.estimateId);
  const row = await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: d.id } });
  expect(row.status).toBe("finalized");
  return d;
}

/** A draft that has been issued but NOT signed — the one that reopens. */
async function finalizedDraft(title: string) {
  const d = await quotableDraft(title);
  await issueFromOffice(d.id);
  const row = await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: d.id } });
  expect(row.status).toBe("finalized");
  return d;
}

const statusOf = async (draftId: string) =>
  (await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: draftId } })).status;

/*
  Each mutation below is tried twice: on a finalized-but-unsigned draft (must reopen it — the
  2026-08-22 "I still cannot edit this draft" rule) and on a signed draft (must refuse with the
  words the line routes use, and leave the row untouched). Same guard, same two outcomes, on
  every door the service has.
*/
describe("the signed-draft guard reaches every draft-level rule, not just the lines", () => {
  describe("PUT /price-book/drafts/:draftId/discount", () => {
    it("reopens a finalized, unsigned draft and sets the discount", async () => {
      const d = await finalizedDraft("discount-reopen");
      const res = await request(app).put(`/price-book/drafts/${d.id}/discount`).send({ type: "military" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ discountType: "military", discountPercent: null });
      expect(await statusOf(d.id)).toBe("draft");
    });

    it("STAYS EDITABLE on a signed draft (Kyle, 2026-09-29) and rides into the next revision, not the signed one", async () => {
      const d = await quotableDraft("discount-signed");
      const issued = await issueFromOffice(d.id);
      await signInPerson(issued.estimateId);
      const res = await request(app).put(`/price-book/drafts/${d.id}/discount`).send({ type: "senior" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ discountType: "senior", discountPercent: null });
      // Saved on the draft, but the draft stays shut: the status is not flipped.
      expect(await statusOf(d.id)).toBe("finalized");
      // The signed record froze its own discount and is untouched.
      const signed = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: issued.estimateId } });
      expect(signed.discountType).toBeNull();
      // "Save changes to the estimate" is the path that makes it count: a new, unsigned revision.
      const revised = await request(app).post(`/issued-estimates/${issued.estimateId}/revise`).send({});
      expect(revised.status, JSON.stringify(revised.body)).toBe(201);
      expect(revised.body.revision).toBe(issued.revision + 1);
      const next = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: revised.body.estimateId } });
      expect(next.discountType).toBe("senior");
      expect(next.signedAt).toBeNull();
    });

    it("still refuses a custom discount with no usable percentage, and 404s an unknown draft", async () => {
      const d = await quotableDraft("discount-custom-bad");
      const bad = await request(app).put(`/price-book/drafts/${d.id}/discount`).send({ type: "custom", percent: 80 });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/above 0 and at most 50/);
      const missing = await request(app).put(`/price-book/drafts/no-such-draft/discount`).send({ type: "military" });
      expect(missing.status).toBe(404);
    });
  });

  describe("PUT /price-book/drafts/:draftId/options-mode", () => {
    it("reopens a finalized, unsigned draft and flips the mode", async () => {
      const d = await finalizedDraft("mode-reopen");
      const res = await request(app).put(`/price-book/drafts/${d.id}/options-mode`).send({ exclusive: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ exclusiveOptions: true });
      expect(await statusOf(d.id)).toBe("draft");
    });

    it("stays editable on a signed draft, without reopening it", async () => {
      const d = await signedDraft("mode-signed");
      const res = await request(app).put(`/price-book/drafts/${d.id}/options-mode`).send({ exclusive: true });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ exclusiveOptions: true });
      expect(await statusOf(d.id)).toBe("finalized");
      const read = await request(app).get(`/price-book/drafts/${d.id}/options-mode`);
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ exclusiveOptions: true });
    });
  });

  describe("PUT /price-book/drafts/:draftId/options/:option", () => {
    it("reopens a finalized, unsigned draft and names the option", async () => {
      const d = await finalizedDraft("name-reopen");
      const res = await request(app).put(`/price-book/drafts/${d.id}/options/b`).send({ label: "Exterior pathway lights", note: "  " });
      expect(res.status).toBe(200);
      // Upper-cased letter, trimmed label, blank note cleared to null — the rule as it was.
      expect(res.body).toEqual({ option: "B", label: "Exterior pathway lights", note: null });
      expect(await statusOf(d.id)).toBe("draft");
      const listed = await request(app).get(`/price-book/drafts/${d.id}/options`);
      expect(listed.body).toEqual([{ option: "B", label: "Exterior pathway lights", note: null }]);
    });

    it("stays editable on a signed draft, without reopening it", async () => {
      const d = await signedDraft("name-signed");
      const res = await request(app).put(`/price-book/drafts/${d.id}/options/A`).send({ label: "Renamed for the revision" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ option: "A", label: "Renamed for the revision", note: null });
      expect(await statusOf(d.id)).toBe("finalized");
    });
  });

  describe("POST /price-book/drafts/:draftId/options/copy", () => {
    it("reopens a finalized, unsigned draft and appends the copied lines", async () => {
      const d = await finalizedDraft("copy-reopen");
      const res = await request(app).post(`/price-book/drafts/${d.id}/options/copy`).send({ from: "A", to: "C" });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ copied: 1, from: "A", to: "C" });
      // This was the gap the audit named: copying used to leave the draft "finalized" with
      // lines it was never finalized with.
      expect(await statusOf(d.id)).toBe("draft");
      expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id, option: "C" } })).toBe(1);
    });

    it("refuses on a signed draft and copies nothing", async () => {
      const d = await signedDraft("copy-signed");
      const res = await request(app).post(`/price-book/drafts/${d.id}/options/copy`).send({ from: "A", to: "B" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/SIGNED/);
      expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id } })).toBe(1);
    });

    it("keeps the same-option and empty-source refusals, and 404s an unknown draft", async () => {
      const d = await quotableDraft("copy-refusals");
      const same = await request(app).post(`/price-book/drafts/${d.id}/options/copy`).send({ from: "A", to: "A" });
      expect(same.status).toBe(400);
      expect(same.body.error).toMatch(/same/);
      const empty = await request(app).post(`/price-book/drafts/${d.id}/options/copy`).send({ from: "B", to: "C" });
      expect(empty.status).toBe(400);
      expect(empty.body.error).toMatch(/Option B has no lines/);
      const missing = await request(app).post(`/price-book/drafts/no-such-draft/options/copy`).send({ from: "A", to: "B" });
      expect(missing.status).toBe(404);
    });
  });

  describe("POST /price-book/drafts/:draftId/questions", () => {
    it("reopens a finalized, unsigned draft and raises the question", async () => {
      const d = await finalizedDraft("question-reopen");
      const res = await request(app).post(`/price-book/drafts/${d.id}/questions`).send({ question: "Which panel?", rawText: "panel?" });
      expect(res.status).toBe(201);
      expect(res.body.raisedBy).toBe("human:walkthrough-entry");
      expect(res.body.rawText).toBe("panel?");
      expect(await statusOf(d.id)).toBe("draft");
    });

    it("refuses on a signed draft — an open question would block a document that is already agreed", async () => {
      const d = await signedDraft("question-signed");
      const res = await request(app).post(`/price-book/drafts/${d.id}/questions`).send({ question: "Too late?" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/SIGNED/);
      expect(await prisma.priceBookDraftQuestion.count({ where: { draftId: d.id } })).toBe(0);
    });

    it("404s an unknown draft instead of failing on the foreign key", async () => {
      const res = await request(app).post(`/price-book/drafts/no-such-draft/questions`).send({ question: "?" });
      expect(res.status).toBe(404);
    });
  });
});

describe("issueDraft decides once, for both doors", () => {
  it("CRM: re-issuing a draft whose live estimate is SIGNED is refused, and no revision is minted", async () => {
    const d = await signedDraft("issue-signed-crm");
    const before = await prisma.issuedEstimate.count({ where: { draftId: d.id } });
    const res = await request(app)
      .post(`/price-book/drafts/${d.id}/issue`)
      .send({ accountId: customerId, serviceAddressId: propertyId });
    expect(res.status).toBe(409);
    expect(res.body.issued).toBe(false);
    expect(res.body.reasons.join(" ")).toMatch(/SIGNED/);
    expect(res.body.reasons.join(" ")).toMatch(/change order/);
    expect(await prisma.issuedEstimate.count({ where: { draftId: d.id } })).toBe(before);
  });

  it("CRM: re-issuing a draft whose live estimate is LOST is refused and points at Reopen", async () => {
    const d = await quotableDraft("issue-lost-crm");
    const issued = await issueFromOffice(d.id);
    // Lost starts from sent/viewed, so the quote has to have gone out first.
    await prisma.issuedEstimate.update({ where: { id: issued.estimateId }, data: { status: "sent", sentAt: new Date() } });
    const lost = await request(app).post(`/issued-estimates/${issued.estimateId}/lost`).send({ reason: "price" });
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);

    const res = await request(app)
      .post(`/price-book/drafts/${d.id}/issue`)
      .send({ accountId: customerId, serviceAddressId: propertyId });
    expect(res.status).toBe(409);
    expect(res.body.reasons.join(" ")).toMatch(/lost/i);
    expect(res.body.reasons.join(" ")).toMatch(/reopen/i);
    expect(await prisma.issuedEstimate.count({ where: { draftId: d.id } })).toBe(1);

    // Reopen IS the way back: after it, Issue revises as it always did.
    const reopened = await request(app).post(`/issued-estimates/${issued.estimateId}/reopen`).send({});
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    const again = await request(app)
      .post(`/price-book/drafts/${d.id}/issue`)
      .send({ accountId: customerId, serviceAddressId: propertyId });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.number).toBe(issued.number);
    expect(again.body.revision).toBe(issued.revision + 1);
  });

  it("CRM: 'Save changes to the estimate' (POST /revise) is refused on a LOST estimate too — the rule is in reviseEstimate, not only in Issue", async () => {
    const d = await quotableDraft("revise-lost-crm");
    const issued = await issueFromOffice(d.id);
    await prisma.issuedEstimate.update({ where: { id: issued.estimateId }, data: { status: "sent", sentAt: new Date() } });
    const lost = await request(app).post(`/issued-estimates/${issued.estimateId}/lost`).send({ reason: "price" });
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);

    const res = await request(app).post(`/issued-estimates/${issued.estimateId}/revise`).send({});
    expect(res.status).toBe(409);
    expect(res.body.revised).toBe(false);
    expect(res.body.reasons.join(" ")).toMatch(/lost/i);
    expect(res.body.reasons.join(" ")).toMatch(/reopen/i);
    expect(await prisma.issuedEstimate.count({ where: { draftId: d.id } })).toBe(1);

    const reopened = await request(app).post(`/issued-estimates/${issued.estimateId}/reopen`).send({});
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    const again = await request(app).post(`/issued-estimates/${issued.estimateId}/revise`).send({});
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it("CRM: revising a SIGNED estimate by hand stays open — it is the deliberate change-after-signing path", async () => {
    const d = await signedDraft("revise-signed-crm");
    const live = await prisma.issuedEstimate.findFirstOrThrow({ where: { draftId: d.id } });
    const res = await request(app).post(`/issued-estimates/${live.id}/revise`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("field: a re-issue records the tech's NAME on the revision and the id on a first issue, as it always did", async () => {
    const d = await quotableDraft("issue-actor-tech");
    const first = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send({});
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send({});
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const a = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: first.body.data.estimateId } });
    const b = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: second.body.data.estimateId } });
    expect(a.createdBy).toBe(`tech:${technicianId}`);
    expect(b.createdBy).toBe(`tech:${MARK} Tech`);
  });

  it("field: the tech's Issue is refused on a signed estimate with Kyle's exact sentence (ruling 1, 2026-10-09: changing a signed estimate is office only)", async () => {
    const d = await quotableDraft("issue-signed-tech");
    const first = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send({});
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    await signInPerson(first.body.data.estimateId as string);

    const res = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("not_ready");
    expect(res.body.error.message).toBe("Signed — the office changes a signed estimate; raise a change order for new work");
    expect(res.body.reasons).toEqual(["Signed — the office changes a signed estimate; raise a change order for new work"]);
    expect(await prisma.issuedEstimate.count({ where: { draftId: d.id } })).toBe(1);
  });

  it("field: an unsigned re-issue still revises (same number, revision up) — nothing else changed", async () => {
    const d = await quotableDraft("issue-revise-tech");
    const first = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send({});
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send({});
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.data.number).toBe(first.body.data.number);
    expect(second.body.data.estimateId).not.toBe(first.body.data.estimateId);
  });
});

describe("the field's line routes answer a signed quote the way the CRM does", () => {
  it("DELETE /quote-lines/:id on a signed draft is a 400 with the reason, not a 500", async () => {
    const d = await quotableDraft("field-remove-signed");
    const first = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send({});
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    await signInPerson(first.body.data.estimateId as string);
    const line = await prisma.priceBookDraftLine.findFirstOrThrow({ where: { draftId: d.id } });

    const field = await auth(request(app).delete(`/health-record/quote-lines/${line.id}`));
    expect(field.status).toBe(400);
    expect(field.body.error.message).toMatch(/SIGNED/);
    const crm = await request(app).delete(`/price-book/lines/${line.id}`);
    expect(crm.status).toBe(400);
    expect(crm.body.error).toMatch(/SIGNED/);
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id } })).toBe(1);
  });
});

describe("draft-rule routes: only a rule refusal is a 400; a database failure reaches the global handler", () => {
  it("a failure that is not a DraftError answers 500, not a 400 carrying the Prisma message", async () => {
    const d = await quotableDraft("db-failure");
    const spy = vi.spyOn(prisma.priceBookDraftEstimate, "update").mockRejectedValueOnce(new Error("connection reset by peer"));
    try {
      const res = await request(app).put(`/price-book/drafts/${d.id}/discount`).send({ type: "military" });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Internal server error");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("duplicate and attach, now service functions", () => {
  it("POST /duplicate copies lines, option names and the discount into a fresh editable draft", async () => {
    const d = await signedDraft("duplicate-source");
    await prisma.priceBookDraftOption.create({ data: { draftId: d.id, option: "A", label: "The signed scope", note: null } });
    await prisma.priceBookDraftEstimate.update({ where: { id: d.id }, data: { discountType: "senior" } });

    // A signed draft is the normal source: copying is a READ of it, so the guard does not apply.
    const res = await request(app).post(`/price-book/drafts/${d.id}/duplicate`).send({});
    expect(res.status).toBe(201);
    draftIds.push(res.body.id);
    const copy = await prisma.priceBookDraftEstimate.findUniqueOrThrow({
      where: { id: res.body.id },
      include: { lines: true, optionMeta: true },
    });
    expect(copy.status).toBe("draft");
    expect(copy.title).toBe(d.title);
    expect(copy.discountType).toBe("senior");
    expect(copy.changeOrderForId).toBeNull();
    expect(copy.lines.map((l) => [l.itemId, l.quantity, l.option, l.state])).toEqual([[ITEM, 1, "A", "CONFIRMED"]]);
    expect(copy.optionMeta.map((o) => [o.option, o.label])).toEqual([["A", "The signed scope"]]);
    // The source is untouched.
    expect(await statusOf(d.id)).toBe("finalized");

    expect((await request(app).post(`/price-book/drafts/no-such-draft/duplicate`).send({})).status).toBe(404);
  });

  it("POST /attach keeps its stricter rule: 'draft' status only, and the address must belong to the account", async () => {
    const d = await finalizedDraft("attach-finalized");
    const shut = await request(app).post(`/price-book/drafts/${d.id}/attach`).send({ accountId: customerId, serviceAddressId: propertyId });
    expect(shut.status).toBe(409);
    expect(shut.body.error).toMatch(/finalized/);

    const fresh = await quotableDraft("attach-fresh");
    const wrong = await request(app).post(`/price-book/drafts/${fresh.id}/attach`).send({ accountId: "someone-else", serviceAddressId: propertyId });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/does not belong/);

    const ok = await request(app).post(`/price-book/drafts/${fresh.id}/attach`).send({ accountId: customerId, serviceAddressId: propertyId });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, serviceAddressId: propertyId });
    expect(ok.body.draft.customerId).toBe(customerId);

    expect((await request(app).post(`/price-book/drafts/no-such-draft/attach`).send({ accountId: customerId, serviceAddressId: propertyId })).status).toBe(404);
  });
});
