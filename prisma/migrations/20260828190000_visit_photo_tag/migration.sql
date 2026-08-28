-- Photo gallery (Kyle, 2026-08-28): job photos need a category so before/after
-- and assessment shots can be told apart. Nullable — every existing photo
-- simply has no tag yet.
ALTER TABLE "VisitPhoto" ADD COLUMN "tag" TEXT;
