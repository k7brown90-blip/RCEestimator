import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/services/twilio");
vi.mock("googleapis");

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { getLeadFollowUpMetrics } from "../src/services/crmAnalytics";
import { dayInstant } from "../shared/calendarDay";
import { repairLeadLostState } from "../src/services/leadStateRepair";

/**
 * Plan lead-intake-fixes, bugs B2 (follow-up day), B3 (Needs-attention count) and B4 (Status vs
 * Call outcome). B1 (blank / partial address) is in leadManualEntry.test.ts.
 */

const TAG = "LIF";

async function wipe() {
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
}
beforeEach(wipe);
afterAll(wipe);

const post = (body: Record<string, unknown>) =>
  request(app).post("/crm/leads").send({ name: `${TAG} Lead`, ...body });

describe("B2: a follow-up date is a calendar day (noon UTC)", () => {
  it("PATCH stores a bare date at noon UTC, so Chicago shows the day that was typed", async () => {
    const created = await post({}).expect(201);
    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}`)
      .send({ followUpDate: "2026-11-15" })
      .expect(200);
    expect(res.body.followUpDate).toBe("2026-11-15T12:00:00.000Z");
    // Not Nov 14 in Chicago, which is what midnight UTC rendered as.
    const chicago = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(res.body.followUpDate));
    expect(chicago).toBe("2026-11-15");
  });

  it("POST stores a bare date at noon UTC too, and accepts null", async () => {
    const withDate = await post({ followUpDate: "2026-11-15" }).expect(201);
    expect(withDate.body.lead.followUpDate).toBe("2026-11-15T12:00:00.000Z");
    const without = await post({ followUpDate: null }).expect(201);
    expect(without.body.lead.followUpDate).toBeNull();
  });

  it("a full timestamp passes through untouched, and garbage is refused", async () => {
    const created = await post({}).expect(201);
    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}`)
      .send({ followUpDate: "2026-11-15T14:30:00.000Z" })
      .expect(200);
    expect(res.body.followUpDate).toBe("2026-11-15T14:30:00.000Z");
    await request(app).patch(`/leads/${created.body.lead.id}`).send({ followUpDate: "nonsense" }).expect(400);
    await post({ followUpDate: "nonsense" }).expect(400);
  });

  it("clears the date with null", async () => {
    const created = await post({ followUpDate: "2026-11-15" }).expect(201);
    const res = await request(app).patch(`/leads/${created.body.lead.id}`).send({ followUpDate: null }).expect(200);
    expect(res.body.followUpDate).toBeNull();
  });

  it("the due-today and overdue counts follow the Chicago day, never counting one lead twice", async () => {
    // "Now" is Nov 15, 10 AM in Chicago. A Nov 15 follow-up is due today and NOT overdue; the
    // old "< now" turned it overdue by mid-morning, and the old server-local setHours(0) put the
    // day boundary on UTC midnight (6 PM Chicago the evening before).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-15T16:00:00Z"));
    try {
      const rows: [string, Date | null][] = [
        [`${TAG} Yesterday`, dayInstant("2026-11-14")],
        [`${TAG} Today Noon`, dayInstant("2026-11-15")],
        [`${TAG} Today Midnight`, new Date("2026-11-15T00:00:00Z")], // what the old writer stored
        [`${TAG} Tomorrow`, dayInstant("2026-11-16")],
        [`${TAG} NoDate`, null],
      ];
      for (const [name, followUpDate] of rows) {
        await prisma.lead.create({ data: { name, followUpDate } });
      }
      const m = await getLeadFollowUpMetrics();
      const overdue = m.overdueLeads.filter((l) => l.name.startsWith(TAG)).map((l) => l.name);
      expect(overdue).toEqual([`${TAG} Yesterday`]);
      // Count only our own rows out of whatever else the shared test database holds.
      const mine = await prisma.lead.findMany({ where: { name: { startsWith: TAG } }, select: { name: true } });
      expect(mine).toHaveLength(5);
      // dueTodayCount / noFollowUpCount are global; assert they at least include ours.
      expect(m.dueTodayCount).toBeGreaterThanOrEqual(2);
      expect(m.noFollowUpCount).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("GET /leads/follow-ups-due pulls a lead on its own day, not the evening before", async () => {
    const previous = process.env.WEBHOOK_SECRET;
    process.env.WEBHOOK_SECRET = "lif-secret";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await prisma.lead.create({
        data: { name: `${TAG} Due Nov 15`, leadStatus: "planning", followUpDate: dayInstant("2026-11-15") },
      });
      // Nov 14, 8 PM Chicago (Nov 15 02:00 UTC): not yet.
      vi.setSystemTime(new Date("2026-11-15T02:00:00Z"));
      const evening = await request(app).get("/leads/follow-ups-due").set("webhook_secret", "lif-secret").expect(200);
      expect(evening.body.leads.some((l: { name: string }) => l.name === `${TAG} Due Nov 15`)).toBe(false);
      // Nov 15, 7 AM Chicago (13:00 UTC): due.
      vi.setSystemTime(new Date("2026-11-15T13:00:00Z"));
      const morning = await request(app).get("/leads/follow-ups-due").set("webhook_secret", "lif-secret").expect(200);
      expect(morning.body.leads.some((l: { name: string }) => l.name === `${TAG} Due Nov 15`)).toBe(true);
    } finally {
      vi.useRealTimers();
      if (previous === undefined) delete process.env.WEBHOOK_SECRET;
      else process.env.WEBHOOK_SECRET = previous;
    }
  });
});

describe("B3: the Needs-attention count leaves out lost and converted leads", () => {
  it("a lead lost by EITHER column, or converted, is not counted; an open one is", async () => {
    const before = await getLeadFollowUpMetrics();
    const pastDay = dayInstant("2026-01-02");
    await prisma.lead.createMany({
      data: [
        { name: `${TAG} Open`, status: "new", leadStatus: "new" },
        { name: `${TAG} Open Overdue`, status: "contacted", leadStatus: "unresolved", followUpDate: pastDay },
        { name: `${TAG} Lost By Status`, status: "lost", leadStatus: "new" },
        { name: `${TAG} Lost By Status Overdue`, status: "lost", leadStatus: "new", followUpDate: pastDay },
        { name: `${TAG} Lost By Outcome`, status: "new", leadStatus: "lost" },
        { name: `${TAG} Converted`, status: "converted", leadStatus: "booked" },
        { name: `${TAG} Converted Overdue`, status: "converted", leadStatus: "planning", followUpDate: pastDay },
      ],
    });
    const after = await getLeadFollowUpMetrics();

    expect(after.openLeadCount - before.openLeadCount).toBe(2);
    expect(after.noFollowUpCount - before.noFollowUpCount).toBe(1);
    expect(after.overdueCount - before.overdueCount).toBe(1);
    const overdueNames = after.overdueLeads.filter((l) => l.name.startsWith(TAG)).map((l) => l.name);
    expect(overdueNames).toEqual([`${TAG} Open Overdue`]);
  });
});

describe("B4: Status and Call outcome stay in step", () => {
  it("POST with Status lost stores the outcome lost too (the 12 Yelp imports)", async () => {
    const res = await post({ status: "lost", leadStatus: "new" }).expect(201);
    expect(res.body.lead.status).toBe("lost");
    expect(res.body.lead.leadStatus).toBe("lost");
  });

  it("POST refuses to start a lead as won, and says Convert", async () => {
    const res = await post({ leadStatus: "won" }).expect(400);
    expect(res.body.error).toMatch(/Convert/);
  });

  it("PATCH Status lost writes the outcome lost; reopening sends it back to new", async () => {
    const created = await post({}).expect(201);
    const id = created.body.lead.id;

    const lost = await request(app).patch(`/leads/${id}`).send({ status: "lost", lostReason: "price" }).expect(200);
    expect(lost.body.status).toBe("lost");
    expect(lost.body.leadStatus).toBe("lost");

    // The drawer's "Mark Contacted" sends only { status: "contacted" }.
    const reopened = await request(app).patch(`/leads/${id}`).send({ status: "contacted" }).expect(200);
    expect(reopened.body.status).toBe("contacted");
    expect(reopened.body.leadStatus).toBe("new");
  });

  it("PATCH from the form's payload reopens a lost lead (the form re-sends the stored outcome)", async () => {
    const created = await post({ status: "lost" }).expect(201);
    expect(created.body.lead.leadStatus).toBe("lost");
    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}`)
      .send({ status: "contacted", leadStatus: "lost", lostReason: null, lostNotes: null })
      .expect(200);
    expect(res.body.status).toBe("contacted");
    expect(res.body.leadStatus).toBe("new");
    // It is back in the Open queue.
    const open = await request(app).get("/leads?pipeline=open").expect(200);
    expect(open.body.some((l: { id: string }) => l.id === created.body.lead.id)).toBe(true);
  });

  it("PATCH outcome lost writes Status lost", async () => {
    const created = await post({}).expect(201);
    const res = await request(app).patch(`/leads/${created.body.lead.id}`).send({ leadStatus: "lost" }).expect(200);
    expect(res.body.status).toBe("lost");
    expect(res.body.leadStatus).toBe("lost");
  });

  it("an edit of an unrelated field never fails on a row that holds won, and leaves it alone", async () => {
    // Savannah writes "won"; deleting an account resets a converted lead to status new but keeps "won".
    const lead = await prisma.lead.create({ data: { name: `${TAG} Won Orphan`, status: "new", leadStatus: "won" } });
    const res = await request(app)
      .patch(`/leads/${lead.id}`)
      .send({ notes: "called back", status: "new", leadStatus: "won" })
      .expect(200);
    expect(res.body.notes).toBe("called back");
    expect(res.body.status).toBe("new");
    expect(res.body.leadStatus).toBe("won");
    // But nobody can SET it by hand.
    const other = await post({}).expect(201);
    await request(app).patch(`/leads/${other.body.lead.id}`).send({ leadStatus: "won" }).expect(400);
  });

  it("a converted lead still saves an edit, and is never demoted by it", async () => {
    const lead = await prisma.lead.create({ data: { name: `${TAG} Converted`, status: "converted", leadStatus: "won" } });
    const res = await request(app)
      .patch(`/leads/${lead.id}`)
      .send({ notes: "consultation booked", status: "converted", leadStatus: "won" })
      .expect(200);
    expect(res.body.status).toBe("converted");
    expect(res.body.leadStatus).toBe("won");
    // The guard still stops a MOVE to converted.
    const fresh = await post({}).expect(201);
    await request(app).patch(`/leads/${fresh.body.lead.id}`).send({ status: "converted" }).expect(400);
  });
});

describe("B4 repair: scripts/reconcileLeadStatus.ts (the logic is repairLeadLostState)", () => {
  const seed = async () => {
    await prisma.lead.createMany({
      data: [
        { name: `${TAG} Yelp Lost`, status: "lost", leadStatus: "new" },
        { name: `${TAG} Outcome Lost`, status: "contacted", leadStatus: "lost" },
        { name: `${TAG} Already Fine`, status: "lost", leadStatus: "lost" },
        { name: `${TAG} Open`, status: "new", leadStatus: "planning" },
        { name: `${TAG} Converted`, status: "converted", leadStatus: "lost" },
        { name: `${TAG} Won Orphan`, status: "new", leadStatus: "won" },
      ],
    });
  };
  const mine = (names: string[]) => prisma.lead.findMany({ where: { name: { in: names.map((n) => `${TAG} ${n}`) } } });

  it("is a dry run by default: it lists the rows and writes nothing", async () => {
    await seed();
    const report = await repairLeadLostState({ apply: false });
    const names = report.changes.filter((c) => c.name.startsWith(TAG)).map((c) => c.name).sort();
    expect(names).toEqual([`${TAG} Outcome Lost`, `${TAG} Yelp Lost`]);
    expect(report.applied).toBe(false);
    const rows = await mine(["Yelp Lost", "Outcome Lost"]);
    expect(rows.find((r) => r.name === `${TAG} Yelp Lost`)?.leadStatus).toBe("new");
    expect(rows.find((r) => r.name === `${TAG} Outcome Lost`)?.status).toBe("contacted");
  });

  it("--apply sets both columns lost on the mismatched rows only, and never touches converted or won", async () => {
    await seed();
    await repairLeadLostState({ apply: true });
    const rows = await prisma.lead.findMany({ where: { name: { startsWith: TAG } } });
    const by = (n: string) => rows.find((r) => r.name === `${TAG} ${n}`)!;
    expect([by("Yelp Lost").status, by("Yelp Lost").leadStatus]).toEqual(["lost", "lost"]);
    expect([by("Outcome Lost").status, by("Outcome Lost").leadStatus]).toEqual(["lost", "lost"]);
    expect([by("Open").status, by("Open").leadStatus]).toEqual(["new", "planning"]);
    expect([by("Converted").status, by("Converted").leadStatus]).toEqual(["converted", "lost"]);
    expect([by("Won Orphan").status, by("Won Orphan").leadStatus]).toEqual(["new", "won"]);

    // A second pass finds nothing of ours left to change, and reports the won orphan.
    const again = await repairLeadLostState({ apply: false });
    expect(again.changes.filter((c) => c.name.startsWith(TAG))).toEqual([]);
    expect(again.wonWithoutConversion.some((w) => w.name === `${TAG} Won Orphan`)).toBe(true);
  });
});
