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
import type { VisitAssignment } from "../lib/api";
import type { ScheduleJobResult, TechDayAvailability } from "../lib/types";

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
  vi.spyOn(api, "visitAssignments").mockResolvedValue([]);
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
    // A booked job shows its crew control (JobCrew) in reschedule mode.
    vi.spyOn(api, "technicians").mockResolvedValue([]);
    vi.spyOn(api, "visitAssignments").mockResolvedValue([]);
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

// ─── THE CREW (2026-11-15) ────────────────────────────────────────────────────────────────────
// Kyle: "I am unable to assign multiple techs to the same job and need to update the scheduling so
// I can manage manpower between jobs." Booking takes a crew: tap techs, the first tapped leads, one
// "Make lead" tap switches. A job that is already booked shows the SAME "Technicians on this job"
// control the Job drawer shows, not a second single-select picker.

function avail(id: string, name: string, over: Partial<TechDayAvailability> = {}): TechDayAvailability {
  return { technicianId: id, name, email: `${id}@example.com`, calendarAccessible: true, busy: [], freeAtRequested: true, ...over };
}

function renderBooking(techs: TechDayAvailability[], onJob: VisitAssignment[] = []) {
  vi.spyOn(api, "techAvailability").mockResolvedValue({ date: "2026-10-06", techs });
  vi.spyOn(api, "visitAssignments").mockResolvedValue(onJob);
  return renderWithProviders(
    <JobScheduler jobId="job-1" status="contracted" autoOpen pickedDate="2026-10-06" />,
    { route: "/calendar" },
  );
}

describe("Booking with a crew", () => {
  it("the first tech tapped is the Lead, the next is a Helper, and Make lead switches them", async () => {
    renderBooking([avail("t-ann", "Ann"), avail("t-bob", "Bob")]);

    fireEvent.click(await screen.findByRole("button", { name: /^Ann/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Bob/ }));
    expect(screen.getByRole("button", { name: /^Ann.*Lead/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Bob.*Helper/ })).toHaveAttribute("aria-pressed", "true");

    // Only the helper has a Make lead button.
    fireEvent.click(screen.getByRole("button", { name: "Make lead" }));
    expect(screen.getByRole("button", { name: /^Bob.*Lead/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Ann.*Helper/ })).toBeInTheDocument();
  });

  it("sends the lead as technicianId and the rest as helperTechnicianIds", async () => {
    const schedule = vi.spyOn(api, "scheduleJob").mockResolvedValue(BOOKED);
    renderBooking([avail("t-ann", "Ann"), avail("t-bob", "Bob"), avail("t-cal", "Cal")]);

    fireEvent.click(await screen.findByRole("button", { name: /^Ann/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Bob/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Cal/ }));
    // Ann leads (first tapped); make Bob the lead instead: the first "Make lead" button is Bob's.
    fireEvent.click(screen.getAllByRole("button", { name: "Make lead" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
    const input = schedule.mock.calls[0][1];
    expect(input.technicianId).toBe("t-bob");
    expect(input.helperTechnicianIds).toEqual(["t-ann", "t-cal"]);
  });

  it("tapping a selected tech takes them off; removing the lead hands the lead to the next one tapped", async () => {
    const schedule = vi.spyOn(api, "scheduleJob").mockResolvedValue(BOOKED);
    renderBooking([avail("t-ann", "Ann"), avail("t-bob", "Bob")]);

    fireEvent.click(await screen.findByRole("button", { name: /^Ann/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Bob/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Ann/ }));
    expect(screen.getByRole("button", { name: /^Ann/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Bob.*Lead/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
    const input = schedule.mock.calls[0][1];
    expect(input.technicianId).toBe("t-bob");
    expect(input).not.toHaveProperty("helperTechnicianIds");
  });

  it("a booking with nobody picked sends no technician at all", async () => {
    const schedule = vi.spyOn(api, "scheduleJob").mockResolvedValue(BOOKED);
    renderBooking([avail("t-ann", "Ann")]);
    await screen.findByRole("button", { name: /^Ann/ });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
    expect(schedule.mock.calls[0][1].technicianId).toBeUndefined();
    expect(schedule.mock.calls[0][1]).not.toHaveProperty("helperTechnicianIds");
  });

  it("keeps each tech's availability line and warns per selected tech who is double-booked", async () => {
    renderBooking([
      avail("t-ann", "Ann"),
      avail("t-bob", "Bob", { freeAtRequested: false, busy: [{ start: "x", end: "y", startLocal: "9:00 AM", endLocal: "11:00 AM" }] }),
      avail("t-cal", "Cal", { calendarAccessible: false, freeAtRequested: null }),
    ]);

    expect(await screen.findByText(/available · free all day/)).toBeInTheDocument();
    expect(screen.getByText("busy: 9:00 AM–11:00 AM")).toBeInTheDocument();
    expect(screen.getByText(/calendar not shared/)).toBeInTheDocument();

    expect(screen.queryByText(/has a conflict at that time/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Ann/ }));
    expect(screen.queryByText(/has a conflict at that time/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Bob/ }));
    expect(screen.getByText(/Heads up — Bob has a conflict at that time/)).toBeInTheDocument();
  });
});

function assignment(id: string, techId: string, name: string, role: "primary" | "helper"): VisitAssignment {
  return {
    id, visitId: "job-1", technicianId: techId, role, status: "assigned",
    assignedAt: "2026-11-15T12:00:00.000Z", technician: { id: techId, name },
  };
}

describe("Booking a job that already has a crew", () => {
  // The Job drawer's "Technicians on this job" works before a job has a date, so the Calendar's
  // booking panel must show who is already on it and book them, not start from an empty picker.
  const crew = [assignment("a-ann", "t-ann", "Ann", "primary"), assignment("a-bob", "t-bob", "Bob", "helper")];
  const everyone = () => [avail("t-ann", "Ann"), avail("t-bob", "Bob"), avail("t-cal", "Cal")];

  it("shows who is already on the job, locked, with the Lead / Helper they already are", async () => {
    renderBooking(everyone(), crew);

    const ann = await screen.findByRole("button", { name: /^Ann.*Lead.*already on this job/ });
    expect(ann).toBeDisabled();
    expect(ann).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Bob.*Helper.*already on this job/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Cal/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/Greyed techs are already on this job and stay on it/)).toBeInTheDocument();
  });

  it("a newly tapped tech helps (the job already has a lead) and the booking leaves the lead alone", async () => {
    const schedule = vi.spyOn(api, "scheduleJob").mockResolvedValue(BOOKED);
    renderBooking(everyone(), crew);

    fireEvent.click(await screen.findByRole("button", { name: /^Cal/ }));
    expect(screen.getByRole("button", { name: /^Cal.*Helper/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Ann.*Lead/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
    expect(schedule.mock.calls[0][1].technicianId).toBeUndefined();
    expect(schedule.mock.calls[0][1].helperTechnicianIds).toEqual(["t-cal"]);
  });

  it("Make lead on a newly tapped tech sends them as technicianId, and the old lead shows as Helper", async () => {
    const schedule = vi.spyOn(api, "scheduleJob").mockResolvedValue(BOOKED);
    renderBooking(everyone(), crew);

    fireEvent.click(await screen.findByRole("button", { name: /^Cal/ }));
    // Bob (helper on the job) and Cal both show Make lead; rows run Ann, Bob, Cal, so Cal's is last.
    const makeLead = screen.getAllByRole("button", { name: "Make lead" });
    fireEvent.click(makeLead[makeLead.length - 1]);
    expect(screen.getByRole("button", { name: /^Cal.*Lead/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Ann.*Helper.*already on this job/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
    expect(schedule.mock.calls[0][1].technicianId).toBe("t-cal");
    expect(schedule.mock.calls[0][1]).not.toHaveProperty("helperTechnicianIds");
  });

  it("warns about a double-booked tech who is already on the job", async () => {
    renderBooking([
      avail("t-ann", "Ann"),
      avail("t-bob", "Bob", { freeAtRequested: false, busy: [{ start: "x", end: "y", startLocal: "9:00 AM", endLocal: "11:00 AM" }] }),
    ], crew);
    expect(await screen.findByText(/Heads up — Bob has a conflict at that time/)).toBeInTheDocument();
  });
});

describe("Rescheduling a booked job", () => {
  const booked = {
    jobId: "job-1",
    status: "scheduled",
    scheduledStart: "2026-10-01T14:00:00.000Z",
    scheduledEnd: "2026-10-01T21:00:00.000Z",
  };

  it("shows Technicians on this job instead of the single Reassign picker, and sends no technician", async () => {
    const reschedule = vi.spyOn(api, "rescheduleJob").mockResolvedValue({ jobId: "job-1" } as unknown as ScheduleJobResult);
    vi.spyOn(api, "techAvailability").mockResolvedValue({ date: "2026-10-06", techs: [avail("t-ann", "Ann")] });
    vi.spyOn(api, "technicians").mockResolvedValue([]);
    vi.spyOn(api, "visitAssignments").mockResolvedValue([]);
    renderWithProviders(<JobScheduler {...booked} autoOpen pickedDate="2026-10-06" />, { route: "/calendar" });

    expect(await screen.findByText("Technicians on this job")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to job" })).toBeInTheDocument();
    expect(screen.queryByText(/Reassign technician/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Assign technicians/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Reason for reschedule"), { target: { value: "customer asked" } });
    fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
    await waitFor(() => expect(reschedule).toHaveBeenCalledTimes(1));
    expect(reschedule.mock.calls[0][1]).not.toHaveProperty("technicianId");
  });

  it("shows the crew control before any date is picked: the crew is the job's, not the date's", async () => {
    vi.spyOn(api, "techAvailability").mockResolvedValue({ date: "x", techs: [] });
    vi.spyOn(api, "technicians").mockResolvedValue([]);
    vi.spyOn(api, "visitAssignments").mockResolvedValue([]);
    renderWithProviders(<JobScheduler {...booked} autoOpen pickedDate={null} />, { route: "/calendar" });
    expect(await screen.findByText("Technicians on this job")).toBeInTheDocument();
  });

  it("shows each crew member's available / busy line for the day picked, so a helper booked elsewhere shows before the move", async () => {
    vi.spyOn(api, "techAvailability").mockResolvedValue({
      date: "2026-10-06",
      techs: [
        avail("t-ann", "Ann"),
        avail("t-bob", "Bob", { freeAtRequested: false, busy: [{ start: "x", end: "y", startLocal: "9:00 AM", endLocal: "11:00 AM" }] }),
      ],
    });
    vi.spyOn(api, "technicians").mockResolvedValue([]);
    vi.spyOn(api, "visitAssignments").mockResolvedValue([
      assignment("a-ann", "t-ann", "Ann", "primary"),
      assignment("a-bob", "t-bob", "Bob", "helper"),
    ]);
    const { container } = renderWithProviders(<JobScheduler {...booked} autoOpen pickedDate="2026-10-06" />, { route: "/calendar" });

    expect(await screen.findByText("busy: 9:00 AM–11:00 AM")).toBeInTheDocument();
    expect(screen.getByText(/available · free all day/)).toBeInTheDocument();
    const lines = container.querySelectorAll("[data-crew-availability]");
    expect(lines).toHaveLength(2);
    // Each line sits on its own tech's row.
    expect(lines[0].closest("li")).toHaveTextContent("Ann");
    expect(lines[1].closest("li")).toHaveTextContent("Bob");
  });

  it("says to pick a day when none is picked yet, and shows no availability lines", async () => {
    vi.spyOn(api, "techAvailability").mockResolvedValue({ date: "x", techs: [] });
    vi.spyOn(api, "technicians").mockResolvedValue([]);
    vi.spyOn(api, "visitAssignments").mockResolvedValue([assignment("a-ann", "t-ann", "Ann", "primary")]);
    const { container } = renderWithProviders(<JobScheduler {...booked} autoOpen pickedDate={null} />, { route: "/calendar" });
    expect(await screen.findByText("Pick a day to see who is free.")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-crew-availability]")).toHaveLength(0);
  });

  it("greys the crew controls with the reason when the consultation was closed out (completedAt passed through)", async () => {
    vi.spyOn(api, "techAvailability").mockResolvedValue({ date: "x", techs: [] });
    vi.spyOn(api, "technicians").mockResolvedValue([]);
    vi.spyOn(api, "visitAssignments").mockResolvedValue([
      assignment("a-ann", "t-ann", "Ann", "primary"),
      assignment("a-bob", "t-bob", "Bob", "helper"),
    ]);
    renderWithProviders(
      <JobScheduler {...booked} status="estimate" completedAt="2026-10-02T15:00:00.000Z" autoOpen pickedDate={null} />,
      { route: "/calendar" },
    );
    await screen.findByText("Bob");
    expect(screen.getByRole("button", { name: "Make lead" })).toBeDisabled();
    for (const b of screen.getAllByRole("button", { name: "Remove from job" })) expect(b).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add to job" })).toBeDisabled();
    expect(screen.getByText(/This consultation is completed, so its technicians can't be changed/)).toBeInTheDocument();
  });
});
