/**
 * "Technicians on this job" (2026-11-15). Kyle: "I am unable to assign multiple techs to the same job
 * and need to update the scheduling so I can manage manpower between jobs."
 *
 * One crew control for every screen that shows a job. Pinned here: each tech is a Lead or a Helper;
 * Make lead and Remove from job act on one row; Add a technician + role + Add to job puts one more on
 * the job (the first is the lead, later ones help unless told otherwise); a promoted lead and a Google
 * warning come back on screen; a cancelled or completed job greys every control and says why.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { JobCrew } from "./JobCrew";
import { api } from "../lib/api";
import type { Technician, VisitAssignment } from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

const techs = [
  { id: "t-ann", name: "Ann Lead", isActive: true },
  { id: "t-bob", name: "Bob Helper", isActive: true },
  { id: "t-cal", name: "Cal Spare", isActive: true },
  { id: "t-old", name: "Retired Rick", isActive: false },
] as Technician[];

function row(id: string, techId: string, name: string, role: "primary" | "helper", status = "assigned"): VisitAssignment {
  return {
    id, visitId: "visit-1", technicianId: techId, role, status,
    assignedAt: "2026-11-15T12:00:00.000Z", technician: { id: techId, name },
  };
}

const ann = row("a-ann", "t-ann", "Ann Lead", "primary");
const bob = row("a-bob", "t-bob", "Bob Helper", "helper");

function mockReads(assignments: VisitAssignment[]) {
  vi.spyOn(api, "technicians").mockResolvedValue(techs);
  return vi.spyOn(api, "visitAssignments").mockResolvedValue(assignments);
}

describe("JobCrew - the list", () => {
  it("shows each tech as Lead or Helper, lead first, with Make lead only on helpers", async () => {
    mockReads([bob, ann]);
    renderWithProviders(<JobCrew visitId="visit-1" status="scheduled" />);

    expect(await screen.findByText("Ann Lead", { selector: "span.font-medium" })).toBeInTheDocument();
    const names = screen.getAllByText(/^(Ann Lead|Bob Helper)$/, { selector: "span.font-medium" }).map((n) => n.textContent);
    expect(names).toEqual(["Ann Lead", "Bob Helper"]);
    expect(screen.getByText("Lead", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("Helper", { selector: "span" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Make lead" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Remove from job" })).toHaveLength(2);
  });

  it("shows a legacy role 'lead' row (written by the field app's new service call) as the Lead", async () => {
    mockReads([{ ...ann, role: "lead" }, bob]);
    renderWithProviders(<JobCrew visitId="visit-1" status="scheduled" />);
    await screen.findByText("Ann Lead", { selector: "span.font-medium" });
    expect(screen.getByText("Lead", { selector: "span" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Make lead" })).toHaveLength(1);
  });

  it("says so when nobody is on the job, whether or not it has a date", async () => {
    mockReads([]);
    renderWithProviders(<JobCrew visitId="visit-1" status="contracted" />);
    expect(await screen.findByText("No technician is on this job yet.")).toBeInTheDocument();
  });

  it("does not list a finished assignment as crew", async () => {
    mockReads([ann, row("a-done", "t-cal", "Cal Spare", "helper", "completed")]);
    renderWithProviders(<JobCrew visitId="visit-1" status="scheduled" />);
    await screen.findByText("Ann Lead", { selector: "span.font-medium" });
    expect(screen.queryByText("Cal Spare", { selector: "span.font-medium" })).not.toBeInTheDocument();
  });
});

describe("JobCrew - Make lead and Remove from job", () => {
  it("Make lead calls makeLeadAssignment for that row and refreshes the host", async () => {
    mockReads([ann, bob]);
    const make = vi.spyOn(api, "makeLeadAssignment").mockResolvedValue({ ...bob, role: "primary" });
    const onChanged = vi.fn();
    renderWithProviders(<JobCrew visitId="visit-1" status="scheduled" onChanged={onChanged} />);

    fireEvent.click(await screen.findByRole("button", { name: "Make lead" }));
    await waitFor(() => expect(make).toHaveBeenCalledWith("a-bob"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("Remove from job calls removeAssignment, and says who became the lead when the lead was removed", async () => {
    mockReads([ann, bob]);
    const remove = vi.spyOn(api, "removeAssignment").mockResolvedValue({
      removed: true, promoted: { technicianId: "t-bob", name: "Bob Helper" },
    });
    renderWithProviders(<JobCrew visitId="visit-1" status="scheduled" />);

    await screen.findByText("Ann Lead", { selector: "span.font-medium" });
    fireEvent.click(screen.getAllByRole("button", { name: "Remove from job" })[0]);

    await waitFor(() => expect(remove).toHaveBeenCalledWith("a-ann"));
    expect(await screen.findByText("Bob Helper is now the lead.")).toBeInTheDocument();
  });

  it("shows the Google warning the server returns, as a warning and not as a failure", async () => {
    mockReads([ann, bob]);
    vi.spyOn(api, "removeAssignment").mockResolvedValue({
      removed: true, warning: "Saved — the Google event could not be updated: Calendar is unavailable",
    });
    renderWithProviders(<JobCrew visitId="visit-1" status="scheduled" />);

    await screen.findByText("Ann Lead", { selector: "span.font-medium" });
    fireEvent.click(screen.getAllByRole("button", { name: "Remove from job" })[1]);

    const warning = await screen.findByText("Saved — the Google event could not be updated: Calendar is unavailable");
    expect(warning.className).toMatch(/amber/);
    expect(warning.className).not.toMatch(/red/);
  });

  it("shows a server refusal on screen", async () => {
    mockReads([ann, bob]);
    vi.spyOn(api, "makeLeadAssignment").mockRejectedValue(new Error("That technician is not on this job."));
    renderWithProviders(<JobCrew visitId="visit-1" status="scheduled" />);

    fireEvent.click(await screen.findByRole("button", { name: "Make lead" }));
    expect(await screen.findByText("That technician is not on this job.")).toBeInTheDocument();
  });
});

describe("JobCrew - Add a technician", () => {
  it("offers only active techs who are not already on the job", async () => {
    mockReads([ann]);
    renderWithProviders(<JobCrew visitId="visit-1" status="scheduled" />);

    await screen.findByRole("option", { name: "Bob Helper" });
    expect(screen.getByRole("option", { name: "Cal Spare" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Ann Lead" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Retired Rick" })).not.toBeInTheDocument();
  });

  it("with a lead already on the job the new tech defaults to Helper", async () => {
    mockReads([ann]);
    const assign = vi.spyOn(api, "assignTechnician").mockResolvedValue({ ...bob });
    renderWithProviders(<JobCrew visitId="visit-1" status="scheduled" />);

    await screen.findByRole("option", { name: "Bob Helper" });
    fireEvent.change(screen.getByLabelText("Add a technician"), { target: { value: "t-bob" } });
    expect(screen.getByLabelText("As")).toHaveValue("helper");
    fireEvent.click(screen.getByRole("button", { name: "Add to job" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("visit-1", { technicianId: "t-bob", role: "helper" }));
  });

  it("choosing Lead sends role primary and warns that the current lead becomes a helper", async () => {
    mockReads([ann]);
    const assign = vi.spyOn(api, "assignTechnician").mockResolvedValue({ ...bob, role: "primary" });
    renderWithProviders(<JobCrew visitId="visit-1" status="scheduled" />);

    await screen.findByRole("option", { name: "Bob Helper" });
    fireEvent.change(screen.getByLabelText("Add a technician"), { target: { value: "t-bob" } });
    fireEvent.change(screen.getByLabelText("As"), { target: { value: "primary" } });
    expect(screen.getByText("The current lead becomes a helper.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add to job" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("visit-1", { technicianId: "t-bob", role: "primary" }));
  });

  it("with nobody on the job the first tech defaults to Lead", async () => {
    mockReads([]);
    renderWithProviders(<JobCrew visitId="visit-1" status="contracted" />);
    await screen.findByRole("option", { name: "Bob Helper" });
    expect(screen.getByLabelText("As")).toHaveValue("primary");
  });

  it("Add to job is greyed with the reason until a technician is picked", async () => {
    mockReads([]);
    renderWithProviders(<JobCrew visitId="visit-1" status="contracted" />);
    await screen.findByRole("option", { name: "Bob Helper" });
    expect(screen.getByRole("button", { name: "Add to job" })).toBeDisabled();
    expect(screen.getByText("Pick a technician first.")).toBeInTheDocument();
  });
});

describe("JobCrew - a closed job", () => {
  it.each(["cancelled", "completed"])("%s: every control is greyed and the reason is on screen", async (status) => {
    mockReads([ann, bob]);
    renderWithProviders(<JobCrew visitId="visit-1" status={status} />);

    await screen.findByText("Ann Lead", { selector: "span.font-medium" });
    expect(screen.getByText(`This job is ${status}, so its technicians can't be changed.`)).toBeInTheDocument();
    for (const b of screen.getAllByRole("button", { name: /Make lead|Remove from job|Add to job/ })) {
      expect(b).toBeDisabled();
    }
    expect(screen.getByLabelText("Add a technician")).toBeDisabled();
  });

  it("a closed consultation (status estimate, completedAt set) is greyed too", async () => {
    mockReads([ann]);
    renderWithProviders(<JobCrew visitId="visit-1" status="estimate" completedAt="2026-11-14T18:00:00.000Z" />);

    await screen.findByText("Ann Lead", { selector: "span.font-medium" });
    expect(screen.getByText("This consultation is completed, so its technicians can't be changed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove from job" })).toBeDisabled();
  });
});
