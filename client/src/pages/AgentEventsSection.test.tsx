/**
 * Settings -> "Agent events" (work order agent-team, BA5).
 *
 * Pinned: the heading and the row's columns; the filter chips (All / Delivered / Retrying / Dead /
 * No URL) and the Event-type dropdown, which asks the server for the filtered list and lists
 * estimate.accepted; the no-address and no-secret banners with their exact words; "Resend" on every
 * row, GREYED with its reason on a Delivered row and live on Dead, Retrying and No URL rows; the
 * attempt history on "Show attempts"; every control greyed with the reason for a session without
 * bot_keys and for the AI admin; and that the screen never asks for or prints an address or secret.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { AgentEventsSection, NO_SECRET_BANNER, NO_URL_BANNER } from "./AgentEventsSection";
import { api } from "../lib/api";
import type { HubEventView } from "../lib/types";
import { AI_ADMIN_SESSION, OWNER_NO_GRANT, ownerWith, PIN_SESSION } from "../test/sessions";
import { AGENT_KEYS_AI_ADMIN_REASON } from "../../../shared/agentScopes";
import { CRM_POWERS } from "../../../shared/crmPowers";
import { HUB_EVENT_TYPES, RESEND_DELIVERED_REASON, TEST_RESEND_REASON } from "../../../shared/hub/events";

afterEach(() => vi.restoreAllMocks());

const ev = (over: Partial<HubEventView> = {}): HubEventView => ({
  id: "e1", type: "estimate.signed", createdAt: "2026-11-21T15:02:00-06:00", summary: "Estimate 2026-1042 rev 2 signed, $4,250",
  status: "delivered", target: "admin", attempts: 1, lastError: null, lastStatusCode: 200, nextAttemptAt: null,
  deliveredAt: "2026-11-21T15:02:01-06:00",
  attemptLog: [{ at: "2026-11-21T15:02:01-06:00", statusCode: 200, error: null, ms: 84 }], ...over,
});

const CONFIG = { urlSet: true, secretSet: true, adminEnvUrlSet: false, adminEnvUrlRefused: false };

function show(events: HubEventView[], config = CONFIG, session = PIN_SESSION) {
  vi.spyOn(api, "session").mockResolvedValue(session);
  const list = vi.spyOn(api, "hubEvents").mockResolvedValue({ events, nextBefore: null });
  const cfg = vi.spyOn(api, "hubEventsConfig").mockResolvedValue(config);
  const resend = vi.spyOn(api, "resendHubEvent").mockResolvedValue({ event: ev({ status: "delivered", attempts: 2 }) });
  const view = renderWithProviders(<AgentEventsSection />);
  return { list, cfg, resend, ...view };
}

const btn = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("AgentEventsSection for Kyle", () => {
  it("has the heading, the chips, the Event type dropdown and a row with every column", async () => {
    show([ev()]);
    expect(screen.getByRole("heading", { name: "Agent events" })).toBeTruthy();
    expect(await screen.findByText("Estimate 2026-1042 rev 2 signed, $4,250")).toBeTruthy();
    for (const chip of ["All", "Delivered", "Retrying", "Dead", "No URL"]) expect(btn(chip)).toBeTruthy();
    expect(btn("All").getAttribute("aria-pressed")).toBe("true");
    expect(within(screen.getByTestId("agent-event-e1")).getByText("estimate.signed")).toBeTruthy();
    expect(within(screen.getByTestId("agent-event-e1")).getByText("Delivered")).toBeTruthy();
    const select = screen.getByLabelText("Event type") as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).toContain("estimate.accepted");
    expect(values.filter(Boolean).sort()).toEqual([...HUB_EVENT_TYPES].sort());
  });

  it("asks the server for a status and an event type when the chip or dropdown changes", async () => {
    const { list } = show([ev()]);
    await screen.findByText(/Estimate 2026-1042/);
    fireEvent.click(btn("Dead"));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ status: "dead", type: "" }));
    fireEvent.click(btn("No URL"));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ status: "no_target", type: "" }));
    fireEvent.change(screen.getByLabelText("Event type"), { target: { value: "payment.received" } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ status: "no_target", type: "payment.received" }));
    expect(btn("No URL").getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the no-address banner with its exact words, and the no-secret banner, only when they apply", async () => {
    show([], { ...CONFIG, urlSet: false, secretSet: false });
    expect((await screen.findByTestId("agent-events-no-url")).textContent).toBe(NO_URL_BANNER);
    // W2-C: Admin is no longer the target of nearly everything (a Team message goes to every agent that can read it), so the banner is about Admin's own events.
    expect(NO_URL_BANNER).toBe("Admin has no receiving address, so its events (customer messages, leads, estimates, payments, jobs) are being kept. Add Admin's address in the Agent webhooks card below, then press Resend. Team messages go to every agent that has its own address.");
    expect(screen.getByTestId("agent-events-no-secret").textContent).toBe(NO_SECRET_BANNER);
    expect(NO_SECRET_BANNER).toBe("Admin has no signing secret — nothing is sent until it does. Generate one in the Agent webhooks card below, or set HUB_WEBHOOK_SECRET in Railway.");
  });

  it("shows neither banner when both are set", async () => {
    show([ev()]);
    await screen.findByText(/Estimate 2026-1042/);
    await waitFor(() => expect(screen.queryByTestId("agent-events-no-url")).toBeNull());
    expect(screen.queryByTestId("agent-events-no-secret")).toBeNull();
  });

  it("greys Resend on a Delivered row with its reason, and keeps it live on Dead, Retrying and No URL rows", async () => {
    show([
      ev({ id: "d1", status: "delivered" }),
      ev({ id: "x1", status: "dead", attempts: 1, lastStatusCode: 400, lastError: "Receiver refused (HTTP 400) — not retried", type: "payment.received", summary: "Payment $50 received by cash" }),
      ev({ id: "r1", status: "retrying", attempts: 2, nextAttemptAt: "2026-11-21T15:12:00-06:00", lastError: "Could not connect to the receiving address", type: "lead.created", summary: "New lead from web" }),
      ev({ id: "n1", status: "no_target", attempts: 0, lastError: "No receiving address is set", type: "job.completed", summary: "Job marked complete" }),
    ]);
    await screen.findByText("New lead from web");
    const row = (id: string) => within(screen.getByTestId(`agent-event-${id}`));
    const delivered = row("d1").getByRole("button", { name: "Resend estimate.signed" }) as HTMLButtonElement;
    expect(delivered.disabled).toBe(true);
    expect(row("d1").getByTestId("resend-reason-d1").textContent).toBe(RESEND_DELIVERED_REASON);
    for (const [id, type] of [["x1", "payment.received"], ["r1", "lead.created"], ["n1", "job.completed"]] as const) {
      expect((row(id).getByRole("button", { name: `Resend ${type}` }) as HTMLButtonElement).disabled).toBe(false);
    }
    expect(row("x1").getByText("Receiver refused (HTTP 400) — not retried")).toBeTruthy();
    expect(row("x1").getByText("Dead — gave up")).toBeTruthy();
    expect(row("n1").getByText("No URL — kept")).toBeTruthy();
    expect(row("r1").getByText(/Next try/)).toBeTruthy();
  });

  it("Resend calls the one route and refreshes the list", async () => {
    const { resend, list } = show([ev({ id: "x9", status: "dead", type: "lead.created", summary: "New lead from web" })]);
    await screen.findByText("New lead from web");
    const before = list.mock.calls.length;
    fireEvent.click(btn("Resend lead.created"));
    await waitFor(() => expect(resend).toHaveBeenCalledWith("x9"));
    expect(await screen.findByText("Delivered.")).toBeTruthy();
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before));
  });

  it.each([
    ["no secret, nothing sent", "pending", "HUB_WEBHOOK_SECRET not set", "Not delivered — HUB_WEBHOOK_SECRET not set."],
    ["the agent turned Off", "no_target", "This agent is turned Off", "Not delivered — This agent is turned Off."],
    ["a receiver that keeps answering 5xx", "dead", "Receiver answered HTTP 503 — gave up after 7 tries", "Not delivered — Receiver answered HTTP 503 — gave up after 7 tries."],
  ])("Resend says the server's real reason when it did not deliver: %s", async (_label, status, lastError, expected) => {
    const { resend } = show([ev({ id: "w1", status: "dead", type: "lead.created", summary: "New lead from web" })]);
    resend.mockResolvedValue({ event: ev({ id: "w1", status, lastError, attempts: 2 }) });
    await screen.findByText("New lead from web");
    fireEvent.click(btn("Resend lead.created"));
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(screen.queryByText("Delivered.")).toBeNull();
    expect(screen.queryByText(/Sent again; it will retry/)).toBeNull();
  });

  it("shows the attempt history when a row is expanded", async () => {
    show([ev({ id: "h1", status: "dead", attempts: 2, attemptLog: [
      { at: "2026-11-21T15:02:01-06:00", statusCode: 503, error: "Receiver answered HTTP 503", ms: 120 },
      { at: "2026-11-21T15:02:31-06:00", statusCode: null, error: "Timed out after 10 seconds", ms: 10000 },
    ] })]);
    await screen.findByText(/Estimate 2026-1042/);
    fireEvent.click(btn("Show attempts"));
    const list = within(screen.getByTestId("attempts-h1"));
    expect(list.getByText(/HTTP 503, 120 ms — Receiver answered HTTP 503/)).toBeTruthy();
    expect(list.getByText(/no answer, 10000 ms — Timed out after 10 seconds/)).toBeTruthy();
    fireEvent.click(btn("Hide attempts"));
    expect(screen.queryByTestId("attempts-h1")).toBeNull();
  });

  it("says so when there are no events, and never prints an address or a secret", async () => {
    show([]);
    await waitFor(() => expect(screen.getByTestId("agent-events-empty").textContent).toBe("No events yet."));
    expect(document.body.textContent ?? "").not.toMatch(/https?:\/\//);
  });
});

describe("AgentEventsSection greys out for a session that may not use it", () => {
  it("a login without bot_keys sees the reason and every control greyed, and the server is never asked", async () => {
    const { list, cfg } = show([], undefined, OWNER_NO_GRANT);
    expect((await screen.findByTestId("agent-events-locked")).textContent).toBe(CRM_POWERS.bot_keys.reason);
    for (const chip of ["All", "Delivered", "Retrying", "Dead", "No URL"]) expect(btn(chip).disabled).toBe(true);
    expect((screen.getByLabelText("Event type") as HTMLSelectElement).disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(list).not.toHaveBeenCalled();
    expect(cfg).not.toHaveBeenCalled();
  });

  it("the AI admin is told in the card's own words", async () => {
    show([], undefined, AI_ADMIN_SESSION);
    expect((await screen.findByTestId("agent-events-locked")).textContent).toBe(AGENT_KEYS_AI_ADMIN_REASON);
  });

  it("a login Kyle gave bot_keys can use it", async () => {
    show([ev()], undefined, ownerWith("bot_keys"));
    expect(await screen.findByText(/Estimate 2026-1042/)).toBeTruthy();
    expect(screen.queryByTestId("agent-events-locked")).toBeNull();
    expect(btn("Dead").disabled).toBe(false);
  });
});

describe("AgentEventsSection per-agent filter and test events (work order C6b)", () => {
  it("has an Agent dropdown that asks the server for one agent's events", async () => {
    const { list } = show([ev()]);
    await screen.findByText(/Estimate 2026-1042/);
    const agent = screen.getByLabelText("Agent") as HTMLSelectElement;
    expect([...agent.options].map((o) => o.value)).toEqual(["", "admin", "inventory", "facebook", "outreach", "scout", "research", "cfo", "nec_coach"]);
    fireEvent.change(agent, { target: { value: "inventory" } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ status: "all", type: "", target: "inventory" }));
    fireEvent.change(agent, { target: { value: "" } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ status: "all", type: "" }));
  });

  it("shows the event id and the last HTTP code, and greys Resend on a test event with the reason", async () => {
    show([ev({ id: "t-7", type: "test.ping", status: "dead", summary: "Test event (ids only)", lastStatusCode: 500, attempts: 1 })]);
    await screen.findByText("Test event (ids only)");
    const row = within(screen.getByTestId("agent-event-t-7"));
    expect(row.getByText("t-7")).toBeTruthy();
    expect(screen.getByTestId("last-code-t-7").textContent).toBe("500");
    expect((row.getByRole("button", { name: "Resend test.ping" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("resend-reason-t-7").textContent).toBe(TEST_RESEND_REASON);
  });
});
