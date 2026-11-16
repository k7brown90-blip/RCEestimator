/**
 * The ballpark on a lead (Kyle, 2026-11-15, plan lead-intake-fixes F4).
 *
 * "Online ballparks are saved (never sent from the CRM) and adjusted after field observation." A lead
 * holds ONE saved ballpark: an ordinary draft in the existing Estimate Intake builder, tied to the
 * lead. This file pins what is different about it:
 *
 *   - POST /price-book/drafts takes the lead, and a second one for the same lead is refused;
 *   - GET /leads/:id carries it (title, total, updated);
 *   - while it has no visit it cannot be issued, finalized for the customer or attached, on the
 *     server — not just greyed in the builder — and the review payload says why;
 *   - converting the lead (any door: convertLeadToOpportunity) gives it the new visit, so the
 *     tech's Quote screen finds it by visitId and the lock lifts;
 *   - deleting the lead deletes it; a stub account's deletion hands it back to the lead;
 *   - Savannah (agent routes, MCP server) has no estimate or draft tool.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
        events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }), delete: vi.fn().mockResolvedValue({}) },
      }),
    },
  };
});
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: vi.fn().mockResolvedValue(true), sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { addLine } from "../src/services/atomicEstimateService";
import { BALLPARK_ON_LEAD_REASON } from "../shared/leadBallpark";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const TAG = "LBP";
const ITEM = "LBP-EA";

let technicianId: string;
let techToken: string;

async function wipe() {
  const drafts = await prisma.priceBookDraftEstimate.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
  const draftIds = drafts.map((d) => d.id);
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: draftIds } }, select: { id: true } });
  const estIds = ests.map((e) => e.id);
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateOption.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null, changeOrderForId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftOption.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.emailListMember.deleteMany({ where: { email: { contains: "lbp-" } } });
  await prisma.systemEvent.deleteMany({ where: { source: "leads-won" } });
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.visitAssignment.deleteMany({ where: { visit: { customer: { name: { startsWith: TAG } } } } });
  await prisma.visit.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.systemSnapshot.deleteMany({ where: { property: { customer: { name: { startsWith: TAG } } } } });
  await prisma.property.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ITEM, { unit: "ea" })]);
  const tech = await prisma.technician.create({ data: { name: `${TAG} Tech`, accessToken: `lbp-tech-${Date.now()}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
});
beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.technician.deleteMany({ where: { id: technicianId } });
  await deleteAtomics([ITEM]);
});

const tech = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);

/** A lead with only a city and ZIP, the way Yelp gives it — no street yet. */
async function partialLead(name = `${TAG} Steve`) {
  const res = await request(app).post("/crm/leads").send({ name, email: "lbp-steve@example.com", city: "Murfreesboro", postalCode: "37128" }).expect(201);
  return res.body.lead as { id: string; name: string };
}

async function startBallpark(leadId: string, title = `${TAG} Ballpark`) {
  const res = await request(app).post("/price-book/drafts").send({ title, leadId });
  return res;
}

async function ballparkWithLine(leadId: string) {
  const created = await startBallpark(leadId);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  await addLine(prisma, created.body.id, { itemId: ITEM, quantity: 2 });
  return created.body.id as string;
}

const FULL_ADDRESS = { addressLine1: "41 Ballpark Way", city: "Murfreesboro", state: "TN", postalCode: "37128", createNewAccount: true };

describe("starting a ballpark on a lead", () => {
  it("ties the draft to the lead, with no account, address or visit", async () => {
    const lead = await partialLead();
    const res = await startBallpark(lead.id);
    expect(res.status).toBe(201);
    expect(res.body.leadId).toBe(lead.id);
    expect(res.body.customerId).toBeNull();
    expect(res.body.visitId).toBeNull();
  });

  it("refuses a second ballpark for the same lead — one tool, one draft", async () => {
    const lead = await partialLead();
    await startBallpark(lead.id).then((r) => expect(r.status).toBe(201));
    const again = await startBallpark(lead.id, `${TAG} Second`);
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/already has a ballpark/);
    expect(await prisma.priceBookDraftEstimate.count({ where: { leadId: lead.id } })).toBe(1);
  });

  it("a copy of a ballpark that is still on the lead is not a second ballpark on it", async () => {
    const lead = await partialLead();
    const draftId = await ballparkWithLine(lead.id);
    const copy = await request(app).post(`/price-book/drafts/${draftId}/duplicate`).send({}).expect(201);
    const row = await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: copy.body.id } });
    expect(row.leadId).toBeNull();
    expect(await prisma.priceBookDraftEstimate.count({ where: { leadId: lead.id } })).toBe(1);
  });
});

describe("GET /leads/:leadId", () => {
  it("lists the lead's ballpark with title, total and updated", async () => {
    const lead = await partialLead();
    const draftId = await ballparkWithLine(lead.id);
    const res = await request(app).get(`/leads/${lead.id}`).expect(200);
    expect(res.body.ballparks).toHaveLength(1);
    const b = res.body.ballparks[0];
    expect(b).toMatchObject({ id: draftId, title: `${TAG} Ballpark`, status: "draft", visitId: null, lineCount: 1 });
    expect(typeof b.total).toBe("number");
    expect(b.total).toBeGreaterThan(0);
    expect(new Date(b.updatedAt).getTime()).not.toBeNaN();
  });

  it("is an empty list for a lead with none", async () => {
    const lead = await partialLead();
    const res = await request(app).get(`/leads/${lead.id}`).expect(200);
    expect(res.body.ballparks).toEqual([]);
  });
});

describe("while the ballpark sits on a lead it cannot be sent", () => {
  it("the review payload names the lock, so the builder can grey the send controls with the reason", async () => {
    const lead = await partialLead();
    const draftId = await ballparkWithLine(lead.id);
    const review = await request(app).get(`/price-book/drafts/${draftId}/review`).expect(200);
    expect(review.body.draft.ballparkLockReason).toBe(BALLPARK_ON_LEAD_REASON);
    expect(review.body.draft.lead).toEqual({ id: lead.id, name: lead.name });
    expect(review.body.draft.visitId).toBeNull();
  });

  it("POST /price-book/drafts/:id/issue is refused even with an account and address in the body", async () => {
    const lead = await partialLead();
    const draftId = await ballparkWithLine(lead.id);
    const customer = await prisma.customer.create({ data: { name: `${TAG} Somebody Else` } });
    const property = await prisma.property.create({
      data: { customerId: customer.id, name: "Elsewhere", addressLine1: "1 Elsewhere Rd", city: "Franklin", state: "TN", postalCode: "37064" },
    });
    const res = await request(app)
      .post(`/price-book/drafts/${draftId}/issue`)
      .send({ accountId: customer.id, serviceAddressId: property.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({ issued: false, reasons: [BALLPARK_ON_LEAD_REASON] });
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(0);
    expect((await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: draftId } })).status).toBe("draft");
  });

  it("POST /price-book/drafts/:id/finalize (customer) is refused and freezes nothing", async () => {
    const lead = await partialLead();
    const draftId = await ballparkWithLine(lead.id);
    const res = await request(app).post(`/price-book/drafts/${draftId}/finalize`).send({});
    expect(res.status).toBe(409);
    expect(res.body.reasons).toEqual([BALLPARK_ON_LEAD_REASON]);
    expect((await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: draftId } })).status).toBe("draft");
  });

  it("Attach-to-account is refused: a lead's ballpark reaches an account by converting the lead", async () => {
    const lead = await partialLead();
    const draftId = await ballparkWithLine(lead.id);
    const customer = await prisma.customer.create({ data: { name: `${TAG} Attach` } });
    const property = await prisma.property.create({
      data: { customerId: customer.id, name: "Attach", addressLine1: "2 Attach Rd", city: "Franklin", state: "TN", postalCode: "37064" },
    });
    const res = await request(app).post(`/price-book/drafts/${draftId}/attach`).send({ accountId: customer.id, serviceAddressId: property.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(BALLPARK_ON_LEAD_REASON);
  });

  it("an ordinary draft on an account and visit is not locked", async () => {
    const customer = await prisma.customer.create({ data: { name: `${TAG} Ordinary` } });
    const property = await prisma.property.create({
      data: { customerId: customer.id, name: "Ordinary", addressLine1: "3 Ordinary Rd", city: "Franklin", state: "TN", postalCode: "37064" },
    });
    const draft = await request(app).post("/price-book/drafts").send({ title: `${TAG} Ordinary draft`, customerId: customer.id }).expect(201);
    await addLine(prisma, draft.body.id, { itemId: ITEM, quantity: 1 });
    const review = await request(app).get(`/price-book/drafts/${draft.body.id}/review`).expect(200);
    expect(review.body.draft.ballparkLockReason).toBeNull();
    const issued = await request(app).post(`/price-book/drafts/${draft.body.id}/issue`).send({ accountId: customer.id, serviceAddressId: property.id });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  });
});

describe("converting the lead hands the ballpark to the consultation", () => {
  it("moves the draft onto the new visit; the lock lifts and the lead still shows it", async () => {
    const lead = await partialLead();
    const draftId = await ballparkWithLine(lead.id);
    await request(app).patch(`/leads/${lead.id}`).send({ addressLine1: FULL_ADDRESS.addressLine1, state: "TN" }).expect(200);

    const res = await request(app).patch(`/leads/${lead.id}/convert`).send({ createNewAccount: true }).expect(200);

    const row = await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: draftId } });
    expect(row.visitId).toBe(res.body.visit.id);
    expect(row.customerId).toBe(res.body.customer.id);
    expect(row.leadId).toBe(lead.id);
    expect(row.status).toBe("draft");

    const review = await request(app).get(`/price-book/drafts/${draftId}/review`).expect(200);
    expect(review.body.draft.ballparkLockReason).toBeNull();

    const after = await request(app).get(`/leads/${lead.id}`).expect(200);
    expect(after.body.ballparks).toHaveLength(1);
    expect(after.body.ballparks[0].visitId).toBe(res.body.visit.id);
  });

  it("refuses a new ballpark on a converted lead — it could never be unlocked", async () => {
    const lead = await partialLead();
    const draftId = await ballparkWithLine(lead.id);
    await request(app).patch(`/leads/${lead.id}`).send({ addressLine1: FULL_ADDRESS.addressLine1, state: "TN" }).expect(200);
    await request(app).patch(`/leads/${lead.id}/convert`).send({ createNewAccount: true }).expect(200);
    await request(app).delete(`/price-book/drafts/${draftId}`).expect((r) => expect(r.status).toBeLessThan(300));

    const again = await startBallpark(lead.id, `${TAG} After convert`);
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/already converted/);
    expect(await prisma.priceBookDraftEstimate.count({ where: { leadId: lead.id } })).toBe(0);
  });

  it("a moved ballpark whose job was deleted is not locked for good (its lead is already converted)", async () => {
    const lead = await partialLead();
    const draftId = await ballparkWithLine(lead.id);
    await request(app).patch(`/leads/${lead.id}`).send({ addressLine1: FULL_ADDRESS.addressLine1, state: "TN" }).expect(200);
    await request(app).patch(`/leads/${lead.id}/convert`).send({ createNewAccount: true }).expect(200);
    // Deleting the visit leaves visitId null (onDelete: SetNull) with leadId still set.
    await prisma.priceBookDraftEstimate.update({ where: { id: draftId }, data: { visitId: null } });

    const review = await request(app).get(`/price-book/drafts/${draftId}/review`).expect(200);
    expect(review.body.draft.ballparkLockReason).toBeNull();
  });

  it("the field Quote screen opens that same draft (workingDraftForVisit finds it by visitId) and resumes it", async () => {
    const lead = await partialLead();
    const draftId = await ballparkWithLine(lead.id);
    await request(app).patch(`/leads/${lead.id}`).send({ addressLine1: FULL_ADDRESS.addressLine1, state: "TN" }).expect(200);
    const res = await request(app).patch(`/leads/${lead.id}/convert`).send({ createNewAccount: true }).expect(200);
    const visitId: string = res.body.visit.id;
    await prisma.visitAssignment.create({ data: { visitId, technicianId } });

    const read = await tech(request(app).get(`/health-record/visits/${visitId}/quote`));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.draftId).toBe(draftId);

    // "Build the quote" resumes it rather than starting a second draft.
    const open = await tech(request(app).post(`/health-record/visits/${visitId}/quote`));
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect(open.body.data).toEqual({ draftId, resumed: true });
    expect(await prisma.priceBookDraftEstimate.count({ where: { visitId } })).toBe(1);

    // And it is the same draft, with the office's line on it, in the field's quote payload.
    const payload = await tech(request(app).get(`/health-record/quotes/${draftId}`));
    expect(payload.status, JSON.stringify(payload.body)).toBe(200);
    expect(payload.body.data.title).toBe(`${TAG} Ballpark`);
    expect(JSON.stringify(payload.body.data)).toContain(ITEM);
  });

  it("moves it through the Mark-won door too (the same function serves Confirm booking) (one function, inside its transaction)", async () => {
    const lead = await partialLead();
    const draftId = await ballparkWithLine(lead.id);
    await request(app).patch(`/leads/${lead.id}`).send({ addressLine1: FULL_ADDRESS.addressLine1, state: "TN" }).expect(200);
    process.env.WEBHOOK_SECRET = "lbp-secret";
    const won = await request(app).patch(`/leads/${lead.id}/won`).set("webhook_secret", "lbp-secret").send({});
    expect(won.status, JSON.stringify(won.body)).toBeLessThan(300);
    const row = await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: draftId } });
    expect(row.visitId).not.toBeNull();
  });

  it("a refused conversion (no street yet) leaves the ballpark on the lead, locked", async () => {
    const lead = await partialLead();
    const draftId = await ballparkWithLine(lead.id);
    await request(app).patch(`/leads/${lead.id}/convert`).send({ createNewAccount: true }).expect(400);
    const row = await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: draftId } });
    expect(row.visitId).toBeNull();
    expect(row.leadId).toBe(lead.id);
  });

  it("only moves the lead's plain working draft: one already on a visit stays where it is", async () => {
    const lead = await partialLead();
    const other = await prisma.customer.create({ data: { name: `${TAG} Other Job` } });
    const prop = await prisma.property.create({
      data: { customerId: other.id, name: "Other", addressLine1: "9 Other Rd", city: "Franklin", state: "TN", postalCode: "37064" },
    });
    const otherVisit = await prisma.visit.create({ data: { customerId: other.id, propertyId: prop.id, mode: "onsite", status: "scheduled" } });
    const onVisit = await request(app).post("/price-book/drafts").send({ title: `${TAG} On another visit`, leadId: lead.id, visitId: otherVisit.id }).expect(201);
    await request(app).patch(`/leads/${lead.id}`).send({ addressLine1: FULL_ADDRESS.addressLine1, state: "TN" }).expect(200);
    await request(app).patch(`/leads/${lead.id}/convert`).send({ createNewAccount: true }).expect(200);
    const row = await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: onVisit.body.id } });
    expect(row.visitId).toBe(otherVisit.id);
  });

  it("a stub account deleted before any work hands the ballpark back to the lead (SetNull keeps leadId)", async () => {
    const lead = await partialLead();
    const draftId = await ballparkWithLine(lead.id);
    await request(app).patch(`/leads/${lead.id}`).send({ addressLine1: FULL_ADDRESS.addressLine1, state: "TN" }).expect(200);
    const res = await request(app).patch(`/leads/${lead.id}/convert`).send({ createNewAccount: true }).expect(200);
    const del = await request(app).delete(`/customers/${res.body.customer.id}`);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    const row = await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: draftId } });
    expect(row).toMatchObject({ leadId: lead.id, visitId: null, customerId: null });
    // On the lead again, so it is locked again and reachable from the lead drawer.
    const back = await request(app).get(`/leads/${lead.id}`).expect(200);
    expect(back.body.ballparks.map((b: { id: string }) => b.id)).toEqual([draftId]);
  });
});

describe("deleting a lead deletes its unsent ballpark", () => {
  it("removes the draft and its lines", async () => {
    const lead = await partialLead();
    const draftId = await ballparkWithLine(lead.id);
    await request(app).delete(`/leads/${lead.id}`).expect(204);
    expect(await prisma.priceBookDraftEstimate.count({ where: { id: draftId } })).toBe(0);
    expect(await prisma.priceBookDraftLine.count({ where: { draftId } })).toBe(0);
  });

  it("leaves another lead's ballpark alone", async () => {
    const a = await partialLead(`${TAG} A`);
    const b = await partialLead(`${TAG} B`);
    await ballparkWithLine(a.id);
    const keep = await ballparkWithLine(b.id);
    await request(app).delete(`/leads/${a.id}`).expect(204);
    expect(await prisma.priceBookDraftEstimate.count({ where: { id: keep } })).toBe(1);
  });

  it("the ballpark can also be deleted by itself from the lead (the builder's Delete draft, same route)", async () => {
    const lead = await partialLead();
    const draftId = await ballparkWithLine(lead.id);
    await request(app).delete(`/price-book/drafts/${draftId}`).expect(200);
    const res = await request(app).get(`/leads/${lead.id}`).expect(200);
    expect(res.body.ballparks).toEqual([]);
    // and the lead may start a new one
    await startBallpark(lead.id).then((r) => expect(r.status).toBe(201));
  });
});

describe("Savannah is not part of the estimating system", () => {
  // Narrower than "touches no draft": the pre-existing MCP tool propose_estimate_lines can still add
  // PROPOSED (unpriced, unsendable) lines to any draftId. This checks no Savannah file names or
  // creates a ballpark.
  it("no agent route, agent instruction or MCP tool names or creates a ballpark", () => {
    const src = join(__dirname, "..", "src");
    const files = [
      ...readdirSync(join(src, "routes")).filter((f) => f.startsWith("agent")).map((f) => join(src, "routes", f)),
      join(src, "agentInstructions.ts"),
      join(src, "mcp", "server.ts"),
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/price-book\/drafts|priceBookDraftEstimate|createDraft\(|leadBallpark|ballpark/i);
    }
  });
});
