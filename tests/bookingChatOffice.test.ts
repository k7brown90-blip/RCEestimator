/**
 * Website booking chat — what the OFFICE does from the lead drawer (plan
 * 2026-10-30-website-booking-chat, U3): Confirm booking, Release hold, delete a photo, deleting a
 * lead that holds a slot, and the three U2 follow-ups that landed with it (no same-day slots, the
 * held-after-email update to Kyle, the deep link).
 *
 * OpenAI, Google Calendar, email and Twilio are mocked — no network. The chat is built through the
 * real routes (a scripted model), so the HOLD event, photos and prep areas are the real thing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  kyleEmail: vi.fn(),
  customerEmail: vi.fn(),
  customerSms: vi.fn(),
  kyleSms: vi.fn(),
  freebusy: vi.fn(),
  insert: vi.fn(),
  del: vi.fn(),
  busy: { value: false },
  eventSeq: { value: 0 },
}));

vi.mock("openai", () => ({
  default: class {
    responses = { create: mocks.openaiCreate };
  },
}));
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
}));
vi.mock("../src/services/confirmationEmail", async (orig) => ({
  ...(await orig<typeof import("../src/services/confirmationEmail")>()),
  sendKyleNotificationEmail: mocks.kyleEmail,
  sendConfirmationEmail: mocks.customerEmail,
}));
vi.mock("../src/services/notifications", async (orig) => ({
  ...(await orig<typeof import("../src/services/notifications")>()),
  sendCustomerSms: mocks.customerSms,
  sendKyleSms: mocks.kyleSms,
}));
vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials() {}
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: mocks.freebusy },
        events: { insert: mocks.insert, delete: mocks.del, list: vi.fn().mockResolvedValue({ data: { items: [] } }) },
      }),
    },
  };
});

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { holdSlotForChat, listOfferableSlots, todayYmdCT } from "../src/services/bookingChat/scheduling";

const SECRET = "booking-chat-office-test-secret";
const TAG = "BCO";
const EMAIL = "bco.test@example.com";
const PHONE = "615-555-0188";

let tokens: string[] = [];
let ipCounter = 0;
const freshIp = () => `198.51.100.${(ipCounter++ % 250) + 1}-${Date.now()}`;

// ── scripted model ───────────────────────────────────────────────────────────

const say = (text: string) => ({ output_text: text, output: [{ type: "message", content: [{ type: "output_text", text }] }] });
let callSeq = 0;
const call = (name: string, args: unknown) => ({
  output: [{ type: "function_call", call_id: `call_${++callSeq}`, name, arguments: JSON.stringify(args) }],
});
const script = (...responses: unknown[]) => {
  for (const r of responses) mocks.openaiCreate.mockResolvedValueOnce(r);
};

const authed = (r: request.Test) => r.set("webhook_secret", SECRET);

async function send(token: string, text: string) {
  return authed(request(app).post(`/booking-chat/${token}/message`)).send({ text });
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);

function futureDate(daysAhead = 7): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + daysAhead * 86_400_000));
}

/**
 * A chat the way a visitor produces it: lead with an address, a kitchen concern WITH a photo, a
 * panel photo, prep areas, and a held 10:00 block a week out.
 */
async function heldChat(opts: { name?: string; hold?: boolean } = {}) {
  const started = await authed(request(app).post("/booking-chat/start").set("x-visitor-ip", freshIp())).send({ src: "gbp" });
  const token = started.body.token as string;
  tokens.push(token);

  script(
    call("update_work_order", {
      name: opts.name ?? `${TAG} Customer`,
      phone: PHONE,
      email: EMAIL,
      address: "12 Test Lane, Franklin, TN 37064",
      original_request: "Kitchen outlet is dead",
      priority: true,
      priority_quote: "it smells like burning",
      square_footage: "2400",
      year_built: "1998",
      prep_areas: ["Kitchen", "Garage"],
      questions_for_kyle: ["Can you do Saturday?"],
    }),
    say("Thanks. What's the address?"),
  );
  await send(token, "Kitchen outlet dead, it smells like burning");

  const concernPhoto = await authed(request(app).post(`/booking-chat/${token}/photo?kind=concern&room=Kitchen`)).set("Content-Type", "image/jpeg").send(JPEG);
  const panelPhoto = await authed(request(app).post(`/booking-chat/${token}/photo?kind=panel&room=Garage`)).set("Content-Type", "image/jpeg").send(JPEG);
  const concernPhotoId = concernPhoto.body.photoId as string;
  const panelPhotoId = panelPhoto.body.photoId as string;

  script(
    call("update_work_order", { concerns: [{ room: "Kitchen", description: "Outlet by the sink is dead", photo_id: concernPhotoId }] }),
    say("Got it."),
  );
  await send(token, "here is the outlet");

  const date = futureDate();
  if (opts.hold !== false) {
    script(call("book_appointment", { date, startTime: "10:00" }), say("Held."));
    await send(token, "10 works");
  }
  const chat = await prisma.bookingChat.findUniqueOrThrow({ where: { token }, include: { lead: true } });
  return { token, chat, lead: chat.lead!, date, concernPhotoId, panelPhotoId };
}

const confirm = (leadId: string, body: Record<string, unknown> = {}) => request(app).post(`/leads/${leadId}/confirm-booking`).send(body);

async function wipe() {
  await prisma.emailListMember.deleteMany({ where: { email: EMAIL } });
  await prisma.systemEvent.deleteMany({ where: { source: "bookingChat" } });
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.visit.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.systemSnapshot.deleteMany({ where: { property: { customer: { name: { startsWith: TAG } } } } });
  await prisma.property.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
}

let savedTerritories: string | null = null;

beforeAll(async () => {
  process.env.WEBHOOK_SECRET = SECRET;
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.PUBLIC_BASE_URL = "https://crm.example.test";
  const row = await prisma.companySetting.findUnique({ where: { key: "territories" } });
  savedTerritories = row?.valueJson ?? null;
  await prisma.companySetting.deleteMany({ where: { key: "territories" } });
});

beforeEach(async () => {
  tokens = [];
  mocks.busy.value = false;
  mocks.openaiCreate.mockReset();
  mocks.kyleEmail.mockReset().mockResolvedValue(true);
  mocks.customerEmail.mockReset().mockResolvedValue(true);
  mocks.customerSms.mockReset().mockResolvedValue(null);
  mocks.kyleSms.mockReset().mockResolvedValue(null);
  mocks.insert.mockReset().mockImplementation(async ({ requestBody }: { requestBody: { summary: string; start: unknown; end: unknown } }) => ({
    data: { id: `evt_${++mocks.eventSeq.value}`, summary: requestBody.summary, start: requestBody.start, end: requestBody.end },
  }));
  mocks.del.mockReset().mockResolvedValue({});
  mocks.freebusy.mockReset().mockImplementation(async ({ requestBody }: { requestBody: { timeMin: string; timeMax: string; items: Array<{ id: string }> } }) => {
    const busy = mocks.busy.value ? [{ start: requestBody.timeMin, end: requestBody.timeMax }] : [];
    return { data: { calendars: Object.fromEntries(requestBody.items.map((i) => [i.id, { busy }])) } };
  });
  await prisma.slotHold.deleteMany();
  await wipe();
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.bookingChat.deleteMany({ where: { token: { in: tokens } } });
});

afterAll(async () => {
  await wipe();
  await prisma.slotHold.deleteMany();
  if (savedTerritories !== null) {
    await prisma.companySetting.create({ data: { key: "territories", valueJson: savedTerritories } });
  }
  delete process.env.WEBHOOK_SECRET;
  delete process.env.OPENAI_API_KEY;
  delete process.env.PUBLIC_BASE_URL;
});

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean) {
  for (let i = 0; i < 60; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /leads/:leadId — the drawer's read", () => {
  it("carries the chat (parsed) and photo METADATA, never bytes or the chat token", async () => {
    const { lead, concernPhotoId, panelPhotoId } = await heldChat();
    const res = await request(app).get(`/leads/${lead.id}`).expect(200);

    const chat = res.body.bookingChat;
    expect(chat.status).toBe("held");
    expect(chat).toMatchObject({
      priority: true, priorityQuote: "it smells like burning", originalRequest: "Kitchen outlet is dead",
      squareFootage: "2400", yearBuilt: "1998", srcParam: "gbp", platform: "google",
      questionsForKyle: ["Can you do Saturday?"], prepAreas: ["Kitchen", "Garage"],
    });
    expect(chat.concerns).toEqual([{ room: "Kitchen", description: "Outlet by the sink is dead", photoId: concernPhotoId }]);
    expect(chat.heldLabel).toMatch(/10:00 AM – 12:00 PM/);
    expect(Array.isArray(chat.transcript)).toBe(true);
    expect(chat.transcript.length).toBeGreaterThan(0);
    expect(chat.token).toBeUndefined();
    expect(chat.visitorIpHash).toBeUndefined();

    expect(res.body.photos.map((p: { id: string }) => p.id).sort()).toEqual([concernPhotoId, panelPhotoId].sort());
    for (const p of res.body.photos) {
      expect(p.data).toBeUndefined();
      expect(p).toMatchObject({ mimeType: "image/jpeg", sizeBytes: JPEG.length });
    }
  });

  it("a lead that never used the chat reads as before: bookingChat null, no photos", async () => {
    const lead = await prisma.lead.create({ data: { name: `${TAG} Phone Lead`, source: "phone" } });
    const res = await request(app).get(`/leads/${lead.id}`).expect(200);
    expect(res.body.bookingChat).toBeNull();
    expect(res.body.photos).toEqual([]);
  });
});

describe("GET /leads/:leadId/photos/:photoId", () => {
  it("serves the bytes with their mime type, and 404s a photo through the wrong lead", async () => {
    const a = await heldChat();
    const b = await heldChat({ name: `${TAG} Other` });
    const ok = await request(app).get(`/leads/${a.lead.id}/photos/${a.concernPhotoId}`).expect(200);
    expect(ok.headers["content-type"]).toMatch(/image\/jpeg/);
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(ok.body as Buffer, JPEG)).toBe(0);
    await request(app).get(`/leads/${b.lead.id}/photos/${a.concernPhotoId}`).expect(404);
  });
});

describe("POST /leads/:leadId/confirm-booking", () => {
  it("converts the lead, schedules the job at the held time, copies the photos, confirms the chat and emails both people", async () => {
    const { lead, chat, concernPhotoId } = await heldChat();
    const heldEventId = chat.heldEventId!;
    mocks.insert.mockClear();
    mocks.kyleEmail.mockClear();

    const res = await confirm(lead.id).expect(200);
    expect(res.body).toMatchObject({ photosCopied: 2, customerEmail: EMAIL, kyleEmailed: true });
    expect(res.body.warnings).toEqual([]);

    // Lead converted through the existing path.
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe("converted");
    expect(after.visitId).toBe(res.body.visitId);

    // The job is scheduled exactly at the held block — a 2-hour estimate.
    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: res.body.visitId } });
    expect(visit.status).toBe("estimate");
    expect(visit.scheduledStart!.getTime()).toBe(chat.heldStart!.getTime());
    expect(visit.scheduledEnd!.getTime() - visit.scheduledStart!.getTime()).toBe(2 * 3_600_000);
    expect(visit.googleEventId).toMatch(/^evt_/);
    expect(visit.googleEventId).not.toBe(heldEventId);

    // ONE calendar event now: the job's. The HOLD was deleted.
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insert.mock.calls[0][0].requestBody.summary).toMatch(/^ESTIMATE: /);
    expect(mocks.del).toHaveBeenCalledWith({ calendarId: "primary", eventId: heldEventId });

    // The customer email is the one scheduleJob already sends, now carrying the prep reminder.
    await waitFor(() => mocks.customerEmail.mock.calls.length, (n) => n >= 1);
    expect(mocks.customerEmail).toHaveBeenCalledTimes(1);
    const sent = mocks.customerEmail.mock.calls[0][0];
    expect(sent.customerEmail).toBe(EMAIL);
    expect(sent.prepReminder).toEqual({ dayName: expect.stringMatching(/^[A-Z][a-z]+day$/), areas: ["Kitchen", "Garage"] });

    // Photos are the job's now, tagged reference, no technician, captioned with room + words.
    const photos = await prisma.visitPhoto.findMany({ where: { visitId: visit.id }, orderBy: { caption: "asc" } });
    expect(photos).toHaveLength(2);
    for (const p of photos) {
      expect(p).toMatchObject({ tag: "reference", technicianId: null, mimeType: "image/jpeg" });
      expect(Buffer.compare(Buffer.from(p.data), JPEG)).toBe(0);
    }
    expect(photos.map((p) => p.caption)).toEqual(["Electrical panel (homeowner's photo)", "Kitchen — Outlet by the sink is dead"]);
    // The lead's own photos are untouched (the exit for them is the drawer's delete).
    expect(await prisma.leadPhoto.count({ where: { leadId: lead.id } })).toBe(2);
    expect(concernPhotoId).toBeTruthy();

    // Chat confirmed.
    const confirmed = await prisma.bookingChat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(confirmed.heldEventId).toBeNull();

    // Kyle's confirmation: day, time, address, name, phone, email, request, prep, the JOB link; escaped.
    const kyleCall = mocks.kyleEmail.mock.calls.find(([subject]) => String(subject).startsWith("Booking confirmed"));
    expect(kyleCall).toBeTruthy();
    const [, body] = kyleCall as [string, string];
    expect(body).toContain("10:00 AM – 12:00 PM");
    expect(body).toContain(`Name: ${TAG} Customer`);
    expect(body).toContain(`Phone: ${PHONE}`);
    expect(body).toContain(`Email: ${EMAIL}`);
    expect(body).toContain("12 Test Lane");
    expect(body).toContain("Request: Kitchen outlet is dead");
    expect(body).toContain("Prep areas: Kitchen; Garage");
    expect(body).toContain("it smells like burning");
    expect(body).toContain(`https://crm.example.test/jobs?job=${visit.id}`);

    // A second press is refused, not repeated.
    const again = await confirm(lead.id);
    expect(again.status).toBe(409);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });

  it("escapes what the visitor typed in Kyle's confirmation", async () => {
    const { lead, chat } = await heldChat();
    await prisma.bookingChat.update({ where: { id: chat.id }, data: { originalRequest: "<script>alert(1)</script>", prepAreasJson: JSON.stringify(["<b>attic</b>"]) } });
    await confirm(lead.id).expect(200);
    const [, body] = mocks.kyleEmail.mock.calls.find(([s]) => String(s).startsWith("Booking confirmed")) as [string, string];
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("&lt;b&gt;attic&lt;/b&gt;");
  });

  it("a duplicate-account refusal writes NOTHING: hold kept, no visit, no photos copied, no email", async () => {
    const { lead, chat } = await heldChat();
    const existing = await prisma.customer.create({ data: { name: `${TAG} Existing`, phone: PHONE, email: EMAIL } });
    mocks.del.mockClear();
    mocks.insert.mockClear();
    mocks.kyleEmail.mockClear();

    const res = await confirm(lead.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Possible duplicate account");
    expect(res.body.matches.map((m: { customerId: string }) => m.customerId)).toContain(existing.id);

    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("new");
    const kept = await prisma.bookingChat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(kept.status).toBe("held");
    expect(kept.heldEventId).toBe(chat.heldEventId);
    expect(mocks.del).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.kyleEmail).not.toHaveBeenCalled();
    expect(await prisma.visitPhoto.count({ where: { visit: { customerId: existing.id } } })).toBe(0);
    expect(await prisma.visit.count({ where: { customerId: existing.id } })).toBe(0);

    // The picker's answer goes through the same door: link the account and its address.
    const linked = await confirm(lead.id, { customerId: existing.id }).expect(200);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).customerId).toBe(existing.id);
    expect(linked.body.customerId).toBe(existing.id);
    expect((await prisma.bookingChat.findUniqueOrThrow({ where: { id: chat.id } })).status).toBe("confirmed");
  });

  it("a scheduling failure never touches the hold, reports it, and a second press finishes the job", async () => {
    const { lead, chat } = await heldChat();
    mocks.del.mockClear();
    mocks.insert.mockClear();
    mocks.insert.mockRejectedValueOnce(new Error("Google is down"));

    const failed = await confirm(lead.id);
    expect(failed.status).toBe(502);
    expect(failed.body.error).toMatch(/could not be scheduled: Google is down/);
    expect(failed.body.error).toMatch(/hold is still in place/);

    // The customer still has their HOLD: never neither.
    expect(mocks.del).not.toHaveBeenCalled();
    const kept = await prisma.bookingChat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(kept.status).toBe("held");
    expect(kept.heldEventId).toBe(chat.heldEventId);
    expect(mocks.customerEmail).not.toHaveBeenCalled();
    expect(await prisma.visitPhoto.count({ where: { visit: { customer: { name: { startsWith: TAG } } } } })).toBe(0);

    // The lead was converted (that part succeeded); retry carries on with that job.
    const converted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(converted.status).toBe("converted");
    const customers = await prisma.customer.count({ where: { name: { startsWith: TAG } } });

    const retry = await confirm(lead.id).expect(200);
    expect(retry.body.visitId).toBe(converted.visitId);
    expect(await prisma.customer.count({ where: { name: { startsWith: TAG } } })).toBe(customers);
    expect(mocks.del).toHaveBeenCalledWith({ calendarId: "primary", eventId: chat.heldEventId });
    expect((await prisma.bookingChat.findUniqueOrThrow({ where: { id: chat.id } })).status).toBe("confirmed");
  });

  it("refuses a chat that holds nothing, and a lead that never used the chat", async () => {
    const { lead } = await heldChat({ hold: false });
    const none = await confirm(lead.id);
    expect(none.status).toBe(409);
    expect(none.body.error).toMatch(/no held time/i);
    const phoneLead = await prisma.lead.create({ data: { name: `${TAG} Phone Lead`, source: "phone" } });
    expect((await confirm(phoneLead.id)).status).toBe(404);
    expect((await confirm("no-such-lead")).status).toBe(404);
  });
});

describe("POST /leads/:leadId/release-hold", () => {
  it("deletes the HOLD event, marks the chat released, clears the slot, keeps the lead", async () => {
    const { lead, chat } = await heldChat();
    mocks.del.mockClear();
    await request(app).post(`/leads/${lead.id}/release-hold`).expect(200);

    expect(mocks.del).toHaveBeenCalledWith({ calendarId: "primary", eventId: chat.heldEventId });
    const after = await prisma.bookingChat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(after).toMatchObject({ status: "released", heldEventId: null, heldStart: null, heldEnd: null });
    expect(after.releasedAt).not.toBeNull();
    expect(await prisma.lead.findUnique({ where: { id: lead.id } })).not.toBeNull();
    // Nothing went to the customer.
    expect(mocks.customerEmail).not.toHaveBeenCalled();

    // Nothing left to release.
    expect((await request(app).post(`/leads/${lead.id}/release-hold`)).status).toBe(409);
  });

  it("changes nothing when Google refuses, and treats an already-deleted event as released", async () => {
    const { lead, chat } = await heldChat();
    mocks.del.mockRejectedValueOnce(Object.assign(new Error("backend error"), { code: 500 }));
    const refused = await request(app).post(`/leads/${lead.id}/release-hold`);
    expect(refused.status).toBe(502);
    expect((await prisma.bookingChat.findUniqueOrThrow({ where: { id: chat.id } })).status).toBe("held");

    mocks.del.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { code: 404 }));
    await request(app).post(`/leads/${lead.id}/release-hold`).expect(200);
    expect((await prisma.bookingChat.findUniqueOrThrow({ where: { id: chat.id } })).status).toBe("released");
  });

  it("marking the lead lost frees the held slot too", async () => {
    const { lead, chat } = await heldChat();
    mocks.del.mockClear();
    await request(app).patch(`/leads/${lead.id}`).send({ status: "lost", leadStatus: "lost", lostReason: "timing" }).expect(200);
    expect(mocks.del).toHaveBeenCalledWith({ calendarId: "primary", eventId: chat.heldEventId });
    expect((await prisma.bookingChat.findUniqueOrThrow({ where: { id: chat.id } })).status).toBe("released");
  });
});

describe("DELETE /leads/:leadId/photos/:photoId", () => {
  it("deletes the photo and takes its id out of the concerns so nothing dangles", async () => {
    const { lead, chat, concernPhotoId, panelPhotoId } = await heldChat();
    await request(app).delete(`/leads/${lead.id}/photos/${concernPhotoId}`).expect(200);

    expect(await prisma.leadPhoto.findUnique({ where: { id: concernPhotoId } })).toBeNull();
    expect(await prisma.leadPhoto.findUnique({ where: { id: panelPhotoId } })).not.toBeNull();
    const row = await prisma.bookingChat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(row.concernsJson).not.toContain(concernPhotoId);
    // The concern itself — the customer's words — stays.
    expect(JSON.parse(row.concernsJson)).toEqual([{ room: "Kitchen", description: "Outlet by the sink is dead" }]);

    await request(app).delete(`/leads/${lead.id}/photos/${concernPhotoId}`).expect(404);
  });

  it("will not delete another lead's photo through this lead", async () => {
    const a = await heldChat();
    const b = await heldChat({ name: `${TAG} Other` });
    await request(app).delete(`/leads/${b.lead.id}/photos/${a.concernPhotoId}`).expect(404);
    expect(await prisma.leadPhoto.findUnique({ where: { id: a.concernPhotoId } })).not.toBeNull();
  });
});

describe("DELETE /leads/:leadId — a lead that holds a slot", () => {
  it("deletes the HOLD event first, then the lead (and its chat and photos by cascade)", async () => {
    const { lead, chat } = await heldChat();
    mocks.del.mockClear();
    await request(app).delete(`/leads/${lead.id}`).expect(204);
    expect(mocks.del).toHaveBeenCalledWith({ calendarId: "primary", eventId: chat.heldEventId });
    expect(await prisma.lead.findUnique({ where: { id: lead.id } })).toBeNull();
    expect(await prisma.bookingChat.findUnique({ where: { id: chat.id } })).toBeNull();
    expect(await prisma.leadPhoto.count({ where: { leadId: lead.id } })).toBe(0);
  });

  it("still deletes the lead when the calendar will not delete the event, and logs the event id", async () => {
    const { lead, chat } = await heldChat();
    mocks.del.mockRejectedValueOnce(new Error("calendar down"));
    await request(app).delete(`/leads/${lead.id}`).expect(204);
    expect(await prisma.lead.findUnique({ where: { id: lead.id } })).toBeNull();
    const logged = await waitFor(
      () => prisma.systemEvent.findMany({ where: { source: "bookingChat", level: "error" } }),
      (rows) => rows.some((e) => e.message.includes("HOLD event could not be deleted")),
    );
    expect(logged.some((e) => e.message.includes("HOLD event could not be deleted") && (e.detailsJson ?? "").includes(chat.heldEventId!))).toBe(true);
  });

  it("a chat lead with no hold deletes without touching the calendar", async () => {
    const { lead } = await heldChat({ hold: false });
    mocks.del.mockClear();
    await request(app).delete(`/leads/${lead.id}`).expect(204);
    expect(mocks.del).not.toHaveBeenCalled();
  });
});

describe("no same-day slots", () => {
  it("never offers today, and refuses to hold today, however the model asks", async () => {
    // 7:00 AM Central on a Tuesday: today's whole day of blocks would otherwise be on offer.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T13:00:00Z") });
    expect(todayYmdCT()).toBe("2026-11-10");

    const { slots } = await listOfferableSlots({});
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].date).toBe("2026-11-11");
    expect(slots.some((s) => s.date <= "2026-11-10")).toBe(false);

    const { chat } = await heldChat({ hold: false });
    const today = await holdSlotForChat(chat.id, { date: "2026-11-10", startTime: "14:00" });
    expect(today).toMatchObject({ ok: false, code: "bad_slot" });
    expect((today as { message: string }).message).toMatch(/same-day/i);
    expect(mocks.insert).not.toHaveBeenCalled();

    const tomorrow = await holdSlotForChat(chat.id, { date: "2026-11-11", startTime: "08:00" });
    expect(tomorrow.ok).toBe(true);
  });
});

describe("a hold made after Kyle was already emailed", () => {
  it("sends him a short 'now HELD' update, escaped, with the lead link", async () => {
    const { token, chat, lead } = await heldChat({ hold: false });
    await prisma.bookingChat.update({ where: { id: chat.id }, data: { kyleNotifiedAt: new Date() } });
    await prisma.lead.update({ where: { id: lead.id }, data: { name: `${TAG} <i>Customer</i>` } });
    mocks.kyleEmail.mockClear();

    script(call("book_appointment", { date: futureDate(), startTime: "14:00" }), say("Held."));
    await send(token, "2pm");

    expect(mocks.kyleEmail).toHaveBeenCalledTimes(1);
    const [subject, body] = mocks.kyleEmail.mock.calls[0] as [string, string];
    expect(subject).toMatch(/now HELD/);
    expect(subject).toMatch(/2:00 PM – 4:00 PM/);
    expect(body).toContain("&lt;i&gt;Customer&lt;/i&gt;");
    expect(body).not.toContain("<i>");
    expect(body).toContain(`https://crm.example.test/leads?lead=${lead.id}`);
  });

  it("sends nothing extra when he has not been emailed yet — the one email will carry the hold", async () => {
    const { chat } = await heldChat({ hold: false });
    expect(chat.kyleNotifiedAt).toBeNull();
    mocks.kyleEmail.mockClear();
    const r = await holdSlotForChat(chat.id, { date: futureDate(), startTime: "10:00" });
    expect(r.ok).toBe(true);
    expect(mocks.kyleEmail).not.toHaveBeenCalled();
  });
});

describe("Kyle's lead email deep-links to the lead's drawer", () => {
  it("points at /leads?lead=<id>, which the CRM opens as a drawer on any route", async () => {
    const { token, lead } = await heldChat();
    script(call("end_conversation", { outcome: "completed" }), say("Thanks."));
    await send(token, "that's all");
    const [, body] = mocks.kyleEmail.mock.calls[0] as [string, string];
    expect(body).toContain(`https://crm.example.test/leads?lead=${lead.id}`);
  });
});

describe("markup and junk are refused at update_work_order (security review M1, second layer)", () => {
  it("rejects < and > in name and address, and a phone that is not digits and phone punctuation — and saves nothing", async () => {
    const started = await authed(request(app).post("/booking-chat/start").set("x-visitor-ip", freshIp())).send({});
    const token = started.body.token as string;
    tokens.push(token);
    const outputs = () => {
      const calls = mocks.openaiCreate.mock.calls;
      const input = calls[calls.length - 1][0].input as Array<{ type?: string; output?: string }>;
      return input.filter((i) => i.type === "function_call_output").map((i) => JSON.parse(i.output!));
    };

    const bad: Array<Record<string, string>> = [
      { name: `${TAG} <a href="https://evil.example">x</a>`, phone: PHONE },
      { name: `${TAG} Ok`, phone: PHONE, address: "1 Main St <script>alert(1)</script>, Franklin, TN 37064" },
      { name: `${TAG} Ok`, phone: "615-555-0100 call me <b>" },
      { name: `${TAG} Ok`, phone: "see my email jane@example.com 6155550100" },
      { name: `${TAG} Ok`, phone: "615555010x" },
    ];
    for (const args of bad) {
      script(call("update_work_order", args), say("Could you say that again?"));
      await send(token, "details");
      expect(outputs()[0], JSON.stringify(args)).toMatchObject({ ok: false });
    }
    expect(await prisma.lead.count({ where: { name: { startsWith: TAG } } })).toBe(0);

    // The usual ways of writing a number still go through.
    for (const phone of ["615-555-0100", "(615) 555-0100", "+1 615.555.0100", "6155550100"]) {
      const t = (await authed(request(app).post("/booking-chat/start").set("x-visitor-ip", freshIp())).send({})).body.token as string;
      tokens.push(t);
      script(call("update_work_order", { name: `${TAG} Fine`, phone }), say("Thanks."));
      await send(t, "details");
      const chat = await prisma.bookingChat.findUniqueOrThrow({ where: { token: t }, include: { lead: true } });
      expect(chat.lead?.phone, phone).toBe(phone);
    }
  });
});

describe("Kyle's 'Job Scheduled' email escapes the customer's name and address (security review M1)", () => {
  it("a name that is trying to be markup reaches Kyle as text", async () => {
    const { lead } = await heldChat();
    await prisma.lead.update({ where: { id: lead.id }, data: { name: `${TAG} <a href="https://evil.example">Pay</a>` } });
    await confirm(lead.id).expect(200);
    const call = mocks.kyleEmail.mock.calls.find(([s]) => s === "Job Scheduled");
    expect(call).toBeTruthy();
    const body = call![1] as string;
    expect(body).not.toContain("<a href=");
    expect(body).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;Pay&lt;/a&gt;");
  });
});
