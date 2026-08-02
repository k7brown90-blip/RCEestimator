-- §3.3 applies per TERMINATION, not per enclosure.
--
-- The first cut blocked torque for every component inside a
-- serviceSideEnergized enclosure. Wrong scope: the main lugs stay hot with
-- the main open, but branch breakers in the same panel are load-side — they
-- can be switched off and torque-verified. The flag moves to the item; the
-- enclosure flag remains as the default heuristic for line-side component
-- types (lug, service_entrance, meter_base, mast, weatherhead).
ALTER TABLE "InspectionItem" ADD COLUMN IF NOT EXISTS "serviceSideEnergized" BOOLEAN NOT NULL DEFAULT false;
