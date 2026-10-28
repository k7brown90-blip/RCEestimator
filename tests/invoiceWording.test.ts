/**
 * A signed job reads "Invoice" wherever the customer looks (Kyle, 2026-10-27: "When sending an
 * invoice the customer sees 'estimate' instead of invoice. Can we look into getting the verbage
 * accurate to what is being sent between estimates and invoices?").
 *
 * The rule is the PDF's own (issuedEstimatePdf.ts `isInvoice = Boolean(signedAt)`, Kyle
 * 2026-08-21 "The signed estimates need to be labeled invoices"), applied to the two places that
 * still said "estimate" once the job was signed:
 *   1. The customer's link page /e/:token (title, letterhead, "Invoice No.", "Signed <date>" in
 *      place of "Valid N days", "Invoice detail", "INVOICE TOTAL"). Unsigned pages are unchanged.
 *   2. The CRM "Customer PDF" download name (invoice-<number> signed, estimate-<number> unsigned,
 *      the -company suffix kept).
 *   3. The pay page: a "View or print your itemized invoice" link to the INVOICE ROOT's /e/ page,
 *      for a payer (a school, a property manager) who holds only the pay link.
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
// Customer emails are counted, never sent.
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "INVWORD";
const ITEM = "INVWORD1";

let customerId: string;
let propertyId: string;
let visitId: string;
const draftIds: string[] = [];

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ITEM)]);
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "invword@example.com", phone: "615-555-0171" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "9 Invoice Wording Ct", city: "La Vergne", state: "TN", postalCode: "37086" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "estimate" },
  });
  visitId = visit.id;
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
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ITEM]);
});

async function issue(title: string) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, quantitySource: "COUNT" });
  const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
  expect(g.ok).toBe(true);
  if (!g.ok) throw new Error(g.reasons.join("; "));
  return prisma.issuedEstimate.findUniqueOrThrow({ where: { id: g.estimateId } });
}

async function sign(estimateId: string) {
  const res = await request(app)
    .post(`/issued-estimates/${estimateId}/sign-in-person`)
    .send({ signerName: "Invoice Payer", signatureImage: TEST_SIGNATURE });
  expect(res.status).toBe(200);
  return prisma.issuedEstimate.findUniqueOrThrow({ where: { id: estimateId } });
}

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("the customer's link page /e/:token", () => {
  it("an UNSIGNED page reads Estimate everywhere, exactly as before", async () => {
    const est = await issue("unsigned page");
    const res = await request(app).get(`/e/${est.token}`);
    expect(res.status).toBe(200);
    const html = res.text;
    expect(html).toContain(`<title>Estimate ${est.number} — Red Cedar Electric</title>`);
    expect(html).toContain(">ESTIMATE</p>");
    expect(html).toContain("<strong>Estimate No.</strong>");
    expect(html).toContain(`<strong>Valid</strong>${est.validDays} days`);
    expect(html).toContain("<h2>Estimate detail</h2>");
    expect(html).toContain("ESTIMATE TOTAL");
    expect(html).toContain(`This estimate is valid for ${est.validDays} days.`);
    expect(html).not.toContain("INVOICE TOTAL");
    expect(html).not.toContain("Invoice No.");
    expect(html).not.toContain("Invoice detail");
    expect(html).not.toContain("<strong>Signed</strong>");
  });

  it("a SIGNED page reads Invoice: title, letterhead, number, signed date, detail, total", async () => {
    const est = await sign((await issue("signed page")).id);
    expect(est.signedAt).not.toBeNull();
    const res = await request(app).get(`/e/${est.token}`);
    expect(res.status).toBe(200);
    const html = res.text;
    expect(html).toContain(`<title>Invoice ${est.number} — Red Cedar Electric</title>`);
    expect(html).toContain(">INVOICE</p>");
    expect(html).toContain("<strong>Invoice No.</strong>");
    expect(html).toContain("<strong>Signed</strong>");
    expect(html).toContain("<h2>Invoice detail</h2>");
    expect(html).toContain("INVOICE TOTAL");
    // Nothing the customer reads still calls it an estimate or promises a validity window.
    expect(html).not.toContain("ESTIMATE TOTAL");
    expect(html).not.toContain("Estimate No.");
    expect(html).not.toContain("Estimate detail");
    expect(html).not.toContain(">ESTIMATE</p>");
    expect(html).not.toContain("<strong>Valid</strong>");
    expect(html).not.toContain("This estimate is valid");
    expect(html).not.toContain(`<title>Estimate`);
  });
});

describe("GET /issued-estimates/:id/pdf file name", () => {
  it("unsigned: estimate-<number>.pdf, and -company on the company copy", async () => {
    const est = await issue("pdf unsigned");
    const customer = await request(app).get(`/issued-estimates/${est.id}/pdf`).buffer(true).parse(binary);
    expect(customer.status).toBe(200);
    expect(customer.headers["content-disposition"]).toBe(`inline; filename="estimate-${est.number}.pdf"`);
    const company = await request(app).get(`/issued-estimates/${est.id}/pdf?audience=company`).buffer(true).parse(binary);
    expect(company.headers["content-disposition"]).toBe(`inline; filename="estimate-${est.number}-company.pdf"`);
  });

  it("signed: invoice-<number>.pdf, and -company on the company copy", async () => {
    const est = await sign((await issue("pdf signed")).id);
    const customer = await request(app).get(`/issued-estimates/${est.id}/pdf`).buffer(true).parse(binary);
    expect(customer.status).toBe(200);
    expect(customer.headers["content-disposition"]).toBe(`inline; filename="invoice-${est.number}.pdf"`);
    const company = await request(app).get(`/issued-estimates/${est.id}/pdf?audience=company`).buffer(true).parse(binary);
    expect(company.headers["content-disposition"]).toBe(`inline; filename="invoice-${est.number}-company.pdf"`);
  });
});

describe("the pay page links to the itemized invoice", () => {
  const LABEL = "View or print your itemized invoice";

  it("a signed invoice's pay page links to its own /e/ page, which reads Invoice", async () => {
    const est = await sign((await issue("pay link")).id);
    const page = await request(app).get(`/pay/${est.token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(LABEL);
    expect(page.text).toContain(`href="/e/${est.token}"`);
    const target = await request(app).get(`/e/${est.token}`);
    expect(target.status).toBe(200);
    expect(target.text).toContain("INVOICE TOTAL");
  });

  it("a change order's pay link points at the ROOT invoice's /e/ page, never the change order's", async () => {
    const root = await sign((await issue("pay link root")).id);
    const raised = await request(app).post(`/issued-estimates/${root.id}/change-order`).send({});
    expect(raised.status).toBe(201);
    const coDraftId = raised.body.draftId as string;
    draftIds.push(coDraftId);
    await addLine(prisma, coDraftId, { itemId: ITEM, quantity: 2, quantitySource: "COUNT" });
    const g = await graduateDraft(prisma, { draftId: coDraftId, accountId: customerId, serviceAddressId: propertyId });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const co = await sign(g.estimateId);
    expect(co.changeOrderForId).toBe(root.id);
    expect(co.token).not.toBe(root.token);

    const page = await request(app).get(`/pay/${co.token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(LABEL);
    expect(page.text).toContain(`href="/e/${root.token}"`);
    expect(page.text).not.toContain(`/e/${co.token}`);
  });

  it("a pay page that cannot be paid (unsigned) shows the refusal and no invoice link", async () => {
    const est = await issue("pay link unsigned");
    const page = await request(app).get(`/pay/${est.token}`);
    expect(page.status).toBe(400);
    expect(page.text).not.toContain(LABEL);
    expect(page.text).not.toContain(`/e/${est.token}`);
  });
});
