-- Option mode (Kyle, 2026-08-25): "A single EV Charger estimate, give 3
-- options on length from panel… Since these are to help decide the location
-- and not 3 different EV Chargers they cannot be additive." false = options
-- ADD (all that apply, the default); true = one-or-the-other — the customer
-- picks exactly ONE, enforced at signature.
ALTER TABLE "PriceBookDraftEstimate" ADD COLUMN "exclusiveOptions" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "IssuedEstimate" ADD COLUMN "exclusiveOptions" BOOLEAN NOT NULL DEFAULT false;
