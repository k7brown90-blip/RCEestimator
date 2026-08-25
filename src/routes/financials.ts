/**
 * Financials — the dedicated money tab. (Kyle, 2026-08-25: "a new tab dedicated
 * to financial tracking of each job that will produce necessary accounting
 * reports for the company, I will enter all company bills and rolling costs and
 * revenue in here.")
 *
 * Mounted behind the operator session like every other CRM surface.
 *
 * The ledger it reads is deliberately what already exists plus two new tables:
 * - REVENUE: signed invoices (IssuedEstimate, billed totals — accrual view) and
 *   Payment rows (Stripe webhook + hand-recorded cash/checks — cash view).
 *   Both are shown; they answer different questions.
 * - EXPENSES: Receipt rows (job materials, gas, overhead one-offs — already
 *   captured from the tech PWA, MMS, and now the CRM) and CompanyBill rows
 *   (recurring bills expanded month by month).
 *
 * All four reports Kyle asked for: monthly P&L, expenses by category, job
 * profitability, and the tax-year CSV export.
 */

import express from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, readParam } from "./agent-helpers";
import { billedTotalOf, stripeConfigured } from "../services/stripePayments";
import { getLaborRate } from "../services/jobCosting";

export const financialsRouter = express.Router();

// ── Company bills ────────────────────────────────────────────────────────────

const billSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(["overhead", "insurance", "vehicle", "software", "marketing", "other"]).default("overhead"),
  amount: z.number().positive(),
  cadence: z.enum(["one_time", "weekly", "monthly", "quarterly", "annual"]),
  billDate: z.string().optional(),  // one_time
  startDate: z.string().optional(), // recurring
  endDate: z.string().nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
});

financialsRouter.get("/bills", asyncHandler(async (_req, res) => {
  const bills = await prisma.companyBill.findMany({ orderBy: [{ cadence: "asc" }, { name: "asc" }] });
  res.json(bills);
}));

financialsRouter.post("/bills", asyncHandler(async (req, res) => {
  const body = billSchema.parse(req.body);
  if (body.cadence === "one_time" && !body.billDate) {
    res.status(400).json({ error: "A one-time bill needs its billDate." });
    return;
  }
  if (body.cadence !== "one_time" && !body.startDate) {
    res.status(400).json({ error: "A recurring bill needs a startDate." });
    return;
  }
  const bill = await prisma.companyBill.create({
    data: {
      name: body.name,
      category: body.category,
      amount: body.amount,
      cadence: body.cadence,
      billDate: body.billDate ? new Date(body.billDate) : null,
      startDate: body.startDate ? new Date(body.startDate) : null,
      endDate: body.endDate ? new Date(body.endDate) : null,
      notes: body.notes ?? null,
    },
  });
  res.status(201).json(bill);
}));

financialsRouter.patch("/bills/:id", asyncHandler(async (req, res) => {
  const body = billSchema.partial().parse(req.body);
  const bill = await prisma.companyBill.update({
    where: { id: readParam(req, "id") },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.amount !== undefined ? { amount: body.amount } : {}),
      ...(body.cadence !== undefined ? { cadence: body.cadence } : {}),
      ...(body.billDate !== undefined ? { billDate: body.billDate ? new Date(body.billDate) : null } : {}),
      ...(body.startDate !== undefined ? { startDate: body.startDate ? new Date(body.startDate) : null } : {}),
      ...(body.endDate !== undefined ? { endDate: body.endDate ? new Date(body.endDate) : null } : {}),
      ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
    },
  });
  res.json(bill);
}));

financialsRouter.delete("/bills/:id", asyncHandler(async (req, res) => {
  await prisma.companyBill.delete({ where: { id: readParam(req, "id") } });
  res.status(204).end();
}));

// ── Payments ─────────────────────────────────────────────────────────────────

financialsRouter.get("/payments", asyncHandler(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const payments = await prisma.payment.findMany({
    where: { createdAt: { gte: new Date(`${year}-01-01`), lt: new Date(`${year + 1}-01-01`) } },
    orderBy: { createdAt: "desc" },
    include: { customer: { select: { id: true, name: true } } },
  });
  res.json(payments);
}));

/** Hand-recorded cash/check payments. Stripe rows only ever arrive via webhook. */
financialsRouter.post("/payments", asyncHandler(async (req, res) => {
  const body = z.object({
    amount: z.number().positive(),
    // Methods the system can't detect (Kyle, 2026-08-25: "when they write a
    // check or do another form of payment that the system can't detect like
    // cash or zelle"). Stripe rows only ever arrive via the webhook.
    method: z.enum(["cash", "check", "zelle", "other"]),
    // deposit satisfies the scheduling gate (Kyle, 2026-08-25).
    kind: z.enum(["deposit", "final", "other"]).default("other"),
    customerId: z.string().optional(),
    estimateId: z.string().optional(),
    visitId: z.string().optional(),
    note: z.string().trim().max(500).optional(),
    paidAt: z.string().optional(),
  }).parse(req.body);
  const payment = await prisma.payment.create({
    data: {
      amount: body.amount,
      method: body.method,
      kind: body.kind,
      status: "paid",
      customerId: body.customerId ?? null,
      estimateId: body.estimateId ?? null,
      visitId: body.visitId ?? null,
      note: body.note ?? null,
      paidAt: body.paidAt ? new Date(body.paidAt) : new Date(),
    },
  });
  // A recorded cash/check tied to an invoice emails the customer their receipt
  // too (Kyle, 2026-08-25) — same document either way the money arrived.
  if (payment.estimateId) {
    const { sendPaymentReceiptEmail } = await import("../services/paymentReceipts");
    sendPaymentReceiptEmail(prisma, payment.id).catch((err) =>
      console.error("[financials] receipt email failed:", err));
  }
  res.status(201).json(payment);
}));

// ── Report machinery ─────────────────────────────────────────────────────────

/** Which months (0-11) of `year` a bill lands in, and at what amount. */
export function billMonthsInYear(
  bill: { cadence: string; amount: number; billDate: Date | null; startDate: Date | null; endDate: Date | null },
  year: number,
): { month: number; amount: number }[] {
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

interface YearLedger {
  /** Signed invoices: { month, amount, number, customer, estimateId, signedAt } */
  invoiced: { month: number; amount: number; number: string; customer: string; estimateId: string; date: Date }[];
  collected: { month: number; amount: number; method: string; date: Date; note: string | null }[];
  receiptRows: { month: number; amount: number; category: string; vendor: string | null; date: Date; jobId: string | null }[];
  billRows: { month: number; amount: number; category: string; name: string }[];
}

async function yearLedger(year: number): Promise<YearLedger> {
  const from = new Date(`${year}-01-01`);
  const to = new Date(`${year + 1}-01-01`);

  const [estimates, payments, receipts, bills] = await Promise.all([
    prisma.issuedEstimate.findMany({
      where: { signedAt: { gte: from, lt: to }, status: { not: "void" }, account: { isTestAccount: false } },
      include: { options: true, account: { select: { name: true } } },
    }),
    prisma.payment.findMany({ where: { status: "paid", paidAt: { gte: from, lt: to } } }),
    prisma.receipt.findMany({
      where: { status: "confirmed", receivedAt: { gte: from, lt: to } },
      select: { amount: true, category: true, vendor: true, receivedAt: true, jobId: true },
    }),
    prisma.companyBill.findMany(),
  ]);

  return {
    invoiced: estimates.map((est) => ({
      month: est.signedAt!.getMonth(),
      amount: billedTotalOf({
        total: est.total,
        tripCharge: est.tripCharge,
        selectedOptions: est.selectedOptions,
        comboCapJson: est.comboCapJson,
        discountJson: est.discountJson,
        optionsSubtotals: est.options.map((o) => ({ option: o.option, subtotal: o.subtotal })),
      }),
      number: est.number,
      customer: est.account.name,
      estimateId: est.id,
      date: est.signedAt!,
    })),
    collected: payments.map((p) => ({
      month: p.paidAt!.getMonth(), amount: p.amount, method: p.method, date: p.paidAt!, note: p.note,
    })),
    receiptRows: receipts.map((r) => ({
      month: r.receivedAt.getMonth(), amount: r.amount, category: r.category, vendor: r.vendor, date: r.receivedAt, jobId: r.jobId,
    })),
    billRows: bills.flatMap((bill) =>
      billMonthsInYear(bill, year).map((hit) => ({
        month: hit.month, amount: hit.amount, category: bill.category, name: bill.name,
      })),
    ),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Report 1+2: monthly P&L and expenses by category ────────────────────────

financialsRouter.get("/summary", asyncHandler(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const ledger = await yearLedger(year);

  const months = Array.from({ length: 12 }, (_, month) => {
    const invoiced = ledger.invoiced.filter((r) => r.month === month).reduce((s, r) => s + r.amount, 0);
    const collected = ledger.collected.filter((r) => r.month === month).reduce((s, r) => s + r.amount, 0);
    const receiptExp = ledger.receiptRows.filter((r) => r.month === month).reduce((s, r) => s + r.amount, 0);
    const billExp = ledger.billRows.filter((r) => r.month === month).reduce((s, r) => s + r.amount, 0);
    return {
      month,
      invoiced: round2(invoiced),
      collected: round2(collected),
      expenses: round2(receiptExp + billExp),
      net: round2(invoiced - receiptExp - billExp),
    };
  });

  // Expenses by category — receipts and bills merged, per month + YTD.
  const categories = new Map<string, { monthly: number[]; total: number }>();
  const addExpense = (category: string, month: number, amount: number) => {
    const row = categories.get(category) ?? { monthly: Array(12).fill(0), total: 0 };
    row.monthly[month] += amount;
    row.total += amount;
    categories.set(category, row);
  };
  for (const r of ledger.receiptRows) addExpense(r.category, r.month, r.amount);
  for (const b of ledger.billRows) addExpense(`bill:${b.category}`, b.month, b.amount);

  res.json({
    year,
    stripeConfigured: stripeConfigured(),
    months,
    totals: {
      invoiced: round2(months.reduce((s, m) => s + m.invoiced, 0)),
      collected: round2(months.reduce((s, m) => s + m.collected, 0)),
      expenses: round2(months.reduce((s, m) => s + m.expenses, 0)),
      net: round2(months.reduce((s, m) => s + m.net, 0)),
    },
    expensesByCategory: [...categories.entries()].map(([category, row]) => ({
      category,
      monthly: row.monthly.map(round2),
      total: round2(row.total),
    })).sort((a, b) => b.total - a.total),
  });
}));

// ── Report 3: job profitability ─────────────────────────────────────────────

financialsRouter.get("/job-profitability", asyncHandler(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const visits = await prisma.visit.findMany({
    where: {
      status: "completed",
      completedAt: { gte: new Date(`${year}-01-01`), lt: new Date(`${year + 1}-01-01`) },
      customer: { isTestAccount: false },
    },
    include: {
      customer: { select: { id: true, name: true } },
      property: { select: { addressLine1: true, city: true } },
    },
    orderBy: { completedAt: "desc" },
  });

  const visitIds = visits.map((v) => v.id);
  const [estimates, receipts] = await Promise.all([
    prisma.issuedEstimate.findMany({
      where: {
        signedAt: { not: null },
        OR: [{ jobVisitId: { in: visitIds } }, { visitId: { in: visitIds } }],
      },
      include: { options: true },
    }),
    prisma.receipt.groupBy({
      by: ["jobId"],
      where: { jobId: { in: visitIds }, status: "confirmed" },
      _sum: { amount: true },
    }),
  ]);

  const laborRate = await getLaborRate();
  const spendByJob = new Map(receipts.map((r) => [r.jobId, r._sum.amount ?? 0]));
  const estimateByJob = new Map<string, number>();
  for (const est of estimates) {
    const amount = billedTotalOf({
      total: est.total,
      tripCharge: est.tripCharge,
      selectedOptions: est.selectedOptions,
      comboCapJson: est.comboCapJson,
      discountJson: est.discountJson,
      optionsSubtotals: est.options.map((o) => ({ option: o.option, subtotal: o.subtotal })),
    });
    for (const key of [est.jobVisitId, est.visitId]) {
      if (key && !estimateByJob.has(key)) estimateByJob.set(key, amount);
    }
  }

  res.json(visits.map((visit) => {
    const quoted = estimateByJob.get(visit.id) ?? null;
    const materialSpend = round2(spendByJob.get(visit.id) ?? 0);
    // Real labor now (Phase 5): the time clock rolls punches into
    // Visit.laborHours; the rate is the company labor rate.
    const laborHours = visit.laborHours ?? 0;
    const laborCost = round2(laborHours * laborRate);
    return {
      visitId: visit.id,
      customer: visit.customer.name,
      customerId: visit.customer.id,
      address: `${visit.property.addressLine1}, ${visit.property.city}`,
      jobType: visit.jobType,
      completedAt: visit.completedAt,
      quoted,
      materialSpend,
      laborHours,
      laborCost,
      marginBeforeLabor: quoted !== null ? round2(quoted - materialSpend) : null,
      margin: quoted !== null ? round2(quoted - materialSpend - laborCost) : null,
    };
  }));
}));

// ── Receipt insights (Phase 5): "update the price book and flag most used
// items." The engine RECOMMENDS, never sets (decisions/2026-08-04): this
// reads the Vision-parsed line items off confirmed receipts and reports the
// most-purchased items and where receipt unit costs drift from the price
// book's stored supplier costs. Kyle changes the book; this shows him where.
financialsRouter.get("/receipt-insights", asyncHandler(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const receipts = await prisma.receipt.findMany({
    where: {
      status: "confirmed",
      lineItems: { not: null },
      receivedAt: { gte: new Date(`${year}-01-01`), lt: new Date(`${year + 1}-01-01`) },
    },
    select: { lineItems: true, vendor: true },
  });

  interface Seen { name: string; count: number; totalQty: number; unitCosts: number[]; vendors: Set<string> }
  const items = new Map<string, Seen>();
  for (const receipt of receipts) {
    let rows: { name?: string; qty?: number; unitCost?: number }[] = [];
    try { rows = JSON.parse(receipt.lineItems!); } catch { continue; }
    for (const row of rows) {
      if (!row.name) continue;
      const key = row.name.trim().toLowerCase();
      const seen = items.get(key) ?? { name: row.name.trim(), count: 0, totalQty: 0, unitCosts: [], vendors: new Set<string>() };
      seen.count += 1;
      seen.totalQty += row.qty ?? 1;
      if (typeof row.unitCost === "number" && row.unitCost > 0) seen.unitCosts.push(row.unitCost);
      if (receipt.vendor) seen.vendors.add(receipt.vendor);
      items.set(key, seen);
    }
  }

  const top = [...items.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  // Price-drift check: receipt items whose name matches a price-book atomic's
  // description, compared against that item's stored supplier cost.
  // Contains-match both directions — "12-2 Romex 250ft" should find "Romex 12-2".
  const [atomics, supplierPrices] = await Promise.all([
    prisma.priceBookAtomic.findMany({
      where: { description: { not: null } },
      select: { itemId: true, description: true },
      take: 3000,
    }),
    prisma.priceBookSupplierPrice.findMany({
      where: { unitCost: { not: null } },
      select: { itemId: true, unitCost: true, supplier: { select: { name: true } } },
      take: 5000,
    }),
  ]);
  const priceByItem = new Map<string, { unitCost: number; supplier: string }>();
  for (const p of supplierPrices) {
    if (!priceByItem.has(p.itemId)) priceByItem.set(p.itemId, { unitCost: p.unitCost!, supplier: p.supplier.name });
  }

  const drift: {
    receiptItem: string; bookItem: string; supplier: string;
    bookCost: number; receiptAvgCost: number; driftPct: number;
  }[] = [];
  for (const item of top) {
    if (item.unitCosts.length === 0) continue;
    const avg = item.unitCosts.reduce((s, c) => s + c, 0) / item.unitCosts.length;
    const norm = item.name.toLowerCase();
    const match = atomics.find((a) => {
      const bookNorm = a.description!.toLowerCase();
      return bookNorm.includes(norm) || norm.includes(bookNorm);
    });
    const price = match ? priceByItem.get(match.itemId) : undefined;
    if (match && price && price.unitCost > 0) {
      const pct = Math.round(((avg - price.unitCost) / price.unitCost) * 1000) / 10;
      if (Math.abs(pct) >= 5) {
        drift.push({
          receiptItem: item.name,
          bookItem: match.description!,
          supplier: price.supplier,
          bookCost: price.unitCost,
          receiptAvgCost: Math.round(avg * 100) / 100,
          driftPct: pct,
        });
      }
    }
  }

  res.json({
    year,
    receiptsParsed: receipts.length,
    topItems: top.map((t) => ({
      name: t.name,
      receipts: t.count,
      totalQty: Math.round(t.totalQty * 100) / 100,
      avgUnitCost: t.unitCosts.length > 0
        ? Math.round((t.unitCosts.reduce((s, c) => s + c, 0) / t.unitCosts.length) * 100) / 100
        : null,
      vendors: [...t.vendors],
    })),
    priceDrift: drift.sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct)),
  });
}));

// ── Go-live status (Phase 5): what stands between test dollars and real ones.
// The Dashboard steps are Kyle's to click; this reports what the server can see.
financialsRouter.get("/stripe-status", asyncHandler(async (_req, res) => {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  res.json({
    configured: Boolean(key),
    keyMode: key.startsWith("sk_live") || key.startsWith("rk_live") ? "live" : key ? "test" : "none",
    restrictedKey: key.startsWith("rk_"),
    webhookSecretSet: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
  });
}));

// ── Report 4: tax-year CSV export ───────────────────────────────────────────

financialsRouter.get("/export", asyncHandler(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const ledger = await yearLedger(year);

  const esc = (v: string) => `"${v.replaceAll('"', '""')}"`;
  const rows: string[] = ["date,type,category,description,amount"];
  for (const r of ledger.invoiced) {
    rows.push(`${r.date.toISOString().slice(0, 10)},income,invoiced,${esc(`Invoice ${r.number} — ${r.customer}`)},${r.amount.toFixed(2)}`);
  }
  for (const c of ledger.collected) {
    rows.push(`${c.date.toISOString().slice(0, 10)},income,collected,${esc(`Payment (${c.method})${c.note ? ` — ${c.note}` : ""}`)},${c.amount.toFixed(2)}`);
  }
  for (const r of ledger.receiptRows) {
    rows.push(`${r.date.toISOString().slice(0, 10)},expense,${r.category},${esc(r.vendor ?? "receipt")},${r.amount.toFixed(2)}`);
  }
  for (const b of ledger.billRows) {
    rows.push(`${year}-${String(b.month + 1).padStart(2, "0")}-01,expense,${b.category},${esc(`Bill — ${b.name}`)},${b.amount.toFixed(2)}`);
  }

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="rce-financials-${year}.csv"`);
  res.send(rows.join("\n"));
}));
