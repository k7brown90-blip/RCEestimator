import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { isPublicRoute } from "../src/middleware/publicRoutes";
import { saveCrmLogin, setCrmLoginEnabled, setPowers, setPrincipal, removeCrmLogin } from "../src/services/crmLogin";
import { saveAdminLogin } from "../src/services/adminLogin";
import { CRM_POWER_KEYS } from "../shared/crmPowers";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";

/**
 * Work order agent-team, HA2: the person's CRM login signs in on the SAME /auth/login door as the AI
 * admin, the gate and refresh know it, and GET /auth/session is the one who-am-I. Its own file
 * because PIN_HASH is set for the whole file, which would 401 every other test sharing it (same
 * reason as adminLogin.test.ts / sessionRefresh.test.ts).
 */

const JWT_SECRET = process.env.JWT_SECRET ?? "rce-dev-secret-change-me";
const PIN = "1234";
const PASS = "correct horse battery";
const AI_PASS = "another long password!";
const BAD_BODY = { error: "Invalid username or password" };

beforeAll(async () => {
  process.env.PIN_HASH = await hashPin(PIN);
});
afterAll(async () => {
  delete process.env.PIN_HASH;
  await cleanupCrmLoginFixtures();
});
beforeEach(cleanupCrmLoginFixtures);

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function pinToken(): Promise<string> {
  const res = await request(app).post("/auth/pin").send({ pin: PIN });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

async function makeUser(username = "michael", role = "owner", name = "Michael Test") {
  const person = await makePerson(name);
  const row = await saveCrmLogin(person.id, { username, role, password: PASS });
  return { person, row };
}

async function signIn(username: string, password = PASS) {
  return request(app).post("/auth/login").send({ username, password });
}

async function userToken(username = "michael"): Promise<string> {
  const res = await signIn(username);
  expect(res.status).toBe(200);
  return res.body.token as string;
}

describe("POST /auth/login for a person", () => {
  it("signs a CRM user in, with a token that names the login and carries no role or powers", async () => {
    const { row } = await makeUser();
    const res = await signIn("michael");
    expect(res.status).toBe(200);
    expect(res.body.expiresIn).toBe(8 * 60 * 60);
    const claims = jwt.verify(res.body.token as string, JWT_SECRET) as Record<string, unknown>;
    expect(claims.sub).toBe(`user:${row.id}`);
    expect(claims.lid).toBe(row.id);
    expect(claims.ver).toBe(1);
    expect(claims.role).toBeUndefined();
    expect(claims.powers).toBeUndefined();
    expect((await request(app).get("/accounts").set(bearer(res.body.token as string))).status).toBe(200);
  });

  it("matches the username case-insensitively and treats % and _ literally", async () => {
    await makeUser("Mi_chael");
    expect((await signIn("mi_CHAEL")).status).toBe(200);
    expect((await signIn("miXchael")).status).toBe(401);
    expect((await signIn("Mi%")).status).toBe(401);
  });

  it("a wrong password, an unknown user, a null password hash, a turned-off login and a deactivated person all give the identical 401", async () => {
    const { person, row } = await makeUser("michael");
    const noPass = await makePerson("No Password");
    await saveCrmLogin(noPass.id, { username: "nopass", role: "office" });
    const off = await makeUser("offuser", "office", "Off User");
    await setCrmLoginEnabled(off.row.id, false);
    const gone = await makeUser("goneuser", "office", "Gone User");
    await prisma.technician.update({ where: { id: gone.person.id }, data: { isActive: false } });

    const attempts = [
      await signIn("michael", "wrong password here"),
      await signIn("nobody"),
      await signIn("nopass", PASS),
      await signIn("nopass", ""),
      await signIn("offuser"),
      await signIn("goneuser"),
      await signIn("michael", ""),
      await request(app).post("/auth/login").send({ username: "michael" }),
      await request(app).post("/auth/login").send({}),
      await signIn("a\u0000b"),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(BAD_BODY);
      expect(res.body.token).toBeUndefined();
    }
    expect(row.id).toBeTruthy();
    expect(person.id).toBeTruthy();
  });

  it("runs exactly one bcrypt compare per attempt, whichever table is hit", async () => {
    await makeUser("michael");
    await saveAdminLogin("grok-admin", AI_PASS);
    const noPass = await makePerson("No Password");
    await saveCrmLogin(noPass.id, { username: "nopass", role: "office" });

    const spy = vi.spyOn(bcrypt, "compare");
    try {
      const cases: Array<[string, string, number]> = [
        ["michael", PASS, 200], // person, right
        ["michael", "wrong password here", 401], // person, wrong
        ["grok-admin", AI_PASS, 200], // AI admin, right
        ["grok-admin", "wrong password here", 401], // AI admin, wrong
        ["nobody", PASS, 401], // unknown
        ["nopass", PASS, 401], // null hash
      ];
      for (const [username, password, status] of cases) {
        spy.mockClear();
        const res = await signIn(username, password);
        expect(res.status, `${username}`).toBe(status);
        expect(spy, `${username} compare count`).toHaveBeenCalledTimes(1);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("reads credentials from the body only, never the URL", async () => {
    await makeUser();
    const res = await request(app).post(`/auth/login?username=michael&password=${encodeURIComponent(PASS)}`);
    expect(res.status).toBe(401);
  });

  it("the AI admin still signs in as before, and keeps precedence on its own name", async () => {
    await saveAdminLogin("grok-admin", AI_PASS);
    const res = await signIn("grok-admin", AI_PASS);
    expect(res.status).toBe(200);
    expect((jwt.verify(res.body.token as string, JWT_SECRET) as { sub: string }).sub).toBe("ai-admin");
  });

  it("the PIN session is still sub=owner", async () => {
    expect((jwt.verify(await pinToken(), JWT_SECRET) as { sub: string }).sub).toBe("owner");
  });
});

describe("a tech-role login has no CRM sign-in yet", () => {
  it("saving one is allowed, but it gets the identical 401 at sign-in", async () => {
    const { row } = await makeUser("techuser", "tech", "Tech User");
    expect(row.role).toBe("tech");
    const res = await signIn("techuser");
    expect(res.status).toBe(401);
    expect(res.body).toEqual(BAD_BODY);
    expect(res.body.token).toBeUndefined();
  });

  it("a signed-in owner-role login changed to tech gets 401 on its next request, and cannot refresh", async () => {
    const { row } = await makeUser("michael", "owner");
    const token = await userToken();
    expect((await request(app).get("/accounts").set(bearer(token))).status).toBe(200);
    await saveCrmLogin(row.technicianId, { username: "michael", role: "tech" });
    const refused = await request(app).get("/accounts").set(bearer(token));
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: "Invalid or expired session" });
    expect((await request(app).post("/auth/refresh").set(bearer(token))).status).toBe(401);
    expect((await signIn("michael")).status).toBe(401);
    // And back again: the same login works once it is not a tech role.
    await saveCrmLogin(row.technicianId, { username: "michael", role: "office" });
    expect((await signIn("michael")).status).toBe(200);
  });

  it("still runs exactly one bcrypt compare for the tech-role refusal", async () => {
    await makeUser("techuser", "tech", "Tech User");
    const spy = vi.spyOn(bcrypt, "compare");
    try {
      expect((await signIn("techuser")).status).toBe(401);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("/auth/login issues the same database lookups whether the name is unknown, the AI admin's or a person's", () => {
  it("one AdminLogin lookup and one CrmLogin lookup (a single raw query) on every path, and nothing else", async () => {
    await makeUser("michael");
    await saveAdminLogin("grok-admin", AI_PASS);

    const adminFind = vi.spyOn(prisma.adminLogin, "findUnique");
    const raw = vi.spyOn(prisma, "$queryRaw");
    const crmFind = vi.spyOn(prisma.crmLogin, "findUnique");
    const crmFirst = vi.spyOn(prisma.crmLogin, "findFirst");
    const techFind = vi.spyOn(prisma.technician, "findUnique");
    const spies = [adminFind, raw, crmFind, crmFirst, techFind];
    const counts: Record<string, number[]> = {};
    try {
      for (const [label, username, password] of [
        ["unknown", "nobody", PASS],
        ["ai-admin", "grok-admin", AI_PASS],
        ["ai-admin wrong password", "grok-admin", "wrong password here"],
        ["person", "michael", PASS],
        ["person wrong password", "MICHAEL", "wrong password here"],
      ] as const) {
        for (const spy of spies) spy.mockClear();
        await signIn(username, password);
        counts[label] = spies.map((s) => s.mock.calls.length);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    // [adminLogin.findUnique, $queryRaw, crmLogin.findUnique, crmLogin.findFirst, technician.findUnique]
    for (const label of Object.keys(counts)) expect(counts[label], label).toEqual([1, 1, 0, 0, 0]);
  });

  it("the lookup is parameterised: a username that looks like SQL is data, not a query", async () => {
    await makeUser("michael");
    const res = await signIn("x' OR lower(username) = lower('michael");
    expect(res.status).toBe(401);
    expect(res.body).toEqual(BAD_BODY);
    expect((await signIn("michael")).status).toBe(200);
  });
});

describe("the gate follows the person's row", () => {
  it("Turn off and Turn on: the old token is refused, a new sign-in works", async () => {
    const { row } = await makeUser();
    const token = await userToken();
    expect((await request(app).get("/accounts").set(bearer(token))).status).toBe(200);
    await setCrmLoginEnabled(row.id, false);
    const refused = await request(app).get("/accounts").set(bearer(token));
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: "Invalid or expired session" });
    await setCrmLoginEnabled(row.id, true);
    expect((await request(app).get("/accounts").set(bearer(token))).status).toBe(401);
    expect((await signIn("michael")).status).toBe(200);
  });

  it("a password change ends the session on the next request", async () => {
    const { person } = await makeUser();
    const token = await userToken();
    await saveCrmLogin(person.id, { username: "michael", role: "owner", password: "a different long password" });
    expect((await request(app).get("/accounts").set(bearer(token))).status).toBe(401);
    expect((await signIn("michael", PASS)).status).toBe(401);
    expect((await signIn("michael", "a different long password")).status).toBe(200);
  });

  it("Remove ends the session on the next request", async () => {
    const { row } = await makeUser();
    const token = await userToken();
    await removeCrmLogin(row.id);
    expect((await request(app).get("/accounts").set(bearer(token))).status).toBe(401);
  });

  it("a deactivated team member gets 401 on the next request", async () => {
    const { person } = await makeUser();
    const token = await userToken();
    await prisma.technician.update({ where: { id: person.id }, data: { isActive: false } });
    expect((await request(app).get("/accounts").set(bearer(token))).status).toBe(401);
  });

  it("a role or power change takes effect on the next request without a re-sign-in", async () => {
    const { row } = await makeUser("michael", "office");
    const token = await userToken();
    const before = await request(app).get("/auth/session").set(bearer(token));
    expect(before.body).toMatchObject({ kind: "user", role: "office", isKyle: false, powers: [] });

    await saveCrmLogin(row.technicianId, { username: "michael", role: "admin" });
    await setPowers(row.id, ["treasury", "approve_drafts"]);
    const after = await request(app).get("/auth/session").set(bearer(token));
    expect(after.body).toMatchObject({ kind: "user", role: "admin", isKyle: false, powers: ["treasury", "approve_drafts"] });

    await setPowers(row.id, []);
    expect((await request(app).get("/auth/session").set(bearer(token))).body.powers).toEqual([]);
  });

  it("a token whose id does not match its subject is refused", async () => {
    const a = await makeUser("michael");
    const b = await makeUser("other", "office", "Other");
    const forged = jwt.sign({ sub: `user:${a.row.id}`, lid: b.row.id, ver: b.row.sessionVersion }, JWT_SECRET, { expiresIn: "1h" });
    expect((await request(app).get("/accounts").set(bearer(forged))).status).toBe(401);
  });

  it("writes the actor user:<id> in the access log, never a token", async () => {
    const { row } = await makeUser();
    const token = await userToken();
    const lines: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      try {
        const parsed = JSON.parse(String(args[0])) as Record<string, unknown>;
        if (parsed.log === "access") lines.push(parsed);
      } catch { /* not a JSON line */ }
    });
    try {
      await request(app).get("/accounts").set(bearer(token));
    } finally {
      spy.mockRestore();
    }
    const line = lines.find((l) => l.path === "/accounts");
    expect(line, "an access line for /accounts").toBeDefined();
    expect(line?.actor).toBe(`user:${row.id}`);
    expect(line?.auth).toBe("ok");
    expect(JSON.stringify(line)).not.toContain(token);
  });
});

describe("POST /auth/refresh for a person", () => {
  it("renews a live session with the same login id and version", async () => {
    const { row } = await makeUser();
    const token = await userToken();
    const res = await request(app).post("/auth/refresh").set(bearer(token));
    expect(res.status).toBe(200);
    const claims = jwt.verify(res.body.token as string, JWT_SECRET) as Record<string, unknown>;
    expect(claims.sub).toBe(`user:${row.id}`);
    expect(claims.lid).toBe(row.id);
    expect(claims.ver).toBe(row.sessionVersion);
    expect((await request(app).get("/accounts").set(bearer(res.body.token as string))).status).toBe(200);
  });

  it("is refused after Remove, after Turn off and after a password change", async () => {
    const { row, person } = await makeUser();
    const token = await userToken();
    await saveCrmLogin(person.id, { username: "michael", role: "owner", password: "a different long password" });
    expect((await request(app).post("/auth/refresh").set(bearer(token))).status).toBe(401);

    const fresh = (await signIn("michael", "a different long password")).body.token as string;
    await setCrmLoginEnabled(row.id, false);
    expect((await request(app).post("/auth/refresh").set(bearer(fresh))).status).toBe(401);

    await setCrmLoginEnabled(row.id, true);
    const again = (await signIn("michael", "a different long password")).body.token as string;
    await removeCrmLogin(row.id);
    expect((await request(app).post("/auth/refresh").set(bearer(again))).status).toBe(401);
  });
});

describe("GET /auth/session", () => {
  it("is behind the gate and not on the public allowlist", async () => {
    expect(isPublicRoute("GET", "/auth/session")).toBe(false);
    expect((await request(app).get("/auth/session")).status).toBe(401);
    expect((await request(app).get("/auth/session").set(bearer("garbage"))).status).toBe(401);
  });

  it("is the PIN: kind kyle-pin, owner, every power, name Kyle until a principal login is set", async () => {
    const res = await request(app).get("/auth/session").set(bearer(await pinToken()));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "kyle-pin", name: "Kyle", role: "owner", isKyle: true, powers: [...CRM_POWER_KEYS] });
  });

  it("the PIN takes its name from the principal login's person", async () => {
    const { row } = await makeUser("kyle", "owner", "Kyle Rowe");
    await setPrincipal(row.id);
    const res = await request(app).get("/auth/session").set(bearer(await pinToken()));
    expect(res.body.name).toBe("Kyle Rowe");
    expect(res.body.isKyle).toBe(true);
  });

  it("is a person: kind user, their own role, only the powers Kyle granted", async () => {
    const { row } = await makeUser("michael", "owner", "Michael Test");
    await setPowers(row.id, ["price_book_edit"]);
    const res = await request(app).get("/auth/session").set(bearer(await userToken()));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "user", name: "Michael Test", role: "owner", isKyle: false, powers: ["price_book_edit"] });
  });

  it("the principal login is Kyle and holds every power", async () => {
    const { row } = await makeUser("kyle", "owner", "Kyle Rowe");
    await setPrincipal(row.id);
    const res = await request(app).get("/auth/session").set(bearer(await userToken("kyle")));
    expect(res.body).toEqual({ kind: "user", name: "Kyle Rowe", role: "owner", isKyle: true, powers: [...CRM_POWER_KEYS] });
  });

  it("is the AI admin: kind ai-admin, no powers, never Kyle", async () => {
    await saveAdminLogin("grok-admin", AI_PASS);
    const token = (await signIn("grok-admin", AI_PASS)).body.token as string;
    const res = await request(app).get("/auth/session").set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "ai-admin", name: "grok-admin", role: "ai-admin", isKyle: false, powers: [] });
  });

  it("never contains a token or a hash", async () => {
    const { row } = await makeUser();
    await setPrincipal(row.id);
    for (const token of [await pinToken(), await userToken()]) {
      const text = JSON.stringify((await request(app).get("/auth/session").set(bearer(token))).body);
      expect(text).not.toContain(token);
      expect(text).not.toContain("$2");
      expect(text.toLowerCase()).not.toContain("hash");
      expect(text.toLowerCase()).not.toContain("token");
    }
  });
});

describe("usernames may not collide between the AI admin and a person", () => {
  it("PUT /settings/admin-login answers 409 for a person's username and leaves the AI admin as it was", async () => {
    await makeUser("Michael");
    const pin = await pinToken();
    const clash = await request(app).put("/settings/admin-login").set(bearer(pin)).send({ username: "michael", password: AI_PASS });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatch(/CRM login/);
    expect(await prisma.adminLogin.count()).toBe(0);
    const ok = await request(app).put("/settings/admin-login").set(bearer(pin)).send({ username: "grok-admin", password: AI_PASS });
    expect(ok.status).toBe(200);
  });
});
