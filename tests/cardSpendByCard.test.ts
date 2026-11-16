/**
 * Each card swipe goes to the truck whose card made it (Kyle, 2026-11-15).
 *
 * "The cards are already assigned to the trucks though" — Truck.stripeCardId is set for both cards
 * (••••9891 Michael Schramm, ••••3805 Kyle Brown), but both draw on ONE Field Expenses financial
 * account, and routing by that account put every swipe on the oldest truck. The v2 transaction does
 * not name the card; the Treasury ReceivedDebit behind `flow.received_debit` does
 * (initiating_payment_method_details.issuing_card), so the ingest retrieves it and routes by
 * Truck.stripeCardId first, the account second.
 *
 * Mock style is the one tests/treasurySweep.test.ts uses: services/stripePayments is mocked so
 * stripe() hands back only what the code under test calls. Nothing here reaches Stripe.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
// stripeConfigured() is mocked true below; the value here never reaches the network.
process.env.STRIPE_SECRET_KEY = "rk_test_mocked_never_used";

const mocks = vi.hoisted(() => ({
  receivedDebitRetrieve: vi.fn(),
  logSystemEvent: vi.fn(),
}));

vi.mock("../src/services/stripePayments", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/stripePayments")>();
  return {
    ...mod,
    stripeConfigured: () => true,
    // The card is read off the v2 ReceivedDebit via rawRequest (the v1 Treasury retrieve answers
    // "Unrecognized request URL" on this account — production, 2026-11-15).
    stripe: () => ({ rawRequest: mocks.receivedDebitRetrieve }),
  };
});
vi.mock("../src/services/systemEvents", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/systemEvents")>();
  return { ...mod, logSystemEvent: mocks.logSystemEvent };
});
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

import { createCardResolver, ingestFinancialAccountTransaction } from "../src/services/cardSpend";

const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const FA = `fa_test_bycard_${suffix}`;
const CARD_A = `ic_testA_${suffix}`;
const CARD_B = `ic_testB_${suffix}`;
const CARD_STRANGER = `ic_testX_${suffix}`;
const newId = () => `trxn_${crypto.randomUUID().replaceAll("-", "")}`;

let truckA: string;
let truckB: string;

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
    flow: { received_debit: `rd_${id.slice(5, 25)}`, type: "received_debit" },
    status: "posted",
    livemode: true,
    ...over,
  };
}

/** What GET /v2/money_management/received_debits/:id answers for a swipe made on `card`. */
const debitOnCard = (card: string) => ({
  id: "rd_mock",
  object: "v2.money_management.received_debit",
  type: "card_spend",
  card_spend: { card_v1_id: card, card_transactions: [] },
});

beforeAll(async () => {
  // A is created first, so routing by the shared account alone would put every swipe on A.
  truckA = (await prisma.truck.create({ data: { name: `ByCard A ${suffix}`, stripeCardId: CARD_A, stripeFinancialAccountId: FA } })).id;
  truckB = (await prisma.truck.create({ data: { name: `ByCard B ${suffix}`, stripeCardId: CARD_B, stripeFinancialAccountId: FA } })).id;
});

beforeEach(() => {
  mocks.receivedDebitRetrieve.mockReset();
  mocks.logSystemEvent.mockReset();
});

afterAll(async () => {
  const trucks = [truckA, truckB];
  const spends = await prisma.cardSpend.findMany({ where: { truckId: { in: trucks } }, select: { purchaseOrderId: true } });
  const poIds = spends.map((s) => s.purchaseOrderId).filter((v): v is string => Boolean(v));
  await prisma.cardSpend.deleteMany({ where: { OR: [{ truckId: { in: trucks } }, { stripeCardId: { in: [CARD_A, CARD_B, CARD_STRANGER, FA] } }] } });
  const pos = await prisma.purchaseOrder.findMany({ where: { OR: [{ id: { in: poIds } }, { truckId: { in: trucks } }] }, select: { id: true } });
  const ids = pos.map((p) => p.id);
  if (ids.length > 0) {
    await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: { in: ids } } });
    await prisma.purchaseOrderEvent.deleteMany({ where: { purchaseOrderId: { in: ids } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.truck.deleteMany({ where: { id: { in: trucks } } });
});

describe("a swipe goes to the truck whose card made it", () => {
  it("routes a swipe on card B to truck B even though the shared account's oldest truck is A, and stores the real card id", async () => {
    mocks.receivedDebitRetrieve.mockResolvedValue(debitOnCard(CARD_B));
    const row = txn();
    const { spend, created } = await ingestFinancialAccountTransaction(row);
    expect(created).toBe(true);
    expect(mocks.receivedDebitRetrieve).toHaveBeenCalledWith(
      "GET",
      `/v2/money_management/received_debits/${row.flow.received_debit}`,
      undefined,
      expect.objectContaining({ apiVersion: expect.stringMatching(/.preview$/) }),
    );
    expect(spend.truckId).toBe(truckB);
    expect(spend.stripeCardId).toBe(CARD_B);
  });

  it("routes a swipe on card A to truck A", async () => {
    mocks.receivedDebitRetrieve.mockResolvedValue(debitOnCard(CARD_A));
    const { spend } = await ingestFinancialAccountTransaction(txn());
    expect(spend.truckId).toBe(truckA);
    expect(spend.stripeCardId).toBe(CARD_A);
  });

  it("a supplier swipe with no PO drafts its PO-after-the-fact on the CARD's truck", async () => {
    mocks.receivedDebitRetrieve.mockResolvedValue(debitOnCard(CARD_B));
    const { spend } = await ingestFinancialAccountTransaction(txn({ counterparty: { name: "CITY ELECTRIC SUPPLY/NASHVILLE/USA" } }));
    expect(spend.truckId).toBe(truckB);
    expect(spend.purchaseOrderId).not.toBeNull();
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: spend.purchaseOrderId! } });
    expect(po.afterTheFact).toBe(true);
    expect(po.purpose).toBe("truck_stock");
    expect(po.truckId).toBe(truckB);
  });

  it("falls back to the financial account when no truck has the card", async () => {
    mocks.receivedDebitRetrieve.mockResolvedValue(debitOnCard(CARD_STRANGER));
    const { spend } = await ingestFinancialAccountTransaction(txn());
    expect(spend.truckId).toBe(truckA);
    // The real card is still recorded, so a truck mapped to it later is the answer.
    expect(spend.stripeCardId).toBe(CARD_STRANGER);
  });
});

describe("a card that cannot be read never breaks the ingest", () => {
  it("a Stripe refusal falls back to the account, warns ONCE per run, and stops calling Stripe for the rest of the run", async () => {
    mocks.receivedDebitRetrieve.mockRejectedValue(Object.assign(new Error("The provided key does not have the required permissions"), { statusCode: 403, type: "StripePermissionError" }));
    const cards = createCardResolver();
    const first = await ingestFinancialAccountTransaction(txn({ counterparty: { name: "SHELL OIL 123/HERMITAGE/USA" } }), { cards });
    const second = await ingestFinancialAccountTransaction(txn({ counterparty: { name: "SHELL OIL 456/HERMITAGE/USA" } }), { cards });

    expect(first.spend.truckId).toBe(truckA);
    expect(second.spend.truckId).toBe(truckA);
    // Account routing, as before — but the stored card is the ACCOUNT id, never the fallback truck's own
    // ic_ card: an ic_ on a row means "read off the received debit", and a stamp would pass for that.
    expect(first.spend.stripeCardId).toBe(FA);
    expect(second.spend.stripeCardId).toBe(FA);
    expect(mocks.receivedDebitRetrieve).toHaveBeenCalledTimes(1);
    const warns = mocks.logSystemEvent.mock.calls.filter(([level, source]) => level === "warn" && source === "card-spend");
    expect(warns).toHaveLength(1);
  });

  it("a received debit that names no issuing card falls back to the account", async () => {
    mocks.receivedDebitRetrieve.mockResolvedValue({ id: "rd_x", type: "bank_transfer", bank_transfer: { statement_descriptor: "X" } });
    const { spend } = await ingestFinancialAccountTransaction(txn({ counterparty: { name: "SHELL OIL 789/HERMITAGE/USA" } }));
    expect(spend.truckId).toBe(truckA);
    expect(spend.stripeCardId).toBe(FA);
    // The reason names the fields that came back (never their values), so a dry run shows the real shape.
    const info = mocks.logSystemEvent.mock.calls.find(([level, source]) => level === "info" && source === "card-spend");
    expect(String(info?.[2])).toContain("type bank_transfer; fields: type, bank_transfer");
    expect(String(info?.[2])).not.toContain("statement_descriptor");
  });

  it("an id that is not an ic_ card is never taken as the card", async () => {
    mocks.receivedDebitRetrieve.mockResolvedValue({ id: "rd_y", type: "card_spend", card_spend: { card_v1_id: FA } });
    const { spend } = await ingestFinancialAccountTransaction(txn({ counterparty: { name: "SHELL OIL 790/HERMITAGE/USA" } }));
    expect(spend.truckId).toBe(truckA);
    expect(spend.stripeCardId).toBe(FA);
  });

  it("a transaction with no received-debit id never calls Stripe", async () => {
    const { spend } = await ingestFinancialAccountTransaction(txn({ flow: { type: "received_debit" }, counterparty: { name: "SHELL OIL 000/HERMITAGE/USA" } }));
    expect(mocks.receivedDebitRetrieve).not.toHaveBeenCalled();
    expect(spend.truckId).toBe(truckA);
    expect(spend.stripeCardId).toBe(FA);
  });

  it("a stored ic_ is not taken as the card: an unrouted row with a stale truck stamp is looked up again", async () => {
    // A row left unrouted that carries some truck's ic_ stamp (the pre-2026-11-15 shape) is asked about on Stripe.
    const row = txn({ counterparty: { name: "SHELL OIL 555/HERMITAGE/USA" } });
    mocks.receivedDebitRetrieve.mockRejectedValue(Object.assign(new Error("no scope"), { statusCode: 403, type: "StripePermissionError" }));
    const first = await ingestFinancialAccountTransaction(row);
    await prisma.cardSpend.update({ where: { id: first.spend.id }, data: { truckId: null, stripeCardId: CARD_A } });
    mocks.receivedDebitRetrieve.mockReset();
    mocks.receivedDebitRetrieve.mockResolvedValue(debitOnCard(CARD_B));
    const again = await ingestFinancialAccountTransaction(row);
    expect(mocks.receivedDebitRetrieve).toHaveBeenCalledTimes(1);
    expect(again.spend.truckId).toBe(truckB);
    expect(again.spend.stripeCardId).toBe(CARD_B);
  });
});

describe("re-delivery leaves the truck Kyle chose", () => {
  it("a row Kyle moved stays moved, keeps its real card id, and Stripe is not asked again", async () => {
    mocks.receivedDebitRetrieve.mockResolvedValue(debitOnCard(CARD_B));
    const row = txn({ counterparty: { name: "SHELL OIL 321/HERMITAGE/USA" } });
    const first = await ingestFinancialAccountTransaction(row);
    expect(first.spend.truckId).toBe(truckB);

    await prisma.cardSpend.update({ where: { id: first.spend.id }, data: { truckId: truckA } });
    mocks.receivedDebitRetrieve.mockClear();

    const again = await ingestFinancialAccountTransaction({ ...row, status: "posted" });
    expect(again.created).toBe(false);
    expect(again.spend.truckId).toBe(truckA);
    expect(again.spend.stripeCardId).toBe(CARD_B);
    expect(mocks.receivedDebitRetrieve).not.toHaveBeenCalled();
  });
});
