/**
 * The account spine — signed quote → job, and the test-account instrument. (P029)
 *
 * Kyle, 2026-08-18, verbatim: *"The process is Lead → appointment → estimate → email/signed quote
 * → job → payment → job complete… All of it links to their account. Note: if they have multiple
 * addresses on file it needs to link to the address that we are working at."*
 *
 * This module owns the two links in that chain that P027/P028 left open: turning a SIGNED
 * estimate into a job on the same account and address, and the marked test account that keeps
 * price-book practice out of the real numbers.
 */

import type { PrismaClient } from "@prisma/client";
import { logSystemEvent } from "./systemEvents";

// ─── Signed quote → job ─────────────────────────────────────────────────────────

export type CreateJobResult =
  | { ok: true; visitId: string; created: boolean }
  | { ok: false; reason: string };

/**
 * Turn a signed estimate into a job, on the SAME account and address.
 *
 * Neither id is re-derived, re-picked or re-confirmed here: they are read off the signed estimate,
 * which froze them at issuance. That is the whole point of the spine — by the time a customer has
 * signed, "which account, which address" is already answered, and asking again would be an
 * opportunity to answer differently.
 *
 * Idempotent. A second tap returns the job that already exists rather than creating a duplicate:
 * the estimate row itself carries `jobVisitId`, so "has this been done" is a fact about the
 * estimate rather than a heuristic over the visit list.
 */
export async function createJobFromSignedEstimate(
  prisma: PrismaClient,
  estimateId: string,
  opts: { actor?: string } = {}
): Promise<CreateJobResult> {
  const est = await prisma.issuedEstimate.findUnique({ where: { id: estimateId } });
  if (!est) return { ok: false, reason: "Estimate not found." };

  // A job is work the customer agreed to. An unsigned estimate has not been agreed to.
  if (!est.signedAt) {
    return {
      ok: false,
      reason: "This estimate has not been signed yet. A job is created from a signed quote.",
    };
  }

  if (est.jobVisitId) {
    const existing = await prisma.visit.findUnique({ where: { id: est.jobVisitId } });
    if (existing) return { ok: true, visitId: existing.id, created: false };
    // The job was deleted out from under the link — fall through and make a new one rather than
    // handing back a dangling id.
  }

  const visit = await prisma.$transaction(async (tx) => {
    const created = await tx.visit.create({
      data: {
        customerId: est.customerId,
        propertyId: est.serviceAddressId,
        mode: "onsite",
        purpose: est.title,
        // The customer has signed, so the job starts contracted rather than as an estimate.
        status: "contracted",
        contractedAt: est.signedAt,
        estimatedCost: est.total,
      },
    });
    await tx.issuedEstimate.update({
      where: { id: est.id },
      data: { jobVisitId: created.id },
    });
    await tx.issuedEstimateEvent.create({
      data: {
        estimateId: est.id,
        type: "job_created",
        actor: opts.actor ?? "human:crm-session",
        detail: `Job created at the signed address, contracted for $${est.total.toFixed(2)}.`,
      },
    });
    return created;
  });

  logSystemEvent("info", "issued-estimate", `Job created from signed estimate ${est.number}`, {
    estimateId: est.id,
    visitId: visit.id,
    accountId: est.customerId,
    serviceAddressId: est.serviceAddressId,
  });

  return { ok: true, visitId: visit.id, created: true };
}

// ─── The test account ───────────────────────────────────────────────────────────

/**
 * Kyle, 2026-08-18: *"Speculative pricing may exist only for testing the price book but should be
 * a planned deletion."*
 *
 * So the test account is an INSTRUMENT, not a feature. It exists to exercise the price book, it
 * is visibly marked, its rows never mix into funnel counts or the Estimates chain view, and it
 * carries a deletion path built up front — because a temporary thing with no delete button stops
 * being temporary.
 *
 * Nothing here deletes on a schedule or a trigger. `deleteTestAccount` runs when Kyle says so.
 * The expected moment is the atomic-units catalog swap, which is when the price-book testing that
 * justifies this path ends — but that is his call to make, not this module's to infer.
 */
export const TEST_ACCOUNT_NAME = "TEST — price book practice";

/** The marked test account, or null. Never creates one as a side effect of being asked. */
export async function findTestAccount(prisma: PrismaClient) {
  return prisma.customer.findFirst({ where: { isTestAccount: true } });
}

/** Create the test account and its one address, or return the existing one. */
export async function ensureTestAccount(prisma: PrismaClient) {
  const existing = await findTestAccount(prisma);
  if (existing) {
    const property = await prisma.property.findFirst({ where: { customerId: existing.id } });
    if (property) return { account: existing, property };
    const made = await prisma.property.create({
      data: {
        customerId: existing.id,
        name: "TEST address",
        addressLine1: "1 Test Bench",
        city: "La Vergne",
        state: "TN",
        postalCode: "37086",
      },
    });
    return { account: existing, property: made };
  }

  return prisma.$transaction(async (tx) => {
    const account = await tx.customer.create({
      data: { name: TEST_ACCOUNT_NAME, isTestAccount: true },
    });
    const property = await tx.property.create({
      data: {
        customerId: account.id,
        name: "TEST address",
        addressLine1: "1 Test Bench",
        city: "La Vergne",
        state: "TN",
        postalCode: "37086",
      },
    });
    return { account, property };
  });
}

export interface TestAccountDeletion {
  deleted: boolean;
  accountId: string | null;
  counts: { estimates: number; drafts: number; visits: number; properties: number };
}

/**
 * Delete the test account and everything under it, in one action.
 *
 * Ordered against the foreign keys the rest of the system deliberately made restrictive: issued
 * estimates block their account and address from deletion, and drafts block on issued estimates.
 * So the teardown walks inward — events, lines, estimates, draft rows, drafts, visits, properties,
 * account — rather than relying on cascades that were intentionally not granted.
 *
 * REFUSES to touch an account that is not marked `isTestAccount`. The whole safety of a one-tap
 * "delete everything" is that it can only ever find the one row that opted into being deleted.
 */
export async function deleteTestAccount(prisma: PrismaClient): Promise<TestAccountDeletion> {
  const account = await findTestAccount(prisma);
  if (!account) {
    return { deleted: false, accountId: null, counts: { estimates: 0, drafts: 0, visits: 0, properties: 0 } };
  }

  const estimates = await prisma.issuedEstimate.findMany({
    where: { customerId: account.id },
    select: { id: true, draftId: true },
  });
  const estimateIds = estimates.map((e) => e.id);
  const draftIds = [...new Set(estimates.map((e) => e.draftId))];

  const visits = await prisma.visit.findMany({ where: { customerId: account.id }, select: { id: true } });
  const properties = await prisma.property.findMany({ where: { customerId: account.id }, select: { id: true } });

  await prisma.$transaction(async (tx) => {
    await tx.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estimateIds } } });
    await tx.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estimateIds } } });
    // Break the revision chain before deleting, or the self-referencing FK blocks it.
    await tx.issuedEstimate.updateMany({ where: { id: { in: estimateIds } }, data: { supersedesId: null } });
    await tx.issuedEstimate.deleteMany({ where: { id: { in: estimateIds } } });

    // Drafts that belonged to this account, plus any that produced its estimates.
    const draftWhere = { OR: [{ customerId: account.id }, { id: { in: draftIds } }] };
    const drafts = await tx.priceBookDraftEstimate.findMany({ where: draftWhere, select: { id: true } });
    const allDraftIds = drafts.map((d) => d.id);
    await tx.priceBookDraftLine.deleteMany({ where: { draftId: { in: allDraftIds } } });
    await tx.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: allDraftIds } } });
    await tx.priceBookDraftEstimate.deleteMany({ where: { id: { in: allDraftIds } } });

    await tx.visit.deleteMany({ where: { customerId: account.id } });
    await tx.property.deleteMany({ where: { customerId: account.id } });
    await tx.customer.delete({ where: { id: account.id } });
  });

  logSystemEvent("warn", "account-spine", `TEST account deleted on request`, {
    accountId: account.id,
    estimates: estimateIds.length,
    drafts: draftIds.length,
  });

  return {
    deleted: true,
    accountId: account.id,
    counts: {
      estimates: estimateIds.length,
      drafts: draftIds.length,
      visits: visits.length,
      properties: properties.length,
    },
  };
}

/**
 * The Prisma filter that keeps test rows out of real numbers.
 *
 * Exported as a value rather than repeated at each call site, so "does this surface exclude the
 * test account?" has one answer that can be grepped, and turning the exclusion off is one visible
 * change rather than seven.
 */
export const EXCLUDE_TEST_ACCOUNT = { account: { isTestAccount: false } } as const;
