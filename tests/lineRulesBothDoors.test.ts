/**
 * One estimating system, two doors (Kyle, 2026-10-08) — Phase 0, unit 0c: line rules.
 *
 * Three rules that the CRM routes and the tech routes each used to carry their own version of,
 * now decided once in the service (src/services/atomicEstimateService.ts):
 *
 *   1. CREDIT LINES. The CRM said `z.number().positive()` and refused a change order's negative
 *      count before the service saw it; the field said "non-zero" and let `assertQuantityAllowed`
 *      decide. One schema (`lineQuantitySchema`), one rule: a negative is legal on a change
 *      order and a typo anywhere else, from either app.
 *
 *   2. QUANTITY IS JUST A NUMBER. Kyle: "We just need a number not type." The service sets
 *      quantitySource from the item (MEASURED_LENGTH when sold by length, else COUNT) and ignores
 *      whatever a caller sent. Old MANUAL / TERMINATION_COUNT rows keep their value until a
 *      person re-saves their quantity.
 *
 *   3. LINE ORDER. A line added without a position lands at the END (max sortOrder + 1), not at
 *      0 — otherwise the first line added after a draft was arranged jumps to the top. AI
 *      proposals use max + 1 rather than a row count, and a copied option lands after the lines
 *      already in the draft.
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
import {
  addLine,
  computeDraft,
  confirmProposedLine,
  copyOptionLines,
  createDraft,
  editLine,
  proposeLines,
  quantitySourceFor,
  removeLine,
} from "../src/services/atomicEstimateService";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "LINERULES";
const EA = "LRULE-EA";
const FT = "LRULE-FT";
const LF = "LRULE-LF";
const HR = "LRULE-HR";
const ALL_ITEMS = [EA, FT, LF, HR];

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
  await seedAtomics([
    quotableAtomic(EA, { unit: "ea" }),
    quotableAtomic(FT, { unit: "ft" }),
    quotableAtomic(LF, { unit: "lf" }),
    quotableAtomic(HR, { unit: "hr" }),
  ]);
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "linerules@example.com", phone: "615-555-0177" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "1 Line Rules Way", city: "Murfreesboro", state: "TN", postalCode: "37127" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" },
  });
  visitId = visit.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `linerules-test-${customer.id}` } });
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
  await deleteAtomics(ALL_ITEMS);
});

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);

async function newDraft(title: string, extra: { changeOrderForId?: string } = {}) {
  // createDraft, not a bare insert: it stamps the billed-rate snapshot, which Issue needs.
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  if (extra.changeOrderForId) {
    return prisma.priceBookDraftEstimate.update({ where: { id: d.id }, data: { changeOrderForId: extra.changeOrderForId } });
  }
  return d;
}

/** An ordinary draft, issued, so there is a real estimate for a change order to point at. */
async function issuedRoot() {
  const d = await createDraft(prisma, { title: `${MARK} root`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: EA, quantity: 1 });
  const res = await request(app)
    .post(`/price-book/drafts/${d.id}/issue`)
    .send({ accountId: customerId, serviceAddressId: propertyId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { estimateId: string };
}

const sourceOf = async (lineId: string) =>
  (await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: lineId } })).quantitySource;

// ─── 1. CREDIT LINES ──────────────────────────────────────────────────────────────────────

describe("credit lines behave the same from the CRM and the field", () => {
  it("the CRM refuses a negative on an ordinary draft with the SERVICE's reason, and zero everywhere", async () => {
    const d = await newDraft("ordinary");
    const negative = await request(app).post(`/price-book/drafts/${d.id}/lines`).send({ itemId: EA, quantity: -1 });
    expect(negative.status).toBe(400);
    // The words come from assertQuantityAllowed, not from a zod `.positive()` in the route.
    expect(negative.body.error).toMatch(/only allowed on a change order/i);

    const zero = await request(app).post(`/price-book/drafts/${d.id}/lines`).send({ itemId: EA, quantity: 0 });
    expect(zero.status).toBe(400);
    expect(JSON.stringify(zero.body)).toMatch(/cannot be zero/i);
  });

  it("the CRM takes a negative line on a change order, edits a line to a negative, and confirms a proposal into one", async () => {
    const root = await issuedRoot();
    const co = await newDraft("change order", { changeOrderForId: root.estimateId });

    // The review payload is what tells the CRM screen to allow the minus sign.
    const review = await request(app).get(`/price-book/drafts/${co.id}/review`);
    expect(review.body.draft.changeOrderForId).toBe(root.estimateId);

    const added = await request(app).post(`/price-book/drafts/${co.id}/lines`).send({ itemId: EA, quantity: -1 });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.quantity).toBe(-1);

    const positive = await request(app).post(`/price-book/drafts/${co.id}/lines`).send({ itemId: EA, quantity: 2 });
    expect(positive.status).toBe(201);
    const edited = await request(app).patch(`/price-book/lines/${positive.body.id}`).send({ quantity: -3 });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.line.quantity).toBe(-3);

    // A proposal is always positive (the model may never propose a negative) — the person
    // confirming a change order's line may turn it into a credit.
    const proposed = await proposeLines(prisma, co.id, [{ itemId: EA, quantity: 1, reasoning: "test" }], [], "ai:test");
    const confirmed = await request(app).post(`/price-book/lines/${proposed.proposed[0]!.id}/confirm`).send({ quantity: -2 });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.line.quantity).toBe(-2);
  });

  it("an ordinary draft refuses a negative on edit and on confirm, from the CRM, with the same reason", async () => {
    const d = await newDraft("ordinary edit");
    const line = await addLine(prisma, d.id, { itemId: EA, quantity: 1 });
    const edit = await request(app).patch(`/price-book/lines/${line.id}`).send({ quantity: -1 });
    expect(edit.status).toBe(400);
    expect(edit.body.error).toMatch(/only allowed on a change order/i);

    const proposed = await proposeLines(prisma, d.id, [{ itemId: EA, quantity: 1, reasoning: "test" }], [], "ai:test");
    const confirm = await request(app).post(`/price-book/lines/${proposed.proposed[0]!.id}/confirm`).send({ quantity: -1 });
    expect(confirm.status).toBe(400);
    expect(confirm.body.error).toMatch(/only allowed on a change order/i);
  });

  it("the field gives the same answer as the CRM for the same draft and the same quantity", async () => {
    const root = await issuedRoot();
    const co = await newDraft("change order, both doors", { changeOrderForId: root.estimateId });
    const plain = await newDraft("ordinary, both doors");

    for (const [draft, quantity, expected] of [
      [plain, -1, 400],
      [co, -1, 201],
      [plain, 0, 400],
      [co, 0, 400],
    ] as const) {
      const crm = await request(app).post(`/price-book/drafts/${draft.id}/lines`).send({ itemId: EA, quantity });
      const field = await auth(request(app).post(`/health-record/quotes/${draft.id}/lines`)).send({ itemId: EA, quantity });
      // Zero is a validation error on both doors, but each door wraps it its own way (CRM 400,
      // field 422) — what must agree is that it is refused. Negative must agree exactly.
      if (quantity === 0) {
        expect(crm.status).toBe(400);
        expect(field.status).toBe(422);
      } else {
        expect(crm.status, `CRM ${quantity} on ${draft.title}`).toBe(expected);
        expect(field.status, `field ${quantity} on ${draft.title}`).toBe(expected);
      }
      if (quantity < 0 && expected === 400) {
        expect(crm.body.error).toBe(field.body.error.message);
      }
    }
  });
});

// ─── 2. QUANTITY IS JUST A NUMBER ────────────────────────────────────────────────────────

describe("quantity is just a number — the service sets quantitySource from the item", () => {
  it("quantitySourceFor: length items (ft, lf) are measured; everything else, hourly included, is counted", () => {
    expect(quantitySourceFor({ unit: "ft" })).toBe("MEASURED_LENGTH");
    expect(quantitySourceFor({ unit: " LF " })).toBe("MEASURED_LENGTH");
    expect(quantitySourceFor({ unit: "ea" })).toBe("COUNT");
    expect(quantitySourceFor({ unit: "hr" })).toBe("COUNT");
    expect(quantitySourceFor({ unit: null })).toBe("COUNT");
  });

  it("addLine ignores a source it is handed — through the service, the CRM route and the tech route", async () => {
    const d = await newDraft("sources");
    // Service: a caller claiming MANUAL for a counted item, COUNT for a cable.
    const a = await addLine(prisma, d.id, { itemId: EA, quantity: 2, quantitySource: "MANUAL" });
    const b = await addLine(prisma, d.id, { itemId: FT, quantity: 100, quantitySource: "COUNT" });
    expect(await sourceOf(a.id)).toBe("COUNT");
    expect(await sourceOf(b.id)).toBe("MEASURED_LENGTH");

    // CRM route: the field is not in the schema, so it is dropped, not refused.
    const crm = await request(app)
      .post(`/price-book/drafts/${d.id}/lines`)
      .send({ itemId: LF, quantity: 50, quantitySource: "TERMINATION_COUNT" });
    expect(crm.status, JSON.stringify(crm.body)).toBe(201);
    expect(await sourceOf(crm.body.id)).toBe("MEASURED_LENGTH");

    // Tech route: same.
    const tech = await auth(request(app).post(`/health-record/quotes/${d.id}/lines`)).send({ itemId: EA, quantity: 3, quantitySource: "MANUAL" });
    expect(tech.status, JSON.stringify(tech.body)).toBe(201);
    expect(await sourceOf(tech.body.data.lineId)).toBe("COUNT");

    // An hourly item's quantity is hours; it is stored as a count, as it always was.
    const hr = await request(app).post(`/price-book/drafts/${d.id}/lines`).send({ itemId: HR, quantity: 2 });
    expect(await sourceOf(hr.body.id)).toBe("COUNT");
  });

  it("proposals take the item's source whatever the model said, and no longer copy the reasoning into the note", async () => {
    const d = await newDraft("proposals");
    const res = await proposeLines(
      prisma,
      d.id,
      [
        { itemId: EA, quantity: 2, quantitySource: "MANUAL", reasoning: "model picked manual" },
        { itemId: FT, quantity: 40, quantitySource: "COUNT", reasoning: "model picked count" },
      ],
      [],
      "ai:test",
    );
    const [ea, ft] = await Promise.all(res.proposed.map((p) => prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: p.id } })));
    expect(ea!.quantitySource).toBe("COUNT");
    expect(ea!.note).toBeNull();
    expect(ea!.proposalReasoning).toBe("model picked manual");
    expect(ft!.quantitySource).toBe("MEASURED_LENGTH");
  });

  it("confirming a proposal sets the source from the item — including one the model stored as MANUAL before this rule", async () => {
    const d = await newDraft("confirm");
    const legacy = await prisma.priceBookDraftLine.create({
      data: { draftId: d.id, itemId: EA, quantity: 1, quantitySource: "MANUAL", state: "PROPOSED", proposedBy: "ai:old", proposalReasoning: "old" },
    });
    // The route no longer accepts a source; one in the body is ignored.
    const res = await request(app).post(`/price-book/lines/${legacy.id}/confirm`).send({ quantitySource: "TERMINATION_COUNT" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.line.quantitySource).toBe("COUNT");
    // The edit flag follows quantity and difficulty only — a source change is not an "edit".
    expect(res.body.line.editedBeforeConfirm).toBe(false);

    const viaService = await prisma.priceBookDraftLine.create({
      data: { draftId: d.id, itemId: FT, quantity: 10, quantitySource: "COUNT", state: "PROPOSED", proposedBy: "ai:old", proposalReasoning: "old" },
    });
    const confirmed = await confirmProposedLine(prisma, viaService.id, "human:test");
    expect(confirmed.quantitySource).toBe("MEASURED_LENGTH");
  });

  it("an old MANUAL row keeps its value through a note edit and is cleared only when its quantity is re-saved", async () => {
    const d = await newDraft("legacy");
    const legacy = await prisma.priceBookDraftLine.create({
      data: { draftId: d.id, itemId: EA, quantity: 2, quantitySource: "MANUAL", state: "CONFIRMED", confirmedBy: "human:old", confirmedAt: new Date() },
    });
    const noteOnly = await request(app).patch(`/price-book/lines/${legacy.id}`).send({ note: "kitchen", quantitySource: "COUNT" });
    expect(noteOnly.status).toBe(200);
    expect(await sourceOf(legacy.id)).toBe("MANUAL"); // history is not rewritten by a note edit
    // ...and the sent source was ignored, not obeyed.

    const requantified = await request(app).patch(`/price-book/lines/${legacy.id}`).send({ quantity: 2 });
    expect(requantified.status).toBe(200);
    expect(await sourceOf(legacy.id)).toBe("COUNT");

    // Same through the service and the tech route.
    const other = await prisma.priceBookDraftLine.create({
      data: { draftId: d.id, itemId: FT, quantity: 5, quantitySource: "TERMINATION_COUNT", state: "CONFIRMED", confirmedBy: "human:old", confirmedAt: new Date() },
    });
    await editLine(prisma, other.id, { difficulty: "DIFFICULT" });
    expect(await sourceOf(other.id)).toBe("TERMINATION_COUNT");
    const viaTech = await auth(request(app).patch(`/health-record/quote-lines/${other.id}`)).send({ quantity: 6, quantitySource: "MANUAL" });
    expect(viaTech.status).toBe(200);
    expect(await sourceOf(other.id)).toBe("MEASURED_LENGTH");
  });

  it("REPORTED: an old MANUAL line with no note does NOT block Issue — it only shows the gap, until its quantity is re-saved", async () => {
    // The engine's MANUAL_QUANTITY_WITHOUT_NOTE gap reads the STORED source. Kyle (2026-08-20)
    // turned every such check into a warning ("Nothing should block me from completing the
    // estimate"), so an old MANUAL row cannot stop an estimate being issued. It still carries the
    // amber gap on its line, because the new rule deliberately does not rewrite history; saving
    // the quantity (Edit, Save on the line) re-enters it as a plain number and clears the gap.
    const d = await newDraft("legacy gap");
    const legacy = await prisma.priceBookDraftLine.create({
      data: { draftId: d.id, itemId: EA, quantity: 2, quantitySource: "MANUAL", state: "CONFIRMED", confirmedBy: "human:old", confirmedAt: new Date() },
    });
    const gapsOf = async () => (await computeDraft(prisma, d.id)).computed.lines.find((l) => l.id === legacy.id)!.gaps.map((g) => g.kind);
    expect(await gapsOf()).toContain("MANUAL_QUANTITY_WITHOUT_NOTE");

    const issued = await request(app)
      .post(`/price-book/drafts/${d.id}/issue`)
      .send({ accountId: customerId, serviceAddressId: propertyId });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);

    const resaved = await request(app).patch(`/price-book/lines/${legacy.id}`).send({ quantity: 2 });
    expect(resaved.status).toBe(200);
    expect(await gapsOf()).not.toContain("MANUAL_QUANTITY_WITHOUT_NOTE");
  });
});

// ─── 3. LINE ORDER ───────────────────────────────────────────────────────────────────────

describe("a line added without a position lands at the end", () => {
  it("numbers hand-added lines 0, 1, 2 and lands the next one after an arranged draft, not at the top", async () => {
    const d = await newDraft("order");
    const l1 = await addLine(prisma, d.id, { itemId: EA, quantity: 1 });
    const l2 = await addLine(prisma, d.id, { itemId: EA, quantity: 1 });
    const l3 = await addLine(prisma, d.id, { itemId: EA, quantity: 1 });
    expect([l1.sortOrder, l2.sortOrder, l3.sortOrder]).toEqual([0, 1, 2]);

    // Kyle arranges the draft (drag-and-drop renumbers it): 5, 3, 9.
    await prisma.priceBookDraftLine.update({ where: { id: l1.id }, data: { sortOrder: 5 } });
    await prisma.priceBookDraftLine.update({ where: { id: l2.id }, data: { sortOrder: 3 } });
    await prisma.priceBookDraftLine.update({ where: { id: l3.id }, data: { sortOrder: 9 } });
    const next = await addLine(prisma, d.id, { itemId: EA, quantity: 1 });
    expect(next.sortOrder).toBe(10);

    // Through the CRM and tech routes too — same function.
    const crm = await request(app).post(`/price-book/drafts/${d.id}/lines`).send({ itemId: EA, quantity: 1 });
    expect(crm.body.sortOrder).toBe(11);
    const tech = await auth(request(app).post(`/health-record/quotes/${d.id}/lines`)).send({ itemId: EA, quantity: 1 });
    const techRow = await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: tech.body.data.lineId } });
    expect(techRow.sortOrder).toBe(12);
  });

  it("an all-zero draft (every line added before this rule) gets 1, so the new line still lands last", async () => {
    const d = await newDraft("all zeros");
    await prisma.priceBookDraftLine.createMany({
      data: [0, 1].map(() => ({ draftId: d.id, itemId: EA, quantity: 1, quantitySource: "COUNT" as const, state: "CONFIRMED" as const, sortOrder: 0 })),
    });
    const next = await addLine(prisma, d.id, { itemId: EA, quantity: 1 });
    expect(next.sortOrder).toBe(1);
  });

  it("an empty draft starts at 0, and an explicit sortOrder is still honoured", async () => {
    const d = await newDraft("empty");
    expect((await addLine(prisma, d.id, { itemId: EA, quantity: 1 })).sortOrder).toBe(0);
    expect((await addLine(prisma, d.id, { itemId: EA, quantity: 1, sortOrder: 40 })).sortOrder).toBe(40);
    expect((await addLine(prisma, d.id, { itemId: EA, quantity: 1 })).sortOrder).toBe(41);
  });

  it("removing the last line frees its number — max + 1 follows what is left", async () => {
    const d = await newDraft("delete");
    const a = await addLine(prisma, d.id, { itemId: EA, quantity: 1 });
    const b = await addLine(prisma, d.id, { itemId: EA, quantity: 1 });
    await removeLine(prisma, b.id);
    const c = await addLine(prisma, d.id, { itemId: EA, quantity: 1 });
    expect([a.sortOrder, c.sortOrder]).toEqual([0, 1]);
  });

  it("AI proposals continue from max + 1, not from a row count that can collide after a delete", async () => {
    const d = await newDraft("proposals order");
    await prisma.priceBookDraftLine.createMany({
      data: [
        { draftId: d.id, itemId: EA, quantity: 1, quantitySource: "COUNT" as const, state: "CONFIRMED" as const, sortOrder: 0 },
        { draftId: d.id, itemId: EA, quantity: 1, quantitySource: "COUNT" as const, state: "CONFIRMED" as const, sortOrder: 7 },
      ],
    });
    // Two rows, highest number 7. A count would have started at 2 and landed in the middle.
    const res = await proposeLines(
      prisma,
      d.id,
      [
        { itemId: EA, quantity: 1, reasoning: "one" },
        { itemId: EA, quantity: 1, reasoning: "two" },
      ],
      [],
      "ai:test",
    );
    const rows = await prisma.priceBookDraftLine.findMany({ where: { id: { in: res.proposed.map((p) => p.id) } }, orderBy: { sortOrder: "asc" } });
    expect(rows.map((r) => r.sortOrder)).toEqual([8, 9]);
  });

  it("a copied option lands after every line already in the draft, in the source's order", async () => {
    const d = await newDraft("copy");
    // Option A: two lines. Option B already holds one line Kyle placed at 5.
    const a1 = await addLine(prisma, d.id, { itemId: EA, quantity: 1, note: "a1", option: "A" });
    const a2 = await addLine(prisma, d.id, { itemId: EA, quantity: 2, note: "a2", option: "A" });
    const b0 = await addLine(prisma, d.id, { itemId: EA, quantity: 3, note: "b0", option: "B", sortOrder: 5 });
    expect([a1.sortOrder, a2.sortOrder]).toEqual([0, 1]);

    const out = await copyOptionLines(prisma, d.id, "A", "B");
    expect(out.copied).toBe(2);

    const inB = await prisma.priceBookDraftLine.findMany({
      where: { draftId: d.id, option: "B" },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    // Kyle's own line first, then the copies, in the order option A had them.
    expect(inB.map((l) => l.note)).toEqual(["b0", "a1", "a2"]);
    expect(inB[0]!.id).toBe(b0.id);
    expect(inB[1]!.sortOrder).toBe(6);
    expect(inB[2]!.sortOrder).toBe(7);
    // Option A is untouched.
    const inA = await prisma.priceBookDraftLine.findMany({ where: { draftId: d.id, option: "A" }, orderBy: { sortOrder: "asc" } });
    expect(inA.map((l) => l.sortOrder)).toEqual([0, 1]);
  });
});
