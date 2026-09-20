-- Kyle, 2026-09-18 (receipts read and cost accurately, Unit 2): "the reader
-- must reconcile, or say it could not" — a parse whose line totals + tax
-- don't add up to the printed total is left in pending_review with a note
-- on WHAT didn't add up, instead of being silently accepted.
-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "reconciliationNote" TEXT;
