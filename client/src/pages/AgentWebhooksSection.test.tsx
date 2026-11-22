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
import type { AgentWebhooksValue } from "../lib/types";
import { AI_ADMIN_SESSION, OWNER_NO_GRANT, PIN_SESSION } from "../test/sessions";
import { HUB_EVENT_TYPES } from "../../../shared/hub/events";

afterEach(() => vi.restoreAllMocks());

const value = (over: Partial<AgentWebhooksValue> = {}): AgentWebhooksValue => ({
  targets: [{ id: "admin", url: null, enabled: true }, { id: "inventory", url: null, enabled: true }],
  routes: {}, ...over,
});

const NO_ENV = { urlSet: false, secretSet: true, adminEnvUrlSet: false, adminEnvUrlRefused: false };

function show(initial: AgentWebhooksValue, session = PIN_SESSION, config = NO_ENV) {
  vi.spyOn(api, "session").mockResolvedValue(session);
  vi.spyOn(api, "hubEventsConfig").mockResolvedValue(config);
  const load = vi.spyOn(api, "agentWebhooks").mockResolvedValue({ key: "agentWebhooks", value: initial });
  const save = vi.spyOn(api, "saveAgentWebhooks").mockImplementation(async (v) => ({ key: "agentWebhooks", value: v }));
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
