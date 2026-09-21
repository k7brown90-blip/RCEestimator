/**
 * Bank statements — the registry, the uploads, the lines and their classification, and the
 * confirmations they make (Kyle, 2026-09-20: "I can manually upload the bank statements each
 * month from each account"). Mounted at /bank behind the operator session like /financials;
 * nothing here is in publicRoutes.ts.
 *
 * Why this lives on the FINANCIALS tab and not Purchasing & Stock: a statement is money —
 * cash on hand, what left the account, what moved between accounts. Purchasing owns buying
 * (the P.O., the receipt, the landing); a bank line that pays a P.O. confirms money the P.O.
 * already carries, it does not buy anything. Financials is money-only since build #5, and
 * this is money.
 *
 * Kyle's standing rule: everything here is editable and deletable from the surface that shows
 * it — an account (PATCH/DELETE), a statement (DELETE undoes the import and every confirmation
 * its lines made), a line (PATCH reclassifies, including back to unclassified; DELETE removes).
 */

import express from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, readParam } from "./agent-helpers";
import {
  ACCOUNT_KINDS, ACCOUNT_PURPOSES, BankError, CLASSIFICATIONS, COUNTED_KINDS, EXPENSE_CATEGORIES, TRANSFER_KINDS,
  autoClassify, candidatesFor, classifyBankLine, deleteLine, deleteStatement, importStatement, loadClassifyContext,
} from "../services/bankStatements";
import { accountsWithBalances, confirmationsForYear } from "../services/bankLedger";
import { logSystemEvent } from "../services/systemEvents";

export const bankRouter = express.Router();

// ─── The registry ────────────────────────────────────────────────────────────

const accountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  institution: z.string().trim().min(1).max(100).default("Chase"),
  last4: z.string().trim().regex(/^\d{4}$/, "last four digits").nullable().optional(),
  kind: z.enum(ACCOUNT_KINDS),
  purpose: z.enum(ACCOUNT_PURPOSES),
  isActive: z.boolean().optional(),
});

bankRouter.get("/bank/accounts", asyncHandler(async (_req, res) => {
  res.json(await accountsWithBalances());
}));

bankRouter.post("/bank/accounts", asyncHandler(async (req, res) => {
  const body = accountSchema.parse(req.body ?? {});
  const account = await prisma.bankAccount.create({
    data: { name: body.name, institution: body.institution, last4: body.last4 ?? null, kind: body.kind, purpose: body.purpose, isActive: body.isActive ?? true },
  });
  // A new last-four can make transfers recognisable — re-run the rules over the untouched queue.
  await autoClassify();
  res.status(201).json(account);
}));

bankRouter.patch("/bank/accounts/:id", asyncHandler(async (req, res) => {
  const body = accountSchema.partial().parse(req.body ?? {});
  const account = await prisma.bankAccount.update({
    where: { id: readParam(req, "id") },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.institution !== undefined ? { institution: body.institution } : {}),
      ...(body.last4 !== undefined ? { last4: body.last4 } : {}),
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
      ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    },
  });
  await autoClassify();
  res.json(account);
}));

/** Deletable once its statements are gone — deleting statements is the explicit undo of their imports. */
bankRouter.delete("/bank/accounts/:id", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const account = await prisma.bankAccount.findUnique({ where: { id }, include: { _count: { select: { statements: true } } } });
  if (!account) { res.status(404).json({ error: "Bank account not found." }); return; }
  if (account._count.statements > 0) {
    res.status(409).json({ error: `${account.name} has ${account._count.statements} imported statement${account._count.statements === 1 ? "" : "s"} — delete those first (each delete undoes its import).` });
    return;
  }
  await prisma.bankAccount.delete({ where: { id } });
  res.status(204).end();
}));

// ─── Statements ──────────────────────────────────────────────────────────────

bankRouter.get("/bank/statements", asyncHandler(async (req, res) => {
  const accountId = typeof req.query.accountId === "string" && req.query.accountId ? req.query.accountId : undefined;
  const rows = await prisma.bankStatement.findMany({
    where: accountId ? { accountId } : {},
    orderBy: [{ periodEnd: "desc" }, { importedAt: "desc" }],
    include: { account: { select: { name: true } }, _count: { select: { lines: { where: { classification: "unclassified" } } } } },
  });
  res.json(rows.map((s) => ({
    id: s.id, accountId: s.accountId, accountName: s.account.name, fileName: s.fileName, format: s.format,
    periodStart: s.periodStart, periodEnd: s.periodEnd, closingBalance: s.closingBalance, balanceAsOf: s.balanceAsOf,
    lineCount: s.lineCount, unclassified: s._count.lines, importedAt: s.importedAt,
  })));
}));

/**
 * The upload: the file as the raw body (any Content-Type — the format is sniffed from the
 * bytes), the file name on the query. 200 with `duplicate: true` when these exact bytes were
 * imported before; 201 otherwise.
 */
bankRouter.post(
  "/bank/accounts/:id/statements",
  express.raw({ type: () => true, limit: "8mb" }),
  asyncHandler(async (req, res) => {
    const fileName = typeof req.query.fileName === "string" && req.query.fileName.trim() ? req.query.fileName.trim() : "statement";
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const result = await importStatement(readParam(req, "id"), body, fileName);
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (err) {
      if (err instanceof BankError) { res.status(err.statusCode).json({ error: err.message }); return; }
      throw err;
    }
  }),
);

bankRouter.delete("/bank/statements/:id", asyncHandler(async (req, res) => {
  try {
    await deleteStatement(readParam(req, "id"));
    res.status(204).end();
  } catch (err) {
    if (err instanceof BankError) { res.status(err.statusCode).json({ error: err.message }); return; }
    throw err;
  }
}));

// ─── Lines and the queue ─────────────────────────────────────────────────────

const LINE_SELECT = {
  id: true, accountId: true, statementId: true, postedAt: true, amount: true, description: true, bankRef: true, bankType: true,
  runningBalance: true, payeeKey: true, classification: true, category: true, transferKind: true, counterpartyAccountId: true,
  matchedKind: true, matchedId: true, matchedMonth: true, reason: true, hint: true, classifiedBy: true, classifiedAt: true,
  account: { select: { name: true, purpose: true } }, counterparty: { select: { name: true } },
} as const;

/**
 * `?classification=unclassified` is the queue (every year — a queue is not year-scoped).
 * `?year=` lists a year's lines, any classification. Each row carries the candidates the rules
 * saw (bills, P.O.s, payments that fit the amount and the date) so Kyle confirms with a click.
 */
bankRouter.get("/bank/lines", asyncHandler(async (req, res) => {
  const q = z.object({
    classification: z.enum(CLASSIFICATIONS).optional(),
    year: z.coerce.number().int().min(1990).max(2100).optional(),
    accountId: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(2000).default(500),
  }).parse(req.query);
  const lines = await prisma.bankLine.findMany({
    where: {
      ...(q.classification ? { classification: q.classification } : {}),
      ...(q.year ? { postedAt: { gte: new Date(`${q.year}-01-01`), lt: new Date(`${q.year + 1}-01-01`) } } : {}),
      ...(q.accountId ? { accountId: q.accountId } : {}),
    },
    orderBy: [{ postedAt: "desc" }, { createdAt: "desc" }],
    take: q.limit,
    select: LINE_SELECT,
  });
  const years = [...new Set(lines.map((l) => l.postedAt.getFullYear()))];
  const ctx = years.length > 0 ? await loadClassifyContext(prisma, years) : null;
  // Names for what a classified line points at — the queue and the history both say what a match means.
  const billIds = [...new Set(lines.filter((l) => l.matchedKind === "company_bill" && l.matchedId).map((l) => l.matchedId!))];
  const poIds = [...new Set(lines.filter((l) => l.matchedKind === "po_off_card" && l.matchedId).map((l) => l.matchedId!))];
  const [bills, pos] = await Promise.all([
    billIds.length ? prisma.companyBill.findMany({ where: { id: { in: billIds } }, select: { id: true, name: true, amount: true } }) : [],
    poIds.length ? prisma.purchaseOrder.findMany({ where: { id: { in: poIds } }, select: { id: true, number: true, supplier: true, offCardAmount: true } }) : [],
  ]);
  const billName = new Map(bills.map((b) => [b.id, `${b.name} ($${b.amount.toFixed(2)})`]));
  const poName = new Map(pos.map((p) => [p.id, `${p.number} — ${p.supplier}${p.offCardAmount != null ? ` ($${p.offCardAmount.toFixed(2)} typed)` : ""}`]));
  res.json(lines.map(({ account, counterparty, ...l }) => ({
    ...l,
    accountName: account.name,
    accountPurpose: account.purpose,
    counterpartyName: counterparty?.name ?? null,
    matchedLabel: l.matchedKind === "company_bill" ? billName.get(l.matchedId ?? "") ?? null
      : l.matchedKind === "po_off_card" ? poName.get(l.matchedId ?? "") ?? null
      : null,
    candidates: l.classification === "unclassified" && ctx ? candidatesFor(l, ctx) : null,
  })));
}));

/** Kyle's ruling on a line — or a reset to unclassified, which the rules then leave alone. */
bankRouter.patch("/bank/lines/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    classification: z.enum(CLASSIFICATIONS),
    category: z.enum(EXPENSE_CATEGORIES).nullable().optional(),
    transferKind: z.enum(TRANSFER_KINDS).nullable().optional(),
    counterpartyAccountId: z.string().nullable().optional(),
    matchedKind: z.enum(COUNTED_KINDS).nullable().optional(),
    matchedId: z.string().nullable().optional(),
    matchedMonth: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  }).parse(req.body ?? {});
  try {
    await classifyBankLine(readParam(req, "id"), body);
  } catch (err) {
    if (err instanceof BankError) { res.status(err.statusCode).json({ error: err.message }); return; }
    throw err;
  }
  const line = await prisma.bankLine.findUnique({ where: { id: readParam(req, "id") }, select: LINE_SELECT });
  res.json(line);
}));

bankRouter.delete("/bank/lines/:id", asyncHandler(async (req, res) => {
  const reason = typeof req.query.reason === "string" && req.query.reason.trim() ? req.query.reason.trim().slice(0, 500) : null;
  try {
    await deleteLine(readParam(req, "id"), reason);
    res.status(204).end();
  } catch (err) {
    if (err instanceof BankError) { res.status(err.statusCode).json({ error: err.message }); return; }
    throw err;
  }
}));

/** Run the rules again over every line no human has touched — after a bill or a P.O. amount is added, say. */
bankRouter.post("/bank/lines/auto", asyncHandler(async (_req, res) => {
  const result = await autoClassify();
  logSystemEvent("info", "bank", `Rules re-run on the queue: ${result.classified} classified, ${result.unclassified} still to classify.`);
  res.json(result);
}));

// ─── Confirmations: what a statement has confirmed, and what it should have ──

bankRouter.get("/bank/confirmations", asyncHandler(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  res.json(await confirmationsForYear(year));
}));
