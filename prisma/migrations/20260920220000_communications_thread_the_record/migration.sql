-- Single-recipient follow-up email from the CRM (2026-09-20 communications build).
--
-- Kyle: "Campaigns can fold into the lead section and we can create a communications
-- ability since we already have customer emails. Follow ups can be done by sending
-- an email straight from the CRM." Sends go through the SAME sendCustomerEmail /
-- EmailDelivery path every other customer email already uses (services/recordEmail.ts) --
-- this migration only adds the two columns that let a lead or account thread its own
-- deliveries without scanning every row for a matching `to` address, the same way
-- issuedEstimateId/visitId already scope the estimate and job threads.
--
-- Both columns are nullable and SET NULL on delete, same shape as the existing
-- issuedEstimateId/visitId links: additive only, no data loss, no defaults to backfill.

ALTER TABLE "EmailDelivery" ADD COLUMN "leadId" TEXT;
ALTER TABLE "EmailDelivery" ADD COLUMN "customerId" TEXT;
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "EmailDelivery_leadId_idx" ON "EmailDelivery"("leadId");
CREATE INDEX "EmailDelivery_customerId_idx" ON "EmailDelivery"("customerId");

-- EmailBounce carries the same two columns, copied across from the matched EmailDelivery
-- row by services/resendWebhook.ts the same way it already copies issuedEstimateId/visitId --
-- so a bounced follow-up still shows on the lead/account's thread, not just in the
-- Financials bounce card. Only reachable via the Resend path (providerMessageId match);
-- the Gmail DSN path classifies by subject text and cannot recover a free-form subject.

ALTER TABLE "EmailBounce" ADD COLUMN "leadId" TEXT;
ALTER TABLE "EmailBounce" ADD COLUMN "customerId" TEXT;
ALTER TABLE "EmailBounce" ADD CONSTRAINT "EmailBounce_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmailBounce" ADD CONSTRAINT "EmailBounce_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "EmailBounce_leadId_idx" ON "EmailBounce"("leadId");
CREATE INDEX "EmailBounce_customerId_idx" ON "EmailBounce"("customerId");
