-- A statement's balance comes from its newest POSTED line (Kyle, 2026-09-21: "The checking did
-- not update like the savings accounts did after upload").
--
-- Chase's activity CSV gives a pending row a blank Balance. The importer took the closing balance
-- from the newest row only, so the checking export (newest row: a pending $125.83 debit) stored no
-- balance and the Balances card read "No statement imported yet". The importer now leaves pending
-- rows out (bankStatements.ts parseCsvStatement); this gives every statement already stored without
-- a balance the running balance of its newest line that has one. Re-importing instead would have
-- cost the classifications on its lines.
--
-- Same-day ties: Chase exports newest-first and the lines were created in file order, so the
-- first-created line on the newest day is the latest transaction. Idempotent: a statement that
-- has a balance is never touched.

UPDATE "BankStatement" s
SET "closingBalance" = l."runningBalance",
    "balanceAsOf" = l."postedAt"
FROM (
  SELECT DISTINCT ON ("statementId") "statementId", "runningBalance", "postedAt"
  FROM "BankLine"
  WHERE "runningBalance" IS NOT NULL
  ORDER BY "statementId", "postedAt" DESC, "createdAt" ASC, "id" ASC
) l
WHERE l."statementId" = s."id"
  AND s."closingBalance" IS NULL;
