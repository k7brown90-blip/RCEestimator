/**
 * Lead notes carry over to the account (plan 2026-11-22-lead-notes-to-account; Kyle: "The lead info
 * contained here like what they need, job notes should also convert over to the account").
 *
 * Converting a lead writes ONE ordinary call note on the account's Conversation ("From the lead:" +
 * the filled items of the lead's "What they need" section), through the ONE note writer
 * (createAccountNote, handed the conversion's transaction), at all three doors:
 * PATCH /leads/:id/convert, PATCH /leads/:id/won, POST /leads/:id/confirm-booking.
 *
 * Google Calendar and email are mocked; no network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  del: vi.fn(),
  eventSeq: { value: 0 },
}));

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock("../src/services/confirmationEmail", async (orig) => ({
  ...(await orig<typeof import("../src/services/confirmationEmail")>()),
  sendKyleNotificationEmail: vi.fn().mockResolvedValue(true),
  sendConfirmationEmail: vi.fn().mockResolvedValue(true),
  sendBrandedEmail: vi.fn().mockResolvedValue(true),
}));
vi.mock("../src/services/notifications", async (orig) => ({
  ...(await orig<typeof import("../src/services/notifications")>()),
  sendCustomerSms: vi.fn().mockResolvedValue(null),
  sendKyleSms: vi.fn().mockResolvedValue(null),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials() {}
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }) },
        events: { insert: mocks.insert, delete: mocks.del, list: vi.fn().mockResolvedValue({ data: { items: [] } }) },
      }),
    },
  };
});

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { leadNeedsNoteBody, LEAD_INTAKE_TAKEN_BY } from "../src/services/leads";
import { ACCOUNT_NOTE_BODY_MAX } from "../src/services/customerNotes";

const TAG = "LNA";
const SECRET = "lna-secret";
const EMAIL = "lna-note@example.com";

async function wipe() {
  await prisma.emailListMember.deleteMany({ where: { email: { contains: "lna-" } } });
  await prisma.systemEvent.deleteMany({ where: { source: "leads-won" } });
  await prisma.bookingChat.deleteMany({ where: { lead: { name: { startsWith: TAG } } } });
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.visitAssignment.deleteMany({ where: { visit: { customer: { name: { startsWith: TAG } } } } });
  await prisma.visit.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.systemSnapshot.deleteMany({ where: { property: { customer: { name: { startsWith: TAG } } } } });
  await prisma.property.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
}

beforeAll(() => {
  process.env.WEBHOOK_SECRET = SECRET;
});
beforeEach(async () => {
  mocks.insert.mockReset().mockImplementation(async ({ requestBody }: { requestBody: { summary: string; start: unknown; end: unknown } }) => ({
    data: { id: `lna_evt_${++mocks.eventSeq.value}`, summary: requestBody.summary, start: requestBody.start, end: requestBody.end },
  }));
  mocks.del.mockReset().mockResolvedValue({});
  await wipe();
});
afterAll(async () => {
  await wipe();
  delete process.env.WEBHOOK_SECRET;
});

const ADDRESS = { addressLine1: "41 Note Way", city: "Murfreesboro", state: "TN", postalCode: "37128" };

type Needs = {
  jobType?: string | null; callType?: string | null; urgentFlag?: boolean;
  warrantyCall?: boolean; warrantyNote?: string | null; notes?: string | null;
};

/** A lead with a full address (so conversion makes a job) and the given "What they need" section. */
async function makeLead(suffix: string, needs: Needs = {}, extra: Record<string, unknown> = {}) {
  return prisma.lead.create({
    data: { name: `${TAG} ${suffix}`, source: "phone", email: EMAIL, ...ADDRESS, ...needs, ...extra },
  });
}

const FULL_NEEDS: Needs = {
  jobType: "Panel upgrade", callType: "new_job", urgentFlag: true,
  warrantyCall: true, warrantyNote: "Breaker tripped after the install", notes: "Gate code 4411\nDog in the yard",
};
const FULL_BODY = [
  "From the lead:",
  "Job type: Panel upgrade",
  "Call type: new job",
  "Urgent",
  "Warranty claim: Breaker tripped after the install",
  "Notes: Gate code 4411\nDog in the yard",
].join("\n");

const notesOf = (customerId: string) => prisma.customerNote.findMany({ where: { customerId } });
const sessionName = async () => (await request(app).get("/auth/session").expect(200)).body.name as string;

describe("the note body (leadNeedsNoteBody)", () => {
  const blank = { jobType: null, callType: null, urgentFlag: false, warrantyCall: false, warrantyNote: null, notes: null };

  it("lists only the filled items, one per line, in the form's own words", () => {
    expect(leadNeedsNoteBody({ ...blank, ...FULL_NEEDS })).toBe(FULL_BODY);
    expect(leadNeedsNoteBody({ ...blank, jobType: "EV charger" })).toBe("From the lead:\nJob type: EV charger");
    expect(leadNeedsNoteBody({ ...blank, callType: "estimate_followup", notes: "Call after 3" }))
      .toBe("From the lead:\nCall type: estimate followup\nNotes: Call after 3");
    expect(leadNeedsNoteBody({ ...blank, warrantyCall: true })).toBe("From the lead:\nWarranty call");
  });

  it("is null when the section is empty (blank, whitespace, an unticked warranty box)", () => {
    expect(leadNeedsNoteBody(blank)).toBeNull();
    expect(leadNeedsNoteBody({ ...blank, jobType: "  ", notes: "\n " })).toBeNull();
    // A leftover claim text behind an unticked "Warranty call" is hidden in the form, so it is not "filled".
    expect(leadNeedsNoteBody({ ...blank, warrantyNote: "old text" })).toBeNull();
  });
});

describe("a very long Notes field", () => {
  const blank = { jobType: null, callType: null, urgentFlag: false, warrantyCall: false, warrantyNote: null, notes: null };

  it("is cut so the body stays within the cap the note's own Edit enforces", () => {
    const body = leadNeedsNoteBody({ ...blank, jobType: "Panel upgrade", notes: "x".repeat(12_000) })!;
    expect(body.length).toBeLessThanOrEqual(ACCOUNT_NOTE_BODY_MAX);
    expect(body.startsWith("From the lead:\nJob type: Panel upgrade\nNotes: xxx")).toBe(true);
    expect(body.endsWith("…")).toBe(true);
  });

  it("never leaves half an emoji at the cut", () => {
    const body = leadNeedsNoteBody({ ...blank, notes: "\u{1F600}".repeat(6_000) })!;
    expect(body.length).toBeLessThanOrEqual(ACCOUNT_NOTE_BODY_MAX);
    const beforeEllipsis = body.charCodeAt(body.length - 2);
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
  });

  it("a body at the cap is left alone", () => {
    const filler = "y".repeat(ACCOUNT_NOTE_BODY_MAX - "From the lead:\nNotes: ".length);
    const body = leadNeedsNoteBody({ ...blank, notes: filler })!;
    expect(body.length).toBe(ACCOUNT_NOTE_BODY_MAX);
    expect(body.endsWith("…")).toBe(false);
  });
});

describe("PATCH /leads/:id/convert", () => {
  it("writes ONE call note on the new account, tagged to the new job, taken by the signed-in person", async () => {
    const lead = await makeLead("Convert", FULL_NEEDS);
    const res = await request(app).patch(`/leads/${lead.id}/convert`).send({ createNewAccount: true }).expect(200);

    const notes = await notesOf(res.body.customer.id);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe(FULL_BODY);
    expect(notes[0].visitId).toBe(res.body.visit.id);
    expect(notes[0].takenBy).toBe(await sessionName());
    expect(notes[0].takenBy.length).toBeGreaterThan(0);
    // Written as an ordinary note: createdAt === updatedAt, so it reads as not edited.
    expect(notes[0].updatedAt.getTime()).toBe(notes[0].createdAt.getTime());

    // The job's purpose is exactly what it was: the lead's Notes.
    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: res.body.visit.id } });
    expect(visit.purpose).toBe(FULL_NEEDS.notes);

    // It comes back on the account's Conversation list and the job's tag shows.
    const list = await request(app).get(`/accounts/${res.body.customer.id}/notes`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].body.startsWith("From the lead:")).toBe(true);
    expect(list.body[0].visit.id).toBe(res.body.visit.id);
  });

  it("it is an ordinary note: editable and deletable from the account Conversation", async () => {
    const lead = await makeLead("Editable", { jobType: "Panel upgrade" });
    const res = await request(app).patch(`/leads/${lead.id}/convert`).send({ createNewAccount: true }).expect(200);
    const [note] = await notesOf(res.body.customer.id);

    await request(app).patch(`/accounts/${res.body.customer.id}/notes/${note.id}`).send({ body: "Corrected by the office." }).expect(200);
    expect((await prisma.customerNote.findUniqueOrThrow({ where: { id: note.id } })).body).toBe("Corrected by the office.");
    await request(app).delete(`/accounts/${res.body.customer.id}/notes/${note.id}`).expect(204);
    expect(await notesOf(res.body.customer.id)).toHaveLength(0);
  });

  it("a lead with 12,000 characters of Notes converts, and the note it leaves can still be edited", async () => {
    const lead = await makeLead("LongNotes", { jobType: "Panel upgrade", notes: "n".repeat(12_000) });
    const res = await request(app).patch(`/leads/${lead.id}/convert`).send({ createNewAccount: true }).expect(200);
    const [note] = await notesOf(res.body.customer.id);
    expect(note.body.length).toBeLessThanOrEqual(ACCOUNT_NOTE_BODY_MAX);
    // Edit re-sends the body through the route's own cap; saving it unchanged must work.
    await request(app).patch(`/accounts/${res.body.customer.id}/notes/${note.id}`).send({ body: note.body }).expect(200);
    // The full text is still on the job.
    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: res.body.visit.id } });
    expect(visit.purpose).toHaveLength(12_000);
  });

  it("writes nothing when the lead's 'What they need' section is empty", async () => {
    const lead = await makeLead("Empty");
    const res = await request(app).patch(`/leads/${lead.id}/convert`).send({ createNewAccount: true }).expect(200);
    expect(await notesOf(res.body.customer.id)).toHaveLength(0);
  });

  it("an EXISTING account gets the note too (and other notes on it are untouched)", async () => {
    const existing = await prisma.customer.create({ data: { name: `${TAG} Existing Account` } });
    const earlier = await prisma.customerNote.create({ data: { customerId: existing.id, body: "Earlier call.", takenBy: "Eric" } });
    const lead = await makeLead("Linked", { jobType: "Outlet repair", notes: "Kitchen outlet is dead" }, { customerId: existing.id });

    const res = await request(app).patch(`/leads/${lead.id}/convert`).send({}).expect(200);
    expect(res.body.customer.id).toBe(existing.id);

    const notes = await notesOf(existing.id);
    expect(notes).toHaveLength(2);
    const fromLead = notes.find((n) => n.id !== earlier.id)!;
    expect(fromLead.body).toBe("From the lead:\nJob type: Outlet repair\nNotes: Kitchen outlet is dead");
    expect(fromLead.visitId).toBe(res.body.visit.id);
    expect((await prisma.customerNote.findUniqueOrThrow({ where: { id: earlier.id } })).body).toBe("Earlier call.");
  });

  it("a refused conversion writes NO note: duplicate-account picker, missing address, already converted", async () => {
    // Duplicate account: an account with the lead's email exists and the lead is not linked to it.
    const dupAccount = await prisma.customer.create({ data: { name: `${TAG} Dup Account`, email: EMAIL } });
    const dupLead = await makeLead("Dup", FULL_NEEDS);
    const dup = await request(app).patch(`/leads/${dupLead.id}/convert`).send({}).expect(409);
    expect(dup.body.error).toBe("Possible duplicate account");
    expect(await notesOf(dupAccount.id)).toHaveLength(0);
    expect(await prisma.customerNote.count({ where: { customer: { name: { startsWith: TAG } } } })).toBe(0);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: dupLead.id } })).status).not.toBe("converted");

    // Missing address.
    const noAddr = await makeLead("NoAddress", FULL_NEEDS, { addressLine1: null, city: null, state: null, postalCode: null });
    await request(app).patch(`/leads/${noAddr.id}/convert`).send({ createNewAccount: true }).expect(400);
    expect(await prisma.customerNote.count({ where: { customer: { name: { startsWith: TAG } } } })).toBe(0);

    // Already converted: the second press adds nothing.
    const once = await makeLead("Twice", { jobType: "Panel upgrade" }, { email: "lna-twice@example.com" });
    const first = await request(app).patch(`/leads/${once.id}/convert`).send({ createNewAccount: true }).expect(200);
    await request(app).patch(`/leads/${once.id}/convert`).send({ createNewAccount: true }).expect(409);
    expect(await notesOf(first.body.customer.id)).toHaveLength(1);
  });
});

describe("PATCH /leads/:id/won (the webhook-secret door)", () => {
  it("writes the same ONE note, taken by the fixed label 'Lead intake'", async () => {
    // The webhook door never adopts a match, so this lead must not collide with any account.
    const lead = await makeLead("Won", FULL_NEEDS, { email: "lna-won@example.com" });
    const res = await request(app).patch(`/leads/${lead.id}/won`).set("webhook_secret", SECRET).send({}).expect(200);
    const { customer, visit } = res.body.opportunity;

    const notes = await notesOf(customer.id);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe(FULL_BODY);
    expect(notes[0].visitId).toBe(visit.id);
    expect(notes[0].takenBy).toBe(LEAD_INTAKE_TAKEN_BY);
    expect(LEAD_INTAKE_TAKEN_BY).toBe("Lead intake");
  });

  it("writes nothing when the section is empty, and nothing when the door refuses", async () => {
    const empty = await makeLead("WonEmpty", {}, { email: "lna-wonempty@example.com" });
    const ok = await request(app).patch(`/leads/${empty.id}/won`).set("webhook_secret", SECRET).send({}).expect(200);
    expect(await notesOf(ok.body.opportunity.customer.id)).toHaveLength(0);

    const noAddr = await makeLead("WonNoAddr", FULL_NEEDS, { email: "lna-wonnoaddr@example.com", addressLine1: null, city: null, state: null, postalCode: null });
    await request(app).patch(`/leads/${noAddr.id}/won`).set("webhook_secret", SECRET).send({}).expect(400);
    await request(app).patch(`/leads/${noAddr.id}/won`).set("webhook_secret", "wrong").send({}).expect(401);
    expect(await prisma.customerNote.count({ where: { customer: { name: { startsWith: TAG } } } })).toBe(0);
  });

  it("an existing linked account gets the note", async () => {
    const existing = await prisma.customer.create({ data: { name: `${TAG} Won Existing` } });
    const lead = await makeLead("WonLinked", { notes: "Needs a quote" }, { customerId: existing.id, email: "lna-wonlinked@example.com" });
    await request(app).patch(`/leads/${lead.id}/won`).set("webhook_secret", SECRET).send({}).expect(200);
    const notes = await notesOf(existing.id);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe("From the lead:\nNotes: Needs a quote");
    expect(notes[0].takenBy).toBe("Lead intake");
  });
});

describe("POST /leads/:id/confirm-booking", () => {
  /** A lead holding a website-chat slot a week out: the state the Confirm booking button works on. */
  async function heldLead(suffix: string, needs: Needs, extra: Record<string, unknown> = {}) {
    const lead = await makeLead(suffix, needs, extra);
    const heldStart = new Date(Date.now() + 7 * 86_400_000);
    heldStart.setUTCMinutes(0, 0, 0);
    await prisma.bookingChat.create({
      data: {
        token: `lna-${suffix}-${Date.now()}`, leadId: lead.id, status: "held",
        heldStart, heldEnd: new Date(heldStart.getTime() + 2 * 3_600_000),
      },
    });
    return lead;
  }

  it("writes the same ONE note, tagged to the booked job, taken by the signed-in person", async () => {
    const lead = await heldLead("Confirm", FULL_NEEDS, { email: "lna-confirm@example.com" });
    const res = await request(app).post(`/leads/${lead.id}/confirm-booking`).send({ createNewAccount: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    const notes = await notesOf(after.customerId!);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe(FULL_BODY);
    expect(notes[0].visitId).toBe(res.body.visitId);
    expect(notes[0].takenBy).toBe(await sessionName());
  });

  it("writes nothing when the section is empty, and nothing on a refusal (duplicate account)", async () => {
    const empty = await heldLead("ConfirmEmpty", {}, { email: "lna-confirmempty@example.com" });
    const ok = await request(app).post(`/leads/${empty.id}/confirm-booking`).send({ createNewAccount: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const emptyAfter = await prisma.lead.findUniqueOrThrow({ where: { id: empty.id } });
    expect(await notesOf(emptyAfter.customerId!)).toHaveLength(0);

    const dupAccount = await prisma.customer.create({ data: { name: `${TAG} Confirm Dup`, email: EMAIL } });
    const dup = await heldLead("ConfirmDup", FULL_NEEDS);
    await request(app).post(`/leads/${dup.id}/confirm-booking`).send({}).expect(409);
    expect(await notesOf(dupAccount.id)).toHaveLength(0);
  });

  it("an existing linked account gets the note, and pressing Confirm booking again adds no second one", async () => {
    const existing = await prisma.customer.create({ data: { name: `${TAG} Confirm Existing` } });
    const lead = await heldLead("ConfirmLinked", { jobType: "Ceiling fan" }, { customerId: existing.id, email: "lna-confirmlinked@example.com" });
    const first = await request(app).post(`/leads/${lead.id}/confirm-booking`).send({});
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const notes = await notesOf(existing.id);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe("From the lead:\nJob type: Ceiling fan");
    expect(notes[0].visitId).toBe(first.body.visitId);

    await request(app).post(`/leads/${lead.id}/confirm-booking`).send({});
    expect(await notesOf(existing.id)).toHaveLength(1);
  });
});
