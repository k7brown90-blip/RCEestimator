/**
 * P028 — in-person signing mode.
 *
 * The claim this file has to earn is **"the customer cannot get out of this estimate."** The
 * customer is holding a phone with a valid CRM session on it, so hidden navigation proves
 * nothing: what matters is what the SERVER answers when a request is made anyway.
 *
 * So the isolation tests are all BY REQUEST — a signing-scoped token is minted, and then real
 * requests go at the accounts list, the leads list, other estimates, the price book and the send
 * endpoint. Every one must be refused. A test that only asserted "the nav is hidden" would pass
 * on a build where typing a URL still worked, which is exactly the failure mode.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft, signEstimateInPerson } from "../src/services/issuedEstimateService";
import { renderEstimatePage } from "../src/services/issuedEstimateRender";
import { mintSigningToken, signingSessionAllows } from "../src/middleware/signingScope";

const MARK = "P028";
const TEST_PIN = "802468";
const GOOD_A = "BF001";
const GOOD_B = "A008";

let customerId: string;
let propertyId: string;
let visitId: string;
let ownerToken: string;
const draftIds: string[] = [];

async function cleanEstimates() {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: draftIds } } });
  const ids = ests.map((e) => e.id);
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: ids } }, data: { supersedesId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: ids } } });
}

async function issuedEstimate(title: string) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: GOOD_A, quantity: 1, quantitySource: "COUNT" });
  await addLine(prisma, d.id, { itemId: GOOD_B, quantity: 1, quantitySource: "COUNT" });
  const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
  if (!g.ok) throw new Error(`graduation failed: ${g.reasons.join("; ")}`);
  return g;
}

beforeAll(async () => {
  process.env.PIN_HASH = await bcrypt.hash(TEST_PIN, 10);
  ownerToken = jwt.sign({ sub: "owner" }, process.env.JWT_SECRET ?? "rce-dev-secret-change-me", {
    expiresIn: "1h",
  });

  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "p028@example.com" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: {
      customerId,
      name: `${MARK} House`,
      addressLine1: "28 Signing Lane",
      city: "La Vergne",
      state: "TN",
      postalCode: "37086",
    },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" },
  });
  visitId = visit.id;
});

afterAll(async () => {
  await cleanEstimates();
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  delete process.env.PIN_HASH;
});

// ─── Entering signing mode ──────────────────────────────────────────────────────

describe("entering signing mode", () => {
  it("requires a full session and hands back a scoped token", async () => {
    const g = await issuedEstimate("enter");

    const anon = await request(app).post(`/issued-estimates/${g.estimateId}/signing-mode`).send({});
    expect(anon.status).toBe(401);

    const res = await request(app)
      .post(`/issued-estimates/${g.estimateId}/signing-mode`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.estimateId).toBe(g.estimateId);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token).not.toBe(ownerToken);

    const est = await prisma.issuedEstimate.findUnique({
      where: { id: g.estimateId },
      include: { events: true },
    });
    expect(est!.events.map((e) => e.type)).toContain("signing_mode");
  });

  it("a signing session cannot open another signing session — no self-renewal", async () => {
    const g = await issuedEstimate("no-renew");
    const { token } = mintSigningToken(g.estimateId);

    const res = await request(app)
      .post(`/issued-estimates/${g.estimateId}/signing-mode`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(403);
  });
});

// ─── THE LOCK. By request, not by hidden buttons. ───────────────────────────────

describe("a signing session reaches nothing but its own estimate", () => {
  it("is refused at every CRM route it might be pointed at", async () => {
    const g = await issuedEstimate("isolation");
    const { token } = mintSigningToken(g.estimateId);
    const auth = { Authorization: `Bearer ${token}` };

    // The routes a customer could plausibly reach for, plus the spellings that have bitten before.
    const probes: Array<[string, string]> = [
      ["get", "/accounts"],
      ["get", "/api/accounts"],
      ["get", "/leads"],
      ["get", "/visits"],
      ["get", "/jobs"],
      ["get", "/properties"],
      ["get", "/price-book/drafts"],
      ["get", "/price-book/atomics?search=panel"],
      ["get", "/issued-estimates"],
      ["get", "/crm/settings"],
    ];

    const leaked: string[] = [];
    for (const [method, path] of probes) {
      const res = await request(app)[method as "get"](path).set(auth).send();
      if (res.status !== 403) leaked.push(`${method.toUpperCase()} ${path} -> ${res.status}`);
    }
    expect(leaked, `\nsigning session reached:\n${leaked.join("\n")}\n`).toEqual([]);
  });

  /**
   * The boundary, stated rather than assumed.
   *
   * `pinAuthMiddleware` checks the public allowlist BEFORE it looks at the token, so an
   * allowlisted route never consults the signing scope at all. That is not a hole this mode
   * opens: those routes are reachable from any browser on the internet without the phone, and
   * each carries its own credential — a webhook secret, a bearer token, or an unguessable token
   * in the path. Signing mode neither widens nor narrows them.
   *
   * What matters is that they still REFUSE an unauthorised caller, which is what this pins.
   */
  it("allowlisted routes are outside signing mode by construction, and still refuse", async () => {
    const g = await issuedEstimate("public-boundary");
    const { token } = mintSigningToken(g.estimateId);
    const auth = { Authorization: `Bearer ${token}` };

    // Public + its own credential -> refused for want of that credential, not for want of session.
    expect((await request(app).get("/calls/daily-summary").set(auth)).status).toBe(401);
    // Public and genuinely open -> answers, exactly as it does for anyone.
    expect((await request(app).get("/healthz").set(auth)).status).toBe(200);
    // And the customer's OWN estimate page is public by token — which they do not have on this
    // device, because in-person mode never puts one in the browser.
    expect((await request(app).get("/e/notatoken").set(auth)).status).toBe(404);
  });

  it("cannot read or sign a DIFFERENT estimate", async () => {
    const mine = await issuedEstimate("mine");
    const other = await issuedEstimate("other");
    const { token } = mintSigningToken(mine.estimateId);
    const auth = { Authorization: `Bearer ${token}` };

    expect((await request(app).get(`/issued-estimates/${other.estimateId}/customer-view`).set(auth)).status).toBe(403);
    expect(
      (await request(app)
        .post(`/issued-estimates/${other.estimateId}/sign-in-person`)
        .set(auth)
        .send({ signerName: "Wrong Estimate" })).status
    ).toBe(403);

    // And the other estimate is genuinely untouched.
    const untouched = await prisma.issuedEstimate.findUnique({ where: { id: other.estimateId } });
    expect(untouched!.signedAt).toBeNull();
  });

  it("cannot trigger the customer email — the send stays operator-only", async () => {
    const g = await issuedEstimate("no-send");
    const { token } = mintSigningToken(g.estimateId);

    const res = await request(app)
      .post(`/issued-estimates/${g.estimateId}/send`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(403);
    const est = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });
    expect(est!.sentAt).toBeNull();
  });

  it("cannot revise, which would mint a fresh token it could then chase", async () => {
    const g = await issuedEstimate("no-revise");
    const { token } = mintSigningToken(g.estimateId);
    const res = await request(app)
      .post(`/issued-estimates/${g.estimateId}/revise`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("reaches exactly the two routes it is supposed to", async () => {
    const g = await issuedEstimate("allowed");
    const { token } = mintSigningToken(g.estimateId);
    const auth = { Authorization: `Bearer ${token}` };

    const view = await request(app).get(`/issued-estimates/${g.estimateId}/customer-view`).set(auth);
    expect(view.status).toBe(200);
    expect(view.text).toContain("ESTIMATE TOTAL");

    const sign = await request(app)
      .post(`/issued-estimates/${g.estimateId}/sign-in-person`)
      .set(auth)
      .send({ signerName: "Test Signature" });
    expect(sign.status).toBe(200);
    expect(sign.body.signed).toBe(true);
  });

  it("the allow-list predicate itself is exact, including near-miss paths", () => {
    const id = "abc123";
    expect(signingSessionAllows("GET", `/issued-estimates/${id}/customer-view`, id)).toBe(true);
    expect(signingSessionAllows("POST", `/issued-estimates/${id}/sign-in-person`, id)).toBe(true);
    // Same shape, different estimate.
    expect(signingSessionAllows("GET", `/issued-estimates/other/customer-view`, id)).toBe(false);
    // Right estimate, wrong action.
    expect(signingSessionAllows("GET", `/issued-estimates/${id}`, id)).toBe(false);
    expect(signingSessionAllows("POST", `/issued-estimates/${id}/send`, id)).toBe(false);
    expect(signingSessionAllows("POST", `/issued-estimates/${id}/revise`, id)).toBe(false);
    // Method matters.
    expect(signingSessionAllows("POST", `/issued-estimates/${id}/customer-view`, id)).toBe(false);
    // Both spellings resolve the same, as everywhere else in this app.
    expect(signingSessionAllows("GET", `/api/issued-estimates/${id}/customer-view`, id)).toBe(true);
    // Prefix games do not work.
    expect(signingSessionAllows("GET", `/issued-estimates/${id}/customer-view/../../accounts`, id)).toBe(false);
  });
});

// ─── Exit is the PIN, and expiry falls to the lock ──────────────────────────────

describe("leaving signing mode", () => {
  it("the PIN mints a full session — and it is the only thing that does", async () => {
    const g = await issuedEstimate("exit");
    const { token } = mintSigningToken(g.estimateId);

    // The signing session cannot reach the accounts list...
    expect((await request(app).get("/accounts").set("Authorization", `Bearer ${token}`)).status).toBe(403);

    // ...a wrong PIN gets nothing...
    expect((await request(app).post("/auth/pin").send({ pin: "000000" })).status).toBe(401);

    // ...and the right PIN hands back a token that does.
    const login = await request(app).post("/auth/pin").send({ pin: TEST_PIN });
    expect(login.status).toBe(200);
    const full = login.body.token as string;
    expect((await request(app).get("/accounts").set("Authorization", `Bearer ${full}`)).status).toBe(200);
  });

  it("an expired signing token is refused, and does not degrade into a full session", async () => {
    const g = await issuedEstimate("expiry");
    const expired = jwt.sign(
      { sub: "signing", est: g.estimateId },
      process.env.JWT_SECRET ?? "rce-dev-secret-change-me",
      { expiresIn: -10 }
    );
    const auth = { Authorization: `Bearer ${expired}` };

    // 401 (dead credential), never 200 — and certainly not on the CRM.
    expect((await request(app).get(`/issued-estimates/${g.estimateId}/customer-view`).set(auth)).status).toBe(401);
    expect((await request(app).get("/accounts").set(auth)).status).toBe(401);
  });
});

// ─── The signature is the same signature ────────────────────────────────────────

describe("the in-person signature", () => {
  it("records channel in_person and locks the estimate exactly like the email path", async () => {
    const g = await issuedEstimate("channel");
    const r = await signEstimateInPerson(prisma, g.estimateId, {
      signerName: "Test Signature",
      ip: "10.0.0.9",
      userAgent: "test-agent",
    });
    expect(r.ok).toBe(true);

    const est = await prisma.issuedEstimate.findUnique({
      where: { id: g.estimateId },
      include: { events: true },
    });
    expect(est!.status).toBe("signed");
    expect(est!.signedChannel).toBe("in_person");
    expect(est!.signerName).toBe("Test Signature");
    expect(est!.signerIp).toBe("10.0.0.9");
    expect(est!.consentText).toContain("electronic signature");

    const signed = est!.events.find((e) => e.type === "signed");
    expect(signed!.actor).toBe("customer:in-person");
    expect(signed!.detail).toContain("in person");
  });

  it("signs once — a second attempt is refused and the first signer stands", async () => {
    const g = await issuedEstimate("once");
    expect((await signEstimateInPerson(prisma, g.estimateId, { signerName: "First" })).ok).toBe(true);
    const second = await signEstimateInPerson(prisma, g.estimateId, { signerName: "Second" });
    expect(second.ok).toBe(false);

    const est = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });
    expect(est!.signerName).toBe("First");
    expect(
      await prisma.issuedEstimateEvent.count({ where: { estimateId: g.estimateId, type: "signed" } })
    ).toBe(1);
  });

  it("an estimate signed in person cannot then be signed from the emailed link", async () => {
    const g = await issuedEstimate("cross-channel");
    await signEstimateInPerson(prisma, g.estimateId, { signerName: "In Person" });

    const est = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });
    const res = await request(app)
      .post(`/e/${est!.token}/sign`)
      .type("form")
      .send({ signerName: "Email Signer" });

    expect(res.status).toBe(400);
    const after = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });
    expect(after!.signerName).toBe("In Person");
    expect(after!.signedChannel).toBe("in_person");
  });

  it("refuses a blank name rather than recording an empty signature", async () => {
    const g = await issuedEstimate("blank");
    const r = await signEstimateInPerson(prisma, g.estimateId, { signerName: " " });
    expect(r.ok).toBe(false);
    const est = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });
    expect(est!.signedAt).toBeNull();
  });
});

// ─── One render, so one no-hours guarantee ──────────────────────────────────────

describe("both channels share one customer render", () => {
  const HOUR_PATTERNS = [
    /\bhours?\b/i,
    /\bhrs?\b/i,
    /\/\s*hr\b/i,
    /lab(o|ou)r\s+h(ou)?rs?/i,
    /\$\s?\d[\d,.]*\s*(?:\/|per\s+)h(?:r|our)/i,
  ];

  it("the in-person render carries no hours either", async () => {
    const g = await issuedEstimate("nohours");
    const est = await prisma.issuedEstimate.findUnique({
      where: { id: g.estimateId },
      include: { lines: { orderBy: { sortOrder: "asc" } }, supersededBy: true },
    });

    const html = renderEstimatePage(est as never, { channel: "in_person" });
    for (const re of HOUR_PATTERNS) expect(html).not.toMatch(re);
    expect(html).toContain("ESTIMATE TOTAL");
  });

  it("the estimate DOCUMENT is identical between channels — only the sign block differs", async () => {
    const g = await issuedEstimate("identical");
    const est = await prisma.issuedEstimate.findUnique({
      where: { id: g.estimateId },
      include: { lines: { orderBy: { sortOrder: "asc" } }, supersededBy: true },
    });

    const email = renderEstimatePage(est as never, { channel: "email" });
    const inPerson = renderEstimatePage(est as never, { channel: "in_person" });

    // Everything above the acceptance block is the same bytes: letterhead, lines, totals, terms.
    const upTo = (s: string) => s.slice(0, s.indexOf("Payment.") + 8);
    expect(upTo(inPerson)).toBe(upTo(email));

    // The email page carries the public form; the in-person page does not, because the React
    // shell renders the signature panel against the session API instead.
    expect(email).toContain(`/e/${est!.token}/sign`);
    expect(inPerson).not.toContain("<form");
  });

  it("serves that same render over HTTP to a signing session", async () => {
    const g = await issuedEstimate("http-render");
    const { token } = mintSigningToken(g.estimateId);
    const res = await request(app)
      .get(`/issued-estimates/${g.estimateId}/customer-view`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    for (const re of HOUR_PATTERNS) expect(res.text).not.toMatch(re);
    expect(res.text).toContain("Work subtotal");
  });
});
