/**
 * One estimate, one link (Kyle, 2026-11-27; plan .claude/plans/2026-11-27-one-estimate-one-link.md, Part 2).
 *
 *   "This is getting on my nerves, see how each draft creates a new document. I am tired of it. It
 *    should replace what was edited not create more drafts that have to be deleted."
 *
 * Every save of an issued estimate used to be a new revision with a new customer link. Now:
 *
 *   (a) saving an estimate NOBODY OUTSIDE THE OFFICE HAS SEEN replaces it where it is - the same
 *       row, number, revision and link, with the draft's lines and total as they are now;
 *   (b) once it has been sent, opened, signed, accepted or paid on, a save is a revision exactly as
 *       before - new row, revision up, the old link dead;
 *   (c) a send that lands WHILE the save is being built wins: the save falls back to a revision.
 *
 *   (f) a save in place never lets a signature land on a document the customer was not shown: the
 *       office's signing screen and the phone both say which document they showed, and the write
 *       refuses one that has been saved since (review findings, 2026-11-27);
 *   (g) an email that is still being SENT already counts: the real sendEstimateEmail claims the
 *       estimate before it reads the figures, so a save during the send is a revision.
 *
 * Everything here goes through the real services (issueDraft / reviseEstimate / graduateDraft /
 * signEstimate / sendEstimateEmail) against the test database. Nothing in the estimating path is
 * mocked. The ONE stub is the mail provider (sendBrandedEmail), so no email leaves the test run and
 * a test can hold a send "in flight".
 */

import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";

// The mail provider, and nothing else. Every test starts with it accepting the message.
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn() }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { addLine, createDraft, setDraftDetails } from "../src/services/atomicEstimateService";
import {
  estimateIsUnseen,
  figuresKeyOf,
  getDraftLifecycle,
  getEstimateByToken,
  issueDraft,
  issuedFiguresKey,
  reviseEstimate,
  signEstimate,
  signEstimateInPerson,
} from "../src/services/issuedEstimateService";
import { sendEstimateEmail } from "../src/services/issuedEstimateSend";
import { getIssuedQuoteMoney } from "../src/services/quoteMoney";

beforeEach(() => {
  emailMock.sendBrandedEmail.mockReset();
  emailMock.sendBrandedEmail.mockResolvedValue(true);
});

const MARK = "OEOL";
const ITEM_A = "OEOL001";
const ITEM_B = "OEOL002";
const ITEM_C = "OEOL003";

let customerId: string;
let propertyId: string;
let visitId: string;
const draftIds: string[] = [];

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ITEM_A), quotableAtomic(ITEM_B), quotableAtomic(ITEM_C)]);
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Test Account`, email: "oeol-account@example.com", phone: "615-555-0160" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "1 Example Way", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" },
  });
  visitId = visit.id;
});

afterAll(async () => {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: draftIds } }, select: { id: true } });
  const estIds = ests.map((e) => e.id);
  await prisma.payment.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.emailDelivery.deleteMany({ where: { issuedEstimateId: { in: estIds } } });
  await prisma.document.deleteMany({ where: { issuedEstimateId: { in: estIds } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ITEM_A, ITEM_B, ITEM_C]);
});

/** A draft with two quotable lines, issued once through the CRM's Issue door. Nothing sent. */
async function issuedOnce(title: string) {
  const draft = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(draft.id);
  await addLine(prisma, draft.id, { itemId: ITEM_A, quantity: 2, quantitySource: "COUNT" });
  await addLine(prisma, draft.id, { itemId: ITEM_B, quantity: 1, quantitySource: "COUNT" });
  const first = await issueDraft(prisma, { draftId: draft.id, accountId: customerId, serviceAddressId: propertyId, actor: "human:test" });
  if (!first.ok) throw new Error(`first issue refused: ${first.reasons.join(" ")}`);
  expect(first.replacedInPlace).toBeUndefined();
  return { draftId: draft.id, estimateId: first.estimateId, number: first.number };
}

/** The whole estimate as stored, for before/after comparison. */
function snapshot(estimateId: string) {
  return prisma.issuedEstimate.findUniqueOrThrow({
    where: { id: estimateId },
    include: { lines: { orderBy: { sortOrder: "asc" } }, options: true, events: { orderBy: { at: "asc" } }, supersededBy: true },
  });
}

/** Edit the draft the way the builder does: one more line. Any edit reopens the draft. */
function editDraft(draftId: string) {
  return addLine(prisma, draftId, { itemId: ITEM_C, quantity: 3, quantitySource: "COUNT" });
}

// ─── (a) nobody outside the office has seen it: replaced where it is ─────────────────────────

describe("(a) saving an estimate nobody outside the office has seen replaces it in place", () => {
  it("the office's 'Save changes to the estimate' (reviseEstimate): same id, number, revision and token; the lines and the total change", async () => {
    const { draftId, estimateId, number } = await issuedOnce("save-in-place");
    const before = await snapshot(estimateId);
    expect(await estimateIsUnseen(prisma, estimateId)).toBe(true);
    await editDraft(draftId);

    const saved = await reviseEstimate(prisma, estimateId, { actor: "human:test" });

    expect(saved).toEqual({ ok: true, estimateId, number, revision: 1, replacedInPlace: true });
    const after = await snapshot(estimateId);
    // The identity is untouched - above all the token, which IS the customer's link.
    expect(after.id).toBe(before.id);
    expect(after.number).toBe(before.number);
    expect(after.revision).toBe(1);
    expect(after.token).toBe(before.token);
    expect(after.supersedesId).toBeNull();
    expect(after.supersededBy).toBeNull();
    expect(after.status).toBe("draft");
    // The document is the draft as it stands now.
    expect(after.lines.map((l) => l.itemId)).toEqual([ITEM_A, ITEM_B, ITEM_C]);
    expect(before.lines.map((l) => l.itemId)).toEqual([ITEM_A, ITEM_B]);
    expect(after.total).toBeGreaterThan(before.total);
    expect(after.workSubtotal).toBeCloseTo(after.lines.reduce((s, l) => s + l.lineTotal, 0), 2);
    expect(after.options.reduce((s, o) => s + o.lineCount, 0)).toBe(3);
    // No second estimate: the draft has ONE issued row, and no row was left behind by the save.
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(1);
    // The link still opens, and it opens the new figures.
    const byToken = await getEstimateByToken(prisma, before.token);
    expect(byToken.ok).toBe(true);
    if (byToken.ok) expect(byToken.estimate.total).toBe(after.total);
    // The history stays and gains one "updated" - never a second "created", never "superseded".
    expect(after.events.map((e) => e.type)).toEqual(["created", "updated"]);
    expect(after.events[1].actor).toBe("human:test");
    expect(after.events[1].detail).toContain("Same number, same revision, same customer link");
    // A save is not a view (trap 7): nothing here stamps the first view.
    expect(after.firstViewedAt).toBeNull();
    expect(after.sentAt).toBeNull();
  });

  it("keeps what belongs to the estimate rather than the document: the warranty claim and who created it", async () => {
    const { draftId, estimateId } = await issuedOnce("keeps-identity");
    const claim = JSON.stringify({ company: "Example Warranty", claimNumber: "C-1", coveredAmount: 50 });
    await prisma.issuedEstimate.update({ where: { id: estimateId }, data: { warrantyJson: claim, depositRequired: false } });
    await prisma.issuedEstimateEvent.createMany({
      data: [
        { estimateId, type: "warranty_set", actor: "human:test", detail: "set" },
        { estimateId, type: "terms_changed", actor: "human:test", detail: "deposit off" },
      ],
    });
    await editDraft(draftId);

    const saved = await reviseEstimate(prisma, estimateId, { actor: "tech:someone" });

    expect(saved.ok && saved.replacedInPlace).toBe(true);
    const after = await snapshot(estimateId);
    expect(after.warrantyJson).toBe(claim);
    expect(after.depositRequired).toBe(false);
    expect(after.createdBy).toBe("human:test");
  });

  it("both Issue doors (issueDraft) do the same: the CRM's and the technician's", async () => {
    for (const door of ["crm", "field"] as const) {
      const { draftId, estimateId, number } = await issuedOnce(`issue-door-${door}`);
      const before = await snapshot(estimateId);
      await editDraft(draftId);

      const again = await issueDraft(prisma, {
        draftId, accountId: customerId, serviceAddressId: propertyId,
        actor: "tech:id-1", reviseActor: "tech:Test Tech", door,
      });

      expect(again).toEqual({ ok: true, estimateId, number, revision: 1, replacedInPlace: true });
      const after = await snapshot(estimateId);
      expect(after.token).toBe(before.token);
      expect(after.lines).toHaveLength(3);
      expect(after.events.at(-1)).toMatchObject({ type: "updated", actor: "tech:Test Tech" });
      expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(1);
    }
  });

  it("five saves before the first send leave ONE estimate with ONE link (the 2026-11-27 screenshot)", async () => {
    const { draftId, estimateId } = await issuedOnce("five-saves");
    const { token } = await snapshot(estimateId);
    for (let i = 0; i < 5; i++) {
      await addLine(prisma, draftId, { itemId: ITEM_C, quantity: i + 1, quantitySource: "COUNT" });
      const saved = await reviseEstimate(prisma, estimateId, { actor: "human:test" });
      expect(saved.ok && saved.replacedInPlace).toBe(true);
    }
    const rows = await prisma.issuedEstimate.findMany({ where: { draftId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: estimateId, revision: 1, token });
  });

  it("the lifecycle tells both apps which it will be, before the press", async () => {
    const { draftId, estimateId } = await issuedOnce("lifecycle");
    for (const door of ["crm", "field"] as const) {
      expect((await getDraftLifecycle(prisma, draftId, door)).issued?.savesInPlace).toBe(true);
    }
    await prisma.issuedEstimate.update({ where: { id: estimateId }, data: { sentAt: new Date(), sentTo: "oeol-account@example.com", status: "sent" } });
    for (const door of ["crm", "field"] as const) {
      expect((await getDraftLifecycle(prisma, draftId, door)).issued?.savesInPlace).toBe(false);
    }
  });
});

// ─── (b) somebody outside the office has: a revision, as before ──────────────────────────────

describe("(b) once anybody outside the office could have seen it or acted on it, a save is a revision", () => {
  /** Each entry makes the estimate NOT unseen, the way the app itself records that fact. */
  const touched: Array<[string, (estimateId: string) => Promise<unknown>]> = [
    ["sent", (id) => prisma.issuedEstimate.update({ where: { id }, data: { sentAt: new Date(), sentBy: "human:test", sentTo: "oeol-account@example.com", status: "sent" } })],
    ["viewed by the customer", (id) => prisma.issuedEstimate.update({ where: { id }, data: { firstViewedAt: new Date() } })],
    ["deposit-bearing (a payment recorded against it)", (id) => prisma.payment.create({ data: { customerId, estimateId: id, amount: 100, method: "check", kind: "deposit" } })],
    ["emailed, even when the send stamp never landed (an EmailDelivery row)", (id) => prisma.emailDelivery.create({ data: { provider: "resend", to: "oeol-account@example.com", subject: "Your estimate", kind: "estimate", issuedEstimateId: id, status: "sent" } })],
    ["archived", (id) => prisma.issuedEstimate.update({ where: { id }, data: { archivedAt: new Date(), archivedReason: "another option was chosen" } })],
    ["carrying an event the allow-list does not know", (id) => prisma.issuedEstimateEvent.create({ data: { estimateId: id, type: "something_new", actor: "human:test" } })],
  ];

  it.each(touched)("%s", async (_label, touch) => {
    const { draftId, estimateId, number } = await issuedOnce("revises");
    const before = await snapshot(estimateId);
    await touch(estimateId);
    expect(await estimateIsUnseen(prisma, estimateId)).toBe(false);
    await editDraft(draftId);

    const saved = await reviseEstimate(prisma, estimateId, { actor: "human:test" });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.replacedInPlace).toBeUndefined();
    expect(saved.estimateId).not.toBe(estimateId);
    expect(saved).toMatchObject({ number, revision: 2 });
    // The old row is exactly as it was - same lines, same total - and its link is dead.
    const old = await snapshot(estimateId);
    expect(old.lines.map((l) => l.id)).toEqual(before.lines.map((l) => l.id));
    expect(old.total).toBe(before.total);
    expect(old.token).toBe(before.token);
    expect(old.supersededBy?.id).toBe(saved.estimateId);
    expect(old.events.some((e) => e.type === "updated")).toBe(false);
    expect((await getEstimateByToken(prisma, before.token)).ok).toBe(false);
    // The revision has its own link and the edited lines.
    const next = await snapshot(saved.estimateId);
    expect(next.token).not.toBe(before.token);
    expect(next.supersedesId).toBe(estimateId);
    expect(next.lines).toHaveLength(3);
  });

  it("signed by the customer (the real signature): the office's save still makes a revision to be signed again", async () => {
    const { draftId, estimateId, number } = await issuedOnce("revises-signed");
    const { token } = await snapshot(estimateId);
    const signed = await signEstimate(prisma, token, { signerName: "Test Signer", signatureImage: TEST_SIGNATURE });
    expect(signed.ok).toBe(true);
    expect(await estimateIsUnseen(prisma, estimateId)).toBe(false);
    void draftId;

    const saved = await reviseEstimate(prisma, estimateId, { actor: "human:test" });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.replacedInPlace).toBeUndefined();
    expect(saved).toMatchObject({ number, revision: 2 });
    const old = await snapshot(estimateId);
    expect(old.signedAt).not.toBeNull();
    expect(old.signerName).toBe("Test Signer");
  });

  it("accepted by the office on the customer's word: a revision, never an in-place change to what was accepted", async () => {
    // A signed or accepted estimate shuts its draft's lines, so there is no line edit here - the
    // office's save republishes the draft (its discount, title and scope stay editable).
    const { estimateId, number } = await issuedOnce("revises-accepted");
    await prisma.issuedEstimate.update({ where: { id: estimateId }, data: { signedAt: new Date(), signerName: "Test Signer", signedChannel: "office", acceptedVia: "phone", status: "signed" } });
    const before = await snapshot(estimateId);
    expect(await estimateIsUnseen(prisma, estimateId)).toBe(false);

    const saved = await reviseEstimate(prisma, estimateId, { actor: "human:test" });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.replacedInPlace).toBeUndefined();
    expect(saved).toMatchObject({ number, revision: 2 });
    const old = await snapshot(estimateId);
    expect(old.acceptedVia).toBe("phone");
    expect(old.lines.map((l) => l.id)).toEqual(before.lines.map((l) => l.id));
    expect(old.events.some((e) => e.type === "updated")).toBe(false);
  });

  it("the save AFTER a revision is in place again: the new revision is itself unseen until it is sent", async () => {
    const { draftId, estimateId } = await issuedOnce("revision-then-in-place");
    await prisma.issuedEstimate.update({ where: { id: estimateId }, data: { sentAt: new Date(), sentTo: "oeol-account@example.com", status: "sent" } });
    await editDraft(draftId);
    const rev2 = await reviseEstimate(prisma, estimateId, { actor: "human:test" });
    expect(rev2.ok && rev2.revision).toBe(2);
    if (!rev2.ok) return;
    const rev2Before = await snapshot(rev2.estimateId);
    await editDraft(draftId);

    const again = await issueDraft(prisma, { draftId, accountId: customerId, serviceAddressId: propertyId, actor: "human:test" });

    expect(again).toEqual({ ok: true, estimateId: rev2.estimateId, number: rev2.number, revision: 2, replacedInPlace: true });
    const rev2After = await snapshot(rev2.estimateId);
    expect(rev2After.token).toBe(rev2Before.token);
    // The kept row keeps ITS OWN place in the chain (trap 2): it still supersedes rev 1.
    expect(rev2After.supersedesId).toBe(estimateId);
    expect(rev2After.lines).toHaveLength(4);
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(2);
  });
});

// ─── (c) the race ────────────────────────────────────────────────────────────────────────────

describe("(c) a send that lands while the save is being built wins", () => {
  it("the unseen test is read again under the row lock, so the save falls back to a revision", async () => {
    const { draftId, estimateId, number } = await issuedOnce("race-send");
    const before = await snapshot(estimateId);
    await editDraft(draftId);

    // The send: it holds the estimate's row lock until the save has built its fresh row
    // (graduateDraft has run, the lock has not been taken yet), then stamps "sent" and commits.
    // The save read "unseen" before any of that; only the re-check under the lock can catch it.
    const send = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "IssuedEstimate" WHERE "id" = ${estimateId} FOR UPDATE`;
      for (let i = 0; i < 400; i++) {
        if (await prisma.issuedEstimate.count({ where: { draftId, id: { not: estimateId } } })) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await tx.issuedEstimate.update({ where: { id: estimateId }, data: { sentAt: new Date(), sentBy: "human:test", sentTo: "oeol-account@example.com", status: "sent" } });
      await tx.issuedEstimateEvent.create({ data: { estimateId, type: "sent", actor: "human:test", detail: "Emailed (rev 1)" } });
    }, { timeout: 30_000 });
    const save = reviseEstimate(prisma, estimateId, { actor: "human:test" });
    await send;
    const saved = await save;

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.replacedInPlace).toBeUndefined();
    expect(saved.estimateId).not.toBe(estimateId);
    expect(saved).toMatchObject({ number, revision: 2 });
    // What was sent is what the customer was sent: untouched, superseded, its link dead.
    const old = await snapshot(estimateId);
    expect(old.sentAt).not.toBeNull();
    expect(old.total).toBe(before.total);
    expect(old.lines.map((l) => l.id)).toEqual(before.lines.map((l) => l.id));
    expect(old.supersededBy?.id).toBe(saved.estimateId);
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(2);
  });
});

// ─── (f) a signature never lands on a document the customer was not shown ────────────────────
//
// Before this build every save was a new revision, so a signature taken on the old one was refused
// ("replaced by a newer revision" / "taken on revision 1, this is revision 2"). An in-place save
// keeps the row and the revision, so the write itself has to notice that the document changed.

describe("(f) an in-place save cannot put a signature on a document the customer was not shown", () => {
  const ownerToken = () => jwt.sign({ sub: "owner" }, process.env.JWT_SECRET ?? "rce-dev-secret-change-me", { expiresIn: "1h" });
  const row = (id: string) => prisma.issuedEstimate.findUniqueOrThrow({ where: { id } });

  it("the office's signing screen: the page is loaded, the estimate is saved with a changed price, the signature is refused", async () => {
    const { draftId, estimateId, number } = await issuedOnce("sign-office");
    const before = await row(estimateId);

    // "Sign now": the customer starts reading. The page says which document it is.
    const view = await request(app).get(`/issued-estimates/${estimateId}/customer-view`).set("Authorization", `Bearer ${ownerToken()}`);
    expect(view.status).toBe(200);
    const shown = view.headers["x-figures-key"];
    expect(shown).toMatch(/^[0-9a-f]{64}$/);
    // Opening it on the office's own screen is not a customer view (trap 7) - it is still unseen.
    expect(await estimateIsUnseen(prisma, estimateId)).toBe(true);
    expect((await row(estimateId)).firstViewedAt).toBeNull();

    // Another tab (or the technician's Issue) saves the same draft with one more line.
    await editDraft(draftId);
    const saved = await reviseEstimate(prisma, estimateId, { actor: "human:test" });
    expect(saved.ok && saved.replacedInPlace).toBe(true);
    expect((await row(estimateId)).total).toBeGreaterThan(before.total);

    // The customer signs the page they were reading.
    const signedOld = await request(app)
      .post(`/issued-estimates/${estimateId}/sign-in-person`)
      .set("Authorization", `Bearer ${ownerToken()}`)
      .send({ signerName: "Test Signer", signatureImage: TEST_SIGNATURE, figuresKey: shown });
    expect(signedOld.status).toBe(400);
    expect(signedOld.body).toMatchObject({ signed: false });
    expect(signedOld.body.error).toContain(`not the figures estimate ${number} shows now`);
    expect((await row(estimateId)).signedAt).toBeNull();

    // A page that does not say what it showed (one loaded before this build) is refused too.
    const signedBlind = await request(app)
      .post(`/issued-estimates/${estimateId}/sign-in-person`)
      .set("Authorization", `Bearer ${ownerToken()}`)
      .send({ signerName: "Test Signer", signatureImage: TEST_SIGNATURE });
    expect(signedBlind.status).toBe(400);
    expect(signedBlind.body.error).toMatch(/did not say which version the customer read/);
    expect((await row(estimateId)).signedAt).toBeNull();

    // Reloaded, the page carries the current document's key, and that signature is the one recorded.
    const reloaded = await request(app).get(`/issued-estimates/${estimateId}/customer-view`).set("Authorization", `Bearer ${ownerToken()}`);
    expect(reloaded.headers["x-figures-key"]).not.toBe(shown);
    const signedNow = await signEstimateInPerson(prisma, estimateId, {
      signerName: "Test Signer", signatureImage: TEST_SIGNATURE, figuresKey: reloaded.headers["x-figures-key"],
    });
    expect(signedNow).toEqual({ ok: true, estimateId });
    expect((await row(estimateId)).signedAt).not.toBeNull();
  });

  it("an estimate never saved in place still signs from a page that sends no key (nothing changes for it)", async () => {
    const { estimateId } = await issuedOnce("sign-no-key");
    expect(await signEstimateInPerson(prisma, estimateId, { signerName: "Test Signer", signatureImage: TEST_SIGNATURE })).toEqual({ ok: true, estimateId });
  });

  it("the phone: a WORDS-ONLY save (same dollars, same revision) still refuses the signature taken on the old wording", async () => {
    const { draftId, estimateId, number } = await issuedOnce("sign-words-only");
    const before = await row(estimateId);
    // What the phone holds: the revision and the server's key for the quote it is showing.
    const held = (await getDraftLifecycle(prisma, draftId, "field")).issued!;
    expect(held).toMatchObject({ estimateId, revision: 1 });

    // The office rewrites the scope. No price moves.
    await setDraftDetails(prisma, draftId, { jobDescription: "A different scope of work than the customer read." });
    const saved = await reviseEstimate(prisma, estimateId, { actor: "human:test" });
    expect(saved).toEqual({ ok: true, estimateId, number, revision: 1, replacedInPlace: true });
    const after = await row(estimateId);
    expect(after.total).toBe(before.total);
    expect(after.scopeText).not.toBe(before.scopeText);
    // Same dollars and the same revision, and the key is nevertheless a different one.
    expect(await issuedFiguresKey(prisma, estimateId)).not.toBe(held.figuresKey);

    // Captured after the save, on the screen loaded before it - and sent at once, clocks agreeing.
    const now = new Date().toISOString();
    const signed = await signEstimateInPerson(prisma, estimateId, {
      signerName: "Test Signer", signatureImage: TEST_SIGNATURE,
      revision: held.revision, figuresKey: held.figuresKey, capturedAt: now, sentAt: now,
    });
    expect(signed.ok).toBe(false);
    if (!signed.ok) expect(signed.reason).toMatch(/not the figures estimate .* shows now/);
    expect((await row(estimateId)).signedAt).toBeNull();

    // With the quote reloaded, the phone holds the new key and the signature is recorded.
    const fresh = (await getDraftLifecycle(prisma, draftId, "field")).issued!;
    expect(fresh.figuresKey).not.toBe(held.figuresKey);
    const again = await signEstimateInPerson(prisma, estimateId, {
      signerName: "Test Signer", signatureImage: TEST_SIGNATURE, revision: fresh.revision, figuresKey: fresh.figuresKey,
    });
    expect(again).toEqual({ ok: true, estimateId });
  });

  it("the key of an estimate never saved in place is what it always was (a signature a phone already holds still lands)", async () => {
    const { draftId, estimateId } = await issuedOnce("sign-key-unchanged");
    const key = (await getDraftLifecycle(prisma, draftId, "field")).issued!.figuresKey;
    const money = await getIssuedQuoteMoney(prisma, estimateId);
    // Exactly the hash made before this build: the revision and the selections, nothing else.
    expect(key).toBe(figuresKeyOf(money!.selections, 1));
    // The stamp only enters the hash when there is one.
    expect(figuresKeyOf({ A: { total: 1 } }, 1, null)).toBe(figuresKeyOf({ A: { total: 1 } }, 1));
    expect(figuresKeyOf({ A: { total: 1 } }, 1, "event-1")).not.toBe(figuresKeyOf({ A: { total: 1 } }, 1));
    expect(figuresKeyOf({ A: { total: 1 } }, 1, "event-1")).not.toBe(figuresKeyOf({ A: { total: 1 } }, 1, "event-2"));
  });

  it("a save that lands while the signature is being written wins: the signature is refused, nothing is signed", async () => {
    const { estimateId, number } = await issuedOnce("sign-race");
    const key = await issuedFiguresKey(prisma, estimateId);

    // The save: it holds the estimate's row lock (as reviseEstimate does) until the signature has
    // run all its checks and is waiting for that lock, then commits its "updated" event.
    let sign!: ReturnType<typeof signEstimateInPerson>;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "IssuedEstimate" WHERE "id" = ${estimateId} FOR UPDATE`;
      sign = signEstimateInPerson(prisma, estimateId, { signerName: "Test Signer", signatureImage: TEST_SIGNATURE, figuresKey: key });
      let blocked = false;
      for (let i = 0; i < 400 && !blocked; i++) {
        const waiting = await prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"IssuedEstimate"%FOR UPDATE%'`;
        blocked = Number(waiting[0].n) > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
      expect(blocked).toBe(true);
      await tx.issuedEstimateEvent.create({ data: { estimateId, type: "updated", actor: "human:test", detail: "saved in place" } });
    }, { timeout: 30_000 });

    const signed = await sign;
    expect(signed.ok).toBe(false);
    if (!signed.ok) expect(signed.reason).toBe(`Estimate ${number} was changed while the customer was signing it. Open the current estimate and have the customer read it and sign again.`);
    expect((await row(estimateId)).signedAt).toBeNull();
  });
});

// ─── (g) an email being sent already counts as sent ──────────────────────────────────────────
//
// Kyle: "she got 4 emails and they show different pricing." The real send, with only the mail
// provider held open: a save that arrives while the message is with the provider must not rewrite
// the figures behind the link that message carries.

describe("(g) a save while the estimate email is being sent is a revision, never an in-place change", () => {
  const events = async (estimateId: string) =>
    (await prisma.issuedEstimateEvent.findMany({ where: { estimateId }, orderBy: { at: "asc" } })).map((e) => e.type);
  const bodySent = () => (emailMock.sendBrandedEmail.mock.calls[0][0] as { bodyHtml: string }).bodyHtml;

  it("the provider is still working on the message when 'Save changes to the estimate' is pressed", async () => {
    const { draftId, estimateId, number } = await issuedOnce("send-in-flight");
    const before = await snapshot(estimateId);
    await editDraft(draftId);

    // The provider takes the message and does not answer until the save is done.
    let providerHasIt!: () => void;
    const handed = new Promise<void>((r) => { providerHasIt = r; });
    let providerAnswers!: (ok: boolean) => void;
    const answer = new Promise<boolean>((r) => { providerAnswers = r; });
    emailMock.sendBrandedEmail.mockImplementation(() => { providerHasIt(); return answer; });

    const send = sendEstimateEmail(prisma, estimateId, { sentBy: "human:test" });
    await handed;
    // Mid-send: no sentAt, no EmailDelivery row - and it is already NOT unseen.
    expect((await snapshot(estimateId)).sentAt).toBeNull();
    expect(await prisma.emailDelivery.count({ where: { issuedEstimateId: estimateId } })).toBe(0);
    expect(await estimateIsUnseen(prisma, estimateId)).toBe(false);

    const saved = await reviseEstimate(prisma, estimateId, { actor: "human:test" });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.replacedInPlace).toBeUndefined();
    expect(saved.estimateId).not.toBe(estimateId);
    expect(saved).toMatchObject({ number, revision: 2 });

    providerAnswers(true);
    expect(await send).toMatchObject({ ok: true, to: "oeol-account@example.com" });
    // What the email quoted is what its link's row still holds: the lines and total it was built from.
    const old = await snapshot(estimateId);
    expect(old.total).toBe(before.total);
    expect(old.lines.map((l) => l.id)).toEqual(before.lines.map((l) => l.id));
    expect(old.sentAt).not.toBeNull();
    expect(bodySent()).toContain(before.token);
    expect(bodySent()).toContain(`Total $${before.total.toFixed(2)}`);
    // The claim is gone once the send is recorded; the trail reads as it always did.
    expect((await events(estimateId)).sort()).toEqual(["created", "sent", "superseded"]);
  });

  it("the save got there first: it lands in place, and the email is built from the saved figures", async () => {
    const { draftId, estimateId } = await issuedOnce("save-then-send");
    const before = await snapshot(estimateId);
    await editDraft(draftId);
    const saved = await reviseEstimate(prisma, estimateId, { actor: "human:test" });
    expect(saved.ok && saved.replacedInPlace).toBe(true);
    const after = await snapshot(estimateId);
    expect(after.total).not.toBe(before.total);

    expect(await sendEstimateEmail(prisma, estimateId, { sentBy: "human:test" })).toMatchObject({ ok: true });

    expect(bodySent()).toContain(`Total $${after.total.toFixed(2)}`);
    expect(await events(estimateId)).toEqual(["created", "updated", "sent"]);
  });

  it("a send the provider FAILED keeps its claim (the message may have gone): the next save is a revision", async () => {
    const { draftId, estimateId } = await issuedOnce("send-failed");
    emailMock.sendBrandedEmail.mockResolvedValue(false);

    expect((await sendEstimateEmail(prisma, estimateId, { sentBy: "human:test" })).ok).toBe(false);

    expect(await events(estimateId)).toEqual(["created", "send_started"]);
    expect((await snapshot(estimateId)).sentAt).toBeNull();
    await editDraft(draftId);
    const saved = await reviseEstimate(prisma, estimateId, { actor: "human:test" });
    expect(saved.ok && saved.revision).toBe(2);
    expect(saved.ok && saved.replacedInPlace).toBeUndefined();
  });

  it("a send refused BEFORE anything reached the provider leaves no claim: the next save is still in place", async () => {
    const { draftId, estimateId } = await issuedOnce("send-refused");

    // No electrical assessment at this address, so the report cannot be attached and nothing is sent.
    const refused = await sendEstimateEmail(prisma, estimateId, { sentBy: "human:test", attachHealthReport: true });

    expect(refused.ok).toBe(false);
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
    expect(await events(estimateId)).toEqual(["created"]);
    await editDraft(draftId);
    const saved = await reviseEstimate(prisma, estimateId, { actor: "human:test" });
    expect(saved.ok && saved.replacedInPlace).toBe(true);
  });
});
