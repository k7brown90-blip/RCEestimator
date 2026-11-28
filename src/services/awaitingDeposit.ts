/**
 * SIGNED, DEPOSIT NOT IN - the one rule, and the one list (Kyle, 2026-11-27: "she signed and
 * hasn't paid so we need to see that").
 *
 * Two readers ask the same question about a contracted job: "is its signed estimate's deposit
 * satisfied?" - the Calendar's needs-scheduling rail (to sort ready-to-schedule from awaiting) and
 * the Signed - awaiting deposit list (GET /jobs/awaiting-deposit, shown on the Jobs page and in the
 * Calendar rail). Both go through `signedDepositState`, so there is ONE rule.
 *
 * The answer is paymentSummary's own `depositSatisfied` on the ROOT invoice (signedRootForJob,
 * 2026-09-20 - the summary already rolls the change orders in): any money at or past the deposit
 * satisfies it, and an invoice that requires no deposit satisfies it outright. So "needs a deposit
 * and has not paid it" is exactly `!depositSatisfied`; nothing here re-derives the arithmetic.
 *
 * The Jobs LIST is a different ruling and is NOT read from here (Kyle, 2026-08-26: Jobs are signed
 * work with the deposit paid) - see the comment at GET /jobs.
 */

import type { PrismaClient } from "@prisma/client";
import { EXCLUDE_TEST_CUSTOMER } from "./accountSpine";
import { signedRootForJob } from "./invoiceGroup";
import { paymentSummary } from "./stripePayments";

export interface SignedDepositState {
  /** A live signed ROOT invoice exists for this job. */
  hasSignedRoot: boolean;
  /** The root invoice's number, or null with no signed root. */
  estimateNumber: string | null;
  /**
   * paymentSummary's depositSatisfied on the root. FALSE when there is no signed root at all - the
   * list skips those (nothing was signed, nothing is owed); the Calendar rail reads
   * `!hasSignedRoot || depositSatisfied`, matching the scheduling gate, which is open with no signed
   * estimate, so such a job lands in "ready to schedule" with its Schedule button.
   */
  depositSatisfied: boolean;
}

/** The one rule: the deposit state of a job's signed root invoice. */
export async function signedDepositState(prisma: PrismaClient, visitId: string): Promise<SignedDepositState> {
  // The ROOT invoice (2026-09-20) - its summary already rolls the change orders in.
  const root = await signedRootForJob(prisma, visitId);
  if (!root) return { hasSignedRoot: false, estimateNumber: null, depositSatisfied: false };
  const summary = await paymentSummary(prisma, root.id, "https://unused.invalid");
  return { hasSignedRoot: true, estimateNumber: root.number, depositSatisfied: Boolean(summary?.depositSatisfied) };
}

/** One row of the Signed - awaiting deposit list. `visitId` is the id the job drawer opens with. */
export interface AwaitingDepositRow {
  visitId: string;
  customerId: string;
  customerName: string;
  propertyId: string;
  address: string;
  jobType: string | null;
  purpose: string | null;
  estimateNumber: string;
}

/**
 * A safety ceiling only, NOT a display cap: the list used to share the calendar rail's 50-row
 * window with consultations, so fifty newer consultations hid signed jobs that were owed money.
 * It is the visits scanned, and is far above any real count of contracted, unbooked jobs.
 */
export const AWAITING_DEPOSIT_SCAN_LIMIT = 1000;

/**
 * Contracted, unbooked jobs whose live signed root invoice needs a deposit that is not in. The
 * test account is excluded (Kyle, 2026-09-11: it is a price-book instrument, not work). A job with
 * a deposit in, or an invoice that requires none, or no live signed invoice (void / lost / never
 * signed) is not on it. Unbooked because the scheduling deposit gate keeps an unpaid job off the
 * calendar; the list says "not on the schedule until it is".
 */
export async function listAwaitingDeposit(prisma: PrismaClient): Promise<AwaitingDepositRow[]> {
  const visits = await prisma.visit.findMany({
    where: { status: "contracted", scheduledStart: null, ...EXCLUDE_TEST_CUSTOMER },
    include: {
      customer: { select: { id: true, name: true } },
      property: { select: { id: true, addressLine1: true, city: true, state: true } },
    },
    orderBy: { createdAt: "desc" },
    take: AWAITING_DEPOSIT_SCAN_LIMIT,
  });
  const rows: AwaitingDepositRow[] = [];
  for (const v of visits) {
    const state = await signedDepositState(prisma, v.id);
    if (!state.hasSignedRoot || state.depositSatisfied) continue;
    rows.push({
      visitId: v.id,
      customerId: v.customer.id,
      customerName: v.customer.name,
      propertyId: v.property.id,
      address: `${v.property.addressLine1}, ${v.property.city}, ${v.property.state}`,
      jobType: v.jobType,
      purpose: v.purpose,
      estimateNumber: state.estimateNumber as string,
    });
  }
  return rows;
}
