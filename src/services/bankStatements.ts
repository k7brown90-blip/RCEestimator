/**
 * Bank statement import (Kyle, 2026-09-20): "I can manually upload the bank statements each
 * month from each account. Plaid can be used at a later date when its established." And:
 * "Having everything tracked in one place would make it easier."
 *
 * Until 2026-09-21 the P&L knew only money that touched the Stripe card, bills Kyle typed and
 * payroll from the hours ledger. Everything paid by ACH or autopay out of Chase was invisible.
 * This file is the manual-upload SOURCE — the parsers, the line identity, the classifier and
 * the edits. Plaid later is a second source that writes the same BankLine rows (a statement
 * row per pull, lines keyed the same way, `autoClassify` after); nothing downstream
 * (services/bankLedger.ts, the P&L) knows which source a line came from.
 *
 * ── THE WHOLE DESIGN IS THE CLASSIFICATION ─────────────────────────────────────────────────
 * Every line is exactly one of:
 *   expense          new money out — reaches Expenses on the P&L, once, in the month posted
 *   transfer         between our own accounts — a set-aside into capital / overhead / tax
 *                    savings, the same money coming back, or anything to/from Stripe
 *   already_counted  the P&L has this money by another route (the four double-count traps)
 *   ignored          not the business's money, with a reason
 *   unclassified     the queue Kyle works
 * ONLY `expense` adds to the P&L. The rest add nothing — pinned by tests/bankImport.test.ts.
 *
 * ── THE FOUR DOUBLE-COUNT TRAPS, each detected here ───────────────────────────────────────
 *  1. Stripe card spend is already on the P&L (CardSpend). A Chase line to or from Stripe —
 *     funding the card's financial account, the month-end sweep landing, a payout — is a
 *     TRANSFER (kind "stripe"). Detected by the word STRIPE in the description.
 *  2. Payroll comes from the hours ledger (services/payrollLedger.ts, accrual on the month
 *     worked). A Chase line that says PAYROLL, or a Zelle/ACH to a technician by name, is
 *     ALREADY COUNTED (kind "payroll"). Never a second expense.
 *  3. A purchase paid off-card already has a typed amount on its P.O.
 *     (PurchaseOrder.offCardAmount). A line whose amount equals a typed amount within three
 *     weeks of offCardAt MATCHES that P.O. (kind "po_off_card") rather than adding. The typed
 *     amount stays the money — it is also the job's material cost — and the line confirms it.
 *  4. Autopay bills. CompanyBill posts to the P&L every scheduled month with nothing
 *     confirming payment (PUNCHLIST A6). A line whose amount equals a bill's amount, whose
 *     description carries a word of the bill's name, and for which that bill has an
 *     unconfirmed scheduled month nearby, CONFIRMS that bill-month (kind "company_bill").
 *     The bill's scheduled amount stays the money; the line confirms it. The inverse is the
 *     prize: a scheduled bill-month a statement covers but no line confirms is a bill you may
 *     have stopped paying — services/bankLedger.ts lists them.
 *
 * A TAX PAYMENT OUT OF THE TAX ACCOUNT IS KYLE'S RULING. A savings-account line that is not a
 * transfer to a registered account is left unclassified with the hint written out; no rule
 * here decides it.
 *
 * ── MEMORY ────────────────────────────────────────────────────────────────────────────────
 * When Kyle classifies a line, the next line with the same PAYEE (payeeKey — the description
 * with ids, dates and store numbers stripped) is classified the same way, and says so in its
 * reason. No rule table: the memory IS the lines Kyle classified, so the exit is the same as
 * everything else here — reclassify the line. A P.O. match is one-off and never remembered.
 *
 * ── IDEMPOTENCY ───────────────────────────────────────────────────────────────────────────
 * File: sha256 of the bytes, unique per account — the same statement uploaded twice imports
 * nothing the second time. Line: `lineKeyOf` — the bank's own FITID when the file has one
 * (OFX), else posted date + cents + normalised description + reference + the occurrence index
 * of that tuple within the file (two identical $5 fees on one day are two lines). Unique per
 * account, so an overlapping export (a re-download with a wider date range) skips what is
 * already there and imports only the new lines.
 */

import crypto from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logSystemEvent } from "./systemEvents";
import { billMonthsInYear } from "./companyBills";
import { EXCLUDE_TEST_JOB, EXCLUDE_TEST_PAYER } from "./accountSpine";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const ACCOUNT_KINDS = ["checking", "savings"] as const;
export const ACCOUNT_PURPOSES = ["operating", "capital", "overhead_savings", "tax"] as const;
export type AccountPurpose = (typeof ACCOUNT_PURPOSES)[number];
/** Money moved INTO one of these is a set-aside, never an expense (Kyle, 2026-09-20). */
export const SET_ASIDE_PURPOSES: ReadonlySet<string> = new Set(["capital", "overhead_savings", "tax"]);

export const CLASSIFICATIONS = ["unclassified", "expense", "transfer", "already_counted", "ignored"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const TRANSFER_KINDS = ["stripe", "set_aside", "set_aside_return", "own_accounts"] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];
export const COUNTED_KINDS = ["payroll", "po_off_card", "company_bill", "payment"] as const;
export type CountedKind = (typeof COUNTED_KINDS)[number];
/** The P&L categories a bank expense can carry — the bill and card-spend vocabularies joined. */
export const EXPENSE_CATEGORIES = [
  "overhead", "insurance", "vehicle", "software", "marketing", "materials", "tools", "gas",
  "maintenance", "permit", "inspection", "tax", "bank_fees", "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export class BankError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "BankError";
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const cents = (n: number) => Math.round(n * 100);
const DAY = 24 * 60 * 60 * 1000;
/** How far a bank line may sit from the P.O.'s offCardAt / the payment's paidAt and still match. */
const MATCH_WINDOW_DAYS = 21;

/** "YYYY-MM" of a local date — the bill-month key. */
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthKeyOf(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}
function adjacentMonthKeys(d: Date): string[] {
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return [monthKey(d), monthKey(prev), monthKey(next)];
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

export interface ParsedLine {
  postedAt: Date;
  amount: number;
  description: string;
  bankRef: string | null;
  bankType: string | null;
  runningBalance: number | null;
}

export interface ParsedStatement {
  format: "chase_csv" | "csv" | "ofx";
  lines: ParsedLine[];
  periodStart: Date | null;
  periodEnd: Date | null;
  closingBalance: number | null;
  balanceAsOf: Date | null;
  /** Last four of the account id when the file names it (OFX ACCTID). */
  accountLast4: string | null;
}

/** A date-only value at UTC noon: the same calendar day in every zone this business runs in. */
function dateOnly(y: number, m: number, d: number): Date | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** MM/DD/YYYY (Chase), YYYY-MM-DD, or M/D/YY. */
export function parseDate(raw: string): Date | null {
  const s = raw.trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return dateOnly(y, Number(m[1]), Number(m[2]));
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return dateOnly(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

function parseMoney(raw: string): number | null {
  const s = raw.trim().replace(/[$,\s]/g, "");
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()]/g, ""));
  if (!Number.isFinite(n)) return null;
  return round2(neg ? -n : n);
}

/** RFC-4180-ish: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9#]/g, "");

/**
 * Chase's activity export: `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #`
 * (checking and savings alike). Any CSV with a date, a description and an amount column — or
 * separate debit/credit columns — parses the same way; Chase is recognised by its header.
 */
function parseCsvStatement(text: string): ParsedStatement {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length < 2) throw new BankError("The file has no statement lines under its header.", 400);
  const header = rows[0].map(norm);
  // Names in PREFERENCE order: Chase's first column is "Details" (DEBIT/CREDIT), not the description.
  const col = (...names: string[]) => {
    for (const name of names) {
      const i = header.indexOf(name);
      if (i >= 0) return i;
    }
    return -1;
  };
  const isChase = col("postingdate") >= 0 && col("description") >= 0 && col("amount") >= 0;
  const dateCol = isChase ? col("postingdate") : col("postingdate", "date", "transactiondate", "posteddate", "postdate");
  const descCol = col("description", "memo", "name", "payee", "details");
  const amountCol = col("amount");
  const debitCol = col("debit", "withdrawal", "withdrawals");
  const creditCol = col("credit", "deposit", "deposits");
  const typeCol = col("type", "transactiontype");
  const balanceCol = col("balance", "runningbalance");
  const refCol = col("checkorslip#", "checknumber", "check#", "reference", "referencenumber");
  if (dateCol < 0 || descCol < 0 || (amountCol < 0 && debitCol < 0 && creditCol < 0)) {
    throw new BankError("This CSV has no date, description and amount columns — export the account activity from Chase as CSV, or an OFX/QFX file.", 400);
  }
  const lines: ParsedLine[] = [];
  for (const r of rows.slice(1)) {
    const postedAt = parseDate(r[dateCol] ?? "");
    if (!postedAt) continue;
    let amount: number | null = null;
    if (amountCol >= 0) amount = parseMoney(r[amountCol] ?? "");
    if (amount === null && (debitCol >= 0 || creditCol >= 0)) {
      const debit = debitCol >= 0 ? parseMoney(r[debitCol] ?? "") ?? 0 : 0;
      const credit = creditCol >= 0 ? parseMoney(r[creditCol] ?? "") ?? 0 : 0;
      amount = round2(credit - Math.abs(debit));
    }
    if (amount === null) continue;
    const description = (r[descCol] ?? "").trim();
    if (!description && amount === 0) continue;
    lines.push({
      postedAt,
      amount,
      description: description || "(no description)",
      bankRef: refCol >= 0 && (r[refCol] ?? "").trim() ? (r[refCol] ?? "").trim() : null,
      bankType: typeCol >= 0 && (r[typeCol] ?? "").trim() ? (r[typeCol] ?? "").trim().toUpperCase() : null,
      runningBalance: balanceCol >= 0 ? parseMoney(r[balanceCol] ?? "") : null,
    });
  }
  if (lines.length === 0) throw new BankError("No statement lines could be read from the file.", 400);
  // Newest-first is Chase's order; the running balance after the newest line is the closing figure.
  const newestFirst = lines[0].postedAt.getTime() >= lines[lines.length - 1].postedAt.getTime();
  const latest = lines.reduce((best, l) => (l.postedAt.getTime() > best.postedAt.getTime() ? l : best), lines[0]);
  const latestOnDay = lines.filter((l) => l.postedAt.getTime() === latest.postedAt.getTime());
  const closing = newestFirst ? latestOnDay[0] : latestOnDay[latestOnDay.length - 1];
  const times = lines.map((l) => l.postedAt.getTime());
  return {
    format: isChase ? "chase_csv" : "csv",
    lines,
    periodStart: new Date(Math.min(...times)),
    periodEnd: new Date(Math.max(...times)),
    closingBalance: closing.runningBalance,
    balanceAsOf: closing.runningBalance === null ? null : closing.postedAt,
    accountLast4: null,
  };
}

/** OFX/QFX: SGML-style `<TAG>value` (closing tags optional) or XML. Cheap, and it carries FITIDs. */
function parseOfx(text: string): ParsedStatement {
  const tag = (block: string, name: string): string | null => {
    const m = block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, "i"));
    return m ? m[1].trim() : null;
  };
  const ofxDate = (raw: string | null): Date | null => {
    const m = raw?.match(/^(\d{4})(\d{2})(\d{2})/);
    return m ? dateOnly(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  };
  const blocks = [...text.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi)].map((m) => m[1]);
  const lines: ParsedLine[] = [];
  for (const b of blocks) {
    const postedAt = ofxDate(tag(b, "DTPOSTED"));
    const amount = parseMoney(tag(b, "TRNAMT") ?? "");
    if (!postedAt || amount === null) continue;
    const name = tag(b, "NAME") ?? "";
    const memo = tag(b, "MEMO") ?? "";
    const description = [name, memo && memo !== name ? memo : ""].filter(Boolean).join(" ").trim() || "(no description)";
    const fitid = tag(b, "FITID");
    lines.push({
      postedAt,
      amount,
      description,
      // The FITID is the bank's own identity for the line; the check number rides in the description.
      bankRef: fitid ? `fitid:${fitid}` : tag(b, "CHECKNUM"),
      bankType: tag(b, "TRNTYPE")?.toUpperCase() ?? null,
      runningBalance: null,
    });
  }
  if (lines.length === 0) throw new BankError("No transactions could be read from the OFX file.", 400);
  const acctId = tag(text, "ACCTID");
  const times = lines.map((l) => l.postedAt.getTime());
  const ledger = text.match(/<LEDGERBAL>([\s\S]*?)(?=<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>)/i)?.[1] ?? "";
  return {
    format: "ofx",
    lines,
    periodStart: ofxDate(tag(text, "DTSTART")) ?? new Date(Math.min(...times)),
    periodEnd: ofxDate(tag(text, "DTEND")) ?? new Date(Math.max(...times)),
    closingBalance: parseMoney(tag(ledger, "BALAMT") ?? ""),
    balanceAsOf: ofxDate(tag(ledger, "DTASOF")),
    accountLast4: acctId && acctId.length >= 4 ? acctId.slice(-4) : null,
  };
}

/** Sniffs the format from the bytes — the browser's Content-Type for a .qfx download is not reliable. */
export function parseStatement(file: Buffer | string): ParsedStatement {
  const text = typeof file === "string" ? file : file.toString("utf8");
  if (/OFXHEADER|<OFX>/i.test(text.slice(0, 4000))) return parseOfx(text);
  return parseCsvStatement(text);
}

// ─── Identity ────────────────────────────────────────────────────────────────

export function fileHashOf(file: Buffer): string {
  return crypto.createHash("sha256").update(file).digest("hex");
}

const normDescription = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();

/**
 * The line's identity on its account. The bank's FITID when there is one; else the posted
 * date, the cents, the normalised description, the reference, and which occurrence of that
 * exact tuple this is within the file — so two identical lines on one day are two lines, and
 * the same line in two overlapping exports is one.
 */
export function lineKeyOf(line: ParsedLine, occurrence: number): string {
  const base = line.bankRef?.startsWith("fitid:")
    ? line.bankRef
    : [line.postedAt.toISOString().slice(0, 10), cents(line.amount), normDescription(line.description), line.bankRef ?? "", occurrence].join("|");
  return crypto.createHash("sha256").update(base).digest("hex").slice(0, 40);
}

/** The tuple two lines must share to be "the same line" — what `occurrence` counts. */
function tupleOf(line: ParsedLine): string {
  return [line.postedAt.toISOString().slice(0, 10), cents(line.amount), normDescription(line.description), line.bankRef ?? ""].join("|");
}

/**
 * The payee, normalised: what a classification is remembered by. Chase ACH descriptions name
 * the company after ORIG CO NAME; everything else has its ids, dates, store numbers and
 * masked account digits stripped.
 */
export function payeeKey(description: string): string {
  const upper = description.toUpperCase();
  const orig = upper.match(/ORIG CO NAME:(.+?)\s+(?:ORIG ID|CO ENTRY|DESC DATE|SEC:)/);
  if (orig) return orig[1].replace(/\s+/g, " ").trim().slice(0, 60);
  const cleaned = upper
    .replace(/TRANSACTION\s*#?:?\s*\d+/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " ")
    .replace(/\.{2,}\d+/g, " ")
    .replace(/#\s*\d+/g, " ")
    .replace(/\b[A-Z]*\d[A-Z0-9-]*\b/g, " ")
    .replace(/[^A-Z&' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 60) || upper.slice(0, 60);
}

// ─── The classifier ──────────────────────────────────────────────────────────

export interface RegistryAccount {
  id: string;
  name: string;
  last4: string | null;
  purpose: string;
}

export interface Decision {
  classification: Classification;
  category?: string | null;
  transferKind?: TransferKind | null;
  counterpartyAccountId?: string | null;
  matchedKind?: CountedKind | null;
  matchedId?: string | null;
  matchedMonth?: string | null;
  reason?: string | null;
  hint?: string | null;
}

interface BillCandidate { id: string; name: string; amount: number; months: string[] }
interface PoCandidate { id: string; number: string; supplier: string; offCardAmount: number; offCardAt: Date; offCardMethod: string | null }
interface PaymentCandidate { id: string; amount: number; paidAt: Date; method: string; customerName: string | null }
interface Memory {
  classification: Classification;
  category: string | null;
  transferKind: string | null;
  counterpartyAccountId: string | null;
  matchedKind: string | null;
  matchedId: string | null;
  note: string | null;
  classifiedAt: Date | null;
}

export interface ClassifyContext {
  accounts: RegistryAccount[];
  /** Upper-cased technician names, for the payroll rule. */
  technicians: string[];
  bills: BillCandidate[];
  purchaseOrders: PoCandidate[];
  payments: PaymentCandidate[];
  /** Confirmations other lines already hold — a bill-month, a P.O., a payment can each be confirmed once. */
  confirmedBillMonths: Set<string>;
  confirmedPoIds: Set<string>;
  confirmedPaymentIds: Set<string>;
  /** Kyle's most recent classification per payee. */
  memory: Map<string, Memory>;
}

const STOP_WORDS = new Set(["THE", "AND", "INC", "LLC", "CO", "COMPANY", "PAYMENT", "PAYMENTS", "BILL", "AUTOPAY", "SERVICE", "SERVICES", "MONTHLY"]);
function nameTokens(name: string): string[] {
  return name.toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

function transferKindFor(here: RegistryAccount, other: RegistryAccount, amount: number): TransferKind {
  const landing = amount < 0 ? other : here;
  const leaving = amount < 0 ? here : other;
  if (SET_ASIDE_PURPOSES.has(landing.purpose)) return "set_aside";
  if (SET_ASIDE_PURPOSES.has(leaving.purpose)) return "set_aside_return";
  return "own_accounts";
}

/** Load everything the rules look at, once per run. Scoped to the years the lines touch. */
export async function loadClassifyContext(db: PrismaClient | Prisma.TransactionClient, years: number[]): Promise<ClassifyContext> {
  const yrs = [...new Set(years)].sort();
  const from = new Date(Math.min(...yrs), 0, 1);
  const to = new Date(Math.max(...yrs) + 1, 0, 1);
  const pad = MATCH_WINDOW_DAYS * DAY;
  const [accounts, technicians, bills, pos, payments, confirmations, owned] = await Promise.all([
    db.bankAccount.findMany({ where: { isActive: true }, select: { id: true, name: true, last4: true, purpose: true } }),
    db.technician.findMany({ where: { isActive: true }, select: { name: true } }),
    db.companyBill.findMany(),
    // A test account's P.O. is practice, not money — EXCLUDE_TEST_JOB is itself an OR, so it goes under AND.
    db.purchaseOrder.findMany({
      where: { AND: [EXCLUDE_TEST_JOB, { offCardAmount: { not: null }, offCardAt: { gte: new Date(from.getTime() - pad), lt: new Date(to.getTime() + pad) } }] },
      select: { id: true, number: true, supplier: true, offCardAmount: true, offCardAt: true, offCardMethod: true },
    }),
    db.payment.findMany({
      where: {
        status: "paid", method: { notIn: ["stripe", "discount"] }, paidAt: { gte: new Date(from.getTime() - pad), lt: new Date(to.getTime() + pad) },
        ...EXCLUDE_TEST_PAYER,
      },
      select: { id: true, amount: true, paidAt: true, method: true, customer: { select: { name: true } } },
    }),
    db.bankLine.findMany({
      where: { classification: "already_counted", matchedKind: { in: ["company_bill", "po_off_card", "payment"] } },
      select: { matchedKind: true, matchedId: true, matchedMonth: true },
    }),
    db.bankLine.findMany({
      where: { classifiedBy: "owner", classification: { not: "unclassified" } },
      orderBy: { classifiedAt: "desc" },
      select: { payeeKey: true, classification: true, category: true, transferKind: true, counterpartyAccountId: true, matchedKind: true, matchedId: true, reason: true, classifiedAt: true },
    }),
  ]);
  const memory = new Map<string, Memory>();
  for (const l of owned) {
    if (memory.has(l.payeeKey)) continue; // newest first — the first seen is Kyle's latest ruling
    // A P.O. match is one purchase; a customer payment is one check. Neither is a payee habit.
    if (l.classification === "already_counted" && (l.matchedKind === "po_off_card" || l.matchedKind === "payment")) continue;
    memory.set(l.payeeKey, {
      classification: l.classification as Classification, category: l.category, transferKind: l.transferKind,
      counterpartyAccountId: l.counterpartyAccountId, matchedKind: l.matchedKind, matchedId: l.matchedId, note: l.reason, classifiedAt: l.classifiedAt,
    });
  }
  return {
    accounts,
    technicians: technicians.map((t) => t.name.toUpperCase().replace(/\s+/g, " ").trim()).filter((n) => n.length >= 5),
    bills: bills.map((b) => ({
      id: b.id, name: b.name, amount: b.amount,
      months: yrs.flatMap((y) => billMonthsInYear(b, y).map((m) => monthKeyOf(y, m.month))),
    })),
    purchaseOrders: pos.map((p) => ({ id: p.id, number: p.number, supplier: p.supplier, offCardAmount: p.offCardAmount!, offCardAt: p.offCardAt!, offCardMethod: p.offCardMethod })),
    payments: payments.map((p) => ({ id: p.id, amount: p.amount, paidAt: p.paidAt!, method: p.method, customerName: p.customer?.name ?? null })),
    confirmedBillMonths: new Set(confirmations.filter((c) => c.matchedKind === "company_bill" && c.matchedId && c.matchedMonth).map((c) => `${c.matchedId}:${c.matchedMonth}`)),
    confirmedPoIds: new Set(confirmations.filter((c) => c.matchedKind === "po_off_card" && c.matchedId).map((c) => c.matchedId!)),
    confirmedPaymentIds: new Set(confirmations.filter((c) => c.matchedKind === "payment" && c.matchedId).map((c) => c.matchedId!)),
    memory,
  };
}

/** The bill-month this line would pay: the line's own month first, then the one before, then the one after. */
function openBillMonth(bill: BillCandidate, postedAt: Date, ctx: ClassifyContext): string | null {
  for (const key of adjacentMonthKeys(postedAt)) {
    if (bill.months.includes(key) && !ctx.confirmedBillMonths.has(`${bill.id}:${key}`)) return key;
  }
  return null;
}

export interface LineForRules {
  accountId: string;
  postedAt: Date;
  amount: number;
  description: string;
  bankType: string | null;
  payeeKey: string;
}

/** Candidate matches for a line — what the queue offers Kyle to confirm by hand. */
export function candidatesFor(line: LineForRules, ctx: ClassifyContext): {
  bills: { id: string; name: string; amount: number; month: string }[];
  purchaseOrders: { id: string; number: string; supplier: string; amount: number; date: string; method: string | null }[];
  payments: { id: string; amount: number; date: string; method: string; customerName: string | null }[];
} {
  const out = { bills: [] as { id: string; name: string; amount: number; month: string }[], purchaseOrders: [] as { id: string; number: string; supplier: string; amount: number; date: string; method: string | null }[], payments: [] as { id: string; amount: number; date: string; method: string; customerName: string | null }[] };
  const abs = Math.abs(line.amount);
  if (line.amount < 0) {
    for (const b of ctx.bills) {
      if (cents(b.amount) !== cents(abs)) continue;
      const month = openBillMonth(b, line.postedAt, ctx);
      if (month) out.bills.push({ id: b.id, name: b.name, amount: b.amount, month });
    }
    for (const p of ctx.purchaseOrders) {
      if (ctx.confirmedPoIds.has(p.id) || cents(p.offCardAmount) !== cents(abs)) continue;
      if (Math.abs(p.offCardAt.getTime() - line.postedAt.getTime()) > MATCH_WINDOW_DAYS * DAY) continue;
      out.purchaseOrders.push({ id: p.id, number: p.number, supplier: p.supplier, amount: p.offCardAmount, date: p.offCardAt.toISOString(), method: p.offCardMethod });
    }
  } else if (line.amount > 0) {
    for (const p of ctx.payments) {
      if (ctx.confirmedPaymentIds.has(p.id) || cents(p.amount) !== cents(abs)) continue;
      if (Math.abs(p.paidAt.getTime() - line.postedAt.getTime()) > MATCH_WINDOW_DAYS * DAY) continue;
      out.payments.push({ id: p.id, amount: p.amount, date: p.paidAt.toISOString(), method: p.method, customerName: p.customerName });
    }
  }
  return out;
}

/**
 * The rules, in order. Pure: decides from the context, writes nothing. Every decision carries
 * the reason in words, and every non-decision carries a hint for the queue.
 */
export function classifyLine(line: LineForRules, ctx: ClassifyContext): Decision {
  const here = ctx.accounts.find((a) => a.id === line.accountId);
  const desc = line.description.toUpperCase();
  const hereIsSetAside = !!here && SET_ASIDE_PURPOSES.has(here.purpose);
  const undecided = (hint: string | null): Decision => ({ classification: "unclassified", hint });

  // 1. Between our own accounts — the masked last four in the description names the other side.
  const xfer = desc.match(/TRANSFER\s+(TO|FROM)\b[^0-9]*?(\d{4})\b/) ?? (line.bankType === "ACCT_XFER" || line.bankType === "XFER" ? desc.match(/\.{2,}(\d{4})\b/) : null);
  if (xfer) {
    const last4 = xfer[xfer.length - 1];
    const other = here && ctx.accounts.find((a) => a.id !== here.id && a.last4 === last4);
    if (here && other) {
      const kind = transferKindFor(here, other, line.amount);
      const words = kind === "set_aside" ? "a set-aside" : kind === "set_aside_return" ? "money coming back out of a set-aside" : "between our own accounts";
      return {
        classification: "transfer", transferKind: kind, counterpartyAccountId: other.id,
        reason: `Transfer ${line.amount < 0 ? "to" : "from"} ${other.name} (…${last4}) — ${words}, not an expense.`,
      };
    }
    return undecided(`A transfer ${line.amount < 0 ? "to" : "from"} an account ending ${last4} that is not in the registry — add that account (with its last four), or classify this by hand.`);
  }
  if (line.bankType === "ACCT_XFER") return undecided("An account transfer the description does not name the other side of — which account?");

  // 2. Stripe: the card balance being funded, the sweep or a payout landing. Our own money either way.
  if (/\bSTRIPE\b/.test(desc)) {
    return {
      classification: "transfer", transferKind: "stripe",
      reason: `${line.amount < 0 ? "Money to" : "Money from"} Stripe — the card's balance, the sweep and payouts are our own money moving; card spend and Stripe fees are already on the P&L.`,
    };
  }

  // 3. Kyle's own earlier ruling on this payee.
  const remembered = ctx.memory.get(line.payeeKey);
  if (remembered) {
    const when = remembered.classifiedAt ? ` on ${remembered.classifiedAt.toISOString().slice(0, 10)}` : "";
    const base = `Same payee as a line you classified${when}`;
    if (remembered.classification === "already_counted" && remembered.matchedKind === "company_bill" && remembered.matchedId) {
      const bill = ctx.bills.find((b) => b.id === remembered.matchedId);
      const month = bill ? openBillMonth(bill, line.postedAt, ctx) : null;
      if (bill && month) {
        return { classification: "already_counted", matchedKind: "company_bill", matchedId: bill.id, matchedMonth: month, reason: `${base} — confirms the ${bill.name} bill for ${month}.` };
      }
      return undecided(bill
        ? `${bill.name} has no unconfirmed scheduled month near this date — a second payment, or the bill's schedule is off?`
        : "The bill this payee used to confirm no longer exists — classify by hand.");
    }
    if (remembered.classification === "already_counted" && remembered.matchedKind === "payroll") {
      return { classification: "already_counted", matchedKind: "payroll", reason: `${base} as payroll — wages are on the P&L from the hours ledger.` };
    }
    if (remembered.classification === "expense") {
      return { classification: "expense", category: remembered.category ?? "other", reason: `${base} as an expense (${remembered.category ?? "other"}).` };
    }
    if (remembered.classification === "transfer") {
      return { classification: "transfer", transferKind: (remembered.transferKind as TransferKind) ?? "own_accounts", counterpartyAccountId: remembered.counterpartyAccountId, reason: `${base} as a transfer.` };
    }
    if (remembered.classification === "ignored") {
      return { classification: "ignored", reason: `${base} as ignored${remembered.note ? ` — ${remembered.note}` : ""}.` };
    }
  }

  // 4. Payroll — the hours ledger already carries it (services/payrollLedger.ts).
  if (line.amount < 0) {
    const tech = ctx.technicians.find((name) => desc.includes(name));
    if (/\bPAYROLL\b/.test(desc) || tech) {
      return {
        classification: "already_counted", matchedKind: "payroll",
        reason: tech ? `Payment to ${tech} — payroll, already on the P&L from the hours ledger in the month worked.` : "Payroll — already on the P&L from the hours ledger in the month worked.",
      };
    }
  }

  // 5. Bank fees are new money out with no other home.
  if (line.amount < 0 && (/(^|_)FEE(_|$)/.test(line.bankType ?? "") || /\b(SERVICE|MONTHLY|MAINTENANCE|WIRE|OVERDRAFT)\s+FEE\b/.test(desc))) {
    return { classification: "expense", category: "bank_fees", reason: "A bank fee." };
  }

  const candidates = candidatesFor(line, ctx);

  // 6. A typed not-on-card amount on a P.O. — the line confirms it, the P.O. stays the money.
  if (candidates.purchaseOrders.length === 1) {
    const p = candidates.purchaseOrders[0];
    return {
      classification: "already_counted", matchedKind: "po_off_card", matchedId: p.id,
      reason: `Matches the $${p.amount.toFixed(2)} typed on ${p.number} (${p.supplier}) as paid ${p.method ?? "off the card"} — the P.O. already carries this money.`,
    };
  }
  if (candidates.purchaseOrders.length > 1) {
    return undecided(`The amount matches ${candidates.purchaseOrders.length} P.O.s' typed amounts (${candidates.purchaseOrders.map((p) => p.number).join(", ")}) — pick which one this paid.`);
  }

  // 7. A scheduled company bill — amount and a word of the name, with an unconfirmed month nearby.
  if (candidates.bills.length > 0) {
    const named = candidates.bills.filter((b) => nameTokens(b.name).some((t) => desc.includes(t)));
    if (named.length === 1) {
      const b = named[0];
      return {
        classification: "already_counted", matchedKind: "company_bill", matchedId: b.id, matchedMonth: b.month,
        reason: `Confirms the ${b.name} bill for ${b.month} — the bill's scheduled amount is already on the P&L.`,
      };
    }
    return undecided(`The amount matches the ${candidates.bills.map((b) => b.name).join(" / ")} bill — confirm it, or classify as something else.`);
  }

  // 8. A customer payment Kyle already recorded (cash, check, Zelle, ACH) — money in, counted as collected.
  if (candidates.payments.length === 1) {
    const p = candidates.payments[0];
    return {
      classification: "already_counted", matchedKind: "payment", matchedId: p.id,
      reason: `Matches the $${p.amount.toFixed(2)} ${p.method} payment${p.customerName ? ` from ${p.customerName}` : ""} recorded ${p.date.slice(0, 10)} — already counted as collected.`,
    };
  }
  if (candidates.payments.length > 1) {
    return undecided(`The amount matches ${candidates.payments.length} recorded payments — pick which one this deposit is.`);
  }

  // 9. A savings account moving money anywhere but our own accounts is Kyle's ruling, never the importer's.
  if (hereIsSetAside) {
    if (here.purpose === "tax" && line.amount < 0) {
      return undecided("A payment out of the tax account — your ruling: an expense (category tax), or not the business's money (ignore, with a reason).");
    }
    return undecided(`Money ${line.amount < 0 ? "leaving" : "landing in"} ${here.name} that is not a transfer to a registered account — your call.`);
  }

  // 10. Everything else is the queue.
  if (line.amount < 0) return undecided(null);
  if (line.amount > 0) return undecided("Money in that matches no recorded payment — a customer payment not yet recorded, a transfer, or not the business's.");
  return undecided("A zero-amount line.");
}

// ─── Import ──────────────────────────────────────────────────────────────────

export interface ImportResult {
  duplicate: boolean;
  statementId: string;
  fileName: string;
  format: string;
  imported: number;
  skipped: number;
  autoClassified: number;
  unclassified: number;
}

const decisionData = (d: Decision, by: "rule" | "owner", at: Date) => ({
  classification: d.classification,
  category: d.category ?? null,
  transferKind: d.transferKind ?? null,
  counterpartyAccountId: d.counterpartyAccountId ?? null,
  matchedKind: d.matchedKind ?? null,
  matchedId: d.matchedId ?? null,
  matchedMonth: d.matchedMonth ?? null,
  reason: d.reason ?? null,
  hint: d.hint ?? null,
  classifiedBy: d.classification === "unclassified" && by === "rule" ? null : by,
  classifiedAt: d.classification === "unclassified" && by === "rule" ? null : at,
});

/**
 * One uploaded file for one account. The same bytes a second time import nothing (the
 * statement row already exists); an overlapping export imports only the lines the account
 * does not already hold. New lines run through the rules once, immediately.
 */
export async function importStatement(accountId: string, file: Buffer, fileName: string): Promise<ImportResult> {
  const account = await prisma.bankAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new BankError("Bank account not found.", 404);
  if (!file || file.length === 0) throw new BankError("The upload was empty.", 400);
  const fileHash = fileHashOf(file);
  const existing = await prisma.bankStatement.findUnique({ where: { accountId_fileHash: { accountId, fileHash } } });
  if (existing) {
    return { duplicate: true, statementId: existing.id, fileName: existing.fileName, format: existing.format, imported: 0, skipped: existing.lineCount, autoClassified: 0, unclassified: 0 };
  }
  const parsed = parseStatement(file);
  if (parsed.accountLast4 && account.last4 && parsed.accountLast4 !== account.last4) {
    throw new BankError(`This file is for an account ending ${parsed.accountLast4}; ${account.name} ends ${account.last4}.`, 409);
  }

  const seen = new Map<string, number>();
  const keyed = parsed.lines.map((line) => {
    const t = tupleOf(line);
    const n = seen.get(t) ?? 0;
    seen.set(t, n + 1);
    return { line, lineKey: lineKeyOf(line, n) };
  });
  const have = new Set((await prisma.bankLine.findMany({
    where: { accountId, lineKey: { in: keyed.map((k) => k.lineKey) } }, select: { lineKey: true },
  })).map((r) => r.lineKey));
  const fresh = keyed.filter((k) => !have.has(k.lineKey));

  const statement = await prisma.$transaction(async (tx) => {
    const st = await tx.bankStatement.create({
      data: {
        accountId, fileName: fileName.slice(0, 200), fileHash, format: parsed.format,
        periodStart: parsed.periodStart, periodEnd: parsed.periodEnd,
        closingBalance: parsed.closingBalance, balanceAsOf: parsed.balanceAsOf,
        lineCount: fresh.length,
      },
    });
    if (fresh.length > 0) {
      await tx.bankLine.createMany({
        data: fresh.map(({ line, lineKey }) => ({
          accountId, statementId: st.id, lineKey,
          postedAt: line.postedAt, amount: line.amount, description: line.description.slice(0, 500),
          bankRef: line.bankRef, bankType: line.bankType, runningBalance: line.runningBalance,
          payeeKey: payeeKey(line.description),
        })),
      });
    }
    return st;
  });

  const { classified, unclassified } = await autoClassify({ statementId: statement.id });
  logSystemEvent("info", "bank", `Imported ${fileName} for ${account.name}: ${fresh.length} new line${fresh.length === 1 ? "" : "s"}, ${keyed.length - fresh.length} already held, ${classified} classified by rule, ${unclassified} to classify.`, {
    statementId: statement.id, accountId, format: parsed.format,
  });
  return {
    duplicate: false, statementId: statement.id, fileName: statement.fileName, format: statement.format,
    imported: fresh.length, skipped: keyed.length - fresh.length, autoClassified: classified, unclassified,
  };
}

/**
 * Run the rules over every line no human has touched (`classifiedBy` null or "rule"). Called
 * after an import, after the registry changes (a new last-four makes transfers recognisable),
 * and on Kyle's click. A line Kyle classified — or reset to unclassified — is never touched.
 */
export async function autoClassify(scope: { statementId?: string; accountId?: string } = {}): Promise<{ classified: number; unclassified: number }> {
  const lines = await prisma.bankLine.findMany({
    where: {
      ...(scope.statementId ? { statementId: scope.statementId } : {}),
      ...(scope.accountId ? { accountId: scope.accountId } : {}),
      OR: [{ classifiedBy: null }, { classifiedBy: "rule" }],
    },
    orderBy: { postedAt: "asc" },
    select: { id: true, accountId: true, postedAt: true, amount: true, description: true, bankType: true, payeeKey: true, classification: true },
  });
  if (lines.length === 0) return { classified: 0, unclassified: 0 };
  const ctx = await loadClassifyContext(prisma, lines.map((l) => l.postedAt.getFullYear()));
  // A rule-made confirmation being re-run must not block itself: forget what these lines hold.
  const ids = new Set(lines.map((l) => l.id));
  const held = await prisma.bankLine.findMany({
    where: { id: { in: [...ids] }, classification: "already_counted" },
    select: { matchedKind: true, matchedId: true, matchedMonth: true },
  });
  for (const h of held) {
    if (h.matchedKind === "company_bill") ctx.confirmedBillMonths.delete(`${h.matchedId}:${h.matchedMonth}`);
    if (h.matchedKind === "po_off_card" && h.matchedId) ctx.confirmedPoIds.delete(h.matchedId);
    if (h.matchedKind === "payment" && h.matchedId) ctx.confirmedPaymentIds.delete(h.matchedId);
  }
  const now = new Date();
  let classified = 0;
  let unclassified = 0;
  for (const line of lines) {
    const d = classifyLine(line, ctx);
    // Claim what this line confirms so the next line cannot confirm the same thing.
    if (d.matchedKind === "company_bill") ctx.confirmedBillMonths.add(`${d.matchedId}:${d.matchedMonth}`);
    if (d.matchedKind === "po_off_card" && d.matchedId) ctx.confirmedPoIds.add(d.matchedId);
    if (d.matchedKind === "payment" && d.matchedId) ctx.confirmedPaymentIds.add(d.matchedId);
    await prisma.bankLine.update({ where: { id: line.id }, data: decisionData(d, "rule", now) });
    if (d.classification === "unclassified") unclassified += 1; else classified += 1;
  }
  return { classified, unclassified };
}

// ─── Kyle's edits ────────────────────────────────────────────────────────────

export interface ClassifyInput {
  classification: Classification;
  category?: string | null;
  transferKind?: TransferKind | null;
  counterpartyAccountId?: string | null;
  matchedKind?: CountedKind | null;
  matchedId?: string | null;
  matchedMonth?: string | null;
  note?: string | null;
}

/**
 * Kyle's ruling on one line. Validated against the records it names; a bill-month, a P.O. or a
 * payment can be confirmed by one line only (409 names the other). Resetting to unclassified
 * is allowed and marks the line his, so the rules leave it alone afterwards.
 */
export async function classifyBankLine(lineId: string, input: ClassifyInput): Promise<void> {
  const line = await prisma.bankLine.findUnique({ where: { id: lineId }, select: { id: true, accountId: true, postedAt: true, amount: true } });
  if (!line) throw new BankError("Bank line not found.", 404);
  const note = input.note?.trim() || null;
  const d: Decision = { classification: input.classification, reason: note };

  if (input.classification === "expense") {
    if (!input.category || !(EXPENSE_CATEGORIES as readonly string[]).includes(input.category)) throw new BankError("An expense needs a category.", 400);
    d.category = input.category;
  } else if (input.classification === "transfer") {
    if (!input.transferKind || !(TRANSFER_KINDS as readonly string[]).includes(input.transferKind)) throw new BankError("A transfer needs its kind (set-aside, set-aside return, Stripe, or between our accounts).", 400);
    d.transferKind = input.transferKind;
    if (input.counterpartyAccountId) {
      const other = await prisma.bankAccount.findUnique({ where: { id: input.counterpartyAccountId }, select: { id: true } });
      if (!other) throw new BankError("The other account is not in the registry.", 400);
      if (other.id === line.accountId) throw new BankError("A transfer's other side cannot be the same account.", 400);
      d.counterpartyAccountId = other.id;
    }
  } else if (input.classification === "already_counted") {
    if (!input.matchedKind || !(COUNTED_KINDS as readonly string[]).includes(input.matchedKind)) throw new BankError("Say what already counts this money: payroll, a P.O.'s typed amount, a company bill, or a recorded payment.", 400);
    d.matchedKind = input.matchedKind;
    if (input.matchedKind === "company_bill") {
      const bill = input.matchedId ? await prisma.companyBill.findUnique({ where: { id: input.matchedId } }) : null;
      if (!bill) throw new BankError("Pick the company bill this line paid.", 400);
      const month = input.matchedMonth?.match(/^\d{4}-\d{2}$/) ? input.matchedMonth : monthKey(line.postedAt);
      const year = Number(month.slice(0, 4));
      if (!billMonthsInYear(bill, year).some((m) => monthKeyOf(year, m.month) === month)) {
        throw new BankError(`${bill.name} is not scheduled for ${month}.`, 400);
      }
      const other = await prisma.bankLine.findFirst({ where: { id: { not: line.id }, matchedKind: "company_bill", matchedId: bill.id, matchedMonth: month }, select: { postedAt: true, amount: true } });
      if (other) throw new BankError(`${bill.name} for ${month} is already confirmed by the ${other.postedAt.toISOString().slice(0, 10)} line ($${Math.abs(other.amount).toFixed(2)}).`, 409);
      d.matchedId = bill.id;
      d.matchedMonth = month;
    } else if (input.matchedKind === "po_off_card") {
      const po = input.matchedId ? await prisma.purchaseOrder.findUnique({ where: { id: input.matchedId }, select: { id: true, number: true, offCardAmount: true } }) : null;
      if (!po) throw new BankError("Pick the P.O. this line paid.", 400);
      if (po.offCardAmount == null) throw new BankError(`${po.number} has no not-on-card amount typed — type it on the P.O. first, then this line confirms it.`, 409);
      const other = await prisma.bankLine.findFirst({ where: { id: { not: line.id }, matchedKind: "po_off_card", matchedId: po.id }, select: { postedAt: true } });
      if (other) throw new BankError(`${po.number} is already confirmed by the ${other.postedAt.toISOString().slice(0, 10)} line.`, 409);
      d.matchedId = po.id;
    } else if (input.matchedKind === "payment") {
      const p = input.matchedId ? await prisma.payment.findUnique({ where: { id: input.matchedId }, select: { id: true } }) : null;
      if (!p) throw new BankError("Pick the recorded payment this deposit is.", 400);
      const other = await prisma.bankLine.findFirst({ where: { id: { not: line.id }, matchedKind: "payment", matchedId: p.id }, select: { postedAt: true } });
      if (other) throw new BankError(`That payment is already confirmed by the ${other.postedAt.toISOString().slice(0, 10)} line.`, 409);
      d.matchedId = p.id;
    }
  } else if (input.classification === "ignored") {
    if (!note) throw new BankError("Say why this line is ignored.", 400);
  }

  await prisma.bankLine.update({ where: { id: line.id }, data: decisionData(d, "owner", new Date()) });
  // His ruling is now memory: the other queued lines from the same payee follow it at once,
  // and a bill-month or P.O. he just claimed is no longer a candidate for the rest.
  await autoClassify();
}

/** A wrong import, undone: the statement and every line it brought — and so every confirmation those lines made. */
export async function deleteStatement(statementId: string): Promise<void> {
  const st = await prisma.bankStatement.findUnique({ where: { id: statementId }, include: { account: { select: { name: true } } } });
  if (!st) throw new BankError("Statement not found.", 404);
  await prisma.bankStatement.delete({ where: { id: statementId } });
  logSystemEvent("info", "bank", `Deleted statement ${st.fileName} (${st.account.name}, ${st.lineCount} lines) — its lines and their confirmations are gone.`, { statementId, accountId: st.accountId });
}

/** One line, gone. A later overlapping import can bring it back; "ignored with a reason" is the durable exit. */
export async function deleteLine(lineId: string, reason: string | null): Promise<void> {
  const line = await prisma.bankLine.findUnique({ where: { id: lineId }, select: { id: true, accountId: true, description: true, amount: true, postedAt: true } });
  if (!line) throw new BankError("Bank line not found.", 404);
  await prisma.bankLine.delete({ where: { id: lineId } });
  logSystemEvent("info", "bank", `Deleted bank line ${line.postedAt.toISOString().slice(0, 10)} ${line.description} ($${line.amount.toFixed(2)})${reason ? ` — ${reason}` : ""}.`, { lineId, accountId: line.accountId });
}
