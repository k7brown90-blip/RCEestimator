/**
 * "Schedule anyway" (2026-10-02).
 *
 * Kyle: "I want what I manually schedule in this system to take priority." A Google Calendar block
 * no longer ends the booking: the server names whose calendar is busy and says it can be booked over,
 * and the scheduler offers a button for exactly that — and only for exactly that. A 409 that is NOT a
 * calendar conflict (someone else booking the date, an end before the start) never offers it.
 *
 * Note: JobScheduler.oneHome.test.ts allows only pages/CalendarPage.tsx to IMPORT the component from
 * source; test files are excluded from that scan, so rendering it here does not add a host.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { JobScheduler } from "./JobScheduler";
import { api, ApiError } from "../lib/api";
import type { ScheduleJobResult } from "../lib/types";

const CONFLICT = "Michael Schramm's calendar is busy all day Wednesday, October 7";

function conflict409(message: string, canOverride: boolean): ApiError {
  return Object.assign(new ApiError(message), { status: 409, body: { error: message, conflicts: [], canOverride } });
}

const BOOKED = { jobId: "job-1" } as unknown as ScheduleJobResult;

afterEach(() => {
  vi.restoreAllMocks();
});

function renderScheduling() {
  vi.spyOn(api, "techAvailability").mockResolvedValue({ date: "2026-10-06", techs: [] });
  return renderWithProviders(
    <JobScheduler jobId="job-1" status="contracted" autoOpen pickedDate="2026-10-06" />,
    { route: "/calendar" },
  );
}

describe("Schedule anyway", () => {
  it("shows the named conflict in red with a 'Schedule anyway' button, which resends with the override", async () => {
    const schedule = vi.spyOn(api, "scheduleJob")
      .mockRejectedValueOnce(conflict409(CONFLICT, true))
      .mockResolvedValueOnce(BOOKED);
    renderScheduling();

    expect(screen.queryByRole("button", { name: "Schedule anyway" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    const message = await screen.findByText(CONFLICT);
    expect(message.className).toMatch(/text-red/);
    const anyway = screen.getByRole("button", { name: "Schedule anyway" });
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][1]).not.toHaveProperty("overrideCalendarConflict");

    fireEvent.click(anyway);
    await waitFor(() => expect(schedule).toHaveBeenCalledTimes(2));
    expect(schedule.mock.calls[1][1]).toMatchObject({
      startDate: "2026-10-06",
      startTime: "07:00",
      overrideCalendarConflict: true,
    });
    // Booked: the conflict and its button are gone.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Schedule anyway" })).not.toBeInTheDocument());
  });

  it("drops the override when the start time changes — the conflict described a different request", async () => {
    vi.spyOn(api, "scheduleJob").mockRejectedValueOnce(conflict409(CONFLICT, true));
    renderScheduling();

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(await screen.findByRole("button", { name: "Schedule anyway" })).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("07:00"), { target: { value: "08:00" } });
    expect(screen.queryByRole("button", { name: "Schedule anyway" })).not.toBeInTheDocument();
    expect(screen.queryByText(CONFLICT)).not.toBeInTheDocument();
  });

  it("offers no override for a 409 that is not a calendar conflict", async () => {
    vi.spyOn(api, "scheduleJob").mockRejectedValueOnce(
      conflict409("Another booking is in progress for 2026-10-06", false),
    );
    renderScheduling();

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    expect(await screen.findByText(/Another booking is in progress/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Schedule anyway" })).not.toBeInTheDocument();
  });

  it("says 'Reschedule anyway' when moving a booked job, and resends the same request with the override", async () => {
    const reschedule = vi.spyOn(api, "rescheduleJob")
      .mockRejectedValueOnce(conflict409(CONFLICT, true))
      .mockResolvedValueOnce({ jobId: "job-1" } as unknown as ScheduleJobResult);
    vi.spyOn(api, "techAvailability").mockResolvedValue({ date: "2026-10-06", techs: [] });
    renderWithProviders(
      <JobScheduler
        jobId="job-1"
        status="scheduled"
        scheduledStart="2026-10-01T14:00:00.000Z"
        scheduledEnd="2026-10-01T21:00:00.000Z"
        autoOpen
        pickedDate="2026-10-06"
      />,
      { route: "/calendar" },
    );

    fireEvent.change(screen.getByPlaceholderText("Reason for reschedule"), { target: { value: "customer asked" } });
    fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));

    expect(await screen.findByText(CONFLICT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reschedule anyway" }));

    await waitFor(() => expect(reschedule).toHaveBeenCalledTimes(2));
    expect(reschedule.mock.calls[1][1]).toMatchObject({
      newStartDate: "2026-10-06",
      reason: "customer asked",
      overrideCalendarConflict: true,
    });
  });
});
