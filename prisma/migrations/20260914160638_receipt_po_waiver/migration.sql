-- Kyle, 2026-09-14 (legacy purchase close-out, Unit 2): a confirmed materials
-- receipt whose PO can never exist (photo lost, e.g. the 9/11 upload failure)
-- leaves the "needs PO" queue by being marked WAIVED, never by being attached
-- to a PO it has no real link to. purchaseOrderId stays null.
-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "poWaivedAt" TIMESTAMP(3),
ADD COLUMN     "poWaivedReason" TEXT;
