/**
 * Team -> "CRM login" (work order agent-team, HA4): the two doors onto the one dialog.
 *
 * Pinned: each roster row has a "CRM login" button and a "CRM: Owner · on" tag when the person has a
 * login; for a session that is not Kyle the button is GREYED with the reason "Only Kyle manages CRM
 * logins." on the screen (never hidden) and the logins are not even requested; the same button and the
 * same dialog are on the person's own page (/team/:technicianId).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "../test/renderWithProviders";
import { TeamPage } from "./TeamPage";
import { TechnicianPage } from "./TechnicianPage";
import { api } from "../lib/api";
import type { Technician } from "../lib/api";
import { AI_ADMIN_SESSION, OWNER_NO_GRANT, PIN_SESSION, PRINCIPAL_SESSION, loginFor } from "../test/sessions";

afterEach(() => vi.restoreAllMocks());

const tech = (id: string, name: string): Technician => ({
  id, name, role: "technician", accessToken: `token-${id}`, isActive: true, calendarShared: false, createdAt: "2026-01-01T00:00:00.000Z",
});
const MICHAEL = tech("t1", "Michael Schramm");
const SAM = tech("t2", "Sam Tech");

function showTeam(session = PIN_SESSION) {
  vi.spyOn(api, "session").mockResolvedValue(session);
  vi.spyOn(api, "technicians").mockResolvedValue([MICHAEL, SAM]);
  const logins = vi.spyOn(api, "crmLogins").mockResolvedValue({
    logins: [loginFor("t1", "Michael Schramm", { role: "owner", enabled: true })],
  });
  renderWithProviders(<TeamPage />);
  return { logins };
}

const rowOf = (name: string) => screen.getByRole("link", { name }).closest("li") as HTMLElement;

describe("Team roster: the CRM login button", () => {
  it("every row has a CRM login button, and a person with a login shows a CRM tag", async () => {
    showTeam();
    await screen.findByText("Michael Schramm");
    expect(within(rowOf("Michael Schramm")).getByRole("button", { name: "CRM login" })).toBeTruthy();
    expect(within(rowOf("Sam Tech")).getByRole("button", { name: "CRM login" })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("crm-tag-t1").textContent).toBe("CRM: Owner · on"));
    // Sam has no login: no tag at all.
    expect(screen.queryByTestId("crm-tag-t2")).toBeNull();
  });

  it("the tag says off for a login that is turned off, and names the role", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "technicians").mockResolvedValue([MICHAEL]);
    vi.spyOn(api, "crmLogins").mockResolvedValue({ logins: [loginFor("t1", "Michael Schramm", { role: "office", enabled: false })] });
    renderWithProviders(<TeamPage />);
    await waitFor(() => expect(screen.getByTestId("crm-tag-t1").textContent).toBe("CRM: Office · off"));
  });

  it("a login that can't sign in says so in its tag (a Tech role, or no password)", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "technicians").mockResolvedValue([MICHAEL, SAM]);
    vi.spyOn(api, "crmLogins").mockResolvedValue({ logins: [
      loginFor("t1", "Michael Schramm", { role: "tech" }),
      loginFor("t2", "Sam Tech", { role: "office", hasPassword: false }),
    ] });
    renderWithProviders(<TeamPage />);
    await waitFor(() => expect(screen.getByTestId("crm-tag-t1").textContent).toBe("CRM: Tech · on, can't sign in"));
    expect(screen.getByTestId("crm-tag-t2").textContent).toBe("CRM: Office · on, can't sign in");
  });

  it("clicking CRM login on Michael's row opens 'CRM login for Michael Schramm' with his saved login in it", async () => {
    showTeam();
    await screen.findByText("Michael Schramm");
    const button = within(rowOf("Michael Schramm")).getByRole("button", { name: "CRM login" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(await screen.findByRole("dialog", { name: "CRM login for Michael Schramm" })).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("michael"));
  });

  it("Kyle's own principal login may open it too", async () => {
    showTeam(PRINCIPAL_SESSION);
    await screen.findByText("Michael Schramm");
    expect((within(rowOf("Michael Schramm")).getByRole("button", { name: "CRM login" }) as HTMLButtonElement).disabled).toBe(false);
  });

  for (const [label, session] of [["an owner-role login without Kyle's say-so", OWNER_NO_GRANT], ["the AI admin", AI_ADMIN_SESSION]] as const) {
    it(`for ${label} the button is greyed with its reason on the screen, never hidden, and nothing asks for the logins`, async () => {
      const { logins } = showTeam(session);
      await screen.findByText("Michael Schramm");
      await waitFor(() => expect(screen.getAllByTestId("crm-login-only-kyle")).toHaveLength(2));
      for (const name of ["Michael Schramm", "Sam Tech"]) {
        const row = within(rowOf(name));
        const button = row.getByRole("button", { name: "CRM login" }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.title).toBe("Only Kyle manages CRM logins.");
        expect(row.getByTestId("crm-login-only-kyle").textContent).toBe("Only Kyle manages CRM logins.");
      }
      expect(screen.queryByTestId("crm-tag-t1")).toBeNull();
      expect(logins).not.toHaveBeenCalled();
      fireEvent.click(within(rowOf("Michael Schramm")).getByRole("button", { name: "CRM login" }));
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  }
});

describe("the person's own page: a CRM login card with the same button and dialog", () => {
  function showPerson(session = PIN_SESSION) {
    vi.spyOn(api, "session").mockResolvedValue(session);
    vi.spyOn(api, "technicians").mockResolvedValue([MICHAEL]);
    vi.spyOn(api, "crmLogins").mockResolvedValue({ logins: [loginFor("t1", "Michael Schramm")] });
    vi.spyOn(api, "payrollWeek").mockReturnValue(new Promise(() => {}));
    renderWithProviders(
      <Routes><Route path="/team/:technicianId" element={<TechnicianPage />} /></Routes>,
      { route: "/team/t1" },
    );
  }

  it("shows the card with the login's status and opens the same dialog", async () => {
    showPerson();
    const card = await screen.findByRole("region", { name: "CRM login" });
    await waitFor(() => expect(within(card).getByTestId("crm-login-card-status").textContent).toBe("CRM: Owner · on"));
    fireEvent.click(within(card).getByRole("button", { name: "CRM login" }));
    expect(await screen.findByRole("dialog", { name: "CRM login for Michael Schramm" })).toBeTruthy();
  });

  it("is greyed with the reason for a session that is not Kyle", async () => {
    showPerson(OWNER_NO_GRANT);
    const card = await screen.findByRole("region", { name: "CRM login" });
    await waitFor(() => expect((within(card).getByRole("button", { name: "CRM login" }) as HTMLButtonElement).disabled).toBe(true));
    expect(within(card).getByTestId("crm-login-only-kyle").textContent).toBe("Only Kyle manages CRM logins.");
    expect(within(card).getByTestId("crm-login-card-status").textContent).toMatch(/Only Kyle/);
  });
});

/*
 * A technician's token and role are Kyle's alone (work order agent-team, U10): the server sends no token to anyone else, so
 * Show token / Show QR / Rotate token and the Role choice are GREYED with the reason on the screen, never hidden.
 */
describe("Team roster: token and role are Kyle's alone", () => {
  const REASON = "Only Kyle's PIN sign-in can change this.";
  const tokenless = (t: Technician): Technician => ({ ...t, accessToken: undefined });

  for (const [label, session] of [["an owner-role login without Kyle's say-so", OWNER_NO_GRANT], ["the AI admin", AI_ADMIN_SESSION]] as const) {
    it(`for ${label}: the three token buttons and the Role choice are greyed with the sentence, and no token is ever shown`, async () => {
      vi.spyOn(api, "session").mockResolvedValue(session);
      vi.spyOn(api, "technicians").mockResolvedValue([tokenless(MICHAEL), tokenless(SAM)]);
      vi.spyOn(api, "crmLogins").mockResolvedValue({ logins: [] });
      renderWithProviders(<TeamPage />);
      await screen.findByText("Michael Schramm");
      await waitFor(() => expect(screen.getByTestId("token-role-reason").textContent).toContain(REASON));
      const row = within(rowOf("Michael Schramm"));
      for (const name of ["Show token", "Show QR", "Rotate token"]) {
        const button = row.getByRole("button", { name }) as HTMLButtonElement;
        expect(button.disabled, name).toBe(true);
        expect(button.title, name).toBe(REASON);
      }
      const role = screen.getByLabelText("Role") as HTMLSelectElement;
      expect(role.disabled).toBe(true);
      expect(role.title).toBe(REASON);
      expect(role.value).toBe("technician");
      expect(document.body.textContent).not.toContain("token-t1");
    });
  }

  it("for Kyle every one of them is live and the token still shows", async () => {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "technicians").mockResolvedValue([MICHAEL]);
    vi.spyOn(api, "crmLogins").mockResolvedValue({ logins: [] });
    renderWithProviders(<TeamPage />);
    await screen.findByText("Michael Schramm");
    const row = within(rowOf("Michael Schramm"));
    for (const name of ["Show token", "Show QR", "Rotate token"]) expect((row.getByRole("button", { name }) as HTMLButtonElement).disabled, name).toBe(false);
    expect((screen.getByLabelText("Role") as HTMLSelectElement).disabled).toBe(false);
    expect(screen.queryByTestId("token-role-reason")).toBeNull();
    fireEvent.click(row.getByRole("button", { name: "Show token" }));
    expect(screen.getByText("token-t1")).toBeInTheDocument();
  });
});
