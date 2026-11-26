/**
 * Settings -> "Agent keys" (work order agent-team, K-U2).
 *
 * Pinned: the heading and the Running / Writes paused / All agents off strip with its three confirming
 * buttons (one writer: PUT /owner-settings/agentAccess); the key table (Live/Test chip, prefix, scope
 * and hub chips, Allow writes live for Kyle, expiry, last used, status);
 * every control GREYED WITH ITS REASON for a session without bot_keys and for the AI admin; "+ New
 * agent key" greyed "Set AGENT_KEY_PEPPER in Railway first." with no pepper; the Agent dropdown
 * prefilling scopes and thread limits; the show-once dialog, whose secret never enters the React
 * Query cache and is gone when it closes; Rotate, Revoke, Edit and "Revoked keys (n)".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { renderWithProviders } from "../test/renderWithProviders";
import { AgentKeysSection } from "./AgentKeysSection";
import { api } from "../lib/api";
import type { AgentAccessMode, AgentKeyView, AgentKeysData } from "../lib/types";
import { AI_ADMIN_SESSION, OWNER_NO_GRANT, ownerWith, PIN_SESSION } from "../test/sessions";
import { AGENT_KEYS_AI_ADMIN_REASON } from "../../../shared/agentScopes";
import { CRM_POWERS } from "../../../shared/crmPowers";

afterEach(() => vi.restoreAllMocks());

// A helper rather than `mode: "on"` literals: tests/visitModes.test.ts scans the client for that spelling
// as a VISIT mode. These are the agent kill switch's modes.
const access = (mode: AgentAccessMode, changedAt: string | null = null, changedBy: string | null = null) => ({ mode, changedAt, changedBy });

const key = (over: Partial<AgentKeyView> = {}): AgentKeyView => ({
  id: "k1", name: "Admin Agent", agentRole: "admin", environment: "live", displayPrefix: "rce_live_AbC1",
  scopes: ["crm:read", "hub:read"], hubThreadKinds: [], writesEnabled: false, teamPostsPublish: true, expiresAt: null, retiresAt: null,
  revokedAt: null, revokedReason: null, lastUsedAt: null, lastUsedTool: null, createdAt: "2026-11-21T10:00:00-06:00",
  createdBy: "owner", rotatedFromId: null, status: "active", ...over,
});

const data = (over: Partial<AgentKeysData> = {}): AgentKeysData => ({
  pepperConfigured: true, environment: "live",
  agentAccess: access("on"), keys: [key()], ...over,
});

function show(initial: AgentKeysData, session = PIN_SESSION) {
  vi.spyOn(api, "session").mockResolvedValue(session);
  const load = vi.spyOn(api, "agentKeys").mockResolvedValue(initial);
  const create = vi.spyOn(api, "createAgentKey").mockResolvedValue({ key: key({ id: "k9", name: "New one" }), secret: "rce_live_SECRETSECRETSECRETSECRETSECRETSECRETSECRE1" });
  const update = vi.spyOn(api, "updateAgentKey").mockResolvedValue({ key: key() });
  const rotate = vi.spyOn(api, "rotateAgentKey").mockResolvedValue({
    key: key({ id: "k2" }), retired: key({ status: "retiring", retiresAt: "2026-11-22T10:00:00-06:00" }), secret: "rce_live_ROTATEDROTATEDROTATEDROTATEDROTATEDROTATE1",
  });
  const revoke = vi.spyOn(api, "revokeAgentKey").mockResolvedValue({ key: key({ status: "revoked" }) });
  const mode = vi.spyOn(api, "setAgentAccess").mockResolvedValue({ key: "agentAccess", value: access("off", "2026-11-21T15:02:00-06:00", "Kyle") });
  const view = renderWithProviders(<AgentKeysSection />);
  return { load, create, update, rotate, revoke, mode, ...view };
}

/** Click "+ New agent key" once the card has loaded and the button is live. */
async function openNewKey() {
  await waitFor(() => expect((screen.getByRole("button", { name: "+ New agent key" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "+ New agent key" }));
}

const btn = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("AgentKeysSection for Kyle", () => {
  it("has the Agent keys heading, the Running strip and the table with every column's content", async () => {
    show(data({
      keys: [key({
        scopes: ["hub:read", "hub:draft"], hubThreadKinds: ["training"], lastUsedAt: "2026-11-21T15:02:00-06:00", lastUsedTool: "get_lead",
        expiresAt: "2099-01-31T23:59:00-06:00",
      })],
    }));
    expect(screen.getByRole("heading", { name: "Agent keys" })).toBeTruthy();
    expect(await screen.findByText("Admin Agent")).toBeTruthy();
    expect(screen.getByTestId("agent-access-status").textContent).toBe("Agents: Running");
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("rce_live_AbC1…")).toBeTruthy();
    expect(screen.getByText("hub:draft")).toBeTruthy();
    expect(screen.getByTestId("agent-hub-chip").textContent).toBe("Training thread only");
    expect(screen.getByText(/Last used Nov 21, 3:02 PM · get_lead/)).toBeTruthy();
    expect(screen.getByText("Jan 31, 2099")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    for (const name of ["Edit", "Rotate key", "Revoke", "+ New agent key", "Pause writes", "Turn all agents off"]) {
      expect(btn(name).disabled, name).toBe(false);
    }
    expect(screen.queryByRole("button", { name: "Resume agents" })).toBeNull();
  });

  // W1 (2026-11-22): the first write tool (POST /hub/messages) shipped, so the old "Write tools arrive in
  // Phase B" lock is gone; Allow writes is live for Kyle and greyed only with a real reason.
  it("Allow writes is LIVE for Kyle, and so is Activity (W2: it is no longer greyed with 'arrives with the Messages hub')", async () => {
    show(data());
    await screen.findByText("Admin Agent");
    const writes = screen.getByLabelText("Allow writes for Admin Agent") as HTMLInputElement;
    expect(writes.disabled).toBe(false);
    expect(writes.title).toBe("");
    expect(screen.queryByText("Write tools arrive in Phase B")).toBeNull();
    const activity = btn("Activity");
    expect(activity.disabled).toBe(false);
    expect(screen.queryByText(/arrives with the Messages hub/)).toBeNull();
  });

  it("shows a retiring key as 'Retiring until <time>' with 'Revoke now', and collapses revoked keys under 'Revoked keys (n)'", async () => {
    show(data({
      keys: [
        key({ id: "a", name: "Old", status: "retiring", retiresAt: "2026-11-22T10:00:00-06:00" }),
        key({ id: "b", name: "Gone one", status: "revoked", revokedAt: "2026-11-20T09:00:00-06:00", revokedReason: "leaked" }),
        key({ id: "c", name: "Gone two", status: "revoked", revokedAt: "2026-11-19T09:00:00-06:00" }),
      ],
    }));
    expect(await screen.findByText("Retiring until Nov 22, 10:00 AM")).toBeTruthy();
    expect(btn("Revoke now")).toBeTruthy();
    const rotate = btn("Rotate key"); // greyed with its reason, never hidden
    expect(rotate.disabled).toBe(true);
    expect(rotate.title).toBe("This key is already being replaced.");
    expect(screen.getByTestId("rotate-reason-a").textContent).toBe("This key is already being replaced.");
    const revoked = screen.getByTestId("agent-revoked-keys") as HTMLDetailsElement;
    expect(revoked.open).toBe(false);
    expect(within(revoked).getByText("Revoked keys (2)")).toBeTruthy();
    expect(within(revoked).getByText(/leaked/)).toBeTruthy();
  });

  it("has no delete anywhere: Revoke is the exit", async () => {
    show(data());
    await screen.findByText("Admin Agent");
    expect(screen.queryByRole("button", { name: /delete|remove/i })).toBeNull();
  });
});

describe("Allow writes (W1: agent writes switched on)", () => {
  it("ticking asks a plain confirm naming what it allows; Cancel changes nothing; OK sends writesEnabled true", async () => {
    const { update } = show(data());
    await screen.findByText("Admin Agent");
    const confirm = vi.spyOn(window, "confirm");
    confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByLabelText("Allow writes for Admin Agent"));
    // W2: team posts publish at once when that key's box is ticked. Changed deliberately (Kyle 2026-11-24, "requiring them to check-in on everything
    // defeats the purpose of the chat"): a customer email or text and a Training reply go out as soon as the key posts them - the old text said they waited.
    expect(confirm).toHaveBeenCalledWith(
      'Let "Admin Agent" post in Messages? Its posts in the Team, group and crew chats are published at once when "Team posts publish immediately" is ticked for it '
      + '(and wait for your Approve when it is not). Its emails and texts to customers, and its replies in a Training thread, go out as soon as it posts them: '
      + 'nobody approves them first. A text still stops for a customer who opted out or has not agreed to texts, and an email for an address that unsubscribed. '
      + 'While Agent access is paused or off, nothing an AI wrote is published or sent. A price book change it proposes still waits for your Approve.',
    );
    expect(update).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByLabelText("Allow writes for Admin Agent"));
    await waitFor(() => expect(update).toHaveBeenCalledWith("k1", { writesEnabled: true }));
  });

  it("unticking needs no confirm and sends writesEnabled false", async () => {
    const { update } = show(data({ keys: [key({ writesEnabled: true })] }));
    await screen.findByText("Admin Agent");
    const confirm = vi.spyOn(window, "confirm");
    fireEvent.click(screen.getByLabelText("Allow writes for Admin Agent"));
    await waitFor(() => expect(update).toHaveBeenCalledWith("k1", { writesEnabled: false }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("while the kill switch is read-only it is greyed with 'Agent access is read-only — writes are refused until it is On'", async () => {
    show(data({ agentAccess: access("read_only", "2026-11-21T15:02:00-06:00", "Kyle") }));
    await screen.findByText("Admin Agent");
    const writes = screen.getByLabelText("Allow writes for Admin Agent") as HTMLInputElement;
    expect(writes.disabled).toBe(true);
    expect(writes.title).toBe("Agent access is read-only — writes are refused until it is On");
    expect(screen.getByText("Agent access is read-only — writes are refused until it is On")).toBeTruthy();
  });

  it("while the kill switch is off it is greyed with 'Agent access is Off'", async () => {
    show(data({ agentAccess: access("off", "2026-11-21T15:02:00-06:00", "Kyle") }));
    await screen.findByText("Admin Agent");
    const writes = screen.getByLabelText("Allow writes for Admin Agent") as HTMLInputElement;
    expect(writes.disabled).toBe(true);
    expect(writes.title).toBe("Agent access is Off");
  });

  it("a key already ticked can still be unticked while the kill switch is not On (the safe way out)", async () => {
    const { update } = show(data({ agentAccess: access("off", null, "Kyle"), keys: [key({ writesEnabled: true })] }));
    await screen.findByText("Admin Agent");
    const writes = screen.getByLabelText("Allow writes for Admin Agent") as HTMLInputElement;
    expect(writes.disabled).toBe(false);
    fireEvent.click(writes);
    await waitFor(() => expect(update).toHaveBeenCalledWith("k1", { writesEnabled: false }));
  });

  it("a revoked key shows Allow writes greyed with its reason under 'Revoked keys', never hidden", async () => {
    show(data({ keys: [key({ id: "b", name: "Gone one", status: "revoked", writesEnabled: true, revokedAt: "2026-11-20T09:00:00-06:00" })] }));
    const revoked = await screen.findByTestId("agent-revoked-keys");
    const writes = within(revoked).getByLabelText("Allow writes for Gone one") as HTMLInputElement;
    expect(writes.disabled).toBe(true);
    expect(writes.title).toBe("This key is revoked — it can no longer write");
  });
});

describe("W2: the Messages scopes, Team posts publish immediately, and Activity", () => {
  it("the new-key form has a Messages group with Kyle's four words as labels and the description as helper text, in his order", async () => {
    show(data({ keys: [] }));
    await openNewKey();
    const messages = screen.getByText("Messages", { selector: "legend" }).closest("fieldset") as HTMLElement;
    const labels = within(messages).getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"));
    expect(labels).toEqual(["New key scope team:read", "New key scope team:reply", "New key scope hub:read", "New key scope hub:draft"]);
    for (const [word, helper] of [
      ["Read team", "Read the Team, group and job crew chats"], ["Post team", "Post in the Team, group and job crew chats"],
      ["Read customer", "Read customer conversations (and job crew chats) — not the Team or group chats"], ["Draft customer", "Email and text customers — a message goes out as soon as the agent posts it (no approval step)"],
    ]) {
      expect(within(messages).getByText(word)).toBeTruthy();
      expect(within(messages).getByText(helper)).toBeTruthy();
    }
    // The four boxes are not repeated under Read / Draft / Write.
    expect(screen.getAllByLabelText("New key scope team:reply")).toHaveLength(1);
    expect(screen.getAllByLabelText("New key scope hub:read")).toHaveLength(1);
  });

  it("Edit shows the same Messages group with the key's own ticks", async () => {
    show(data({ keys: [key({ scopes: ["team:read"] })] }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Admin Agent scope team:read") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Admin Agent scope team:reply") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("Read team")).toBeTruthy();
  });

  it("'Team posts publish immediately' sits beside Allow writes, and sends teamPostsPublish when it is changed", async () => {
    const { update } = show(data({ keys: [key({ writesEnabled: true })] }));
    await screen.findByText("Admin Agent");
    const box = screen.getByLabelText("Team posts publish immediately for Admin Agent") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    expect(screen.getByText("Team posts publish immediately")).toBeTruthy();
    fireEvent.click(box); // unticking needs no confirm
    await waitFor(() => expect(update).toHaveBeenCalledWith("k1", { teamPostsPublish: false }));
  });

  it("is greyed with its reason while writes are off, while Agent access is not On, and under Revoked keys; a ticked box can still be unticked", async () => {
    // Writes off (a new key's state), box OFF: cannot be ticked, with the reason.
    const off = show(data({ keys: [key({ writesEnabled: false, teamPostsPublish: false })] }));
    await screen.findByText("Admin Agent");
    const writesOff = screen.getByLabelText("Team posts publish immediately for Admin Agent") as HTMLInputElement;
    expect(writesOff.disabled).toBe(true);
    expect(writesOff.title).toBe("Allow writes is off for this key — it cannot post until that is ticked");
    expect(screen.getByTestId("publish-reason-k1").textContent).toBe("Allow writes is off for this key — it cannot post until that is ticked");
    expect(off.update).not.toHaveBeenCalled();
  });

  it("while Agent access is paused the box says nothing is published until it is On", async () => {
    show(data({ agentAccess: access("read_only", null, "Kyle"), keys: [key({ writesEnabled: true, teamPostsPublish: false })] }));
    await screen.findByText("Admin Agent");
    const box = screen.getByLabelText("Team posts publish immediately for Admin Agent") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.title).toBe("Agent access is not On — nothing an AI wrote is published until it is On");
  });

  it("a ticked box is never trapped: it can be unticked while writes are off or Agent access is off", async () => {
    const { update } = show(data({ agentAccess: access("off", null, "Kyle"), keys: [key({ writesEnabled: true, teamPostsPublish: true })] }));
    await screen.findByText("Admin Agent");
    const box = screen.getByLabelText("Team posts publish immediately for Admin Agent") as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(screen.getByTestId("publish-reason-k1")).toBeTruthy(); // the reason still shows beside it
    fireEvent.click(box);
    await waitFor(() => expect(update).toHaveBeenCalledWith("k1", { teamPostsPublish: false }));
  });

  it("a revoked key shows the box greyed with its reason under 'Revoked keys', never hidden", async () => {
    show(data({ keys: [key({ id: "b", name: "Gone one", status: "revoked", revokedAt: "2026-11-20T09:00:00-06:00" })] }));
    const revoked = await screen.findByTestId("agent-revoked-keys");
    const box = within(revoked).getByLabelText("Team posts publish immediately for Gone one") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.title).toBe("This key is revoked — it can no longer post");
  });

  it("Activity opens that key's calls newest first with the Chicago time, the key's name, the action, the endpoint and the result, and Close puts it away", async () => {
    show(data());
    const activity = vi.spyOn(api, "agentKeyActivity").mockResolvedValue({
      keyId: "k1", keyName: "Admin Agent",
      activity: [
        { id: "a2", at: "2026-11-23T09:15:00-06:00", keyName: "Admin Agent", action: "hub.messages.draft", endpoint: "POST /hub/messages", resultCode: "ok", status: 201 },
        { id: "a1", at: "2026-11-23T09:14:00-06:00", keyName: "Admin Agent", action: "hub.threads.list", endpoint: "GET /hub/threads", resultCode: "scope_denied", status: 403 },
      ],
    });
    await screen.findByText("Admin Agent");
    fireEvent.click(btn("Activity"));
    const panel = await screen.findByTestId("agent-activity-k1");
    expect(activity).toHaveBeenCalledWith("k1");
    const rows = await within(panel).findAllByRole("row");
    expect(rows).toHaveLength(3); // header + 2
    expect(rows[1].textContent).toContain("Nov 23, 9:15 AM");
    expect(rows[1].textContent).toContain("hub.messages.draft");
    expect(rows[1].textContent).toContain("POST /hub/messages");
    expect(rows[1].textContent).toContain("ok (201)");
    expect(rows[2].textContent).toContain("scope_denied (403)");
    expect(within(panel).getAllByText("Admin Agent").length).toBeGreaterThan(0);
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("agent-activity-k1")).toBeNull();
  });

  it("Activity for a key with no calls says so", async () => {
    show(data());
    vi.spyOn(api, "agentKeyActivity").mockResolvedValue({ keyId: "k1", keyName: "Admin Agent", activity: [] });
    await screen.findByText("Admin Agent");
    fireEvent.click(btn("Activity"));
    expect(await screen.findByTestId("agent-activity-empty")).toBeTruthy();
  });
});

describe("the pause switch", () => {
  it("Pause writes, Turn all agents off and Resume agents each confirm and call the ONE writer with the mode", async () => {
    const { mode } = show(data());
    await screen.findByText("Admin Agent");
    const confirm = vi.spyOn(window, "confirm");

    confirm.mockReturnValueOnce(false);
    fireEvent.click(btn("Pause writes"));
    expect(mode).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    fireEvent.click(btn("Pause writes"));
    await waitFor(() => expect(mode).toHaveBeenCalledWith("read_only"));
    await waitFor(() => expect(btn("Turn all agents off").disabled).toBe(false));

    confirm.mockReturnValueOnce(true);
    fireEvent.click(btn("Turn all agents off"));
    await waitFor(() => expect(mode).toHaveBeenCalledWith("off"));
  });

  it("while paused, a red banner names who and when, the strip says so, and Resume agents appears", async () => {
    const { mode } = show(data({ agentAccess: access("read_only", "2026-11-21T15:02:00-06:00", "Michael") }));
    await waitFor(() => expect(screen.getByTestId("agent-access-status").textContent).toBe("Writes paused"));
    expect(screen.getByTestId("agent-access-banner").textContent).toMatch(/Writes were paused by Michael on Nov 21, 3:02 PM/);
    expect(screen.queryByRole("button", { name: "Pause writes" })).toBeNull();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mode.mockResolvedValueOnce({ key: "agentAccess", value: access("on", "2026-11-21T16:00:00-06:00", "Kyle") });
    fireEvent.click(btn("Resume agents"));
    await waitFor(() => expect(mode).toHaveBeenCalledWith("on"));
  });

  it("all agents off reads 'All agents off' with its banner", async () => {
    show(data({ agentAccess: access("off", "2026-11-21T15:02:00-06:00", "Kyle") }));
    await waitFor(() => expect(screen.getByTestId("agent-access-status").textContent).toBe("All agents off"));
    expect(screen.getByTestId("agent-access-banner").textContent).toMatch(/switched off by Kyle/);
  });

  it("shows the server's refusal", async () => {
    const { mode } = show(data());
    await screen.findByText("Admin Agent");
    mode.mockRejectedValueOnce(new Error("Only Kyle can manage agent keys."));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(btn("Pause writes"));
    expect(await screen.findByText("Only Kyle can manage agent keys.")).toBeTruthy();
  });
});

describe("greyed with the reason, never hidden", () => {
  it("a session without bot_keys: every control greyed with the shared reason on the card, and nothing is loaded", async () => {
    const { load } = show(data(), OWNER_NO_GRANT);
    const note = await screen.findByTestId("agent-keys-locked");
    expect(note.textContent).toBe(CRM_POWERS.bot_keys.reason);
    for (const name of ["+ New agent key", "Pause writes", "Turn all agents off"]) {
      expect(btn(name).disabled, name).toBe(true);
      expect(btn(name).title, name).toBe(CRM_POWERS.bot_keys.reason);
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("the AI admin: the card shows, every control greyed with 'Only Kyle can view or change agent keys.'", async () => {
    const { load } = show(data(), AI_ADMIN_SESSION);
    expect((await screen.findByTestId("agent-keys-locked")).textContent).toBe(AGENT_KEYS_AI_ADMIN_REASON);
    expect(AGENT_KEYS_AI_ADMIN_REASON).toBe("Only Kyle can view or change agent keys.");
    expect(btn("+ New agent key").disabled).toBe(true);
    expect(btn("Pause writes").disabled).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it("a person Kyle granted bot_keys to is enabled like Kyle", async () => {
    show(data(), ownerWith("bot_keys"));
    await screen.findByText("Admin Agent");
    expect(screen.queryByTestId("agent-keys-locked")).toBeNull();
    expect(btn("+ New agent key").disabled).toBe(false);
    expect(btn("Edit").disabled).toBe(false);
  });

  it("with AGENT_KEY_PEPPER unset, + New agent key is greyed with 'Set AGENT_KEY_PEPPER in Railway first.'", async () => {
    show(data({ pepperConfigured: false }));
    await screen.findByText("Admin Agent");
    expect(btn("+ New agent key").disabled).toBe(true);
    expect(btn("+ New agent key").title).toBe("Set AGENT_KEY_PEPPER in Railway first.");
    expect(screen.getByTestId("agent-new-key-reason").textContent).toBe("Set AGENT_KEY_PEPPER in Railway first.");
    expect(btn("Rotate key").disabled).toBe(true);
  });
});

describe("Rotate key on a key that cannot be rotated", () => {
  it("an expired key shows Rotate key greyed with the way back: Edit for a new expiry, or a new key", async () => {
    show(data({ keys: [key({ id: "e", name: "Old", status: "expired", expiresAt: "2026-11-20T23:59:00-06:00" })] }));
    await screen.findByText("Old");
    const rotate = btn("Rotate key");
    expect(rotate.disabled).toBe(true);
    const reason = "Only an active key can be rotated — use Edit to set a new expiry, or create a new key.";
    expect(rotate.title).toBe(reason);
    expect(screen.getByTestId("rotate-reason-e").textContent).toBe(reason);
  });

  it("a replaced (retired) key says the same, and an active key has no reason line", async () => {
    show(data({ keys: [key({ id: "r", name: "Retired one", status: "retired", retiresAt: "2026-11-20T10:00:00-06:00" }), key({ id: "ok", name: "Fine" })] }));
    await screen.findByText("Retired one");
    expect(screen.getByTestId("rotate-reason-r")).toBeTruthy();
    expect(screen.queryByTestId("rotate-reason-ok")).toBeNull();
  });
});

describe("editing an expired key", () => {
  const expired = key({ id: "e", name: "Old", status: "expired", expiresAt: "2026-11-20T23:59:00-06:00" });

  it("prefills the CHICAGO day (11-20), not the UTC day (11-21), and a plain rename does not resend the expiry", async () => {
    const { update } = show(data({ keys: [expired] }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Expires for Old") as HTMLInputElement).value).toBe("2026-11-20");
    fireEvent.change(screen.getByLabelText("Name for Old"), { target: { value: "Old renamed" } });
    fireEvent.click(btn("Save changes"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const [, sent] = update.mock.calls[0];
    expect(sent).toEqual({ name: "Old renamed", scopes: ["crm:read", "hub:read"], hubThreadKinds: [] });
    expect("expiresAt" in sent).toBe(false);
  });

  it("changing or clearing the date does send it", async () => {
    const { update } = show(data({ keys: [expired] }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Expires for Old"), { target: { value: "2099-01-31" } });
    fireEvent.click(btn("Save changes"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).toMatchObject({ expiresAt: "2099-01-31" });
  });
});

describe("no state is claimed before it is known", () => {
  const pending = <T,>() => new Promise<T>(() => undefined);

  it("while the keys load: 'Loading…', no 'Running', no 'No agent keys yet.', and the kill switch and New key are greyed", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "agentKeys").mockReturnValue(pending<AgentKeysData>());
    renderWithProviders(<AgentKeysSection />);
    await waitFor(() => expect(screen.getByTestId("agent-access-status").textContent).toBe("Loading…"));
    expect(screen.queryByText("Agents: Running")).toBeNull();
    expect(screen.queryByText("No agent keys yet.")).toBeNull();
    for (const name of ["Pause writes", "Turn all agents off", "Resume agents", "+ New agent key"]) {
      expect(btn(name).disabled, name).toBe(true);
    }
    expect(btn("Pause writes").title).toBe("Loading agent status…");
  });

  it("while the session loads: the same, and nothing is requested yet", async () => {
    vi.spyOn(api, "session").mockReturnValue(pending());
    const load = vi.spyOn(api, "agentKeys").mockResolvedValue(data());
    renderWithProviders(<AgentKeysSection />);
    expect(screen.getByTestId("agent-access-status").textContent).toBe("Loading…");
    expect(screen.queryByText("Agents: Running")).toBeNull();
    expect(btn("Pause writes").disabled).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it("when the keys fail to load: a readable line with the reason, status unknown, buttons greyed, no empty table claim", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "agentKeys").mockRejectedValue(new Error("Database is down"));
    renderWithProviders(<AgentKeysSection />);
    expect((await screen.findByTestId("agent-keys-load-error")).textContent).toBe("Couldn't load agent keys — Database is down");
    expect(screen.getByTestId("agent-access-status").textContent).toBe("Agents: status unknown");
    expect(screen.queryByText("Agents: Running")).toBeNull();
    expect(screen.queryByText("No agent keys yet.")).toBeNull();
    expect(screen.getByText("Couldn't load agent keys.")).toBeTruthy();
    for (const name of ["Pause writes", "Turn all agents off", "Resume agents", "+ New agent key"]) {
      expect(btn(name).disabled, name).toBe(true);
    }
    expect(btn("Pause writes").title).toBe("Agent status could not be loaded.");
  });

  it("when the session cannot be read, the keys are still requested (the server decides) and the card does not hang on Loading", async () => {
    vi.spyOn(api, "session").mockRejectedValue(new Error("no session"));
    const load = vi.spyOn(api, "agentKeys").mockResolvedValue(data({ agentAccess: access("off", "2026-11-21T15:02:00-06:00", "Kyle") }));
    renderWithProviders(<AgentKeysSection />);
    await waitFor(() => expect(load).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("agent-access-status").textContent).toBe("All agents off"));
    expect(btn("Resume agents").disabled).toBe(false);
  });
});

describe("making a key", () => {
  // Kyle 2026-11-24: Settings > Agent keys shows "Read the price book" and "Add to the price book and propose changes" as two boxes (drawn from the one
  // scope table), ticked by role: Inventory both, every other agent but Other the read box only.
  it("shows the two price book boxes with their labels, ticked by role", async () => {
    show(data({ keys: [] }));
    await openNewKey();
    const agent = screen.getByLabelText("Agent") as HTMLSelectElement;
    const read = () => screen.getByLabelText("New key scope pricebook:read") as HTMLInputElement;
    const write = () => screen.getByLabelText("New key scope pricebook:write") as HTMLInputElement;
    expect(screen.getByText("Read the price book", { exact: false })).toBeTruthy();
    expect(screen.getByText("Add to the price book and propose changes", { exact: false })).toBeTruthy();
    expect([read().checked, write().checked]).toEqual([true, false]); // Admin
    fireEvent.change(agent, { target: { value: "inventory" } });
    expect([read().checked, write().checked]).toEqual([true, true]);
    fireEvent.change(agent, { target: { value: "research" } });
    expect([read().checked, write().checked]).toEqual([true, false]);
    fireEvent.change(agent, { target: { value: "other" } });
    expect([read().checked, write().checked]).toEqual([false, false]);
    fireEvent.click(write());
    expect(write().checked).toBe(true);
  });

  it("the Agent dropdown prefills scopes and the hub thread limit; Create key is greyed with a reason until there is a name", async () => {
    show(data({ keys: [] }));
    await openNewKey();
    const agent = screen.getByLabelText("Agent") as HTMLSelectElement;
    expect((screen.getByLabelText("New key scope crm:read") as HTMLInputElement).checked).toBe(true); // Admin default
    expect((screen.getByLabelText("New key scope training:write") as HTMLInputElement).checked).toBe(false);

    // W2 (Kyle 2026-11-23): Scout and Claude Code read and post in the Team chats and have no thread limit any more.
    fireEvent.change(agent, { target: { value: "scout" } });
    expect((screen.getByLabelText("New key scope training:write") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("New key scope team:read") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("New key scope team:reply") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("New key scope hub:read") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("New key scope hub:draft") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("New key scope crm:read") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("New key thread kind Training") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("New key thread kind Customer") as HTMLInputElement).checked).toBe(false);

    fireEvent.change(agent, { target: { value: "claude_code" } });
    expect((screen.getByLabelText("New key scope dev:write") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("New key scope team:reply") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("New key thread kind Dev") as HTMLInputElement).checked).toBe(false);

    // CFO is one of the agents, with its own defaults.
    expect(within(agent).getByRole("option", { name: "CFO" })).toBeTruthy();
    fireEvent.change(agent, { target: { value: "cfo" } });
    expect((screen.getByLabelText("New key scope finance:read") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("New key scope team:read") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("New key scope hub:draft") as HTMLInputElement).checked).toBe(false);

    expect(btn("Create key").disabled).toBe(true);
    expect(screen.getByTestId("agent-create-reason").textContent).toMatch(/name/);
  });

  it("Create key sends the name, role, ticked scopes, thread kinds and expiry, then shows the key once", async () => {
    const { create } = show(data({ keys: [] }));
    await openNewKey();
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "scout" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Scout key" } });
    fireEvent.click(screen.getByLabelText("New key scope team:reply")); // untick one
    fireEvent.change(screen.getByLabelText("Expires (optional)"), { target: { value: "2099-06-15" } });
    expect(btn("Create key").disabled).toBe(false);
    fireEvent.click(btn("Create key"));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const sent = create.mock.calls[0][0];
    expect(sent).toMatchObject({ name: "Scout key", agentRole: "scout", hubThreadKinds: [], expiresAt: "2099-06-15" });
    expect(sent.scopes).not.toContain("team:reply");
    expect(sent.scopes).toContain("team:read");
    expect(sent.scopes).toContain("training:write");

    const dialog = await screen.findByRole("dialog", { name: "New agent key" });
    expect(within(dialog).getByTestId("agent-key-secret").textContent).toMatch(/^rce_live_SECRET/);
    expect(within(dialog).getByText(/This is the only time the key is shown/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("the secret is never in the React Query cache, and it is gone when 'I've saved it' is clicked", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "agentKeys").mockResolvedValue(data({ keys: [] }));
    const SECRET = "rce_live_SECRETSECRETSECRETSECRETSECRETSECRETSECRE1";
    vi.spyOn(api, "createAgentKey").mockResolvedValue({ key: key({ id: "k9", name: "Fresh" }), secret: SECRET });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 }, mutations: { retry: false, gcTime: 60_000 } } });
    render(
      <QueryClientProvider client={client}><MemoryRouter><AgentKeysSection /></MemoryRouter></QueryClientProvider>,
    );
    await openNewKey();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fresh" } });
    fireEvent.click(btn("Create key"));
    await screen.findByTestId("agent-key-secret");

    const cache = JSON.stringify([
      client.getQueryCache().getAll().map((q) => q.state.data),
      client.getMutationCache().getAll().map((m) => [m.state.data, m.state.variables]),
    ]);
    expect(cache).not.toContain(SECRET);
    expect(cache).not.toContain("SECRETSECRET");

    fireEvent.click(btn("I've saved it"));
    expect(screen.queryByTestId("agent-key-secret")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain("SECRETSECRET");
  });

  it("the show-once dialog cannot be dismissed by Escape or a click outside (only 'I've saved it')", async () => {
    show(data({ keys: [] }));
    await openNewKey();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fresh" } });
    fireEvent.click(btn("Create key"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(dialog);
    expect(screen.getByTestId("agent-key-secret")).toBeTruthy();
  });

  it("shows the server's message when a create is refused", async () => {
    const { create } = show(data({ keys: [] }));
    create.mockRejectedValueOnce(new Error("Set AGENT_KEY_PEPPER in Railway first."));
    await openNewKey();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.click(btn("Create key"));
    expect(await screen.findByText("Set AGENT_KEY_PEPPER in Railway first.")).toBeTruthy();
    expect(screen.queryByTestId("agent-key-secret")).toBeNull();
  });
});

describe("row actions", () => {
  it("Rotate key confirms, calls the API and shows the new key once", async () => {
    const { rotate } = show(data());
    await screen.findByRole("button", { name: "Rotate key" });
    const confirm = vi.spyOn(window, "confirm");
    confirm.mockReturnValueOnce(false);
    fireEvent.click(btn("Rotate key"));
    expect(rotate).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    fireEvent.click(btn("Rotate key"));
    await waitFor(() => expect(rotate).toHaveBeenCalledWith("k1"));
    const dialog = await screen.findByRole("dialog", { name: "Rotated agent key" });
    expect(within(dialog).getByTestId("agent-key-secret").textContent).toMatch(/ROTATED/);
    fireEvent.click(within(dialog).getByRole("button", { name: "I've saved it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Revoke confirms first; cancelling does nothing, confirming calls the API", async () => {
    const { revoke } = show(data());
    await screen.findByText("Admin Agent");
    const confirm = vi.spyOn(window, "confirm");
    confirm.mockReturnValueOnce(false);
    fireEvent.click(btn("Revoke"));
    expect(revoke).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    fireEvent.click(btn("Revoke"));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("k1"));
    expect(await screen.findByText(/"Admin Agent" revoked\./)).toBeTruthy();
  });

  it("Edit opens the editor with the key's values and Save changes sends name, scopes, thread kinds and expiry", async () => {
    const { update } = show(data({ keys: [key({ scopes: ["hub:read"], hubThreadKinds: ["team"], expiresAt: "2099-01-31T23:59:00-06:00" })] }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Name for Admin Agent") as HTMLInputElement).value).toBe("Admin Agent");
    expect((screen.getByLabelText("Expires for Admin Agent") as HTMLInputElement).value).toBe("2099-01-31");
    expect((screen.getByLabelText("Admin Agent scope hub:read") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Admin Agent thread kind Team") as HTMLInputElement).checked).toBe(true);

    fireEvent.change(screen.getByLabelText("Name for Admin Agent"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByLabelText("Admin Agent scope crm:read"));
    fireEvent.click(screen.getByLabelText("Admin Agent thread kind Team")); // clear the limit
    fireEvent.change(screen.getByLabelText("Expires for Admin Agent"), { target: { value: "" } });
    fireEvent.click(btn("Save changes"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith("k1", { name: "Renamed", scopes: ["hub:read", "crm:read"], hubThreadKinds: [], expiresAt: null });
    expect(await screen.findByText(/applies on the key's next call/)).toBeTruthy();
  });
});
