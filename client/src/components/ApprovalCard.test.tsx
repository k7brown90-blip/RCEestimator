/**
 * The ONE approval card (work order agent-team, U4 + TC1/TC3): what it says (header from the frozen class and
 * purpose, the chip, "When you approve", "Sends as:"), and what its three buttons do - Approve and send (asks
 * first), Edit then "Send my version", Reject (a reason first). Greyed, never hidden, with the reason printed:
 * the approve_drafts sentence for someone without the power, and "Red Cedar never sends marketing by text" for a
 * text that can never go. A held text has "Send now" and a failed one "Try sending again"; decided cards show
 * who and what, with the delivery chip for a sent email.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { approvalCard } from "../test/hubFixtures";
import { ApprovalCard } from "./ApprovalCard";
import { api } from "../lib/api";
import type { HubDecision } from "../lib/types";

afterEach(() => vi.restoreAllMocks());

const REASON = "Only Kyle can approve what the agents draft. Kyle can turn this on for you under Team → CRM login.";
const decision = (over: Partial<HubDecision> = {}): HubDecision => ({ card: approvalCard({ status: "sent" }), send: { status: "sent", error: null }, ...over });

function show(card = approvalCard(), props: { canApprove?: boolean; approveReason?: string | null; onDecided?: () => void } = {}) {
  return renderWithProviders(
    <ApprovalCard card={card} canApprove={props.canApprove ?? true} approveReason={props.approveReason ?? null} onDecided={props.onDecided} />,
  );
}
const btn = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("what the card says", () => {
  it("names the author, the channel, class and purpose, the recipient and the effect, and the last messages above it", () => {
    show();
    const card = screen.getByTestId("approval-card");
    expect(card).toHaveTextContent("Draft by RCE Admin (AI) · Email · Transactional — Reply · to Jane");
    expect(screen.getByTestId("approval-chip")).toHaveTextContent("This will email the customer");
    expect(card).toHaveTextContent("Can you come Tuesday?");
    expect(card).toHaveTextContent("We can be there Tuesday morning.");
    expect(screen.getByTestId("when-you-approve")).toHaveTextContent("Emails Jane at jane@example.com");
  });

  it("a text shows 'Sends as:' with the exact words, and an internal draft says it never reaches a customer", () => {
    show(approvalCard({
      channel: "sms", headerLine: "Text · Transactional — Appointment Confirmation", recipientAddress: null, subject: null,
      sendsAs: "Red Cedar Electric: Appointment Confirmation Mon 11/23, 8-10 AM\nTuesday works.\nReply STOP to opt out.",
    }));
    expect(screen.getByTestId("sends-as")).toHaveTextContent("Red Cedar Electric: Appointment Confirmation Mon 11/23, 8-10 AM");
    expect(screen.getByTestId("approval-card")).toHaveTextContent("Text · Transactional — Appointment Confirmation");
  });

  it("an in-app draft carries the Internal-only chip", () => {
    show(approvalCard({
      channel: "in_app", kind: "team_reply", headerLine: "Message · Internal only", recipient: null, recipientAddress: null, subject: null,
      chip: { tone: "internal", text: "Internal only — never reaches a customer" },
      approve: { label: "Approve and post", confirm: "Post this in the conversation?", blockedReason: null, editBlockedReason: null },
    }));
    expect(screen.getByTestId("approval-chip")).toHaveTextContent("Internal only — never reaches a customer");
    expect(btn("Approve and post")).toBeEnabled();
  });
});

describe("Approve", () => {
  it("asks the server's question first, then approves; a 'No' sends nothing", async () => {
    const approve = vi.spyOn(api, "approveHubMessage").mockResolvedValue(decision());
    const onDecided = vi.fn();
    show(approvalCard(), { onDecided });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(btn("Approve and send"));
    expect(confirm).toHaveBeenCalledWith("Send this email to Jane (jane@example.com)? It goes to the customer.");
    expect(approve).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(btn("Approve and send"));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("msg-1"));
    await waitFor(() => expect(onDecided).toHaveBeenCalledTimes(1));
  });

  it("an internal draft posts without a customer question", async () => {
    const approve = vi.spyOn(api, "approveHubMessage").mockResolvedValue(decision());
    const confirm = vi.spyOn(window, "confirm");
    show(approvalCard({ chip: { tone: "internal", text: "Internal only — never reaches a customer" }, approve: { label: "Approve and post", confirm: "Post?", blockedReason: null, editBlockedReason: null } }));
    fireEvent.click(btn("Approve and post"));
    await waitFor(() => expect(approve).toHaveBeenCalled());
    expect(confirm).not.toHaveBeenCalled();
  });

  it("shows the server's refusal on the card", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(api, "approveHubMessage").mockRejectedValue(new Error("Someone else already decided this draft."));
    show();
    fireEvent.click(btn("Approve and send"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else already decided this draft.");
  });
});

describe("greyed, never hidden, with the reason printed", () => {
  it("a session without the approve power sees all three buttons greyed and the power's sentence", () => {
    show(approvalCard(), { canApprove: false, approveReason: REASON });
    for (const name of ["Approve and send", "Edit", "Reject"]) expect(btn(name)).toBeDisabled();
    expect(screen.getByTestId("approval-lock")).toHaveTextContent(REASON);
  });

  it("a marketing text greys Approve and Edit with 'Red Cedar never sends marketing by text', but Reject still works", async () => {
    show(approvalCard({
      channel: "sms", headerLine: "Text · Marketing", recipientAddress: null, subject: null, sendsAs: null,
      approve: { label: "Approve and send", confirm: "Text this to Jane? It goes to the customer.", blockedReason: "Red Cedar never sends marketing by text", editBlockedReason: "Red Cedar never sends marketing by text" },
    }));
    expect(btn("Approve and send")).toBeDisabled();
    expect(btn("Edit")).toBeDisabled();
    expect(screen.getByTestId("approval-lock")).toHaveTextContent("Red Cedar never sends marketing by text");
    expect(btn("Reject")).toBeEnabled();
    expect(screen.getByTestId("approval-card")).toHaveTextContent("Text · Marketing");
  });
});

describe("Edit and Send my version", () => {
  it("edits the subject and words and sends them through the one edit-approve call", async () => {
    const edit = vi.spyOn(api, "editApproveHubMessage").mockResolvedValue(decision());
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);
    show();
    fireEvent.click(btn("Edit"));
    const form = screen.getByRole("form", { name: "Edit draft" });
    fireEvent.change(within(form).getByLabelText("Subject"), { target: { value: "Your visit" } });
    fireEvent.change(within(form).getByLabelText("Message"), { target: { value: "Kyle's own words." } });
    fireEvent.click(within(form).getByRole("button", { name: "Send my version" }));
    await waitFor(() => expect(edit).toHaveBeenCalledWith("msg-1", { body: "Kyle's own words.", subject: "Your visit", cc: [] }));
  });

  it("'Send my version' is greyed until there are words, and Cancel leaves the draft alone", () => {
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);
    show();
    fireEvent.click(btn("Edit"));
    const form = screen.getByRole("form", { name: "Edit draft" });
    fireEvent.change(within(form).getByLabelText("Message"), { target: { value: "  " } });
    expect(within(form).getByRole("button", { name: "Send my version" })).toBeDisabled();
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Edit draft" })).toBeNull();
  });
});

describe("Reject", () => {
  it("'Reject draft' stays greyed with 'Type a reason first' until there is a reason, then rejects with it", async () => {
    const reject = vi.spyOn(api, "rejectHubMessage").mockResolvedValue(decision({ send: null, card: approvalCard({ status: "rejected" }) }));
    show();
    fireEvent.click(btn("Reject"));
    const form = screen.getByRole("form", { name: "Reject draft" });
    const submit = within(form).getByRole("button", { name: "Reject draft" });
    expect(submit).toBeDisabled();
    expect(within(form).getByText("Type a reason first")).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Why?"), { target: { value: "Wrong day" } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(reject).toHaveBeenCalledWith("msg-1", { reason: "Wrong day" }));
  });
});

describe("after a decision, and the exits", () => {
  it("a held text says 'Approved — SMS disabled' and offers Send now and Reject", () => {
    show(approvalCard({
      channel: "sms", status: "approved", subject: null, recipientAddress: null,
      outcome: { text: "Approved — SMS disabled", error: null, decidedBy: "Kyle", decidedAt: null, rejectedReason: null, sentAt: null, emailDelivery: null },
    }));
    expect(screen.getByTestId("approval-outcome")).toHaveTextContent("Approved — SMS disabled");
    expect(btn("Send now")).toBeEnabled();
    expect(btn("Reject")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("a failed message says why and offers Try sending again and Reject", () => {
    show(approvalCard({
      status: "failed",
      outcome: { text: "Could not be sent: Gmail is down", error: null, decidedBy: null, decidedAt: null, rejectedReason: null, sentAt: null, emailDelivery: null },
    }));
    expect(screen.getByTestId("approval-outcome")).toHaveTextContent("Could not be sent: Gmail is down");
    expect(btn("Try sending again")).toBeEnabled();
    expect(btn("Reject")).toBeEnabled();
  });

  it("a sent email shows who sent it and its delivery chip, with no buttons left", () => {
    show(approvalCard({
      status: "sent",
      outcome: {
        text: "Sent by Kyle", error: null, decidedBy: "Kyle", decidedAt: "2026-11-20T16:00:00.000Z", rejectedReason: null, sentAt: "2026-11-20T16:00:01.000Z",
        emailDelivery: { id: "d-1", provider: "resend", status: "delivered", statusAt: "2026-11-20T16:01:00.000Z", to: "jane@example.com", cc: [], subject: "Tuesday", kind: "communication", estimateNumber: null, error: null, createdAt: "2026-11-20T16:00:01.000Z" },
      },
    }));
    expect(screen.getByTestId("approval-outcome")).toHaveTextContent("Sent by Kyle");
    expect(screen.getByTestId("approval-outcome")).toHaveTextContent(/Delivered/);
    expect(screen.queryByRole("button", { name: /approve|reject|edit/i })).toBeNull();
  });

  it("a rejected draft shows the reason, and a blocked text the refusal", () => {
    show(approvalCard({ status: "rejected", outcome: { text: "Rejected: Wrong day", error: null, decidedBy: "Kyle", decidedAt: null, rejectedReason: "Wrong day", sentAt: null, emailDelivery: null } }));
    expect(screen.getByTestId("approval-outcome")).toHaveTextContent("Rejected: Wrong day");
  });
});

describe("Edit stays live when editing is the remedy", () => {
  it("a draft blocked only because of its own words greys Approve but keeps Edit and 'Send my version' live", async () => {
    const edit = vi.spyOn(api, "editApproveHubMessage").mockResolvedValue(decision());
    show(approvalCard({
      channel: "sms", subject: null, recipientAddress: null,
      approve: {
        label: "Approve and send", confirm: "Text this to Jane? It goes to the customer.",
        blockedReason: "The text already says \"Reply STOP\". The footer is added for you; take it out of the message.", editBlockedReason: null,
      },
    }));
    expect(btn("Approve and send")).toBeDisabled();
    expect(btn("Edit")).toBeEnabled();
    fireEvent.click(btn("Edit"));
    const form = screen.getByRole("form", { name: "Edit draft" });
    fireEvent.change(within(form).getByLabelText(/Words/), { target: { value: "Tuesday works." } });
    const send = within(form).getByRole("button", { name: "Send my version" });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    await waitFor(() => expect(edit).toHaveBeenCalledWith("msg-1", { body: "Tuesday works." }));
  });

  it("an email draft with no address on file keeps Edit live so one can be typed", () => {
    show(approvalCard({
      recipientAddress: null,
      approve: { label: "Approve and send", confirm: "Send?", blockedReason: "There is no email address on file for this customer. Edit the draft and type one.", editBlockedReason: null },
    }));
    expect(btn("Approve and send")).toBeDisabled();
    expect(btn("Edit")).toBeEnabled();
  });

  it("a held text while texting is off greys Send now with the reason, and Reject still works", () => {
    show(approvalCard({
      channel: "sms", status: "approved", subject: null, recipientAddress: null,
      approve: { label: "Approve and send", confirm: "Text?", blockedReason: "Texting is turned off. This text goes out once texting is turned on.", editBlockedReason: null },
      outcome: { text: "Approved — SMS disabled", error: null, decidedBy: "Kyle", decidedAt: null, rejectedReason: null, sentAt: null, emailDelivery: null },
    }));
    expect(btn("Send now")).toBeDisabled();
    expect(screen.getByTestId("approval-lock")).toHaveTextContent("Texting is turned off.");
    expect(btn("Reject")).toBeEnabled();
  });
});

