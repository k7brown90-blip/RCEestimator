/**
 * One card charge, one expense (Kyle, 2026-09-21, PUNCHLIST N9).
 *
 * Production proof: every card swipe reached CardSpend TWICE — once from the
 * v2 money-management feed (`trxn_…`, polled every 10 min,
 * services/cardSpend.ts syncFinancialAccountTransactions) and once from the
 * classic Stripe Issuing WEBHOOK (`ipi_…`, stripePayments.ts
 * `issuing_transaction.created` / `.updated`), which kept arriving even
 * though the Issuing LIST call is refused ("not set up to use Issuing"). No
 * id is shared between the two feeds, so dedup-by-stripeTransactionId let
 * both rows live — five real duplicates, $432.06 double-counted.
 *
 * THE DECISION: the v2 feed is the ONE source of card spend. The webhook now
 * acknowledges Issuing events (so Stripe stops retrying) and creates nothing.
 * This file pins that split, plus the two things the fix must not touch:
 * materials still draft/link a P.O. exactly as before, and a receipt's per-
 * item lines still land in inventory (tests/landingPrices.test.ts), never the
 * P&L.
 *
 * No Stripe call is made anywhere in here: STRIPE_SECRET_KEY is unset and
 * every row is hand-built.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type Stripe from "stripe";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 { setCredentials() {} }
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

import { app } from "../src/app";
import { ingestFinancialAccountTransaction } from "../src/services/cardSpend";
import { dispatchStripeEvent } from "../src/services/stripePayments";

// Sentinel year (constants.md: 2031/2032/2033/2034 are already taken by other
// suites) so this file's P&L rows never collide with another test's.
const YEAR = 2035;
const OCCURRED_AT = new Date(Date.UTC(YEAR, 5, 15, 12, 0, 0));

const FA = "fa_test_n9_truck";
let truckId: string;

/** A v2 money-management transaction row, shaped like production. */
function v2Row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "trxn_n9_test",
    object: "v2.money_management.transaction",
    amount: { value: -3500, currency: "usd" },
    category: "received_debit",
    counterparty: { name: "ELET_RES_PERMIT_TN/SMYRNA/USA" },
    created: OCCURRED_AT.toISOString(),
    description: "ELET_RES_PERMIT_TN/SMYRNA/USA",
    financial_account: FA,
    flow: { received_debit: "rd_n9_test" },
    status: "posted",
    livemode: true,
    ...over,
  };
}

/** A hand-built Stripe issuing_transaction.* webhook event. Its shape does not
 * need to match Stripe.Issuing.Transaction any more: the dispatcher no longer
 * reads the payload at all (stripePayments.ts) — it only acknowledges. */
function issuingWebhookEvent(type: "issuing_transaction.created" | "issuing_transaction.updated", id: string) {
  return {
    id: `evt_${id}`,
    object: "event",
    type,
    data: { object: { id, object: "issuing.transaction" } },
  } as unknown as Stripe.Event;
}

async function summary(year: number) {
  const res = await request(app).get(`/financials/summary?year=${year}`);
  expect(res.status).toBe(200);
  return res.body as { months: { month: number; expenses: number }[]; expensesByCategory: { category: string; monthly: number[] }[] };
}
const monthOf = (s: Awaited<ReturnType<typeof summary>>) => s.months[OCCURRED_AT.getUTCMonth()].expenses;

beforeAll(async () => {
  await prisma.cardSpend.deleteMany({ where: { stripeCardId: FA } });
  const truck = await prisma.truck.create({ data: { name: `N9 Test Truck ${Date.now()}`, stripeFinancialAccountId: FA } });
  truckId = truck.id;
});

afterAll(async () => {
  const spends = await prisma.cardSpend.findMany({ where: { truckId }, select: { purchaseOrderId: true } });
  const poIds = spends.map((s) => s.purchaseOrderId).filter((v): v is string => Boolean(v));
  await prisma.cardSpend.deleteMany({ where: { OR: [{ truckId }, { stripeCardId: FA }] } });
  if (poIds.length > 0) {
    await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: { in: poIds } } });
    await prisma.purchaseOrderEvent.deleteMany({ where: { purchaseOrderId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
  }
  await prisma.purchaseOrder.deleteMany({ where: { truckId } });
  await prisma.truck.delete({ where: { id: truckId } }).catch(() => {});
});

describe("the Issuing webhook creates nothing; the v2 feed is the one source", () => {
  it("(a) issuing_transaction.created makes NO CardSpend row; the v2 row for the same charge makes exactly one, and the P&L counts it once", async () => {
    const before = await summary(YEAR);

    // The webhook event that used to duplicate this exact charge (ipi_… in
    // production). It must be acknowledged (no throw) and create nothing.
    const spendCountBefore = await prisma.cardSpend.count();
    await expect(dispatchStripeEvent(prisma, issuingWebhookEvent("issuing_transaction.created", "ipi_n9_test"))).resolves.toBeUndefined();
    await expect(dispatchStripeEvent(prisma, issuingWebhookEvent("issuing_transaction.updated", "ipi_n9_test"))).resolves.toBeUndefined();
    expect(await prisma.cardSpend.count({ where: { stripeTransactionId: "ipi_n9_test" } })).toBe(0);
    expect(await prisma.cardSpend.count()).toBe(spendCountBefore);

    // The v2 row for the SAME real-world charge — this is the one row that should exist.
    const { spend, created } = await ingestFinancialAccountTransaction(v2Row());
    expect(created).toBe(true);
    expect(spend.amount).toBe(35);
    expect(await prisma.cardSpend.count({ where: { stripeCardId: FA } })).toBe(1);

    const after = await summary(YEAR);
    // permit lands as its own P&L category (services/cardSpend.ts kindForMerchantName
    // does not match "ELET_RES_PERMIT_TN" against any pattern, so it is "other" →
    // "overhead" unless re-kinded; either way the delta must be exactly ONE $35 charge).
    expect(monthOf(after) - monthOf(before)).toBe(35);

    // Re-delivering the same webhook event again still creates nothing.
    await dispatchStripeEvent(prisma, issuingWebhookEvent("issuing_transaction.created", "ipi_n9_test"));
    expect(await prisma.cardSpend.count({ where: { stripeTransactionId: "ipi_n9_test" } })).toBe(0);
    expect(monthOf(await summary(YEAR)) - monthOf(before)).toBe(35);
  });
});

describe("materials still draft or link their P.O. exactly as before", () => {
  it("(b) a materials v2 charge with no PO behind it drafts exactly one PO, and the charge lands on it exactly once", async () => {
    const posBefore = await prisma.purchaseOrder.count({ where: { truckId } });
    const { spend } = await ingestFinancialAccountTransaction(v2Row({
      id: "trxn_n9_materials", amount: { value: -14501, currency: "usd" },
      counterparty: { name: "THE HOME DEPOT #0733/SMYRNA/USA" }, description: "THE HOME DEPOT #0733/SMYRNA/USA",
    }));
    expect(spend.kind).toBe("materials");
    expect(spend.amount).toBe(145.01);
    expect(spend.purchaseOrderId).not.toBeNull();
    expect(await prisma.purchaseOrder.count({ where: { truckId } })).toBe(posBefore + 1);

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: spend.purchaseOrderId! } });
    expect(po.afterTheFact).toBe(true);
    expect(po.truckId).toBe(truckId);
    expect(await prisma.cardSpend.count({ where: { purchaseOrderId: po.id } })).toBe(1);
  });
});

describe("a receipt's amount still adds nothing to the P&L (the charge is the money)", () => {
  it("(c) a manual receipt with an amount changes no P&L figure — the money is only ever on CardSpend/PurchaseOrder/CompanyBill/payroll/BankLine", async () => {
    const before = await summary(YEAR);
    const receipt = await prisma.receipt.create({
      data: {
        category: "materials", vendor: "N9-test receipt-only", amount: 999.99, status: "confirmed", source: "manual",
        receivedAt: OCCURRED_AT,
      },
    });
    const after = await summary(YEAR);
    expect(monthOf(after)).toBe(monthOf(before));
    await prisma.receipt.delete({ where: { id: receipt.id } });
  });
});

// (c), the inventory half: a receipt's per-item lines (receiptVision `unitCost`
// per line) still land at per-item cost via the P.O. landing path
// (purchase_in, services/inventory.ts landPurchaseOrder ~843-930). Already
// pinned end-to-end — not duplicated here:
//   tests/landingPrices.test.ts › "landing prices come from the receipt, line
//   by line" › "two breakers on one receipt each land at THEIR receipt line's
//   price plus its tax share" (asserts the receipt's per-line unitCost drives
//   the purchase_in StockMovement.unitCost and the resulting StockLevel.avgUnitCost).
