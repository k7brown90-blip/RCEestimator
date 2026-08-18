/**
 * P028 — in-person signing.
 *
 * THE DEVICE LOCK WAS REMOVED on 2026-08-18. It narrowed the session to one estimate, trapped the
 * back button, timed out after five minutes and required the operator PIN to exit. That design was
 * AI-derived and recorded as "stated for veto"; Kyle vetoed it: *"I don't like the feature and want
 * it gone. It's not needed."* The tests that pinned the scope went with it.
 *
 * What still matters, and is still pinned here: the in-person signature is the SAME signature —
 * same conditional sign-once update, same lock on the estimate, same audit shape — differing only
 * in `signedChannel`, and both channels render from one customer document.
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


// ─── THE LOCK. By request, not by hidden buttons. ───────────────────────────────


// ─── Exit is the PIN, and expiry falls to the lock ──────────────────────────────


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

  it("serves that same render over HTTP to the operator session", async () => {
    const g = await issuedEstimate("http-render");
    const res = await request(app)
      .get(`/issued-estimates/${g.estimateId}/customer-view`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    for (const re of HOUR_PATTERNS) expect(res.text).not.toMatch(re);
    // "Work subtotal" was removed on 2026-08-18 — Kyle: the customer gets scope plus ONE price.
    expect(res.text).toContain("ESTIMATE TOTAL");
  });
});
