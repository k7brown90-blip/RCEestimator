/**
 * The manual "review confirmed" mark on the account (plan
 * 2026-10-02-account-property-and-the-estimate-that-knows-the-job.md, item E / ruling E2).
 *
 * Kyle: "I would like the google review to be a manual only marked... Once once is done we can
 * mark that." Google never tells this app a review landed, so `Customer.reviewConfirmedAt` /
 * `reviewConfirmedBy` are a recorded fact a human enters, never something the system derives.
 *
 * These tests prove:
 *   1. POST records who and when, and 404s an unknown account.
 *   2. `confirmedBy` is required — no server-side default, same as CustomerNote.takenBy.
 *   3. DELETE clears both fields back to null — the standing "nothing is one-way" rule — and the
 *      mark can be re-confirmed afterwards with a different name.
 *   4. GET /accounts/:id/summary carries both fields on `account`, for the CRM to render.
 */

import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";

const MARK = "RVC";
const customerIds: string[] = [];

async function makeAccount(suffix: string) {
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer ${suffix}`, phone: "615-555-0188", email: `${MARK}-${suffix}@example.com` },
  });
  customerIds.push(customer.id);
  return customer.id;
}

afterAll(async () => {
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
});

describe("POST /accounts/:id/review-confirmed", () => {
  it("records who marked it and when", async () => {
    const customerId = await makeAccount("basic");
    const res = await request(app).post(`/accounts/${customerId}/review-confirmed`).send({ confirmedBy: "Eric" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reviewConfirmedBy).toBe("Eric");
    expect(res.body.reviewConfirmedAt).not.toBeNull();

    const stored = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(stored.reviewConfirmedBy).toBe("Eric");
    expect(stored.reviewConfirmedAt).not.toBeNull();
  });

  it("404s an account that does not exist", async () => {
    const res = await request(app).post("/accounts/does-not-exist/review-confirmed").send({ confirmedBy: "Eric" });
    expect(res.status).toBe(404);
  });

  it("requires confirmedBy — no server-side default, same precedent as CustomerNote.takenBy", async () => {
    const customerId = await makeAccount("no-name");
    const res = await request(app).post(`/accounts/${customerId}/review-confirmed`).send({});
    expect(res.status).toBe(400);

    const blank = await request(app).post(`/accounts/${customerId}/review-confirmed`).send({ confirmedBy: "   " });
    expect(blank.status).toBe(400);

    const stored = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(stored.reviewConfirmedBy).toBeNull();
  });
});

describe("DELETE /accounts/:id/review-confirmed", () => {
  it("clears both fields back to null — reversible, never one-way", async () => {
    const customerId = await makeAccount("undo");
    await request(app).post(`/accounts/${customerId}/review-confirmed`).send({ confirmedBy: "Kyle" });

    const res = await request(app).delete(`/accounts/${customerId}/review-confirmed`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reviewConfirmedAt).toBeNull();
    expect(res.body.reviewConfirmedBy).toBeNull();

    const stored = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(stored.reviewConfirmedAt).toBeNull();
    expect(stored.reviewConfirmedBy).toBeNull();
  });

  it("round-trips: confirm, undo, confirm again under a different name", async () => {
    const customerId = await makeAccount("roundtrip");
    await request(app).post(`/accounts/${customerId}/review-confirmed`).send({ confirmedBy: "Eric" });
    await request(app).delete(`/accounts/${customerId}/review-confirmed`);
    const again = await request(app).post(`/accounts/${customerId}/review-confirmed`).send({ confirmedBy: "Kyle" });

    expect(again.body.reviewConfirmedBy).toBe("Kyle");
    const stored = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(stored.reviewConfirmedBy).toBe("Kyle");
  });

  it("404s an account that does not exist", async () => {
    const res = await request(app).delete("/accounts/does-not-exist/review-confirmed");
    expect(res.status).toBe(404);
  });
});

describe("GET /accounts/:id/summary carries the mark", () => {
  it("is null until confirmed, then reflects who and when", async () => {
    const customerId = await makeAccount("summary");
    const before = await request(app).get(`/accounts/${customerId}/summary`);
    expect(before.body.account.reviewConfirmedAt).toBeNull();
    expect(before.body.account.reviewConfirmedBy).toBeNull();

    await request(app).post(`/accounts/${customerId}/review-confirmed`).send({ confirmedBy: "Eric" });

    const after = await request(app).get(`/accounts/${customerId}/summary`);
    expect(after.body.account.reviewConfirmedBy).toBe("Eric");
    expect(after.body.account.reviewConfirmedAt).not.toBeNull();
  });
});
