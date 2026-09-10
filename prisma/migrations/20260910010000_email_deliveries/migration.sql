-- Resend-first transactional email with delivery tracking (Kyle, 2026-09-09).
--
-- "I need the emails working, very few are actually getting through, this is
-- priority number one."
--
-- Gmail SMTP authenticated cleanly (mail-tester 9.5/10) and Comcast still
-- refused three sends in a day ("554 ESMTP server not available") while iCloud
-- accepted silently into Junk. A signed $3,586 estimate reached neither of the
-- customer's addresses. Resend is already verified on the root domain for
-- campaigns and reports per-message delivered / bounced / complained events by
-- webhook, so every customer email now goes Resend-first with Gmail as the
-- automatic fallback, and the CRM records each email's real delivery state.
--
-- EmailDelivery: one row per customer send — which pipe took it, the Resend id
-- when there is one, and the status the webhook (or the fallback) reports.
-- Links to the estimate / visit are SET NULL: the record outlives its subject.
--
-- EmailBounce is generalised so a Resend bounce files beside a Gmail DSN:
-- provider (default 'gmail' keeps every existing row valid), providerMessageId
-- (the Resend email id, unique when present), and gmailMessageId becomes
-- nullable — its unique index is kept; Postgres treats NULLs as distinct.
--
-- Additive only.

ALTER TABLE "EmailBounce" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'gmail';
ALTER TABLE "EmailBounce" ADD COLUMN "providerMessageId" TEXT;
ALTER TABLE "EmailBounce" ALTER COLUMN "gmailMessageId" DROP NOT NULL;
CREATE UNIQUE INDEX "EmailBounce_providerMessageId_key" ON "EmailBounce"("providerMessageId");

CREATE TABLE "EmailDelivery" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,             -- resend | gmail
    "providerMessageId" TEXT,             -- the Resend email id; null for Gmail
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "kind" TEXT NOT NULL,                 -- estimate | invoice | appointment | deposit | balance | receipt | health_record | document | campaign | other
    "estimateNumber" TEXT,
    "issuedEstimateId" TEXT,
    "visitId" TEXT,
    "status" TEXT NOT NULL,               -- sent | delivered | delayed | bounced | complained | failed
    "statusAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmailDelivery_issuedEstimateId_fkey" FOREIGN KEY ("issuedEstimateId") REFERENCES "IssuedEstimate"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EmailDelivery_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmailDelivery_providerMessageId_key" ON "EmailDelivery"("providerMessageId");
CREATE INDEX "EmailDelivery_issuedEstimateId_idx" ON "EmailDelivery"("issuedEstimateId");
CREATE INDEX "EmailDelivery_visitId_idx" ON "EmailDelivery"("visitId");
CREATE INDEX "EmailDelivery_status_idx" ON "EmailDelivery"("status");
CREATE INDEX "EmailDelivery_createdAt_idx" ON "EmailDelivery"("createdAt");
