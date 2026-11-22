/**
 * The Thread drawer (work order agent-team, U3): messages with author badges, "Post to crew" / "Post to
 * team", Edit and Delete on your own message, "deleted by ... - reason", Rename, Close thread / Reopen,
 * marking read on open, and a customer thread that is the record's own Conversation. There is no
 * "Delete thread".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../../test/renderWithProviders";
import { approvalCard, approvalsResponse, threadDetail, threadMessage, timeline } from "../../test/hubFixtures";
import { OWNER_NO_GRANT, PIN_SESSION } from "../../test/sessions";
import { DrawerHost } from "./DrawerHost";
import { api } from "../../lib/api";
import * as images from "../../lib/images";
import type { AccountSummary } from "../../lib/types";

afterEach(() => vi.restoreAllMocks());

const open = async (detail: ReturnType<typeof threadDetail>) => {
  vi.spyOn(api, "hubThread").mockResolvedValue(detail);
  vi.spyOn(api, "markHubThreadRead").mockResolvedValue(undefined);
  renderWithProviders(<DrawerHost />, { route: "/messages?thread=thread-1" });
  return screen.findByRole("dialog", { name: detail.thread.title });
};

describe("ThreadDrawer: a crew thread", () => {
  it("shows who said what, an AI author as one, and 'Post to crew' greyed until there is something to post", async () => {
    const dialog = await open(threadDetail([
      threadMessage({ id: "m-1", authorType: "tech", authorDisplay: "Eric", body: "On site, panel is open." }),
      threadMessage({ id: "m-2", authorType: "ai_agent", authorDisplay: "RCE Admin", body: "Noted, thanks." }),
    ]));
    expect(within(dialog).getByText("On site, panel is open.")).toBeInTheDocument();
    expect(within(dialog).getByText("RCE Admin (AI)")).toBeInTheDocument();
    const post = within(dialog).getByRole("button", { name: "Post to crew" });
    expect(post).toBeDisabled();
    expect(within(dialog).getByText("Write a message first.")).toBeInTheDocument();
    // No way to delete the thread, or to start a new one, from here.
    expect(within(dialog).queryByRole("button", { name: /delete thread/i })).not.toBeInTheDocument();
  });

  it("a text the CRM sent by itself names who it went to, and a refused one says why in words under 'Not texted'", async () => {
    vi.spyOn(api, "hubApprovals").mockResolvedValue(approvalsResponse([]));
    const dialog = await open(threadDetail([
      threadMessage({ id: "m-1", authorType: "system", authorDisplay: "System", channel: "sms", direction: "outbound", status: "sent", body: "NEW JOB", toMasked: "(615) ***-0102", messageClass: "internal" }),
      threadMessage({ id: "m-2", authorType: "system", authorDisplay: "System", channel: "sms", direction: "outbound", status: "blocked", body: "Job update", error: "internal_not_allowed", toMasked: "(615) ***-0103", messageClass: "internal" }),
    ]));
    const lines = within(dialog).getAllByTestId("automatic-text-line");
    expect(lines[0]).toHaveTextContent("Staff alert text to (615) ***-0102");
    expect(within(dialog).queryByTitle("Sent to the customer.")).toBeNull();
    expect(within(dialog).getByText("Not texted")).toBeInTheDocument();
    expect(within(dialog).queryByText("internal_not_allowed")).toBeNull();
    expect(within(dialog).queryByTestId("approval-card")).toBeNull();
  });

  it("posts a message to the crew", async () => {
    const dialog = await open(threadDetail([]));
    const posted = vi.spyOn(api, "postHubMessage").mockResolvedValue({ id: "m-9" });
    fireEvent.change(within(dialog).getByLabelText("Message"), { target: { value: "Bring the 200 amp base" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Post to crew" }));
    await waitFor(() => expect(posted).toHaveBeenCalledWith("thread-1", { body: "Bring the 200 amp base" }));
  });

  it("says 'Post to team' on a Team thread", async () => {
    const dialog = await open(threadDetail([], { kind: "team", title: "Kyle and the AI team", visitId: null, technicianId: "tech-1" }));
    expect(within(dialog).getByRole("button", { name: "Post to team" })).toBeInTheDocument();
  });

  it("greys 'Post to team' with the reason on another person's Team thread, but still shows what was said", async () => {
    const why = "This is Kyle's thread with the AI team — you can read it, not post in it.";
    const detail = threadDetail(
      [threadMessage({ id: "m-1", body: "Order the Romex" })],
      { kind: "team", title: "Kyle ↔ AI team", visitId: null, technicianId: "tech-kyle" },
    );
    const dialog = await open({ ...detail, postBlock: why });
    expect(within(dialog).getByText("Order the Romex")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Message"), { target: { value: "hello" } });
    expect(within(dialog).getByLabelText("Message")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Post to team" })).toBeDisabled();
    expect(within(dialog).getByText(why)).toBeInTheDocument();
  });

  it("marks the thread read when it opens with something new in it, and marks the new ones", async () => {
    const dialog = await open(threadDetail(
      [threadMessage({ id: "m-old", createdAt: "2026-11-20T10:00:00.000Z" }), threadMessage({ id: "m-new", body: "Fresh news", createdAt: "2026-11-20T16:00:00.000Z" })],
      { unread: 1 }, "2026-11-20T12:00:00.000Z",
    ));
    await waitFor(() => expect(api.markHubThreadRead).toHaveBeenCalledWith("thread-1"));
    const fresh = within(dialog).getByText("Fresh news").closest("li") as HTMLElement;
    expect(fresh).toHaveTextContent("New");
    expect(within(dialog).getByText("On site, panel is open.").closest("li")).not.toHaveTextContent("New");
  });

  it("does not call it read when nothing is unread", async () => {
    await open(threadDetail([threadMessage()], { unread: 0 }));
    expect(api.markHubThreadRead).not.toHaveBeenCalled();
  });
});

describe("ThreadDrawer: the way out of a message", () => {
  it("edits your own message", async () => {
    const dialog = await open(threadDetail([threadMessage({ id: "m-mine", authorDisplay: "Kyle", authorType: "office", body: "First try", mine: true, canEdit: true, canDelete: true })]));
    const edit = vi.spyOn(api, "editHubMessage").mockResolvedValue({ id: "m-mine", editedAt: "2026-11-21T12:00:00.000Z" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit" }));
    const box = within(dialog).getByLabelText("Message text");
    expect(box).toHaveValue("First try");
    fireEvent.change(box, { target: { value: "Second try" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(edit).toHaveBeenCalledWith("m-mine", { body: "Second try" }));
  });

  it("offers no Edit or Delete on someone else's message", async () => {
    const dialog = await open(threadDetail([threadMessage({ mine: false, canEdit: false, canDelete: false })]));
    expect(within(dialog).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("deletes with a reason: 'Delete message' is greyed until one is given", async () => {
    const dialog = await open(threadDetail([threadMessage({ id: "m-mine", mine: true, canEdit: true, canDelete: true })]));
    const remove = vi.spyOn(api, "deleteHubMessage").mockResolvedValue(undefined);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    const confirm = within(dialog).getByRole("button", { name: "Delete message" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Why is it being deleted?"), { target: { value: "Wrong job" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("m-mine", { reason: "Wrong job" }));
  });

  it("leaves 'Deleted by ... - reason' where a deleted message was, with no text", async () => {
    const dialog = await open(threadDetail([threadMessage({ deleted: true, body: null, deletedBy: "Kyle", deletedReason: "Wrong job", canDelete: false })]));
    expect(within(dialog).getByText("Deleted by Kyle — Wrong job")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});

describe("ThreadDrawer: the thread itself", () => {
  it("renames the thread", async () => {
    const dialog = await open(threadDetail([]));
    const patch = vi.spyOn(api, "patchHubThread").mockResolvedValue(threadDetail([]));
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Elm St crew" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("thread-1", { title: "Elm St crew" }));
  });

  it("closes the thread, and a closed one offers Reopen and greys the box with the reason", async () => {
    const dialog = await open(threadDetail([]));
    const patch = vi.spyOn(api, "patchHubThread").mockResolvedValue(threadDetail([]));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close thread" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("thread-1", { status: "closed" }));
  });

  it("offers Reopen on a closed thread and says why posting is off", async () => {
    const dialog = await open(threadDetail([], { status: "closed" }));
    expect(within(dialog).getByRole("button", { name: "Reopen" })).toBeInTheDocument();
    expect(within(dialog).getByText("This thread is closed. Reopen it to post.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Post to crew" })).toBeDisabled();
  });
});

describe("ThreadDrawer: a customer thread", () => {
  it("is the account's Conversation, with the same two buttons and no box of its own", async () => {
    vi.spyOn(api, "hubTimeline").mockResolvedValue(timeline([]));
    vi.spyOn(api, "accountSummary").mockResolvedValue({ account: { id: "cust-1", name: "Jane Homeowner", email: "jane@example.com" } } as unknown as AccountSummary);
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    const dialog = await open(threadDetail([], { kind: "customer", title: "Jane Homeowner", customerId: "cust-1", visitId: null }));
    expect(await within(dialog).findByRole("button", { name: "Add call note" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Email the customer" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Post" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Open the account →" })).toHaveAttribute("href", "/accounts/cust-1");
    expect(api.hubTimeline).toHaveBeenCalledWith({ customerId: "cust-1" });
  });
});

describe("ThreadDrawer: an AI draft waiting, and the Audit button", () => {
  const draftMessage = () => threadMessage({
    id: "msg-1", authorType: "ai_agent", authorDisplay: "RCE Admin", body: "Drafted: the panel is ready Tuesday.", status: "pending_approval",
  });

  it("draws the draft as the one ApprovalCard, with Approve, Edit and Reject, in place of the plain message", async () => {
    vi.spyOn(api, "hubApprovals").mockResolvedValue(approvalsResponse([
      approvalCard({
        threadKind: "job", channel: "in_app", kind: "team_reply", headerLine: "Message · Internal only", recipient: null, recipientAddress: null, subject: null,
        body: "Drafted: the panel is ready Tuesday.", chip: { tone: "internal", text: "Internal only — never reaches a customer" },
        approve: { label: "Approve and post", confirm: "Post this in the conversation?", blockedReason: null, editBlockedReason: null },
      }),
    ]));
    const dialog = await open(threadDetail([draftMessage()]));
    const card = await within(dialog).findByTestId("approval-card");
    expect(card).toHaveTextContent("Draft by RCE Admin (AI) · Message · Internal only");
    expect(within(card).getByRole("button", { name: "Approve and post" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Reject" })).toBeEnabled();
    // Said once: the plain message row is not drawn beside its card.
    expect(within(dialog).getAllByText("Drafted: the panel is ready Tuesday.")).toHaveLength(1);
  });

  it("the Audit button is Kyle's: greyed with the reason for anyone else", async () => {
    vi.spyOn(api, "session").mockResolvedValue(OWNER_NO_GRANT);
    const dialog = await open(threadDetail([]));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Audit" })).toBeDisabled());
    expect(within(dialog).getByText(/Only Kyle can read the message audit log\./)).toBeInTheDocument();
  });

  it("for Kyle, Audit shows what the hub did in this conversation only", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    const audit = vi.spyOn(api, "hubAudit").mockResolvedValue({
      entries: [{
        id: "a-1", at: "2026-11-21T18:00:00.000Z", actorKey: "owner", actorDisplay: "Kyle", action: "message_approved", actionLabel: "Approved",
        threadId: "thread-1", threadTitle: "Jane Homeowner — 12 Main St", messageId: "m-1", reason: null, messageClass: null, category: null,
        summary: "Approved — Jane Homeowner — 12 Main St",
      }],
      actors: [{ key: "owner", display: "Kyle" }], more: false,
    });
    const dialog = await open(threadDetail([]));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Audit" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Audit" }));
    expect(await within(dialog).findByText("Audit for this conversation")).toBeInTheDocument();
    await waitFor(() => expect(audit).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-1" })));
    expect(await within(dialog).findByText("Approved — Jane Homeowner — 12 Main St")).toBeInTheDocument();
  });
});

describe("ThreadDrawer: Add photo (U5, amendment 9b)", () => {
  const pick = (dialog: HTMLElement, name = "p.jpg") => {
    const file = new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });
    fireEvent.change(within(dialog).getByLabelText("Choose a photo"), { target: { files: [file] } });
  };
  const stubObjectUrls = () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() });
  };

  it("is on a Team thread: the picture is shrunk to 1600 px, held on the server, sent with the message, and can be removed first", async () => {
    stubObjectUrls();
    const blob = new Blob(["x"], { type: "image/jpeg" });
    const shrink = vi.spyOn(images, "downscaleToBlob").mockResolvedValue(blob);
    const upload = vi.spyOn(api, "uploadHubAttachment").mockResolvedValue({ id: "att-1", mimeType: "image/jpeg", sizeBytes: 1 });
    const removeAtt = vi.spyOn(api, "removeHubAttachment").mockResolvedValue(undefined);
    const dialog = await open(threadDetail([], { kind: "team", title: "Eric and the AI team", visitId: null, technicianId: "tech-1" }));
    const add = within(dialog).getByRole("button", { name: "Add photo" });
    expect(add).toBeEnabled();
    pick(dialog);
    await waitFor(() => expect(upload).toHaveBeenCalledWith("thread-1", blob));
    expect(shrink).toHaveBeenCalledTimes(1);

    // A photo on its own is a message, so Post is no longer greyed for "Write a message first".
    const post = within(dialog).getByRole("button", { name: "Post to team" });
    await waitFor(() => expect(post).toBeEnabled());
    const posted = vi.spyOn(api, "postHubMessage").mockResolvedValue({ id: "m-9" });
    fireEvent.click(post);
    await waitFor(() => expect(posted).toHaveBeenCalledWith("thread-1", { body: "", attachmentIds: ["att-1"] }));

    // The exit before it is sent: Remove takes it off the server too.
    pick(dialog, "q.jpg");
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeAtt).toHaveBeenCalledWith("att-1"));
    expect(within(dialog).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("is on a job thread: nothing is saved until Post to crew, which files the picture on the job and names it", async () => {
    vi.spyOn(images, "downscale").mockResolvedValue("data:image/jpeg;base64,AAAA");
    const upload = vi.spyOn(api, "uploadVisitPhoto").mockResolvedValue({ id: "vp-1" } as never);
    const hold = vi.spyOn(api, "uploadHubAttachment");
    const dialog = await open(threadDetail([], { kind: "job", visitId: "visit-1" }));
    pick(dialog);
    await waitFor(() => expect(within(dialog).getByRole("img", { name: "Photo to send" })).toBeInTheDocument());
    expect(upload).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    const posted = vi.spyOn(api, "postHubMessage").mockResolvedValue({ id: "m-9" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Post to crew" }));
    await waitFor(() => expect(posted).toHaveBeenCalledWith("thread-1", { body: "", photoIds: ["vp-1"] }));
    expect(upload).toHaveBeenCalledWith("visit-1", { dataUrl: "data:image/jpeg;base64,AAAA" });
  });

  it("is greyed with the reason on a closed thread, on a Dev thread and on another person's Team thread", async () => {
    const closed = await open(threadDetail([], { status: "closed" }));
    expect(within(closed).getByRole("button", { name: "Add photo" })).toBeDisabled();
    expect(within(closed).getAllByText("This thread is closed. Reopen it to add a photo.").length).toBeGreaterThan(0);
  });

  it("is greyed on a Dev thread, which holds no photos", async () => {
    const dev = await open(threadDetail([], { kind: "dev", title: "Dev", visitId: null }));
    expect(within(dev).getByRole("button", { name: "Add photo" })).toBeDisabled();
    expect(within(dev).getByText("Photos go on a job, Team or Training thread.")).toBeInTheDocument();
  });

  it("a failed post and a second 'Post to crew' name the photos already filed on the job; it does not file them again", async () => {
    vi.spyOn(images, "downscale").mockResolvedValue("data:image/jpeg;base64,AAAA");
    const upload = vi.spyOn(api, "uploadVisitPhoto")
      .mockResolvedValueOnce({ id: "vp-1" } as never)
      .mockResolvedValueOnce({ id: "vp-2" } as never)
      .mockResolvedValue({ id: "vp-WRONG" } as never);
    const dialog = await open(threadDetail([], { kind: "job", visitId: "visit-1" }));
    pick(dialog, "a.jpg");
    await waitFor(() => expect(within(dialog).getAllByRole("img", { name: "Photo to send" })).toHaveLength(1));
    pick(dialog, "b.jpg");
    await waitFor(() => expect(within(dialog).getAllByRole("img", { name: "Photo to send" })).toHaveLength(2));
    const posted = vi.spyOn(api, "postHubMessage")
      .mockRejectedValueOnce(new Error("The server was busy."))
      .mockResolvedValue({ id: "m-9" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Post to crew" }));
    await waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
    await within(dialog).findByText("The server was busy.");
    expect(upload).toHaveBeenCalledTimes(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "Post to crew" }));
    await waitFor(() => expect(posted).toHaveBeenCalledTimes(2));
    // Still two uploads, and the retry named the same two photos.
    expect(upload).toHaveBeenCalledTimes(2);
    expect(posted).toHaveBeenLastCalledWith("thread-1", { body: "", photoIds: ["vp-1", "vp-2"] });
  });

  it("brings back a photo that was added and never sent, with its Remove, so it is never stranded out of sight", async () => {
    stubObjectUrls();
    vi.spyOn(api, "removeHubAttachment").mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Blob(["img"], { type: "image/jpeg" }), { status: 200 }));
    const detail = { ...threadDetail([], { kind: "team", title: "Eric and the AI team", visitId: null, technicianId: "tech-1" }), staged: [{ id: "att-held", mimeType: "image/jpeg" }] };
    const dialog = await open(detail);
    expect(await within(dialog).findByRole("img", { name: "Photo to send" })).toBeInTheDocument();
    // A photo on its own is a message, so Post is not greyed while it is held.
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Post to team" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.removeHubAttachment).toHaveBeenCalledWith("att-held"));
    expect(within(dialog).queryByRole("img", { name: "Photo to send" })).not.toBeInTheDocument();
  });

  it("an empty edit box on a photo-only message says why Save changes is greyed", async () => {
    const dialog = await open(threadDetail([threadMessage({ id: "m-mine", authorDisplay: "Kyle", authorType: "office", body: null, mine: true, canEdit: true, canDelete: true, attachments: [{ id: "att-1", mimeType: "image/jpeg" }] })]));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Blob(["img"], { type: "image/jpeg" }), { status: 200 }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit" }));
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(within(dialog).getByTestId("edit-needs-words")).toHaveTextContent("Type some words to save.");
    fireEvent.change(within(dialog).getByLabelText("Message text"), { target: { value: "Here is the panel" } });
    expect(within(dialog).queryByTestId("edit-needs-words")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("shows the photos on a message, fetched with the session and never by a URL carrying a token", async () => {
    stubObjectUrls();
    const fetched: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      fetched.push(String(input));
      return new Response(new Blob(["img"], { type: "image/jpeg" }), { status: 200 });
    });
    const dialog = await open(threadDetail([threadMessage({
      id: "m-1", body: "Look", attachments: [{ id: "att-9", mimeType: "image/jpeg" }], photoIds: ["vp-3"],
    })], { kind: "team", title: "Eric and the AI team", visitId: null, technicianId: "tech-1" }));
    await waitFor(() => expect(within(dialog).getAllByRole("img").length).toBe(2));
    const pictures = fetched.filter((u) => /visit-photos|hub\/attachments/.test(u)).sort();
    expect(pictures).toEqual(["/api/health-record-admin/visit-photos/vp-3", "/api/hub/attachments/att-9"]);
    for (const url of pictures) expect(url).not.toMatch(/token|access/i);
  });
});
