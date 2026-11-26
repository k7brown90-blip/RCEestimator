-- Sales tax inside the sell, all items (Kyle, 2026-11-24: "Tax in sell, all items"). Two nullable columns, no data change:
-- the price book itself is repriced by the server at start-up (src/services/priceBookTaxReprice.ts), never by SQL, so there is one pricing formula.
-- AlterTable
ALTER TABLE "PriceBookAtomic" ADD COLUMN     "companyCostWithTax" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "IssuedEstimateLine" ADD COLUMN     "materialCostWithTax" DOUBLE PRECISION;

