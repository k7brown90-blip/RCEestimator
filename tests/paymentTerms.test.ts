/**
 * Payment terms, the deposit on a financed job, and the reminder pause (Kyle, 2026-10-08;
 * one-estimating-system plan decisions 8 and 9, Detail B build audit items F, J and K;
 * Phase 6 Unit 6C).
 *
 * What these pin:
 *   1. DUE UPON RECEIPT, for EVERY customer (decision 9): the words are one constant
 *      (services/paymentTerms.ts), snapshotted here WORD FOR WORD, and no customer document still
 *      says "due at completion". The final bill ("Your final bill") states the balance is due upon
 *      receipt; inspections and the fix obligation are never mentioned (Kyle: "it doesn't need to be
 *      explained here").
 *   2. THE DEPOSIT ON A FINANCED JOB (decision 8): refused before the deposit is in, AND again at
 *      recording the Synchrony payment (a deposit voided or an unticked "Deposit required" after the
 *      fee went on must not let the balance be financed). The tech sees the same reason on the field
 *      payment screen (payment-info `financingBlocked`).
 *   3. REMINDERS: a customer whose balance is being paid through Synchrony is not chased — not by
 *      the daily sweep and not by the manual "Send reminder" — and they resume when the fee is removed.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { chargeableAmount } from "../src/services/stripePayments";
import { getActiveFinancingPlans } from "../src/services/financingSettings";
import { FINANCING_IN_PROGRESS, removeFinancingFee } from "../src/services/financingFee";
import { REMINDER_PAUSED_FOR_FINANCING, sendInvoiceReminder, sweepInvoiceReminders } from "../src/services/invoiceReminders";
import { BALANCE_DUE_TERMS, CONTRACT_PAYMENT_TERMS, FINAL_BILL_TERMS } from "../src/services/paymentTerms";

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
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { sendBalanceRequestEmail, sendDepositRequestEmail, sendPaymentReceiptEmail } from "../src/services/paymentReceipts";

const MARK = "PTRM";
const ORIGIN = "https://unused.invalid";

let customerId: string;
let propertyId: string;
let draftId: string;
let techToken: string;
let technicianId: string;

const cleanup = async () => {
  const estIds = (await prisma.issuedEstimate.findMany({ where: { number: { startsWith: `0000-${MARK}` } }, select: { id: true } })).map((e) => e.id);
  await prisma.payment.deleteMany({ where: { OR: [{ estimateId: { in: estIds } }, { note: { startsWith: `${MARK} ` } }] } });
  await prisma.financingFee.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: `${MARK} draft` } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: `${MARK}-SUP` } });
  await prisma.visitAssignment.deleteMany({ where: { visit: { purpose: `${MARK} visit` } } });
  await prisma.visit.deleteMany({ where: { purpose: `${MARK} visit` } });
  await prisma.property.deleteMany({ where: { name: `${MARK} property` } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: `${MARK} Customer` } } });
  await prisma.technician.deleteMany({ where: { name: `${MARK} Tech` } });
  await prisma.systemEvent.deleteMany({ where: { message: { contains: `0000-${MARK}` } } });
};

/** A $425 signed estimate (trip $75 + $350 option A) — deposit 1/3 = $141.67, balance after it $283.33. */
async function issue(suffix: string, opts: { visitId?: string | null; depositRequired?: boolean } = {}) {
  return prisma.issuedEstimate.create({
    data: {
      number: `0000-${MARK}${suffix}`,
      // 64 hex characters — the shape /e/:token insists on (getEstimateByToken).
      token: `ab${suffix.charCodeAt(0).toString(16)}${Date.now().toString(16)}`.padEnd(64, "0"),
      status: "signed",
      draftId,
      customerId,
      serviceAddressId: propertyId,
      customerName: `${MARK} Customer`,
      customerEmail: "ptrm-customer@example.com",
      serviceAddress: "9 Terms Lane, Hermitage, TN",
      title: "Panel upgrade",
      scopeText: "Panel upgrade.",
      workSubtotal: 350,
      tripCharge: 75,
      total: 425,
      sentAt: new Date(),
      sentTo: "ptrm-customer@example.com",
      visitId: opts.visitId ?? null,
      jobVisitId: opts.visitId ?? null,
      signedAt: new Date(),
      signerName: `${MARK} Customer`,
      signedChannel: "email",
      depositRequired: opts.depositRequired ?? true,
      selectedOptions: ["A"],
      comboCapJson: JSON.stringify({ applied: false, reduction: 0, ceiling: 0, bandLabel: "n/a" }),
      options: { create: [{ option: "A", label: "Panel", subtotal: 350, lineCount: 2 }] },
    },
  });
}

const record = (body: Record<string, unknown>) => request(app).post("/financials/payments").send(body);
const addFee = (estimateId: string, planNumber: string) => request(app).post("/financials/financing-fees").send({ estimateId, planNumber });
const voidIt = (id: string, reason: string) => request(app).post(`/financials/payments/${id}/void`).send({ reason });
const depositOn = (estimateId: string) => record({ amount: 141.67, method: "cash", kind: "deposit", estimateId, customerId, paidAt: "2019-05-01T12:00:00.000Z" });
const lastEmail = () => emailMock.sendBrandedEmail.mock.calls.at(-1)![0] as { subject: string; bodyHtml: string; headline: string };

async function firstPlan() {
  const plans = await getActiveFinancingPlans();
  expect(plans.length).toBeGreaterThan(0);
  return plans[0];
}

beforeAll(async () => {
  await cleanup();
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "ptrm-customer@example.com" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} property`, addressLine1: "9 Terms Lane", city: "Hermitage", state: "TN", postalCode: "37076" },
  });
  propertyId = property.id;
  await prisma.priceBookSupplier.create({ data: { id: `${MARK}-SUP`, name: `${MARK} Supply`, quotable: "YES" } });
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} draft`, supplierId: `${MARK}-SUP` } });
  draftId = draft.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `ptrm-tech-${customer.id}`, role: "technician" } });
  technicianId = tech.id;
  techToken = tech.accessToken;
});

afterAll(cleanup);

// ─── 1. Due upon receipt of the final invoice — everyone ────────────────────────────────────

describe("payment terms: due upon receipt of the final invoice (decision 9)", () => {
  it("the wording, word for word", () => {
    expect(BALANCE_DUE_TERMS).toBe("The balance is due upon receipt of your final invoice.");
    expect(FINAL_BILL_TERMS).toBe("This balance is due upon receipt of this invoice.");
    expect(CONTRACT_PAYMENT_TERMS).toBe("Due upon receipt of the final invoice");
    // Kyle: "it doesn't need to be explained here" — no inspections, no fix obligation, no completion.
    for (const words of [BALANCE_DUE_TERMS, FINAL_BILL_TERMS, CONTRACT_PAYMENT_TERMS]) {
      expect(words).not.toMatch(/inspect|fix|repair|obligat|complet/i);
    }
  });

  it("no customer-facing source still says the balance is due at completion", () => {
    const root = path.resolve(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
        if (entry.name === "paymentTerms.ts") continue; // quotes the old wording in its own header
        const text = fs.readFileSync(full, "utf8");
        if (/\bdue\s+(at|upon|on)\s+completion/i.test(text) || /balance is due at completion/i.test(text) || /at completion of the work/i.test(text)) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    for (const dir of ["src", "client/src", "field/src", "shared"]) walk(path.join(root, dir));
    expect(offenders).toEqual([]);
  });

  it("the deposit request, a part-payment receipt and the final bill (normal, reminder, financed) all say due upon receipt", async () => {
    const est = await issue("1");

    // The deposit request email.
    emailMock.sendBrandedEmail.mockClear();
    await sendDepositRequestEmail(prisma, est.id, ORIGIN);
    expect(emailMock.sendBrandedEmail).toHaveBeenCalledTimes(1);
    expect(lastEmail().bodyHtml).toContain(BALANCE_DUE_TERMS);
    expect(lastEmail().bodyHtml).not.toMatch(/at completion/i);

    // A receipt that leaves a balance (the deposit): the remaining balance is due upon receipt of the final invoice.
    const dep = await depositOn(est.id);
    expect(dep.status).toBe(201);
    // (The record route also fires this receipt on its own, fire-and-forget — so look at every receipt sent.)
    emailMock.sendBrandedEmail.mockClear();
    await sendPaymentReceiptEmail(prisma, dep.body.id);
    const receipts = emailMock.sendBrandedEmail.mock.calls.map((c) => c[0] as { kind: string; bodyHtml: string }).filter((c) => c.kind === "receipt");
    expect(receipts.length).toBeGreaterThan(0);
    for (const r of receipts) {
      expect(r.bodyHtml).toContain(BALANCE_DUE_TERMS);
      expect(r.bodyHtml).not.toMatch(/at completion/i);
    }

    // The FINAL BILL — "Your final bill" — states it is due upon receipt of THIS invoice.
    emailMock.sendBrandedEmail.mockClear();
    expect(await sendBalanceRequestEmail(prisma, est.id, ORIGIN)).toMatchObject({ ok: true, amount: 283.33 });
    expect(lastEmail().headline).toBe("Your final bill");
    expect(lastEmail().bodyHtml).toContain(FINAL_BILL_TERMS);
    expect(lastEmail().bodyHtml).toContain("/pay/");
    expect(lastEmail().bodyHtml).not.toMatch(/inspect|at completion/i);

    // The reminder version is the same document.
    emailMock.sendBrandedEmail.mockClear();
    expect(await sendBalanceRequestEmail(prisma, est.id, ORIGIN, { reminder: true })).toMatchObject({ ok: true });
    expect(lastEmail().headline).toBe("A friendly reminder");
    expect(lastEmail().bodyHtml).toContain(FINAL_BILL_TERMS);

    // Financed: the same sentence, with no pay link (the fee is only on the Synchrony path).
    const plan = await firstPlan();
    expect((await addFee(est.id, plan.planNumber)).status).toBe(201);
    emailMock.sendBrandedEmail.mockClear();
    expect(await sendBalanceRequestEmail(prisma, est.id, ORIGIN)).toMatchObject({ ok: true });
    expect(lastEmail().bodyHtml).toContain(FINAL_BILL_TERMS);
    expect(lastEmail().bodyHtml).toContain("Synchrony");
    expect(lastEmail().bodyHtml).not.toContain("/pay/");
  });

  it("the customer's estimate page and the pay page say it too", async () => {
    // Deposit received: the balance line is the new wording.
    const paid = await issue("2");
    expect((await depositOn(paid.id)).status).toBe(201);
    const page = await request(app).get(`/e/${paid.token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Deposit received");
    expect(page.text).toContain(BALANCE_DUE_TERMS);
    expect(page.text).not.toMatch(/due at completion/i);

    // No deposit required: the page and the (refused) deposit link both say it.
    const none = await issue("3", { depositRequired: false });
    const nonePage = await request(app).get(`/e/${none.token}`);
    expect(nonePage.status).toBe(200);
    expect(nonePage.text).toContain("no deposit is needed");
    expect(nonePage.text).toContain(BALANCE_DUE_TERMS);
    expect(nonePage.text).not.toMatch(/due at completion/i);
    const refused = await chargeableAmount(prisma, none.token, "deposit");
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { reason: string }).reason).toContain(BALANCE_DUE_TERMS);
  });
});

// ─── 2. The deposit on a financed job ───────────────────────────────────────────────────────

describe("the 1/3 deposit on a financed job (decision 8)", () => {
  it("refused before the deposit, refused again at recording if the deposit goes away, and the tech reads the same reason in the field", async () => {
    const plan = await firstPlan();
    const visit = await prisma.visit.create({
      data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${MARK} visit`, status: "scheduled" },
    });
    await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId } });
    const est = await issue("4", { visitId: visit.id });
    const fieldInfo = () => request(app).get(`/health-record/visits/${visit.id}/payment-info`).set("Authorization", `Bearer ${techToken}`);

    // Before the deposit: the fee is refused with the reason, and the field payment screen carries the SAME sentence.
    const refused = await addFee(est.id, plan.planNumber);
    expect(refused.status).toBe(409);
    const reason = refused.body.error as string;
    expect(reason).toMatch(/deposit has not been collected/);
    const field0 = await fieldInfo();
    expect(field0.status).toBe(200);
    expect(field0.body.data.financingBlocked).toBe(reason);
    expect(field0.body.data.financing).toBeNull();

    // Deposit in: the field has nothing to warn about; the fee goes on; the field shows the fee, not a block.
    const dep = await depositOn(est.id);
    expect(dep.status).toBe(201);
    expect((await fieldInfo()).body.data.financingBlocked).toBeNull();
    const applied = await addFee(est.id, plan.planNumber);
    expect(applied.status).toBe(201);
    const field1 = (await fieldInfo()).body.data;
    expect(field1.financing).toMatchObject({ planNumber: plan.planNumber });
    expect(field1.financingBlocked).toBeNull();

    // The deposit is voided AFTER the fee went on — the Synchrony payment cannot be recorded.
    expect((await voidIt(dep.body.id, "Check bounced")).status).toBe(200);
    const owed = applied.body.fee + 425;
    const blocked = await record({ amount: owed, method: "synchrony", estimateId: est.id, planNumber: plan.planNumber, authNumber: "SYN-1" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe(reason);
    expect(await prisma.payment.count({ where: { estimateId: est.id, method: "synchrony" } })).toBe(0);

    // Re-collecting the deposit is closed while the fee is on (the fee closes every other rail) —
    // the exit is to remove the fee with a reason, take the deposit, and add the fee again.
    const closedRail = await depositOn(est.id);
    expect(closedRail.status).toBe(409);
    expect(closedRail.body.error).toContain(FINANCING_IN_PROGRESS);
    await removeFinancingFee(prisma, applied.body.id, "Deposit check bounced — re-collecting the deposit first");
    expect((await depositOn(est.id)).status).toBe(201);
    expect((await addFee(est.id, plan.planNumber)).status).toBe(201);

    // "Deposit required" unticked after the fact is refused the same way (no no-deposit financing).
    await prisma.issuedEstimate.update({ where: { id: est.id }, data: { depositRequired: false } });
    const unticked = await record({ amount: 283.33 + applied.body.fee, method: "synchrony", estimateId: est.id, planNumber: plan.planNumber, authNumber: "SYN-2" });
    expect(unticked.status).toBe(409);
    expect(unticked.body.error).toMatch(/no no-deposit financing/);
    await prisma.issuedEstimate.update({ where: { id: est.id }, data: { depositRequired: true } });

    // With the deposit back in and required, the payment records and closes the invoice.
    const ok = await record({ amount: 283.33 + applied.body.fee, method: "synchrony", estimateId: est.id, planNumber: plan.planNumber, authNumber: "SYN-3" });
    expect(ok.status).toBe(201);
    expect((await fieldInfo()).body.data.paidInFull).toBe(true);
  });
});

// ─── 3. Reminders pause while Synchrony funding is pending ──────────────────────────────────

describe("reminders do not chase a customer whose balance is being paid through Synchrony", () => {
  it("the manual button and the daily sweep both stand down, and both resume when the fee is removed", async () => {
    const plan = await firstPlan();
    const visit = await prisma.visit.create({
      data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${MARK} visit`, status: "completed", completedAt: new Date(Date.now() - 30 * 86400_000) },
    });
    const est = await issue("5", { visitId: visit.id });
    await prisma.issuedEstimate.update({ where: { id: est.id }, data: { signedAt: new Date(Date.now() - 30 * 86400_000) } });
    expect((await depositOn(est.id)).status).toBe(201);
    await prisma.payment.updateMany({ where: { estimateId: est.id }, data: { paidAt: new Date(Date.now() - 30 * 86400_000) } });
    const applied = await addFee(est.id, plan.planNumber);
    expect(applied.status).toBe(201);

    // Manual: refused with the reason (and the route says so), nothing is sent or stamped.
    emailMock.sendBrandedEmail.mockClear();
    expect(await sendInvoiceReminder(prisma, est.id)).toEqual({ ok: false, reason: REMINDER_PAUSED_FOR_FINANCING });
    const route = await request(app).post(`/issued-estimates/${est.id}/payment-reminder`).send({});
    expect(route.status).toBe(400);
    expect(route.body.error).toBe(REMINDER_PAUSED_FOR_FINANCING);
    expect(REMINDER_PAUSED_FOR_FINANCING).toContain("Financing in progress — balance is being paid through Synchrony");

    // Sweep: skipped.
    process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS = "on";
    try {
      await sweepInvoiceReminders(prisma);
      expect(emailMock.sendBrandedEmail.mock.calls.some((c) => c[0].issuedEstimateId === est.id)).toBe(false);
      expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).paymentRemindersSent).toBe(0);

      // The financing falls through: the fee is removed (with a reason) and the reminders resume.
      await removeFinancingFee(prisma, applied.body.id, "Synchrony declined — paying by check");
      await sweepInvoiceReminders(prisma);
      expect(emailMock.sendBrandedEmail.mock.calls.some((c) => c[0].issuedEstimateId === est.id)).toBe(true);
      expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).paymentRemindersSent).toBe(1);
    } finally {
      delete process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS;
    }
    // And the manual button works again.
    emailMock.sendBrandedEmail.mockClear();
    expect(await sendInvoiceReminder(prisma, est.id)).toMatchObject({ ok: true, amount: 283.33 });
    expect(lastEmail().bodyHtml).toContain(FINAL_BILL_TERMS);
  });
});
