/**
 * The Messages entry in the nav (work order agent-team, U3): a sidebar link with a badge of unread
 * messages plus the approvals this session may act on, and on a phone an entry in the More sheet whose
 * count joins More's badge (the bar itself never grows - Kyle, 2026-09-10).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { badge } from "../test/hubFixtures";
import { AppShell } from "./AppShell";
import { api } from "../lib/api";
import type { Lead } from "../lib/types";

afterEach(() => vi.restoreAllMocks());

describe("AppShell: the Messages badge", () => {
  it("shows the count beside Messages in the sidebar and adds it to More's badge on a phone", async () => {
    vi.spyOn(api, "leads").mockResolvedValue([{ id: "l-1" }, { id: "l-2" }] as unknown as Lead[]);
    vi.spyOn(api, "hubBadge").mockResolvedValue(badge({ unread: 3, needsApproval: 2, total: 5 }));

    const { container } = renderWithProviders(<AppShell><p>page</p></AppShell>);
    const aside = container.querySelector("aside") as HTMLElement;
    const link = within(aside).getByRole("link", { name: /^Messages/ });
    await waitFor(() => expect(link).toHaveTextContent("5"));
    // Leads keeps its own count.
    expect(within(aside).getByRole("link", { name: /^Leads/ })).toHaveTextContent("2");

    // More carries leads (2) + messages (5): both live in the sheet.
    const phoneNav = container.querySelector("nav") as HTMLElement;
    const more = within(phoneNav).getByRole("button", { name: /more/i });
    await waitFor(() => expect(more).toHaveTextContent("7"));
    fireEvent.click(more);
    const sheet = await screen.findByRole("dialog", { name: /more/i });
    expect(within(sheet).getByRole("link", { name: /^Messages/ })).toHaveTextContent("5");
  });

  it("shows no count when nothing is unread or waiting", async () => {
    vi.spyOn(api, "leads").mockResolvedValue([]);
    const spy = vi.spyOn(api, "hubBadge").mockResolvedValue(badge());
    const { container } = renderWithProviders(<AppShell><p>page</p></AppShell>);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const aside = container.querySelector("aside") as HTMLElement;
    expect(within(aside).getByRole("link", { name: "Messages" })).toBeInTheDocument();
  });
});
