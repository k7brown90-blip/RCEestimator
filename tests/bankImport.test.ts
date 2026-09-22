/**
 * Bank statement import (Kyle, 2026-09-20): "I can manually upload the bank statements each
 * month from each account." The worked example the plan asked for, pinned against the real
 * database and the real P&L endpoint:
 *
 *   One September statement for the checking account carrying
 *     - a Stripe line (the card's balance being funded)         → TRANSFER, adds nothing
 *     - a Stripe line the other way (the sweep / a payout)      → TRANSFER, adds nothing
 *     - a Zelle to a technician                                 → ALREADY COUNTED (payroll)
 *     - a check equal to a P.O.'s typed not-on-card amount      → ALREADY COUNTED (the P.O.)
 *     - an autopay line equal to a company bill                 → ALREADY COUNTED (the bill, confirmed)
 *     - a transfer into the tax savings account                 → TRANSFER (a set-aside)
 *     - a deposit equal to a recorded customer check            → ALREADY COUNTED (the payment)
 *     - a genuine new ACH expense (an insurance premium)        → the queue; Kyle classifies it
 *   and Expenses moves by ONLY the last one, once Kyle rules on it.
 *
 *   Then: the same file again changes nothing; an overlapping export imports only its one new
 *   line; a bill the statement covers but never shows is visible as unconfirmed; the tax
 *   account's own outflow is Kyle's ruling, not the importer's; the cash panel reads each
 *   balance AS OF its statement; a wrong import is undone by deleting the statement, and every
 *   confirmation its lines made goes with it.
 *
 * Sentinel year 2033 — testAccountFinancials uses 2031, payrollOnPnl and poIsTheMoney 2032 —
 * and every P&L figure is a delta against the same year read before the statement existed.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
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
import { isPublicRoute } from "../src/middleware/publicRoutes";
import { lineKeyOf, parseStatement, payeeKey } from "../src/services/bankStatements";

const YEAR = 2033;
const SEP = 8;
const OCT = 9;
const r2 = (n: number) => Math.round(n * 100) / 100;
const HOUR = 60 * 60 * 1000;

type MonthRow = { month: number; invoiced: number; collected: number; payroll: number; bank: number; expenses: number; net: number };
type Summary = {
  months: MonthRow[];
  totals: { expenses: number; bank: number };
  expensesByCategory: { category: string; monthly: number[]; total: number }[];
  bank: { accounts: number; unclassified: number; unclassifiedOut: number; lastImportAt: string | null };
};
async function summary(): Promise<Summary> {
  const res = await request(app).get(`/financials/summary?year=${YEAR}`);
  expect(res.status).toBe(200);
  return res.body as Summary;
}
const category = (s: Summary, name: string, month: number) => s.expensesByCategory.find((c) => c.category === name)?.monthly[month] ?? 0;

type Line = {
  id: string; description: string; amount: number; classification: string; category: string | null; transferKind: string | null;
  counterpartyAccountId: string | null; matchedKind: string | null; matchedId: string | null; matchedMonth: string | null;
  reason: string | null; hint: string | null; classifiedBy: string | null; matchedLabel: string | null;
  candidates: { bills: unknown[]; purchaseOrders: unknown[]; payments: unknown[] } | null;
};
async function lines(query = `year=${YEAR}`): Promise<Line[]> {
  const res = await request(app).get(`/bank/lines?${query}`);
  expect(res.status).toBe(200);
  return res.body as Line[];
}
const byDesc = (rows: Line[], needle: string) => {
  const hit = rows.find((l) => l.description.toUpperCase().includes(needle.toUpperCase()));
  expect(hit, `a line containing "${needle}"`).toBeTruthy();
  return hit!;
};

async function upload(accountId: string, csv: string, fileName: string) {
  return request(app)
    .post(`/bank/accounts/${accountId}/statements?fileName=${encodeURIComponent(fileName)}`)
    .set("Content-Type", "application/octet-stream")
    .send(Buffer.from(csv, "utf8"));
}

const HEADER = "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #";
const STRIPE_OUT = 'DEBIT,09/02/2033,"STRIPE            DES:TRANSFER   ID:ST-Q1W2E3 INDN:RED CEDAR ELECTRIC  CO ID:1800948598 CCD",-1500.00,ACH_DEBIT,8500.00,';
const CHECK = 'CHECK,09/04/2033,"CHECK 1042",-406.74,CHECK_PAID,8093.26,1042';
const ZELLE = 'DEBIT,09/05/2033,"Zelle payment to Bank Ledger Tech 21937465",-600.00,QUICKPAY_DEBIT,7493.26,';
const VERIZON = 'DEBIT,09/06/2033,"ORIG CO NAME:VERIZON WIRELESS       ORIG ID:9783397101 DESC DATE:090533 CO ENTRY DESCR:PAYMENTS   SEC:PPD    TRACE#:021000023456789 EED:330906   IND ID:123456789012345   IND NAME:RED CEDAR ELECTRIC TRN: 2493456789TC",-85.00,ACH_DEBIT,7408.26,';
const TO_TAX = 'DEBIT,09/07/2033,"Online Transfer to SAV ...4444 transaction#: 2201122 09/07",-1000.00,ACCT_XFER,6408.26,';
const ACME = 'DEBIT,09/08/2033,"ORIG CO NAME:ACME INSURANCE         ORIG ID:1234567890 DESC DATE:090833 CO ENTRY DESCR:INS PREM    SEC:CCD    TRACE#:021000029876543 EED:330908   IND ID:RCE   IND NAME:RED CEDAR ELECTRIC TRN: 2519876543TC",-250.00,ACH_DEBIT,6158.26,';
const DEPOSIT = 'CREDIT,09/09/2033,"REMOTE ONLINE DEPOSIT #  1",1200.00,DEPOSIT,7358.26,';
const STRIPE_IN = 'CREDIT,09/30/2033,"STRIPE            DES:TRANSFER   ID:ST-Z9Y8X7 INDN:RED CEDAR ELECTRIC  CO ID:1800948598 CCD",2200.00,ACH_CREDIT,9558.26,';
const FEE = 'DEBIT,09/15/2033,"MONTHLY SERVICE FEE",-15.00,FEE_TRANSACTION,7343.26,';
const OPENING = 'CREDIT,09/01/2033,"Online Transfer from SAV ...2222 transaction#: 2200001 09/01",500.00,ACCT_XFER,10000.00,';

const SEPTEMBER = [HEADER, OPENING, STRIPE_OUT, CHECK, ZELLE, VERIZON, TO_TAX, ACME, DEPOSIT, STRIPE_IN].join("\n") + "\n";
const SEPTEMBER_WIDER = [HEADER, OPENING, STRIPE_OUT, CHECK, ZELLE, VERIZON, TO_TAX, ACME, DEPOSIT, FEE, STRIPE_IN].join("\n") + "\n";
const OCTOBER = [
  HEADER,
  'DEBIT,10/06/2033,"ORIG CO NAME:VERIZON WIRELESS       ORIG ID:9783397101 DESC DATE:100533 CO ENTRY DESCR:PAYMENTS   SEC:PPD    TRACE#:021000023456790 EED:331006   IND ID:123456789012345   IND NAME:RED CEDAR ELECTRIC TRN: 2793456789TC",-85.00,ACH_DEBIT,9473.26,',
  'DEBIT,10/08/2033,"ORIG CO NAME:ACME INSURANCE         ORIG ID:1234567890 DESC DATE:100833 CO ENTRY DESCR:INS PREM    SEC:CCD    TRACE#:021000029876544 EED:331008   IND ID:RCE   IND NAME:RED CEDAR ELECTRIC TRN: 2819876543TC",-250.00,ACH_DEBIT,9223.26,',
  'DEBIT,10/31/2033,"Online Transfer to SAV ...3333 transaction#: 2301122 10/31",-700.00,ACCT_XFER,8523.26,',
].join("\n") + "\n";
const TAX_ACCOUNT = [
  HEADER,
  'CREDIT,09/07/2033,"Online Transfer from CHK ...1111 transaction#: 2201122 09/07",1000.00,ACCT_XFER,5000.00,',
  'DEBIT,09/15/2033,"IRS USATAXPYMT 220123456789012",-800.00,ACH_DEBIT,4200.00,',
].join("\n") + "\n";

let checkingId: string;
let taxId: string;
let capitalId: string;
let overheadId: string;
let techId: string;
let customerId: string;
let testCustomerId: string;
let poId: string;
let verizonId: string;
let softwareId: string;
let paymentId: string;
let before: Summary;

beforeAll(async () => {
  // The registry: Chase has four (Kyle, 2026-09-20).
  const mk = (name: string, kind: string, purpose: string, last4: string) =>
    request(app).post("/bank/accounts").send({ name, kind, purpose, last4 }).then((r) => { expect(r.status).toBe(201); return r.body.id as string; });
  checkingId = await mk("BNK Checking", "checking", "operating", "1111");
  capitalId = await mk("BNK Capital", "savings", "capital", "2222");
  overheadId = await mk("BNK Overhead savings", "savings", "overhead_savings", "3333");
  taxId = await mk("BNK Tax", "savings", "tax", "4444");

  // Payroll on the P&L from the hours ledger: one closed 8h shift in September.
  techId = (await prisma.technician.create({ data: { name: "Bank Ledger Tech", hourlyRate: 30, accessToken: `bnk-token-${Date.now()}` } })).id;
  const shiftStart = new Date(YEAR, SEP, 5, 8);
  await prisma.shiftEntry.create({
    data: { technicianId: techId, startedAt: shiftStart, endedAt: new Date(shiftStart.getTime() + 8 * HOUR), minutes: 480, rateApplied: 30, source: "office" },
  });

  // A P.O. paid by check, typed on the P.O. as not-on-card (Kyle's 9/3 $406.74 case).
  poId = (await prisma.purchaseOrder.create({
    data: {
      number: `PO-${YEAR}-BNK1`, purpose: "truck_stock", destinationType: "warehouse", supplier: "BNK Supply", status: "purchased", openedBy: "owner",
      offCardAmount: 406.74, offCardMethod: "check", offCardNote: "check 1042", offCardAt: new Date(YEAR, SEP, 3, 12),
    },
  })).id;

  // Two standing bills: one autopays from checking, one never shows up on the statement.
  verizonId = (await prisma.companyBill.create({ data: { name: "Verizon Wireless", category: "overhead", amount: 85, cadence: "monthly", startDate: new Date(YEAR, 0, 1) } })).id;
  softwareId = (await prisma.companyBill.create({ data: { name: "BNK Software Co", category: "software", amount: 49, cadence: "monthly", startDate: new Date(YEAR, 0, 1) } })).id;

  // A customer check Kyle recorded by hand — and the same amount on the test account, which must never be a candidate.
  customerId = (await prisma.customer.create({ data: { name: "Bank Import Co", phone: "+16155501234", isTestAccount: false } })).id;
  testCustomerId = (await prisma.customer.create({ data: { name: "Bank Import Practice", phone: "+16155501235", isTestAccount: true } })).id;
  paymentId = (await prisma.payment.create({ data: { customerId, amount: 1200, method: "check", kind: "final", status: "paid", checkNumber: "5501", paidAt: new Date(YEAR, SEP, 8, 12) } })).id;
  await prisma.payment.create({ data: { customerId: testCustomerId, amount: 1200, method: "check", kind: "final", status: "paid", paidAt: new Date(YEAR, SEP, 8, 12) } });

  before = await summary();
});

afterAll(async () => {
  await prisma.bankAccount.deleteMany({ where: { name: { startsWith: "BNK " } } });
  await prisma.payment.deleteMany({ where: { customerId: { in: [customerId, testCustomerId] } } });
  await prisma.customer.deleteMany({ where: { id: { in: [customerId, testCustomerId] } } });
  await prisma.companyBill.deleteMany({ where: { id: { in: [verizonId, softwareId] } } });
  await prisma.purchaseOrder.deleteMany({ where: { id: poId } });
  await prisma.shiftEntry.deleteMany({ where: { technicianId: techId } });
  await prisma.technician.deleteMany({ where: { id: techId } });
});

describe("the door", () => {
  it("every /bank route sits behind the operator session — none is public", () => {
    for (const path of ["/bank/accounts", "/bank/statements", "/bank/lines", "/bank/confirmations"]) {
      expect(isPublicRoute("GET", path), path).toBe(false);
      expect(isPublicRoute("POST", path), path).toBe(false);
    }
  });
});

describe("the parsers and the identity", () => {
  it("reads Chase's CSV: signed amounts, the running balance after the last line, the period", () => {
    const parsed = parseStatement(Buffer.from(SEPTEMBER));
    expect(parsed.format).toBe("chase_csv");
    expect(parsed.lines).toHaveLength(9);
    expect(parsed.lines[2]).toMatchObject({ amount: -406.74, bankRef: "1042", bankType: "CHECK_PAID", runningBalance: 8093.26 });
    expect(parsed.periodStart!.toISOString().slice(0, 10)).toBe("2033-09-01");
    expect(parsed.periodEnd!.toISOString().slice(0, 10)).toBe("2033-09-30");
    expect(parsed.closingBalance).toBe(9558.26);
    expect(parsed.balanceAsOf!.toISOString().slice(0, 10)).toBe("2033-09-30");
  });

  it("reads OFX: FITIDs become the line identity, the ledger balance the AS OF figure, ACCTID the last four", () => {
    const ofx = [
      "OFXHEADER:100", "DATA:OFXSGML", "", "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD",
      "<BANKACCTFROM><BANKID>021000021<ACCTID>000000001111<ACCTTYPE>CHECKING</BANKACCTFROM>",
      "<BANKTRANLIST><DTSTART>20330901<DTEND>20330930",
      "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20330906120000.000[-5:EST]<TRNAMT>-85.00<FITID>2033090600123<NAME>VERIZON WIRELESS<MEMO>PAYMENTS</STMTTRN>",
      "<STMTTRN><TRNTYPE>XFER<DTPOSTED>20330907<TRNAMT>-1000.00<FITID>2033090700456<NAME>Online Transfer to SAV ...4444</STMTTRN>",
      "</BANKTRANLIST><LEDGERBAL><BALAMT>9558.26<DTASOF>20330930</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
    ].join("\n");
    const parsed = parseStatement(Buffer.from(ofx));
    expect(parsed.format).toBe("ofx");
    expect(parsed.accountLast4).toBe("1111");
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0]).toMatchObject({ amount: -85, bankRef: "fitid:2033090600123", bankType: "DEBIT", description: "VERIZON WIRELESS PAYMENTS" });
    expect(parsed.closingBalance).toBe(9558.26);
    expect(parsed.balanceAsOf!.toISOString().slice(0, 10)).toBe("2033-09-30");
    // Same FITID, same key, whatever the file's other columns say; a CSV line is keyed on its tuple + occurrence.
    expect(lineKeyOf(parsed.lines[0], 0)).toBe(lineKeyOf({ ...parsed.lines[0], description: "different" }, 3));
    const csv = parseStatement(Buffer.from(SEPTEMBER)).lines[2];
    expect(lineKeyOf(csv, 0)).not.toBe(lineKeyOf(csv, 1));
    expect(lineKeyOf(csv, 0)).toBe(lineKeyOf({ ...csv, description: "  check   1042 " }, 0));
  });

  it("leaves a pending row out and takes the balance from the newest posted line (Kyle's checking export, 2026-09-21)", () => {
    // The real shape: Chase gives a not-yet-posted row a BLANK Balance (" "), and each data row carries a trailing comma.
    const pending = [
      "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #",
      'DEBIT,09/21/2033,"POS DEBIT                QUEENSBORO INDUSTRIES     910-2511251  NC",-125.83,MISC_DEBIT, ,,',
      'DEBIT,09/16/2033,"ETC Gymnastics Smyrna TN                     09/16",-47.19,DEBIT_CARD,389.41,,',
      'DEBIT,09/14/2033,"SHELL OIL 57527465108 NASHVILLE TN           09/11",-76.68,DEBIT_CARD,436.60,,',
      'CREDIT,09/10/2033,"ORIG CO NAME:American Classic       ORIG ID:1204895317",467.83,ACH_CREDIT,525.55,,',
    ].join("\n");
    const parsed = parseStatement(Buffer.from(pending));
    expect(parsed.pendingSkipped).toBe(1);
    expect(parsed.lines).toHaveLength(3);
    expect(parsed.lines.some((l) => l.description.includes("QUEENSBORO"))).toBe(false);
    expect(parsed.closingBalance).toBe(389.41);
    expect(parsed.balanceAsOf!.toISOString().slice(0, 10)).toBe("2033-09-16");
    expect(parsed.periodEnd!.toISOString().slice(0, 10)).toBe("2033-09-16");
    // A file with no balances at all keeps every row — only a blank among balances means pending.
    const noBalances = parseStatement(Buffer.from("Date,Description,Amount\n09/02/2033,COFFEE,-4.50\n09/03/2033,TOOLS,-20.00\n"));
    expect(noBalances.pendingSkipped).toBe(0);
    expect(noBalances.lines).toHaveLength(2);
    expect(noBalances.closingBalance).toBeNull();
  });

  it("refuses a file with no statement columns", async () => {
    const res = await upload(checkingId, "hello,world\n1,2\n", "junk.csv");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no date, description and amount columns/);
  });

  it("normalises the payee so a classification carries to next month's line", () => {
    expect(payeeKey("ORIG CO NAME:ACME INSURANCE         ORIG ID:1234567890 DESC DATE:090833")).toBe("ACME INSURANCE");
    expect(payeeKey("Zelle payment to Bank Ledger Tech 21937465")).toBe("ZELLE PAYMENT TO BANK LEDGER TECH");
    expect(payeeKey("Online Transfer to SAV ...4444 transaction#: 2201122 09/07")).toBe("ONLINE TRANSFER TO SAV");
    expect(payeeKey("HOME DEPOT #1234 NASHVILLE TN 09/12")).toBe("HOME DEPOT NASHVILLE TN");
  });
});

describe("the worked example — every line classified, Expenses moves by only the genuine new one", () => {
  it("imports the September statement and classifies eight of nine lines by rule; the insurance premium is the queue", async () => {
    const res = await upload(checkingId, SEPTEMBER, "Chase1111_Activity_Sep2033.CSV");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ duplicate: false, imported: 9, skipped: 0, autoClassified: 8, unclassified: 1, format: "chase_csv" });

    const rows = await lines();
    expect(rows).toHaveLength(9);

    // Trap 1 — Stripe, both directions, is our own money moving.
    expect(byDesc(rows, "ST-Q1W2E3")).toMatchObject({ classification: "transfer", transferKind: "stripe", classifiedBy: "rule" });
    expect(byDesc(rows, "ST-Z9Y8X7")).toMatchObject({ classification: "transfer", transferKind: "stripe" });
    // Trap 2 — payroll is on the P&L from the hours ledger.
    expect(byDesc(rows, "Zelle payment to Bank Ledger Tech")).toMatchObject({ classification: "already_counted", matchedKind: "payroll" });
    // Trap 3 — the check matches the amount typed on the P.O.; the P.O. stays the money.
    expect(byDesc(rows, "CHECK 1042")).toMatchObject({ classification: "already_counted", matchedKind: "po_off_card", matchedId: poId, matchedLabel: `PO-${YEAR}-BNK1 — BNK Supply ($406.74 typed)` });
    // Trap 4 — the autopay confirms the bill's scheduled month.
    expect(byDesc(rows, "VERIZON WIRELESS")).toMatchObject({ classification: "already_counted", matchedKind: "company_bill", matchedId: verizonId, matchedMonth: "2033-09" });
    // A set-aside into the tax account, and money back out of capital: transfers, with the other side named.
    expect(byDesc(rows, "to SAV ...4444")).toMatchObject({ classification: "transfer", transferKind: "set_aside", counterpartyAccountId: taxId });
    expect(byDesc(rows, "from SAV ...2222")).toMatchObject({ classification: "transfer", transferKind: "set_aside_return", counterpartyAccountId: capitalId });
    // The deposit matches the one REAL recorded check — the test account's identical payment was never a candidate.
    expect(byDesc(rows, "REMOTE ONLINE DEPOSIT")).toMatchObject({ classification: "already_counted", matchedKind: "payment", matchedId: paymentId });
    // The genuine new expense: nobody decided it, and the queue says so.
    const acme = byDesc(rows, "ACME INSURANCE");
    expect(acme).toMatchObject({ classification: "unclassified", classifiedBy: null, hint: null });
    expect(acme.candidates).toEqual({ bills: [], purchaseOrders: [], payments: [] });
    expect((await lines("classification=unclassified")).map((l) => l.id)).toEqual([acme.id]);
  });

  it("the P&L did not move: every rule-classified line adds nothing, and the unclassified line is not in Expenses yet", async () => {
    const now = await summary();
    expect(r2(now.months[SEP].expenses - before.months[SEP].expenses)).toBe(0);
    expect(r2(now.months[SEP].net - before.months[SEP].net)).toBe(0);
    expect(now.months[SEP].bank).toBe(0);
    // Collected did not double either: the deposit is the check already recorded.
    expect(r2(now.months[SEP].collected - before.months[SEP].collected)).toBe(0);
    // And the P&L says what is waiting.
    expect(now.bank).toMatchObject({ accounts: 4, unclassified: 1, unclassifiedOut: 250 });
    expect(now.bank.lastImportAt).toBeTruthy();
  });

  it("Kyle classifies the premium as an insurance expense — Expenses moves by exactly $250, in its own column, category and the CSV", async () => {
    const acme = byDesc(await lines(), "ACME INSURANCE");
    const res = await request(app).patch(`/bank/lines/${acme.id}`).send({ classification: "expense", category: "insurance" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ classification: "expense", category: "insurance", classifiedBy: "owner" });

    const now = await summary();
    expect(r2(now.months[SEP].expenses - before.months[SEP].expenses)).toBe(250);
    expect(r2(now.months[SEP].net - before.months[SEP].net)).toBe(-250);
    expect(now.months[SEP].bank).toBe(250);
    expect(r2(now.totals.bank)).toBe(250);
    expect(r2(category(now, "bank:insurance", SEP) - category(before, "bank:insurance", SEP))).toBe(250);
    expect(now.bank.unclassified).toBe(0);

    const csv = await request(app).get(`/financials/export?year=${YEAR}`);
    expect(csv.status).toBe(200);
    const bankLines = (csv.text as string).split("\n").filter((l) => l.includes(",expense,bank:"));
    expect(bankLines).toHaveLength(1);
    expect(bankLines[0]).toMatch(/^2033-09-08,expense,bank:insurance,"Bank — ORIG CO NAME:ACME INSURANCE.*\(BNK Checking\)",250\.00$/);
  });

  it("an expense needs a category, an ignore needs a reason, and a reclassification moves the money out again", async () => {
    const acme = byDesc(await lines(), "ACME INSURANCE");
    expect((await request(app).patch(`/bank/lines/${acme.id}`).send({ classification: "expense" })).status).toBe(400);
    expect((await request(app).patch(`/bank/lines/${acme.id}`).send({ classification: "ignored" })).status).toBe(400);

    const ignored = await request(app).patch(`/bank/lines/${acme.id}`).send({ classification: "ignored", note: "personal policy paid from the wrong account" });
    expect(ignored.status).toBe(200);
    expect(r2((await summary()).months[SEP].expenses - before.months[SEP].expenses)).toBe(0);

    // Back to unclassified by hand: the line is Kyle's now, and a rules re-run leaves it alone.
    expect((await request(app).patch(`/bank/lines/${acme.id}`).send({ classification: "unclassified" })).status).toBe(200);
    expect((await request(app).post("/bank/lines/auto")).status).toBe(200);
    expect(byDesc(await lines(), "ACME INSURANCE")).toMatchObject({ classification: "unclassified", classifiedBy: "owner" });

    // And back to the expense it is.
    expect((await request(app).patch(`/bank/lines/${acme.id}`).send({ classification: "expense", category: "insurance" })).status).toBe(200);
    expect(r2((await summary()).months[SEP].expenses - before.months[SEP].expenses)).toBe(250);
  });

  it("a bill-month and a P.O. can each be confirmed by one line only", async () => {
    const stripeOut = byDesc(await lines(), "ST-Q1W2E3");
    const dup = await request(app).patch(`/bank/lines/${stripeOut.id}`).send({ classification: "already_counted", matchedKind: "company_bill", matchedId: verizonId, matchedMonth: "2033-09" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/Verizon Wireless for 2033-09 is already confirmed by the 2033-09-06 line/);
    const dupPo = await request(app).patch(`/bank/lines/${stripeOut.id}`).send({ classification: "already_counted", matchedKind: "po_off_card", matchedId: poId });
    expect(dupPo.status).toBe(409);
    const wrongMonth = await request(app).patch(`/bank/lines/${stripeOut.id}`).send({ classification: "already_counted", matchedKind: "company_bill", matchedId: verizonId, matchedMonth: "2032-01" });
    expect(wrongMonth.status).toBe(400);
  });
});

describe("idempotency", () => {
  it("the same file again imports nothing and changes nothing", async () => {
    const was = await summary();
    const res = await upload(checkingId, SEPTEMBER, "Chase1111_Activity_Sep2033 (1).CSV");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ duplicate: true, imported: 0, skipped: 9 });
    expect(await lines()).toHaveLength(9);
    expect(await summary()).toEqual(was);
    expect(await prisma.bankStatement.count({ where: { accountId: checkingId } })).toBe(1);
  });

  it("an overlapping export imports only its one new line — a bank fee, which is an expense on its own", async () => {
    const res = await upload(checkingId, SEPTEMBER_WIDER, "Chase1111_Activity_Sep2033_full.CSV");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ duplicate: false, imported: 1, skipped: 9, autoClassified: 1, unclassified: 0 });
    expect(byDesc(await lines(), "MONTHLY SERVICE FEE")).toMatchObject({ classification: "expense", category: "bank_fees", classifiedBy: "rule" });
    const now = await summary();
    expect(r2(now.months[SEP].expenses - before.months[SEP].expenses)).toBe(265);
    expect(r2(category(now, "bank:bank_fees", SEP))).toBe(15);
  });
});

describe("confirmations — the bill you may have stopped paying", () => {
  it("lists the Verizon month as confirmed, the software bill the statement covers but never shows as UNCONFIRMED, and the P.O. as confirmed", async () => {
    const res = await request(app).get(`/bank/confirmations?year=${YEAR}`);
    expect(res.status).toBe(200);
    expect(res.body.coveredMonths).toEqual(["2033-09"]);
    const bills = res.body.bills as { billId: string; month: string; status: string; scheduled: number; line: { amount: number; variance: number } | null }[];
    const verizonSep = bills.find((b) => b.billId === verizonId && b.month === "2033-09")!;
    expect(verizonSep).toMatchObject({ status: "confirmed", scheduled: 85 });
    expect(verizonSep.line).toMatchObject({ amount: -85, variance: 0 });
    expect(bills.find((b) => b.billId === verizonId && b.month === "2033-08")).toMatchObject({ status: "not_imported", line: null });
    expect(bills.find((b) => b.billId === softwareId && b.month === "2033-09")).toMatchObject({ status: "unconfirmed", scheduled: 49, line: null });
    expect(bills.find((b) => b.billId === softwareId && b.month === "2033-10")).toMatchObject({ status: "not_imported" });
    expect(res.body.unconfirmedBillMonths).toBeGreaterThanOrEqual(1);
    const po = (res.body.purchaseOrders as { purchaseOrderId: string; status: string; typed: number; line: { amount: number } | null }[]).find((p) => p.purchaseOrderId === poId)!;
    expect(po).toMatchObject({ status: "confirmed", typed: 406.74 });
    expect(po.line).toMatchObject({ amount: -406.74 });
  });
});

describe("the tax account — Kyle's ruling, never the importer's", () => {
  it("the mirror of the set-aside is a transfer; the payment to the IRS is left for Kyle with the question written out", async () => {
    const res = await upload(taxId, TAX_ACCOUNT, "Chase4444_Activity_Sep2033.CSV");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ imported: 2, autoClassified: 1, unclassified: 1 });
    const rows = await lines(`year=${YEAR}&accountId=${taxId}`);
    expect(byDesc(rows, "from CHK ...1111")).toMatchObject({ classification: "transfer", transferKind: "set_aside", counterpartyAccountId: checkingId });
    const irs = byDesc(rows, "IRS USATAXPYMT");
    expect(irs.classification).toBe("unclassified");
    expect(irs.hint).toMatch(/A payment out of the tax account — your ruling/);
    // Nothing moved on the P&L.
    expect(r2((await summary()).months[SEP].expenses - before.months[SEP].expenses)).toBe(265);
  });

  it("the cash panel reads each balance AS OF its own statement, and says which accounts have none", async () => {
    const res = await request(app).get("/bank/accounts");
    expect(res.status).toBe(200);
    const accounts = res.body as { id: string; name: string; purpose: string; balance: { amount: number; asOf: string } | null; unclassified: number; statementCount: number }[];
    const checking = accounts.find((a) => a.id === checkingId)!;
    expect(checking.balance!.amount).toBe(9558.26);
    expect(checking.balance!.asOf.slice(0, 10)).toBe("2033-09-30");
    expect(checking.statementCount).toBe(2);
    const tax = accounts.find((a) => a.id === taxId)!;
    expect(tax.balance!.amount).toBe(4200);
    expect(tax.balance!.asOf.slice(0, 10)).toBe("2033-09-15");
    expect(tax.unclassified).toBe(1);
    expect(accounts.find((a) => a.id === capitalId)!.balance).toBeNull();
  });
});

describe("memory — a ruling carries to the same payee next month", () => {
  it("October's ACME line is an insurance expense by Kyle's earlier ruling; October's Verizon confirms October's bill; the overhead set-aside is a transfer", async () => {
    const res = await upload(checkingId, OCTOBER, "Chase1111_Activity_Oct2033.CSV");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ imported: 3, autoClassified: 3, unclassified: 0 });
    const rows = await lines(`year=${YEAR}&accountId=${checkingId}`);
    const acmeOct = rows.find((l) => l.description.includes("ACME INSURANCE") && l.description.includes("DESC DATE:100833"))!;
    expect(acmeOct).toMatchObject({ classification: "expense", category: "insurance", classifiedBy: "rule" });
    expect(acmeOct.reason).toMatch(/Same payee as a line you classified/);
    const verizonOct = rows.find((l) => l.description.includes("VERIZON") && l.description.includes("DESC DATE:100533"))!;
    expect(verizonOct).toMatchObject({ classification: "already_counted", matchedKind: "company_bill", matchedId: verizonId, matchedMonth: "2033-10" });
    expect(byDesc(rows, "to SAV ...3333")).toMatchObject({ classification: "transfer", transferKind: "set_aside", counterpartyAccountId: overheadId });

    const now = await summary();
    expect(r2(now.months[OCT].expenses - before.months[OCT].expenses)).toBe(250);
    expect(now.months[OCT].bank).toBe(250);
  });
});

describe("a wrong import is undone by deleting the statement", () => {
  it("deleting October removes its lines, its expense and its confirmation", async () => {
    const statements = (await request(app).get(`/bank/statements?accountId=${checkingId}`)).body as { id: string; fileName: string; lineCount: number; unclassified: number }[];
    const october = statements.find((s) => s.fileName.includes("Oct2033"))!;
    expect(october.lineCount).toBe(3);
    expect((await request(app).delete(`/bank/statements/${october.id}`)).status).toBe(204);
    expect((await lines(`year=${YEAR}&accountId=${checkingId}`)).filter((l) => l.description.includes("DESC DATE:100"))).toHaveLength(0);
    const now = await summary();
    expect(r2(now.months[OCT].expenses - before.months[OCT].expenses)).toBe(0);
    const confirmations = (await request(app).get(`/bank/confirmations?year=${YEAR}`)).body;
    expect(confirmations.bills.find((b: { billId: string; month: string }) => b.billId === verizonId && b.month === "2033-10")).toMatchObject({ status: "not_imported", line: null });
  });

  it("deleting the first September statement takes its lines' confirmations with it — the overlapping export that skipped those lines does not hold them", async () => {
    const statements = (await request(app).get(`/bank/statements?accountId=${checkingId}`)).body as { id: string; fileName: string; lineCount: number }[];
    const first = statements.find((s) => s.fileName === "Chase1111_Activity_Sep2033.CSV")!;
    expect((await request(app).delete(`/bank/statements/${first.id}`)).status).toBe(204);
    // Only the fee line (the wider export's own) survives on checking.
    const rows = await lines(`year=${YEAR}&accountId=${checkingId}`);
    expect(rows.map((l) => l.description)).toEqual(["MONTHLY SERVICE FEE"]);
    const now = await summary();
    expect(r2(now.months[SEP].expenses - before.months[SEP].expenses)).toBe(15);
    // September is still COVERED by the wider export, so the Verizon month reads unconfirmed now — honestly.
    const confirmations = (await request(app).get(`/bank/confirmations?year=${YEAR}`)).body;
    expect(confirmations.bills.find((b: { billId: string; month: string }) => b.billId === verizonId && b.month === "2033-09")).toMatchObject({ status: "unconfirmed", line: null });
    expect(confirmations.purchaseOrders.find((p: { purchaseOrderId: string }) => p.purchaseOrderId === poId)).toMatchObject({ status: "unconfirmed", line: null });
  });

  it("an account with statements cannot be deleted; delete the statements and it can — and a single line can go with a reason", async () => {
    const refused = await request(app).delete(`/bank/accounts/${checkingId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/imported statement/);

    const fee = byDesc(await lines(`year=${YEAR}&accountId=${checkingId}`), "MONTHLY SERVICE FEE");
    expect((await request(app).delete(`/bank/lines/${fee.id}?reason=${encodeURIComponent("test cleanup")}`)).status).toBe(204);
    expect(r2((await summary()).months[SEP].expenses - before.months[SEP].expenses)).toBe(0);

    for (const s of (await request(app).get(`/bank/statements?accountId=${checkingId}`)).body as { id: string }[]) {
      expect((await request(app).delete(`/bank/statements/${s.id}`)).status).toBe(204);
    }
    expect((await request(app).delete(`/bank/accounts/${checkingId}`)).status).toBe(204);
    // Back to where the year started, bank-wise: nothing on checking, and the P&L as it was before any import.
    const end = await summary();
    expect(end.months[SEP].expenses).toBe(before.months[SEP].expenses);
    expect(end.months[SEP].bank).toBe(0);
  });
});
