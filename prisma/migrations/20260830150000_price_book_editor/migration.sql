-- In-app price book editor (Kyle, 2026-08-30, Option A: the app is the book).
-- subCategory nullable; audit table append-only; category order table.
ALTER TABLE "PriceBookAtomic" ADD COLUMN "subCategory" TEXT;

CREATE TABLE "PriceBookEdit" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "editedBy" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PriceBookEdit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PriceBookEdit_itemId_createdAt_idx" ON "PriceBookEdit"("itemId", "createdAt");

CREATE TABLE "PriceBookCategoryMeta" (
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "PriceBookCategoryMeta_pkey" PRIMARY KEY ("name")
);
