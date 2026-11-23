/**
 * Settings -> "Message audit log" (work order agent-team, U4; Kyle only): read-only, newest first, filtered
 * to "Blocked texts" (when, reason, class, send type - never a phone), and greyed with the reason for anyone
 * but Kyle. The Thread drawer's "Audit" button shows the same list for one conversation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { MessageAuditLogSection } from "./MessageAuditLogSection";
import { AUDIT_LOCK_REASON } from "../components/MessageAuditLog";
import { api } from "../lib/api";
import { AI_ADMIN_SESSION, OWNER_NO_GRANT, PIN_SESSION } from "../test/sessions";
import type { AuditResponse } from "../../../shared/hub/views";

afterEach(() => vi.restoreAllMocks());

const entry = (over: Partial<AuditResponse["entries"][number]> = {}): AuditResponse["entries"][number] => ({
  id: "a-1", at: "2026-11-21T18:00:00.000Z", actorKey: "owner", actorDisplay: "Kyle", action: "message_approved", actionLabel: "Approved",
  threadId: "thread-1", threadTitle: "Jane Homeowner", messageId: "m-1", reason: null, messageClass: null, category: null,
  summary: "Approved — Jane Homeowner", ...over,
});
const page = (entries = [entry()], over: Partial<AuditResponse> = {}): AuditResponse => ({ entries, actors: [{ key: "owner", display: "Kyle" }], more: false, ...over });

describe("Message audit log", () => {
  it("lists what happened, and 'Blocked texts' asks the server for send_blocked and shows the reason, class and send type", async () => {
    const audit = vi.spyOn(api, "hubAudit").mockImplementation(async (f) => (f?.action === "send_blocked"
      ? page([entry({
        id: "b-1", action: "send_blocked", actionLabel: "Blocked text", reason: "Red Cedar never sends marketing by text", messageClass: "marketing",
        category: "seasonal_offer", summary: "marketing text (seasonal_offer) was not sent — Jane Homeowner",
      })])
      : page()));
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    renderWithProviders(<MessageAuditLogSection />);
    expect(await screen.findByText("Approved — Jane Homeowner")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "send_blocked" } });
    await waitFor(() => expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "send_blocked" })));
    expect(await screen.findByText("Red Cedar never sends marketing by text")).toBeInTheDocument();
    expect(screen.getByText(/marketing text \(seasonal_offer\) was not sent/)).toBeInTheDocument();
    expect(screen.getByText("Blocked text")).toBeInTheDocument();
  });

  it("filters by who, and loads older entries on request", async () => {
    const audit = vi.spyOn(api, "hubAudit").mockImplementation(async (f) => (f?.before
      ? page([entry({ id: "old-1", summary: "Rejected — Old Customer" })])
      : page([entry()], { more: true })));
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    renderWithProviders(<MessageAuditLogSection />);
    await screen.findByText("Approved — Jane Homeowner");
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    expect(await screen.findByText("Rejected — Old Customer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
    fireEvent.change(await screen.findByLabelText("Who"), { target: { value: "owner" } });
    await waitFor(() => expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actor: "owner" })));
  });

  it.each([["the AI admin", AI_ADMIN_SESSION], ["another login", OWNER_NO_GRANT]])("%s sees it greyed with the reason and nothing is fetched", async (_who, session) => {
    vi.spyOn(api, "session").mockResolvedValue(session);
    const audit = vi.spyOn(api, "hubAudit").mockResolvedValue(page());
    renderWithProviders(<MessageAuditLogSection />);
    await screen.findByTestId("audit-locked");
    expect(screen.getByTestId("audit-locked")).toHaveTextContent(AUDIT_LOCK_REASON);
    expect(screen.getByLabelText("Show")).toBeDisabled();
    expect(audit).not.toHaveBeenCalled();
  });
});
