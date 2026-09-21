/**
 * CalendarPage render test (tab separation, 2026-09-20 — PUNCHLIST C9, "two month calendars
 * against two endpoints, one rendering inside a modal on top of the other").
 *
 * Pins the fix: scheduling from this page opens the scheduler INLINE under the page's own
 * month grid, the page's grid is the date picker, and the scheduler draws no grid of its own
 * and never fetches `/crm/schedule/month` — one grid, one endpoint.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { CalendarPage } from "./CalendarPage";
import { api } from "../lib/api";
import type { CalendarSchedule } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const schedule: CalendarSchedule = {
  start: "2026-09-01",
  end: "2026-09-30",
  appointments: [],
  unscheduled: [
    {
      visitId: "visit-sold",
      customerId: "acct-1",
      customerName: "Jane Sold",
      propertyId: "prop-1",
      address: "12 Main St, Smyrna",
      status: "contracted",
      jobType: "Panel upgrade",
      purpose: null,
      appointmentKind: "production",
      estimatedDurationDays: 1,
      createdAt: "2026-09-10T12:00:00.000Z",
      depositSatisfied: true,
    },
  ],
  googleOnlyEvents: [],
} as CalendarSchedule;

function mockEverything() {
  vi.spyOn(api, "calendarSchedule").mockResolvedValue(schedule);
  vi.spyOn(api, "calendarAvailability").mockResolvedValue({ available_slots: [], current_time_central: "", current_date_central: "" });
  vi.spyOn(api, "monthSchedule").mockResolvedValue({ year: 2026, month: 9, days: [] } as unknown as Awaited<ReturnType<typeof api.monthSchedule>>);
  vi.spyOn(api, "techAvailability").mockResolvedValue({ date: "2026-09-20", techs: [] });
}

describe("CalendarPage", () => {
  it("renders one month grid and the needs-booking rail", async () => {
    mockEverything();

    renderWithProviders(<CalendarPage />);

    expect(screen.getByText("Calendar")).toBeInTheDocument();
    expect(await screen.findByText("Jane Sold")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^schedule$/i })).toBeInTheDocument();
    // Exactly one grid: the page's ("Sun" headers), never the scheduler's ("Su" headers).
    expect(screen.getAllByText("Sun")).toHaveLength(1);
    expect(screen.queryByText("Su")).not.toBeInTheDocument();
  });

  it("schedules against the page's own grid — the scheduler opens inline with no second grid and no second month fetch (C9)", async () => {
    mockEverything();

    const { container } = renderWithProviders(<CalendarPage />);
    await screen.findByText("Jane Sold");

    fireEvent.click(screen.getByRole("button", { name: /^schedule$/i }));

    // Inline under the grid — not a modal over it — and the hint says what to do.
    const panel = container.querySelector("[data-scheduling-panel]");
    expect(panel).not.toBeNull();
    expect(within(panel as HTMLElement).getByText("Jane Sold")).toBeInTheDocument();
    expect(container.querySelector("[data-scheduling-hint]")).toHaveTextContent(/Scheduling Jane Sold/);
    expect(within(panel as HTMLElement).getByText(/Tap a day on the calendar above/)).toBeInTheDocument();
    // Still one grid.
    expect(screen.getAllByText("Sun")).toHaveLength(1);
    expect(screen.queryByText("Su")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Tap today on the page's grid: it becomes the start date in the panel.
    const today = new Date();
    const dayButton = screen.getByRole("button", { name: String(today.getDate()) });
    fireEvent.click(dayButton);
    expect(dayButton).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector("[data-picked-date]")).toHaveTextContent(/Start date:/);
    // The picked day drives the tech-availability check, so the confirm can proceed.
    await waitFor(() => expect(api.techAvailability).toHaveBeenCalled());

    // The scheduler never fetched its own month — the page's schedule is the only one.
    expect(api.monthSchedule).not.toHaveBeenCalled();

    // Close puts the grid back to browsing.
    fireEvent.click(within(panel as HTMLElement).getByRole("button", { name: /^close$/i }));
    expect(container.querySelector("[data-scheduling-panel]")).toBeNull();
  });
});
