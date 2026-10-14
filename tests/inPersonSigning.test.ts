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

import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { randomUUID } from "node:crypto";
import { CONSENT_TEXT } from "../shared/consentText";
import { figuresKeyOf, graduateDraft, issuedFiguresKey, SIGNATURE_CLOCK_SKEW_MS, signEstimateInPerson } from "../src/services/issuedEstimateService";
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
  // Own fixture, not the deleted importer's — see tests/helpers/priceBookFixture.ts and
  // .claude/plans/2026-09-15-tests-build-their-own-price-data.md.
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(GOOD_A), quotableAtomic(GOOD_B)]);

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
  await deleteAtomics([GOOD_A, GOOD_B]);
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
      signatureImage: TEST_SIGNATURE,
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
    // Ruling 4 (Kyle, 2026-10-09): the CRM's in-person screen records the same sentence as the emailed page and the phone.
    expect(est!.consentText).toBe(
      "By typing my full name and tapping Accept & Sign, I agree to the scope and the price on this estimate, and I authorize Red Cedar Electric LLC to perform the work described. I understand this is an electronic signature with the same effect as a written one.",
    );

    const signed = est!.events.find((e) => e.type === "signed");
    expect(signed!.actor).toBe("customer:in-person");
    expect(signed!.detail).toContain("in person");
  });

  it("signs once — a second attempt is refused and the first signer stands", async () => {
    const g = await issuedEstimate("once");
    expect((await signEstimateInPerson(prisma, g.estimateId, { signerName: "First", signatureImage: TEST_SIGNATURE })).ok).toBe(true);
    const second = await signEstimateInPerson(prisma, g.estimateId, { signerName: "Second", signatureImage: TEST_SIGNATURE });
    expect(second.ok).toBe(false);

    const est = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });
    expect(est!.signerName).toBe("First");
    expect(
      await prisma.issuedEstimateEvent.count({ where: { estimateId: g.estimateId, type: "signed" } })
    ).toBe(1);
  });

  it("an estimate signed in person cannot then be signed from the emailed link", async () => {
    const g = await issuedEstimate("cross-channel");
    await signEstimateInPerson(prisma, g.estimateId, { signerName: "In Person", signatureImage: TEST_SIGNATURE });

    const est = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });
    const res = await request(app)
      .post(`/e/${est!.token}/sign`)
      .type("form")
      .send({ signerName: "Email Signer", signatureImage: TEST_SIGNATURE });

    expect(res.status).toBe(400);
    const after = await prisma.issuedEstimate.findUnique({ where: { id: g.estimateId } });
    expect(after!.signerName).toBe("In Person");
    expect(after!.signedChannel).toBe("in_person");
  });

  it("refuses a blank name rather than recording an empty signature", async () => {
    const g = await issuedEstimate("blank");
    const r = await signEstimateInPerson(prisma, g.estimateId, { signerName: " ", signatureImage: TEST_SIGNATURE });
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

// ─── Captured on the phone with no signal (Phase 7 unit U7, 2026-10-10) ─────────────────

/*
  The technician's phone saves the signature the moment the customer makes it and sends it when it
  has signal — seconds or days later. applySignature (the one write path) must accept that request
  exactly once, judge it by when it was CAPTURED (Kyle, 2026-10-09, ruling 10), and refuse with
  words anything the office changed meanwhile. The office's door sends none of this and is pinned
  unchanged in tests/fieldSignInPerson.test.ts.
*/
describe("a signature captured on the phone, delivered later", () => {
  const DAY = 86_400_000;
  const MINUTE = 60_000;
  const sign = (estimateId: string, extra: Record<string, unknown> = {}) =>
    signEstimateInPerson(prisma, estimateId, { signerName: "Test Signature", signatureImage: TEST_SIGNATURE, ...extra });
  const rowOf = (id: string) => prisma.issuedEstimate.findUniqueOrThrow({ where: { id } });
  /** The full capture the phone sends, against the estimate's current figures. */
  async function capture(estimateId: string, over: Record<string, unknown> = {}) {
    return {
      clientSignatureId: randomUUID(),
      capturedAt: new Date(Date.now() - MINUTE).toISOString(),
      // The phone's clock at the send (D2): the office trusts only the gap between the two.
      sentAt: new Date().toISOString(),
      revision: 1,
      figuresKey: await issuedFiguresKey(prisma, estimateId),
      consentText: CONSENT_TEXT,
      ...over,
    };
  }

  it("a resend after a lost answer gets the ORIGINAL success: one signature, one event, both times kept", async () => {
    const g = await issuedEstimate("replay");
    const body = await capture(g.estimateId);
    const first = await sign(g.estimateId, body);
    expect(first).toEqual({ ok: true, estimateId: g.estimateId });

    const est = await rowOf(g.estimateId);
    expect(est.status).toBe("signed");
    expect(est.signedChannel).toBe("in_person");
    expect(est.clientSignatureId).toBe(body.clientSignatureId);
    // The phone's clock is recorded as the phone's claim; signedAt is the server's own receipt time.
    expect(est.signatureCapturedAt!.toISOString()).toBe(body.capturedAt);
    expect(est.signedAt!.getTime()).toBeGreaterThan(est.signatureCapturedAt!.getTime());
    expect(est.signedAt!.getTime()).toBeGreaterThan(Date.now() - 30_000);
    const signedEvent = await prisma.issuedEstimateEvent.findFirstOrThrow({ where: { estimateId: g.estimateId, type: "signed" } });
    expect(signedEvent.detail).toContain("captured on the phone at");
    expect(signedEvent.detail).toContain("the phone's clock");

    // The same capture again: success, nothing rewritten, no second event.
    const again = await sign(g.estimateId, body);
    expect(again).toEqual({ ok: true, estimateId: g.estimateId, replayed: true });
    const after = await rowOf(g.estimateId);
    expect(after.signedAt!.getTime()).toBe(est.signedAt!.getTime());
    expect(after.signerName).toBe("Test Signature");
    expect(await prisma.issuedEstimateEvent.count({ where: { estimateId: g.estimateId, type: "signed" } })).toBe(1);

    // Even after the office voids it: the signature DID land, and the phone's resend is told so.
    await prisma.issuedEstimate.update({ where: { id: g.estimateId }, data: { status: "void", voidedAt: new Date(), voidReason: "test" } });
    expect(await sign(g.estimateId, body)).toEqual({ ok: true, estimateId: g.estimateId, replayed: true });
  });

  it("a DIFFERENT signer's capture on a signed estimate is 'already signed' — never 'recorded', never adopted", async () => {
    const g = await issuedEstimate("second-signer");
    const first = await capture(g.estimateId);
    expect((await sign(g.estimateId, first)).ok).toBe(true);

    const second = await sign(g.estimateId, { ...(await capture(g.estimateId)), signerName: "Somebody Else" });
    expect(second).toEqual({ ok: false, reason: "This estimate has already been signed." });
    const est = await rowOf(g.estimateId);
    expect(est.signerName).toBe("Test Signature");
    expect(est.clientSignatureId).toBe(first.clientSignatureId);
  });

  it("the same capture id on a different estimate is refused, never adopted", async () => {
    const a = await issuedEstimate("same-id-a");
    const b = await issuedEstimate("same-id-b");
    const body = await capture(a.estimateId);
    expect((await sign(a.estimateId, body)).ok).toBe(true);

    const onB = await sign(b.estimateId, { ...body, figuresKey: await issuedFiguresKey(prisma, b.estimateId) });
    expect(onB.ok).toBe(false);
    expect((onB as { reason: string }).reason).toMatch(/already recorded on a different estimate/);
    const rowB = await rowOf(b.estimateId);
    expect(rowB.signedAt).toBeNull();
    expect(rowB.clientSignatureId).toBeNull();
  });

  it("revised, voided or marked lost while the phone was offline → refused with words, nothing written", async () => {
    const revised = await issuedEstimate("queued-revised");
    const newer = await issuedEstimate("queued-revised-newer");
    await prisma.issuedEstimate.update({ where: { id: newer.estimateId }, data: { supersedesId: revised.estimateId } });
    const r = await sign(revised.estimateId, await capture(revised.estimateId));
    expect(r).toEqual({ ok: false, reason: "This estimate has been replaced by a newer revision." });

    const voided = await issuedEstimate("queued-void");
    await prisma.issuedEstimate.update({ where: { id: voided.estimateId }, data: { status: "void", voidedAt: new Date(), voidReason: "test" } });
    const v = await sign(voided.estimateId, await capture(voided.estimateId));
    expect(v).toEqual({ ok: false, reason: "This estimate is void." });

    const lost = await issuedEstimate("queued-lost");
    await prisma.issuedEstimate.update({ where: { id: lost.estimateId }, data: { status: "lost", lostAt: new Date(), lostReason: "went elsewhere" } });
    const l = await sign(lost.estimateId, await capture(lost.estimateId));
    expect(l.ok).toBe(false);
    expect((l as { reason: string }).reason).toMatch(/has been closed/);

    for (const id of [revised.estimateId, voided.estimateId, lost.estimateId]) {
      const est = await rowOf(id);
      expect(est.signedAt).toBeNull();
      expect(est.clientSignatureId).toBeNull();
      expect(est.signatureCapturedAt).toBeNull();
    }
  });

  it("the 30 days are judged at CAPTURE (ruling 10): day 29 arriving on day 31 is honoured, day 30-and-a-minute is not", async () => {
    const issuedAt = new Date(Date.now() - 31 * DAY);

    const honoured = await issuedEstimate("expiry-honoured");
    await prisma.issuedEstimate.update({ where: { id: honoured.estimateId }, data: { createdAt: issuedAt } });
    const capturedAt = new Date(issuedAt.getTime() + 29 * DAY).toISOString();
    const ok = await sign(honoured.estimateId, await capture(honoured.estimateId, { capturedAt }));
    expect(ok).toEqual({ ok: true, estimateId: honoured.estimateId });
    const est = await rowOf(honoured.estimateId);
    expect(est.signatureCapturedAt!.toISOString()).toBe(capturedAt);
    // Recorded today, two days past the window — both facts on the row.
    expect(est.signedAt!.getTime()).toBeGreaterThan(issuedAt.getTime() + 30 * DAY);

    const late = await issuedEstimate("expiry-late");
    await prisma.issuedEstimate.update({ where: { id: late.estimateId }, data: { createdAt: issuedAt } });
    const refused = await sign(late.estimateId, await capture(late.estimateId, { capturedAt: new Date(issuedAt.getTime() + 30 * DAY + MINUTE).toISOString() }));
    expect(refused.ok).toBe(false);
    expect((refused as { reason: string }).reason).toMatch(/expired on/);
    expect((await rowOf(late.estimateId)).signedAt).toBeNull();

    // No capture time (the office's door, the emailed link): the server's clock, exactly as before.
    const office = await issuedEstimate("expiry-office");
    await prisma.issuedEstimate.update({ where: { id: office.estimateId }, data: { createdAt: issuedAt } });
    const plain = await sign(office.estimateId);
    expect(plain.ok).toBe(false);
    expect((plain as { reason: string }).reason).toMatch(/expired on/);
  });

  it("the phone's clock does not decide the 30 days (D2): the capture is placed on the office's clock from how long the phone held it, so a clock days slow or fast is judged as a correct one", async () => {
    const issuedAt = new Date(Date.now() - 31 * DAY);
    const threeDays = 3 * DAY;

    // A phone three days SLOW. The customer really signed on day 29½ and the phone held it 1½ days
    // (a dead zone). By the phone's own clock that reads day 26½ — honoured either way, correctly.
    const slowOk = await issuedEstimate("clock-slow-ok");
    await prisma.issuedEstimate.update({ where: { id: slowOk.estimateId }, data: { createdAt: issuedAt } });
    const reallyCaptured = issuedAt.getTime() + 29.5 * DAY;
    const okBody = await capture(slowOk.estimateId, {
      capturedAt: new Date(reallyCaptured - threeDays).toISOString(),
      sentAt: new Date(Date.now() - threeDays).toISOString(),
    });
    expect(await sign(slowOk.estimateId, okBody)).toEqual({ ok: true, estimateId: slowOk.estimateId });
    // The phone's claim is what is recorded as the capture time, labelled as such (ruling 10: both times kept).
    expect((await rowOf(slowOk.estimateId)).signatureCapturedAt!.toISOString()).toBe(okBody.capturedAt);

    // The SAME slow phone, but the customer really signed on day 30½ — expired. The phone's clock
    // says day 27½, which the old rule would have honoured; the gap (half a day) places it on day 30½.
    const slowLate = await issuedEstimate("clock-slow-late");
    await prisma.issuedEstimate.update({ where: { id: slowLate.estimateId }, data: { createdAt: issuedAt } });
    const lateCaptured = issuedAt.getTime() + 30.5 * DAY;
    const late = await sign(slowLate.estimateId, await capture(slowLate.estimateId, {
      capturedAt: new Date(lateCaptured - threeDays).toISOString(),
      sentAt: new Date(Date.now() - threeDays).toISOString(),
    }));
    expect(late.ok).toBe(false);
    expect((late as { reason: string }).reason).toMatch(/expired on/);
    expect((await rowOf(slowLate.estimateId)).signedAt).toBeNull();

    // A phone a day FAST, signing a fresh estimate a minute before sending: the gap is a minute, accepted.
    const fast = await issuedEstimate("clock-fast");
    const fastBody = await capture(fast.estimateId, {
      capturedAt: new Date(Date.now() + DAY - MINUTE).toISOString(),
      sentAt: new Date(Date.now() + DAY).toISOString(),
    });
    expect(await sign(fast.estimateId, fastBody)).toEqual({ ok: true, estimateId: fast.estimateId });
  });

  it("what the phone's clock still cannot do: send before it captured, place the capture before the estimate existed, or come without the send time", async () => {
    expect(SIGNATURE_CLOCK_SKEW_MS).toBe(10 * MINUTE);
    const g = await issuedEstimate("clock");
    const created = (await rowOf(g.estimateId)).createdAt;
    const now = Date.now();

    // The clock moved between the signature and the send by more than the tolerance: the gap means nothing.
    const moved = await sign(g.estimateId, await capture(g.estimateId, {
      capturedAt: new Date(now).toISOString(),
      sentAt: new Date(now - SIGNATURE_CLOCK_SKEW_MS - MINUTE).toISOString(),
    }));
    expect(moved.ok).toBe(false);
    expect((moved as { reason: string }).reason).toMatch(/clock moved between the signature/);

    // Held for longer than the estimate has existed: a document signed before it was issued.
    const early = await sign(g.estimateId, await capture(g.estimateId, {
      capturedAt: new Date(created.getTime() - SIGNATURE_CLOCK_SKEW_MS - MINUTE).toISOString(),
      sentAt: new Date(now).toISOString(),
    }));
    expect(early.ok).toBe(false);
    expect((early as { reason: string }).reason).toMatch(/before estimate .* was issued/);

    // A capture time with no send time (an app that predates D2): the time cannot be checked, so it is refused with words.
    const noSend = await sign(g.estimateId, await capture(g.estimateId, { sentAt: undefined }));
    expect(noSend.ok).toBe(false);
    expect((noSend as { reason: string }).reason).toMatch(/did not say when it sent/);

    const unreadable = await sign(g.estimateId, await capture(g.estimateId, { capturedAt: "not a time" }));
    expect(unreadable.ok).toBe(false);
    expect((unreadable as { reason: string }).reason).toMatch(/could not be read/);
    expect((await rowOf(g.estimateId)).signedAt).toBeNull();

    // A phone a few minutes slow that "signed before the issue" by the office's clock: inside the tolerance, accepted.
    const slow = new Date(created.getTime() - 5 * MINUTE).toISOString();
    expect(await sign(g.estimateId, await capture(g.estimateId, { capturedAt: slow, sentAt: new Date(created.getTime() - 4 * MINUTE).toISOString() }))).toEqual({ ok: true, estimateId: g.estimateId });
    expect((await rowOf(g.estimateId)).signatureCapturedAt!.toISOString()).toBe(slow);
  });

  it("a consent sentence that is not CONSENT_TEXT is refused; the exact sentence is recorded", async () => {
    const g = await issuedEstimate("consent");
    const stale = await sign(g.estimateId, await capture(g.estimateId, { consentText: "By typing my full name below and tapping Accept, I agree." }));
    expect(stale.ok).toBe(false);
    expect((stale as { reason: string }).reason).toMatch(/wording/);
    expect((await rowOf(g.estimateId)).signedAt).toBeNull();

    expect((await sign(g.estimateId, await capture(g.estimateId))).ok).toBe(true);
    expect((await rowOf(g.estimateId)).consentText).toBe(CONSENT_TEXT);
  });

  it("a figures key that is not this estimate's is refused; the server's own key is accepted", async () => {
    const g = await issuedEstimate("figures");
    const wrong = await sign(g.estimateId, await capture(g.estimateId, { figuresKey: "0".repeat(64) }));
    expect(wrong.ok).toBe(false);
    expect((wrong as { reason: string }).reason).toMatch(/figures/);
    expect((await rowOf(g.estimateId)).signedAt).toBeNull();

    const key = await issuedFiguresKey(prisma, g.estimateId);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect((await sign(g.estimateId, await capture(g.estimateId, { figuresKey: key }))).ok).toBe(true);
  });

  it("the figures key is the server's: stable under key order, different per revision and per figure", () => {
    const sel = { A: { key: "A", options: ["A"], subtotal: 100, trip: 0, comboSaving: 0, base: 100, discount: 0, discountCapped: false, total: 100 } };
    const reordered = { A: { total: 100, discountCapped: false, discount: 0, base: 100, comboSaving: 0, trip: 0, subtotal: 100, options: ["A"], key: "A" } };
    expect(figuresKeyOf(sel, 1)).toBe(figuresKeyOf(reordered, 1));
    expect(figuresKeyOf(sel, 1)).not.toBe(figuresKeyOf(sel, 2));
    expect(figuresKeyOf(sel, 1)).not.toBe(figuresKeyOf({ A: { ...sel.A, total: 100.01 } }, 1));
  });

  it("a revision other than this row's is refused", async () => {
    const g = await issuedEstimate("revision");
    const r = await sign(g.estimateId, await capture(g.estimateId, { revision: 2 }));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/revision 2 of estimate .*; this is revision 1/);
    expect((await rowOf(g.estimateId)).signedAt).toBeNull();
  });

  it("the office's door records none of it: no capture id, no capture time, expiry by the server's clock", async () => {
    const g = await issuedEstimate("office-door");
    expect(await sign(g.estimateId)).toEqual({ ok: true, estimateId: g.estimateId });
    const est = await rowOf(g.estimateId);
    expect(est.clientSignatureId).toBeNull();
    expect(est.signatureCapturedAt).toBeNull();
    expect(est.signedAt).not.toBeNull();
    const signedEvent = await prisma.issuedEstimateEvent.findFirstOrThrow({ where: { estimateId: g.estimateId, type: "signed" } });
    expect(signedEvent.detail).not.toContain("captured on the phone");
  });
});
