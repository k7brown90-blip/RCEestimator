/**
 * ONE Conversation per record (work order agent-team, U2; default D3). The ported cases of the old
 * Conversation-notes tests (a note's Edit and Delete, the "edited" marker, who took the call and where
 * it is remembered, a note added from the job is tagged to it, the job drawer's newest few) plus what
 * the one timeline adds: emails with their delivery status, an AI draft waiting with "Review draft",
 * the website chat line, the Crew chat button, the read-only Property section, and the greyed-with-a-
 * reason buttons for a lead that is not an account yet.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useLocation } from "react-router-dom";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { messageEntry, noteEntry, timeline, approvalCard, approvalsResponse } from "../test/hubFixtures";
import { RecordConversation } from "./RecordConversation";
import { JOB_SURFACE_LIMIT, TAKEN_BY_STORAGE_KEY } from "./ConversationNotes";
import { api } from "../lib/api";
import type { TimelineEntry, TimelineNote } from "../../../shared/hub/views";
import { sendBlockText } from "../../../shared/hub/sendBlocks";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function LocationProbe() {
  const { search } = useLocation();
  return <p data-testid="location">{search}</p>;
}

function note(overrides: Partial<TimelineNote> = {}): TimelineNote {
  return {
    id: "note-1", customerId: "cust-1", visitId: null, body: "Called about flickering in the kitchen.", takenBy: "Kyle",
    createdAt: "2026-09-30T14:05:00.000Z", updatedAt: "2026-09-30T14:05:00.000Z", visit: null, ...overrides,
  };
}

const taggedVisit: TimelineNote["visit"] = {
  id: "visit-1", jobType: "Panel upgrade", purpose: null, visitDate: "2026-09-10T12:00:00.000Z", property: { addressLine1: "12 Main St" },
};

const emailEntry = (over: Partial<Extract<TimelineEntry, { type: "email" }>["email"]> = {}): TimelineEntry => ({
  type: "email", id: "email:e-1", at: "2026-11-02T10:00:00.000Z", visitId: null, jobLabel: null,
  email: {
    id: "e-1", provider: "resend", status: "delivered", statusAt: "2026-11-02T10:01:00.000Z", to: "jane@example.com", cc: [],
    subject: "Your estimate", kind: "estimate", estimateNumber: null, error: null, createdAt: "2026-11-02T10:00:00.000Z", ...over,
  },
});

const account = (entries: TimelineEntry[], over = {}) => {
  vi.spyOn(api, "hubTimeline").mockResolvedValue(timeline(entries, over));
  return renderWithProviders(
    <><RecordConversation surface="account" record={{ key: "customerId", id: "cust-1" }} accountId="cust-1" /><LocationProbe /></>,
    { route: "/accounts/cust-1" },
  );
};

describe("reading the conversation", () => {
  it("lists the entries as the server orders them, with who took each call and which job it was about", async () => {
    account([
      noteEntry(note({ id: "n-2", body: "Second call: wants Tuesday.", takenBy: "Eric", createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-01T09:00:00.000Z", visitId: "visit-1", visit: taggedVisit })),
      noteEntry(note({ id: "n-1", body: "First call." })),
    ]);

    const items = await screen.findAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Second call: wants Tuesday.");
    expect(items[0]).toHaveTextContent("Taken by Eric");
    expect(items[0]).toHaveTextContent("about Panel upgrade — 12 Main St");
    expect(items[1]).toHaveTextContent("First call.");
    expect(items[1]).not.toHaveTextContent("about");
    expect(api.hubTimeline).toHaveBeenCalledWith({ customerId: "cust-1" });
  });

  it("marks a changed note as edited, and leaves an unchanged one alone", async () => {
    account([
      noteEntry(note({ id: "n-edited", body: "Changed later.", updatedAt: "2026-09-30T16:20:00.000Z" })),
      noteEntry(note({ id: "n-original", body: "Never touched." })),
    ]);
    const items = await screen.findAllByRole("listitem");
    expect(items[0]).toHaveTextContent(/· edited /);
    expect(items[1]).not.toHaveTextContent(/edited/);
  });

  it("says so when nothing was said yet, and still offers 'Add call note'", async () => {
    account([]);
    expect(await screen.findByText("No conversation yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add call note" })).toBeEnabled();
  });

  it("shows an email with its subject, who it went to and what became of it", async () => {
    account([emailEntry({ status: "bounced", cc: ["bob@example.com"] })]);
    const row = (await screen.findAllByRole("listitem"))[0];
    expect(row).toHaveTextContent("Your estimate");
    expect(row).toHaveTextContent("to jane@example.com · cc bob@example.com");
    expect(within(row).getByText(/^Bounced/)).toBeInTheDocument();
  });

  it("shows an AI draft waiting as the AI's, with 'Review draft' opening the thread; a deleted one is a mark, not text", async () => {
    account([
      messageEntry({ id: "m-del", status: "posted", authorType: "office", authorDisplay: "Kyle", deleted: true, body: null, deletedBy: "Kyle", deletedReason: "Wrong customer", threadId: "t-1" }),
      messageEntry({ id: "m-1", threadId: "thread-9" }),
    ]);
    const rows = await screen.findAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Deleted by Kyle — Wrong customer");
    expect(rows[1]).toHaveTextContent("RCE Admin (AI)");
    expect(rows[1]).toHaveTextContent("Needs approval");
    expect(rows[1]).toHaveTextContent("Draft: confirming Tuesday.");
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Review draft" }));
    expect(screen.getByTestId("location")).toHaveTextContent("?thread=thread-9");
  });

  it("an AI draft waiting is the ApprovalCard right there on the account: Approve, Edit and Reject, no trip to another screen", async () => {
    vi.spyOn(api, "hubApprovals").mockResolvedValue(approvalsResponse([approvalCard({ id: "m-1", threadId: "thread-9" })]));
    account([messageEntry({ id: "m-1", threadId: "thread-9" })]);
    const card = await screen.findByTestId("approval-card");
    expect(within(card).getByRole("button", { name: "Approve and send" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Review draft" })).toBeNull();
  });

  it("shows a text the CRM refused as 'Not texted', never as sent", async () => {
    account([messageEntry({ id: "m-b", status: "blocked", channel: "sms", direction: "outbound", authorType: "system", authorDisplay: "System", body: "Reminder", error: "opted_out" })]);
    expect(await screen.findByText("Not texted")).toBeInTheDocument();
    // The reason is said in words, under the message, not as the raw code.
    expect(screen.queryByText("opted_out")).toBeNull();
    expect(screen.getByText(sendBlockText("opted_out"))).toBeInTheDocument();
  });

  it("a blocked line says why in words (no consent is 'never agreed', not 'opted out')", async () => {
    account([messageEntry({ id: "m-c", status: "blocked", channel: "sms", direction: "outbound", authorType: "system", authorDisplay: "System", body: "Job scheduled", error: "no_sms_consent", toMasked: "(615) ***-0101", messageClass: "transactional" })]);
    expect(await screen.findByText(sendBlockText("no_sms_consent"))).toBeInTheDocument();
    expect(screen.queryByText("no_sms_consent")).toBeNull();
    expect(screen.queryByTitle(/opted out/i)).toBeNull();
  });

  it("an automatic text names who it went to, masked, so a staff alert never reads as a text the customer got", async () => {
    account([
      messageEntry({ id: "m-1", status: "sent", channel: "sms", direction: "outbound", authorType: "system", authorDisplay: "System", body: "Hi Jane", toMasked: "(615) ***-0101", messageClass: "transactional" }),
      messageEntry({ id: "m-2", status: "sent", channel: "sms", direction: "outbound", authorType: "system", authorDisplay: "System", body: "JOB SCHEDULED", toMasked: "Kyle", messageClass: "internal" }),
    ]);
    const lines = await screen.findAllByTestId("automatic-text-line");
    expect(lines[0]).toHaveTextContent("Automatic text to (615) ***-0101");
    expect(lines[1]).toHaveTextContent("Text to Kyle");
    expect(lines[1]).toHaveTextContent("not sent to the customer");
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).getByTitle("Sent to the customer.")).toBeInTheDocument();
    expect(within(rows[1]).queryByTitle("Sent to the customer.")).toBeNull();
    expect(within(rows[1]).getByText("Sent to staff")).toBeInTheDocument();
  });

  it("a system-blocked text is a timeline line, never an Approval card, even while a card query would return other rows", async () => {
    vi.spyOn(api, "hubApprovals").mockResolvedValue(approvalsResponse([]));
    account([messageEntry({ id: "m-b", status: "blocked", channel: "sms", direction: "outbound", authorType: "system", authorDisplay: "System", body: "Job scheduled", error: "no_sms_consent" })]);
    expect(await screen.findByText("Not texted")).toBeInTheDocument();
    expect(screen.queryByTestId("approval-card")).toBeNull();
  });

  it("is one line for the website chat, and 'Open the chat' opens the lead", async () => {
    account([{ type: "web_chat", id: "chat:c-1", at: "2026-10-30T12:00:00.000Z", visitId: null, jobLabel: null, leadId: "lead-4", count: 3, status: "confirmed" }]);
    const row = (await screen.findAllByRole("listitem"))[0];
    expect(row).toHaveTextContent("Website chat — 3 messages");
    fireEvent.click(within(row).getByRole("button", { name: "Open the chat" }));
    expect(screen.getByTestId("location")).toHaveTextContent("?lead=lead-4");
  });
});

describe("the lead drawer's website chat lines", () => {
  const chat = (leadId: string): TimelineEntry => ({ type: "web_chat", id: `chat:${leadId}`, at: "2026-10-30T12:00:00.000Z", visitId: null, jobLabel: null, leadId, count: 2, status: "confirmed" });

  it("says 'above' only for this lead's own chat; a sibling lead's chat gets 'Open the chat'", async () => {
    vi.spyOn(api, "hubTimeline").mockResolvedValue(timeline([chat("lead-A"), chat("lead-B")]));
    renderWithProviders(
      <><RecordConversation surface="lead" record={{ key: "leadId", id: "lead-A" }} accountId="cust-1" /><LocationProbe /></>,
      { route: "/leads?lead=lead-A" },
    );
    const rows = await screen.findAllByRole("listitem");
    const own = rows.find((r) => r.textContent?.includes("The transcript is in Website chat above."));
    expect(own).toBeDefined();
    expect(within(own as HTMLElement).queryByRole("button", { name: "Open the chat" })).not.toBeInTheDocument();
    const sibling = rows.find((r) => within(r).queryByRole("button", { name: "Open the chat" }));
    expect(sibling).toBeDefined();
    expect(sibling).not.toHaveTextContent("above");
    fireEvent.click(within(sibling as HTMLElement).getByRole("button", { name: "Open the chat" }));
    expect(screen.getByTestId("location")).toHaveTextContent("lead=lead-B");
  });
});

describe("the job drawer's view", () => {
  const many = Array.from({ length: JOB_SURFACE_LIMIT + 2 }, (_, i) => noteEntry(note({ id: `n-${i}`, body: `Call number ${i}` })));

  it("shows the newest few and 'Show all'; the account page shows every entry", async () => {
    vi.spyOn(api, "hubTimeline").mockResolvedValue(timeline(many));
    const { unmount } = renderWithProviders(
      <RecordConversation surface="job" record={{ key: "visitId", id: "visit-1" }} accountId="cust-1" visitId="visit-1" />, { route: "/jobs" },
    );
    expect(await screen.findAllByRole("listitem")).toHaveLength(JOB_SURFACE_LIMIT);
    fireEvent.click(screen.getByRole("button", { name: `Show all ${many.length} entries (2 more)` }));
    expect(screen.getAllByRole("listitem")).toHaveLength(many.length);
    expect(screen.getByRole("button", { name: `Show the latest ${JOB_SURFACE_LIMIT}` })).toBeInTheDocument();
    unmount();

    renderWithProviders(<RecordConversation surface="account" record={{ key: "customerId", id: "cust-1" }} accountId="cust-1" />, { route: "/accounts/cust-1" });
    expect(await screen.findAllByRole("listitem")).toHaveLength(many.length);
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("'Crew chat' opens this job's crew thread, with how many messages are new", async () => {
    vi.spyOn(api, "hubTimeline").mockResolvedValue(timeline([], { crewThread: { id: "crew-7", unread: 2 } }));
    const open = vi.spyOn(api, "openJobThread");
    renderWithProviders(
      <><RecordConversation surface="job" record={{ key: "visitId", id: "visit-1" }} accountId="cust-1" visitId="visit-1" /><LocationProbe /></>, { route: "/jobs" },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Crew chat (2 new)" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("?thread=crew-7"));
    expect(open).not.toHaveBeenCalled();
  });

  it("'Crew chat' makes the job's thread the first time, then opens it", async () => {
    vi.spyOn(api, "hubTimeline").mockResolvedValue(timeline([]));
    const open = vi.spyOn(api, "openJobThread").mockResolvedValue({ id: "crew-new" });
    renderWithProviders(
      <><RecordConversation surface="job" record={{ key: "visitId", id: "visit-1" }} accountId="cust-1" visitId="visit-1" /><LocationProbe /></>, { route: "/jobs" },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Crew chat" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("?thread=crew-new"));
    expect(open).toHaveBeenCalledWith("visit-1");
  });
});

describe("adding a call note", () => {
  it("needs what was said AND who took it, greyed with the reason until it has both; then files it on the account", async () => {
    const add = vi.spyOn(api, "addAccountNote").mockResolvedValue(note() as never);
    account([]);

    fireEvent.click(await screen.findByRole("button", { name: "Add call note" }));
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
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save note" })).not.toBeInTheDocument());
    // The conversation is read again.
    await waitFor(() => expect(api.hubTimeline).toHaveBeenCalledTimes(2));
  });

  it("from the job drawer, tags the note to that job and says so", async () => {
    vi.spyOn(api, "hubTimeline").mockResolvedValue(timeline([]));
    const add = vi.spyOn(api, "addAccountNote").mockResolvedValue(note({ visitId: "visit-1", visit: taggedVisit }) as never);
    renderWithProviders(<RecordConversation surface="job" record={{ key: "visitId", id: "visit-1" }} accountId="cust-1" visitId="visit-1" />, { route: "/jobs?job=visit-1" });

    fireEvent.click(await screen.findByRole("button", { name: "Add call note" }));
    expect(screen.getByText("Filed on the account and tagged to this job.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("What was said"), { target: { value: "Gate code is 4411." } });
    fireEvent.change(screen.getByLabelText("Taken by"), { target: { value: "Eric" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(add).toHaveBeenCalledWith("cust-1", { body: "Gate code is 4411.", takenBy: "Eric", visitId: "visit-1" }));
  });

  it("remembers who took the call in this browser and prefills it next time, with no invented default before that", async () => {
    vi.spyOn(api, "addAccountNote").mockResolvedValue(note() as never);
    const first = account([]);
    fireEvent.click(await screen.findByRole("button", { name: "Add call note" }));
    expect(screen.getByLabelText("Taken by")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("What was said"), { target: { value: "Call one." } });
    fireEvent.change(screen.getByLabelText("Taken by"), { target: { value: "Kyle" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(localStorage.getItem(TAKEN_BY_STORAGE_KEY)).toBe("Kyle"));
    first.unmount();

    account([]);
    fireEvent.click(await screen.findByRole("button", { name: "Add call note" }));
    expect(screen.getByLabelText("Taken by")).toHaveValue("Kyle");
  });

  it("shows the server's refusal instead of a dead button", async () => {
    vi.spyOn(api, "addAccountNote").mockRejectedValue(new Error("That job is not on this account."));
    account([]);
    fireEvent.click(await screen.findByRole("button", { name: "Add call note" }));
    fireEvent.change(screen.getByLabelText("What was said"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Taken by"), { target: { value: "Kyle" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByText("That job is not on this account.")).toBeInTheDocument();
  });
});

describe("the way out of a note", () => {
  it("edits a note from its row", async () => {
    const update = vi.spyOn(api, "updateAccountNote").mockResolvedValue(note() as never);
    account([noteEntry(note())]);
    const row = (await screen.findAllByRole("listitem"))[0];
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const bodyBox = within(row).getByLabelText("What was said");
    expect(bodyBox).toHaveValue("Called about flickering in the kitchen.");
    fireEvent.change(bodyBox, { target: { value: "Corrected." } });
    fireEvent.click(within(row).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("cust-1", "note-1", { body: "Corrected.", takenBy: "Kyle" }));
  });

  it("deletes a note from its row after confirming, and leaves it alone on cancel", async () => {
    const remove = vi.spyOn(api, "deleteAccountNote").mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    account([noteEntry(note())]);
    const row = (await screen.findAllByRole("listitem"))[0];
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/Delete this note taken by Kyle/));
    expect(remove).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("cust-1", "note-1"));
  });
});

describe("the email composer and the other surfaces", () => {
  it("hosts the ONE composer it is given, beside 'Add call note'", async () => {
    vi.spyOn(api, "hubTimeline").mockResolvedValue(timeline([]));
    renderWithProviders(
      <RecordConversation surface="account" record={{ key: "customerId", id: "cust-1" }} accountId="cust-1" emailPanel={<button type="button">Email the customer</button>} />,
      { route: "/accounts/cust-1" },
    );
    expect(await screen.findAllByRole("button", { name: "Email the customer" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add call note" })).toBeInTheDocument();
  });

  it("greys 'Email the customer' with its reason when the host offers no composer", async () => {
    vi.spyOn(api, "hubTimeline").mockResolvedValue(timeline([]));
    renderWithProviders(
      <RecordConversation surface="job" record={{ key: "visitId", id: "visit-1" }} accountId="cust-1" visitId="visit-1" emailNote="Email from the payment card below." />,
      { route: "/jobs" },
    );
    const email = await screen.findByRole("button", { name: "Email the customer" });
    expect(email).toBeDisabled();
    expect(email).toHaveAttribute("title", "Email from the payment card below.");
    expect(screen.getByText("Email from the payment card below.")).toBeInTheDocument();
  });

  it("on a lead that is not an account yet, greys 'Add call note' and says why", async () => {
    vi.spyOn(api, "hubTimeline").mockResolvedValue(timeline([], { scope: { customerId: null, leadId: "lead-1", visitId: null, propertyId: null, name: "New Lead" } }));
    renderWithProviders(<RecordConversation surface="lead" record={{ key: "leadId", id: "lead-1" }} accountId={null} />, { route: "/leads?lead=lead-1" });
    const add = await screen.findByRole("button", { name: "Add call note" });
    expect(add).toBeDisabled();
    expect(screen.getByText("Call notes are kept on the account. Turn this lead into an account to add one.")).toBeInTheDocument();
  });

  it("on the Property page is read-only: no buttons to add, no Edit or Delete, and a way to the account", async () => {
    vi.spyOn(api, "hubTimeline").mockResolvedValue(timeline([noteEntry(note({ visitId: "visit-1", visit: taggedVisit }))], { readOnly: true }));
    renderWithProviders(<RecordConversation surface="property" record={{ key: "propertyId", id: "prop-1" }} accountId="cust-1" />, { route: "/properties/prop-1" });
    const section = await screen.findByRole("region", { name: "Conversation" });
    expect(within(section).getByRole("heading", { name: "Conversation at this address" })).toBeInTheDocument();
    expect(await within(section).findByText("Called about flickering in the kitchen.")).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "Add call note" })).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(within(section).getByRole("link", { name: "Open the account's conversation" })).toHaveAttribute("href", "/accounts/cust-1");
    expect(api.hubTimeline).toHaveBeenCalledWith({ propertyId: "prop-1" });
  });
});
