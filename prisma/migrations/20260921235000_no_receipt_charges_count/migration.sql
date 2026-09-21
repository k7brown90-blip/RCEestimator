-- "No Receipt" is not a reason to drop a charge (Kyle, 2026-09-21: "Those need counted").
--
-- THE CHARGE IS THE MONEY; THE RECEIPT IS PROOF (constants, 2026-09-19). Before that rule
-- settled, both copies of several real card purchases were ignored by hand with the reason
-- "No Receipt" / "No receipt" -- the v2 card-feed row AND the Issuing-webhook duplicate -- so
-- the purchase counted $0 on the P&L and in job cost. In production (read 2026-09-21):
--   9/8 THE HOME DEPOT #0776 $324.33, 9/8 CES 689 $6.59, 9/17 HOMEDEPOT.COM $114.01,
--   9/17 THE HOME DEPOT #0776 $651.73, $22.06, $18.50, 9/18 THE HOME DEPOT #0734 $7.18, $16.43,
--   and the 9/17 HOMEDEPOT.COM order still PENDING at $344.43 (the card feed moves it to the
--   captured amount when it posts).
--
-- Restores ONE copy of each: the card-feed row (`trxn_`), the one source of card spend since
-- 20260921230000_one_card_charge_one_expense. The Issuing duplicates (`ipi_`) stay ignored.
-- No P.O. or receipt is re-matched (Kyle's instruction). Job cost and the P&L are derived from
-- live CardSpend rows, so both follow with no further write. Idempotent: a second run finds
-- nothing (status is no longer 'ignored').

UPDATE "CardSpend"
SET "status" = 'unmatched',
    "ignoredReason" = NULL,
    "note" = 'restored 2026-09-21 — the charge is the money; a missing receipt does not remove it (Kyle: "Those need counted")'
WHERE "stripeTransactionId" LIKE 'trxn\_%' ESCAPE '\'
  AND "status" = 'ignored'
  AND lower(trim("ignoredReason")) = 'no receipt';
