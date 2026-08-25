-- The handoff queue (Phase 4, Kyle 2026-08-25): "admin then schedules an
-- estimate or install once that job is closed out." A completed job with
-- nextStep null sits in the office's Needs-next-step queue until it is
-- dispositioned: archived | followup_booked.
ALTER TABLE "Visit" ADD COLUMN "nextStep" TEXT;
ALTER TABLE "Visit" ADD COLUMN "nextStepAt" TIMESTAMP(3);

-- Jobs completed before the queue existed would otherwise flood it on day one.
-- They were dispositioned by life already; mark them archived.
UPDATE "Visit" SET "nextStep" = 'archived', "nextStepAt" = CURRENT_TIMESTAMP
  WHERE "status" = 'completed' AND "completedAt" IS NULL;
