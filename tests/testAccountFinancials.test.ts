/**
 * The test account never reaches a company number.
 *
 * Kyle, 2026-09-11: *"I want all information in the test account to be
 * considered as a test only. No incorporation into financial tracking at all."*
 *
 * The exclusion filters had existed since P029, but the account he was actually
 * testing in was never marked — so every one of them passed it through and he
 * saw practice money in his books. The property worth pinning is therefore not
 * "a filter exists" but "a marked account's money is absent from the totals, and
 * present again the moment it is unmarked" — the same rows, the same year, the
 * flag as the only difference.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { payrollForWeek } from "../src/services/timeTracking";
import { consumeForJob } from "../src/services/jobMaterials";

const YEAR = 2031; // far from any other fixture's year, so the totals are ours alone
const JAN = new Date(`${YEAR}-01-15T15:00:00.000Z`);

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;

/** Expenses + collected for our sentinel year. */
async function summary() {
  const res = await request(app).get(`/financials/summary?year=${YEAR}`);
  expect(res.status).toBe(200);
  const month = res.body.months[0];
  return { collected: month.collected, expenses: month.expenses, invoiced: month.invoiced };
}

async function setTest(isTestAccount: boolean) {
  await prisma.customer.update({ where: { id: customerId }, data: { isTestAccount } });
}

beforeAll(async () => {
  const customer = await prisma.customer.create({
    data: { name: "TESTACCT financial exclusion", isTestAccount: false },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: {
      customerId, name: "Bench", addressLine1: "1 Bench Way",
      city: "La Vergne", state: "TN", postalCode: "37086",
    },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: "TESTACCT job", status: "contracted" },
  });
  visitId = visit.id;
  const tech = await prisma.technician.create({
    data: { name: "TESTACCT tech", hourlyRate: 40, commissionPercent: 10, accessToken: "testacct-token" },
  });
  technicianId = tech.id;

  await Promise.all([
    prisma.payment.create({
      data: { customerId, amount: 900, status: "paid", method: "check", paidAt: JAN },
    }),
    prisma.receipt.create({
      data: {
        jobId: visitId, amount: 150, status: "confirmed", category: "materials",
        vendor: "TESTACCT Supply", receivedAt: JAN, source: "test",
      },
    }),
    prisma.commission.create({
      data: { technicianId, visitId, basis: "job_profit", percent: 10, amount: 75, earnedAt: JAN },
    }),
    prisma.timeEntry.create({
      data: {
        visitId, technicianId,
        startedAt: JAN,
        endedAt: new Date(JAN.getTime() + 4 * 60 * 60 * 1000),
        minutes: 240,
        rateApplied: 40,
        endedReason: "completed",
      },
    }),
  ]);
});

afterAll(async () => {
  await prisma.commission.deleteMany({ where: { technicianId } });
  await prisma.timeEntry.deleteMany({ where: { technicianId } });
  await prisma.receipt.deleteMany({ where: { jobId: visitId } });
  await prisma.payment.deleteMany({ where: { customerId } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
});

describe("a marked test account is absent from every company total", () => {
  it("keeps its payments and receipts out of the year ledger, and puts them back when unmarked", async () => {
    await setTest(false);
    const live = await summary();
    expect(live.collected, "the fixture's payment should be visible while live").toBeGreaterThanOrEqual(900);
    expect(live.expenses, "the fixture's receipt should be visible while live").toBeGreaterThanOrEqual(150);

    await setTest(true);
    const marked = await summary();
    expect(marked.collected).toBe(live.collected - 900);
    expect(marked.expenses).toBe(Math.round((live.expenses - 150) * 100) / 100);

    // The flag is the only difference — unmarking restores the same numbers.
    await setTest(false);
    expect(await summary()).toEqual(live);
  });

  it("keeps its hours and commissions out of payroll", async () => {
    await setTest(false);
    const live = await payrollForWeek(technicianId, JAN);
    expect(live.jobMinutes).toBe(240);
    expect(live.commissions).toBe(75);
    expect(live.total).toBeGreaterThan(0);

    await setTest(true);
    const marked = await payrollForWeek(technicianId, JAN);
    expect(marked.jobMinutes).toBe(0);
    expect(marked.impliedMinutes, "no payroll floor off a practice job").toBe(0);
    expect(marked.commissions).toBe(0);
    expect(marked.total).toBe(0);
  });

  /*
    Kyle, 2026-09-12: "test jobs should not touch inventory because those jobs
    are never real installations so material is never used for them." Filtering
    test material out of the REPORTS would not have been enough — the wire would
    still have left the shelf and the truck would be short on a real job.
  */
  it("takes nothing off the truck for a test job, and still does for a live one", async () => {
    const line = { itemId: "TESTACCT-WIRE", name: "TESTACCT 14/2 NM-B", unit: "ft", qty: 25 };

    await setTest(true);
    await expect(
      consumeForJob({ jobId: visitId, lines: [line], actor: "test", allowNegative: true, reason: "pinning the rule" }),
    ).rejects.toThrow(/test account/i);
    expect(await prisma.stockMovement.count({ where: { jobId: visitId } })).toBe(0);

    // The same call on the same job succeeds the moment it is a real account —
    // so the refusal is the flag talking, not a broken fixture.
    await setTest(false);
    const moved = await consumeForJob({
      jobId: visitId, lines: [line], actor: "test", allowNegative: true, reason: "pinning the rule",
    });
    expect(moved).toHaveLength(1);
    expect(moved[0].kind).toBe("consume");

    await prisma.stockMovement.deleteMany({ where: { jobId: visitId } });
    await prisma.stockLevel.deleteMany({ where: { itemId: line.itemId } });
  });

  it("keeps its commissions out of the company commission ledger", async () => {
    await setTest(true);
    const ledger = await request(app).get(`/time/commissions?technicianId=${technicianId}`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.map((c: { visitId: string | null }) => c.visitId)).not.toContain(visitId);

    // Asked about that one job, it still answers — a test account's own page is
    // allowed to show a test account's own numbers.
    const scoped = await request(app).get(`/time/commissions?visitId=${visitId}`);
    expect(scoped.body.map((c: { visitId: string | null }) => c.visitId)).toContain(visitId);
  });
});
