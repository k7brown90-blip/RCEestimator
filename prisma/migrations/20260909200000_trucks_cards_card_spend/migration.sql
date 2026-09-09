-- Trucks, cards, financial accounts (Kyle, 2026-09-09).
--
-- "Each tech will have their own card for material and gas through stripe and
-- I will have to set up a financial account for each." Spend routes to a truck
-- BY THE CARD, never by guessing: a truck carries its Issuing card id (unique),
-- the last4 Kyle reads off the plastic, and the Treasury financial account its
-- balance lives in.
--
-- CardSpend is one Issuing card transaction -- the money. "Photo verifies, card
-- proves": the receipt photo is the itemized record; a PO is verified when it
-- has both and they agree. Gas and maintenance belong to the truck, never a job.
-- A materials capture with no PO behind it drafts one on its own, flagged
-- "PO after the fact" (PurchaseOrder.afterTheFact), which cannot close until a
-- receipt photo is attached and the purpose confirmed.
--
-- Job costing is unchanged: receipts on a job still count as that job's material.

-- Truck -> card + financial account -------------------------------------------
ALTER TABLE "Truck" ADD COLUMN "stripeCardId" TEXT;
ALTER TABLE "Truck" ADD COLUMN "cardLast4" TEXT;
ALTER TABLE "Truck" ADD COLUMN "stripeFinancialAccountId" TEXT;
ALTER TABLE "Truck" ADD COLUMN "notes" TEXT;
CREATE UNIQUE INDEX "Truck_stripeCardId_key" ON "Truck"("stripeCardId");

-- PurchaseOrder: drafted from a card transaction ------------------------------
-- openedBy gains the value 'system' (free text -- no constraint to change).
ALTER TABLE "PurchaseOrder" ADD COLUMN "afterTheFact" BOOLEAN NOT NULL DEFAULT false;

-- Card spend -------------------------------------------------------------------
-- amount is DOLLARS: positive for a purchase (Stripe sends captures negative,
-- in cents), negative for a refund.
CREATE TABLE "CardSpend" (
    "id" TEXT NOT NULL,
    "stripeTransactionId" TEXT NOT NULL,
    "stripeAuthorizationId" TEXT,
    "stripeCardId" TEXT NOT NULL,
    "truckId" TEXT,
    "kind" TEXT NOT NULL,                       -- materials | fuel | maintenance | tool | other
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "merchantName" TEXT NOT NULL,
    "merchantCategory" TEXT,                    -- Stripe's category slug
    "merchantCategoryCode" TEXT,                -- the MCC
    "merchantCity" TEXT,
    "merchantState" TEXT,
    "purchaseOrderId" TEXT,
    "receiptId" TEXT,                           -- one receipt matches one spend
    "status" TEXT NOT NULL DEFAULT 'unmatched', -- unmatched | matched | ignored
    "ignoredReason" TEXT,
    "note" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "rawJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CardSpend_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CardSpend_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CardSpend_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CardSpend_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CardSpend_stripeTransactionId_key" ON "CardSpend"("stripeTransactionId");
CREATE UNIQUE INDEX "CardSpend_receiptId_key" ON "CardSpend"("receiptId");
CREATE INDEX "CardSpend_truckId_idx" ON "CardSpend"("truckId");
CREATE INDEX "CardSpend_status_idx" ON "CardSpend"("status");
CREATE INDEX "CardSpend_occurredAt_idx" ON "CardSpend"("occurredAt");
CREATE INDEX "CardSpend_purchaseOrderId_idx" ON "CardSpend"("purchaseOrderId");
