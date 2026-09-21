/**
 * A company bill paid on the Stripe card is counted ONCE (2026-09-21, PUNCHLIST M6).
 *
 * Kyle: "the actual charge is the source of truth." Until today a recurring bill paid on the
 * card reached Expenses twice — the CardSpend row AND the scheduled bill-month. Now a card
 * charge that matches a bill (amount + a word of its name + an open month nearby — the bank
 * importer's own match, services/companyBills.ts) CONFIRMS that bill-month and REPLACES it: the
 * charge is the expense at its own amount, the scheduled figure leaves the P&L. Nothing is
 * written; ignoring the charge puts the scheduled amount back.
 *
 * Sentinel year 2034 — 2031 testAccountFinancials, 2032 payroll/poIsTheMoney, 2033 bankImport.
 * Every figure is a delta against the same year read before the bill existed.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
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

import { app } from "../src/app";
import { defaultTruckId } from "../src/services/purchaseOrders";
import { confirmBillMonthsByCard } from "../src/services/companyBills";

const YEAR = 2034;
const AUG = 7;
const SEP = 8;
const OCT = 9;
const r2 = (n: number) => Math.round(n * 100) / 100;
const CARD = "card_bpc";
const newId = () => crypto.randomUUID().replaceAll("-", "");

type Summary = {
  months: { month: number; expenses: number; bank: number }[];
  expensesByCategory: { category: string; monthly: number[] }[];
};
async function summary(): Promise<Summary> {
  const res = await request(app).get(`/financials/summary?year=${YEAR}`);
  expect(res.status).toBe(200);
  return res.body as Summary;
}
const category = (s: Summary, name: string, month: number) => s.expensesByCategory.find((c) => c.category === name)?.monthly[month] ?? 0;

type BillRow = { billId: string; month: string; status: string; line: { id: string } | null; card: { spendId: string; amount: number; merchant: string } | null };
async function billMonth(billId: string, month: string): Promise<BillRow> {
  const res = await request(app).get(`/bank/confirmations?year=${YEAR}`);
  expect(res.status).toBe(200);
  const row = (res.body.bills as BillRow[]).find((b) => b.billId === billId && b.month === month);
  expect(row, `a confirmation row for ${month}`).toBeTruthy();
  return row!;
}

let truckId: string;
let base: Summary;
let billId: string;
let bankAccountId: string | null = null;

async function charge(merchant: string, amount: number, at: Date) {
  return prisma.cardSpend.create({
    data: { stripeTransactionId: `bpc_${newId()}`, stripeCardId: CARD, truckId, kind: "other", amount, merchantName: merchant, occurredAt: at },
  });
}

beforeAll(async () => {
  truckId = await defaultTruckId();
  base = await summary();
  billId = (await prisma.companyBill.create({
    data: { name: "BPC Cloud Software", category: "software", amount: 49, cadence: "monthly", startDate: new Date(YEAR, 0, 1), endDate: new Date(YEAR, 11, 31) },
  })).id;
});

afterAll(async () => {
  await prisma.cardSpend.deleteMany({ where: { stripeCardId: CARD } });
  if (bankAccountId) await prisma.bankAccount.deleteMany({ where: { id: bankAccountId } }); // statements and lines cascade
  await prisma.companyBill.deleteMany({ where: { id: billId } });
});

describe("the matcher, pure", () => {
  const bill = { id: "b1", name: "BPC Cloud Software", amount: 49, cadence: "monthly", billDate: null, startDate: new Date(YEAR, 0, 1), endDate: null };
  const at = (m: number, d = 10) => new Date(YEAR, m, d);

  it("amount + a word of the name + the charge's own month", () => {
    const out = confirmBillMonthsByCard([bill], [{ id: "c1", merchantName: "BPC CLOUD SOFTWARE", amount: 49, occurredAt: at(SEP) }]);
    expect([...out.keys()]).toEqual([`b1:${YEAR}-09`]);
    expect(out.get(`b1:${YEAR}-09`)?.spendId).toBe("c1");
  });

  it("the amount alone is not a match, and neither is the name alone", () => {
    expect(confirmBillMonthsByCard([bill], [{ id: "c1", merchantName: "HOME DEPOT", amount: 49, occurredAt: at(SEP) }]).size).toBe(0);
    expect(confirmBillMonthsByCard([bill], [{ id: "c1", merchantName: "BPC CLOUD SOFTWARE", amount: 49.01, occurredAt: at(SEP) }]).size).toBe(0);
  });

  it("one charge confirms at most one month; a second identical charge takes the month before, then the one after", () => {
    const out = confirmBillMonthsByCard([bill], [
      { id: "c1", merchantName: "BPC CLOUD SOFTWARE", amount: 49, occurredAt: at(SEP, 5) },
      { id: "c2", merchantName: "BPC CLOUD SOFTWARE", amount: 49, occurredAt: at(SEP, 20) },
      { id: "c3", merchantName: "BPC CLOUD SOFTWARE", amount: 49, occurredAt: at(SEP, 25) },
      { id: "c4", merchantName: "BPC CLOUD SOFTWARE", amount: 49, occurredAt: at(SEP, 28) },
    ]);
    expect(out.get(`b1:${YEAR}-09`)?.spendId).toBe("c1");
    expect(out.get(`b1:${YEAR}-08`)?.spendId).toBe("c2");
    expect(out.get(`b1:${YEAR}-10`)?.spendId).toBe("c3");
    expect(out.size).toBe(3); // c4 finds nothing open nearby and confirms nothing
  });

  it("a refund pays nothing, and two bills of the same amount at the same merchant is a question, not a match", () => {
    expect(confirmBillMonthsByCard([bill], [{ id: "c1", merchantName: "BPC CLOUD SOFTWARE", amount: -49, occurredAt: at(SEP) }]).size).toBe(0);
    const twin = { ...bill, id: "b2", name: "BPC Cloud Backup" };
    expect(confirmBillMonthsByCard([bill, twin], [{ id: "c1", merchantName: "BPC CLOUD", amount: 49, occurredAt: at(SEP) }]).size).toBe(0);
  });

  it("is deterministic whichever order the charges arrive in", () => {
    const rows = [
      { id: "c2", merchantName: "BPC CLOUD SOFTWARE", amount: 49, occurredAt: at(SEP, 20) },
      { id: "c1", merchantName: "BPC CLOUD SOFTWARE", amount: 49, occurredAt: at(SEP, 5) },
    ];
    const a = confirmBillMonthsByCard([bill], rows);
    const b = confirmBillMonthsByCard([bill], [...rows].reverse());
    expect([...a.entries()].map(([k, v]) => [k, v.spendId])).toEqual([...b.entries()].map(([k, v]) => [k, v.spendId]));
    expect(a.get(`b1:${YEAR}-09`)?.spendId).toBe("c1");
  });
});

describe("the P&L: a bill paid on the card is the card charge, once", () => {
  let first: { id: string };
  let second: { id: string };

  it("a scheduled bill is money until something pays it", async () => {
    const s = await summary();
    expect(r2(s.months[SEP].expenses - base.months[SEP].expenses)).toBe(49);
    expect(category(s, "bill:software", SEP)).toBe(49);
    expect((await billMonth(billId, `${YEAR}-09`)).status).toBe("not_imported");
  });

  it("a card charge that pays the bill IS the money — Expenses moves by the charge, not the charge plus the bill", async () => {
    first = await charge("BPC CLOUD SOFTWARE", 49, new Date(YEAR, SEP, 10));
    const s = await summary();
    expect(r2(s.months[SEP].expenses - base.months[SEP].expenses)).toBe(49);
    expect(category(s, "overhead", SEP) - category(base, "overhead", SEP)).toBe(49); // the charge, as card spend
    expect(category(s, "bill:software", SEP)).toBe(0); // the scheduled amount is gone
    expect(category(s, "bill:software", AUG)).toBe(49); // August is still a bill nothing paid
    // The Bills card says why: September is confirmed by the card, not a statement.
    const row = await billMonth(billId, `${YEAR}-09`);
    expect(row.status).toBe("confirmed");
    expect(row.line).toBeNull();
    expect(row.card).toMatchObject({ spendId: first.id, amount: 49, merchant: "BPC CLOUD SOFTWARE" });
    expect((await billMonth(billId, `${YEAR}-08`)).card).toBeNull();
  });

  it("the CSV export carries the charge and not the bill-month it paid", async () => {
    const res = await request(app).get(`/financials/export?year=${YEAR}`);
    expect(res.status).toBe(200);
    const rows = (res.text as string).split("\n").filter((l) => l.includes("BPC"));
    expect(rows.some((l) => l.includes("Card — BPC CLOUD SOFTWARE"))).toBe(true);
    expect(rows.filter((l) => l.startsWith(`${YEAR}-09-01`) && l.includes("Bill — BPC Cloud Software"))).toHaveLength(0);
    expect(rows.filter((l) => l.startsWith(`${YEAR}-08-01`) && l.includes("Bill — BPC Cloud Software"))).toHaveLength(1);
  });

  it("a second identical charge takes the next open month — never the same month twice, never two months for one charge", async () => {
    second = await charge("BPC CLOUD SOFTWARE", 49, new Date(YEAR, SEP, 20));
    const s = await summary();
    expect(r2(s.months[SEP].expenses - base.months[SEP].expenses)).toBe(98); // two charges
    expect(category(s, "bill:software", SEP)).toBe(0);
    expect(category(s, "bill:software", AUG)).toBe(0); // the second charge paid August
    expect(category(s, "bill:software", OCT)).toBe(49);
    expect((await billMonth(billId, `${YEAR}-08`)).card?.spendId).toBe(second.id);
    expect((await billMonth(billId, `${YEAR}-09`)).card?.spendId).toBe(first.id);
  });

  it("an IGNORED charge is not money and confirms nothing — the scheduled amount comes back on its own", async () => {
    await prisma.cardSpend.update({ where: { id: second.id }, data: { status: "ignored", ignoredReason: "duplicate" } });
    const s = await summary();
    expect(r2(s.months[SEP].expenses - base.months[SEP].expenses)).toBe(49);
    expect(category(s, "bill:software", AUG)).toBe(49);
    expect((await billMonth(billId, `${YEAR}-08`)).card).toBeNull();
  });

  it("a bank line that ALSO confirms the month adds nothing, and the month still drops exactly once", async () => {
    const account = await prisma.bankAccount.create({ data: { name: "BPC Checking", last4: "9034", kind: "checking", purpose: "operating" } });
    bankAccountId = account.id;
    const statement = await prisma.bankStatement.create({
      data: { accountId: account.id, fileName: "bpc-sep.csv", fileHash: `bpc-${newId()}`, format: "chase_csv", periodStart: new Date(Date.UTC(YEAR, SEP, 1, 12)), periodEnd: new Date(Date.UTC(YEAR, SEP, 30, 12)), lineCount: 1 },
    });
    await prisma.bankLine.create({
      data: {
        accountId: account.id, statementId: statement.id, lineKey: `bpc-${newId()}`, postedAt: new Date(Date.UTC(YEAR, SEP, 12, 12)), amount: -49,
        description: "BPC CLOUD SOFTWARE AUTOPAY", payeeKey: "BPC CLOUD SOFTWARE", classification: "already_counted", matchedKind: "company_bill",
        matchedId: billId, matchedMonth: `${YEAR}-09`, reason: "test", classifiedBy: "rule", classifiedAt: new Date(),
      },
    });
    const s = await summary();
    expect(r2(s.months[SEP].expenses - base.months[SEP].expenses)).toBe(49); // the card charge, once
    expect(s.months[SEP].bank).toBe(0); // an already-counted line adds nothing
    expect(category(s, "bill:software", SEP)).toBe(0);
    const row = await billMonth(billId, `${YEAR}-09`);
    expect(row.status).toBe("confirmed");
    expect(row.line).not.toBeNull();
    expect(row.card?.spendId).toBe(first.id);
  });

  it("a charge of the right amount at another merchant confirms nothing — the bill stays money and the charge is its own expense", async () => {
    await charge("HOME DEPOT", 49, new Date(YEAR, OCT, 3));
    const s = await summary();
    expect(r2(s.months[OCT].expenses - base.months[OCT].expenses)).toBe(98); // the bill AND the charge
    expect(category(s, "bill:software", OCT)).toBe(49);
    expect((await billMonth(billId, `${YEAR}-10`)).card).toBeNull();
  });
});
