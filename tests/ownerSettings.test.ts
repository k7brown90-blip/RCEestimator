import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { isPublicRoute } from "../src/middleware/publicRoutes";
import { saveCrmLogin, setPowers, setPrincipal } from "../src/services/crmLogin";
import { saveAdminLogin } from "../src/services/adminLogin";
import { getQuietWindow, getSmsPurposeLabels } from "../src/services/ownerSettings";
import { SMS_PURPOSES } from "../shared/sms/purposes";
import { requireOwner } from "../src/lib/routeHelpers";
import { CRM_POWER_KEYS } from "../shared/crmPowers";
import { DEFAULT_QUIET_WINDOW } from "../shared/sms/quietHours";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";

/**
 * Work order agent-team, step 0: the ONE owner-guarded settings family (GET and PUT
 * /owner-settings/:key, CompanySetting rows only Kyle may read or change), with `quietHours` as its
 * first key and getQuietWindow() as the one reader. Not the open PUT /crm/settings/:key.
 */

const PIN = "1234";
const PASS = "correct horse battery";
const AI_PASS = "another long password!";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const row = () => prisma.companySetting.findUnique({ where: { key: "quietHours" } });

beforeAll(async () => {
  process.env.PIN_HASH = await hashPin(PIN);
});
afterAll(async () => {
  delete process.env.PIN_HASH;
  await prisma.companySetting.deleteMany({ where: { key: "quietHours" } });
  await cleanupCrmLoginFixtures();
});
beforeEach(async () => {
  await cleanupCrmLoginFixtures();
  await prisma.companySetting.deleteMany({ where: { key: "quietHours" } });
});

async function pinToken(): Promise<string> {
  return (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
}
async function personToken(username = "michael") {
  const person = await makePerson(username);
  const login = await saveCrmLogin(person.id, { username, role: "owner", password: PASS });
  const res = await request(app).post("/auth/login").send({ username, password: PASS });
  expect(res.status).toBe(200);
  return { login, token: res.body.token as string };
}

describe("/owner-settings/quietHours", () => {
  it("is behind the gate and not on the public allowlist", async () => {
    expect(isPublicRoute("GET", "/owner-settings/quietHours")).toBe(false);
    expect(isPublicRoute("PUT", "/owner-settings/quietHours")).toBe(false);
    expect((await request(app).get("/owner-settings/quietHours")).status).toBe(401);
    expect((await request(app).put("/owner-settings/quietHours").send(DEFAULT_QUIET_WINDOW)).status).toBe(401);
  });

  it("reads the default 8 AM to 8 PM when nothing is stored", async () => {
    const res = await request(app).get("/owner-settings/quietHours").set(bearer(await pinToken()));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: "quietHours", value: { start: "08:00", end: "20:00" } });
    expect(await getQuietWindow()).toEqual(DEFAULT_QUIET_WINDOW);
  });

  it("Kyle saves a window, reads it back, and getQuietWindow() returns it", async () => {
    const pin = await pinToken();
    const put = await request(app).put("/owner-settings/quietHours").set(bearer(pin)).send({ start: "09:00", end: "18:30" });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ key: "quietHours", value: { start: "09:00", end: "18:30" } });
    expect(JSON.parse((await row())!.valueJson)).toEqual({ start: "09:00", end: "18:30" });
    const get = await request(app).get("/owner-settings/quietHours").set(bearer(pin));
    expect(get.body.value).toEqual({ start: "09:00", end: "18:30" });
    expect(await getQuietWindow()).toEqual({ start: "09:00", end: "18:30" });
  });

  it("refuses a window that is not HH:MM, has start at or after end, or carries extra keys, and stores nothing", async () => {
    const pin = await pinToken();
    for (const body of [
      { start: "8am", end: "20:00" }, { start: "08:00", end: "25:00" }, { start: "20:00", end: "08:00" },
      { start: "08:00", end: "08:00" }, { start: "08:00" }, { start: 8, end: 20 }, { start: "08:00", end: "20:00", extra: 1 }, {},
    ]) {
      const res = await request(app).put("/owner-settings/quietHours").set(bearer(pin)).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await row()).toBeNull();
  });

  it("a window may only narrow 8 AM to 8 PM: 06:00-22:00 is a 400 with a plain reason, and nothing is stored", async () => {
    const pin = await pinToken();
    const wide = await request(app).put("/owner-settings/quietHours").set(bearer(pin)).send({ start: "06:00", end: "22:00" });
    expect(wide.status).toBe(400);
    expect(wide.body.error).toBe("Quiet hours can't go earlier than 8:00 AM or later than 8:00 PM.");
    for (const body of [{ start: "07:59", end: "20:00" }, { start: "08:00", end: "20:01" }, { start: "00:00", end: "23:59" }]) {
      const res = await request(app).put("/owner-settings/quietHours").set(bearer(pin)).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toMatch(/can't go earlier than 8:00 AM or later than 8:00 PM/);
    }
    expect(await row()).toBeNull();
    // The edges themselves are allowed, and so is narrowing.
    expect((await request(app).put("/owner-settings/quietHours").set(bearer(pin)).send({ start: "08:00", end: "20:00" })).status).toBe(200);
    expect((await request(app).put("/owner-settings/quietHours").set(bearer(pin)).send({ start: "08:00", end: "08:01" })).status).toBe(200);
  });

  it("a stored window outside 8 AM to 8 PM reads as the default", async () => {
    await prisma.companySetting.create({ data: { key: "quietHours", valueJson: JSON.stringify({ start: "06:00", end: "22:00" }) } });
    expect(await getQuietWindow()).toEqual(DEFAULT_QUIET_WINDOW);
  });

  it("an unknown key is a 400, on read and on write", async () => {
    const pin = await pinToken();
    const get = await request(app).get("/owner-settings/companyProfile").set(bearer(pin));
    expect(get.status).toBe(400);
    expect(get.body.error).toMatch(/quietHours/);
    expect((await request(app).put("/owner-settings/treasury").set(bearer(pin)).send({ mainFloat: 1 })).status).toBe(400);
    expect((await request(app).put("/owner-settings/__proto__").set(bearer(pin)).send({})).status).toBe(400);
    expect((await request(app).put("/owner-settings/constructor").set(bearer(pin)).send({})).status).toBe(400);
  });

  it("a stored value that no longer validates reads as the default, never as a bad window", async () => {
    await prisma.companySetting.create({ data: { key: "quietHours", valueJson: JSON.stringify({ start: "20:00", end: "08:00" }) } });
    expect(await getQuietWindow()).toEqual(DEFAULT_QUIET_WINDOW);
    await prisma.companySetting.update({ where: { key: "quietHours" }, data: { valueJson: "not json" } });
    expect(await getQuietWindow()).toEqual(DEFAULT_QUIET_WINDOW);
  });

  it("another person's login gets 403 with the reason, however much Kyle has granted it, and nothing is stored", async () => {
    const { login, token } = await personToken();
    await setPowers(login.id, [...CRM_POWER_KEYS]);
    const put = await request(app).put("/owner-settings/quietHours").set(bearer(token)).send({ start: "06:00", end: "22:00" });
    expect(put.status).toBe(403);
    expect(put.body).toEqual({ error: "Only Kyle can see or change this setting." });
    const get = await request(app).get("/owner-settings/quietHours").set(bearer(token));
    expect(get.status).toBe(403);
    expect(await row()).toBeNull();
  });

  it("the AI admin gets 403", async () => {
    await saveAdminLogin("grok-admin", AI_PASS);
    const token = (await request(app).post("/auth/login").send({ username: "grok-admin", password: AI_PASS })).body.token as string;
    expect((await request(app).get("/owner-settings/quietHours").set(bearer(token))).status).toBe(403);
    expect((await request(app).put("/owner-settings/quietHours").set(bearer(token)).send({ start: "06:00", end: "22:00" })).status).toBe(403);
    expect(await row()).toBeNull();
  });

  it("Kyle's principal CRM login is allowed", async () => {
    const { login, token } = await personToken("kyle");
    await setPrincipal(login.id);
    const put = await request(app).put("/owner-settings/quietHours").set(bearer(token)).send({ start: "08:15", end: "19:45" });
    expect(put.status).toBe(200);
    expect((await request(app).get("/owner-settings/quietHours").set(bearer(token))).body.value).toEqual({ start: "08:15", end: "19:45" });
  });

  it("with the gate off (dev/test) it is open, like requireOwner", async () => {
    const saved = process.env.PIN_HASH;
    delete process.env.PIN_HASH;
    try {
      expect((await request(app).put("/owner-settings/quietHours").send({ start: "08:30", end: "19:00" })).status).toBe(200);
      expect((await request(app).get("/owner-settings/quietHours")).body.value).toEqual({ start: "08:30", end: "19:00" });
    } finally {
      process.env.PIN_HASH = saved;
    }
  });

  it("GET /crm/settings never carries an owner-guarded key, for any caller", async () => {
    const pin = await pinToken();
    expect((await request(app).put("/owner-settings/quietHours").set(bearer(pin)).send({ start: "09:00", end: "17:00" })).status).toBe(200);
    expect(await row()).not.toBeNull();
    const { token } = await personToken("office-person");
    for (const t of [pin, token]) {
      const res = await request(app).get("/crm/settings").set(bearer(t));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).not.toContain("quietHours");
    }
    // An ordinary key is still listed.
    await prisma.companySetting.upsert({ where: { key: "operatingHours" }, create: { key: "operatingHours", valueJson: "{}" }, update: {} });
    expect(Object.keys((await request(app).get("/crm/settings").set(bearer(pin))).body)).toContain("operatingHours");
  });

  it("the open PUT /crm/settings/:key still refuses this key: it never gets added there", async () => {
    const res = await request(app).put("/crm/settings/quietHours").set(bearer(await pinToken())).send({ start: "00:00", end: "23:59" });
    expect(res.status).toBe(400);
    expect(await row()).toBeNull();
  });
});

describe("requireOwner (lifted to lib/routeHelpers.ts)", () => {
  const run = (state: Record<string, unknown>, message?: string) => {
    let nexted = false;
    let status = 0;
    let body: unknown;
    const res = { status: (s: number) => { status = s; return { json: (b: unknown) => { body = b; } }; } };
    const handler = message === undefined ? requireOwner() : requireOwner(message);
    handler(state as never, res as never, () => { nexted = true; });
    return { nexted, status, body };
  };

  it("passes the PIN session and gate-disabled, and refuses everyone else with the caller's sentence", () => {
    expect(run({ _authActor: "owner" }).nexted).toBe(true);
    expect(run({ _authOutcome: "gate-disabled" }).nexted).toBe(true);
    for (const state of [{ _authActor: "ai-admin" }, { _authActor: "user:x", _crmLogin: { isPrincipal: true } }, {}]) {
      const r = run(state);
      expect(r.nexted).toBe(false);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: "Only Kyle can change this." });
    }
    expect(run({}, "Only the owner can change the AI admin login.").body).toEqual({ error: "Only the owner can change the AI admin login." });
  });
});

describe("/owner-settings/smsPurposeLabels (the words after \"Red Cedar Electric:\" in a customer text, U9)", () => {
  const labelRow = () => prisma.companySetting.findUnique({ where: { key: "smsPurposeLabels" } });
  beforeEach(async () => { await prisma.companySetting.deleteMany({ where: { key: "smsPurposeLabels" } }); });
  afterAll(async () => { await prisma.companySetting.deleteMany({ where: { key: "smsPurposeLabels" } }); });

  it("is behind the gate, off the public allowlist and never listed by the open /crm/settings", async () => {
    expect(isPublicRoute("GET", "/owner-settings/smsPurposeLabels")).toBe(false);
    expect((await request(app).get("/owner-settings/smsPurposeLabels")).status).toBe(401);
    const pin = await pinToken();
    expect((await request(app).put("/owner-settings/smsPurposeLabels").set(bearer(pin)).send({ reschedule: "Moved" })).status).toBe(200);
    expect(Object.keys((await request(app).get("/crm/settings").set(bearer(pin))).body)).not.toContain("smsPurposeLabels");
    expect((await request(app).put("/crm/settings/smsPurposeLabels").set(bearer(pin)).send({ reschedule: "Moved" })).status).toBe(400);
  });

  it("reads {} when nothing is stored, and getSmsPurposeLabels() fills every reason from shared/sms/purposes.ts", async () => {
    const res = await request(app).get("/owner-settings/smsPurposeLabels").set(bearer(await pinToken()));
    expect(res.body).toEqual({ key: "smsPurposeLabels", value: {} });
    const all = await getSmsPurposeLabels();
    expect(all.appointment_confirmation).toBe("Appointment Confirmation");
    expect(Object.keys(all).sort()).toEqual(Object.keys(SMS_PURPOSES).sort());
  });

  it("Kyle renames one reason: the reader returns it and every other reason keeps its default; a stored label that no longer validates reads as the defaults", async () => {
    const pin = await pinToken();
    const put = await request(app).put("/owner-settings/smsPurposeLabels").set(bearer(pin)).send({ appointment_reminder: "  Visit Tomorrow  " });
    expect(put.status).toBe(200);
    expect(put.body.value).toEqual({ appointment_reminder: "Visit Tomorrow" });
    const labels = await getSmsPurposeLabels();
    expect(labels.appointment_reminder).toBe("Visit Tomorrow");
    expect(labels.reschedule).toBe("Reschedule");
    await prisma.companySetting.update({ where: { key: "smsPurposeLabels" }, data: { valueJson: JSON.stringify({ not_a_reason: "x" }) } });
    expect((await getSmsPurposeLabels()).appointment_reminder).toBe("Appointment Reminder");
  });

  it("refuses an unknown reason, an empty label, a long one, a line break, the company name and STOP wording, and stores nothing", async () => {
    const pin = await pinToken();
    for (const body of [
      { not_a_reason: "Hello" }, { reschedule: "" }, { reschedule: "x".repeat(41) }, { reschedule: "Two\nlines" },
      { reschedule: "Red Cedar Electric visit" }, { reschedule: "Reply STOP now" }, { reschedule: 5 },
    ]) {
      const res = await request(app).put("/owner-settings/smsPurposeLabels").set(bearer(pin)).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await labelRow()).toBeNull();
  });

  it("is Kyle only: another person's login and the AI admin get 403", async () => {
    const { login, token } = await personToken();
    await setPowers(login.id, [...CRM_POWER_KEYS]);
    expect((await request(app).put("/owner-settings/smsPurposeLabels").set(bearer(token)).send({ reschedule: "Moved" })).status).toBe(403);
    expect((await request(app).get("/owner-settings/smsPurposeLabels").set(bearer(token))).status).toBe(403);
    await saveAdminLogin("grok-admin", AI_PASS);
    const ai = (await request(app).post("/auth/login").send({ username: "grok-admin", password: AI_PASS })).body.token as string;
    expect((await request(app).put("/owner-settings/smsPurposeLabels").set(bearer(ai)).send({ reschedule: "Moved" })).status).toBe(403);
    expect(await labelRow()).toBeNull();
  });
});
