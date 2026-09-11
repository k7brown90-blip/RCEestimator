/**
 * Card spend off the FINANCIAL ACCOUNT feed (Kyle, 2026-09-10).
 *
 * Classic Issuing is not enabled on this Stripe account — probed in production:
 * "Your account is not set up to use Issuing". The Field Expenses ••••3805 card
 * is issued by the Financial Accounts product, and its swipes arrive on the v2
 * money-management transaction feed as `received_debit` rows with no merchant
 * category code, a counterparty string like "THE HOME DEPOT #0733/HERMITAGE/USA",
 * and a status that moves pending → posted (or void).
 *
 * The rows below are the real shapes returned by production on 2026-09-10.
 * Nothing here calls Stripe: rows are hand-built and STRIPE_SECRET_KEY is unset.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
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

import { ingestFinancialAccountTransaction, kindForMerchantName } from "../src/services/cardSpend";

const FA = "fa_test_f150";
const OTHER_FA = "fa_test_nobody";
const newId = () => `trxn_${crypto.randomUUID().replaceAll("-", "")}`;

let truckId: string;

/** The production row shape, minus the fields the ingest does not read. */
function txn(over: Partial<Record<string, unknown>> = {}) {
  const id = (over.id as string) ?? newId();
  return {
    id,
    object: "v2.money_management.transaction",
    amount: { value: -1251, currency: "usd" },
    category: "received_debit",
    counterparty: { name: "THE HOME DEPOT #0733/HERMITAGE/USA" },
    created: new Date().toISOString(),
    description: "THE HOME DEPOT #0733/HERMITAGE/USA",
    financial_account: FA,
    flow: { received_debit: `rd_${id.slice(5, 20)}`, type: "received_debit" },
    status: "pending",
    livemode: true,
    ...over,
  };
}

beforeAll(async () => {
  await prisma.cardSpend.deleteMany({ where: { stripeCardId: { in: [FA, OTHER_FA] } } });
  const truck = await prisma.truck.create({
    data: { name: `FA Test Truck ${Date.now()}`, stripeFinancialAccountId: FA },
  });
  truckId = truck.id;
});

afterAll(async () => {
  const spends = await prisma.cardSpend.findMany({ where: { truckId }, select: { purchaseOrderId: true } });
  const poIds = spends.map((s) => s.purchaseOrderId).filter((v): v is string => Boolean(v));
  await prisma.cardSpend.deleteMany({ where: { OR: [{ truckId }, { stripeCardId: { in: [FA, OTHER_FA] } }] } });
  if (poIds.length > 0) {
    await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: { in: poIds } } });
    await prisma.purchaseOrderEvent.deleteMany({ where: { purchaseOrderId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
  }
  await prisma.purchaseOrder.deleteMany({ where: { truckId } });
  await prisma.truck.delete({ where: { id: truckId } }).catch(() => {});
});

describe("kindForMerchantName — there is no MCC on this feed", () => {
  it("reads the merchant string instead", () => {
    expect(kindForMerchantName("THE HOME DEPOT #0733")).toBe("materials");
    expect(kindForMerchantName("CITY ELECTRIC SUPPLY")).toBe("materials");
    expect(kindForMerchantName("SUNBELT RENTALS #126")).toBe("tool");
    expect(kindForMerchantName("SHELL OIL 12345678")).toBe("fuel");
    expect(kindForMerchantName("O'REILLY AUTO PARTS")).toBe("maintenance");
    expect(kindForMerchantName("SOME DINER")).toBe("other");
    expect(kindForMerchantName(null)).toBe("other");
  });
});

describe("a Home Depot swipe off the financial account", () => {
  let spendId: string;
  let transactionId: string;

  it("lands as a positive purchase on the truck that owns the account, and drafts a PO", async () => {
    const row = txn();
    transactionId = row.id;
    const { spend, created } = await ingestFinancialAccountTransaction(row);
    spendId = spend.id;

    expect(created).toBe(true);
    // -1251 cents on the feed is $12.51 OUT of the account.
    expect(spend.amount).toBe(12.51);
    expect(spend.merchantName).toBe("THE HOME DEPOT #0733");
    expect(spend.merchantCity).toBe("HERMITAGE");
    expect(spend.kind).toBe("materials");
    expect(spend.settlement).toBe("pending");
    expect(spend.truckId).toBe(truckId);
    expect(spend.purchaseOrderId).not.toBeNull();

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: spend.purchaseOrderId! } });
    expect(po.afterTheFact).toBe(true);
    expect(po.truckId).toBe(truckId);
    expect(po.supplier).toBe("THE HOME DEPOT #0733");
  });

  it("posting the same transaction flips settlement and keeps Kyle's edits", async () => {
    await prisma.cardSpend.update({ where: { id: spendId }, data: { kind: "tool", note: "Kyle says tools" } });
    const { spend, created } = await ingestFinancialAccountTransaction(
      txn({ id: transactionId, status: "posted", status_transitions: { posted_at: new Date().toISOString() } }),
    );
    expect(created).toBe(false);
    expect(spend.settlement).toBe("posted");
    expect(spend.kind).toBe("tool");
    expect(spend.note).toBe("Kyle says tools");
  });
});

describe("the rest of the feed", () => {
  it("a rental is a tool, not materials, and drafts no PO", async () => {
    const { spend } = await ingestFinancialAccountTransaction(
      txn({ amount: { value: -5680, currency: "usd" }, counterparty: { name: "SUNBELT RENTALS #126/NASHVILLE-DAV/USA" } }),
    );
    expect(spend.amount).toBe(56.8);
    expect(spend.kind).toBe("tool");
    expect(spend.merchantCity).toBe("NASHVILLE-DAV");
    expect(spend.purchaseOrderId).toBeNull();
  });

  it("a refund is negative, drafts NO new PO, and rides the purchase's PO", async () => {
    const before = await prisma.purchaseOrder.count({ where: { truckId } });
    const { spend } = await ingestFinancialAccountTransaction(
      txn({ amount: { value: 4200, currency: "usd" }, counterparty: { name: "THE HOME DEPOT #0733/HERMITAGE/USA" } }),
    );
    expect(spend.amount).toBe(-42);
    // Money back at the same store belongs to the order it reverses, not a new one.
    expect(await prisma.purchaseOrder.count({ where: { truckId } })).toBe(before);
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: spend.purchaseOrderId! } });
    expect(po.supplier).toBe("THE HOME DEPOT #0733");
  });

  it("a void is ignored with the reason, never deleted", async () => {
    const row = txn({ amount: { value: -999, currency: "usd" } });
    await ingestFinancialAccountTransaction(row);
    const { spend, voided } = await ingestFinancialAccountTransaction({ ...row, status: "void" });
    expect(voided).toBe(true);
    expect(spend.settlement).toBe("void");
    expect(spend.status).toBe("ignored");
    expect(spend.ignoredReason).toBe("voided by Stripe");
    expect(await prisma.cardSpend.count({ where: { stripeTransactionId: row.id } })).toBe(1);
  });

  it("a swipe on an account no truck claims stays unrouted rather than guessing", async () => {
    const { spend } = await ingestFinancialAccountTransaction(
      txn({ financial_account: OTHER_FA, counterparty: { name: "LOWES #2244/SMYRNA/USA" } }),
    );
    expect(spend.truckId).toBeNull();
    expect(spend.stripeCardId).toBe(OTHER_FA);
    expect(spend.kind).toBe("materials");
  });
});

// Kyle, 2026-09-11 — the duplicate POs 0005–0008. The office opened a PO,
// photographed the receipt against it, and it was verified (or landed and
// closed) BEFORE the card feed caught up a day later. The swipe must join that
// PO, not draft a second one.
describe("a swipe that arrives after the office PO is already verified or landed", () => {
  it("joins the PO that holds the exact-amount receipt instead of drafting a duplicate", async () => {
    const { createPurchaseOrder, transitionPurchaseOrder } = await import("../src/services/purchaseOrders");
    const dayAgo = new Date(Date.now() - 24 * 3600e3);
    const office = await createPurchaseOrder({
      supplier: "Home Depot", truckId, openedBy: "owner", actor: "owner", openedAt: new Date(Date.now() - 2 * 24 * 3600e3),
    } as Parameters<typeof createPurchaseOrder>[0]);
    await prisma.receipt.create({
      data: { purchaseOrderId: office.id, category: "materials", status: "confirmed", vendor: "The Home Depot", amount: 30.8, source: "tech_pwa", receivedAt: dayAgo },
    });
    for (const to of ["purchased", "verified", "closed"] as const) {
      await transitionPurchaseOrder(office.id, to, { actor: "test", reason: "office flow" });
    }
    const before = await prisma.purchaseOrder.count({ where: { truckId } });

    const { spend } = await ingestFinancialAccountTransaction(
      txn({ amount: { value: -3080, currency: "usd" }, created: dayAgo.toISOString(), counterparty: { name: "THE HOME DEPOT  #0776/LA VERGNE/USA" } }),
    );

    expect(spend.purchaseOrderId).toBe(office.id);
    expect(await prisma.purchaseOrder.count({ where: { truckId } })).toBe(before);

    await prisma.receipt.deleteMany({ where: { purchaseOrderId: office.id } });
  });
});
