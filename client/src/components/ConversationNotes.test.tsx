/**
 * Call notes (plan item F, 2026-10-01) — the helpers that stay in ConversationNotes.tsx after the
 * list moved into the one record Conversation (work order agent-team, U2 / D3).
 *
 * Kyle: "Notes should be account based for an admin that is answering calls and dispatching. Any
 * info gathered during a conversation should be able to be documented and shared with others per
 * account." The behaviours that used to be tested through the old list component (Add, Edit, Delete,
 * the edited marker, who took the call and where it is remembered, the job tag, the job drawer's
 * newest few) are pinned through the record Conversation in RecordConversation.test.tsx.
 */

import { describe, expect, it } from "vitest";
import { isEdited, noteJobLabel } from "./ConversationNotes";
import type { TimelineNote } from "../../../shared/hub/views";

const base = { createdAt: "2026-09-30T14:05:00.000Z", updatedAt: "2026-09-30T14:05:00.000Z" };

const taggedVisit: TimelineNote["visit"] = {
  id: "visit-1", jobType: "Panel upgrade", purpose: null, visitDate: "2026-09-10T12:00:00.000Z", property: { addressLine1: "12 Main St" },
};

describe("isEdited / noteJobLabel", () => {
  it("is edited only when updatedAt is strictly later than createdAt", () => {
    expect(isEdited(base)).toBe(false);
    expect(isEdited({ ...base, updatedAt: "2026-09-30T15:00:00.000Z" })).toBe(true);
  });

  it("names the job and its address, or nothing when the note is not tagged", () => {
    expect(noteJobLabel(taggedVisit)).toBe("Panel upgrade — 12 Main St");
    expect(noteJobLabel({ ...taggedVisit!, jobType: null, purpose: "Quote the generator" })).toBe("Quote the generator — 12 Main St");
    expect(noteJobLabel(null)).toBeNull();
  });
});
