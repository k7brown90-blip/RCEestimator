/**
 * What the bank lines mean to the rest of the app — the reads (services/bankStatements.ts is
 * the writes). Three questions:
 *
 *   1. What does the P&L add?  `bankExpenseRowsForYear` — ONLY lines classified `expense`,
 *      as positive amounts in the month posted. A transfer, an already-counted line, an
 *      ignored line and an unclassified line add nothing. This is the fifth source in
 *      routes/financials.ts yearLedger (after card charges, typed P.O. amounts, bills, fees
 *      and payroll) and the once-only rule tests/bankImport.test.ts pins.
 *
 *   2. What is still provisional?  `confirmationsForYear` — every scheduled bill-month and
 *      every typed not-on-card P.O. amount, with whether a bank line confirmed it. A
 *      bill-month a statement COVERS but nothing confirms is the prize Kyle asked for: "a
 *      bill you may have stopped paying, and now it is visible" (PUNCHLIST A6).
 *
 *   3. What is in the bank?  `accountsWithBalances` — each registered account with the
 *      running balance after the newest imported statement, labelled AS OF that statement.
 *      Honest staleness beats a fake live number; Plaid later replaces the source and not
 *      this shape.
 */

import { prisma } from "../lib/prisma";
import { billMonthsInYear } from "./companyBills";
import { EXCLUDE_TEST_JOB } from "./accountSpine";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface BankExpenseRow {
  lineId: string;
  month: number;
  /** Positive = money out. A credit classified as an expense (a refund by ACH) is negative, like a card refund. */
  amount: number;
  category: string;
  description: string;
  accountName: string;
  date: Date;
}

/** The P&L's fifth expense source: `expense` lines only, in the month posted. */
export async function bankExpenseRowsForYear(year: number): Promise<BankExpenseRow[]> {
  const from = new Date(`${year}-01-01`);
  const to = new Date(`${year + 1}-01-01`);
  const lines = await prisma.bankLine.findMany({
    where: { classification: "expense", postedAt: { gte: from, lt: to } },
    orderBy: { postedAt: "asc" },
    select: { id: true, postedAt: true, amount: true, category: true, description: true, account: { select: { name: true } } },
  });
  return lines.map((l) => ({
    lineId: l.id,
    month: l.postedAt.getMonth(),
    amount: round2(-l.amount),
    category: l.category ?? "other",
    description: l.description,
    accountName: l.account.name,
    date: l.postedAt,
  }));
}

export interface BankQueueSummary {
  /** Lines nobody has classified, every year — the queue is not year-scoped. */
  unclassified: number;
  /** Their money out, summed as a positive figure (money in is not included). */
  unclassifiedOut: number;
  lastImportAt: Date | null;
  accounts: number;
}

/** For the P&L's honesty line: how much is sitting in the queue and so NOT in Expenses yet. */
export async function bankQueueSummary(): Promise<BankQueueSummary> {
  const [lines, last, accounts] = await Promise.all([
    prisma.bankLine.findMany({ where: { classification: "unclassified" }, select: { amount: true } }),
    prisma.bankStatement.findFirst({ orderBy: { importedAt: "desc" }, select: { importedAt: true } }),
    prisma.bankAccount.count({ where: { isActive: true } }),
  ]);
  return {
    unclassified: lines.length,
    unclassifiedOut: round2(lines.filter((l) => l.amount < 0).reduce((s, l) => s - l.amount, 0)),
    lastImportAt: last?.importedAt ?? null,
    accounts,
  };
}

// ─── Coverage: which months an operating account's statements have been imported for ──────

/**
 * A month is COVERED when some operating-account statement's period reaches its last day —
 * only then can "no line confirms this bill-month" mean anything. A month nothing covers is
 * "not imported", never "unconfirmed".
 */
async function coveredMonths(year: number): Promise<Set<string>> {
  const statements = await prisma.bankStatement.findMany({
    where: { account: { purpose: "operating", isActive: true }, periodStart: { not: null }, periodEnd: { not: null } },
    select: { periodStart: true, periodEnd: true },
  });
  const covered = new Set<string>();
  for (let month = 0; month < 12; month += 1) {
    // Local month bounds, compared as calendar days (statement dates sit at UTC noon).
    const monthEnd = Date.UTC(year, month + 1, 0, 12);
    const monthStart = Date.UTC(year, month, 1, 12);
    if (statements.some((s) => s.periodStart!.getTime() <= monthStart + 3 * 24 * 3600 * 1000 && s.periodEnd!.getTime() >= monthEnd)) {
      covered.add(`${year}-${String(month + 1).padStart(2, "0")}`);
    }
  }
  return covered;
}

export type ConfirmationStatus = "confirmed" | "unconfirmed" | "not_imported" | "not_on_bank";

export interface BillMonthConfirmation {
  billId: string;
  name: string;
  /** "YYYY-MM" */
  month: string;
  scheduled: number;
  status: Exclude<ConfirmationStatus, "not_on_bank">;
  /** The confirming line, when confirmed — and how far the bank's figure sat from the scheduled amount. */
  line: { id: string; postedAt: Date; amount: number; description: string; variance: number } | null;
}

export interface PoConfirmation {
  purchaseOrderId: string;
  number: string;
  supplier: string;
  typed: number;
  method: string | null;
  offCardAt: Date;
  status: ConfirmationStatus;
  line: { id: string; postedAt: Date; amount: number; description: string } | null;
}

export interface Confirmations {
  year: number;
  coveredMonths: string[];
  bills: BillMonthConfirmation[];
  purchaseOrders: PoConfirmation[];
  /** Bill-months a statement covers and nothing confirms — the "stopped paying?" list. */
  unconfirmedBillMonths: number;
}

/** Every scheduled bill-month and typed P.O. amount for the year, against the lines that confirm them. */
export async function confirmationsForYear(year: number): Promise<Confirmations> {
  const from = new Date(`${year}-01-01`);
  const to = new Date(`${year + 1}-01-01`);
  const [bills, pos, lines, covered] = await Promise.all([
    prisma.companyBill.findMany({ orderBy: { name: "asc" } }),
    prisma.purchaseOrder.findMany({
      where: { AND: [EXCLUDE_TEST_JOB, { offCardAmount: { not: null }, offCardAt: { gte: from, lt: to } }] },
      orderBy: { offCardAt: "asc" },
      select: { id: true, number: true, supplier: true, offCardAmount: true, offCardMethod: true, offCardAt: true },
    }),
    prisma.bankLine.findMany({
      where: { classification: "already_counted", matchedKind: { in: ["company_bill", "po_off_card"] } },
      select: { id: true, postedAt: true, amount: true, description: true, matchedKind: true, matchedId: true, matchedMonth: true },
    }),
    coveredMonths(year),
  ]);
  const byBillMonth = new Map(lines.filter((l) => l.matchedKind === "company_bill").map((l) => [`${l.matchedId}:${l.matchedMonth}`, l]));
  const byPo = new Map(lines.filter((l) => l.matchedKind === "po_off_card").map((l) => [l.matchedId!, l]));

  const billRows: BillMonthConfirmation[] = [];
  for (const bill of bills) {
    for (const hit of billMonthsInYear(bill, year)) {
      const month = `${year}-${String(hit.month + 1).padStart(2, "0")}`;
      const line = byBillMonth.get(`${bill.id}:${month}`);
      billRows.push({
        billId: bill.id,
        name: bill.name,
        month,
        scheduled: hit.amount,
        status: line ? "confirmed" : covered.has(month) ? "unconfirmed" : "not_imported",
        line: line ? { id: line.id, postedAt: line.postedAt, amount: line.amount, description: line.description, variance: round2(-line.amount - hit.amount) } : null,
      });
    }
  }
  const poRows: PoConfirmation[] = pos.map((po) => {
    const line = byPo.get(po.id);
    const month = `${po.offCardAt!.getFullYear()}-${String(po.offCardAt!.getMonth() + 1).padStart(2, "0")}`;
    // Cash and a personal card never show on the business statement — nothing to confirm.
    const offBank = po.offCardMethod === "cash" || po.offCardMethod === "personal_card";
    return {
      purchaseOrderId: po.id,
      number: po.number,
      supplier: po.supplier,
      typed: po.offCardAmount!,
      method: po.offCardMethod,
      offCardAt: po.offCardAt!,
      status: line ? "confirmed" : offBank ? "not_on_bank" : covered.has(month) ? "unconfirmed" : "not_imported",
      line: line ? { id: line.id, postedAt: line.postedAt, amount: line.amount, description: line.description } : null,
    };
  });
  return {
    year,
    coveredMonths: [...covered].sort(),
    bills: billRows,
    purchaseOrders: poRows,
    unconfirmedBillMonths: billRows.filter((b) => b.status === "unconfirmed").length,
  };
}

// ─── The cash panel ──────────────────────────────────────────────────────────

export interface BankAccountView {
  id: string;
  name: string;
  institution: string;
  last4: string | null;
  kind: string;
  purpose: string;
  isActive: boolean;
  createdAt: Date;
  /** The newest statement that carried a balance — null until one is imported. */
  balance: { amount: number; asOf: Date; statementId: string; fileName: string; importedAt: Date } | null;
  statementCount: number;
  lineCount: number;
  unclassified: number;
}

export async function accountsWithBalances(): Promise<BankAccountView[]> {
  const accounts = await prisma.bankAccount.findMany({
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    include: {
      statements: { where: { closingBalance: { not: null }, balanceAsOf: { not: null } }, orderBy: [{ balanceAsOf: "desc" }, { importedAt: "desc" }], take: 1 },
      _count: { select: { statements: true, lines: true } },
    },
  });
  const queue = await prisma.bankLine.groupBy({ by: ["accountId"], where: { classification: "unclassified" }, _count: { _all: true } });
  const queueBy = new Map(queue.map((q) => [q.accountId, q._count._all]));
  return accounts.map((a) => {
    const latest = a.statements[0];
    return {
      id: a.id,
      name: a.name,
      institution: a.institution,
      last4: a.last4,
      kind: a.kind,
      purpose: a.purpose,
      isActive: a.isActive,
      createdAt: a.createdAt,
      balance: latest ? { amount: latest.closingBalance!, asOf: latest.balanceAsOf!, statementId: latest.id, fileName: latest.fileName, importedAt: latest.importedAt } : null,
      statementCount: a._count.statements,
      lineCount: a._count.lines,
      unclassified: queueBy.get(a.id) ?? 0,
    };
  });
}
