-- A signature taken on the technician's phone with no signal is accepted once, by its phone-minted
-- id, and keeps the phone's capture time beside the server's receipt time (Kyle, 2026-10-09,
-- one-estimating-system rulings 9 and 10; Phase 7 unit U7). ADD COLUMN only: both nullable, no
-- default, no backfill - every existing signature keeps exactly what it recorded. Hand-written like
-- 20261009140000_void_a_commission: `prisma migrate dev` would touch the drifted .env database.
ALTER TABLE "IssuedEstimate" ADD COLUMN "clientSignatureId" TEXT;
ALTER TABLE "IssuedEstimate" ADD COLUMN "signatureCapturedAt" TIMESTAMP(3);

-- One capture is one signature on one estimate: the same id can never land on a second row.
CREATE UNIQUE INDEX "IssuedEstimate_clientSignatureId_key" ON "IssuedEstimate"("clientSignatureId");
