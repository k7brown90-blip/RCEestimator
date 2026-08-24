-- Health record: per-section notes, on-site customer acknowledgment, and report
-- delivery proof (Kyle, 2026-08-24).
--
-- SECTION NOTES: the paper field record has a notes line per section; the PWA only
-- had per-item notes. Internal by default — a note reaches the customer's report
-- only when the technician promoted it ("includeOnReport").
--
-- ACKNOWLEDGMENT: the digital version of the paper form's signature box. Either a
-- drawn signature exists or ackSkippedReason says why not — absence is deliberate.
--
-- DELIVERY: one row per report email actually sent (when / to what address / by
-- whom), because the record only protects anyone if delivery can be proven later.

ALTER TABLE "HealthInspection" ADD COLUMN "sectionNotesJson" TEXT;
ALTER TABLE "HealthInspection" ADD COLUMN "customerSignerName" TEXT;
ALTER TABLE "HealthInspection" ADD COLUMN "customerSignatureImage" TEXT;
ALTER TABLE "HealthInspection" ADD COLUMN "acknowledgedAt" TIMESTAMP(3);
ALTER TABLE "HealthInspection" ADD COLUMN "ackSkippedReason" TEXT;

CREATE TABLE "HealthReportDelivery" (
    "id"           TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "documentId"   TEXT NOT NULL,
    "sentTo"       TEXT NOT NULL,
    "sentBy"       TEXT NOT NULL,
    "sentAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HealthReportDelivery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "HealthReportDelivery_inspectionId_sentAt_idx" ON "HealthReportDelivery"("inspectionId", "sentAt");
ALTER TABLE "HealthReportDelivery" ADD CONSTRAINT "HealthReportDelivery_inspectionId_fkey"
    FOREIGN KEY ("inspectionId") REFERENCES "HealthInspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
