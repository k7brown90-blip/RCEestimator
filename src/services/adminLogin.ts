/**
 * The AI admin's own sign-in (Kyle, 2026-11-15: "Lets do a username and password so it can save it
 * and login on its own"; "Its own login"). One row in AdminLogin, managed from Settings -> "AI admin
 * login". The PIN is untouched and keeps issuing the "owner" session.
 *
 * Every write to the row lives in this file (save, turn off / on, remove), and each of them either
 * bumps `sessionVersion` or deletes the row, so the session gate (middleware/pinAuth.ts) refuses
 * the AI admin's existing token on its very next request. There is deliberately NO cache between
 * the gate and this table: revoking must not wait for a TTL, and the table has one row.
 */
import bcrypt from "bcryptjs";
import type { AdminLogin, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";

/** The JWT `sub` for the AI admin's session. Kyle's PIN session is "owner". */
export const AI_ADMIN_SUB = "ai-admin";

export const ADMIN_PASSWORD_MIN = 12;
/** bcrypt only reads the first 72 bytes; refuse longer than that rather than silently truncate. */
export const ADMIN_PASSWORD_MAX_BYTES = 72;

/**
 * The AI admin's username may not be the same as a person's CRM login (work order agent-team, HA1:
 * "AI admin username may not collide with a person's login"). The sign-in door checks AdminLogin
 * first, so a shared name would silently shadow the person. Compared case-insensitively. The route
 * answers this with 409.
 */
export class UsernameTakenError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "UsernameTakenError";
  }
}

export interface AdminLoginView {
  configured: boolean;
  username: string | null;
  enabled: boolean;
  updatedAt: string | null;
}

/** What the Settings card may see. NEVER the hash. */
export function toAdminLoginView(row: AdminLogin | null): AdminLoginView {
  if (!row) return { configured: false, username: null, enabled: false, updatedAt: null };
  return { configured: true, username: row.username, enabled: row.enabled, updatedAt: row.updatedAt.toISOString() };
}

export async function getAdminLogin(db: PrismaClient = defaultPrisma): Promise<AdminLogin | null> {
  return db.adminLogin.findFirst({ orderBy: { createdAt: "asc" } });
}

/**
 * The row that an "ai-admin" token must still match: same row (`aid`), still turned on, same
 * `sessionVersion` (`ver`). Returns null when any of that is false. The gate calls this on every
 * ai-admin request; `owner` sessions never reach it.
 */
export async function currentAdminLoginFor(
  aid: unknown,
  ver: unknown,
  db: PrismaClient = defaultPrisma,
): Promise<AdminLogin | null> {
  if (typeof aid !== "string" || typeof ver !== "number") return null;
  const row = await db.adminLogin.findUnique({ where: { id: aid } });
  if (!row || !row.enabled || row.sessionVersion !== ver) return null;
  return row;
}

/**
 * Create the login, or replace it (username and password) if one exists. There is only ever one
 * row. Replacing bumps `sessionVersion`, which signs the AI admin out; a replace leaves On/Off as
 * it was, so changing the password of a login that is turned off does not quietly turn it on.
 */
export async function saveAdminLogin(
  username: string,
  password: string,
  db: PrismaClient = defaultPrisma,
): Promise<AdminLogin> {
  // lower() = lower(), not Prisma's ILIKE-based insensitive mode, which would read _ and % as wildcards.
  const taken = await db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "CrmLogin" WHERE lower("username") = lower(${username}) LIMIT 1`;
  if (taken.length > 0) {
    throw new UsernameTakenError("That username is already a person's CRM login. Pick a different one for the AI admin.");
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const existing = await getAdminLogin(db);
  if (!existing) {
    return db.adminLogin.create({ data: { username, passwordHash } });
  }
  return db.adminLogin.update({
    where: { id: existing.id },
    data: { username, passwordHash, sessionVersion: { increment: 1 } },
  });
}

/** Turn off (bumps the version, ending its session) or on. Null when no login exists. */
export async function setAdminLoginEnabled(
  enabled: boolean,
  db: PrismaClient = defaultPrisma,
): Promise<AdminLogin | null> {
  const existing = await getAdminLogin(db);
  if (!existing) return null;
  return db.adminLogin.update({
    where: { id: existing.id },
    data: enabled ? { enabled: true } : { enabled: false, sessionVersion: { increment: 1 } },
  });
}

/** Remove the login. The row is gone, so its tokens fail the `aid` lookup. False when none existed. */
export async function removeAdminLogin(db: PrismaClient = defaultPrisma): Promise<boolean> {
  const existing = await getAdminLogin(db);
  if (!existing) return false;
  await db.adminLogin.delete({ where: { id: existing.id } });
  return true;
}
