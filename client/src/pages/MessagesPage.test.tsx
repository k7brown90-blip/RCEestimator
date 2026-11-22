/**
 * The Messages page (work order agent-team, U3): the chips, the rows with their unread dot, AI chip and
 * state chip, the search box, Show closed threads, and the Needs approval queue. A click on a row opens
 * the Thread drawer (?thread=). There is no "New thread" and no "Delete thread".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useLocation } from "react-router-dom";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { approvalCard, approvalsResponse, threadRow, threadsResponse } from "../test/hubFixtures";
import { MessagesPage } from "./MessagesPage";
import { api } from "../lib/api";
import { setHubStreamStatus } from "../lib/hubStreamStatus";

afterEach(() => vi.restoreAllMocks());

function LocationProbe() {
  const { search } = useLocation();
  return <p data-testid="location">{search}</p>;
}

const draftRow = threadRow({
  id: "t-draft", kind: "customer", title: "Jane Homeowner", customerId: "cust-1", visitId: null, unread: 0, pending: 1, aiLast: true,
  lastLine: { authorType: "ai_agent", authorDisplay: "RCE Admin", status: "pending_approval", text: "Draft: confirming Tuesday.", at: "2026-11-20T15:00:00.000Z" },
});
const crewRow = threadRow({
  id: "t-crew", kind: "job", title: "Bob Builder — 9 Elm St", unread: 2,
  lastLine: { authorType: "tech", authorDisplay: "Eric", status: "posted", text: "On site.", at: "2026-11-20T14:00:00.000Z" },
});
const teamRow = threadRow({ id: "t-team", kind: "team", title: "Kyle and the AI team", visitId: null, technicianId: "tech-1" });

function show(over: Partial<ReturnType<typeof threadsResponse>> = {}) {
  const spy = vi.spyOn(api, "hubThreads").mockResolvedValue(threadsResponse([draftRow, crewRow, teamRow], { needsApproval: 1, ...over }));
  renderWithProviders(<><MessagesPage /><LocationProbe /></>, { route: "/messages" });
  return spy;
}

describe("MessagesPage", () => {
  it("lists the conversations with unread, the AI chip and the state of the newest message", async () => {
    show();
    const draft = await screen.findByRole("button", { name: /Jane Homeowner/ });
    expect(draft).toHaveTextContent("AI");
    expect(draft).toHaveTextContent("Needs approval");
    expect(draft).toHaveTextContent("RCE Admin (AI): Draft: confirming Tuesday.");
    const crew = screen.getByRole("button", { name: /Bob Builder/ });
    expect(within(crew).getByLabelText("2 unread")).toBeInTheDocument();
    expect(crew).toHaveTextContent("2 new");
    expect(crew).toHaveTextContent("Crew chat");
    expect(screen.getByRole("button", { name: /Kyle and the AI team/ })).toHaveTextContent("Team");
  });

  it("has the five chips, with the waiting count on Needs approval, and no 'New thread'", async () => {
    show({ needsApproval: 3 });
    await screen.findByRole("button", { name: /Jane Homeowner/ });
    for (const name of ["All", "Customers", "Jobs", "Team", "Needs approval (3)"]) {
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /new .*thread/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete thread/i })).not.toBeInTheDocument();
  });

  it("asks the server for the chip's kind, for the approval queue, and for the search", async () => {
    const spy = show();
    await screen.findByRole("button", { name: /Jane Homeowner/ });
    fireEvent.click(screen.getByRole("tab", { name: "Jobs" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ kind: "job", status: "open", needsApproval: false, q: undefined }));
    fireEvent.change(screen.getByLabelText("Search messages"), { target: { value: "meter" } });
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ q: "meter" })));
    fireEvent.click(screen.getByLabelText("Show closed threads"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ status: "all" })));
    vi.spyOn(api, "hubApprovals").mockResolvedValue(approvalsResponse([approvalCard()]));
    fireEvent.click(screen.getByRole("tab", { name: "Needs approval (1)" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ needsApproval: true })));
  });

  it("opens the Thread drawer for the row that was clicked", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: /Bob Builder/ }));
    expect(screen.getByTestId("location")).toHaveTextContent("?thread=t-crew");
  });

  it("says what an empty chip means, and says so when a search finds nothing", async () => {
    vi.spyOn(api, "hubThreads").mockResolvedValue(threadsResponse([]));
    vi.spyOn(api, "hubApprovals").mockResolvedValue(approvalsResponse([]));
    renderWithProviders(<MessagesPage />, { route: "/messages" });
    fireEvent.change(await screen.findByLabelText("Search messages"), { target: { value: "zzz" } });
    expect(await screen.findByText("Nothing matches that search.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Needs approval (0)" }));
    expect(await screen.findByText("Nothing is waiting for approval.")).toBeInTheDocument();
  });

  it("Needs approval lists the drafts themselves as cards with Approve, Edit and Reject, not conversation rows", async () => {
    show();
    vi.spyOn(api, "hubApprovals").mockResolvedValue(approvalsResponse([approvalCard()]));
    await screen.findByRole("button", { name: /Jane Homeowner/ });
    fireEvent.click(screen.getByRole("tab", { name: "Needs approval (1)" }));
    const card = await screen.findByTestId("approval-card");
    expect(within(card).getByRole("button", { name: "Approve and send" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Reject" })).toBeEnabled();
    // The conversation rows and the search box belong to the other chips.
    expect(screen.queryByRole("button", { name: /Bob Builder/ })).toBeNull();
    expect(screen.queryByLabelText("Search messages")).toBeNull();
    // A way into the conversation is on the card.
    fireEvent.click(within(card).getByRole("button", { name: "Open the conversation" }));
    expect(screen.getByTestId("location")).toHaveTextContent("?thread=thread-1");
  });

  it("tells someone without the approve power why they cannot act on the queue, with every button greyed", async () => {
    show({ canApprove: false });
    const reason = "Only Kyle can approve what the agents draft. Kyle can turn this on for you under Team → CRM login.";
    vi.spyOn(api, "hubApprovals").mockResolvedValue(approvalsResponse([approvalCard()], { canApprove: false, approveReason: reason }));
    await screen.findByRole("button", { name: /Jane Homeowner/ });
    fireEvent.click(screen.getByRole("tab", { name: "Needs approval (1)" }));
    expect(await screen.findByTestId("approval-queue-lock")).toHaveTextContent(reason);
    expect(screen.getByRole("button", { name: "Approve and send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });
});

describe("MessagesPage: live updates and notifications (U6, U7)", () => {
  afterEach(() => setHubStreamStatus("connecting"));

  it("says 'Reconnecting…' until the stream is live, then 'Live', and offers the notifications button either way", async () => {
    vi.spyOn(api, "hubPushKey").mockResolvedValue({ configured: false, publicKey: null, reason: "Notifications are not set up on the server yet.", subscribed: false });
    show();
    await screen.findByRole("button", { name: /Jane Homeowner/ });
    expect(screen.getByTestId("stream-status")).toHaveTextContent("Reconnecting…");
    expect(screen.getByRole("button", { name: "Turn on notifications on this device" })).toBeInTheDocument();
    setHubStreamStatus("live");
    await waitFor(() => expect(screen.getByTestId("stream-status")).toHaveTextContent("Live"));
  });
});
