/**
 * Month-end sweep + Stripe fees (Kyle, 2026-09-09, Build 5).
 *
 * "At the end of each month I will take whatever money is over that value and
 * deposit it into the Chase savings accounts for taxes and owner
 * distributions." Floats live in Settings; the sweep is a click from the
 * number Financials shows; Stripe's processing fees are their own P&L expense
 * line and Collected stays gross.
 *
 * No Stripe call leaves this file: the Stripe client is mocked at
 * services/stripePayments (rawRequest for the v2 money-management reads and
 * the outbound transfer, balance.retrieve, balanceTransactions.list as an
 * async iterator the way the SDK's auto-pagination is consumed).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
// stripeConfigured() is mocked true below; the value here never reaches the network.
process.env.STRIPE_SECRET_KEY = "rk_test_mocked_never_used";

const mocks = vi.hoisted(() => ({
  rawRequest: vi.fn(),
  balanceRetrieve: vi.fn(),
  balanceTransactionsList: vi.fn(),
}));

vi.mock("../src/services/stripePayments", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/stripePayments")>();
  return {
    ...mod,
    stripeConfigured: () => true,
    stripe: () => ({
      rawRequest: mocks.rawRequest,
      balance: { retrieve: mocks.balanceRetrieve },
      balanceTransactions: { list: mocks.balanceTransactionsList },
      treasury: { financialAccounts: { list: vi.fn().mockResolvedValue({ data: [] }) } },
    }),
  };
});
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

import { app } from "../src/app";
import { resetBalancesCache } from "../src/services/cardSpend";
import { resetStripeFeeCache, sweepExcess } from "../src/services/treasury";
import { defaultTruckId } from "../src/services/purchaseOrders";

const MAIN = "fa_test_main";
const TRUCK_FA = "fa_test_truck1";
const CHASE = "usba_test_chase";
const r2 = (n: number) => Math.round(n * 100) / 100;

// Mid current month, noon local — every fee row lands in one P&L column.
const base = new Date();
base.setDate(15);
base.setHours(12, 0, 0, 0);
const year = base.getFullYear();
const month = base.getMonth();
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

/** Stripe's v2 financial-account shape, balances in cents. */
function financialAccounts(main: { available: number; outbound?: number; inbound?: number }, truck = 40_000) {
  return {
    data: [
      { id: MAIN, status: "open", balance: { available: { usd: { value: main.available } }, inbound_pending: { usd: { value: main.inbound ?? 0 } }, outbound_pending: { usd: { value: main.outbound ?? 0 } } } },
      { id: TRUCK_FA, status: "open", balance: { available: { usd: { value: truck } }, inbound_pending: { usd: { value: 0 } }, outbound_pending: { usd: { value: 0 } } } },
    ],
  };
}

function permissionError(message: string) {
  return Object.assign(new Error(message), { statusCode: 403, type: "StripePermissionError", code: "more_permissions_required" });
}

/** rawRequest dispatch: GET financial accounts → balances; POST outbound transfer → per-test. */
let accountsResponse: () => Promise<unknown> = () => Promise.resolve(financialAccounts({ available: 1_250_000, outbound: 50_000 }));
let transferResponse: (params: unknown) => Promise<unknown> = () => Promise.resolve({ id: "obt_test_1", status: "processing" });
mocks.rawRequest.mockImplementation((method: string, path: string, params?: unknown) => {
  if (method === "GET" && path.startsWith("/v2/money_management/financial_accounts")) return accountsResponse();
  if (method === "POST" && path === "/v2/money_management/outbound_transfers") return transferResponse(params);
  return Promise.reject(new Error(`unexpected rawRequest ${method} ${path}`));
});
mocks.balanceRetrieve.mockResolvedValue({ available: [{ amount: 100_000, currency: "usd" }], pending: [] });

/** Balance transactions as the SDK yields them under `for await` — two card charges with fees, one bank payment. */
type BalanceTx = { id: string; type: string; amount: number; fee: number; net: number; created: number; source: string };
let feeRows: BalanceTx[] = [
  { id: "txn_1", type: "charge", amount: 100_000, fee: 3_200, net: 96_800, created: unix(base), source: "ch_test_1" },
  { id: "txn_2", type: "charge", amount: 50_000, fee: 1_750, net: 48_250, created: unix(new Date(base.getTime() + 3_600_000)), source: "ch_test_2" },
  { id: "txn_3", type: "payment", amount: 200_000, fee: 800, net: 199_200, created: unix(new Date(base.getTime() + 7_200_000)), source: "py_test_3" },
];
let feesThrow: Error | null = null;
mocks.balanceTransactionsList.mockImplementation((params: { type?: string }) => {
  const rows = feeRows.filter((r) => r.type === params.type);
  return (async function* () {
    if (feesThrow) throw feesThrow;
    for (const r of rows) yield r;
  })();
});

let truckId: string;

async function waitForEvent(where: { source: string; level: string; message: { contains: string } }) {
  for (let i = 0; i < 20; i++) {
    const row = await prisma.systemEvent.findFirst({ where, orderBy: { createdAt: "desc" } });
    if (row) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

async function settings(value: Record<string, unknown>) {
  const res = await request(app).put("/settings/treasury").send(value);
  expect(res.status).toBe(200);
  return res.body;
}

const FULL_SETTINGS = () => ({
  mainFinancialAccountId: MAIN,
  mainFloat: 5000,
  truckFloats: { [truckId]: 300 },
  chaseAccountLabel: "Chase savings — taxes & distributions",
  chaseExternalAccountId: CHASE,
});

beforeAll(async () => {
  await prisma.treasurySweep.deleteMany();
  await prisma.companySetting.deleteMany({ where: { key: "treasury" } });
  await prisma.systemEvent.deleteMany({ where: { source: "treasury" } });
  await prisma.payment.deleteMany({ where: { note: "TS-test" } });
  truckId = await defaultTruckId();
  await prisma.truck.update({ where: { id: truckId }, data: { stripeFinancialAccountId: TRUCK_FA } });
});

afterAll(async () => {
  await prisma.treasurySweep.deleteMany();
  await prisma.companySetting.deleteMany({ where: { key: "treasury" } });
  await prisma.systemEvent.deleteMany({ where: { source: "treasury" } });
  await prisma.payment.deleteMany({ where: { note: "TS-test" } });
  await prisma.truck.update({ where: { id: truckId }, data: { stripeFinancialAccountId: null } });
});

beforeEach(() => {
  resetBalancesCache();
  accountsResponse = () => Promise.resolve(financialAccounts({ available: 1_250_000, outbound: 50_000 }));
  transferResponse = () => Promise.resolve({ id: "obt_test_1", status: "processing" });
});

describe("treasury settings", () => {
  it("defaults to zero floats and nothing chosen", async () => {
    const res = await request(app).get("/settings/treasury");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mainFinancialAccountId: null, mainFloat: 0, truckFloats: {}, chaseAccountLabel: null, chaseExternalAccountId: null });
  });

  it("round-trips the block and validates every number ≥ 0", async () => {
    const saved = await settings(FULL_SETTINGS());
    expect(saved).toEqual(FULL_SETTINGS());
    const read = await request(app).get("/settings/treasury");
    expect(read.body).toEqual(FULL_SETTINGS());

    const negativeMain = await request(app).put("/settings/treasury").send({ ...FULL_SETTINGS(), mainFloat: -1 });
    expect(negativeMain.status).toBe(400);
    const negativeTruck = await request(app).put("/settings/treasury").send({ ...FULL_SETTINGS(), truckFloats: { [truckId]: -50 } });
    expect(negativeTruck.status).toBe(400);
    const notANumber = await request(app).put("/settings/treasury").send({ ...FULL_SETTINGS(), mainFloat: "five" });
    expect(notANumber.status).toBe(400);
    // The bad writes changed nothing.
    expect((await request(app).get("/settings/treasury")).body).toEqual(FULL_SETTINGS());
    // The generic settings GET carries the block too (same store as companyProfile).
    const all = await request(app).get("/crm/settings");
    expect(all.body.treasury).toEqual(FULL_SETTINGS());
  });
});

describe("the sweep number", () => {
  it("excess = balance − float − outbound pending, floored at zero", () => {
    expect(sweepExcess(12_500, 5_000, 500)).toBe(7_000);
    expect(sweepExcess(4_000, 5_000, 0)).toBe(0);
    expect(sweepExcess(5_000, 5_000, 0)).toBe(0);
    expect(sweepExcess(100.10, 0.05, 0.02)).toBe(100.03);
  });

  it("GET /financials/sweep reads the main account and every truck against its float", async () => {
    await settings(FULL_SETTINGS());
    const res = await request(app).get("/financials/sweep?fresh=1");
    expect(res.status).toBe(200);
    expect(res.body.main).toEqual({ financialAccountId: MAIN, balance: 12_500, inboundPending: 0, outboundPending: 500, float: 5_000, excess: 7_000 });
    const truck = res.body.trucks.find((t: { truckId: string }) => t.truckId === truckId);
    expect(truck).toMatchObject({ financialAccountId: TRUCK_FA, balance: 400, float: 300, excessOrShortfall: 100 });
    expect(res.body.destination).toEqual({ label: "Chase savings — taxes & distributions", externalAccountId: CHASE });
    expect(res.body.canSweep).toBe(true);
    expect(res.body.reason).toBeNull();
    expect(typeof res.body.asOf).toBe("string");
    expect(Array.isArray(res.body.recent)).toBe(true);
  });

  it("a truck under its float shows the shortfall; the main account at or under its float has no excess", async () => {
    await settings({ ...FULL_SETTINGS(), mainFloat: 13_000, truckFloats: { [truckId]: 1_000 } });
    const res = await request(app).get("/financials/sweep?fresh=1");
    expect(res.body.main.excess).toBe(0);
    expect(res.body.canSweep).toBe(false);
    expect(res.body.reason).toMatch(/No excess/);
    const truck = res.body.trucks.find((t: { truckId: string }) => t.truckId === truckId);
    expect(truck.excessOrShortfall).toBe(-600);
  });

  it("says which scope is missing when Stripe refuses the read, and what to choose when nothing is chosen", async () => {
    await settings(FULL_SETTINGS());
    accountsResponse = () => Promise.reject(permissionError("This API key does not have the required permissions for this endpoint (more_permissions_required)."));
    const noScope = await request(app).get("/financials/sweep?fresh=1");
    expect(noScope.status).toBe(200);
    expect(noScope.body.stripeAvailable).toBe(false);
    expect(noScope.body.canSweep).toBe(false);
    expect(noScope.body.reason).toMatch(/Money Management read scope/);
    expect(noScope.body.main).toBeNull();

    accountsResponse = () => Promise.resolve(financialAccounts({ available: 1_250_000, outbound: 50_000 }));
    await settings({ ...FULL_SETTINGS(), mainFinancialAccountId: null });
    const noAccount = await request(app).get("/financials/sweep?fresh=1");
    expect(noAccount.body.canSweep).toBe(false);
    expect(noAccount.body.reason).toMatch(/main financial account in Settings/);

    await settings({ ...FULL_SETTINGS(), chaseExternalAccountId: null });
    const noDestination = await request(app).get("/financials/sweep?fresh=1");
    expect(noDestination.body.main.excess).toBe(7_000);
    expect(noDestination.body.canSweep).toBe(false);
    expect(noDestination.body.reason).toMatch(/Chase destination/);
  });
});

describe("the click", () => {
  it("refuses without the confirm word (400), above the excess (409), and with no destination (409 + reason)", async () => {
    await settings(FULL_SETTINGS());
    const noWord = await request(app).post("/financials/sweep").send({ amount: 100 });
    expect(noWord.status).toBe(400);
    expect(noWord.body.error).toMatch(/SWEEP/);
    const wrongWord = await request(app).post("/financials/sweep").send({ amount: 100, confirm: "sweep please" });
    expect(wrongWord.status).toBe(400);

    const tooMuch = await request(app).post("/financials/sweep").send({ amount: 7_000.01, confirm: "SWEEP" });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toMatch(/more than the excess/);

    await settings({ ...FULL_SETTINGS(), chaseExternalAccountId: null });
    const noDestination = await request(app).post("/financials/sweep").send({ amount: 100, confirm: "SWEEP" });
    expect(noDestination.status).toBe(409);
    expect(noDestination.body.error).toMatch(/Chase destination/);

    // Nothing reached Stripe's write endpoint, and nothing was recorded.
    expect(mocks.rawRequest.mock.calls.some(([m, p]) => m === "POST" && String(p).includes("outbound_transfers"))).toBe(false);
    expect(await prisma.treasurySweep.count()).toBe(0);
  });

  it("creates the outbound transfer from the FRESH excess, records a created row, logs INFO", async () => {
    await settings(FULL_SETTINGS());
    let sent: unknown = null;
    transferResponse = (params) => { sent = params; return Promise.resolve({ id: "obt_test_1", status: "processing" }); };

    const res = await request(app).post("/financials/sweep").send({ amount: 7_000, confirm: "SWEEP" });
    expect(res.status).toBe(201);
    expect(res.body.excessAtClick).toBe(7_000);
    expect(res.body.sweep).toMatchObject({ financialAccountId: MAIN, amount: 7_000, destinationLabel: "Chase savings — taxes & distributions", stripeTransferId: "obt_test_1", status: "created", requestedBy: "owner" });

    // The v2 shape, sent once, with the preview version header.
    expect(sent).toEqual({
      from: { financial_account: MAIN, currency: "usd" },
      to: { payout_method: CHASE },
      amount: { value: 700_000, currency: "usd" },
      description: "Month-end sweep to Chase — taxes & owner distributions",
    });
    const call = mocks.rawRequest.mock.calls.find(([m, p]) => m === "POST" && p === "/v2/money_management/outbound_transfers")!;
    expect(call[3]).toMatchObject({ apiVersion: expect.stringMatching(/\.preview$/), idempotencyKey: expect.stringContaining("sweep-") });

    const row = await prisma.treasurySweep.findUniqueOrThrow({ where: { id: res.body.sweep.id } });
    expect(row.status).toBe("created");
    expect(row.error).toBeNull();
    const event = await waitForEvent({ source: "treasury", level: "info", message: { contains: "Month-end sweep: $7000.00" } });
    expect(event).not.toBeNull();

    // It shows in the last five.
    const view = await request(app).get("/financials/sweep");
    expect(view.body.recent[0].id).toBe(res.body.sweep.id);
  });

  it("a Stripe permission refusal is a 502 with Stripe's exact message, a failed row, and a WARN", async () => {
    await settings(FULL_SETTINGS());
    const message = "This API key does not have the required permissions for this endpoint (more_permissions_required: money_management_write).";
    transferResponse = () => Promise.reject(permissionError(message));

    const res = await request(app).post("/financials/sweep").send({ amount: 1_000, confirm: "SWEEP" });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain(message);
    expect(res.body.error).toMatch(/Money Management write scope/);
    expect(res.body.stripe).toEqual({ type: "StripePermissionError", code: "more_permissions_required" });

    const failed = await prisma.treasurySweep.findFirst({ where: { status: "failed" }, orderBy: { createdAt: "desc" } });
    expect(failed).not.toBeNull();
    expect(failed!.amount).toBe(1_000);
    expect(failed!.error).toBe(message);
    expect(failed!.stripeTransferId).toBeNull();
    const event = await waitForEvent({ source: "treasury", level: "warn", message: { contains: "refused by Stripe" } });
    expect(event).not.toBeNull();

    // An unknown-shape rejection is also a 502 with the message, never a second guess.
    transferResponse = () => Promise.reject(Object.assign(new Error("Received unknown parameter: to[payout_method]"), { statusCode: 400, type: "StripeInvalidRequestError", code: "parameter_unknown" }));
    const bad = await request(app).post("/financials/sweep").send({ amount: 1_000, confirm: "SWEEP" });
    expect(bad.status).toBe(502);
    expect(bad.body.error).toContain("Received unknown parameter: to[payout_method]");
    expect(mocks.rawRequest.mock.calls.filter(([m, p]) => m === "POST" && p === "/v2/money_management/outbound_transfers").length).toBe(3);
  });
});

describe("Stripe fees on the P&L", () => {
  it("fee rows land in the month as their own column and category; Collected stays gross; the CSV carries them", async () => {
    resetStripeFeeCache();
    feesThrow = null;
    const before = await request(app).get(`/financials/summary?year=${year}`);
    expect(before.status).toBe(200);
    await prisma.payment.create({ data: { amount: 1_000, method: "cash", kind: "final", status: "paid", note: "TS-test", paidAt: base } });
    const res = await request(app).get(`/financials/summary?year=${year}`);
    expect(res.status).toBe(200);
    expect(res.body.feesAvailable).toBe(true);
    expect(res.body.feesReason).toBeNull();
    const m = res.body.months[month];
    expect(m.stripeFees).toBe(r2(32 + 17.5 + 8));
    expect(res.body.totals.stripeFees).toBe(r2(32 + 17.5 + 8));
    // Fees are inside Expenses too — the same month's expenses moved by exactly the fees relative to a fee-less ledger
    // is pinned in the feesAvailable:false case below; here, the category line is the fee sum.
    const cat = res.body.expensesByCategory.find((c: { category: string }) => c.category === "stripe_fees");
    expect(cat.monthly[month]).toBe(r2(32 + 17.5 + 8));
    expect(cat.total).toBe(r2(32 + 17.5 + 8));
    // Collected is the gross $1,000 the customer paid — the fee never nets it down.
    expect(r2(m.collected - before.body.months[month].collected)).toBe(1_000);

    const csv = await request(app).get(`/financials/export?year=${year}`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(`expense,stripe_fees,"Stripe fee — ch_test_1 (net 968.00)",32.00`);
    expect(csv.text).toContain(`Stripe fee — py_test_3`);
    expect(csv.text).toContain(`,income,collected,"Payment (cash) — TS-test",1000.00`);
  });

  it("when the key cannot read balance transactions the column is empty and the summary says why", async () => {
    resetStripeFeeCache();
    const withFees = await request(app).get(`/financials/summary?year=${year}`);
    resetStripeFeeCache();
    feesThrow = permissionError("This API key does not have the required permissions for this endpoint (balance_transactions read).");
    const res = await request(app).get(`/financials/summary?year=${year}`);
    expect(res.status).toBe(200);
    expect(res.body.feesAvailable).toBe(false);
    expect(res.body.feesReason).toMatch(/balance transactions/i);
    expect(res.body.feesReason).toContain("balance_transactions read");
    expect(res.body.months[month].stripeFees).toBe(0);
    expect(res.body.expensesByCategory.find((c: { category: string }) => c.category === "stripe_fees")).toBeUndefined();
    // Expenses drop by exactly the fees — proof they were inside Expenses when readable.
    expect(r2(withFees.body.months[month].expenses - res.body.months[month].expenses)).toBe(r2(32 + 17.5 + 8));
    expect(r2(withFees.body.months[month].net - res.body.months[month].net)).toBe(r2(-(32 + 17.5 + 8)));
    feesThrow = null;
    resetStripeFeeCache();
  });
});
