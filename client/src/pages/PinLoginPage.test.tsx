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
