/**
 * The waiting-approval reminder (work order agent-team, U8, team answer 8): services/hubRenotify.ts, and the
 * owner setting `hubNotify` it reads (services/ownerSettings.ts).
 *
 * Pinned here, with the clock handed in (the cron passes the real one): a draft that has waited 16 minutes is
 * reminded about; the same draft is NOT again at 31 or 74 minutes and IS again at 76 (once an hour, never every
 * 15 minutes); a draft 14 minutes old is not; Saturday sends nothing; 7:59 PM sends and 8:01 PM does not (hours
 * 8:00 AM-8:00 PM Chicago); a draft whose 15 minutes ended before the window opens is reminded when it opens;
 * a decided draft is never reminded about; with push not set up nothing is stamped; and Kyle's hours are the one
 * owner-settings key hubNotify, Kyle only, with no days field.
 *
 * Other test files share this database, so every assertion is about THIS file's own drafts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
vi.mock("stripe", () => ({ default: class MockStripe { constructor() { throw new Error("Stripe must not be constructed in tests"); } } }));
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 { setCredentials() {} }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }) },
        events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }), delete: vi.fn().mockResolvedValue({}) },
      }),
    },
  };
});
const sendNotification = vi.fn();
vi.mock("web-push", () => ({ default: { sendNotification: (...a: unknown[]) => sendNotification(...a), setVapidDetails: vi.fn() } }));

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { createMessageRow, ensureThreadFor } from "../src/services/hub";
import { runRenotify } from "../src/services/hubRenotify";
import { saveSubscription } from "../src/services/hubPush";
import { DEFAULT_HUB_NOTIFY, OWNER_SETTINGS, getNotifyWindow, isOwnerSettingKey } from "../src/services/ownerSettings";

const TAG = "HubRenotify";
const RUN = Math.random().toString(36).slice(2, 8);
const ENDPOINT = `https://fcm.googleapis.com/fcm/send/${TAG}-${RUN}`;
const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
const VAPID = { VAPID_PUBLIC_KEY: "BPublicKeyForTests", VAPID_PRIVATE_KEY: "privateKeyForTests", VAPID_SUBJECT: "mailto:test@example.com" } as const;
const saved: Record<string, string | undefined> = {};

// November 2026 is standard time in Chicago (UTC-6). Tuesday 24th, Saturday 28th.
const chicago = (day: number, hour: number, minute = 0): Date => new Date(Date.UTC(2026, 10, day, hour + 6, minute));
const minutesAfter = (d: Date, m: number): Date => new Date(d.getTime() + m * 60_000);

async function wipe() {
  await prisma.hubPushSubscription.deleteMany({ where: { endpoint: ENDPOINT } });
  await prisma.hubThread.deleteMany({ where: { title: { startsWith: TAG } } });
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = customers.map((c) => c.id);
  if (ids.length > 0) await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  await prisma.companySetting.deleteMany({ where: { key: "hubNotify" } });
}
beforeAll(() => { for (const k of Object.keys(VAPID)) saved[k] = process.env[k]; });
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await wipe();
});
beforeEach(async () => {
  await wipe();
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  for (const [k, v] of Object.entries(VAPID)) process.env[k] = v;
  await saveSubscription("owner", { endpoint: ENDPOINT, keys }, "test");
});

/** A draft waiting for approval, made `at`, in a thread of its own. */
async function draft(at: Date, status = "pending_approval") {
  const customer = await prisma.customer.create({ data: { name: `${TAG} ${Math.random().toString(36).slice(2)}` } });
  const thread = await ensureThreadFor({ customerId: customer.id });
  const row = await createMessageRow(prisma, {
    threadId: thread.id, authorType: "ai_agent", authorKey: "agent:scout", authorDisplay: "Scout", channel: "email", direction: "outbound",
    status, body: "Hello", subject: "Hi", toAddress: "x@example.com",
  });
  return prisma.hubMessage.update({ where: { id: row.id }, data: { createdAt: at } });
}
const fresh = (id: string) => prisma.hubMessage.findUniqueOrThrow({ where: { id } });
const mine = () => (sendNotification.mock.calls as Array<[{ endpoint: string }, string]>).filter((c) => c[0].endpoint === ENDPOINT);

describe("15 minutes, then once an hour", () => {
  it("reminds at 16 minutes, not at 31 or 74, and again at 76", async () => {
    const made = chicago(24, 9, 0);
    const m = await draft(made);
    await runRenotify(minutesAfter(made, 14));
    expect((await fresh(m.id)).notifyCount, "14 minutes").toBe(0);

    const first = minutesAfter(made, 16);
    await runRenotify(first);
    const afterFirst = await fresh(m.id);
    expect(afterFirst.notifyCount).toBe(1);
    expect(afterFirst.lastNotifiedAt?.getTime()).toBe(first.getTime());
    expect(mine()).toHaveLength(1);
    const payload = JSON.parse(mine()[0]![1]) as Record<string, string>;
    expect(payload.body).toMatch(/needs? approval|need approval/);
    expect(payload.url).toBe(`/messages?thread=${m.threadId}`);
    expect(JSON.stringify(payload)).not.toContain(TAG);

    for (const at of [31, 74]) {
      await runRenotify(minutesAfter(made, at));
      expect((await fresh(m.id)).notifyCount, `${at} minutes`).toBe(1);
    }
    expect(mine()).toHaveLength(1);

    await runRenotify(minutesAfter(made, 76));
    expect((await fresh(m.id)).notifyCount, "76 minutes").toBe(2);
    expect(mine()).toHaveLength(2);
  });

  it("never reminds about a draft that has been decided", async () => {
    const made = chicago(24, 9, 0);
    const approved = await draft(made, "approved");
    const rejected = await draft(made, "rejected");
    const edited = await draft(made, "edited");
    const posted = await draft(made, "posted");
    await runRenotify(minutesAfter(made, 90));
    for (const m of [approved, rejected, edited, posted]) expect((await fresh(m.id)).notifyCount, m.status).toBe(0);
    // A draft that was reminded and is then rejected is not reminded again.
    const waiting = await draft(made);
    await runRenotify(minutesAfter(made, 16));
    expect((await fresh(waiting.id)).notifyCount).toBe(1);
    await prisma.hubMessage.update({ where: { id: waiting.id }, data: { status: "rejected" } });
    await runRenotify(minutesAfter(made, 120));
    expect((await fresh(waiting.id)).notifyCount).toBe(1);
  });
});

describe("only inside Mon-Fri 8:00 AM-8:00 PM Chicago", () => {
  it("sends nothing on a Saturday", async () => {
    const made = chicago(28, 10, 0);
    const m = await draft(made);
    expect(await runRenotify(minutesAfter(made, 30))).toMatchObject({ reminded: 0, skipped: "outside_hours" });
    expect((await fresh(m.id)).notifyCount).toBe(0);
    expect(mine()).toHaveLength(0);
  });

  it("sends at 7:59 PM and not at 8:01 PM", async () => {
    const made = chicago(24, 19, 0);
    const m = await draft(made);
    await runRenotify(chicago(24, 20, 1));
    expect((await fresh(m.id)).notifyCount, "8:01 PM").toBe(0);
    await runRenotify(chicago(24, 19, 59));
    expect((await fresh(m.id)).notifyCount, "7:59 PM").toBe(1);
  });

  it("gives a draft whose 15 minutes ended before 8:00 AM its first reminder when the window opens, then hourly", async () => {
    const made = chicago(24, 7, 0);
    const m = await draft(made);
    await runRenotify(chicago(24, 7, 30));
    expect((await fresh(m.id)).notifyCount, "7:30 AM, before opening").toBe(0);
    await runRenotify(chicago(24, 8, 0));
    expect((await fresh(m.id)).notifyCount, "8:00 AM").toBe(1);
    await runRenotify(chicago(24, 8, 30));
    expect((await fresh(m.id)).notifyCount, "8:30 AM").toBe(1);
    await runRenotify(chicago(24, 9, 0));
    expect((await fresh(m.id)).notifyCount, "9:00 AM").toBe(2);
  });

  it("follows Kyle's hours from the one owner setting, and says nothing about days", async () => {
    expect(isOwnerSettingKey("hubNotify")).toBe(true);
    expect(OWNER_SETTINGS.hubNotify.guard).toBe("kyle");
    expect(await getNotifyWindow()).toEqual(DEFAULT_HUB_NOTIFY);
    // The route is the one owner-settings family; the test session is Kyle (the gate is off here).
    expect((await request(app).put("/owner-settings/hubNotify").send({ start: "09:00", end: "17:00" })).status).toBe(200);
    expect(await getNotifyWindow()).toEqual({ start: "09:00", end: "17:00" });
    // No days field, and the end must come after the start.
    expect((await request(app).put("/owner-settings/hubNotify").send({ start: "09:00", end: "17:00", days: [1, 2] })).status).toBe(400);
    expect((await request(app).put("/owner-settings/hubNotify").send({ start: "18:00", end: "09:00" })).status).toBe(400);
    expect((await request(app).put("/owner-settings/hubNotify").send({ start: "9am", end: "5pm" })).status).toBe(400);
    expect(await getNotifyWindow()).toEqual({ start: "09:00", end: "17:00" });

    const made = chicago(24, 8, 0);
    const m = await draft(made);
    await runRenotify(chicago(24, 8, 30));
    expect((await fresh(m.id)).notifyCount, "before Kyle's 9:00 AM").toBe(0);
    await runRenotify(chicago(24, 9, 0));
    expect((await fresh(m.id)).notifyCount, "at 9:00 AM").toBe(1);
    await runRenotify(chicago(24, 17, 30));
    expect((await fresh(m.id)).notifyCount, "after Kyle's 5:00 PM").toBe(1);
  });

  it("is never served by the open /crm/settings", async () => {
    await request(app).put("/owner-settings/hubNotify").send({ start: "09:00", end: "17:00" });
    expect((await request(app).get("/crm/settings")).body).not.toHaveProperty("hubNotify");
    expect((await request(app).put("/crm/settings/hubNotify").send({ start: "00:00", end: "23:59" })).status).toBeGreaterThanOrEqual(400);
    expect(await getNotifyWindow()).toEqual({ start: "09:00", end: "17:00" });
  });
});

describe("when notifications are not set up", () => {
  it("stamps nothing, so the first reminder goes out the first time it can", async () => {
    for (const k of Object.keys(VAPID)) delete process.env[k];
    const made = chicago(24, 9, 0);
    const m = await draft(made);
    expect(await runRenotify(minutesAfter(made, 30))).toMatchObject({ reminded: 0, skipped: "push_not_set_up" });
    expect((await fresh(m.id)).notifyCount).toBe(0);
    for (const [k, v] of Object.entries(VAPID)) process.env[k] = v;
    await runRenotify(minutesAfter(made, 31));
    expect((await fresh(m.id)).notifyCount).toBe(1);
  });
});
