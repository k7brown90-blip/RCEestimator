/**
 * A line's name is the job's, and the customer reads no quantity (Kyle, 2026-10-27).
 *
 *   "I also want to get rid of the quantity showing on the estimates and invoices. Instead I want
 *    to be able to edit the name of the line item so I can customize the line item name to the
 *    specific job."
 *
 * Pinned here:
 *   1. ONE rule, both doors. The CRM's PATCH /price-book/lines/:id and the tech's PATCH
 *      /health-record/quote-lines/:id set and clear `customName` through the same editLine, with
 *      the same trimming, the same 200-character limit, the same replay rule, the same refusal on a
 *      signed draft - and the same row afterwards.
 *   2. Issue freezes `customName ?? price-book name` into the line's description, and the
 *      price-book name beside it; a later edit of the draft moves nothing already issued.
 *   3. The customer's page and the customer's PDF show the name and no quantity. The company copy
 *      keeps the quantity, shows both names, and keys its materials list by the item.
 *   4. Both review payloads carry the field; a copied option keeps the name.
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
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { addLine, createDraft, editLine } from "../src/services/atomicEstimateService";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "LCNAME";
const ITEM = "LCNAME1";
const ITEM_B = "LCNAME2";
// Plain ASCII on purpose: the PDF text extraction below cannot read an em dash back.
const CATALOG = "Receptacle, 20-amp, tamper-resistant";
const CATALOG_B = "Weatherproof cover, in-use";

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;
const draftIds: string[] = [];

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);
const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

/** pdfkit writes text as hex runs; see tests/issuedEstimatePdf.test.ts `extractText`. */
function pdfText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const parts: string[] = [];
  for (const m of raw.matchAll(/<([0-9A-Fa-f]+)>/g)) {
    if (m[1].length % 2 !== 0) continue;
    parts.push(Buffer.from(m[1], "hex").toString("latin1"));
  }
  return parts.join("");
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ITEM, { description: CATALOG }), quotableAtomic(ITEM_B, { description: CATALOG_B })]);
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "lcname@example.com", phone: "615-555-0188" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "5 Line Name Ln", city: "La Vergne", state: "TN", postalCode: "37086" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "estimate" },
  });
  visitId = visit.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `lcname-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.visitAssignment.create({ data: { visitId, technicianId } });
});

afterAll(async () => {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: draftIds } } });
  const estIds = ests.map((e) => e.id);
  await prisma.payment.deleteMany({ where: { estimateId: { in: estIds } } });
  const jobIds = [...new Set(ests.map((e) => e.jobVisitId).filter((v): v is string => Boolean(v)))];
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: jobIds } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null, changeOrderForId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.visit.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ITEM, ITEM_B]);
});

/** A draft with a 3-count line of ITEM (and, when asked, a 5-count line of ITEM_B). */
async function draftWith(title: string, opts: { second?: boolean } = {}) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  const line = await addLine(prisma, d.id, { itemId: ITEM, quantity: 3, quantitySource: "COUNT" });
  const second = opts.second ? await addLine(prisma, d.id, { itemId: ITEM_B, quantity: 5, quantitySource: "COUNT" }) : null;
  return { draftId: d.id, lineId: line.id, secondLineId: second?.id ?? null };
}

const crmPatch = (lineId: string, body: Record<string, unknown>) => request(app).patch(`/price-book/lines/${lineId}`).send(body);
const techPatch = (lineId: string, body: Record<string, unknown>) => auth(request(app).patch(`/health-record/quote-lines/${lineId}`)).send(body);
const stored = (lineId: string) => prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: lineId } });

async function issue(draftId: string) {
  const g = await graduateDraft(prisma, { draftId, accountId: customerId, serviceAddressId: propertyId });
  if (!g.ok) throw new Error(g.reasons.join("; "));
  return prisma.issuedEstimate.findUniqueOrThrow({ where: { id: g.estimateId }, include: { lines: true } });
}

describe("the line's name - ONE rule, both doors", () => {
  it("the CRM door sets it, trimmed; the tech door leaves the same row", async () => {
    const a = await draftWith("crm sets");
    const b = await draftWith("tech sets");
    const crm = await crmPatch(a.lineId, { customName: "  Garage outlet - Smith  " });
    const tech = await techPatch(b.lineId, { customName: "  Garage outlet - Smith  " });
    expect(crm.status).toBe(200);
    expect(tech.status).toBe(200);
    expect((await stored(a.lineId)).customName).toBe("Garage outlet - Smith");
    expect((await stored(b.lineId)).customName).toBe("Garage outlet - Smith");
    // The price, the quantity and the item are not the name's business.
    expect((await stored(a.lineId)).quantity).toBe(3);
    expect((await stored(a.lineId)).itemId).toBe(ITEM);
  });

  it("empty, blank and null all clear it - on both doors - which puts the price-book name back", async () => {
    const d = await draftWith("clears");
    for (const clear of ["", "   ", null]) {
      await crmPatch(d.lineId, { customName: "Named for the job" });
      expect((await stored(d.lineId)).customName).toBe("Named for the job");
      expect((await crmPatch(d.lineId, { customName: clear })).status).toBe(200);
      expect((await stored(d.lineId)).customName).toBeNull();

      await techPatch(d.lineId, { customName: "Named for the job" });
      expect((await techPatch(d.lineId, { customName: clear })).status).toBe(200);
      expect((await stored(d.lineId)).customName).toBeNull();
    }
  });

  it("a name over 200 characters is refused by both doors and writes nothing", async () => {
    const d = await draftWith("too long");
    const tooLong = "x".repeat(201);
    expect((await crmPatch(d.lineId, { customName: tooLong })).status).toBeGreaterThanOrEqual(400);
    expect((await techPatch(d.lineId, { customName: tooLong })).status).toBeGreaterThanOrEqual(400);
    expect((await stored(d.lineId)).customName).toBeNull();
    // Exactly 200 is fine.
    expect((await crmPatch(d.lineId, { customName: "y".repeat(200) })).status).toBe(200);
    // And the service itself holds the limit for a caller that skipped both schemas.
    await expect(editLine(prisma, d.lineId, { customName: "z".repeat(201) })).rejects.toThrow(/at most 200/);
    expect((await stored(d.lineId)).customName).toBe("y".repeat(200));
  });

  it("the tech door's replay rule covers the name: a stale `expected` is refused 409 naming both values", async () => {
    const d = await draftWith("expected");
    await crmPatch(d.lineId, { customName: "The office's wording" });
    const stale = await techPatch(d.lineId, { customName: "Tech wording", expected: { customName: null } });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toContain("customName was blank");
    expect((await stored(d.lineId)).customName).toBe("The office's wording");
    // The same edit with what the phone really saw lands.
    const fresh = await techPatch(d.lineId, { customName: "Tech wording", expected: { customName: "The office's wording" } });
    expect(fresh.status).toBe(200);
    expect((await stored(d.lineId)).customName).toBe("Tech wording");
    // A lost-answer replay (the value is already the new one) is let through and writes nothing.
    const replay = await techPatch(d.lineId, { customName: "Tech wording", expected: { customName: "The office's wording" } });
    expect(replay.status).toBe(200);
  });

  it("a SIGNED estimate refuses the name from both doors, and the name stays as it was", async () => {
    const d = await draftWith("signed");
    await crmPatch(d.lineId, { customName: "Before signing" });
    const est = await issue(d.draftId);
    const signed = await request(app)
      .post(`/issued-estimates/${est.id}/sign-in-person`)
      .send({ signerName: "Name Signer", signatureImage: TEST_SIGNATURE });
    expect(signed.status).toBe(200);

    const crm = await crmPatch(d.lineId, { customName: "After signing" });
    expect(crm.status).toBe(400);
    expect(JSON.stringify(crm.body)).toMatch(/SIGNED/);
    const tech = await techPatch(d.lineId, { customName: "After signing" });
    expect(tech.status).toBe(400);
    expect(JSON.stringify(tech.body)).toMatch(/SIGNED/);
    // Clearing is an edit too.
    expect((await crmPatch(d.lineId, { customName: null })).status).toBe(400);
    expect((await stored(d.lineId)).customName).toBe("Before signing");
  });

  it("both review payloads carry it, and the price-book name stays `description`", async () => {
    const d = await draftWith("payloads");
    await crmPatch(d.lineId, { customName: "Kitchen island receptacle" });

    const review = await request(app).get(`/price-book/drafts/${d.draftId}/review`);
    expect(review.status).toBe(200);
    const crmLine = review.body.confirmedLines.find((l: { id: string }) => l.id === d.lineId);
    expect(crmLine.customName).toBe("Kitchen island receptacle");
    expect(crmLine.description).toBe(CATALOG);

    const compute = await request(app).get(`/price-book/drafts/${d.draftId}/compute`);
    expect(compute.status).toBe(200);
    const computed = compute.body.computed.lines.find((l: { id: string }) => l.id === d.lineId);
    expect(computed.customName).toBe("Kitchen island receptacle");
    expect(computed.description).toBe(CATALOG);

    const field = await auth(request(app).get(`/health-record/quotes/${d.draftId}`));
    expect(field.status).toBe(200);
    const fieldLine = field.body.data.lines.find((l: { id: string }) => l.id === d.lineId);
    expect(fieldLine.customName).toBe("Kitchen island receptacle");
    expect(fieldLine.description).toBe(CATALOG);
  });

  it("copying an option keeps the name on the copy", async () => {
    const d = await draftWith("copy");
    await crmPatch(d.lineId, { customName: "Carried across" });
    const res = await request(app).post(`/price-book/drafts/${d.draftId}/options/copy`).send({ from: "A", to: "B" });
    expect(res.status).toBe(201);
    const copies = await prisma.priceBookDraftLine.findMany({ where: { draftId: d.draftId, option: "B" } });
    expect(copies).toHaveLength(1);
    expect(copies[0].customName).toBe("Carried across");
  });
});

describe("issue freezes the name", () => {
  it("customName ?? price-book name goes into description; the price-book name rides beside it", async () => {
    const d = await draftWith("freeze", { second: true });
    await crmPatch(d.lineId, { customName: "Pool pump disconnect - Jones" });
    const est = await issue(d.draftId);
    const named = est.lines.find((l) => l.itemId === ITEM)!;
    const plain = est.lines.find((l) => l.itemId === ITEM_B)!;
    expect(named.description).toBe("Pool pump disconnect - Jones");
    expect(named.catalogDescription).toBe(CATALOG);
    expect(named.quantity).toBe(3);
    expect(plain.description).toBe(CATALOG_B);
    expect(plain.catalogDescription).toBe(CATALOG_B);
  });

  it("editing the draft afterwards moves nothing already issued", async () => {
    const d = await draftWith("frozen");
    await crmPatch(d.lineId, { customName: "As first worded" });
    const est = await issue(d.draftId);
    await crmPatch(d.lineId, { customName: "Reworded later" });
    const again = await prisma.issuedEstimateLine.findMany({ where: { estimateId: est.id } });
    expect(again[0].description).toBe("As first worded");
    // Re-issuing is a revision and freezes the new wording.
    const revised = await issue(d.draftId);
    expect(revised.lines[0].description).toBe("Reworded later");
  });
});

describe("what the customer reads - no quantity", () => {
  it("the customer's page shows the name and has no Qty column or count cell", async () => {
    const d = await draftWith("page", { second: true });
    await crmPatch(d.lineId, { customName: "Detached garage feeder" });
    const est = await issue(d.draftId);
    const res = await request(app).get(`/e/${est.token}`);
    expect(res.status).toBe(200);
    const html = res.text;
    // Presence first, so the absences below cannot pass on an empty page.
    expect(html).toContain("Detached garage feeder");
    expect(html).toContain(CATALOG_B);
    expect(html).not.toContain(">Qty<");
    expect(html).not.toContain('<td class="r">3</td>');
    expect(html).not.toContain('<td class="r">5</td>');
    expect(html).not.toContain(CATALOG);
  });

  it("the customer's PDF shows the name, no quantity and no price-book name", async () => {
    const d = await draftWith("pdf customer", { second: true });
    await crmPatch(d.lineId, { customName: "Detached garage feeder" });
    const est = await issue(d.draftId);
    const res = await request(app).get(`/issued-estimates/${est.id}/pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const text = pdfText(res.body as Buffer);
    expect(text).toContain("Detached garage feeder");
    expect(text).toContain(CATALOG_B);
    expect(text).not.toContain("× 3");
    expect(text).not.toContain("× 5");
    expect(text).not.toContain("price book:");
    expect(text).not.toContain(CATALOG);
  });

  it("the company PDF keeps the quantities, shows both names, and keys the materials list by the item", async () => {
    const d = await draftWith("pdf company", { second: true });
    await crmPatch(d.lineId, { customName: "Detached garage feeder" });
    // A second line of the same item under another name: still ONE row in the ordering list.
    await addLine(prisma, d.draftId, { itemId: ITEM, quantity: 2, quantitySource: "COUNT" });
    const extra = await prisma.priceBookDraftLine.findMany({ where: { draftId: d.draftId, itemId: ITEM }, orderBy: { createdAt: "asc" } });
    await crmPatch(extra[1].id, { customName: "Pool house feeder" });
    const est = await issue(d.draftId);
    const res = await request(app).get(`/issued-estimates/${est.id}/pdf?audience=company`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const text = pdfText(res.body as Buffer);
    expect(text).toContain("Detached garage feeder");
    expect(text).toContain("Pool house feeder");
    expect(text).toContain(`price book: ${CATALOG}`);
    expect(text).toContain("× 3");
    expect(text).toContain("× 2");
    expect(text).toContain("× 5");
    // The ordering list: the item once, by its price-book name, the two counts added (3 + 2).
    const list = text.slice(text.indexOf("Material to order"));
    expect(list).toContain(`${CATALOG}  × 5`);
    expect(list).not.toContain("Detached garage feeder");
    expect(list).not.toContain("Pool house feeder");
  });
});
