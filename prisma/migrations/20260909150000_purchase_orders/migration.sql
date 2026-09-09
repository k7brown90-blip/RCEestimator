-- Purchasing becomes a real document (Kyle, 2026-09-09).
--
-- "Purchasing needs to start with a P.O. number then the purchase and photo
-- verification of the receipt." The old MaterialOrder was optional, unnumbered,
-- and floated beside receipts. This replaces it with a numbered PurchaseOrder
-- (PO-YYYY-NNNN), its lines, an edit trail ("We need to be able to edit
-- manually in case there are errors found"), a per-year counter, and the
-- receipt's link back to the PO it verifies. Purpose is CHOSEN, never inferred
-- ("Truck Stock, Warehouse, or Tool purchase ... The default will be truck
-- stock"). Materials land on a truck or the warehouse, never on a job -- the job
-- on a PO is context only.
--
-- Existing MaterialOrder rows migrate to POs (truck stock, Truck 1) and then the
-- old table is dropped. Job costing is untouched: receipts on a job still count
-- as that job's material.

-- Trucks ---------------------------------------------------------------------
CREATE TABLE "Truck" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "technicianId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Truck_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Truck_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Kyle's truck. "There is only one warehouse for now it is my home location" --
-- the warehouse needs no row; the truck does, because truck-stock POs point at it.
INSERT INTO "Truck" ("id", "name") VALUES ('truck_1', 'Truck 1');

-- Purchase orders ------------------------------------------------------------
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,           -- truck_stock | warehouse | tool
    "destinationType" TEXT NOT NULL,   -- truck | warehouse
    "truckId" TEXT,
    "jobId" TEXT,
    "supplier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open', -- open | purchased | verified | closed | cancelled
    "notes" TEXT,
    "openedBy" TEXT NOT NULL,          -- owner | tech
    "openedByTechnicianId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purchasedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseOrder_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PurchaseOrder_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PurchaseOrder_number_key" ON "PurchaseOrder"("number");
CREATE INDEX "PurchaseOrder_status_idx" ON "PurchaseOrder"("status");
CREATE INDEX "PurchaseOrder_jobId_idx" ON "PurchaseOrder"("jobId");
CREATE INDEX "PurchaseOrder_truckId_idx" ON "PurchaseOrder"("truckId");

CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "itemId" TEXT,
    "name" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "partNumber" TEXT,
    "unitCost" DOUBLE PRECISION,
    "qtyLanded" DOUBLE PRECISION,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PurchaseOrderLine_purchaseOrderId_idx" ON "PurchaseOrderLine"("purchaseOrderId");

-- The edit trail: one row per create / edit / status change / receipt attach.
CREATE TABLE "PurchaseOrderEvent" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "before" TEXT,
    "after" TEXT,
    CONSTRAINT "PurchaseOrderEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseOrderEvent_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PurchaseOrderEvent_purchaseOrderId_at_idx" ON "PurchaseOrderEvent"("purchaseOrderId", "at");

-- One row per year; `next` is the next sequence to hand out.
CREATE TABLE "PurchaseOrderCounter" (
    "year" INTEGER NOT NULL,
    "next" INTEGER NOT NULL,
    CONSTRAINT "PurchaseOrderCounter_pkey" PRIMARY KEY ("year")
);

-- Receipt -> PO --------------------------------------------------------------
ALTER TABLE "Receipt" ADD COLUMN "purchaseOrderId" TEXT;
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Receipt_purchaseOrderId_idx" ON "Receipt"("purchaseOrderId");

-- Migrate MaterialOrder -> PurchaseOrder --------------------------------------
-- The old id is kept as the PO id so nothing that stored it (system events,
-- notes) goes stale. Numbers are assigned per year in creation order; a sent
-- order was already bought, so it lands as "purchased"; everything else is open.
INSERT INTO "PurchaseOrder" (
    "id", "number", "purpose", "destinationType", "truckId", "jobId", "supplier",
    "status", "openedBy", "openedAt", "purchasedAt", "sentAt", "createdAt"
)
SELECT
    m."id",
    'PO-' || to_char(m."createdAt", 'YYYY') || '-' ||
        lpad((row_number() OVER (PARTITION BY date_part('year', m."createdAt") ORDER BY m."createdAt", m."id"))::text, 4, '0'),
    'truck_stock',
    'truck',
    'truck_1',
    m."jobId",
    m."supplier",
    CASE WHEN m."sentAt" IS NOT NULL THEN 'purchased' ELSE 'open' END,
    'owner',
    m."createdAt",
    m."sentAt",
    m."sentAt",
    m."createdAt"
FROM "MaterialOrder" m;

-- Lines from each order's items JSON. Done per order inside a DO block so one
-- malformed `items` string skips that order's lines instead of failing the
-- migration -- the PO row itself is already in.
DO $$
DECLARE
    r RECORD;
    parsed JSONB;
BEGIN
    FOR r IN SELECT "id", "items" FROM "MaterialOrder" LOOP
        BEGIN
            parsed := r."items"::jsonb;
            IF jsonb_typeof(parsed) = 'array' THEN
                INSERT INTO "PurchaseOrderLine" ("id", "purchaseOrderId", "name", "qty", "unit", "partNumber", "sortOrder")
                SELECT
                    md5(r."id" || ':' || t.ord::text),
                    r."id",
                    COALESCE(NULLIF(t.elem->>'name', ''), 'item'),
                    COALESCE(NULLIF(t.elem->>'qty', '')::double precision, 1),
                    NULLIF(t.elem->>'unit', ''),
                    NULLIF(t.elem->>'partNumber', ''),
                    (t.ord - 1)::int
                FROM jsonb_array_elements(parsed) WITH ORDINALITY AS t(elem, ord)
                WHERE jsonb_typeof(t.elem) = 'object';
            END IF;
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'MaterialOrder % items could not be migrated: %', r."id", SQLERRM;
        END;
    END LOOP;
END $$;

-- Every migrated PO gets a "created" trail entry so the trail starts at the top.
INSERT INTO "PurchaseOrderEvent" ("id", "purchaseOrderId", "at", "actor", "kind", "reason")
SELECT md5(p."id" || ':migrated'), p."id", p."createdAt", 'migration', 'created', 'Migrated from MaterialOrder (2026-09-09)'
FROM "PurchaseOrder" p;

-- Seed the counter: next = highest sequence used this year + 1.
INSERT INTO "PurchaseOrderCounter" ("year", "next")
SELECT date_part('year', m."createdAt")::int, COUNT(*)::int + 1
FROM "MaterialOrder" m
GROUP BY date_part('year', m."createdAt");

DROP TABLE "MaterialOrder";
