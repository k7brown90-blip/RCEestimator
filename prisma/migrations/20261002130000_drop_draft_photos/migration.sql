-- Drop the retired DraftPhoto table (Kyle, 2026-10-02: "Draft photos don't make sense to me …
-- we would obviously want the photos added to the estimates that are from an applied job,
-- consultation, or diagnostics."). Every route that read or wrote this table is already gone;
-- nothing in the app references it.
--
-- THIS PERMANENTLY DESTROYS DATA. Before this migration ran, Kyle ran a separate, deliberate
-- script (scripts/migrateDraftPhotosToVisits.ts) against production on 2026-10-01 to move what
-- could be moved: 16 rows total, 11 migrated onto VisitPhoto (the photo now lives on the
-- consultation job it came from), 5 unresolved, 0 failed. Of the 5 unresolved, Kyle exported 2 to
-- his own machine and deliberately let the other 3 go after reviewing all five himself. This
-- migration destroys those 5 photographs (3 never exported, 2 already saved off elsewhere) along
-- with the empty husk of the table. That is an informed decision already made, not something for
-- this migration to re-litigate — it only finishes the irreversible step.

-- DropTable
DROP TABLE "DraftPhoto";
