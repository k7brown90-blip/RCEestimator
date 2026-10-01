/**
 * Archive the estimates that were not chosen (Kyle, 2026-10-01; plan
 * 2026-10-01-manual-sends-archiving-and-one-calendar.md, item C).
 *
 * "once a job is sold the other ones that are not chosen should be archived. (Arlene is a good
 *  example, she signed the new estimate for $4004.01 which was an adjustment after we reviewed
 *  the initial options together.) The first one totaling over $14,000 is now irrelevent and can
 *  be archived."
 *
 * Pinned here:
 *   1. THE ARLENE SHAPE — two unsigned estimates at one address; sign the second; the first is
 *      archived with a reason naming the signed one; the signed one is not.
 *   2. WHAT THE PASS NEVER TOUCHES at the same address — a signed row, a void row, a lost row, a
 *      change order, a draft (never presented), a superseded revision — and anything at a
 *      DIFFERENT address.
 *   3. All three signature doors run it: in person, the emailed link, the office acceptance.
 *   4. A signed CHANGE ORDER runs nothing; a second pass never overrides a person's Unarchive.
 *   5. Archive / unarchive by hand round-trip through the drawer's endpoints, with the refusals.
 *   6. NOT A STATUS, NOT MONEY: status is unchanged by archiving, LIVE_SIGNED counts are unchanged,
 *      /invoices never lists an archived row, a signature on an archived row clears the archive,
 *      and the funnel reports it as WITHDRAWN outside the rate — never as won, lost or open.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

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
    },
  };
});
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft, reviseEstimate, signEstimateInPerson } from "../src/services/issuedEstimateService";
import { sendEstimateEmail } from "../src/services/issuedEstimateSend";
import { archiveCompetingEstimates, competingEstimatesWhere, competitorReason } from "../src/services/estimateArchive";
import { LIVE_SIGNED } from "../src/services/invoiceGroup";
import { getFunnelReport, type FunnelRange } from "../src/services/leadFunnel";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "ARCHIVE";
const ATOMIC = "AR001";
const DAY = 86_400_000;

let customerId: string;
const propertyIds: string[] = [];
const draftIds: string[] = [];

async function property(name: string) {
  const p = await prisma.property.create({
    data: { customerId, name: `${MARK} ${name}`, addressLine1: `${propertyIds.length + 1} Options Way`, city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  propertyIds.push(p.id);
  return p.id;
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ATOMIC)]);
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Williamson`, email: "archive@example.com", phone: "615-555-0199" },
  });
  customerId = customer.id;
});

afterAll(async () => {
  const ests = await prisma.issuedEstimate.findMany({ where: { customerId }, select: { id: true } });
  const ids = ests.map((e) => e.id);
  await prisma.payment.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.document.deleteMany({ where: { issuedEstimateId: { in: ids } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimateOption.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: ids } }, data: { supersedesId: null, changeOrderForId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: ids } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { job: { customerId } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ATOMIC]);
});

/** Issue a one-line estimate at an address; it starts as "draft" (issued, not yet emailed). */
async function issue(title: string, propertyId: string) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId: null });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: ATOMIC, quantity: 1, quantitySource: "COUNT" });
  const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
  if (!g.ok) throw new Error(`graduation failed: ${JSON.stringify(g)}`);
  return prisma.issuedEstimate.findUniqueOrThrow({ where: { id: g.estimateId } });
}

/** Put an issued row where a test needs it, the way the real paths would have. */
async function put(id: string, status: "sent" | "viewed" | "expired") {
  const sentAt = new Date(Date.now() - DAY);
  return prisma.issuedEstimate.update({
    where: { id },
    data: { status, sentAt, sentTo: "archive@example.com", firstViewedAt: status === "viewed" ? new Date(sentAt.getTime() + 3600_000) : null },
  });
}

/** A presented, unsigned estimate at an address — the shape the pass archives. */
async function presented(title: string, propertyId: string, status: "sent" | "viewed" | "expired" = "sent") {
  const e = await issue(title, propertyId);
  await put(e.id, status);
  return e;
}

const row = (id: string) => prisma.issuedEstimate.findUniqueOrThrow({ where: { id } });
const signInPerson = (id: string) => request(app).post(`/issued-estimates/${id}/sign-in-person`).send({ signerName: "Arlene Williamson", signatureImage: TEST_SIGNATURE });
const archiveByHand = (id: string, reason?: string | null) => request(app).post(`/issued-estimates/${id}/archive`).send(reason === undefined ? {} : { reason });
const unarchive = (id: string) => request(app).post(`/issued-estimates/${id}/unarchive`).send({});
const events = (id: string, type: string) => prisma.issuedEstimateEvent.findMany({ where: { estimateId: id, type }, orderBy: { at: "asc" } });

describe("1 + 2. The Arlene shape, and what the pass leaves alone", () => {
  let home: string;
  let elsewhere: string;
  let first: Awaited<ReturnType<typeof presented>>;   // 2026-1096: the $14k first set of options
  let chosen: Awaited<ReturnType<typeof presented>>;  // 2026-1101: the adjustment she signed
  let signedBefore: Awaited<ReturnType<typeof issue>>;
  let voided: Awaited<ReturnType<typeof issue>>;
  let lost: Awaited<ReturnType<typeof issue>>;
  let changeOrder: Awaited<ReturnType<typeof issue>>;
  let draft: Awaited<ReturnType<typeof issue>>;
  let older: Awaited<ReturnType<typeof issue>>;
  let newer: Awaited<ReturnType<typeof issue>>;
  let otherAddress: Awaited<ReturnType<typeof issue>>;

  beforeAll(async () => {
    home = await property("Home");
    elsewhere = await property("Rental");

    first = await presented("first options", home, "viewed");
    chosen = await presented("adjusted options", home, "sent");

    // A signed estimate at the same address — someone's agreement. Signed through the SERVICE
    // (no route, no pass), so this fixture cannot itself archive anything.
    signedBefore = await presented("earlier job, signed", home);
    expect((await signEstimateInPerson(prisma, signedBefore.id, { signerName: "Arlene", signatureImage: TEST_SIGNATURE })).ok).toBe(true);
    // Void and lost already have their exits.
    voided = await presented("wrong price", home);
    await prisma.issuedEstimate.update({ where: { id: voided.id }, data: { status: "void", voidedAt: new Date(), voidReason: "wrong price" } });
    lost = await presented("went elsewhere", home);
    await prisma.issuedEstimate.update({ where: { id: lost.id }, data: { status: "lost", lostAt: new Date(), lostReason: "price" } });
    // A change order belongs to an invoice; it is not a competing quote.
    changeOrder = await presented("more work on the signed job", home);
    await prisma.issuedEstimate.update({ where: { id: changeOrder.id }, data: { changeOrderForId: signedBefore.id } });
    // A draft was never in front of the customer.
    draft = await issue("not yet sent", home);
    // A revision chain: the older revision is already hidden as superseded; the newer is live.
    older = await presented("rev 1", home);
    newer = await presented("rev 2", home);
    await prisma.issuedEstimate.update({ where: { id: newer.id }, data: { supersedesId: older.id } });
    // A genuine second job at a DIFFERENT address on the same account.
    otherAddress = await presented("rental panel", elsewhere);
  });

  it("the predicate is exported and names every exclusion the plan listed", () => {
    const where = competingEstimatesWhere({ id: "x", customerId: "c", serviceAddressId: "p" });
    expect(where).toMatchObject({
      id: { not: "x" }, customerId: "c", serviceAddressId: "p",
      status: { in: ["sent", "viewed", "expired"] },
      signedAt: null, voidedAt: null, lostAt: null, changeOrderForId: null, jobVisitId: null, supersededBy: null, archivedAt: null,
    });
  });

  it("signing the second estimate archives the first with a reason naming the signed one — and nothing else at the address", async () => {
    const liveSignedBefore = await prisma.issuedEstimate.count({ where: LIVE_SIGNED });

    const res = await signInPerson(chosen.id);
    expect(res.status).toBe(200);
    expect(res.body.signed).toBe(true);
    // The response says what moved, so the signed screen can say it too.
    expect(res.body.archived.map((a: { id: string }) => a.id).sort()).toEqual([first.id, newer.id].sort());

    const archivedFirst = await row(first.id);
    expect(archivedFirst.archivedAt).not.toBeNull();
    expect(archivedFirst.archivedReason).toBe(competitorReason(chosen.number));
    expect(archivedFirst.archivedReason).toContain(chosen.number);
    // NOT A STATUS: it is still the viewed quote it was. Still unsigned, no job.
    expect(archivedFirst.status).toBe("viewed");
    expect(archivedFirst.signedAt).toBeNull();
    expect(archivedFirst.jobVisitId).toBeNull();
    // The trail says so, and says where the way back is.
    const trail = await events(first.id, "archived");
    expect(trail).toHaveLength(1);
    expect(trail[0].actor).toBe("system:sign-in-person");
    expect(trail[0].detail).toContain("Unarchive");

    // The signed one is a sale, not archived.
    const signed = await row(chosen.id);
    expect(signed.status).toBe("signed");
    expect(signed.archivedAt).toBeNull();

    // Left alone, every one of them:
    for (const [name, e] of [["signed", signedBefore], ["void", voided], ["lost", lost], ["change order", changeOrder], ["draft", draft], ["superseded rev", older], ["other address", otherAddress]] as const) {
      const r = await row(e.id);
      expect(r.archivedAt, `${name} must not be archived`).toBeNull();
      expect(r.archivedReason, `${name} must not carry a reason`).toBeNull();
    }
    expect((await row(signedBefore.id)).status).toBe("signed");
    expect((await row(voided.id)).status).toBe("void");
    expect((await row(lost.id)).status).toBe("lost");
    // The latest revision of the chain was presented and unsigned, so it IS archived.
    expect((await row(newer.id)).archivedAt).not.toBeNull();

    // Money: one more live signed row (the sale), and that is the only change.
    expect(await prisma.issuedEstimate.count({ where: LIVE_SIGNED })).toBe(liveSignedBefore + 1);
  });

  it("signing it again is refused and archives nothing further", async () => {
    const before = await prisma.issuedEstimate.findMany({ where: { customerId }, select: { id: true, archivedAt: true } });
    const res = await signInPerson(chosen.id);
    expect(res.status).toBe(400);
    const after = await prisma.issuedEstimate.findMany({ where: { customerId }, select: { id: true, archivedAt: true } });
    expect(after).toEqual(before);
  });

  it("the pass itself is a no-op on an unsigned estimate and on a change order", async () => {
    expect(await archiveCompetingEstimates(prisma, first.id, "test")).toEqual({ archived: [], skipped: "not signed" });
    await prisma.issuedEstimate.update({ where: { id: changeOrder.id }, data: { status: "signed", signedAt: new Date() } });
    const fresh = await presented("waiting at the address while a change order is signed", home);
    expect(await archiveCompetingEstimates(prisma, changeOrder.id, "test")).toMatchObject({ archived: [], skipped: expect.stringContaining("change order") });
    expect((await row(fresh.id)).archivedAt).toBeNull();
  });
});

describe("3. The other two doors", () => {
  it("the office acceptance archives the other presented estimate and names it in the response", async () => {
    const p = await property("Office door");
    const other = await presented("option set A", p, "viewed");
    const accepted = await presented("option set B", p, "sent");
    const res = await request(app).post(`/issued-estimates/${accepted.id}/accept`).send({ acceptedVia: "phone", acceptedBy: "Arlene Williamson" });
    expect(res.status).toBe(200);
    expect(res.body.archived).toHaveLength(1);
    expect(res.body.archived[0].id).toBe(other.id);
    expect((await row(other.id)).archivedReason).toBe(competitorReason(accepted.number));
    expect((await events(other.id, "archived"))[0].actor).toBe("system:office-accept");
    expect((await row(accepted.id)).archivedAt).toBeNull();
  });

  it("the emailed link archives the other presented estimate", async () => {
    const p = await property("Email door");
    const other = await presented("option set A", p);
    const signed = await presented("option set B", p);
    const res = await request(app)
      .post(`/e/${signed.token}/sign`)
      .type("form")
      .send({ signerName: "Arlene Williamson", signatureImage: TEST_SIGNATURE });
    expect(res.status).toBe(200);
    expect((await row(signed.id)).status).toBe("signed");
    expect((await row(other.id)).archivedReason).toBe(competitorReason(signed.number));
    expect((await events(other.id, "archived"))[0].actor).toBe("system:email-sign");
  });
});

describe("4. A later pass never overrides a person", () => {
  it("an estimate unarchived by hand stays out when a revision of the signed one is signed later — while a new row at the address is still caught", async () => {
    const p = await property("Two real jobs");
    const panel = await presented("panel upgrade", p);
    const ev = await presented("EV charger", p);
    expect((await signInPerson(ev.id)).status).toBe(200);
    expect((await row(panel.id)).archivedAt).not.toBeNull();

    // Kyle: "that one is a separate job" — Unarchive from the drawer.
    expect((await unarchive(panel.id)).status).toBe(200);
    expect((await row(panel.id)).archivedAt).toBeNull();

    // A week later the EV charger is revised and the revision is signed. The pass runs again.
    const rev = await reviseEstimate(prisma, ev.id, { actor: "human:crm-session" });
    if (!rev.ok) throw new Error(`revise failed: ${JSON.stringify(rev)}`);
    await put(rev.estimateId, "sent");
    const late = await presented("a third quote, sent after the unarchive", p);
    const res = await signInPerson(rev.estimateId);
    expect(res.status).toBe(200);

    // The person's decision stands; the new row is caught, proving the pass did run.
    expect((await row(panel.id)).archivedAt).toBeNull();
    expect((await row(late.id)).archivedAt).not.toBeNull();
    expect(res.body.archived.map((a: { id: string }) => a.id)).toEqual([late.id]);
  });

  it("signing a change order archives nothing at the address", async () => {
    const p = await property("Change order door");
    const root = await presented("the job", p);
    expect((await signEstimateInPerson(prisma, root.id, { signerName: "Arlene", signatureImage: TEST_SIGNATURE })).ok).toBe(true);
    const waiting = await presented("a separate quote, still out", p);
    const co = await presented("more work on the job", p);
    await prisma.issuedEstimate.update({ where: { id: co.id }, data: { changeOrderForId: root.id } });
    const res = await signInPerson(co.id);
    expect(res.status).toBe(200);
    expect(res.body.archived).toEqual([]);
    expect((await row(waiting.id)).archivedAt).toBeNull();
  });
});

describe("5. Archive and unarchive by hand — the drawer's endpoints", () => {
  let p: string;
  beforeAll(async () => { p = await property("By hand"); });

  it("round-trips: archive with a reason, read it back on the record and the chain, unarchive, and each refuses a second time", async () => {
    const e = await presented("Arlene's first $14k options", p, "viewed");

    const archived = await archiveByHand(e.id, "went with 2026-1101 instead");
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ archived: true, reason: "went with 2026-1101 instead" });
    const r = await row(e.id);
    expect(r.archivedAt).not.toBeNull();
    expect(r.archivedReason).toBe("went with 2026-1101 instead");
    expect(r.status).toBe("viewed"); // not a status
    expect((await events(e.id, "archived"))[0].actor).toBe("human:crm-session");

    // Shown wherever the row is shown: the drawer's record and the Estimates page's chain.
    const record = await request(app).get(`/issued-estimates/${e.id}/record`);
    expect(record.status).toBe(200);
    expect(record.body.estimate.archivedReason).toBe("went with 2026-1101 instead");
    expect(record.body.estimate.archivedAt).toBeTruthy();
    const chain = await request(app).get("/issued-estimates/chain?includeTest=true");
    const chainRow = chain.body.estimates.find((x: { id: string }) => x.id === e.id);
    expect(chainRow.archivedReason).toBe("went with 2026-1101 instead");
    expect(chainRow.status).toBe("viewed");

    expect((await archiveByHand(e.id)).status).toBe(409);

    const back = await unarchive(e.id);
    expect(back.status).toBe(200);
    expect(back.body).toEqual({ unarchived: true, status: "viewed" });
    const r2 = await row(e.id);
    expect(r2.archivedAt).toBeNull();
    expect(r2.archivedReason).toBeNull();
    expect(r2.status).toBe("viewed");
    expect((await events(e.id, "unarchived"))[0].actor).toBe("human:crm-session");

    expect((await unarchive(e.id)).status).toBe(409);
  });

  it("archives with no reason at all, and a draft (never sent) may be put away rather than deleted", async () => {
    const d = await issue("a draft put away", p);
    const res = await archiveByHand(d.id, null);
    expect(res.status).toBe(200);
    expect(res.body.reason).toBeNull();
    expect((await row(d.id)).status).toBe("draft");
  });

  it("refuses a signed, a void and a lost estimate, each naming its own door", async () => {
    const signed = await presented("signed", p);
    expect((await signEstimateInPerson(prisma, signed.id, { signerName: "Arlene", signatureImage: TEST_SIGNATURE })).ok).toBe(true);
    const s = await archiveByHand(signed.id);
    expect(s.status).toBe(409);
    expect(s.body.error).toMatch(/Void it/);

    const voided = await presented("void", p);
    await prisma.issuedEstimate.update({ where: { id: voided.id }, data: { status: "void", voidedAt: new Date() } });
    expect((await archiveByHand(voided.id)).status).toBe(409);

    const lost = await presented("lost", p);
    await prisma.issuedEstimate.update({ where: { id: lost.id }, data: { status: "lost", lostAt: new Date(), lostReason: "price" } });
    const l = await archiveByHand(lost.id);
    expect(l.status).toBe(409);
    expect(l.body.error).toMatch(/Reopen it first/);

    expect((await archiveByHand("does-not-exist")).status).toBe(404);
  });

  it("an archived estimate is not sent until it is unarchived", async () => {
    const e = await presented("archived, then resent", p);
    expect((await archiveByHand(e.id, "put away")).status).toBe(200);
    const sent = await sendEstimateEmail(prisma, e.id, { sentBy: "human:crm-session" });
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.reason).toMatch(/archived.*Unarchive/i);
  });
});

describe("6. Not a status, not money — and how the funnel counts it", () => {
  it("a signature on an archived estimate takes it back out of the archive, so an archived row is never a signed row", async () => {
    const p = await property("Signed after archive");
    const e = await presented("put away, then the customer signed it anyway", p);
    expect((await archiveByHand(e.id, "thought they went elsewhere")).status).toBe(200);
    const res = await signInPerson(e.id);
    expect(res.status).toBe(200);
    const r = await row(e.id);
    expect(r.status).toBe("signed");
    expect(r.signedAt).not.toBeNull();
    expect(r.archivedAt).toBeNull();
    expect(r.archivedReason).toBeNull();
    // Same for the office door.
    const o = await presented("put away, then accepted by phone", p);
    expect((await archiveByHand(o.id)).status).toBe(200);
    expect((await request(app).post(`/issued-estimates/${o.id}/accept`).send({ acceptedVia: "phone", acceptedBy: "Arlene Williamson" })).status).toBe(200);
    expect((await row(o.id)).archivedAt).toBeNull();
  });

  it("every archived row in the database is unsigned, without a job, and absent from /invoices; archiving moved no LIVE_SIGNED count", async () => {
    const archivedRows = await prisma.issuedEstimate.findMany({ where: { archivedAt: { not: null } }, select: { id: true, signedAt: true, jobVisitId: true, status: true } });
    expect(archivedRows.length).toBeGreaterThan(0);
    for (const r of archivedRows) {
      expect(r.signedAt).toBeNull();
      expect(r.jobVisitId).toBeNull();
      expect(r.status).not.toBe("signed");
    }
    const invoices = await request(app).get("/invoices?includeTest=true");
    expect(invoices.status).toBe(200);
    const listed = new Set((invoices.body as { id: string }[]).map((i) => i.id));
    for (const r of archivedRows) expect(listed.has(r.id)).toBe(false);

    const p = await property("Money");
    const e = await presented("archived by hand", p);
    const liveSignedBefore = await prisma.issuedEstimate.count({ where: LIVE_SIGNED });
    expect((await archiveByHand(e.id)).status).toBe(200);
    expect(await prisma.issuedEstimate.count({ where: LIVE_SIGNED })).toBe(liveSignedBefore);
  });

  it("the funnel reports an archived document as WITHDRAWN — outside the rate, neither won, lost nor open", async () => {
    const range: FunnelRange = {
      start: new Date(Date.now() - 2 * DAY), end: new Date(Date.now() + 2 * DAY),
      startDate: new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10), endDate: new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10),
    };
    const p = await property("Funnel");
    const e = await presented("in the rate until archived", p);
    const before = await getFunnelReport(prisma, range);
    expect((await archiveByHand(e.id, "options not taken")).status).toBe(200);
    const after = await getFunnelReport(prisma, range);

    expect(after.winRate.withdrawn).toBe(before.winRate.withdrawn + 1);
    expect(after.winRate.open).toBe(before.winRate.open - 1);
    expect(after.winRate.issued).toBe(before.winRate.issued - 1);
    expect(after.winRate.contracted).toBe(before.winRate.contracted);
    expect(after.winRate.lost).toBe(before.winRate.lost);
    expect(after.winRate.issued).toBe(after.winRate.contracted + after.winRate.lost + after.winRate.open);

    // And back, exactly.
    expect((await unarchive(e.id)).status).toBe(200);
    const restored = await getFunnelReport(prisma, range);
    expect(restored.winRate).toEqual(before.winRate);
  });
});
