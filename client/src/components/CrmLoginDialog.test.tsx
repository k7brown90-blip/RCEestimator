/**
 * Team -> "CRM login" dialog (work order agent-team, HA4).
 *
 * Pinned: Save login creates the login (and sends a password only when one was typed); the password
 * hint says blank keeps the current one; picking Tech says on screen that tech logins cannot sign in
 * yet; each Kyle-only power is a checkbox that saves the moment it is ticked; Turn off / Turn on and
 * Remove login each call the API, and Remove asks first and says the person is signed out at once;
 * the "This is me" box exists only for Kyle's PIN session; Kyle's own login shows every power ticked
 * and locked.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { CrmLoginDialog, cannotSignInReason, crmLoginTag } from "./CrmLoginDialog";
import { api } from "../lib/api";
import type { CrmLoginView, SessionView } from "../lib/types";
import { CRM_POWERS, CRM_POWER_KEYS } from "../../../shared/crmPowers";
import { OWNER_NO_GRANT, PIN_SESSION, PRINCIPAL_SESSION, loginFor } from "../test/sessions";

afterEach(() => vi.restoreAllMocks());

describe("cannotSignInReason and the roster tag", () => {
  const login = (over: Partial<CrmLoginView> = {}) => loginFor("t1", "Michael Schramm", over);

  it("a good login has no reason and a plain tag", () => {
    expect(cannotSignInReason(login())).toBeNull();
    expect(crmLoginTag(login())).toBe("CRM: Owner · on");
  });

  it("names the first thing that stops it, and the tag says it can't sign in", () => {
    expect(cannotSignInReason(login({ role: "tech" }))).toMatch(/Tech logins can't sign in/);
    expect(crmLoginTag(login({ role: "tech" }))).toBe("CRM: Tech · on, can't sign in");
    expect(cannotSignInReason(login({ personActive: false }))).toMatch(/deactivated/);
    expect(crmLoginTag(login({ personActive: false }))).toBe("CRM: Owner · on, can't sign in");
    expect(cannotSignInReason(login({ hasPassword: false }))).toBe("no password is set");
    expect(crmLoginTag(login({ hasPassword: false, role: "office" }))).toBe("CRM: Office · on, can't sign in");
  });

  it("the principal with no password can sign in (via the PIN)", () => {
    expect(cannotSignInReason(login({ hasPassword: false, isPrincipal: true }))).toBeNull();
    expect(crmLoginTag(login({ hasPassword: false, isPrincipal: true }))).toBe("CRM: Owner · on");
  });

  it("a turned-off login's tag says off and does not add 'can't sign in'", () => {
    expect(crmLoginTag(login({ enabled: false, hasPassword: false }))).toBe("CRM: Owner · off");
  });

  it("no login: no tag", () => {
    expect(crmLoginTag(undefined)).toBeNull();
  });
});

const PERSON = { id: "t1", name: "Michael Schramm" };

function show(opts: { login?: CrmLoginView; session?: SessionView } = {}) {
  vi.spyOn(api, "session").mockResolvedValue(opts.session ?? PIN_SESSION);
  vi.spyOn(api, "crmLogins").mockResolvedValue({ logins: opts.login ? [opts.login] : [] });
  const save = vi.spyOn(api, "saveCrmLogin").mockImplementation(async (id, input) =>
    loginFor(id, PERSON.name, { username: input.username, role: input.role, hasPassword: input.password !== undefined }));
  const off = vi.spyOn(api, "turnOffCrmLogin").mockResolvedValue(loginFor("t1", PERSON.name, { enabled: false }));
  const on = vi.spyOn(api, "turnOnCrmLogin").mockResolvedValue(loginFor("t1", PERSON.name, { enabled: true }));
  const remove = vi.spyOn(api, "removeCrmLogin").mockResolvedValue({ removed: true, technicianId: "t1" });
  const powers = vi.spyOn(api, "setCrmLoginPowers").mockImplementation(async (id, list) =>
    loginFor(id, PERSON.name, { powers: list }));
  const principal = vi.spyOn(api, "setCrmLoginPrincipal").mockImplementation(async (id, flag) =>
    loginFor(id, PERSON.name, { isPrincipal: flag }));
  const onClose = vi.fn();
  renderWithProviders(<CrmLoginDialog technician={PERSON} onClose={onClose} />);
  return { save, off, on, remove, powers, principal, onClose };
}

const username = () => screen.getByLabelText("Username") as HTMLInputElement;
const password = () => screen.getByLabelText(/^Password/) as HTMLInputElement;
const role = () => screen.getByLabelText("Role") as HTMLSelectElement;
const saveBtn = () => screen.getByRole("button", { name: "Save login" }) as HTMLButtonElement;
const power = (key: keyof typeof CRM_POWERS) => screen.getByLabelText(CRM_POWERS[key].label) as HTMLInputElement;

describe("CrmLoginDialog", () => {
  it("is titled for the person and says there is no login yet", async () => {
    show();
    expect(screen.getByRole("dialog", { name: "CRM login for Michael Schramm" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "CRM login for Michael Schramm" })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("crm-login-status").textContent).toMatch(/No CRM login yet for Michael Schramm/));
    // Nothing to turn off or remove, and the powers wait for the login to exist.
    expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove login" })).toBeNull();
    expect(screen.getByTestId("crm-login-powers-reason").textContent).toMatch(/Save the login first/);
    for (const key of CRM_POWER_KEYS) expect(power(key).disabled).toBe(true);
  });

  it("Save login is greyed with its reason until a username is typed, and the password hint says blank keeps the current one", async () => {
    show({ login: loginFor("t1", PERSON.name) });
    await waitFor(() => expect(username().value).toBe("michael"));
    expect(screen.getByText(/Leave blank to keep the current one/)).toBeTruthy();
    fireEvent.change(username(), { target: { value: "mi" } });
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByTestId("crm-login-save-reason").textContent).toMatch(/at least 3/);
    fireEvent.change(username(), { target: { value: "michael" } });
    fireEvent.change(password(), { target: { value: "short" } });
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByTestId("crm-login-save-reason").textContent).toMatch(/at least 12/);
    fireEvent.change(password(), { target: { value: "" } });
    expect(saveBtn().disabled).toBe(false);
  });

  it("CREATE: Save login calls the API with username and role, and no password when none was typed", async () => {
    const { save } = show();
    await waitFor(() => expect(screen.getByTestId("crm-login-status").textContent).toMatch(/No CRM login/));
    fireEvent.change(username(), { target: { value: "michael" } });
    fireEvent.change(role(), { target: { value: "admin" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(save).toHaveBeenCalledWith("t1", { username: "michael", role: "admin" }));
    // No password was typed, so the status does not claim he can sign in.
    await waitFor(() => expect(screen.getByTestId("crm-login-status").textContent).toBe("On, but Michael Schramm can't sign in yet: no password is set."));
    expect(screen.getByText("Login saved.")).toBeTruthy();
    // Now it exists, Turn off and Remove login appear and the powers unlock.
    expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove login" })).toBeTruthy();
    expect(power("treasury").disabled).toBe(false);
  });

  it("CREATE with a password sends it, empties the box, and says the person signs in again with it", async () => {
    const { save } = show();
    await waitFor(() => expect(screen.getByTestId("crm-login-status")).toBeTruthy());
    fireEvent.change(username(), { target: { value: "michael" } });
    fireEvent.change(password(), { target: { value: "correct horse battery" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(save).toHaveBeenCalledWith("t1", { username: "michael", role: "owner", password: "correct horse battery" }));
    await waitFor(() => expect(password().value).toBe(""));
    expect(screen.getByText(/signs in again with the new password/)).toBeTruthy();
  });

  it("choosing Tech says why on the screen: tech logins can't sign in yet", async () => {
    const { save } = show({ login: loginFor("t1", PERSON.name) });
    await waitFor(() => expect(username().value).toBe("michael"));
    expect(screen.queryByTestId("crm-login-tech-note")).toBeNull();
    fireEvent.change(role(), { target: { value: "tech" } });
    expect(screen.getByTestId("crm-login-tech-note").textContent).toBe("Tech logins can't sign in to the CRM yet.");
    // Saving a tech login is still allowed; the notice is the explanation.
    fireEvent.click(saveBtn());
    await waitFor(() => expect(save).toHaveBeenCalledWith("t1", { username: "michael", role: "tech" }));
    fireEvent.change(role(), { target: { value: "office" } });
    expect(screen.queryByTestId("crm-login-tech-note")).toBeNull();
    // The four roles, by name.
    expect(Array.from(role().options).map((o) => o.textContent)).toEqual(["Owner", "Admin", "Office", "Tech"]);
  });

  it("POWER TOGGLE: ticking a power saves it at once, unticking removes it, in the shared order", async () => {
    const { powers } = show({ login: loginFor("t1", PERSON.name, { powers: ["treasury"] }) });
    await waitFor(() => expect(power("treasury").checked).toBe(true));
    expect(screen.getByText("Kyle-only powers")).toBeTruthy();
    expect(CRM_POWER_KEYS).toHaveLength(9); // W2-E added coding_requests ("Ask Claude Code to change the app") to the original eight
    for (const key of CRM_POWER_KEYS) expect(screen.getByLabelText(CRM_POWERS[key].label)).toBeTruthy();

    fireEvent.click(power("price_book_edit"));
    await waitFor(() => expect(powers).toHaveBeenLastCalledWith("t1", ["price_book_edit", "treasury"]));
    await waitFor(() => expect(power("price_book_edit").checked).toBe(true));

    fireEvent.click(power("treasury"));
    await waitFor(() => expect(powers).toHaveBeenLastCalledWith("t1", ["price_book_edit"]));
    await waitFor(() => expect(power("treasury").checked).toBe(false));

    fireEvent.click(power("approve_drafts"));
    await waitFor(() => expect(powers).toHaveBeenLastCalledWith("t1", ["price_book_edit", "approve_drafts"]));
  });

  it("TURN OFF then TURN ON call the API and flip the button and the status", async () => {
    const { off, on } = show({ login: loginFor("t1", PERSON.name) });
    const offBtn = await screen.findByRole("button", { name: "Turn off" });
    fireEvent.click(offBtn);
    await waitFor(() => expect(off).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(screen.getByTestId("crm-login-status").textContent).toMatch(/^Off — /));
    expect(screen.getByText(/signed out at once/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(on).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy());
  });

  it("REMOVE asks first, says the person is signed out at once, and only then calls the API", async () => {
    const { remove } = show({ login: loginFor("t1", PERSON.name) });
    const removeBtn = await screen.findByRole("button", { name: "Remove login" });

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(removeBtn);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(confirm.mock.calls[0][0])).toMatch(/signed out at once/);
    expect(remove).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(removeBtn);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(screen.getByTestId("crm-login-status").textContent).toMatch(/No CRM login yet/));
    expect(screen.queryByRole("button", { name: "Remove login" })).toBeNull();
    expect(username().value).toBe("");
  });

  it("a refusal from the server is shown, not swallowed", async () => {
    const { save } = show();
    save.mockRejectedValue(new Error("That username is already another person's login. Pick a different one."));
    await waitFor(() => expect(screen.getByTestId("crm-login-status")).toBeTruthy());
    fireEvent.change(username(), { target: { value: "michael" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(/already another person's login/)).toBeTruthy());
  });

  it("THIS IS ME: on Kyle's PIN session the box marks the login as his; on any other session there is no such box", async () => {
    const { principal } = show({ login: loginFor("t1", PERSON.name), session: PIN_SESSION });
    const box = await screen.findByLabelText(/This is me — the owner PIN signs in as this person/) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(principal).toHaveBeenCalledWith("t1", true));
    await waitFor(() => expect(box.checked).toBe(true));
    // Kyle's own login holds every power: every box ticked and locked.
    for (const key of CRM_POWER_KEYS) {
      expect(power(key).checked).toBe(true);
      expect(power(key).disabled).toBe(true);
    }
    expect(screen.getByTestId("crm-login-powers-reason").textContent).toMatch(/holds every power/);
    fireEvent.click(box);
    await waitFor(() => expect(principal).toHaveBeenLastCalledWith("t1", false));
  });

  it("THIS IS ME is always shown; on Kyle's own CRM login it is greyed with the reason (only the PIN can move the mark)", async () => {
    const { principal } = show({ login: loginFor("t1", PERSON.name, { isPrincipal: true }), session: PRINCIPAL_SESSION });
    await waitFor(() => expect(username().value).toBe("michael"));
    const box = screen.getByLabelText(/This is me — the owner PIN signs in as this person/) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(true); // it still shows where the mark is
    expect(screen.getByTestId("crm-login-me-reason").textContent)
      .toBe("Only the owner PIN can choose which login is yours. Sign in with the PIN to change this.");
    fireEvent.click(box);
    expect(principal).not.toHaveBeenCalled();
  });

  it("THIS IS ME is greyed with the same reason for any session that is not the PIN", async () => {
    show({ login: loginFor("t1", PERSON.name), session: OWNER_NO_GRANT });
    await waitFor(() => expect(username().value).toBe("michael"));
    expect((screen.getByLabelText(/This is me/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("crm-login-me-reason")).toBeTruthy();
  });

  it("THIS IS ME is live on the PIN and shows no reason line", async () => {
    show({ login: loginFor("t1", PERSON.name), session: PIN_SESSION });
    const box = await screen.findByLabelText(/This is me/) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(screen.queryByTestId("crm-login-me-reason")).toBeNull();
  });

  describe("it never claims a login can sign in when it cannot", () => {
    const status = () => screen.getByTestId("crm-login-status").textContent;

    it("no password and not Kyle's own: 'On, but … can't sign in yet: no password is set.' and the hint asks for one", async () => {
      show({ login: loginFor("t1", PERSON.name, { hasPassword: false }) });
      await waitFor(() => expect(status()).toBe("On, but Michael Schramm can't sign in yet: no password is set."));
      expect(screen.getByText(/No password is set yet\. Type one so this person can sign in\./)).toBeTruthy();
      expect(screen.queryByText(/Leave blank to keep the current one/)).toBeNull();
    });

    it("a Tech role: says why", async () => {
      show({ login: loginFor("t1", PERSON.name, { role: "tech" }) });
      await waitFor(() => expect(status()).toBe("On, but Michael Schramm can't sign in yet: Tech logins can't sign in to the CRM yet."));
    });

    it("a deactivated person: says why", async () => {
      show({ login: loginFor("t1", PERSON.name, { personActive: false }) });
      await waitFor(() => expect(status()).toBe("On, but Michael Schramm can't sign in yet: they are deactivated on the Team roster."));
    });

    it("Kyle's own login with no password CAN sign in (the PIN signs in as him), so it says On", async () => {
      show({ login: loginFor("t1", PERSON.name, { hasPassword: false, isPrincipal: true }) });
      await waitFor(() => expect(status()).toMatch(/^On — Michael Schramm signs in as "michael"/));
    });

    it("a login with a password and a good role says On, and the hint says blank keeps the current one", async () => {
      show({ login: loginFor("t1", PERSON.name) });
      await waitFor(() => expect(status()).toMatch(/^On — /));
      expect(screen.getByText(/Leave blank to keep the current one/)).toBeTruthy();
    });

    it("a turned-off login still just says Off", async () => {
      show({ login: loginFor("t1", PERSON.name, { enabled: false, hasPassword: false }) });
      await waitFor(() => expect(status()).toMatch(/^Off — /));
    });
  });

  it("THIS IS ME waits for the login to exist", async () => {
    show({ session: PIN_SESSION });
    const box = await screen.findByLabelText(/This is me/) as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });

  it("closes from the x", async () => {
    const { onClose } = show({ session: OWNER_NO_GRANT });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
