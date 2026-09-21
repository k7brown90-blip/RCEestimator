/**
 * Payroll on the P&L (Kyle, 2026-09-20: "Team pay is for tracking hourly rate
 * + commissions. The P&L is what tracks the payroll overhead.").
 *
 * The worked example the plan asked for: one job with hours, a commission,
 * materials on a P.O. and a signed invoice. Pinned against the real database:
 *
 *   - Expenses carries the wages EXACTLY ONCE — the shift pays the job time
 *     inside it (shift + job hours would pay the same minutes twice), and job
 *     profitability's per-job labour line is a view of the same hours that is
 *     never added to Expenses on top.
 *   - Wages land in the month the hours were WORKED; a Monday–Sunday week that
 *     straddles a month boundary is walked whole for the 40-hour line and each
 *     shift lands in its own month, the overtime premium with the shift that
 *     crossed 40.
 *   - A commission counts at earnedAt, whether or not paidAt is set.
 *   - A flagged, unconfirmed clock counts nothing; confirming it books the
 *     hours in the month they were worked.
 *   - Hours with no rate on file cost $0 and are reported as unrated hours.
 *   - A test account's job hours and commissions never reach the company line.
 *   - The tax-year CSV carries the same wages and commissions as the screen.
 *
 * Every figure is a delta against the same year read before the fixture
 * existed, so a recurring bill from another test cannot move the assertions.
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
import { payrollForWeek, recomputeVisitLabor, weekOf } from "../src/services/timeTracking";
import { getLaborRate } from "../src/services/jobCosting";

const YEAR = 2032; // far from every other fixture's year (testAccountFinancials uses 2031)
const SEP = 8;
const OCT = 9;
const HOUR = 60 * 60 * 1000;
const RATE = 30;
const r2 = (n: number) => Math.round(n * 100) / 100;

let customerId: string;
let propertyId: string;
let visitId: string;
let techId: string;
let unratedTechId: string;
let draftId: string;

/** The week the example is worked in: Mon 13 – Sun 19 September 2032. */
const weekA = weekOf(new Date(YEAR, SEP, 15));
/** A week that straddles the month: Mon 27 Sep – Sun 3 Oct 2032. */
const weekB = weekOf(new Date(YEAR, OCT, 1));

/** `day` days after the week's Monday, at `hour` local. */
const at = (week: { start: Date }, day: number, hour: number) => new Date(week.start.getTime() + day * 24 * HOUR + hour * HOUR);

type MonthRow = { month: number; payroll: number; expenses: number; stripeFees: number; net: number; invoiced: number };
type Summary = {
  months: MonthRow[];
  totals: { payroll: number; expenses: number };
  expensesByCategory: { category: string; monthly: number[]; total: number }[];
  payrollUnratedHours: number;
};
async function summary(): Promise<Summary> {
  const res = await request(app).get(`/financials/summary?year=${YEAR}`);
  expect(res.status).toBe(200);
  return res.body as Summary;
}
const category = (s: Summary, name: string, month: number) =>
  s.expensesByCategory.find((c) => c.category === name)?.monthly[month] ?? 0;

let baseline: Summary;

async function shift(technicianId: string, start: Date, hours: number, extra: Record<string, unknown> = {}) {
  return prisma.shiftEntry.create({
    data: {
      technicianId, startedAt: start, endedAt: new Date(start.getTime() + hours * HOUR), minutes: hours * 60,
      rateApplied: RATE, source: "office", ...extra,
    },
  });
}

beforeAll(async () => {
  // Sanity on the calendar the example relies on: week B really does straddle September/October.
  expect(weekB.start.getMonth()).toBe(SEP);
  expect(weekB.end.getMonth()).toBe(OCT);

  baseline = await summary();

  const customer = await prisma.customer.create({ data: { name: "PNL Payroll Co", phone: "+16155509999", isTestAccount: false } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "Payroll House", addressLine1: "40 Overtime Ln", city: "Franklin", state: "TN", postalCode: "37064" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: {
      customerId, propertyId, mode: "onsite", purpose: "PNL panel swap", jobType: "PNL panel swap", status: "completed",
      visitDate: at(weekA, 0, 9), completedAt: at(weekA, 1, 12),
    },
  });
  visitId = visit.id;
  techId = (await prisma.technician.create({ data: { name: "PNL Tech", hourlyRate: RATE, accessToken: `pnl-token-${Date.now()}` } })).id;
  unratedTechId = (await prisma.technician.create({ data: { name: "PNL Unrated", hourlyRate: null, accessToken: `pnl-unrated-${Date.now()}` } })).id;

  // The invoice: a signed estimate on the job, so job profitability has revenue to margin against.
  draftId = (await prisma.priceBookDraftEstimate.create({ data: { title: "pnl draft", supplierId: "PNL-SUP" } })).id;
  await prisma.issuedEstimate.create({
    data: {
      number: "0000-PNL-PAYROLL", token: `pnl-token-${Date.now()}`, status: "signed", draftId,
      customerId, serviceAddressId: propertyId, jobVisitId: visitId,
      customerName: "PNL Payroll Co", serviceAddress: "40 Overtime Ln, Franklin", title: "PNL panel swap",
      // No option selection: the invoice bills its total (a selection with no option rows would bill $0).
      workSubtotal: 2400, total: 2400, selectedOptions: [], signedAt: at(weekA, 0, 8), signedChannel: "email",
    },
  });

  // Materials: $500 on the card, on a P.O. tagged to the job.
  await prisma.purchaseOrder.create({
    data: {
      number: `PO-${YEAR}-PNL`, purpose: "truck_stock", destinationType: "warehouse", jobId: visitId,
      supplier: "PNL Supply", status: "closed", openedBy: "owner", openedAt: at(weekA, 0, 7),
      cardSpends: { create: { stripeTransactionId: `tx_pnl_${Date.now()}`, stripeCardId: "card_pnl", kind: "materials", amount: 500, merchantName: "PNL Supply", occurredAt: at(weekA, 0, 7) } },
    },
  });

  // Week A — Monday: an 8h shift with a 4h job session INSIDE it (paid by the shift, once).
  await shift(techId, at(weekA, 0, 8), 8);
  await prisma.timeEntry.create({
    data: { visitId, technicianId: techId, startedAt: at(weekA, 0, 9), endedAt: at(weekA, 0, 13), minutes: 240, rateApplied: RATE, endedReason: "paused" },
  });
  // Tuesday: 2h on the job with NO shift — the payroll floor pays it.
  await prisma.timeEntry.create({
    data: { visitId, technicianId: techId, startedAt: at(weekA, 1, 8), endedAt: at(weekA, 1, 10), minutes: 120, rateApplied: RATE, endedReason: "completed" },
  });
  await recomputeVisitLabor(visitId);
  // Thursday: the unrated technician's hour — hours, but no cost (rule 6).
  await shift(unratedTechId, at(weekA, 3, 8), 1, { rateApplied: null });

  // Week B — Mon–Fri 8h each (Mon–Thu in September, Fri 1 Oct), then Saturday 6h: the hours that cross 40.
  for (let day = 0; day < 5; day += 1) await shift(techId, at(weekB, day, 8), 8);
  await shift(techId, at(weekB, 5, 8), 6);

  // Commissions on the job: one unpaid, one already marked paid in October. Both EARNED in September.
  await prisma.commission.createMany({
    data: [
      { technicianId: techId, visitId, basis: "job_profit", percent: 10, amount: 75, earnedAt: at(weekA, 2, 12), paidAt: null },
      { technicianId: techId, visitId, basis: "manual", amount: 50, note: "PNL spiff", earnedAt: at(weekA, 3, 12), paidAt: new Date(YEAR, OCT, 20, 12) },
    ],
  });
});

afterAll(async () => {
  await prisma.commission.deleteMany({ where: { technicianId: { in: [techId, unratedTechId] } } });
  await prisma.timeEntry.deleteMany({ where: { technicianId: { in: [techId, unratedTechId] } } });
  await prisma.shiftEntry.deleteMany({ where: { technicianId: { in: [techId, unratedTechId] } } });
  await prisma.timeEdit.deleteMany({ where: { reason: { startsWith: "PNL" } } });
  await prisma.cardSpend.deleteMany({ where: { stripeCardId: "card_pnl" } });
  await prisma.purchaseOrder.deleteMany({ where: { supplier: "PNL Supply" } });
  await prisma.issuedEstimate.deleteMany({ where: { number: "0000-PNL-PAYROLL" } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: draftId } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.technician.deleteMany({ where: { id: { in: [techId, unratedTechId] } } });
});

// What the fixture is worth, by the rule.
const WEEK_A_WAGES = 8 * RATE + 2 * RATE;             // shift 8h + uncovered job time 2h; the 4h inside the shift adds nothing
const WEEK_B_SEP_WAGES = 32 * RATE;                     // Mon–Thu, 32 regular hours
const WEEK_B_OCT_WAGES = 8 * RATE + 6 * RATE * 1.5;     // Fri regular + Sat 6h at 1.5× (the hours past 40)
const SEP_WAGES = WEEK_A_WAGES + WEEK_B_SEP_WAGES;      // 300 + 960
const SEP_COMMISSIONS = 75 + 50;
const MATERIALS = 500;

describe("payroll on the P&L — wages counted once, in the month worked", () => {
  it("Expenses = materials + wages + commissions; the job time inside the shift is not paid twice, and the CSV agrees", async () => {
    const now = await summary();
    const sep = now.months[SEP];
    const base = baseline.months[SEP];

    expect(r2(sep.payroll - base.payroll)).toBe(SEP_WAGES + SEP_COMMISSIONS);
    // Wages ONCE: 8h shift + 2h floor = $300, not 8h + 4h + 2h = $420. And nothing else moved
    // Expenses — not job profitability's labour, not the 4h session inside the shift.
    expect(r2(sep.expenses - base.expenses)).toBe(MATERIALS + SEP_WAGES + SEP_COMMISSIONS);
    expect(r2(sep.net - base.net)).toBe(r2(2400 - (MATERIALS + SEP_WAGES + SEP_COMMISSIONS)));

    // Visible by category: wages and commissions apart.
    expect(r2(category(now, "payroll:wages", SEP) - category(baseline, "payroll:wages", SEP))).toBe(SEP_WAGES);
    expect(r2(category(now, "payroll:commissions", SEP) - category(baseline, "payroll:commissions", SEP))).toBe(SEP_COMMISSIONS);
    expect(r2(category(now, "materials", SEP) - category(baseline, "materials", SEP))).toBe(MATERIALS);

    // Year total moved by exactly both months' payroll.
    expect(r2(now.totals.payroll - baseline.totals.payroll)).toBe(SEP_WAGES + SEP_COMMISSIONS + WEEK_B_OCT_WAGES);

    // The tax-year export carries the same money the screen shows.
    const csv = await request(app).get(`/financials/export?year=${YEAR}`);
    expect(csv.status).toBe(200);
    const lines = (csv.text as string).split("\n").filter((l) => l.includes("PNL Tech"));
    const wageLines = lines.filter((l) => l.includes(",expense,payroll:wages,"));
    const commissionLines = lines.filter((l) => l.includes(",expense,payroll:commissions,"));
    const sum = (rows: string[]) => r2(rows.reduce((s, l) => s + Number(l.slice(l.lastIndexOf(",") + 1)), 0));
    expect(sum(wageLines)).toBe(SEP_WAGES + WEEK_B_OCT_WAGES);
    expect(sum(commissionLines)).toBe(SEP_COMMISSIONS);
    // Week B is one workweek in two months: two wage rows, and the overtime is named on October's.
    const weekBRows = wageLines.filter((l) => l.includes(`week of ${weekB.start.toISOString().slice(0, 10)}`));
    expect(weekBRows).toHaveLength(2);
    expect(weekBRows.some((l) => l.includes("6h overtime"))).toBe(true);
  });

  it("job profitability still shows the job's own labour line — the per-job view of the same hours", async () => {
    const res = await request(app).get(`/financials/job-profitability?year=${YEAR}`);
    expect(res.status).toBe(200);
    const row = res.body.find((r: { visitId: string }) => r.visitId === visitId);
    expect(row, "the completed job appears in the report").toBeTruthy();
    // 4h inside the shift + 2h on the floor — every counted session, at the company labor rate.
    expect(row.laborHours).toBe(6);
    expect(row.laborCost).toBe(r2(6 * (await getLaborRate())));
    expect(row.materialSpend).toBe(MATERIALS);
    expect(row.quoted).toBe(2400);
    expect(row.margin).toBe(r2(2400 - MATERIALS - row.laborCost));
  });

  it("a week that straddles the month is walked whole: September gets Mon–Thu, October gets Friday and the overtime Saturday", async () => {
    const now = await summary();
    expect(r2(now.months[OCT].payroll - baseline.months[OCT].payroll)).toBe(WEEK_B_OCT_WAGES);
    expect(r2(category(now, "payroll:wages", OCT) - category(baseline, "payroll:wages", OCT))).toBe(WEEK_B_OCT_WAGES);
    // No commission landed in October: the $50 marked paid in October was EARNED in September.
    expect(r2(category(now, "payroll:commissions", OCT) - category(baseline, "payroll:commissions", OCT))).toBe(0);

    // And the Team week says the same total for the same week — one walk, two views.
    const team = await payrollForWeek(techId, weekB.start);
    expect(team.regularMinutes).toBe(40 * 60);
    expect(team.overtimeMinutes).toBe(6 * 60);
    expect(team.total).toBe(WEEK_B_SEP_WAGES + WEEK_B_OCT_WAGES);
  });

  it("hours with no rate on file cost $0 and are reported, not hidden", async () => {
    const now = await summary();
    expect(r2(now.payrollUnratedHours - baseline.payrollUnratedHours)).toBe(1);
  });

  it("a flagged, unconfirmed clock counts nothing; confirming it books the hours in the month they were worked", async () => {
    const before = await summary();
    // A 12-hour Wednesday the sweep flagged, closed by hand but never answered for.
    const flagged = await shift(techId, at(weekA, 2, 8), 12, { flaggedAt: at(weekA, 2, 20), confirmedAt: null });
    expect(r2((await summary()).months[SEP].payroll - before.months[SEP].payroll)).toBe(0);

    await prisma.shiftEntry.update({ where: { id: flagged.id }, data: { confirmedAt: new Date() } });
    expect(r2((await summary()).months[SEP].payroll - before.months[SEP].payroll)).toBe(12 * RATE);

    await prisma.shiftEntry.delete({ where: { id: flagged.id } });
  });

  it("a test account's job hours and commissions never reach the company line; its shifts still do", async () => {
    const live = await summary();
    await prisma.customer.update({ where: { id: customerId }, data: { isTestAccount: true } });
    try {
      const marked = await summary();
      // Gone: the 2h floor session on the practice job ($60), both commissions ($125), the materials ($500).
      // Kept: the Monday shift ($240) — a shift is company time — and all of week B.
      expect(r2(live.months[SEP].payroll - marked.months[SEP].payroll)).toBe(2 * RATE + SEP_COMMISSIONS);
      expect(r2(live.months[SEP].expenses - marked.months[SEP].expenses)).toBe(2 * RATE + SEP_COMMISSIONS + MATERIALS);
    } finally {
      await prisma.customer.update({ where: { id: customerId }, data: { isTestAccount: false } });
    }
    expect(await summary()).toEqual(live);
  });
});
