-- P030 — Kyle's tab becomes the catalog.
--
-- Purely additive. The 226 items from `Atomics (Kyle's Copy)` land as NEW rows in
-- PriceBookAtomic with readable keys; the existing 323 are retired in place by the importer
-- (retiredAt), never deleted, so the two legacy drafts keep their foreign keys and every signed
-- or issued estimate keeps its frozen snapshot.
--
-- `sell*` are the authoritative customer prices, straight from Kyle's sheet. `companyCost` and
-- `companyPrice` are internal. The labour columns already on this table carry per-unit HOURS for
-- these rows and stay internal too — no customer-facing model gains an hours field here.

ALTER TABLE "PriceBookAtomic"
  ADD COLUMN "companyCost"       DOUBLE PRECISION,
  ADD COLUMN "companyPrice"      DOUBLE PRECISION,
  ADD COLUMN "sellDifficult"     DOUBLE PRECISION,
  ADD COLUMN "sellNormal"        DOUBLE PRECISION,
  ADD COLUMN "sellVeryDifficult" DOUBLE PRECISION,
  ADD COLUMN "source"            TEXT NOT NULL DEFAULT 'neca-workbook',
  ADD COLUMN "unitLabel"         TEXT;

CREATE INDEX "PriceBookAtomic_source_idx" ON "PriceBookAtomic"("source");
