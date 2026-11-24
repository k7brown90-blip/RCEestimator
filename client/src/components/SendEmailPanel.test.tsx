/** CC on the follow-up email panel (Kyle, 2026-10-24: "The email will be the same as doing a CC email."). */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { SendEmailPanel } from "./SendEmailPanel";
import { api } from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SendEmailPanel CC on a lead", () => {
  it("sends the CC list with the email, and explains why a typed address cannot be saved as a contact", async () => {
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    const send = vi.spyOn(api, "sendRecordEmail").mockResolvedValue({
      sent: true, to: "jane@example.com", cc: ["pm@example.com"], suppressed: false,
    });
    renderWithProviders(<SendEmailPanel target="lead" id="lead-1" primaryEmail="jane@example.com" />);

    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    fireEvent.change(screen.getByLabelText("CC address"), { target: { value: "pm@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add CC" }));
    expect(screen.getByText(/CC pm@example.com/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as contact" })).toBeDisabled();
    expect(screen.getAllByText("Leads have no account to save contacts to").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Checking in" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Following up." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith({
      target: "lead", id: "lead-1", to: "jane@example.com", cc: ["pm@example.com"], subject: "Checking in", body: "Following up.",
    }));
    expect(await screen.findByText("Sent to jane@example.com, cc pm@example.com.")).toBeInTheDocument();
  });
});

/*
 * ONE EMAIL TOOL (Kyle, 2026-10-27: "A rule of thumb is there is one tool for one task."): with a
 * `record` the same panel is "Email the customer" - pick what you are sending, who gets it, and one
 * Send button names both. Without a record it is exactly the message panel above.
 */
describe("SendEmailPanel with a record - Email the customer", () => {
  const record = {
    estimateId: "est-1",
    number: "2026-1104",
    kinds: [
      { kind: "invoice" as const, label: "Invoice 2026-1104 — $2,800.00 due" },
      { kind: "deposit" as const, label: "Deposit request — $1,400.00", blocked: "Financing in progress — the deposit pay link is closed." },
      { kind: "financing" as const, label: "Financing link" },
      { kind: "message" as const, label: "Message" },
    ],
  };
  const quiet = () => {
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    vi.spyOn(api, "accountContacts").mockResolvedValue([
      { id: "c1", accountId: "acct-1", label: "Property manager", email: "pm@example.com", phone: null },
    ] as never);
    vi.spyOn(api, "account").mockResolvedValue({ id: "acct-1", name: "ACAR", properties: [] } as never);
  };

  it("offers only the kinds it was given, greys a blocked one WITH its reason, and names kind + recipient on the one Send button", async () => {
    quiet();
    renderWithProviders(<SendEmailPanel target="account" id="acct-1" primaryEmail="amehmedovic@acar.example" accountIdForContacts="acct-1" record={record} />);

    fireEvent.click(screen.getByRole("button", { name: "Email the customer" }));
    expect(screen.getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual(["invoice", "deposit", "financing", "message"]);
    expect(screen.getByRole("radio", { name: /^Deposit request/ })).toBeDisabled();
    expect(screen.getByText("Financing in progress — the deposit pay link is closed.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Invoice 2026-1104/ })).toBeChecked();
    expect(screen.getAllByRole("button", { name: /^Send / })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send invoice 2026-1104 to amehmedovic@acar.example" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Financing link" }));
    expect(screen.getByRole("button", { name: "Send financing link to amehmedovic@acar.example" })).toBeInTheDocument();
  });

  it("sends the invoice to the picked contact with a CC and a note, and the button follows the pick", async () => {
    quiet();
    const send = vi.spyOn(api, "sendCustomerEmail").mockResolvedValue({ sent: true, kind: "invoice", to: "pm@example.com", cc: ["amehmedovic@acar.example"], amount: 2800, reminder: false });
    renderWithProviders(<SendEmailPanel target="account" id="acct-1" primaryEmail="amehmedovic@acar.example" accountIdForContacts="acct-1" record={record} />);

    fireEvent.click(screen.getByRole("button", { name: "Email the customer" }));
    await screen.findAllByRole("option", { name: /Property manager — pm@example.com/ });
    fireEvent.change(screen.getByLabelText("Send to"), { target: { value: "pm@example.com" } });
    fireEvent.change(screen.getByLabelText("Add CC"), { target: { value: "amehmedovic@acar.example" } });
    fireEvent.change(screen.getByPlaceholderText("Optional note to include in the email"), { target: { value: "Per our call" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invoice 2026-1104 to pm@example.com" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith({
      kind: "invoice", estimateId: "est-1", to: "pm@example.com", cc: ["amehmedovic@acar.example"], message: "Per our call", photoIds: undefined,
    }));
  });

  it("the Message kind is the free-form email, filed against the estimate so the thread shows it", async () => {
    quiet();
    const sendRecord = vi.spyOn(api, "sendRecordEmail").mockResolvedValue({ sent: true, to: "amehmedovic@acar.example", suppressed: false });
    const sendCustomer = vi.spyOn(api, "sendCustomerEmail");
    renderWithProviders(<SendEmailPanel target="account" id="acct-1" primaryEmail="amehmedovic@acar.example" accountIdForContacts="acct-1" record={record} />);

    fireEvent.click(screen.getByRole("button", { name: "Email the customer" }));
    fireEvent.click(screen.getByRole("radio", { name: "Message" }));
    const sendButton = screen.getByRole("button", { name: "Send message to amehmedovic@acar.example" });
    expect(sendButton).toBeDisabled(); // a message needs a subject and a body
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Quick question" } });
    fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "Hello." } });
    fireEvent.click(sendButton);

    await waitFor(() => expect(sendRecord).toHaveBeenCalledWith({
      target: "account", id: "acct-1", to: null, subject: "Quick question", body: "Hello.", estimateId: "est-1",
    }));
    expect(sendCustomer).not.toHaveBeenCalled();
  });

  it("with no address anywhere, says so and keeps Send greyed - it does not guess", async () => {
    quiet();
    renderWithProviders(<SendEmailPanel target="account" id="acct-1" primaryEmail={null} accountIdForContacts="acct-1" record={record} />);
    fireEvent.click(screen.getByRole("button", { name: "Email the customer" }));
    expect(screen.getByText(/No email on file — pick a contact or type an address above/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send invoice 2026-1104" })).toBeDisabled();
  });

  it("without a record it stays the plain message panel: no kinds, 'Send email', 'Send'", async () => {
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    renderWithProviders(<SendEmailPanel target="lead" id="lead-1" primaryEmail="jane@example.com" />);
    expect(screen.queryByRole("button", { name: "Email the customer" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });
});

/*
 * ONE Conversation per record (work order agent-team, U2 / D3): where a record's Conversation timeline
 * lists every email, the panel is the composer only. It lists nothing of its own and says "Email the
 * customer". Everywhere else (the estimate and invoice drawers) its list of what was sent stays.
 */
describe("SendEmailPanel inside a record's Conversation", () => {
  const delivery = {
    id: "d-1", provider: "resend" as const, providerMessageId: null, status: "delivered" as const, statusAt: null, to: "jane@example.com", cc: [],
    error: null, createdAt: "2026-11-02T10:00:00.000Z", subject: "Earlier note", kind: "communication" as const, estimateNumber: null,
    issuedEstimateId: null, visitId: null, leadId: "lead-1", customerId: null, estimate: null,
  };

  it("lists nothing of its own with showThread off, and the closed button says what openLabel says", async () => {
    const list = vi.spyOn(api, "emailDeliveries").mockResolvedValue([delivery]);
    renderWithProviders(<SendEmailPanel target="lead" id="lead-1" primaryEmail="jane@example.com" showThread={false} openLabel="Email the customer" />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Email the customer" })).toBeInTheDocument();
    expect(screen.queryByText(/Email thread/)).not.toBeInTheDocument();
    expect(screen.queryByText("Earlier note")).not.toBeInTheDocument();
  });

  it("keeps its list of what was sent by default", async () => {
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([delivery]);
    renderWithProviders(<SendEmailPanel target="lead" id="lead-1" primaryEmail="jane@example.com" />);
    expect(await screen.findByText("Email thread (1)")).toBeInTheDocument();
  });
});

/*
 * THE AI ADMIN'S MESSAGE IS A DRAFT (work order agent-team, U4b, default D2): signed in as the AI admin, the free-form
 * Message button reads "Send for Kyle's approval to jane@…" and the server leaves a draft instead of sending; Kyle's own
 * session and every other office login keep "Send". The structured kinds (invoice, estimate, review...) are not touched.
 */
describe("SendEmailPanel as the AI admin", () => {
  it("names who it would go to, masked, and who approves it; the answer says it was left for approval", async () => {
    vi.spyOn(api, "session").mockResolvedValue({ kind: "ai-admin", name: "grok-admin", role: "ai-admin", isKyle: false, powers: [] });
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    const send = vi.spyOn(api, "sendRecordEmail").mockResolvedValue({
      sent: false, drafted: true, messageId: "m-1", to: "jane@example.com", cc: ["pm@example.com"], suppressed: false,
    });
    renderWithProviders(<SendEmailPanel target="lead" id="lead-1" primaryEmail="jane@example.com" />);

    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Checking in" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Following up." } });
    const button = await screen.findByRole("button", { name: "Send for Kyle's approval to jane@…" });
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    fireEvent.click(button);

    await waitFor(() => expect(send).toHaveBeenCalledWith({
      target: "lead", id: "lead-1", to: "jane@example.com", subject: "Checking in", body: "Following up.",
    }));
    expect(await screen.findByText(/Left for Kyle's approval\. It goes to jane@example\.com, cc pm@example\.com once he approves it, from Messages → Waiting for approval\./)).toBeInTheDocument();
    expect(screen.queryByText(/^Sent to/)).not.toBeInTheDocument();
  });

  it("Kyle's own session keeps the plain Send button", async () => {
    vi.spyOn(api, "session").mockResolvedValue({ kind: "kyle-pin", name: "Kyle", role: "owner", isKyle: true, powers: [] });
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    renderWithProviders(<SendEmailPanel target="lead" id="lead-1" primaryEmail="jane@example.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    expect(await screen.findByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approval/ })).not.toBeInTheDocument();
  });

  it("a structured kind (the review request) is not drafted: its button keeps its own words even for the AI admin", async () => {
    vi.spyOn(api, "session").mockResolvedValue({ kind: "ai-admin", name: "grok-admin", role: "ai-admin", isKyle: false, powers: [] });
    vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
    vi.spyOn(api, "accountContacts").mockResolvedValue([] as never);
    vi.spyOn(api, "account").mockResolvedValue({ id: "acct-1", name: "ACAR", properties: [] } as never);
    renderWithProviders(
      <SendEmailPanel
        target="account" id="acct-1" primaryEmail="jane@example.com" accountIdForContacts="acct-1"
        record={{ visitId: "v1", kinds: [{ kind: "review" as const }, { kind: "message" as const }] }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Email the customer" }));
    expect(await screen.findByRole("button", { name: "Send review request to jane@example.com" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Message" }));
    expect(await screen.findByRole("button", { name: "Send for Kyle's approval to jane@…" })).toBeInTheDocument();
  });
});
