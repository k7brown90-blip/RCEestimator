/**
 * Settings -> "Agent webhooks" (work order agent-team, TC4; Kyle only).
 *
 * Pinned: each agent row (Admin, Inventory) with its name, On/Off and its address, or "No address —
 * the agent will poll"; "Edit address" saves through the ONE owner-settings writer; "Turn off" and
 * "Remove address" (the exit, with a confirm); the event-type table with its defaults (Admin for
 * everything, Inventory for material.used) and a re-point that is stored only when it differs from the
 * default; and that every control is greyed with the reason for anyone but Kyle.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import {
  AgentWebhooksSection, ENV_ADDRESS_TEXT, ENV_REFUSED_TEXT, ENV_REMOVE_REASON, NO_ADDRESS_TEXT, WEBHOOKS_LOCK_REASON,
} from "./AgentWebhooksSection";
import { api } from "../lib/api";
import type { AgentWebhooksResponse, AgentWebhooksSave, AgentWebhooksValue } from "../lib/types";
import { AI_ADMIN_SESSION, OWNER_NO_GRANT, PIN_SESSION } from "../test/sessions";
import { HUB_EVENT_TYPES } from "../../../shared/hub/events";

afterEach(() => vi.restoreAllMocks());

const value = (over: Partial<AgentWebhooksValue> = {}): AgentWebhooksValue => ({
  targets: [{ id: "admin", url: null, enabled: true }, { id: "inventory", url: null, enabled: true }],
  routes: {}, ...over,
});

const NO_ENV = { urlSet: false, secretSet: true, adminEnvUrlSet: false, adminEnvUrlRefused: false };

/** What the server answers to a save: the same targets with each header's value masked (never echoed). */
const answer = (v: AgentWebhooksSave): AgentWebhooksResponse => ({
  key: "agentWebhooks",
  value: { ...v, targets: v.targets.map((t) => ({ ...t, headers: (t.headers ?? []).map((h) => ({ name: h.name, masked: h.value ? `••••${h.value.slice(-4)}` : "••••kept" })) })) },
  status: { pepperSet: true },
});

function show(initial: AgentWebhooksValue, session = PIN_SESSION, config = NO_ENV) {
  vi.spyOn(api, "session").mockResolvedValue(session);
  vi.spyOn(api, "hubEventsConfig").mockResolvedValue(config);
  vi.spyOn(api, "hubEvents").mockResolvedValue({ events: [], nextBefore: null });
  const load = vi.spyOn(api, "agentWebhooks").mockResolvedValue({ key: "agentWebhooks", value: initial, status: { pepperSet: true } });
  const save = vi.spyOn(api, "saveAgentWebhooks").mockImplementation(async (v) => answer(v));
  const view = renderWithProviders(<AgentWebhooksSection />);
  return { load, save, ...view };
}

const btn = (scope: HTMLElement, name: string | RegExp) => within(scope).getByRole("button", { name }) as HTMLButtonElement;

describe("AgentWebhooksSection for Kyle", () => {
  it("shows Admin and Inventory with 'No address — the agent will poll' and the table's defaults", async () => {
    show(value());
    expect(screen.getByRole("heading", { name: "Agent webhooks" })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("webhook-address-admin").textContent).toBe(NO_ADDRESS_TEXT));
    expect(NO_ADDRESS_TEXT).toBe("No address — the agent will poll");
    expect(screen.getByTestId("webhook-address-inventory").textContent).toBe(NO_ADDRESS_TEXT);
    for (const type of HUB_EVENT_TYPES) {
      const select = screen.getByLabelText(`Where ${type} goes`) as HTMLSelectElement;
      expect(select.value).toBe(type === "material.used" ? "inventory" : "admin");
    }
  });

  it("saves an address through the one owner-settings writer", async () => {
    const { save } = show(value());
    await screen.findByTestId("webhook-target-admin");
    await waitFor(() => expect(btn(screen.getByTestId("webhook-target-admin"), "Edit address").disabled).toBe(false));
    fireEvent.click(btn(screen.getByTestId("webhook-target-admin"), "Edit address"));
    fireEvent.change(screen.getByLabelText("Admin receiving address"), { target: { value: "https://agents.example.com/hook" } });
    fireEvent.click(screen.getByRole("button", { name: "Save address" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].targets).toEqual([
      { id: "admin", url: "https://agents.example.com/hook", enabled: true }, { id: "inventory", url: null, enabled: true },
    ]);
    await waitFor(() => expect(screen.getByTestId("webhook-address-admin").textContent).toBe("https://agents.example.com/hook"));
    expect(await screen.findByText("Admin address saved.")).toBeTruthy();
  });

  it("shows the server's refusal of a bad address in words", async () => {
    const { save } = show(value());
    save.mockRejectedValueOnce(new Error("A receiving address must start with https:// and name a host (no user name or password)."));
    await waitFor(() => expect(btn(screen.getByTestId("webhook-target-admin"), "Edit address").disabled).toBe(false));
    fireEvent.click(btn(screen.getByTestId("webhook-target-admin"), "Edit address"));
    fireEvent.change(screen.getByLabelText("Admin receiving address"), { target: { value: "https://x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save address" }));
    expect(await screen.findByText(/must start with https:\/\//)).toBeTruthy();
  });

  it("turns an agent off and on, and removes an address only after a confirm", async () => {
    const { save } = show(value({ targets: [{ id: "admin", url: "https://agents.example.com/hook", enabled: true }, { id: "inventory", url: null, enabled: true }] }));
    await waitFor(() => expect(screen.getByTestId("webhook-address-admin").textContent).toBe("https://agents.example.com/hook"));
    const admin = screen.getByTestId("webhook-target-admin");
    fireEvent.click(btn(admin, "Turn off"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].targets[0]).toEqual({ id: "admin", url: "https://agents.example.com/hook", enabled: false });
    await waitFor(() => expect(btn(screen.getByTestId("webhook-target-admin"), "Turn on")).toBeTruthy());

    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(btn(screen.getByTestId("webhook-target-admin"), "Remove address"));
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(btn(screen.getByTestId("webhook-target-admin"), "Remove address"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0].targets[0].url).toBeNull();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("greys Remove address when there is none, with the reason", async () => {
    show(value());
    await waitFor(() => expect(screen.getByTestId("webhook-address-admin").textContent).toBe(NO_ADDRESS_TEXT));
    const remove = btn(screen.getByTestId("webhook-target-admin"), "Remove address");
    expect(remove.disabled).toBe(true);
    expect(remove.title).toBe("There is no address to remove.");
  });

  it("stores a re-point only when it differs from the default, and drops it when set back", async () => {
    const { save } = show(value());
    await waitFor(() => expect((screen.getByLabelText("Where lead.created goes") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Where lead.created goes"), { target: { value: "inventory" } });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].routes).toEqual({ "lead.created": "inventory" });
    await waitFor(() => expect((screen.getByLabelText("Where lead.created goes") as HTMLSelectElement).value).toBe("inventory"));
    fireEvent.change(screen.getByLabelText("Where lead.created goes"), { target: { value: "admin" } });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0].routes).toEqual({});
  });
});

describe("AgentWebhooksSection when Admin's address comes from Railway (HUB_AGENT_WEBHOOK_URL)", () => {
  it("says so instead of 'No address', and greys Remove address with the reason (there is nothing saved to remove)", async () => {
    show(value(), PIN_SESSION, { ...NO_ENV, urlSet: true, adminEnvUrlSet: true });
    await waitFor(() => expect(screen.getByTestId("webhook-address-admin").textContent).toBe(ENV_ADDRESS_TEXT));
    expect(ENV_ADDRESS_TEXT).toBe("Using HUB_AGENT_WEBHOOK_URL from Railway");
    expect(screen.queryByText(NO_ADDRESS_TEXT, { selector: "[data-testid='webhook-address-admin']" })).toBeNull();
    // Inventory has no Railway fallback: it still reads "No address".
    expect(screen.getByTestId("webhook-address-inventory").textContent).toBe(NO_ADDRESS_TEXT);
    const remove = btn(screen.getByTestId("webhook-target-admin"), "Remove address");
    expect(remove.disabled).toBe(true);
    expect(remove.title).toBe(ENV_REMOVE_REASON);
    expect(ENV_REMOVE_REASON).toBe("This address comes from HUB_AGENT_WEBHOOK_URL in Railway — remove it there, or press Turn off to stop sending.");
    // The Turn off the reason points at is live.
    expect(btn(screen.getByTestId("webhook-target-admin"), "Turn off").disabled).toBe(false);
    expect(screen.getByText(/Admin uses\s+HUB_AGENT_WEBHOOK_URL from Railway when no address is saved here/)).toBeTruthy();
  });

  it("with an address also saved, the Remove confirm says the Railway address takes over", async () => {
    const { save } = show(
      value({ targets: [{ id: "admin", url: "https://agents.example.com/hook", enabled: true }, { id: "inventory", url: null, enabled: true }] }),
      PIN_SESSION, { ...NO_ENV, urlSet: true, adminEnvUrlSet: true },
    );
    await waitFor(() => expect(screen.getByTestId("webhook-address-admin").textContent).toBe("https://agents.example.com/hook"));
    await waitFor(() => expect(btn(screen.getByTestId("webhook-target-admin"), "Remove address").disabled).toBe(false));
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    fireEvent.click(btn(screen.getByTestId("webhook-target-admin"), "Remove address"));
    expect(confirm.mock.calls[0][0]).toBe(
      "Remove Admin's receiving address? Admin's events will go to the Railway address (HUB_AGENT_WEBHOOK_URL) instead. Use Turn off to stop them.",
    );
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it("says when the Railway variable is not an allowed address and so is ignored", async () => {
    show(value(), PIN_SESSION, { ...NO_ENV, adminEnvUrlRefused: true });
    await waitFor(() => expect(screen.getByTestId("webhook-address-admin").textContent).toBe(ENV_REFUSED_TEXT));
  });
});

describe("AgentWebhooksSection greys out for anyone but Kyle", () => {
  it.each([["a login without his rights", OWNER_NO_GRANT], ["the AI admin", AI_ADMIN_SESSION]])("%s sees the reason and every control greyed, and nothing is loaded", async (_label, session) => {
    const { load } = show(value(), session);
    expect((await screen.findByTestId("agent-webhooks-locked")).textContent).toBe(WEBHOOKS_LOCK_REASON);
    for (const id of ["admin", "inventory"]) {
      const row = screen.getByTestId(`webhook-target-${id}`);
      expect(btn(row, "Edit address").disabled).toBe(true);
      expect(btn(row, "Turn off").disabled).toBe(true);
      expect(btn(row, "Remove address").disabled).toBe(true);
      expect(screen.getByTestId(`webhook-address-${id}`).textContent).toBe("");
    }
    expect((screen.getByLabelText("Where lead.created goes") as HTMLSelectElement).disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(load).not.toHaveBeenCalled();
  });
});

// ── work order C6b: custom headers, signing secret, test event, delivery log ──────────────────────

type T = NonNullable<AgentWebhooksValue["targets"]>[number];
const target = (id: "admin" | "inventory", over: Partial<T> = {}): T => ({ id, url: null, enabled: true, headers: [], signingSecret: null, secretSource: id === "admin" ? "env" : "none", ...over });
const full = (admin: Partial<T> = {}, inventory: Partial<T> = {}): AgentWebhooksValue => ({ targets: [target("admin", admin), target("inventory", inventory)], routes: {} });
const row = (id: string) => screen.getByTestId(`webhook-target-${id}`);
const ready = async () => { await waitFor(() => expect(btn(row("admin"), "Edit address").disabled).toBe(false)); };

describe("AgentWebhooksSection signing secret", () => {
  it("says which secret is in use for each agent", async () => {
    show(full({}, {}));
    await waitFor(() => expect(screen.getByTestId("webhook-secret-status-admin").textContent).toBe("Using HUB_WEBHOOK_SECRET from Railway"));
    expect(screen.getByTestId("webhook-secret-status-inventory").textContent).toBe("No signing secret — events are kept, not sent");
    expect(btn(row("admin"), "Generate signing secret")).toBeTruthy();
  });

  it("shows 'Own secret ••••abcd' with Regenerate and Remove signing secret when the agent has its own", async () => {
    show(full({ secretSource: "own", signingSecret: { masked: "••••abcd", createdAt: "2026-11-22T10:00:00Z" } }));
    await waitFor(() => expect(screen.getByTestId("webhook-secret-status-admin").textContent).toBe("Own secret ••••abcd"));
    expect(btn(row("admin"), "Regenerate")).toBeTruthy();
    expect(btn(row("admin"), "Remove signing secret")).toBeTruthy();
    expect(within(row("admin")).queryByRole("button", { name: "Generate signing secret" })).toBeNull();
  });

  it("Generate signing secret shows the new secret ONCE with Copy, and it is gone after 'I've saved it'", async () => {
    show(full());
    const gen = vi.spyOn(api, "generateWebhookSecret").mockResolvedValue({ secret: "SECRET-SHOWN-ONCE-0123456789abcdefghijklmnop", masked: "••••mnop", replaced: false });
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    await ready();
    fireEvent.click(btn(row("inventory"), "Generate signing secret"));
    await waitFor(() => expect(gen).toHaveBeenCalledWith("inventory"));
    expect((await screen.findByTestId("webhook-secret-value-inventory")).textContent).toBe("SECRET-SHOWN-ONCE-0123456789abcdefghijklmnop");
    expect(screen.getByText(/only time the secret is shown/)).toBeTruthy();
    fireEvent.click(btn(row("inventory"), "Copy"));
    await waitFor(() => expect(write).toHaveBeenCalledWith("SECRET-SHOWN-ONCE-0123456789abcdefghijklmnop"));
    fireEvent.click(btn(row("inventory"), "I've saved it"));
    expect(screen.queryByTestId("webhook-secret-value-inventory")).toBeNull();
    expect(document.body.textContent).not.toContain("SECRET-SHOWN-ONCE");
  });

  it("Generate on Admin while it signs with HUB_WEBHOOK_SECRET asks the Regenerate question first; Cancel does nothing, OK generates", async () => {
    show(full());
    const gen = vi.spyOn(api, "generateWebhookSecret").mockResolvedValue({ secret: "ADMIN-ENV-REPLACED-0123456789abcdefghijklmn", masked: "••••klmn", replaced: false });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await ready();
    fireEvent.click(btn(row("admin"), "Generate signing secret"));
    expect(gen).not.toHaveBeenCalled();
    fireEvent.click(btn(row("admin"), "Generate signing secret"));
    await waitFor(() => expect(gen).toHaveBeenCalledWith("admin"));
    expect(confirm.mock.calls[0][0]).toBe("Regenerate the signing secret? The agents' receiver will reject events until it has the new one.");
  });

  it("a first Generate with no secret at all (Inventory) asks nothing", async () => {
    show(full());
    const gen = vi.spyOn(api, "generateWebhookSecret").mockResolvedValue({ secret: "INV-FIRST-0123456789abcdefghijklmnopqrstuvw", masked: "••••tuvw", replaced: false });
    const confirm = vi.spyOn(window, "confirm");
    await ready();
    fireEvent.click(btn(row("inventory"), "Generate signing secret"));
    await waitFor(() => expect(gen).toHaveBeenCalledWith("inventory"));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps each agent's one-time secret: generating Inventory's does not discard Admin's unsaved one", async () => {
    show(full());
    const gen = vi.spyOn(api, "generateWebhookSecret").mockImplementation(async (id) => ({ secret: `SECRET-FOR-${id}-0123456789abcdefghijklmnop`, masked: "••••mnop", replaced: false }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await ready();
    fireEvent.click(btn(row("admin"), "Generate signing secret"));
    expect((await screen.findByTestId("webhook-secret-value-admin")).textContent).toContain("SECRET-FOR-admin");
    fireEvent.click(btn(row("inventory"), "Generate signing secret"));
    expect((await screen.findByTestId("webhook-secret-value-inventory")).textContent).toContain("SECRET-FOR-inventory");
    expect(gen).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("webhook-secret-value-admin").textContent).toContain("SECRET-FOR-admin");
    // "I've saved it" drops only that agent's.
    fireEvent.click(btn(row("admin"), "I've saved it"));
    expect(screen.queryByTestId("webhook-secret-value-admin")).toBeNull();
    expect(screen.getByTestId("webhook-secret-value-inventory")).toBeTruthy();
  });

  it("Regenerate asks the exact question, and does nothing on Cancel", async () => {
    show(full({ secretSource: "own", signingSecret: { masked: "••••abcd", createdAt: "x" } }));
    const gen = vi.spyOn(api, "generateWebhookSecret").mockResolvedValue({ secret: "NEW-SECRET-0123456789abcdefghijklmnopqrstuv", masked: "••••stuv", replaced: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await waitFor(() => expect(btn(row("admin"), "Regenerate").disabled).toBe(false));
    fireEvent.click(btn(row("admin"), "Regenerate"));
    expect(gen).not.toHaveBeenCalled();
    fireEvent.click(btn(row("admin"), "Regenerate"));
    await waitFor(() => expect(gen).toHaveBeenCalledWith("admin"));
    expect(confirm.mock.calls[0][0]).toBe("Regenerate the signing secret? The agents' receiver will reject events until it has the new one.");
    expect((await screen.findByTestId("webhook-secret-value-admin")).textContent).toContain("NEW-SECRET");
  });

  it("Remove signing secret (the exit) asks first, then calls the remove route", async () => {
    show(full({ secretSource: "own", signingSecret: { masked: "••••abcd", createdAt: "x" } }));
    const rm = vi.spyOn(api, "removeWebhookSecret").mockResolvedValue({ removed: true });
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    await waitFor(() => expect(btn(row("admin"), "Remove signing secret").disabled).toBe(false));
    fireEvent.click(btn(row("admin"), "Remove signing secret"));
    await waitFor(() => expect(rm).toHaveBeenCalledWith("admin"));
  });
});

describe("AgentWebhooksSection custom headers", () => {
  it("greys the controls that store a secret, with the reason, when AGENT_KEY_PEPPER is not set", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "hubEventsConfig").mockResolvedValue(NO_ENV);
    vi.spyOn(api, "hubEvents").mockResolvedValue({ events: [], nextBefore: null });
    vi.spyOn(api, "agentWebhooks").mockResolvedValue({ key: "agentWebhooks", value: full({}, { headers: [{ name: "Authorization", masked: "••••abcd" }] }), status: { pepperSet: false } });
    renderWithProviders(<AgentWebhooksSection />);
    expect((await screen.findByTestId("agent-webhooks-no-pepper")).textContent).toContain("Set AGENT_KEY_PEPPER in Railway first.");
    await waitFor(() => expect(screen.getByTestId("webhook-secret-status-admin").textContent).not.toBe(""));
    for (const id of ["admin", "inventory"]) {
      const b = btn(row(id), "Generate signing secret");
      expect(b.disabled).toBe(true);
      expect(b.title).toBe("Set AGENT_KEY_PEPPER in Railway first.");
    }
    expect((screen.getByLabelText("Add header to Admin") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Edit value of Authorization on Inventory") as HTMLButtonElement).title).toBe("Set AGENT_KEY_PEPPER in Railway first.");
    // Removing needs no encryption, so it stays live.
    expect((screen.getByLabelText("Remove header Authorization from Inventory") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Add header sends only that agent's header list, then shows the name and •••• + last four, never the value", async () => {
    const { save } = show(full());
    await ready();
    fireEvent.click(screen.getByLabelText("Add header to Admin"));
    fireEvent.change(screen.getByLabelText("Admin header name"), { target: { value: "Authorization" } });
    fireEvent.change(screen.getByLabelText("Admin header value"), { target: { value: "Bearer sk-live-0123456789WXYZ" } });
    fireEvent.click(screen.getByRole("button", { name: "Save header" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].targets).toEqual([
      { id: "admin", url: null, enabled: true, headers: [{ name: "Authorization", value: "Bearer sk-live-0123456789WXYZ" }] },
      { id: "inventory", url: null, enabled: true },
    ]);
    await waitFor(() => expect(screen.getByTestId("webhook-header-masked-admin-Authorization").textContent).toBe("••••WXYZ"));
    expect(document.body.textContent).not.toContain("sk-live");
    expect(await screen.findByText("Authorization header saved on Admin.")).toBeTruthy();
  });

  it("says why before saving when the name is reserved or the value has a character a header cannot carry", async () => {
    const { save } = show(full());
    await ready();
    fireEvent.click(screen.getByLabelText("Add header to Admin"));
    fireEvent.change(screen.getByLabelText("Admin header name"), { target: { value: "X-RCE-Signature" } });
    fireEvent.change(screen.getByLabelText("Admin header value"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save header" }));
    expect((await screen.findByTestId("webhook-header-error-admin")).textContent).toMatch(/set by the CRM itself/);
    fireEvent.change(screen.getByLabelText("Admin header name"), { target: { value: "Authorization" } });
    fireEvent.change(screen.getByLabelText("Admin header value"), { target: { value: "café" } });
    fireEvent.click(screen.getByRole("button", { name: "Save header" }));
    await waitFor(() => expect(screen.getByTestId("webhook-header-error-admin").textContent).toMatch(/printable/));
    expect(save).not.toHaveBeenCalled();
  });

  it("Edit value re-enters one value and keeps the others; Remove header drops one after a confirm", async () => {
    const two = [{ name: "Authorization", masked: "••••abcd" }, { name: "X-Api-Key", masked: "••••9999" }];
    const { save } = show(full({ headers: two }));
    await ready();
    fireEvent.click(screen.getByLabelText("Edit value of Authorization on Admin"));
    fireEvent.change(screen.getByLabelText("New value for Authorization on Admin"), { target: { value: "Bearer fresh-value-ZZZZ" } });
    fireEvent.click(screen.getByRole("button", { name: "Save value" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].targets[0].headers).toEqual([{ name: "Authorization", value: "Bearer fresh-value-ZZZZ" }, { name: "X-Api-Key" }]);

    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await waitFor(() => expect((screen.getByLabelText("Remove header X-Api-Key from Admin") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText("Remove header X-Api-Key from Admin"));
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Remove header X-Api-Key from Admin"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0].targets[0].headers).toEqual([{ name: "Authorization" }]);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("greys Add header at five, with the reason", async () => {
    const five = ["A-1", "A-2", "A-3", "A-4", "A-5"].map((name) => ({ name, masked: "••••1111" }));
    show(full({ headers: five }));
    await waitFor(() => expect((screen.getByLabelText("Add header to Admin") as HTMLButtonElement).title).toBe("At most 5 custom headers per agent — remove one first."));
    expect((screen.getByLabelText("Add header to Admin") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("AgentWebhooksSection Send test event", () => {
  it("is greyed with the reason when there is no address, the agent is Off, or there is no signing secret", async () => {
    show(full({ url: null }, { url: "https://inv.example.com/h", secretSource: "none" }));
    await waitFor(() => expect(screen.getByTestId("webhook-test-reason-admin").textContent).toBe("Set a receiving address first."));
    expect((screen.getByLabelText("Send test event to Admin") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("webhook-test-reason-inventory").textContent).toBe("Generate a signing secret first.");
    expect((screen.getByLabelText("Send test event to Inventory") as HTMLButtonElement).disabled).toBe(true);
  });

  it("is greyed with the pepper reason when delivery would have to decrypt (own secret or a header) and AGENT_KEY_PEPPER is unset, but not for an env-secret Admin with no headers", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "hubEventsConfig").mockResolvedValue(NO_ENV);
    vi.spyOn(api, "hubEvents").mockResolvedValue({ events: [], nextBefore: null });
    vi.spyOn(api, "agentWebhooks").mockResolvedValue({
      key: "agentWebhooks",
      value: full(
        { url: "https://agents.example.com/hook" },
        { url: "https://inv.example.com/h", secretSource: "own", signingSecret: { masked: "••••abcd", createdAt: "x" } },
      ),
      status: { pepperSet: false },
    });
    renderWithProviders(<AgentWebhooksSection />);
    await waitFor(() => expect(screen.getByTestId("webhook-test-reason-inventory").textContent).toBe("Set AGENT_KEY_PEPPER in Railway first."));
    expect((screen.getByLabelText("Send test event to Inventory") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Send test event to Admin") as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends one test and shows the HTTP status and response time on the card", async () => {
    show(full({ url: "https://agents.example.com/hook" }));
    const test = vi.spyOn(api, "sendWebhookTest").mockResolvedValue({
      event: { id: "t1", type: "test.ping", createdAt: "2026-11-22T10:00:00-06:00", summary: "Test event (ids only)", status: "delivered", target: "admin", attempts: 1, lastError: null, lastStatusCode: 200, nextAttemptAt: null, deliveredAt: "2026-11-22T10:00:00-06:00", attemptLog: [] },
      statusCode: 200, ms: 143, error: null,
    });
    await waitFor(() => expect((screen.getByLabelText("Send test event to Admin") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText("Send test event to Admin"));
    await waitFor(() => expect(test).toHaveBeenCalledWith("admin"));
    expect((await screen.findByTestId("webhook-test-result-admin")).textContent).toBe("Test delivered — HTTP 200 in 143 ms.");
  });

  it("shows the status, time and error when the receiver refuses, and the reason when the server will not send", async () => {
    show(full({ url: "https://agents.example.com/hook" }));
    const test = vi.spyOn(api, "sendWebhookTest").mockResolvedValueOnce({
      event: { id: "t2", type: "test.ping", createdAt: "2026-11-22T10:00:00-06:00", summary: "", status: "dead", target: "admin", attempts: 1, lastError: "x", lastStatusCode: 401, nextAttemptAt: null, deliveredAt: null, attemptLog: [] },
      statusCode: 401, ms: 88, error: "Receiver refused (HTTP 401) — not retried",
    }).mockRejectedValueOnce(new Error("Admin is turned Off - turn it on first."));
    await waitFor(() => expect((screen.getByLabelText("Send test event to Admin") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText("Send test event to Admin"));
    expect((await screen.findByTestId("webhook-test-result-admin")).textContent).toBe("Test failed — HTTP 401 in 88 ms. Receiver refused (HTTP 401) — not retried.");
    fireEvent.click(screen.getByLabelText("Send test event to Admin"));
    await waitFor(() => expect(screen.getByTestId("webhook-test-result-admin").textContent).toBe("Test not sent — Admin is turned Off - turn it on first."));
    expect(test).toHaveBeenCalledTimes(2);
  });
});

describe("AgentWebhooksSection delivery log per webhook", () => {
  it("shows each agent's newest events from the Agent events log, filtered to it, with Show attempts and Resend", async () => {
    const ev = { id: "11111111-aaaa", type: "lead.created", createdAt: "2026-11-22T09:00:00-06:00", summary: "New lead from web", status: "dead", target: "admin", attempts: 3, lastError: "Receiver answered HTTP 500", lastStatusCode: 500, nextAttemptAt: null, deliveredAt: null, attemptLog: [] };
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "hubEventsConfig").mockResolvedValue(NO_ENV);
    const list = vi.spyOn(api, "hubEvents").mockImplementation(async (f) => ({ events: f?.target === "admin" ? [ev] : [], nextBefore: null }));
    vi.spyOn(api, "agentWebhooks").mockResolvedValue({ key: "agentWebhooks", value: full(), status: { pepperSet: true } });
    renderWithProviders(<AgentWebhooksSection />);
    const log = await screen.findByTestId("webhook-log-admin");
    await waitFor(() => expect(within(log).getByText("New lead from web")).toBeTruthy());
    expect(list).toHaveBeenCalledWith({ status: "all", type: "", target: "admin", limit: 5 });
    expect(list).toHaveBeenCalledWith({ status: "all", type: "", target: "inventory", limit: 5 });
    const r = within(screen.getByTestId("agent-event-11111111-aaaa"));
    expect(r.getByText("11111111-aaaa")).toBeTruthy();
    expect(r.getByTestId("last-code-11111111-aaaa").textContent).toBe("500");
    expect(r.getByText("Dead — gave up")).toBeTruthy();
    expect(r.getByRole("button", { name: "Show attempts" })).toBeTruthy();
    expect((r.getByRole("button", { name: "Resend lead.created" }) as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(within(screen.getByTestId("webhook-log-inventory")).getByText("No events sent to Inventory yet.")).toBeTruthy());
  });
});

describe("AgentWebhooksSection new controls are greyed for anyone but Kyle", () => {
  it("greys Generate, Add header and Send test event with the reason", async () => {
    show(full(), OWNER_NO_GRANT);
    await screen.findByTestId("agent-webhooks-locked");
    for (const id of ["admin", "inventory"]) {
      expect(btn(row(id), "Generate signing secret").disabled).toBe(true);
      expect(btn(row(id), "Generate signing secret").title).toBe(WEBHOOKS_LOCK_REASON);
    }
    expect((screen.getByLabelText("Add header to Admin") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Send test event to Admin") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Send test event to Admin") as HTMLButtonElement).title).toBe(WEBHOOKS_LOCK_REASON);
  });
});
