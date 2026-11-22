import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { isPublicRoute } from "../src/middleware/publicRoutes";
import { saveCrmLogin, setPowers, setPrincipal } from "../src/services/crmLogin";
import { saveAdminLogin } from "../src/services/adminLogin";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";

/**
 * Work order agent-team, HA4 (server): /crm-logins, the routes behind Team -> "CRM login". Every
 * route is Kyle only (the PIN or his principal login) and not grantable; the principal mark is the
 * PIN session only. The hash is never in a response.
 */

const PIN = "1234";
const PASS = "correct horse battery";
const AI_PASS = "another long password!";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  process.env.PIN_HASH = await hashPin(PIN);
});
afterAll(async () => {
  delete process.env.PIN_HASH;
  await cleanupCrmLoginFixtures();
});
beforeEach(cleanupCrmLoginFixtures);

async function pinToken(): Promise<string> {
  return (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
}
async function signIn(username: string): Promise<string> {
  const res = await request(app).post("/auth/login").send({ username, password: PASS });
  expect(res.status).toBe(200);
  return res.body.token as string;
}
async function aiAdminToken(): Promise<string> {
  await saveAdminLogin("grok-admin", AI_PASS);
  return (await request(app).post("/auth/login").send({ username: "grok-admin", password: AI_PASS })).body.token as string;
}
/** An owner-role login holding EVERY power except being Kyle: the strongest non-Kyle session there is. */
async function michael() {
  const person = await makePerson("Michael Test");
  const row = await saveCrmLogin(person.id, { username: "michael", role: "owner", password: PASS });
  await setPowers(row.id, ["van_clearance", "lle_verify", "level_gates", "training_publish", "price_book_edit", "treasury", "bot_keys", "approve_drafts"]);
  return { person, row, token: await signIn("michael") };
}
/** Kyle's own principal CRM login. */
async function kylePrincipal() {
  const person = await makePerson("Kyle Test");
  const row = await saveCrmLogin(person.id, { username: "kyle", role: "owner", password: PASS });
  await setPrincipal(row.id);
  return { person, row, token: await signIn("kyle") };
}

const ROUTES: Array<{ label: string; send: (id: string, t: string) => request.Test }> = [
  { label: "GET /crm-logins", send: (_id, t) => request(app).get("/crm-logins").set(bearer(t)) },
  { label: "PUT /crm-logins/:id", send: (id, t) => request(app).put(`/crm-logins/${id}`).set(bearer(t)).send({ username: "hacker", role: "owner", password: PASS }) },
  { label: "POST /crm-logins/:id/disable", send: (id, t) => request(app).post(`/crm-logins/${id}/disable`).set(bearer(t)) },
  { label: "POST /crm-logins/:id/enable", send: (id, t) => request(app).post(`/crm-logins/${id}/enable`).set(bearer(t)) },
  { label: "DELETE /crm-logins/:id", send: (id, t) => request(app).delete(`/crm-logins/${id}`).set(bearer(t)) },
  { label: "PUT /crm-logins/:id/powers", send: (id, t) => request(app).put(`/crm-logins/${id}/powers`).set(bearer(t)).send({ powers: ["treasury"] }) },
  { label: "POST /crm-logins/:id/principal", send: (id, t) => request(app).post(`/crm-logins/${id}/principal`).set(bearer(t)).send({ principal: true }) },
];

describe("every /crm-logins route is Kyle only", () => {
  it("none is on the public allowlist, and none answers without a session", async () => {
    expect(isPublicRoute("GET", "/crm-logins")).toBe(false);
    expect(isPublicRoute("PUT", "/crm-logins/abc")).toBe(false);
    expect(isPublicRoute("POST", "/crm-logins/abc/principal")).toBe(false);
    const target = (await makePerson("Target")).id;
    for (const route of ROUTES) {
      const res = await route.send(target, "");
      expect(res.status, route.label).toBe(401);
    }
  });

  it("a non-Kyle session gets 403 on every route, however much Kyle has granted it, and nothing changes", async () => {
    const mike = await michael();
    const target = await makePerson("Target");
    const targetLogin = await saveCrmLogin(target.id, { username: "target", role: "office", password: PASS });
    const before = await prisma.crmLogin.findMany({ orderBy: { username: "asc" } });

    for (const route of ROUTES) {
      for (const [who, token] of [["owner-role person holding every power", mike.token], ["AI admin", await aiAdminToken()]] as const) {
        const res = await route.send(target.id, token);
        expect(res.status, `${route.label} as ${who}`).toBe(403);
        expect(res.body, `${route.label} as ${who}`).toEqual({ error: "Only Kyle manages CRM logins." });
      }
    }
    // Unknown person ids do not turn a 403 into a 404 either.
    expect((await ROUTES[2].send("no-such-person", mike.token)).status).toBe(403);
    expect(await prisma.crmLogin.findMany({ orderBy: { username: "asc" } })).toEqual(before);
    expect(targetLogin.id).toBeTruthy();
  });
});

describe("Kyle manages logins", () => {
  it("creates a login with PUT and never returns the hash", async () => {
    const pin = await pinToken();
    const person = await makePerson("Michael Schramm");
    const res = await request(app).put(`/crm-logins/${person.id}`).set(bearer(pin)).send({ username: "michael", role: "owner", password: PASS });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      technicianId: person.id, name: "Michael Schramm", username: "michael", role: "owner",
      isPrincipal: false, powers: [], enabled: true, hasPassword: true, personActive: true,
    });
    const stored = await prisma.crmLogin.findUniqueOrThrow({ where: { technicianId: person.id } });
    expect(stored.passwordHash).toMatch(/^\$2/);
    // No response, on any route, contains the hash or the password.
    const texts = [
      JSON.stringify(res.body),
      JSON.stringify((await request(app).get("/crm-logins").set(bearer(pin))).body),
      JSON.stringify((await request(app).post(`/crm-logins/${person.id}/disable`).set(bearer(pin))).body),
      JSON.stringify((await request(app).post(`/crm-logins/${person.id}/enable`).set(bearer(pin))).body),
      JSON.stringify((await request(app).put(`/crm-logins/${person.id}/powers`).set(bearer(pin)).send({ powers: ["treasury"] })).body),
    ];
    for (const text of texts) {
      expect(text).not.toContain(stored.passwordHash as string);
      expect(text).not.toContain(PASS);
      expect(text.toLowerCase()).not.toContain("passwordhash");
      expect(text).not.toContain("$2");
    }
  });

  it("lists every login with its person's name, and the roster person can then sign in", async () => {
    const pin = await pinToken();
    const a = await makePerson("Person A");
    const b = await makePerson("Person B");
    await request(app).put(`/crm-logins/${a.id}`).set(bearer(pin)).send({ username: "alpha", role: "admin", password: PASS });
    await request(app).put(`/crm-logins/${b.id}`).set(bearer(pin)).send({ username: "bravo", role: "tech" }); // no password
    const list = await request(app).get("/crm-logins").set(bearer(pin));
    expect(list.status).toBe(200);
    expect(list.body.logins.map((l: { username: string; hasPassword: boolean }) => [l.username, l.hasPassword])).toEqual([["alpha", true], ["bravo", false]]);
    expect((await request(app).post("/auth/login").send({ username: "alpha", password: PASS })).status).toBe(200);
  });

  it("validates the body: short username, bad role, short or over-long password are 400, and nothing is created", async () => {
    const pin = await pinToken();
    const person = await makePerson("Michael");
    const put = (body: Record<string, unknown>) => request(app).put(`/crm-logins/${person.id}`).set(bearer(pin)).send(body);
    expect((await put({ username: "ab", role: "owner", password: PASS })).status).toBe(400);
    expect((await put({ username: "michael", role: "superuser", password: PASS })).status).toBe(400);
    expect((await put({ username: "michael", role: "owner", password: "short" })).status).toBe(400);
    expect((await put({ username: "michael", role: "owner", password: "x".repeat(73) })).status).toBe(400);
    expect((await put({ role: "owner" })).status).toBe(400);
    expect(await prisma.crmLogin.count()).toBe(0);
    expect((await request(app).put("/crm-logins/no-such-person").set(bearer(pin)).send({ username: "michael", role: "owner" })).status).toBe(404);
  });

  it("a blank password on an existing login keeps the current one and the session; a tech role is allowed to be saved", async () => {
    const pin = await pinToken();
    const person = await makePerson("Michael");
    await request(app).put(`/crm-logins/${person.id}`).set(bearer(pin)).send({ username: "michael", role: "owner", password: PASS });
    const token = await signIn("michael");
    const res = await request(app).put(`/crm-logins/${person.id}`).set(bearer(pin)).send({ username: "michael", role: "office" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("office");
    expect((await request(app).get("/accounts").set(bearer(token))).status).toBe(200);
    expect((await request(app).put(`/crm-logins/${person.id}`).set(bearer(pin)).send({ username: "michael", role: "tech" })).status).toBe(200);
  });

  it("refuses a username the AI admin holds with 409", async () => {
    await saveAdminLogin("grok-admin", AI_PASS);
    const person = await makePerson("Michael");
    const res = await request(app).put(`/crm-logins/${person.id}`).set(bearer(await pinToken())).send({ username: "Grok-Admin", role: "owner", password: PASS });
    expect(res.status).toBe(409);
    expect(await prisma.crmLogin.count()).toBe(0);
  });

  it("turn off signs the person out at once, turn on lets them sign in again, remove deletes the login", async () => {
    const pin = await pinToken();
    const person = await makePerson("Michael");
    await request(app).put(`/crm-logins/${person.id}`).set(bearer(pin)).send({ username: "michael", role: "owner", password: PASS });
    const token = await signIn("michael");

    const off = await request(app).post(`/crm-logins/${person.id}/disable`).set(bearer(pin));
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    expect((await request(app).get("/accounts").set(bearer(token))).status).toBe(401);
    expect((await request(app).post("/auth/login").send({ username: "michael", password: PASS })).status).toBe(401);

    const on = await request(app).post(`/crm-logins/${person.id}/enable`).set(bearer(pin));
    expect(on.body.enabled).toBe(true);
    const again = await signIn("michael");
    expect((await request(app).get("/accounts").set(bearer(again))).status).toBe(200);

    const gone = await request(app).delete(`/crm-logins/${person.id}`).set(bearer(pin));
    expect(gone.status).toBe(200);
    expect(await prisma.crmLogin.count()).toBe(0);
    expect((await request(app).get("/accounts").set(bearer(again))).status).toBe(401);
    // A second remove, or a disable with no login, is a plain 404.
    expect((await request(app).delete(`/crm-logins/${person.id}`).set(bearer(pin))).status).toBe(404);
    expect((await request(app).post(`/crm-logins/${person.id}/disable`).set(bearer(pin))).status).toBe(404);
  });

  it("sets powers: the eight known keys only; an unknown key is a 400 and changes nothing", async () => {
    const pin = await pinToken();
    const person = await makePerson("Michael");
    await request(app).put(`/crm-logins/${person.id}`).set(bearer(pin)).send({ username: "michael", role: "owner", password: PASS });
    const set = (powers: unknown) => request(app).put(`/crm-logins/${person.id}/powers`).set(bearer(pin)).send({ powers });

    const ok = await set(["treasury", "approve_drafts", "price_book_edit"]);
    expect(ok.status).toBe(200);
    expect(ok.body.powers).toEqual(["price_book_edit", "treasury", "approve_drafts"]);

    for (const bad of [["treasury", "owner"], ["root"], ["TREASURY"], [""]]) {
      const res = await set(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error).toMatch(/Unknown power/);
    }
    expect((await request(app).put(`/crm-logins/${person.id}/powers`).set(bearer(pin)).send({ powers: "treasury" })).status).toBe(400);
    expect((await request(app).put(`/crm-logins/${person.id}/powers`).set(bearer(pin)).send({})).status).toBe(400);
    expect((await prisma.crmLogin.findUniqueOrThrow({ where: { technicianId: person.id } })).powers).toEqual(["price_book_edit", "treasury", "approve_drafts"]);
    expect((await set([])).body.powers).toEqual([]);
    expect((await request(app).put("/crm-logins/no-such-person/powers").set(bearer(pin)).send({ powers: [] })).status).toBe(404);
  });

  it("Kyle's principal login manages logins too (it is Kyle), but cannot move the principal mark", async () => {
    const kyle = await kylePrincipal();
    const person = await makePerson("Michael");
    const put = await request(app).put(`/crm-logins/${person.id}`).set(bearer(kyle.token)).send({ username: "michael", role: "owner", password: PASS });
    expect(put.status).toBe(200);
    expect((await request(app).get("/crm-logins").set(bearer(kyle.token))).status).toBe(200);
    expect((await request(app).put(`/crm-logins/${person.id}/powers`).set(bearer(kyle.token)).send({ powers: ["treasury"] })).status).toBe(200);
  });
});

describe("the principal mark is the PIN session only", () => {
  it("the PIN marks a login as Kyle's, then unmarks it; exactly one row is ever marked", async () => {
    const pin = await pinToken();
    const a = await makePerson("A");
    const b = await makePerson("B");
    for (const [p, u] of [[a, "alpha"], [b, "bravo"]] as const) {
      await request(app).put(`/crm-logins/${p.id}`).set(bearer(pin)).send({ username: u, role: "owner", password: PASS });
    }
    const first = await request(app).post(`/crm-logins/${a.id}/principal`).set(bearer(pin)).send({ principal: true });
    expect(first.status).toBe(200);
    expect(first.body.isPrincipal).toBe(true);
    const second = await request(app).post(`/crm-logins/${b.id}/principal`).set(bearer(pin)).send({ principal: true });
    expect(second.body.isPrincipal).toBe(true);
    expect(await prisma.crmLogin.count({ where: { isPrincipal: true } })).toBe(1);
    const off = await request(app).post(`/crm-logins/${b.id}/principal`).set(bearer(pin)).send({ principal: false });
    expect(off.body.isPrincipal).toBe(false);
    expect(await prisma.crmLogin.count({ where: { isPrincipal: true } })).toBe(0);
    expect((await request(app).post(`/crm-logins/${b.id}/principal`).set(bearer(pin)).send({ principal: "yes" })).status).toBe(400);
    expect((await request(app).post("/crm-logins/no-such-person/principal").set(bearer(pin)).send({ principal: true })).status).toBe(404);
  });

  it("a principal CRM login gets 403 on /principal, both to mark another and to move its own, and the mark stays put", async () => {
    const kyle = await kylePrincipal();
    const other = await makePerson("Michael");
    await saveCrmLogin(other.id, { username: "michael", role: "owner", password: PASS });
    for (const [id, principal] of [[other.id, true], [kyle.person.id, false], [kyle.person.id, true]] as const) {
      const res = await request(app).post(`/crm-logins/${id}/principal`).set(bearer(kyle.token)).send({ principal });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Only the owner PIN can choose which login is Kyle's." });
    }
    const marked = await prisma.crmLogin.findMany({ where: { isPrincipal: true } });
    expect(marked.map((m) => m.id)).toEqual([kyle.row.id]);
  });
});

describe("the AI admin login is Kyle's: the PIN or his principal login, nobody else", () => {
  const AI_BODY = { username: "grok-admin", password: AI_PASS };
  const MESSAGE = { error: "Only the owner can change the AI admin login." };

  it("Kyle's principal login can save, turn off, turn on and remove the AI admin login", async () => {
    const kyle = await kylePrincipal();
    const put = await request(app).put("/settings/admin-login").set(bearer(kyle.token)).send(AI_BODY);
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ configured: true, username: "grok-admin", enabled: true });
    expect((await request(app).post("/settings/admin-login/disable").set(bearer(kyle.token))).body.enabled).toBe(false);
    expect((await request(app).post("/settings/admin-login/enable").set(bearer(kyle.token))).body.enabled).toBe(true);
    expect((await request(app).delete("/settings/admin-login").set(bearer(kyle.token))).status).toBe(200);
    expect(await prisma.adminLogin.count()).toBe(0);
  });

  it("an owner-role login that is not Kyle's principal gets 403 with the same message on every write, and nothing changes", async () => {
    const mike = await michael(); // owner role, every power, not principal
    const put = await request(app).put("/settings/admin-login").set(bearer(mike.token)).send(AI_BODY);
    expect(put.status).toBe(403);
    expect(put.body).toEqual(MESSAGE);
    expect(await prisma.adminLogin.count()).toBe(0);

    await saveAdminLogin("grok-admin", AI_PASS);
    for (const send of [
      () => request(app).put("/settings/admin-login").set(bearer(mike.token)).send({ username: "other-name", password: AI_PASS }),
      () => request(app).post("/settings/admin-login/disable").set(bearer(mike.token)),
      () => request(app).post("/settings/admin-login/enable").set(bearer(mike.token)),
      () => request(app).delete("/settings/admin-login").set(bearer(mike.token)),
    ]) {
      const res = await send();
      expect(res.status).toBe(403);
      expect(res.body).toEqual(MESSAGE);
    }
    const row = await prisma.adminLogin.findFirstOrThrow();
    expect(row).toMatchObject({ username: "grok-admin", enabled: true, sessionVersion: 1 });
    // Reading the status stays open to any signed-in session.
    expect((await request(app).get("/settings/admin-login").set(bearer(mike.token))).status).toBe(200);
  });

  it("the PIN still can, and the AI admin itself still cannot", async () => {
    const pin = await pinToken();
    expect((await request(app).put("/settings/admin-login").set(bearer(pin)).send(AI_BODY)).status).toBe(200);
    const signedIn = (await request(app).post("/auth/login").send(AI_BODY)).body.token as string;
    expect((await request(app).post("/settings/admin-login/disable").set(bearer(signedIn))).status).toBe(403);
  });
});

describe("GET /health-record-admin/technicians carries no login fields", () => {
  it("lists the roster with no CRM login, username, hash or role on any row", async () => {
    const mike = await michael();
    const kyle = await kylePrincipal();
    const res = await request(app).get("/health-record-admin/technicians").set(bearer(await pinToken()));
    expect(res.status).toBe(200);
    const rows = res.body as Array<Record<string, unknown>>;
    expect(rows.some((r) => r.id === mike.person.id)).toBe(true);
    expect(rows.some((r) => r.id === kyle.person.id)).toBe(true);
    const text = JSON.stringify(res.body).toLowerCase();
    for (const row of rows) {
      for (const key of ["crmLogin", "passwordHash", "username", "isPrincipal", "powers", "sessionVersion"]) {
        expect(Object.keys(row), key).not.toContain(key);
      }
    }
    expect(text).not.toContain("passwordhash");
    expect(text).not.toContain("$2a$");
    expect(text).not.toContain("$2b$");
  });
});
