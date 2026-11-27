/**
 * Settings -> "Agent webhooks" (work order agent-team, TC4; Kyle only).
 *
 * Pinned: each agent block (W2-C: Admin, Inventory, Facebook, Outreach, Scout, Research, CFO, NEC Coach) with its name, one line of
 * status and its address, or "No address — the agent will poll"; EVERY block starts folded on its agent row (Kyle, 2026-11-26: one shared fold, the same for every login) (the tests
 * below open every block first, through renderCard, except the ones that test the folding itself); "Edit address" saves through the ONE
 * owner-settings writer; "Turn off" and "Remove address" (the exit, with a confirm); the event-type table with its defaults (Admin for
 * everything, Inventory for material.used; message.team is NOT in it - the fan-out decides) and a re-point that is stored only when it
 * differs from the default; and that every control is greyed with the reason for anyone but Kyle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { openCards } from "../test/openCard";
import {
  AgentWebhooksSection, ENV_ADDRESS_TEXT, ENV_REFUSED_TEXT, ENV_REMOVE_REASON, NO_ADDRESS_TEXT, WEBHOOKS_LOCK_REASON,
} from "./AgentWebhooksSection";
import { api } from "../lib/api";
import type { AgentWebhooksResponse, AgentWebhooksSave, AgentWebhooksValue } from "../lib/types";
import { AI_ADMIN_SESSION, OWNER_NO_GRANT, PIN_SESSION } from "../test/sessions";
import { HUB_EVENT_TYPES, HUB_WEBHOOK_TARGET_IDS, HUB_WEBHOOK_TARGET_LABELS, WEBHOOK_VERIFY_RECIPE, isFanOutEventType } from "../../../shared/hub/events";

let watcher: MutationObserver | null = null;
beforeEach(() => { watcher = null; openCards("settings-agent-webhooks"); });
afterEach(() => { watcher?.disconnect(); vi.restoreAllMocks(); });

/**
 * Render the card. A block that is not set up starts FOLDED (the one shared fold, remembered per agent), so by default the test opens each one
 * as it appears, the way a person would click its row; pass autoOpen false to test the folding itself.
 */
function renderCard(autoOpen = true) {
  const view = renderWithProviders(<AgentWebhooksSection />);
  if (autoOpen) {
    const click = () => {
      for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-testid^='webhook-target-'] > h3 > button[aria-expanded=false]"))) fireEvent.click(b);
    };
    watcher = new MutationObserver(click);
    watcher.observe(document.body, { childList: true, subtree: true, attributes: true });
    click();
  }
  return view;
}

/** The six agents the card lists after Admin and Inventory, as the screen sends them when nothing about them changed. */
const OTHERS = HUB_WEBHOOK_TARGET_IDS.filter((id) => id !== "admin" && id !== "inventory");
const othersSaved = OTHERS.map((id) => ({ id, url: null, enabled: true }));
const othersView = OTHERS.map((id) => ({ id, url: null, enabled: true }));

const value = (over: Partial<AgentWebhooksValue> = {}): AgentWebhooksValue => ({
  targets: [{ id: "admin", url: null, enabled: true }, { id: "inventory", url: null, enabled: true }, ...othersView],
  routes: {}, ...over,
});

const NO_ENV = { urlSet: false, secretSet: true, adminEnvUrlSet: false, adminEnvUrlRefused: false };

/** What the server answers to a save: the same targets with each header's value masked (never echoed). */
const answer = (v: AgentWebhooksSave): AgentWebhooksResponse => ({
  key: "agentWebhooks",
  value: { ...v, targets: v.targets.map((t) => ({ ...t, headers: (t.headers ?? []).map((h) => ({ name: h.name, masked: h.value ? `••••${h.value.slice(-4)}` : "••••kept" })) })) },
  status: { pepperSet: true },
});

function show(initial: AgentWebhooksValue, session = PIN_SESSION, config = NO_ENV, autoOpen = true) {
  vi.spyOn(api, "session").mockResolvedValue(session);
  vi.spyOn(api, "hubEventsConfig").mockResolvedValue(config);
  vi.spyOn(api, "hubEvents").mockResolvedValue({ events: [], nextBefore: null });
  const load = vi.spyOn(api, "agentWebhooks").mockResolvedValue({ key: "agentWebhooks", value: initial, status: { pepperSet: true } });
  const save = vi.spyOn(api, "saveAgentWebhooks").mockImplementation(async (v) => answer(v));
  const view = renderCard(autoOpen);
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
    // Kyle 2026-11-24: the two pricebook.* events are fan-out too (every other key with pricebook:read), so they are not in the table either.
    for (const type of HUB_EVENT_TYPES.filter((t) => !isFanOutEventType(t))) {
      const select = screen.getByLabelText(`Where ${type} goes`) as HTMLSelectElement;
      expect(select.value).toBe(type === "material.used" ? "inventory" : "admin");
      // Every agent with a webhook can be pointed at, not only Admin and Inventory.
      expect(Array.from(select.options).map((o) => o.value)).toEqual([...HUB_WEBHOOK_TARGET_IDS]);
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
      { id: "admin", url: "https://agents.example.com/hook", enabled: true }, { id: "inventory", url: null, enabled: true }, ...othersSaved,
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
    // (Kyle, 2026-11-26, "one line each": the card's long intro that also said this is gone; the address line above says it for Admin.)
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
    renderCard();
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
      ...othersSaved,
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
    renderCard();
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
    renderCard();
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

// ── W2-C (Kyle 2026-11-23 item 4): a receiver for every agent ───────────────────────────────────────

describe("AgentWebhooksSection: one block per agent that can hear a team chat (W2-C)", () => {
  const LABELS = ["Admin", "Inventory", "Facebook", "Outreach", "Scout", "Research", "CFO", "NEC Coach"];

  it("shows eight blocks, in the card's order, and none for Claude Code or Other", async () => {
    show(value(), PIN_SESSION, NO_ENV, false);
    await screen.findByTestId("webhook-target-admin");
    expect([...HUB_WEBHOOK_TARGET_IDS]).toEqual(["admin", "inventory", "facebook", "outreach", "scout", "research", "cfo", "nec_coach"]);
    expect(HUB_WEBHOOK_TARGET_IDS.map((id) => HUB_WEBHOOK_TARGET_LABELS[id])).toEqual(LABELS);
    const blocks = Array.from(document.querySelectorAll("[data-testid^='webhook-target-']"));
    expect(blocks).toHaveLength(8);
    for (const id of HUB_WEBHOOK_TARGET_IDS) expect(screen.getByTestId(`webhook-target-${id}`)).toBeTruthy();
    expect(screen.queryByTestId("webhook-target-claude_code")).toBeNull();
    expect(screen.queryByTestId("webhook-target-other")).toBeNull();
  });

  it("says in each header, in one line, whether the agent is Not set up, On — signed, Off or has an address with no signing secret", async () => {
    const v = value({
      targets: [
        { id: "admin", url: "https://a.example.com/h", enabled: true, headers: [], signingSecret: null, secretSource: "env" },
        { id: "inventory", url: "https://i.example.com/h", enabled: true, headers: [], signingSecret: null, secretSource: "none" },
        { id: "facebook", url: "https://f.example.com/h", enabled: false, headers: [], signingSecret: { masked: "••••abcd", createdAt: "x" }, secretSource: "own" },
        { id: "outreach", url: null, enabled: true, headers: [], signingSecret: null, secretSource: "none" },
        { id: "scout", url: "https://s.example.com/h", enabled: true, headers: [], signingSecret: { masked: "••••abcd", createdAt: "x" }, secretSource: "own" },
        { id: "research", url: null, enabled: true }, { id: "cfo", url: null, enabled: true }, { id: "nec_coach", url: null, enabled: true },
      ],
    });
    show(v, PIN_SESSION, { ...NO_ENV, adminEnvUrlSet: false }, false);
    await waitFor(() => expect(screen.getByTestId("webhook-status-admin").textContent).toBe("On — signed"));
    const status = (id: string) => screen.getByTestId(`webhook-status-${id}`).textContent;
    expect(status("inventory")).toBe("Address set, no signing secret — nothing is sent");
    expect(status("facebook")).toBe("Off");
    expect(status("outreach")).toBe("Not set up");
    expect(status("scout")).toBe("On — signed");
    for (const id of ["research", "cfo", "nec_coach"]) expect(status(id)).toBe("Not set up");
  });

  // Kyle, 2026-11-26 ("Fold each webhook agent" / "All folded"): EVERY block starts folded, set up or not, the same for every login;
  // a click on the agent's row opens it and the choice is remembered. (Superseded: "a block that is set up starts open".)
  it("starts every block folded behind its agent row, set up or not, and a click on the row toggles either; the choice is remembered per agent", async () => {
    show(value({
      targets: [
        { id: "admin", url: "https://a.example.com/h", enabled: true, headers: [], signingSecret: null, secretSource: "env" },
        { id: "inventory", url: null, enabled: true }, { id: "facebook", url: null, enabled: true }, { id: "outreach", url: null, enabled: true },
        { id: "scout", url: null, enabled: true }, { id: "research", url: null, enabled: true }, { id: "cfo", url: null, enabled: true }, { id: "nec_coach", url: null, enabled: true },
      ],
    }), PIN_SESSION, NO_ENV, false);
    await waitFor(() => expect(screen.getByTestId("webhook-status-admin").textContent).toBe("On — signed"));
    // Admin is set up and CFO is not: BOTH start folded, with no controls until the row is clicked.
    expect(within(screen.getByTestId("webhook-target-admin")).queryByRole("button", { name: "Edit address" })).toBeNull();
    expect(screen.getByRole("button", { name: "Admin" })).toHaveAttribute("aria-expanded", "false");
    const cfo = screen.getByTestId("webhook-target-cfo");
    expect(within(cfo).queryByRole("button", { name: "Edit address" })).toBeNull();
    expect(screen.getByRole("button", { name: "CFO" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "CFO" }));
    expect(btn(screen.getByTestId("webhook-target-cfo"), "Edit address")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "CFO" }));
    expect(within(screen.getByTestId("webhook-target-cfo")).queryByRole("button", { name: "Edit address" })).toBeNull();
    // A configured block opens on a click, and what the person did is remembered for that agent.
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(btn(screen.getByTestId("webhook-target-admin"), "Edit address")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Admin" })).toHaveAttribute("aria-expanded", "true");
    expect(localStorage.getItem("rce.card.settings-webhook-admin")).toBe("1");
  });

  // Kyle, 2026-11-26 ("Fold each webhook agent"): the per-agent fold works the same for every login and is never forced open.
  it("a login that is not Kyle sees every agent block folded too, with the reason on the card", async () => {
    show(value(), OWNER_NO_GRANT, NO_ENV, false);
    expect((await screen.findByTestId("agent-webhooks-locked")).textContent).toBe(WEBHOOKS_LOCK_REASON);
    for (const id of HUB_WEBHOOK_TARGET_IDS) {
      expect(within(screen.getByTestId(`webhook-target-${id}`)).queryByRole("button", { name: "Edit address" })).toBeNull();
    }
    // Opening one shows its controls greyed.
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(btn(screen.getByTestId("webhook-target-admin"), "Edit address").disabled).toBe(true);
  });

  // Kyle, 2026-11-26: events not being sent (no address OR no signing secret) is a live warning that opens the folded card by itself.
  it("an agent with an address but no signing secret puts the warning on the folded card's row and opens it by itself", async () => {
    localStorage.setItem("rce.card.settings-agent-webhooks", "0");
    show(value({
      targets: [
        { id: "admin", url: "https://a.example.com/h", enabled: true, headers: [], signingSecret: null, secretSource: "env" },
        { id: "cfo", url: "https://cfo.example.com/h", enabled: true, headers: [], signingSecret: null, secretSource: "none" },
        ...HUB_WEBHOOK_TARGET_IDS.filter((id) => id !== "admin" && id !== "cfo").map((id) => ({ id, url: null, enabled: true })),
      ],
    }), PIN_SESSION, { urlSet: true, secretSet: true, adminEnvUrlSet: false, adminEnvUrlRefused: false }, false);
    await waitFor(() => expect(screen.getByRole("button", { name: "Agent webhooks" })).toHaveAttribute("aria-expanded", "true"));
    expect(screen.getByText(/CFO: address set, no signing secret — nothing is sent/)).toBeTruthy();
    expect(screen.queryByText(/Admin's events are not being sent/)).toBeNull();
  });

  it("says who hears a team chat and prints the receiver's signature recipe", async () => {
    show(value(), PIN_SESSION, NO_ENV, false);
    // Kyle, 2026-11-26 ("one line each"): the separate fan-out note is gone; the routing table's own line says team chats are not listed.
    await screen.findByTestId("agent-webhooks-recipe");
    expect(document.body.textContent).toContain("Team, group and crew-chat messages are not listed: they go to every agent that can read the conversation.");
    const recipe = screen.getByTestId("agent-webhooks-recipe");
    expect(recipe.textContent).toContain(WEBHOOK_VERIFY_RECIPE);
    expect(WEBHOOK_VERIFY_RECIPE).toContain('cut it at the LAST occurrence of ,"timestamp":');
    expect(WEBHOOK_VERIFY_RECIPE).toContain("<timestamp>.<payload>");
    expect(WEBHOOK_VERIFY_RECIPE).toContain("X-RCE-Signature");
    // Claude Code is named as having no webhook, so its absence is explained on the screen.
    expect(document.body.textContent).toContain("Claude Code has no webhook");
  });

  it("leaves message.team out of the 'Which agent gets which event' table (the fan-out decides), and drops a stored route for it on the next save", async () => {
    const { save } = show(value({ routes: { "message.team": "inventory", "lead.created": "cfo" } }));
    await waitFor(() => expect((screen.getByLabelText("Where lead.created goes") as HTMLSelectElement).value).toBe("cfo"));
    expect(screen.queryByLabelText("Where message.team goes")).toBeNull();
    expect(screen.getByText(/Team, group and crew-chat messages are not listed/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Where job.completed goes"), { target: { value: "research" } });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].routes).toEqual({ "lead.created": "cfo", "job.completed": "research" });
  });

  it("gives a new agent every control the first two had: Edit address, Turn off, Remove address, Generate signing secret, Add header, Send test event and Recent events", async () => {
    const { save } = show(value({
      targets: [
        { id: "admin", url: null, enabled: true }, { id: "inventory", url: null, enabled: true }, { id: "facebook", url: null, enabled: true },
        { id: "outreach", url: null, enabled: true }, { id: "scout", url: null, enabled: true }, { id: "research", url: null, enabled: true },
        { id: "cfo", url: "https://cfo.example.com/h", enabled: true, headers: [{ name: "Authorization", masked: "••••abcd" }], signingSecret: null, secretSource: "none" },
        { id: "nec_coach", url: null, enabled: true },
      ],
    }));
    await waitFor(() => expect(screen.getByTestId("webhook-status-cfo").textContent).toBe("Address set, no signing secret — nothing is sent"));
    const cfo = screen.getByTestId("webhook-target-cfo");
    for (const name of ["Edit address", "Turn off", "Remove address", "Generate signing secret"]) expect(btn(cfo, name), name).toBeTruthy();
    expect(screen.getByLabelText("Add header to CFO")).toBeTruthy();
    expect(screen.getByLabelText("Edit value of Authorization on CFO")).toBeTruthy();
    expect(screen.getByLabelText("Remove header Authorization from CFO")).toBeTruthy();
    expect(screen.getByLabelText("Send test event to CFO")).toBeTruthy();
    expect(screen.getByTestId("webhook-log-cfo")).toBeTruthy();
    expect(within(screen.getByTestId("webhook-log-cfo")).getByText("Recent events to CFO")).toBeTruthy();

    // Turn off saves ONLY that agent's change, with all eight agents in the body.
    await waitFor(() => expect(btn(cfo, "Turn off").disabled).toBe(false));
    fireEvent.click(btn(cfo, "Turn off"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = save.mock.calls[0][0].targets;
    expect(sent.map((t) => t.id)).toEqual([...HUB_WEBHOOK_TARGET_IDS]);
    expect(sent.find((t) => t.id === "cfo")).toEqual({ id: "cfo", url: "https://cfo.example.com/h", enabled: false });
    await waitFor(() => expect(screen.getByTestId("webhook-status-cfo").textContent).toBe("Off"));
    // Generate shows the secret once, for that agent only.
    const gen = vi.spyOn(api, "generateWebhookSecret").mockResolvedValue({ secret: "cfo-secret-value-1234", masked: "••••1234", replaced: false });
    fireEvent.click(btn(screen.getByTestId("webhook-target-cfo"), "Generate signing secret"));
    await waitFor(() => expect(gen).toHaveBeenCalledWith("cfo"));
    expect((await screen.findByTestId("webhook-secret-value-cfo")).textContent).toBe("cfo-secret-value-1234");
    expect(screen.queryByTestId("webhook-secret-value-admin")).toBeNull();
  });
});

describe("AgentWebhooksSection when the settings fail to load (W2-C review)", () => {
  it("shows a visible banner, and each block opens to its controls greyed with the reason - never eight bare names", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "hubEventsConfig").mockResolvedValue(NO_ENV);
    vi.spyOn(api, "hubEvents").mockResolvedValue({ events: [], nextBefore: null });
    vi.spyOn(api, "agentWebhooks").mockRejectedValue(new Error("network down"));
    renderCard(false);
    expect((await screen.findByTestId("agent-webhooks-load-failed")).textContent).toContain("Agent webhooks could not be loaded.");
    for (const id of HUB_WEBHOOK_TARGET_IDS) {
      // Folded by default (nothing is forced open): click the agent's row, then its controls are there, greyed with the reason.
      fireEvent.click(within(screen.getByTestId(`webhook-target-${id}`)).getAllByRole("button")[0]);
      const block = screen.getByTestId(`webhook-target-${id}`);
      const edit = btn(block, "Edit address");
      expect(edit.disabled).toBe(true);
      expect(edit.title).toBe("Agent webhooks could not be loaded.");
    }
  });
});
