/**
 * Approve / Edit-and-approve / Reject and the Message audit log (work order agent-team, U4 + TC1/TC3 +
 * BA7): routes/hub.ts over services/hubApproval.ts, hubCards.ts and hubAuditView.ts.
 *
 * Pinned here: every decision is gated by the approve_drafts power (the AI admin and a login without it get
 * the power's sentence and nothing changes; Kyle, and a login Kyle granted it to, can); a draft is decided
 * once (a second Approve is a 409 and sends nothing); each decision writes one audit row and tells the
 * agents once, WITHOUT the reject reason or the edited words; edit keeps the original and sends the edited
 * version; Reject needs a reason; a marketing text's Approve is greyed with its reason and, if pressed, is
 * refused with one send_blocked row; the card's header line comes from the frozen class and purpose; the
 * audit log is Kyle's alone and its "Blocked texts" filter shows the reason, never a phone; and no route
 * file reaches hubSend.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

process.env.GMAIL_USER = "service@example.test";
process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
process.env.RESEND_API_KEY = "re_test_key_never_used";
delete process.env.TRANSACTIONAL_EMAIL_PROVIDER;
vi.mock("googleapis");
const mail = vi.hoisted(() => ({ sendMail: vi.fn<(opts: Record<string, unknown>) => Promise<unknown>>() }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: mail.sendMail }) } }));
const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { ensureThreadFor, type HubReader } from "../src/services/hub";
import { waitingDraft } from "./helpers/waitingDraft"; // Kyle 2026-11-24: an agent message now SENDS when posted; these tests need a card already waiting (a pre-deploy one)
import { saveCrmLogin, setPowers } from "../src/services/crmLogin";
import { saveAdminLogin } from "../src/services/adminLogin";
import { CRM_POWERS } from "../shared/crmPowers";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";

const PIN = "1234";
const PASS = "correct horse battery";
const AI_PASS = "another long password!";
const TAG = "HubApproval";
const DOMAIN = `hubapproval-${Date.now()}.example`;
const REASON = CRM_POWERS.approve_drafts.reason;
const AI: HubReader = { key: "ai-admin", kind: "ai-admin", display: "RCE Admin", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false };

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const twilioCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("api.twilio.com"));
const resendCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("api.resend.com"));

async function wipe() {
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = customers.map((c) => c.id);
  await prisma.hubThread.deleteMany({ where: { OR: [{ title: { startsWith: TAG } }, { customerId: { in: ids } }] } });
  await prisma.emailDelivery.deleteMany({ where: { to: { endsWith: `@${DOMAIN}` } } });
  if (ids.length > 0) await prisma.customer.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  process.env.PIN_HASH = await hashPin(PIN);
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "tok";
  process.env.TWILIO_SMS_NUMBER = "+16155550000";
  await wipe();
});
afterAll(async () => {
  delete process.env.PIN_HASH;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_SMS_NUMBER;
  await wipe();
  await cleanupCrmLoginFixtures();
});
beforeEach(async () => {
  await cleanupCrmLoginFixtures();
  fetchMock.mockReset();
  mail.sendMail.mockReset();
  mail.sendMail.mockResolvedValue({});
  fetchMock.mockImplementation(async (url) => {
    if (String(url).includes("api.twilio.com")) return new Response(JSON.stringify({ sid: `SM${randomUUID().replace(/-/g, "")}`, status: "queued" }), { status: 201 });
    return new Response(JSON.stringify({ id: `re_${randomUUID()}` }), { status: 200 });
  });
  delete process.env.HUB_SMS_OUTBOUND_ENABLED;
});
afterEach(async () => {
  delete process.env.HUB_SMS_OUTBOUND_ENABLED;
  await wipe();
});

async function pinToken(): Promise<string> {
  const res = await request(app).post("/auth/pin").send({ pin: PIN });
  expect(res.status).toBe(200);
  return res.body.token as string;
}
async function login(username: string): Promise<string> {
  const res = await request(app).post("/auth/login").send({ username, password: PASS });
  expect(res.status).toBe(200);
  return res.body.token as string;
}
/** An owner-ROLE login: the role alone must not let it approve. */
async function michael(powers: string[] = []) {
  const person = await makePerson("Michael");
  const row = await saveCrmLogin(person.id, { username: "michael", role: "owner", password: PASS });
  if (powers.length > 0) await setPowers(row.id, powers as never);
  return login("michael");
}
async function aiAdminToken(): Promise<string> {
  await saveAdminLogin("grok-admin", AI_PASS);
  const res = await request(app).post("/auth/login").send({ username: "grok-admin", password: AI_PASS });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

let seq = 0;
async function account(over: { smsConsent?: boolean | null } = {}) {
  const phone = `615556${1000 + (seq++ % 8000)}`;
  const customer = await prisma.customer.create({
    data: { name: `${TAG} Jane ${seq}`, phone, email: `jane${seq}@${DOMAIN}`, smsConsent: over.smsConsent === undefined ? true : over.smsConsent },
  });
  const thread = await ensureThreadFor({ customerId: customer.id });
  return { customer, thread, phone };
}
async function emailDraft(threadId: string, over: Record<string, unknown> = {}) {
  return (await waitingDraft(AI, { threadId, channel: "email", category: "thread_reply", subject: "Tuesday", body: "We can be there Tuesday.", ...over })).message;
}
async function textDraft(threadId: string, category = "confirmation_request", body = "We can be there Tuesday.") {
  return (await waitingDraft(AI, { threadId, channel: "sms", category, body })).message;
}
const events = (messageId: string) => prisma.hubEvent.findMany({ where: { type: "approval.decided", payloadJson: { contains: messageId } } });
const audits = (messageId: string, action: string) => prisma.hubAuditLog.count({ where: { messageId, action } });

describe("the approve_drafts gate on all three decisions", () => {
  it("the AI admin and an owner-role login without the power get the power's sentence, and nothing changes", async () => {
    const { thread } = await account();
    const draft = await emailDraft(thread.id);
    for (const token of [await aiAdminToken(), await michael()]) {
      for (const [route, body] of [["approve", {}], ["edit-approve", { body: "mine" }], ["reject", { reason: "no thanks" }]] as const) {
        const r = await request(app).post(`/hub/messages/${draft.id}/${route}`).set(bearer(token)).send(body);
        expect(r.status, route).toBe(403);
        expect(r.body.error).toBe(REASON);
      }
    }
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("pending_approval");
    expect(resendCalls()).toHaveLength(0);
    expect(await events(draft.id)).toHaveLength(0);
  });

  it("Kyle's PIN session can, and so can a login Kyle granted the power to", async () => {
    const { thread } = await account();
    const a = await emailDraft(thread.id);
    const kyle = await pinToken();
    expect((await request(app).post(`/hub/messages/${a.id}/approve`).set(bearer(kyle)).send({})).status).toBe(200);

    const b = await emailDraft(thread.id);
    const granted = await michael(["approve_drafts"]);
    expect((await request(app).post(`/hub/messages/${b.id}/approve`).set(bearer(granted)).send({})).status).toBe(200);
  });

  it("a technician's token never reaches the approval routes", async () => {
    const { thread } = await account();
    const draft = await emailDraft(thread.id);
    const tech = await prisma.technician.create({ data: { name: `${TAG} Tech`, accessToken: `hubapproval-${randomUUID()}` } });
    const r = await request(app).post(`/hub/messages/${draft.id}/approve`).set(bearer(tech.accessToken)).send({});
    expect([401, 403]).toContain(r.status);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("pending_approval");
    await prisma.technician.delete({ where: { id: tech.id } });
  });

  it("no route, agent door or tool file imports the hubSend function: only the card registry (Approve's run), the agents' direct send and an office person's own text do (Kyle 2026-11-24: the auto-send rule file became services/hubAgentSend.ts)", () => {
    const root = path.resolve(__dirname, "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    const importsFunction = /import\s*\{[^}]*\bhubSend\b[^}]*\}\s*from/;
    const users = files.filter((f) => importsFunction.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f).replace(/\\/g, "/")).sort();
    // Kyle 2026-11-26: an office person's own text from the Conversation box (services/hubOfficeText.ts) is the third caller - the person typing it is
    // the approval, and it still goes through the one sender. No route, agent door or tool file imports hubSend.
    expect(users).toEqual(["services/hubActions/registry.ts", "services/hubAgentSend.ts", "services/hubOfficeText.ts"]);
  });
});

describe("Approve", () => {
  it("sends the email once, links the delivery, answers with the card, writes one audit row and tells the agents once", async () => {
    const { customer, thread } = await account();
    const draft = await emailDraft(thread.id);
    const kyle = await pinToken();

    const r = await request(app).post(`/hub/messages/${draft.id}/approve`).set(bearer(kyle)).send({});
    expect(r.status).toBe(200);
    expect(r.body.send).toEqual({ status: "sent", error: null });
    expect(r.body.card).toMatchObject({ id: draft.id, status: "sent", headerLine: "Email · Transactional — Reply" });
    expect(r.body.card.outcome.text).toMatch(/^Sent by /);
    expect(r.body.card.outcome.emailDelivery).toMatchObject({ to: customer.email, status: "sent" });
    expect(await prisma.emailDelivery.count({ where: { customerId: customer.id } })).toBe(1);
    expect(resendCalls()).toHaveLength(1);
    expect(await audits(draft.id, "message_approved")).toBe(1);

    const sent = await events(draft.id);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.payloadJson)).toMatchObject({ message_id: draft.id, status: "approved" });
  });

  it("a draft is decided once: the second Approve is a 409 and sends nothing more", async () => {
    const { thread } = await account();
    const draft = await emailDraft(thread.id);
    const kyle = await pinToken();
    expect((await request(app).post(`/hub/messages/${draft.id}/approve`).set(bearer(kyle)).send({})).status).toBe(200);
    const second = await request(app).post(`/hub/messages/${draft.id}/approve`).set(bearer(kyle)).send({});
    expect(second.status).toBe(409);
    expect(resendCalls()).toHaveLength(1);
    expect(await audits(draft.id, "message_approved")).toBe(1);
    expect(await events(draft.id)).toHaveLength(1);
  });

  it("an approved text with texting OFF is held as 'Approved — SMS disabled' (no Twilio), and 'Send now' sends it once texting is on", async () => {
    const { thread } = await account();
    const draft = await textDraft(thread.id);
    const kyle = await pinToken();
    const held = await request(app).post(`/hub/messages/${draft.id}/approve`).set(bearer(kyle)).send({});
    expect(held.body.send).toEqual({ status: "approved", error: "SMS disabled" });
    expect(held.body.card.outcome.text).toBe("Approved — SMS disabled");
    expect(twilioCalls()).toHaveLength(0);

    process.env.HUB_SMS_OUTBOUND_ENABLED = "on";
    const now = await request(app).post(`/hub/messages/${draft.id}/approve`).set(bearer(kyle)).send({});
    expect(now.body.send).toEqual({ status: "sent", error: null });
    expect(twilioCalls()).toHaveLength(1);
    // The retry was not a second decision: still one approval.decided.
    expect(await events(draft.id)).toHaveLength(1);
  });

  it("a marketing text: the card greys Approve with the reason; pressing it anyway is refused, one send_blocked row, never held", async () => {
    const { thread, phone } = await account();
    const row = await prisma.hubMessage.create({
      data: {
        threadId: thread.id, authorType: "ai_agent", authorDisplay: "RCE Admin", channel: "sms", direction: "outbound", status: "pending_approval",
        body: "Fall special.", toPhone10: phone, category: "seasonal_offer", messageClass: "marketing",
      },
    });
    const kyle = await pinToken();
    const list = await request(app).get(`/hub/approvals?threadId=${thread.id}`).set(bearer(kyle));
    const card = (list.body.cards as Array<{ id: string; headerLine: string; approve: { blockedReason: string | null } }>).find((c) => c.id === row.id)!;
    expect(card.headerLine).toBe("Text · Marketing");
    expect(card.approve.blockedReason).toBe("Red Cedar never sends marketing by text");

    const r = await request(app).post(`/hub/messages/${row.id}/approve`).set(bearer(kyle)).send({});
    expect(r.status).toBe(200);
    expect(r.body.send).toEqual({ status: "blocked", error: "marketing_not_opted_in" });
    expect(r.body.card.outcome.text).toBe("Not sent: Red Cedar never sends marketing by text");
    expect(await audits(row.id, "send_blocked")).toBe(1);
    expect(await audits(row.id, "message_held")).toBe(0);
    expect(twilioCalls()).toHaveLength(0);
  });
});

describe("the card (describe)", () => {
  it("a text card derives its header from the frozen class and purpose, shows 'Sends as:' and the recent messages, and never a phone", async () => {
    const { thread, phone } = await account();
    await prisma.hubMessage.create({ data: { threadId: thread.id, authorType: "customer", authorDisplay: "Jane", channel: "sms", direction: "inbound", status: "received", body: "Is Tuesday ok?" } });
    const draft = await textDraft(thread.id, "confirmation_request", "Tuesday is fine.");
    const kyle = await pinToken();
    const r = await request(app).get("/hub/approvals").set(bearer(kyle));
    const card = (r.body.cards as Array<Record<string, unknown> & { id: string }>).find((c) => c.id === draft.id)!;
    expect(card).toMatchObject({
      headerLine: "Text · Transactional — Appointment Confirmation", draftedBy: "RCE Admin (AI)", draftedByAi: true, channel: "sms",
    });
    expect(card.sendsAs as string).toMatch(/^Red Cedar Electric: Appointment Confirmation .+\nTuesday is fine\.\nReply STOP to opt out\.$/);
    expect((card.recent as Array<{ text: string }>).map((m) => m.text)).toEqual(["Is Tuesday ok?"]);
    expect((card.chip as { tone: string }).tone).toBe("customer");
    expect(JSON.stringify(card)).not.toContain(phone);
  });

  it("the queue count is the badge's approval count", async () => {
    const { thread } = await account();
    await emailDraft(thread.id);
    await emailDraft(thread.id);
    const kyle = await pinToken();
    const list = await request(app).get("/hub/approvals").set(bearer(kyle));
    const badge = await request(app).get("/hub/badge").set(bearer(kyle));
    expect(list.body.cards).toHaveLength(2);
    expect(badge.body.needsApproval).toBe(2);
    expect(list.body.canApprove).toBe(true);
    const lockedOut = await request(app).get("/hub/approvals").set(bearer(await michael()));
    expect(lockedOut.body).toMatchObject({ canApprove: false, approveReason: REASON });
  });
});

describe("Edit and approve", () => {
  it("keeps the original (edited), sends the edited version as a new message that points back, and the event never carries the words", async () => {
    const { customer, thread } = await account();
    const draft = await emailDraft(thread.id);
    const kyle = await pinToken();
    const r = await request(app).post(`/hub/messages/${draft.id}/edit-approve`).set(bearer(kyle))
      .send({ body: "Kyle's own wording about Tuesday.", subject: "Tuesday visit", cc: [`office@${DOMAIN}`] });
    expect(r.status).toBe(200);
    expect(r.body.send).toEqual({ status: "sent", error: null });

    const original = await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } });
    expect(original.status).toBe("edited");
    expect(original.body).toBe("We can be there Tuesday.");
    const copy = await prisma.hubMessage.findUniqueOrThrow({ where: { id: r.body.card.id as string } });
    expect(copy).toMatchObject({ status: "sent", editedFromId: draft.id, body: "Kyle's own wording about Tuesday.", subject: "Tuesday visit", messageClass: "transactional", category: "thread_reply" });
    const delivery = await prisma.emailDelivery.findMany({ where: { customerId: customer.id } });
    expect(delivery).toHaveLength(1);
    expect(delivery[0]).toMatchObject({ subject: "Tuesday visit", cc: [`office@${DOMAIN}`] });
    expect(await audits(copy.id, "message_edit_approved")).toBe(1);

    const ev = await events(draft.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payloadJson).not.toContain("Kyle's own wording");
    expect(JSON.parse(ev[0]!.payloadJson)).toMatchObject({ status: "edited", result_ids: { message_id: copy.id } });
    // A decided draft cannot be edited again.
    expect((await request(app).post(`/hub/messages/${draft.id}/edit-approve`).set(bearer(kyle)).send({ body: "again" })).status).toBe(409);
  });

  it("an email needs a subject and a text needs words; a bad address is refused before anything is made", async () => {
    const { thread } = await account();
    const draft = await emailDraft(thread.id);
    const kyle = await pinToken();
    expect((await request(app).post(`/hub/messages/${draft.id}/edit-approve`).set(bearer(kyle)).send({ body: "" })).status).toBe(400);
    expect((await request(app).post(`/hub/messages/${draft.id}/edit-approve`).set(bearer(kyle)).send({ body: "x", to: "not-an-email" })).status).toBe(400);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("pending_approval");
  });
});

describe("Reject", () => {
  it("needs a reason; keeps it on the draft; sends nothing; the event never carries it; a rejected draft cannot be rejected again", async () => {
    const { thread } = await account();
    const draft = await emailDraft(thread.id);
    const kyle = await pinToken();
    expect((await request(app).post(`/hub/messages/${draft.id}/reject`).set(bearer(kyle)).send({})).status).toBe(400);
    expect((await request(app).post(`/hub/messages/${draft.id}/reject`).set(bearer(kyle)).send({ reason: "no" })).status).toBe(400);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("pending_approval");

    const r = await request(app).post(`/hub/messages/${draft.id}/reject`).set(bearer(kyle)).send({ reason: "Wrong day, he said Wednesday" });
    expect(r.status).toBe(200);
    expect(r.body.send).toBeNull();
    expect(r.body.card.outcome.text).toBe("Rejected: Wrong day, he said Wednesday");
    expect(await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: "rejected", rejectedReason: "Wrong day, he said Wednesday" });
    expect(resendCalls()).toHaveLength(0);
    expect(await audits(draft.id, "message_rejected")).toBe(1);
    const ev = await events(draft.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payloadJson).not.toContain("Wednesday");
    expect(JSON.parse(ev[0]!.payloadJson).status).toBe("rejected");
    expect((await request(app).post(`/hub/messages/${draft.id}/reject`).set(bearer(kyle)).send({ reason: "again please" })).status).toBe(409);
    expect((await request(app).post(`/hub/messages/${draft.id}/approve`).set(bearer(kyle)).send({})).status).toBe(409);
  });

  it("a held text can be rejected (the exit for 'Approved — SMS disabled')", async () => {
    const { thread } = await account();
    const draft = await textDraft(thread.id);
    const kyle = await pinToken();
    await request(app).post(`/hub/messages/${draft.id}/approve`).set(bearer(kyle)).send({});
    const r = await request(app).post(`/hub/messages/${draft.id}/reject`).set(bearer(kyle)).send({ reason: "Customer called instead" });
    expect(r.status).toBe(200);
    expect(await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: "rejected", error: null });
  });
});

describe("the Message audit log (Kyle only)", () => {
  it("Kyle reads it; another login and the AI admin do not", async () => {
    const kyle = await pinToken();
    expect((await request(app).get("/hub/audit").set(bearer(kyle))).status).toBe(200);
    expect((await request(app).get("/hub/audit").set(bearer(await michael(["approve_drafts"])))).status).toBe(403);
    expect((await request(app).get("/hub/audit").set(bearer(await aiAdminToken()))).status).toBe(403);
  });

  it("'Blocked texts' lists the refused text with its reason, class and send type - and no phone number", async () => {
    const { thread, phone } = await account();
    const row = await prisma.hubMessage.create({
      data: {
        threadId: thread.id, authorType: "ai_agent", authorDisplay: "RCE Admin", channel: "sms", direction: "outbound", status: "pending_approval",
        body: "Fall special.", toPhone10: phone, category: "seasonal_offer", messageClass: "marketing",
      },
    });
    const kyle = await pinToken();
    await request(app).post(`/hub/messages/${row.id}/approve`).set(bearer(kyle)).send({});
    const blocked = await request(app).get("/hub/audit?action=send_blocked").set(bearer(kyle));
    const mine = (blocked.body.entries as Array<Record<string, unknown>>).find((e) => e.messageId === row.id)!;
    expect(mine).toMatchObject({
      action: "send_blocked", actionLabel: "Blocked text", reason: "Red Cedar never sends marketing by text", messageClass: "marketing", category: "seasonal_offer",
    });
    expect(JSON.stringify(blocked.body)).not.toContain(phone);
    expect(JSON.stringify(blocked.body)).not.toContain(phone.slice(-4));
    expect((blocked.body.entries as Array<{ action: string }>).every((e) => e.action === "send_blocked")).toBe(true);

    // By conversation, and by who.
    const byThread = await request(app).get(`/hub/audit?threadId=${thread.id}`).set(bearer(kyle));
    expect((byThread.body.entries as Array<{ threadId: string }>).every((e) => e.threadId === thread.id)).toBe(true);
    const actor = (byThread.body.entries as Array<{ actorKey: string }>)[0]!.actorKey;
    const byActor = await request(app).get(`/hub/audit?threadId=${thread.id}&actor=${encodeURIComponent(actor)}`).set(bearer(kyle));
    expect((byActor.body.entries as Array<{ actorKey: string }>).every((e) => e.actorKey === actor)).toBe(true);
    expect(byThread.body.actors.length).toBeGreaterThan(0);
  });
});


describe("a text that can never go out is refused BEFORE anything is recorded as approved", () => {
  async function marketingRow(threadId: string, phone: string) {
    return prisma.hubMessage.create({
      data: {
        threadId, authorType: "ai_agent", authorDisplay: "RCE Admin", channel: "sms", direction: "outbound", status: "pending_approval",
        body: "Fall special.", toPhone10: phone, category: "seasonal_offer", messageClass: "marketing",
      },
    });
  }
  const eventStatuses = async (id: string) => (await events(id)).map((e) => JSON.parse(e.payloadJson).status as string);

  it("Approve on a marketing text writes no 'Approved' audit row and tells the agents 'blocked', never 'approved'", async () => {
    const { thread, phone } = await account();
    const row = await marketingRow(thread.id, phone);
    const kyle = await pinToken();
    const r = await request(app).post(`/hub/messages/${row.id}/approve`).set(bearer(kyle)).send({});
    expect(r.status).toBe(200);
    expect(r.body.send).toEqual({ status: "blocked", error: "marketing_not_opted_in" });
    expect(await audits(row.id, "message_approved")).toBe(0);
    expect(await audits(row.id, "send_blocked")).toBe(1);
    expect(await eventStatuses(row.id)).toEqual(["blocked"]);
    const after = await prisma.hubMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "blocked", decidedBy: null });
    expect(twilioCalls()).toHaveLength(0);
  });

  it("Approve on a text whose own words carry the STOP line is a 409 that changes nothing, so it can still be edited", async () => {
    const { thread } = await account();
    const draft = await textDraft(thread.id, "confirmation_request", "Tuesday works. Reply STOP to opt out.");
    const kyle = await pinToken();
    const r = await request(app).post(`/hub/messages/${draft.id}/approve`).set(bearer(kyle)).send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Reply STOP/);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("pending_approval");
    expect(await audits(draft.id, "message_approved")).toBe(0);
    expect(await events(draft.id)).toHaveLength(0);
  });

  it("the card: Approve is greyed for the words and Edit stays live; for marketing both are greyed", async () => {
    const { thread, phone } = await account();
    const wordy = await textDraft(thread.id, "confirmation_request", "Tuesday works. Reply STOP to opt out.");
    const marketing = await marketingRow(thread.id, phone);
    const noAddress = await prisma.customer.create({ data: { name: `${TAG} NoEmail`, phone: "6155569999", email: null } });
    const emailThread = await ensureThreadFor({ customerId: noAddress.id });
    const emailless = await emailDraft(emailThread.id);
    const kyle = await pinToken();
    const list = await request(app).get("/hub/approvals?status=all").set(bearer(kyle));
    type C = { id: string; approve: { blockedReason: string | null; editBlockedReason: string | null } };
    const byId = (id: string) => (list.body.cards as C[]).find((c) => c.id === id)!;
    expect(byId(wordy.id).approve.blockedReason).toMatch(/Reply STOP/);
    expect(byId(wordy.id).approve.editBlockedReason).toBeNull();
    expect(byId(emailless.id).approve.blockedReason).toMatch(/no email address/i);
    expect(byId(emailless.id).approve.editBlockedReason).toBeNull();
    expect(byId(marketing.id).approve.blockedReason).toBe("Red Cedar never sends marketing by text");
    expect(byId(marketing.id).approve.editBlockedReason).toBe("Red Cedar never sends marketing by text");
  });

  it("Edit-and-approve: a marketing text is blocked with one send_blocked row and no copy; an edit that still carries the STOP line is a 409; a fixed edit sends", async () => {
    const { thread, phone } = await account();
    const kyle = await pinToken();
    const row = await marketingRow(thread.id, phone);
    const blocked = await request(app).post(`/hub/messages/${row.id}/edit-approve`).set(bearer(kyle)).send({ body: "Fall special, call us." });
    expect(blocked.status).toBe(200);
    expect(blocked.body.send).toEqual({ status: "blocked", error: "marketing_not_opted_in" });
    expect(await prisma.hubMessage.count({ where: { editedFromId: row.id } })).toBe(0);
    expect(await audits(row.id, "send_blocked")).toBe(1);
    expect(await eventStatuses(row.id)).toEqual(["blocked"]);

    process.env.HUB_SMS_OUTBOUND_ENABLED = "on";
    const draft = await textDraft(thread.id, "confirmation_request", "Tuesday works. Reply STOP to opt out.");
    const still = await request(app).post(`/hub/messages/${draft.id}/edit-approve`).set(bearer(kyle)).send({ body: "Tuesday. Reply STOP now." });
    expect(still.status).toBe(409);
    expect(await prisma.hubMessage.count({ where: { editedFromId: draft.id } })).toBe(0);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("pending_approval");

    const fixed = await request(app).post(`/hub/messages/${draft.id}/edit-approve`).set(bearer(kyle)).send({ body: "Tuesday works." });
    expect(fixed.status).toBe(200);
    expect(fixed.body.send).toEqual({ status: "sent", error: null });
    expect(twilioCalls()).toHaveLength(1);
  });
});

describe("the card of an edited original names who edited it", () => {
  it("reads 'Edited by <the approver> before sending', not 'someone'", async () => {
    const { thread } = await account();
    const draft = await emailDraft(thread.id);
    const kyle = await pinToken();
    expect((await request(app).post(`/hub/messages/${draft.id}/edit-approve`).set(bearer(kyle)).send({ body: "My words." })).status).toBe(200);
    const list = await request(app).get(`/hub/approvals?status=all&threadId=${thread.id}`).set(bearer(kyle));
    const original = (list.body.cards as Array<{ id: string; status: string; outcome: { text: string; decidedBy: string | null } }>).find((c) => c.id === draft.id)!;
    expect(original.status).toBe("edited");
    expect(original.outcome.text).toMatch(/^Edited by .+ before sending$/);
    expect(original.outcome.text).not.toMatch(/someone/);
    const copy = await prisma.hubMessage.findFirstOrThrow({ where: { editedFromId: draft.id } });
    const copyAudit = await prisma.hubAuditLog.findFirstOrThrow({ where: { messageId: copy.id, action: "message_edit_approved" } });
    expect(original.outcome.decidedBy).toBe(copyAudit.actorDisplay);
  });
});

describe("a conversation's open cards are never pushed out by its history", () => {
  it("with more than 100 decided drafts in the thread, a new draft still has its card, and the newest history is what is shown", async () => {
    const { thread } = await account();
    const base = Date.now() - 10_000_000;
    await prisma.hubMessage.createMany({
      data: Array.from({ length: 105 }, (_, i) => ({
        threadId: thread.id, authorType: "ai_agent", authorDisplay: "RCE Admin", channel: "email", direction: "outbound", status: "rejected",
        subject: `old ${i}`, body: `old draft ${i}`, rejectedReason: "no", decidedBy: "owner", decidedAt: new Date(base + i), createdAt: new Date(base + i),
      })),
    });
    const fresh = await emailDraft(thread.id);
    const kyle = await pinToken();
    const list = await request(app).get(`/hub/approvals?status=all&threadId=${thread.id}`).set(bearer(kyle));
    const cards = list.body.cards as Array<{ id: string; status: string; subject: string | null }>;
    expect(cards.find((c) => c.id === fresh.id)).toMatchObject({ status: "pending_approval" });
    // The window keeps the NEWEST 100 decided rows (old 5..104), oldest first, with the open card last.
    expect(cards.filter((c) => c.status === "rejected")).toHaveLength(100);
    expect(cards.some((c) => c.subject === "old 0")).toBe(false);
    expect(cards.some((c) => c.subject === "old 104")).toBe(true);
    expect(cards[cards.length - 1]!.id).toBe(fresh.id);
  });
});

describe("Send now on a held text while texting is still off", () => {
  it("the card greys it with the reason, and a direct call is a 409 that adds no audit rows; Reject still works", async () => {
    const { thread } = await account();
    const draft = await textDraft(thread.id);
    const kyle = await pinToken();
    const held = await request(app).post(`/hub/messages/${draft.id}/approve`).set(bearer(kyle)).send({});
    expect(held.body.send).toEqual({ status: "approved", error: "SMS disabled" });
    expect(held.body.card.approve.blockedReason).toBe("Texting is turned off. This text goes out once texting is turned on.");

    const before = await prisma.hubAuditLog.count({ where: { messageId: draft.id } });
    const again = await request(app).post(`/hub/messages/${draft.id}/approve`).set(bearer(kyle)).send({});
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/Texting is turned off/);
    expect(await prisma.hubAuditLog.count({ where: { messageId: draft.id } })).toBe(before);

    // Once texting is on the card is live again and Send now works.
    process.env.HUB_SMS_OUTBOUND_ENABLED = "on";
    const list = await request(app).get(`/hub/approvals?status=all&threadId=${thread.id}`).set(bearer(kyle));
    expect((list.body.cards as Array<{ id: string; approve: { blockedReason: string | null } }>).find((c) => c.id === draft.id)!.approve.blockedReason).toBeNull();
    expect((await request(app).post(`/hub/messages/${draft.id}/approve`).set(bearer(kyle)).send({})).body.send).toEqual({ status: "sent", error: null });
  });

  it("Reject still works on a held text while texting is off", async () => {
    const { thread } = await account();
    const draft = await textDraft(thread.id);
    const kyle = await pinToken();
    await request(app).post(`/hub/messages/${draft.id}/approve`).set(bearer(kyle)).send({});
    const r = await request(app).post(`/hub/messages/${draft.id}/reject`).set(bearer(kyle)).send({ reason: "Changed my mind" });
    expect(r.status).toBe(200);
    expect(r.body.card.status).toBe("rejected");
  });
});
