-- The change order joins the invoice (Kyle, 2026-09-20): "apply a change order
-- to an already signed invoice. This will add to the cost of the job and allow
-- a single payment once its all finished."
--
-- The signed documents stay frozen and separate. What changes is the money: a
-- signed change order now rolls into the invoice of the estimate it points at.
-- Three columns on the issued row carry that:
--   changeOrderForId — the ROOT invoice this change order belongs to (frozen
--                      copy of the draft's link; the draft stays editable).
--   depositRequired  — the ⅓ deposit is optional now, per document. ON keeps
--                      today's behaviour; OFF adds nothing to the deposit.
--   addToCurrentJob  — a signed change order attaches to the parent's job
--                      instead of minting a second one.

ALTER TABLE "IssuedEstimate"
  ADD COLUMN "changeOrderForId" TEXT,
  ADD COLUMN "depositRequired"  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "addToCurrentJob"  BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "IssuedEstimate_changeOrderForId_idx" ON "IssuedEstimate"("changeOrderForId");

ALTER TABLE "IssuedEstimate"
  ADD CONSTRAINT "IssuedEstimate_changeOrderForId_fkey"
  FOREIGN KEY ("changeOrderForId") REFERENCES "IssuedEstimate"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Every change order already issued gets its frozen parent link from the draft
-- it came from, so the Godwin-style change orders signed before today join
-- their invoice too (their money already sits on their own rows and simply
-- sums). A change order raised against a change order flattens to the root.
-- (Resolved through the PARENT'S DRAFT, not the parent's new column: inside one
-- UPDATE every row reads the pre-statement snapshot, so the parent's own link
-- would still be NULL here.)
UPDATE "IssuedEstimate" e
SET "changeOrderForId" = COALESCE(pd."changeOrderForId", d."changeOrderForId")
FROM "PriceBookDraftEstimate" d
LEFT JOIN "IssuedEstimate" parent ON parent."id" = d."changeOrderForId"
LEFT JOIN "PriceBookDraftEstimate" pd ON pd."id" = parent."draftId"
WHERE e."draftId" = d."id"
  AND d."changeOrderForId" IS NOT NULL
  AND d."changeOrderForId" <> e."id";

-- Kyle's default for change orders: no deposit of their own.
UPDATE "IssuedEstimate" SET "depositRequired" = false WHERE "changeOrderForId" IS NOT NULL;
