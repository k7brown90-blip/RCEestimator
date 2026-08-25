-- Contacts, job completion, and financials (Kyle, 2026-08-25).
--
-- CONTACTS: labeled additional emails/phones per account — the spouse's cell,
-- the work email. The Customer row's own email/phone remain primary; send
-- pickers and inbound-SMS matching read these too.
--
-- COMPLETION: completedAt on Visit — the labor-tracking timestamp. No gate:
-- "We do not want to lock ourselves out of closing a job, some might be labor
-- only." Warnings, never walls.
--
-- FINANCIALS: CompanyBill (recurring bills & rolling costs; one-offs stay on
-- Receipt) and Payment (Stripe via webhook, cash/check by hand) — the two
-- tables the Financials tab's reports read alongside receipts and invoices.

CREATE TABLE "CustomerContact" (
    "id"         TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "label"      TEXT NOT NULL,
    "email"      TEXT,
    "phone"      TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerContact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CustomerContact_customerId_idx" ON "CustomerContact"("customerId");
CREATE INDEX "CustomerContact_phone_idx" ON "CustomerContact"("phone");
ALTER TABLE "CustomerContact" ADD CONSTRAINT "CustomerContact_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Visit" ADD COLUMN "completedAt" TIMESTAMP(3);

CREATE TABLE "CompanyBill" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "category"  TEXT NOT NULL DEFAULT 'overhead',
    "amount"    DOUBLE PRECISION NOT NULL,
    "cadence"   TEXT NOT NULL,
    "billDate"  TIMESTAMP(3),
    "startDate" TIMESTAMP(3),
    "endDate"   TIMESTAMP(3),
    "notes"     TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompanyBill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Payment" (
    "id"              TEXT NOT NULL,
    "customerId"      TEXT,
    "estimateId"      TEXT,
    "visitId"         TEXT,
    "amount"          DOUBLE PRECISION NOT NULL,
    "method"          TEXT NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'paid',
    "stripeSessionId" TEXT,
    "note"            TEXT,
    "paidAt"          TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Payment_stripeSessionId_key" ON "Payment"("stripeSessionId");
CREATE INDEX "Payment_paidAt_idx" ON "Payment"("paidAt");
CREATE INDEX "Payment_estimateId_idx" ON "Payment"("estimateId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
