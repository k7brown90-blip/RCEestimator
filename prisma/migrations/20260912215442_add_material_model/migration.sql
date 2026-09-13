-- Two statements Prisma generated here were REMOVED by hand on 2026-09-13 before
-- this ever reached production:
--
--   DROP INDEX "PriceBookDraftEstimate_changeOrderForId_idx";
--   ALTER TABLE "IssuedEstimate" ALTER COLUMN "selectedOptions" DROP DEFAULT;
--
-- Neither has anything to do with the Material model. They are drift artifacts:
-- this migration was generated against the dev database, which CLAUDE.md records
-- as unmaintained and schema-drifted, so `migrate dev` diffed against the wrong
-- baseline and emitted statements to "correct" differences that only exist there.
--
-- Shipping them would have done one of two things to production, both bad: drop
-- an index serving change-order lookups that the schema does not declare, or —
-- if production never had that index — fail outright, since Postgres errors on
-- DROP INDEX without IF EXISTS. A failed migration aborts `prisma migrate deploy`,
-- which aborts `npm start`, which means the release does not boot.
--
-- Production may genuinely be drifted in those two ways. That is worth
-- reconciling deliberately, in its own migration, with eyes on it — not as a
-- silent passenger on a feature migration.

-- CreateTable
CREATE TABLE "Material" (
    "id" TEXT NOT NULL,
    "upc" TEXT,
    "sku" TEXT,
    "supplier" TEXT,
    "description" TEXT,
    "packQty" DOUBLE PRECISION,
    "packUnit" TEXT,
    "lastCost" DOUBLE PRECISION,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbology" TEXT,
    "itemId" TEXT,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Material_upc_key" ON "Material"("upc");

-- CreateIndex
CREATE INDEX "Material_itemId_idx" ON "Material"("itemId");

-- CreateIndex
CREATE INDEX "Material_supplier_idx" ON "Material"("supplier");

-- CreateIndex
CREATE UNIQUE INDEX "Material_supplier_sku_key" ON "Material"("supplier", "sku");
