/**
 * Estimate validity — the nightly relabel and the arithmetic behind it.
 *
 * Moved out of server.ts's cron body (2026-09-20, estimate lost) so a test can run the sweep and
 * pin that it touches only what it should. Kyle, 2026-09-06: estimates are good for 30 days. The
 * signature path already refuses by date math (issuedEstimateService.ts applySignature); this
 * relabel is for the EYES — expired rows read EXPIRED on the tracker and drop out of the
 * sent/viewed working set. `validDays` is frozen per document, so the few pre-ruling 14-day
 * estimates keep their printed promise. Re-issuing at current prices is the existing revise door.
 *
 * A LOST estimate is never swept: it left the working set by the customer's decision, and a
 * relabel would erase which of the two happened — exactly the distinction the win rate needs.
 */

import type { PrismaClient } from "@prisma/client";
import { EXPIRABLE_STATUSES, type IssuedEstimateStatus } from "../../shared/estimateStatus";
import { logSystemEvent } from "./systemEvents";
// PUNCHLIST A10/H4 (2026-09-22): the arithmetic itself now lives in shared/ so the client's
// EstimatesPage reads the SAME definition instead of its own `sentAt`-based one. Re-exported here
// so every existing server import of `isPastValidity` from this module is unchanged.
import { isPastValidity } from "../../shared/estimateExpiry";

const DAY_MS = 86_400_000;

export { isPastValidity };

/**
 * Where a reopened (un-lost) estimate goes back to. The customer's first view is a durable fact
 * (`firstViewedAt`), so "viewed" vs "sent" is not guessed; and if the window closed while it sat
 * lost it reads expired at once rather than "sent" until the next sweep.
 */
export function reopenedStatusOf(
  est: { firstViewedAt: Date | null; createdAt: Date; validDays: number },
  now = Date.now(),
): Extract<IssuedEstimateStatus, "sent" | "viewed" | "expired"> {
  if (isPastValidity(est, now)) return "expired";
  return est.firstViewedAt ? "viewed" : "sent";
}

export async function sweepExpiredEstimates(prisma: PrismaClient, now = Date.now()): Promise<{ expired: string[] }> {
  const candidates = await prisma.issuedEstimate.findMany({
    where: {
      status: { in: [...EXPIRABLE_STATUSES] },
      signedAt: null,
      voidedAt: null,
      lostAt: null,
      supersededBy: null,
      createdAt: { lt: new Date(now - 14 * DAY_MS) },
    },
    select: { id: true, number: true, createdAt: true, validDays: true },
  });
  const expired = candidates.filter((e) => isPastValidity(e, now));
  if (expired.length > 0) {
    await prisma.issuedEstimate.updateMany({
      where: { id: { in: expired.map((e) => e.id) } },
      data: { status: "expired" },
    });
    logSystemEvent("info", "issued-estimate",
      `Marked ${expired.length} unsigned estimate(s) expired past their validity: ${expired.map((e) => e.number).join(", ")}`,
      { estimateIds: expired.map((e) => e.id) });
  }
  return { expired: expired.map((e) => e.id) };
}
