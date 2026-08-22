-- Discounts and walkthrough photos (Kyle, 2026-08-22).
--
-- DISCOUNTS: "military discount at 5%, senior citizen discount at 5%" — "Off of the whole job but
-- gets capped at $250." The TYPE is chosen while drafting and copied to the issued estimate; the
-- AMOUNT is frozen at signature (discountJson), because 5%-of-what-they-selected does not exist as
-- a number until the customer picks. Same freeze discipline as the combination discount.
--
-- PHOTOS: bytes in the database because Railway wipes the filesystem on deploy. Attach-only; no
-- AI egress (P012 seam).

ALTER TABLE "PriceBookDraftEstimate" ADD COLUMN "discountType" TEXT;
ALTER TABLE "IssuedEstimate" ADD COLUMN "discountType" TEXT;
ALTER TABLE "IssuedEstimate" ADD COLUMN "discountJson" TEXT;

CREATE TABLE "DraftPhoto" (
    "id"        TEXT NOT NULL,
    "draftId"   TEXT NOT NULL,
    "mime"      TEXT NOT NULL,
    "bytes"     BYTEA NOT NULL,
    "size"      INTEGER NOT NULL,
    "note"      TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DraftPhoto_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DraftPhoto_draftId_idx" ON "DraftPhoto"("draftId");
ALTER TABLE "DraftPhoto" ADD CONSTRAINT "DraftPhoto_draftId_fkey"
    FOREIGN KEY ("draftId") REFERENCES "PriceBookDraftEstimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
