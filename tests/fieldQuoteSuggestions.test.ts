/**
 * AI-suggested lines, open questions and the walkthrough list from BOTH doors — Phase 2 unit D of the
 * one-estimating-system plan (Kyle, 2026-10-08). NOT Savannah: the Walkthrough tab's "Build the draft
 * (AI)" and basic match.
 *
 * Each rule is ONE service function — confirmProposedLine / rejectProposedLine / resolveQuestion /
 * getDraftSuggestions (atomicEstimateService.ts), proposeWalkthroughForDraft (aiProposer.ts) and
 * resolveWalkthroughRows (walkthroughMatch.ts). The CRM's routes (src/app.ts) and the technician's
 * (src/routes/health-record.ts, behind quoteDraftForTech) are thin wrappers. Pinned from both doors:
 *
 *   - a technician reaches suggestions, questions and the walkthrough only through THEIR visit's quote;
 *   - Confirm / Edit & confirm / Reject / Resolve leave the same rows the CRM's buttons leave, and a
 *     refusal carries the same status and the same words on both doors;
 *   - rejectProposedLine had NO signed-draft guard (it deleted a line off a signed draft): it has the
 *     lock now, for both doors, and so does resolveQuestion;
 *   - "Build the draft (AI)" degrades to "basic" identically (path + reason, nothing written), refuses a
 *     signed draft BEFORE any model call, and the phone's answer carries no usage/cost;
 *   - nothing the phone receives carries hours, labour, rates, cost or Synchrony;
 *   - the issue refusal names the heading and the button that clears each list, in plain words, and the
 *     same words come from the shared sentence the field uses to grey its Issue button.
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
import { addLine, createDraft, proposeLines, raiseQuestion } from "../src/services/atomicEstimateService";
import { unreviewedReasons } from "../shared/suggestedLines";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "FIELDSUGG";
const EA = "FSG-EA"; // a plain count item, flat $70
const FT = "FSG-FT"; // sold by the foot
const ALL_IDS = [EA, FT];

let customerId: string;
let propertyId: string;
let technicianId: string;
let techToken: string;
let strangerId: string;
let strangerToken: string;
const visitIds: string[] = [];
const draftIds: string[] = [];

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([
    quotableAtomic(EA, { description: "FSG plain device", unit: "ea" }),
    quotableAtomic(FT, { description: "FSG cable by the foot", unit: "ft" }),
  ]);
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "fieldsugg@example.com", phone: "615-555-0191" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "3 Suggestion Way", city: "Murfreesboro", state: "TN", postalCode: "37127" },
  });
  propertyId = property.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `fieldsugg-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  const stranger = await prisma.technician.create({ data: { name: `${MARK} Stranger`, accessToken: `fieldsugg-stranger-${customer.id}` } });
  strangerId = stranger.id;
  strangerToken = stranger.accessToken;
});

afterAll(async () => {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: draftIds } } });
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
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftOption.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: visitIds } } });
  await prisma.technician.deleteMany({ where: { id: { in: [technicianId, strangerId] } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics(ALL_IDS);
});

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);
const asStranger = (r: request.Test) => r.set("Authorization", `Bearer ${strangerToken}`);

async function newVisit(label: string) {
  const visit = await prisma.visit.create({ data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} ${label}`, status: "scheduled" } });
  visitIds.push(visit.id);
  await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId } });
  return visit.id;
}

/** A draft on a fresh visit with one confirmed $70 line, so it is issuable once nothing is pending. */
async function newDraft(label: string, withLine = true) {
  const visitId = await newVisit(label);
  const d = await createDraft(prisma, { title: `${MARK} ${label}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  if (withLine) await addLine(prisma, d.id, { itemId: EA, quantity: 1 });
  return d;
}

/** One PROPOSED line (the model's write path) and its id. */
async function propose(draftId: string, itemId = EA, quantity = 2, reasoning = "The panel schedule shows a spare space, so a breaker fits.") {
  const r = await proposeLines(prisma, draftId, [{ itemId, quantity, reasoning }], [], "ai:test-model");
  expect(r.proposed, JSON.stringify(r)).toHaveLength(1);
  return r.proposed[0]!.id;
}

const askQuestion = async (draftId: string, question = "The customer mentioned a pool plug — what is it?") =>
  (await raiseQuestion(prisma, draftId, { question, rawText: "that weird outdoor plug by the pool", raisedBy: "ai:test-model" })).id;

const quotePayload = async (id: string) => {
  const res = await auth(request(app).get(`/health-record/quotes/${id}`));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
};

/** Issue from the field and sign in person (the draft is then locked). */
async function issueAndSign(draftId: string) {
  const issued = await auth(request(app).post(`/health-record/quotes/${draftId}/issue`)).send({});
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  const res = await request(app)
    .post(`/issued-estimates/${issued.body.data.estimateId}/sign-in-person`)
    .send({ signerName: "Mrs Suggestion", signatureImage: TEST_SIGNATURE, selectedOptions: ["A"] });
  expect(res.body, JSON.stringify(res.body)).toMatchObject({ signed: true });
}

/** Every key in a JSON tree. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}

// ─── The quote payload ────────────────────────────────────────────────────────

describe("GET /health-record/quotes/:draftId — what the phone lists under AI proposals and Open questions", () => {
  it("carries the suggested lines (with the book's name and the model's reasoning) and the open questions", async () => {
    const d = await newDraft("payload");
    const lineId = await propose(d.id, FT, 40);
    const qId = await askQuestion(d.id);

    const q = await quotePayload(d.id);
    expect(q.suggestedLines).toEqual([
      {
        id: lineId, itemId: FT, description: "FSG cable by the foot", quantity: 40, difficulty: "NORMAL", option: "A",
        reasoning: "The panel schedule shows a spare space, so a breaker fits.", proposedBy: "ai:test-model",
      },
    ]);
    expect(q.openQuestions).toEqual([
      { id: qId, question: "The customer mentioned a pool plug — what is it?", rawText: "that weird outdoor plug by the pool", raisedBy: "ai:test-model" },
    ]);
    // The suggestion is NOT priced: it is in `lines` as PROPOSED with no total, and in no option total.
    const row = q.lines.find((l: { id: string }) => l.id === lineId);
    expect(row).toMatchObject({ state: "PROPOSED", lineTotal: null });
  });

  it("agrees with the CRM's review of the same draft (same rows, same reasoning)", async () => {
    const d = await newDraft("payload-crm");
    const lineId = await propose(d.id);
    const qId = await askQuestion(d.id);
    const q = await quotePayload(d.id);
    const review = await request(app).get(`/price-book/drafts/${d.id}/review`);
    expect(review.body.proposedLines.map((l: { id: string; reasoning: string }) => [l.id, l.reasoning]))
      .toEqual(q.suggestedLines.map((l: { id: string; reasoning: string }) => [l.id, l.reasoning]));
    expect(review.body.openQuestions.map((x: { id: string }) => x.id)).toEqual(q.openQuestions.map((x: { id: string }) => x.id));
    expect([lineId, qId].every(Boolean)).toBe(true);
  });

  it("a resolved question and a confirmed line are no longer listed", async () => {
    const d = await newDraft("payload-clear");
    const lineId = await propose(d.id);
    const qId = await askQuestion(d.id);
    expect((await auth(request(app).post(`/health-record/quote-lines/${lineId}/confirm`)).send({})).status).toBe(200);
    expect((await auth(request(app).post(`/health-record/quote-questions/${qId}/resolve`)).send({ resolutionNote: "A 20A outdoor GFCI." })).status).toBe(200);
    const q = await quotePayload(d.id);
    expect(q.suggestedLines).toEqual([]);
    expect(q.openQuestions).toEqual([]);
  });

  it("no hours, labour, rate, cost, markup, Synchrony or usage key anywhere in what the phone gets for them", async () => {
    const d = await newDraft("payload-keys");
    await propose(d.id);
    await askQuestion(d.id);
    const q = await quotePayload(d.id);
    const banned = /hours|labou?r|rate|cost|markup|synchrony|usage|token|sell|price/i;
    for (const k of keysOf({ s: q.suggestedLines, o: q.openQuestions })) {
      expect(banned.test(k), `${k} must not reach the phone`).toBe(false);
    }
  });
});

// ─── Confirm ──────────────────────────────────────────────────────────────────

describe("POST /health-record/quote-lines/:lineId/confirm — the CRM's confirmProposedLine", () => {
  it("Confirm as proposed: the line becomes a priced, confirmed line recorded as the technician's", async () => {
    const d = await newDraft("confirm");
    const lineId = await propose(d.id, EA, 3);
    const res = await auth(request(app).post(`/health-record/quote-lines/${lineId}/confirm`)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(row).toMatchObject({ state: "CONFIRMED", quantity: 3, confirmedBy: `tech:${technicianId}`, editedBeforeConfirm: false });
    const q = await quotePayload(d.id);
    expect(q.lines.find((l: { id: string }) => l.id === lineId).lineTotal).toBe(210);
  });

  it("Edit & confirm: the edited quantity and difficulty are what is kept, and it is recorded as edited", async () => {
    const d = await newDraft("confirm-edit");
    const lineId = await propose(d.id, EA, 3);
    const res = await auth(request(app).post(`/health-record/quote-lines/${lineId}/confirm`)).send({ quantity: 5, difficulty: "DIFFICULT" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: lineId } }))
      .toMatchObject({ state: "CONFIRMED", quantity: 5, difficulty: "DIFFICULT", editedBeforeConfirm: true });
  });

  it("leaves the SAME row the CRM's Confirm leaves for the same input", async () => {
    const a = await newDraft("confirm-parity-crm");
    const b = await newDraft("confirm-parity-field");
    const crmLine = await propose(a.id, FT, 12);
    const fieldLine = await propose(b.id, FT, 12);
    const crm = await request(app).post(`/price-book/lines/${crmLine}/confirm`).send({ quantity: 20, difficulty: "VERY_DIFFICULT" });
    const field = await auth(request(app).post(`/health-record/quote-lines/${fieldLine}/confirm`)).send({ quantity: 20, difficulty: "VERY_DIFFICULT" });
    expect(crm.status).toBe(200);
    expect(field.status).toBe(200);
    const pick = (r: { state: string; quantity: number; quantitySource: string; difficulty: string; option: string; editedBeforeConfirm: boolean }) =>
      ({ state: r.state, quantity: r.quantity, quantitySource: r.quantitySource, difficulty: r.difficulty, option: r.option, editedBeforeConfirm: r.editedBeforeConfirm });
    expect(pick(await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: fieldLine } })))
      .toEqual(pick(await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: crmLine } })));
    expect(await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: crmLine } })).toMatchObject({ confirmedBy: "human:crm-session" });
    expect(await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: fieldLine } })).toMatchObject({ confirmedBy: `tech:${technicianId}` });
  });

  it("refuses the same way on both doors: a negative quantity off a change order, and a second confirm", async () => {
    const a = await newDraft("confirm-neg-crm");
    const b = await newDraft("confirm-neg-field");
    const crmLine = await propose(a.id);
    const fieldLine = await propose(b.id);
    const crm = await request(app).post(`/price-book/lines/${crmLine}/confirm`).send({ quantity: -1 });
    const field = await auth(request(app).post(`/health-record/quote-lines/${fieldLine}/confirm`)).send({ quantity: -1 });
    expect(crm.status).toBe(400);
    expect(field.status).toBe(400);
    expect(field.body.error.message).toBe(crm.body.error);
    expect(field.body.error.message).toMatch(/only allowed on a change order/i);
    expect((await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: fieldLine } })).state).toBe("PROPOSED");

    await auth(request(app).post(`/health-record/quote-lines/${fieldLine}/confirm`)).send({});
    await request(app).post(`/price-book/lines/${crmLine}/confirm`).send({});
    const crmAgain = await request(app).post(`/price-book/lines/${crmLine}/confirm`).send({});
    const fieldAgain = await auth(request(app).post(`/health-record/quote-lines/${fieldLine}/confirm`)).send({});
    expect(crmAgain.status).toBe(409);
    expect(fieldAgain.status).toBe(409);
    expect(fieldAgain.body.error.message).toBe(`Line ${fieldLine} is already confirmed.`);
  });

  it("is only for the technician whose visit it is (403), and an unknown line is 403 too, not a leak", async () => {
    const d = await newDraft("confirm-owner");
    const lineId = await propose(d.id);
    const res = await asStranger(request(app).post(`/health-record/quote-lines/${lineId}/confirm`)).send({});
    expect(res.status).toBe(403);
    expect((await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: lineId } })).state).toBe("PROPOSED");
    expect((await auth(request(app).post(`/health-record/quote-lines/no-such-line/confirm`)).send({})).status).toBe(403);
    expect((await request(app).post(`/health-record/quote-lines/${lineId}/confirm`).send({})).status).toBe(401);
  });
});

// ─── Reject ───────────────────────────────────────────────────────────────────

describe("POST /health-record/quote-lines/:lineId/reject — the CRM's rejectProposedLine", () => {
  it("drops the suggestion (the row is deleted) and the quote no longer lists it", async () => {
    const d = await newDraft("reject");
    const lineId = await propose(d.id);
    const res = await auth(request(app).post(`/health-record/quote-lines/${lineId}/reject`)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await prisma.priceBookDraftLine.findUnique({ where: { id: lineId } })).toBeNull();
    expect((await quotePayload(d.id)).suggestedLines).toEqual([]);
  });

  it("refuses a CONFIRMED line with the same status and words on both doors, and leaves it there", async () => {
    const d = await newDraft("reject-confirmed");
    const lineId = await propose(d.id);
    await auth(request(app).post(`/health-record/quote-lines/${lineId}/confirm`)).send({});
    const crm = await request(app).post(`/price-book/lines/${lineId}/reject`).send({});
    const field = await auth(request(app).post(`/health-record/quote-lines/${lineId}/reject`)).send({});
    expect(crm.status).toBe(409);
    expect(field.status).toBe(409);
    expect(field.body.error.message).toBe(crm.body.error);
    expect(await prisma.priceBookDraftLine.findUnique({ where: { id: lineId } })).not.toBeNull();
  });

  it("is only for the technician whose visit it is", async () => {
    const d = await newDraft("reject-owner");
    const lineId = await propose(d.id);
    expect((await asStranger(request(app).post(`/health-record/quote-lines/${lineId}/reject`)).send({})).status).toBe(403);
    expect(await prisma.priceBookDraftLine.findUnique({ where: { id: lineId } })).not.toBeNull();
  });

  it("a SIGNED draft keeps its suggestion: reject is locked like every other line change, on BOTH doors", async () => {
    const d = await newDraft("reject-signed");
    await issueAndSign(d.id);
    // A suggestion that exists on a draft that has since been signed (it cannot be rejected out from under the signature).
    const stray = await prisma.priceBookDraftLine.create({
      data: { draftId: d.id, itemId: EA, quantity: 1, quantitySource: "COUNT", state: "PROPOSED", proposedBy: "ai:test-model", proposalReasoning: "stray" },
    });
    const crm = await request(app).post(`/price-book/lines/${stray.id}/reject`).send({});
    const field = await auth(request(app).post(`/health-record/quote-lines/${stray.id}/reject`)).send({});
    expect(crm.status).toBe(400);
    expect(field.status).toBe(400);
    expect(crm.body.error).toMatch(/SIGNED/);
    expect(field.body.error.message).toBe(crm.body.error);
    expect(await prisma.priceBookDraftLine.findUnique({ where: { id: stray.id } })).not.toBeNull();
    // ...and so is Confirm.
    const confirm = await auth(request(app).post(`/health-record/quote-lines/${stray.id}/confirm`)).send({});
    expect(confirm.status).toBe(400);
    expect(confirm.body.error.message).toMatch(/SIGNED/);
    expect((await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: stray.id } })).state).toBe("PROPOSED");
  });
});

// ─── Resolve ──────────────────────────────────────────────────────────────────

describe("POST /health-record/quote-questions/:questionId/resolve — the CRM's resolveQuestion", () => {
  it("records the answer, who gave it and when — the same row the CRM's Resolve leaves", async () => {
    const a = await newDraft("resolve-crm");
    const b = await newDraft("resolve-field");
    const crmQ = await askQuestion(a.id);
    const fieldQ = await askQuestion(b.id);
    const crm = await request(app).post(`/price-book/questions/${crmQ}/resolve`).send({ resolutionNote: "  A 20A outdoor GFCI.  " });
    const field = await auth(request(app).post(`/health-record/quote-questions/${fieldQ}/resolve`)).send({ resolutionNote: "  A 20A outdoor GFCI.  " });
    expect(crm.status).toBe(200);
    expect(field.status, JSON.stringify(field.body)).toBe(200);
    const crmRow = await prisma.priceBookDraftQuestion.findUniqueOrThrow({ where: { id: crmQ } });
    const fieldRow = await prisma.priceBookDraftQuestion.findUniqueOrThrow({ where: { id: fieldQ } });
    expect(fieldRow.resolutionNote).toBe(crmRow.resolutionNote);
    expect(fieldRow.resolutionNote).toBe("A 20A outdoor GFCI.");
    expect(fieldRow.resolvedAt).not.toBeNull();
    expect(crmRow.resolvedBy).toBe("human:crm-session");
    expect(fieldRow.resolvedBy).toBe(`tech:${technicianId}`);
  });

  it("refuses an empty answer on both doors (the question stays open)", async () => {
    const d = await newDraft("resolve-empty");
    const qId = await askQuestion(d.id);
    expect((await request(app).post(`/price-book/questions/${qId}/resolve`).send({ resolutionNote: "   " })).status).toBeGreaterThanOrEqual(400);
    expect((await auth(request(app).post(`/health-record/quote-questions/${qId}/resolve`)).send({ resolutionNote: "   " })).status).toBeGreaterThanOrEqual(400);
    expect((await prisma.priceBookDraftQuestion.findUniqueOrThrow({ where: { id: qId } })).resolvedAt).toBeNull();
  });

  it("is only for the technician whose visit it is", async () => {
    const d = await newDraft("resolve-owner");
    const qId = await askQuestion(d.id);
    expect((await asStranger(request(app).post(`/health-record/quote-questions/${qId}/resolve`)).send({ resolutionNote: "x" })).status).toBe(403);
    expect((await auth(request(app).post(`/health-record/quote-questions/no-such-question/resolve`)).send({ resolutionNote: "x" })).status).toBe(403);
    expect((await prisma.priceBookDraftQuestion.findUniqueOrThrow({ where: { id: qId } })).resolvedAt).toBeNull();
  });

  it("a SIGNED draft's questions are locked on BOTH doors, with the signed sentence", async () => {
    const d = await newDraft("resolve-signed");
    await issueAndSign(d.id);
    const stray = await prisma.priceBookDraftQuestion.create({ data: { draftId: d.id, question: "Stray?", raisedBy: "ai:test-model" } });
    const crm = await request(app).post(`/price-book/questions/${stray.id}/resolve`).send({ resolutionNote: "done" });
    const field = await auth(request(app).post(`/health-record/quote-questions/${stray.id}/resolve`)).send({ resolutionNote: "done" });
    expect(crm.status).toBe(400);
    expect(field.status).toBe(400);
    expect(crm.body.error).toMatch(/SIGNED/);
    expect(field.body.error.message).toBe(crm.body.error);
    expect((await prisma.priceBookDraftQuestion.findUniqueOrThrow({ where: { id: stray.id } })).resolvedAt).toBeNull();
  });
});

// ─── The issue refusal ────────────────────────────────────────────────────────

describe("the draft cannot be issued while suggestions or questions wait, and the refusal says what to do", () => {
  it("names the heading and the button that clears each list, then issues once they are cleared", async () => {
    const d = await newDraft("issue-gate");
    const lineId = await propose(d.id);
    const qId = await askQuestion(d.id);

    const refused = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send({});
    expect(refused.status).toBe(409);
    const words = (refused.body.reasons as string[]).join(" ");
    expect(words).toContain("1 AI-suggested line is still unconfirmed");
    expect(words).toContain("1 open question is still unresolved");
    for (const w of ['"AI proposals"', "Confirm", "Reject", '"Open questions"', "Resolve"]) expect(words).toContain(w);
    // The phone greys its Issue button with these very sentences before the press.
    for (const sentence of unreviewedReasons(1, 1)) expect(refused.body.reasons).toContain(sentence);

    expect((await auth(request(app).post(`/health-record/quote-lines/${lineId}/confirm`)).send({})).status).toBe(200);
    // One thing still waiting: only the question's sentence remains.
    const stillRefused = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send({});
    expect(stillRefused.status).toBe(409);
    expect(stillRefused.body.reasons).toEqual(unreviewedReasons(0, 1));
    expect((await auth(request(app).post(`/health-record/quote-questions/${qId}/resolve`)).send({ resolutionNote: "Done." })).status).toBe(200);
    const issued = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send({});
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  });

  it("the shared sentence is plural-aware", () => {
    expect(unreviewedReasons(0, 0)).toEqual([]);
    expect(unreviewedReasons(3, 0)[0]).toContain("3 AI-suggested lines are still unconfirmed");
    expect(unreviewedReasons(0, 2)[0]).toContain("2 open questions are still unresolved");
  });
});

// ─── Build the draft (AI) ─────────────────────────────────────────────────────

describe("POST /health-record/quotes/:draftId/walkthrough/propose — the CRM's proposeWalkthroughForDraft", () => {
  it('with no model available answers path "basic" with the reason, writes nothing, and leaves usage off', async () => {
    const d = await newDraft("propose-basic");
    const before = await prisma.priceBookDraftLine.count({ where: { draftId: d.id } });
    const field = await auth(request(app).post(`/health-record/quotes/${d.id}/walkthrough/propose`)).send({ text: "5 duplex receptacles" });
    expect(field.status, JSON.stringify(field.body)).toBe(200);
    expect(field.body.data.path).toBe("basic");
    // The truck gets a fixed sentence, never the upstream error text (it is shown to the customer).
    expect(field.body.data.degradedReason).toBe("The AI helper is unavailable right now.");
    expect(JSON.stringify(field.body)).not.toContain("OPENAI_API_KEY");
    expect(field.body.data).toMatchObject({ proposed: [], questions: [], rejected: [] });
    expect(keysOf(field.body)).not.toContain("usage");
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id } })).toBe(before);

    // The CRM's answer is the same, plus the `usage` the office's route has always returned.
    const crm = await request(app).post(`/price-book/drafts/${d.id}/propose`).send({ text: "5 duplex receptacles" });
    expect(crm.status).toBe(200);
    const { usage, ...crmRest } = crm.body;
    expect(usage).toBeNull();
    // Same answer, except the reason: the office sees why, the truck sees a fixed sentence.
    expect(String(crmRest.degradedReason)).toContain("OPENAI_API_KEY");
    expect({ ...crmRest, degradedReason: field.body.data.degradedReason }).toEqual(field.body.data);
  });

  it("refuses an empty list, and a draft that is not the technician's", async () => {
    const d = await newDraft("propose-owner");
    expect((await auth(request(app).post(`/health-record/quotes/${d.id}/walkthrough/propose`)).send({ text: "   " })).status).toBeGreaterThanOrEqual(400);
    expect((await asStranger(request(app).post(`/health-record/quotes/${d.id}/walkthrough/propose`)).send({ text: "4 outlets" })).status).toBe(403);
    expect((await request(app).post(`/health-record/quotes/${d.id}/walkthrough/propose`).send({ text: "4 outlets" })).status).toBe(401);
  });

  it("a SIGNED draft is refused before any model call, with the same status and words on both doors", async () => {
    const d = await newDraft("propose-signed");
    await issueAndSign(d.id);
    const crm = await request(app).post(`/price-book/drafts/${d.id}/propose`).send({ text: "4 outlets" });
    const field = await auth(request(app).post(`/health-record/quotes/${d.id}/walkthrough/propose`)).send({ text: "4 outlets" });
    expect(crm.status).toBe(400);
    expect(field.status).toBe(400);
    expect(crm.body.error).toMatch(/SIGNED/);
    expect(field.body.error.message).toBe(crm.body.error);
  });
});

// ─── Basic match ──────────────────────────────────────────────────────────────

describe("POST /health-record/quote-catalog/resolve-walkthrough — the CRM's resolveWalkthroughRows", () => {
  const rows = [{ raw: "50 ft FSG cable by the foot" }, { raw: "zzqq qqzz xxyy" }];

  it("needs a technician's token", async () => {
    expect((await request(app).post("/health-record/quote-catalog/resolve-walkthrough").send({ rows })).status).toBe(401);
  });

  it("returns exactly the rows the CRM's route returns for the same list", async () => {
    const field = await auth(request(app).post("/health-record/quote-catalog/resolve-walkthrough")).send({ rows });
    const crm = await request(app).post("/price-book/resolve-walkthrough").send({ rows });
    expect(field.status, JSON.stringify(field.body)).toBe(200);
    expect(field.body.data.rows).toEqual(crm.body.rows);
    expect(field.body.data.rows[0].status).not.toBe("UNMATCHED");
    const foot = field.body.data.rows[0].candidates.find((c: { itemId: string }) => c.itemId === FT);
    expect(foot).toMatchObject({ itemId: FT, description: "FSG cable by the foot", unit: "ft", isContinuousLength: true });
    expect(field.body.data.rows[1]).toMatchObject({ status: "UNMATCHED", candidates: [] });
  });

  it("carries words and yes/no badges only — the one number is the quantity the tech typed", async () => {
    const field = await auth(request(app).post("/health-record/quote-catalog/resolve-walkthrough")).send({ rows });
    for (const row of field.body.data.rows as Array<Record<string, unknown> & { candidates: Array<Record<string, unknown>> }>) {
      expect(Object.keys(row).sort()).toEqual(["candidates", "matchedOn", "parsedQuantity", "raw", "searchTerm", "status", "unknownWords"]);
      for (const c of row.candidates) {
        expect(Object.keys(c).sort()).toEqual(["description", "hasLabourUnitBasis", "hasPriceAtActiveSupplier", "isContinuousLength", "itemId", "unit"]);
        for (const [k, v] of Object.entries(c)) expect(typeof v === "number", `${k} is a number`).toBe(false);
      }
    }
    const text = JSON.stringify(field.body);
    for (const banned of ["laborNormal", "laborDifficult", "costBasisUsed", "sellPricePerUnit"]) expect(text).not.toContain(banned);
  });

  it("refuses more than 100 rows and a blank row", async () => {
    const tooMany = Array.from({ length: 101 }, () => ({ raw: "outlet" }));
    expect((await auth(request(app).post("/health-record/quote-catalog/resolve-walkthrough")).send({ rows: tooMany })).status).toBeGreaterThanOrEqual(400);
    expect((await auth(request(app).post("/health-record/quote-catalog/resolve-walkthrough")).send({ rows: [{ raw: "  " }] })).status).toBeGreaterThanOrEqual(400);
  });

  it('"+ Add to quote" is an ordinary add-line with the walkthrough note — nothing was added by the match', async () => {
    const d = await newDraft("match-add", false);
    const matched = await auth(request(app).post("/health-record/quote-catalog/resolve-walkthrough")).send({ rows });
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id } })).toBe(0);
    const itemId = (matched.body.data.rows[0].candidates as Array<{ itemId: string }>).find((c) => c.itemId === FT)!.itemId;
    const add = await auth(request(app).post(`/health-record/quotes/${d.id}/lines`)).send({ itemId, quantity: 1, option: "A", note: `From walkthrough: "${rows[0]!.raw}"` });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    const line = await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: add.body.data.lineId } });
    expect(line).toMatchObject({ itemId: FT, state: "CONFIRMED", note: `From walkthrough: "50 ft FSG cable by the foot"` });
  });
});
