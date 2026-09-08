/**
 * Receipt → job material cost, one writer.
 *
 * Kyle, 2026-09-08: "The uploaded receipts are not processing correctly. I just
 * finished Jason Daughdrill's job and the uploaded receipt did not calculate
 * over the estimated cost." Four receipts had been uploaded from the CRM,
 * confirmed on arrival, and the job's actualMaterialCost still read 0 — the
 * office upload door never re-rolled the total. Two other doors (the Make
 * webhook and the admin review PATCH) each carried their own copy of the sum.
 *
 * Every door that creates, edits, confirms or deletes a receipt now calls this
 * and nothing else stamps Visit.actualMaterialCost. The rule is unchanged:
 * confirmed material receipts only (ruled 2026-09-06), summed to the cent.
 */

import { prisma } from "../lib/prisma";

export async function rerollJobMaterialCost(jobId: string): Promise<number> {
  const rows = await prisma.receipt.findMany({
    where: { jobId, category: "materials", status: "confirmed" },
    select: { amount: true },
  });
  const total = Math.round(rows.reduce((sum, r) => sum + r.amount, 0) * 100) / 100;
  // The visit may be gone (test teardown, a deleted job) — a missing row is not an error here.
  await prisma.visit.update({ where: { id: jobId }, data: { actualMaterialCost: total } }).catch(() => {});
  return total;
}

/** Re-roll every job a receipt touched — the old job and the new one when it moved. */
export async function rerollJobsMaterialCost(jobIds: Array<string | null | undefined>): Promise<void> {
  const unique = [...new Set(jobIds.filter((id): id is string => Boolean(id)))];
  for (const jobId of unique) await rerollJobMaterialCost(jobId);
}
