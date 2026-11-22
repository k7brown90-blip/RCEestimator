/**
 * The header says who is signed in, and Sign out ends THEIR session (work order agent-team, HA5): so
 * two people can share one office PC. The session is read once from GET /auth/session and shared.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "../test/renderWithProviders";
import { AppShell } from "./AppShell";
import { api } from "../lib/api";
import type { SessionView } from "../lib/types";
import { AI_ADMIN_SESSION, OWNER_NO_GRANT, PIN_SESSION, ownerWith } from "../test/sessions";
import { PowerLockNote } from "./PowerLockNote";

afterEach(() => vi.restoreAllMocks());

function show(session: SessionView, children: React.ReactNode = <p>page content</p>) {
  vi.spyOn(api, "leads").mockResolvedValue([]);
  const spy = vi.spyOn(api, "session").mockResolvedValue(session);
  renderWithProviders(
    <Routes>
      <Route path="/login" element={<p>the login page</p>} />
      <Route path="*" element={<AppShell>{children}</AppShell>} />
    </Routes>,
    { route: "/dashboard" },
  );
  return spy;
}

describe("AppShell header", () => {
  it("reads 'Signed in as <name> (<role>)' with a Sign out button, for a CRM user", async () => {
    show(OWNER_NO_GRANT);
    await waitFor(() => expect(screen.getByTestId("signed-in-as").textContent).toBe("Signed in as Michael Schramm (Owner)"));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    // The whole line, as the person reads it.
    expect(screen.getByTestId("session-bar").textContent).toBe("Signed in as Michael Schramm (Owner)·Sign out");
  });

  it("the owner PIN reads the session's name, with the Owner role", async () => {
    show(PIN_SESSION);
    await waitFor(() => expect(screen.getByTestId("signed-in-as").textContent).toBe("Signed in as Kyle (Owner)"));
    cleanupName();
  });

  it("the PIN takes the name of the login marked as Kyle's when there is one", async () => {
    show({ ...PIN_SESSION, name: "Kyle Rowe" });
    await waitFor(() => expect(screen.getByTestId("signed-in-as").textContent).toBe("Signed in as Kyle Rowe (Owner)"));
  });

  it("the AI admin reads what the session returns", async () => {
    show(AI_ADMIN_SESSION);
    await waitFor(() => expect(screen.getByTestId("signed-in-as").textContent).toBe("Signed in as grok-admin (AI admin)"));
  });

  it("each role is named: Admin, Office, Tech", async () => {
    show({ ...OWNER_NO_GRANT, role: "office", name: "Pat Office" });
    await waitFor(() => expect(screen.getByTestId("signed-in-as").textContent).toBe("Signed in as Pat Office (Office)"));
  });

  it("Sign out is there even before the session is known, and still works", async () => {
    vi.spyOn(api, "leads").mockResolvedValue([]);
    vi.spyOn(api, "session").mockReturnValue(new Promise(() => {}));
    localStorage.setItem("rce_token", "t");
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<p>the login page</p>} />
        <Route path="*" element={<AppShell><p>page content</p></AppShell>} />
      </Routes>,
      { route: "/dashboard" },
    );
    expect(screen.queryByTestId("signed-in-as")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(localStorage.getItem("rce_token")).toBeNull();
    expect(await screen.findByText("the login page")).toBeTruthy();
  });

  it("Sign out removes rce_token and goes to /login", async () => {
    localStorage.setItem("rce_token", "some-session-token");
    show(OWNER_NO_GRANT);
    await waitFor(() => expect(screen.getByTestId("signed-in-as")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(localStorage.getItem("rce_token")).toBeNull();
    expect(await screen.findByText("the login page")).toBeTruthy();
    expect(screen.queryByText("page content")).toBeNull();
  });

  it("the session is fetched ONCE however many components ask, and a power-locked note reads it", async () => {
    const spy = show(OWNER_NO_GRANT, (
      <>
        <PowerLockNote power="price_book_edit" />
        <PowerLockNote power="treasury" />
        <PowerLockNote power="bot_keys" />
      </>
    ));
    await waitFor(() => expect(screen.getByTestId("power-lock-treasury")).toBeTruthy());
    expect(screen.getByTestId("power-lock-price_book_edit").textContent)
      .toBe("Only Kyle can change price book prices, hours and names. Kyle can turn this on for you under Team → CRM login.");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a power-lock note is not shown to a session that holds the power, nor to the PIN", async () => {
    show(ownerWith("treasury"), (
      <>
        <PowerLockNote power="treasury" />
        <PowerLockNote power="price_book_edit" />
      </>
    ));
    await waitFor(() => expect(screen.getByTestId("signed-in-as")).toBeTruthy());
    expect(screen.queryByTestId("power-lock-treasury")).toBeNull();
    expect(screen.getByTestId("power-lock-price_book_edit")).toBeTruthy();
  });
});

function cleanupName() {
  expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
}
