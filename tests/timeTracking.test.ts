/**
 * Time and payroll — TWO CLOCKS, KEPT SEPARATE (Kyle, 2026-09-11).
 *
 * Every rule he ruled on, exercised against the real database:
 *
 *   1. Job time sits inside the shift — arrive auto-starts one, clock out pauses
 *      a running job first.
 *   2. Shift hours minus job hours is unbilled company overhead.
 *   3. A rate is FROZEN when an entry closes: a raise changes tomorrow, never
 *      last month.
 *   5. A clock past 12 hours is flagged, STOPS ACCRUING, and is confirmable.
 *   6. No rate set = hours but NO cost, and rateSet says so.
 *   7. Commission = percent × (revenue − material − permit/inspection fees − labor
 *      at TOTAL cost), floored at $0 (Kyle, 2026-10-08, decision 10 — supersedes
 *      the 2026-09-11 "labor is NOT subtracted" ruling this file used to pin).
 *   8. A 46-hour week is 40 regular + 6 overtime, with the premium on the LATER
 *      hours, in the order worked.
 *
 * Plus the legacy /clock-in and /clock-out aliases, which must keep an
 * un-updated phone working exactly as before.
 *
 * No Stripe, Google or OpenAI call is made: the keys are deleted and the two
 * network-bound modules are mocked, exactly as the existing suites do.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  arrive,
  commissionForJob,
  completeJob,
  confirmEntry,
  createShift,
  editShift,
  endShift,
  flagRunaways,
  payrollForWeek,
  startShift,
  weekOf,
} from "../src/services/timeTracking";

const MIN = 60_000;
const HOUR = 60 * MIN;

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;

/** A Monday at 06:00 local, comfortably in the past — the week under test. */
function lastMonday(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 21);
  d.setHours(6, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

beforeAll(async () => {
  const customer = await prisma.customer.create({ data: { name: "Time Test Customer", phone: "615-555-0199" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: {
      customerId, name: "Time Test House", addressLine1: "9 Clock Lane",
      city: "Murfreesboro", state: "TN", postalCode: "37127",
    },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { propertyId, customerId, mode: "service_diagnostic", purpose: "Time test", status: "scheduled" },
  });
  visitId = visit.id;

  const res = await request(app)
    .post("/health-record-admin/technicians")
    .send({ name: "Time Test Tech", role: "technician" })
    .expect(201);
  technicianId = res.body.id;
  techToken = res.body.accessToken;

  await prisma.visitAssignment.create({ data: { visitId, technicianId } });
});

afterAll(async () => {
  await prisma.timeEdit.deleteMany({ where: { OR: [{ actor: "owner" }, { actor: { startsWith: "tech:" } }] } });
  await prisma.commission.deleteMany({ where: { technicianId } });
  await prisma.timeEntry.deleteMany({ where: { visitId } });
  await prisma.shiftEntry.deleteMany({ where: { technicianId } });
  await prisma.receipt.deleteMany({ where: { jobId: visitId } });
  await prisma.visitAssignment.deleteMany({ where: { visitId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
  await prisma.visit.deleteMany({ where: { id: visitId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
});

/** Every test starts from an empty clock and no rate on file. */
beforeEach(async () => {
  await prisma.timeEntry.deleteMany({ where: { visitId } });
  await prisma.shiftEntry.deleteMany({ where: { technicianId } });
  await prisma.commission.deleteMany({ where: { technicianId } });
  await prisma.technician.update({
    where: { id: technicianId },
    data: { hourlyRate: null, commissionPercent: null },
  });
});

describe("the shift clock (payroll)", () => {
  it("starts, refuses a second open shift, and ends", async () => {
    const shift = await startShift(technicianId, { source: "field" });
    expect(shift.endedAt).toBeNull();

    await expect(startShift(technicianId, { source: "field" })).rejects.toMatchObject({ statusCode: 409 });

    const ended = await endShift(technicianId);
    expect(ended.shift.endedAt).not.toBeNull();
    expect(ended.shift.minutes).toBeGreaterThan(0);
    expect(ended.pausedJob).toBeNull();
  });

  it("refuses to clock out when nobody is clocked in", async () => {
    await expect(endShift(technicianId)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("rule 1 — job time sits inside the shift", () => {
  it("arrive auto-starts a shift and says so", async () => {
    const result = await arrive(visitId, technicianId);
    expect(result.startedShift).toBe(true);
    const open = await prisma.shiftEntry.findFirst({ where: { technicianId, endedAt: null } });
    expect(open).not.toBeNull();
    expect(result.entry.shiftEntryId).toBe(open!.id);
  });

  it("arriving while already clocked in does NOT open a second shift", async () => {
    await startShift(technicianId, { source: "field" });
    const result = await arrive(visitId, technicianId);
    expect(result.startedShift).toBe(false);
    expect(await prisma.shiftEntry.count({ where: { technicianId } })).toBe(1);
  });

  it("clocking out pauses a running job first, and says so", async () => {
    await arrive(visitId, technicianId);
    const ended = await endShift(technicianId);
    expect(ended.pausedJob).not.toBeNull();
    expect(ended.pausedJob!.visitId).toBe(visitId);
    const session = await prisma.timeEntry.findFirst({ where: { visitId, technicianId } });
    expect(session!.endedAt).not.toBeNull();
    expect(session!.endedReason).toBe("clock_out");
  });
});

describe("rule 5 — a clock past 12 hours is flagged and stops accruing", () => {
  it("flags a 13-hour entry, excludes it from every total, and takes a confirmation", async () => {
    const started = new Date(Date.now() - 13 * HOUR);
    const shift = await prisma.shiftEntry.create({
      data: { technicianId, startedAt: started, source: "field" },
    });

    const swept = await flagRunaways({ hours: 12 });
    expect(swept.shifts).toBeGreaterThanOrEqual(1);
    const flagged = await prisma.shiftEntry.findUniqueOrThrow({ where: { id: shift.id } });
    expect(flagged.flaggedAt).not.toBeNull();
    expect(flagged.confirmedAt).toBeNull();

    // It has stopped accruing: nothing of it reaches the week's totals.
    const before = await payrollForWeek(technicianId, started);
    expect(before.shiftMinutes).toBe(0);
    expect(before.flagged.some((f) => f.id === shift.id)).toBe(true);

    // ...and it cannot count again until someone answers.
    const realEnd = new Date(started.getTime() + 8 * HOUR);
    await confirmEntry("shift", shift.id, { endedAt: realEnd, actor: "owner", reason: "Forgot to clock out" });
    const after = await payrollForWeek(technicianId, started);
    expect(after.shiftMinutes).toBe(8 * 60);
    expect(after.flagged).toHaveLength(0);
  });
});

describe("rule 3 — the frozen rate survives a raise", () => {
  it("pays last week's hours at last week's rate", async () => {
    await prisma.technician.update({ where: { id: technicianId }, data: { hourlyRate: 25 } });
    const monday = lastMonday();
    const entry = await createShift({
      technicianId,
      startedAt: monday,
      endedAt: new Date(monday.getTime() + 8 * HOUR),
    });
    expect(entry.rateApplied).toBe(25);

    // The raise lands AFTER those hours closed.
    await prisma.technician.update({ where: { id: technicianId }, data: { hourlyRate: 40 } });

    const week = await payrollForWeek(technicianId, monday);
    expect(week.rate).toBe(40);            // what they earn from here on
    expect(week.regularPay).toBe(8 * 25);  // what those hours actually paid
  });
});

describe("rule 2 — unbilled time is shift minus job", () => {
  it("reports drive and shop time as company overhead", async () => {
    const monday = lastMonday();
    await createShift({ technicianId, startedAt: monday, endedAt: new Date(monday.getTime() + 9 * HOUR) });
    await prisma.timeEntry.create({
      data: {
        visitId, technicianId,
        startedAt: new Date(monday.getTime() + HOUR),
        endedAt: new Date(monday.getTime() + 8 * HOUR),
        minutes: 7 * 60,
        endedReason: "completed",
      },
    });

    const week = await payrollForWeek(technicianId, monday);
    expect(week.shiftMinutes).toBe(9 * 60);
    expect(week.jobMinutes).toBe(7 * 60);
    expect(week.unbilledMinutes).toBe(2 * 60);
  });
});

describe("the payroll floor — job time with no shift is still paid", () => {
  it("pays job hours the day clock missed, and counts them toward the week", async () => {
    await prisma.technician.update({ where: { id: technicianId }, data: { hourlyRate: 30 } });
    const monday = lastMonday();
    // No shift at all — exactly Kyle's week on 2026-09-11: job clocks, no ShiftEntry rows.
    await prisma.timeEntry.create({
      data: {
        visitId, technicianId,
        startedAt: new Date(monday.getTime() + HOUR),
        endedAt: new Date(monday.getTime() + 6.5 * HOUR),
        minutes: 5.5 * 60,
        rateApplied: 30,
        endedReason: "completed",
      },
    });

    const week = await payrollForWeek(technicianId, monday);
    expect(week.shiftMinutes).toBe(0);
    expect(week.jobMinutes).toBe(5.5 * 60);
    expect(week.impliedMinutes).toBe(5.5 * 60);
    expect(week.regularMinutes).toBe(5.5 * 60);
    expect(week.regularPay).toBe(5.5 * 30);
    expect(week.unbilledMinutes).toBe(0); // every paid minute was on the job
  });

  it("does not pay job time twice when a shift already covers it", async () => {
    await prisma.technician.update({ where: { id: technicianId }, data: { hourlyRate: 30 } });
    const monday = lastMonday();
    await createShift({ technicianId, startedAt: monday, endedAt: new Date(monday.getTime() + 8 * HOUR) });
    await prisma.timeEntry.create({
      data: {
        visitId, technicianId,
        startedAt: new Date(monday.getTime() + HOUR),
        endedAt: new Date(monday.getTime() + 4 * HOUR),
        minutes: 3 * 60,
        endedReason: "completed",
      },
    });

    const week = await payrollForWeek(technicianId, monday);
    expect(week.impliedMinutes).toBe(0);
    expect(week.regularMinutes).toBe(8 * 60);
    expect(week.regularPay).toBe(8 * 30);
  });

  it("pays only the tail of a job that ran past the clock-out", async () => {
    await prisma.technician.update({ where: { id: technicianId }, data: { hourlyRate: 30 } });
    const monday = lastMonday();
    await createShift({ technicianId, startedAt: monday, endedAt: new Date(monday.getTime() + 8 * HOUR) });
    await prisma.timeEntry.create({
      data: {
        visitId, technicianId,
        startedAt: new Date(monday.getTime() + 6 * HOUR),
        endedAt: new Date(monday.getTime() + 10 * HOUR), // two hours past clock-out
        minutes: 4 * 60,
        endedReason: "completed",
      },
    });

    const week = await payrollForWeek(technicianId, monday);
    expect(week.impliedMinutes).toBe(2 * 60);
    expect(week.regularMinutes).toBe(10 * 60);
    expect(week.regularPay).toBe(10 * 30);
  });
});

describe("hours closed before a rate existed", () => {
  it("pays them at the rate set afterwards, and marks the rate as not frozen", async () => {
    const monday = lastMonday();
    // Closed with no rate on file — rateApplied lands null.
    const entry = await createShift({
      technicianId,
      startedAt: monday,
      endedAt: new Date(monday.getTime() + 8 * HOUR),
    });
    expect(entry.rateApplied).toBeNull();

    // Kyle sets the rate afterwards. Those hours are not worth nothing forever.
    await prisma.technician.update({ where: { id: technicianId }, data: { hourlyRate: 30 } });

    const week = await payrollForWeek(technicianId, monday);
    expect(week.regularPay).toBe(8 * 30);
    expect(week.shifts[0].rateApplied).toBe(30);
    expect(week.shifts[0].rateFrozen).toBe(false);
  });
});

describe("rule 8 — overtime rides the hours that crossed 40", () => {
  it("splits a 46-hour week into 40 regular and 6 overtime, premium on the later hours", async () => {
    await prisma.technician.update({ where: { id: technicianId }, data: { hourlyRate: 20 } });
    const monday = lastMonday();
    // Mon–Fri 8h each = 40, then Saturday 6h — the hours that cross the line.
    for (let day = 0; day < 5; day += 1) {
      const start = new Date(monday.getTime() + day * 24 * HOUR);
      await createShift({ technicianId, startedAt: start, endedAt: new Date(start.getTime() + 8 * HOUR) });
    }
    const saturday = new Date(monday.getTime() + 5 * 24 * HOUR);
    await createShift({ technicianId, startedAt: saturday, endedAt: new Date(saturday.getTime() + 6 * HOUR) });

    const week = await payrollForWeek(technicianId, monday);
    expect(week.shiftMinutes).toBe(46 * 60);
    expect(week.regularMinutes).toBe(40 * 60);
    expect(week.overtimeMinutes).toBe(6 * 60);
    // Straight time on all 46 hours; the premium is the EXTRA half, on six hours only.
    // (Before 2026-09-21 regularPay covered the first 40 only and the week totalled
    // $860 while its own shift rows summed to $980.)
    expect(week.regularPay).toBe(46 * 20);
    expect(week.overtimePremium).toBe(6 * 20 * 0.5);
    expect(week.total).toBe(46 * 20 + 60);
    expect(week.shifts.reduce((s, r) => s + (r.pay ?? 0), 0)).toBe(week.total);

    // In the order worked: Monday carries none of it, Saturday carries all of it.
    const saturdayRow = week.shifts.find((s) => new Date(s.startedAt).getTime() === saturday.getTime())!;
    expect(saturdayRow.overtimeMinutes).toBe(6 * 60);
    expect(week.shifts[0].overtimeMinutes).toBe(0);
  });
});

describe("rule 6 — no rate set means hours but no cost", () => {
  it("counts the hours and says the rate is not set", async () => {
    const monday = lastMonday();
    await createShift({ technicianId, startedAt: monday, endedAt: new Date(monday.getTime() + 8 * HOUR) });
    const week = await payrollForWeek(technicianId, monday);
    expect(week.shiftMinutes).toBe(8 * 60);
    expect(week.rateSet).toBe(false);
    expect(week.rate).toBeNull();
    expect(week.regularPay).toBe(0);
    expect(week.total).toBe(0);
    expect(week.shifts[0].rateApplied).toBeNull();
    expect(week.shifts[0].pay).toBeNull();
  });
});

describe("rule 4 — every hour is editable with a reason and a trail", () => {
  it("writes a TimeEdit carrying the reason, the before and the after", async () => {
    const monday = lastMonday();
    const shift = await createShift({ technicianId, startedAt: monday, endedAt: new Date(monday.getTime() + 8 * HOUR) });
    const corrected = new Date(monday.getTime() + 6 * HOUR);
    await editShift(shift.id, { endedAt: corrected, actor: "owner", reason: "Left early for the parts run" });

    const trail = await prisma.timeEdit.findMany({ where: { shiftEntryId: shift.id } });
    expect(trail).toHaveLength(1);
    expect(trail[0].reason).toBe("Left early for the parts run");
    expect(trail[0].kind).toBe("shift");
    expect(JSON.parse(trail[0].beforeJson).minutes).toBe(8 * 60);
    expect(JSON.parse(trail[0].afterJson).minutes).toBe(6 * 60);
  });

  it("the route refuses an edit with no reason", async () => {
    const monday = lastMonday();
    const shift = await createShift({ technicianId, startedAt: monday, endedAt: new Date(monday.getTime() + HOUR) });
    await request(app)
      .patch(`/time/shifts/${shift.id}`)
      .send({ endedAt: new Date(monday.getTime() + 2 * HOUR).toISOString() })
      .expect(400);
  });
});

/**
 * THE P.O. IS THE MONEY (Kyle, 2026-09-19): a job's material is the money on
 * the P.O.s tagged to it. These fixtures put it there — a typed not-on-card
 * amount for material, and card charges of kind permit/inspection for fees.
 */
async function moneyOnJob(visit: string, input: { typed: number; charges?: Array<{ kind: string; amount: number; merchant: string }> }) {
  await prisma.cardSpend.deleteMany({ where: { purchaseOrder: { jobId: visit } } });
  await prisma.purchaseOrder.deleteMany({ where: { jobId: visit } });
  const po = await prisma.purchaseOrder.create({
    data: {
      number: `PO-TT-${Math.random().toString(36).slice(2, 8)}`, purpose: "truck_stock", destinationType: "warehouse", jobId: visit,
      supplier: "TT money", status: "closed", openedBy: "owner", offCardAmount: input.typed, offCardMethod: "check", offCardAt: new Date(),
    },
  });
  for (const c of input.charges ?? []) {
    await prisma.cardSpend.create({
      data: { stripeTransactionId: `tt_${Math.random().toString(36).slice(2, 10)}`, stripeCardId: "card_tt", kind: c.kind, amount: c.amount, merchantName: c.merchant, purchaseOrderId: po.id, occurredAt: new Date() },
    });
  }
}

/** Closed job hours on the visit for one technician, at a frozen rate (or none). */
async function hoursOnJob(technician: string, hours: number, rateApplied: number | null) {
  const startedAt = new Date(Date.now() - (hours + 1) * HOUR);
  await prisma.timeEntry.create({
    data: {
      visitId, technicianId: technician, startedAt,
      endedAt: new Date(startedAt.getTime() + hours * HOUR), minutes: hours * 60, endedReason: "completed", rateApplied,
    },
  });
}

/** Settings → Payroll → "Employer cost on top of wages (%)" — through the PUT, so the validation runs. */
async function employerCost(percent: number | null) {
  const res = await request(app).put("/crm/settings/payroll").send({ employerCostPercent: percent });
  expect(res.status).toBe(200);
}

/**
 * DECISION 10 (Kyle, 2026-10-08) — commission on TRUE profit. The test that used to live here
 * pinned "labor is NOT subtracted" (revenue 5000 − 1200 − 250 = 3550, "labor's $600 is
 * deliberately absent"). It was changed on purpose, not worked around: labor at TOTAL cost is now
 * the fourth term, every tech's hours × the rate frozen on the session × (1 + employer cost %).
 */
describe("rule 7 — commission on job profit (decision 10: labor at total cost is subtracted)", () => {
  beforeEach(async () => {
    await prisma.companySetting.deleteMany({ where: { key: "payroll" } });
  });
  afterAll(async () => {
    await prisma.companySetting.deleteMany({ where: { key: "payroll" } });
  });

  it("is percent × (revenue − material − permit/inspection fees − labor at total cost), each its own row", async () => {
    await prisma.technician.update({ where: { id: technicianId }, data: { commissionPercent: 10, hourlyRate: 30 } });
    await prisma.visit.update({ where: { id: visitId }, data: { revenue: 5000, laborHours: 20 } });
    await moneyOnJob(visitId, {
      typed: 1200,
      charges: [
        { kind: "permit", amount: 150, merchant: "Rutherford County" },
        { kind: "inspection", amount: 100, merchant: "State Inspector" },
      ],
    });
    await hoursOnJob(technicianId, 20, 30); // $600 of wages
    await employerCost(10);                 // $660 at total cost

    const quote = await commissionForJob(visitId, technicianId);
    expect(quote.revenue).toBe(5000);
    // A permit charge on the job's P.O. is a FEE, never material — counted once.
    expect(quote.materialCost).toBe(1200);
    expect(quote.materialSource).toBe("po");
    expect(quote.fees).toBe(250);
    expect(quote.feeRows.map((f) => [f.kind, f.category, f.amount])).toEqual([["card", "permit", 150], ["card", "inspection", 100]]);
    expect(quote.feeProblems).toEqual([]);
    // Labor, shown: who, hours, wages, and the total with the employer cost on top.
    expect(quote.laborRows).toEqual([
      { technicianId, name: "Time Test Tech", hours: 20, wage: 600, rateMissing: false, total: 660 },
    ]);
    expect(quote.laborWage).toBe(600);
    expect(quote.employerCostPercent).toBe(10);
    expect(quote.employerCostSet).toBe(true);
    expect(quote.laborCost).toBe(660);
    expect(quote.missing).toEqual([]);
    expect(quote.profit).toBe(2890);       // 5000 − 1200 − 250 − 660
    expect(quote.commissionableProfit).toBe(2890);
    expect(quote.percent).toBe(10);
    expect(quote.amount).toBe(289);
  });

  /**
   * KYLE'S WORKED EXAMPLE (2026-10-08): a $500 job; materials $150 + a $65 GFCI breaker; permit $50
   * + a $50 reinspection; labor $100 + $100 — profit −$15, so the commission is $0: "the tech never
   * owes money back". Two technicians at $20/hr × 4h = $80 of wages each, 25% employer cost on top
   * = $100 each — every tech who worked it counts.
   */
  it("Kyle's example: $500 job, $215 material, $100 fees, $200 labor → profit −$15 → commission $0", async () => {
    const second = await prisma.technician.create({ data: { name: "Time Test Helper", accessToken: `tt-helper-${Date.now()}`, hourlyRate: 20 } });
    try {
      await prisma.technician.update({ where: { id: technicianId }, data: { commissionPercent: 10, hourlyRate: 20 } });
      await prisma.visit.update({ where: { id: visitId }, data: { revenue: 500 } });
      await moneyOnJob(visitId, {
        typed: 215, // $150 of materials + the $65 GFCI breaker
        charges: [
          { kind: "permit", amount: 50, merchant: "Rutherford County" },
          { kind: "inspection", amount: 50, merchant: "State Inspector — reinspection" },
        ],
      });
      await hoursOnJob(technicianId, 4, 20);
      await hoursOnJob(second.id, 4, 20);
      await employerCost(25);

      const quote = await commissionForJob(visitId, technicianId);
      expect(quote.revenue).toBe(500);
      expect(quote.materialCost).toBe(215);
      expect(quote.fees).toBe(100);
      expect(quote.laborRows.map((r) => [r.name, r.hours, r.wage, r.total])).toEqual(expect.arrayContaining([
        ["Time Test Tech", 4, 80, 100],
        ["Time Test Helper", 4, 80, 100],
      ]));
      expect(quote.laborCost).toBe(200);
      expect(quote.profit).toBe(-15);              // shown as the loss it is
      expect(quote.commissionableProfit).toBe(0);  // floored — never negative
      expect(quote.amount).toBe(0);                // $0, the tech never owes money back

      // Recording it through the route books $0, not a refusal — the job was worked.
      const posted = await request(app).post("/time/commissions").send({ technicianId, visitId, basis: "job_profit" });
      expect(posted.status).toBe(201);
      expect(posted.body.amount).toBe(0);
    } finally {
      await prisma.timeEntry.deleteMany({ where: { technicianId: second.id } });
      await prisma.technician.delete({ where: { id: second.id } });
    }
  });

  it("a missing hourly rate or employer cost % is MISSING, never $0 labor — and the route says which", async () => {
    await prisma.technician.update({ where: { id: technicianId }, data: { commissionPercent: 10, hourlyRate: null } });
    await prisma.visit.update({ where: { id: visitId }, data: { revenue: 5000 } });
    await moneyOnJob(visitId, { typed: 1200 });

    // Hours closed with no rate on file.
    await hoursOnJob(technicianId, 8, null);
    await employerCost(10);
    let quote = await commissionForJob(visitId, technicianId);
    expect(quote.laborRows[0]).toMatchObject({ rateMissing: true, wage: null, total: null });
    expect(quote.laborCost).toBeNull();
    expect(quote.profit).toBeNull();
    expect(quote.amount).toBeNull();
    expect(quote.missing).toEqual(["Time Test Tech has hours on this job with no hourly rate set"]);
    const refused = await request(app).post("/time/commissions").send({ technicianId, visitId, basis: "job_profit" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/no hourly rate set/);

    // Rated hours, but the employer cost % was never set.
    await prisma.timeEntry.deleteMany({ where: { visitId } });
    await hoursOnJob(technicianId, 8, 30);
    await employerCost(null);
    quote = await commissionForJob(visitId, technicianId);
    expect(quote.laborWage).toBe(240);
    expect(quote.employerCostSet).toBe(false);
    expect(quote.laborCost).toBeNull();
    expect(quote.profit).toBeNull();
    expect(quote.missing).toEqual(['employer cost % not set — Settings → Payroll → "Employer cost on top of wages (%)"']);

    // No hours at all: nothing to burden, labor is $0 and the profit computes even with no percent set.
    await prisma.timeEntry.deleteMany({ where: { visitId } });
    quote = await commissionForJob(visitId, technicianId);
    expect(quote.laborRows).toEqual([]);
    expect(quote.laborCost).toBe(0);
    expect(quote.employerCostSet).toBe(false);
    expect(quote.profit).toBe(3800);
    expect(quote.amount).toBe(380);
  });

  it("invents no percentage when none was typed", async () => {
    await prisma.visit.update({ where: { id: visitId }, data: { revenue: 5000 } });
    await moneyOnJob(visitId, { typed: 1200 });
    const quote = await commissionForJob(visitId, technicianId);
    expect(quote.percentSet).toBe(false);
    expect(quote.amount).toBeNull();
  });
});

describe("the workweek", () => {
  it("runs Monday 00:00 to Sunday 23:59:59 local", () => {
    // A Wednesday.
    const { start, end } = weekOf(new Date(2026, 8, 9, 15, 30));
    expect(start.getDay()).toBe(1);
    expect(start.getDate()).toBe(7);
    expect(start.getHours()).toBe(0);
    expect(end.getDay()).toBe(0);
    expect(end.getDate()).toBe(13);
    expect(end.getHours()).toBe(23);
  });
});

describe("the tech routes", () => {
  const auth = () => ({ Authorization: `Bearer ${techToken}` });

  it("clock in / clock out still work as aliases for arrive / pause", async () => {
    const inRes = await request(app)
      .post(`/health-record/visits/${visitId}/clock-in`)
      .set(auth())
      .send({})
      .expect(201);
    expect(inRes.body.data.clockedInAt).toBeTruthy();

    // The legacy verb still starts the shift, because job time sits inside it.
    expect(await prisma.shiftEntry.count({ where: { technicianId, endedAt: null } })).toBe(1);

    const outRes = await request(app)
      .post(`/health-record/visits/${visitId}/clock-out`)
      .set(auth())
      .send({})
      .expect(200);
    expect(outRes.body.data.minutes).toBeGreaterThan(0);
    expect(outRes.body.data).toHaveProperty("laborMinutes");
    expect(outRes.body.data).toHaveProperty("laborHours");

    // A second clock-in on the same visit is still a conflict.
    await request(app).post(`/health-record/visits/${visitId}/clock-in`).set(auth()).send({}).expect(201);
    await request(app).post(`/health-record/visits/${visitId}/clock-in`).set(auth()).send({}).expect(409);
  });

  it("reports today's clock, and the flagged entry needing an answer", async () => {
    await prisma.shiftEntry.create({
      data: { technicianId, startedAt: new Date(Date.now() - 14 * HOUR), source: "field", flaggedAt: new Date() },
    });
    const res = await request(app).get("/health-record/shift").set(auth()).expect(200);
    // A flagged shift is not "running" — it stopped accruing.
    expect(res.body.data.clockedInAt).toBeNull();
    expect(res.body.data.flagged).toHaveLength(1);
    expect(res.body.data.flagged[0].kind).toBe("shift");
  });

  it("arrive reports that it started the shift, and complete-time closes the job clock", async () => {
    const arriveRes = await request(app)
      .post(`/health-record/visits/${visitId}/arrive`)
      .set(auth())
      .send({})
      .expect(201);
    expect(arriveRes.body.data.startedShift).toBe(true);

    const doneRes = await request(app)
      .post(`/health-record/visits/${visitId}/complete-time`)
      .set(auth())
      .send({})
      .expect(200);
    expect(doneRes.body.data.minutes).toBeGreaterThan(0);
    const session = await prisma.timeEntry.findFirstOrThrow({ where: { visitId, technicianId } });
    expect(session.endedReason).toBe("completed");
    // The SHIFT keeps running — the drive home is still paid time.
    expect(await prisma.shiftEntry.count({ where: { technicianId, endedAt: null } })).toBe(1);
  });
});

describe("the office routes", () => {
  it("serves the pay week and the job's own hours", async () => {
    const monday = lastMonday();
    await prisma.technician.update({ where: { id: technicianId }, data: { hourlyRate: 50 } });
    await createShift({ technicianId, startedAt: monday, endedAt: new Date(monday.getTime() + 4 * HOUR) });
    await request(app)
      .post(`/time/jobs/${visitId}/sessions`)
      .send({
        technicianId,
        startedAt: new Date(monday.getTime() + HOUR).toISOString(),
        endedAt: new Date(monday.getTime() + 3 * HOUR).toISOString(),
      })
      .expect(201);

    const week = await request(app)
      .get(`/time/technicians/${technicianId}/week?start=${monday.toISOString()}`)
      .expect(200);
    expect(week.body.shiftMinutes).toBe(4 * 60);
    expect(week.body.jobMinutes).toBe(2 * 60);
    expect(week.body.unbilledMinutes).toBe(2 * 60);
    expect(week.body.regularPay).toBe(200);

    const job = await request(app).get(`/time/jobs/${visitId}`).expect(200);
    expect(job.body.totalHours).toBe(2);
    expect(job.body.laborCost).toBe(100);
    expect(job.body.technicians[0].rateSet).toBe(true);

    // Visit.laborHours — what job profitability reads — tracks the sessions.
    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: visitId } });
    expect(visit.laborHours).toBe(2);
  });

  it("records a commission from job profit and lists it", async () => {
    await prisma.technician.update({ where: { id: technicianId }, data: { commissionPercent: 5 } });
    await prisma.visit.update({ where: { id: visitId }, data: { revenue: 2000 } });
    await moneyOnJob(visitId, { typed: 500 });

    const created = await request(app)
      .post("/time/commissions")
      .send({ technicianId, visitId, basis: "job_profit" })
      .expect(201);
    expect(created.body.amount).toBe(75); // 5% of (2000 − 500 − 0)

    const list = await request(app).get(`/time/commissions?technicianId=${technicianId}`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].percent).toBe(5);

    await request(app).post(`/time/commissions/${created.body.id}/void`).send({ reason: "Entered twice" }).expect(200);
    // Voided, not deleted: the row is still listed, marked, and no longer counted.
    const after = await request(app).get(`/time/commissions?technicianId=${technicianId}`).expect(200);
    expect(after.body).toHaveLength(1);
    expect(after.body[0].voidReason).toBe("Entered twice");
  });
});
