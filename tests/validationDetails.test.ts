/**
 * A refusal has to say WHICH box is wrong (Kyle, 2026-09-22).
 *
 * He could not create a customer account: the form showed "Validation failed" and nothing else,
 * three attempts in a row, because the error handler hid Zod's `flatten()` whenever
 * NODE_ENV was "production". The field names and messages in that payload describe the CALLER'S
 * OWN request — "email: Invalid email" — so there is nothing to protect by hiding them, and
 * hiding them is what made the form unusable.
 *
 * The client turns these into "Email: Invalid email" (client/src/lib/api.ts fieldMessage).
 */

import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

const CREATED: string[] = [];

afterAll(async () => {
  if (CREATED.length > 0) await prisma.customer.deleteMany({ where: { id: { in: CREATED } } });
});

describe("a 400 names the field, in every environment", () => {
  it("POST /accounts with a malformed email says so, with the field name", async () => {
    const res = await request(app).post("/accounts").send({ name: "Fielded Test", email: "kyle@" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(res.body.details?.fieldErrors?.email?.[0]).toMatch(/email/i);
  });

  // There is no production-mode case here on purpose: with PIN_HASH unset, NODE_ENV=production
  // now refuses every protected request with 503 before any handler runs (PUNCHLIST B3,
  // 2026-09-22) — which is the behaviour we want and is pinned in tests/authInvariant.test.ts.
  // The details are unconditional in the handler itself (src/app.ts, the ZodError branch).

  it("a trailing space in the email is what a real attempt looked like — and it is refused", async () => {
    const res = await request(app).post("/accounts").send({ name: "Fielded Test", email: "kyle@example.com " });
    expect(res.status).toBe(400);
    expect(res.body.details?.fieldErrors?.email?.[0]).toBeTruthy();
  });

  it("the same account with the email trimmed is created — what the form now sends", async () => {
    const res = await request(app).post("/accounts").send({ name: "Fielded Test", email: "kyle@example.com" });
    expect(res.status).toBe(201);
    CREATED.push(res.body.id);
  });

  it("a missing name names `name`, not the whole form", async () => {
    const res = await request(app).post("/accounts").send({ email: "someone@example.com" });
    expect(res.status).toBe(400);
    expect(res.body.details?.fieldErrors?.name?.[0]).toBeTruthy();
  });
});
