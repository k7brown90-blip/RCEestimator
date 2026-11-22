/**
 * A PERSON's CRM sign-in (work order agent-team, unit HA1). Mirrors services/adminLogin.ts function
 * for function: the same bcrypt cost, the same password limits (IMPORTED from there, never copied),
 * the same rule that every write either bumps `sessionVersion` or deletes the row, so the session
 * gate (middleware/pinAuth.ts) refuses the person's existing token on its very next request. There is
 * deliberately NO cache between the gate and this table.
 *
 * One login per person (`technicianId` is unique; the person id everywhere is Technician.id). The
 * login carries a role (owner | admin | office | tech) that decides which screens open, and a
 * `powers` list of Kyle-only powers (shared/crmPowers.ts) that Kyle grants. The role never grants a
 * power. `isPrincipal` marks Kyle's own login: it holds every power, and the PIN session resolves
 * its display name from it. Exactly one row may carry it - enforced in `setPrincipal`'s transaction,
 * not by a partial unique index.
 *
 * The AI admin's AdminLogin table is separate. A username may not exist in both (compared
 * case-insensitively): the door checks AdminLogin first, so a shared name would shadow the person.
 * The other direction is refused in saveAdminLogin.
 *
 * Every write to CrmLogin lives in this file. Callers pass `db` so tests can use their own client.
 */
import bcrypt from "bcryptjs";
import type { CrmLogin, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { ADMIN_PASSWORD_MAX_BYTES, ADMIN_PASSWORD_MIN } from "./adminLogin";
import { logSystemEvent } from "./systemEvents";
import { CRM_POWER_KEYS, isCrmPower, isCrmRole, type CrmPower, type CrmRole } from "../../shared/crmPowers";

/** The JWT `sub` prefix for a person's session: `user:<login id>`. Kyle's PIN session is "owner". */
export const CRM_USER_SUB_PREFIX = "user:";

export const CRM_USERNAME_MIN = 3;
export const CRM_USERNAME_MAX = 100;

/** A refusal the route can show as-is. `statusCode` is the HTTP status it should be answered with. */
export class CrmLoginError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409) {
    super(message);
    this.name = "CrmLoginError";
  }
}

/** A login row with the roster person it belongs to. */
export type CrmLoginWithPerson = CrmLogin & { technician: { id: string; name: string; isActive: boolean } };

const WITH_PERSON = { technician: { select: { id: true, name: true, isActive: true } } } as const;

export interface CrmLoginView {
  id: string;
  technicianId: string;
  /** The roster person's name. */
  name: string;
  username: string;
  role: string;
  isPrincipal: boolean;
  powers: string[];
  enabled: boolean;
  /** True when a password is set. The hash itself is never returned. */
  hasPassword: boolean;
  /** The roster person is still active; an inactive person cannot sign in. */
  personActive: boolean;
  updatedAt: string;
}

/** What the Team card may see. NEVER the hash. */
export function toCrmLoginView(row: CrmLoginWithPerson): CrmLoginView {
  return {
    id: row.id,
    technicianId: row.technicianId,
    name: row.technician.name,
    username: row.username,
    role: row.role,
    isPrincipal: row.isPrincipal,
    powers: [...row.powers],
    enabled: row.enabled,
    hasPassword: row.passwordHash !== null,
    personActive: row.technician.isActive,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCrmLogins(db: PrismaClient = defaultPrisma): Promise<CrmLoginWithPerson[]> {
  return db.crmLogin.findMany({ include: WITH_PERSON, orderBy: { createdAt: "asc" } });
}

/**
 * The row a "user:" token must still match: same row (`lid`), still turned on, same
 * `sessionVersion` (`ver`), and the roster person still active. Returns null when any of that is
 * false. The gate calls this on every "user:" request, and reads role and powers from the row it
 * returns - never from the token.
 */
export async function currentCrmLoginFor(
  lid: unknown,
  ver: unknown,
  db: PrismaClient = defaultPrisma,
): Promise<CrmLoginWithPerson | null> {
  if (typeof lid !== "string" || typeof ver !== "number") return null;
  const row = await db.crmLogin.findUnique({ where: { id: lid }, include: WITH_PERSON });
  if (!row || !row.enabled || row.sessionVersion !== ver || !row.technician.isActive) return null;
  // A tech-role login has no CRM sign-in yet (work order default). Checked here, on every request,
  // so it also ends a session whose role was changed to tech while it was open.
  if (row.role === "tech") return null;
  return row;
}

/**
 * The login whose username equals this one, ignoring case - and ONLY ignoring case. Prisma's
 * `mode: "insensitive"` compiles to ILIKE, which reads % and _ in the typed name as wildcards (a
 * sign-in of "%" would match the first login), so this compares lower(username) instead.
 *
 * It is exactly ONE parameterised query, hit or miss: the login joined to its roster person. The
 * sign-in door (pinAuth.ts handleAdminLogin) relies on that - a second round trip for a hit would
 * let the response time say which usernames exist.
 */
export async function findCrmLoginByUsername(
  username: string,
  db: PrismaClient = defaultPrisma,
): Promise<CrmLoginWithPerson | null> {
  const rows = await db.$queryRaw<Array<CrmLogin & { personName: string; personActive: boolean }>>`
    SELECT c."id", c."technicianId", c."username", c."passwordHash", c."role", c."isPrincipal",
           c."powers", c."enabled", c."sessionVersion", c."createdAt", c."updatedAt",
           t."name" AS "personName", t."isActive" AS "personActive"
    FROM "CrmLogin" c
    JOIN "Technician" t ON t."id" = c."technicianId"
    WHERE lower(c."username") = lower(${username})
    ORDER BY c."createdAt" ASC
    LIMIT 1`;
  if (rows.length === 0) return null;
  const { personName, personActive, ...login } = rows[0];
  return { ...login, technician: { id: login.technicianId, name: personName, isActive: personActive } };
}

/** The login of one roster person (the Team dialog addresses a login by person). */
export async function getCrmLoginForPerson(technicianId: string, db: PrismaClient = defaultPrisma): Promise<CrmLoginWithPerson | null> {
  return db.crmLogin.findUnique({ where: { technicianId }, include: WITH_PERSON });
}

/** The CRM login marked as Kyle's own, if there is one. */
export async function getPrincipalLogin(db: PrismaClient = defaultPrisma): Promise<CrmLoginWithPerson | null> {
  return db.crmLogin.findFirst({ where: { isPrincipal: true }, include: WITH_PERSON, orderBy: { createdAt: "asc" } });
}

function checkUsername(raw: string): string {
  const username = raw.trim();
  if (username.length < CRM_USERNAME_MIN) throw new CrmLoginError(`Username must be at least ${CRM_USERNAME_MIN} characters`, 400);
  if (username.length > CRM_USERNAME_MAX) throw new CrmLoginError("Username is too long", 400);
  // A control character (a NUL above all) is never a saved username: Postgres refuses it in a text
  // parameter, and the sign-in door treats one as a plain miss.
  if (/[\u0000-\u001f\u007f]/.test(username)) throw new CrmLoginError("Username has a character that is not allowed", 400);
  return username;
}

function checkPassword(password: string): void {
  if (password.length < ADMIN_PASSWORD_MIN) {
    throw new CrmLoginError(`Password must be at least ${ADMIN_PASSWORD_MIN} characters`, 400);
  }
  if (Buffer.byteLength(password, "utf8") > ADMIN_PASSWORD_MAX_BYTES) {
    throw new CrmLoginError(`Password is too long (max ${ADMIN_PASSWORD_MAX_BYTES} bytes)`, 400);
  }
}

export interface SaveCrmLoginInput {
  username: string;
  role: string;
  /** Omit to leave the password as it is (or unset, on a new login). */
  password?: string;
}

/**
 * Create the person's login, or edit it. A password change bumps `sessionVersion`, which signs the
 * person out. A role or username change does not (the gate reads the role from the row on every
 * request, so it takes effect at once). On an existing login the enabled flag, powers and principal
 * mark are left alone - they have their own functions.
 *
 * 409 when the username (case-insensitive) is the AI admin's or another person's login.
 */
export async function saveCrmLogin(
  technicianId: string,
  input: SaveCrmLoginInput,
  db: PrismaClient = defaultPrisma,
): Promise<CrmLoginWithPerson> {
  const username = checkUsername(input.username);
  if (!isCrmRole(input.role)) throw new CrmLoginError("Role must be owner, admin, office or tech", 400);
  const role: CrmRole = input.role;
  if (input.password !== undefined) checkPassword(input.password);

  const person = await db.technician.findUnique({ where: { id: technicianId }, select: { id: true } });
  if (!person) throw new CrmLoginError("That team member does not exist", 404);

  const aiAdmin = await db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AdminLogin" WHERE lower("username") = lower(${username}) LIMIT 1`;
  if (aiAdmin.length > 0) throw new CrmLoginError("That username belongs to the AI admin login. Pick a different one.", 409);

  const existing = await db.crmLogin.findUnique({ where: { technicianId } });
  const sameName = await findCrmLoginByUsername(username, db);
  if (sameName && sameName.id !== existing?.id) throw new CrmLoginError("That username is already another person's login. Pick a different one.", 409);

  const passwordHash = input.password !== undefined ? await bcrypt.hash(input.password, 10) : undefined;
  if (!existing) {
    return db.crmLogin.create({
      data: { technicianId, username, role, passwordHash: passwordHash ?? null },
      include: WITH_PERSON,
    });
  }
  return db.crmLogin.update({
    where: { id: existing.id },
    data: {
      username,
      role,
      ...(passwordHash !== undefined ? { passwordHash, sessionVersion: { increment: 1 } } : {}),
    },
    include: WITH_PERSON,
  });
}

/** Turn off (bumps the version, ending the session) or on. Null when no such login. */
export async function setCrmLoginEnabled(
  loginId: string,
  enabled: boolean,
  db: PrismaClient = defaultPrisma,
): Promise<CrmLoginWithPerson | null> {
  const existing = await db.crmLogin.findUnique({ where: { id: loginId }, select: { id: true } });
  if (!existing) return null;
  return db.crmLogin.update({
    where: { id: loginId },
    data: enabled ? { enabled: true } : { enabled: false, sessionVersion: { increment: 1 } },
    include: WITH_PERSON,
  });
}

/** Remove the login. The row is gone, so its tokens fail the `lid` lookup. False when none existed. */
export async function removeCrmLogin(loginId: string, db: PrismaClient = defaultPrisma): Promise<boolean> {
  const { count } = await db.crmLogin.deleteMany({ where: { id: loginId } });
  return count > 0;
}

/**
 * Replace the login's Kyle-only powers with exactly this list (unknown keys are refused, repeats
 * are collapsed). Takes effect on the person's next request - the gate reads `powers` from the row.
 * Writes a system-event line saying who now holds what. Null when no such login.
 */
export async function setPowers(
  loginId: string,
  powers: readonly string[],
  db: PrismaClient = defaultPrisma,
): Promise<CrmLoginWithPerson | null> {
  const unknown = powers.filter((p) => !isCrmPower(p));
  if (unknown.length > 0) throw new CrmLoginError(`Unknown power: ${unknown.join(", ")}`, 400);
  const wanted = CRM_POWER_KEYS.filter((k) => powers.includes(k));
  const existing = await db.crmLogin.findUnique({ where: { id: loginId }, select: { id: true } });
  if (!existing) return null;
  const row = await db.crmLogin.update({ where: { id: loginId }, data: { powers: wanted }, include: WITH_PERSON });
  logSystemEvent("info", "crm-login", `Powers for ${row.technician.name} (${row.username}) set to: ${wanted.join(", ") || "none"}`, {
    crmLoginId: row.id, technicianId: row.technicianId, powers: wanted,
  });
  return row;
}

/** Arbitrary constant naming the "one principal" advisory lock. */
const PRINCIPAL_LOCK_KEY = 7_340_001;

/**
 * Mark this login as Kyle's own and clear the mark on every other row, in ONE transaction, so there
 * is never a moment with two and a failure leaves the old one in place. Null when no such login.
 */
export async function setPrincipal(loginId: string, db: PrismaClient = defaultPrisma): Promise<CrmLoginWithPerson | null> {
  const existing = await db.crmLogin.findUnique({ where: { id: loginId }, select: { id: true } });
  if (!existing) return null;
  const row = await db.$transaction(async (tx) => {
    // Serialise concurrent callers: under read-committed two transactions could each clear the
    // other's mark and both end up principal. The lock is released when the transaction ends.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PRINCIPAL_LOCK_KEY})`;
    await tx.crmLogin.updateMany({ where: { isPrincipal: true, id: { not: loginId } }, data: { isPrincipal: false } });
    return tx.crmLogin.update({ where: { id: loginId }, data: { isPrincipal: true }, include: WITH_PERSON });
  });
  logSystemEvent("info", "crm-login", `${row.technician.name} (${row.username}) is now the principal CRM login`, {
    crmLoginId: row.id, technicianId: row.technicianId,
  });
  return row;
}

/** Take the "this is Kyle" mark off a login. Null when no such login; no-op when it was not marked. */
export async function clearPrincipal(loginId: string, db: PrismaClient = defaultPrisma): Promise<CrmLoginWithPerson | null> {
  const existing = await db.crmLogin.findUnique({ where: { id: loginId }, select: { id: true } });
  if (!existing) return null;
  const row = await db.crmLogin.update({ where: { id: loginId }, data: { isPrincipal: false }, include: WITH_PERSON });
  logSystemEvent("info", "crm-login", `${row.technician.name} (${row.username}) is no longer the principal CRM login`, {
    crmLoginId: row.id, technicianId: row.technicianId,
  });
  return row;
}

/** Every power key, for a principal login or the PIN session. */
export const ALL_POWERS: readonly CrmPower[] = CRM_POWER_KEYS;
