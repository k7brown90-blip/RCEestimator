/**
 * Settings -> "AI auto-send rules" (work order agent-team, BA8; Kyle only).
 *
 * Pinned: one switch per eligible category (the registry's), every one OFF by default with the subtitle
 * "Off means every AI message waits for someone to press Approve."; turning one ON asks the question and only
 * a yes saves, through the ONE owner-settings writer; turning it OFF is one click; the card says it also
 * needs the Railway gate while that is off; and every switch is greyed with the reason for anyone but Kyle.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import {
  AUTOSEND_GATE_NOTE, AUTOSEND_LOCK_REASON, AUTOSEND_SUBTITLE, AUTOSEND_TURN_ON_QUESTION, AutoSendRulesSection,
} from "./AutoSendRulesSection";
import { api } from "../lib/api";
import { AI_ADMIN_SESSION, OWNER_NO_GRANT, PIN_SESSION } from "../test/sessions";
import type { HubAutoSendResponse } from "../lib/types";
import { AUTO_SEND_CATEGORIES } from "../../../shared/hub/autoSendCategories";

afterEach(() => vi.restoreAllMocks());

const CATEGORY = AUTO_SEND_CATEGORIES[0]!;
const response = (categories: Record<string, boolean> = {}, gateOn = false): HubAutoSendResponse => ({
  key: "hubAutoSend",
  value: { categories, changedAt: null, changedBy: null },
  status: { gateOn, gateEnv: "AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND" },
});

function show(initial: HubAutoSendResponse, session = PIN_SESSION) {
  vi.spyOn(api, "session").mockResolvedValue(session);
  const load = vi.spyOn(api, "hubAutoSend").mockResolvedValue(initial);
  const save = vi.spyOn(api, "saveHubAutoSend").mockImplementation(async (categories) => ({ ...initial, value: { ...initial.value, categories } }));
  renderWithProviders(<AutoSendRulesSection />);
  return { load, save };
}
const toggle = () => screen.getByRole("switch", { name: `Auto-send ${CATEGORY.label}` }) as HTMLButtonElement;

describe("AutoSendRulesSection for Kyle", () => {
  it("lists every eligible category OFF, with the subtitle, and says the Railway gate is also needed", async () => {
    show(response());
    expect(screen.getByRole("heading", { name: "AI auto-send rules" })).toBeInTheDocument();
    expect(screen.getByText(AUTOSEND_SUBTITLE)).toBeInTheDocument();
    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId(`autosend-${CATEGORY.key}`)).toHaveTextContent("Off");
    expect(screen.getByTestId("autosend-gate-note")).toHaveTextContent(AUTOSEND_GATE_NOTE);
    expect(AUTOSEND_GATE_NOTE).toBe("Also needs AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND=on in Railway — nothing sends automatically until then.");
  });

  it("turning one ON asks first; a 'No' saves nothing and a 'Yes' saves through the one writer", async () => {
    const { save } = show(response());
    await waitFor(() => expect(toggle()).toBeEnabled());
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(toggle());
    expect(confirm).toHaveBeenCalledWith(AUTOSEND_TURN_ON_QUESTION);
    expect(AUTOSEND_TURN_ON_QUESTION).toBe("Messages in this category will go out without anyone pressing Approve. Turn on?");
    expect(save).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(toggle());
    await waitFor(() => expect(save).toHaveBeenCalledWith({ [CATEGORY.key]: true }));
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
    expect(await screen.findByText(`${CATEGORY.label} auto-send turned on.`)).toBeInTheDocument();
  });

  it("turning it OFF is one click, with no question", async () => {
    const { save } = show(response({ [CATEGORY.key]: true }, true));
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
    const confirm = vi.spyOn(window, "confirm");
    fireEvent.click(toggle());
    await waitFor(() => expect(save).toHaveBeenCalledWith({ [CATEGORY.key]: false }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId("autosend-gate-note")).toBeNull();
  });
});

describe("AutoSendRulesSection for anyone else", () => {
  it.each([["the AI admin", AI_ADMIN_SESSION], ["another login", OWNER_NO_GRANT]])("%s sees the switches greyed with the reason, and nothing is fetched", async (_who, session) => {
    const { load } = show(response(), session);
    await screen.findByTestId("autosend-locked");
    expect(screen.getByTestId("autosend-locked")).toHaveTextContent(AUTOSEND_LOCK_REASON);
    expect(AUTOSEND_LOCK_REASON).toBe("Only Kyle's PIN sign-in can change these.");
    expect(toggle()).toBeDisabled();
    expect(load).not.toHaveBeenCalled();
    // Kyle may have turned a category on; a session that cannot read the state must not claim it is Off.
    expect(screen.getByTestId(`autosend-${CATEGORY.key}`)).not.toHaveTextContent(/Off/);
    expect(screen.getByTestId(`autosend-${CATEGORY.key}`)).toHaveTextContent("Not shown");
  });
});

describe("the categories BA8 names", () => {
  it("shows one switch each for the first reply, the appointment reminder, a team post and a Training reply, all Off", async () => {
    show(response());
    await waitFor(() => expect(toggle()).toBeEnabled());
    for (const key of ["lead_first_response", "visit_reminder", "team_internal", "training_reply"]) {
      expect(screen.getByTestId(`autosend-${key}`)).toHaveTextContent("Off");
    }
    expect(screen.getAllByRole("switch")).toHaveLength(AUTO_SEND_CATEGORIES.length);
    expect(AUTO_SEND_CATEGORIES.map((c) => c.key)).toEqual(expect.arrayContaining(["lead_first_response", "visit_reminder", "team_internal", "training_reply"]));
  });
});
