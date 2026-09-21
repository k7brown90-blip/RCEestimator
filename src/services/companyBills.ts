/**
 * Which months a company bill lands in. Lived in routes/financials.ts until 2026-09-21; moved
 * here so the bank ledger (services/bankLedger.ts — "which scheduled bill-months has a
 * statement confirmed?") can share the one schedule rule without a route importing a service
 * that imports the route. routes/financials.ts re-exports it, so nothing that imported it there
 * moved.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { EXCLUDE_TEST_CARD_SPEND } from "./accountSpine";

export interface BillSchedule {
  cadence: string;
  amount: number;
  billDate: Date | null;
  startDate: Date | null;
  endDate: Date | null;
}

/** Which months (0-11) of `year` a bill lands in, and at what amount. */
export function billMonthsInYear(bill: BillSchedule, year: number): { month: number; amount: number }[] {
  if (bill.cadence === "one_time") {
    if (!bill.billDate || bill.billDate.getFullYear() !== year) return [];
    return [{ month: bill.billDate.getMonth(), amount: bill.amount }];
  }
  if (!bill.startDate) return [];
  const start = bill.startDate;
  const end = bill.endDate;
  const out: { month: number; amount: number }[] = [];
  for (let month = 0; month < 12; month++) {
    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 0);
    if (monthEnd < start) continue;
    if (end && monthStart > end) continue;
    if (bill.cadence === "monthly") out.push({ month, amount: bill.amount });
    else if (bill.cadence === "weekly") {
      // Monthly equivalent — 52 weeks across 12 months. Approximate by design;
      // the report labels it as a weekly bill's monthly share.
      out.push({ month, amount: Math.round((bill.amount * 52) / 12 * 100) / 100 });
    } else if (bill.cadence === "quarterly") {
      const monthsSinceStart = (year - start.getFullYear()) * 12 + (month - start.getMonth());
      if (monthsSinceStart >= 0 && monthsSinceStart % 3 === 0) out.push({ month, amount: bill.amount });
    } else if (bill.cadence === "annual") {
      if (month === start.getMonth()) out.push({ month, amount: bill.amount });
    }
  }
  return out;
}

// ─── The bill-matching vocabulary, shared by the bank importer and the card ledger ────────────

/** "YYYY-MM" of a (year, month 0-11) — the bill-month key. */
export function monthKeyOf(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** The bill-month a charge could be paying: its own month first, then the one before, then the one after. */
export function adjacentMonthKeys(d: Date): string[] {
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return [monthKeyOf(d.getFullYear(), d.getMonth()), monthKeyOf(prev.getFullYear(), prev.getMonth()), monthKeyOf(next.getFullYear(), next.getMonth())];
}

const STOP_WORDS = new Set(["THE", "AND", "INC", "LLC", "CO", "COMPANY", "PAYMENT", "PAYMENTS", "BILL", "AUTOPAY", "SERVICE", "SERVICES", "MONTHLY"]);
/** The words of a bill's name worth matching against a statement description or a card merchant. */
export function nameTokens(name: string): string[] {
  return name.toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

export const cents = (n: number) => Math.round(n * 100);

// ─── A card charge that IS a bill's payment ──────────────────────────────────────────────────
//
// Kyle, 2026-09-21: "the actual charge is the source of truth." A recurring bill paid on the
// Stripe card (software, insurance) used to reach Expenses TWICE — once as the CardSpend row and
// once as the scheduled bill-month (PUNCHLIST M6). The same match the bank importer makes for a
// statement line (amount + a word of the bill's name + an unconfirmed month nearby) is made here
// for a card charge, with one difference in what it means:
//
//   a BANK line confirms the bill-month and adds nothing — the scheduled amount stays the money
//   (services/bankStatements.ts rule 7, "confirm, never replace");
//   a CARD charge confirms the bill-month and REPLACES it — the charge is already in Expenses at
//   its own amount (routes/financials.ts spendRows), so that month's scheduled amount drops out.
//
// Derived, never written: nothing is stamped on CompanyBill or CardSpend, so ignoring the charge
// (or deleting the bill) undoes the confirmation by itself. One charge confirms at most one
// bill-month; a bill-month is taken by at most one charge; an ignored charge confirms nothing
// because it is not in the population offered here (the caller passes exactly the charges the
// P&L counts). A bill-month the bank ALSO confirmed still drops exactly once — the bank line was
// already adding nothing, so there is nothing to subtract twice.

export interface BillForCardMatch extends BillSchedule {
  id: string;
  name: string;
}

export interface CardChargeForBills {
  id: string;
  merchantName: string;
  amount: number;
  occurredAt: Date;
}

export interface CardBillConfirmation {
  billId: string;
  /** "YYYY-MM" */
  month: string;
  spendId: string;
  merchant: string;
  amount: number;
  occurredAt: Date;
}

/** `${billId}:${YYYY-MM}` — the key both the P&L and the Bills card look a confirmation up by. */
export const billMonthKey = (billId: string, month: string) => `${billId}:${month}`;

/**
 * Pure: which scheduled bill-months these card charges pay. Deterministic — charges are walked
 * oldest first (ties by id), so the same rows always confirm the same months whichever year is
 * being read. Pass ALL the live charges that could match (the async loader below does), never a
 * one-year slice: a January charge may pay December's bill.
 */
export function confirmBillMonthsByCard(bills: BillForCardMatch[], charges: CardChargeForBills[]): Map<string, CardBillConfirmation> {
  const out = new Map<string, CardBillConfirmation>();
  if (bills.length === 0 || charges.length === 0) return out;
  const years = [...new Set(charges.flatMap((c) => [c.occurredAt.getFullYear() - 1, c.occurredAt.getFullYear(), c.occurredAt.getFullYear() + 1]))].sort();
  const schedule = bills.map((bill) => ({
    bill,
    tokens: nameTokens(bill.name),
    months: new Set(years.flatMap((y) => billMonthsInYear(bill, y).map((m) => monthKeyOf(y, m.month)))),
  }));
  const ordered = [...charges].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
  for (const charge of ordered) {
    if (!(charge.amount > 0)) continue; // a refund is negative and pays nothing
    const merchant = charge.merchantName.toUpperCase();
    // Amount first, then a word of the name — exactly one bill may claim the charge (rule 7 of
    // the bank importer: two bills of the same amount at this merchant is a question, not a match).
    const named = schedule.filter((s) => cents(s.bill.amount) === cents(charge.amount) && s.tokens.some((t) => merchant.includes(t)));
    if (named.length !== 1) continue;
    const s = named[0];
    const month = adjacentMonthKeys(charge.occurredAt).find((key) => s.months.has(key) && !out.has(billMonthKey(s.bill.id, key)));
    if (!month) continue;
    out.set(billMonthKey(s.bill.id, month), {
      billId: s.bill.id, month, spendId: charge.id, merchant: charge.merchantName, amount: charge.amount, occurredAt: charge.occurredAt,
    });
  }
  return out;
}

/**
 * The confirmations as the database stands: every company bill against every LIVE card charge
 * whose amount equals some bill's amount. The charge population is the P&L's own (routes/
 * financials.ts spendRows: not ignored, not the test account's) — a charge the P&L does not
 * count cannot take a bill-month off it.
 */
export async function cardConfirmedBillMonths(db: PrismaClient | Prisma.TransactionClient): Promise<Map<string, CardBillConfirmation>> {
  const bills = await db.companyBill.findMany({ select: { id: true, name: true, amount: true, cadence: true, billDate: true, startDate: true, endDate: true } });
  if (bills.length === 0) return new Map();
  const amounts = [...new Set(bills.map((b) => cents(b.amount)))];
  const charges = await db.cardSpend.findMany({
    where: {
      status: { not: "ignored" },
      // EXCLUDE_TEST_CARD_SPEND is itself an OR — it goes under AND beside ours (constants, "Two Prisma traps").
      AND: [EXCLUDE_TEST_CARD_SPEND, { OR: amounts.map((c) => ({ amount: { gte: (c - 0.5) / 100, lte: (c + 0.5) / 100 } })) }],
    },
    select: { id: true, merchantName: true, amount: true, occurredAt: true },
  });
  return confirmBillMonthsByCard(bills, charges);
}
