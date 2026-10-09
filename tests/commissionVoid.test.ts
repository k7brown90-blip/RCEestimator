/**
 * Void a recorded commission (2026-10-09, one-estimating-system plan, Phase 6 CARRY).
 *
 * Commission rows used to be HARD-DELETED by the CRM "Remove…" button. A commission is money (the
 * P&L's payroll line, a tech's pay week), so the exit is void-with-reason: the row is kept, marked,
 * and no longer counts anywhere.
 *
 * What these pin:
 *   1. A reason is required (and bounded); nothing is written without one.
 *   2. The row is KEPT — voidedAt/voidedBy/voidReason — and a SystemEvent names the commission.
 *   3. EVERY reader excludes a voided row: the P&L payroll line and its CSV, the Team week's
 *      commissions total / total pay / rows, and the duplicate check in POST /time/commissions.
 *      GET /time/commissions (the job card's list) still LISTS it, marked, on purpose.
 *   4. Two voids racing each other: exactly one lands, the other is told 409, the first reason stands.
 *   5. "Record commission" works again after a void; it is still refused while a live one stands.
 *   6. A commission already paid out (paidAt set) is refused.
 *   7. The old DELETE answers 410 and removes nothing.
 *   8. There is NO technician route — the tech router is walked, not trusted.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import { CommissionVoidError, voidCommission } from "../src/services/commissionVoid";
import { payrollForYear } from "../src/services/payrollLedger";
import { payrollForWeek, weekOf } from "../src/services/timeTracking";

delete process.env.STRIPE_SECRET_KEY;
vi.mock("stripe", () => ({ default: class MockStripe { constructor() { throw new Error("Stripe must not be constructed in tests"); } } }));
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials() {}
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }) },
        events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }) },
      }),
    },
  };
});
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { healthRecordTechRouter } from "../src/routes/health-record";

const MARK = "CMV";
/** A year no other test records money in — the P&L assertions sum the whole year. */
const YEAR = 2036;
const EARNED = new Date(YEAR, 5, 10, 12, 0, 0); // Wednesday, June 10 2036

let customerId: string;
let propertyId: string;
let technicianId: string;
let techToken: string;

const cleanup = async () => {
  await prisma.commission.deleteMany({ where: { technician: { name: `${MARK} Tech` } } });
  await prisma.visitAssignment.deleteMany({ where: { visit: { purpose: `${MARK} visit` } } });
  await prisma.visit.deleteMany({ where: { purpose: `${MARK} visit` } });
  await prisma.property.deleteMany({ where: { name: `${MARK} property` } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: `${MARK} Customer` } } });
  await prisma.technician.deleteMany({ where: { name: `${MARK} Tech` } });
  if (technicianId) await prisma.systemEvent.deleteMany({ where: { source: "time", detailsJson: { contains: technicianId } } });
};

const settle = () => new Promise((r) => setTimeout(r, 200)); // fire-and-forget writes land
const voidIt = (id: string, reason?: string) => request(app).post(`/time/commissions/${id}/void`).send(reason === undefined ? {} : { reason });
const manual = (amount: number, extra: Record<string, unknown> = {}) =>
  prisma.commission.create({ data: { technicianId, basis: "manual", amount, earnedAt: EARNED, note: `${MARK} manual`, ...extra } });

type Summary = {
  totals: { payroll: number };
  expensesByCategory: { category: string; monthly: number[]; total: number }[];
};
const summary = async (): Promise<Summary> => {
  const res = await request(app).get(`/financials/summary?year=${YEAR}`);
  expect(res.status).toBe(200);
  return res.body as Summary;
};
const commissionCategory = (s: Summary) => s.expensesByCategory.find((c) => c.category === "payroll:commissions")?.total ?? 0;

beforeAll(async () => {
  await cleanup();
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "cmv-customer@example.com" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} property`, addressLine1: "9 Void Lane", city: "Hermitage", state: "TN", postalCode: "37076" },
  });
  propertyId = property.id;
  const tech = await prisma.technician.create({
    data: { name: `${MARK} Tech`, accessToken: `cmv-tech-${customer.id}`, role: "admin", hourlyRate: 30, commissionPercent: 10 },
  });
  technicianId = tech.id;
  techToken = tech.accessToken;
});

afterAll(cleanup);

// ─── 1. A reason is required ─────────────────────────────────────────────────

describe("voiding takes a reason", () => {
  it("refuses a missing, blank or over-long reason, and writes nothing", async () => {
    const c = await manual(40);
    for (const reason of [undefined, "", "   "]) {
      const res = await voidIt(c.id, reason);
      expect(res.status, JSON.stringify(reason)).toBe(400);
      expect(res.body.error).toMatch(/say why/i);
    }
    const tooLong = await voidIt(c.id, "x".repeat(301));
    expect(tooLong.status).toBe(400);
    expect((await prisma.commission.findUniqueOrThrow({ where: { id: c.id } })).voidedAt).toBeNull();
  });

  it("answers 404 for a commission that does not exist", async () => {
    const res = await voidIt("no-such-commission", "Wrong job");
    expect(res.status).toBe(404);
  });
});

// ─── 2. The row is kept, marked, and audited ─────────────────────────────────

describe("a void keeps the row", () => {
  it("marks voidedAt / voidedBy / voidReason, keeps the amount, and writes a SystemEvent", async () => {
    const c = await manual(55);
    const res = await voidIt(c.id, "  Entered on the wrong job  ");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: c.id, amount: 55, voidReason: "Entered on the wrong job", voidedBy: "human:crm-session" });

    const row = await prisma.commission.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.voidedAt).toBeInstanceOf(Date);
    expect(row.voidReason).toBe("Entered on the wrong job");
    expect(row.voidedBy).toBe("human:crm-session");
    expect(row.amount).toBe(55); // the money is still on the row — only its standing changed

    await settle();
    const sys = await prisma.systemEvent.findFirst({
      where: { source: "time", message: { contains: "Commission of $55.00 voided — Entered on the wrong job" } },
      orderBy: { createdAt: "desc" },
    });
    expect(sys).toBeTruthy();
  });

  it("the job card's list (GET /time/commissions?visitId=) still lists the voided row, marked", async () => {
    const visit = await prisma.visit.create({ data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${MARK} visit`, status: "completed" } });
    const c = await manual(12, { visitId: visit.id });
    await voidIt(c.id, "Duplicate");
    const list = await request(app).get(`/time/commissions?visitId=${visit.id}`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: c.id, voidReason: "Duplicate", voidedBy: "human:crm-session" });
    expect(typeof list.body[0].voidedAt).toBe("string");
  });
});

// ─── 3. Every reader excludes a voided row ───────────────────────────────────

describe("every reader of Commission excludes a voided row", () => {
  it("the P&L payroll line, its CSV, the year ledger and the Team week all drop it — and take it back out only once", async () => {
    const baseline = await summary();
    const baseYear = await payrollForYear(YEAR);
    const week = weekOf(EARNED);
    const baseWeek = await payrollForWeek(technicianId, week.start);

    const live = await manual(30.03);
    const doomed = await manual(70.07);

    // Before the void both count.
    let s = await summary();
    expect(Math.round((commissionCategory(s) - commissionCategory(baseline)) * 100) / 100).toBe(100.1);
    expect((await payrollForYear(YEAR)).commissionRows.filter((r) => r.technicianId === technicianId)).toHaveLength(
      baseYear.commissionRows.filter((r) => r.technicianId === technicianId).length + 2,
    );
    let w = await payrollForWeek(technicianId, week.start);
    expect(Math.round((w.commissions - baseWeek.commissions) * 100) / 100).toBe(100.1);

    expect((await voidIt(doomed.id, "Paid in cash outside the app")).status).toBe(200);

    // P&L: only the live one is left.
    s = await summary();
    expect(Math.round((commissionCategory(s) - commissionCategory(baseline)) * 100) / 100).toBe(30.03);
    expect(Math.round((s.totals.payroll - baseline.totals.payroll) * 100) / 100).toBe(30.03);
    // The tax-year CSV has no line for the voided one.
    const csv = await request(app).get(`/financials/export?year=${YEAR}`).expect(200);
    const lines = (csv.text as string).split("\n").filter((l) => l.includes(",expense,payroll:commissions,") && l.includes("CMV Tech"));
    expect(lines.some((l) => l.includes("30.03"))).toBe(true);
    expect(lines.some((l) => l.includes("70.07"))).toBe(false);

    // The year ledger and the Team week agree.
    const year = await payrollForYear(YEAR);
    const mine = year.commissionRows.filter((r) => r.technicianId === technicianId);
    expect(mine.map((r) => r.amount)).not.toContain(70.07);
    expect(mine.map((r) => r.amount)).toContain(30.03);
    w = await payrollForWeek(technicianId, week.start);
    expect(Math.round((w.commissions - baseWeek.commissions) * 100) / 100).toBe(30.03);
    expect(Math.round((w.total - baseWeek.total) * 100) / 100).toBe(30.03);
    expect(w.commissionRows.map((r) => r.id)).toContain(live.id);
    expect(w.commissionRows.map((r) => r.id)).not.toContain(doomed.id);
  });
});

// ─── 4. Two voids racing each other ──────────────────────────────────────────

describe("a double void", () => {
  it("a second void of the same row is refused with 409 and keeps the first reason", async () => {
    const c = await manual(20);
    expect((await voidIt(c.id, "First reason")).status).toBe(200);
    const again = await voidIt(c.id, "Second reason");
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already voided/);
    expect(again.body.error).toContain("First reason");
    expect((await prisma.commission.findUniqueOrThrow({ where: { id: c.id } })).voidReason).toBe("First reason");
  });

  it("two voids racing each other: exactly one lands, the other is a 409, and the winner's reason stands", async () => {
    const c = await manual(25);
    const results = await Promise.allSettled([
      voidCommission(prisma, c.id, "Racer A"),
      voidCommission(prisma, c.id, "Racer B"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBeInstanceOf(CommissionVoidError);
    expect(bad[0].reason.statusCode).toBe(409);
    const row = await prisma.commission.findUniqueOrThrow({ where: { id: c.id } });
    expect(["Racer A", "Racer B"]).toContain(row.voidReason);
    expect(row.voidReason).toBe((ok[0] as PromiseFulfilledResult<{ voidReason: string }>).value.voidReason);
  });
});

// ─── 5. Re-record after a void ───────────────────────────────────────────────

describe("recording again after a void", () => {
  it("is refused while a live job-profit commission stands, and allowed once it is voided", async () => {
    const visit = await prisma.visit.create({
      data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${MARK} visit`, status: "completed", revenue: 1000 },
    });
    await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId } });
    const post = () => request(app).post("/time/commissions").send({ technicianId, visitId: visit.id, basis: "job_profit" });

    const first = await post();
    expect(first.status).toBe(201);
    expect(first.body.amount).toBe(100);
    const blocked = await post();
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/void it first/);

    expect((await voidIt(first.body.id, "Entered twice")).status).toBe(200);
    const second = await post();
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);

    // The job card's list now carries both: one voided, one live. Only the live one is money.
    const list = await request(app).get(`/time/commissions?visitId=${visit.id}`).expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.filter((c: { voidedAt: string | null }) => c.voidedAt == null)).toHaveLength(1);
  });
});

// ─── 6. Paid out ─────────────────────────────────────────────────────────────

describe("a commission already paid out", () => {
  it("is refused — it is in a technician's pay — and stays live", async () => {
    // Commission.paidAt has no writer today (constants.md); the guard waits for the day one exists.
    const c = await manual(90, { paidAt: new Date() });
    const res = await voidIt(c.id, "Changed my mind");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already paid out/);
    expect((await prisma.commission.findUniqueOrThrow({ where: { id: c.id } })).voidedAt).toBeNull();
  });
});

// ─── 7. The old DELETE ───────────────────────────────────────────────────────

describe("DELETE /time/commissions/:id", () => {
  it("answers 410 with where to go, and deletes nothing", async () => {
    const c = await manual(15);
    const res = await request(app).delete(`/time/commissions/${c.id}`).send({ reason: "old button" });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/void/i);
    expect(await prisma.commission.count({ where: { id: c.id } })).toBe(1);
  });
});

// ─── 8. No technician route ──────────────────────────────────────────────────

describe("there is NO technician route for voiding a commission", () => {
  it("the tech router carries no commission route, a tech bearer gets 404, and the CRM route does not answer to it", async () => {
    const router = healthRecordTechRouter as unknown as { stack: Array<{ route?: { path: string | string[]; methods: Record<string, boolean> } }> };
    const paths = router.stack
      .filter((l) => l.route)
      .flatMap((l) => (Array.isArray(l.route!.path) ? l.route!.path : [l.route!.path]).map((p) => ({ path: p, methods: Object.keys(l.route!.methods).filter((m) => l.route!.methods[m]) })));
    expect(paths.length).toBeGreaterThan(20); // we really walked the router
    const commissionRoutes = paths.filter((r) => /commission/i.test(r.path));
    expect(commissionRoutes, `tech router must never carry a commission route: ${JSON.stringify(commissionRoutes)}`).toEqual([]);

    const c = await manual(33);
    for (const path of [`/health-record/time/commissions/${c.id}/void`, `/health-record/commissions/${c.id}/void`]) {
      const res = await request(app).post(path).set("Authorization", `Bearer ${techToken}`).send({ reason: "tech tries" });
      expect(res.status, path).toBe(404);
    }
    // The CRM route is the session's (pinAuthMiddleware is a no-op without PIN_HASH, so arm it).
    process.env.PIN_HASH = await bcrypt.hash("135790", 4);
    try {
      const crm = await request(app).post(`/time/commissions/${c.id}/void`).set("Authorization", `Bearer ${techToken}`).send({ reason: "tech tries" });
      expect(crm.status).toBe(401);
    } finally {
      delete process.env.PIN_HASH;
    }
    expect((await prisma.commission.findUniqueOrThrow({ where: { id: c.id } })).voidedAt).toBeNull();
  });
});
