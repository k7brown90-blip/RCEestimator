/**
 * The ONE per-invoice money read (W2-B review: one tool for one task). The CRM's Invoices list (GET /invoices in app.ts) and the agents'
 * invoice reads (services/agentReports.ts, the Research and CFO tools on /mcp) both ask this file for an invoice's change orders, its paid
 * payments, its financing fee, what is owed, what is paid and its payment status, so a figure on one cannot disagree with the other.
 *
 * Rules carried here, unchanged from the Invoices list (Kyle, 2026-09-07 .. 2026-10-09):
 *   - signed, live change orders ride the invoice they joined (LIVE_SIGNED_CHANGE_ORDER);
 *   - only PAID, non-voided payments count; money left on a change order's own row counts on its ROOT invoice;
 *   - totalPaid / balance / paymentStatus are the HOMEOWNER's (splitPaidByPayer; the warranty company's money is its own ledger);
 *   - what is OWED is the documents plus the live financing fee (the same arithmetic paymentSummary runs);
 *   - "deposit_paid" only means something when a deposit is required (2026-09-20).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { INVOICE_DOC_SELECT, LIVE_SIGNED_CHANGE_ORDER, rollupInvoice, type InvoiceDocRow, type InvoiceGroup } from "./invoiceGroup";
import { splitPaidByPayer } from "./stripePayments";
import { activeFinancingFeesByRoot, type FinancingFeeView } from "./financingFee";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export type InvoicePaymentStatus = "paid" | "deposit_paid" | "partial" | "unpaid";

/** The payment status of an invoice: the one rule (paid in full, else deposit met when required, else partial, else unpaid). */
export function invoicePaymentStatus(input: { totalPaid: number; owed: number; depositRequired: boolean; depositDue: number }): InvoicePaymentStatus {
  if (input.totalPaid >= input.owed - 0.01) return "paid";
  if (input.depositRequired && input.totalPaid >= input.depositDue - 0.01) return "deposit_paid";
  return input.totalPaid > 0.009 ? "partial" : "unpaid";
}

const PAID_SELECT = { estimateId: true, amount: true, method: true, paidAt: true, payer: true, refundedAmount: true } as const;
export type InvoicePaidRow = Prisma.PaymentGetPayload<{ select: typeof PAID_SELECT }>;

/** What one batched read finds for a set of root invoices. */
export interface InvoiceMoneyInputs {
  /** Every signed live change order on those roots, flat (their ids are where money may also sit). */
  changeOrderRows: InvoiceDocRow[];
  changeOrdersByRoot: Map<string, InvoiceDocRow[]>;
  /** Paid, non-voided payments keyed by the ROOT invoice. */
  paymentsByRoot: Map<string, InvoicePaidRow[]>;
  feesByRoot: Map<string, FinancingFeeView>;
}

/** Three batched queries (change orders, payments, fees) for the given root ids, never one per row. */
export async function loadInvoiceMoneyInputs(db: PrismaClient, rootIds: string[]): Promise<InvoiceMoneyInputs> {
  const changeOrderRows = rootIds.length === 0 ? [] : ((await db.issuedEstimate.findMany({
    where: { changeOrderForId: { in: rootIds }, ...LIVE_SIGNED_CHANGE_ORDER },
    select: INVOICE_DOC_SELECT,
    orderBy: { signedAt: "asc" },
  })) as unknown as InvoiceDocRow[]);
  const changeOrdersByRoot = new Map<string, InvoiceDocRow[]>();
  for (const co of changeOrderRows) changeOrdersByRoot.set(co.changeOrderForId!, [...(changeOrdersByRoot.get(co.changeOrderForId!) ?? []), co]);

  const paidRows = rootIds.length === 0 ? [] : await db.payment.findMany({
    // Voided rows (2026-10-09, services/paymentVoid.ts) are listed on the invoice's own panel but are not money: they count in no
    // total, balance or status. refundedAmount: a card refund recorded from Stripe comes off inside splitPaidByPayer.
    where: { estimateId: { in: [...rootIds, ...changeOrderRows.map((c) => c.id)] }, status: "paid", voidedAt: null },
    select: PAID_SELECT,
  });
  // Keyed by the ROOT: money that history left on a change order's own row counts on its invoice.
  const rootOfId = new Map<string, string>(changeOrderRows.map((c) => [c.id, c.changeOrderForId!]));
  const paymentsByRoot = new Map<string, InvoicePaidRow[]>();
  for (const row of paidRows) {
    if (!row.estimateId) continue;
    const key = rootOfId.get(row.estimateId) ?? row.estimateId;
    paymentsByRoot.set(key, [...(paymentsByRoot.get(key) ?? []), row]);
  }
  // The live financing fee per invoice (Kyle, 2026-10-08): owed on top of the documents, NOT in billedTotal or depositDue.
  const feesByRoot = await activeFinancingFeesByRoot(db, rootIds);
  return { changeOrderRows, changeOrdersByRoot, paymentsByRoot, feesByRoot };
}

export interface InvoiceMoney {
  group: InvoiceGroup;
  split: ReturnType<typeof splitPaidByPayer<InvoicePaidRow>>;
  financingFee: FinancingFeeView | null;
  /** The documents plus the financing fee. */
  owed: number;
  /** The homeowner's paid total (a settlement figure: legacy "discount" rows stay in). */
  totalPaid: number;
  lastPaidAt: Date | null;
  paymentStatus: InvoicePaymentStatus;
}

/** One root invoice's money, from what loadInvoiceMoneyInputs read. */
export function invoiceMoneyOf(root: InvoiceDocRow, inputs: InvoiceMoneyInputs): InvoiceMoney {
  const group = rollupInvoice(root, inputs.changeOrdersByRoot.get(root.id) ?? []);
  const split = splitPaidByPayer(inputs.paymentsByRoot.get(root.id) ?? []);
  const financingFee = inputs.feesByRoot.get(root.id) ?? null;
  const owed = round2(group.billedTotal + (financingFee?.fee ?? 0));
  const totalPaid = split.customerPaid;
  const lastPaidAt = split.customer.reduce<Date | null>((latest, r) => (r.paidAt && (!latest || r.paidAt > latest) ? r.paidAt : latest), null);
  const paymentStatus = invoicePaymentStatus({ totalPaid, owed, depositRequired: group.depositRequired, depositDue: group.depositDue });
  return { group, split, financingFee, owed, totalPaid, lastPaidAt, paymentStatus };
}
