/**
 * Void a recorded payment — administrator only (Kyle, 2026-10-08, one-estimating-system plan
 * decision 11; Phase 6 Unit 6B).
 *
 *   "Only the administrator can void a recorded payment: CRM only ... NO tech route at all,
 *    not even for a technician with role admin; reason required; row kept, marked void,
 *    audit trail."
 *
 * What these pin:
 *   1. CROSS-READER: once a row is void, EVERY money reader agrees it is not money —
 *      paymentSummary (balance, depositSatisfied, paidInFull), GET /invoices, GET /jobs' deposit
 *      gate, the account's lifetime collected, the P&L's collected, bank-statement matching,
 *      the receipt email, the office-acceptance undo — while the row itself stays listed.
 *   2. A reason is required (and bounded).
 *   3. A row cannot be voided twice.
 *   4. A Stripe row is refused: a card payment is refunded in Stripe, not voided here.
 *   5. There is NO technician route — the tech router is walked, not trusted.
 *   6. The audit trail: an IssuedEstimateEvent "payment_voided" and a SystemEvent.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import { paymentSummary } from "../src/services/stripePayments";
import { voidPayment, PaymentVoidError } from "../src/services/paymentVoid";
import { collectedByCustomer } from "../src/services/lifetimeCollected";
import { candidatesFor, loadClassifyContext } from "../src/services/bankStatements";
import { undoOfficeAcceptance } from "../src/services/officeAcceptance";

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
import { healthRecordTechRouter } from "../src/routes/health-record";
import { sendPaymentReceiptEmail } from "../src/services/paymentReceipts";

const MARK = "PVD";
/** A year no other test records money in — the P&L assertion sums the whole year. */
const LEDGER_YEAR = 2019;

let customerId: string;
let propertyId: string;
let draftId: string;
let techToken: string;
let technicianId: string;

const cleanup = async () => {
  const estIds = (await prisma.issuedEstimate.findMany({ where: { number: { startsWith: `0000-${MARK}` } }, select: { id: true } })).map((e) => e.id);
  await prisma.payment.deleteMany({ where: { OR: [{ estimateId: { in: estIds } }, { note: { startsWith: `${MARK} ` } }] } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: `${MARK} draft` } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: `${MARK}-SUP` } });
  await prisma.visit.deleteMany({ where: { purpose: `${MARK} visit` } });
  await prisma.property.deleteMany({ where: { name: `${MARK} property` } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: `${MARK} Customer` } } });
  await prisma.technician.deleteMany({ where: { name: `${MARK} Tech` } });
  await prisma.systemEvent.deleteMany({ where: { message: { contains: `0000-${MARK}` } } });
};

/** A $425 signed estimate (trip $75 + $350 option A) — deposit ⅓ = $141.67. */
async function issue(input: { suffix: string; visitId?: string | null; signedChannel?: string }) {
  return prisma.issuedEstimate.create({
    data: {
      number: `0000-${MARK}${input.suffix}`,
      token: `pvdtoken${input.suffix}${Date.now()}`.padEnd(40, "0"),
      status: "signed",
      draftId,
      customerId,
      serviceAddressId: propertyId,
      customerName: `${MARK} Customer`,
      customerEmail: "pvd-customer@example.com",
      serviceAddress: "12 Void Lane, Hermitage, TN",
      title: "Ceiling fan install",
      scopeText: "Ceiling fan install and balance.",
      workSubtotal: 350,
      tripCharge: 75,
      total: 425,
      sentAt: new Date(),
      sentTo: "pvd-customer@example.com",
      visitId: input.visitId ?? null,
      jobVisitId: input.visitId ?? null,
      signedAt: new Date(),
      signerName: `${MARK} Customer`,
      signedChannel: input.signedChannel ?? "email",
      ...(input.signedChannel === "office" ? { acceptedVia: "phone", acceptedNote: "said yes on the phone" } : {}),
      selectedOptions: ["A"],
      comboCapJson: JSON.stringify({ applied: false, reduction: 0, ceiling: 0, bandLabel: "n/a" }),
      options: { create: [{ option: "A", label: "Fan install", subtotal: 350, lineCount: 2 }] },
    },
  });
}

const summaryOf = (id: string) => paymentSummary(prisma, id, "https://unused.invalid");
const record = (body: Record<string, unknown>) => request(app).post("/financials/payments").send(body);
const voidIt = (id: string, reason?: string) => request(app).post(`/financials/payments/${id}/void`).send(reason === undefined ? {} : { reason });
const settle = () => new Promise((r) => setTimeout(r, 200)); // fire-and-forget writes land

beforeAll(async () => {
  await cleanup();
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "pvd-customer@example.com" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} property`, addressLine1: "12 Void Lane", city: "Hermitage", state: "TN", postalCode: "37076" },
  });
  propertyId = property.id;
  await prisma.priceBookSupplier.create({ data: { id: `${MARK}-SUP`, name: `${MARK} Supply`, quotable: "YES" } });
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} draft`, supplierId: `${MARK}-SUP` } });
  draftId = draft.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `pvd-tech-${customer.id}`, role: "admin" } });
  technicianId = tech.id;
  techToken = tech.accessToken;
});

afterAll(cleanup);

// ─── 1. Every reader agrees ──────────────────────────────────────────────────

describe("a voided payment is not money, anywhere — and the row stays", () => {
  it("paymentSummary, GET /invoices, GET /jobs, lifetime collected, the P&L, bank matching and the receipt all exclude it", async () => {
    const visit = await prisma.visit.create({
      data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${MARK} visit`, status: "scheduled" },
    });
    const est = await issue({ suffix: "1", visitId: visit.id });

    const dep = await record({ amount: 141.67, method: "cash", kind: "deposit", estimateId: est.id, customerId, paidAt: `${LEDGER_YEAR}-06-10T12:00:00.000Z` });
    expect(dep.status).toBe(201);
    const fin = await record({ amount: 283.33, method: "check", kind: "final", checkNumber: "7781", estimateId: est.id, customerId, paidAt: `${LEDGER_YEAR}-06-15T12:00:00.000Z` });
    expect(fin.status).toBe(201);

    const paid = (await summaryOf(est.id))!;
    expect(paid).toMatchObject({ totalPaid: 425, balance: 0, paidInFull: true, depositSatisfied: true });
    const ledgerBefore = await request(app).get(`/financials/summary?year=${LEDGER_YEAR}`);
    expect(ledgerBefore.body.totals.collected).toBe(425);

    // The administrator voids the final check — typed against the wrong invoice, say.
    const res = await voidIt(fin.body.id, "Check #7781 was for a different job");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: fin.body.id, voidedBy: "human:crm-session", voidReason: "Check #7781 was for a different job" });
    expect(res.body.voidedAt).toBeTruthy();

    // paymentSummary — the one definition the pay page, the field app, the scheduling gate,
    // receipts and reminders read.
    const after = (await summaryOf(est.id))!;
    expect(after).toMatchObject({ totalPaid: 141.67, depositPaid: 141.67, balance: 283.33, paidInFull: false, depositSatisfied: true });
    // The row is still LISTED, marked void — never dropped from the ledger.
    expect(after.payments).toHaveLength(2);
    const listed = after.payments.find((p) => p.id === fin.body.id)!;
    expect(listed.voidedAt).toBeTruthy();
    expect(listed.voidReason).toBe("Check #7781 was for a different job");
    expect(after.payments.find((p) => p.id === dep.body.id)!.voidedAt).toBeNull();

    // GET /invoices — the Financials card and the invoice drawer.
    const inv = await request(app).get("/invoices");
    const row = inv.body.find((i: { id: string }) => i.id === est.id);
    expect(row).toMatchObject({ billedTotal: 425, totalPaid: 141.67, balance: 283.33, collected: 141.67, paymentStatus: "deposit_paid" });

    // The year ledger (financials/payments) still lists the row, marked.
    const ledgerRows = await request(app).get(`/financials/payments?year=${new Date().getFullYear()}`);
    const ledgerRow = ledgerRows.body.find((p: { id: string }) => p.id === fin.body.id);
    expect(ledgerRow).toBeTruthy();
    expect(ledgerRow.voidedAt).toBeTruthy();
    expect(ledgerRow.voidReason).toBe("Check #7781 was for a different job");

    // Lifetime collected — accounts list, account summary, lead funnel.
    const lifetime = (await collectedByCustomer(prisma, [customerId])).get(customerId)!;
    expect(lifetime.collected).toBe(141.67);
    expect(lifetime.paymentCount).toBe(1);

    // The P&L's collected for the year.
    const ledgerAfter = await request(app).get(`/financials/summary?year=${LEDGER_YEAR}`);
    expect(ledgerAfter.body.totals.collected).toBe(141.67);

    // Bank-statement matching: a $283.33 deposit no longer finds the voided check.
    const ctx = await loadClassifyContext(prisma, [LEDGER_YEAR]);
    const line = { accountId: "acct", postedAt: new Date(`${LEDGER_YEAR}-06-16T12:00:00.000Z`), amount: 283.33, description: "DEPOSIT", bankType: null, payeeKey: "deposit" };
    expect(candidatesFor(line, ctx).payments.find((p) => p.id === fin.body.id)).toBeUndefined();
    const liveLine = { ...line, amount: 141.67 };
    expect(candidatesFor(liveLine, ctx).payments.find((p) => p.id === dep.body.id)).toBeTruthy();

    // No receipt email for a voided row.
    emailMock.sendBrandedEmail.mockClear();
    await sendPaymentReceiptEmail(prisma, fin.body.id);
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();

    // The field app's payment-info (the same summary) — the tech sees the balance reopen.
    await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId } });
    const field = await request(app).get(`/health-record/visits/${visit.id}/payment-info`).set("Authorization", `Bearer ${techToken}`);
    expect(field.status).toBe(200);
    expect(field.body.data).toMatchObject({ balance: 283.33, paidInFull: false });

    // Void the deposit too: the deposit gate closes again — GET /jobs drops the job (the same
    // rule the warranty-payer test pins: an unpaid ⅓ keeps a job off the Jobs tab).
    const before = await request(app).get("/jobs");
    expect(before.body.find((j: { visitId: string }) => j.visitId === visit.id)).toBeTruthy();
    const res2 = await voidIt(dep.body.id, "Keyed twice");
    expect(res2.status).toBe(200);
    const gated = (await summaryOf(est.id))!;
    expect(gated).toMatchObject({ totalPaid: 0, depositPaid: 0, balance: 425, depositSatisfied: false });
    const jobs = await request(app).get("/jobs");
    expect(jobs.body.find((j: { visitId: string }) => j.visitId === visit.id)).toBeUndefined();
  });

  it("the office-acceptance undo no longer sees a voided payment as money on the invoice", async () => {
    const est = await issue({ suffix: "2", signedChannel: "office" });
    const pay = await record({ amount: 100, method: "zelle", kind: "other", estimateId: est.id, customerId });
    expect(pay.status).toBe(201);
    const blocked = await undoOfficeAcceptance(prisma, est.id);
    expect(blocked.ok).toBe(false);
    expect((blocked as { reason: string }).reason).toMatch(/payment has been recorded/);

    expect((await voidIt(pay.body.id, "Zelle never arrived")).status).toBe(200);
    const undone = await undoOfficeAcceptance(prisma, est.id);
    expect(undone.ok).toBe(true);
  });
});

// ─── 2-4. Refusals ───────────────────────────────────────────────────────────

describe("refusals", () => {
  it("a reason is required — missing, empty and whitespace are all 400, and the row is untouched", async () => {
    const est = await issue({ suffix: "3" });
    const pay = await record({ amount: 50, method: "cash", estimateId: est.id, customerId });
    for (const body of [undefined, "", "   "]) {
      const res = await voidIt(pay.body.id, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Say why/);
    }
    const tooLong = await voidIt(pay.body.id, "x".repeat(301));
    expect(tooLong.status).toBe(400);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: pay.body.id } });
    expect(row.voidedAt).toBeNull();
    expect((await summaryOf(est.id))!.totalPaid).toBe(50);
  });

  it("a voided payment cannot be voided twice", async () => {
    const est = await issue({ suffix: "4" });
    const pay = await record({ amount: 50, method: "cash", estimateId: est.id, customerId });
    expect((await voidIt(pay.body.id, "first")).status).toBe(200);
    const again = await voidIt(pay.body.id, "second");
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already voided/);
    expect(again.body.error).toContain("first");
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: pay.body.id } });
    expect(row.voidReason).toBe("first"); // the first void stands
  });

  it("a Stripe-recorded payment is refused — a card payment is refunded in Stripe, not voided here", async () => {
    const est = await issue({ suffix: "5" });
    const card = await prisma.payment.create({
      data: { amount: 141.67, method: "stripe", kind: "deposit", status: "paid", stripeSessionId: `cs_test_${MARK}_${Date.now()}`, estimateId: est.id, customerId, paidAt: new Date() },
    });
    const res = await voidIt(card.id, "customer changed their mind");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/refunded in Stripe/);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: card.id } });
    expect(row.voidedAt).toBeNull();
    expect((await summaryOf(est.id))!.depositSatisfied).toBe(true);
  });

  it("404 for a payment that does not exist; the service throws the same typed errors", async () => {
    expect((await voidIt("no-such-payment", "why")).status).toBe(404);
    await expect(voidPayment(prisma, "no-such-payment", "why")).rejects.toBeInstanceOf(PaymentVoidError);
    await expect(voidPayment(prisma, "no-such-payment", "")).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ─── 5. No tech route ────────────────────────────────────────────────────────

describe("there is NO technician route for voiding a payment (Kyle: 'NO tech route at all, not even for a technician with role admin')", () => {
  it("the tech router carries no route that writes a payment, and a tech with role admin gets 404", async () => {
    const router = healthRecordTechRouter as unknown as { stack: Array<{ route?: { path: string | string[]; methods: Record<string, boolean> } }> };
    const paths = router.stack
      .filter((l) => l.route)
      .flatMap((l) => (Array.isArray(l.route!.path) ? l.route!.path : [l.route!.path]).map((p) => ({ path: p, methods: Object.keys(l.route!.methods).filter((m) => l.route!.methods[m]) })));
    expect(paths.length).toBeGreaterThan(20); // we really walked the router
    const paymentWriters = paths.filter((r) =>
      /payment/i.test(r.path) && /void/i.test(r.path)
      || /^\/payments\b/.test(r.path)
      || (/payment/i.test(r.path) && r.methods.some((m) => m !== "get") && !/email-payment-request/.test(r.path)),
    );
    expect(paymentWriters, `tech router must never write a Payment row: ${JSON.stringify(paymentWriters)}`).toEqual([]);

    const est = await issue({ suffix: "6" });
    const pay = await record({ amount: 25, method: "cash", estimateId: est.id, customerId });
    for (const path of [`/health-record/payments/${pay.body.id}/void`, `/health-record/financials/payments/${pay.body.id}/void`]) {
      const res = await request(app).post(path).set("Authorization", `Bearer ${techToken}`).send({ reason: "tech tries" });
      expect(res.status, path).toBe(404);
    }
    // And the CRM route itself does not answer to a technician's bearer token — it is the
    // session's (pinAuthMiddleware, which is a no-op without PIN_HASH, so arm it here the way
    // tests/authInvariant.test.ts does), never the field app's.
    process.env.PIN_HASH = await bcrypt.hash("135790", 4);
    try {
      const crm = await request(app).post(`/financials/payments/${pay.body.id}/void`).set("Authorization", `Bearer ${techToken}`).send({ reason: "tech tries" });
      expect(crm.status).toBe(401);
    } finally {
      delete process.env.PIN_HASH;
    }
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pay.body.id } })).voidedAt).toBeNull();
  });
});

// ─── 6. Audit trail ──────────────────────────────────────────────────────────

describe("audit trail", () => {
  it("writes an IssuedEstimateEvent 'payment_voided' with the reason, and a SystemEvent naming the payment", async () => {
    const est = await issue({ suffix: "7" });
    const pay = await record({ amount: 60, method: "check", checkNumber: "9001", kind: "final", estimateId: est.id, customerId });
    expect((await voidIt(pay.body.id, "Bounced")).status).toBe(200);
    await settle();

    const event = await prisma.issuedEstimateEvent.findFirst({ where: { estimateId: est.id, type: "payment_voided" } });
    expect(event).toBeTruthy();
    expect(event!.actor).toBe("human:crm-session");
    expect(event!.detail).toContain("$60.00 check #9001");
    expect(event!.detail).toContain("Bounced");

    const sys = await prisma.systemEvent.findFirst({ where: { source: "financials", message: { contains: `Payment voided — $60.00 check #9001` } }, orderBy: { createdAt: "desc" } });
    expect(sys).toBeTruthy();
    expect(sys!.level).toBe("warn");
    expect(sys!.message).toContain(est.number);
    expect(JSON.parse(sys!.detailsJson!)).toMatchObject({ paymentId: pay.body.id, estimateId: est.id, actor: "human:crm-session" });

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: pay.body.id } });
    expect(row).toMatchObject({ voidedBy: "human:crm-session", voidReason: "Bounced" });
    expect(row.voidedAt).toBeInstanceOf(Date);
  });

  it("a payment not against any invoice voids too — no estimate event (there is no estimate), a SystemEvent that says so", async () => {
    const pay = await record({ amount: 40, method: "cash", note: `${MARK} untied cash` });
    expect(pay.status).toBe(201);
    const res = await voidIt(pay.body.id, "Entered on the wrong day");
    expect(res.status).toBe(200);
    await settle();
    const sys = await prisma.systemEvent.findFirst({ where: { source: "financials", message: { contains: "Payment voided — $40.00 cash" } }, orderBy: { createdAt: "desc" } });
    expect(sys!.message).toContain("not against an invoice");
    await prisma.systemEvent.deleteMany({ where: { id: sys!.id } });
  });
});
