/**
 * EstimatesPage render smoke test (Phase A, 2026-09-20 "drawers and tab
 * purpose" plan). This page is the chain view the plan's Estimates row builds
 * on ("GAINS mark-lost, resend, void, PDF (drawer)") — pins that the three
 * lifecycle buckets (Sent / Viewed / Sold) classify a row correctly today, so
 * Phase 2 (estimate lost) has a known-good baseline to add "Lost" beside.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { EstimatesPage } from "./EstimatesPage";
import { api } from "../lib/api";
import type { PbChainRow } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function row(overrides: Partial<PbChainRow>): PbChainRow {
  return {
    id: "est-1",
    number: "EST-2026-0001",
    revision: 1,
    status: "sent",
    title: "Panel upgrade",
    total: 4200,
    createdAt: "2026-09-10T12:00:00.000Z",
    sentAt: "2026-09-10T12:00:00.000Z",
    signedAt: null,
    signedChannel: null,
    account: { id: "acct-1", name: "Jane Homeowner", isTestAccount: false },
    serviceAddress: { id: "prop-1", name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN" },
    supersededBy: null,
    job: null,
    ...overrides,
  };
}

describe("EstimatesPage", () => {
  it("sections rows into Sent, Viewed and Sold", async () => {
    vi.spyOn(api, "estimateChain").mockResolvedValue({
      estimates: [
        row({ id: "e-sent", number: "EST-2026-0001", status: "sent" }),
        row({ id: "e-viewed", number: "EST-2026-0002", status: "viewed" }),
        row({ id: "e-sold", number: "EST-2026-0003", status: "signed", signedAt: "2026-09-12T12:00:00.000Z", job: { id: "job-1", status: "estimate", scheduledStart: null } }),
      ],
    });

    renderWithProviders(<EstimatesPage />);

    expect(screen.getByText("Estimates")).toBeInTheDocument();
    // The count sits in a nested <span>, so the accessible NAME (which flattens
    // descendant text) is the reliable match — a plain text query would need to
    // know the DOM splits "Sent" and "(1)" into separate nodes.
    expect(await screen.findByRole("heading", { name: "Sent (1)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Viewed (1)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sold (1)" })).toBeInTheDocument();
    expect(screen.getAllByText("Jane Homeowner")).toHaveLength(3);
  });

  it("gives lost estimates their own VISIBLE card, labelled with the reason (2026-09-20)", async () => {
    vi.spyOn(api, "estimateChain").mockResolvedValue({
      estimates: [
        row({ id: "e-sent", number: "EST-2026-0001", status: "sent" }),
        row({ id: "e-lost", number: "EST-2026-0004", status: "lost", lostAt: "2026-09-15T12:00:00.000Z", lostReason: "price" }),
        // Void stays hidden behind the Sent card's toggle — void and lost are different.
        row({ id: "e-void", number: "EST-2026-0005", status: "void" }),
      ],
    });

    renderWithProviders(<EstimatesPage />);

    expect(await screen.findByRole("heading", { name: "Lost (1)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sent (1)" })).toBeInTheDocument();
    expect(screen.getByText("lost — price")).toBeInTheDocument();
    expect(screen.queryByText("void")).not.toBeInTheDocument();
    expect(screen.getByText(/Show drafts \/ expired \/ void \(1\)/)).toBeInTheDocument();
  });

  it("opens with its own attention strip: bounced first, then quotes stale for 7+ days (2026-09-20)", async () => {
    const day = 24 * 60 * 60 * 1000;
    const daysAgo = (n: number) => new Date(Date.now() - n * day).toISOString();
    // PUNCHLIST H4: staleness is measured from createdAt now, not sentAt — these fixtures set
    // both to the same age (issued and sent the same day) so the scenario is unaffected by the
    // fix; the divergent case (issued long before it was sent) is its own test below.
    vi.spyOn(api, "estimateChain").mockResolvedValue({
      estimates: [
        // Fresh — sent yesterday. Not stale.
        row({ id: "e-fresh", number: "EST-2026-0001", status: "sent", createdAt: daysAgo(1), sentAt: daysAgo(1), account: { id: "a1", name: "Fresh Sent", isTestAccount: false } }),
        // Stale — sent 10 days ago, never opened.
        row({ id: "e-stale", number: "EST-2026-0002", status: "sent", createdAt: daysAgo(10), sentAt: daysAgo(10), account: { id: "a2", name: "Stale Sent", isTestAccount: false } }),
        // Opened 12 days ago, unsigned.
        row({ id: "e-viewed", number: "EST-2026-0003", status: "viewed", createdAt: daysAgo(12), sentAt: daysAgo(12), account: { id: "a3", name: "Stale Viewed", isTestAccount: false } }),
        // Bounced — never arrived, whatever its age.
        row({
          id: "e-bounced", number: "EST-2026-0004", status: "sent", createdAt: daysAgo(2), sentAt: daysAgo(2),
          account: { id: "a4", name: "Bounced Bob", isTestAccount: false },
          lastBounceAt: daysAgo(2), lastBounceReason: "mailbox full",
        }),
        // Bounced once, delivered since — resolved, not in the strip.
        row({
          id: "e-redelivered", number: "EST-2026-0005", status: "sent", createdAt: daysAgo(3), sentAt: daysAgo(3),
          account: { id: "a5", name: "Redelivered Rita", isTestAccount: false },
          lastBounceAt: daysAgo(3),
          lastDelivery: { provider: "resend", status: "delivered", statusAt: daysAgo(1), to: "rita@example.com", error: null, createdAt: daysAgo(1) },
        }),
      ],
    });

    renderWithProviders(<EstimatesPage />);

    const strip = await screen.findByRole("region", { name: /needs attention/i });
    expect(within(strip).getByText("1 never arrived (email bounced)")).toBeInTheDocument();
    expect(within(strip).getByText("1 sent, not opened in 7+ days")).toBeInTheDocument();
    expect(within(strip).getByText("1 opened, unsigned 7+ days")).toBeInTheDocument();
    const rowsText = within(strip).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(rowsText[0]).toMatch(/Bounced Bob/);
    expect(rowsText.some((t) => /Stale Sent/.test(t))).toBe(true);
    expect(rowsText.some((t) => /Stale Viewed/.test(t))).toBe(true);
    expect(rowsText.some((t) => /Fresh Sent|Redelivered Rita/.test(t))).toBe(false);
    // Each row carries the record's own drawer button.
    expect(within(strip).getAllByRole("button", { name: "Open" })).toHaveLength(3);
  });

  it("shows no strip when every quote is fresh and delivered", async () => {
    vi.spyOn(api, "estimateChain").mockResolvedValue({
      estimates: [row({ id: "e-fresh", status: "sent", createdAt: new Date().toISOString(), sentAt: new Date().toISOString() })],
    });

    renderWithProviders(<EstimatesPage />);

    expect(await screen.findByRole("heading", { name: "Sent (1)" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /needs attention/i })).not.toBeInTheDocument();
  });

  it("moves a signed-and-scheduled row off this page entirely — it belongs to Jobs", async () => {
    vi.spyOn(api, "estimateChain").mockResolvedValue({
      estimates: [
        row({
          id: "e-scheduled",
          status: "signed",
          signedAt: "2026-09-12T12:00:00.000Z",
          job: { id: "job-1", status: "scheduled", scheduledStart: "2026-09-20T12:00:00.000Z" },
        }),
      ],
    });

    renderWithProviders(<EstimatesPage />);

    expect(await screen.findByRole("heading", { name: "Sent (0)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sold (0)" })).toBeInTheDocument();
    expect(screen.queryByText("Jane Homeowner")).not.toBeInTheDocument();
  });

  it("PUNCHLIST A10: reads 'expired' from createdAt, the same clock the server's signature refusal uses — not sentAt", async () => {
    const day = 24 * 60 * 60 * 1000;
    const daysAgo = (n: number) => new Date(Date.now() - n * day).toISOString();
    vi.spyOn(api, "estimateChain").mockResolvedValue({
      estimates: [
        // Issued 31 days ago but only emailed 2 days ago — validDays 30. The OLD sentAt-based
        // rule read this as good for 28 more days; the server's createdAt-based rule (and the
        // signature refusal it backs) already considers it expired. The tracker must agree.
        row({ id: "e-stale-draft", number: "EST-2026-0009", status: "sent", createdAt: daysAgo(31), sentAt: daysAgo(2), validDays: 30 }),
        // A normal, still-live quote for contrast — issued and sent together, well inside 30 days.
        row({ id: "e-live", number: "EST-2026-0010", status: "sent", createdAt: daysAgo(5), sentAt: daysAgo(5), validDays: 30, account: { id: "a-live", name: "Live Sent", isTestAccount: false } }),
      ],
    });

    renderWithProviders(<EstimatesPage />);

    // Expired leaves the Sent count and sits behind the hidden toggle instead.
    expect(await screen.findByRole("heading", { name: "Sent (1)" })).toBeInTheDocument();
    expect(screen.getByText(/Show drafts \/ expired \/ void \(1\)/)).toBeInTheDocument();
    expect(screen.getByText("Live Sent")).toBeInTheDocument();
  });
});
