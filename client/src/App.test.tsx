/**
 * PUNCHLIST C6: an unknown path inside the authenticated shell used to render an
 * empty card with no indication the URL was wrong and no way back — the app's
 * inner `<Routes>` (App.tsx) had no catch-all.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./test/renderWithProviders";
import App from "./App";
import { api } from "./lib/api";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("App", () => {
  it("renders a not-found card with a way home for an unknown path, instead of an empty shell", async () => {
    localStorage.setItem("rce_token", "test-token");
    vi.spyOn(api, "leads").mockResolvedValue([]);

    renderWithProviders(<App />, { route: "/this-route-does-not-exist" });

    await waitFor(() => expect(api.leads).toHaveBeenCalled());
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
  });
});
