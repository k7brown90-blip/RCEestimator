/**
 * Settings -> "AI admin login" (Kyle, 2026-11-15: "Lets do a username and password so it can save it
 * and login on its own"; "Its own login").
 *
 * Pinned: the card says On / Off / not set up; Save login is greyed WITH its reason until the
 * username and a 12+ character password are typed; Save, Turn off, Turn on and Remove login each
 * call the API; Save and Turn off say on screen that the AI admin is signed out on its next click;
 * Remove asks first; the password box never shows a saved password.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { openCards } from "../test/openCard";
import { AdminLoginSection } from "./AdminLoginSection";
import { api } from "../lib/api";
import type { AdminLoginStatus } from "../lib/types";
import { OWNER_NO_GRANT, PIN_SESSION, PRINCIPAL_SESSION } from "../test/sessions";

afterEach(() => vi.restoreAllMocks());
// The card starts folded (Kyle, 2026-11-26); these tests are about what is inside it, so open it the way a returning user left it.
beforeEach(() => openCards("settings-ai-admin-login"));

const NONE: AdminLoginStatus = { configured: false, username: null, enabled: false, updatedAt: null };
const ON: AdminLoginStatus = { configured: true, username: "grok-admin", enabled: true, updatedAt: "2026-11-15T12:00:00.000Z" };
const OFF: AdminLoginStatus = { ...ON, enabled: false };

function show(initial: AdminLoginStatus) {
  vi.spyOn(api, "adminLogin").mockResolvedValue(initial);
  const save = vi.spyOn(api, "saveAdminLogin").mockResolvedValue(ON);
  const off = vi.spyOn(api, "turnOffAdminLogin").mockResolvedValue(OFF);
  const on = vi.spyOn(api, "turnOnAdminLogin").mockResolvedValue(ON);
  const remove = vi.spyOn(api, "removeAdminLogin").mockResolvedValue(NONE);
  renderWithProviders(<AdminLoginSection />);
  return { save, off, on, remove };
}

const username = () => screen.getByLabelText("Username") as HTMLInputElement;
const password = () => screen.getByLabelText("Password") as HTMLInputElement;
const saveBtn = () => screen.getByRole("button", { name: "Save login" }) as HTMLButtonElement;

describe("AdminLoginSection", () => {
  it("says it is not set up, and Save login is greyed with its reason until both boxes are good", async () => {
    show(NONE);
    await waitFor(() => expect(screen.getByTestId("admin-login-status").textContent).toMatch(/Not set up/));
    expect(screen.getByRole("heading", { name: "AI admin login" })).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByTestId("admin-login-save-reason").textContent).toMatch(/username/i);

    fireEvent.change(username(), { target: { value: "grok-admin" } });
    expect(screen.getByTestId("admin-login-save-reason").textContent).toMatch(/Type a password/);

    fireEvent.change(password(), { target: { value: "short" } });
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByTestId("admin-login-save-reason").textContent).toMatch(/at least 12/);

    fireEvent.change(password(), { target: { value: "correct horse battery" } });
    expect(saveBtn().disabled).toBe(false);
    expect(screen.queryByTestId("admin-login-save-reason")).toBeNull();
    // No Turn off / Remove for a login that does not exist.
    expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove login" })).toBeNull();
  });

  it("Save login sends the username and password, clears the password box, and says the AI admin is signed out", async () => {
    const { save } = show(NONE);
    await waitFor(() => expect(screen.getByTestId("admin-login-status").textContent).toMatch(/Not set up/));
    fireEvent.change(username(), { target: { value: "grok-admin" } });
    fireEvent.change(password(), { target: { value: "correct horse battery" } });
    fireEvent.click(saveBtn());

    await waitFor(() => expect(save).toHaveBeenCalledWith({ username: "grok-admin", password: "correct horse battery" }));
    expect(await screen.findByText(/signed out and will have to sign in again on its next click/)).toBeTruthy();
    await waitFor(() => expect(password().value).toBe(""));
    expect(screen.getByTestId("admin-login-status").textContent).toMatch(/On/);
  });

  it("shows On with the username, never a saved password, and a new password is needed to Save", async () => {
    show(ON);
    await waitFor(() => expect(screen.getByTestId("admin-login-status").textContent).toMatch(/On — .*grok-admin/));
    expect(username().value).toBe("grok-admin");
    expect(password().value).toBe("");
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByTestId("admin-login-save-reason").textContent).toMatch(/new password/);
  });

  it("Turn off calls the API and says the AI admin is signed out; the button becomes Turn on", async () => {
    const { off } = show(ON);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(off).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Login turned off\. The AI admin is signed out/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Turn on" })).toBeTruthy();
    expect(screen.getByTestId("admin-login-status").textContent).toMatch(/Off/);
  });

  it("Turn on calls the API for a login that is off", async () => {
    const { on } = show(OFF);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(on).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/can sign in again/)).toBeTruthy();
  });

  it("Remove login asks first; cancelling does nothing, confirming removes it", async () => {
    const { remove } = show(ON);
    const confirm = vi.spyOn(window, "confirm");

    confirm.mockReturnValueOnce(false);
    fireEvent.click(await screen.findByRole("button", { name: "Remove login" }));
    expect(remove).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove login" }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("admin-login-status").textContent).toMatch(/Not set up/));
    expect(screen.queryByRole("button", { name: "Remove login" })).toBeNull();
  });

  it("shows the server's message when a save is refused", async () => {
    const { save } = show(NONE);
    save.mockRejectedValueOnce(new Error("Only the owner can change the AI admin login."));
    await waitFor(() => expect(screen.getByTestId("admin-login-status").textContent).toMatch(/Not set up/));
    fireEvent.change(username(), { target: { value: "grok-admin" } });
    fireEvent.change(password(), { target: { value: "correct horse battery" } });
    fireEvent.click(saveBtn());
    expect(await screen.findByText("Only the owner can change the AI admin login.")).toBeTruthy();
  });
});

describe("AdminLoginSection for a session that is not Kyle", () => {
  const REASON = "Only Kyle can change the AI admin login.";
  function showAs(session: typeof PIN_SESSION) {
    vi.spyOn(api, "session").mockResolvedValue(session);
    vi.spyOn(api, "adminLogin").mockResolvedValue(ON);
    const save = vi.spyOn(api, "saveAdminLogin").mockResolvedValue(ON);
    renderWithProviders(<AdminLoginSection />);
    return save;
  }

  it("greys Save login, Turn off and Remove login with the reason on the card, and Save does nothing", async () => {
    const save = showAs(OWNER_NO_GRANT);
    await waitFor(() => expect(screen.getByTestId("admin-login-only-kyle").textContent).toBe(REASON));
    fireEvent.change(username(), { target: { value: "grok-admin" } });
    fireEvent.change(password(), { target: { value: "correct horse battery" } });
    expect(saveBtn().disabled).toBe(true);
    expect(saveBtn().title).toBe(REASON);
    for (const name of ["Turn off", "Remove login"]) {
      const button = (await screen.findByRole("button", { name })) as HTMLButtonElement;
      expect(button.disabled, name).toBe(true);
      expect(button.title, name).toBe(REASON);
    }
    fireEvent.submit(saveBtn().closest("form")!);
    expect(save).not.toHaveBeenCalled();
  });

  it("greys Turn on too when the login is off", async () => {
    vi.spyOn(api, "session").mockResolvedValue(OWNER_NO_GRANT);
    vi.spyOn(api, "adminLogin").mockResolvedValue(OFF);
    renderWithProviders(<AdminLoginSection />);
    const button = (await screen.findByRole("button", { name: "Turn on" })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.title).toBe(REASON);
  });

  for (const [who, session] of [["the owner PIN", PIN_SESSION], ["Kyle's principal login", PRINCIPAL_SESSION]] as const) {
    it(`is fully enabled for ${who}, with no reason line`, async () => {
      showAs(session);
      const off = (await screen.findByRole("button", { name: "Turn off" })) as HTMLButtonElement;
      fireEvent.change(username(), { target: { value: "grok-admin" } });
      fireEvent.change(password(), { target: { value: "correct horse battery" } });
      await waitFor(() => expect(off.disabled).toBe(false));
      expect(saveBtn().disabled).toBe(false);
      expect((screen.getByRole("button", { name: "Remove login" }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByTestId("admin-login-only-kyle")).toBeNull();
    });
  }
});
