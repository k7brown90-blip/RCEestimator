/**
 * Options D-H and line order — ONE service, two doors (Kyle, 2026-10-08; one-estimating-system
 * plan, Phase 1 unit 1a).
 *
 * Kyle: "I want to be able to add more than 3 options for projects that are more expansive. I want
 * to have a create additional option button here which will continue the options past 'C'." and
 * "I would like to be able to drag and drop line items on the review screen."
 *
 * Add option, remove option and save line order are each ONE function in
 * src/services/atomicEstimateService.ts. The CRM routes (src/app.ts) and the tech routes
 * (src/routes/health-record.ts, behind quoteDraftForTech) are thin wrappers over it. Every rule is
 * pinned here from BOTH doors, so a check that exists on one and not the other fails a test:
 *
 *   - which options a draft has: A, B, C always + any letter with a row or a line; the SAME
 *     object (`optionSet`) in the CRM review payload and the tech quote payload;
 *   - add: lowest free letter after C, refused past H, hard refusal on a signed draft, reopens a
 *     finalized-unsigned one, and a refused press does NOT reopen anything;
 *   - remove: D-H only, takes the option's lines with it in one transaction and says how many,
 *     leaves the other letters alone (no re-lettering), same guard;
 *   - line order: the FULL list or nothing — a foreign line id, an incomplete list, a duplicate,
 *     an unknown option, an option the draft does not have, a signed draft: all refused, nothing
 *     written.
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
  addOption,
  createDraft,
  getDraftOptionSet,
  getDraftReview,
  removeLine,
  removeOption,
  saveLineOrder,
} from "../src/services/atomicEstimateService";
import { reviseEstimate } from "../src/services/issuedEstimateService";
import { OPTION_LIMIT_REASON, nextFreeOption } from "../shared/estimateOptions";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "OPTLINEORDER";
const ITEM = "OLO-EA";

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;
let strangerId: string;
let strangerToken: string;
const draftIds: string[] = [];

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

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ITEM, { unit: "ea" })]);
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "optlineorder@example.com", phone: "615-555-0188" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "1 Option Order Way", city: "Murfreesboro", state: "TN", postalCode: "37127" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" },
  });
  visitId = visit.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `optlineorder-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.visitAssignment.create({ data: { visitId, technicianId } });
  // A second technician who is NOT assigned to the visit.
  const stranger = await prisma.technician.create({ data: { name: `${MARK} Stranger`, accessToken: `optlineorder-stranger-${customer.id}` } });
  strangerId = stranger.id;
  strangerToken = stranger.accessToken;
});

afterAll(async () => {
  await cleanEstimatesFor(draftIds);
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftOption.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId } });
  await prisma.technician.deleteMany({ where: { id: { in: [technicianId, strangerId] } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ITEM]);
});

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);

/** An empty draft on the shared visit — createDraft stamps the rate snapshot Issue needs. */
async function newDraft(title: string) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  return d;
}

/** A draft with `n` lines in option A (so it can be issued). */
async function draftWithLines(title: string, n = 1) {
  const d = await newDraft(title);
  for (let i = 0; i < n; i++) await addLine(prisma, d.id, { itemId: ITEM, quantity: i + 1 });
  return d;
}

async function issueFromOffice(draftId: string) {
  const res = await request(app)
    .post(`/price-book/drafts/${draftId}/issue`)
    .send({ accountId: customerId, serviceAddressId: propertyId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { estimateId: string };
}

/** Issued (so "finalized") but not signed — the draft that REOPENS for an edit. */
async function finalizedDraft(title: string) {
  const d = await draftWithLines(title);
  await issueFromOffice(d.id);
  expect(await statusOf(d.id)).toBe("finalized");
  return d;
}

/** Issued and SIGNED — the draft that stays shut. */
async function signedDraft(title: string) {
  const d = await draftWithLines(title);
  const issued = await issueFromOffice(d.id);
  const res = await request(app)
    .post(`/issued-estimates/${issued.estimateId}/sign-in-person`)
    .send({ signerName: "Mrs Option Order", signatureImage: TEST_SIGNATURE, selectedOptions: ["A"] });
  expect(res.body, `the signature was refused: ${JSON.stringify(res.body)}`).toMatchObject({ signed: true });
  expect(await statusOf(d.id)).toBe("finalized");
  return d;
}

const statusOf = async (draftId: string) =>
  (await prisma.priceBookDraftEstimate.findUniqueOrThrow({ where: { id: draftId } })).status;

const letters = async (draftId: string) =>
  (await getDraftOptionSet(prisma, draftId)).options.map((o) => o.option);

const rowLetters = async (draftId: string) =>
  (await prisma.priceBookDraftOption.findMany({ where: { draftId }, orderBy: { option: "asc" } })).map((r) => r.option);

/** The draft's lines as [option, sortOrder] in id order given. */
async function placed(ids: string[]) {
  const rows = await prisma.priceBookDraftLine.findMany({ where: { id: { in: ids } } });
  return ids.map((id) => {
    const r = rows.find((x) => x.id === id)!;
    return `${r.option}${r.sortOrder}`;
  });
}

// ─── Which options a draft has ────────────────────────────────────────────────────────────

describe("which options a draft has — one function, both payloads", () => {
  it("nextFreeOption fills the lowest free letter after C and is null when full", () => {
    expect(nextFreeOption(["A", "B", "C"])).toBe("D");
    expect(nextFreeOption(["A", "B", "C", "D", "F"])).toBe("E");
    expect(nextFreeOption(["A", "B", "C", "E", "F"])).toBe("D");
    expect(nextFreeOption(["A", "B", "C", "D", "E", "F", "G", "H"])).toBeNull();
    // A, B and C are never offered, even if the caller forgot to list them.
    expect(nextFreeOption([])).toBe("D");
  });

  it("a fresh draft has A, B, C — none removable — and offers D", async () => {
    const d = await newDraft("fresh");
    const set = await getDraftOptionSet(prisma, d.id);
    expect(set.options.map((o) => o.option)).toEqual(["A", "B", "C"]);
    expect(set.options.every((o) => o.removable === false)).toBe(true);
    expect(set.nextOption).toBe("D");
  });

  it("a letter counts when it has a row OR a line, and carries its name and line count", async () => {
    const d = await newDraft("row-or-line");
    await prisma.priceBookDraftOption.create({ data: { draftId: d.id, option: "E", label: "Pool pump" } });
    await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, option: "G" });
    await addLine(prisma, d.id, { itemId: ITEM, quantity: 2, option: "G" });
    const set = await getDraftOptionSet(prisma, d.id);
    expect(set.options.map((o) => o.option)).toEqual(["A", "B", "C", "E", "G"]);
    const e = set.options.find((o) => o.option === "E")!;
    expect(e).toMatchObject({ label: "Pool pump", lineCount: 0, removable: true });
    expect(set.options.find((o) => o.option === "G")).toMatchObject({ label: null, lineCount: 2, removable: true });
    expect(set.nextOption).toBe("D");
  });

  it("the CRM review payload and the tech quote payload carry the SAME optionSet", async () => {
    const d = await draftWithLines("same-payload");
    await request(app).post(`/price-book/drafts/${d.id}/options`).send({});
    const crm = await request(app).get(`/price-book/drafts/${d.id}/review`);
    expect(crm.status).toBe(200);
    const tech = await auth(request(app).get(`/health-record/quotes/${d.id}`));
    expect(tech.status, JSON.stringify(tech.body)).toBe(200);
    expect(crm.body.optionSet.options.map((o: { option: string }) => o.option)).toEqual(["A", "B", "C", "D"]);
    expect(tech.body.data.optionSet).toEqual(crm.body.optionSet);
    expect((await getDraftReview(prisma, d.id)).optionSet).toEqual(crm.body.optionSet);
    // The field payload still never carries labour hours (constants.md:520-526).
    expect(JSON.stringify(tech.body.data.optionSet)).not.toMatch(/laborHours|laborDollars/);
  });
});

// ─── Add option ───────────────────────────────────────────────────────────────────────────

describe("Add option", () => {
  it("CRM: creates D (label null), then E; the empty option survives a reload", async () => {
    const d = await draftWithLines("add-crm");
    const first = await request(app).post(`/price-book/drafts/${d.id}/options`).send({});
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.option).toBe("D");
    expect(first.body.optionSet.nextOption).toBe("E");
    const second = await request(app).post(`/price-book/drafts/${d.id}/options`).send({});
    expect(second.body.option).toBe("E");
    const rows = await prisma.priceBookDraftOption.findMany({ where: { draftId: d.id }, orderBy: { option: "asc" } });
    expect(rows.map((r) => [r.option, r.label, r.note])).toEqual([["D", null, null], ["E", null, null]]);
    // No line is in D or E, yet both are there after a reload — the engine alone would drop them.
    const review = await request(app).get(`/price-book/drafts/${d.id}/review`);
    expect(review.body.optionSet.options.map((o: { option: string }) => o.option)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("field: the same function — D then E, wrapped in the tech envelope", async () => {
    const d = await draftWithLines("add-field");
    const first = await auth(request(app).post(`/health-record/quotes/${d.id}/options`).send({}));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ success: true, data: { option: "D" } });
    const second = await auth(request(app).post(`/health-record/quotes/${d.id}/options`).send({}));
    expect(second.body.data.option).toBe("E");
    expect(await rowLetters(d.id)).toEqual(["D", "E"]);
  });

  it("refuses past H with 'Eight options is the limit' — from both doors, writing nothing", async () => {
    const d = await newDraft("cap");
    for (const want of ["D", "E", "F", "G", "H"]) {
      const r = await request(app).post(`/price-book/drafts/${d.id}/options`).send({});
      expect(r.body.option).toBe(want);
    }
    expect((await getDraftOptionSet(prisma, d.id)).nextOption).toBeNull();
    const crm = await request(app).post(`/price-book/drafts/${d.id}/options`).send({});
    expect(crm.status).toBe(400);
    expect(crm.body.error).toMatch(/Eight options is the limit/);
    expect(crm.body.error).toContain(OPTION_LIMIT_REASON);
    const tech = await auth(request(app).post(`/health-record/quotes/${d.id}/options`).send({}));
    expect(tech.status).toBe(400);
    expect(tech.body).toMatchObject({ success: false, error: { code: "bad_request" } });
    expect(tech.body.error.message).toMatch(/Eight options is the limit/);
    expect(await rowLetters(d.id)).toEqual(["D", "E", "F", "G", "H"]);
  });

  it("a refused press at the cap does NOT reopen an issued draft", async () => {
    const d = await draftWithLines("cap-no-reopen");
    await prisma.priceBookDraftOption.createMany({
      data: (["D", "E", "F", "G", "H"] as const).map((option) => ({ draftId: d.id, option })),
    });
    await issueFromOffice(d.id);
    expect(await statusOf(d.id)).toBe("finalized");
    const r = await request(app).post(`/price-book/drafts/${d.id}/options`).send({});
    expect(r.status).toBe(400);
    expect(await statusOf(d.id)).toBe("finalized");
  });

  it("fills the lowest free letter: after removing E from D-H, the next Add is E again", async () => {
    const d = await newDraft("gap");
    for (let i = 0; i < 5; i++) await addOption(prisma, d.id);
    await removeOption(prisma, d.id, "E");
    expect(await letters(d.id)).toEqual(["A", "B", "C", "D", "F", "G", "H"]);
    // Nothing was re-lettered: F, G, H are still F, G, H.
    const again = await addOption(prisma, d.id);
    expect(again.option).toBe("E");
    expect(await letters(d.id)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
  });

  it("a letter that only has a LINE still counts, so Add skips it", async () => {
    const d = await newDraft("line-only");
    await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, option: "D" });
    const r = await addOption(prisma, d.id);
    expect(r.option).toBe("E");
  });

  it("two presses at once get two different letters (the unique key decides, the loser retries)", async () => {
    const d = await newDraft("race");
    const [a, b] = await Promise.all([addOption(prisma, d.id), addOption(prisma, d.id)]);
    expect(new Set([a.option, b.option])).toEqual(new Set(["D", "E"]));
    expect(await rowLetters(d.id)).toEqual(["D", "E"]);
  });

  it("reopens a finalized, unsigned draft", async () => {
    const d = await finalizedDraft("add-reopen");
    const r = await request(app).post(`/price-book/drafts/${d.id}/options`).send({});
    expect(r.status).toBe(201);
    expect(await statusOf(d.id)).toBe("draft");
  });

  it("SIGNED draft: a hard refusal from both doors, and nothing is written", async () => {
    const d = await signedDraft("add-signed");
    const crm = await request(app).post(`/price-book/drafts/${d.id}/options`).send({});
    expect(crm.status).toBe(400);
    expect(crm.body.error).toMatch(/SIGNED/);
    const tech = await auth(request(app).post(`/health-record/quotes/${d.id}/options`).send({}));
    expect(tech.status).toBe(400);
    expect(tech.body.error.message).toMatch(/SIGNED/);
    expect(await rowLetters(d.id)).toEqual([]);
    expect(await statusOf(d.id)).toBe("finalized");
  });

  it("404 for an unknown draft on the CRM; 403 for a quote that is not the technician's", async () => {
    const missing = await request(app).post(`/price-book/drafts/no-such-draft/options`).send({});
    expect(missing.status).toBe(404);
    const d = await newDraft("not-yours");
    const stranger = await request(app)
      .post(`/health-record/quotes/${d.id}/options`).set("Authorization", `Bearer ${strangerToken}`).send({});
    expect(stranger.status).toBe(403);
    expect(await rowLetters(d.id)).toEqual([]);
  });
});

// ─── Remove option ────────────────────────────────────────────────────────────────────────

describe("Remove option", () => {
  it("CRM: takes D, its name and ALL its lines (confirmed and proposed) in one go, and says how many", async () => {
    const d = await draftWithLines("rm-crm");
    await addOption(prisma, d.id); // D
    await addOption(prisma, d.id); // E
    await request(app).put(`/price-book/drafts/${d.id}/options/D`).send({ label: "Garage circuit" });
    await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, option: "D" });
    await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, option: "D" });
    await prisma.priceBookDraftLine.create({
      data: { draftId: d.id, itemId: ITEM, quantity: 1, quantitySource: "COUNT", option: "D", state: "PROPOSED", proposedBy: "ai:test" },
    });
    await addLine(prisma, d.id, { itemId: ITEM, quantity: 5, option: "E" });

    const res = await request(app).delete(`/price-book/drafts/${d.id}/options/d`); // lower-case is read as D
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ option: "D", linesRemoved: 3 });
    expect(res.body.optionSet.options.map((o: { option: string }) => o.option)).toEqual(["A", "B", "C", "E"]);
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id, option: "D" } })).toBe(0);
    expect(await rowLetters(d.id)).toEqual(["E"]);
    // E and its line are exactly as they were — no re-lettering — and A's line is untouched.
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id, option: "E" } })).toBe(1);
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id, option: "A" } })).toBe(1);
  });

  it("field: the same function and the same answer", async () => {
    const d = await draftWithLines("rm-field");
    await addOption(prisma, d.id);
    await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, option: "D" });
    const res = await auth(request(app).delete(`/health-record/quotes/${d.id}/options/D`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { option: "D", linesRemoved: 1 } });
    expect(await rowLetters(d.id)).toEqual([]);
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id, option: "D" } })).toBe(0);
  });

  it("removes an EMPTY added option and reports 0 lines", async () => {
    const d = await newDraft("rm-empty");
    await addOption(prisma, d.id);
    const res = await request(app).delete(`/price-book/drafts/${d.id}/options/D`);
    expect(res.body).toMatchObject({ option: "D", linesRemoved: 0 });
  });

  it("refuses A, B and C with the reason — from both doors — and leaves their lines alone", async () => {
    const d = await draftWithLines("rm-base", 2);
    for (const letter of ["A", "B", "C"]) {
      const crm = await request(app).delete(`/price-book/drafts/${d.id}/options/${letter}`);
      expect(crm.status).toBe(400);
      expect(crm.body.error).toMatch(/cannot be removed/);
      const tech = await auth(request(app).delete(`/health-record/quotes/${d.id}/options/${letter}`));
      expect(tech.status).toBe(400);
      expect(tech.body.error.message).toMatch(/cannot be removed/);
    }
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id, option: "A" } })).toBe(2);
  });

  it("404 for an option the draft does not have, 400 for a non-letter, 404 for an unknown draft", async () => {
    const d = await newDraft("rm-missing");
    const notThere = await request(app).delete(`/price-book/drafts/${d.id}/options/F`);
    expect(notThere.status).toBe(404);
    expect(notThere.body.error).toMatch(/not on this estimate/);
    const techNotThere = await auth(request(app).delete(`/health-record/quotes/${d.id}/options/F`));
    expect(techNotThere.status).toBe(404);
    expect(techNotThere.body.error.code).toBe("not_found");
    const junk = await request(app).delete(`/price-book/drafts/${d.id}/options/Z`);
    expect(junk.status).toBe(400);
    expect(junk.body.error).toMatch(/Unknown option/);
    const nodraft = await request(app).delete(`/price-book/drafts/no-such-draft/options/D`);
    expect(nodraft.status).toBe(404);
  });

  it("reopens a finalized, unsigned draft; a refused removal reopens nothing", async () => {
    const d = await finalizedDraft("rm-reopen");
    await prisma.priceBookDraftOption.create({ data: { draftId: d.id, option: "D" } });
    // A/B/C is refused BEFORE the reopen.
    const refused = await request(app).delete(`/price-book/drafts/${d.id}/options/A`);
    expect(refused.status).toBe(400);
    expect(await statusOf(d.id)).toBe("finalized");
    const ok = await request(app).delete(`/price-book/drafts/${d.id}/options/D`);
    expect(ok.status).toBe(200);
    expect(await statusOf(d.id)).toBe("draft");
  });

  it("SIGNED draft: a hard refusal from both doors; the option, its name and its lines all stay", async () => {
    const d = await signedDraft("rm-signed");
    await prisma.priceBookDraftOption.create({ data: { draftId: d.id, option: "D", label: "Extra" } });
    const crm = await request(app).delete(`/price-book/drafts/${d.id}/options/D`);
    expect(crm.status).toBe(400);
    expect(crm.body.error).toMatch(/SIGNED/);
    const tech = await auth(request(app).delete(`/health-record/quotes/${d.id}/options/D`));
    expect(tech.status).toBe(400);
    expect(tech.body.error.message).toMatch(/SIGNED/);
    expect(await rowLetters(d.id)).toEqual(["D"]);
    expect(await statusOf(d.id)).toBe("finalized");
  });
});

// ─── Save line order ──────────────────────────────────────────────────────────────────────

describe("Save line order", () => {
  async function arrangedDraft(title: string) {
    const d = await newDraft(title);
    const l = [];
    for (let i = 0; i < 4; i++) l.push(await addLine(prisma, d.id, { itemId: ITEM, quantity: i + 1 }));
    return { d, ids: l.map((x) => x.id) };
  }

  it("CRM: reorders within an option and moves a line to another, numbering 0..n-1", async () => {
    const { d, ids } = await arrangedDraft("order-crm");
    const [a, b, c, e] = ids;
    const res = await request(app).put(`/price-book/drafts/${d.id}/line-order`).send({
      order: [
        { lineId: c, option: "A" },
        { lineId: a, option: "A" },
        { lineId: e, option: "B" },
        { lineId: b, option: "B" },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ ok: true, saved: 4 });
    expect(await placed([c, a, e, b])).toEqual(["A0", "A1", "B2", "B3"]);
    // The review payload (and so Review, the presentation, Issue and the PDF) reads that order.
    const review = await getDraftReview(prisma, d.id);
    expect(review.confirmedLines.map((l) => l.id)).toEqual([c, a, e, b]);
  });

  it("field: the same function — and the CRM sees the field's order", async () => {
    const { d, ids } = await arrangedDraft("order-field");
    const [a, b, c, e] = ids;
    const res = await auth(request(app).put(`/health-record/quotes/${d.id}/line-order`).send({
      order: [b, a, e, c].map((lineId) => ({ lineId, option: "A" })),
    }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { saved: 4 } });
    const review = await request(app).get(`/price-book/drafts/${d.id}/review`);
    expect(review.body.confirmedLines.map((l: { id: string }) => l.id)).toEqual([b, a, e, c]);
  });

  it("drops a line into an EMPTY added option", async () => {
    const { d, ids } = await arrangedDraft("order-into-empty");
    await addOption(prisma, d.id); // D, empty
    const order = ids.map((lineId, i) => ({ lineId, option: i === 2 ? "D" : "A" }));
    const res = await request(app).put(`/price-book/drafts/${d.id}/line-order`).send({ order });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: ids[2] } })).option).toBe("D");
    expect((await getDraftOptionSet(prisma, d.id)).options.find((o) => o.option === "D")!.lineCount).toBe(1);
  });

  it("does not rewrite a line already in place", async () => {
    const { d, ids } = await arrangedDraft("order-noop");
    const first = await saveLineOrder(prisma, d.id, ids.map((lineId) => ({ lineId, option: "A" })));
    expect(first.saved).toBe(4);
    const again = await saveLineOrder(prisma, d.id, ids.map((lineId) => ({ lineId, option: "A" })));
    expect(again).toEqual({ saved: 4, changed: 0 });
  });

  it("REFUSES a line id from another draft, from both doors, and changes nothing", async () => {
    const { d, ids } = await arrangedDraft("order-foreign");
    const other = await draftWithLines("order-foreign-other");
    const otherLine = (await prisma.priceBookDraftLine.findFirstOrThrow({ where: { draftId: other.id } })).id;
    const before = await placed(ids);
    const order = [...ids.slice(0, 3), otherLine].map((lineId) => ({ lineId, option: "A" }));
    const crm = await request(app).put(`/price-book/drafts/${d.id}/line-order`).send({ order });
    expect(crm.status).toBe(400);
    expect(crm.body.error).toMatch(/not on this estimate/);
    const tech = await auth(request(app).put(`/health-record/quotes/${d.id}/line-order`).send({ order }));
    expect(tech.status).toBe(400);
    expect(tech.body.error.message).toMatch(/not on this estimate/);
    expect(await placed(ids)).toEqual(before);
    expect((await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: otherLine } })).draftId).toBe(other.id);
  });

  it("REFUSES an incomplete list, from both doors, and changes nothing", async () => {
    const { d, ids } = await arrangedDraft("order-partial");
    const before = await placed(ids);
    const order = ids.slice(0, 3).map((lineId) => ({ lineId, option: "B" }));
    const crm = await request(app).put(`/price-book/drafts/${d.id}/line-order`).send({ order });
    expect(crm.status).toBe(400);
    expect(crm.body.error).toMatch(/leaves out 1 line/);
    const tech = await auth(request(app).put(`/health-record/quotes/${d.id}/line-order`).send({ order }));
    expect(tech.status).toBe(400);
    expect(tech.body.error.message).toMatch(/leaves out 1 line/);
    expect(await placed(ids)).toEqual(before);
  });

  it("REFUSES an unknown option, an option the draft does not have, and a line listed twice", async () => {
    const { d, ids } = await arrangedDraft("order-bad-option");
    const before = await placed(ids);
    const mk = (option: string, dup = false) => ({
      order: [...ids, ...(dup ? [ids[0]] : [])].map((lineId, i) => ({ lineId, option: i === 0 ? option : "A" })),
    });
    for (const door of ["crm", "tech"] as const) {
      const put = (body: object) =>
        door === "crm"
          ? request(app).put(`/price-book/drafts/${d.id}/line-order`).send(body)
          : auth(request(app).put(`/health-record/quotes/${d.id}/line-order`).send(body));
      const message = (r: request.Response) => (door === "crm" ? r.body.error : r.body.error.message);
      const unknown = await put(mk("Z"));
      expect(unknown.status).toBe(400);
      expect(message(unknown)).toMatch(/Unknown option/);
      // E is a real letter, but this draft has no Option E until someone adds it.
      const absent = await put(mk("E"));
      expect(absent.status).toBe(400);
      expect(message(absent)).toMatch(/Option E is not on this estimate/);
      const twice = await put(mk("A", true));
      expect(twice.status).toBe(400);
      expect(message(twice)).toMatch(/twice/);
    }
    expect(await placed(ids)).toEqual(before);
  });

  it("an AI-proposed line may be left out: it is numbered after the list and its option is untouched", async () => {
    const { d, ids } = await arrangedDraft("order-proposed");
    const proposed = await prisma.priceBookDraftLine.create({
      data: { draftId: d.id, itemId: ITEM, quantity: 1, quantitySource: "COUNT", option: "B", sortOrder: 0, state: "PROPOSED", proposedBy: "ai:test" },
    });
    const reversed = [...ids].reverse();
    const res = await request(app).put(`/price-book/drafts/${d.id}/line-order`).send({
      order: reversed.map((lineId) => ({ lineId, option: "A" })),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: proposed.id } });
    expect([p.option, p.sortOrder]).toEqual(["B", 4]);
    expect(await placed(reversed)).toEqual(["A0", "A1", "A2", "A3"]);
  });

  it("reopens a finalized, unsigned draft", async () => {
    const d = await finalizedDraft("order-reopen");
    const line = await prisma.priceBookDraftLine.findFirstOrThrow({ where: { draftId: d.id } });
    const res = await request(app).put(`/price-book/drafts/${d.id}/line-order`).send({ order: [{ lineId: line.id, option: "C" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(d.id)).toBe("draft");
    expect((await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: line.id } })).option).toBe("C");
  });

  it("a bad list does not reopen a finalized draft", async () => {
    const d = await finalizedDraft("order-bad-no-reopen");
    const res = await request(app).put(`/price-book/drafts/${d.id}/line-order`).send({ order: [] });
    expect(res.status).toBe(400);
    expect(await statusOf(d.id)).toBe("finalized");
  });

  it("SIGNED draft: a hard refusal from both doors; nothing moves", async () => {
    const d = await signedDraft("order-signed");
    const line = await prisma.priceBookDraftLine.findFirstOrThrow({ where: { draftId: d.id } });
    const order = [{ lineId: line.id, option: "C" }];
    const crm = await request(app).put(`/price-book/drafts/${d.id}/line-order`).send({ order });
    expect(crm.status).toBe(400);
    expect(crm.body.error).toMatch(/SIGNED/);
    const tech = await auth(request(app).put(`/health-record/quotes/${d.id}/line-order`).send({ order }));
    expect(tech.status).toBe(400);
    expect(tech.body.error.message).toMatch(/SIGNED/);
    expect((await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: line.id } })).option).toBe("A");
    expect(await statusOf(d.id)).toBe("finalized");
  });

  it("403 for a quote that is not the technician's; 404 for an unknown draft on the CRM", async () => {
    const { d, ids } = await arrangedDraft("order-not-yours");
    const order = ids.map((lineId) => ({ lineId, option: "A" }));
    const stranger = await request(app)
      .put(`/health-record/quotes/${d.id}/line-order`).set("Authorization", `Bearer ${strangerToken}`).send({ order });
    expect(stranger.status).toBe(403);
    const missing = await request(app).put(`/price-book/drafts/no-such-draft/line-order`).send({ order: [] });
    expect(missing.status).toBe(404);
  });

  it("a line added AFTER arranging still lands at the end (the Phase 0 default holds with options)", async () => {
    const { d, ids } = await arrangedDraft("order-then-add");
    await saveLineOrder(prisma, d.id, [...ids].reverse().map((lineId) => ({ lineId, option: "A" })));
    const added = await addLine(prisma, d.id, { itemId: ITEM, quantity: 9, option: "B" });
    expect(added.sortOrder).toBe(4);
  });
});

// ─── Review fixes (2026-10-08): option on the review line, `was`, expected count, lock reason ──────

describe("the review payload carries each confirmed line's OWN option", () => {
  it("so the Review board never has to ask the compute result (a missing one filed lines under A)", async () => {
    const d = await newDraft("review-option");
    const a = await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, option: "A" });
    const b = await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, option: "B" });
    const res = await request(app).get(`/price-book/drafts/${d.id}/review`);
    expect(res.status).toBe(200);
    const byId = new Map<string, { option: string }>(res.body.confirmedLines.map((l: { id: string; option: string }) => [l.id, l]));
    expect(byId.get(a.id)!.option).toBe("A");
    expect(byId.get(b.id)!.option).toBe("B");
  });
});

describe("Save line order — a stale screen cannot undo the other app's move (`was`)", () => {
  it("refuses with a 409 and writes NOTHING when a line is no longer in the option the sender saw", async () => {
    const d = await newDraft("order-was");
    const x = await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, option: "B" });
    const y = await addLine(prisma, d.id, { itemId: ITEM, quantity: 2, option: "A" });
    // The tech moves X from B to C on the phone ...
    await request(app).put(`/price-book/drafts/${d.id}/line-order`).send({
      order: [{ lineId: y.id, option: "A", was: "A" }, { lineId: x.id, option: "C", was: "B" }],
    });
    expect((await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: x.id } })).option).toBe("C");
    // ... and the office, still looking at the old Review, drags Y and sends X as B.
    const stale = [{ lineId: x.id, option: "B", was: "B" }, { lineId: y.id, option: "A", was: "A" }];
    const crm = await request(app).put(`/price-book/drafts/${d.id}/line-order`).send({ order: stale });
    expect(crm.status).toBe(409);
    expect(crm.body.error).toMatch(/moved to another option by someone else/);
    const tech = await auth(request(app).put(`/health-record/quotes/${d.id}/line-order`).send({ order: stale }));
    expect(tech.status).toBe(409);
    expect(tech.body.error).toMatchObject({ code: "conflict" });
    // The tech's move stands, and nothing else was touched.
    expect(await placed([y.id, x.id])).toEqual(["A0", "C1"]);
  });

  it("a current `was` saves as before; a caller that sends none (a script) is not checked", async () => {
    const d = await newDraft("order-was-ok");
    const x = await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, option: "B" });
    const y = await addLine(prisma, d.id, { itemId: ITEM, quantity: 2, option: "A" });
    const ok = await request(app).put(`/price-book/drafts/${d.id}/line-order`).send({
      order: [{ lineId: x.id, option: "A", was: "B" }, { lineId: y.id, option: "A", was: "A" }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const noWas = await saveLineOrder(prisma, d.id, [{ lineId: y.id, option: "C" }, { lineId: x.id, option: "C" }]);
    expect(noWas.saved).toBe(2);
  });
});

describe("Remove option — only the lines the person agreed to (`expectedLines`)", () => {
  it("deletes nothing and says 409 when the option holds a different number now, from both doors", async () => {
    const d = await draftWithLines("rm-expected");
    await addOption(prisma, d.id); // D
    await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, option: "D" });
    // The screen showed "Option D has 1 line"; the other app then added a second.
    await addLine(prisma, d.id, { itemId: ITEM, quantity: 2, option: "D" });

    const crm = await request(app).delete(`/price-book/drafts/${d.id}/options/D?expectedLines=1`);
    expect(crm.status).toBe(409);
    expect(crm.body.error).toMatch(/now has 2 lines, not 1/);
    const tech = await auth(request(app).delete(`/health-record/quotes/${d.id}/options/D?expectedLines=1`));
    expect(tech.status).toBe(409);
    expect(tech.body.error).toMatchObject({ code: "conflict" });
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id, option: "D" } })).toBe(2);
    expect(await rowLetters(d.id)).toEqual(["D"]);

    // The count the person saw when it is looked at again: removed, and the answer says 2.
    const ok = await request(app).delete(`/price-book/drafts/${d.id}/options/D?expectedLines=2`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ linesRemoved: 2 });
  });

  it("an option that showed 0 lines (no confirm) is not wiped if lines arrived since", async () => {
    const d = await draftWithLines("rm-expected-zero");
    await addOption(prisma, d.id);
    await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, option: "D" });
    const res = await request(app).delete(`/price-book/drafts/${d.id}/options/D?expectedLines=0`);
    expect(res.status).toBe(409);
    expect(await prisma.priceBookDraftLine.count({ where: { draftId: d.id, option: "D" } })).toBe(1);
  });

  it("a refused count on a finalized draft does not reopen it", async () => {
    const d = await draftWithLines("rm-expected-finalized");
    await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, option: "D" });
    await issueFromOffice(d.id);
    expect(await statusOf(d.id)).toBe("finalized");
    const res = await request(app).delete(`/price-book/drafts/${d.id}/options/D?expectedLines=5`);
    expect(res.status).toBe(409);
    expect(await statusOf(d.id)).toBe("finalized");
  });
});

describe("lockedReason — the server's own 'signed' rule, on both payloads", () => {
  it("is null on an open draft and the refusal's own sentence on a signed one — the same on both doors", async () => {
    const open = await draftWithLines("lock-open");
    expect((await getDraftOptionSet(prisma, open.id)).lockedReason).toBeNull();

    const d = await signedDraft("lock-signed");
    const crm = await request(app).get(`/price-book/drafts/${d.id}/review`);
    const tech = await auth(request(app).get(`/health-record/quotes/${d.id}`));
    expect(crm.body.optionSet.lockedReason).toMatch(/is SIGNED\. A signed agreement is never edited/);
    expect(tech.body.data.optionSet.lockedReason).toBe(crm.body.optionSet.lockedReason);
    // It IS the sentence the refusal carries, so the screen and the press can never disagree.
    const refused = await request(app).post(`/price-book/drafts/${d.id}/options`).send({});
    expect(refused.body.error).toBe(crm.body.optionSet.lockedReason);
  });

  it("stays locked after the signed estimate is REVISED (the case the CRM's own 'signed' test missed)", async () => {
    const d = await signedDraft("lock-revised");
    const signedRow = await prisma.issuedEstimate.findFirstOrThrow({ where: { draftId: d.id, signedAt: { not: null } } });
    const revised = await reviseEstimate(prisma, signedRow.id, { actor: "test" });
    expect(revised.ok, JSON.stringify(revised)).toBe(true);
    // The old signed row is now superseded ...
    const after = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: signedRow.id }, include: { supersededBy: true } });
    expect(after.supersededBy).not.toBeNull();
    // ... and the server still refuses, so the payload must still say so.
    expect((await getDraftOptionSet(prisma, d.id)).lockedReason).toMatch(/is SIGNED/);
    const refused = await request(app).post(`/price-book/drafts/${d.id}/options`).send({});
    expect(refused.status).toBe(400);
  });
});

describe("the tech quote payload tells a suggested line from a confirmed one", () => {
  it("sends `state`, so the phone can leave a PROPOSED line out of the drag list", async () => {
    const d = await draftWithLines("quote-state");
    await prisma.priceBookDraftLine.create({
      data: { draftId: d.id, itemId: ITEM, quantity: 1, quantitySource: "COUNT", option: "A", state: "PROPOSED", proposedBy: "ai:test" },
    });
    const res = await auth(request(app).get(`/health-record/quotes/${d.id}`));
    expect(res.status).toBe(200);
    const states = res.body.data.lines.map((l: { state: string }) => l.state).sort();
    expect(states).toEqual(["CONFIRMED", "PROPOSED"]);
  });
});

describe("DELETE /quote-lines/:lineId — a rule answers with its reason; a missing line is a DraftError 404", () => {
  it("a signed quote answers 400 with the reason, and removeLine on a gone line throws a DraftError (404)", async () => {
    const d = await signedDraft("qline-del");
    const line = await prisma.priceBookDraftLine.findFirstOrThrow({ where: { draftId: d.id } });
    const signed = await auth(request(app).delete(`/health-record/quote-lines/${line.id}`));
    expect(signed.status).toBe(400);
    expect(signed.body.error.message).toMatch(/SIGNED/);

    const open = await draftWithLines("qline-gone");
    const gone = await prisma.priceBookDraftLine.findFirstOrThrow({ where: { draftId: open.id } });
    await removeLine(prisma, gone.id);
    await expect(removeLine(prisma, gone.id)).rejects.toMatchObject({ name: "DraftError", status: 404 });
  });
});
