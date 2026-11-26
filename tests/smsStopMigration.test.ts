/**
 * The data migration 20261126100000_sms_stop_only (Kyle 2026-11-26: "REMOVE THE SMS CONSENT GATE COMPLETELY ... Keep STOP handling only").
 * Run against real rows in the test database: every Customer and Lead with smsConsent false goes to null UNLESS the latest opt keyword the
 * CRM logged for that phone number (InboundMessage.handledAs opt_out / opt_in, matched on the last 10 digits whatever the stored format) is
 * 'opt_out'. A true, a null and a STOP are left as they are, and a second run changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/prisma";

const TAG = "SmsStopMig";

async function wipe() {
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.inboundMessage.deleteMany({ where: { body: { startsWith: TAG } } });
}
beforeAll(wipe);
afterAll(wipe);

const inbound = (fromPhone: string, handledAs: string, at: string) =>
  prisma.inboundMessage.create({ data: { fromPhone, body: `${TAG} ${handledAs}`, matchType: "customer", handledAs, createdAt: new Date(at) } });

describe("migration 20261126100000_sms_stop_only (data only)", () => {
  it("nulls a false that was never a STOP, keeps a real STOP (any stored phone format), and is idempotent", async () => {
    const sql = readFileSync(join(__dirname, "..", "prisma", "migrations", "20261126100000_sms_stop_only", "migration.sql"), "utf8");
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|ALTER|DELETE|INSERT)\b/i);
    const statements = code.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(2);
    // The real statements, run only over this test's own rows: the test database is shared, and the other suites keep STOP rows of their own.
    const scoped = statements.map((s) => {
      expect(s).toContain('WHERE "smsConsent" = false');
      return s.replace('WHERE "smsConsent" = false', `WHERE "smsConsent" = false AND "name" LIKE '${TAG}%'`);
    });

    // A declined website box: false, no STOP on record -> null.
    const declinedWeb = await prisma.customer.create({ data: { name: `${TAG} declined web`, phone: "6155550101", smsConsent: false } });
    const declinedLead = await prisma.lead.create({ data: { name: `${TAG} declined lead`, phone: "(615) 555-0102", smsConsent: false } });
    const noPhone = await prisma.lead.create({ data: { name: `${TAG} no phone`, phone: null, smsConsent: false } });
    // A real STOP, logged in a different format than the row stores: stays false.
    const stopped = await prisma.customer.create({ data: { name: `${TAG} stopped`, phone: "(615) 555-0103", smsConsent: false } });
    await inbound("+16155550103", "opt_out", "2026-11-01T10:00:00Z");
    const stoppedLead = await prisma.lead.create({ data: { name: `${TAG} stopped lead`, phone: "615-555-0104", smsConsent: false } });
    await inbound("+16155550104", "opt_out", "2026-11-01T10:00:00Z");
    // A STOP that was followed by a START: the latest keyword is opt_in -> null.
    const restarted = await prisma.customer.create({ data: { name: `${TAG} restarted`, phone: "6155550105", smsConsent: false } });
    await inbound("+16155550105", "opt_out", "2026-11-01T10:00:00Z");
    await inbound("+16155550105", "opt_in", "2026-11-02T10:00:00Z");
    // A START and then a later STOP -> stays false.
    const stoppedAgain = await prisma.customer.create({ data: { name: `${TAG} stopped again`, phone: "6155550106", smsConsent: false } });
    await inbound("+16155550106", "opt_in", "2026-11-01T10:00:00Z");
    await inbound("+16155550106", "opt_out", "2026-11-02T10:00:00Z");
    // true and null are never touched.
    const ticked = await prisma.customer.create({ data: { name: `${TAG} ticked`, phone: "6155550107", smsConsent: true } });
    const never = await prisma.lead.create({ data: { name: `${TAG} never`, phone: "6155550108", smsConsent: null } });

    for (let run = 0; run < 2; run += 1) {
      for (const s of scoped) await prisma.$executeRawUnsafe(s);
      const c = async (id: string) => (await prisma.customer.findUniqueOrThrow({ where: { id } })).smsConsent;
      const l = async (id: string) => (await prisma.lead.findUniqueOrThrow({ where: { id } })).smsConsent;
      expect(await c(declinedWeb.id)).toBeNull();
      expect(await l(declinedLead.id)).toBeNull();
      expect(await l(noPhone.id)).toBeNull();
      expect(await c(stopped.id)).toBe(false);
      expect(await l(stoppedLead.id)).toBe(false);
      expect(await c(restarted.id)).toBeNull();
      expect(await c(stoppedAgain.id)).toBe(false);
      expect(await c(ticked.id)).toBe(true);
      expect(await l(never.id)).toBeNull();
    }
  });
});
