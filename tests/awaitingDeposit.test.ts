/**
 * Signed - awaiting deposit (Kyle, 2026-11-27: "she signed and hasn't paid so we need to see that
 * and process a payment for those who are financing").
 *
 * What these pin:
 *   1. GET /jobs/awaiting-deposit lists a contracted job whose signed root invoice needs a deposit
 *      that is not in - carrying the id the job drawer opens with, the customer, address, job type
 *      and estimate number.
 *   2. It leaves out: a paid deposit, an invoice that requires no deposit, a void or lost estimate,
 *      an estimate that was never signed, a booked job, and the test account.
 *   3. More than fifty newer consultations hide nothing (the list used to share the calendar rail's
 *      50-row window with them).
 *   4. The Calendar endpoint answers the same question through the same helper: the unpaid job is
 *      depositSatisfied false, the paid one true.
 *   5. GET /jobs is unchanged: an unpaid signed job is still NOT on the Jobs list (Kyle,
 *      2026-08-26: Jobs are signed work with the deposit paid), a paid one still is.
 *   6. Taking the deposit moves the job off the list.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

delete process.env.STRIPE_SECRET_KEY;
vi.mock("stripe", () => ({ default: class MockStripe { constructor() { throw new Error("Stripe must not be constructed in tests"); } } }));
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
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

const MARK = "AWD";

let customerId: string;
let propertyId: string;
let testCustomerId: string;
let testPropertyId: string;
let draftId: string;
let seq = 0;

const cleanup = async () => {
  const estIds = (await prisma.issuedEstimate.findMany({ where: { number: { startsWith: `0000-${MARK}` } }, select: { id: true } })).map((e) => e.id);
  await prisma.payment.deleteMany({ where: { OR: [{ estimateId: { in: estIds } }, { note: { startsWith: `${MARK} ` } }] } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: `${MARK} draft` } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: `${MARK}-SUP` } });
  await prisma.visit.deleteMany({ where: { purpose: { startsWith: `${MARK} ` } } });
  await prisma.property.deleteMany({ where: { name: { startsWith: `${MARK} ` } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: `${MARK} ` } } });
};

/** A contracted, unbooked job. `purpose` carries the mark so cleanup finds it. */
async function makeJob(opts: { customer?: "real" | "test"; status?: string; scheduled?: boolean; jobType?: string } = {}) {
  seq += 1;
  const test = opts.customer === "test";
  return prisma.visit.create({
    data: {
      customerId: test ? testCustomerId : customerId,
      propertyId: test ? testPropertyId : propertyId,
      mode: "service_diagnostic",
      status: opts.status ?? "contracted",
      jobType: opts.jobType ?? "Panel swap",
      purpose: `${MARK} job ${seq}`,
      ...(opts.scheduled ? { scheduledStart: new Date("2031-05-04T14:00:00.000Z"), scheduledEnd: new Date("2031-05-04T18:00:00.000Z") } : {}),
    },
  });
}

/** A $425 signed estimate on the job (trip $75 + $350 option A) - deposit one third = $141.67. */
async function sign(visitId: string, opts: { depositRequired?: boolean; status?: string; voidedAt?: Date | null; signedAt?: Date | null; customer?: "real" | "test" } = {}) {
  seq += 1;
  const test = opts.customer === "test";
  return prisma.issuedEstimate.create({
    data: {
      number: `0000-${MARK}${seq}`,
      token: `awdtoken${seq}${Date.now()}`.padEnd(40, "0"),
      status: opts.status ?? "signed",
      draftId,
      customerId: test ? testCustomerId : customerId,
      serviceAddressId: test ? testPropertyId : propertyId,
      customerName: `${MARK} Customer`,
      customerEmail: "awd-customer@example.com",
      serviceAddress: "9 Waiting Lane, Hermitage, TN",
      title: "Panel swap",
      scopeText: "Panel swap.",
      workSubtotal: 350,
      tripCharge: 75,
      total: 425,
      sentAt: new Date(),
      sentTo: "awd-customer@example.com",
      visitId,
      jobVisitId: visitId,
      signedAt: opts.signedAt === undefined ? new Date() : opts.signedAt,
      voidedAt: opts.voidedAt ?? null,
      signerName: `${MARK} Customer`,
      signedChannel: "email",
      depositRequired: opts.depositRequired ?? true,
      selectedOptions: ["A"],
      comboCapJson: JSON.stringify({ applied: false, reduction: 0, ceiling: 0, bandLabel: "n/a" }),
      options: { create: [{ option: "A", label: "Panel swap", subtotal: 350, lineCount: 2 }] },
    },
  });
}

const payDeposit = (estimateId: string) =>
  prisma.payment.create({ data: { amount: 141.67, method: "cash", kind: "deposit", payer: "customer", status: "paid", customerId, estimateId, paidAt: new Date(), note: `${MARK} deposit` } });

const awaiting = async () => {
  const res = await request(app).get("/jobs/awaiting-deposit");
  expect(res.status).toBe(200);
  return res.body as Array<{ visitId: string; customerName: string; address: string; jobType: string | null; estimateNumber: string }>;
};

beforeAll(async () => {
  await cleanup();
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "awd-customer@example.com" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} property`, addressLine1: "9 Waiting Lane", city: "Hermitage", state: "TN", postalCode: "37076" },
  });
  propertyId = property.id;
  const test = await prisma.customer.create({ data: { name: `${MARK} Test Account`, isTestAccount: true } });
  testCustomerId = test.id;
  const testProperty = await prisma.property.create({
    data: { customerId: testCustomerId, name: `${MARK} test property`, addressLine1: "1 Instrument Way", city: "Hermitage", state: "TN", postalCode: "37076" },
  });
  testPropertyId = testProperty.id;
  await prisma.priceBookSupplier.create({ data: { id: `${MARK}-SUP`, name: `${MARK} Supply`, quotable: "YES" } });
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} draft`, supplierId: `${MARK}-SUP` } });
  draftId = draft.id;
});

afterAll(cleanup);

describe("GET /jobs/awaiting-deposit", () => {
  it("lists a contracted job whose signed invoice needs a deposit that is not in, with what the row needs", async () => {
    const job = await makeJob({ jobType: "Panel swap" });
    const est = await sign(job.id);

    const rows = await awaiting();
    const row = rows.find((r) => r.visitId === job.id);
    expect(row).toBeDefined();
    // visitId IS the id OpenDrawerButton kind="job" opens the job drawer with (EstimateDrawer passes jobVisitId).
    expect(row).toMatchObject({
      visitId: job.id,
      customerName: `${MARK} Customer`,
      address: "9 Waiting Lane, Hermitage, TN",
      jobType: "Panel swap",
      estimateNumber: est.number,
    });
  });

  it("leaves out a paid deposit, an invoice that needs none, void and lost estimates, an unsigned one, a booked job and the test account", async () => {
    const paid = await makeJob();
    await payDeposit((await sign(paid.id)).id);

    const noDeposit = await makeJob();
    await sign(noDeposit.id, { depositRequired: false });

    const voided = await makeJob();
    await sign(voided.id, { status: "void", voidedAt: new Date() });

    const lost = await makeJob();
    await sign(lost.id, { status: "lost" });

    const unsigned = await makeJob();
    await sign(unsigned.id, { status: "sent", signedAt: null });

    const booked = await makeJob({ scheduled: true });
    await sign(booked.id);

    const testJob = await makeJob({ customer: "test" });
    await sign(testJob.id, { customer: "test" });

    const ids = (await awaiting()).map((r) => r.visitId);
    for (const left of [paid, noDeposit, voided, lost, unsigned, booked, testJob]) expect(ids).not.toContain(left.id);
  });

  it("is not hidden by more than fifty newer consultations (no shared 50-row window)", async () => {
    const job = await makeJob();
    await sign(job.id);
    await prisma.visit.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({
        customerId,
        propertyId,
        mode: "service_diagnostic",
        status: "estimate",
        purpose: `${MARK} consultation ${i}`,
        createdAt: new Date(Date.now() + 60_000 + i),
      })),
    });

    try {
      expect((await awaiting()).map((r) => r.visitId)).toContain(job.id);
    } finally {
      // They are newer than everything else, so left in place they would crowd later tests out of the calendar rail's own 50.
      await prisma.visit.deleteMany({ where: { purpose: { startsWith: `${MARK} consultation` } } });
    }
  });

  it("drops the job once its deposit is recorded", async () => {
    const job = await makeJob();
    const est = await sign(job.id);
    expect((await awaiting()).map((r) => r.visitId)).toContain(job.id);

    await payDeposit(est.id);
    expect((await awaiting()).map((r) => r.visitId)).not.toContain(job.id);
  });
});

describe("the same rule, everywhere", () => {
  it("the Calendar rail's depositSatisfied agrees with the list: unpaid false, paid true", async () => {
    const unpaid = await makeJob();
    await sign(unpaid.id);
    const paid = await makeJob();
    await payDeposit((await sign(paid.id)).id);

    const res = await request(app).get("/crm/schedule/calendar?start=2031-05-01&end=2031-05-31");
    expect(res.status).toBe(200);
    const byId = new Map<string, boolean | null>(res.body.unscheduled.map((u: { visitId: string; depositSatisfied: boolean | null }) => [u.visitId, u.depositSatisfied]));
    expect(byId.get(unpaid.id)).toBe(false);
    expect(byId.get(paid.id)).toBe(true);
    expect((await awaiting()).map((r) => r.visitId)).toContain(unpaid.id);
    expect((await awaiting()).map((r) => r.visitId)).not.toContain(paid.id);
  });

  it("a contracted, unbooked job with no signed estimate is ready to schedule on the Calendar rail (the scheduling gate is open for it) and is not on the awaiting list", async () => {
    const bare = await makeJob();
    const res = await request(app).get("/crm/schedule/calendar?start=2031-05-01&end=2031-05-31");
    expect(res.status).toBe(200);
    const row = res.body.unscheduled.find((u: { visitId: string }) => u.visitId === bare.id);
    expect(row).toBeDefined();
    expect(row.depositSatisfied).toBe(true);
    expect((await awaiting()).map((r) => r.visitId)).not.toContain(bare.id);
  });

  it("GET /jobs is unchanged: an unpaid signed job is not on the Jobs list, a paid one is", async () => {
    const unpaid = await makeJob();
    await sign(unpaid.id);
    const paid = await makeJob();
    await payDeposit((await sign(paid.id)).id);

    const res = await request(app).get("/jobs");
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ visitId: string }>).map((j) => j.visitId);
    expect(ids).toContain(paid.id);
    expect(ids).not.toContain(unpaid.id);
  });
});
