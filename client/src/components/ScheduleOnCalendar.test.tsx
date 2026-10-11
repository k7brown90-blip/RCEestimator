/**
 * The Test Account's door (2026-10-11). Kyle: "since this is the test account we need to have a
 * test booking that doesn't show on the calendar but places either a consultation, or job on the
 * field app to run tests." With `isTestAccount` the card replaces the Calendar door with
 * "Put on the field app" / "Take off the field app"; without it, the card is what it always was.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { ScheduleOnCalendar } from "./ScheduleOnCalendar";
import { api } from "../lib/api";
import type { Technician, VisitAssignment } from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

const techs = [
  { id: "tech-1", name: "Michael Schramm", isActive: true },
  { id: "tech-2", name: "Retired Rick", isActive: false },
] as Technician[];

const assignment = {
  id: "assign-1", visitId: "visit-1", technicianId: "tech-1", role: "primary", status: "assigned",
  assignedAt: "2026-10-11T12:00:00.000Z", technician: { id: "tech-1", name: "Michael Schramm" },
} as VisitAssignment;

function mockReads(assignments: VisitAssignment[] = []) {
  vi.spyOn(api, "technicians").mockResolvedValue(techs);
  return vi.spyOn(api, "visitAssignments").mockResolvedValue(assignments);
}

describe("ScheduleOnCalendar - Test Account", () => {
  it("shows 'Put on the field app' and no Calendar door link, for a consultation", async () => {
    mockReads();
    const { container } = renderWithProviders(<ScheduleOnCalendar visitId="visit-1" status="estimate" isTestAccount />);

    expect(screen.getByText("Test visit — field app")).toBeInTheDocument();
    expect(screen.getByText(/this visit goes straight to the field app\. It never appears on the Calendar or Google Calendar, and the customer gets no booking email/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Put on the field app" })).toBeDisabled();
    expect(screen.getByText("Pick a technician first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark consultation complete" })).toBeInTheDocument();
    expect(container.querySelector("[data-schedule-door]")).toBeNull();
    expect(screen.queryByText("Not booked yet.")).not.toBeInTheDocument();
    // Only active technicians are offered.
    await screen.findByRole("option", { name: "Michael Schramm" });
    expect(screen.queryByRole("option", { name: "Retired Rick" })).not.toBeInTheDocument();
  });

  it("shows the same card for a job, without the consultation close-out", async () => {
    mockReads();
    const { container } = renderWithProviders(<ScheduleOnCalendar visitId="visit-1" status="contracted" isTestAccount />);

    expect(screen.getByRole("button", { name: "Put on the field app" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark consultation complete" })).not.toBeInTheDocument();
    expect(container.querySelector("[data-schedule-door]")).toBeNull();
  });

  it("picking a technician and clicking calls assignTechnician, then refreshes the host", async () => {
    mockReads();
    const assign = vi.spyOn(api, "assignTechnician").mockResolvedValue(assignment);
    const onChanged = vi.fn();
    renderWithProviders(<ScheduleOnCalendar visitId="visit-1" status="estimate" isTestAccount onChanged={onChanged} />);

    await screen.findByRole("option", { name: "Michael Schramm" });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tech-1" } });
    const button = screen.getByRole("button", { name: "Put on the field app" });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    await waitFor(() => expect(assign).toHaveBeenCalledWith("visit-1", { technicianId: "tech-1" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("shows a server error on screen when the assignment fails", async () => {
    mockReads();
    vi.spyOn(api, "assignTechnician").mockRejectedValue(new Error("Technician not found"));
    renderWithProviders(<ScheduleOnCalendar visitId="visit-1" status="estimate" isTestAccount />);

    await screen.findByRole("option", { name: "Michael Schramm" });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tech-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Put on the field app" }));

    expect(await screen.findByText("Technician not found")).toBeInTheDocument();
  });

  it("an existing assignment shows 'Take off the field app', which calls removeAssignment", async () => {
    mockReads([assignment, { ...assignment, id: "assign-done", status: "completed" }]);
    const remove = vi.spyOn(api, "removeAssignment").mockResolvedValue(undefined);
    const onChanged = vi.fn();
    renderWithProviders(<ScheduleOnCalendar visitId="visit-1" status="contracted" isTestAccount onChanged={onChanged} />);

    expect(await screen.findByText("On Michael Schramm's field app")).toBeInTheDocument();
    // The completed assignment is not listed.
    expect(screen.getAllByRole("button", { name: "Take off the field app" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Take off the field app" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith("assign-1"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("a closed consultation keeps the 'Consultation completed' display and offers no assign button", () => {
    mockReads();
    renderWithProviders(
      <ScheduleOnCalendar visitId="visit-1" status="estimate" completedAt="2026-10-10T18:00:00.000Z" isTestAccount />,
    );
    expect(screen.getByText("Consultation completed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Put on the field app" })).not.toBeInTheDocument();
  });

  it("a cancelled test visit says why it cannot go on the field app", () => {
    mockReads();
    renderWithProviders(<ScheduleOnCalendar visitId="visit-1" status="cancelled" isTestAccount />);
    expect(screen.getByRole("button", { name: "Put on the field app" })).toBeDisabled();
    expect(screen.getByText("This visit is cancelled, so it will not show on the field app.")).toBeInTheDocument();
  });
});

describe("ScheduleOnCalendar - everyone else", () => {
  it("without isTestAccount the Calendar door renders as before and no field-app card appears", () => {
    const techSpy = vi.spyOn(api, "technicians");
    const { container } = renderWithProviders(<ScheduleOnCalendar visitId="visit-1" status="estimate" />);

    const door = container.querySelector("[data-schedule-door]");
    expect(door).not.toBeNull();
    expect(door).toHaveAttribute("href", "/calendar?schedule=visit-1");
    expect(screen.getByText("Estimate Appointment")).toBeInTheDocument();
    expect(screen.getByText("Not booked yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Put on the field app" })).not.toBeInTheDocument();
    expect(techSpy).not.toHaveBeenCalled();
  });
});
