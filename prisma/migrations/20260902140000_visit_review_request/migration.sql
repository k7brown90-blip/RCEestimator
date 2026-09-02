-- Google review request on job completion (Kyle, 2026-09-02: "I need a review
-- request to send out once I mark a job done"). Stamped when the email goes,
-- so a job asks exactly once and a repeat customer isn't nagged per visit.
ALTER TABLE "Visit" ADD COLUMN "reviewRequestedAt" TIMESTAMP(3);
