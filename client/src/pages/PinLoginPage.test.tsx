/**
 * PUNCHLIST C5: login used to always land on /jobs, ignoring the `from` location
 * `RequireAuth` (App.tsx) hands it when it bounces an unauthenticated visit. A
 * bookmarked or shared link — a job drawer, a specific tab — dropped the operator
 * on Jobs instead of back where they were headed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PinLoginPage } from "./PinLoginPage";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderLogin(initialEntry: { pathname: string; state?: unknown }) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/login" element={<PinLoginPage />} />
        <Route path="/purchasing" element={<p>Landed on purchasing</p>} />
        <Route path="/" element={<p>Landed on home</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function submitPin() {
  fireEvent.change(screen.getByPlaceholderText("••••"), { target: { value: "1234" } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
}

describe("PinLoginPage", () => {
  it("returns to the location RequireAuth bounced from, not a fixed /jobs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: "tok-1" }) }),
    );
    renderLogin({
      pathname: "/login",
      state: { from: { pathname: "/purchasing", search: "?po=po-1", hash: "" } },
    });

    await submitPin();

    expect(await screen.findByText("Landed on purchasing")).toBeInTheDocument();
  });

  it("falls back to the app's one home ('/') when there is nowhere to return to", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: "tok-1" }) }),
    );
    renderLogin({ pathname: "/login" });

    await submitPin();

    expect(await screen.findByText("Landed on home")).toBeInTheDocument();
  });
});

describe("PinLoginPage secure fill and paste", () => {
  it("unlocks with a PIN written straight onto the box (secure fill: no key or change event)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: "tok-1" }) });
    vi.stubGlobal("fetch", fetchMock);
    renderLogin({ pathname: "/login" });

    const input = screen.getByPlaceholderText("••••") as HTMLInputElement;
    // The native setter, with NO input/change event fired — what a browser autofill does.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "1234");
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByText("Landed on home")).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/pin");
    expect(JSON.parse(init.body as string)).toEqual({ pin: "1234" });
  });

  it("gives the box a name and autocomplete so a password manager recognises the login form", () => {
    renderLogin({ pathname: "/login" });
    const input = screen.getByPlaceholderText("••••");
    expect(input).toHaveAttribute("name", "pin");
    expect(input).toHaveAttribute("autocomplete", "current-password");
    expect(document.querySelector('input[name="username"]')).toHaveAttribute("autocomplete", "username");
  });

  it("leaves Unlock enabled with an empty box", () => {
    renderLogin({ pathname: "/login" });
    expect(screen.getByRole("button", { name: "Unlock" })).toBeEnabled();
  });

  it("shows the server's message when the PIN is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Invalid PIN" }) }),
    );
    renderLogin({ pathname: "/login" });

    fireEvent.change(screen.getByPlaceholderText("••••"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByText("Invalid PIN")).toBeInTheDocument();
  });
});
