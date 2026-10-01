/**
 * Account conversation notes (plan item F, 2026-10-01).
 *
 * Kyle: "Notes should be account based for an admin that is answering calls and dispatching. Any
 * info gathered during a conversation should be able to be documented and shared with others per
 * account." A CustomerNote is one conversation on the ACCOUNT — body, who took it (typed, because
 * there is no per-user identity behind the PIN), when — optionally tagged to a job.
 *
 * Pinned here:
 * - create / list newest-first / edit / delete, each scoped to the account in the URL;
 * - a fresh note has `updatedAt === createdAt` EXACTLY, and only an edit moves `updatedAt` — the
 *   client renders `updatedAt > createdAt` as "edited", so a millisecond of skew at create would
 *   make every new note read as edited;
 * - the job link is a TAG: deleting the job keeps the note on the account with the tag cleared;
 * - the account OWNS the log: deleting an (empty) account takes its notes with it.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/services/twilio");
vi.mock("googleapis");

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

const TAG = "AcctNotes Test";

async function wipe() {
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return;
  await prisma.customerNote.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.visit.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.property.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.customer.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(wipe);
afterAll(wipe);

async function makeAccount(suffix: string) {
  const customer = await prisma.customer.create({
    data: {
      name: `${TAG} ${suffix}`,
      properties: { create: { name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } },
    },
    include: { properties: true },
  });
  const property = customer.properties[0]!;
  const visit = await prisma.visit.create({
    data: { customerId: customer.id, propertyId: property.id, mode: "service_call", jobType: "Panel upgrade" },
  });
  return { customer, property, visit };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("POST /accounts/:id/notes", () => {
  it("files a note on the account with who took it, and stamps created and updated from ONE instant", async () => {
    const { customer } = await makeAccount("Create");

    const res = await request(app)
      .post(`/accounts/${customer.id}/notes`)
      .send({ body: "Called about flickering in the kitchen. Wants Tuesday AM.", takenBy: "Kyle" })
      .expect(201);

    expect(res.body.customerId).toBe(customer.id);
    expect(res.body.body).toBe("Called about flickering in the kitchen. Wants Tuesday AM.");
    expect(res.body.takenBy).toBe("Kyle");
    expect(res.body.visitId).toBeNull();
    expect(res.body.visit).toBeNull();
    // The edited marker is `updatedAt > createdAt`. A fresh note must not trip it.
    expect(res.body.updatedAt).toBe(res.body.createdAt);
  });

  it("tags the note to one of the account's jobs, and reads the job's label back on the list", async () => {
    const { customer, visit } = await makeAccount("Tag");

    const res = await request(app)
      .post(`/accounts/${customer.id}/notes`)
      .send({ body: "Tech should bring a 200A panel.", takenBy: "Kyle", visitId: visit.id })
      .expect(201);

    expect(res.body.visitId).toBe(visit.id);
    expect(res.body.visit).toMatchObject({ id: visit.id, jobType: "Panel upgrade", property: { addressLine1: "12 Main St" } });
  });

  it("refuses a note with nothing said, or nobody named as taking it", async () => {
    const { customer } = await makeAccount("Empty");

    await request(app).post(`/accounts/${customer.id}/notes`).send({ body: "   ", takenBy: "Kyle" }).expect(400);
    await request(app).post(`/accounts/${customer.id}/notes`).send({ body: "Something said", takenBy: "" }).expect(400);
    await request(app).post(`/accounts/${customer.id}/notes`).send({ body: "Something said" }).expect(400);
    expect(await prisma.customerNote.count({ where: { customerId: customer.id } })).toBe(0);
  });

  it("refuses to tag another account's job", async () => {
    const { customer } = await makeAccount("Mine");
    const other = await makeAccount("Theirs");

    const res = await request(app)
      .post(`/accounts/${customer.id}/notes`)
      .send({ body: "Cross-wired", takenBy: "Kyle", visitId: other.visit.id })
      .expect(400);

    expect(res.body.error).toMatch(/not on this account/);
    expect(await prisma.customerNote.count({ where: { customerId: customer.id } })).toBe(0);
  });

  it("404s on an account that does not exist", async () => {
    await request(app).post("/accounts/no-such-account/notes").send({ body: "x", takenBy: "Kyle" }).expect(404);
  });
});

describe("GET /accounts/:id/notes", () => {
  it("lists newest first — the last caller is at the top", async () => {
    const { customer } = await makeAccount("Order");
    const t0 = new Date("2026-09-28T14:00:00.000Z");
    const t1 = new Date("2026-09-30T09:30:00.000Z");
    await prisma.customerNote.create({ data: { customerId: customer.id, body: "First call", takenBy: "Kyle", createdAt: t0, updatedAt: t0 } });
    await prisma.customerNote.create({ data: { customerId: customer.id, body: "Second call", takenBy: "Eric", createdAt: t1, updatedAt: t1 } });

    const res = await request(app).get(`/accounts/${customer.id}/notes`).expect(200);

    expect(res.body.map((n: { body: string }) => n.body)).toEqual(["Second call", "First call"]);
    expect(res.body.map((n: { takenBy: string }) => n.takenBy)).toEqual(["Eric", "Kyle"]);
  });

  it("is per account — another account's notes never appear", async () => {
    const a = await makeAccount("A");
    const b = await makeAccount("B");
    await prisma.customerNote.create({ data: { customerId: a.customer.id, body: "A's call", takenBy: "Kyle" } });
    await prisma.customerNote.create({ data: { customerId: b.customer.id, body: "B's call", takenBy: "Kyle" } });

    const res = await request(app).get(`/accounts/${a.customer.id}/notes`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].body).toBe("A's call");
  });
});

describe("PATCH /accounts/:id/notes/:noteId", () => {
  it("edits the note and moves updatedAt past createdAt — the original time is kept, so it shows as edited", async () => {
    const { customer } = await makeAccount("Edit");
    const created = (await request(app)
      .post(`/accounts/${customer.id}/notes`)
      .send({ body: "Wants Tuesday", takenBy: "Kyle" })
      .expect(201)).body;
    await pause(10);

    const res = await request(app)
      .patch(`/accounts/${customer.id}/notes/${created.id}`)
      .send({ body: "Wants Tuesday — or Wednesday after 2." })
      .expect(200);

    expect(res.body.body).toBe("Wants Tuesday — or Wednesday after 2.");
    expect(res.body.takenBy).toBe("Kyle");
    expect(res.body.createdAt).toBe(created.createdAt);
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(new Date(res.body.createdAt).getTime());

    const listed = (await request(app).get(`/accounts/${customer.id}/notes`).expect(200)).body;
    expect(listed[0].body).toBe("Wants Tuesday — or Wednesday after 2.");
    expect(new Date(listed[0].updatedAt).getTime()).toBeGreaterThan(new Date(listed[0].createdAt).getTime());
  });

  it("can correct who took the call", async () => {
    const { customer } = await makeAccount("WhoTook");
    const created = (await request(app).post(`/accounts/${customer.id}/notes`).send({ body: "Call", takenBy: "Kyle" }).expect(201)).body;

    const res = await request(app).patch(`/accounts/${customer.id}/notes/${created.id}`).send({ takenBy: "Eric" }).expect(200);
    expect(res.body.takenBy).toBe("Eric");
    expect(res.body.body).toBe("Call");
  });

  it("refuses an empty edit, an emptied body, and a note that belongs to another account", async () => {
    const mine = await makeAccount("EditMine");
    const theirs = await makeAccount("EditTheirs");
    const note = await prisma.customerNote.create({ data: { customerId: theirs.customer.id, body: "Theirs", takenBy: "Kyle" } });
    const ownNote = await prisma.customerNote.create({ data: { customerId: mine.customer.id, body: "Mine", takenBy: "Kyle" } });

    await request(app).patch(`/accounts/${mine.customer.id}/notes/${ownNote.id}`).send({}).expect(400);
    await request(app).patch(`/accounts/${mine.customer.id}/notes/${ownNote.id}`).send({ body: "  " }).expect(400);
    await request(app).patch(`/accounts/${mine.customer.id}/notes/${note.id}`).send({ body: "Rewritten" }).expect(404);

    expect((await prisma.customerNote.findUnique({ where: { id: note.id } }))?.body).toBe("Theirs");
  });
});

describe("DELETE /accounts/:id/notes/:noteId", () => {
  it("deletes the note from the account, and only from the account it is on", async () => {
    const mine = await makeAccount("DelMine");
    const theirs = await makeAccount("DelTheirs");
    const own = await prisma.customerNote.create({ data: { customerId: mine.customer.id, body: "Mine", takenBy: "Kyle" } });
    const other = await prisma.customerNote.create({ data: { customerId: theirs.customer.id, body: "Theirs", takenBy: "Kyle" } });

    await request(app).delete(`/accounts/${mine.customer.id}/notes/${other.id}`).expect(404);
    await request(app).delete(`/accounts/${mine.customer.id}/notes/${own.id}`).expect(204);
    await request(app).delete(`/accounts/${mine.customer.id}/notes/${own.id}`).expect(404);

    expect((await request(app).get(`/accounts/${mine.customer.id}/notes`).expect(200)).body).toEqual([]);
    expect(await prisma.customerNote.count({ where: { id: other.id } })).toBe(1);
  });
});

describe("what happens to a note when the things around it go away", () => {
  it("deleting the tagged job keeps the note on the account and only clears the tag (SetNull)", async () => {
    const { customer, visit } = await makeAccount("JobGone");
    const created = (await request(app)
      .post(`/accounts/${customer.id}/notes`)
      .send({ body: "Said the panel is in the garage.", takenBy: "Kyle", visitId: visit.id })
      .expect(201)).body;

    // The visit delete route, not a raw prisma delete — this is the door Kyle uses.
    await request(app).delete(`/visits/${visit.id}`).expect(204);

    const listed = (await request(app).get(`/accounts/${customer.id}/notes`).expect(200)).body;
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);
    expect(listed[0].body).toBe("Said the panel is in the garage.");
    expect(listed[0].takenBy).toBe("Kyle");
    expect(listed[0].visitId).toBeNull();
    expect(listed[0].visit).toBeNull();
    // Losing the tag is not an edit.
    expect(listed[0].updatedAt).toBe(listed[0].createdAt);
  });

  it("deleting an empty account takes its notes with it (Cascade) — a note alone does not pin the account", async () => {
    const { customer } = await makeAccount("AcctGone");
    // The stub visit from makeAccount is status "estimate" with no work on it, which is what
    // deleteCustomer allows through. The note must neither block that nor outlive the account.
    await prisma.customerNote.create({ data: { customerId: customer.id, body: "Wrong number, actually.", takenBy: "Kyle" } });

    await request(app).delete(`/accounts/${customer.id}`).expect(204);

    expect(await prisma.customer.count({ where: { id: customer.id } })).toBe(0);
    expect(await prisma.customerNote.count({ where: { customerId: customer.id } })).toBe(0);
  });
});
