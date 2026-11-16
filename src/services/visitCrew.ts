/**
 * The ONE crew service: who is on a job, who leads it, and what their Google invite says.
 *
 * Kyle, 2026-11-15: "I am unable to assign multiple techs to the same job and need to update the
 * scheduling so I can manage manpower between jobs." VisitAssignment is the only crew record (the
 * Visit has no technician column). Before this file four places wrote it on their own — the admin
 * assign route, the admin delete route, scheduleJob's booking upsert and rescheduleJob's tech swap
 * — and none of them touched the Google event after booking, so a swapped tech never got the invite
 * and a removed one kept it. Now every one of them goes through here.
 *
 * Rules:
 *  - ONE lead per job (role "primary"). Making someone lead, or adding someone as lead, demotes the
 *    current lead to helper. Removing the lead while others remain promotes the longest-assigned
 *    remaining tech; a first tech added as "helper" to an empty crew is the lead too (a job with a
 *    crew always has a lead — scheduling's "current tech" lookups key on role "primary").
 *  - Every change re-syncs the job's Google event when it has one: guests = every assigned tech with
 *    an email, "Technician:" line = the crew, lead first. A Google failure NEVER undoes the crew
 *    change — it comes back as `warning` for the screen to show.
 *  - Test Account visits and unscheduled jobs have no googleEventId, so nothing syncs and no customer
 *    is ever emailed from here. The only message sent is the tech's own "New Job Assigned" /
 *    "Job Cancelled" (notifyTechnicianOfAssignment, whose gating is unchanged).
 */

import { prisma } from "../lib/prisma";
import { updateCalendarEventCrew, technicianDescriptionLine } from "./schedule";
import { notifyTechnicianOfAssignment } from "./visitConfirmations";

export type CrewRole = "primary" | "helper";

/**
 * The lead is role "primary". The field app's own "new service call" (routes/health-record.ts) used to
 * write role "lead" for the tech who made the visit, so rows with that value exist; they are the lead
 * too. Everything here that asks "who leads" asks this list, and a CrewMember always reports "primary".
 */
export const LEAD_ROLES = ["primary", "lead"];
const isLeadRole = (role: string) => LEAD_ROLES.includes(role);

/** Thrown for a refusal the office should read; the global error handler answers with `statusCode`. */
export class CrewError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = "CrewError";
    this.statusCode = statusCode;
  }
}

export interface CrewMember {
  assignmentId: string;
  technicianId: string;
  name: string;
  email: string | null;
  role: string;
  status: string;
}

export interface CrewChange {
  /** The assignment row after the change; null when the change was a removal. */
  assignment: AssignmentRow | null;
  crew: CrewMember[];
  /** Set when the change made a DIFFERENT tech the lead (the lead was removed, or the crew was empty). */
  promoted: { technicianId: string; name: string } | null;
  /** Set when the crew change saved but the Google event could not be updated. */
  warning: string | null;
}

const TECH_SELECT = { id: true, name: true, role: true, isActive: true, employeeNumber: true } as const;
type AssignmentRow = Awaited<ReturnType<typeof findAssignmentRow>>;
async function findAssignmentRow(id: string) {
  return prisma.visitAssignment.findUniqueOrThrow({ where: { id }, include: { technician: { select: TECH_SELECT } } });
}

/** Options only the booking / reschedule paths pass — they own the event and the tech notification themselves. */
export interface CrewOptions {
  /** Skip the Google event re-sync (scheduleJob has just written the event with the right guests). */
  skipSync?: boolean;
  /** Skip the "New Job Assigned" notification (scheduleJob / rescheduleJob notify everyone themselves). */
  skipNotify?: boolean;
  /** Booking a visit whose consultation was already closed out is the caller's business, not a crew edit. */
  skipClosedCheck?: boolean;
}

const CLOSED_MESSAGE = (what: string) => `This job is ${what}, so its technicians can't be changed.`;

async function assertOpenVisit(visitId: string): Promise<void> {
  const visit = await prisma.visit.findUnique({ where: { id: visitId }, select: { status: true, completedAt: true } });
  if (!visit) throw new CrewError("Job not found", 404);
  if (visit.status === "cancelled" || visit.status === "completed") throw new CrewError(CLOSED_MESSAGE(visit.status));
  // A closed consultation keeps status "estimate" on purpose; completedAt is the only signal it is done.
  if (visit.completedAt) throw new CrewError(CLOSED_MESSAGE("completed"));
}

/** The crew as it stands now, lead first, then longest-assigned. */
export async function listCrew(visitId: string): Promise<CrewMember[]> {
  const rows = await prisma.visitAssignment.findMany({
    where: { visitId },
    include: { technician: { select: { id: true, name: true, email: true } } },
    orderBy: [{ assignedAt: "asc" }, { id: "asc" }],
  });
  return rows
    .map((r) => ({
      assignmentId: r.id,
      technicianId: r.technicianId,
      name: r.technician.name,
      email: r.technician.email ?? null,
      role: isLeadRole(r.role) ? "primary" : r.role,
      status: r.status,
    }))
    .sort((a, b) => Number(b.role === "primary") - Number(a.role === "primary"));
}

/**
 * Make the Google event match the crew. Returns null when it did (or there is no event to match), or
 * the sentence the screen shows when Google refused. Never throws.
 */
export async function syncCrewToCalendar(visitId: string): Promise<string | null> {
  try {
    const visit = await prisma.visit.findUnique({ where: { id: visitId }, select: { googleEventId: true } });
    if (!visit?.googleEventId) return null;
    const [crew, everyone] = await Promise.all([
      listCrew(visitId),
      prisma.technician.findMany({ where: { email: { not: null } }, select: { email: true } }),
    ]);
    await updateCalendarEventCrew(visit.googleEventId, {
      attendeeEmails: crew.flatMap((c) => (c.email ? [c.email] : [])),
      managedEmails: everyone.flatMap((t) => (t.email ? [t.email] : [])),
      technicianLine: technicianDescriptionLine(crew),
    });
    return null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[visitCrew] Google event for visit ${visitId} not updated:`, err);
    return `Saved — the Google event could not be updated: ${reason}`;
  }
}

/** A job with a crew always has a lead. Promotes the longest-assigned remaining tech when none is. */
async function ensureLead(visitId: string): Promise<{ technicianId: string; name: string } | null> {
  const rows = await prisma.visitAssignment.findMany({
    where: { visitId },
    include: { technician: { select: { name: true } } },
    orderBy: [{ assignedAt: "asc" }, { id: "asc" }],
  });
  if (rows.length === 0 || rows.some((r) => isLeadRole(r.role))) return null;
  const next = rows.find((r) => r.status !== "completed") ?? rows[0];
  await prisma.visitAssignment.update({ where: { id: next.id }, data: { role: "primary" } });
  return { technicianId: next.technicianId, name: next.technician.name };
}

function fireAndForgetNotify(technicianId: string, visitId: string, event: "assigned" | "cancelled", label: string): void {
  notifyTechnicianOfAssignment(technicianId, visitId, event).catch((err) => console.error(`[${label}] Tech notify failed:`, err));
}

/**
 * Put a technician on a job as lead ("primary") or helper. Re-adding someone already on it updates
 * their role. `role` omitted: lead when the job has none, helper otherwise (the old route defaulted to
 * "primary" and could leave two leads).
 */
export async function addTechnician(
  visitId: string,
  technicianId: string,
  role?: CrewRole,
  opts: CrewOptions = {},
): Promise<CrewChange> {
  if (!opts.skipClosedCheck) await assertOpenVisit(visitId);
  else if (!(await prisma.visit.findUnique({ where: { id: visitId }, select: { id: true } }))) throw new CrewError("Job not found", 404);
  const tech = await prisma.technician.findUnique({ where: { id: technicianId }, select: { id: true } });
  if (!tech) throw new CrewError("Technician not found", 404);

  const assignmentId = await prisma.$transaction(async (tx) => {
    const hasLead = (await tx.visitAssignment.count({ where: { visitId, role: { in: LEAD_ROLES }, technicianId: { not: technicianId } } })) > 0;
    const wanted: CrewRole = role ?? (hasLead ? "helper" : "primary");
    // One lead: a new lead demotes whoever led before.
    if (wanted === "primary") {
      await tx.visitAssignment.updateMany({ where: { visitId, role: { in: LEAD_ROLES }, technicianId: { not: technicianId } }, data: { role: "helper" } });
    }
    const row = await tx.visitAssignment.upsert({
      where: { visitId_technicianId: { visitId, technicianId } },
      create: { visitId, technicianId, role: wanted },
      update: { role: wanted, status: "assigned", completedAt: null },
    });
    return row.id;
  });

  const promotedTech = await ensureLead(visitId);
  // The tech who was just added and landed as lead because the crew was empty is not news to the screen.
  const promoted = promotedTech && promotedTech.technicianId !== technicianId ? promotedTech : null;
  const warning = opts.skipSync ? null : await syncCrewToCalendar(visitId);
  if (!opts.skipNotify) fireAndForgetNotify(technicianId, visitId, "assigned", "crew add");
  return { assignment: await findAssignmentRow(assignmentId), crew: await listCrew(visitId), promoted, warning };
}

/** Take a technician off a job. The lead leaving promotes the longest-assigned remaining tech. */
export async function removeTechnician(assignmentId: string): Promise<CrewChange> {
  const assignment = await prisma.visitAssignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, technicianId: true, visitId: true },
  });
  if (!assignment) throw new CrewError("That technician is not on this job.", 404);
  await assertOpenVisit(assignment.visitId);

  await prisma.visitAssignment.delete({ where: { id: assignmentId } });
  const promoted = await ensureLead(assignment.visitId);
  const warning = await syncCrewToCalendar(assignment.visitId);
  fireAndForgetNotify(assignment.technicianId, assignment.visitId, "cancelled", "crew remove");
  return { assignment: null, crew: await listCrew(assignment.visitId), promoted, warning };
}

/** Make this assignment's technician the lead; the current lead becomes a helper. */
export async function makeLead(assignmentId: string): Promise<CrewChange> {
  const assignment = await prisma.visitAssignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, technicianId: true, visitId: true },
  });
  if (!assignment) throw new CrewError("That technician is not on this job.", 404);
  await assertOpenVisit(assignment.visitId);

  await prisma.$transaction([
    prisma.visitAssignment.updateMany({
      where: { visitId: assignment.visitId, role: { in: LEAD_ROLES }, id: { not: assignmentId } },
      data: { role: "helper" },
    }),
    prisma.visitAssignment.update({ where: { id: assignmentId }, data: { role: "primary" } }),
  ]);
  const warning = await syncCrewToCalendar(assignment.visitId);
  return { assignment: await findAssignmentRow(assignmentId), crew: await listCrew(assignment.visitId), promoted: null, warning };
}

/**
 * The reschedule tech swap (PUNCHLIST C8): the named tech becomes THE lead and whoever held the lead
 * before is released with the "cancelled" notification — helpers stay. rescheduleJob owns the "changed"
 * notification to everyone still on the job. The event has already been moved, so this patches its guests.
 */
export async function replaceLead(visitId: string, technicianId: string): Promise<CrewChange> {
  const tech = await prisma.technician.findUnique({ where: { id: technicianId }, select: { id: true } });
  if (!tech) throw new CrewError("Technician not found", 404);

  const { previous, assignmentId } = await prisma.$transaction(async (tx) => {
    const previous = await tx.visitAssignment.findMany({
      where: { visitId, role: { in: LEAD_ROLES }, technicianId: { not: technicianId } },
      select: { id: true, technicianId: true },
    });
    if (previous.length > 0) await tx.visitAssignment.deleteMany({ where: { id: { in: previous.map((p) => p.id) } } });
    const row = await tx.visitAssignment.upsert({
      where: { visitId_technicianId: { visitId, technicianId } },
      create: { visitId, technicianId, role: "primary" },
      update: { role: "primary", status: "assigned", completedAt: null },
    });
    return { previous, assignmentId: row.id };
  });
  for (const prev of previous) fireAndForgetNotify(prev.technicianId, visitId, "cancelled", "crew swap");

  const warning = await syncCrewToCalendar(visitId);
  return { assignment: await findAssignmentRow(assignmentId), crew: await listCrew(visitId), promoted: null, warning };
}

/**
 * The crew picked at booking: one lead plus any helpers. scheduleJob has just created the event with
 * these guests and notifies everyone itself, so nothing is synced or notified from here.
 */
export async function assignBookingCrew(visitId: string, leadId: string | null, helperIds: string[]): Promise<void> {
  const internal: CrewOptions = { skipSync: true, skipNotify: true, skipClosedCheck: true };
  if (leadId) await addTechnician(visitId, leadId, "primary", internal);
  for (const helperId of helperIds) {
    if (helperId !== leadId) await addTechnician(visitId, helperId, "helper", internal);
  }
}
