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
import { fireEvent, screen, within } from "@testing-library/react";
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
    receivedAt: "2026-09-15T12:00:00.000Z",
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

  it("shows an overdue follow-up as the day that was entered, not the evening before (B2)", async () => {
    // The old writer stored a bare date as midnight UTC, which Chicago reads as the previous
    // evening. CI runs in UTC where that bug is invisible, so the zone is set explicitly.
    const zone = process.env.TZ;
    process.env.TZ = "America/Chicago";
    try {
      vi.spyOn(api, "leads").mockResolvedValue(leads);
      vi.spyOn(api, "campaignLeadMembership").mockResolvedValue({ leadIds: [] });
      vi.spyOn(api, "crmFollowUps").mockResolvedValue({
        ...noFollowUps,
        overdueCount: 2,
        overdueLeads: [
          { id: "lead-8", name: "Midnight Mike", phone: null, source: "manual", jobType: null, leadStatus: "new", status: "new", followUpDate: "2026-11-15T00:00:00.000Z" },
          { id: "lead-9", name: "Noon Nora", phone: null, source: "phone", jobType: null, leadStatus: "new", status: "new", followUpDate: "2026-11-15T12:00:00.000Z" },
        ],
      });

      renderWithProviders(<LeadsPage />);

      const strip = await screen.findByRole("region", { name: /needs attention/i });
      expect(within(strip).getByText(/Midnight Mike — follow-up was due 11\/15\/2026/)).toBeInTheDocument();
      expect(within(strip).getByText(/Noon Nora — follow-up was due 11\/15\/2026/)).toBeInTheDocument();
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
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

  it("Received reads the day the lead arrived, not the day it was typed in (F3)", async () => {
    vi.spyOn(api, "leads").mockResolvedValue([
      // Typed in 11/14 at 9:57 PM Chicago (03:57Z the next UTC day); arrived on Angi 10/20.
      { ...leads[0], id: "lead-angi", name: "Jim Robinson", createdAt: "2026-11-15T03:57:00.000Z", receivedAt: "2026-10-20T12:00:00.000Z" },
      // A webhook lead: receivedAt is the real moment, 9:57 PM Chicago on 11/14 = 11/15 in UTC.
      { ...leads[0], id: "lead-web", name: "Wendy Webform", createdAt: "2026-11-15T03:57:00.000Z", receivedAt: "2026-11-15T03:57:00.000Z" },
    ]);
    vi.spyOn(api, "campaignLeadMembership").mockResolvedValue({ leadIds: [] });
    vi.spyOn(api, "crmFollowUps").mockResolvedValue(noFollowUps);

    renderWithProviders(<LeadsPage />);

    const angi = (await screen.findByText("Jim Robinson")).closest(".card") as HTMLElement;
    expect(within(angi).getByText("Received 10/20/2026")).toBeInTheDocument();
    const web = screen.getByText("Wendy Webform").closest(".card") as HTMLElement;
    expect(within(web).getByText("Received 11/14/2026")).toBeInTheDocument();
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

/**
 * "Search leads…" (F1, Kyle 2026-11-15): one box over Open AND Closed, each card tagged with its
 * tab, and an empty box leaves the tab view exactly as it was.
 */
describe("LeadsPage — Search leads…", () => {
  const openLead: Lead = {
    ...leads[0], id: "lead-open", name: "Olive Open", phone: "6155550101", email: "olive@example.com",
    addressLine1: null, city: null, postalCode: null, address: "88 Elm St, Franklin TN 37064",
  };
  const closedLead: Lead = {
    ...leads[0], id: "lead-closed", name: "Carl Closed", phone: "+16155559999", email: null, status: "lost",
    leadStatus: "lost", lostReason: "price", addressLine1: "5 Oak Ave", city: "Nolensville", postalCode: "37135",
  };

  /** api.leads answers per pipeline, the way the server does — never one list for every call. */
  function mockLists() {
    const spy = vi.spyOn(api, "leads").mockImplementation(async (params) => {
      const pipeline = typeof params === "object" ? params.pipeline : undefined;
      if (pipeline === "closed") return [closedLead];
      if (pipeline === "open") return [openLead];
      return [openLead, closedLead];
    });
    vi.spyOn(api, "campaignLeadMembership").mockResolvedValue({ leadIds: [] });
    vi.spyOn(api, "crmFollowUps").mockResolvedValue(noFollowUps);
    return spy;
  }

  const box = () => screen.getByPlaceholderText("Search leads…");
  const tabOf = (name: string) =>
    (screen.getByText(name).closest(".card") as HTMLElement).querySelector("[data-lead-tab]")?.getAttribute("data-lead-tab");

  it("is on the page from the first paint — even when the Open tab is empty", async () => {
    vi.spyOn(api, "leads").mockResolvedValue([]);
    vi.spyOn(api, "campaignLeadMembership").mockResolvedValue({ leadIds: [] });
    vi.spyOn(api, "crmFollowUps").mockResolvedValue(noFollowUps);
    renderWithProviders(<LeadsPage />);
    expect(box()).toBeInTheDocument();
    expect(await screen.findByText("Nothing waiting — the queue is clear.")).toBeInTheDocument();
  });

  it("finds a lead on each tab by name and tags the card Open or Closed", async () => {
    mockLists();
    renderWithProviders(<LeadsPage />);
    await screen.findByText("Olive Open");

    // Both names contain an "o"; one letter would be too loose a test, so search the shared word.
    fireEvent.change(box(), { target: { value: "o" } });
    expect(await screen.findByText("Carl Closed")).toBeInTheDocument();
    expect(screen.getByText("Olive Open")).toBeInTheDocument();
    expect(tabOf("Olive Open")).toBe("open");
    expect(tabOf("Carl Closed")).toBe("closed");
    // The tab buttons and status chips step aside — search covers both tabs.
    expect(screen.queryByRole("button", { name: "Contacted" })).not.toBeInTheDocument();
    expect(screen.getByText(/Searching Open and Closed together/)).toBeInTheDocument();
  });

  it("matches a phone typed in another format, on either tab", async () => {
    mockLists();
    renderWithProviders(<LeadsPage />);
    fireEvent.change(box(), { target: { value: "(615) 555-9999" } });
    expect(await screen.findByText("Carl Closed")).toBeInTheDocument();
    expect(screen.queryByText("Olive Open")).not.toBeInTheDocument();

    fireEvent.change(box(), { target: { value: "615-555-0101" } });
    expect(await screen.findByText("Olive Open")).toBeInTheDocument();
    expect(screen.queryByText("Carl Closed")).not.toBeInTheDocument();
  });

  it("matches email, the free-text address, and city / ZIP", async () => {
    mockLists();
    renderWithProviders(<LeadsPage />);
    fireEvent.change(box(), { target: { value: "OLIVE@example.com" } });
    expect(await screen.findByText("Olive Open")).toBeInTheDocument();

    fireEvent.change(box(), { target: { value: "88 elm" } });
    expect(await screen.findByText("Olive Open")).toBeInTheDocument();
    expect(screen.queryByText("Carl Closed")).not.toBeInTheDocument();

    fireEvent.change(box(), { target: { value: "Nolensville" } });
    expect(await screen.findByText("Carl Closed")).toBeInTheDocument();
    fireEvent.change(box(), { target: { value: "37135" } });
    expect(await screen.findByText("Carl Closed")).toBeInTheDocument();
  });

  it("does not read a street number as a phone number", async () => {
    mockLists();
    renderWithProviders(<LeadsPage />);
    // "Apt 101" is not phone-shaped, and 555-0101 contains 0101 — it must not match Olive by phone.
    fireEvent.change(box(), { target: { value: "Apt 0101" } });
    expect(await screen.findByText("No leads match that search.")).toBeInTheDocument();
    // Fewer than four digits never matches a phone either.
    fireEvent.change(box(), { target: { value: "555" } });
    expect(await screen.findByText("No leads match that search.")).toBeInTheDocument();
  });

  it("an empty box puts the tab view back, and Clear search empties the box", async () => {
    const spy = mockLists();
    renderWithProviders(<LeadsPage />);
    await screen.findByText("Olive Open");
    fireEvent.change(box(), { target: { value: "carl" } });
    expect(await screen.findByText("Carl Closed")).toBeInTheDocument();
    expect(screen.queryByText("Olive Open")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(await screen.findByText("Olive Open")).toBeInTheDocument();
    expect(screen.queryByText("Carl Closed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Contacted" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-lead-tab]")).toHaveLength(0);
    // Both tabs were fetched by pipeline — never one unfiltered call (that would add scheduled leads).
    const pipelines = spy.mock.calls.map(([p]) => (typeof p === "object" ? p.pipeline : undefined));
    expect(pipelines).toContain("open");
    expect(pipelines).toContain("closed");
    expect(pipelines).not.toContain(undefined);
  });
});
