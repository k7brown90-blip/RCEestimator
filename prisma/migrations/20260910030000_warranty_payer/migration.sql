-- Warranty payer tracking (Kyle, 2026-09-10).
--
-- "Patricia's warranty portion of the job is not getting tracked and doesn't
-- have a system to record its payment to that job when that check comes in."
--
-- One account, two payers. Payment.payer says whose money a row is:
-- "customer" (the homeowner, against the homeowner share = billed total) or
-- "warranty" (the home-warranty company, against the covered amount recorded in
-- IssuedEstimate.warrantyJson). A warranty check never reduces the homeowner's
-- balance and vice versa. checkNumber is the check on the row when there is one.
-- The claim's tracking dates (submitted / expected / approved / received /
-- deposited) and its event trail live inside warrantyJson — no schema change.
--
-- Additive only. Every existing row is a customer payment.
ALTER TABLE "Payment" ADD COLUMN "payer" TEXT NOT NULL DEFAULT 'customer';
ALTER TABLE "Payment" ADD COLUMN "checkNumber" TEXT;
