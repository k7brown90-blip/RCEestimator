/**
 * The job crew (2026-11-15). Kyle: "I am unable to assign multiple techs to the same job and need to
 * update the scheduling so I can manage manpower between jobs."
 *
 * services/visitCrew.ts is the ONE writer of VisitAssignment. Pinned here:
 *  - add a helper; add as lead demotes the old lead (one lead per job); make lead swaps the roles;
 *  - removing the lead promotes the longest-assigned helper, and says so;
 *  - after every change the Google event's guests are every assigned tech with an email, the
 *    "Technician:" line lists the crew lead first, and guests who are NOT technicians are kept;
 *  - a Google failure never undoes the crew change: it comes back as a warning;
 *  - a visit with no Google event (the Test Account's) syncs nothing;
 *  - a cancelled / completed job refuses crew changes;
 *  - booking with helpers invites them all, and the reschedule tech swap moves the invite.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";

const cal = vi.hoisted(() => ({
  /** what events.get answers with (the event as Google holds it) */
  event: { attendees: [] as Array<{ email: string; responseStatus?: string }>, description: "" as string | null },
  patches: [] as Array<{ eventId: string; sendUpdates?: string; requestBody: { attendees?: Array<{ email: string }>; description?: string } }>,
  inserts: [] as Array<{ sendUpdates?: string; requestBody: { attendees?: Array<{ email: string }>; description?: string } }>,
  gets: 0,
  patchFails: null as string | null,
  /** the calendar ids each availability read (freebusy.query) asked about */
  freebusy: [] as string[][],
}));

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/services/visitConfirmations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/visitConfirmations")>()),
  notifyTechnicianOfAssignment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials() {}
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: {
          query: vi.fn().mockImplementation((params: { requestBody: { items: Array<{ id: string }> } }) => {
            cal.freebusy.push(params.requestBody.items.map((i) => i.id));
            return Promise.resolve({ data: { calendars: Object.fromEntries(params.requestBody.items.map((i) => [i.id, { busy: [] }])) } });
          }),
        },
        events: {
          insert: vi.fn().mockImplementation((params: { sendUpdates?: string; requestBody: { attendees?: Array<{ email: string }>; description?: string } }) => {
            cal.inserts.push(params);
            return Promise.resolve({ data: { id: `gcal_crew_${Math.random().toString(36).slice(2)}`, ...params.requestBody } });
          }),
          get: vi.fn().mockImplementation(() => {
            cal.gets += 1;
            return Promise.resolve({ data: { id: "evt", ...cal.event } });
          }),
          patch: vi.fn().mockImplementation((params: { eventId: string; sendUpdates?: string; requestBody: { attendees?: Array<{ email: string }>; description?: string } }) => {
            if (cal.patchFails) return Promise.reject(new Error(cal.patchFails));
            cal.patches.push(params);
            return Promise.resolve({ data: { id: params.eventId } });
          }),
          delete: vi.fn().mockResolvedValue({}),
          list: vi.fn().mockResolvedValue({ data: { items: [] } }),
        },
      }),
    },
  };
});

import { app } from "../src/app";
import { notifyTechnicianOfAssignment } from "../src/services/visitConfirmations";
import { addTechnician, removeTechnician, makeLead, listCrew, CrewError } from "../src/services/visitCrew";
import { scheduleJob, rescheduleJob } from "../src/services/scheduling";

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const OWNER_EMAIL = `crew-owner-${SUFFIX}@example.com`;
const emailOf = (n: string) => `crew-${n.toLowerCase()}-${SUFFIX}@example.com`;

let customerId: string;
let testCustomerId: string;
let propertyId: string;
let testPropertyId: string;
const tech: Record<"Ann" | "Bob" | "Cal" | "Dee", string> = { Ann: "", Bob: "", Cal: "", Dee: "" };
const visitIds: string[] = [];

/** A booked job that has a Google event. */
async function makeJob(over: Record<string, unknown> = {}) {
  const v = await prisma.visit.create({
    data: {
      customerId, propertyId, mode: "service_diagnostic", status: "scheduled",
      scheduledStart: new Date("2031-11-03T14:00:00Z"), scheduledEnd: new Date("2031-11-03T21:00:00Z"),
      googleEventId: `evt-${Math.random().toString(36).slice(2)}`,
      ...over,
    },
  });
  visitIds.push(v.id);
  return v;
}

const lastPatch = () => cal.patches[cal.patches.length - 1];
const patchedEmails = () => (lastPatch().requestBody.attendees ?? []).map((a) => a.email).sort();

beforeEach(async () => {
  cal.event = { attendees: [], description: "Job ID: x\nCustomer: Crew Customer\nAddress: 1 Crew Way\nTechnician: Ann" };
  cal.patches = [];
  cal.inserts = [];
  cal.gets = 0;
  cal.patchFails = null;
  cal.freebusy = [];
  vi.mocked(notifyTechnicianOfAssignment).mockClear();

  if (!customerId) {
    customerId = (await prisma.customer.create({ data: { name: "Crew Customer" } })).id;
    propertyId = (await prisma.property.create({
      data: { customerId, name: "Main", addressLine1: "1 Crew Way", city: "Murfreesboro", state: "TN", postalCode: "37130" },
    })).id;
    testCustomerId = (await prisma.customer.create({ data: { name: "Crew Test Account", isTestAccount: true } })).id;
    testPropertyId = (await prisma.property.create({
      data: { customerId: testCustomerId, name: "Test", addressLine1: "2 Crew Way", city: "Murfreesboro", state: "TN", postalCode: "37130" },
    })).id;
    for (const n of ["Ann", "Bob", "Cal", "Dee"] as const) {
      tech[n] = (await prisma.technician.create({
        data: { name: `Crew ${n}`, email: emailOf(n), accessToken: `crew-${n}-${SUFFIX}` },
      })).id;
    }
  }
});

afterAll(async () => {
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: visitIds } } });
  await prisma.visit.deleteMany({ where: { id: { in: visitIds } } });
  await prisma.technician.deleteMany({ where: { name: { startsWith: "Crew " } } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, testPropertyId] } } });
  await prisma.customer.deleteMany({ where: { id: { in: [customerId, testCustomerId] } } });
});

describe("addTechnician", () => {
  it("the first tech is the lead; a second added as helper stays a helper, and the event is re-synced with both", async () => {
    const v = await makeJob();
    await addTechnician(v.id, tech.Ann, "primary");
    const change = await addTechnician(v.id, tech.Bob, "helper");

    expect(change.crew.map((c) => [c.name, c.role])).toEqual([["Crew Ann", "primary"], ["Crew Bob", "helper"]]);
    expect(change.warning).toBeNull();
    expect(cal.patches).toHaveLength(2);
    expect(lastPatch().eventId).toBe(v.googleEventId);
    expect(lastPatch().sendUpdates).toBe("all");
    expect(patchedEmails()).toEqual([emailOf("Ann"), emailOf("Bob")].sort());
    // Lead first, helper after; other lines of the description are left alone.
    expect(lastPatch().requestBody.description).toBe(
      "Job ID: x\nCustomer: Crew Customer\nAddress: 1 Crew Way\nTechnician: Crew Ann (lead), Crew Bob",
    );
    // The added tech got the existing "New Job Assigned" notification.
    expect(notifyTechnicianOfAssignment).toHaveBeenCalledWith(tech.Bob, v.id, "assigned");
  });

  it("adding as lead demotes the current lead to helper: one lead per job", async () => {
    const v = await makeJob();
    await addTechnician(v.id, tech.Ann, "primary");
    const change = await addTechnician(v.id, tech.Bob, "primary");

    const roles = Object.fromEntries(change.crew.map((c) => [c.name, c.role]));
    expect(roles).toEqual({ "Crew Bob": "primary", "Crew Ann": "helper" });
    expect(change.crew.filter((c) => c.role === "primary")).toHaveLength(1);
    expect(lastPatch().requestBody.description).toContain("Technician: Crew Bob (lead), Crew Ann");
  });

  it("with no role it leads an empty job and helps a job that has a lead", async () => {
    const v = await makeJob();
    expect((await addTechnician(v.id, tech.Ann)).assignment?.role).toBe("primary");
    expect((await addTechnician(v.id, tech.Bob)).assignment?.role).toBe("helper");
  });

  it("a first tech added as helper to an empty crew becomes the lead (a crew always has a lead)", async () => {
    const v = await makeJob();
    const change = await addTechnician(v.id, tech.Ann, "helper");
    expect(change.assignment?.role).toBe("primary");
    expect(change.promoted).toBeNull();
  });

  it("re-adding a tech already on the job changes their role and never duplicates the row", async () => {
    const v = await makeJob();
    await addTechnician(v.id, tech.Ann, "primary");
    await addTechnician(v.id, tech.Bob, "helper");
    await addTechnician(v.id, tech.Bob, "helper");
    expect(await prisma.visitAssignment.count({ where: { visitId: v.id } })).toBe(2);
  });

  it("keeps guests who are not technicians and drops none of them", async () => {
    cal.event = {
      attendees: [{ email: OWNER_EMAIL }, { email: emailOf("Dee"), responseStatus: "accepted" }],
      description: "Address: 1 Crew Way",
    };
    const v = await makeJob();
    await addTechnician(v.id, tech.Ann, "primary");
    // Dee is a technician but is not on the crew, so her invite goes; the owner's stays.
    expect(patchedEmails()).toEqual([OWNER_EMAIL, emailOf("Ann")].sort());
  });

  it("a legacy role 'lead' row (the field app's own new service call wrote it) is the lead: a new lead demotes it", async () => {
    const v = await makeJob();
    await prisma.visitAssignment.create({ data: { visitId: v.id, technicianId: tech.Ann, role: "lead" } });

    const helper = await addTechnician(v.id, tech.Bob);
    expect(helper.assignment?.role).toBe("helper");
    expect(helper.crew.map((c) => [c.name, c.role])).toEqual([["Crew Ann", "primary"], ["Crew Bob", "helper"]]);

    const change = await addTechnician(v.id, tech.Cal, "primary");
    expect(Object.fromEntries(change.crew.map((c) => [c.name, c.role]))).toEqual({ "Crew Cal": "primary", "Crew Ann": "helper", "Crew Bob": "helper" });
  });

  it("refuses a technician that does not exist", async () => {
    const v = await makeJob();
    await expect(addTechnician(v.id, "no-such-tech", "helper")).rejects.toMatchObject({ name: "CrewError", statusCode: 404 });
  });
});

describe("makeLead", () => {
  it("swaps the roles and rewrites the Technician line lead first", async () => {
    const v = await makeJob();
    await addTechnician(v.id, tech.Ann, "primary");
    const bob = (await addTechnician(v.id, tech.Bob, "helper")).assignment!;

    const change = await makeLead(bob.id);
    expect(Object.fromEntries(change.crew.map((c) => [c.name, c.role]))).toEqual({ "Crew Bob": "primary", "Crew Ann": "helper" });
    expect(lastPatch().requestBody.description).toContain("Technician: Crew Bob (lead), Crew Ann");
    expect(patchedEmails()).toEqual([emailOf("Ann"), emailOf("Bob")].sort());
  });
});

describe("removeTechnician", () => {
  it("removing the lead promotes the longest-assigned helper and says so; the removed tech is told and uninvited", async () => {
    const v = await makeJob();
    const ann = (await addTechnician(v.id, tech.Ann, "primary")).assignment!;
    const bob = (await addTechnician(v.id, tech.Bob, "helper")).assignment!;
    const cal3 = (await addTechnician(v.id, tech.Cal, "helper")).assignment!;
    // Cal was assigned FIRST of the two helpers; Bob later - the oldest helper must be promoted.
    await prisma.visitAssignment.update({ where: { id: cal3.id }, data: { assignedAt: new Date("2031-01-01T00:00:00Z") } });
    await prisma.visitAssignment.update({ where: { id: bob.id }, data: { assignedAt: new Date("2031-02-01T00:00:00Z") } });
    vi.mocked(notifyTechnicianOfAssignment).mockClear();

    const change = await removeTechnician(ann.id);

    expect(change.promoted).toEqual({ technicianId: tech.Cal, name: "Crew Cal" });
    expect(Object.fromEntries(change.crew.map((c) => [c.name, c.role]))).toEqual({ "Crew Cal": "primary", "Crew Bob": "helper" });
    expect(patchedEmails()).toEqual([emailOf("Bob"), emailOf("Cal")].sort());
    expect(lastPatch().requestBody.description).toContain("Technician: Crew Cal (lead), Crew Bob");
    expect(notifyTechnicianOfAssignment).toHaveBeenCalledWith(tech.Ann, v.id, "cancelled");
    expect(await prisma.visitAssignment.findUnique({ where: { id: ann.id } })).toBeNull();
  });

  it("removing a helper promotes nobody", async () => {
    const v = await makeJob();
    await addTechnician(v.id, tech.Ann, "primary");
    const bob = (await addTechnician(v.id, tech.Bob, "helper")).assignment!;
    const change = await removeTechnician(bob.id);
    expect(change.promoted).toBeNull();
    expect(change.crew.map((c) => c.name)).toEqual(["Crew Ann"]);
  });

  it("removing the last tech empties the event's guests and drops the Technician line", async () => {
    const v = await makeJob();
    const ann = (await addTechnician(v.id, tech.Ann, "primary")).assignment!;
    const change = await removeTechnician(ann.id);
    expect(change.crew).toEqual([]);
    expect(lastPatch().requestBody.attendees).toEqual([]);
    expect(lastPatch().requestBody.description).not.toMatch(/Technician/);
  });

  it("an assignment that is not there is a 404, not a 500", async () => {
    await expect(removeTechnician("no-such-assignment")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("Google trouble never undoes the crew change", () => {
  it("returns the warning and keeps the assignment", async () => {
    cal.patchFails = "Calendar is unavailable";
    const v = await makeJob();
    const change = await addTechnician(v.id, tech.Ann, "primary");

    expect(change.warning).toBe("Saved — the Google event could not be updated: Calendar is unavailable");
    expect(change.crew.map((c) => c.name)).toEqual(["Crew Ann"]);
    expect(await prisma.visitAssignment.count({ where: { visitId: v.id } })).toBe(1);
  });
});

describe("a visit with no Google event (the Test Account's) syncs nothing", () => {
  it("assigns without touching Google and without any customer message", async () => {
    const v = await prisma.visit.create({
      data: { customerId: testCustomerId, propertyId: testPropertyId, mode: "service_diagnostic", status: "estimate" },
    });
    visitIds.push(v.id);

    const change = await addTechnician(v.id, tech.Ann, "primary");
    await addTechnician(v.id, tech.Bob, "helper");
    await removeTechnician(change.assignment!.id);

    expect(cal.gets).toBe(0);
    expect(cal.patches).toHaveLength(0);
    expect(change.warning).toBeNull();
    expect((await listCrew(v.id)).map((c) => [c.name, c.role])).toEqual([["Crew Bob", "primary"]]);
  });
});

describe("a closed job takes no crew changes", () => {
  it.each(["cancelled", "completed"])("%s refuses add, remove and make lead", async (status) => {
    const v = await makeJob();
    const ann = (await addTechnician(v.id, tech.Ann, "primary")).assignment!;
    await prisma.visit.update({ where: { id: v.id }, data: { status } });

    for (const attempt of [
      () => addTechnician(v.id, tech.Bob, "helper"),
      () => removeTechnician(ann.id),
      () => makeLead(ann.id),
    ]) {
      const err = await attempt().catch((e) => e);
      expect(err).toBeInstanceOf(CrewError);
      expect(err.statusCode).toBe(409);
      expect(err.message).toContain(status);
    }
    expect(await prisma.visitAssignment.count({ where: { visitId: v.id } })).toBe(1);
  });

  it("a closed consultation (status estimate, completedAt set) is closed too", async () => {
    const v = await makeJob({ status: "estimate", completedAt: new Date("2031-11-01T12:00:00Z") });
    await expect(addTechnician(v.id, tech.Ann, "primary")).rejects.toBeInstanceOf(CrewError);
  });
});

describe("the routes", () => {
  it("POST assign, PATCH make lead and DELETE remove all go through the crew service", async () => {
    const v = await makeJob();
    const a = await request(app).post(`/health-record-admin/visits/${v.id}/assign`).send({ technicianId: tech.Ann, role: "primary" }).expect(201);
    const b = await request(app).post(`/health-record-admin/visits/${v.id}/assign`).send({ technicianId: tech.Bob, role: "helper" }).expect(201);
    expect(b.body.role).toBe("helper");
    expect(b.body.warning).toBeNull();

    const lead = await request(app).patch(`/health-record-admin/assignments/${b.body.id}`).send({ role: "primary" }).expect(200);
    expect(lead.body.role).toBe("primary");
    expect((await prisma.visitAssignment.findUnique({ where: { id: a.body.id } }))?.role).toBe("helper");
    // Only "primary" is a valid PATCH: demoting is done by making someone else lead.
    await request(app).patch(`/health-record-admin/assignments/${b.body.id}`).send({ role: "helper" }).expect(422);

    const removed = await request(app).delete(`/health-record-admin/assignments/${b.body.id}`).expect(200);
    expect(removed.body).toMatchObject({ removed: true, promoted: { technicianId: tech.Ann } });
    await request(app).delete(`/health-record-admin/assignments/${b.body.id}`).expect(404);
  });

  it("a closed job answers 409 with the reason", async () => {
    const v = await makeJob({ status: "cancelled" });
    const res = await request(app).post(`/health-record-admin/visits/${v.id}/assign`).send({ technicianId: tech.Ann }).expect(409);
    expect(res.body.error).toContain("cancelled");
  });
});

describe("booking and rescheduling carry the crew to Google", () => {
  it("booking with helpers invites the lead and every helper and lists them on the event", async () => {
    const v = await prisma.visit.create({
      data: { customerId, propertyId, mode: "estimate", status: "estimate" },
    });
    visitIds.push(v.id);

    await scheduleJob(v.id, "2031-11-04", "10:00", tech.Ann, null, { helperTechnicianIds: [tech.Bob, tech.Cal, tech.Ann] });

    expect(cal.inserts).toHaveLength(1);
    const emails = (cal.inserts[0].requestBody.attendees ?? []).map((a) => a.email).sort();
    expect(emails).toEqual([emailOf("Ann"), emailOf("Bob"), emailOf("Cal")].sort());
    expect(cal.inserts[0].requestBody.description).toContain("Technician: Crew Ann (lead), Crew Bob, Crew Cal");
    const crew = await listCrew(v.id);
    expect(crew.map((c) => [c.name, c.role])).toEqual([["Crew Ann", "primary"], ["Crew Bob", "helper"], ["Crew Cal", "helper"]]);
  });

  it("booking with one tech and no helpers behaves as it always did", async () => {
    const v = await prisma.visit.create({ data: { customerId, propertyId, mode: "estimate", status: "estimate" } });
    visitIds.push(v.id);
    await scheduleJob(v.id, "2031-11-05", "10:00", tech.Ann);
    expect(cal.inserts[0].requestBody.description).toContain("Technician: Crew Ann");
    expect(cal.inserts[0].requestBody.description).not.toContain("(lead)");
    expect((cal.inserts[0].requestBody.attendees ?? []).map((a) => a.email)).toEqual([emailOf("Ann")]);
  });

  it("a bad helper id refuses the booking before anything is created", async () => {
    const v = await prisma.visit.create({ data: { customerId, propertyId, mode: "estimate", status: "estimate" } });
    visitIds.push(v.id);
    await expect(scheduleJob(v.id, "2031-11-06", "10:00", tech.Ann, null, { helperTechnicianIds: ["nope"] })).rejects.toThrow("Technician not found");
    expect(cal.inserts).toHaveLength(0);
  });

  it("the reschedule tech swap releases the old lead, keeps helpers, and moves the invite to the new tech", async () => {
    const v = await prisma.visit.create({
      data: {
        customerId, propertyId, mode: "estimate", status: "estimate",
        scheduledStart: new Date("2031-11-07T15:00:00Z"), scheduledEnd: new Date("2031-11-07T17:00:00Z"),
        googleEventId: "evt-swap",
      },
    });
    visitIds.push(v.id);
    await prisma.visitAssignment.createMany({
      data: [
        { visitId: v.id, technicianId: tech.Ann, role: "primary" },
        { visitId: v.id, technicianId: tech.Bob, role: "helper" },
      ],
    });
    cal.event = { attendees: [{ email: emailOf("Ann") }, { email: emailOf("Bob") }], description: "Address: 1 Crew Way\nTechnician: Crew Ann (lead), Crew Bob" };
    vi.mocked(notifyTechnicianOfAssignment).mockClear();

    await rescheduleJob(v.id, "2031-11-10", "10:00", "swap the lead", null, tech.Dee);

    const crew = await listCrew(v.id);
    expect(crew.map((c) => [c.name, c.role])).toEqual([["Crew Dee", "primary"], ["Crew Bob", "helper"]]);
    const swapPatch = cal.patches.find((p) => p.requestBody.attendees);
    expect(swapPatch).toBeDefined();
    expect((swapPatch!.requestBody.attendees ?? []).map((a) => a.email).sort()).toEqual([emailOf("Bob"), emailOf("Dee")].sort());
    expect(swapPatch!.requestBody.description).toContain("Technician: Crew Dee (lead), Crew Bob");
    expect(notifyTechnicianOfAssignment).toHaveBeenCalledWith(tech.Ann, v.id, "cancelled");
  });

  // Kyle, 2026-11-15: the Job drawer's "Technicians on this job" works before the job has a date, so a
  // job reaches the Calendar's booking with a crew already on it. The event must carry all of them.
  it("booking a job that already has a crew keeps them: the event invites everyone on the job, and a newly picked lead takes the lead", async () => {
    const v = await prisma.visit.create({ data: { customerId, propertyId, mode: "estimate", status: "estimate" } });
    visitIds.push(v.id);
    await addTechnician(v.id, tech.Ann, "primary");
    await addTechnician(v.id, tech.Bob, "helper");
    expect(cal.patches).toHaveLength(0); // no event yet, nothing synced

    await scheduleJob(v.id, "2031-11-12", "10:00", tech.Cal, null, { nameCalendarOwners: true });

    expect(cal.inserts).toHaveLength(1);
    const emails = (cal.inserts[0].requestBody.attendees ?? []).map((a) => a.email).sort();
    expect(emails).toEqual([emailOf("Ann"), emailOf("Bob"), emailOf("Cal")].sort());
    expect(cal.inserts[0].requestBody.description).toContain("Technician: Crew Cal (lead), Crew Ann, Crew Bob");
    // The database says the same thing the event does.
    const crew = await listCrew(v.id);
    expect(crew.map((c) => [c.name, c.role])).toEqual([["Crew Cal", "primary"], ["Crew Ann", "helper"], ["Crew Bob", "helper"]]);
  });

  it("booking with nobody picked still invites the crew the job already has and leaves their roles alone", async () => {
    const v = await prisma.visit.create({ data: { customerId, propertyId, mode: "estimate", status: "estimate" } });
    visitIds.push(v.id);
    await addTechnician(v.id, tech.Ann, "primary");
    await addTechnician(v.id, tech.Bob, "helper");

    await scheduleJob(v.id, "2031-11-13", "10:00", null, null, { nameCalendarOwners: true });

    const emails = (cal.inserts[0].requestBody.attendees ?? []).map((a) => a.email).sort();
    expect(emails).toEqual([emailOf("Ann"), emailOf("Bob")].sort());
    expect(cal.inserts[0].requestBody.description).toContain("Technician: Crew Ann (lead), Crew Bob");
    expect((await listCrew(v.id)).map((c) => [c.name, c.role])).toEqual([["Crew Ann", "primary"], ["Crew Bob", "helper"]]);
  });

  it("the CRM's availability check on a production booking reads the whole crew's calendars, including techs already on the job", async () => {
    const v = await prisma.visit.create({ data: { customerId, propertyId, mode: "service_diagnostic", status: "contracted" } });
    visitIds.push(v.id);
    await addTechnician(v.id, tech.Ann, "primary");
    await addTechnician(v.id, tech.Bob, "helper");

    await scheduleJob(v.id, "2031-11-12", "07:00", null, { date: "2031-11-12", time: "16:00" }, { nameCalendarOwners: true, helperTechnicianIds: [tech.Cal] });

    expect(cal.freebusy).toHaveLength(1);
    expect([...cal.freebusy[0]].sort()).toEqual([emailOf("Ann"), emailOf("Bob"), emailOf("Cal")].sort());
    const emails = (cal.inserts[0].requestBody.attendees ?? []).map((a) => a.email).sort();
    expect(emails).toEqual([emailOf("Ann"), emailOf("Bob"), emailOf("Cal")].sort());
  });

  it("a voice-agent booking (no CRM flag) keeps its old availability scope: only who it names, never the crew the field app assigned", async () => {
    const v = await prisma.visit.create({ data: { customerId, propertyId, mode: "service_diagnostic", status: "contracted" } });
    visitIds.push(v.id);
    await addTechnician(v.id, tech.Ann, "primary");

    await scheduleJob(v.id, "2031-11-12", "07:00", null, { date: "2031-11-12", time: "16:00" });

    // Nobody named: the company-wide read, which is not scoped to Ann's calendar alone.
    expect(cal.freebusy).toHaveLength(1);
    expect(cal.freebusy[0]).not.toEqual([emailOf("Ann")]);
    // The event still carries the job's crew, so Google matches the database.
    expect((cal.inserts[0].requestBody.attendees ?? []).map((a) => a.email)).toEqual([emailOf("Ann")]);
  });

  it("the CRM reschedule reads every crew member's calendar, not only the lead's", async () => {
    const v = await prisma.visit.create({
      data: {
        customerId, propertyId, mode: "service_diagnostic", status: "scheduled",
        scheduledStart: new Date("2031-11-03T14:00:00Z"), scheduledEnd: new Date("2031-11-03T21:00:00Z"),
        googleEventId: "evt-resched-crew",
      },
    });
    visitIds.push(v.id);
    await prisma.visitAssignment.createMany({
      data: [
        { visitId: v.id, technicianId: tech.Ann, role: "primary" },
        { visitId: v.id, technicianId: tech.Bob, role: "helper" },
      ],
    });

    await rescheduleJob(v.id, "2031-11-12", "07:00", "customer asked", null, null, { scopeToCurrentTech: true, nameCalendarOwners: true });

    expect(cal.freebusy).toHaveLength(1);
    expect([...cal.freebusy[0]].sort()).toEqual([emailOf("Ann"), emailOf("Bob")].sort());
  });

  it("a CRM reschedule that names a new lead reads the new lead and the helpers who stay (the old lead is released)", async () => {
    const v = await prisma.visit.create({
      data: {
        customerId, propertyId, mode: "service_diagnostic", status: "scheduled",
        scheduledStart: new Date("2031-11-03T14:00:00Z"), scheduledEnd: new Date("2031-11-03T21:00:00Z"),
        googleEventId: "evt-resched-swap",
      },
    });
    visitIds.push(v.id);
    await prisma.visitAssignment.createMany({
      data: [
        { visitId: v.id, technicianId: tech.Ann, role: "primary" },
        { visitId: v.id, technicianId: tech.Bob, role: "helper" },
      ],
    });

    await rescheduleJob(v.id, "2031-11-12", "07:00", "swap the lead", null, tech.Dee, { scopeToCurrentTech: true, nameCalendarOwners: true });

    expect(cal.freebusy).toHaveLength(1);
    expect([...cal.freebusy[0]].sort()).toEqual([emailOf("Bob"), emailOf("Dee")].sort());
  });
});
