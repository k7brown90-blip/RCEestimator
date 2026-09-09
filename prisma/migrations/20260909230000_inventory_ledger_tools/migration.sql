-- Inventory ledger and tool register (Kyle, 2026-09-09, Build 3).
--
-- "We need an inventory tab that tracks what is on the truck and what is at the
-- warehouse so on future jobs I can label some stock as truckstock and it won't
-- double count the cost." "Warehouse items will only be used to transfer
-- material to truck stock." "There is only one warehouse for now it is my home
-- location."
--
-- A location is a string key -- 'warehouse' or 'truck:<truckId>' -- because
-- Postgres treats NULLs as distinct in unique indexes, so nullable columns could
-- never make (location, item) unique. StockLevel is the running balance per item
-- per location, written only by services/inventory.ts. StockMovement is the
-- append-only ledger; a correction is a new movement referencing the one it
-- corrects ("We need to be able to edit manually in case there are errors
-- found"). Cost method: moving average per item per location.
--
-- Tools: "some tools will not stay on a truck but will be used between trucks
-- as the jobs demand ... When they are used and stored the stock will be updated
-- as to where the tool is currently at."
--
-- Additive only. Job costing is unchanged: nothing here charges a job (Build 4).

-- Purchase orders: when the material landed ---------------------------------
ALTER TABLE "PurchaseOrder" ADD COLUMN "landedAt" TIMESTAMP(3);
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "landedAt" TIMESTAMP(3);

-- Stock levels ---------------------------------------------------------------
CREATE TABLE "StockLevel" (
    "id" TEXT NOT NULL,
    "locationKey" TEXT NOT NULL,           -- warehouse | truck:<truckId>
    "itemId" TEXT NOT NULL,                -- PriceBookAtomic.itemId (no FK; the book is editable)
    "name" TEXT NOT NULL,
    "unit" TEXT,
    "qtyOnHand" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgUnitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "parLevel" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockLevel_locationKey_itemId_key" ON "StockLevel"("locationKey", "itemId");
CREATE INDEX "StockLevel_locationKey_idx" ON "StockLevel"("locationKey");

-- The ledger -----------------------------------------------------------------
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,                  -- purchase_in | transfer | consume | return | count | correction
    "itemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT,
    "qty" DOUBLE PRECISION NOT NULL,       -- positive; for count = the counted quantity
    "delta" DOUBLE PRECISION,              -- count / correction: the signed change
    "unitCost" DOUBLE PRECISION,           -- the cost applied
    "fromLocationKey" TEXT,
    "toLocationKey" TEXT,
    "purchaseOrderId" TEXT,
    "purchaseOrderLineId" TEXT,
    "jobId" TEXT,
    "correctsId" TEXT,                     -- a prior StockMovement id
    "reason" TEXT,
    "actor" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockMovement_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "StockMovement_itemId_idx" ON "StockMovement"("itemId");
CREATE INDEX "StockMovement_purchaseOrderId_idx" ON "StockMovement"("purchaseOrderId");
CREATE INDEX "StockMovement_jobId_idx" ON "StockMovement"("jobId");
CREATE INDEX "StockMovement_at_idx" ON "StockMovement"("at");
CREATE INDEX "StockMovement_fromLocationKey_idx" ON "StockMovement"("fromLocationKey");
CREATE INDEX "StockMovement_toLocationKey_idx" ON "StockMovement"("toLocationKey");

-- Tool register --------------------------------------------------------------
CREATE TABLE "Tool" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serial" TEXT,
    "cost" DOUBLE PRECISION,
    "purchasedAt" TIMESTAMP(3),
    "purchaseOrderId" TEXT,
    "condition" TEXT NOT NULL DEFAULT 'good', -- good | needs_repair | retired
    "locationKey" TEXT NOT NULL,              -- warehouse | truck:<truckId>
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tool_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Tool_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "Tool_locationKey_idx" ON "Tool"("locationKey");

CREATE TABLE "ToolMovement" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "fromLocationKey" TEXT NOT NULL,
    "toLocationKey" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ToolMovement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ToolMovement_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ToolMovement_toolId_idx" ON "ToolMovement"("toolId");

-- Restock requests from the truck --------------------------------------------
CREATE TABLE "StockRequest" (
    "id" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "itemId" TEXT,
    "name" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open', -- open | fulfilled | declined
    "requestedByTechnicianId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "StockRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockRequest_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "StockRequest_status_idx" ON "StockRequest"("status");
