/**
 * CalendarPage render test (tab separation, 2026-09-20 — PUNCHLIST C9, "two month calendars
 * against two endpoints, one rendering inside a modal on top of the other").
 *
 * Pins the fix: scheduling from this page opens the scheduler INLINE under the page's own
 * month grid, the page's grid is the date picker, and the scheduler draws no grid of its own
 * and never fetches `/crm/schedule/month` — one grid, one endpoint.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useLocation } from "react-router-dom";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { CalendarPage } from "./CalendarPage";
import { api } from "../lib/api";
import type { CalendarAppointment, CalendarSchedule, Visit } from "../lib/types";

function SearchProbe() {
  const { search } = useLocation();
  return <p data-testid="search">{search}</p>;
}

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

/**
 * ?schedule=<id> redirect (plan 2026-10-01, item E1 — "Book consultation ... does not let me
 * schedule the consultation"). This is the door `AccountDetailPage.tsx`'s "Book consultation"
 * button lands on: it creates the visit, then navigates to `/calendar?schedule=<visit.id>`, and
 * this effect (CalendarPage.tsx:94-117) is supposed to find it and open the picker unprompted.
 *
 * Investigated 2026-10-01: could not reproduce a defect in this mechanism against current
 * source. These three tests pin the exact claims the architect could not verify by reading
 * alone, and were mutation-checked against the pre-fix code each guards (see the dispatch
 * report) — reverting either guarded line fails the matching test below.
 */
describe("?schedule= redirect — the 'Book consultation' door", () => {
  const freshConsult = {
    visitId: "visit-new-consult",
    customerId: "acct-1",
    customerName: "Fresh Consult",
    propertyId: "prop-1",
    address: "1 New St, Smyrna",
    status: "estimate",
    jobType: null,
    purpose: "Consultation — estimate visit",
    appointmentKind: "estimate",
    estimatedDurationDays: null,
    createdAt: "2026-09-29T12:00:00.000Z",
    depositSatisfied: null,
  };

  it("opens the FIRST-TIME schedule picker, never reschedule, for a freshly created unscheduled estimate visit", async () => {
    const withNewConsult: CalendarSchedule = { ...schedule, unscheduled: [freshConsult] } as CalendarSchedule;
    vi.spyOn(api, "calendarSchedule").mockResolvedValue(withNewConsult);
    vi.spyOn(api, "calendarAvailability").mockResolvedValue({ available_slots: [], current_time_central: "", current_date_central: "" });
    vi.spyOn(api, "monthSchedule").mockResolvedValue({ year: 2026, month: 9, days: [] } as unknown as Awaited<ReturnType<typeof api.monthSchedule>>);
    vi.spyOn(api, "techAvailability").mockResolvedValue({ date: "2026-09-20", techs: [] });

    renderWithProviders(<CalendarPage />, { route: "/calendar?schedule=visit-new-consult" });

    await screen.findByText("Fresh Consult");
    // "schedule" mode (first booking), never "reschedule" — a visit with scheduledStart null
    // must never land on the reschedule control (the "wrong scheduling mechanism" Kyle named).
    await waitFor(() => expect(screen.queryByText(/Pick a start date:/i)).toBeInTheDocument());
    expect(screen.queryByText(/Pick a new start date:/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^reschedule$/i })).not.toBeInTheDocument();
  });

  it("recovers from a stale cached month and still opens the picker (Cecilia Pesavento, 2026-09-03)", async () => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + 1;
    const rangeStart = `${year}-${pad(month)}-01`;
    const rangeEnd = `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`;
    const staleSchedule: CalendarSchedule = { start: rangeStart, end: rangeEnd, appointments: [], unscheduled: [], googleOnlyEvents: [] } as CalendarSchedule;
    const freshSchedule: CalendarSchedule = { ...staleSchedule, unscheduled: [freshConsult] } as CalendarSchedule;

    vi.spyOn(api, "calendarAvailability").mockResolvedValue({ available_slots: [], current_time_central: "", current_date_central: "" });
    vi.spyOn(api, "monthSchedule").mockResolvedValue({ year, month, days: [] } as unknown as Awaited<ReturnType<typeof api.monthSchedule>>);
    vi.spyOn(api, "techAvailability").mockResolvedValue({ date: "2026-09-20", techs: [] });
    // First resolution (the cached month a prior /calendar visit left behind) has no new
    // visit; the retry's refetch is what lands it.
    const calSpy = vi.spyOn(api, "calendarSchedule").mockResolvedValueOnce(staleSchedule).mockResolvedValue(freshSchedule);

    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { MemoryRouter } = await import("react-router-dom");
    const { render } = await import("@testing-library/react");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 }, mutations: { retry: false } } });
    queryClient.setQueryData(["calendar", rangeStart, rangeEnd], staleSchedule);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/calendar?schedule=visit-new-consult"]}>
          <CalendarPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(calSpy).toHaveBeenCalledTimes(2));
    await screen.findByText("Fresh Consult");
    await waitFor(() => expect(screen.queryByText(/Pick a start date:/i)).toBeInTheDocument());
  });
});

/**
 * ONE SCHEDULER (2026-10-01, plan item E3). The job drawer, the visit workspace and the lead
 * drawer gave up their inline `JobScheduler`; their "Reschedule or cancel on the Calendar" door
 * arrives here as `?schedule=<visitId>`. Before this change the effect looked only in the month
 * on screen, so a job booked NEXT month opened nothing — the door would have led to a blank
 * calendar, which is the hole CLAUDE.md's click-through rule 5 forbids. These pin the receive
 * side: the grid moves to the job's month and opens the reschedule picker; a visit that cannot
 * be scheduled says why instead of being silently consumed.
 */
describe("?schedule= for a job the month on screen does not hold", () => {
  const pad = (n: number) => String(n).padStart(2, "0");
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const today = new Date();
  const thisYear = today.getFullYear();
  const thisMonth = today.getMonth() + 1;
  const nextMonth = thisMonth === 12 ? 1 : thisMonth + 1;
  const nextYear = thisMonth === 12 ? thisYear + 1 : thisYear;
  const nextStart = `${nextYear}-${pad(nextMonth)}-01`;
  // 18:00Z is 1pm CDT / noon CST — the 15th in Central either way.
  const bookedStart = `${nextYear}-${pad(nextMonth)}-15T18:00:00.000Z`;
  const bookedEnd = `${nextYear}-${pad(nextMonth)}-15T20:00:00.000Z`;

  const booked = {
    visitId: "visit-booked",
    customerId: "acct-2",
    customerName: "Booked Next Month",
    propertyId: "prop-2",
    address: "9 Later Ln, Smyrna",
    status: "scheduled",
    jobType: "Panel upgrade",
    purpose: null,
    appointmentKind: "production",
    scheduledStart: bookedStart,
    scheduledEnd: bookedEnd,
    travelBufferMinutes: 0,
    estimatedDurationDays: 1,
    confirmationStatus: "pending",
    technicians: [],
  } as unknown as CalendarAppointment;

  const empty = (start: string, end: string): CalendarSchedule =>
    ({ start, end, appointments: [], unscheduled: [], googleOnlyEvents: [] }) as CalendarSchedule;

  function mockMonths() {
    vi.spyOn(api, "calendarAvailability").mockResolvedValue({ available_slots: [], current_time_central: "", current_date_central: "" });
    vi.spyOn(api, "monthSchedule").mockResolvedValue({ year: thisYear, month: thisMonth, days: [] } as unknown as Awaited<ReturnType<typeof api.monthSchedule>>);
    vi.spyOn(api, "techAvailability").mockResolvedValue({ date: bookedStart.slice(0, 10), techs: [] });
    return vi.spyOn(api, "calendarSchedule").mockImplementation((start, end) =>
      Promise.resolve(start === nextStart ? { ...empty(start, end), appointments: [booked] } : empty(start, end)),
    );
  }

  it("moves the grid to the job's month and opens the RESCHEDULE picker for it", async () => {
    const calSpy = mockMonths();
    vi.spyOn(api, "visit").mockResolvedValue({
      id: "visit-booked", propertyId: "prop-2", customerId: "acct-2", mode: "service_diagnostic", status: "scheduled",
      visitDate: "2026-09-10T12:00:00.000Z", scheduledStart: bookedStart, scheduledEnd: bookedEnd,
      customer: { id: "acct-2", name: "Booked Next Month" } as Visit["customer"],
    } as Visit);

    const { container } = renderWithProviders(<><CalendarPage /><SearchProbe /></>, { route: "/calendar?schedule=visit-booked" });

    // The month on screen does not hold it: one retry, then the lookup.
    await waitFor(() => expect(api.visit).toHaveBeenCalledWith("visit-booked"));
    // The grid moved to the job's month and fetched it.
    expect(await screen.findByText(`${MONTH_NAMES[nextMonth - 1]} ${nextYear}`)).toBeInTheDocument();
    await waitFor(() => expect(calSpy).toHaveBeenCalledWith(nextStart, expect.any(String)));
    // ...and the picker opened in reschedule mode, naming the job, with the param consumed.
    await waitFor(() => expect(screen.queryByText(/Pick a new start date:/i)).toBeInTheDocument());
    expect(container.querySelector("[data-scheduling-hint]")).toHaveTextContent(/Rescheduling Booked Next Month/);
    expect(within(container.querySelector("[data-scheduling-panel]") as HTMLElement).getByText("Booked Next Month")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent(""));
    // Still one grid.
    expect(screen.getAllByText("Sun")).toHaveLength(1);
    expect(screen.queryByText("Su")).not.toBeInTheDocument();
  });

  it("says why when the visit cannot be scheduled, instead of opening nothing", async () => {
    mockMonths();
    vi.spyOn(api, "visit").mockResolvedValue({
      id: "visit-gone", propertyId: "prop-2", customerId: "acct-2", mode: "service_diagnostic", status: "cancelled",
      visitDate: "2026-09-10T12:00:00.000Z", scheduledStart: null,
      customer: { id: "acct-2", name: "Gone Customer" } as Visit["customer"],
    } as Visit);

    const { container } = renderWithProviders(<><CalendarPage /><SearchProbe /></>, { route: "/calendar?schedule=visit-gone" });

    await waitFor(() => expect(api.visit).toHaveBeenCalledWith("visit-gone"));
    const miss = await waitFor(() => {
      const el = container.querySelector("[data-schedule-miss]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(miss).toHaveTextContent(/Gone Customer is not waiting to be scheduled/);
    expect(miss).toHaveTextContent(/"cancelled"/);
    expect(container.querySelector("[data-scheduling-panel]")).toBeNull();
    // The instruction was consumed, so back/refresh does not replay it.
    await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent(""));
    // Still this month — nothing to jump to.
    expect(screen.getByText(`${MONTH_NAMES[thisMonth - 1]} ${thisYear}`)).toBeInTheDocument();
  });
});
