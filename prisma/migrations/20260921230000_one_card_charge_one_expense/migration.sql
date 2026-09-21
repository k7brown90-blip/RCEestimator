-- One card charge, one expense (2026-09-21, PUNCHLIST N9).
--
-- Every card swipe reached CardSpend TWICE: once from the v2 money-management
-- feed (`trxn_…` ids, polled every 10 minutes since 9/8) and once from the
-- classic Stripe Issuing WEBHOOK (`ipi_…` ids, arriving since 9/11 even though
-- the Issuing LIST call is refused — "not set up to use Issuing"). No id is
-- shared between the two feeds, so the ingest's dedup-by-stripeTransactionId
-- let both rows live as two real expenses (and, for a materials charge, a
-- second after-the-fact P.O.). Kyle's ruling: the v2 feed is the ONE source of
-- card spend going forward (services/cardSpend.ts / stripePayments.ts, same
-- change as this migration). This corrects the past on the ledger the same
-- way a hand ignore already works: never a delete, always a reason on the row.
--
-- Scope, all three guarded together:
--   1. Only an `ipi_` row is touched — a `trxn_` row is NEVER a target, so two
--      real `trxn_` charges of the same amount are left alone.
--   2. Only when a `trxn_` TWIN exists for it: same amount, same card, and
--      occurredAt within 3 days either way. An `ipi_` row with no twin (the
--      HOMEDEPOT.COM online order, captured as one v2 pending authorization
--      against two Issuing captures) is NOT proven to be a duplicate and is
--      left live.
--   3. Only when it is not already ignored — a row Kyle hand-ignored (many
--      carry reason "No Receipt") keeps that reason exactly as he wrote it;
--      that is a separate question he is deciding, not this migration's to touch.
--
-- Expected in production: exactly five rows — Sunbelt $56.80, biBERK $142.20,
-- ELET_RES_PERMIT_TN $35.00, VCN*SMYRNATREASCOLLECT $123.00, RACETRAC $75.06
-- (total $432.06).

UPDATE "CardSpend" dup
SET "status" = 'ignored',
    "ignoredReason" = 'duplicate — the same charge arrived from the Stripe Issuing webhook; the card feed row counts it (backfilled 2026-09-21)',
    "note" = 'duplicate — the same charge arrived from the Stripe Issuing webhook; the card feed row counts it (backfilled 2026-09-21)'
WHERE dup."stripeTransactionId" LIKE 'ipi\_%' ESCAPE '\'
  AND dup."status" <> 'ignored'
  AND EXISTS (
    SELECT 1 FROM "CardSpend" twin
    WHERE twin."stripeTransactionId" LIKE 'trxn\_%' ESCAPE '\'
      AND twin."amount" = dup."amount"
      AND twin."stripeCardId" = dup."stripeCardId"
      AND twin."occurredAt" BETWEEN dup."occurredAt" - INTERVAL '3 days' AND dup."occurredAt" + INTERVAL '3 days'
  );
