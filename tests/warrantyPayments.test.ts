/**
 * Warranty payer tracking (Kyle, 2026-09-10).
 *
 *   "Patricia's warranty portion of the job is not getting tracked and doesn't
 *    have a system to record its payment to that job when that check comes in."
 *
 * The live case: 2026-1065, Option A $425, RELY Home claim 343467219 /
 * auth45978673 for $370. Ratified 2026-09-09: one account, two payers. The
 * homeowner's money closes the homeowner share ($55); the warranty company's
 * money closes the covered amount ($370); neither reduces the other. The
 * warranty share is a receivable with dates, chased on its own; the homeowner
 * is never reminded about it; the job earned the full $425.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { fullBillOf, paymentSummary, parseWarrantyJson, warrantyReceivableStatus } from "../src/services/stripePayments";
import { sendInvoiceReminder, sweepInvoiceReminders } from "../src/services/invoiceReminders";

// Stripe never reaches the network from here: the key is unset (every pay surface
// hides itself) and the client factory is stubbed so nothing can construct one.
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
// The customer receipt / balance emails: counted, never sent.
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";

const RELY = {
  company: "RELY Home",
  claimNumber: "343467219",
  authNumber: "auth45978673",
  coveredAmount: 370,
  note: "3 hrs labor + $70 toward fan; other issues not covered",
  setAt: "2026-09-09T15:00:00.000Z",
};
const RELY_JSON = JSON.stringify(RELY);

let customerId: string;
let propertyId: string;
let draftId: string;

const cleanup = async () => {
  await prisma.payment.deleteMany({ where: { estimateId: { in: (await prisma.issuedEstimate.findMany({ where: { number: { startsWith: "0000-WPY" } }, select: { id: true } })).map((e) => e.id) } } });
  await prisma.issuedEstimate.deleteMany({ where: { number: { startsWith: "0000-WPY" } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: "warranty-pay draft" } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: "WPYTEST-SUP" } });
  await prisma.visit.deleteMany({ where: { purpose: "warranty-pay visit" } });
  await prisma.property.deleteMany({ where: { name: "warranty-pay property" } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: "Warranty Pay Test" } } });
};

/** Option A $425 = trip $75 + $350 fan install; the 2026-1065 shape, signed. */
async function issue(input: { suffix: string; warrantyJson?: string | null; visitId?: string | null; signedAt?: Date }) {
  return prisma.issuedEstimate.create({
    data: {
      number: `0000-WPY${input.suffix}`,
      token: `wpytoken${input.suffix}${Date.now()}`.padEnd(40, "0"),
      status: "signed",
      draftId,
      customerId,
      serviceAddressId: propertyId,
      customerName: "Warranty Pay Test Copeland",
      customerEmail: "copeland-pay@example.com",
      serviceAddress: "5937 New Hope Court, Hermitage, TN",
      title: "Warranty Call + Electrical Assessment",
      scopeText: "Ceiling fan install and balance, 54-inch, customer-supplied fan.",
      workSubtotal: 350,
      tripCharge: 75,
      total: 425,
      sentAt: new Date(),
      sentTo: "copeland-pay@example.com",
      warrantyJson: input.warrantyJson === undefined ? RELY_JSON : input.warrantyJson,
      visitId: input.visitId ?? null,
      jobVisitId: input.visitId ?? null,
      signedAt: input.signedAt ?? new Date(),
      signerName: "Patricia Copeland",
      signedChannel: "email",
      selectedOptions: ["A"],
      comboCapJson: JSON.stringify({ applied: false, reduction: 0, ceiling: 0, bandLabel: "n/a" }),
      options: { create: [{ option: "A", label: "Warranty call + fan install", subtotal: 350, lineCount: 2 }] },
    },
  });
}

const summaryOf = (id: string) => paymentSummary(prisma, id, "https://unused.invalid");

beforeAll(async () => {
  await cleanup();
  const customer = await prisma.customer.create({ data: { name: "Warranty Pay Test Copeland", email: "copeland-pay@example.com" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "warranty-pay property", addressLine1: "5937 New Hope Court", city: "Hermitage", state: "TN", postalCode: "37076" },
  });
  propertyId = property.id;
  await prisma.priceBookSupplier.create({ data: { id: "WPYTEST-SUP", name: "Warranty Pay Supply", quotable: "YES" } });
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: "warranty-pay draft", supplierId: "WPYTEST-SUP" } });
  draftId = draft.id;
});

afterAll(cleanup);

// ─── paymentSummary: two payers, two ledgers ─────────────────────────────────

describe("paymentSummary splits the two payers", () => {
  it("customer pays $55 → homeowner balance 0, warranty balance 370, paidInFull true, fullyPaid false; RELY's $370 → fullyPaid", async () => {
    const est = await issue({ suffix: "1" });
    const fresh = (await summaryOf(est.id))!;
    expect(fresh.billedTotal).toBe(55);
    expect(fresh.balance).toBe(55);
    expect(fresh.warranty).toMatchObject({ covered: 370, paid: 0, balance: 370, claim: { claimNumber: "343467219" } });
    expect(fresh.paidInFull).toBe(false);
    expect(fresh.fullyPaid).toBe(false);

    const res = await request(app).post("/financials/payments").send({ amount: 55, method: "zelle", kind: "final", estimateId: est.id, customerId });
    expect(res.status).toBe(201);
    expect(res.body.payer).toBe("customer");

    const afterCustomer = (await summaryOf(est.id))!;
    expect(afterCustomer.totalPaid).toBe(55);
    expect(afterCustomer.balance).toBe(0);
    expect(afterCustomer.paidInFull).toBe(true);
    expect(afterCustomer.fullyPaid).toBe(false);
    expect(afterCustomer.warranty!.paid).toBe(0);
    expect(afterCustomer.warranty!.balance).toBe(370);

    const check = await request(app).post("/financials/payments").send({
      amount: 370, method: "check", payer: "warranty", checkNumber: "104477", estimateId: est.id, paidAt: "2026-10-20T12:00:00.000Z",
    });
    expect(check.status).toBe(201);
    expect(check.body).toMatchObject({ payer: "warranty", checkNumber: "104477", amount: 370, estimateId: est.id, customerId });

    const done = (await summaryOf(est.id))!;
    expect(done.totalPaid).toBe(55); // the homeowner's figure never moved
    expect(done.balance).toBe(0);
    expect(done.warranty).toMatchObject({ covered: 370, paid: 370, balance: 0 });
    expect(done.paidInFull).toBe(true);
    expect(done.fullyPaid).toBe(true);
    expect(done.payments.find((p) => p.payer === "warranty")?.checkNumber).toBe("104477");

    // The check stamped the claim: received + deposited on the paid date, check number, and a trail.
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id }, include: { events: true } });
    const claim = parseWarrantyJson(row.warrantyJson)!;
    expect(claim.receivedAt).toBe("2026-10-20T12:00:00.000Z");
    expect(claim.depositedAt).toBe("2026-10-20T12:00:00.000Z");
    expect(claim.checkNumber).toBe("104477");
    expect(claim.events.at(-1)).toMatchObject({ kind: "payment", actor: "human:crm-session" });
    expect(claim.events.at(-1)!.detail).toContain("$370.00 check #104477");
    expect(row.events.some((e) => e.type === "warranty_payment" && e.detail?.includes("RELY Home paid $370.00"))).toBe(true);

    // The payment-info route the panels read carries the split.
    const info = await request(app).get(`/issued-estimates/${est.id}/payment-info`);
    expect(info.status).toBe(200);
    expect(info.body.warranty).toMatchObject({ covered: 370, paid: 370, balance: 0 });
    expect(info.body.fullyPaid).toBe(true);
  });

  it("a warranty check never touches the homeowner's balance, and a customer payment never touches the warranty's", async () => {
    const est = await issue({ suffix: "2" });
    const check = await request(app).post("/financials/payments").send({ amount: 370, method: "check", payer: "warranty", estimateId: est.id });
    expect(check.status).toBe(201);
    const s1 = (await summaryOf(est.id))!;
    expect(s1.totalPaid).toBe(0);
    expect(s1.balance).toBe(55);
    expect(s1.paidInFull).toBe(false);
    expect(s1.depositSatisfied).toBe(false); // RELY's money does not open the homeowner's deposit gate
    expect(s1.warranty!.balance).toBe(0);
    expect(s1.fullyPaid).toBe(false);

    const dep = await request(app).post("/financials/payments").send({ amount: 18.33, method: "cash", kind: "deposit", estimateId: est.id });
    expect(dep.status).toBe(201);
    const s2 = (await summaryOf(est.id))!;
    expect(s2.depositPaid).toBe(18.33);
    expect(s2.depositSatisfied).toBe(true);
    expect(s2.balance).toBe(36.67);
    expect(s2.warranty).toMatchObject({ paid: 370, balance: 0 });

    // GET /invoices reads the same split.
    const inv = await request(app).get("/invoices");
    const row = inv.body.find((i: { id: string }) => i.id === est.id);
    expect(row).toMatchObject({ billedTotal: 55, totalPaid: 18.33, balance: 36.67, warrantyCovered: 370, warrantyPaid: 370, warrantyBalance: 0, warrantyStatus: "paid", paymentStatus: "deposit_paid" });
    expect(row.collected).toBe(388.33); // money is money — both payers
  });
});

// ─── Refusals ────────────────────────────────────────────────────────────────

describe("POST /financials/payments with payer warranty", () => {
  it("400 without a claim on the estimate, 400 without an estimate", async () => {
    const plain = await issue({ suffix: "3", warrantyJson: null });
    const res = await request(app).post("/financials/payments").send({ amount: 100, method: "check", payer: "warranty", estimateId: plain.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No warranty claim is recorded/);
    expect(await prisma.payment.count({ where: { estimateId: plain.id } })).toBe(0);

    const none = await request(app).post("/financials/payments").send({ amount: 100, method: "check", payer: "warranty" });
    expect(none.status).toBe(400);
  });

  it("409 above the warranty balance (+ $0.01 tolerance), and never records", async () => {
    const est = await issue({ suffix: "4" });
    const over = await request(app).post("/financials/payments").send({ amount: 370.5, method: "check", payer: "warranty", estimateId: est.id });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatch(/more than RELY Home still owes/);
    expect(await prisma.payment.count({ where: { estimateId: est.id } })).toBe(0);

    const part = await request(app).post("/financials/payments").send({ amount: 200, method: "ach", payer: "warranty", estimateId: est.id });
    expect(part.status).toBe(201);
    const again = await request(app).post("/financials/payments").send({ amount: 170.02, method: "check", payer: "warranty", estimateId: est.id });
    expect(again.status).toBe(409);
    const exact = await request(app).post("/financials/payments").send({ amount: 170.01, method: "check", payer: "warranty", estimateId: est.id });
    expect(exact.status).toBe(201);
    expect((await summaryOf(est.id))!.warranty!.balance).toBeLessThanOrEqual(0.01);
  });
});

// ─── The homeowner is never written to about the warranty share ──────────────

describe("customer emails and the warranty payment", () => {
  it("a warranty check sends no receipt while the homeowner still owes; the homeowner's own payment does", async () => {
    const est = await issue({ suffix: "5" });
    emailMock.sendBrandedEmail.mockClear();
    await request(app).post("/financials/payments").send({ amount: 370, method: "check", payer: "warranty", estimateId: est.id });
    await new Promise((r) => setTimeout(r, 150)); // fire-and-forget receipts settle
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();

    await request(app).post("/financials/payments").send({ amount: 55, method: "check", estimateId: est.id });
    await new Promise((r) => setTimeout(r, 150));
    expect(emailMock.sendBrandedEmail).toHaveBeenCalledTimes(1);
    expect(emailMock.sendBrandedEmail.mock.calls[0][0].subject).toMatch(/^Paid in full/);
  });

  it("invoice reminders read the HOMEOWNER balance — a homeowner-paid estimate with RELY still owing is not reminded", async () => {
    const est = await issue({ suffix: "6", signedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) });
    await request(app).post("/financials/payments").send({ amount: 55, method: "zelle", estimateId: est.id, paidAt: new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString() });
    const s = (await summaryOf(est.id))!;
    expect(s.paidInFull).toBe(true);
    expect(s.warranty!.balance).toBe(370);

    // The manual button: nothing to bill the homeowner.
    const manual = await sendInvoiceReminder(prisma, est.id);
    expect(manual).toEqual({ ok: false, reason: "This invoice is already paid in full." });

    // The sweep: quiet for 20 days, under the reminder cap, and still skipped.
    process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS = "on";
    try {
      emailMock.sendBrandedEmail.mockClear();
      await sweepInvoiceReminders(prisma);
    } finally {
      delete process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS;
    }
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } });
    expect(row.paymentRemindersSent).toBe(0);
    expect(row.lastPaymentReminderAt).toBeNull();
    const remindedThis = emailMock.sendBrandedEmail.mock.calls.some((c) => c[0].issuedEstimateId === est.id);
    expect(remindedThis).toBe(false);
  });
});

// ─── Revenue: the full bill, in lockstep ─────────────────────────────────────

describe("revenue is the full bill (homeowner + warranty)", () => {
  it("fullBillOf = pre-coverage total; GET /jobs and the account summary quote it identically", async () => {
    expect(fullBillOf({ total: 425, tripCharge: 75, selectedOptions: ["A"], comboCapJson: null, discountJson: null, warrantyJson: RELY_JSON, optionsSubtotals: [{ option: "A", subtotal: 350 }] })).toBe(425);

    const visit = await prisma.visit.create({
      data: { customerId, propertyId, mode: "service_diagnostic", purpose: "warranty-pay visit", status: "scheduled" },
    });
    const est = await issue({ suffix: "7", visitId: visit.id });
    // Only RELY has paid so far — the homeowner's deposit gate must stay shut on the Jobs tab…
    await request(app).post("/financials/payments").send({ amount: 370, method: "check", payer: "warranty", estimateId: est.id });
    const gated = await request(app).get("/jobs");
    expect(gated.body.find((j: { visitId: string }) => j.visitId === visit.id)).toBeUndefined();
    // …until the homeowner's ⅓ lands.
    await request(app).post("/financials/payments").send({ amount: 18.33, method: "check", kind: "deposit", estimateId: est.id });

    const jobs = await request(app).get("/jobs");
    const summary = await request(app).get(`/accounts/${customerId}/summary`);
    const fromJobs = jobs.body.find((j: { visitId: string }) => j.visitId === visit.id);
    const fromSummary = summary.body.jobs.find((j: { visitId: string }) => j.visitId === visit.id);
    expect(fromJobs).toBeTruthy();
    expect(fromSummary).toBeTruthy();
    expect(fromSummary.costs).toEqual(fromJobs.costs);
    expect(fromJobs.costs.revenue).toBe(425);
    expect(fromJobs.estimate.totalCost).toBe(55); // the invoice figure stays the homeowner share
  });
});

// ─── Claim tracking ──────────────────────────────────────────────────────────

describe("PATCH /issued-estimates/:id/warranty/tracking", () => {
  it("writes the dates with an event; expectedAt defaults to submitted + 45 days", async () => {
    const est = await issue({ suffix: "8" });
    const res = await request(app).patch(`/issued-estimates/${est.id}/warranty/tracking`).send({
      submittedAt: "2026-09-10T12:00:00.000Z",
      reason: "submitted on the RELY portal",
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.warranty.submittedAt).toBe("2026-09-10T12:00:00.000Z");
    expect(res.body.warranty.expectedAt).toBe("2026-10-25T12:00:00.000Z");
    expect(res.body.warranty.coveredAmount).toBe(370); // the price did not move

    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id }, include: { events: true } });
    const claim = parseWarrantyJson(row.warrantyJson)!;
    expect(claim.events).toHaveLength(1);
    expect(claim.events[0]).toMatchObject({ kind: "tracking", actor: "human:crm-session", reason: "submitted on the RELY portal" });
    expect(claim.events[0].detail).toContain("submittedAt — → 2026-09-10");
    expect(claim.events[0].detail).toContain("expectedAt — → 2026-10-25 (submitted + 45 days)");
    expect(row.events.some((e) => e.type === "warranty_tracking" && e.detail?.includes("reason: submitted on the RELY portal"))).toBe(true);

    // A typed expected date wins; a plain date-input value parses; the check number lands.
    const res2 = await request(app).patch(`/issued-estimates/${est.id}/warranty/tracking`).send({
      expectedAt: "2026-10-01", approvedAt: "2026-09-20", checkNumber: "2211", reason: "RELY approved by phone",
    });
    expect(res2.status).toBe(200);
    expect(res2.body.warranty.expectedAt.slice(0, 10)).toBe("2026-10-01");
    expect(res2.body.warranty.checkNumber).toBe("2211");
    expect(res2.body.warranty.events).toHaveLength(2);

    // No reason → 400; no change → changed:false and no new event.
    expect((await request(app).patch(`/issued-estimates/${est.id}/warranty/tracking`).send({ approvedAt: "2026-09-21" })).status).toBe(400);
    const same = await request(app).patch(`/issued-estimates/${est.id}/warranty/tracking`).send({ checkNumber: "2211", reason: "noop" });
    expect(same.body.changed).toBe(false);
    expect(parseWarrantyJson((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).warrantyJson)!.events).toHaveLength(2);
  });

  it("400 on an estimate without a claim", async () => {
    const plain = await issue({ suffix: "9", warrantyJson: null });
    const res = await request(app).patch(`/issued-estimates/${plain.id}/warranty/tracking`).send({ submittedAt: "2026-09-10", reason: "x" });
    expect(res.status).toBe(400);
  });
});

// ─── The receivables list ────────────────────────────────────────────────────

describe("GET /warranty-receivables", () => {
  it("statuses: not submitted / submitted / overdue / paid, with totals", () => {
    const base = { submittedAt: null, expectedAt: null };
    expect(warrantyReceivableStatus(base, 370)).toBe("not submitted");
    expect(warrantyReceivableStatus({ submittedAt: "2026-09-10T12:00:00.000Z", expectedAt: "2099-01-01T00:00:00.000Z" }, 370)).toBe("submitted");
    expect(warrantyReceivableStatus({ submittedAt: "2026-07-01T12:00:00.000Z", expectedAt: "2026-08-15T12:00:00.000Z" }, 370)).toBe("overdue");
    expect(warrantyReceivableStatus({ submittedAt: "2026-07-01T12:00:00.000Z", expectedAt: "2026-08-15T12:00:00.000Z" }, 0)).toBe("paid");
  });

  it("lists every signed covered estimate with its money, dates, and status", async () => {
    const notSubmitted = await issue({ suffix: "10" });
    const overdue = await issue({ suffix: "11", warrantyJson: JSON.stringify({ ...RELY, submittedAt: "2026-06-01T12:00:00.000Z", expectedAt: "2026-07-16T12:00:00.000Z" }) });
    const submitted = await issue({ suffix: "12", warrantyJson: JSON.stringify({ ...RELY, submittedAt: "2026-09-01T12:00:00.000Z", expectedAt: "2099-10-16T12:00:00.000Z" }) });
    const paid = await issue({ suffix: "13", warrantyJson: JSON.stringify({ ...RELY, submittedAt: "2026-06-01T12:00:00.000Z", expectedAt: "2026-07-16T12:00:00.000Z" }) });
    await request(app).post("/financials/payments").send({ amount: 370, method: "check", payer: "warranty", checkNumber: "9", estimateId: paid.id });
    await issue({ suffix: "14", warrantyJson: null }); // no claim → not listed

    const res = await request(app).get("/warranty-receivables");
    expect(res.status).toBe(200);
    const byId = new Map<string, { status: string; balance: number; paid: number; daysOutstanding: number; checkNumber: string | null; account: { id: string } }>(
      res.body.rows.map((r: { estimateId: string }) => [r.estimateId, r]),
    );
    expect(byId.get(notSubmitted.id)).toMatchObject({ status: "not submitted", balance: 370, paid: 0, account: { id: customerId } });
    expect(byId.get(overdue.id)).toMatchObject({ status: "overdue", balance: 370 });
    expect(byId.get(overdue.id)!.daysOutstanding).toBeGreaterThan(45);
    expect(byId.get(submitted.id)).toMatchObject({ status: "submitted", balance: 370 });
    expect(byId.get(paid.id)).toMatchObject({ status: "paid", balance: 0, paid: 370, checkNumber: "9", daysOutstanding: 0 });
    expect(res.body.rows.find((r: { number: string }) => r.number === "0000-WPY14")).toBeUndefined();

    // Overdue rows sort first; totals add up over the whole list.
    const statuses = res.body.rows.map((r: { status: string }) => r.status);
    expect(statuses.indexOf("overdue")).toBeLessThan(statuses.indexOf("paid"));
    const ours = res.body.rows.filter((r: { number: string }) => r.number.startsWith("0000-WPY"));
    expect(res.body.totals.count).toBeGreaterThanOrEqual(ours.length);
    expect(res.body.totals.balance).toBeGreaterThanOrEqual(1110);
    expect(res.body.totals.overdue).toBeGreaterThanOrEqual(1);
  });
});
