-- Email bounce watcher (Kyle, 2026-09-09).
--
-- "My emails are not getting to the clients" / "very few are actually getting
-- through, this is priority number one."
--
-- The transport is fine (mail-tester 9.5/10, SPF pass, DKIM aligned, DMARC
-- present). What was missing was VISIBILITY: when a receiver rejects a message,
-- Gmail puts a "Delivery Status Notification (Failure)" from
-- mailer-daemon@googlemail.com in the inbox, in the sent message's thread, and
-- the CRM never saw it -- so a bounced estimate (2026-1067 to comcast, 554;
-- 2026-1035 to gmail, 550 5.1.1) looked identical to a delivered one.
--
-- EmailBounce is one parsed DSN. gmailMessageId is unique so a re-poll is
-- idempotent. The estimate/visit links are SET NULL: the bounce is a record of
-- what Gmail said, and outlives what it was about.
--
-- IssuedEstimate.lastBounceAt / lastBounceReason: the flag the Estimates page,
-- the account page and the invoice rows read. Cleared when a later send goes to
-- a DIFFERENT address, or by hand (POST /email-bounces/:id/resolve).
--
-- Additive only.

ALTER TABLE "IssuedEstimate" ADD COLUMN "lastBounceAt" TIMESTAMP(3);
ALTER TABLE "IssuedEstimate" ADD COLUMN "lastBounceReason" TEXT;

CREATE TABLE "EmailBounce" (
    "id" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "gmailThreadId" TEXT,
    "recipient" TEXT NOT NULL,
    "status" TEXT,                    -- enhanced status code, e.g. 5.7.0 / 5.1.1
    "diagnostic" TEXT,                -- the Diagnostic-Code line, <= 500 chars
    "action" TEXT,
    "remoteMta" TEXT,
    "originalSubject" TEXT,
    "kind" TEXT NOT NULL,             -- estimate | invoice | appointment | deposit | balance | receipt | campaign | other
    "estimateNumber" TEXT,
    "issuedEstimateId" TEXT,
    "visitId" TEXT,
    "bouncedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailBounce_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmailBounce_issuedEstimateId_fkey" FOREIGN KEY ("issuedEstimateId") REFERENCES "IssuedEstimate"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EmailBounce_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmailBounce_gmailMessageId_key" ON "EmailBounce"("gmailMessageId");
CREATE INDEX "EmailBounce_resolvedAt_bouncedAt_idx" ON "EmailBounce"("resolvedAt", "bouncedAt");
CREATE INDEX "EmailBounce_issuedEstimateId_idx" ON "EmailBounce"("issuedEstimateId");
CREATE INDEX "EmailBounce_visitId_idx" ON "EmailBounce"("visitId");
