-- Payment.kind (Kyle, 2026-08-25): "We need to implement a 1/3 deposit on
-- every job. Deposit required before it can be scheduled." deposit | final |
-- other. The scheduling gate reads paid deposit rows; the final pay link
-- charges the balance net of everything already paid.
ALTER TABLE "Payment" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'other';
