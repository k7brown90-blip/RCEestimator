/**
 * The financing fee and the Synchrony payment — the money path for a financed balance (Kyle,
 * 2026-10-08, one-estimating-system plan decisions 7, 8, 11 and 12; Detail B build audit items
 * G and I; Phase 6 Unit 6A, 2026-10-09).
 *
 *   7.  Fee = 50% of the plan's Synchrony rate x the balance after the 1/3 deposit; financed =
 *       balance + fee. Computed by shared/financing.ts `financingFeeCents` — NEVER a second formula.
 *   8.  The 1/3 deposit is REQUIRED on a financed job: no no-deposit financing, no partial release.
 *   12. The plan is chosen when the balance is paid through Synchrony, not at signing.
 *
 * ── WHERE THE FEE LIVES ────────────────────────────────────────────────────────────────────────
 * Its own root-level record, `FinancingFee` (schema.prisma says why it cannot sit on the signed
 * document). Keyed to the ROOT invoice; OUTSIDE documentOf / billedTotalOf / depositBase
 * (services/invoiceGroup.ts), so the deposit is a third of the documents and never of the fee.
 *
 * ── WHO READS IT ───────────────────────────────────────────────────────────────────────────────
 * `paymentSummary` (stripePayments.ts) adds the live fee to the balance and carries it as
 * `financingFee`; everything that reads the summary (the CRM payment panel, the field payment-info,
 * the invoice email, the final bill, receipts, reminders, the scheduling gate) therefore agrees.
 * The list readers that roll money up themselves — GET /invoices, GET /jobs, the account summary,
 * the P&L's invoiced, job profitability, the commission basis — read `activeFinancingFeesByRoot`
 * and add the fee the same way. tests/financingFee.test.ts pins them against each other.
 *
 * ── THE CARD PATH NEVER SEES THE FEE ───────────────────────────────────────────────────────────
 * "The fee only exists on the Synchrony path." While a fee is applied AND NOT YET PAID
 * (`financingInProgress` below — the one test every closed rail reads), `chargeableAmount` refuses
 * (so /pay/:token, the Stripe checkout and the QR all stop with FINANCING_IN_PROGRESS), the CRM
 * greys its card and record-payment buttons with that reason, the deposit request is not sent, and
 * POST /financials/payments refuses any other customer method with it. The only money that closes
 * the financed balance is the Synchrony payment recorded here — or the fee is removed first, with a
 * reason, and the other rails reopen at the plain balance.
 * Once the Synchrony payment is recorded the fee is LOCKED and paid, and its job is done: whatever
 * is still owed after that (a deposit check that bounced and was voided, a change order signed
 * later) is plain invoice money, and card, cash, check and Zelle reopen for it at the balance.
 * (Review finding, 2026-10-09: with the lock closing every rail too, a voided deposit after the
 * Synchrony payment left $3,000 that could only be collected by voiding real Synchrony money.)
 *
 * ── THE EXITS (standing rule: nothing is permanent) ────────────────────────────────────────────
 * The fee is REMOVED with a reason (row kept, removedAt set) until the Synchrony payment is
 * recorded. Recording the payment LOCKS the fee: a live (not voided) Synchrony row naming it is
 * the lock, and voiding that payment (services/paymentVoid.ts, administrator only) is the exit —
 * the fee is then unlocked and can be removed or left for a second attempt.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  dollarsToCents,
  financingFeeCents,
  lenderCutCents,
  type FinancingPlan,
} from "../../shared/financing";
import { getActiveFinancingPlans, plansFromSnapshot } from "./financingSettings";
import { logSystemEvent } from "./systemEvents";

/** The one sentence every closed card path shows while a fee is applied. */
export const FINANCING_IN_PROGRESS = "Financing in progress — balance is being paid through Synchrony";

/**
 * The one state that closes the other rails: a fee is on the invoice and NOT yet paid through
 * Synchrony. A locked fee (a live Synchrony payment names it) is paid — money still owed after
 * that is plain invoice money and every rail is open for it. Every closed-rail check, server and
 * client, reads this and never `financingFee` alone (2026-10-09).
 */
export function financingInProgress(summary: { financingFee: { locked: boolean } | null | undefined }): boolean {
  return Boolean(summary.financingFee && !summary.financingFee.locked);
}

/**
 * DECISION 7 holds only on the balance the fee was worked on. A change order signed after the fee
 * went on (or a payment voided) moves the balance, and "balance + fee" would then be a new balance
 * plus a fee worked on the old one. The same words grey "Record Synchrony payment" on the CRM panel
 * (SynchronyFinancing.tsx) and refuse the record here (2026-10-09).
 */
export function feeBaseDriftReason(feeBase: number, balanceBeforeFee: number): string {
  return `The balance changed since the financing fee was added — the fee was worked on $${feeBase.toFixed(2)} and the balance after the deposit is now $${balanceBeforeFee.toFixed(2)} (a change order joined the invoice, or a payment was voided). Remove the financing fee (with a reason) and add it again so the fee is worked on the current balance.`;
}

export const FEE_REMOVE_REASON_MAX = 300;
export const FINANCING_AUTH_MAX = 60;

/** The actor every CRM write records — the PIN session is the office. */
export const FINANCING_ACTOR = "human:crm-session";

const round2 = (n: number) => Math.round(n * 100) / 100;
const toDollars = (cents: number) => cents / 100;

export class FinancingFeeError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "FinancingFeeError";
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

/** The live fee as every reader sees it. Dollars; NO rate field — safe for the CRM and the field. */
export interface FinancingFeeView {
  id: string;
  planNumber: string;
  planDescription: string;
  /** The fee itself, dollars. */
  fee: number;
  /** The homeowner balance the fee was worked on, dollars. */
  feeBase: number;
  appliedAt: Date;
  /** A live Synchrony payment names this fee — it cannot be removed until that payment is voided. */
  locked: boolean;
  lockedByPaymentId: string | null;
}

interface FeeRow {
  id: string;
  estimateId: string;
  planNumber: string;
  planDescription: string;
  discountRatePct: number;
  feeBaseCents: number;
  feeCents: number;
  appliedAt: Date;
}

const FEE_SELECT = {
  id: true, estimateId: true, planNumber: true, planDescription: true, discountRatePct: true,
  feeBaseCents: true, feeCents: true, appliedAt: true,
} as const;

/** The live Synchrony rows that lock fees, keyed by fee id. */
async function locksFor(db: Db, feeIds: string[]): Promise<Map<string, string>> {
  if (feeIds.length === 0) return new Map();
  const rows = await db.payment.findMany({
    where: { financingFeeId: { in: feeIds }, status: "paid", voidedAt: null },
    select: { id: true, financingFeeId: true },
  });
  return new Map(rows.map((r) => [r.financingFeeId!, r.id]));
}

function viewOf(row: FeeRow, lockedBy: string | null): FinancingFeeView {
  return {
    id: row.id,
    planNumber: row.planNumber,
    planDescription: row.planDescription,
    fee: toDollars(row.feeCents),
    feeBase: toDollars(row.feeBaseCents),
    appliedAt: row.appliedAt,
    locked: lockedBy !== null,
    lockedByPaymentId: lockedBy,
  };
}

/**
 * The live fee on an invoice — asked with every id money may sit on (the group's `ids`), because
 * a fee is written on the root and the root can change when a signed revision takes over.
 */
export async function activeFinancingFeeFor(db: Db, estimateIds: string[]): Promise<FinancingFeeView | null> {
  if (estimateIds.length === 0) return null;
  const row = await db.financingFee.findFirst({
    where: { estimateId: { in: estimateIds }, removedAt: null },
    orderBy: { appliedAt: "desc" },
    select: FEE_SELECT,
  });
  if (!row) return null;
  const locks = await locksFor(db, [row.id]);
  return viewOf(row, locks.get(row.id) ?? null);
}

/**
 * The live fees for a LIST of root ids, one query — for /invoices, GET /jobs, the account summary,
 * the P&L and job profitability, which must not run one query per row. Absent = no fee.
 */
export async function activeFinancingFeesByRoot(db: Db, rootIds: string[]): Promise<Map<string, FinancingFeeView>> {
  const out = new Map<string, FinancingFeeView>();
  if (rootIds.length === 0) return out;
  const rows = await db.financingFee.findMany({
    where: { estimateId: { in: rootIds }, removedAt: null },
    orderBy: { appliedAt: "desc" },
    select: FEE_SELECT,
  });
  const locks = await locksFor(db, rows.map((r) => r.id));
  for (const r of rows) if (!out.has(r.estimateId)) out.set(r.estimateId, viewOf(r, locks.get(r.id) ?? null));
  return out;
}

/** The fee in dollars for a root, 0 when none — the one-liner the revenue readers add. */
export function feeDollarsOf(fees: Map<string, FinancingFeeView>, rootId: string): number {
  return fees.get(rootId)?.fee ?? 0;
}

// ─── The plans a balance can be financed on ──────────────────────────────────────────────────

/**
 * The plans for THIS invoice: the root estimate's snapshot (frozen at issue, so a Settings edit
 * never changes a quote already sent), else the live Settings list when the estimate predates the
 * snapshot. Server-side — carries rates.
 */
async function plansForRoot(db: Db, rootId: string): Promise<FinancingPlan[]> {
  const est = await db.issuedEstimate.findUnique({ where: { id: rootId }, select: { financingPlansJson: true } });
  return plansFromSnapshot(est?.financingPlansJson) ?? await getActiveFinancingPlans();
}

export interface FinancingOption {
  planNumber: string;
  description: string;
  /** The fee this plan would add, dollars. */
  fee: number;
  /** balance + fee — what would be run on Synchrony. */
  financed: number;
}

export interface FinancingOptions {
  estimateId: string;
  number: string;
  /** The homeowner balance the fee would be worked on. */
  balance: number;
  /** Why no fee can be added right now — null when it can. The CRM shows this on the greyed button. */
  blockedReason: string | null;
  /** The fee already applied, when there is one. */
  applied: FinancingFeeView | null;
  options: FinancingOption[];
}

/**
 * DECISION 8 (Kyle, 2026-10-08), in one place: the 1/3 deposit is REQUIRED on a financed job and
 * must be in before the balance is financed. Null when it is. Checked when the fee is added AND
 * again when the Synchrony payment is recorded (Phase 6 Unit 6C) — a deposit voided or a
 * "Deposit required" tick removed in between must not let the balance be financed anyway.
 * The same sentence is shown on the CRM payment panel's greyed button and on the field payment
 * screen (payment-info `financingBlocked`), so the tech and the office read the same words.
 */
export function financingDepositReason(summary: { depositRequired: boolean; depositSatisfied: boolean }): string | null {
  if (!summary.depositRequired) {
    return "Financing needs the 1/3 deposit — tick \"Deposit required\" and collect it first (no no-deposit financing).";
  }
  if (!summary.depositSatisfied) return "The 1/3 deposit has not been collected yet — financing is for the balance after the deposit.";
  return null;
}

/**
 * Why a fee cannot be added to this invoice right now, in the words the greyed button shows.
 * Decision 8 is the big one: the 1/3 deposit must be collected first.
 */
export function financingBlockedReason(summary: {
  paidInFull: boolean; depositRequired: boolean; depositSatisfied: boolean; balance: number; financingFee: unknown;
}): string | null {
  if (summary.financingFee) return "A financing fee is already on this invoice.";
  if (summary.paidInFull) return "This invoice is paid in full — there is nothing to finance.";
  const deposit = financingDepositReason(summary);
  if (deposit) return deposit;
  if (!(summary.balance > 0)) return "Nothing is owed on this invoice.";
  return null;
}

/** What "Pay balance with Synchrony" shows: the balance and each plan's fee on it. */
export async function financingOptionsFor(prisma: PrismaClient, estimateId: string): Promise<FinancingOptions> {
  const { paymentSummary } = await import("./stripePayments");
  const summary = await paymentSummary(prisma, estimateId, "https://unused.invalid");
  if (!summary) throw new FinancingFeeError("Estimate not found.", 404);
  const blockedReason = financingBlockedReason(summary);
  const balanceCents = dollarsToCents(summary.balanceBeforeFee);
  const plans = await plansForRoot(prisma, summary.estimateId);
  return {
    estimateId: summary.estimateId,
    number: summary.number,
    balance: summary.balanceBeforeFee,
    blockedReason,
    applied: summary.financingFee,
    options: plans.filter((p) => p.active).map((p) => {
      const feeCents = financingFeeCents(balanceCents, p.discountRatePct);
      return { planNumber: p.planNumber, description: p.description, fee: toDollars(feeCents), financed: toDollars(balanceCents + feeCents) };
    }),
  };
}

// ─── Apply / remove ──────────────────────────────────────────────────────────────────────────

/**
 * "Add the financing fee" — the fee becomes real on the invoice. Refuses with the reason on screen
 * when the deposit is not in (decision 8), when the invoice is paid, or when a fee is already there.
 */
export async function applyFinancingFee(
  prisma: PrismaClient,
  estimateId: string,
  planNumber: string,
  actor: string = FINANCING_ACTOR,
): Promise<FinancingFeeView> {
  const { paymentSummary } = await import("./stripePayments");
  const summary = await paymentSummary(prisma, estimateId, "https://unused.invalid");
  if (!summary) throw new FinancingFeeError("Estimate not found.", 404);
  const blocked = financingBlockedReason(summary);
  if (blocked) throw new FinancingFeeError(blocked, 409);

  const wanted = (planNumber ?? "").trim();
  const plan = (await plansForRoot(prisma, summary.estimateId)).find((p) => p.active && p.planNumber === wanted);
  if (!plan) throw new FinancingFeeError(`Plan ${wanted || "?"} is not one of the plans offered on this estimate.`, 400);

  const feeBaseCents = dollarsToCents(summary.balanceBeforeFee);
  const feeCents = financingFeeCents(feeBaseCents, plan.discountRatePct);
  const row = await prisma.$transaction(async (tx) => {
    // Re-checked inside the transaction BEHIND A ROW LOCK on the root invoice: two clicks, two
    // tabs or a retry must not make two fees. Postgres runs READ COMMITTED, so a plain re-check
    // alone could still see nothing while the other insert was uncommitted; the lock makes the
    // second applier wait, and its re-check then sees the first one's commit (2026-10-09).
    await tx.$queryRaw`SELECT "id" FROM "IssuedEstimate" WHERE "id" = ${summary.estimateId} FOR UPDATE`;
    const existing = await tx.financingFee.findFirst({ where: { estimateId: summary.estimateId, removedAt: null }, select: { id: true } });
    if (existing) throw new FinancingFeeError("A financing fee is already on this invoice.", 409);
    const created = await tx.financingFee.create({
      data: {
        estimateId: summary.estimateId,
        planNumber: plan.planNumber,
        planDescription: plan.description,
        discountRatePct: plan.discountRatePct,
        feeBaseCents,
        feeCents,
        appliedBy: actor,
      },
      select: FEE_SELECT,
    });
    await tx.issuedEstimateEvent.create({
      data: {
        estimateId: summary.estimateId,
        type: "financing_fee_applied",
        actor,
        detail: `Financing fee added — Plan ${plan.planNumber} (${plan.description}): $${toDollars(feeCents).toFixed(2)} on a balance of $${toDollars(feeBaseCents).toFixed(2)}; $${toDollars(feeBaseCents + feeCents).toFixed(2)} to run on Synchrony.`,
      },
    });
    return created;
  });
  logSystemEvent("info", "financials", `Financing fee added — $${toDollars(feeCents).toFixed(2)} Plan ${plan.planNumber} on ${summary.number}`, {
    feeId: row.id, estimateId: summary.estimateId, planNumber: plan.planNumber, feeBase: toDollars(feeBaseCents), fee: toDollars(feeCents), actor,
  });
  return viewOf(row, null);
}

/**
 * "Remove financing fee" — with a reason, until the Synchrony payment is recorded. The row is
 * kept and marked, never deleted.
 */
export async function removeFinancingFee(
  prisma: PrismaClient,
  feeId: string,
  reason: string,
  actor: string = FINANCING_ACTOR,
): Promise<{ id: string; estimateId: string; removedAt: Date; removeReason: string }> {
  const why = (reason ?? "").trim();
  if (why.length === 0) throw new FinancingFeeError("Say why the financing fee is being removed.", 400);
  if (why.length > FEE_REMOVE_REASON_MAX) throw new FinancingFeeError(`Keep the reason under ${FEE_REMOVE_REASON_MAX} characters.`, 400);

  const fee = await prisma.financingFee.findUnique({ where: { id: feeId } });
  if (!fee) throw new FinancingFeeError("Financing fee not found.", 404);
  if (fee.removedAt) {
    throw new FinancingFeeError(`This fee was already removed on ${fee.removedAt.toISOString().slice(0, 10)}${fee.removeReason ? ` — ${fee.removeReason}` : ""}.`, 409);
  }
  const est = await prisma.issuedEstimate.findUnique({ where: { id: fee.estimateId }, select: { id: true, number: true } });
  const now = new Date();
  const label = `$${toDollars(fee.feeCents).toFixed(2)} Plan ${fee.planNumber}`;
  await prisma.$transaction(async (tx) => {
    // The lock check and the write sit together behind a row lock on the fee (2026-10-09): a
    // Synchrony payment being recorded at the same moment takes the same lock, so it either lands
    // first — and this refuses — or waits and finds the fee removed.
    await tx.$queryRaw`SELECT "id" FROM "FinancingFee" WHERE "id" = ${fee.id} FOR UPDATE`;
    const lock = (await locksFor(tx, [fee.id])).get(fee.id);
    if (lock) {
      throw new FinancingFeeError(
        "A Synchrony payment is recorded against this fee — void that payment first (administrator only); the fee unlocks when it is voided.",
        409,
      );
    }
    // Conditional write: a second remove racing this one updates nothing and is told so, instead
    // of overwriting the first remove's reason and time.
    const updated = await tx.financingFee.updateMany({
      where: { id: fee.id, removedAt: null },
      data: { removedAt: now, removedBy: actor, removeReason: why },
    });
    if (updated.count === 0) throw new FinancingFeeError("This fee was already removed.", 409);
    if (est) {
      await tx.issuedEstimateEvent.create({
        data: { estimateId: est.id, type: "financing_fee_removed", actor, detail: `Financing fee removed — ${label}: ${why}` },
      });
    }
  });
  logSystemEvent("warn", "financials", `Financing fee removed — ${label}${est ? ` on ${est.number}` : ""}: ${why}`, {
    feeId: fee.id, estimateId: fee.estimateId, fee: toDollars(fee.feeCents), actor,
  });
  return { id: fee.id, estimateId: fee.estimateId, removedAt: now, removeReason: why };
}

// ─── The Synchrony payment ───────────────────────────────────────────────────────────────────

export interface SynchronyPaymentInput {
  estimateId: string;
  /** The gross the customer authorized — defaults to the balance with the fee (what is owed). */
  amount?: number;
  planNumber?: string;
  authNumber: string;
  paidAt?: Date;
  note?: string | null;
  customerId?: string | null;
  visitId?: string | null;
}

/**
 * "Record Synchrony payment" — closes the financed balance. Needs the fee on the invoice (that is
 * what the customer authorized, and it carries the plan and the rate the cut is worked from); the
 * plan named must be the fee's plan; the balance must still be the one the fee was worked on; the
 * amount must be exactly what is owed — balance plus fee — because Synchrony releases the whole
 * financed amount at once (decision 8: no partial releases). Writes the Payment row (method
 * "synchrony", gross = amount, cut and net captured) and the invoice's audit event.
 */
export async function recordSynchronyPayment(prisma: PrismaClient, input: SynchronyPaymentInput, actor: string = FINANCING_ACTOR) {
  const auth = (input.authNumber ?? "").trim();
  if (!auth) throw new FinancingFeeError("Type Synchrony's authorization number for this payment.", 400);
  if (auth.length > FINANCING_AUTH_MAX) throw new FinancingFeeError(`Keep the authorization number under ${FINANCING_AUTH_MAX} characters.`, 400);

  const { paymentSummary } = await import("./stripePayments");
  const summary = await paymentSummary(prisma, input.estimateId, "https://unused.invalid");
  if (!summary) throw new FinancingFeeError("Estimate not found.", 404);
  const fee = summary.financingFee;
  if (!fee) {
    throw new FinancingFeeError("Add the financing fee first — \"Pay balance with Synchrony\" on the payment panel — so the plan and the fee are on the invoice before the payment is recorded.", 409);
  }
  if (fee.locked) throw new FinancingFeeError("A Synchrony payment is already recorded against this fee.", 409);
  // Decision 8, enforced where the money is recorded and not only where the fee is added.
  const depositReason = financingDepositReason(summary);
  if (depositReason) throw new FinancingFeeError(depositReason, 409);
  if (input.planNumber && input.planNumber.trim() !== fee.planNumber) {
    throw new FinancingFeeError(`The fee on this invoice is for Plan ${fee.planNumber} — remove the fee and add it again for Plan ${input.planNumber.trim()}.`, 409);
  }
  if (Math.abs(fee.feeBase - summary.balanceBeforeFee) > 0.01) {
    throw new FinancingFeeError(feeBaseDriftReason(fee.feeBase, summary.balanceBeforeFee), 409);
  }
  const owed = summary.balance;
  const amount = input.amount === undefined ? owed : round2(input.amount);
  if (!(amount > 0)) throw new FinancingFeeError("The amount must be more than $0.", 400);
  if (amount > owed + 0.01) throw new FinancingFeeError(`$${amount.toFixed(2)} is more than the $${owed.toFixed(2)} owed on ${summary.number} (balance plus the financing fee).`, 409);
  // NO PARTIAL RELEASES (Kyle, 2026-10-08, decision 8: "I will not include partial releases"). A
  // smaller amount would lock the fee with money still owed and the fee wrong for what was financed.
  if (amount < owed - 0.01) {
    throw new FinancingFeeError(
      `$${amount.toFixed(2)} is less than the $${owed.toFixed(2)} owed on ${summary.number} (balance plus the financing fee). Synchrony releases the whole financed amount at once — no partial releases. If the customer is financing a different amount, remove the fee (with a reason) and add it again on the right balance.`,
      409,
    );
  }

  const feeRow = await prisma.financingFee.findUniqueOrThrow({ where: { id: fee.id }, select: { discountRatePct: true } });
  const grossCents = dollarsToCents(amount);
  const cutCents = lenderCutCents(grossCents, feeRow.discountRatePct);
  const netCents = grossCents - cutCents;
  const paidAt = input.paidAt ?? new Date();

  const root = await prisma.issuedEstimate.findUniqueOrThrow({
    where: { id: summary.estimateId },
    select: { id: true, number: true, customerId: true, jobVisitId: true, visitId: true },
  });
  const payment = await prisma.$transaction(async (tx) => {
    // Re-checked BEHIND A ROW LOCK on the fee (2026-10-09): a double-submit, a retry or two tabs
    // must not write two Synchrony rows — the second would read as an overpayment, book Synchrony's
    // cut twice and send two receipts. removeFinancingFee takes the same lock, so a remove racing
    // this record is seen here too.
    await tx.$queryRaw`SELECT "id" FROM "FinancingFee" WHERE "id" = ${fee.id} FOR UPDATE`;
    const live = await tx.financingFee.findFirst({ where: { id: fee.id, removedAt: null }, select: { id: true } });
    if (!live) throw new FinancingFeeError("The financing fee was removed while this payment was being recorded — add it again first.", 409);
    if ((await locksFor(tx, [fee.id])).has(fee.id)) throw new FinancingFeeError("A Synchrony payment is already recorded against this fee.", 409);
    const row = await tx.payment.create({
      data: {
        amount,
        method: "synchrony",
        kind: "final",
        payer: "customer",
        status: "paid",
        customerId: input.customerId ?? root.customerId,
        estimateId: root.id,
        visitId: input.visitId ?? root.jobVisitId ?? root.visitId ?? null,
        note: input.note ?? null,
        paidAt,
        financingFeeId: fee.id,
        financingPlanNumber: fee.planNumber,
        financingAuthNumber: auth,
        financingNet: toDollars(netCents),
        financingCut: toDollars(cutCents),
      },
    });
    await tx.issuedEstimateEvent.create({
      data: {
        estimateId: root.id,
        type: "synchrony_payment",
        actor,
        detail: `Synchrony payment recorded — Plan ${fee.planNumber}, auth ${auth}: $${amount.toFixed(2)} financed; Synchrony's cut $${toDollars(cutCents).toFixed(2)}, $${toDollars(netCents).toFixed(2)} funded to Red Cedar.`,
      },
    });
    return row;
  });
  logSystemEvent("info", "financials", `Synchrony payment recorded — $${amount.toFixed(2)} Plan ${fee.planNumber} on ${root.number}; net funded $${toDollars(netCents).toFixed(2)}`, {
    paymentId: payment.id, estimateId: root.id, feeId: fee.id, planNumber: fee.planNumber, gross: amount, cut: toDollars(cutCents), net: toDollars(netCents), actor,
  });
  return payment;
}

/**
 * The year's Synchrony cuts for the P&L — one expense row per live Synchrony payment, in the month
 * it was paid, like Stripe's fee rows (treasury.ts stripeFeeRows). Collected stays GROSS.
 */
export async function synchronyCutRows(
  db: Db,
  bounds: { from: Date; to: Date },
  extraWhere: Prisma.PaymentWhereInput = {},
): Promise<{ month: number; amount: number; paymentId: string; net: number; date: Date; planNumber: string | null }[]> {
  const rows = await db.payment.findMany({
    where: { method: "synchrony", status: "paid", voidedAt: null, financingCut: { gt: 0 }, paidAt: { gte: bounds.from, lt: bounds.to }, ...extraWhere },
    select: { id: true, financingCut: true, financingNet: true, paidAt: true, financingPlanNumber: true },
  });
  return rows.map((r) => ({
    month: r.paidAt!.getMonth(), amount: r.financingCut!, paymentId: r.id, net: r.financingNet ?? 0, date: r.paidAt!, planNumber: r.financingPlanNumber,
  }));
}
