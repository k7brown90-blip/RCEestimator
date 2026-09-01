-- Custom percentage discount (Kyle, 2026-09-01): "I want to be able to add a custom discount
-- here. This will allow me to stay competitive and I can follow through with a price match
-- system." discountType gains the value "custom"; the percentage lives beside it on the draft and
-- is frozen onto the issued estimate at issue. Nullable, no default: existing rows carry no
-- custom percentage, and null is the truthful value for that.
ALTER TABLE "PriceBookDraftEstimate" ADD COLUMN "discountPercent" DOUBLE PRECISION;
ALTER TABLE "IssuedEstimate" ADD COLUMN "discountPercent" DOUBLE PRECISION;
