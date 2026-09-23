/**
 * PUNCHLIST N3 (2026-09-22) — "A signed revision takes over its invoice" (2026-09-21) means a
 * signed root superseded by a still-UNSIGNED revision is still the live invoice. `/invoices`
 * already dropped its `supersededBy: null` filter for that reason, but two other readers still
 * had it: `invoiceReminders.ts`'s sweep (a completed job's balance reminder went silent for the
 * entire window between "revise" and "the revision is signed") and `jobMaterials.ts`'s
 * `allSignedEstimatesForJob` (the material-need list stopped counting the very estimate the tech
 * was working from). Both are fixed to match `signedEstimateForJob`, which never had the filter.
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
import { materialNeedListForJob } from "../src/services/jobMaterials";
import { sweepInvoiceReminders } from "../src/services/invoiceReminders";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "N3REV";
const ITEM = "N3REV1";
const DAY = 86_400_000;

let customerId: string;
let propertyId: string;
let visitId: string;
let jobId: string;
let rootId: string;
let revId: string;
const draftIds: string[] = [];

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ITEM)]);
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "n3rev-customer@example.com", phone: "615-555-0199" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "3 Revision Loop", city: "La Vergne", state: "TN", postalCode: "37086" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} panel`, status: "estimate" },
  });
  visitId = visit.id;

  // Issue and sign the root in person — the route mints the job synchronously.
  const draft = await createDraft(prisma, { title: `${MARK} root`, supplierId: "HD", visitId });
  draftIds.push(draft.id);
  await addLine(prisma, draft.id, { itemId: ITEM, quantity: 3, quantitySource: "COUNT" });
  const graduated = await graduateDraft(prisma, { draftId: draft.id, accountId: customerId, serviceAddressId: propertyId });
  expect(graduated.ok).toBe(true);
  if (!graduated.ok) throw new Error(graduated.reasons.join("; "));
  rootId = graduated.estimateId;
  const signed = await request(app)
    .post(`/issued-estimates/${rootId}/sign-in-person`)
    .send({ signerName: "Mrs Revision", signatureImage: TEST_SIGNATURE });
  expect(signed.body, `signature refused: ${JSON.stringify(signed.body)}`).toMatchObject({ signed: true });
  const root = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: rootId } });
  jobId = root.jobVisitId!;
  expect(jobId, "signing in person creates the job").toBeTruthy();

  // The job is done, and the 7 quiet days are already up on both the signature and the
  // completion — the sweep's other gates are satisfied, so the ONLY thing left to prove is that
  // the root still counts as a candidate while its revision sits unsigned.
  await prisma.visit.update({
    where: { id: jobId },
    data: { status: "completed", completedAt: new Date(Date.now() - 10 * DAY) },
  });
  await prisma.issuedEstimate.update({
    where: { id: rootId },
    data: { signedAt: new Date(Date.now() - 10 * DAY) },
  });

  // Revise the signed root — the revision is deliberately left UNSIGNED for every test below.
  const revised = await request(app).post(`/issued-estimates/${rootId}/revise`).send({ waiveTrip: true });
  expect(revised.status).toBe(201);
  revId = revised.body.estimateId as string;
  const rev = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: revId } });
  expect(rev.signedAt).toBeNull();
  const rootAfterRevise = await prisma.issuedEstimate.findUniqueOrThrow({
    where: { id: rootId },
    include: { supersededBy: { select: { id: true } } },
  });
  expect(rootAfterRevise.status).toBe("signed");
  expect(rootAfterRevise.voidedAt).toBeNull();
  // The root itself is still live; it is the REVISION that names the root via supersedesId — the
  // reverse relation confirms the chain exists without asserting on a scalar that doesn't exist.
  expect(rootAfterRevise.supersededBy?.id).toBe(revId);
});

afterAll(async () => {
  const ests = await prisma.issuedEstimate.findMany({ where: { customerId }, select: { id: true } });
  const ids = ests.map((e) => e.id);
  await prisma.payment.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: ids } }, data: { supersedesId: null, changeOrderForId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: ids } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ITEM]);
});

describe("jobMaterials.ts allSignedEstimatesForJob (PUNCHLIST N3)", () => {
  it("still counts the signed root's material while its revision sits unsigned", async () => {
    const need = await materialNeedListForJob(jobId);
    expect(need.estimates.map((e) => e.id)).toContain(rootId);
    const line = need.lines.find((l) => l.itemId === ITEM);
    expect(line?.qty).toBe(3);
  });
});

describe("invoiceReminders.ts sweepInvoiceReminders (PUNCHLIST N3)", () => {
  it("still reminds the signed root's balance while its revision sits unsigned", async () => {
    process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS = "on";
    try {
      emailMock.sendBrandedEmail.mockClear();
      const result = await sweepInvoiceReminders(prisma);
      expect(result.reminded).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS;
    }
    const remindedThis = emailMock.sendBrandedEmail.mock.calls.some(
      (c) => c[0]?.issuedEstimateId === rootId || c[0]?.to === "n3rev-customer@example.com",
    );
    expect(remindedThis).toBe(true);
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: rootId } });
    expect(row.paymentRemindersSent).toBe(1);
    expect(row.lastPaymentReminderAt).not.toBeNull();
  });
});
