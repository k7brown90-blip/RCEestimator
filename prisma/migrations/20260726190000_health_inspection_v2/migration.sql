-- Health record v2: the 0-100 headline score is retired in favour of leading
-- with the line items that need correction.
--
-- `score` is made nullable rather than dropped: reports already delivered to
-- customers carry a score, and re-rendering one must reproduce what was sent.
-- `schemaVersion` is what the PDF generator and the CRM history views branch on.
--
-- Deploy ordering matters: this must land before any field build that stops
-- sending `score`. The push endpoint accepts both shapes so a phone running a
-- stale service worker keeps syncing either way.

-- AlterTable
ALTER TABLE "HealthInspection" ALTER COLUMN "score" DROP NOT NULL;

ALTER TABLE "HealthInspection" ADD COLUMN     "schemaVersion" TEXT NOT NULL DEFAULT 'v1',
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'full',
ADD COLUMN     "failCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "monitorCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "passCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "belowStandardCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "naCount" INTEGER NOT NULL DEFAULT 0;
