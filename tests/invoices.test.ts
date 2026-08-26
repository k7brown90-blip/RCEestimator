/**
 * GET /invoices — the Invoices tab.
 *
 * Kyle, 2026-08-26: "I need an invoices tab that tracks the invoices sent and
 * what ones are paid." An invoice is a SIGNED issued estimate (2026-08-21:
 * "The signed estimates need to be labeled invoices"), so the list must show
 * exactly those — never drafts, never voided rows, never the test account —
 * with money rolled up the way paymentSummary rolls it: discount rows close
 * balances but are not collected cash.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
}));

import { app } from "../src/app";

let customerId: string;
let testAccountId: string;

const cleanup = async () => {
  await prisma.payment.deleteMany({ where: { note: "invoices-test" } });
  await prisma.issuedEstimate.deleteMany({ where: { number: { startsWith: "0000-INV" } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: "invoices-test draft" } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: "INVTEST-SUP" } });
  await prisma.property.deleteMany({ where: { name: "invoices-test property" } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: "Invoices Test" } } });
};

async function issueSigned(input: {
  suffix: string;
  total: number;
  signed?: boolean;
  voided?: boolean;
  onTestAccount?: boolean;
  sentTo?: string;
  draftId: string;
  serviceAddressId: string;
}) {
  return prisma.issuedEstimate.create({
    data: {
      number: `0000-INV${input.suffix}`,
      token: `invtest-token-${input.suffix}-${Date.now()}`,
      status: input.signed === false ? "sent" : "signed",
      draftId: input.draftId,
      customerId: input.onTestAccount ? testAccountId : customerId,
      serviceAddressId: input.serviceAddressId,
      customerName: "Invoices Test Co",
      serviceAddress: "12 Ledger Ln, Franklin",
      title: `Invoice fixture ${input.suffix}`,
      workSubtotal: input.total,
      total: input.total,
      ...(input.signed === false ? {} : { signedAt: new Date(), signedChannel: "email" }),
      ...(input.voided ? { voidedAt: new Date(), voidReason: "test" } : {}),
      ...(input.sentTo ? { sentAt: new Date(), sentTo: input.sentTo } : {}),
    },
  });
}

beforeAll(async () => {
  await cleanup();
  const customer = await prisma.customer.create({ data: { name: "Invoices Test Co" } });
  customerId = customer.id;
  const testAccount = await prisma.customer.create({
    data: { name: "Invoices Test Practice", isTestAccount: true },
  });
  testAccountId = testAccount.id;
  const property = await prisma.property.create({
    data: {
      customerId,
      name: "invoices-test property",
      addressLine1: "12 Ledger Ln",
      city: "Franklin",
      state: "TN",
      postalCode: "37064",
    },
  });
  await prisma.priceBookSupplier.create({
    data: { id: "INVTEST-SUP", name: "Invoices Test Supply", quotable: "YES" },
  });
  const draft = await prisma.priceBookDraftEstimate.create({
    data: { title: "invoices-test draft", supplierId: "INVTEST-SUP" },
  });

  // 1. Signed, nothing paid → unpaid.
  await issueSigned({
    suffix: "1", total: 900, sentTo: "owner@example.com",
    draftId: draft.id, serviceAddressId: property.id,
  });

  // 2. Signed, deposit satisfied via check + 3% discount row → deposit_paid;
  //    the discount closes balance but is not collected cash.
  const dep = await issueSigned({
    suffix: "2", total: 900, draftId: draft.id, serviceAddressId: property.id,
  });
  await prisma.payment.createMany({
    data: [
      { estimateId: dep.id, customerId, amount: 291, method: "check", kind: "deposit", status: "paid", paidAt: new Date(), note: "invoices-test" },
      { estimateId: dep.id, customerId, amount: 9, method: "discount", kind: "deposit", status: "paid", paidAt: new Date(), note: "invoices-test" },
    ],
  });

  // 3. Signed, paid in full.
  const paid = await issueSigned({
    suffix: "3", total: 300, draftId: draft.id, serviceAddressId: property.id,
  });
  await prisma.payment.create({
    data: { estimateId: paid.id, customerId, amount: 300, method: "stripe", kind: "final", status: "paid", paidAt: new Date(), note: "invoices-test" },
  });

  // 4. Sent but NOT signed — not an invoice.
  await issueSigned({
    suffix: "4", total: 500, signed: false,
    draftId: draft.id, serviceAddressId: property.id,
  });

  // 5. Signed then voided — off the books.
  await issueSigned({
    suffix: "5", total: 500, voided: true,
    draftId: draft.id, serviceAddressId: property.id,
  });

  // 6. Signed on the test account — practice must not mix into real money.
  await issueSigned({
    suffix: "6", total: 500, onTestAccount: true,
    draftId: draft.id, serviceAddressId: property.id,
  });
});

afterAll(cleanup);

describe("GET /invoices", () => {
  it("lists signed invoices only — no drafts, no voided rows, no test account", async () => {
    const res = await request(app).get("/invoices");
    expect(res.status).toBe(200);
    const mine = res.body.filter((r: { number: string }) => r.number.startsWith("0000-INV"));
    expect(mine.map((r: { number: string }) => r.number).sort()).toEqual([
      "0000-INV1", "0000-INV2", "0000-INV3",
    ]);
  });

  it("rolls the money up per invoice, splitting collected cash from discount rows", async () => {
    const res = await request(app).get("/invoices");
    const byNumber = new Map(res.body.map((r: { number: string }) => [r.number, r]));

    const unpaid = byNumber.get("0000-INV1") as Record<string, unknown>;
    expect(unpaid.paymentStatus).toBe("unpaid");
    expect(unpaid.billedTotal).toBe(900);
    expect(unpaid.depositDue).toBe(300);
    expect(unpaid.balance).toBe(900);
    expect(unpaid.sentTo).toBe("owner@example.com");

    const deposit = byNumber.get("0000-INV2") as Record<string, unknown>;
    expect(deposit.paymentStatus).toBe("deposit_paid");
    expect(deposit.totalPaid).toBe(300); // check 291 + discount 9 — the gate math
    expect(deposit.collected).toBe(291); // real money only
    expect(deposit.discountTotal).toBe(9);
    expect(deposit.balance).toBe(600);

    const paid = byNumber.get("0000-INV3") as Record<string, unknown>;
    expect(paid.paymentStatus).toBe("paid");
    expect(paid.balance).toBe(0);
    expect(paid.lastPaidAt).not.toBeNull();
  });
});
