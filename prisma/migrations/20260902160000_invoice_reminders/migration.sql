-- Unpaid-invoice follow-up (Kyle, 2026-09-02: "yes the ... unpaid invoice follow up").
-- Reminder pacing lives on the invoice itself: how many nudges went out and when the
-- last one did, so the sweep asks gently (7-day spacing, three asks max) and the
-- Invoices page can show "reminded 2x, last 9/9".
ALTER TABLE "IssuedEstimate" ADD COLUMN "paymentRemindersSent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "IssuedEstimate" ADD COLUMN "lastPaymentReminderAt" TIMESTAMP(3);
