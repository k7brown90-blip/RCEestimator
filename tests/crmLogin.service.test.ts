import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";
import {
  CrmLoginError, currentCrmLoginFor, listCrmLogins, removeCrmLogin, saveCrmLogin, setCrmLoginEnabled,
  setPowers, setPrincipal, toCrmLoginView,
} from "../src/services/crmLogin";
import { saveAdminLogin, UsernameTakenError } from "../src/services/adminLogin";
import { CRM_POWER_KEYS, CRM_POWERS } from "../shared/crmPowers";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";

/**
 * Work order agent-team, HA1: the CrmLogin model and service. A person's CRM sign-in, mirroring
 * services/adminLogin.ts. No HTTP here; the door is tests/crmLoginSession.test.ts.
 */

const PASS = "correct horse battery";

beforeEach(cleanupCrmLoginFixtures);
afterAll(cleanupCrmLoginFixtures);

async function makeLogin(username = "michael", role = "owner", password: string | null = PASS) {
  const person = await makePerson(`Person ${username}`);
  const row = await saveCrmLogin(person.id, { username, role, password: password ?? undefined });
  return { person, row };
}

describe("shared power list", () => {
  it("has the eight Kyle-only powers, each with a label and a 403 reason", () => {
    expect([...CRM_POWER_KEYS].sort()).toEqual([
      "approve_drafts", "bot_keys", "level_gates", "lle_verify", "price_book_edit", "training_publish", "treasury", "van_clearance",
    ]);
    for (const key of CRM_POWER_KEYS) {
      expect(CRM_POWERS[key].label.length).toBeGreaterThan(3);
      expect(CRM_POWERS[key].reason).toMatch(/^Only Kyle can /);
    }
  });
});

describe("the view never shows the hash", () => {
  it("returns hasPassword, not the password hash, and says whether one is set", async () => {
    const { row } = await makeLogin();
    const view = toCrmLoginView(row);
    expect(view.hasPassword).toBe(true);
    const text = JSON.stringify(view);
    expect(text).not.toContain(row.passwordHash as string);
    expect(text).not.toContain("$2");
    expect(text.toLowerCase()).not.toContain("passwordhash");
    const none = await makeLogin("nopassword", "office", null);
    expect(toCrmLoginView(none.row).hasPassword).toBe(false);
    expect(none.row.passwordHash).toBeNull();
  });

  it("listCrmLogins returns each person with their roster name", async () => {
    await makeLogin("michael");
    const list = await listCrmLogins();
    expect(list).toHaveLength(1);
    expect(toCrmLoginView(list[0]).name).toBe("Person michael");
  });
});

describe("currentCrmLoginFor ends a session the instant the row changes", () => {
  it("accepts the row as it was signed in, and refuses garbage ids and versions", async () => {
    const { row } = await makeLogin();
    expect((await currentCrmLoginFor(row.id, row.sessionVersion))?.id).toBe(row.id);
    expect(await currentCrmLoginFor(undefined, 1)).toBeNull();
    expect(await currentCrmLoginFor(row.id, "1")).toBeNull();
    expect(await currentCrmLoginFor("no-such-id", 1)).toBeNull();
  });

  it("a password change invalidates it", async () => {
    const { person, row } = await makeLogin();
    await saveCrmLogin(person.id, { username: "michael", role: "owner", password: "a different long password" });
    expect(await currentCrmLoginFor(row.id, row.sessionVersion)).toBeNull();
    const fresh = await prisma.crmLogin.findUniqueOrThrow({ where: { id: row.id } });
    expect(fresh.sessionVersion).toBe(row.sessionVersion + 1);
  });

  it("a role or username change alone does not sign anyone out", async () => {
    const { person, row } = await makeLogin();
    await saveCrmLogin(person.id, { username: "michael2", role: "office" });
    const still = await currentCrmLoginFor(row.id, row.sessionVersion);
    expect(still?.role).toBe("office");
    expect(still?.passwordHash).toBe(row.passwordHash);
  });

  it("Turn off invalidates it and Turn on does not bring the old session back", async () => {
    const { row } = await makeLogin();
    const off = await setCrmLoginEnabled(row.id, false);
    expect(off?.enabled).toBe(false);
    expect(await currentCrmLoginFor(row.id, row.sessionVersion)).toBeNull();
    const on = await setCrmLoginEnabled(row.id, true);
    expect(on?.enabled).toBe(true);
    expect(await currentCrmLoginFor(row.id, row.sessionVersion)).toBeNull(); // old version, still refused
    expect(await currentCrmLoginFor(row.id, on!.sessionVersion)).not.toBeNull();
    expect(await setCrmLoginEnabled("no-such-id", false)).toBeNull();
  });

  it("Remove invalidates it", async () => {
    const { row } = await makeLogin();
    expect(await removeCrmLogin(row.id)).toBe(true);
    expect(await currentCrmLoginFor(row.id, row.sessionVersion)).toBeNull();
    expect(await removeCrmLogin(row.id)).toBe(false);
  });

  it("a deactivated team member invalidates it", async () => {
    const { person, row } = await makeLogin();
    await prisma.technician.update({ where: { id: person.id }, data: { isActive: false } });
    expect(await currentCrmLoginFor(row.id, row.sessionVersion)).toBeNull();
    await prisma.technician.update({ where: { id: person.id }, data: { isActive: true } });
    expect(await currentCrmLoginFor(row.id, row.sessionVersion)).not.toBeNull();
  });
});

describe("saveCrmLogin", () => {
  it("is one login per person: saving again edits it", async () => {
    const { person, row } = await makeLogin();
    const again = await saveCrmLogin(person.id, { username: "michael", role: "admin" });
    expect(again.id).toBe(row.id);
    expect(again.role).toBe("admin");
    expect(await prisma.crmLogin.count()).toBe(1);
  });

  it("refuses a short password and one over 72 bytes, with 400", async () => {
    const person = await makePerson();
    const short = await saveCrmLogin(person.id, { username: "michael", role: "owner", password: "short" }).catch((e) => e);
    expect(short).toBeInstanceOf(CrmLoginError);
    expect(short.statusCode).toBe(400);
    const long = await saveCrmLogin(person.id, { username: "michael", role: "owner", password: "x".repeat(73) }).catch((e) => e);
    expect(long).toBeInstanceOf(CrmLoginError);
    expect(long.statusCode).toBe(400);
    // 24 four-byte characters is 24 characters but 96 bytes.
    const multibyte = await saveCrmLogin(person.id, { username: "michael", role: "owner", password: "\u{1F600}".repeat(24) }).catch((e) => e);
    expect(multibyte.statusCode).toBe(400);
    expect(await prisma.crmLogin.count()).toBe(0);
    // Exactly 72 bytes is fine.
    expect((await saveCrmLogin(person.id, { username: "michael", role: "owner", password: "x".repeat(72) })).username).toBe("michael");
  });

  it("refuses an unknown role, a short or control-character username, and a person who does not exist", async () => {
    const person = await makePerson();
    const bad = async (input: { username: string; role: string }, id = person.id): Promise<{ statusCode?: number }> => {
      try {
        await saveCrmLogin(id, input);
        return {};
      } catch (e) {
        return e as CrmLoginError;
      }
    };
    expect((await bad({ username: "michael", role: "superuser" })).statusCode).toBe(400);
    expect((await bad({ username: "ab", role: "owner" })).statusCode).toBe(400);
    expect((await bad({ username: "a\u0000bcd", role: "owner" })).statusCode).toBe(400);
    expect((await bad({ username: "michael", role: "owner" }, "no-such-person")).statusCode).toBe(404);
  });

  it("refuses with 409 a username the AI admin holds, case-insensitively", async () => {
    await saveAdminLogin("Grok-Admin", PASS);
    const person = await makePerson();
    const err = await saveCrmLogin(person.id, { username: "grok-ADMIN", role: "owner" }).catch((e) => e);
    expect(err).toBeInstanceOf(CrmLoginError);
    expect(err.statusCode).toBe(409);
    expect(await prisma.crmLogin.count()).toBe(0);
  });

  it("refuses with 409 a username another person's login holds, case-insensitively", async () => {
    await makeLogin("Michael");
    const other = await makePerson();
    const err = await saveCrmLogin(other.id, { username: "michael", role: "office" }).catch((e) => e);
    expect(err.statusCode).toBe(409);
    // Re-saving your own login under your own name is not a collision.
    const mine = await prisma.crmLogin.findFirstOrThrow();
    expect((await saveCrmLogin(mine.technicianId, { username: "MICHAEL", role: "owner" })).username).toBe("MICHAEL");
  });

  it("compares usernames literally: _ and % are not wildcards in the collision checks", async () => {
    await saveAdminLogin("grok_admin", PASS);
    const person = await makePerson();
    // grokXadmin would match grok_admin if the underscore were a wildcard.
    expect((await saveCrmLogin(person.id, { username: "grokXadmin", role: "owner" })).username).toBe("grokXadmin");
    const other = await makePerson();
    expect((await saveCrmLogin(other.id, { username: "grok%", role: "office" })).username).toBe("grok%");
    // The AI admin side too: "grokXadmin" is a person's login, so "grok_admin" is not blocked by it.
    expect((await saveAdminLogin("grok_admin", PASS)).username).toBe("grok_admin");
  });

  it("the reverse: saving an AI admin username that is a person's login is refused", async () => {
    await makeLogin("Michael");
    const err = await saveAdminLogin("michael", PASS).catch((e) => e);
    expect(err).toBeInstanceOf(UsernameTakenError);
    expect(err.statusCode).toBe(409);
    expect(await prisma.adminLogin.count()).toBe(0);
    // An unrelated name is still fine.
    expect((await saveAdminLogin("grok-admin", PASS)).username).toBe("grok-admin");
  });
});

describe("setPowers", () => {
  it("replaces the list, in the shared order, with repeats collapsed", async () => {
    const { row } = await makeLogin();
    const set = await setPowers(row.id, ["treasury", "approve_drafts", "treasury", "price_book_edit"]);
    expect(set?.powers).toEqual(["price_book_edit", "treasury", "approve_drafts"]);
    expect((await setPowers(row.id, []))?.powers).toEqual([]);
  });

  it("refuses a key that is not a power, and changes nothing", async () => {
    const { row } = await makeLogin();
    await setPowers(row.id, ["treasury"]);
    const err = await setPowers(row.id, ["treasury", "owner"]).catch((e) => e);
    expect(err).toBeInstanceOf(CrmLoginError);
    expect(err.statusCode).toBe(400);
    expect((await prisma.crmLogin.findUniqueOrThrow({ where: { id: row.id } })).powers).toEqual(["treasury"]);
    expect(await setPowers("no-such-id", ["treasury"])).toBeNull();
  });

  it("a power change shows on the very next read, with no version bump", async () => {
    const { row } = await makeLogin();
    await setPowers(row.id, ["bot_keys"]);
    const read = await currentCrmLoginFor(row.id, row.sessionVersion);
    expect(read?.powers).toEqual(["bot_keys"]);
  });
});

describe("setPrincipal", () => {
  it("leaves exactly one principal row", async () => {
    const a = await makeLogin("kyle-one");
    const b = await makeLogin("michael");
    await setPrincipal(a.row.id);
    expect(await prisma.crmLogin.count({ where: { isPrincipal: true } })).toBe(1);
    await setPrincipal(b.row.id);
    const principals = await prisma.crmLogin.findMany({ where: { isPrincipal: true } });
    expect(principals.map((p) => p.id)).toEqual([b.row.id]);
    expect(await setPrincipal("no-such-id")).toBeNull();
    expect((await prisma.crmLogin.findUniqueOrThrow({ where: { id: b.row.id } })).isPrincipal).toBe(true);
  });

  it("two concurrent calls still leave exactly one", async () => {
    const a = await makeLogin("kyle-one");
    const b = await makeLogin("michael");
    await Promise.all([setPrincipal(a.row.id), setPrincipal(b.row.id)]);
    expect(await prisma.crmLogin.count({ where: { isPrincipal: true } })).toBe(1);
  });
});
