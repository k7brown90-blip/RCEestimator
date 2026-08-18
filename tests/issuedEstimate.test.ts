/**
 * P027 — finalized draft → issued estimate → emailed → signed.
 *
 * What these pin are the properties that would be catastrophic and invisible if they broke:
 *
 *   1. **No hours reach the customer.** Kyle, verbatim: "Never show labor hour estimate to the
 *      customer." The rendered page is grepped for hour patterns. This is the one that was
 *      already violated once, in the PDFs, and caught by Kyle rather than by software.
 *   2. **A gap-carrying draft cannot graduate.** An estimate that omits an unpriced item reads
 *      as a finished price and is not one.
 *   3. **A token reaches exactly one estimate**, and every failure looks identical.
 *   4. **Sign-once.** Two taps must not produce two signatures or overwrite the first signer.
 *   5. **A revision never mutates what was already signed**, and it kills the old link.
 *   6. **Only an authenticated operator can send.**
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import {
  graduateDraft,
  getEstimateByToken,
  reviseEstimate,
  signEstimate,
  newToken,
} from "../src/services/issuedEstimateService";
import { renderEstimatePage } from "../src/services/issuedEstimateRender";

const MARK = "P027";

/** Fully quotable in the seeded catalog: labour value, a unit basis, and a price at HD. */
const GOOD_A = "BF001";
const GOOD_B = "A008";
/** Labour columns are all blank — the row Kyle hit on 2026-08-17. */
const NO_LABOUR = "DG001";

let customerId: string;
let propertyId: string;
let visitId: string;
const draftIds: string[] = [];

async function cleanEstimatesFor(ids: string[]) {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: ids } } });
  const estIds = ests.map((e) => e.id);
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  // Unlink the revision chain before deleting, or the self-FK blocks it.
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
}

beforeAll(async () => {
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "p027-customer@example.com", phone: "615-555-0127" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: {
      customerId,
      name: `${MARK} House`,
      addressLine1: "27 Issued Way",
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
  await cleanEstimatesFor(draftIds);
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
});

/** A draft attached to the job, carrying quotable lines. */
async function quotableDraft(title: string) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: GOOD_A, quantity: 2, quantitySource: "COUNT" });
  await addLine(prisma, d.id, { itemId: GOOD_B, quantity: 1, quantitySource: "COUNT" });
  return d;
}

// ─── 1. Graduation refuses what finalize refuses ────────────────────────────────

describe("graduation refuses a draft that is not gap-free", () => {
  it("refuses a line whose labour is not published, and names it", async () => {
    const d = await createDraft(prisma, { title: `${MARK} gap`, supplierId: "HD", visitId });
    draftIds.push(d.id);
    await addLine(prisma, d.id, { itemId: NO_LABOUR, quantity: 1, quantitySource: "COUNT" });

    const result = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.join(" ")).toContain(NO_LABOUR);
    expect(await prisma.issuedEstimate.count({ where: { draftId: d.id } })).toBe(0);
  });

  it("refuses while an AI proposal is still unconfirmed", async () => {
    const d = await quotableDraft("unconfirmed");
    await prisma.priceBookDraftLine.create({
      data: {
        draftId: d.id,
        itemId: GOOD_A,
        quantity: 1,
        quantitySource: "COUNT",
        state: "PROPOSED",
        proposedBy: "ai:test",
      },
    });

    const result = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.join(" ")).toMatch(/unconfirmed/i);
    expect(await prisma.issuedEstimate.count({ where: { draftId: d.id } })).toBe(0);
  });

  it("refuses an empty draft", async () => {
    const d = await createDraft(prisma, { title: `${MARK} empty`, supplierId: "HD" });
    draftIds.push(d.id);
    const result = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    expect(result.ok).toBe(false);
  });
});

// ─── 2. A clean draft graduates into a frozen snapshot ──────────────────────────

describe("graduation freezes a customer-ready snapshot", () => {
  it("carries flat per-line prices, the trip line, and the customer context", async () => {
    const d = await quotableDraft("clean");
    const result = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId, createdBy: "human:test" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const est = await prisma.issuedEstimate.findUnique({
      where: { id: result.estimateId },
      include: { lines: { orderBy: { sortOrder: "asc" } }, events: true },
    });
    expect(est).not.toBeNull();
    expect(est!.status).toBe("draft");
    expect(est!.revision).toBe(1);
    expect(est!.number).toMatch(/^2026-1\d{3}$/);
    // House numbering continues past the issued PDFs rather than restarting.
    expect(Number(est!.number.split("-")[1])).toBeGreaterThan(1010);

    // Context snapshot, taken from the P024 attachment.
    expect(est!.customerName).toBe(`${MARK} Customer`);
    expect(est!.customerEmail).toBe("p027-customer@example.com");
    expect(est!.serviceAddress).toContain("27 Issued Way");

    // Two lines, each with a flat price, and the arithmetic reconciles.
    expect(est!.lines).toHaveLength(2);
    for (const l of est!.lines) {
      expect(l.lineTotal).toBeGreaterThan(0);
      expect(l.unitPrice).toBeGreaterThan(0);
      expect(Math.abs(l.unitPrice * l.quantity - l.lineTotal)).toBeLessThan(0.02);
    }
    const sum = est!.lines.reduce((s, l) => s + l.lineTotal, 0);
    expect(Math.abs(sum - est!.workSubtotal)).toBeLessThan(0.02);
    expect(est!.tripCharge).toBe(200); // Rate Config jobFixedCost
    expect(Math.abs(est!.total - (est!.workSubtotal + 200))).toBeLessThan(0.005);

    // The token is a 256-bit hex string, not a cuid.
    expect(est!.token).toMatch(/^[0-9a-f]{64}$/);

    // And the audit trail opened.
    expect(est!.events.map((e) => e.type)).toContain("created");
  });

  it("shows a waived trip as a $0.00 line rather than hiding it", async () => {
    const d = await quotableDraft("waived");
    const result = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId, waiveTrip: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const est = await prisma.issuedEstimate.findUnique({ where: { id: result.estimateId } });
    expect(est!.tripCharge).toBe(0);
    expect(est!.tripWaived).toBe(true);
    expect(Math.abs(est!.total - est!.workSubtotal)).toBeLessThan(0.005);

    const html = renderEstimatePage(
      (await getEstimateByToken(prisma, est!.token) as { ok: true; estimate: never }).estimate
    );
    expect(html).toContain("Trip and job setup");
    expect(html).toContain("$0.00");
  });
});

// ─── 3. NO HOURS. The rule this whole flow is built around. ─────────────────────

describe("the customer render carries no hours, no rates, no hour arithmetic", () => {
  /**
   * Deliberately NOT a search for the bare word "rate": the house format says "flat rate", which
   * is correct customer language and is the opposite of the violation. What is banned is any
   * expression of TIME or of money-per-time.
   */
  const HOUR_PATTERNS: Array<[string, RegExp]> = [
    ["the word hour(s)", /\bhours?\b/i],
    ["the abbreviation hr(s)", /\bhrs?\b/i],
    ["a per-hour rate", /\/\s*hr\b/i],
    ["labour hours", /lab(o|ou)r\s+h(ou)?rs?/i],
    ["a dollars-per-hour figure", /\$\s?\d[\d,.]*\s*(?:\/|per\s+)h(?:r|our)/i],
    ["a man-hour figure", /\bman[- ]?h(?:ou)?rs?\b/i],
  ];

  it("finds no hour reference anywhere in the rendered page", async () => {
    const d = await quotableDraft("nohours");
    const result = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId, scopeText: "Install two bath fans and one load center." });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const est = await prisma.issuedEstimate.findUnique({ where: { id: result.estimateId } });
    const found = await getEstimateByToken(prisma, est!.token);
    expect(found.ok).toBe(true);
    if (!found.ok) return;

    const html = renderEstimatePage(found.estimate);

    const hits: string[] = [];
    for (const [label, re] of HOUR_PATTERNS) {
      const m = html.match(re);
      if (m) hits.push(`${label}: "${m[0]}"`);
    }
    expect(hits, `Customer-facing HTML leaked hours:\n${hits.join("\n")}`).toEqual([]);

    // Positive control: the page really is the estimate, so an empty render cannot pass.
    expect(html).toContain("ESTIMATE TOTAL");
    expect(html).toContain(est!.number);
  });

  it("the signed page also carries no hours", async () => {
    const d = await quotableDraft("nohours-signed");
    const result = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const est = await prisma.issuedEstimate.findUnique({ where: { id: result.estimateId } });
    await signEstimate(prisma, est!.token, { signerName: "Test Signature" });

    const found = await getEstimateByToken(prisma, est!.token);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const html = renderEstimatePage(found.estimate);
    for (const [, re] of HOUR_PATTERNS) expect(html).not.toMatch(re);
    expect(html).toContain("Accepted");
  });

  it("the model itself has nowhere to put an hour", async () => {
    // Structural, not editorial: if a future change adds an hours column this fails immediately.
    const d = await quotableDraft("nohours-schema");
    const result = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const est = await prisma.issuedEstimate.findUnique({
      where: { id: result.estimateId },
      include: { lines: true },
    });
    const keys = [...Object.keys(est!), ...Object.keys(est!.lines[0])];
    expect(keys.filter((k) => /hour|hrs/i.test(k))).toEqual([]);
  });
});

// ─── 4. Token scope and enumeration ─────────────────────────────────────────────

describe("the token reaches exactly one estimate and nothing else", () => {
  it("resolves its own estimate and no other", async () => {
    const a = await graduateDraft(prisma, { draftId: (await quotableDraft("tok-a")).id, accountId: customerId, serviceAddressId: propertyId });
    const b = await graduateDraft(prisma, { draftId: (await quotableDraft("tok-b")).id, accountId: customerId, serviceAddressId: propertyId });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const ea = await prisma.issuedEstimate.findUnique({ where: { id: a.estimateId } });
    const eb = await prisma.issuedEstimate.findUnique({ where: { id: b.estimateId } });
    expect(ea!.token).not.toBe(eb!.token);

    const viaA = await getEstimateByToken(prisma, ea!.token);
    expect(viaA.ok).toBe(true);
    if (viaA.ok) expect(viaA.estimate.id).toBe(a.estimateId);
  });

  it("refuses a malformed, short, or unknown token identically", async () => {
    for (const bad of ["", "x", "../../etc", "0".repeat(63), "z".repeat(64), newToken()]) {
      const r = await getEstimateByToken(prisma, bad);
      expect(r.ok).toBe(false);
    }
  });

  it("serves 404 over HTTP for a wrong token, with no session", async () => {
    const res = await request(app).get(`/e/${newToken()}`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("ESTIMATE TOTAL");
  });

  it("serves the estimate over HTTP with no session, and records the first view", async () => {
    const d = await quotableDraft("http-view");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const est = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });
    await prisma.issuedEstimate.update({ where: { id: est!.id }, data: { status: "sent", sentAt: new Date() } });

    const res = await request(app).get(`/e/${est!.token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("ESTIMATE TOTAL");

    const after = await prisma.issuedEstimate.findUnique({ where: { id: est!.id } });
    expect(after!.firstViewedAt).not.toBeNull();
    expect(after!.status).toBe("viewed");

    // Idempotent: a second view does not move the first-view timestamp.
    const firstView = after!.firstViewedAt!.toISOString();
    await request(app).get(`/e/${est!.token}`);
    const again = await prisma.issuedEstimate.findUnique({ where: { id: est!.id } });
    expect(again!.firstViewedAt!.toISOString()).toBe(firstView);
  });
});

// ─── 5. Sign once, then locked ──────────────────────────────────────────────────

describe("signing", () => {
  it("records the signature with its audit trail and locks the estimate", async () => {
    const d = await quotableDraft("sign");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const est = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });

    const res = await request(app)
      .post(`/e/${est!.token}/sign`)
      .type("form")
      .send({ signerName: "Test Signature" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("Accepted");

    const after = await prisma.issuedEstimate.findUnique({
      where: { id: est!.id },
      include: { events: true },
    });
    expect(after!.status).toBe("signed");
    expect(after!.signerName).toBe("Test Signature");
    expect(after!.signedAt).not.toBeNull();
    expect(after!.consentText).toContain("electronic signature");
    expect(after!.signerIp).toBeTruthy();
    expect(after!.events.map((e) => e.type)).toContain("signed");
  });

  it("refuses a second signature and keeps the first signer", async () => {
    const d = await quotableDraft("sign-twice");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const est = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });

    const first = await signEstimate(prisma, est!.token, { signerName: "First Signer" });
    const second = await signEstimate(prisma, est!.token, { signerName: "Second Signer" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/already been signed/i);

    const after = await prisma.issuedEstimate.findUnique({ where: { id: est!.id } });
    expect(after!.signerName).toBe("First Signer");
    expect(
      await prisma.issuedEstimateEvent.count({ where: { estimateId: est!.id, type: "signed" } })
    ).toBe(1);
  });

  it("refuses an empty name rather than recording a blank signature", async () => {
    const d = await quotableDraft("sign-blank");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const est = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });

    const r = await signEstimate(prisma, est!.token, { signerName: "  " });
    expect(r.ok).toBe(false);
    const after = await prisma.issuedEstimate.findUnique({ where: { id: est!.id } });
    expect(after!.signedAt).toBeNull();
  });
});

// ─── 6. Revisions never mutate what was issued ──────────────────────────────────

describe("revisions", () => {
  it("supersedes without touching the signed record, and kills the old link", async () => {
    const d = await quotableDraft("revise");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    expect(g.ok).toBe(true);
    if (!g.ok) return;

    const issued = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });
    await signEstimate(prisma, issued!.token, { signerName: "Original Signer" });

    // Baseline is the SIGNED state — that is what must survive a later revision untouched.
    const before = await prisma.issuedEstimate.findUnique({
      where: { id: g.estimateId },
      include: { lines: { orderBy: { sortOrder: "asc" } } },
    });
    expect(before!.signedAt).not.toBeNull();

    const revised = await reviseEstimate(prisma, before!.id, { actor: "human:test" });
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;

    // Same house number, next revision.
    expect(revised.number).toBe(before!.number);
    expect(revised.revision).toBe(2);

    // The original is byte-for-byte what it was: same lines, same prices, same signature.
    const after = await prisma.issuedEstimate.findUnique({
      where: { id: before!.id },
      include: { lines: { orderBy: { sortOrder: "asc" } } },
    });
    expect(after!.signerName).toBe("Original Signer");
    expect(after!.signedAt!.toISOString()).toBe(before!.signedAt!.toISOString());
    expect(after!.workSubtotal).toBe(before!.workSubtotal);
    expect(after!.total).toBe(before!.total);
    expect(after!.lines.map((l) => [l.itemId, l.quantity, l.lineTotal])).toEqual(
      before!.lines.map((l) => [l.itemId, l.quantity, l.lineTotal])
    );

    // The old link no longer opens — the customer cannot sign a replaced version.
    const old = await getEstimateByToken(prisma, before!.token);
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.reason).toBe("superseded");
    expect((await request(app).get(`/e/${before!.token}`)).status).toBe(404);

    // The new revision has its own, different token.
    const next = await prisma.issuedEstimate.findUnique({ where: { id: revised.estimateId } });
    expect(next!.token).not.toBe(before!.token);
    expect((await getEstimateByToken(prisma, next!.token)).ok).toBe(true);
  });

  it("refuses to revise an already-superseded estimate", async () => {
    const d = await quotableDraft("revise-twice");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const first = await reviseEstimate(prisma, g.estimateId);
    expect(first.ok).toBe(true);
    const second = await reviseEstimate(prisma, g.estimateId);
    expect(second.ok).toBe(false);
  });
});

// ─── 7. Only an authenticated operator can send ─────────────────────────────────

describe("the send path is operator-only", () => {
  const TEST_PIN = "246801";

  beforeAll(async () => {
    process.env.PIN_HASH = await bcrypt.hash(TEST_PIN, 10);
  });
  afterAll(() => {
    delete process.env.PIN_HASH;
  });

  it("refuses an unauthenticated send with 401 and sends nothing", async () => {
    const d = await quotableDraft("send-auth");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    expect(g.ok).toBe(true);
    if (!g.ok) return;

    for (const spelling of [`/issued-estimates/${g.estimateId}/send`, `/api/issued-estimates/${g.estimateId}/send`]) {
      const res = await request(app).post(spelling).send({});
      expect(res.status).toBe(401);
    }

    const est = await prisma.issuedEstimate.findUnique({
      where: { id: g.estimateId },
      include: { events: true },
    });
    expect(est!.sentAt).toBeNull();
    expect(est!.status).toBe("draft");
    expect(est!.events.map((e) => e.type)).not.toContain("sent");
  });

  it("refuses unauthenticated access to every other operator route on this feature", async () => {
    const d = await quotableDraft("send-auth-2");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    expect(g.ok).toBe(true);
    if (!g.ok) return;

    const probes: Array<[string, string]> = [
      ["get", "/issued-estimates"],
      ["get", `/issued-estimates/${g.estimateId}`],
      ["post", `/issued-estimates/${g.estimateId}/revise`],
      ["post", `/price-book/drafts/${d.id}/issue`],
    ];
    for (const [method, path] of probes) {
      const res = await request(app)[method as "get"](path).send();
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });

  it("the customer page stays reachable without a session while the gate is on", async () => {
    const d = await quotableDraft("send-auth-3");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const est = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });

    // The whole point of the allowlist entry: the customer has no session and never will.
    expect((await request(app).get(`/e/${est!.token}`)).status).toBe(200);
  });
});

// ─── The send itself, with the mail transport stubbed ───────────────────────────

describe("a successful send stamps the record", () => {
  it("records sentAt / sentBy / sentTo and appends the event", async () => {
    const mod = await import("../src/services/confirmationEmail");
    const spy = vi.spyOn(mod, "sendBrandedEmail").mockResolvedValue(true);
    try {
      const { sendEstimateEmail } = await import("../src/services/issuedEstimateSend");
      const d = await quotableDraft("send-ok");
      const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
      expect(g.ok).toBe(true);
      if (!g.ok) return;

      const result = await sendEstimateEmail(prisma, g.estimateId, { sentBy: "human:test" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.to).toBe("p027-customer@example.com");

      const est = await prisma.issuedEstimate.findUnique({
        where: { id: g.estimateId },
        include: { events: true },
      });
      expect(est!.status).toBe("sent");
      expect(est!.sentAt).not.toBeNull();
      expect(est!.sentBy).toBe("human:test");
      expect(est!.sentTo).toBe("p027-customer@example.com");
      expect(est!.events.map((e) => e.type)).toContain("sent");

      // The email carries the tokenized link and the flat total — and no hours.
      const html = String(spy.mock.calls[0][0].bodyHtml);
      expect(html).toContain(est!.token);
      expect(html).not.toMatch(/\bhours?\b/i);
      expect(html).not.toMatch(/\bhrs?\b/i);
    } finally {
      spy.mockRestore();
    }
  });

  /*
    P029 changed how this case ARISES without changing the property.

    Before the account spine, an estimate could be issued with no customer at all, so "no email"
    meant "no customer". Now every estimate names an account — so the way to have no address is an
    ACCOUNT that has none, which is a real situation (a phone lead Kyle has not collected an email
    from yet). The refusal must still fire, and it must still refuse rather than fall back to
    sending the customer's estimate to Kyle.
  */
  it("refuses to send when the account has no email rather than guessing one", async () => {
    const { sendEstimateEmail } = await import("../src/services/issuedEstimateSend");

    const noEmailAccount = await prisma.customer.create({
      data: { name: `${MARK} No Email Account`, phone: "615-555-0000" },
    });
    const noEmailProperty = await prisma.property.create({
      data: {
        customerId: noEmailAccount.id,
        name: "House",
        addressLine1: "7 Silent Way",
        city: "La Vergne",
        state: "TN",
        postalCode: "37086",
      },
    });

    const d = await createDraft(prisma, { title: `${MARK} no-email`, supplierId: "HD" });
    draftIds.push(d.id);
    await addLine(prisma, d.id, { itemId: GOOD_A, quantity: 1, quantitySource: "COUNT" });
    const g = await graduateDraft(prisma, {
      draftId: d.id,
      accountId: noEmailAccount.id,
      serviceAddressId: noEmailProperty.id,
    });
    expect(g.ok).toBe(true);
    if (!g.ok) return;

    const result = await sendEstimateEmail(prisma, g.estimateId, { sentBy: "human:test" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no valid customer email/i);

    const est = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });
    expect(est!.sentAt).toBeNull();

    // Teardown: this account is outside the suite's shared fixtures.
    await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: g.estimateId } });
    await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: g.estimateId } });
    await prisma.issuedEstimate.delete({ where: { id: g.estimateId } });
    await prisma.property.delete({ where: { id: noEmailProperty.id } });
    await prisma.customer.delete({ where: { id: noEmailAccount.id } });
  });
});

// ─── The customer sees scope and ONE price (P031, 2026-08-18) ──────────────────

describe("the customer render shows no per-line prices", () => {
  /*
    Kyle, 2026-08-18: "the estimates are still giving line items pricing which it should not.
    The customers should get a line item quote with only the total price."

    A per-line price invites a line-by-line negotiation of a lump-sum quote and exposes the shape
    of the build-up on what is meant to be a flat rate. The scope stays itemised; the money does
    not.
  */
  it("lists the items and quantities but prices none of them", async () => {
    const d = await quotableDraft("no-line-prices");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    expect(g.ok).toBe(true);
    if (!g.ok) return;

    const est = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });
    const found = await getEstimateByToken(prisma, est!.token);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const html = renderEstimatePage(found.estimate);

    // The scope is still there, itemised.
    for (const line of found.estimate.lines) {
      expect(html).toContain(line.description);
    }
    // The header no longer offers a Price column.
    expect(html).not.toMatch(/<th[^>]*>\s*Price\s*<\/th>/i);

    // No line's own money appears anywhere.
    for (const line of found.estimate.lines) {
      const lineMoney = `$${line.lineTotal.toFixed(2)}`;
      if (Math.abs(line.lineTotal - found.estimate.total) < 0.005) continue; // a 1-line estimate
      expect(html, `line price ${lineMoney} leaked onto the customer page`).not.toContain(lineMoney);
    }

    // And the one number that should be there, is.
    expect(html).toContain("ESTIMATE TOTAL");
    expect(html).toContain(`$${found.estimate.total.toFixed(2)}`);
  });
});
