/**
 * Resend-first transactional email with delivery tracking (Kyle, 2026-09-09: "I need the emails
 * working, very few are actually getting through, this is priority number one").
 *
 * Pins:
 *   1. The one door: a Resend success writes EmailDelivery {resend, sent, id}; a Resend failure
 *      falls back to Gmail (same html / text / attachments) and writes {gmail, sent} plus a WARN;
 *      both failing writes {failed} with the reason, an ERROR, and returns ok:false.
 *   2. The Svix signature check, computed here with the same algorithm: valid accepts, a wrong
 *      signature and a stale timestamp are 400, a missing secret is 503.
 *   3. The webhook: email.delivered updates the row; email.bounced files an EmailBounce beside the
 *      Gmail DSNs, stamps the estimate, logs one WARN — and a retry of the same event is a no-op.
 *   4. The read side: /email-deliveries, /email-status, and the chain / invoice / account rows
 *      carrying lastDelivery.
 *
 * Nothing here touches the network: fetch is stubbed, nodemailer and googleapis are mocked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { prisma } from "../src/lib/prisma";

process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "test-webhook-secret";
process.env.GMAIL_USER = "service@example.test";
process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
// Resend "configured": the key is never sent anywhere because fetch is stubbed below.
process.env.RESEND_API_KEY = "re_test_key_never_used";
delete process.env.TRANSACTIONAL_EMAIL_PROVIDER;
delete process.env.TRANSACTIONAL_FROM;
delete process.env.TRANSACTIONAL_BCC_SELF;
const WEBHOOK_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
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
          messages: { list: async () => ({ data: { messages: [] } }), get: async () => ({ data: {} }) },
          threads: { get: async () => ({ data: { messages: [] } }) },
        },
      }),
    },
  };
});

/** The fake Gmail transporter. Hoisted so the nodemailer factory can close over it. */
const mail = vi.hoisted(() => ({
  sendMail: vi.fn<(opts: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: mail.sendMail }) },
}));

const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

import { app } from "../src/app";
import { sendCustomerEmail, transactionalProvider } from "../src/services/transactionalEmail";
import { sendBrandedEmail } from "../src/services/confirmationEmail";
import { resetResendWebhookState, signSvixPayload, verifySvixSignature } from "../src/services/resendWebhook";

// ── Helpers ──────────────────────────────────────────────────────────────────

const RUN = Date.now();
const DOMAIN = `txtest-${RUN}.example`;
const CUSTOMER_EMAIL = `customer@${DOMAIN}`;

function resendOk(id: string): Response {
  return new Response(JSON.stringify({ id }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function resendFail(status: number, text = "boom"): Response {
  return new Response(text, { status });
}

function lastFetchBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
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

/** POST a Resend event through the real route, signed the way Svix signs it. */
function postWebhook(event: object, opts: { secret?: string; timestamp?: string; signature?: string; id?: string } = {}) {
  const body = JSON.stringify(event);
  const id = opts.id ?? `msg_${randomBytes(8).toString("hex")}`;
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = opts.signature ?? signSvixPayload(body, id, timestamp, opts.secret ?? WEBHOOK_SECRET);
  return request(app)
    .post("/resend/webhook")
    .set("Content-Type", "application/json")
    .set("svix-id", id)
    .set("svix-timestamp", timestamp)
    .set("svix-signature", signature)
    .send(body);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

let customerId: string;
let propertyId: string;
let draftId: string;
let estimateId: string;
const ESTIMATE_NUMBER = "0000-9101";

const cleanup = async () => {
  await prisma.emailDelivery.deleteMany({ where: { to: { endsWith: `@${DOMAIN}` } } });
  await prisma.emailBounce.deleteMany({ where: { recipient: { endsWith: `@${DOMAIN}` } } });
  await prisma.systemEvent.deleteMany({ where: { source: "email", message: { contains: DOMAIN } } });
  await prisma.systemEvent.deleteMany({ where: { source: "email", message: { contains: "RESEND_WEBHOOK_SECRET" } } });
  await prisma.issuedEstimate.deleteMany({ where: { number: { startsWith: "0000-91" } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: "transactional-email draft" } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: "TXTEST-SUP" } });
  await prisma.property.deleteMany({ where: { name: "transactional-email property" } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: "Transactional Email" } } });
};

beforeAll(async () => {
  await cleanup();
  const customer = await prisma.customer.create({ data: { name: "Transactional Email Test", email: CUSTOMER_EMAIL } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "transactional-email property", addressLine1: "3 Resend Way", city: "Franklin", state: "TN", postalCode: "37064" },
  });
  propertyId = property.id;
  await prisma.priceBookSupplier.create({ data: { id: "TXTEST-SUP", name: "Transactional Email Supply", quotable: "YES" } });
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: "transactional-email draft", supplierId: "TXTEST-SUP" } });
  draftId = draft.id;
  const est = await prisma.issuedEstimate.create({
    data: {
      number: ESTIMATE_NUMBER, token: `txtest-${RUN}`, status: "signed", draftId, customerId, serviceAddressId: propertyId,
      customerName: "Transactional Email Test", customerEmail: CUSTOMER_EMAIL, serviceAddress: "3 Resend Way, Franklin",
      title: "Generator interlock", workSubtotal: 3586, total: 3586, sentAt: new Date(), sentTo: CUSTOMER_EMAIL,
      signedAt: new Date(), signedChannel: "email", signerName: "Transactional Email Test",
    },
  });
  estimateId = est.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(() => {
  fetchMock.mockReset();
  mail.sendMail.mockReset();
  mail.sendMail.mockResolvedValue({ messageId: "<gmail-mock>" });
  delete process.env.TRANSACTIONAL_EMAIL_PROVIDER;
});

// ── 1. The one door ──────────────────────────────────────────────────────────

describe("sendCustomerEmail", () => {
  it("prefers Resend when the key is set", () => {
    expect(transactionalProvider()).toBe("resend");
  });

  it("Resend success → EmailDelivery {resend, sent, id}; from service@, reply_to service@, bcc self, tags, text, attachments", async () => {
    fetchMock.mockResolvedValueOnce(resendOk(`txre_ok_${RUN}`));
    const to = `ok@${DOMAIN}`;
    const r = await sendCustomerEmail({
      to,
      subject: "Your invoice from Red Cedar Electric — 0000-9101",
      html: "<p>Hi</p>",
      text: "Hi",
      attachments: [{ filename: "invoice.pdf", content: Buffer.from("%PDF-1.4 test"), contentType: "application/pdf" }],
      kind: "invoice",
      estimateNumber: ESTIMATE_NUMBER,
      issuedEstimateId: estimateId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider).toBe("resend");
    expect(r.id).toBe(`txre_ok_${RUN}`);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.resend.com/emails");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key_never_used");
    const body = lastFetchBody();
    expect(body.from).toBe("Red Cedar Electric <service@redcedarelectricllc.com>");
    expect(body.reply_to).toBe("service@redcedarelectricllc.com");
    expect(body.to).toEqual([to]);
    expect(body.bcc).toEqual(["service@example.test"]);
    expect(body.subject).toBe("Your invoice from Red Cedar Electric — 0000-9101");
    expect(body.html).toBe("<p>Hi</p>");
    expect(body.text).toBe("Hi");
    expect(body.attachments).toEqual([{ filename: "invoice.pdf", content: Buffer.from("%PDF-1.4 test").toString("base64"), content_type: "application/pdf" }]);
    expect(body.tags).toEqual([{ name: "kind", value: "invoice" }, { name: "estimate", value: "0000-9101" }]);
    expect(mail.sendMail).not.toHaveBeenCalled();

    const row = await prisma.emailDelivery.findUnique({ where: { providerMessageId: `txre_ok_${RUN}` } });
    expect(row).not.toBeNull();
    expect(row!.provider).toBe("resend");
    expect(row!.status).toBe("sent");
    expect(row!.to).toBe(to);
    expect(row!.kind).toBe("invoice");
    expect(row!.estimateNumber).toBe(ESTIMATE_NUMBER);
    expect(row!.issuedEstimateId).toBe(estimateId);
    expect(row!.error).toBeNull();
  });

  it("Resend 500 → falls back to Gmail with the same message, writes {gmail, sent} and a WARN", async () => {
    fetchMock.mockResolvedValueOnce(resendFail(500, "internal"));
    const to = `fallback@${DOMAIN}`;
    const r = await sendCustomerEmail({
      to,
      subject: "Your estimate from Red Cedar Electric — 0000-9101",
      html: "<p>Estimate</p>",
      text: "Estimate",
      attachments: [{ filename: "estimate.pdf", content: Buffer.from("%PDF"), contentType: "application/pdf" }],
      kind: "estimate",
      estimateNumber: ESTIMATE_NUMBER,
      issuedEstimateId: estimateId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider).toBe("gmail");
    expect(r.id).toBeNull();

    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    const sent = mail.sendMail.mock.calls[0][0];
    expect(sent.to).toBe(to);
    expect(sent.from).toContain("service@example.test");
    expect(sent.subject).toBe("Your estimate from Red Cedar Electric — 0000-9101");
    expect(sent.html).toBe("<p>Estimate</p>");
    expect(sent.text).toBe("Estimate");
    expect((sent.attachments as Array<{ filename: string }>)[0].filename).toBe("estimate.pdf");

    const row = await prisma.emailDelivery.findFirst({ where: { to }, orderBy: { createdAt: "desc" } });
    expect(row!.provider).toBe("gmail");
    expect(row!.status).toBe("sent");
    expect(row!.providerMessageId).toBeNull();
    expect(row!.error).toContain("Resend fallback");
    expect(row!.error).toContain("500");

    const warns = await waitForEvents({ source: "email", level: "warn", message: { contains: to } }, 1);
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain("falling back to Gmail");
  });

  it("Resend unreachable AND Gmail refusing → {failed} with both reasons, an ERROR, ok:false", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    mail.sendMail.mockRejectedValueOnce(Object.assign(new Error("invalid_grant"), { code: "EAUTH", responseCode: 535 }));
    const to = `dead@${DOMAIN}`;
    const r = await sendCustomerEmail({ to, subject: "Receipt — $100", html: "<p>x</p>", kind: "receipt" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Resend");
    expect(r.error).toContain("ECONNRESET");
    expect(r.error).toContain("Gmail");
    expect(r.error).toContain("invalid_grant");

    const row = await prisma.emailDelivery.findFirst({ where: { to }, orderBy: { createdAt: "desc" } });
    expect(row!.status).toBe("failed");
    expect(row!.error).toContain("invalid_grant");

    const errors = await waitForEvents({ source: "email", level: "error", message: { contains: to } }, 1);
    expect(errors).toHaveLength(1);
    expect(errors[0].detailsJson).toContain("refresh token expired or revoked");
  });

  it("TRANSACTIONAL_EMAIL_PROVIDER=gmail skips Resend entirely — the transporter the older suites mock", async () => {
    process.env.TRANSACTIONAL_EMAIL_PROVIDER = "gmail";
    expect(transactionalProvider()).toBe("gmail");
    const to = `gmail-only@${DOMAIN}`;
    const r = await sendCustomerEmail({ to, subject: "Appointment Confirmed — Monday", html: "<p>x</p>", kind: "appointment" });
    expect(r.ok && r.provider).toBe("gmail");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    const row = await prisma.emailDelivery.findFirst({ where: { to } });
    expect(row!.provider).toBe("gmail");
    expect(row!.error).toBeNull();
  });

  it("does not bcc Kyle's own address to itself, and TRANSACTIONAL_BCC_SELF=off drops the bcc", async () => {
    fetchMock.mockResolvedValueOnce(resendOk(`txre_self_${RUN}`));
    await sendCustomerEmail({ to: "service@example.test", subject: "VIEWED", html: "<p>x</p>", kind: "other" });
    expect(lastFetchBody().bcc).toBeUndefined();
    await prisma.emailDelivery.deleteMany({ where: { providerMessageId: `txre_self_${RUN}` } });

    process.env.TRANSACTIONAL_BCC_SELF = "off";
    try {
      fetchMock.mockResolvedValueOnce(resendOk(`txre_nobcc_${RUN}`));
      await sendCustomerEmail({ to: `nobcc@${DOMAIN}`, subject: "x", html: "<p>x</p>", kind: "other" });
      expect(lastFetchBody().bcc).toBeUndefined();
    } finally {
      delete process.env.TRANSACTIONAL_BCC_SELF;
    }
  });

  it("sendBrandedEmail is on the same door and carries the attribution", async () => {
    fetchMock.mockResolvedValueOnce(resendOk(`txre_branded_${RUN}`));
    const ok = await sendBrandedEmail({
      to: `branded@${DOMAIN}`,
      subject: "Next step — your deposit for Generator interlock ($1195.33)",
      headline: "Thank you",
      bodyHtml: "<p>Deposit</p>",
      kind: "deposit",
      estimateNumber: ESTIMATE_NUMBER,
      issuedEstimateId: estimateId,
    });
    expect(ok).toBe(true);
    const body = lastFetchBody();
    expect(String(body.html)).toContain("Red Cedar Electric LLC");
    expect(String(body.text)).toContain("Deposit");
    const row = await prisma.emailDelivery.findUnique({ where: { providerMessageId: `txre_branded_${RUN}` } });
    expect(row!.kind).toBe("deposit");
    expect(row!.issuedEstimateId).toBe(estimateId);
  });
});

// ── 2. The signature ─────────────────────────────────────────────────────────

describe("verifySvixSignature", () => {
  const body = '{"type":"email.delivered"}';
  const now = 1_800_000_000_000;
  const ts = String(Math.floor(now / 1000));

  it("accepts a signature computed the Svix way, including one of several space-separated entries", () => {
    const good = signSvixPayload(body, "msg_1", ts, WEBHOOK_SECRET);
    expect(verifySvixSignature(body, { id: "msg_1", timestamp: ts, signature: good }, WEBHOOK_SECRET, now)).toEqual({ ok: true });
    const multi = `v1,${Buffer.from("nope").toString("base64")} ${good}`;
    expect(verifySvixSignature(body, { id: "msg_1", timestamp: ts, signature: multi }, WEBHOOK_SECRET, now)).toEqual({ ok: true });
  });

  it("refuses a wrong signature, a different id, a tampered body, and a stale timestamp", () => {
    const good = signSvixPayload(body, "msg_1", ts, WEBHOOK_SECRET);
    expect(verifySvixSignature(body, { id: "msg_2", timestamp: ts, signature: good }, WEBHOOK_SECRET, now).ok).toBe(false);
    expect(verifySvixSignature(body + " ", { id: "msg_1", timestamp: ts, signature: good }, WEBHOOK_SECRET, now).ok).toBe(false);
    expect(verifySvixSignature(body, { id: "msg_1", timestamp: ts, signature: `v1,${Buffer.from("x").toString("base64")}` }, WEBHOOK_SECRET, now).ok).toBe(false);
    const stale = String(Math.floor(now / 1000) - 6 * 60);
    const staleSig = signSvixPayload(body, "msg_1", stale, WEBHOOK_SECRET);
    const r = verifySvixSignature(body, { id: "msg_1", timestamp: stale, signature: staleSig }, WEBHOOK_SECRET, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("five-minute");
    expect(verifySvixSignature(body, { id: "msg_1", timestamp: ts, signature: good }, "whsec_" + randomBytes(24).toString("base64"), now).ok).toBe(false);
  });
});

// ── 3. The webhook ───────────────────────────────────────────────────────────

describe("POST /resend/webhook", () => {
  const DELIVERED_ID = `txre_delivered_${RUN}`;
  const BOUNCED_ID = `txre_bounced_${RUN}`;
  const bouncedAt = "2026-09-09T21:02:12.000Z";

  beforeAll(async () => {
    resetResendWebhookState();
    await prisma.emailDelivery.createMany({
      data: [
        { provider: "resend", providerMessageId: DELIVERED_ID, to: CUSTOMER_EMAIL, subject: "Your invoice from Red Cedar Electric — 0000-9101", kind: "invoice", estimateNumber: ESTIMATE_NUMBER, issuedEstimateId: estimateId, status: "sent", statusAt: new Date() },
        { provider: "resend", providerMessageId: BOUNCED_ID, to: CUSTOMER_EMAIL, subject: "Your estimate from Red Cedar Electric — 0000-9101", kind: "estimate", estimateNumber: ESTIMATE_NUMBER, issuedEstimateId: estimateId, status: "sent", statusAt: new Date() },
      ],
    });
  });

  it("email.delivered marks the row delivered with the event time", async () => {
    const res = await postWebhook({
      type: "email.delivered",
      created_at: "2026-09-09T20:59:00.000Z",
      data: { email_id: DELIVERED_ID, created_at: "2026-09-09T20:59:00.000Z", to: [CUSTOMER_EMAIL], subject: "Your invoice from Red Cedar Electric — 0000-9101" },
    });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.matched).toBe(true);
    const row = await prisma.emailDelivery.findUnique({ where: { providerMessageId: DELIVERED_ID } });
    expect(row!.status).toBe("delivered");
    expect(row!.statusAt?.toISOString()).toBe("2026-09-09T20:59:00.000Z");
  });

  it("a late email.sent never rewinds a delivered row", async () => {
    const res = await postWebhook({
      type: "email.sent",
      data: { email_id: DELIVERED_ID, created_at: "2026-09-09T20:58:00.000Z", to: [CUSTOMER_EMAIL] },
    });
    expect(res.status).toBe(200);
    const row = await prisma.emailDelivery.findUnique({ where: { providerMessageId: DELIVERED_ID } });
    expect(row!.status).toBe("delivered");
  });

  it("email.bounced files an EmailBounce, stamps the estimate, logs one WARN — and a retry is idempotent", async () => {
    const event = {
      type: "email.bounced",
      created_at: bouncedAt,
      data: {
        email_id: BOUNCED_ID,
        created_at: bouncedAt,
        to: [CUSTOMER_EMAIL],
        subject: "Your estimate from Red Cedar Electric — 0000-9101",
        bounce: { type: "Permanent", subType: "General", message: "The recipient's email provider sent a hard bounce message." },
      },
    };
    const first = await postWebhook(event);
    expect(first.status).toBe(200);
    expect(first.body.bounceFiled).toBe(true);

    const delivery = await prisma.emailDelivery.findUnique({ where: { providerMessageId: BOUNCED_ID } });
    expect(delivery!.status).toBe("bounced");
    expect(delivery!.statusAt?.toISOString()).toBe(bouncedAt);
    expect(delivery!.error).toContain("hard bounce");

    const bounce = await prisma.emailBounce.findUnique({ where: { providerMessageId: BOUNCED_ID } });
    expect(bounce).not.toBeNull();
    expect(bounce!.provider).toBe("resend");
    expect(bounce!.gmailMessageId).toBeNull();
    expect(bounce!.recipient).toBe(CUSTOMER_EMAIL);
    expect(bounce!.status).toBe("Permanent");
    expect(bounce!.diagnostic).toContain("hard bounce");
    expect(bounce!.kind).toBe("estimate");
    expect(bounce!.estimateNumber).toBe(ESTIMATE_NUMBER);
    expect(bounce!.issuedEstimateId).toBe(estimateId);
    expect(bounce!.bouncedAt.toISOString()).toBe(bouncedAt);
    expect(bounce!.resolvedAt).toBeNull();

    const est = await prisma.issuedEstimate.findUnique({ where: { id: estimateId } });
    expect(est!.lastBounceAt?.toISOString()).toBe(bouncedAt);
    expect(est!.lastBounceReason).toContain(CUSTOMER_EMAIL);
    expect(est!.lastBounceReason).toContain("Permanent");

    const warns = await waitForEvents({ source: "email", level: "warn", message: { contains: `bounced (Resend): ${CUSTOMER_EMAIL}` } }, 1);
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain(ESTIMATE_NUMBER);

    // Svix retries the same event: nothing new.
    const second = await postWebhook(event);
    expect(second.status).toBe(200);
    expect(second.body.bounceFiled).toBe(false);
    expect(await prisma.emailBounce.count({ where: { providerMessageId: BOUNCED_ID } })).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(await prisma.systemEvent.count({ where: { source: "email", level: "warn", message: { contains: `bounced (Resend): ${CUSTOMER_EMAIL}` } } })).toBe(1);

    // The Financials card lists it beside the Gmail DSNs, with its provider.
    const list = await request(app).get("/email-bounces?unresolved=1");
    expect(list.status).toBe(200);
    const listed = (list.body as Array<{ providerMessageId: string | null; provider: string; recipient: string; account: { id: string } | null }>)
      .find((b) => b.providerMessageId === BOUNCED_ID);
    expect(listed?.provider).toBe("resend");
    expect(listed?.recipient).toBe(CUSTOMER_EMAIL);
    expect(listed?.account?.id).toBe(customerId);
  });

  it("email.opened is acknowledged and ignored", async () => {
    const res = await postWebhook({ type: "email.opened", data: { email_id: DELIVERED_ID, to: [CUSTOMER_EMAIL] } });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
    const row = await prisma.emailDelivery.findUnique({ where: { providerMessageId: DELIVERED_ID } });
    expect(row!.status).toBe("delivered");
  });

  it("a bad signature is 400", async () => {
    const res = await postWebhook(
      { type: "email.delivered", data: { email_id: DELIVERED_ID, to: [CUSTOMER_EMAIL] } },
      { signature: `v1,${Buffer.from("forged").toString("base64")}` },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("signature");
  });

  it("a stale timestamp is 400 even when the signature over it is right", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const res = await postWebhook({ type: "email.delivered", data: { email_id: DELIVERED_ID, to: [CUSTOMER_EMAIL] } }, { timestamp: stale });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("five-minute");
  });

  it("a missing secret is 503 with a clear message and one WARN", async () => {
    const saved = process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.RESEND_WEBHOOK_SECRET;
    try {
      const res = await postWebhook({ type: "email.delivered", data: { email_id: DELIVERED_ID, to: [CUSTOMER_EMAIL] } }, { secret: saved });
      expect(res.status).toBe(503);
      expect(res.body.error).toContain("RESEND_WEBHOOK_SECRET");
      const again = await postWebhook({ type: "email.delivered", data: { email_id: DELIVERED_ID, to: [CUSTOMER_EMAIL] } }, { secret: saved });
      expect(again.status).toBe(503);
      const warns = await waitForEvents({ source: "email", level: "warn", message: { contains: "RESEND_WEBHOOK_SECRET is not set" } }, 1);
      expect(warns).toHaveLength(1);
    } finally {
      process.env.RESEND_WEBHOOK_SECRET = saved;
    }
  });

  it("the route is public by signature, not by session — an unsigned POST is refused, not 401", async () => {
    const res = await request(app).post("/resend/webhook").set("Content-Type", "application/json").send('{"type":"email.delivered"}');
    expect(res.status).toBe(400);
  });
});

// ── 4. The read side ─────────────────────────────────────────────────────────

describe("read side", () => {
  it("GET /email-deliveries?estimateId= lists the estimate's emails newest first", async () => {
    const res = await request(app).get(`/email-deliveries?estimateId=${estimateId}&limit=10`);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ providerMessageId: string | null; status: string; createdAt: string; estimate: { number: string } | null }>;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < rows.length; i += 1) {
      expect(new Date(rows[i - 1].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(rows[i].createdAt).getTime());
    }
    expect(rows.some((r) => r.providerMessageId === `txre_bounced_${RUN}` && r.status === "bounced")).toBe(true);
    expect(rows[0].estimate?.number).toBe(ESTIMATE_NUMBER);
  });

  it("GET /email-status reports the pipe, the webhook, and the last 24 h by status", async () => {
    const res = await request(app).get("/email-status");
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("resend");
    expect(res.body.from).toBe("Red Cedar Electric <service@redcedarelectricllc.com>");
    expect(res.body.replyTo).toBe("service@redcedarelectricllc.com");
    expect(res.body.bccSelf).toBe(true);
    expect(res.body.resendConfigured).toBe(true);
    expect(res.body.gmailConfigured).toBe(true);
    expect(res.body.webhookSecretSet).toBe(true);
    expect(typeof res.body.lastWebhookEventAt).toBe("string");
    const c = res.body.last24h as Record<string, number>;
    for (const k of ["sent", "delivered", "delayed", "bounced", "complained", "failed", "total"]) expect(typeof c[k]).toBe("number");
    expect(c.delivered).toBeGreaterThanOrEqual(1);
    expect(c.bounced).toBeGreaterThanOrEqual(1);
    expect(c.failed).toBeGreaterThanOrEqual(1);
    expect(c.total).toBeGreaterThanOrEqual(c.delivered + c.bounced + c.failed);
  });

  it("the estimate chain, the invoice list and the account rows carry lastDelivery (the newest row)", async () => {
    // The newest delivery for this estimate is a fresh Resend send that is still "sent".
    fetchMock.mockResolvedValueOnce(resendOk(`txre_newest_${RUN}`));
    await sendCustomerEmail({ to: CUSTOMER_EMAIL, subject: "Your invoice from Red Cedar Electric — 0000-9101", html: "<p>x</p>", kind: "invoice", estimateNumber: ESTIMATE_NUMBER, issuedEstimateId: estimateId });

    type Row = { id: string; lastDelivery: { provider: string; status: string; statusAt: string | null; to: string } | null };
    const chain = await request(app).get("/issued-estimates/chain");
    expect(chain.status).toBe(200);
    const chainRow = (chain.body.estimates as Row[]).find((r) => r.id === estimateId);
    expect(chainRow?.lastDelivery).toMatchObject({ provider: "resend", status: "sent", to: CUSTOMER_EMAIL });

    const invoices = await request(app).get("/invoices");
    expect(invoices.status).toBe(200);
    const inv = (invoices.body as Row[]).find((r) => r.id === estimateId);
    expect(inv?.lastDelivery).toMatchObject({ provider: "resend", status: "sent", to: CUSTOMER_EMAIL });

    const account = await request(app).get(`/accounts/${customerId}/estimates`);
    expect(account.status).toBe(200);
    const acc = (account.body.estimates as Row[]).find((r) => r.id === estimateId);
    expect(acc?.lastDelivery).toMatchObject({ provider: "resend", status: "sent", to: CUSTOMER_EMAIL });

    // Deliver it and the chip turns green on every surface.
    await postWebhook({ type: "email.delivered", data: { email_id: `txre_newest_${RUN}`, created_at: new Date().toISOString(), to: [CUSTOMER_EMAIL] } });
    const after = await request(app).get("/issued-estimates/chain");
    const afterRow = (after.body.estimates as Row[]).find((r) => r.id === estimateId);
    expect(afterRow?.lastDelivery?.status).toBe("delivered");
    expect(afterRow?.lastDelivery?.statusAt).toBeTruthy();
  });
});
