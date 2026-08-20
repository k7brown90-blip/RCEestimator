-- The drawn signature (Kyle, 2026-08-20: "I want the signiture to be drawn not typed").
--
-- Nullable, and estimates signed before today keep a typed name and no drawing. That is honest:
-- they were signed under the rules that applied then, and back-filling an image would fabricate
-- a mark nobody made.

ALTER TABLE "IssuedEstimate" ADD COLUMN "signatureImage" TEXT;
