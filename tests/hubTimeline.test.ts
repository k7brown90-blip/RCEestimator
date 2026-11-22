/**
 * ONE Conversation per record (work order agent-team, U2; default D3): services/hubTimeline.ts.
 *
 * Pinned here: a lead-era email shows on the account once the lead becomes one; a job-tagged note shows
 * on the job and on the property, an untagged one only on the account; a hub-sent email appears ONCE (as
 * the message, never also as its delivery row); the website chat is one line with its count; a lead with
 * no account has its own conversation; a deleted message is a tombstone with no text; the newest entry
 * is first; the job's crew thread and its unread count ride along; and a refusal for an unknown record.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";
import { createMessageRow, ensureThreadFor, softDeleteMessage, type HubReader } from "../src/services/hub";
import { buildTimeline } from "../src/services/hubTimeline";
import type { TimelineEntry } from "../shared/hub/views";

const TAG = "HubTimeline";

const owner: HubReader = { key: "owner", kind: "owner", display: "Kyle", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: true };

async function wipe() {
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = customers.map((c) => c.id);
  await prisma.emailDelivery.deleteMany({ where: { subject: { startsWith: TAG } } });
  await prisma.hubThread.deleteMany({ where: { OR: [{ title: { startsWith: TAG } }, { customerId: { in: ids } }] } });
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
  if (ids.length > 0) {
    await prisma.customerNote.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.visit.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.property.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  }
}
beforeAll(wipe);
beforeEach(wipe);
afterAll(wipe);

async function makeAccount(suffix: string, addresses = ["12 Main St"]) {
  const customer = await prisma.customer.create({
    data: {
      name: `${TAG} ${suffix}`,
      properties: { create: addresses.map((a, i) => ({ name: `Home ${i}`, addressLine1: a, city: "Smyrna", state: "TN", postalCode: "37167" })) },
    },
    include: { properties: true },
  });
  const visits = [];
  for (const p of customer.properties) {
    visits.push(await prisma.visit.create({ data: { customerId: customer.id, propertyId: p.id, mode: "service_call", jobType: "Panel upgrade" } }));
  }
  return { customer, properties: customer.properties, visits };
}

const email = (subject: string, over: Record<string, unknown> = {}) =>
  prisma.emailDelivery.create({ data: { provider: "resend", to: "jane@example.com", subject: `${TAG} ${subject}`, kind: "communication", status: "delivered", ...over } });

const ofType = <T extends TimelineEntry["type"]>(entries: TimelineEntry[], type: T) =>
  entries.filter((e): e is Extract<TimelineEntry, { type: T }> => e.type === type);

describe("the account's conversation", () => {
  it("holds the notes, the emails from every door and the hub's messages, newest first", async () => {
    const { customer, visits } = await makeAccount("Everything");
    const visit = visits[0]!;
    const lead = await prisma.lead.create({ data: { name: `${TAG} Everything lead`, customerId: customer.id } });
    await prisma.customerNote.create({ data: { customerId: customer.id, body: "Called about the kitchen.", takenBy: "Eric", createdAt: new Date("2026-11-01T10:00:00Z"), updatedAt: new Date("2026-11-01T10:00:00Z") } });
    await email("by account", { customerId: customer.id, createdAt: new Date("2026-11-02T10:00:00Z") });
    await email("by job", { visitId: visit.id, createdAt: new Date("2026-11-03T10:00:00Z") });
    await email("by lead", { leadId: lead.id, createdAt: new Date("2026-11-04T10:00:00Z") });
    const thread = await ensureThreadFor({ customerId: customer.id });
    await createMessageRow(prisma, {
      threadId: thread.id, authorType: "ai_agent", authorDisplay: "RCE Admin", channel: "in_app", direction: "internal", status: "pending_approval",
      body: "Draft: confirming Tuesday.",
    });

    const t = await buildTimeline(owner, { customerId: customer.id });
    expect(t.readOnly).toBe(false);
    expect(t.scope).toMatchObject({ customerId: customer.id, name: `${TAG} Everything` });
    expect(ofType(t.entries, "note")).toHaveLength(1);
    expect(ofType(t.entries, "email").map((e) => e.email.subject).sort()).toEqual([`${TAG} by account`, `${TAG} by job`, `${TAG} by lead`]);
    expect(ofType(t.entries, "message")).toHaveLength(1);
    // newest first
    const times = t.entries.map((e) => e.at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("shows the lead-era emails on the account once the lead has become one", async () => {
    const { customer } = await makeAccount("Convert");
    const lead = await prisma.lead.create({ data: { name: `${TAG} Convert lead` } });
    await email("before the account", { leadId: lead.id });
    const before = await buildTimeline(owner, { customerId: customer.id });
    expect(ofType(before.entries, "email")).toHaveLength(0);

    await prisma.lead.update({ where: { id: lead.id }, data: { customerId: customer.id } });
    const after = await buildTimeline(owner, { customerId: customer.id });
    expect(ofType(after.entries, "email").map((e) => e.email.subject)).toEqual([`${TAG} before the account`]);
    // and the lead's own drawer reads the account's conversation, not a second copy
    const fromLead = await buildTimeline(owner, { leadId: lead.id });
    expect(fromLead.scope.customerId).toBe(customer.id);
    expect(ofType(fromLead.entries, "email")).toHaveLength(1);
  });

  it("shows an email a hub message sent ONCE, as the message, with its delivery status", async () => {
    const { customer } = await makeAccount("Once");
    const delivery = await email("sent through the hub", { customerId: customer.id, status: "bounced" });
    const other = await email("sent the old way", { customerId: customer.id });
    const thread = await ensureThreadFor({ customerId: customer.id });
    await createMessageRow(prisma, {
      threadId: thread.id, authorType: "office", authorDisplay: "Kyle", channel: "email", direction: "outbound", status: "sent",
      body: "Hello", subject: `${TAG} sent through the hub`, emailDeliveryId: delivery.id,
    });

    const t = await buildTimeline(owner, { customerId: customer.id });
    const emails = ofType(t.entries, "email");
    expect(emails.map((e) => e.id)).toEqual([`email:${other.id}`]);
    const messages = ofType(t.entries, "message");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.message.emailDelivery).toMatchObject({ id: delivery.id, status: "bounced" });
  });

  it("is a line for a website chat with its message count, and nothing for a lead with no chat", async () => {
    const { customer } = await makeAccount("Chat");
    const lead = await prisma.lead.create({ data: { name: `${TAG} Chat lead`, customerId: customer.id } });
    await prisma.bookingChat.create({
      data: { token: `${TAG}-chat-${Date.now()}`, leadId: lead.id, status: "confirmed", transcriptJson: JSON.stringify([{ role: "user" }, { role: "assistant" }, { role: "user" }]) },
    });
    const t = await buildTimeline(owner, { customerId: customer.id });
    const chats = ofType(t.entries, "web_chat");
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ leadId: lead.id, count: 3 });
  });

  it("shows a deleted message as a tombstone with no text", async () => {
    const { customer } = await makeAccount("Deleted");
    const thread = await ensureThreadFor({ customerId: customer.id });
    const row = await createMessageRow(prisma, {
      threadId: thread.id, authorType: "office", authorKey: "owner", authorDisplay: "Kyle", channel: "in_app", direction: "internal", status: "posted", body: "Secret words",
    });
    await softDeleteMessage(owner, row.id, "Wrong customer");
    const t = await buildTimeline(owner, { customerId: customer.id });
    const m = ofType(t.entries, "message")[0]!.message;
    expect(m).toMatchObject({ deleted: true, body: null, deletedBy: "Kyle", deletedReason: "Wrong customer" });
    expect(JSON.stringify(t)).not.toContain("Secret words");
  });
});

describe("a lead with no account", () => {
  it("has its own conversation: its emails and its chat, no notes", async () => {
    const lead = await prisma.lead.create({ data: { name: `${TAG} Solo lead` } });
    await email("to a lead", { leadId: lead.id });
    await prisma.bookingChat.create({ data: { token: `${TAG}-solo-${Date.now()}`, leadId: lead.id, transcriptJson: "[]" } });
    const t = await buildTimeline(owner, { leadId: lead.id });
    expect(t.scope).toMatchObject({ customerId: null, leadId: lead.id, name: `${TAG} Solo lead` });
    expect(ofType(t.entries, "email")).toHaveLength(1);
    expect(ofType(t.entries, "web_chat")).toHaveLength(1);
    expect(ofType(t.entries, "note")).toHaveLength(0);
  });
});

describe("the job and the property", () => {
  it("shows a job-tagged note on the job and the property, and an untagged one on the job's account view only", async () => {
    const { customer, visits, properties } = await makeAccount("Tagged", ["12 Main St", "99 Other Rd"]);
    const [a, b] = visits as [typeof visits[0], typeof visits[0]];
    await prisma.customerNote.create({ data: { customerId: customer.id, visitId: a.id, body: "Gate code 4411", takenBy: "Eric" } });
    await prisma.customerNote.create({ data: { customerId: customer.id, visitId: b.id, body: "Dog at the other house", takenBy: "Eric" } });
    await prisma.customerNote.create({ data: { customerId: customer.id, body: "Prefers mornings", takenBy: "Eric" } });
    await email("about job A", { visitId: a.id });
    await email("about job B", { visitId: b.id });

    // The job drawer reads the whole account conversation (what the last caller said, whichever job).
    const job = await buildTimeline(owner, { visitId: a.id });
    expect(ofType(job.entries, "note")).toHaveLength(3);
    expect(job.entries.find((e) => e.type === "note" && e.note.body === "Gate code 4411")?.visitId).toBe(a.id);
    expect(job.entries.find((e) => e.type === "note" && e.note.body === "Gate code 4411")?.jobLabel).toBe("Panel upgrade — 12 Main St");

    // The property page: only entries tagged to jobs at THIS address, and read-only.
    const prop = await buildTimeline(owner, { propertyId: properties[0]!.id });
    expect(prop.readOnly).toBe(true);
    expect(ofType(prop.entries, "note").map((e) => e.note.body)).toEqual(["Gate code 4411"]);
    expect(ofType(prop.entries, "email").map((e) => e.email.subject)).toEqual([`${TAG} about job A`]);
    expect(prop.scope.customerId).toBe(customer.id);
  });

  it("carries the job's crew thread and how many messages in it are new", async () => {
    const { visits } = await makeAccount("Crew");
    const visit = visits[0]!;
    const before = await buildTimeline(owner, { visitId: visit.id });
    expect(before.crewThread).toBeNull();

    const crew = await ensureThreadFor({ visitId: visit.id });
    await createMessageRow(prisma, {
      threadId: crew.id, authorType: "tech", authorKey: "tech:someone", authorDisplay: "Eric", channel: "in_app", direction: "internal", status: "posted", body: "On site",
    });
    const after = await buildTimeline(owner, { visitId: visit.id });
    expect(after.crewThread).toEqual({ id: crew.id, unread: 1 });
  });

  it("refuses a record that does not exist", async () => {
    for (const target of [{ customerId: "nope" }, { leadId: "nope" }, { visitId: "nope" }, { propertyId: "nope" }]) {
      await expect(buildTimeline(owner, target)).rejects.toMatchObject({ name: "HubError", status: 404 });
    }
  });
});
