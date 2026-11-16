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
    // The PIN form carries no username box of its own (the old hidden "owner" one is gone, so a
    // password manager does not confuse the PIN with the username/password login below it).
    const pinForm = input.closest("form")!;
    expect(pinForm.querySelector('input[name="username"]')).toBeNull();
    expect(pinForm.querySelectorAll("input")).toHaveLength(1);
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

describe("PinLoginPage: sign in with username and password (the AI admin's own login)", () => {
  const nativeSet = (el: HTMLInputElement, value: string) =>
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);

  function credentialBoxes() {
    const username = document.querySelector('input[name="username"]') as HTMLInputElement;
    const password = document.querySelector('input[name="password"]') as HTMLInputElement;
    return { username, password };
  }

  it("shows a titled second form with real Username and Password boxes and a Sign in button", () => {
    renderLogin({ pathname: "/login" });
    expect(screen.getByText("Sign in with username and password")).toBeInTheDocument();
    const { username, password } = credentialBoxes();
    expect(username).toHaveAttribute("autocomplete", "username");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    expect(password).toHaveAttribute("type", "password");
    // Real, visible fields - not the sr-only trick.
    expect(username.className).not.toContain("sr-only");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    // method=post, so credentials can never land in the address bar even without JavaScript.
    expect(username.closest("form")).toHaveAttribute("method", "post");
    // The PIN form is still on top.
    expect(screen.getByPlaceholderText("••••")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();
  });

  it("signs in with values written straight onto the boxes (secure fill: no key or change event)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: "ai-tok" }) });
    vi.stubGlobal("fetch", fetchMock);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderLogin({ pathname: "/login" });

    const { username, password } = credentialBoxes();
    nativeSet(username, "grok-admin");
    nativeSet(password, "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Landed on home")).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ username: "grok-admin", password: "correct horse battery" });
    expect(setItem).toHaveBeenCalledWith("rce_token", "ai-tok");
  });

  it("returns to the page the visit was bounced from, like the PIN does", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: "t" }) }));
    renderLogin({
      pathname: "/login",
      state: { from: { pathname: "/purchasing", search: "", hash: "" } },
    });
    const { username, password } = credentialBoxes();
    nativeSet(username, "u");
    nativeSet(password, "p");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Landed on purchasing")).toBeInTheDocument();
  });

  it("shows the server's message when the username or password is refused, and stores no token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Invalid username or password" }) }),
    );
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderLogin({ pathname: "/login" });
    const { username, password } = credentialBoxes();
    nativeSet(username, "grok-admin");
    nativeSet(password, "wrong");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Invalid username or password")).toBeInTheDocument();
    expect(setItem).not.toHaveBeenCalledWith("rce_token", expect.anything());
  });

  it("never puts the credentials in a URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: "t" }) });
    vi.stubGlobal("fetch", fetchMock);
    renderLogin({ pathname: "/login" });
    const { username, password } = credentialBoxes();
    nativeSet(username, "grok-admin");
    nativeSet(password, "s3cret-value");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Landed on home");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).not.toContain("grok-admin");
    expect(url).not.toContain("s3cret-value");
    expect(url).not.toContain("?");
  });
});
