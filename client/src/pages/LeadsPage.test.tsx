/**
 * LeadsPage render smoke test (Phase A, 2026-09-20 "drawers and tab purpose"
 * plan). Leads GAINS campaign membership under that plan's tab-purpose table —
 * this pins that a lead card renders its campaign badge from
 * `campaignLeadMembership`.
 *
 * Since 2026-09-21 (Phase 6) the card SHOWS and the drawer ACTS: joining the
 * campaign, like every other lead action, is in the lead drawer (pinned by
 * LeadDrawer.test.tsx), so the card carries the on-campaign chip and an Open
 * button and no action buttons of its own.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { LeadsPage } from "./LeadsPage";
import { api } from "../lib/api";
import type { Lead } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const leads: Lead[] = [
  {
    id: "lead-1",
    name: "Jane Homeowner",
    email: "jane@example.com",
    phone: "+16155551234",
    source: "web",
    status: "new",
    leadStatus: "unresolved",
    notes: null,
    address: null,
    addressLine1: "12 Main St",
    city: "Smyrna",
    state: "TN",
    postalCode: "37167",
    jobType: "Panel upgrade",
    createdAt: "2026-09-15T12:00:00.000Z",
    updatedAt: "2026-09-15T12:00:00.000Z",
  },
];

const noFollowUps = {
  asOf: "2026-09-20T12:00:00.000Z",
  openLeadCount: 1, overdueCount: 0, dueTodayCount: 0, dueNext7DaysCount: 0, noFollowUpCount: 0, overdueLeads: [],
};

describe("LeadsPage", () => {
  it("opens with its own attention strip — overdue follow-ups from /crm/analytics/follow-ups (2026-09-20)", async () => {
    vi.spyOn(api, "leads").mockResolvedValue(leads);
    vi.spyOn(api, "campaignLeadMembership").mockResolvedValue({ leadIds: [] });
    vi.spyOn(api, "crmFollowUps").mockResolvedValue({
      ...noFollowUps,
      overdueCount: 1, dueTodayCount: 2, noFollowUpCount: 3,
      overdueLeads: [
        { id: "lead-9", name: "Ollie Overdue", phone: "+16155559999", source: "phone", jobType: "EV charger", leadStatus: "no_answer", status: "contacted", followUpDate: "2026-09-15T00:00:00.000Z" },
      ],
    });

    renderWithProviders(<LeadsPage />);

    const strip = await screen.findByRole("region", { name: /needs attention/i });
    expect(within(strip).getByText("1 follow-up overdue")).toBeInTheDocument();
    expect(within(strip).getByText("2 due today")).toBeInTheDocument();
    expect(within(strip).getByText("3 open with no follow-up date")).toBeInTheDocument();
    expect(within(strip).getByText(/Ollie Overdue — follow-up was due/)).toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: "Open" })).toBeInTheDocument();
  });

  it("renders the open queue with the drawer door and no card-side actions", async () => {
    vi.spyOn(api, "leads").mockResolvedValue(leads);
    vi.spyOn(api, "campaignLeadMembership").mockResolvedValue({ leadIds: [] });
    vi.spyOn(api, "crmFollowUps").mockResolvedValue(noFollowUps);

    renderWithProviders(<LeadsPage />);

    expect(screen.getByText("Leads")).toBeInTheDocument();
    expect(await screen.findByText("Jane Homeowner")).toBeInTheDocument();
    expect(screen.getByText("12 Main St, Smyrna, TN 37167")).toBeInTheDocument();
    // Not on the campaign — no chip; and the actions are the drawer's, not the card's.
    expect(screen.queryByText(/on email campaign/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /email campaign/i })).not.toBeInTheDocument();
    for (const gone of [/mark contacted/i, /^schedule$/i, /convert only/i, /mark lost/i, /^delete$/i]) {
      expect(screen.queryByRole("button", { name: gone })).not.toBeInTheDocument();
    }
    // The card's drawer door — by its data attribute, because the "Open" pipeline tab is a
    // button called Open too.
    expect(document.querySelectorAll('[data-open-drawer="lead"]')).toHaveLength(1);
  });

  it("shows the on-campaign chip once the lead is a member", async () => {
    vi.spyOn(api, "leads").mockResolvedValue(leads);
    vi.spyOn(api, "campaignLeadMembership").mockResolvedValue({ leadIds: ["lead-1"] });
    vi.spyOn(api, "crmFollowUps").mockResolvedValue(noFollowUps);

    renderWithProviders(<LeadsPage />);

    expect(await screen.findByText(/on email campaign/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\+ email campaign/i })).not.toBeInTheDocument();
  });
});
