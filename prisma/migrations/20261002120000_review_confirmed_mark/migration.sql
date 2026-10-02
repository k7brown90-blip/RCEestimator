-- Google review confirmed, manual mark (Kyle, 2026-10-02, plan item E / ruling E2: "I would like
-- the google review to be a manual only marked ... when we follow up with them we can send it
-- while we are on the phone with them and request it during a conversation.").
--
-- Google gives this app no signal that a review actually landed, so this is a recorded business
-- fact a human enters after checking Google themselves, not something the system derives. Two
-- columns on Customer, not a new table: this is a single CURRENT fact about the account ("has
-- this customer left us a review"), not a running log several people add to — unlike
-- CustomerNote, which is exactly that kind of log and correctly got its own table.
--
-- `reviewConfirmedBy` is nullable and carries no default, on purpose, same as CustomerNote.takenBy
-- and HealthInspection.reviewedBy: there is no per-user identity behind the shared PIN, so the
-- server cannot know who marked it and will not invent an author.
--
-- Reversible, like everything this app creates: the CRM control that sets these two columns also
-- clears them back to NULL — nothing here is a one-way switch.

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "reviewConfirmedAt" TIMESTAMP(3);
ALTER TABLE "Customer" ADD COLUMN "reviewConfirmedBy" TEXT;
