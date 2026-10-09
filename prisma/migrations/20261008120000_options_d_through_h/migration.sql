-- Options continue past C, up to H (Kyle, 2026-10-08: "Capping it at eight is good.").
-- Additive only: ADD VALUE statements, nothing else. No existing row changes, and no statement
-- here uses a new value (a new enum value cannot be used in the transaction that adds it).
ALTER TYPE "PriceBookOption" ADD VALUE IF NOT EXISTS 'D';
ALTER TYPE "PriceBookOption" ADD VALUE IF NOT EXISTS 'E';
ALTER TYPE "PriceBookOption" ADD VALUE IF NOT EXISTS 'F';
ALTER TYPE "PriceBookOption" ADD VALUE IF NOT EXISTS 'G';
ALTER TYPE "PriceBookOption" ADD VALUE IF NOT EXISTS 'H';
