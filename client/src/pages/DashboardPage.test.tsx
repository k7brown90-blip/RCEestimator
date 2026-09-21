/**
 * DashboardPage render tests (Phase F, 2026-09-20 "drawers and tab purpose" plan).
 *
 * The Dashboard used to show ONE headline "Win Rate" that was won leads / (won + lost leads) —
 * phase 1 data wearing a phase 3 label. It now shows four measures, and these tests pin that each
 * one renders its OWN numerator and denominator, that the two loss-reason lists stay two lists
 * over two populations, and that a platform with no tag reads "Unknown" rather than being dropped.
 *
 * The fixture is the plan's worked example: 10 leads from two platforms plus one untagged, 4 of
 * them opportunities, 6 quoted, and 8 presented quotes of which 5 signed, 2 lost, 1 still out —
 * with one draft and one void sitting OUTSIDE the rate.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { DashboardPage } from "./DashboardPage";
import { api } from "../lib/api";
import type { CrmOverview } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const range = { startDate: "2026-08-19", endDate: "2026-09-18", start: "2026-08-19", end: "2026-09-18" };

const overview: CrmOverview = {
  generatedAt: "2026-09-18T12:00:00.000Z",
  funnel: {
    range,
    total: 12,
    openCount: 5,
    opportunityCount: 4,
    lostCount: 3,
    stages: [{ status: "new", count: 5, percent: 42 }],
  },
  followUps: {
    asOf: "2026-09-18T12:00:00.000Z",
    openLeadCount: 5,
    overdueCount: 2,
    dueTodayCount: 1,
    dueNext7DaysCount: 3,
    noFollowUpCount: 0,
    overdueLeads: [
      { id: "lead-1", name: "Jane Overdue", source: "web", jobType: "Panel upgrade", leadStatus: "unresolved", status: "new", followUpDate: "2026-09-10T00:00:00.000Z" },
    ],
  },
  phases: {
    range,
    opportunity: {
      leads: 10,
      opportunities: 4,
      lost: 3,
      open: 3,
      notLeads: 2,
      rate: 40,
      byPlatform: [
        { platform: "google", leads: 6, opportunities: 3, lost: 1, quoted: 4, opportunityRate: 50 },
        { platform: "yelp", leads: 3, opportunities: 1, lost: 2, quoted: 2, opportunityRate: 33 },
        { platform: "unknown", leads: 1, opportunities: 0, lost: 0, quoted: 0, opportunityRate: 0 },
      ],
      lostReasons: { trust: 2, unrecorded: 1 },
    },
    quoted: { leads: 10, quoted: 6, rate: 60 },
    winRate: {
      issued: 8,
      contracted: 5,
      lost: 2,
      open: 1,
      unsent: 1,
      voided: 1,
      rate: 63,
      lostReasons: { price: 2 },
    },
    retention: {
      accounts: 20,
      payingAccounts: 12,
      repeatAccounts: 4,
      lifetimeCollected: 48250.5,
      averagePerPayingAccount: 4020.88,
      newsletter: { reachable: 15, unsubscribed: 2, noEmail: 3 },
      byPlatform: [
        { platform: "google", accounts: 9, payingAccounts: 6, repeatAccounts: 3, collected: 30000 },
      ],
      topAccounts: [
        { id: "acct-1", name: "Godwin", platform: "google", collected: 18250.5, signedInvoices: 3 },
        { id: "acct-2", name: "Daughdrill", platform: null, collected: 9000, signedInvoices: 1 },
      ],
    },
  },
};

describe("DashboardPage", () => {
  it("shows all four phases, each with its own numerator and denominator", async () => {
    vi.spyOn(api, "crmOverview").mockResolvedValue(overview);

    renderWithProviders(<DashboardPage />);

    expect(screen.getByText("CRM Dashboard")).toBeInTheDocument();
    expect(await screen.findByText("Lead → account")).toBeInTheDocument();
    expect(screen.getByText("Lead → estimate")).toBeInTheDocument();
    expect(screen.getByText("Estimate → job (THE win rate)")).toBeInTheDocument();
    expect(screen.getByText("Account → repeat")).toBeInTheDocument();

    // Every rate states both of its numbers, which is the whole point of the rebuild.
    expect(screen.getByText("40%")).toBeInTheDocument();
    expect(screen.getByText("4 of 10")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByText("6 of 10")).toBeInTheDocument();
    expect(screen.getByText("63%")).toBeInTheDocument();
    expect(screen.getByText("5 of 8")).toBeInTheDocument();
    // Phase 4's headline is money collected, and its pair is repeat / paying accounts.
    expect(screen.getAllByText("$48,250.50").length).toBeGreaterThan(0);
    expect(screen.getByText("4 of 12")).toBeInTheDocument();
  });

  it("keeps the two loss questions apart", async () => {
    vi.spyOn(api, "crmOverview").mockResolvedValue(overview);

    renderWithProviders(<DashboardPage />);

    const leadLosses = (await screen.findByText("Leads that never became an account (3)")).closest("div")!;
    const quoteLosses = screen.getByText("Quotes lost after we priced them (2)").closest("div")!;

    // "trust" belongs to the lead population, "price" to the quote population — never merged.
    expect(within(leadLosses).getByText("trust")).toBeInTheDocument();
    expect(within(leadLosses).getByText("no reason recorded")).toBeInTheDocument();
    expect(within(leadLosses).queryByText("price")).not.toBeInTheDocument();
    expect(within(quoteLosses).getByText("price")).toBeInTheDocument();
    expect(within(quoteLosses).queryByText("trust")).not.toBeInTheDocument();
  });

  it("reads phase 1 by platform, and shows an untagged lead as Unknown", async () => {
    vi.spyOn(api, "crmOverview").mockResolvedValue(overview);

    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText("Where the leads came from")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Google")).toBeInTheDocument();
    expect(within(table).getByText("Yelp")).toBeInTheDocument();
    expect(within(table).getByText("Unknown")).toBeInTheDocument();
    expect(within(table).getByText("50%")).toBeInTheDocument();
  });

  it("still surfaces overdue follow-ups and the accounts that came back", async () => {
    vi.spyOn(api, "crmOverview").mockResolvedValue(overview);

    renderWithProviders(<DashboardPage />);

    expect(await screen.findByText("Follow-up Risk")).toBeInTheDocument();
    expect(screen.getByText("Jane Overdue")).toBeInTheDocument();
    expect(screen.getByText("Accounts and repeat work")).toBeInTheDocument();
    expect(screen.getByText("Godwin")).toBeInTheDocument();
    // An account with no platform still lists, labelled Unknown rather than hidden.
    expect(screen.getByText(/Unknown • 1 signed/)).toBeInTheDocument();
  });
});
