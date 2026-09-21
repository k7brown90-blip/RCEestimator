/**
 * Global search in the shell (2026-09-20, drawers plan Phase 5).
 *
 * Pins: the trigger is reachable from BOTH the desktop sidebar and the phone strip and from
 * Ctrl+K; the input lives inside the results drawer and is focused on open; one request per
 * pause in typing, none under two characters; a result with a drawer opens it by adding ONLY its
 * key to the URL and leaves the results panel open beneath; an account result navigates to its
 * page and the panel closes; and the empty state says so.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useLocation } from "react-router-dom";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { AppShell } from "./AppShell";
import { GlobalSearchPanel } from "./GlobalSearch";
import { api } from "../lib/api";
import type { SearchResponse } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <p data-testid="location">{pathname}{search}</p>;
}

const response: SearchResponse = {
  q: "godwin", per: 5, indexed: true, more: { lead: true },
  results: [
    { kind: "po", id: "po-1", title: "PO-2026-0021 — Home Depot", subtitle: "108 Maple Dr", status: "purchased", match: "number", drawer: { kind: "po", id: "po-1" }, href: null, at: "2026-09-18T12:00:00.000Z" },
    { kind: "account", id: "cust-1", title: "Jane Godwin", subtitle: "(615) 555-0101", status: null, match: "text", drawer: null, href: "/accounts/cust-1", at: "2026-09-18T12:00:00.000Z" },
  ],
};
const nothing: SearchResponse = { q: "zzqq", per: 5, indexed: true, more: {}, results: [] };

describe("search in the shell", () => {
  it("is reachable from the sidebar and the phone strip, opens a drawer with the input focused, and closes on Escape", async () => {
    vi.spyOn(api, "leads").mockResolvedValue([]);
    vi.spyOn(api, "search").mockResolvedValue(nothing);
    const { container } = renderWithProviders(<AppShell><p>page content</p></AppShell>, { route: "/jobs" });
    await waitFor(() => expect(api.leads).toHaveBeenCalled());

    const triggers = screen.getAllByRole("button", { name: "Search" });
    expect(triggers).toHaveLength(2);
    // One on the dark rail, one above the page — never in the phone bar (five tabs and More).
    expect(within(container.querySelector("aside") as HTMLElement).getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(within(container.querySelector("nav") as HTMLElement).queryByRole("button", { name: "Search" })).toBeNull();

    fireEvent.click(triggers[1]);
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    const input = within(dialog).getByRole("searchbox", { name: "Search" });
    expect(input).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument();
  });

  it("opens on Ctrl+K", async () => {
    vi.spyOn(api, "leads").mockResolvedValue([]);
    renderWithProviders(<AppShell><p>page content</p></AppShell>, { route: "/calendar" });
    await waitFor(() => expect(api.leads).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Search" })).toBeInTheDocument();
  });
});

describe("the results panel", () => {
  it("asks once per pause, never under two characters, and renders the results in the server's order", async () => {
    const search = vi.spyOn(api, "search").mockResolvedValue(response);
    renderWithProviders(<><GlobalSearchPanel onClose={() => {}} /><LocationProbe /></>, { route: "/jobs?archived=1" });

    const input = screen.getByRole("searchbox", { name: "Search" });
    fireEvent.change(input, { target: { value: "g" } });
    await new Promise((r) => setTimeout(r, 320));
    expect(search).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "god" } });
    fireEvent.change(input, { target: { value: "godwin" } });
    await waitFor(() => expect(search).toHaveBeenCalledWith("godwin"));
    expect(search).toHaveBeenCalledTimes(1);

    const rows = await screen.findAllByRole("button", { name: /PO-2026-0021|Jane Godwin/ });
    expect(rows.map((r) => r.getAttribute("data-search-result"))).toEqual(["po", "account"]);
    expect(rows[0]).toHaveTextContent("P.O.");
    expect(rows[0]).toHaveTextContent("purchased");
    expect(rows[1]).toHaveTextContent("Account");
    expect(screen.getByText(/More leads than shown/)).toBeInTheDocument();
  });

  it("a result with a drawer adds only its key to the URL and keeps the results open beneath", async () => {
    vi.spyOn(api, "search").mockResolvedValue(response);
    const onClose = vi.fn();
    renderWithProviders(<><GlobalSearchPanel onClose={onClose} /><LocationProbe /></>, { route: "/jobs?archived=1" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "godwin" } });
    fireEvent.click(await screen.findByRole("button", { name: /PO-2026-0021/ }));

    expect(screen.getByTestId("location")).toHaveTextContent("/jobs?archived=1&po=po-1");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Search" })).toBeInTheDocument();
  });

  it("an account result navigates to its page and closes the panel; Enter takes the first result", async () => {
    vi.spyOn(api, "search").mockResolvedValue(response);
    const onClose = vi.fn();
    renderWithProviders(<><GlobalSearchPanel onClose={onClose} /><LocationProbe /></>, { route: "/jobs" });
    const input = screen.getByRole("searchbox", { name: "Search" });
    fireEvent.change(input, { target: { value: "godwin" } });
    fireEvent.click(await screen.findByRole("button", { name: /Jane Godwin/ }));
    expect(screen.getByTestId("location")).toHaveTextContent("/accounts/cust-1");
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("location")).toHaveTextContent("/accounts/cust-1?po=po-1");
  });

  it("says when nothing matches", async () => {
    vi.spyOn(api, "search").mockResolvedValue(nothing);
    renderWithProviders(<GlobalSearchPanel onClose={() => {}} />, { route: "/jobs" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "zzqq" } });
    expect(await screen.findByText("Nothing matches “zzqq”.")).toBeInTheDocument();
  });
});
