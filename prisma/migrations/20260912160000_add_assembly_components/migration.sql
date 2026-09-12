-- "Create assembly" (2026-09-12 barcode/materials plan, Unit 1).
--
-- An assembly is a PriceBookAtomic row (rowType = "ASSEMBLY") plus a component list, not a new
-- top-level model — see the comment on PriceBookAtomic.assemblyItems in schema.prisma for why
-- (PriceBookDraftLine.itemId / IssuedEstimateLine.itemId are FKs to PriceBookAtomic only).
--
-- The three override flags let Kyle overwrite an assembly's auto-summed labour per tier without
-- losing the fact that it was overridden — never inferred by comparing the stored value to the
-- live component sum (an override that happens to equal the sum would otherwise look "auto"
-- again and silently resume tracking a later component change).

-- AlterTable
ALTER TABLE "PriceBookAtomic" ADD COLUMN "laborNormalOverridden" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PriceBookAtomic" ADD COLUMN "laborDifficultOverridden" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PriceBookAtomic" ADD COLUMN "laborVeryDifficultOverridden" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PriceBookItemComponent" (
    "id" TEXT NOT NULL,
    "parentItemId" TEXT NOT NULL,
    "childItemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PriceBookItemComponent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceBookItemComponent_childItemId_idx" ON "PriceBookItemComponent"("childItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBookItemComponent_parentItemId_childItemId_key" ON "PriceBookItemComponent"("parentItemId", "childItemId");

-- AddForeignKey
ALTER TABLE "PriceBookItemComponent" ADD CONSTRAINT "PriceBookItemComponent_parentItemId_fkey" FOREIGN KEY ("parentItemId") REFERENCES "PriceBookAtomic"("itemId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBookItemComponent" ADD CONSTRAINT "PriceBookItemComponent_childItemId_fkey" FOREIGN KEY ("childItemId") REFERENCES "PriceBookAtomic"("itemId") ON DELETE RESTRICT ON UPDATE CASCADE;
