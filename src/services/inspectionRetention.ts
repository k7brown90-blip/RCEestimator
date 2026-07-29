/**
 * Inspection retention engine — turns the versioned health-record history into
 * recurring revenue. Roughly 11 months after a property's most recent
 * inspection, a renewal lead is created on the customer's account so the
 * follow-up pipeline (and the voice agent) can book the annual re-inspection.
 *
 * Idempotent: each source inspection produces at most one renewal lead, keyed
 * by a tag in the lead notes. Only the LATEST inspection per property counts —
 * a property that was re-inspected resets its clock automatically.
 */

import { prisma } from "../lib/prisma";
import { parseJsonArray } from "../lib/json";

export const RENEWAL_MONTHS = 11;

const renewalTag = (inspectionId: string) => `[InspectionRenewal ${inspectionId}]`;

export interface RetentionRunResult {
  checked: number; // properties whose latest inspection is due
  created: number; // renewal leads created this run
}

export async function generateInspectionRenewalLeads(
  now: Date = new Date(),
): Promise<RetentionRunResult> {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - RENEWAL_MONTHS);

  // Latest inspection per property; only properties whose most recent
  // inspection is older than the renewal window are due.
  const latestPerProperty = await prisma.healthInspection.groupBy({
    by: ["propertyId"],
    _max: { inspectionDate: true },
  });
  const due = latestPerProperty.filter(
    (entry) => entry._max.inspectionDate && entry._max.inspectionDate <= cutoff,
  );

  let created = 0;
  for (const entry of due) {
    const inspection = await prisma.healthInspection.findFirst({
      where: { propertyId: entry.propertyId, inspectionDate: entry._max.inspectionDate! },
      include: {
        customer: { select: { id: true, name: true, phone: true, email: true } },
        property: { select: { id: true, addressLine1: true, city: true } },
      },
    });
    if (!inspection) continue;

    const tag = renewalTag(inspection.id);
    const existing = await prisma.lead.findFirst({ where: { notes: { contains: tag } } });
    if (existing) continue;

    const lastDate = inspection.inspectionDate.toISOString().slice(0, 10);
    // v2 records have no score — it was retired. Interpolating it made every
    // renewal lead read "score null". Lead with what the record actually says.
    const findingSummary = inspection.score !== null
      ? `score ${inspection.score}`
      : `${inspection.failCount} item(s) needing correction, ${inspection.monitorCount} to monitor`;
    await prisma.lead.create({
      data: {
        name: inspection.customer.name,
        phone: inspection.customer.phone,
        email: inspection.customer.email,
        source: "retention",
        callType: "estimate_followup",
        jobType: "Annual electrical health inspection",
        leadStatus: "new",
        followUpDate: now,
        followUpReason: "annual_inspection_renewal",
        customerId: inspection.customer.id,
        propertyId: inspection.property.id,
        visitId: inspection.visitId,
        notes:
          `${tag} Annual health-record renewal for ${inspection.property.addressLine1}, ` +
          `${inspection.property.city} — last assessed ${lastDate}, ${findingSummary}` +
          `${parseJsonArray(inspection.criticalFindingsJson).length > 0 ? " (had critical findings)" : ""}.`,
      },
    });
    created += 1;
  }

  return { checked: due.length, created };
}

// ─── Upgrade-track follow-up ────────────────────────────────────────────────

export interface EolSweepResult {
  due: number;
  created: number;
}

/** How far ahead of the expiry date the conversation should start. */
export const EOL_LEAD_MONTHS = 6;

const eolTag = (findingId: string) => `[UpgradeFollowUp ${findingId}]`;

/**
 * Raise a lead as documented equipment approaches the end of its published life.
 *
 * This is the upgrade track paying for itself. A MONITOR on a 1994 panel isn't a
 * defect and never becomes one — it's a replacement with a knowable date, and
 * this is what turns "we noticed" into a call six months before the failure
 * rather than an emergency after it.
 *
 * Only findings still live get a lead: one already scheduled, upgraded or
 * declined has had its conversation.
 */
export async function generateUpgradeFollowUpLeads(
  now: Date = new Date(),
): Promise<EolSweepResult> {
  const horizon = new Date(now);
  horizon.setMonth(horizon.getMonth() + EOL_LEAD_MONTHS);

  const due = await prisma.propertyFinding.findMany({
    where: {
      track: "upgrade",
      status: "open",
      followUpAt: { not: null, lte: horizon },
    },
    take: 200,
  });

  let created = 0;
  for (const finding of due) {
    const tag = eolTag(finding.id);
    const existing = await prisma.lead.findFirst({ where: { notes: { contains: tag } } });
    if (existing) continue;

    const [customer, property] = await Promise.all([
      prisma.customer.findUnique({ where: { id: finding.customerId } }),
      prisma.property.findUnique({ where: { id: finding.propertyId } }),
    ]);
    if (!customer || !property) continue;

    const expired = finding.expectedEolYear != null && finding.expectedEolYear <= now.getFullYear();
    await prisma.lead.create({
      data: {
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        source: "retention",
        callType: "estimate_followup",
        jobType: `Planned replacement — ${finding.title}`,
        leadStatus: "new",
        followUpDate: now,
        followUpReason: "equipment_end_of_life",
        customerId: customer.id,
        propertyId: property.id,
        notes:
          `${tag} ${finding.itemId} — ${finding.title} at ${property.addressLine1}, ${property.city}. ` +
          `Documented ${finding.openedAt.toISOString().slice(0, 10)}: ${finding.findingText} ` +
          `Expected end of service life ${finding.expectedEolYear}${expired ? " (already past)" : ""}. ` +
          `This is a planned replacement, not a code defect.`,
      },
    });
    created += 1;
  }

  return { due: due.length, created };
}
