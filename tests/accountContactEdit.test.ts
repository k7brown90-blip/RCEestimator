/**
 * Editing an additional contact in place — PATCH /accounts/:id/contacts/:contactId
 * (plan 2026-10-01-draftphoto-drop-and-contact-patch.md, Unit 2).
 *
 * Kyle asked for this because the CRM had no PATCH at all: "Save changes" POSTed a new contact
 * and then DELETEd the old one. The end state was right, but a failure between the two halves
 * left the customer with TWO contact rows — a duplicate visible on the account page — and every
 * successful edit moved the contact to the bottom of a list ordered by `createdAt`.
 *
 * These tests prove the two properties that are easy to lose in a refactor, and that a plain
 * "it updates the fields" test would not catch:
 *
 *   1. The update is SCOPED BY CUSTOMER. Account A must not be able to edit account B's contact
 *      by guessing an id — a bare `update({ where: { id } })` would be exactly that hole.
 *   2. "A contact needs an email or a phone" is enforced on the MERGED RESULT, not on the request
 *      body. Clearing the email of a contact that has no phone leaves a contact nobody can reach,
 *      and a body-only check lets it through.
 */

import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";

const MARK = "CTE";
const customerIds: string[] = [];

async function makeAccount(suffix: string) {
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer ${suffix}`, phone: "615-555-0177", email: `${MARK}-${suffix}@example.com` },
  });
  customerIds.push(customer.id);
  return customer.id;
}

async function makeContact(customerId: string, data: { label: string; email?: string | null; phone?: string | null }) {
  return prisma.customerContact.create({
    data: { customerId, label: data.label, email: data.email ?? null, phone: data.phone ?? null },
  });
}

afterAll(async () => {
  await prisma.customerContact.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
});

describe("PATCH /accounts/:id/contacts/:contactId", () => {
  it("edits the contact in place, keeping the same row and id", async () => {
    const customerId = await makeAccount("inplace");
    const contact = await makeContact(customerId, { label: "Tenant", email: "old@example.com" });

    const res = await request(app)
      .patch(`/accounts/${customerId}/contacts/${contact.id}`)
      .send({ label: "Property manager", email: "new@example.com", phone: "615-555-0101" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.id).toBe(contact.id);
    expect(res.body.label).toBe("Property manager");

    // The row itself changed — this is what makes it an edit rather than an add-and-delete.
    const after = await prisma.customerContact.findMany({ where: { customerId } });
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(contact.id);
    expect(after[0].email).toBe("new@example.com");
    expect(after[0].phone).toBe("615-555-0101");
    // Its place in the list is unchanged, which the old add-then-delete could not preserve.
    expect(after[0].createdAt.getTime()).toBe(contact.createdAt.getTime());
  });

  it("leaves out fields alone, and an explicit null clears one", async () => {
    const customerId = await makeAccount("partial");
    const contact = await makeContact(customerId, { label: "Spouse", email: "both@example.com", phone: "615-555-0102" });

    const kept = await request(app).patch(`/accounts/${customerId}/contacts/${contact.id}`).send({ label: "Wife" });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.email).toBe("both@example.com");
    expect(kept.body.phone).toBe("615-555-0102");

    // Clearing the email is allowed here precisely BECAUSE the phone survives it.
    const cleared = await request(app).patch(`/accounts/${customerId}/contacts/${contact.id}`).send({ email: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.email).toBeNull();
    expect(cleared.body.phone).toBe("615-555-0102");
  });

  it("REFUSES to edit a contact that belongs to a different account", async () => {
    const mine = await makeAccount("mine");
    const theirs = await makeAccount("theirs");
    const theirContact = await makeContact(theirs, { label: "Their tenant", email: "theirs@example.com" });

    const res = await request(app)
      .patch(`/accounts/${mine}/contacts/${theirContact.id}`)
      .send({ label: "Hijacked", email: "attacker@example.com" });

    expect(res.status).toBe(404);

    // Untouched — the scoping is what makes this a 404 instead of a silent cross-account write.
    const after = await prisma.customerContact.findUniqueOrThrow({ where: { id: theirContact.id } });
    expect(after.label).toBe("Their tenant");
    expect(after.email).toBe("theirs@example.com");
    expect(after.customerId).toBe(theirs);
  });

  it("REFUSES an edit that would leave the contact with no email and no phone", async () => {
    const customerId = await makeAccount("unreachable");
    const contact = await makeContact(customerId, { label: "Email only", email: "only@example.com", phone: null });

    const res = await request(app).patch(`/accounts/${customerId}/contacts/${contact.id}`).send({ email: null });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/needs an email or a phone/i);

    // The rule is about the RESULT, so the stored row must still be reachable.
    const after = await prisma.customerContact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after.email).toBe("only@example.com");
  });

  it("404s a contact id that does not exist at all", async () => {
    const customerId = await makeAccount("missing");
    const res = await request(app).patch(`/accounts/${customerId}/contacts/no-such-contact`).send({ label: "Nobody" });
    expect(res.status).toBe(404);
  });
});
