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
          `${inspection.property.city} — last inspected ${lastDate}, score ${inspection.score}` +
          `${JSON.parse(inspection.criticalFindingsJson).length > 0 ? " (had critical findings)" : ""}.`,
      },
    });
    created += 1;
  }

  return { checked: due.length, created };
}
