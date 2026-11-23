/**
 * The read-only queries behind the Research and CFO tools on /mcp (W2-B, Kyle 2026-11-23: Research gets "read-only access to jobs, invoices,
 * lead sources and calendar visits"; the CFO gets "read-only access to job/invoice/payment data"). R-f: ids, status and enum fields, dates, money
 * amounts, job and invoice numbers and at most a customer's FIRST name.
 *
 * What this file never selects, so it can never reach an agent: a phone, an email, a street, a last name, a token or pay link, the free text
 * (notes, purpose, an estimate's title or scope, a call outcome, a transcript), pay rates, commission or payroll, card or bank details. The
 * answer is still parsed through a named profile (profiles.ts) and the ONE scrub layer (respond.ts agentRespond) by the tool that calls these.
 *
 * Test-account rows (Kyle, 2026-09-11: "no incorporation into financial tracking at all") are left out with the SAME filters every money reader
 * uses (accountSpine.ts EXCLUDE_*). A job or invoice that belongs to the test account is "not found" by id too.
 *
 * Money is the invoice list's own arithmetic: services/invoiceMoney.ts is the ONE per-invoice money read, and GET /invoices (app.ts) calls
 * the same functions, so a figure or a payment status here and on that screen cannot disagree.
 *
 * Free text never leaves: a job's `jobType` is typed by hand (the lead form, the job drawer, the email-intake AI) and can hold a last name
 * or a description, so it is NOT read here; `mode` (a closed list) says what kind of job it is.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { AgentApiError } from "../agentApi/errors";
import { CALENDAR_DAY_TIME_ZONE, addDays, dayInstant, isDayString, toChicagoIso } from "../../shared/calendarDay";
import { zonedWallToInstant } from "../../shared/businessDays";
import { UNKNOWN_PLATFORM } from "../../shared/leadPlatform";
import { EXCLUDE_TEST_ACCOUNT, EXCLUDE_TEST_CUSTOMER, EXCLUDE_TEST_PAYER } from "./accountSpine";
import { campaignFirstName } from "./emailCampaigns";
import { INVOICE_DOC_SELECT, LIVE_SIGNED, invoiceRootId, type InvoiceDocRow } from "./invoiceGroup";
import { invoiceMoneyOf, loadInvoiceMoneyInputs, type InvoicePaymentStatus } from "./invoiceMoney";
import { NOT_A_LEAD_CALL_TYPES } from "./leadFunnel";

export const REPORT_LIMIT_DEFAULT = 50;
export const REPORT_LIMIT_MAX = 200;
/** The cap on a lead source / platform label in the profile (profiles.ts reportLeadSourcesSchema). */
export const REPORT_LABEL_MAX = 60;
/** Invoices are filtered by their payment status AFTER the money is worked out, so a range is read whole; this bounds that read. */
const INVOICE_SCAN_MAX = 2000;

// ── date ranges ──────────────────────────────────────────────────────────────────────────────────

export interface DayRange { from?: string; to?: string }

const badDay = (field: string): AgentApiError =>
  new AgentApiError("bad_request", { reason: `${field} must be a calendar day like 2026-11-23 (Chicago time).` });

/** A day range as instants: from = the start of its Chicago day, to = the START of the day AFTER `to` (so `to` is inclusive). */
export function instantRange(range: DayRange): { gte?: Date; lt?: Date } {
  const out: { gte?: Date; lt?: Date } = {};
  if (range.from !== undefined) {
    if (!isDayString(range.from) || Number.isNaN(dayInstant(range.from).getTime())) throw badDay("from");
    const [y, m, d] = range.from.split("-").map(Number);
    out.gte = zonedWallToInstant(y, m, d, 0, 0, CALENDAR_DAY_TIME_ZONE);
  }
  if (range.to !== undefined) {
    if (!isDayString(range.to) || Number.isNaN(dayInstant(range.to).getTime())) throw badDay("to");
    const [y, m, d] = addDays(range.to, 1).split("-").map(Number);
    out.lt = zonedWallToInstant(y, m, d, 0, 0, CALENDAR_DAY_TIME_ZONE);
  }
  return out;
}

const whenRange = (field: string, r: { gte?: Date; lt?: Date }) => (r.gte || r.lt ? { [field]: r } : {});

const limitOf = (limit: number | undefined): number => Math.min(REPORT_LIMIT_MAX, Math.max(1, limit ?? REPORT_LIMIT_DEFAULT));
const iso = (d: Date | null | undefined): string | null => (d ? toChicagoIso(d) : null);

// ── jobs (a job is a Visit) ──────────────────────────────────────────────────────────────────────

const JOB_SELECT = {
  id: true, status: true, mode: true, visitDate: true, scheduledStart: true, scheduledEnd: true,
  completedAt: true, contractedAt: true, customerId: true, revenue: true, laborHours: true,
  customer: { select: { name: true } },
} as const;

export interface JobRead {
  id: string; status: string; mode: string;
  visit_date: string; scheduled_start: string | null; scheduled_end: string | null; completed_at: string | null; contracted_at: string | null;
  customer_id: string; customer_first_name: string | null; invoice_number: string | null; contracted_revenue: number | null; labor_hours: number | null;
}

/** The signed invoice number each job carries (the root, never a change order): one query for the whole page. */
async function invoiceNumbersByJob(db: PrismaClient, jobIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (jobIds.length === 0) return out;
  const rows = await db.issuedEstimate.findMany({
    where: { ...LIVE_SIGNED, changeOrderForId: null, OR: [{ jobVisitId: { in: jobIds } }, { visitId: { in: jobIds } }] },
    select: { number: true, jobVisitId: true, visitId: true, signedAt: true },
    orderBy: { signedAt: "asc" },
  });
  // The job the estimate produced (jobVisitId) wins over the visit it was built from; the newest signed root wins among equals.
  for (const r of rows) if (r.visitId && jobIds.includes(r.visitId)) out.set(r.visitId, r.number);
  for (const r of rows) if (r.jobVisitId && jobIds.includes(r.jobVisitId)) out.set(r.jobVisitId, r.number);
  return out;
}

type JobRow = {
  id: string; status: string; mode: string; visitDate: Date; scheduledStart: Date | null; scheduledEnd: Date | null;
  completedAt: Date | null; contractedAt: Date | null; customerId: string; revenue: number | null; laborHours: number | null; customer: { name: string };
};

async function jobReads(db: PrismaClient, rows: JobRow[]): Promise<JobRead[]> {
  const numbers = await invoiceNumbersByJob(db, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id, status: r.status, mode: r.mode,
    visit_date: toChicagoIso(r.visitDate), scheduled_start: iso(r.scheduledStart), scheduled_end: iso(r.scheduledEnd),
    completed_at: iso(r.completedAt), contracted_at: iso(r.contractedAt),
    customer_id: r.customerId, customer_first_name: campaignFirstName(r.customer.name),
    invoice_number: numbers.get(r.id) ?? null, contracted_revenue: r.revenue, labor_hours: r.laborHours,
  }));
}

export async function listJobs(
  input: DayRange & { status?: string; limit?: number }, db: PrismaClient = defaultPrisma,
): Promise<{ items: JobRead[]; truncated: boolean }> {
  const limit = limitOf(input.limit);
  const rows = await db.visit.findMany({
    where: { AND: [EXCLUDE_TEST_CUSTOMER, input.status ? { status: input.status } : {}, whenRange("visitDate", instantRange(input))] },
    select: JOB_SELECT, orderBy: [{ visitDate: "desc" }, { id: "desc" }], take: limit + 1,
  });
  return { items: await jobReads(db, rows.slice(0, limit)), truncated: rows.length > limit };
}

export async function getJob(id: string, db: PrismaClient = defaultPrisma): Promise<JobRead> {
  const row = await db.visit.findFirst({ where: { AND: [{ id }, EXCLUDE_TEST_CUSTOMER] }, select: JOB_SELECT });
  if (!row) throw new AgentApiError("not_found", { reason: "Job not found." });
  return (await jobReads(db, [row]))[0]!;
}

// ── calendar visits ──────────────────────────────────────────────────────────────────────────────

export interface VisitRead {
  id: string; status: string; mode: string; scheduled_start: string | null; scheduled_end: string | null;
  customer_id: string; customer_first_name: string | null; technician_first_names: string[];
}

/** Visits whose scheduled start falls in the range, soonest first. A visit IS the job record, so `id` is the job id. */
export async function listVisits(
  input: DayRange & { limit?: number }, db: PrismaClient = defaultPrisma,
): Promise<{ items: VisitRead[]; truncated: boolean }> {
  const limit = limitOf(input.limit);
  const range = instantRange(input);
  const rows = await db.visit.findMany({
    where: { AND: [EXCLUDE_TEST_CUSTOMER, { scheduledStart: { not: null } }, whenRange("scheduledStart", range)] },
    select: {
      id: true, status: true, mode: true, scheduledStart: true, scheduledEnd: true, customerId: true,
      customer: { select: { name: true } },
      assignments: { select: { technician: { select: { name: true } } }, orderBy: { assignedAt: "asc" } },
    },
    orderBy: [{ scheduledStart: "asc" }, { id: "asc" }], take: limit + 1,
  });
  return {
    items: rows.slice(0, limit).map((r) => ({
      id: r.id, status: r.status, mode: r.mode, scheduled_start: iso(r.scheduledStart), scheduled_end: iso(r.scheduledEnd),
      customer_id: r.customerId, customer_first_name: campaignFirstName(r.customer.name),
      technician_first_names: r.assignments.map((a) => campaignFirstName(a.technician.name)),
    })),
    truncated: rows.length > limit,
  };
}

// ── invoices (a signed estimate and the change orders signed onto it) ────────────────────────────

export interface InvoiceRead {
  id: string; number: string; revision: number; status: string; payment_status: InvoicePaymentStatus;
  customer_id: string; customer_first_name: string | null; job_id: string | null; signed_at: string | null;
  billed_total: number; deposit_due: number; deposit_required: boolean; financing_fee: number; total_paid: number; balance: number; last_paid_at: string | null;
  change_orders: Array<{ number: string; billed_total: number; signed_at: string | null }>;
}

const INVOICE_SELECT = { ...INVOICE_DOC_SELECT, customerId: true, createdAt: true } as const;

/** The invoice rows for these live signed ROOTS, with their change orders, payments and financing fee: a handful of batched queries, never one per row. */
async function invoiceReads(db: PrismaClient, roots: InvoiceDocRow[]): Promise<InvoiceRead[]> {
  if (roots.length === 0) return [];
  const inputs = await loadInvoiceMoneyInputs(db, roots.map((r) => r.id));
  return roots.map((root) => {
    const { group, financingFee, totalPaid, owed, lastPaidAt, paymentStatus } = invoiceMoneyOf(root, inputs);
    return {
      id: root.id, number: root.number, revision: root.revision, status: root.status, payment_status: paymentStatus,
      customer_id: root.customerId, customer_first_name: campaignFirstName(root.customerName), job_id: root.jobVisitId ?? root.visitId ?? null,
      signed_at: iso(root.signedAt), billed_total: group.billedTotal, deposit_due: group.depositDue, deposit_required: group.depositRequired,
      financing_fee: financingFee?.fee ?? 0, total_paid: totalPaid, balance: Math.round((owed - totalPaid) * 100) / 100, last_paid_at: iso(lastPaidAt),
      change_orders: group.documents.filter((d) => d.kind === "change_order").map((d) => ({ number: d.number, billed_total: d.billedTotal, signed_at: iso(d.signedAt) })),
    };
  });
}

export async function listInvoices(
  input: DayRange & { status?: string; limit?: number }, db: PrismaClient = defaultPrisma,
): Promise<{ items: InvoiceRead[]; truncated: boolean }> {
  const limit = limitOf(input.limit);
  const range = instantRange(input);
  const roots = (await db.issuedEstimate.findMany({
    where: { AND: [{ ...LIVE_SIGNED, changeOrderForId: null }, EXCLUDE_TEST_ACCOUNT, whenRange("signedAt", range)] },
    select: INVOICE_SELECT, orderBy: [{ signedAt: "desc" }, { id: "desc" }], take: INVOICE_SCAN_MAX,
  })) as unknown as InvoiceDocRow[];
  const all = await invoiceReads(db, roots);
  const matching = input.status ? all.filter((i) => i.payment_status === input.status) : all;
  return { items: matching.slice(0, limit), truncated: matching.length > limit || roots.length === INVOICE_SCAN_MAX };
}

/** One invoice by its id. A change order's id answers about the invoice it joined (the CRM's rule). Not found for the test account. */
export async function getInvoice(id: string, db: PrismaClient = defaultPrisma): Promise<InvoiceRead> {
  const rootId = await invoiceRootId(db, id);
  const root = (await db.issuedEstimate.findFirst({
    where: { AND: [{ id: rootId }, { ...LIVE_SIGNED }, EXCLUDE_TEST_ACCOUNT] }, select: INVOICE_SELECT,
  })) as unknown as InvoiceDocRow | null;
  if (!root) throw new AgentApiError("not_found", { reason: "Invoice not found." });
  return (await invoiceReads(db, [root]))[0]!;
}

// ── payments (the CFO) ───────────────────────────────────────────────────────────────────────────

export interface PaymentRead {
  id: string; invoice_id: string | null; job_id: string | null; amount: number; refunded_amount: number;
  method: string; kind: string; status: string; payer: string; received_at: string | null; voided: boolean;
}

/** Payments received in the range (by their paid date), newest first. Never the check number, a note, a Stripe id or any financing detail. */
export async function listPayments(
  input: DayRange & { limit?: number }, db: PrismaClient = defaultPrisma,
): Promise<{ items: PaymentRead[]; truncated: boolean }> {
  const limit = limitOf(input.limit);
  const rows = await db.payment.findMany({
    where: { AND: [EXCLUDE_TEST_PAYER, whenRange("paidAt", instantRange(input))] },
    select: { id: true, estimateId: true, visitId: true, amount: true, refundedAmount: true, method: true, kind: true, status: true, payer: true, paidAt: true, voidedAt: true },
    orderBy: [{ paidAt: "desc" }, { id: "desc" }], take: limit + 1,
  });
  return {
    items: rows.slice(0, limit).map((p) => ({
      id: p.id, invoice_id: p.estimateId, job_id: p.visitId, amount: p.amount, refunded_amount: p.refundedAmount, method: p.method, kind: p.kind,
      status: p.status, payer: p.payer, received_at: iso(p.paidAt), voided: p.voidedAt !== null,
    })),
    truncated: rows.length > limit,
  };
}

// ── lead sources (Research): counts only, no lead identities ─────────────────────────────────────

export interface LeadSourceCounts {
  from: string | null; to: string | null; total: number;
  by_source: Array<{ source: string; count: number }>;
  by_platform: Array<{ platform: string; count: number }>;
}

/**
 * Leads by how they arrived (`source`, the channel) and by who sent them (`platform`), for leads received in the range (Chicago days). The
 * same rules the funnel report counts by: the moment the lead REALLY arrived (Lead.receivedAt), test-account leads out, and calls that
 * were not leads (wrong number, solicitation, vendor) out. Counts and the two labels only: no id, name, contact or note leaves.
 */
export async function leadSourceCounts(input: DayRange, db: PrismaClient = defaultPrisma): Promise<LeadSourceCounts> {
  // The same Chicago-day window every other read tool here uses (instantRange also validates both days).
  const testIds = new Set((await db.customer.findMany({ where: { isTestAccount: true }, select: { id: true } })).map((c) => c.id));
  const leads = await db.lead.findMany({
    where: whenRange("receivedAt", instantRange(input)),
    select: { source: true, platform: true, callType: true, customerId: true },
  });
  const tally = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const bySource = new Map<string, number>();
  const byPlatform = new Map<string, number>();
  let total = 0;
  for (const l of leads) {
    if (l.customerId && testIds.has(l.customerId)) continue;
    if ((NOT_A_LEAD_CALL_TYPES as readonly string[]).includes(l.callType ?? "")) continue;
    total += 1;
    // Lead.source / platform arrive from public forms with no length limit; cut to the profile's cap so one long value cannot fail the tool.
    tally(bySource, l.source.slice(0, REPORT_LABEL_MAX));
    tally(byPlatform, (l.platform ?? UNKNOWN_PLATFORM).slice(0, REPORT_LABEL_MAX));
  }
  const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return {
    from: input.from ?? null, to: input.to ?? null, total,
    by_source: sorted(bySource).map(([source, count]) => ({ source, count })),
    by_platform: sorted(byPlatform).map(([platform, count]) => ({ platform, count })),
  };
}
