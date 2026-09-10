/**
 * Email bounce watcher (Kyle, 2026-09-09: "My emails are not getting to the clients" /
 * "very few are actually getting through, this is priority number one").
 *
 * Pins:
 *   1. The DSN parser on the two real bounces found that day — comcast's 554 (5.7.0) on
 *      estimate 2026-1067 and gmail's 550 5.1.1 on 2026-1035.
 *   2. The poll is idempotent: the same Gmail message twice → one EmailBounce row, one
 *      SystemEvent, and the estimate's bounce flag stamped once.
 *   3. The routes: list (unresolved), resolve (clears the flag), manual poll.
 *   4. A different-address resend clears the flag; a same-address resend leaves it.
 *   5. Auth trouble comes back as {available:false} — never a throw.
 *
 * googleapis is mocked: nothing here touches the network.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "test-webhook-secret";
process.env.GMAIL_USER = "service@example.test";
process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
}));

/** The fake mailbox. Hoisted so the googleapis factory can close over it. */
const mailbox = vi.hoisted(() => ({
  listed: [] as Array<{ id: string; threadId: string }>,
  messages: {} as Record<string, unknown>,
  threads: {} as Record<string, unknown>,
  listError: null as Error | null,
  listCalls: 0,
  getCalls: 0,
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
      gmail: () => ({
        users: {
          messages: {
            list: async () => {
              mailbox.listCalls += 1;
              if (mailbox.listError) throw mailbox.listError;
              return { data: { messages: mailbox.listed } };
            },
            get: async ({ id }: { id: string }) => {
              mailbox.getCalls += 1;
              return { data: mailbox.messages[id] };
            },
          },
          threads: {
            get: async ({ id }: { id: string }) => ({ data: mailbox.threads[id] ?? { messages: [] } }),
          },
        },
      }),
    },
  };
});

import { app } from "../src/app";
import {
  bounceReason, classifySubject, clearBounceIfDifferentAddress, parseDsn, pollBounces,
} from "../src/services/bounceWatcher";

// ── The two real DSN bodies (Kyle's inbox, 2026-09-09) ───────────────────────

const COMCAST_HUMAN = `Delivery Status Notification (Failure)

Your message wasn't delivered to cmmw013@comcast.net because the server for the recipient domain comcast.net (mx1.comcast.net) refused it.

The response from the remote server was:
554 resimta-a2p-561712.sys.comcast.net resimta-a2p-561712.sys.comcast.net ESMTP server not available
`;

const COMCAST_STATUS = `Reporting-MTA: dns; googlemail.com
Received-From-MTA: dns; service@example.test
Arrival-Date: Wed, 09 Sep 2026 14:02:11 -0700 (PDT)

Final-Recipient: rfc822; cmmw013@comcast.net
Action: failed
Status: 5.7.0
Remote-MTA: dns; mx1.comcast.net. (96.114.157.80, the server for the domain comcast.net.)
Diagnostic-Code: smtp; 554 resimta-a2p-561712.sys.comcast.net resimta-a2p-561712.sys.comcast.net ESMTP server not available
Last-Attempt-Date: Wed, 09 Sep 2026 14:02:12 -0700 (PDT)
`;

const GMAIL_HUMAN = `Address not found

Your message wasn't delivered to Howell.leftwitch@gmail.com because the address couldn't be found, or is unable to receive mail.

The response was:
550 5.1.1 The email account that you tried to reach does not exist. Please try double-checking the recipient's email address for typos or unnecessary spaces.
`;

const GMAIL_STATUS = `Reporting-MTA: dns; googlemail.com
Received-From-MTA: dns; service@example.test
Arrival-Date: Mon, 31 Aug 2026 09:15:40 -0700 (PDT)

Final-Recipient: rfc822; Howell.leftwitch@gmail.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist. Please try
 double-checking the recipient's email address for typos or unnecessary spaces.
 For more information, go to https://support.google.com/mail/?p=NoSuchUser
Last-Attempt-Date: Mon, 31 Aug 2026 09:15:41 -0700 (PDT)
`;

// ── Gmail-shaped fixtures ────────────────────────────────────────────────────

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function dsnMessage(input: {
  id: string; threadId: string; at: Date; recipient: string; human: string; status: string; originalSubject: string;
}) {
  return {
    id: input.id,
    threadId: input.threadId,
    internalDate: String(input.at.getTime()),
    payload: {
      mimeType: "multipart/report",
      headers: [
        { name: "From", value: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>" },
        { name: "Subject", value: "Delivery Status Notification (Failure)" },
        { name: "X-Failed-Recipients", value: input.recipient },
      ],
      body: { size: 0 },
      parts: [
        { mimeType: "text/plain", body: { data: b64url(input.human) } },
        { mimeType: "message/delivery-status", body: { data: b64url(input.status) } },
        {
          mimeType: "message/rfc822",
          body: { size: 0 },
          parts: [{
            mimeType: "text/plain",
            headers: [{ name: "Subject", value: input.originalSubject }, { name: "To", value: input.recipient }],
            body: { data: b64url("Hi there, your estimate is ready.") },
          }],
        },
      ],
    },
  };
}

function thread(input: { dsnId: string; originalId: string; sentAt: Date; subject: string; to: string }) {
  return {
    messages: [
      {
        id: input.originalId,
        internalDate: String(input.sentAt.getTime()),
        payload: {
          headers: [
            { name: "Subject", value: input.subject },
            { name: "To", value: input.to },
            { name: "Date", value: input.sentAt.toUTCString() },
          ],
        },
      },
      { id: input.dsnId, internalDate: String(input.sentAt.getTime() + 60_000), payload: { headers: [] } },
    ],
  };
}

async function waitForEvents(where: object, count: number, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const rows = await prisma.systemEvent.findMany({ where });
    if (rows.length >= count) return rows;
    if (Date.now() - start > timeoutMs) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RUN = Date.now();
let customerId: string;
let propertyId: string;
let draftId: string;
let estimate67Id: string;
let estimate35Id: string;
let apptCustomerId: string;
let apptVisitId: string;
const APPT_EMAIL = `bounce-appt-${RUN}@example.test`;

const cleanup = async () => {
  await prisma.emailBounce.deleteMany({ where: { gmailMessageId: { startsWith: "bwtest-" } } });
  await prisma.systemEvent.deleteMany({ where: { source: "email", detailsJson: { contains: "bwtest-" } } });
  await prisma.issuedEstimate.deleteMany({ where: { number: { startsWith: "0000-90" } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: "bounce-watcher draft" } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: "BWTEST-SUP" } });
  await prisma.visit.deleteMany({ where: { customer: { name: { startsWith: "Bounce Watcher" } } } });
  await prisma.property.deleteMany({ where: { name: "bounce-watcher property" } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: "Bounce Watcher" } } });
};

beforeAll(async () => {
  await cleanup();
  const customer = await prisma.customer.create({ data: { name: "Bounce Watcher Test", email: "cmmw013@comcast.net" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "bounce-watcher property", addressLine1: "7 Bounce Ct", city: "Franklin", state: "TN", postalCode: "37064" },
  });
  propertyId = property.id;
  await prisma.priceBookSupplier.create({ data: { id: "BWTEST-SUP", name: "Bounce Watcher Supply", quotable: "YES" } });
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: "bounce-watcher draft", supplierId: "BWTEST-SUP" } });
  draftId = draft.id;

  const issue = (number: string, email: string) => prisma.issuedEstimate.create({
    data: {
      number, token: `bwtest-${number}-${RUN}`, status: "sent", draftId, customerId, serviceAddressId: propertyId,
      customerName: "Bounce Watcher Test", customerEmail: email, serviceAddress: "7 Bounce Ct, Franklin",
      title: "Panel upgrade", workSubtotal: 1200, total: 1200, sentAt: new Date(), sentTo: email,
    },
  });
  estimate67Id = (await issue("0000-9067", "cmmw013@comcast.net")).id;
  estimate35Id = (await issue("0000-9035", "howell.leftwitch@gmail.com")).id;

  // An account whose appointment email bounced — one scheduled visit, created now.
  const appt = await prisma.customer.create({ data: { name: "Bounce Watcher Appt", email: APPT_EMAIL } });
  apptCustomerId = appt.id;
  const apptProperty = await prisma.property.create({
    data: { customerId: apptCustomerId, name: "bounce-watcher property", addressLine1: "9 Bounce Ct", city: "Franklin", state: "TN", postalCode: "37064" },
  });
  const visit = await prisma.visit.create({
    data: {
      customerId: apptCustomerId, propertyId: apptProperty.id, mode: "scheduled", status: "scheduled",
      purpose: "Service call", scheduledStart: new Date(Date.now() + 86_400_000), scheduledEnd: new Date(Date.now() + 86_400_000 + 7_200_000),
    },
  });
  apptVisitId = visit.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// ── 1. The parser ────────────────────────────────────────────────────────────

describe("DSN parser", () => {
  it("reads comcast's 554 refusal — status 5.7.0, the recipient, and the estimate number", () => {
    const parsed = parseDsn(`${COMCAST_HUMAN}\n${COMCAST_STATUS}`);
    expect(parsed.recipient).toBe("cmmw013@comcast.net");
    expect(parsed.action).toBe("failed");
    expect(parsed.status).toBe("5.7.0");
    expect(parsed.remoteMta).toBe("mx1.comcast.net.");
    expect(parsed.diagnostic).toMatch(/^smtp; 554 resimta-a2p-561712\.sys\.comcast\.net .*ESMTP server not available$/);
    expect(bounceReason(parsed)).toMatch(/^5\.7\.0 554 resimta/);

    const c = classifySubject("Your estimate from Red Cedar Electric — 2026-1067");
    expect(c).toEqual({ kind: "estimate", estimateNumber: "2026-1067" });
  });

  it("reads gmail's 550 5.1.1 (no such address), unfolding the wrapped Diagnostic-Code", () => {
    const parsed = parseDsn(`${GMAIL_HUMAN}\n${GMAIL_STATUS}`);
    expect(parsed.recipient).toBe("howell.leftwitch@gmail.com");
    expect(parsed.status).toBe("5.1.1");
    expect(parsed.remoteMta).toBeNull();
    expect(parsed.diagnostic).toContain("550-5.1.1 The email account that you tried to reach does not exist.");
    expect(parsed.diagnostic).toContain("double-checking the recipient's email address");
    expect(parsed.diagnostic).not.toMatch(/\n/);
    expect(parsed.diagnostic!.length).toBeLessThanOrEqual(500);

    expect(classifySubject("Your estimate from Red Cedar Electric — 2026-1035"))
      .toEqual({ kind: "estimate", estimateNumber: "2026-1035" });
  });

  it("falls back to the human paragraph when the structured block is missing", () => {
    const parsed = parseDsn(COMCAST_HUMAN);
    expect(parsed.recipient).toBe("cmmw013@comcast.net");
    expect(parsed.diagnostic).toMatch(/^smtp; 554 resimta/);
  });

  it("names what was sent from the CRM's own subjects", () => {
    expect(classifySubject("Your invoice from Red Cedar Electric — 2026-1063").kind).toBe("invoice");
    expect(classifySubject("Appointment Confirmed — Monday, September 14").kind).toBe("appointment");
    expect(classifySubject("Please confirm your appointment — Monday, September 14").kind).toBe("appointment");
    expect(classifySubject("Reminder: your appointment tomorrow — Monday, September 14").kind).toBe("appointment");
    expect(classifySubject("Next step — your deposit for Panel upgrade ($400.00)").kind).toBe("deposit");
    expect(classifySubject("Your bill for Panel upgrade — $800.00 due (Invoice 2026-1063)"))
      .toEqual({ kind: "balance", estimateNumber: "2026-1063" });
    expect(classifySubject("Friendly reminder — $800.00 still open on Invoice 2026-1063").kind).toBe("balance");
    expect(classifySubject("Paid in full — receipt for Invoice 2026-1063").kind).toBe("receipt");
    expect(classifySubject("Receipt — $400.00 received on Invoice 2026-1063").kind).toBe("receipt");
    expect(classifySubject("Re: something else").kind).toBe("other");
    expect(classifySubject(null)).toEqual({ kind: "other", estimateNumber: null });
  });
});

// ── 2. The poll ──────────────────────────────────────────────────────────────

describe("pollBounces", () => {
  const bouncedAt = new Date("2026-09-09T21:02:12.000Z");
  const sentAt = new Date("2026-09-09T20:58:00.000Z");

  it("files one row, stamps the estimate, logs one WARN — and a second pass adds nothing", async () => {
    mailbox.listError = null;
    mailbox.listed = [{ id: "bwtest-1", threadId: "bwthread-1" }];
    mailbox.messages["bwtest-1"] = dsnMessage({
      id: "bwtest-1", threadId: "bwthread-1", at: bouncedAt, recipient: "cmmw013@comcast.net",
      human: COMCAST_HUMAN, status: COMCAST_STATUS, originalSubject: "Your estimate from Red Cedar Electric — 0000-9067",
    });
    mailbox.threads["bwthread-1"] = thread({
      dsnId: "bwtest-1", originalId: "bworig-1", sentAt,
      subject: "Your estimate from Red Cedar Electric — 0000-9067", to: "cmmw013@comcast.net",
    });

    const first = await pollBounces({ sinceDays: 3 });
    expect(first).toEqual({ available: true, scanned: 1, new: 1, errors: 0 });

    const row = await prisma.emailBounce.findUnique({ where: { gmailMessageId: "bwtest-1" } });
    expect(row).not.toBeNull();
    expect(row!.recipient).toBe("cmmw013@comcast.net");
    expect(row!.status).toBe("5.7.0");
    expect(row!.kind).toBe("estimate");
    expect(row!.estimateNumber).toBe("0000-9067");
    expect(row!.issuedEstimateId).toBe(estimate67Id);
    expect(row!.remoteMta).toBe("mx1.comcast.net.");
    expect(row!.originalSubject).toBe("Your estimate from Red Cedar Electric — 0000-9067");
    expect(row!.bouncedAt.toISOString()).toBe(bouncedAt.toISOString());
    expect(row!.resolvedAt).toBeNull();

    const est = await prisma.issuedEstimate.findUnique({ where: { id: estimate67Id } });
    expect(est!.lastBounceAt?.toISOString()).toBe(bouncedAt.toISOString());
    expect(est!.lastBounceReason).toContain("cmmw013@comcast.net");
    expect(est!.lastBounceReason).toContain("5.7.0 554");

    const events = await waitForEvents({ source: "email", level: "warn", detailsJson: { contains: "bwtest-1" } }, 1);
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain("cmmw013@comcast.net");
    expect(events[0].message).toContain("0000-9067");

    // Same Gmail message again: nothing new, no second read of the message, no second event.
    const getsBefore = mailbox.getCalls;
    const second = await pollBounces({ sinceDays: 3 });
    expect(second).toEqual({ available: true, scanned: 1, new: 0, errors: 0 });
    expect(mailbox.getCalls).toBe(getsBefore);
    expect(await prisma.emailBounce.count({ where: { gmailMessageId: "bwtest-1" } })).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(await prisma.systemEvent.count({ where: { source: "email", level: "warn", detailsJson: { contains: "bwtest-1" } } })).toBe(1);
  });

  it("links an appointment bounce to the account's one scheduled visit", async () => {
    const at = new Date();
    mailbox.listed = [{ id: "bwtest-appt", threadId: "bwthread-appt" }];
    mailbox.messages["bwtest-appt"] = dsnMessage({
      id: "bwtest-appt", threadId: "bwthread-appt", at, recipient: APPT_EMAIL,
      human: GMAIL_HUMAN.replace("Howell.leftwitch@gmail.com", APPT_EMAIL),
      status: GMAIL_STATUS.replace("Howell.leftwitch@gmail.com", APPT_EMAIL),
      originalSubject: "Appointment Confirmed — Thursday, September 10",
    });
    mailbox.threads["bwthread-appt"] = thread({
      dsnId: "bwtest-appt", originalId: "bworig-appt", sentAt: new Date(at.getTime() - 60_000),
      subject: "Appointment Confirmed — Thursday, September 10", to: APPT_EMAIL,
    });

    const r = await pollBounces({ sinceDays: 3 });
    expect(r).toMatchObject({ available: true, new: 1 });
    const row = await prisma.emailBounce.findUnique({ where: { gmailMessageId: "bwtest-appt" } });
    expect(row!.kind).toBe("appointment");
    expect(row!.estimateNumber).toBeNull();
    expect(row!.issuedEstimateId).toBeNull();
    expect(row!.visitId).toBe(apptVisitId);
    expect(row!.status).toBe("5.1.1");
  });

  it("reports auth trouble as unavailable instead of throwing", async () => {
    mailbox.listError = Object.assign(new Error("Request had insufficient authentication scopes."), { code: 403 });
    const r = await pollBounces({ sinceDays: 3 });
    expect(r.available).toBe(false);
    if (!r.available) {
      expect(r.reason).toContain("mail.google.com");
    }
    mailbox.listError = null;
  });

  it("is off when Gmail is not configured", async () => {
    const saved = process.env.GOOGLE_REFRESH_TOKEN;
    delete process.env.GOOGLE_REFRESH_TOKEN;
    const r = await pollBounces({ sinceDays: 3 });
    expect(r).toEqual({ available: false, reason: expect.stringContaining("not configured") });
    process.env.GOOGLE_REFRESH_TOKEN = saved;
  });
});

// ── 3. Clearing ──────────────────────────────────────────────────────────────

describe("clearBounceIfDifferentAddress", () => {
  it("leaves the flag on a resend to the same address and clears it on a different one", async () => {
    const at = new Date();
    await prisma.issuedEstimate.update({
      where: { id: estimate35Id },
      data: { lastBounceAt: at, lastBounceReason: "howell.leftwitch@gmail.com — 5.1.1 550-5.1.1 no such user" },
    });
    await prisma.emailBounce.create({
      data: {
        gmailMessageId: "bwtest-35", recipient: "howell.leftwitch@gmail.com", status: "5.1.1", kind: "estimate",
        estimateNumber: "0000-9035", issuedEstimateId: estimate35Id, bouncedAt: at,
      },
    });

    // Same address (case-insensitive): the flag stays; the SMTP accept says nothing about delivery.
    expect(await clearBounceIfDifferentAddress(prisma, estimate35Id, "Howell.Leftwitch@gmail.com")).toBe(false);
    let est = await prisma.issuedEstimate.findUnique({ where: { id: estimate35Id } });
    expect(est!.lastBounceAt).not.toBeNull();

    // A different address: the flag comes off and the bounce is resolved with a note.
    expect(await clearBounceIfDifferentAddress(prisma, estimate35Id, "howell.other@example.test")).toBe(true);
    est = await prisma.issuedEstimate.findUnique({ where: { id: estimate35Id } });
    expect(est!.lastBounceAt).toBeNull();
    expect(est!.lastBounceReason).toBeNull();
    const bounce = await prisma.emailBounce.findUnique({ where: { gmailMessageId: "bwtest-35" } });
    expect(bounce!.resolvedAt).not.toBeNull();
    expect(bounce!.resolvedNote).toContain("howell.other@example.test");

    // Nothing to clear → false, no error.
    expect(await clearBounceIfDifferentAddress(prisma, estimate35Id, "howell.other@example.test")).toBe(false);
  });
});

// ── 4. The routes ────────────────────────────────────────────────────────────

describe("email bounce routes", () => {
  it("GET /email-bounces?unresolved=1 lists open bounces newest first with the account", async () => {
    const res = await request(app).get("/email-bounces?unresolved=1");
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ id: string; recipient: string; account: { id: string; name: string } | null; estimate: { number: string } | null; bouncedAt: string; resolvedAt: string | null }>;
    const comcast = rows.find((r) => r.recipient === "cmmw013@comcast.net");
    expect(comcast).toBeDefined();
    expect(comcast!.account).toEqual({ id: customerId, name: "Bounce Watcher Test" });
    expect(comcast!.estimate?.number).toBe("0000-9067");
    expect(comcast!.resolvedAt).toBeNull();
    // The resolved 0000-9035 bounce is not in the unresolved list.
    expect(rows.some((r) => r.recipient === "howell.leftwitch@gmail.com")).toBe(false);
    // Newest first.
    for (let i = 1; i < rows.length; i += 1) {
      expect(new Date(rows[i - 1].bouncedAt).getTime()).toBeGreaterThanOrEqual(new Date(rows[i].bouncedAt).getTime());
    }
    // The appointment bounce names its account through the visit.
    const appt = rows.find((r) => r.recipient === APPT_EMAIL);
    expect(appt?.account).toEqual({ id: apptCustomerId, name: "Bounce Watcher Appt" });
  });

  it("POST /email-bounces/:id/resolve records the note and clears the estimate's flag", async () => {
    const row = await prisma.emailBounce.findUnique({ where: { gmailMessageId: "bwtest-1" } });
    const res = await request(app).post(`/email-bounces/${row!.id}/resolve`).send({ note: "Called; new address on file" });
    expect(res.status).toBe(200);
    expect(res.body.resolvedAt).not.toBeNull();
    expect(res.body.resolvedNote).toBe("Called; new address on file");

    const est = await prisma.issuedEstimate.findUnique({ where: { id: estimate67Id } });
    expect(est!.lastBounceAt).toBeNull();
    expect(est!.lastBounceReason).toBeNull();

    const list = await request(app).get("/email-bounces?unresolved=1");
    expect((list.body as Array<{ id: string }>).some((r) => r.id === row!.id)).toBe(false);
    const all = await request(app).get("/email-bounces");
    expect((all.body as Array<{ id: string }>).some((r) => r.id === row!.id)).toBe(true);

    expect((await request(app).post("/email-bounces/nope/resolve").send({})).status).toBe(404);
  });

  it("POST /email-bounces/poll runs the watcher and returns its counts", async () => {
    mailbox.listError = null;
    mailbox.listed = [{ id: "bwtest-1", threadId: "bwthread-1" }, { id: "bwtest-appt", threadId: "bwthread-appt" }];
    const res = await request(app).post("/email-bounces/poll").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, scanned: 2, new: 0, errors: 0 });
  });

  it("the estimate chain and the invoice list carry the bounce flag", async () => {
    const at = new Date();
    await prisma.issuedEstimate.update({
      where: { id: estimate67Id },
      data: { lastBounceAt: at, lastBounceReason: "cmmw013@comcast.net — 5.7.0 554 ESMTP server not available", signedAt: at, status: "signed", signedChannel: "email" },
    });
    const chain = await request(app).get("/issued-estimates/chain");
    expect(chain.status).toBe(200);
    const chainRow = (chain.body.estimates as Array<{ id: string; lastBounceAt: string | null; lastBounceReason: string | null }>).find((r) => r.id === estimate67Id);
    expect(chainRow?.lastBounceAt).toBe(at.toISOString());
    expect(chainRow?.lastBounceReason).toContain("5.7.0");

    const invoices = await request(app).get("/invoices");
    expect(invoices.status).toBe(200);
    const inv = (invoices.body as Array<{ id: string; lastBounceAt: string | null; lastBounceReason: string | null }>).find((r) => r.id === estimate67Id);
    expect(inv?.lastBounceAt).toBe(at.toISOString());
    expect(inv?.lastBounceReason).toContain("comcast");

    const account = await request(app).get(`/accounts/${customerId}/estimates`);
    const accRow = (account.body.estimates as Array<{ id: string; lastBounceAt: string | null }>).find((r) => r.id === estimate67Id);
    expect(accRow?.lastBounceAt).toBe(at.toISOString());
  });
});
