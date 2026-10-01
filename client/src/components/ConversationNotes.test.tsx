/**
 * Conversation notes on the account (plan item F, 2026-10-01).
 *
 * Kyle: "Notes should be account based for an admin that is answering calls and dispatching. Any
 * info gathered during a conversation should be able to be documented and shared with others per
 * account." One component on two surfaces; pinned here:
 * - the list reads newest first, with who took it and which job it was about;
 * - a note whose updatedAt is later than its createdAt says "edited" — and one that is not, does not;
 * - "Add note" needs both what was said and who took it, greyed with the reason until it has both;
 * - who took it is remembered in this browser and prefilled next time, with no invented default;
 * - a note added from the job drawer is tagged to that job; from the account page it is not;
 * - edit and delete live on the row (standing rule: everything has a way out);
 * - the job drawer shows the newest few with "Show all"; the account page shows every note.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { ConversationNotes, JOB_SURFACE_LIMIT, TAKEN_BY_STORAGE_KEY, isEdited, noteJobLabel } from "./ConversationNotes";
import { api } from "../lib/api";
import type { CustomerNote } from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

function note(overrides: Partial<CustomerNote> = {}): CustomerNote {
  return {
    id: "note-1",
    customerId: "cust-1",
    visitId: null,
    body: "Called about flickering in the kitchen.",
    takenBy: "Kyle",
    createdAt: "2026-09-30T14:05:00.000Z",
    updatedAt: "2026-09-30T14:05:00.000Z",
    visit: null,
    ...overrides,
  };
}

const taggedVisit: CustomerNote["visit"] = {
  id: "visit-1", jobType: "Panel upgrade", purpose: null, visitDate: "2026-09-10T12:00:00.000Z",
  property: { addressLine1: "12 Main St" },
};

describe("isEdited / noteJobLabel", () => {
  it("is edited only when updatedAt is strictly later than createdAt", () => {
    expect(isEdited(note())).toBe(false);
    expect(isEdited(note({ updatedAt: "2026-09-30T15:00:00.000Z" }))).toBe(true);
  });

  it("names the job and its address, or nothing when the note is not tagged", () => {
    expect(noteJobLabel(taggedVisit)).toBe("Panel upgrade — 12 Main St");
    expect(noteJobLabel({ ...taggedVisit!, jobType: null, purpose: "Quote the generator" })).toBe("Quote the generator — 12 Main St");
    expect(noteJobLabel(null)).toBeNull();
  });
});

describe("ConversationNotes — reading the log", () => {
  it("lists the notes as the server orders them, with who took each and which job it was about", async () => {
    vi.spyOn(api, "accountNotes").mockResolvedValue([
      note({ id: "n-2", body: "Second call: wants Tuesday.", takenBy: "Eric", createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-01T09:00:00.000Z", visitId: "visit-1", visit: taggedVisit }),
      note({ id: "n-1", body: "First call." }),
    ]);

    renderWithProviders(<ConversationNotes accountId="cust-1" surface="account" />, { route: "/accounts/cust-1" });

    const items = await screen.findAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Second call: wants Tuesday.");
    expect(items[0]).toHaveTextContent("Taken by Eric");
    expect(items[0]).toHaveTextContent("about Panel upgrade — 12 Main St");
    expect(items[1]).toHaveTextContent("First call.");
    expect(items[1]).toHaveTextContent("Taken by Kyle");
    expect(items[1]).not.toHaveTextContent("about");
    expect(api.accountNotes).toHaveBeenCalledWith("cust-1");
  });

  it("marks a changed note as edited, and leaves an unchanged one alone", async () => {
    vi.spyOn(api, "accountNotes").mockResolvedValue([
      note({ id: "n-edited", body: "Changed later.", updatedAt: "2026-09-30T16:20:00.000Z" }),
      note({ id: "n-original", body: "Never touched." }),
    ]);

    renderWithProviders(<ConversationNotes accountId="cust-1" surface="account" />, { route: "/accounts/cust-1" });

    const items = await screen.findAllByRole("listitem");
    expect(items[0]).toHaveTextContent(/· edited /);
    expect(items[1]).not.toHaveTextContent(/edited/);
  });

  it("says so when there are no notes yet, and still offers 'Add note'", async () => {
    vi.spyOn(api, "accountNotes").mockResolvedValue([]);

    renderWithProviders(<ConversationNotes accountId="cust-1" surface="account" />, { route: "/accounts/cust-1" });

    expect(await screen.findByText("No conversation notes yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add note" })).toBeInTheDocument();
  });

  it("on the job drawer shows the newest few and 'Show all'; the account page shows every note", async () => {
    const many = Array.from({ length: JOB_SURFACE_LIMIT + 2 }, (_, i) =>
      note({ id: `n-${i}`, body: `Call number ${i}` }),
    );
    vi.spyOn(api, "accountNotes").mockResolvedValue(many);

    const { unmount } = renderWithProviders(<ConversationNotes accountId="cust-1" surface="job" visitId="visit-1" />, { route: "/jobs" });

    expect(await screen.findAllByRole("listitem")).toHaveLength(JOB_SURFACE_LIMIT);
    const toggle = screen.getByRole("button", { name: `Show all ${many.length} notes (2 more)` });
    fireEvent.click(toggle);
    expect(screen.getAllByRole("listitem")).toHaveLength(many.length);
    expect(screen.getByRole("button", { name: `Show the latest ${JOB_SURFACE_LIMIT}` })).toBeInTheDocument();
    unmount();

    renderWithProviders(<ConversationNotes accountId="cust-1" surface="account" />, { route: "/accounts/cust-1" });
    expect(await screen.findAllByRole("listitem")).toHaveLength(many.length);
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });
});

describe("ConversationNotes — adding a note", () => {
  it("needs what was said AND who took it, greyed with the reason until it has both; then files it on the account", async () => {
    vi.spyOn(api, "accountNotes").mockResolvedValue([]);
    const add = vi.spyOn(api, "addAccountNote").mockResolvedValue(note());

    renderWithProviders(<ConversationNotes accountId="cust-1" surface="account" />, { route: "/accounts/cust-1" });

    fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
    const save = screen.getByRole("button", { name: "Save note" });
    expect(save).toBeDisabled();
    expect(screen.getByText("Needs what was said and who took the call.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("What was said"), { target: { value: "Wants the quote emailed again." } });
    expect(save).toBeDisabled();
    expect(screen.getByText("Say who took the call.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Taken by"), { target: { value: "Kyle" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(add).toHaveBeenCalledWith("cust-1", { body: "Wants the quote emailed again.", takenBy: "Kyle", visitId: null }));
    // The form closes and the list is re-read.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save note" })).not.toBeInTheDocument());
    expect(api.accountNotes).toHaveBeenCalledTimes(2);
  });

  it("from the job drawer, tags the note to that job and says so", async () => {
    vi.spyOn(api, "accountNotes").mockResolvedValue([]);
    const add = vi.spyOn(api, "addAccountNote").mockResolvedValue(note({ visitId: "visit-1", visit: taggedVisit }));

    renderWithProviders(<ConversationNotes accountId="cust-1" surface="job" visitId="visit-1" />, { route: "/jobs?job=visit-1" });

    fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
    expect(screen.getByText("Filed on the account and tagged to this job.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("What was said"), { target: { value: "Gate code is 4411." } });
    fireEvent.change(screen.getByLabelText("Taken by"), { target: { value: "Eric" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => expect(add).toHaveBeenCalledWith("cust-1", { body: "Gate code is 4411.", takenBy: "Eric", visitId: "visit-1" }));
  });

  it("remembers who took the call in this browser and prefills it next time — with no invented default before that", async () => {
    vi.spyOn(api, "accountNotes").mockResolvedValue([]);
    vi.spyOn(api, "addAccountNote").mockResolvedValue(note());

    const first = renderWithProviders(<ConversationNotes accountId="cust-1" surface="account" />, { route: "/accounts/cust-1" });
    fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
    // Nothing remembered yet: an empty box, not "Kyle" — a prefilled name on a machine someone
    // else uses would attribute their calls to him.
    expect(screen.getByLabelText("Taken by")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("What was said"), { target: { value: "Call one." } });
    fireEvent.change(screen.getByLabelText("Taken by"), { target: { value: "Kyle" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(localStorage.getItem(TAKEN_BY_STORAGE_KEY)).toBe("Kyle"));
    first.unmount();

    renderWithProviders(<ConversationNotes accountId="cust-2" surface="account" />, { route: "/accounts/cust-2" });
    fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
    expect(screen.getByLabelText("Taken by")).toHaveValue("Kyle");
  });

  it("shows the server's refusal instead of a dead button", async () => {
    vi.spyOn(api, "accountNotes").mockResolvedValue([]);
    vi.spyOn(api, "addAccountNote").mockRejectedValue(new Error("That job is not on this account."));

    renderWithProviders(<ConversationNotes accountId="cust-1" surface="job" visitId="visit-9" />, { route: "/jobs" });

    fireEvent.click(await screen.findByRole("button", { name: "Add note" }));
    fireEvent.change(screen.getByLabelText("What was said"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Taken by"), { target: { value: "Kyle" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText("That job is not on this account.")).toBeInTheDocument();
  });
});

describe("ConversationNotes — the way out of a note", () => {
  it("edits a note from its row", async () => {
    vi.spyOn(api, "accountNotes").mockResolvedValue([note()]);
    const update = vi.spyOn(api, "updateAccountNote").mockResolvedValue(note({ body: "Corrected.", updatedAt: "2026-09-30T16:00:00.000Z" }));

    renderWithProviders(<ConversationNotes accountId="cust-1" surface="account" />, { route: "/accounts/cust-1" });

    const row = (await screen.findAllByRole("listitem"))[0];
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const bodyBox = within(row).getByLabelText("What was said");
    expect(bodyBox).toHaveValue("Called about flickering in the kitchen.");
    fireEvent.change(bodyBox, { target: { value: "Corrected." } });
    fireEvent.click(within(row).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith("cust-1", "note-1", { body: "Corrected.", takenBy: "Kyle" }));
  });

  it("deletes a note from its row after confirming, and leaves it alone on cancel", async () => {
    vi.spyOn(api, "accountNotes").mockResolvedValue([note()]);
    const remove = vi.spyOn(api, "deleteAccountNote").mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    renderWithProviders(<ConversationNotes accountId="cust-1" surface="account" />, { route: "/accounts/cust-1" });

    const row = (await screen.findAllByRole("listitem"))[0];
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/Delete this note taken by Kyle/));
    expect(remove).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("cust-1", "note-1"));
  });
});
