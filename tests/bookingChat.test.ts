/**
 * Website booking chat — server side (plan 2026-10-30-website-booking-chat, U2).
 *
 * OpenAI, Google Calendar, email and Twilio are all mocked: no test touches a network. The model is
 * "scripted" — each test queues the exact tool calls and replies the model would produce, and the
 * real routes, tools, database and slot-hold core run against them.
 */
import crypto from "node:crypto";
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
  omitCalendars: { value: false },
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
import { runBookingChatIdleSweep } from "../src/services/bookingChat/notifyKyle";

const SECRET = "booking-chat-test-secret";
const TAG = "BC Test";
const IP_PREFIX = "203.0.113.";

let tokens: string[] = [];
let ipCounter = 0;
const freshIp = () => `${IP_PREFIX}${(ipCounter++ % 250) + 1}-${Date.now()}`;

// ── scripted model ───────────────────────────────────────────────────────────

const say = (text: string) => ({ output_text: text, output: [{ type: "message", content: [{ type: "output_text", text }] }] });
let callSeq = 0;
const call = (name: string, args: unknown) => ({
  output: [{ type: "function_call", call_id: `call_${++callSeq}`, name, arguments: JSON.stringify(args) }],
});
const script = (...responses: unknown[]) => {
  for (const r of responses) mocks.openaiCreate.mockResolvedValueOnce(r);
};

/** The function_call_output the model was handed on a given round of the latest turn. */
function toolOutputs(): Array<Record<string, unknown>> {
  const calls = mocks.openaiCreate.mock.calls;
  const lastInput = calls[calls.length - 1][0].input as Array<{ type?: string; output?: string }>;
  return lastInput.filter((i) => i.type === "function_call_output").map((i) => JSON.parse(i.output!));
}

// ── http helpers ─────────────────────────────────────────────────────────────

const authed = (r: request.Test) => r.set("webhook_secret", SECRET);

async function start(src?: string, ip = freshIp()) {
  const res = await authed(request(app).post("/booking-chat/start").set("x-visitor-ip", ip)).send(src ? { src } : {});
  if (res.body.token) tokens.push(res.body.token);
  return res;
}

async function send(token: string, text: string, extra: Record<string, unknown> = {}) {
  return authed(request(app).post(`/booking-chat/${token}/message`)).send({ text, ...extra });
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

async function upload(token: string, body: Buffer = JPEG, type = "image/jpeg", query = "kind=concern&room=Kitchen") {
  return authed(request(app).post(`/booking-chat/${token}/photo?${query}`)).set("Content-Type", type).send(body);
}

/** Start a chat and get a Lead on it via a scripted update_work_order. */
async function chatWithLead(opts: { name?: string; address?: string; src?: string; extra?: Record<string, unknown> } = {}) {
  const res = await start(opts.src);
  const token = res.body.token as string;
  script(
    call("update_work_order", {
      original_request: "Outlet in the kitchen stopped working",
      name: opts.name ?? `${TAG} Customer`,
      phone: "615-555-0142",
      email: "bc.test@example.com",
      address: opts.address ?? "12 Test Lane, Franklin, TN 37064",
      ...opts.extra,
    }),
    say("Thanks. What's the address?"),
  );
  await send(token, "Kitchen outlet is dead. Jane, 615-555-0142");
  const chat = await prisma.bookingChat.findUniqueOrThrow({ where: { token }, include: { lead: true } });
  return { token, chat, lead: chat.lead! };
}

/** A real, future YYYY-MM-DD in Central Time. */
function futureDate(daysAhead = 7): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + daysAhead * 86_400_000));
}

async function setTerritories(zips: string[] | null) {
  if (zips === null) {
    await prisma.companySetting.deleteMany({ where: { key: "territories" } });
    return;
  }
  const valueJson = JSON.stringify(zips.map((zip) => ({ zip, area: "Test Area" })));
  await prisma.companySetting.upsert({ where: { key: "territories" }, create: { key: "territories", valueJson }, update: { valueJson } });
}

async function waitForEvent(level: string, needle: string) {
  for (let i = 0; i < 40; i++) {
    const rows = await prisma.systemEvent.findMany({ where: { source: "bookingChat", level }, orderBy: { createdAt: "desc" }, take: 20 });
    if (rows.some((r) => r.message.includes(needle))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

let savedTerritories: string | null = null;

beforeAll(async () => {
  process.env.WEBHOOK_SECRET = SECRET;
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  const row = await prisma.companySetting.findUnique({ where: { key: "territories" } });
  savedTerritories = row?.valueJson ?? null;
});

beforeEach(async () => {
  tokens = [];
  mocks.busy.value = false;
  mocks.omitCalendars.value = false;
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
    if (mocks.omitCalendars.value) return { data: { calendars: {} } };
    const busy = mocks.busy.value ? [{ start: requestBody.timeMin, end: requestBody.timeMax }] : [];
    return { data: { calendars: Object.fromEntries(requestBody.items.map((i) => [i.id, { busy }])) } };
  });
  await setTerritories(null);
  await prisma.slotHold.deleteMany();
});

afterEach(async () => {
  const chats = await prisma.bookingChat.findMany({ where: { token: { in: tokens } }, select: { leadId: true } });
  await prisma.bookingChat.deleteMany({ where: { token: { in: tokens } } });
  await prisma.lead.deleteMany({ where: { id: { in: chats.map((c) => c.leadId).filter((x): x is string => !!x) } } });
});

afterAll(async () => {
  await prisma.slotHold.deleteMany();
  await prisma.companySetting.deleteMany({ where: { key: "territories" } });
  if (savedTerritories !== null) {
    await prisma.companySetting.create({ data: { key: "territories", valueJson: savedTerritories } });
  }
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
  delete process.env.WEBHOOK_SECRET;
  delete process.env.OPENAI_API_KEY;
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the website secret guards every route", () => {
  it("refuses all three routes without it, and with a wrong one", async () => {
    await request(app).post("/booking-chat/start").send({}).expect(401);
    await request(app).post("/booking-chat/sometoken/message").send({ text: "hi" }).expect(401);
    await request(app).post("/booking-chat/sometoken/photo").set("Content-Type", "image/jpeg").send(JPEG).expect(401);
    await request(app).post("/booking-chat/start").set("webhook_secret", "nope").send({}).expect(401);
    expect(mocks.openaiCreate).not.toHaveBeenCalled();
  });

  it("answers 404 with a reply for a token that does not exist", async () => {
    const res = await send("no-such-token", "hello");
    expect(res.status).toBe(404);
    expect(res.body.reply).toContain("(615) 625-2163");
  });
});

describe("POST /booking-chat/start", () => {
  it("issues an unguessable token, returns the step-1 greeting, stores the hashed IP", async () => {
    const ip = freshIp();
    const res = await start(undefined, ip);
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43,}$/); // 32 random bytes, url-safe
    expect(res.body.reply).toMatch(/scheduling assistant \(AI\)/);
    const chat = await prisma.bookingChat.findUniqueOrThrow({ where: { token: res.body.token } });
    expect(chat.visitorIpHash).toBe(crypto.createHash("sha256").update(ip).digest("hex"));
    expect(chat.status).toBe("open");
  });

  it("maps ?src= onto a lead platform: gbp and lsa are google, unknown is other, none is null", async () => {
    const cases: Array<[string | undefined, string | null]> = [
      ["gbp", "google"], ["lsa", "google"], ["GBP", "google"], ["yelp", "yelp"], ["somewhere-odd", "other"], [undefined, null],
    ];
    for (const [src, platform] of cases) {
      const res = await start(src);
      const chat = await prisma.bookingChat.findUniqueOrThrow({ where: { token: res.body.token } });
      expect(chat.platform, `src=${src}`).toBe(platform);
      expect(chat.srcParam).toBe(src ?? null);
    }
  });

  it("refuses a sixth chat from one visitor in 24 hours, politely, with the phone number", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) expect((await start(undefined, ip)).status).toBe(201);
    const sixth = await start(undefined, ip);
    expect(sixth.status).toBe(429);
    expect(sixth.body.reply).toContain("(615) 625-2163");
    expect(sixth.body.token).toBeUndefined();
    // A different visitor is unaffected.
    expect((await start()).status).toBe(201);
  });
});

describe("update_work_order", () => {
  it("creates no Lead until a phone number arrives, and never takes status or appointment from the model", async () => {
    const { body } = await start("gbp");
    const token = body.token as string;

    script(
      call("update_work_order", {
        original_request: "Breaker keeps tripping", priority: true, priority_quote: "it smells like burning",
        status: "held", appointment: "2026-11-02 10:00", lead_source: "evil",
      }),
      say("Got it. What's your name, best phone number, and email?"),
    );
    const first = await send(token, "My breaker keeps tripping and it smells like burning");
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("open");
    expect(first.body.acceptsPhotos).toBe(false);
    expect(first.body.heldSlot).toBeNull();

    const early = await prisma.bookingChat.findUniqueOrThrow({ where: { token } });
    expect(early.leadId).toBeNull();
    expect(early.priority).toBe(true);
    expect(early.priorityQuote).toBe("it smells like burning");
    expect(early.originalRequest).toBe("Breaker keeps tripping");
    expect(early.status).toBe("open");
    expect(early.srcParam).toBe("gbp");
    expect(early.heldEventId).toBeNull();

    script(
      call("update_work_order", { name: `${TAG} Jane`, phone: "(615) 555-0100", email: "jane@example.com", address: "1 Main St, Franklin, TN 37064" }),
      say("Thanks Jane."),
    );
    const second = await send(token, "Jane, 615-555-0100, jane@example.com");
    expect(second.body.status).toBe("unbooked");
    expect(second.body.acceptsPhotos).toBe(true);

    const chat = await prisma.bookingChat.findUniqueOrThrow({ where: { token }, include: { lead: true } });
    expect(chat.lead).not.toBeNull();
    expect(chat.lead!.source).toBe("web");
    expect(chat.lead!.platform).toBe("google");
    expect(chat.lead!.name).toBe(`${TAG} Jane`);
    expect(chat.lead!.urgentFlag).toBe(true);
    expect(chat.lead!.notes).toContain("it smells like burning");
    expect(chat.lead!.smsConsent).toBeNull(); // never inferred
  });

  it("records smsConsent only from a boolean the website sent", async () => {
    const { token, lead } = await chatWithLead();
    expect(lead.smsConsent).toBeNull();

    script(say("Sure."));
    await send(token, "ok", { smsConsent: true });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).smsConsent).toBe(true);

    script(say("Sure."));
    await send(token, "ok", { smsConsent: "yes" }); // not a boolean -> request refused, nothing inferred
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).smsConsent).toBe(true);
  });

  it("creates the Lead with the consent that arrived on the same message", async () => {
    const { body } = await start();
    script(call("update_work_order", { name: `${TAG} Consent`, phone: "615-555-0111" }), say("Thanks."));
    await send(body.token, "Consent, 615-555-0111", { smsConsent: false });
    const chat = await prisma.bookingChat.findUniqueOrThrow({ where: { token: body.token }, include: { lead: true } });
    expect(chat.lead!.smsConsent).toBe(false);
  });

  it("keeps concerns as added, drops a photo id that is not this lead's, keeps one that is", async () => {
    const a = await chatWithLead({ name: `${TAG} A` });
    const b = await chatWithLead({ name: `${TAG} B` });
    const photoA = (await upload(a.token)).body.photoId as string;
    expect(photoA).toBeTruthy();

    // B tries to attach A's photo to a concern.
    script(
      call("update_work_order", { concerns: [{ room: "Garage", description: "Light flickers", photo_id: photoA }] }),
      say("Got it."),
    );
    await send(b.token, "garage light flickers");
    expect(toolOutputs()[0].ignored).toEqual([expect.stringContaining(photoA)]);
    let chatB = await prisma.bookingChat.findUniqueOrThrow({ where: { token: b.token } });
    expect(JSON.parse(chatB.concernsJson)).toEqual([{ room: "Garage", description: "Light flickers" }]);

    // A may reference its own photo; concerns accumulate rather than replace.
    script(call("update_work_order", { concerns: [{ room: "Kitchen", description: "Dead outlet", photo_id: photoA }] }), say("Got it."));
    await send(a.token, "dead outlet");
    script(call("update_work_order", { concerns: [{ room: "Garage", description: "Dim light" }] }), say("Got it."));
    await send(a.token, "dim light");
    const chatA = await prisma.bookingChat.findUniqueOrThrow({ where: { token: a.token } });
    expect(JSON.parse(chatA.concernsJson)).toEqual([
      { room: "Kitchen", description: "Dead outlet", photoId: photoA },
      { room: "Garage", description: "Dim light" },
    ]);
    chatB = await prisma.bookingChat.findUniqueOrThrow({ where: { token: b.token } });
    expect(JSON.parse(chatB.concernsJson)).toHaveLength(1);
  });

  it("does not save a phone number that cannot be a phone number", async () => {
    const { body } = await start();
    script(call("update_work_order", { name: `${TAG} Short`, phone: "555" }), say("What's your number?"));
    await send(body.token, "555");
    const chat = await prisma.bookingChat.findUniqueOrThrow({ where: { token: body.token } });
    expect(chat.leadId).toBeNull();
  });
});

describe("check_service_area", () => {
  it("treats an EMPTY territories list as in-area and warns, so no customer is turned away", async () => {
    const { token } = await chatWithLead();
    script(call("check_service_area", { zip: "99999" }), say("Great."));
    await send(token, "my zip is 99999");
    expect(toolOutputs()[0]).toMatchObject({ in_area: true });
    expect(String(toolOutputs()[0].note)).toMatch(/not set up/);
    expect(await waitForEvent("warn", "territories list is empty")).toBe(true);
    expect((await prisma.bookingChat.findUniqueOrThrow({ where: { token } })).status).toBe("unbooked");
  });

  it("accepts a ZIP on the list and refuses one off it, keeping the lead for Kyle", async () => {
    await setTerritories(["37064", "37067"]);
    const { token, lead } = await chatWithLead();

    script(call("check_service_area", { zip: "37067" }), say("Good."));
    await send(token, "37067");
    expect(toolOutputs()[0]).toMatchObject({ in_area: true, area: "Test Area" });

    script(call("check_service_area", { zip: "10001" }), say("Thanks for reaching out."));
    const out = await send(token, "10001");
    expect(toolOutputs()[0]).toMatchObject({ in_area: false });
    expect(out.body.status).toBe("out_of_scope");
    expect(out.body.heldSlot).toBeNull();
    expect(await prisma.lead.findUnique({ where: { id: lead.id } })).not.toBeNull();
  });
});

describe("get_available_slots", () => {
  it("returns the fixed blocks, and still returns them (with a warn) when a calendar cannot be read", async () => {
    const { token } = await chatWithLead();
    script(call("get_available_slots", {}), say("I have times."));
    await send(token, "what times?");
    const slots = toolOutputs()[0].slots as Array<{ startTime: string; date: string }>;
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(["08:00", "10:00", "12:00", "14:00"]).toContain(s.startTime);

    mocks.omitCalendars.value = true;
    script(call("get_available_slots", {}), say("I have times."));
    await send(token, "again?");
    expect((toolOutputs()[0].slots as unknown[]).length).toBeGreaterThan(0);
    expect(await waitForEvent("warn", "freebusy could not read")).toBe(true);
  });

  // Kyle, 2026-10-30: the bot offered times for "123 mary joe martin dr" with no city or ZIP.
  it("offers no times until the recorded address has an in-area ZIP", async () => {
    const noZip = await chatWithLead({ address: "123 Mary Joe Martin Dr" });
    script(call("get_available_slots", {}), say("What's your ZIP?"));
    await send(noZip.token, "what times?");
    expect(toolOutputs()[0]).toMatchObject({ ok: false });
    expect(toolOutputs()[0].slots).toBeUndefined();

    await setTerritories(["37064"]);
    const outside = await chatWithLead({ address: "1 Far Away Rd, New York, NY 10001" });
    script(call("get_available_slots", {}), say("That's outside our area."));
    await send(outside.token, "what times?");
    expect(toolOutputs()[0]).toMatchObject({ ok: false });
    expect(toolOutputs()[0].slots).toBeUndefined();

    const inside = await chatWithLead();
    script(call("get_available_slots", {}), say("I have times."));
    await send(inside.token, "what times?");
    expect((toolOutputs()[0].slots as unknown[]).length).toBeGreaterThan(0);
  });

  it("offers no times to a chat that has no lead yet", async () => {
    const res = await start();
    script(call("get_available_slots", {}), say("First, your name and number?"));
    await send(res.body.token as string, "when can you come?");
    expect(toolOutputs()[0]).toMatchObject({ ok: false });
  });
});

describe("book_appointment — the hold", () => {
  it("holds a fixed block on the calendar, stores it, and sends nothing to the customer", async () => {
    await setTerritories(["37064"]);
    const { token, lead } = await chatWithLead();
    const date = futureDate();
    script(call("book_appointment", { date, startTime: "10:00" }), say("I've held it."));
    const res = await send(token, "10 works");

    expect(toolOutputs()[0]).toMatchObject({ held: true });
    expect(res.body.status).toBe("held");
    expect(res.body.heldSlot.label).toMatch(/10:00 AM – 12:00 PM/);

    expect(mocks.insert).toHaveBeenCalledTimes(1);
    const body = mocks.insert.mock.calls[0][0].requestBody;
    expect(body.summary).toBe(`HOLD: ${lead.name} — ${lead.address}`);
    expect(body.description).toContain(lead.id);
    expect(mocks.insert.mock.calls[0][0].sendUpdates).toBe("none"); // no Google invitations either

    const chat = await prisma.bookingChat.findUniqueOrThrow({ where: { token } });
    expect(chat.status).toBe("held");
    expect(chat.heldEventId).toMatch(/^evt_/);
    expect(chat.heldEnd!.getTime() - chat.heldStart!.getTime()).toBe(2 * 3_600_000);

    // The hold sends NOTHING: no customer email, no customer SMS, no SMS to Kyle, no email to Kyle.
    expect(mocks.customerEmail).not.toHaveBeenCalled();
    expect(mocks.customerSms).not.toHaveBeenCalled();
    expect(mocks.kyleSms).not.toHaveBeenCalled();
    expect(mocks.kyleEmail).not.toHaveBeenCalled();
    // And the slot claim was released.
    expect(await prisma.slotHold.count()).toBe(0);
  });

  it("rejects a block that is not one of the four fixed ones", async () => {
    const { token } = await chatWithLead();
    for (const startTime of ["09:00", "15:00", "10:30"]) {
      script(call("book_appointment", { date: futureDate(), startTime }), say("Let me find another time."));
      await send(token, "try it");
      expect(toolOutputs()[0], startTime).toMatchObject({ ok: false });
    }
    expect(mocks.insert).not.toHaveBeenCalled();
    expect((await prisma.bookingChat.findUniqueOrThrow({ where: { token } })).status).toBe("unbooked");
  });

  it("refuses a slot that freebusy says is busy, and writes nothing", async () => {
    const { token } = await chatWithLead();
    mocks.busy.value = true;
    script(call("book_appointment", { date: futureDate(), startTime: "12:00" }), say("That one was taken."));
    const res = await send(token, "noon");
    expect(toolOutputs()[0]).toMatchObject({ held: false, code: "slot_taken" });
    expect(res.body.status).toBe("unbooked");
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(await prisma.slotHold.count()).toBe(0);
  });

  it("refuses a chat with no lead, and a lead missing its address or name", async () => {
    const { body } = await start();
    script(call("book_appointment", { date: futureDate(), startTime: "10:00" }), say("I need your details first."));
    await send(body.token, "book it");
    expect(toolOutputs()[0]).toMatchObject({ held: false, code: "need_details" });

    const noAddress = await start();
    script(call("update_work_order", { name: `${TAG} NoAddr`, phone: "615-555-0166" }), say("Address?"));
    await send(noAddress.body.token, "x");
    script(call("book_appointment", { date: futureDate(), startTime: "10:00" }), say("Address first."));
    await send(noAddress.body.token, "book it");
    expect(toolOutputs()[0]).toMatchObject({ held: false, code: "need_details" });

    const noName = await start();
    script(call("update_work_order", { phone: "615-555-0177", address: "1 A St, Franklin, TN 37064" }), say("Name?"));
    await send(noName.body.token, "x");
    script(call("book_appointment", { date: futureDate(), startTime: "10:00" }), say("Name first."));
    await send(noName.body.token, "book it");
    expect(toolOutputs()[0]).toMatchObject({ held: false, code: "need_details" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("refuses an address outside the service area", async () => {
    await setTerritories(["37064"]);
    const { token } = await chatWithLead({ address: "5 Far Away Rd, Somewhere, NY 10001" });
    script(call("book_appointment", { date: futureDate(), startTime: "10:00" }), say("Sorry."));
    await send(token, "book it");
    expect(toolOutputs()[0]).toMatchObject({ held: false, code: "out_of_area" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("a second hold deletes the first event: one hold per chat", async () => {
    const { token } = await chatWithLead();
    script(call("book_appointment", { date: futureDate(), startTime: "10:00" }), say("Held."));
    await send(token, "10");
    const first = (await prisma.bookingChat.findUniqueOrThrow({ where: { token } })).heldEventId!;

    script(call("book_appointment", { date: futureDate(), startTime: "14:00" }), say("Moved."));
    const res = await send(token, "actually 2");
    expect(res.body.heldSlot.label).toMatch(/2:00 PM – 4:00 PM/);

    const second = (await prisma.bookingChat.findUniqueOrThrow({ where: { token } })).heldEventId!;
    expect(second).not.toBe(first);
    expect(mocks.insert).toHaveBeenCalledTimes(2);
    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledWith({ calendarId: "primary", eventId: first });
  });

  it("a second hold that fails keeps the first one", async () => {
    const { token } = await chatWithLead();
    script(call("book_appointment", { date: futureDate(), startTime: "10:00" }), say("Held."));
    await send(token, "10");
    const first = (await prisma.bookingChat.findUniqueOrThrow({ where: { token } })).heldEventId!;

    mocks.busy.value = true;
    script(call("book_appointment", { date: futureDate(), startTime: "14:00" }), say("Taken."));
    const res = await send(token, "2");
    expect(res.body.status).toBe("held");
    expect((await prisma.bookingChat.findUniqueOrThrow({ where: { token } })).heldEventId).toBe(first);
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("asking for the block already held is a no-op, not a conflict with our own event", async () => {
    const { token } = await chatWithLead();
    const date = futureDate();
    script(call("book_appointment", { date, startTime: "10:00" }), say("Held."));
    await send(token, "10");
    mocks.busy.value = true; // our own HOLD makes the slot look busy
    script(call("book_appointment", { date, startTime: "10:00" }), say("Still held."));
    await send(token, "10 again");
    expect(toolOutputs()[0]).toMatchObject({ held: true, already_held: true });
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.del).not.toHaveBeenCalled();
  });
});

describe("POST /booking-chat/:token/photo", () => {
  it("is refused with 409 until the chat has a lead, then accepted and noted for the model", async () => {
    const { body } = await start();
    const early = await upload(body.token);
    expect(early.status).toBe(409);
    expect(early.body.error).toBe("phone_first");
    expect(early.body.reply).toMatch(/phone number first/i);
    expect(await prisma.leadPhoto.count()).toBe(0);

    script(call("update_work_order", { name: `${TAG} Photo`, phone: "615-555-0123" }), say("Thanks."));
    await send(body.token, "Photo, 615-555-0123");

    const ok = await upload(body.token, JPEG, "image/jpeg", "kind=panel&room=Garage&caption=panel");
    expect(ok.status).toBe(201);
    const row = await prisma.leadPhoto.findUniqueOrThrow({ where: { id: ok.body.photoId } });
    expect(row).toMatchObject({ kind: "panel", room: "Garage", caption: "panel", mimeType: "image/jpeg", sizeBytes: JPEG.length });
    expect(Buffer.compare(Buffer.from(row.data), JPEG)).toBe(0);

    const chat = await prisma.bookingChat.findUniqueOrThrow({ where: { token: body.token } });
    expect(row.leadId).toBe(chat.leadId);
    expect(chat.transcriptJson).toContain(`[photo uploaded: id=${row.id}, kind=panel, room=Garage]`);

    // The model gets the id in its history, never the bytes.
    script(say("Got it, thanks."));
    await send(body.token, "uploaded");
    const lastCall = mocks.openaiCreate.mock.calls[mocks.openaiCreate.mock.calls.length - 1][0];
    expect(JSON.stringify(lastCall.input)).toContain(row.id);
    expect(JSON.stringify(lastCall)).not.toContain(JPEG.toString("base64"));
    expect(JSON.stringify(lastCall.instructions)).toContain(`id=${row.id}`);
  });

  it("accepts png, webp and heic by their bytes, rejects a mislabelled file and other types", async () => {
    const { token } = await chatWithLead();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(16)]);
    const heic = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic"), Buffer.alloc(16)]);
    expect((await upload(token, png, "image/png")).status).toBe(201);
    expect((await upload(token, webp, "image/webp")).status).toBe(201);
    expect((await upload(token, heic, "image/heic")).status).toBe(201);
    expect((await upload(token, Buffer.from("<html><script>alert(1)</script></html>"), "image/jpeg")).status).toBe(415);
    expect((await upload(token, JPEG, "image/gif")).status).toBe(415);
    expect((await upload(token, JPEG, "application/pdf")).status).toBe(415);
    expect((await upload(token, JPEG, "image/jpeg", "kind=selfie")).status).toBe(400);
  });

  it("stops at 15 photos per chat", async () => {
    const { token, lead } = await chatWithLead();
    await prisma.leadPhoto.createMany({
      data: Array.from({ length: 15 }, () => ({ leadId: lead.id, kind: "concern", mimeType: "image/jpeg", sizeBytes: 1, data: Buffer.from([1]) })),
    });
    const res = await upload(token);
    expect(res.status).toBe(429);
    expect(res.body.reply).toContain("(615) 625-2163");
    expect(await prisma.leadPhoto.count({ where: { leadId: lead.id } })).toBe(15);
  });

  it("answers 404 for an unknown chat", async () => {
    expect((await upload("nope")).status).toBe(404);
  });
});

describe("limits and failures answer politely, never with a bare error", () => {
  it("replies to a message over 1000 characters without calling the model or counting it", async () => {
    const { body } = await start();
    const res = await send(body.token, "x".repeat(1001));
    expect(res.status).toBe(200);
    expect(res.body.reply).toContain("(615) 625-2163");
    expect(res.body.limit).toBe("message_length");
    expect(mocks.openaiCreate).not.toHaveBeenCalled();
    expect((await prisma.bookingChat.findUniqueOrThrow({ where: { token: body.token } })).messageCount).toBe(0);
  });

  it("stops a chat at 60 messages and at 120 AI calls", async () => {
    const { body } = await start();
    await prisma.bookingChat.update({ where: { token: body.token }, data: { messageCount: 60 } });
    const a = await send(body.token, "hello");
    expect(a.body.reply).toContain("(615) 625-2163");
    expect(a.body.limit).toBe("message_count");
    expect(a.body.ended).toBe(true);

    const two = await start();
    await prisma.bookingChat.update({ where: { token: two.body.token }, data: { aiCallCount: 120 } });
    const b = await send(two.body.token, "hello");
    expect(b.body.limit).toBe("ai_calls");
    expect(mocks.openaiCreate).not.toHaveBeenCalled();
  });

  it("caps tool rounds per turn: a model that never stops calling tools is forced to answer", async () => {
    const { body } = await start();
    for (let i = 0; i < 6; i++) script(call("get_available_slots", {}));
    script(say("Here you go."));
    const res = await send(body.token, "times?");
    expect(res.body.reply).toBe("Here you go.");
    expect(mocks.openaiCreate).toHaveBeenCalledTimes(7);
    expect(mocks.openaiCreate.mock.calls[6][0].tool_choice).toBe("none");
  });

  it("answers with the phone number when OpenAI fails, and logs it", async () => {
    const { body } = await start();
    mocks.openaiCreate.mockRejectedValueOnce(new Error("upstream exploded sk-secret"));
    const res = await send(body.token, "hello");
    expect(res.status).toBe(200);
    expect(res.body.reply).toContain("(615) 625-2163");
    expect(res.body.reply).not.toContain("exploded");
    expect(await waitForEvent("error", "OpenAI call failed")).toBe(true);
  });

  it("rejects unknown tools and bad arguments without crashing the turn", async () => {
    const { body } = await start();
    script(call("send_estimate", { total: 5 }), call("check_service_area", { zip: "abc" }), say("Fine."));
    const res = await send(body.token, "hello");
    expect(res.status).toBe(200);
    expect(toolOutputs()[0]).toMatchObject({ ok: false });
  });
});

describe("end_conversation and the email to Kyle", () => {
  it("emails Kyle once when the conversation ends, then answers politely and never again", async () => {
    await setTerritories(["37064"]);
    const { token, lead } = await chatWithLead({ extra: { priority: true, priority_quote: "sparks from the outlet" } });
    script(call("book_appointment", { date: futureDate(), startTime: "08:00" }), say("Held."));
    await send(token, "8");

    script(call("end_conversation", { outcome: "completed" }), say("Thanks. See you then."));
    const res = await send(token, "that's all");
    expect(res.body.ended).toBe(true);
    expect(res.body.acceptsPhotos).toBe(false);

    expect(mocks.kyleEmail).toHaveBeenCalledTimes(1);
    const [subject, emailBody] = mocks.kyleEmail.mock.calls[0] as [string, string];
    expect(subject).toMatch(/^PRIORITY — /);
    expect(subject).toMatch(/HELD/);
    expect(emailBody.indexOf("sparks from the outlet")).toBeLessThan(emailBody.indexOf("Name:"));
    expect(emailBody).toContain(lead.id);
    expect(emailBody).toContain("Photos: 0");

    const after = await send(token, "one more thing");
    expect(after.body.ended).toBe(true);
    expect(after.body.reply).toContain("(615) 625-2163");
    expect(mocks.openaiCreate).toHaveBeenCalledTimes(6); // the closed chat never reaches the model

    // The idle sweep does not email a chat that was already announced.
    await prisma.bookingChat.update({ where: { token }, data: { lastActivityAt: new Date(Date.now() - 3_600_000) } });
    expect((await runBookingChatIdleSweep()).notified).toBe(0);
    expect(mocks.kyleEmail).toHaveBeenCalledTimes(1);
    expect((await prisma.bookingChat.findUniqueOrThrow({ where: { token } })).kyleNotifiedAt).not.toBeNull();
  });

  it("sends nothing for a chat that never produced a lead", async () => {
    const { body } = await start();
    script(call("end_conversation", {}), say("Take care."));
    const res = await send(body.token, "never mind");
    expect(res.body.ended).toBe(true);
    expect(mocks.kyleEmail).not.toHaveBeenCalled();
  });

  it("lets the model signal out-of-scope, but not over a held slot", async () => {
    const a = await chatWithLead();
    script(call("end_conversation", { outcome: "out_of_scope" }), say("I'll pass it to Kyle."));
    const res = await send(a.token, "new construction");
    expect(res.body.status).toBe("out_of_scope");
    expect(mocks.kyleEmail.mock.calls[0][0]).toMatch(/UNBOOKED — out of area/);

    const b = await chatWithLead();
    script(call("book_appointment", { date: futureDate(), startTime: "10:00" }), say("Held."));
    await send(b.token, "10");
    script(call("end_conversation", { outcome: "out_of_scope" }), say("Bye."));
    const held = await send(b.token, "bye");
    expect(held.body.status).toBe("held");
  });

  it("the idle sweep emails an idle chat once and only once, UNBOOKED", async () => {
    const quiet = await chatWithLead();
    const recent = await chatWithLead();
    const noLead = await start();
    const old = new Date(Date.now() - 31 * 60_000);
    await prisma.bookingChat.update({ where: { token: quiet.token }, data: { lastActivityAt: old } });
    await prisma.bookingChat.update({ where: { token: noLead.body.token }, data: { lastActivityAt: old } });
    await prisma.bookingChat.update({ where: { token: recent.token }, data: { lastActivityAt: new Date(Date.now() - 5 * 60_000) } });

    expect((await runBookingChatIdleSweep()).notified).toBe(1);
    expect((await runBookingChatIdleSweep()).notified).toBe(0);
    expect(mocks.kyleEmail).toHaveBeenCalledTimes(1);
    const [subject, body] = mocks.kyleEmail.mock.calls[0] as [string, string];
    expect(subject).toMatch(/UNBOOKED — call back/);
    expect(subject).not.toMatch(/^PRIORITY/);
    expect(body).toContain(quiet.lead.id);

    expect((await prisma.bookingChat.findUniqueOrThrow({ where: { token: recent.token } })).kyleNotifiedAt).toBeNull();
    expect((await prisma.bookingChat.findUniqueOrThrow({ where: { token: noLead.body.token } })).kyleNotifiedAt).toBeNull();
  });

  it("gives the claim back when the email fails, so the next sweep retries", async () => {
    const { token } = await chatWithLead();
    await prisma.bookingChat.update({ where: { token }, data: { lastActivityAt: new Date(Date.now() - 40 * 60_000) } });
    mocks.kyleEmail.mockResolvedValueOnce(false);
    expect((await runBookingChatIdleSweep()).notified).toBe(0);
    expect((await prisma.bookingChat.findUniqueOrThrow({ where: { token } })).kyleNotifiedAt).toBeNull();
    expect((await runBookingChatIdleSweep()).notified).toBe(1);
    expect(mocks.kyleEmail).toHaveBeenCalledTimes(2);
  });

  it("escapes everything a visitor typed before it reaches the email", async () => {
    const evil = '<script>alert("x")</script>';
    // name and address with markup are refused at update_work_order now (security review M1), so the
    // email's own escaping of them is exercised by writing them straight onto the Lead — the email
    // must still be safe if such text ever arrived by another route (the CRM edit form, say).
    const { token, lead } = await chatWithLead({
      extra: {
        priority: true, priority_quote: `<b>fire</b> & "smoke"`,
        email: "ok@example.com",
        concerns: [{ room: "<i>Kitchen</i>", description: "<a href='http://evil'>click</a>" }],
        questions_for_kyle: ["<script>q</script>"],
        prep_areas: ["<u>attic</u>"],
        square_footage: "<s>2000</s>", year_built: "<em>1990</em>",
      },
    });
    await prisma.lead.update({
      where: { id: lead.id },
      data: { name: `${TAG} ${evil}`, address: `<img src=x onerror=alert(1)> 1 St, Franklin, TN 37064` },
    });
    await prisma.bookingChat.update({ where: { token }, data: { lastActivityAt: new Date(Date.now() - 45 * 60_000) } });
    await runBookingChatIdleSweep();

    const [subject, body] = mocks.kyleEmail.mock.calls[0] as [string, string];
    for (const text of [subject, body]) {
      expect(text).not.toMatch(/<(script|img|b|i|a|u|s|em)\b/);
    }
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("&lt;b&gt;fire&lt;/b&gt; &amp; &quot;smoke&quot;");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("the hold core is shared, and Savannah's booking is unchanged", () => {
  it("Savannah's bookAppointment still claims, re-checks, inserts and sends", async () => {
    const { bookAppointment, BookingConflictError } = await import("../src/services/googleCalendar");
    const params = {
      date: futureDate(10), startTime: "10:00", customerName: `${TAG} Savannah`, description: "Outlet",
      address: "9 Phone Rd", phone: "6155550199", email: "sav@example.com",
    };
    const ok = await bookAppointment(params);
    expect(ok.eventId).toMatch(/^evt_/);
    expect(mocks.insert.mock.calls[0][0].requestBody.summary).toBe(`EST: ${TAG} Savannah — 9 Phone Rd`);
    expect(mocks.customerEmail).toHaveBeenCalledTimes(1); // her path keeps its own sends

    mocks.busy.value = true;
    await expect(bookAppointment(params)).rejects.toThrow(BookingConflictError);
    expect(await prisma.slotHold.count()).toBe(0);
  });
});
