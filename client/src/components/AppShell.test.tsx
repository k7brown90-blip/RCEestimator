/**
 * AppShell render smoke test (Phase A, 2026-09-20 "drawers and tab purpose" plan).
 *
 * Pins the nav split Kyle asked for (2026-09-10): "THE PHONE BAR IS FIVE TABS
 * AND 'MORE' — IT NEVER GROWS." jsdom does not apply the `md:` breakpoint, so
 * BOTH the desktop `<aside>` and the phone `<nav>` are always in the DOM —
 * `hidden md:flex` / `md:hidden` only change what a real browser paints. That's
 * useful here: it means a single render lets this test check both layouts by
 * scoping into each container rather than needing two viewport sizes.
 *
 * Desktop sidebar (AppShell.tsx, the `nav` array): all 13 entries.
 * Phone bottom bar (MOBILE_PRIMARY/MOBILE_MORE split): exactly 5 links plus
 * the "More" button — adding a 6th nav entry must change the More sheet, never
 * grow the bar.
 *
 * Tab separation (2026-09-20): "Inventory" is "Purchasing & Stock" (route
 * /purchasing, shown as "Purchasing" on the phone bar), and it took the fifth
 * phone slot from Financials — the Purchases card Kyle uses at the counter
 * moved to it, so the slot followed the card.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { AppShell } from "./AppShell";
import { api } from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AppShell", () => {
  it("renders all 13 nav entries on the desktop sidebar and 5 primary + More on the phone bar", async () => {
    vi.spyOn(api, "leads").mockResolvedValue([]);

    const { container } = renderWithProviders(
      <AppShell>
        <p>page content</p>
      </AppShell>,
    );

    // The page's own content renders — the shell is not swallowing children.
    expect(screen.getByText("page content")).toBeInTheDocument();

    await waitFor(() => expect(api.leads).toHaveBeenCalled());

    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    const desktopLinks = within(aside as HTMLElement).getAllByRole("link");
    expect(desktopLinks).toHaveLength(13);
    expect(desktopLinks.map((a) => a.textContent)).toContain("Financials");
    expect(desktopLinks.map((a) => a.textContent)).toContain("Campaigns");
    // Inventory became Purchasing & Stock (2026-09-20); the old label is gone from the sidebar.
    expect(desktopLinks.map((a) => a.textContent)).toContain("Purchasing & Stock");
    expect(desktopLinks.map((a) => a.textContent)).not.toContain("Inventory");
    expect(within(aside as HTMLElement).getByRole("link", { name: "Purchasing & Stock" })).toHaveAttribute("href", "/purchasing");

    const phoneNav = container.querySelector("nav");
    expect(phoneNav).not.toBeNull();
    const phoneLinks = within(phoneNav as HTMLElement).getAllByRole("link");
    expect(phoneLinks).toHaveLength(5);
    // MOBILE_PRIMARY is `nav.filter(item => item.primary)` — Dashboard and Leads are NOT marked
    // primary, so they live in More even though they're first in the array. The fifth slot is
    // Purchasing (its phone `short` label), not Financials, since 2026-09-20.
    expect(phoneLinks.map((a) => a.textContent)).toEqual([
      "Calendar",
      "Jobs",
      "Estimates",
      "Accounts",
      "Purchasing",
    ]);
    expect(phoneLinks[4]).toHaveAttribute("href", "/purchasing");
    // The 6th cell is the More button, never a 6th link — the bar's column count
    // never follows the nav array's length (Kyle, 2026-09-10).
    expect(within(phoneNav as HTMLElement).getByRole("button", { name: /more/i })).toBeInTheDocument();
  });

  it("opens the More sheet with the remaining entries, and it closes on route change", async () => {
    vi.spyOn(api, "leads").mockResolvedValue([]);
    renderWithProviders(
      <AppShell>
        <p>page content</p>
      </AppShell>,
    );
    await waitFor(() => expect(api.leads).toHaveBeenCalled());

    const moreButton = screen.getByRole("button", { name: /more/i });
    moreButton.click();

    const sheet = await screen.findByRole("dialog", { name: /more/i });
    // Everything not in the phone's primary 5 lives here — 13 total minus 5 primary.
    expect(within(sheet).getAllByRole("link")).toHaveLength(8);
    expect(within(sheet).getByRole("link", { name: /^dashboard$/i })).toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: /^price book$/i })).toBeInTheDocument();
    // Financials gave its phone slot to Purchasing & Stock (2026-09-20) and lives here now.
    expect(within(sheet).getByRole("link", { name: /^financials$/i })).toBeInTheDocument();
  });
});
