/**
 * The invoice GROUP — a signed estimate plus every SIGNED change order pointing at it.
 * (Kyle, 2026-09-20, after the Godwin job: "Every one a new estimate, a new deposit
 * requirement, and a new charge." What he wants: "apply a change order to an already signed
 * invoice. This will add to the cost of the job and allow a single payment once its all
 * finished.")
 *
 * THE DOCUMENTS STAY FROZEN AND SEPARATE — that is the audit trail. What this module changes is
 * the MONEY: one billed total, one deposit, one balance, one pay link, one payment at the end.
 *
 * Rules, all pinned by tests/changeOrderInvoice.test.ts:
 *   - The ROOT is the estimate with `changeOrderForId = null`. A change order's money rolls
 *     into its root; asking about a change order by id answers about the whole invoice.
 *   - Only SIGNED, LIVE change orders count (signed, not void, not superseded). An unsigned or
 *     voided change order counts nothing — its lines are not agreed work.
 *   - The deposit is optional per document: the ⅓ is taken on the sum of the homeowner shares
 *     of the documents whose `depositRequired` is on. No document on -> no deposit, nothing
 *     gates scheduling.
 *   - Payments count for the root and its live change orders. New payments are recorded on
 *     the ROOT (the checkout metadata and the manual record route both resolve to it), so a
 *     later void of one change order never carries the invoice's money away with it. Money
 *     that history left on a change order's own row (before 2026-09-20) counts while that
 *     change order is live and is listed for Kyle by the void route if it is voided — the
 *     same manual-refund rule a standalone void has always had.
 *   - Warranty coverage and discounts stay PER DOCUMENT (each is frozen at that document's
 *     signature); the group sums the homeowner shares and the warranty shares separately.
 */

import type { PrismaClient } from "@prisma/client";
import { billedTotalOf, depositDueOf, fullBillOf, warrantyCoverageOf, type BilledTotalInput, type WarrantyClaim } from "./stripePayments";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The columns the roll-up reads off an issued row. `select`-able from any caller. */
export const INVOICE_DOC_SELECT = {
  id: true, number: true, revision: true, status: true, token: true, title: true,
  customerId: true, customerName: true, customerEmail: true, serviceAddress: true, serviceAddressId: true,
  signedAt: true, voidedAt: true, jobVisitId: true, visitId: true,
  changeOrderForId: true, depositRequired: true, addToCurrentJob: true,
  total: true, tripCharge: true, selectedOptions: true, comboCapJson: true, discountJson: true, warrantyJson: true,
  paymentRemindersSent: true, lastPaymentReminderAt: true,
  options: { select: { option: true, subtotal: true } },
} as const;

export interface InvoiceDocRow {
  id: string;
  number: string;
  revision: number;
  status: string;
  token: string;
  title: string;
  customerId: string;
  customerName: string;
  customerEmail: string | null;
  serviceAddress: string | null;
  serviceAddressId: string;
  signedAt: Date | null;
  voidedAt: Date | null;
  jobVisitId: string | null;
  visitId: string | null;
  changeOrderForId: string | null;
  depositRequired: boolean;
  addToCurrentJob: boolean;
  total: number;
  tripCharge: number;
  selectedOptions: string[];
  comboCapJson: string | null;
  discountJson: string | null;
  warrantyJson: string | null;
  paymentRemindersSent: number;
  lastPaymentReminderAt: Date | null;
  options: { option: string; subtotal: number }[];
}

/** One document of the invoice, with its own frozen arithmetic. */
export interface InvoiceDocument {
  id: string;
  number: string;
  revision: number;
  title: string;
  kind: "invoice" | "change_order";
  signedAt: Date | null;
  depositRequired: boolean;
  /** The homeowner share of this document (coverage off). */
  billedTotal: number;
  /** Homeowner + warranty share — what the document earns in total. */
  fullBill: number;
  warrantyCovered: number;
  warrantyClaim: WarrantyClaim | null;
}

export interface InvoiceGroup {
  root: InvoiceDocRow;
  /** Signed, live change orders on the root, oldest first. */
  changeOrders: InvoiceDocRow[];
  documents: InvoiceDocument[];
  /** Every id money may sit on: the root and its live change orders. */
  ids: string[];
  /** Sum of the homeowner shares. */
  billedTotal: number;
  /** Sum of the full bills — the revenue rung. */
  fullBill: number;
  /** Sum of the warranty shares. */
  warrantyCovered: number;
  /** The homeowner shares of the documents whose deposit flag is on. */
  depositBase: number;
  /** ⅓ of depositBase, to the cent. 0 when no document requires a deposit. */
  depositDue: number;
  /** Any document in the group requires a deposit. */
  depositRequired: boolean;
}

export function moneyOf(row: InvoiceDocRow): BilledTotalInput {
  return {
    total: row.total,
    tripCharge: row.tripCharge,
    selectedOptions: row.selectedOptions,
    comboCapJson: row.comboCapJson,
    discountJson: row.discountJson,
    warrantyJson: row.warrantyJson,
    optionsSubtotals: row.options.map((o) => ({ option: o.option, subtotal: o.subtotal })),
  };
}

export function documentOf(row: InvoiceDocRow): InvoiceDocument {
  const money = moneyOf(row);
  const coverage = warrantyCoverageOf(money);
  return {
    id: row.id,
    number: row.number,
    revision: row.revision,
    title: row.title,
    kind: row.changeOrderForId ? "change_order" : "invoice",
    signedAt: row.signedAt,
    depositRequired: row.depositRequired,
    billedTotal: billedTotalOf(money),
    fullBill: fullBillOf(money),
    warrantyCovered: coverage?.applied ?? 0,
    warrantyClaim: coverage?.claim ?? null,
  };
}

/**
 * A signed row that is still agreed work: signed, not void. `status` is an ALLOW-LIST
 * (2026-09-20, extended to every money site 2026-09-21 — PUNCHLIST A9): `not: "void"` let every
 * status nobody had thought of — lost was the first — roll into the invoice and the technician's
 * brief. A signed row's status is "signed" and the only status it can ever move to is "void"
 * (every writer of IssuedEstimate.status was audited: the send path keeps it, the view path
 * returns early, the expiry sweep and the lost route refuse a signed row, and a revision never
 * touches the row it supersedes). Anything else is not agreed work.
 */
export const LIVE_SIGNED = {
  signedAt: { not: null },
  voidedAt: null,
  status: "signed",
} as const;

/** The in-memory twin of LIVE_SIGNED, for rows a list route already loaded. */
export function isLiveSigned(row: { signedAt: Date | null; voidedAt: Date | null; status: string }): boolean {
  return Boolean(row.signedAt) && !row.voidedAt && row.status === "signed";
}

/**
 * ROOT FIRST (2026-09-20; shared in-memory form 2026-09-21, PUNCHLIST A11): among a job's live
 * signed rows, NEWEST FIRST, the estimate that owns the job is the newest ROOT — never a change
 * order, however recent. A change order stands in only when the job has no root at all (legacy
 * data). `signedRootForJob` and GET /jobs both apply this so the payment panel and the job card
 * cannot name different documents.
 */
export function rootFirst<T extends { changeOrderForId: string | null }>(rowsNewestFirst: readonly T[]): T | null {
  return rowsNewestFirst.find((r) => !r.changeOrderForId) ?? rowsNewestFirst[0] ?? null;
}

/**
 * A change order that counts: signed, not void, not superseded (a change order revised into an
 * unsigned revision keeps counting until that revision is signed — then the old row is void,
 * see issuedEstimateService.ts adoptSupersededInvoice — so `supersededBy: null` here only ever
 * hides a row that is void anyway; it is kept as belt and braces).
 */
export const LIVE_SIGNED_CHANGE_ORDER = {
  ...LIVE_SIGNED,
  supersededBy: null,
} as const;

/**
 * Pure roll-up — the arithmetic every surface shares. `changeOrders` must already be the LIVE
 * SIGNED ones (the loader below filters; list routes filter in their own query).
 */
export function rollupInvoice(root: InvoiceDocRow, changeOrders: InvoiceDocRow[]): InvoiceGroup {
  const documents = [documentOf(root), ...changeOrders.map(documentOf)];
  const billedTotal = round2(documents.reduce((s, d) => s + d.billedTotal, 0));
  const fullBill = round2(documents.reduce((s, d) => s + d.fullBill, 0));
  const warrantyCovered = round2(documents.reduce((s, d) => s + d.warrantyCovered, 0));
  const depositBase = round2(documents.filter((d) => d.depositRequired).reduce((s, d) => s + d.billedTotal, 0));
  // One rounding, on the sum — not a sum of per-document thirds.
  const depositDue = depositBase > 0 ? depositDueOf(depositBase) : 0;
  return {
    root,
    changeOrders,
    documents,
    ids: [root.id, ...changeOrders.map((c) => c.id)],
    billedTotal,
    fullBill,
    warrantyCovered,
    depositBase,
    depositDue,
    depositRequired: depositDue > 0,
  };
}

/**
 * Load the invoice group an estimate belongs to. Given a change order's id, this answers about
 * its ROOT — a change order has no invoice of its own. Null when the id is unknown.
 *
 * Walks up at most a few links: the change-order route and the migration both flatten a change
 * order raised against a change order to the root, so a chain deeper than one is legacy data.
 */
export async function loadInvoiceGroup(prisma: PrismaClient, estimateId: string): Promise<InvoiceGroup | null> {
  const first = await prisma.issuedEstimate.findUnique({ where: { id: estimateId }, select: INVOICE_DOC_SELECT });
  if (!first) return null;
  let row: InvoiceDocRow = first as InvoiceDocRow;
  for (let hop = 0; row.changeOrderForId && hop < 5; hop += 1) {
    const parent = await prisma.issuedEstimate.findUnique({ where: { id: row.changeOrderForId }, select: INVOICE_DOC_SELECT });
    // A missing parent (SetNull), a VOID one (only possible on legacy data — the void route now
    // refuses a root with live change orders) or a LOST one: this change order stands alone as
    // its own invoice, honestly, rather than rolling its money into a document that is off the
    // books or that the customer turned down.
    if (!parent || parent.voidedAt || parent.status === "void" || parent.status === "lost") break;
    row = parent as InvoiceDocRow;
  }
  /*
    FORWARD, too (2026-09-21, PUNCHLIST A1): a signed root that was revised and whose revision
    has since been SIGNED is history — its change orders, its payments and its job moved onto the
    revision the moment that was signed (issuedEstimateService.ts adoptSupersededInvoice), and
    it was voided with that reason. Asked about the old row (a stale tab, a receipt's provenance
    column), this answers about the newest SIGNED revision in its chain, where the money now is.
    Unsigned revisions in between are stepped over; while NO later revision is signed, the old
    row is still the invoice and this loop changes nothing.
  */
  let cursor: { id: string } = row;
  let live = row;
  for (let hop = 0; hop < 25; hop += 1) {
    const next = await prisma.issuedEstimate.findUnique({ where: { supersedesId: cursor.id }, select: INVOICE_DOC_SELECT });
    if (!next) break;
    cursor = next;
    if (next.signedAt) live = next as InvoiceDocRow;
  }
  row = live;
  const changeOrders = await prisma.issuedEstimate.findMany({
    where: { changeOrderForId: row.id, ...LIVE_SIGNED_CHANGE_ORDER },
    orderBy: { signedAt: "asc" },
    select: INVOICE_DOC_SELECT,
  });
  return rollupInvoice(row, changeOrders as InvoiceDocRow[]);
}

/** The id money is recorded against: the root of whatever estimate was named. */
export async function invoiceRootId(prisma: PrismaClient, estimateId: string): Promise<string> {
  const group = await loadInvoiceGroup(prisma, estimateId);
  return group?.root.id ?? estimateId;
}

/**
 * THE signed estimate for a job — the ROOT invoice, never a change order.
 *
 * Every "which signed estimate owns this job" lookup used to be `findFirst … orderBy createdAt
 * desc`, which returned the NEWEST signed document on the job. A change order that joined the
 * job (Kyle's "add to current job") is exactly that newest document, so those lookups would
 * have started answering with the change order alone: its number on the payment panel, its
 * lines as the field brief, its share as the balance. Roots first; a legacy change order with
 * no live root resolves through its own group.
 */
export async function signedRootForJob(
  prisma: PrismaClient,
  jobId: string,
): Promise<InvoiceDocRow | null> {
  const rows = await prisma.issuedEstimate.findMany({
    where: { ...LIVE_SIGNED, OR: [{ jobVisitId: jobId }, { visitId: jobId }] },
    orderBy: { createdAt: "desc" },
    select: INVOICE_DOC_SELECT,
  }) as InvoiceDocRow[];
  const pick = rootFirst(rows);
  if (!pick) return null;
  if (!pick.changeOrderForId) return pick;
  const group = await loadInvoiceGroup(prisma, pick.id);
  return group?.root ?? null;
}

/**
 * Group a list of signed rows (as a list route loads them) into roots with their live change
 * orders — for /invoices, GET /jobs and the account summary, which must not run one query per
 * row. Change orders whose root is not in the list stand alone as their own root.
 */
export function groupSignedRows<T extends InvoiceDocRow>(rows: T[]): Map<string, { root: T; changeOrders: T[] }> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, { root: T; changeOrders: T[] }>();
  for (const r of rows) {
    if (!r.changeOrderForId || !byId.has(r.changeOrderForId)) out.set(r.id, { root: r, changeOrders: [] });
  }
  for (const r of rows) {
    if (r.changeOrderForId && out.has(r.changeOrderForId) && isLiveSigned(r)) {
      out.get(r.changeOrderForId)!.changeOrders.push(r);
    }
  }
  for (const g of out.values()) g.changeOrders.sort((a, b) => (a.signedAt?.getTime() ?? 0) - (b.signedAt?.getTime() ?? 0));
  return out;
}
