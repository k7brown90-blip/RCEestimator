/**
 * P017 rev 2 — the app's own access log, and the closure of the last Twilio surface.
 *
 * The bar for each is different.
 *
 * For the LOG, the expensive failure is not "a line is missing" — it is "a line contains a
 * customer's name". The log exists because of an incident question; a log that leaks the data it
 * was built to protect is worse than no log. So these tests assert the SHAPE is closed: exactly
 * the allowlisted keys, and no body content, ever.
 *
 * For the CLOSURE, the expensive failure is a webhook that still writes after Kyle ruled the
 * channel out of operations. `/sms/inbound` creates receipt rows, technician job notes and
 * customer confirmation actions — so a refusal must happen before any of that, and must be
 * provably before it: every closure test asserts the row count did not move.
 *
 * The signature checks live on behind the closure as the second line of defence for the day the
 * channel re-opens, so their tests open the channel explicitly.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";

process.env.TWILIO_AUTH_TOKEN = "p017_test_token";

vi.mock("googleapis", () => {
  class MockOAuth2 { setCredentials() {} }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }) },
        events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }) },
      }),
    },
  };
});

import { app } from "../src/app";
import { emitAccessLog, type AccessLogLine, redactPath } from "../src/middleware/accessLog";
import { computeTwilioSignature, requestUrlForSignature } from "../src/middleware/twilioSignature";
import { postForgedTwilioWebhook, postSignedTwilioWebhook } from "./helpers/twilioWebhook";
import { isPublicRoute } from "../src/middleware/publicRoutes";
import { logTwilioInboundState, twilioInboundEnabled } from "../src/services/automationGate";

const FORGED_PHONE = "+15550117777";

/** Capture the JSON access lines emitted during `fn`. */
async function captureLog(fn: () => Promise<unknown>): Promise<AccessLogLine[]> {
  const lines: AccessLogLine[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    const first = args[0];
    if (typeof first !== "string" || !first.startsWith("{\"log\":\"access\"")) return;
    const parsed = JSON.parse(first) as AccessLogLine & { log: string };
    lines.push(parsed);
  });
  try {
    await fn();
    // The line is written on response `finish`, which can land a tick after supertest resolves.
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    spy.mockRestore();
  }
  return lines;
}

afterAll(async () => {
  await prisma.inboundMessage.deleteMany({ where: { fromPhone: FORGED_PHONE } });
});

// ─── ACCESS LOG (Scope — do 1, 3) ────────────────────────────────────────────────────────────

describe("access log: shape is closed", () => {
  const EXPECTED_KEYS = ["log", "t", "method", "path", "status", "auth", "actor", "ip", "ms"].sort();

  it("emits exactly the allowlisted fields and nothing else", async () => {
    const lines = await captureLog(() => request(app).get("/atomic-units?search=panel"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(EXPECTED_KEYS);
    }
  });

  it("never carries the query string — a search term can be a customer's name", async () => {
    const lines = await captureLog(() =>
      request(app).get("/atomic-units?search=Jane%20Doe%20Nashville")
    );
    const blob = JSON.stringify(lines);
    expect(blob).not.toContain("Jane");
    expect(blob).not.toContain("Doe");
    expect(blob).not.toContain("Nashville");
    expect(lines.some((l) => l.path === "/atomic-units")).toBe(true);
  });

  it("never carries a request body", async () => {
    const secret = "Marjorie-Hollingsworth-4821-Cedar-Lane";
    const lines = await captureLog(() =>
      request(app).post("/leads").send({ name: secret, phone: "+15550110000" })
    );
    expect(JSON.stringify(lines)).not.toContain("Marjorie");
    expect(JSON.stringify(lines)).not.toContain("Cedar");
  });

  it("redacts the internal webhook token out of the path", async () => {
    // Found in production within a minute of the first P017 deploy: this log wrote
    // INTERNAL_WEBHOOK_TOKEN in plaintext, reproducing P015 review follow-up 4 inside our own
    // records. A log that leaks a secret is worse than no log.
    const lines = await captureLog(() =>
      request(app).post("/internal/webhooks/twilio-status/supersecrettokenvalue").type("form").send({})
    );
    const blob = JSON.stringify(lines);
    expect(blob).not.toContain("supersecrettokenvalue");
    expect(lines.some((l) => l.path === "/internal/webhooks/twilio-status/<token>")).toBe(true);
  });

  it("keeps the mount prefix — a router-served path is logged in full", async () => {
    // Express rewrites req.url on entry to a mounted router; reading the path at response time
    // logged `/webhooks/...` instead of `/internal/webhooks/...`. A forensic log that drops the
    // mount prefix cannot distinguish two routes that differ only by mount.
    const lines = await captureLog(() => request(app).get("/confirm/some-token"));
    expect(lines.some((l) => l.path.startsWith("/confirm/"))).toBe(true);
  });

  it("logs the caller's IP, not the proxy's", async () => {
    const lines = await captureLog(() =>
      request(app).get("/healthz").set("X-Forwarded-For", "203.0.113.7, 10.0.0.1, 10.0.0.2")
    );
    expect(lines.find((l) => l.path === "/healthz")?.ip).toBe("203.0.113.7");
  });

  it("records method, path, status and latency for a real request", async () => {
    const lines = await captureLog(() => request(app).get("/healthz"));
    const line = lines.find((l) => l.path === "/healthz");
    expect(line).toBeDefined();
    expect(line!.method).toBe("GET");
    expect(line!.status).toBe(200);
    expect(typeof line!.ms).toBe("number");
    expect(line!.ms).toBeGreaterThanOrEqual(0);
    expect(new Date(line!.t).toString()).not.toBe("Invalid Date");
  });

  it("emitAccessLog cannot be handed extra fields — the helper assigns by name", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    emitAccessLog({
      t: "2026-08-16T00:00:00.000Z", method: "GET", path: "/x", status: 200,
      auth: "ok", actor: "owner", ip: "1.2.3.4", ms: 1,
      // A caller trying to smuggle a body through is dropped on the floor, not passed along.
      ...({ body: { customerName: "Should Not Appear" } } as object),
    } as AccessLogLine);
    const emitted = String(spy.mock.calls[0][0]);
    spy.mockRestore();
    expect(emitted).not.toContain("Should Not Appear");
    expect(emitted).not.toContain("body");
  });
});

describe("access log: auth outcome is recorded, not inferred", () => {
  beforeAll(async () => {
    process.env.PIN_HASH = await bcrypt.hash("246800", 10);
  });
  afterAll(() => {
    delete process.env.PIN_HASH;
  });

  it("an unauthenticated hit on a protected route logs `unauthenticated`", async () => {
    const lines = await captureLog(() => request(app).get("/accounts"));
    const line = lines.find((l) => l.path === "/accounts");
    expect(line?.auth).toBe("unauthenticated");
    expect(line?.status).toBe(401);
    expect(line?.actor).toBeNull();
  });

  it("a garbage token logs `bad-credentials` — distinct from presenting nothing", async () => {
    const lines = await captureLog(() =>
      request(app).get("/accounts").set("Authorization", "Bearer nope")
    );
    const line = lines.find((l) => l.path === "/accounts");
    expect(line?.auth).toBe("bad-credentials");
    expect(line?.status).toBe(401);
  });

  it("an authenticated request logs `ok` and the actor, never the token", async () => {
    const login = await request(app).post("/auth/pin").send({ pin: "246800" });
    expect(login.status).toBe(200);
    const token = login.body.token as string;

    const lines = await captureLog(() =>
      request(app).get("/accounts").set("Authorization", `Bearer ${token}`)
    );
    const line = lines.find((l) => l.path === "/accounts");
    expect(line?.auth).toBe("ok");
    expect(line?.actor).toBe("owner");
    expect(line?.status).toBe(200);
    expect(JSON.stringify(lines)).not.toContain(token);
  });

  it("a wrong-PIN attempt is logged, and the PIN is not in the line", async () => {
    const lines = await captureLog(() =>
      request(app).post("/auth/pin").send({ pin: "999999" })
    );
    const line = lines.find((l) => l.path === "/auth/pin");
    expect(line?.status).toBe(401);
    expect(line?.auth).toBe("public"); // the login route is allowlisted; the 401 is the PIN check
    expect(JSON.stringify(lines)).not.toContain("999999");
  });

  it("an allowlisted route logs `public`", async () => {
    const lines = await captureLog(() => request(app).get("/healthz"));
    expect(lines.find((l) => l.path === "/healthz")?.auth).toBe("public");
  });
});

// ─── TWILIO SIGNATURE (Scope — do 2, 3) ──────────────────────────────────────────────────────

describe("twilio signature: the algorithm", () => {
  /**
   * NOT a hard-coded vendor test vector. I could not verify one from an authoritative source in
   * this environment, and asserting a constant I cannot check would pin the implementation to my
   * recollection rather than to Twilio's spec — "never make up a number" applies to a signature
   * as much as to a price.
   *
   * Instead the rule is restated here from primitives, independently of the implementation's
   * control flow: signing string = URL, then every parameter in lexicographic key order as
   * key+value, HMAC-SHA1 with the auth token, base64. If the implementation stops sorting, stops
   * concatenating values, or changes digest/encoding, this fails.
   *
   * The end-to-end proof that this matches TWILIO — not just itself — is a real inbound text
   * from a real phone reaching the app in production. That is the prompt's use bar, and it is
   * the only thing that can settle it.
   */
  it("is URL + params in lexicographic key order as key+value, HMAC-SHA1, base64", async () => {
    const crypto = await import("node:crypto");
    const token = "an-auth-token";
    const url = "https://example.com/sms/inbound";

    // Insertion order deliberately reversed against sort order, so an implementation that
    // iterated the object as given would produce a different string.
    const params = { Zeta: "last", Alpha: "first", Mid: "middle" };

    const expected = crypto
      .createHmac("sha1", token)
      .update(Buffer.from(`${url}Alphafirst` + `Midmiddle` + `Zetalast`, "utf-8"))
      .digest("base64");

    expect(computeTwilioSignature(token, url, params)).toBe(expected);
  });

  it("changes when the token, the URL, or any single parameter changes", () => {
    const base = computeTwilioSignature("tok", "https://a.test/x", { A: "1", B: "2" });
    expect(computeTwilioSignature("tok2", "https://a.test/x", { A: "1", B: "2" })).not.toBe(base);
    expect(computeTwilioSignature("tok", "https://a.test/y", { A: "1", B: "2" })).not.toBe(base);
    expect(computeTwilioSignature("tok", "https://a.test/x", { A: "1", B: "3" })).not.toBe(base);
    expect(computeTwilioSignature("tok", "https://a.test/x", { A: "1" })).not.toBe(base);
  });

  it("treats a null or absent value as an empty string rather than the text 'null'", () => {
    const withNull = computeTwilioSignature("tok", "https://a.test/x", { A: null });
    const withEmpty = computeTwilioSignature("tok", "https://a.test/x", { A: "" });
    expect(withNull).toBe(withEmpty);
  });

  it("reconstructs the public URL from the forwarded headers, not the internal one", () => {
    const req = {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "example.com", host: "10.0.0.1:8080" },
      protocol: "http",
      originalUrl: "/sms/inbound",
    } as unknown as Parameters<typeof requestUrlForSignature>[0];
    expect(requestUrlForSignature(req)).toBe("https://example.com/sms/inbound");
  });
});

describe("twilio signature: the second line of defence, for a re-opened channel", () => {
  // These assert what happens when the channel is OPEN. Closed is the describe block after this
  // one, and closed is production's state.
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = "p017_test_token";
    process.env.TWILIO_INBOUND_SMS_WEBHOOK = "on";
  });
  afterEach(() => {
    process.env.TWILIO_AUTH_TOKEN = "p017_test_token";
    delete process.env.TWILIO_INBOUND_SMS_WEBHOOK;
  });

  it("rejects a forged signature with 403 and processes nothing", async () => {
    const before = await prisma.inboundMessage.count({ where: { fromPhone: FORGED_PHONE } });

    const res = await postForgedTwilioWebhook(app, "/sms/inbound", {
      From: FORGED_PHONE,
      Body: "forged receipt injection",
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("signature");
    // The write is the thing that matters — a refusal that still logged the message would be
    // exactly the injection this closes.
    expect(await prisma.inboundMessage.count({ where: { fromPhone: FORGED_PHONE } })).toBe(before);
  });

  it("rejects a request with no signature header at all", async () => {
    const res = await request(app)
      .post("/sms/inbound")
      .type("form")
      .send({ From: FORGED_PHONE, Body: "no signature" });
    expect(res.status).toBe(403);
    expect(await prisma.inboundMessage.count({ where: { fromPhone: FORGED_PHONE } })).toBe(0);
  });

  it("accepts a correctly signed request and processes it", async () => {
    const phone = "+15550118888";
    const res = await postSignedTwilioWebhook(app, "/sms/inbound", { From: phone, Body: "signed and real" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("xml");

    const logged = await prisma.inboundMessage.findFirst({ where: { fromPhone: phone } });
    expect(logged).not.toBeNull();
    expect(logged!.body).toBe("signed and real");
    await prisma.inboundMessage.deleteMany({ where: { fromPhone: phone } });
  });

  it("a signature valid for a DIFFERENT body does not carry over", async () => {
    const body = { From: FORGED_PHONE, Body: "original" };
    const url = `https://test.local/sms/inbound`;
    const sig = computeTwilioSignature("p017_test_token", url, body);

    const res = await request(app)
      .post("/sms/inbound")
      .set("X-Forwarded-Proto", "https")
      .set("X-Forwarded-Host", "test.local")
      .set("X-Twilio-Signature", sig)
      .type("form")
      .send({ ...body, Body: "tampered" });

    expect(res.status).toBe(403);
  });

  it("fails CLOSED with 503 when TWILIO_AUTH_TOKEN is unset — the /mcp precedent", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const res = await request(app)
      .post("/sms/inbound")
      .type("form")
      .send({ From: FORGED_PHONE, Body: "unconfigured" });
    expect(res.status).toBe(503);
    expect(String(res.body.detail)).toContain("unset");
    expect(await prisma.inboundMessage.count({ where: { fromPhone: FORGED_PHONE } })).toBe(0);
  });

  it("logs the refusal as bad-signature rather than as a generic 403", async () => {
    const lines = await captureLog(() =>
      postForgedTwilioWebhook(app, "/sms/inbound", { From: FORGED_PHONE, Body: "forged" })
    );
    const line = lines.find((l) => l.path === "/sms/inbound");
    expect(line?.auth).toBe("bad-signature");
    expect(line?.status).toBe(403);
    // The customer's message text must not reach the log.
    expect(JSON.stringify(lines)).not.toContain("forged");
  });
});

// ─── TWILIO INBOUND CLOSURE — P017 rev 2, Scope — do 2/3/4 ───────────────────────────────────

describe("the inbound Twilio channel is closed", () => {
  const PROBE = "+15550119999";

  beforeEach(() => {
    delete process.env.TWILIO_INBOUND;
    delete process.env.TWILIO_INBOUND_SMS_WEBHOOK;
    delete process.env.TWILIO_INBOUND_STATUS_CALLBACK;
  });
  afterAll(async () => {
    await prisma.inboundMessage.deleteMany({ where: { fromPhone: PROBE } });
  });

  it("closed by default — no env var required to be safe", () => {
    expect(twilioInboundEnabled("smsWebhook")).toBe(false);
    expect(twilioInboundEnabled("statusCallback")).toBe(false);
  });

  it("POST /sms/inbound returns 410 and writes nothing", async () => {
    const before = await prisma.inboundMessage.count();

    const res = await postSignedTwilioWebhook(app, "/sms/inbound", { From: PROBE, Body: "should not land" });

    expect(res.status).toBe(410);
    expect(String(res.body.error)).toContain("closed");
    // Signed correctly and STILL refused — the closure is not a signature check.
    expect(await prisma.inboundMessage.count()).toBe(before);
    expect(await prisma.inboundMessage.findFirst({ where: { fromPhone: PROBE } })).toBeNull();
  });

  it("refuses unread — an unsigned, unparseable post is 410 too, not 403 or 400", async () => {
    const res = await request(app).post("/sms/inbound").type("form").send({ From: PROBE, Body: "x" });
    expect(res.status).toBe(410);
  });

  it("the delivery-status callback is closed the same way (the sweep's second surface)", async () => {
    const res = await request(app)
      .post("/internal/webhooks/twilio-status/any-token")
      .type("form")
      .send({ MessageSid: "SM1", MessageStatus: "delivered" });
    expect(res.status).toBe(410);
  });

  it("logs the refusal as channel-disabled", async () => {
    const lines = await captureLog(() =>
      request(app).post("/sms/inbound").type("form").send({ From: PROBE, Body: "probe" })
    );
    const line = lines.find((l) => l.path === "/sms/inbound");
    expect(line?.auth).toBe("channel-disabled");
    expect(line?.status).toBe(410);
    // The message body is a customer's text. It is refused unread and must not appear.
    expect(JSON.stringify(lines)).not.toContain("probe");
  });

  it("drops off the public allowlist while closed, so default-deny is the backstop", () => {
    expect(isPublicRoute("POST", "/sms/inbound")).toBe(false);
    process.env.TWILIO_INBOUND_SMS_WEBHOOK = "on";
    expect(isPublicRoute("POST", "/sms/inbound")).toBe(true);
    delete process.env.TWILIO_INBOUND_SMS_WEBHOOK;
  });

  it("the env flag re-opens it — closed is a switch, not a demolition", async () => {
    process.env.TWILIO_INBOUND_SMS_WEBHOOK = "on";
    const res = await postSignedTwilioWebhook(app, "/sms/inbound", { From: PROBE, Body: "channel reopened" });
    expect(res.status).toBe(200);
    expect(await prisma.inboundMessage.findFirst({ where: { fromPhone: PROBE } })).not.toBeNull();
    delete process.env.TWILIO_INBOUND_SMS_WEBHOOK;
    await prisma.inboundMessage.deleteMany({ where: { fromPhone: PROBE } });
  });

  it("the master flag re-opens both surfaces", () => {
    process.env.TWILIO_INBOUND = "on";
    expect(twilioInboundEnabled("smsWebhook")).toBe(true);
    expect(twilioInboundEnabled("statusCallback")).toBe(true);
    delete process.env.TWILIO_INBOUND;
  });

  it("fails closed on a malformed flag value", () => {
    for (const bad of ["", " ", "off", "no", "ON!", "yess", "open"]) {
      process.env.TWILIO_INBOUND_SMS_WEBHOOK = bad;
      expect(twilioInboundEnabled("smsWebhook"), `flag=${JSON.stringify(bad)}`).toBe(false);
    }
    delete process.env.TWILIO_INBOUND_SMS_WEBHOOK;
  });

  it("the boot report states both surfaces CLOSED", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logTwilioInboundState();
    const out = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    spy.mockRestore();
    expect(out).toContain("MASTER TWILIO_INBOUND=(unset) -> CLOSED (default)");
    expect(out).toContain("CLOSED smsWebhook");
    expect(out).toContain("CLOSED statusCallback");
  });
});

describe("no send path was created", () => {
  it("P013's gates are untouched — every leg still defaults off", async () => {
    const { twilioSendEnabled } = await import("../src/services/automationGate");
    for (const leg of ["operatorAlerts", "operatorNotifications", "technicianSends", "inboundAcks", "agentSends", "customerLifecycleSms"] as const) {
      expect(twilioSendEnabled(leg), `${leg} must still default off`).toBe(false);
    }
  });
});

/**
 * P029 rider — customer capability tokens must not reach the access log.
 *
 * `/e/:token` is the estimate page and `/confirm/:token` the appointment page. In both, the path
 * segment IS the credential: whoever holds it can read the estimate and SIGN it, or confirm and
 * cancel an appointment. Logging it in plaintext puts a working signature capability into a
 * stream that exists to be read later. Raised by the P027 report; same treatment the Railway
 * webhook token already had.
 */
describe("access log redacts customer capability tokens", () => {
  const TOKEN = "a".repeat(64);

  it("redacts the estimate token but keeps the route visible", () => {
    const out = redactPath(`/e/${TOKEN}`);
    expect(out).toBe("/e/<token>");
    expect(out).not.toContain(TOKEN);
  });

  it("redacts the estimate token on the sign path too", () => {
    const out = redactPath(`/e/${TOKEN}/sign`);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("/e/<token>");
  });

  it("redacts the appointment confirmation token", () => {
    const out = redactPath(`/confirm/${TOKEN}`);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("<token>");
  });

  it("leaves ordinary paths alone", () => {
    expect(redactPath("/accounts")).toBe("/accounts");
    expect(redactPath("/issued-estimates/abc123")).toBe("/issued-estimates/abc123");
  });
});
