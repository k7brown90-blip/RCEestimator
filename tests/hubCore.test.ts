/**
 * The Messages hub data core (work order agent-team, U1).
 *
 * Pinned here: the send-type registry (class and purposeKey derived, no review entry); the ONE
 * row-create function (ignores a smuggled class, refuses an outbound text with no send type); one
 * thread per account / job / person; a lead's thread joining the account's at conversion (all three
 * ways: the service, and the real convert route); who may see which thread (owner, a login, the AI
 * admin, a technician, an agent key with a thread-kind limit); posting by people and by agents; unread
 * counts; edit and soft delete with their audit rows; and that the audit is append-only in the
 * database itself (the trigger globalSetup installs).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Request } from "express";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
vi.mock("stripe", () => ({ default: class MockStripe { constructor() { throw new Error("Stripe must not be constructed in tests"); } } }));
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 { setCredentials() {} }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }) },
        events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }), delete: vi.fn().mockResolvedValue({}) },
      }),
    },
  };
});
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: vi.fn().mockResolvedValue(true), sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import {
  HubError, createMessageRow, editOwnMessage, ensureTeamThread, ensureThreadFor, findVisibleThread, hubAudit,
  markThreadRead, mergeLeadThread, postMessage, readerFor, readerKeyFor, setThreadStatus, softDeleteMessage,
  unreadCounts, visibleThreadWhere, type HubReader,
} from "../src/services/hub";
import { subscribeHub, type HubBusEvent } from "../src/services/hubBus";
import { MESSAGE_CATEGORY_LIST, messageCategoryFor, registryProblems } from "../shared/hub/messageCategories";

const TAG = "HubCore";

const owner: HubReader = { key: "owner", kind: "owner", display: "Kyle", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: true };
const aiAdmin: HubReader = { key: "ai-admin", kind: "ai-admin", display: "AI admin", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false };
const tech = (id: string, name = "Tech"): HubReader => ({ key: `tech:${id}`, kind: "tech", display: name, technicianId: id, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false });
const agent = (id: string, role: string, kinds: string[] = []): HubReader => ({ key: `agent:${id}`, kind: "agent", display: `${role} key`, technicianId: null, threadKinds: kinds, agentRole: role, agentKeyId: id, agentScopes: ["hub:read", "hub:draft", "team:reply", "dev:read", "training:read", "training:write"], isKyle: false });

const techIds: string[] = [];

async function makeTech(name: string) {
  const t = await prisma.technician.create({ data: { name: `${TAG} ${name}`, accessToken: `hubcore-${name}-${Math.random().toString(36).slice(2)}` } });
  techIds.push(t.id);
  return t;
}

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

async function wipe() {
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = customers.map((c) => c.id);
  await prisma.hubThread.deleteMany({ where: { OR: [{ title: { startsWith: TAG } }, { customerId: { in: ids } }, { technicianId: { in: techIds } }] } });
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
  if (ids.length > 0) {
    await prisma.visit.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.property.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.hubThread.deleteMany({ where: { technicianId: { in: techIds } } });
  await prisma.technician.deleteMany({ where: { id: { in: techIds.splice(0) } } });
}

beforeAll(wipe);
beforeEach(wipe);
afterAll(wipe);

describe("the send-type registry", () => {
  it("is self-consistent, and has no review-request entry", () => {
    expect(registryProblems()).toEqual([]);
    expect(MESSAGE_CATEGORY_LIST.some((c) => /review/i.test(c.key) || /review/i.test(c.purposeKey ?? ""))).toBe(false);
  });

  it("derives class and purpose from the key", () => {
    expect(messageCategoryFor("opt_in_confirmation")).toMatchObject({ messageClass: "transactional", purposeKey: "text_alerts_confirmed" });
    expect(messageCategoryFor("lead_first_response")).toMatchObject({ messageClass: "transactional", purposeKey: "request_received" });
    expect(messageCategoryFor("internal_alert")).toMatchObject({ messageClass: "internal", purposeKey: null });
    expect(messageCategoryFor("nope")).toBeNull();
  });

  it("flags a broken registry (a transactional entry with no purpose, a review entry)", () => {
    const bad = [
      { key: "x", label: "x", messageClass: "transactional", purposeKey: null, footer: "first", autoSendEligible: false },
      { key: "review_request", label: "r", messageClass: "internal", purposeKey: null, footer: "never", autoSendEligible: false },
    ] as const;
    const problems = registryProblems(bad as never);
    expect(problems.some((p) => /needs a real purposeKey/.test(p))).toBe(true);
    expect(problems.some((p) => /never texted/.test(p))).toBe(true);
  });
});

describe("createMessageRow, the one row-create function", () => {
  it("derives messageClass and purposeKey from category and ignores any a caller supplies", async () => {
    const { customer } = await makeAccount("Row");
    const thread = await ensureThreadFor({ customerId: customer.id });
    const row = await createMessageRow(prisma, {
      threadId: thread.id, authorType: "system", authorDisplay: "System", channel: "sms", direction: "outbound", status: "sent",
      body: "Reminder", category: "visit_reminder", toPhone: "+1 (615) 903-5947",
      // A request body trying to choose its own class and purpose. Not part of the input type; cast to get it in.
      ...({ messageClass: "marketing", purposeKey: "request_received" } as object),
    });
    expect(row.messageClass).toBe("transactional");
    expect(row.purposeKey).toBe("appointment_reminder");
    expect(row.toPhone10).toBe("6159035947");
  });

  it("refuses an outbound text with no send type, and an unknown send type", async () => {
    const { customer } = await makeAccount("Refuse");
    const thread = await ensureThreadFor({ customerId: customer.id });
    const base = { threadId: thread.id, authorType: "system", authorDisplay: "System", channel: "sms", direction: "outbound", status: "sent", body: "Hi" };
    await expect(createMessageRow(prisma, base)).rejects.toMatchObject({ name: "HubError", status: 400 });
    await expect(createMessageRow(prisma, { ...base, category: "made_up" })).rejects.toBeInstanceOf(HubError);
    // An INBOUND text, and an in-app note, need none.
    const inbound = await createMessageRow(prisma, { ...base, direction: "inbound", status: "received", authorType: "customer" });
    expect(inbound.messageClass).toBeNull();
    const note = await createMessageRow(prisma, { ...base, channel: "in_app", direction: "internal", status: "posted" });
    expect(note.category).toBeNull();
  });

  it("refuses an unknown status, author type, channel or direction", async () => {
    const { customer } = await makeAccount("Vocab");
    const thread = await ensureThreadFor({ customerId: customer.id });
    const ok = { threadId: thread.id, authorType: "office", authorDisplay: "K", channel: "in_app", direction: "internal", status: "posted", body: "x" };
    for (const bad of [{ status: "sent_ish" }, { authorType: "robot" }, { channel: "pigeon" }, { direction: "sideways" }]) {
      await expect(createMessageRow(prisma, { ...ok, ...bad })).rejects.toBeInstanceOf(HubError);
    }
  });

  it("keeps every later column: blocked and the card fields round-trip, and a provider id is unique", async () => {
    const { customer } = await makeAccount("Columns");
    const thread = await ensureThreadFor({ customerId: customer.id });
    const when = new Date("2026-11-23T15:00:00Z");
    const row = await createMessageRow(prisma, {
      threadId: thread.id, authorType: "system", authorDisplay: "System", channel: "sms", direction: "outbound", status: "blocked",
      body: "x", category: "visit_reminder", toPhone: "6159035947", error: "quiet_hours", heldReason: "quiet_hours",
      sentText: "Red Cedar Electric: Appointment Reminder", footerIncluded: true, headerAt: when, eventStart: when, eventEnd: when,
      actionKind: "contact_instead", actionPayloadJson: "{}", sendAfter: when, providerMessageId: "SM_unique_1",
    });
    expect(row).toMatchObject({ status: "blocked", error: "quiet_hours", footerIncluded: true, actionKind: "contact_instead", providerMessageId: "SM_unique_1" });
    await expect(createMessageRow(prisma, {
      threadId: thread.id, authorType: "customer", authorDisplay: "C", channel: "sms", direction: "inbound", status: "received", body: "y", providerMessageId: "SM_unique_1",
    })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("one thread per record", () => {
  it("gives an account one thread, even when two callers ask at once", async () => {
    const { customer } = await makeAccount("Once");
    const [a, b] = await Promise.all([ensureThreadFor({ customerId: customer.id }), ensureThreadFor({ customerId: customer.id })]);
    expect(a.id).toBe(b.id);
    expect(await prisma.hubThread.count({ where: { customerId: customer.id, kind: "customer" } })).toBe(1);
    expect(a.title).toBe(`${TAG} Once`);
  });

  it("gives a job its crew thread and an account its own, separately", async () => {
    const { customer, visit } = await makeAccount("Job");
    const job = await ensureThreadFor({ visitId: visit.id });
    const account = await ensureThreadFor({ customerId: customer.id });
    expect(job.kind).toBe("job");
    expect(account.kind).toBe("customer");
    expect(job.id).not.toBe(account.id);
    expect((await ensureThreadFor({ visitId: visit.id })).id).toBe(job.id);
  });

  it("gives each person ONE Team thread, and the database refuses a second", async () => {
    const kyle = await makeTech("Kyle");
    const michael = await makeTech("Michael");
    const k1 = await ensureTeamThread(kyle.id);
    const k2 = await ensureTeamThread(kyle.id);
    const m1 = await ensureTeamThread(michael.id);
    expect(k1.id).toBe(k2.id);
    expect(m1.id).not.toBe(k1.id);
    await expect(prisma.hubThread.create({ data: { kind: "team", title: "dup", technicianId: kyle.id } })).rejects.toMatchObject({ code: "P2002" });
    await expect(ensureTeamThread("no-such-person")).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a record that does not exist", async () => {
    await expect(ensureThreadFor({ customerId: "nope" })).rejects.toMatchObject({ status: 404 });
    await expect(ensureThreadFor({ leadId: "nope" })).rejects.toMatchObject({ status: 404 });
    await expect(ensureThreadFor({ visitId: "nope" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("a lead's conversation joins the account's at conversion", () => {
  async function leadWithMessage(suffix: string, extra: Record<string, unknown> = {}) {
    const lead = await prisma.lead.create({ data: { name: `${TAG} ${suffix}`, phone: "6155550100", ...extra } });
    const thread = await ensureThreadFor({ leadId: lead.id });
    const msg = await createMessageRow(prisma, {
      threadId: thread.id, authorType: "customer", authorDisplay: "Caller", channel: "sms", direction: "inbound", status: "received", body: "Do you do panels?",
    });
    return { lead, thread, msg };
  }

  it("asks for a lead whose account exists and gets the account's thread", async () => {
    const { customer } = await makeAccount("Linked");
    const lead = await prisma.lead.create({ data: { name: `${TAG} Linked lead`, customerId: customer.id } });
    expect((await ensureThreadFor({ leadId: lead.id })).customerId).toBe(customer.id);
  });

  it("re-keys the lead's thread to the account when the account has none, with an audit row", async () => {
    const { customer } = await makeAccount("Rekey");
    const { lead, thread, msg } = await leadWithMessage("Rekey lead");
    const out = await prisma.$transaction((tx) => mergeLeadThread(tx, { leadId: lead.id, customerId: customer.id }));
    expect(out).toMatchObject({ action: "rekeyed", threadId: thread.id });
    const after = await prisma.hubThread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(after).toMatchObject({ customerId: customer.id, leadId: null });
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: msg.id } })).threadId).toBe(thread.id);
    const audit = await prisma.hubAuditLog.findFirst({ where: { threadId: thread.id, action: "thread_merged" } });
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.detailsJson!)).toMatchObject({ how: "rekeyed", leadId: lead.id });
  });

  it("moves the lead's messages onto the account's existing thread and removes the empty one", async () => {
    const { customer } = await makeAccount("Merge");
    const accountThread = await ensureThreadFor({ customerId: customer.id });
    const { lead, thread, msg } = await leadWithMessage("Merge lead");
    const out = await prisma.$transaction((tx) => mergeLeadThread(tx, { leadId: lead.id, customerId: customer.id }));
    expect(out).toMatchObject({ action: "merged", threadId: accountThread.id, moved: 1 });
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: msg.id } })).threadId).toBe(accountThread.id);
    expect(await prisma.hubThread.findUnique({ where: { id: thread.id } })).toBeNull();
    // Nothing to merge is a no-op, not an error.
    const none = await prisma.$transaction((tx) => mergeLeadThread(tx, { leadId: "no-thread", customerId: customer.id }));
    expect(none.action).toBe("none");
  });

  it("happens inside the real convert route: the lead's message ends up on the new account's thread", async () => {
    const { lead, thread, msg } = await leadWithMessage("Route lead", {
      addressLine1: "9 Convert Ln", city: "Franklin", state: "TN", postalCode: "37064",
    });
    const res = await request(app).patch(`/leads/${lead.id}/convert`).send({ createNewAccount: true }).expect(200);
    const customerId = res.body.customer.id as string;
    const moved = await prisma.hubMessage.findUniqueOrThrow({ where: { id: msg.id }, include: { thread: true } });
    expect(moved.thread).toMatchObject({ kind: "customer", customerId });
    expect(moved.threadId).toBe(thread.id); // no account thread existed, so the lead's was re-keyed
    // Clean up what the route made.
    await prisma.hubThread.deleteMany({ where: { customerId } });
    await prisma.visit.deleteMany({ where: { customerId } });
    await prisma.property.deleteMany({ where: { customerId } });
    await prisma.lead.update({ where: { id: lead.id }, data: { customerId: null, propertyId: null, visitId: null } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
  });
});

describe("linking a lead to an existing account (PATCH /leads/:id)", () => {
  it("moves the lead's earlier conversation onto the account's thread instead of stranding it", async () => {
    const { customer } = await makeAccount("Link target");
    const accountThread = await ensureThreadFor({ customerId: customer.id });
    const lead = await prisma.lead.create({ data: { name: `${TAG} Link lead`, phone: "6155550122" } });
    const leadThread = await ensureThreadFor({ leadId: lead.id });
    expect(leadThread.id).not.toBe(accountThread.id);
    const msg = await createMessageRow(prisma, {
      threadId: leadThread.id, authorType: "customer", authorDisplay: "Caller", channel: "sms", direction: "inbound", status: "received", body: "Before I was linked",
    });

    await request(app).patch(`/leads/${lead.id}`).send({ customerId: customer.id }).expect(200);

    expect((await ensureThreadFor({ leadId: lead.id })).id).toBe(accountThread.id);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: msg.id } })).threadId).toBe(accountThread.id);
    expect(await prisma.hubThread.findUnique({ where: { id: leadThread.id } })).toBeNull();
    const audit = await prisma.hubAuditLog.findFirst({ where: { threadId: accountThread.id, action: "thread_merged" } });
    expect(JSON.parse(audit!.detailsJson!)).toMatchObject({ how: "merged", leadId: lead.id });
  });

  it("re-keys the lead's thread to the account when the account has no thread yet, and leaves other edits alone", async () => {
    const { customer } = await makeAccount("Link rekey");
    const lead = await prisma.lead.create({ data: { name: `${TAG} Link rekey lead` } });
    const leadThread = await ensureThreadFor({ leadId: lead.id });
    await request(app).patch(`/leads/${lead.id}`).send({ customerId: customer.id }).expect(200);
    expect(await prisma.hubThread.findUniqueOrThrow({ where: { id: leadThread.id } })).toMatchObject({ customerId: customer.id, leadId: null });
    // A later edit that does not change the link touches no thread; unlinking keeps the account's thread.
    await request(app).patch(`/leads/${lead.id}`).send({ notes: "just a note" }).expect(200);
    await request(app).patch(`/leads/${lead.id}`).send({ customerId: null }).expect(200);
    expect((await prisma.hubThread.findUniqueOrThrow({ where: { id: leadThread.id } })).customerId).toBe(customer.id);
  });
});

describe("deleting the empty account a lead became", () => {
  it("sends the conversation back to the lead instead of deleting it with the account", async () => {
    const lead = await prisma.lead.create({
      data: { name: `${TAG} Stub lead`, phone: "6155550111", addressLine1: "3 Stub Ln", city: "Franklin", state: "TN", postalCode: "37064" },
    });
    const thread = await ensureThreadFor({ leadId: lead.id });
    const msg = await createMessageRow(prisma, {
      threadId: thread.id, authorType: "customer", authorDisplay: "Caller", channel: "sms", direction: "inbound", status: "received", body: "Can you come Monday?",
    });
    const res = await request(app).patch(`/leads/${lead.id}/convert`).send({ createNewAccount: true }).expect(200);
    const customerId = res.body.customer.id as string;
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: msg.id }, include: { thread: true } })).thread.customerId).toBe(customerId);

    await request(app).delete(`/accounts/${customerId}`).expect(204);

    const after = await prisma.hubMessage.findUniqueOrThrow({ where: { id: msg.id }, include: { thread: true } });
    expect(after.thread).toMatchObject({ customerId: null, leadId: lead.id, kind: "customer" });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("new");
    const audit = await prisma.hubAuditLog.findFirst({ where: { threadId: thread.id, action: "thread_merged" }, orderBy: { at: "desc" } });
    expect(JSON.parse(audit!.detailsJson!)).toMatchObject({ how: "returned_to_lead", leadId: lead.id });
  });

  it("an account that never came from a lead takes its thread with it, like its notes", async () => {
    const { customer, visit } = await makeAccount("Plain delete");
    await prisma.visit.delete({ where: { id: visit.id } });
    const thread = await ensureThreadFor({ customerId: customer.id });
    await request(app).delete(`/accounts/${customer.id}`).expect(204);
    expect(await prisma.hubThread.findUnique({ where: { id: thread.id } })).toBeNull();
  });
});

describe("who may see which thread", () => {
  async function fixture() {
    const kyle = await makeTech("Owner person");
    const a = await makeTech("A");
    const b = await makeTech("B");
    const { customer, visit } = await makeAccount("Vis");
    const other = await makeAccount("Vis other");
    await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId: a.id } });
    const customerThread = await ensureThreadFor({ customerId: customer.id });
    const jobMine = await ensureThreadFor({ visitId: visit.id });
    const jobOther = await ensureThreadFor({ visitId: other.visit.id });
    const teamA = await ensureTeamThread(a.id);
    const teamB = await ensureTeamThread(b.id);
    const dev = await prisma.hubThread.create({ data: { kind: "dev", title: `${TAG} dev ticket` } });
    const trainA = await prisma.hubThread.create({ data: { kind: "training", title: `${TAG} training A`, technicianId: a.id } });
    const trainB = await prisma.hubThread.create({ data: { kind: "training", title: `${TAG} training B`, technicianId: b.id } });
    const all = [customerThread, jobMine, jobOther, teamA, teamB, dev, trainA, trainB];
    return { kyle, a, b, all, ids: { customerThread: customerThread.id, jobMine: jobMine.id, jobOther: jobOther.id, teamA: teamA.id, teamB: teamB.id, dev: dev.id, trainA: trainA.id, trainB: trainB.id } };
  }

  const seen = async (reader: HubReader, among: string[]) =>
    (await prisma.hubThread.findMany({ where: { AND: [{ id: { in: among } }, visibleThreadWhere(reader)] }, select: { id: true } })).map((t) => t.id).sort();

  it("lets the owner, a CRM login and the AI admin see every thread", async () => {
    const f = await fixture();
    const every = f.all.map((t) => t.id).sort();
    expect(await seen(owner, every)).toEqual(every);
    expect(await seen({ ...owner, key: "user:abc", kind: "user" }, every)).toEqual(every);
    expect(await seen(aiAdmin, every)).toEqual(every);
  });

  it("gives a technician their assigned job, their OWN Team thread and their own Training thread, nothing else", async () => {
    const f = await fixture();
    const everyId = f.all.map((t) => t.id);
    expect(await seen(tech(f.a.id), everyId)).toEqual([f.ids.jobMine, f.ids.teamA, f.ids.trainA].sort());
    expect(await seen(tech(f.b.id), everyId)).toEqual([f.ids.teamB, f.ids.trainB].sort());
    // Never a Dev thread, never another person's Team thread, never a customer thread.
    const a = tech(f.a.id);
    expect(await findVisibleThread(a, f.ids.dev)).toBeNull();
    expect(await findVisibleThread(a, f.ids.teamB)).toBeNull();
    expect(await findVisibleThread(a, f.ids.customerThread)).toBeNull();
    // A technician with no person id sees nothing.
    expect(await seen({ ...a, technicianId: null }, everyId)).toEqual([]);
  });

  it("limits an agent key to its hubThreadKinds (Scout training only, Claude Code dev only, empty means all)", async () => {
    const f = await fixture();
    const everyId = f.all.map((t) => t.id);
    expect(await seen(agent("k1", "scout", ["training"]), everyId)).toEqual([f.ids.trainA, f.ids.trainB].sort());
    expect(await seen(agent("k2", "claude_code", ["dev"]), everyId)).toEqual([f.ids.dev]);
    expect(await seen(agent("k3", "admin"), everyId)).toEqual([...everyId].sort());
    expect(await findVisibleThread(agent("k1", "scout", ["training"]), f.ids.customerThread)).toBeNull();
  });

  it("reads the reader out of a request: agent, technician, CRM login, AI admin, owner, gate-disabled", () => {
    const req = (o: object) => o as unknown as Request;
    const scout = { keyId: "K9", name: "Scout", role: "scout", hubThreadKinds: ["training"], scopes: ["hub:read", "training:read"] };
    expect(readerKeyFor(req({ agentPrincipal: scout }))).toBe("agent:K9");
    expect(readerFor(req({ agentPrincipal: scout }))).toMatchObject({ threadKinds: ["training"], agentScopes: ["hub:read", "training:read"] });
    expect(readerKeyFor(req({ technician: { id: "T1", name: "Eric" } }))).toBe("tech:T1");
    expect(readerKeyFor(req({ _crmLogin: { id: "L1", technicianId: "T2", name: "Michael" }, _authActor: "user:L1" }))).toBe("user:L1");
    expect(readerFor(req({ _crmLogin: { id: "L1", technicianId: "T2", name: "Michael" } }))?.technicianId).toBe("T2");
    expect(readerKeyFor(req({ _authActor: "ai-admin" }))).toBe("ai-admin");
    expect(readerKeyFor(req({ _authActor: "owner" }))).toBe("owner");
    expect(readerKeyFor(req({ _authOutcome: "gate-disabled" }))).toBe("owner");
    expect(readerKeyFor(req({}))).toBeNull();
  });
});

describe("posting", () => {
  it("posts a person's message as posted, moves the thread's last message time and writes the audit", async () => {
    const kyle = await makeTech("Poster");
    const team = await ensureTeamThread(kyle.id);
    const before = team.lastMessageAt;
    const msg = await postMessage(tech(kyle.id, "Kyle"), { threadId: team.id, body: "  Need 12-2 Romex on the truck  " });
    expect(msg).toMatchObject({ status: "posted", authorType: "tech", channel: "in_app", direction: "internal", body: "Need 12-2 Romex on the truck", authorKey: `tech:${kyle.id}`, authorTechnicianId: kyle.id });
    const thread = await prisma.hubThread.findUniqueOrThrow({ where: { id: team.id } });
    expect(thread.lastMessageAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    const audit = await prisma.hubAuditLog.findFirst({ where: { messageId: msg.id, action: "message_created" } });
    expect(audit).toMatchObject({ actorKey: `tech:${kyle.id}`, entityType: "message", entityId: msg.id, threadId: team.id });
  });

  it("refuses empty text and a thread the reader cannot see (404, not 403)", async () => {
    const a = await makeTech("PA");
    const b = await makeTech("PB");
    const teamB = await ensureTeamThread(b.id);
    await expect(postMessage(tech(a.id), { threadId: teamB.id, body: "hi" })).rejects.toMatchObject({ status: 404 });
    const teamA = await ensureTeamThread(a.id);
    await expect(postMessage(tech(a.id), { threadId: teamA.id, body: "   " })).rejects.toMatchObject({ status: 400 });
  });

  it("makes an agent's post wait for approval, never posted or approved, and never into a customer thread", async () => {
    const kyle = await makeTech("AgentTarget");
    const team = await ensureTeamThread(kyle.id);
    const { customer } = await makeAccount("AgentCust");
    const customerThread = await ensureThreadFor({ customerId: customer.id });
    const key = agent("key-1", "admin");
    const waiting = await postMessage(key, { threadId: team.id, body: "Draft" });
    expect(waiting).toMatchObject({ status: "pending_approval", authorType: "ai_agent", authorBotKeyId: "key-1" });
    expect((await postMessage(key, { threadId: team.id, body: "Draft 2", status: "draft" })).status).toBe("draft");
    await expect(postMessage(key, { threadId: team.id, body: "Sneaky", status: "approved" })).rejects.toMatchObject({ status: 403 });
    await expect(postMessage(key, { threadId: team.id, body: "Sneaky", status: "posted" })).rejects.toMatchObject({ status: 403 });
    await expect(postMessage(key, { threadId: customerThread.id, body: "Hello customer" })).rejects.toMatchObject({ status: 403 });
  });

  it("posts Claude Code's reply in a Dev thread at once, whatever it asks for", async () => {
    const dev = await prisma.hubThread.create({ data: { kind: "dev", title: `${TAG} dev` } });
    const claude = agent("key-claude", "claude_code", ["dev"]);
    const msg = await postMessage(claude, { threadId: dev.id, body: "Fixed in main", status: "draft" });
    expect(msg).toMatchObject({ status: "posted", authorType: "claude", direction: "internal" });
    // And a different key limited to dev cannot reach any other kind.
    const team = await ensureTeamThread((await makeTech("NotDev")).id);
    await expect(postMessage(claude, { threadId: team.id, body: "x" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("unread counts and read state", () => {
  it("counts others' readable messages, not the reader's own, not deleted, not drafts; markThreadRead clears it", async () => {
    const a = await makeTech("UA");
    const team = await ensureTeamThread(a.id);
    const me = tech(a.id, "Me");
    await postMessage(me, { threadId: team.id, body: "mine" });
    expect((await unreadCounts(me)).total).toBe(0);

    // The AI admin stands in for a second voice in this person's Team thread: an office person may not post in another's.
    const kyle: HubReader = { ...owner, key: "ai-admin", kind: "ai-admin", display: "AI admin", isKyle: false };
    const m1 = await postMessage(kyle, { threadId: team.id, body: "from Kyle 1" });
    await postMessage(kyle, { threadId: team.id, body: "from Kyle 2" });
    await postMessage(agent("k", "admin"), { threadId: team.id, body: "a draft" });
    const gone = await postMessage(kyle, { threadId: team.id, body: "oops" });
    await softDeleteMessage(kyle, gone.id, "typo");
    expect(await unreadCounts(me)).toEqual({ total: 2, byThread: { [team.id]: 2 } });
    // The owner has not opened it either, but their own two do not count for them; the tech's one does.
    expect((await unreadCounts(kyle)).byThread[team.id]).toBe(1);

    await markThreadRead(me, team.id);
    expect((await unreadCounts(me)).total).toBe(0);
    await new Promise((r) => setTimeout(r, 15));
    await postMessage(kyle, { threadId: team.id, body: "from Kyle 3" });
    expect((await unreadCounts(me)).total).toBe(1);
    expect(m1.id).toBeTruthy();
    // A thread you cannot see cannot be marked read.
    const other = await ensureTeamThread((await makeTech("UB")).id);
    await expect(markThreadRead(me, other.id)).rejects.toMatchObject({ status: 404 });
  });

  it("shows a reader only the unread of threads they may see", async () => {
    const a = await makeTech("Scope A");
    const b = await makeTech("Scope B");
    const teamB = await ensureTeamThread(b.id);
    await postMessage({ ...owner, key: "ai-admin", kind: "ai-admin", display: "AI admin", isKyle: false }, { threadId: teamB.id, body: "for B" });
    expect((await unreadCounts(tech(a.id))).total).toBe(0);
    expect((await unreadCounts(tech(b.id))).total).toBe(1);
  });
});

describe("edit, delete and the exits", () => {
  it("lets an author edit their own posted message, with before and after in the audit; not another's", async () => {
    const a = await makeTech("Ed");
    const team = await ensureTeamThread(a.id);
    const me = tech(a.id);
    const msg = await postMessage(me, { threadId: team.id, body: "first" });
    const edited = await editOwnMessage(me, msg.id, "second");
    expect(edited).toMatchObject({ body: "second" });
    expect(edited.editedAt).not.toBeNull();
    const audit = await prisma.hubAuditLog.findFirst({ where: { messageId: msg.id, action: "message_edited" } });
    expect(audit).toMatchObject({ beforeText: "first", afterText: "second" });
    await expect(editOwnMessage(owner, msg.id, "hijack")).rejects.toMatchObject({ status: 403 });
  });

  it("soft-deletes: the row stays, the body is kept in the audit, the files go with it", async () => {
    const a = await makeTech("Del");
    const team = await ensureTeamThread(a.id);
    const me = tech(a.id);
    const msg = await postMessage(me, { threadId: team.id, body: "a photo of the panel" });
    const att = await prisma.hubAttachment.create({ data: { threadId: team.id, messageId: msg.id, mimeType: "image/jpeg", sizeBytes: 3, data: Buffer.from([1, 2, 3]), technicianId: a.id } });
    const deleted = await softDeleteMessage(me, msg.id, "wrong job");
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted).toMatchObject({ deletedBy: `tech:${a.id}`, deletedReason: "wrong job", body: "a photo of the panel" });
    expect((await prisma.hubAttachment.findUniqueOrThrow({ where: { id: att.id } })).deletedAt).not.toBeNull();
    const audit = await prisma.hubAuditLog.findFirst({ where: { messageId: msg.id, action: "message_deleted" } });
    expect(audit?.beforeText).toBe("a photo of the panel");
    await expect(editOwnMessage(me, msg.id, "undelete")).rejects.toMatchObject({ status: 409 });
    // Another technician cannot delete it; the owner may.
    const b = await makeTech("Del B");
    const msg2 = await postMessage(me, { threadId: team.id, body: "second" });
    await expect(softDeleteMessage(tech(b.id), msg2.id, null)).rejects.toMatchObject({ status: 404 });
    await expect(softDeleteMessage({ ...owner, key: "user:other", kind: "user", isKyle: false }, msg2.id, null)).rejects.toMatchObject({ status: 403 });
    expect((await softDeleteMessage(owner, msg2.id, null)).deletedAt).not.toBeNull();
  });

  it("lets Kyle delete another person's message from his principal CRM login too, but not a plain login", async () => {
    const a = await makeTech("Del Principal");
    const team = await ensureTeamThread(a.id);
    const me = tech(a.id);
    // Kyle signed in with his own CRM login: kind "user", but isKyle (CrmLogin.isPrincipal) is true.
    const kyleLogin: HubReader = { key: "user:kyle-login", kind: "user", display: "Kyle", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: true };
    const officeLogin: HubReader = { ...kyleLogin, key: "user:office-login", display: "Office", isKyle: false };
    const first = await postMessage(me, { threadId: team.id, body: "something that should not be here" });
    await expect(softDeleteMessage(officeLogin, first.id, null)).rejects.toMatchObject({ status: 403 });
    const gone = await softDeleteMessage(kyleLogin, first.id, "removed by Kyle");
    expect(gone).toMatchObject({ deletedBy: "user:kyle-login", deletedReason: "removed by Kyle" });
    expect(gone.deletedAt).not.toBeNull();
  });

  it("readerFor marks the PIN session and a principal login as Kyle, and nobody else", () => {
    const base = { _authOutcome: "ok" };
    const asKyle = (extra: Record<string, unknown>) => readerFor({ ...base, ...extra } as unknown as Request);
    expect(asKyle({ _authActor: "owner" })?.isKyle).toBe(true);
    expect(asKyle({ _crmLogin: { id: "l1", name: "Kyle", technicianId: null, isPrincipal: true, powers: [] } })).toMatchObject({ kind: "user", isKyle: true });
    expect(asKyle({ _crmLogin: { id: "l2", name: "Office", technicianId: null, isPrincipal: false, powers: [] } })).toMatchObject({ kind: "user", isKyle: false });
    expect(asKyle({ _authActor: "ai-admin" })?.isKyle).toBe(false);
    expect(asKyle({ technician: { id: "t1", name: "Tech" } })?.isKyle).toBe(false);
  });

  it("closes and reopens a conversation with the audit, and refuses an unknown status", async () => {
    const a = await makeTech("Close");
    const team = await ensureTeamThread(a.id);
    expect((await setThreadStatus(owner, team.id, "closed")).status).toBe("closed");
    expect((await setThreadStatus(owner, team.id, "open")).status).toBe("open");
    await expect(setThreadStatus(owner, team.id, "gone")).rejects.toBeInstanceOf(HubError);
    const rows = await prisma.hubAuditLog.findMany({ where: { threadId: team.id, action: "thread_status" }, orderBy: { at: "asc" } });
    expect(rows.map((r) => [r.beforeText, r.afterText])).toEqual([["open", "closed"], ["closed", "open"]]);
  });
});

describe("every path that writes what the registry protects", () => {
  it("only createMessageRow creates a HubMessage, and nothing but it sets messageClass or purposeKey", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const creators: string[] = [];
    const classWriters: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!full.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf8");
        const isHub = full.endsWith(join("services", "hub.ts"));
        if (/hubMessage\.(create|createMany|upsert)/.test(text) && !isHub) creators.push(full);
        // A write of either column: an object key assigned in a data block outside createMessageRow's own file.
        if (/(messageClass|purposeKey)\s*:/.test(text) && /hubMessage\.(update|updateMany)/.test(text)) classWriters.push(full);
      }
    };
    walk(join(__dirname, "..", "src"));
    expect(creators).toEqual([]);
    expect(classWriters).toEqual([]);
    const hub = readFileSync(join(__dirname, "..", "src", "services", "hub.ts"), "utf8");
    expect((hub.match(/hubMessage\.create\(/g) ?? []).length).toBe(1);
  });
});

describe("the audit is append-only in the database", () => {
  it("raises on UPDATE and on DELETE of a HubAuditLog row, and an insert still works", async () => {
    const id = await hubAudit(prisma, { actorKey: "owner", actorDisplay: "Kyle", action: "message_created", details: { n: 1 } });
    await expect(prisma.hubAuditLog.update({ where: { id }, data: { actorDisplay: "Someone else" } })).rejects.toThrow(/append-only/);
    await expect(prisma.hubAuditLog.delete({ where: { id } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "HubAuditLog" SET "action" = 'x' WHERE "id" = '${id}'`)).rejects.toThrow(/append-only/);
    expect((await prisma.hubAuditLog.findUniqueOrThrow({ where: { id } })).actorDisplay).toBe("Kyle");
  });

  it("is written by exactly one function: nothing else in src updates or deletes it", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!full.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf8");
        if (/hubAuditLog\.(update|updateMany|delete|deleteMany|upsert)\b/.test(text)) offenders.push(full);
        if (/hubAuditLog\.create\b/.test(text) && !full.endsWith(join("services", "hub.ts"))) offenders.push(full);
      }
    };
    walk(join(__dirname, "..", "src"));
    expect(offenders).toEqual([]);
  });
});

describe("a lead's conversation that moved tells the open screens once it has committed (U6)", () => {
  /** Collects what the live bus says while `run` does its work. */
  async function heard(run: () => Promise<void>): Promise<HubBusEvent[]> {
    const events: HubBusEvent[] = [];
    const stop = subscribeHub((e) => events.push(e));
    try { await run(); } finally { stop(); }
    return events;
  }

  it("announces the surviving thread on convert, on linking a lead to an account, and on deleting the empty account", async () => {
    // Link: the lead's thread merges into the account's existing one (the lead thread is deleted, so the account's is what is said).
    const { customer } = await makeAccount("Announce link");
    const accountThread = await ensureThreadFor({ customerId: customer.id });
    const lead = await prisma.lead.create({ data: { name: `${TAG} Announce lead`, phone: "6155550177" } });
    const leadThread = await ensureThreadFor({ leadId: lead.id });
    await createMessageRow(prisma, {
      threadId: leadThread.id, authorType: "customer", authorDisplay: "Caller", channel: "sms", direction: "inbound", status: "received", body: "Before I was linked",
    });
    const linked = await heard(async () => { await request(app).patch(`/leads/${lead.id}`).send({ customerId: customer.id }).expect(200); });
    expect(linked).toContainEqual({ type: "changed", threadId: accountThread.id, messageId: null });

    // Convert: a lead with a conversation becomes an account; its thread is re-keyed and the screens are told.
    const lead2 = await prisma.lead.create({
      data: { name: `${TAG} Announce convert`, phone: "6155550178", addressLine1: "9 Convert Ln", city: "Franklin", state: "TN", postalCode: "37064" },
    });
    const thread2 = await ensureThreadFor({ leadId: lead2.id });
    await createMessageRow(prisma, {
      threadId: thread2.id, authorType: "customer", authorDisplay: "Caller", channel: "sms", direction: "inbound", status: "received", body: "Can you come Monday?",
    });
    let customerId = "";
    const converted = await heard(async () => {
      const res = await request(app).patch(`/leads/${lead2.id}/convert`).send({ createNewAccount: true }).expect(200);
      customerId = res.body.customer.id as string;
    });
    expect(converted).toContainEqual({ type: "changed", threadId: thread2.id, messageId: null });

    // Delete the empty account the lead became: the conversation goes back to the lead and the screens are told.
    const returned = await heard(async () => { await request(app).delete(`/accounts/${customerId}`).expect(204); });
    expect(returned).toContainEqual({ type: "changed", threadId: thread2.id, messageId: null });
  });
});
