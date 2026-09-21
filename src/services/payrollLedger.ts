/**
 * Payroll on the P&L (Kyle, 2026-09-20: "Team pay is for tracking hourly rate
 * + commissions. The P&L is what tracks the payroll overhead.").
 *
 * Until 2026-09-21 the P&L had no labour in it at all — Expenses was card
 * charges, typed P.O. amounts, company bills and Stripe fees, so Net was
 * revenue minus materials and overhead with the largest variable cost missing.
 * This service is the company total; the Team tab keeps the per-person week.
 *
 * WHAT IT SUMS — the same two functions the Team week runs
 * (services/timeTracking.ts payableSegments + attributeWorkweek), so the sum of
 * every technician's week equals this line:
 *
 *   wages       = every payable segment × its frozen rate, with the FLSA 1.5×
 *                 on the minutes past 40 in a Monday–Sunday workweek. A payable
 *                 segment is a closed shift, plus job time no shift covered
 *                 (the payroll floor). Job time INSIDE a shift adds nothing —
 *                 the shift already pays it. "Shift hours + job hours" would
 *                 pay those minutes twice.
 *   commissions = Commission.amount, at earnedAt.
 *
 * WHEN IT COUNTS — the month the hours were WORKED, not a pay date (accrual).
 * Chosen deliberately over a payroll-run / paid-week record:
 *   - Nothing in the app records when Kyle actually pays. There is no payroll
 *     run; the week view is computed on the fly. A "paid" marker would be a
 *     new model that only becomes true when somebody clicks it, and until then
 *     the P&L would be wrong in a new way (a week nobody marked = wages that
 *     never happened). Kyle has to do nothing for this line to be right.
 *   - The Expenses column is already accrual where the app has no payment
 *     event: a CompanyBill lands in its month by its schedule (PUNCHLIST A6),
 *     with nothing confirming it was paid. Payroll is the same kind of standing
 *     obligation and lands the same way.
 *   - Phase 8 (bank import) already plans for this: a Chase payroll line is
 *     ALREADY COUNTED against this ledger, the way a bank line confirms a bill.
 *     The paid event arrives from the statement, not from a hand-set flag.
 *   - Commission.paidAt is a settlement marker for the Team view. Nothing sets
 *     it today, so anchoring the P&L on it would put $0 of commissions on the
 *     books — hence earnedAt, which also matches the Team week.
 *
 * A WEEK THAT SPANS A MONTH BOUNDARY: the 40-hour walk runs on the WHOLE week
 * (it must, or the overtime line moves), and then each segment lands in the
 * month of its own start. Mon–Wed in September, Thu–Sun in October; an overtime
 * premium lands in the month of the segment that crossed 40. A shift that runs
 * past midnight on the last day of a month belongs to the month it started in.
 * The same rule keeps a week straddling New Year whole: December's segments go
 * to the old year, January's to the new, and each is counted exactly once.
 *
 * FLAGGED, UNCONFIRMED HOURS DO NOT COUNT (rule 5, the same predicate as every
 * other total): a clock left running past 12 hours stopped accruing and its
 * real end is unknown. When the technician or Kyle confirms it, the hours land
 * in the month they were worked — a past month's payroll can rise after a
 * confirmation, which is honest: the number was unknown, not zero.
 *
 * NO RATE = HOURS BUT NO COST (rule 6). Those minutes are reported as
 * unratedMinutes so the P&L can say "N hours have no rate on file" rather than
 * silently booking $0.
 *
 * TEST ACCOUNT: a session on a test job never reaches this ledger
 * (EXCLUDE_TEST_CUSTOMER_VIA_VISIT) and a commission on a test job stays out
 * (EXCLUDE_TEST_VISIT). A shift is company time and has no customer; it counts
 * whatever job was worked inside it.
 *
 * COUNTED ONCE. Job profitability (services/jobCosting.ts, /financials/
 * job-profitability, the job card) shows labour PER JOB — hours × the company
 * labor rate — as that job's own margin line. It is a per-job view of the same
 * hours, never added to Expenses. The P&L's Expenses carries wages here, once,
 * and does not add job labour on top.
 */

import { prisma } from "../lib/prisma";
import { EXCLUDE_TEST_CUSTOMER_VIA_VISIT, EXCLUDE_TEST_VISIT } from "./accountSpine";
import { attributeWorkweek, payableSegments, weekOf, type PayableEntry } from "./timeTracking";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One technician, one workweek, the part of it that fell in one month. */
export interface WageRow {
  month: number;
  technicianId: string;
  technicianName: string;
  /** Monday 00:00 local of the workweek this pay belongs to. */
  weekStart: Date;
  /** Earliest counted segment in this bucket — the CSV's date column. */
  date: Date;
  minutes: number;
  regularMinutes: number;
  overtimeMinutes: number;
  /** Straight time + the overtime premium, at the frozen rates. */
  amount: number;
}

export interface CommissionRow {
  month: number;
  technicianId: string;
  technicianName: string;
  basis: string;
  percent: number | null;
  amount: number;
  note: string | null;
  earnedAt: Date;
  paidAt: Date | null;
}

export interface PayrollYear {
  year: number;
  wageRows: WageRow[];
  commissionRows: CommissionRow[];
  /** Counted minutes with no rate on file, per month (0-11) — hours, but $0. */
  unratedMinutes: number[];
}

type WeekBucket = { shifts: PayableEntry[]; sessions: PayableEntry[] };

/**
 * The company's payroll for a calendar year, bucketed by month. Loads every
 * shift and job session whose workweek touches the year (a straddling week is
 * walked whole), groups by technician × workweek, runs the SAME floor-and-walk
 * the Team week runs, and drops each segment into the month it started in.
 */
export async function payrollForYear(year: number): Promise<PayrollYear> {
  // The weeks that touch the year, whole — the 40-hour walk needs every segment.
  const rangeStart = weekOf(new Date(year, 0, 1)).start;
  const rangeEnd = weekOf(new Date(year, 11, 31)).end;
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year + 1, 0, 1);

  const entrySelect = {
    id: true, technicianId: true, startedAt: true, endedAt: true, minutes: true,
    rateApplied: true, flaggedAt: true, confirmedAt: true,
  } as const;

  const [technicians, shifts, sessions, commissions] = await Promise.all([
    prisma.technician.findMany({ select: { id: true, name: true, hourlyRate: true } }),
    prisma.shiftEntry.findMany({
      where: { startedAt: { gte: rangeStart, lte: rangeEnd } },
      select: entrySelect,
    }),
    // Hours on a test job are practice, not payroll (Kyle, 2026-09-11).
    prisma.timeEntry.findMany({
      where: { startedAt: { gte: rangeStart, lte: rangeEnd }, technicianId: { not: null }, ...EXCLUDE_TEST_CUSTOMER_VIA_VISIT },
      select: entrySelect,
    }),
    prisma.commission.findMany({
      where: { earnedAt: { gte: yearStart, lt: yearEnd }, ...EXCLUDE_TEST_VISIT },
      orderBy: { earnedAt: "asc" },
      select: {
        technicianId: true, basis: true, percent: true, amount: true, note: true, earnedAt: true, paidAt: true,
        technician: { select: { name: true } },
      },
    }),
  ]);

  const techById = new Map(technicians.map((t) => [t.id, t]));

  // technician → workweek (Monday ms) → the rows in it.
  const weeks = new Map<string, Map<number, WeekBucket>>();
  const bucketFor = (technicianId: string, startedAt: Date): WeekBucket => {
    const weekKey = weekOf(startedAt).start.getTime();
    const byWeek = weeks.get(technicianId) ?? new Map<number, WeekBucket>();
    weeks.set(technicianId, byWeek);
    const bucket = byWeek.get(weekKey) ?? { shifts: [], sessions: [] };
    byWeek.set(weekKey, bucket);
    return bucket;
  };
  for (const s of shifts) bucketFor(s.technicianId, s.startedAt).shifts.push(s);
  for (const e of sessions) bucketFor(e.technicianId!, e.startedAt).sessions.push(e);

  const wageRows: WageRow[] = [];
  const unratedMinutes = Array(12).fill(0) as number[];

  for (const [technicianId, byWeek] of weeks) {
    const tech = techById.get(technicianId);
    for (const [weekKey, bucket] of byWeek) {
      const segments = payableSegments(bucket.shifts, bucket.sessions, tech?.hourlyRate ?? null);
      const walk = attributeWorkweek(segments);
      // One row per month the week touched — usually one, two at a boundary.
      const byMonth = new Map<number, WageRow>();
      for (const seg of walk.segments) {
        const at = new Date(seg.startedAt);
        if (at.getFullYear() !== year) continue; // the other year's half of a straddling week
        const month = at.getMonth();
        if (seg.rateApplied == null) {
          unratedMinutes[month] += seg.minutes;
          continue;
        }
        const row = byMonth.get(month) ?? {
          month,
          technicianId,
          technicianName: tech?.name ?? technicianId,
          weekStart: new Date(weekKey),
          date: at,
          minutes: 0,
          regularMinutes: 0,
          overtimeMinutes: 0,
          amount: 0,
        };
        if (at < row.date) row.date = at;
        row.minutes += seg.minutes;
        row.regularMinutes += seg.regularMinutes;
        row.overtimeMinutes += seg.overtimeMinutes;
        row.amount += seg.pay;
        byMonth.set(month, row);
      }
      for (const row of byMonth.values()) {
        row.amount = round2(row.amount);
        if (row.amount > 0 || row.minutes > 0) wageRows.push(row);
      }
    }
  }
  wageRows.sort((a, b) => a.date.getTime() - b.date.getTime() || a.technicianName.localeCompare(b.technicianName));

  return {
    year,
    wageRows,
    commissionRows: commissions.map((c) => ({
      month: c.earnedAt.getMonth(),
      technicianId: c.technicianId,
      technicianName: c.technician.name,
      basis: c.basis,
      percent: c.percent,
      amount: c.amount,
      note: c.note,
      earnedAt: c.earnedAt,
      paidAt: c.paidAt,
    })),
    unratedMinutes,
  };
}
