/**
 * Void a recorded commission — the exit from a Commission row (2026-10-09, one-estimating-system
 * plan, Phase 6 CARRY).
 *
 * Until now the CRM "Remove…" button HARD-DELETED the row (DELETE /time/commissions/:id, with a
 * reason in a SystemEvent). A commission is money — it lands in the P&L's payroll line and in a
 * technician's pay week — so CLAUDE.md's standing rule applies: the exit is void-with-reason, the
 * row kept, never a silent delete.
 *
 * THE RULES
 *   - The row is KEPT and marked (`voidedAt`, `voidedBy`, `voidReason`). Never deleted.
 *   - A reason is required (1-300 characters) and lands on the row and in a SystemEvent.
 *   - A row voided once cannot be voided again. The write is conditional (`voidedAt: null` in the
 *     WHERE), so two voids racing each other cannot overwrite the first one's reason and time:
 *     the loser updates nothing and is told 409.
 *   - A commission already PAID OUT is refused. `Commission.paidAt` is the settlement marker; as
 *     of 2026-10-09 NOTHING in the app sets it (constants.md "payroll": "`Commission.paidAt` HAS NO
 *     WRITER" — payroll is accrual, there is no pay-run event), so today the guard can never fire.
 *     It is here so that the day a writer exists, a paid-out commission cannot be quietly taken
 *     back from the books without a deliberate decision. The paidAt check sits in the same
 *     conditional write as the voidedAt check, so it cannot be raced either.
 *   - Only the CRM session reaches this (routes/time.ts is mounted behind the operator session).
 *     The technician router has no route to it and must never get one.
 *
 * EVERY READER OF COMMISSION EXCLUDES A VOIDED ROW (`voidedAt: null`, NOT_VOID_COMMISSION below):
 *   services/payrollLedger.ts (the P&L payroll line + the CSV, and through it every month view),
 *   services/timeTracking.ts payrollForWeek (the Team page week: commissions total, rows, total pay),
 *   routes/time.ts POST /time/commissions (the one-job-profit-commission-per-tech-per-job check — a
 *   voided one must not block re-recording). GET /time/commissions (the job workspace card) is the
 *   one reader that returns voided rows ON PURPOSE, so the card can show them struck through; it
 *   sends voidedAt/voidedBy/voidReason and the client never sums them.
 *   services/sameDayJob.ts counts every Commission on a Visit to refuse deleting a Visit that has
 *   anything attached; a voided row still counts there on purpose (the row is kept history, and
 *   deleting its Visit would orphan it).
 */

import type { PrismaClient } from "@prisma/client";
import { logSystemEvent } from "./systemEvents";

/** The `where` fragment every commission money reader adds. A voided row is not money. */
export const NOT_VOID_COMMISSION = { voidedAt: null } as const;

export const COMMISSION_VOID_REASON_MAX = 300;

/** The CRM PIN session is the administrator — the same actor string a payment void records. */
export const COMMISSION_VOID_ACTOR = "human:crm-session";

export class CommissionVoidError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "CommissionVoidError";
  }
}

export interface VoidedCommission {
  id: string;
  technicianId: string;
  visitId: string | null;
  amount: number;
  voidedAt: Date;
  voidedBy: string;
  voidReason: string;
}

/**
 * Mark one commission void. Throws CommissionVoidError (400 bad reason, 404 no such row, 409
 * already void / already paid out).
 */
export async function voidCommission(
  prisma: PrismaClient,
  commissionId: string,
  reason: string,
  actor: string = COMMISSION_VOID_ACTOR,
): Promise<VoidedCommission> {
  const why = (reason ?? "").trim();
  if (why.length === 0) throw new CommissionVoidError("Say why this commission is being voided.", 400);
  if (why.length > COMMISSION_VOID_REASON_MAX) {
    throw new CommissionVoidError(`Keep the reason under ${COMMISSION_VOID_REASON_MAX} characters.`, 400);
  }

  const existing = await prisma.commission.findUnique({ where: { id: commissionId } });
  if (!existing) throw new CommissionVoidError("Commission not found.", 404);

  const refusal = (c: { voidedAt: Date | null; voidReason: string | null; paidAt: Date | null }): CommissionVoidError | null => {
    if (c.voidedAt) {
      return new CommissionVoidError(
        `This commission was already voided on ${c.voidedAt.toISOString().slice(0, 10)}${c.voidReason ? ` — ${c.voidReason}` : ""}.`,
        409,
      );
    }
    if (c.paidAt) {
      return new CommissionVoidError(
        `This commission was already paid out on ${c.paidAt.toISOString().slice(0, 10)} and cannot be voided here — it is in a technician's pay.`,
        409,
      );
    }
    return null;
  };
  const early = refusal(existing);
  if (early) throw early;

  const now = new Date();
  // CONDITIONAL WRITE (like paymentVoid): the checks above ran outside the write, so two voids
  // racing each other would both pass them. Writing only where voidedAt (and paidAt) are still null
  // makes the second one update nothing.
  const updated = await prisma.commission.updateMany({
    where: { id: existing.id, voidedAt: null, paidAt: null },
    data: { voidedAt: now, voidedBy: actor, voidReason: why },
  });
  if (updated.count === 0) {
    const current = await prisma.commission.findUnique({ where: { id: existing.id } });
    throw (current && refusal(current)) || new CommissionVoidError("This commission could not be voided.", 409);
  }

  const row = await prisma.commission.findUniqueOrThrow({ where: { id: existing.id } });
  logSystemEvent(
    "warn",
    "time",
    `Commission of $${row.amount.toFixed(2)} voided — ${why}`,
    {
      commissionId: row.id, technicianId: row.technicianId, visitId: row.visitId, amount: row.amount,
      percent: row.percent, basis: row.basis, earnedAt: row.earnedAt.toISOString(), actor,
    },
  );

  return {
    id: row.id,
    technicianId: row.technicianId,
    visitId: row.visitId,
    amount: row.amount,
    voidedAt: row.voidedAt!,
    voidedBy: row.voidedBy!,
    voidReason: row.voidReason!,
  };
}
