/**
 * Email sends what is on screen (Kyle, 2026-11-27; plan .claude/plans/2026-11-27-one-estimate-one-link.md, Part 5).
 *
 *   "When I sent that last estimate and did not click save changes to the estimate it did send but it
 *    did not save the changes to his account either. So now he has a copy of the updated estimate and
 *    I do not."
 *
 * The ONE estimate-email service (sendEstimateEmail, reached through sendEstimateEmailFromBody by BOTH
 * the CRM's POST /customer-emails and the field's /health-record/issued-estimates/:id/email) now SAVES
 * the draft first when the estimate being emailed is the live, unsigned estimate of a draft that has
 * been edited since - exactly what "Save changes to the estimate" does - and emails the result:
 *
 *   (h1) an unsent estimate + unsaved edits: the email carries the NEW figures, same id, same link;
 *   (h2) a sent / viewed estimate + unsaved edits: a new revision is made and the email carries the
 *        new revision's link and total; the old link is dead and the old row is untouched;
 *   (h3) a lost estimate + unsaved edits: refused with the save's reason, nothing sent, no claim left;
 *   (h4) a signed (or office-accepted) estimate: unchanged behaviour, no save;
 *   (h5) the draft is reopened but nothing changed: the saved version is emailed, never refused;
 *   (h6) the field's door behaves the same, and its answer names the estimate the email was for.
 *
 * Everything goes through the real services against the test database; the ONE stub is the mail
 * provider (sendBrandedEmail), as in tests/oneEstimateOneLink.test.ts.
 */

import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn() }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { addLine, createDraft, setDraftDetails } from "../src/services/atomicEstimateService";
import { getDraftLifecycle, getEstimateByToken, issueDraft, lostReopenReason, signEstimate } from "../src/services/issuedEstimateService";
import { sendEstimateEmail, sendEstimateEmailFromBody } from "../src/services/issuedEstimateSend";
import { sendCustomerEmailRequest } from "../src/services/customerEmail";
import { savedAndEmailedOutcome } from "../shared/draftLifecycle";

beforeEach(() => {
  emailMock.sendBrandedEmail.mockReset();
  emailMock.sendBrandedEmail.mockResolvedValue(true);
});

const MARK = "ESOS";
const ITEM_A = "ESOS001";
const ITEM_B = "ESOS002";
const ITEM_C = "ESOS003";
const ACCOUNT_EMAIL = "esos-account@example.com";

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;
const draftIds: string[] = [];

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ITEM_A), quotableAtomic(ITEM_B), quotableAtomic(ITEM_C)]);
  const customer = await prisma.customer.create({ data: { name: `${MARK} Test Account`, email: ACCOUNT_EMAIL, phone: "615-555-0161" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "2 Example Way", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({ data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" } });
  visitId = visit.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `esos-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.visitAssignment.create({ data: { visitId, technicianId } });
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
  await prisma.visitAssignment.deleteMany({ where: { visitId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ITEM_A, ITEM_B, ITEM_C]);
});

/** A draft with two quotable lines, issued once. Nothing sent. */
async function issuedOnce(title: string) {
  const draft = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(draft.id);
  await addLine(prisma, draft.id, { itemId: ITEM_A, quantity: 2, quantitySource: "COUNT" });
  await addLine(prisma, draft.id, { itemId: ITEM_B, quantity: 1, quantitySource: "COUNT" });
  const first = await issueDraft(prisma, { draftId: draft.id, accountId: customerId, serviceAddressId: propertyId, actor: "human:test" });
  if (!first.ok) throw new Error(`first issue refused: ${first.reasons.join(" ")}`);
  return { draftId: draft.id, estimateId: first.estimateId, number: first.number };
}

const snapshot = (estimateId: string) =>
  prisma.issuedEstimate.findUniqueOrThrow({
    where: { id: estimateId },
    include: { lines: { orderBy: { sortOrder: "asc" } }, events: { orderBy: { at: "asc" } }, supersededBy: true },
  });

/** Edit the draft the way the builder does: one more line. Any edit reopens the draft. */
const editDraft = (draftId: string) => addLine(prisma, draftId, { itemId: ITEM_C, quantity: 3, quantitySource: "COUNT" });

const markSent = (id: string) =>
  prisma.issuedEstimate.update({ where: { id }, data: { sentAt: new Date(), sentBy: "human:test", sentTo: ACCOUNT_EMAIL, status: "sent" } });

const eventTypes = async (estimateId: string) =>
  (await prisma.issuedEstimateEvent.findMany({ where: { estimateId }, orderBy: { at: "asc" } })).map((e) => e.type);

/** The email the provider was handed. */
const bodySent = () => (emailMock.sendBrandedEmail.mock.calls[0][0] as { bodyHtml: string }).bodyHtml;

/** The CRM door's body and the field door's body are the same; the service takes it raw, as the routes do. */
const send = (estimateId: string, sentBy = "human:crm-session") => sendEstimateEmailFromBody(prisma, estimateId, {}, sentBy);

// ─── (h1) nobody outside the office has seen it: saved in place, then emailed ────────────────

describe("(h1) an unsent estimate with unsaved edits: the email carries the NEW figures, same id and link", () => {
  it("saves in place first, then emails the saved estimate", async () => {
    const { draftId, estimateId, number } = await issuedOnce("h1-in-place");
    const before = await snapshot(estimateId);
    await editDraft(draftId);
    expect((await getDraftLifecycle(prisma, draftId)).hasUnsavedChanges).toBe(true);

    const r = await send(estimateId);

    expect(r).toMatchObject({ ok: true, to: ACCOUNT_EMAIL, estimateId, number, revision: 1, savedFirst: true, replacedInPlace: true });
    const after = await snapshot(estimateId);
    // The same row and the same customer link, with the draft's lines and total as they are now.
    expect(after.token).toBe(before.token);
    expect(after.lines.map((l) => l.itemId)).toEqual([ITEM_A, ITEM_B, ITEM_C]);
    expect(after.total).toBeGreaterThan(before.total);
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(1);
    // What the customer was emailed IS the saved estimate: its total, its link.
    expect(emailMock.sendBrandedEmail).toHaveBeenCalledTimes(1);
    expect(bodySent()).toContain(`Total $${after.total.toFixed(2)}`);
    expect(bodySent()).not.toContain(`Total $${before.total.toFixed(2)}`);
    expect(bodySent()).toContain(before.token);
    // The trail: the save ("updated", by the sender), then the send. No claim left behind.
    expect(await eventTypes(estimateId)).toEqual(["created", "updated", "sent"]);
    expect(after.events[1].actor).toBe("human:crm-session");
    expect(after.sentAt).not.toBeNull();
    // And the draft no longer has anything unsaved: the next press has nothing to save.
    expect((await getDraftLifecycle(prisma, draftId)).hasUnsavedChanges).toBe(false);
  });

  it("an email on a draft with nothing unsaved is exactly what it always was: no save, the same answer", async () => {
    const { draftId, estimateId } = await issuedOnce("h1-no-edits");
    expect((await getDraftLifecycle(prisma, draftId)).hasUnsavedChanges).toBe(false);

    const r = await send(estimateId);

    expect(r).toMatchObject({ ok: true, to: ACCOUNT_EMAIL, estimateId, revision: 1 });
    expect(r.ok && r.savedFirst).toBeUndefined();
    expect(await eventTypes(estimateId)).toEqual(["created", "sent"]);
  });

  it("the CRM's POST /customer-emails body carries the saved-first answer, and the sentence both apps print", async () => {
    const { draftId, estimateId, number } = await issuedOnce("h1-crm-door");
    await editDraft(draftId);

    const r = await sendCustomerEmailRequest(prisma, { kind: "estimate", estimateId }, "human:crm-session");

    expect(r).toEqual({
      ok: true, kind: "estimate", to: ACCOUNT_EMAIL, cc: [],
      estimateId, number, revision: 1, savedFirst: true, replacedInPlace: true,
    });
    // The words the CRM panel and the phone show.
    expect(savedAndEmailedOutcome({ number, revision: 1, replacedInPlace: true }, ACCOUNT_EMAIL))
      .toMatch(/^Saved your changes and emailed estimate .+ to esos-account@example.com\. It was updated where it was/);
    expect(savedAndEmailedOutcome({ number, revision: 3 }, ACCOUNT_EMAIL))
      .toMatch(/^Saved your changes and emailed estimate .+ \(revision 3\) to esos-account@example.com\. The customer's earlier link no longer opens/);
  });
});

// ─── (h2) somebody could have seen it: a new revision, and the email carries THAT ─────────────

describe("(h2) a sent or viewed estimate with unsaved edits: a new revision is made and emailed", () => {
  it.each([
    ["sent", (id: string) => markSent(id)],
    ["viewed by the customer", (id: string) => prisma.issuedEstimate.update({ where: { id }, data: { firstViewedAt: new Date(), status: "viewed" } })],
  ])("%s", async (_label, touch) => {
    const { draftId, estimateId, number } = await issuedOnce("h2-revision");
    await touch(estimateId);
    const before = await snapshot(estimateId);
    await editDraft(draftId);

    const r = await send(estimateId);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ savedFirst: true, number, revision: 2 });
    expect(r.replacedInPlace).toBe(false);
    expect(r.estimateId).not.toBe(estimateId);
    // The old row is exactly as it was and its link is dead.
    const old = await snapshot(estimateId);
    expect(old.total).toBe(before.total);
    expect(old.lines.map((l) => l.id)).toEqual(before.lines.map((l) => l.id));
    expect(old.supersededBy?.id).toBe(r.estimateId);
    expect((await getEstimateByToken(prisma, before.token)).ok).toBe(false);
    // The new revision: its own link, the edited lines, and it is the one that was emailed and stamped sent.
    const next = await snapshot(r.estimateId);
    expect(next.token).not.toBe(before.token);
    expect(next.lines).toHaveLength(3);
    expect(next.total).toBeGreaterThan(before.total);
    expect(next.sentAt).not.toBeNull();
    expect(emailMock.sendBrandedEmail).toHaveBeenCalledTimes(1);
    expect(bodySent()).toContain(next.token);
    expect(bodySent()).not.toContain(before.token);
    expect(bodySent()).toContain(`Total $${next.total.toFixed(2)}`);
    expect(bodySent()).toContain("revision 2");
    expect(await eventTypes(r.estimateId)).toEqual(["created", "sent"]);
    // The old row was NOT stamped sent a second time and carries no claim.
    expect(await eventTypes(estimateId)).not.toContain("send_started");
  });

  it("a send that fails AFTER the save says the save happened, and names the estimate it left", async () => {
    const { draftId, estimateId, number } = await issuedOnce("h2-provider-fails");
    await markSent(estimateId);
    await editDraft(draftId);
    emailMock.sendBrandedEmail.mockResolvedValue(false);

    const r = await send(estimateId);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.saved).toMatchObject({ number, revision: 2, replacedInPlace: false });
    expect(r.saved?.estimateId).not.toBe(estimateId);
    expect(r.reason).toContain(`Your changes were saved to estimate ${number} (revision 2), but the email was not sent:`);
    // The draft has been saved: nothing is left unsaved for the next press.
    expect((await getDraftLifecycle(prisma, draftId)).hasUnsavedChanges).toBe(false);
  });
});

// ─── (h3) a refused save refuses the email ───────────────────────────────────────────────────

describe("(h3) a save the office would be refused refuses the email: nothing sent, nothing saved, no claim left", () => {
  it("a LOST estimate with unsaved edits", async () => {
    const { draftId, estimateId, number } = await issuedOnce("h3-lost");
    await prisma.issuedEstimate.update({ where: { id: estimateId }, data: { status: "lost", lostAt: new Date(), lostReason: "price", sentAt: new Date(), sentTo: ACCOUNT_EMAIL } });
    const before = await snapshot(estimateId);
    await editDraft(draftId);

    const r = await send(estimateId);

    // The SAVE's reason, in its own words - the same sentence "Save changes to the estimate" is refused with.
    expect(r).toEqual({ ok: false, reason: lostReopenReason(number) });
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
    const after = await snapshot(estimateId);
    expect(after.total).toBe(before.total);
    expect(after.lines.map((l) => l.id)).toEqual(before.lines.map((l) => l.id));
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(1);
    expect(after.events.map((e) => e.type)).toEqual(before.events.map((e) => e.type));
    expect(await eventTypes(estimateId)).not.toContain("send_started");
  });

  it("an address the email cannot go to: refused BEFORE anything is saved, so the customer's link is not replaced for nothing", async () => {
    const { draftId, estimateId } = await issuedOnce("h3-bad-address");
    await markSent(estimateId);
    await editDraft(draftId);

    const r = await sendEstimateEmail(prisma, estimateId, { sentBy: "human:test", toOverride: "not-an-address" });

    expect(r.ok).toBe(false);
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(1);
    expect((await getDraftLifecycle(prisma, draftId)).hasUnsavedChanges).toBe(true);
  });

  it("an ARCHIVED estimate is refused as it always was, with nothing saved", async () => {
    const { draftId, estimateId } = await issuedOnce("h3-archived");
    await prisma.issuedEstimate.update({ where: { id: estimateId }, data: { archivedAt: new Date(), archivedReason: "another option was chosen" } });
    await editDraft(draftId);

    const r = await send(estimateId);

    expect(r).toEqual({ ok: false, reason: "This estimate is archived. Unarchive it first, then send it again." });
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(1);
  });

  it("an OLDER revision (superseded) is refused as it always was: only the live estimate of its draft is ever saved from", async () => {
    const { draftId, estimateId } = await issuedOnce("h3-older-revision");
    await markSent(estimateId);
    await editDraft(draftId);
    const first = await send(estimateId); // saves + emails rev 2; rev 1 is now superseded
    expect(first.ok && first.revision).toBe(2);
    emailMock.sendBrandedEmail.mockClear();
    await editDraft(draftId);

    const stale = await send(estimateId);

    expect(stale).toEqual({ ok: false, reason: "This estimate has been superseded by a newer revision. Send that one instead." });
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(2);
  });
});

// ─── (h4) never on a signed or accepted estimate ─────────────────────────────────────────────

describe("(h4) a signed or office-accepted estimate is never saved by an email", () => {
  it("signed by the customer: refused as before, and the draft's unsaved details are NOT saved", async () => {
    const { draftId, estimateId } = await issuedOnce("h4-signed");
    const { token } = await snapshot(estimateId);
    expect((await signEstimate(prisma, token, { signerName: "Test Signer", signatureImage: TEST_SIGNATURE })).ok).toBe(true);
    // A signed draft's lines are shut, but its title, scope and discount stay editable (signedStaysEditable) -
    // so it CAN be reopened with unsaved changes. setDraftDetails alone does not reopen it, so the reopen is stated.
    await setDraftDetails(prisma, draftId, { jobDescription: "A different scope of work than the customer signed." });
    await prisma.priceBookDraftEstimate.update({ where: { id: draftId }, data: { status: "draft" } });
    expect((await getDraftLifecycle(prisma, draftId)).hasUnsavedChanges).toBe(true);
    const before = await snapshot(estimateId);

    const r = await send(estimateId);

    expect(r).toEqual({ ok: false, reason: "This estimate is already signed." });
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(1);
    const after = await snapshot(estimateId);
    expect(after.scopeText).toBe(before.scopeText);
    expect(after.events.map((e) => e.type)).toEqual(before.events.map((e) => e.type));
  });

  it("accepted by the office on the customer's word: the same", async () => {
    const { draftId, estimateId } = await issuedOnce("h4-accepted");
    await prisma.issuedEstimate.update({ where: { id: estimateId }, data: { signedAt: new Date(), signerName: "Test Signer", signedChannel: "office", acceptedVia: "phone", status: "signed" } });
    await setDraftDetails(prisma, draftId, { jobDescription: "A different scope of work than the customer accepted." });
    await prisma.priceBookDraftEstimate.update({ where: { id: draftId }, data: { status: "draft" } });
    expect((await getDraftLifecycle(prisma, draftId)).hasUnsavedChanges).toBe(true);

    const r = await send(estimateId);

    expect(r.ok).toBe(false);
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(1);
    expect(await eventTypes(estimateId)).toEqual(["created"]);
  });
});

// ─── (h5) "nothing changed" is not a refusal ─────────────────────────────────────────────────

describe("(h5) the draft is reopened but nothing changed: the saved version is emailed, never refused", () => {
  /** An edit that was undone leaves the draft reopened (status "draft") with the same lines. */
  const reopenWithoutChange = (draftId: string) => prisma.priceBookDraftEstimate.update({ where: { id: draftId }, data: { status: "draft" } });

  it("an unsent estimate", async () => {
    const { draftId, estimateId } = await issuedOnce("h5-unsent");
    const before = await snapshot(estimateId);
    await reopenWithoutChange(draftId);
    expect((await getDraftLifecycle(prisma, draftId)).hasUnsavedChanges).toBe(true);

    const r = await send(estimateId);

    expect(r).toMatchObject({ ok: true, to: ACCOUNT_EMAIL, estimateId, savedFirst: true, replacedInPlace: true });
    const after = await snapshot(estimateId);
    expect(after.total).toBe(before.total);
    expect(after.token).toBe(before.token);
    expect(bodySent()).toContain(`Total $${before.total.toFixed(2)}`);
  });

  it("a sent estimate: still emailed, with the same figures", async () => {
    const { draftId, estimateId } = await issuedOnce("h5-sent");
    await markSent(estimateId);
    const before = await snapshot(estimateId);
    await reopenWithoutChange(draftId);

    const r = await send(estimateId);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(emailMock.sendBrandedEmail).toHaveBeenCalledTimes(1);
    expect((await snapshot(r.estimateId)).total).toBe(before.total);
    expect(bodySent()).toContain(`Total $${before.total.toFixed(2)}`);
  });
});

// ─── (h6) the field's door ───────────────────────────────────────────────────────────────────

describe("(h6) the field's email route does the same, and says which estimate the email was for", () => {
  const tech = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);

  async function issuedThroughThePhone(title: string) {
    const draft = await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} ${title}`, supplierId: "HD", visitId } });
    draftIds.push(draft.id);
    const addC = async (itemId: string, quantity: number) => {
      const res = await tech(request(app).post(`/health-record/quotes/${draft.id}/lines`)).send({ itemId, quantity, quantitySource: "COUNT" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    };
    await addC(ITEM_A, 1);
    const issued = await tech(request(app).post(`/health-record/quotes/${draft.id}/issue`)).send({});
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    return { draftId: draft.id, estimateId: issued.body.data.estimateId as string, addC };
  }

  it("an unsent estimate edited on the phone and emailed without saving: saved in place, and the answer names it", async () => {
    const { draftId, estimateId, addC } = await issuedThroughThePhone("h6-in-place");
    const before = await snapshot(estimateId);
    await addC(ITEM_C, 2);

    const res = await tech(request(app).post(`/health-record/issued-estimates/${estimateId}/email`)).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ to: ACCOUNT_EMAIL, estimateId, number: before.number, revision: 1, savedFirst: true, replacedInPlace: true });
    // Never the token, on this wire.
    expect(JSON.stringify(res.body)).not.toContain(before.token);
    const after = await snapshot(estimateId);
    expect(after.total).toBeGreaterThan(before.total);
    expect(bodySent()).toContain(`Total $${after.total.toFixed(2)}`);
    // The save is recorded as the TECHNICIAN's, like the email.
    expect(after.events.find((e) => e.type === "updated")?.actor).toBe(`tech:${technicianId}`);
    expect(after.sentBy).toBe(`tech:${technicianId}`);
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(1);
  });

  it("a sent estimate edited and emailed without saving: a new revision, and the answer points the phone at it", async () => {
    const { draftId, estimateId, addC } = await issuedThroughThePhone("h6-revision");
    await markSent(estimateId);
    const before = await snapshot(estimateId);
    await addC(ITEM_C, 2);

    const res = await tech(request(app).post(`/health-record/issued-estimates/${estimateId}/email`)).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ to: ACCOUNT_EMAIL, number: before.number, revision: 2, savedFirst: true, replacedInPlace: false });
    expect(res.body.data.estimateId).not.toBe(estimateId);
    expect(JSON.stringify(res.body)).not.toContain(before.token);
    const next = await snapshot(res.body.data.estimateId);
    expect(bodySent()).toContain(next.token);
    expect((await getEstimateByToken(prisma, before.token)).ok).toBe(false);
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(2);
  });

  it("an email with nothing unsaved answers exactly { to } - the contract it always had", async () => {
    const { estimateId } = await issuedThroughThePhone("h6-plain");

    const res = await tech(request(app).post(`/health-record/issued-estimates/${estimateId}/email`)).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ to: ACCOUNT_EMAIL });
  });

  it("a lost estimate with unsaved edits is refused with the save's reason, in the phone's 409 shape", async () => {
    const { estimateId, addC } = await issuedThroughThePhone("h6-lost");
    const before = await snapshot(estimateId);
    await prisma.issuedEstimate.update({ where: { id: estimateId }, data: { status: "lost", lostAt: new Date(), lostReason: "price", sentAt: new Date(), sentTo: ACCOUNT_EMAIL } });
    await addC(ITEM_C, 1).catch(() => undefined);

    const res = await tech(request(app).post(`/health-record/issued-estimates/${estimateId}/email`)).send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("not_sent");
    expect(res.body.error.message).toMatch(/lost|Reopen/i);
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
    expect((await snapshot(estimateId)).total).toBe(before.total);
  });
});

// ─── (i) review fixes: the races and the pre-save refusals ───────────────────────────────────

/**
 * Hold the estimate's row lock until the save has built its fresh row (graduateDraft has run, the
 * lock has not been taken yet), run `whileHeld` inside that lock, then release. The save read the
 * estimate as unsigned / unseen BEFORE any of this; only the re-check under the lock can catch it.
 * (The same technique as tests/oneEstimateOneLink.test.ts (c).)
 */
function holdLockUntilFreshRow(draftId: string, estimateId: string, whileHeld: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<void>) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "IssuedEstimate" WHERE "id" = ${estimateId} FOR UPDATE`;
    for (let i = 0; i < 400; i++) {
      if (await prisma.issuedEstimate.count({ where: { draftId, id: { not: estimateId } } })) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await whileHeld(tx);
  }, { timeout: 30_000 });
}

describe("(i1) a signature or an office acceptance that lands while the save is being built is never superseded", () => {
  it.each([
    ["the customer signs", { signedAt: new Date(), status: "signed" }],
    ["the office records an acceptance", { signedAt: new Date(), status: "signed", acceptedVia: "phone" }],
  ])("%s mid-save: the email is refused, the signed row stands, no unsigned revision is left, nothing is sent", async (_label, signedNow) => {
    const { draftId, estimateId } = await issuedOnce("i1-signed-mid-save");
    await markSent(estimateId);
    await editDraft(draftId);

    const landing = holdLockUntilFreshRow(draftId, estimateId, async (tx) => {
      await tx.issuedEstimate.update({ where: { id: estimateId }, data: signedNow });
    });
    const sending = send(estimateId);
    await landing;
    const r = await sending;

    expect(r).toEqual({ ok: false, reason: expect.stringContaining("signed or accepted while your changes were being saved") });
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
    const after = await snapshot(estimateId);
    expect(after.supersededBy).toBeNull();
    expect(after.signedAt).not.toBeNull();
    // The half-built revision was rolled back; no claim was left behind.
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(1);
    expect(await eventTypes(estimateId)).not.toContain("send_started");
  });
});

describe("(i2) two emails of the same estimate at once: neither kills the other's link", () => {
  it("another request saved and claimed it between this one's look and its save: this one sends what it finds", async () => {
    const { draftId, estimateId } = await issuedOnce("i2-other-request-first");
    const before = await snapshot(estimateId);
    await editDraft(draftId);

    // The other request: it saved the estimate in place and wrote its send claim under the lock,
    // after this request looked (it saw the draft unsaved) and before this request's save got the lock.
    const other = holdLockUntilFreshRow(draftId, estimateId, async (tx) => {
      await tx.issuedEstimateEvent.create({ data: { estimateId, type: "updated", actor: "tech:other", detail: "saved in place" } });
      await tx.issuedEstimateEvent.create({ data: { estimateId, type: "send_started", actor: "tech:other", detail: "email started" } });
    });
    const r = await send(estimateId);
    await other;

    expect(r).toMatchObject({ ok: true, estimateId, revision: 1 });
    expect(r.ok && r.savedFirst).toBeUndefined();
    // The estimate was NOT superseded by this request, and what went out carries the estimate's own link.
    const after = await snapshot(estimateId);
    expect(after.supersededBy).toBeNull();
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(1);
    expect(emailMock.sendBrandedEmail).toHaveBeenCalledTimes(1);
    expect(bodySent()).toContain(before.token);
  });

  it("really at the same time: nothing is superseded, every email that goes carries the one link, and no request errors", async () => {
    const { draftId, estimateId } = await issuedOnce("i2-real-race");
    const before = await snapshot(estimateId);
    await editDraft(draftId);

    const [a, b] = await Promise.all([send(estimateId), send(estimateId, "tech:other")]);

    // Whichever got there first saved it in place and emailed it. The other either found it already
    // saved and sent it as it stood, or - if both were building the save at the same instant - was
    // told plainly to try again. Neither is an error, and neither killed the other's link.
    expect([a, b].filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    for (const r of [a, b]) {
      if (!r.ok) expect(r.reason).toContain("being saved or sent by someone else right now");
    }
    const after = await snapshot(estimateId);
    expect(after.supersededBy).toBeNull();
    expect(after.token).toBe(before.token);
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(1);
    expect(emailMock.sendBrandedEmail.mock.calls.length).toBe([a, b].filter((r) => r.ok).length);
    for (const call of emailMock.sendBrandedEmail.mock.calls) {
      expect((call[0] as { bodyHtml: string }).bodyHtml).toContain(before.token);
      expect((call[0] as { bodyHtml: string }).bodyHtml).toContain(`Total $${after.total.toFixed(2)}`);
    }
  });
});

describe("(i3) a report that cannot be attached is refused BEFORE the save, so the customer's link is not replaced for nothing", () => {
  it("the Health Record ticked on an address with no assessment", async () => {
    const { draftId, estimateId } = await issuedOnce("i3-no-assessment");
    await markSent(estimateId);
    const before = await snapshot(estimateId);
    await editDraft(draftId);

    const r = await sendEstimateEmail(prisma, estimateId, { sentBy: "human:test", attachHealthReport: true });

    expect(r).toEqual({ ok: false, reason: "No electrical assessment is on file for this address — the report attachments can't be produced." });
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
    // No revision, the link the customer holds still opens, no claim, the draft is still unsaved.
    expect(await prisma.issuedEstimate.count({ where: { draftId } })).toBe(1);
    expect((await getEstimateByToken(prisma, before.token)).ok).toBe(true);
    expect(await eventTypes(estimateId)).not.toContain("send_started");
    expect((await getDraftLifecycle(prisma, draftId)).hasUnsavedChanges).toBe(true);
  });
});
