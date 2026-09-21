-- Bank statement import (Kyle, 2026-09-20, drawers plan Phase 8). "I can manually upload the
-- bank statements each month from each account. Plaid can be used at a later date when its
-- established." And: "Having everything tracked in one place would make it easier."
--
-- Until now the P&L knew only money that touched the Stripe card, bills Kyle typed, and payroll
-- from the hours ledger. Everything paid by ACH or autopay out of Chase was invisible. Three new
-- tables, additive only — no existing table changes, no data to backfill:
--
--   BankAccount   — the registry (Chase has FOUR: checking + capital, overhead savings, tax).
--                   PURPOSE decides classification: money into a set-aside account is a
--                   transfer, never an expense.
--   BankStatement — one uploaded file, unique per (account, sha256 of the bytes) so the same
--                   statement can never import twice.
--   BankLine      — one statement line, unique per (account, lineKey), classified as exactly
--                   one of expense | transfer | already_counted | ignored | unclassified.
--                   Only `expense` reaches the P&L (routes/financials.ts).
--
-- Plain DDL: nothing here needs a privilege beyond CREATE TABLE, which every migration in this
-- directory already relies on, so there is nothing to guard — `prisma migrate deploy` before
-- the server boots cannot fail on a role that ran the previous 70 migrations.

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "institution" TEXT NOT NULL DEFAULT 'Chase',
    "last4" TEXT,
    "kind" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatement" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "closingBalance" DOUBLE PRECISION,
    "balanceAsOf" TIMESTAMP(3),
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankLine" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "lineKey" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL,
    "bankRef" TEXT,
    "bankType" TEXT,
    "runningBalance" DOUBLE PRECISION,
    "payeeKey" TEXT NOT NULL,
    "classification" TEXT NOT NULL DEFAULT 'unclassified',
    "category" TEXT,
    "transferKind" TEXT,
    "counterpartyAccountId" TEXT,
    "matchedKind" TEXT,
    "matchedId" TEXT,
    "matchedMonth" TEXT,
    "reason" TEXT,
    "hint" TEXT,
    "classifiedBy" TEXT,
    "classifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankStatement_accountId_idx" ON "BankStatement"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatement_accountId_fileHash_key" ON "BankStatement"("accountId", "fileHash");

-- CreateIndex
CREATE INDEX "BankLine_statementId_idx" ON "BankLine"("statementId");

-- CreateIndex
CREATE INDEX "BankLine_postedAt_idx" ON "BankLine"("postedAt");

-- CreateIndex
CREATE INDEX "BankLine_classification_idx" ON "BankLine"("classification");

-- CreateIndex
CREATE INDEX "BankLine_matchedKind_matchedId_idx" ON "BankLine"("matchedKind", "matchedId");

-- CreateIndex
CREATE INDEX "BankLine_payeeKey_idx" ON "BankLine"("payeeKey");

-- CreateIndex
CREATE UNIQUE INDEX "BankLine_accountId_lineKey_key" ON "BankLine"("accountId", "lineKey");

-- AddForeignKey
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "BankStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_counterpartyAccountId_fkey" FOREIGN KEY ("counterpartyAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
