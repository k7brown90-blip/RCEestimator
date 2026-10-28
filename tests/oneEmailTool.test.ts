/**
 * ONE email tool (Kyle, 2026-10-27: "A rule of thumb is there is one tool for one task. We do not
 * create multiple tools that do the same thing.") - plan 2026-10-27-invoice-wording, Part 2.
 *
 * What these pin:
 *   1. Every kind the "Email the customer" panel sends goes through POST /customer-emails and
 *      lands at the CHOSEN To + CC, and with nothing chosen at the customer on file.
 *   2. THE INVOICE IS ONE EMAIL: the itemized invoice PDF is always attached, with the amount due,
 *      the paid-to-date, the pay link and "due upon receipt of this invoice".
 *   3. A second send of the same invoice to the same address, still unpaid, is reminder-worded and
 *      stamps the sweep's pacing clock (the stamp the old "Send reminder" button wrote). A first
 *      send, or a send to an address that never got it, does not stamp.
 *   4. The daily sweep calls that same function in its reminder voice - same PDF, same body.
 *   5. One recipient rule: a bad CC is refused by name for every kind, photos are refused (never
 *      dropped) on a kind that cannot carry them, a free-form message can be filed against the
 *      estimate so the panel's thread shows it, and the routes of the removed buttons are gone.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
type SentMail = {
  to: string; cc?: string[]; subject: string; headline: string; bodyHtml: string; kind?: string; issuedEstimateId?: string | null;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
};
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn() }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { sweepInvoiceReminders } from "../src/services/invoiceReminders";
import { FINAL_BILL_TERMS } from "../src/services/paymentTerms";

const MARK = "ONEM";
const CUSTOMER_EMAIL = "onem-customer@example.com";

let customerId: string;
let propertyId: string;
let draftId: string;

const cleanup = async () => {
  const estIds = (await prisma.issuedEstimate.findMany({ where: { number: { startsWith: `0000-${MARK}` } }, select: { id: true } })).map((e) => e.id);
  await prisma.emailDelivery.deleteMany({ where: { issuedEstimateId: { in: estIds } } });
  await prisma.payment.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: `${MARK} draft` } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: `${MARK}-SUP` } });
  await prisma.visit.deleteMany({ where: { purpose: `${MARK} visit` } });
  await prisma.property.deleteMany({ where: { name: `${MARK} property` } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: `${MARK} Customer` } } });
  await prisma.systemEvent.deleteMany({ where: { message: { contains: `0000-${MARK}` } } });
};

/** A $425 signed invoice with a $141.67 deposit due (trip $75 + $350 option A). */
async function issue(suffix: string, opts: { visitId?: string | null } = {}) {
  return prisma.issuedEstimate.create({
    data: {
      number: `0000-${MARK}${suffix}`,
      token: `ab${suffix.charCodeAt(0).toString(16)}${Date.now().toString(16)}`.padEnd(64, "0"),
      status: "signed",
      draftId,
      customerId,
      serviceAddressId: propertyId,
      customerName: `${MARK} Customer`,
      customerEmail: CUSTOMER_EMAIL,
      serviceAddress: "7 One Tool Way, Hermitage, TN",
      title: "Panel upgrade",
      scopeText: "Panel upgrade.",
      workSubtotal: 350,
      tripCharge: 75,
      total: 425,
      sentAt: new Date(),
      sentTo: CUSTOMER_EMAIL,
      visitId: opts.visitId ?? null,
      jobVisitId: opts.visitId ?? null,
      signedAt: new Date(),
      signerName: `${MARK} Customer`,
      signedChannel: "email",
      depositRequired: true,
      selectedOptions: ["A"],
      comboCapJson: JSON.stringify({ applied: false, reduction: 0, ceiling: 0, bandLabel: "n/a" }),
      options: { create: [{ option: "A", label: "Panel", subtotal: 350, lineCount: 2 }] },
    },
  });
}

const post = (body: Record<string, unknown>) => request(app).post("/customer-emails").send(body);
const mails = () => emailMock.sendBrandedEmail.mock.calls.map((c) => c[0] as SentMail);
const lastMail = () => mails().at(-1)!;

beforeAll(async () => {
  await cleanup();
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: CUSTOMER_EMAIL } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} property`, addressLine1: "7 One Tool Way", city: "Hermitage", state: "TN", postalCode: "37076" },
  });
  propertyId = property.id;
  await prisma.priceBookSupplier.create({ data: { id: `${MARK}-SUP`, name: `${MARK} Supply`, quotable: "YES" } });
  draftId = (await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} draft`, supplierId: `${MARK}-SUP` } })).id;
});

afterAll(async () => {
  delete process.env.STRIPE_SECRET_KEY;
  await cleanup();
});

beforeEach(() => {
  emailMock.sendBrandedEmail.mockReset();
  // Like the real pipe: a send files one EmailDelivery row (the invoice send reads them to know
  // whether this address already got this invoice).
  emailMock.sendBrandedEmail.mockImplementation(async (input: SentMail) => {
    await prisma.emailDelivery.create({
      data: {
        provider: "resend", to: input.to, cc: input.cc ?? [], subject: input.subject, kind: input.kind ?? "other",
        issuedEstimateId: input.issuedEstimateId ?? null, estimateNumber: null, status: "sent",
      },
    });
    return true;
  });
  process.env.STRIPE_SECRET_KEY = "sk_test_one_tool"; // the pay link renders only while Stripe is configured (the SDK is mocked)
});

describe("the invoice is ONE email", () => {
  it("goes to the customer on file with nothing chosen, and ALWAYS carries the itemized invoice PDF", async () => {
    const est = await issue("a");
    const res = await post({ kind: "invoice", estimateId: est.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ sent: true, kind: "invoice", to: CUSTOMER_EMAIL, cc: [], amount: 425, reminder: false });

    const mail = lastMail();
    expect(mail.to).toBe(CUSTOMER_EMAIL);
    expect(mail.kind).toBe("invoice");
    expect(mail.subject).toBe(`Your invoice from Red Cedar Electric — ${est.number}`);
    const pdf = mail.attachments!.find((a) => a.contentType === "application/pdf")!;
    expect(pdf.filename).toBe(`invoice-${est.number}.pdf`);
    expect(pdf.content.subarray(0, 4).toString()).toBe("%PDF");
    // The statement: the amount due, the pay link, due upon receipt - one email, not three.
    expect(mail.bodyHtml).toContain("Balance due");
    expect(mail.bodyHtml).toContain("$425.00");
    expect(mail.bodyHtml).toContain(`/pay/${est.token}`);
    expect(mail.bodyHtml).toContain(FINAL_BILL_TERMS);
    // A first send is not a reminder and does not touch the sweep's clock.
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } });
    expect(row.paymentRemindersSent).toBe(0);
    expect(row.lastPaymentReminderAt).toBeNull();
  });

  it("goes to the CHOSEN To and CC (cleaned, de-duplicated, the To dropped from the CC)", async () => {
    const est = await issue("b");
    const res = await post({ kind: "invoice", estimateId: est.id, to: "payer@example.com", cc: ["Owner@Example.com", "PAYER@example.com"], message: "Here is the invoice you asked for." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ to: "payer@example.com", cc: ["owner@example.com"] });
    const mail = lastMail();
    expect(mail.to).toBe("payer@example.com");
    expect(mail.cc).toEqual(["owner@example.com"]);
    expect(mail.bodyHtml).toContain("Here is the invoice you asked for.");
    // The PDF rides to the payer too - the Miranda case: whoever receives it gets an itemized document.
    expect(mail.attachments!.some((a) => a.contentType === "application/pdf")).toBe(true);
  });

  it("paid-to-date and the balance show once money has come in", async () => {
    const est = await issue("c");
    await prisma.payment.create({ data: { estimateId: est.id, customerId, amount: 141.67, method: "cash", kind: "deposit", status: "paid", payer: "customer", paidAt: new Date() } });
    const res = await post({ kind: "invoice", estimateId: est.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.amount).toBe(283.33);
    expect(lastMail().bodyHtml).toContain("Paid to date");
    expect(lastMail().bodyHtml).toContain("$141.67");
    expect(lastMail().bodyHtml).toContain("$283.33");
  });

  it("a second send to the same address while unpaid is reminder-worded and stamps the pacing clock; a new address is a first send", async () => {
    const est = await issue("d");
    const first = await post({ kind: "invoice", estimateId: est.id });
    expect(first.body.reminder).toBe(false);

    const second = await post({ kind: "invoice", estimateId: est.id });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.reminder).toBe(true);
    const mail = lastMail();
    expect(mail.subject).toBe("Friendly reminder — $425.00 still open on Invoice " + est.number);
    expect(mail.headline).toBe("A friendly reminder");
    expect(mail.bodyHtml).toContain("friendly reminder");
    expect(mail.attachments!.some((a) => a.contentType === "application/pdf")).toBe(true); // the reminder is the same email, PDF and all
    const stamped = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } });
    expect(stamped.paymentRemindersSent).toBe(1);
    expect(stamped.lastPaymentReminderAt).not.toBeNull();

    // Someone who never got it (the payer who is not the customer) gets a first-send email, no stamp.
    const other = await post({ kind: "invoice", estimateId: est.id, to: "bookkeeper@example.com" });
    expect(other.body.reminder).toBe(false);
    expect(lastMail().subject).toBe(`Your invoice from Red Cedar Electric — ${est.number}`);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).paymentRemindersSent).toBe(1);

    // The invoice changed since it was last sent (a change order signed, a new total): the next send
    // is news, not a nag - first-send wording and no strike spent (review finding, 2026-10-27).
    await prisma.issuedEstimate.update({ where: { id: est.id }, data: { signedAt: new Date() } });
    const updated = await post({ kind: "invoice", estimateId: est.id });
    expect(updated.body.reminder).toBe(false);
    expect(lastMail().subject).toBe(`Your invoice from Red Cedar Electric — ${est.number}`);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).paymentRemindersSent).toBe(1);
  });

  it("a paid-in-full invoice can still be sent as the record: PAID IN FULL, no pay link, never a reminder", async () => {
    const est = await issue("e");
    await prisma.payment.create({ data: { estimateId: est.id, customerId, amount: 425, method: "check", kind: "final", status: "paid", payer: "customer", paidAt: new Date() } });
    await post({ kind: "invoice", estimateId: est.id });
    const again = await post({ kind: "invoice", estimateId: est.id });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.reminder).toBe(false);
    expect(lastMail().bodyHtml).toContain("PAID IN FULL");
    expect(lastMail().bodyHtml).not.toContain("/pay/");
  });
});

describe("the daily sweep sends that same email, in its reminder voice", () => {
  it("itemized PDF attached, the balance and pay link, the clock stamped - schedule unchanged", async () => {
    const visit = await prisma.visit.create({
      data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${MARK} visit`, status: "completed", completedAt: new Date(Date.now() - 30 * 86400_000) },
    });
    const est = await issue("f", { visitId: visit.id });
    await prisma.issuedEstimate.update({ where: { id: est.id }, data: { signedAt: new Date(Date.now() - 30 * 86400_000) } });

    process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS = "on";
    try {
      await sweepInvoiceReminders(prisma);
    } finally {
      delete process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS;
    }
    const mail = mails().find((m) => m.issuedEstimateId === est.id)!;
    expect(mail).toBeTruthy();
    expect(mail.to).toBe(CUSTOMER_EMAIL);
    expect(mail.subject).toBe("Friendly reminder — $425.00 still open on Invoice " + est.number);
    expect(mail.kind).toBe("invoice");
    expect(mail.attachments!.some((a) => a.filename === `invoice-${est.number}.pdf`)).toBe(true);
    expect(mail.bodyHtml).toContain(`/pay/${est.token}`);
    expect(mail.bodyHtml).toContain(FINAL_BILL_TERMS);
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } });
    expect(row.paymentRemindersSent).toBe(1);
    expect(row.lastPaymentReminderAt).not.toBeNull();
  });
});

describe("the other kinds take the same To, CC and note", () => {
  it("deposit request: customer on file by default, the chosen To/CC when given, the note in the body", async () => {
    const est = await issue("g");
    const plain = await post({ kind: "deposit", estimateId: est.id });
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(plain.body).toMatchObject({ kind: "deposit", to: CUSTOMER_EMAIL, cc: [], amount: 141.67 });
    expect(lastMail().to).toBe(CUSTOMER_EMAIL);
    expect(lastMail().kind).toBe("deposit");

    const chosen = await post({ kind: "deposit", estimateId: est.id, to: "payer@example.com", cc: ["owner@example.com"], message: "Deposit please." });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect(lastMail().to).toBe("payer@example.com");
    expect(lastMail().cc).toEqual(["owner@example.com"]);
    expect(lastMail().bodyHtml).toContain("Deposit please.");
  });

  it("estimate: the chosen To/CC reach sendEstimateEmail, and defaults to the customer on file", async () => {
    const est = await issue("h");
    await prisma.issuedEstimate.update({ where: { id: est.id }, data: { status: "draft", signedAt: null, signerName: null } });
    const plain = await post({ kind: "estimate", estimateId: est.id });
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(plain.body).toMatchObject({ kind: "estimate", to: CUSTOMER_EMAIL });
    const chosen = await post({ kind: "estimate", estimateId: est.id, to: "payer@example.com", cc: ["owner@example.com"] });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect(lastMail().to).toBe("payer@example.com");
    expect(lastMail().cc).toEqual(["owner@example.com"]);
  });
});

describe("one recipient rule, and nothing left half-used", () => {
  it("a bad CC is refused for every kind and nothing goes out", async () => {
    const est = await issue("i");
    for (const kind of ["invoice", "deposit", "financing"]) {
      const res = await post({ kind, estimateId: est.id, cc: ["nope"] });
      expect(res.status, kind).toBe(400);
    }
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
  });

  it("photos are REFUSED - not dropped - on a kind that cannot carry them", async () => {
    const est = await issue("j");
    const res = await post({ kind: "deposit", estimateId: est.id, photoIds: ["some-photo"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only be sent with an invoice or an estimate/i);
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
  });

  it("an unknown kind or a missing record is a 400, never a silent send", async () => {
    expect((await post({ kind: "bill", estimateId: "x" })).status).toBe(400);
    expect((await post({ kind: "invoice" })).status).toBe(400);
    expect((await post({ kind: "invoice", estimateId: "does-not-exist" })).status).toBe(400);
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
  });

  it("a free-form Message from an estimate's panel can be filed against that estimate (so its thread shows it)", async () => {
    const est = await issue("k");
    const res = await request(app).post("/communications/email").send({
      target: "account", id: customerId, to: "payer@example.com", cc: ["owner@example.com"], subject: "Quick question", body: "Hello.", estimateId: est.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ to: "payer@example.com", cc: ["owner@example.com"] });
    expect(lastMail().issuedEstimateId).toBe(est.id);
    const bad = await request(app).post("/communications/email").send({ target: "account", id: customerId, cc: ["nope"], subject: "x", body: "y" });
    expect(bad.status).toBe(400);
  });

  it("the routes of the removed buttons are gone", async () => {
    const est = await issue("l");
    for (const path of [
      `/issued-estimates/${est.id}/send`,
      `/issued-estimates/${est.id}/send-invoice`,
      `/issued-estimates/${est.id}/email-balance-request`,
      `/issued-estimates/${est.id}/payment-reminder`,
      `/issued-estimates/${est.id}/email-deposit-request`,
      `/issued-estimates/${est.id}/email-financing`,
      "/jobs/some-job/email-review-request",
    ]) {
      const res = await request(app).post(path).send({});
      expect(res.status, path).toBe(404);
    }
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
  });
});
