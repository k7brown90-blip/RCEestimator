/**
 * Which months a company bill lands in. Lived in routes/financials.ts until 2026-09-21; moved
 * here so the bank ledger (services/bankLedger.ts — "which scheduled bill-months has a
 * statement confirmed?") can share the one schedule rule without a route importing a service
 * that imports the route. routes/financials.ts re-exports it, so nothing that imported it there
 * moved.
 */

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
