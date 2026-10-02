/**
 * The draft-photo migration (plan A4, Kyle 2026-10-02: "The photos in production will have to
 * migrate to their estimate visits.").
 *
 * These are photographs that cannot be retaken, so the guarantees pinned here are the ones that
 * matter more than the happy path:
 *
 *   1. A photo whose draft names a visit moves onto that visit — bytes, caption and date intact.
 *   2. A photo whose draft has no visit but whose issued estimate (even a VOIDED one) carries a
 *      job moves onto that job. The estimate's fate is irrelevant; the consultation is the anchor.
 *   3. A photo that cannot be placed STAYS WHERE IT IS and is reported with a reason:
 *        - no visit and no issued estimate;
 *        - an estimate whose visitId names a visit that no longer exists;
 *        - a draft whose visit belongs to a DIFFERENT customer (filing it there would make it
 *          emailable by that customer — a leak, not a migration).
 *   4. NOTHING IS DELETED, resolved or not. Every DraftPhoto row is still there afterwards.
 *   5. The dry run decides everything and writes nothing.
 *   6. A second run changes nothing: already-moved photos are counted, not duplicated.
 *
 * Asserts on its own ids only — the migration walks every DraftPhoto row in the database and
 * other files' fixtures may be present.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { migrateDraftPhotos, resolveDraftVisit } from "../src/services/draftPhotoMigration";

const MARK = "DPMG";
const GOOD = "DPMG001";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let ownerId: string;
let otherId: string;
let p1Id: string;
let p3Id: string;
let v1Id: string; // owner's consultation — draft A was created from it
let v2Id: string; // owner's job — estimate B's jobVisitId
let v3Id: string; // the OTHER customer's visit
const draftIds: string[] = [];
const estimateIds: string[] = [];

let photoA: string; // draft A (visitId v1)                      -> v1 via draft.visitId
let photoB: string; // draft B, voided estimate with jobVisitId v2 -> v2 via estimate.jobVisitId
let photoC: string; // draft C, no visit, no estimate              -> stays
let photoD: string; // draft D, estimate.visitId dangling          -> stays
let photoE: string; // draft E, visit on another customer          -> stays
let photoCreatedAt: Date;

const mine = () => [photoA, photoB, photoC, photoD, photoE];

async function draftPhoto(draftId: string, note: string) {
  const row = await prisma.draftPhoto.create({
    data: { draftId, mime: "image/png", bytes: TINY_PNG, size: TINY_PNG.length, note },
  });
  return row;
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(GOOD)]);

  ownerId = (await prisma.customer.create({ data: { name: `${MARK} Owner`, email: "dpmg-owner@example.com", phone: "615-555-0181" } })).id;
  otherId = (await prisma.customer.create({ data: { name: `${MARK} Other`, email: "dpmg-other@example.com", phone: "615-555-0182" } })).id;
  p1Id = (await prisma.property.create({ data: { customerId: ownerId, name: `${MARK} House`, addressLine1: "1 DPMG Way", city: "Smyrna", state: "TN", postalCode: "37167" } })).id;
  p3Id = (await prisma.property.create({ data: { customerId: otherId, name: `${MARK} Other House`, addressLine1: "3 DPMG Way", city: "Smyrna", state: "TN", postalCode: "37167" } })).id;

  // Status "scheduled", not "estimate": graduation auto-links a draft with no visit to an OPEN
  // estimate-stage visit at the address, and these fixtures need estimates B and D to come out
  // with visitId null so the jobVisitId / dangling-id rules are the ones being exercised.
  v1Id = (await prisma.visit.create({ data: { customerId: ownerId, propertyId: p1Id, mode: "onsite", purpose: `${MARK} consultation`, status: "scheduled" } })).id;
  v2Id = (await prisma.visit.create({ data: { customerId: ownerId, propertyId: p1Id, mode: "onsite", purpose: `${MARK} sold job`, status: "scheduled" } })).id;
  v3Id = (await prisma.visit.create({ data: { customerId: otherId, propertyId: p3Id, mode: "onsite", purpose: `${MARK} other customer`, status: "scheduled" } })).id;

  // A — created from the consultation.
  const a = await createDraft(prisma, { title: `${MARK} A`, supplierId: "HD", visitId: v1Id });
  draftIds.push(a.id);
  const pa = await draftPhoto(a.id, "Panel before");
  photoA = pa.id;
  photoCreatedAt = pa.createdAt;

  // B — no visit; issued, then VOIDED, with the signed job on jobVisitId.
  const b = await createDraft(prisma, { title: `${MARK} B`, supplierId: "HD", customerId: ownerId });
  draftIds.push(b.id);
  await addLine(prisma, b.id, { itemId: GOOD, quantity: 1, quantitySource: "COUNT" });
  const gb = await graduateDraft(prisma, { draftId: b.id, accountId: ownerId, serviceAddressId: p1Id });
  if (!gb.ok) throw new Error(`fixture B failed to graduate: ${JSON.stringify(gb)}`);
  estimateIds.push(gb.estimateId);
  await prisma.issuedEstimate.update({
    where: { id: gb.estimateId },
    data: { visitId: null, jobVisitId: v2Id, status: "void", voidedAt: new Date(), voidReason: `${MARK} fixture` },
  });
  photoB = (await draftPhoto(b.id, "Meter base")).id;

  // C — nothing to hang it on.
  const c = await createDraft(prisma, { title: `${MARK} C`, supplierId: "HD" });
  draftIds.push(c.id);
  photoC = (await draftPhoto(c.id, "Orphan")).id;

  // D — issued, but the estimate's visitId (a plain column) names a visit that is gone.
  const d = await createDraft(prisma, { title: `${MARK} D`, supplierId: "HD", customerId: ownerId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: GOOD, quantity: 1, quantitySource: "COUNT" });
  const gd = await graduateDraft(prisma, { draftId: d.id, accountId: ownerId, serviceAddressId: p1Id });
  if (!gd.ok) throw new Error(`fixture D failed to graduate: ${JSON.stringify(gd)}`);
  estimateIds.push(gd.estimateId);
  await prisma.issuedEstimate.update({
    where: { id: gd.estimateId },
    data: { visitId: `${MARK}-visit-that-was-deleted`, jobVisitId: null },
  });
  photoD = (await draftPhoto(d.id, "Dangling")).id;

  // E — the draft says customer OWNER but points at the OTHER customer's visit.
  const e = await createDraft(prisma, { title: `${MARK} E`, supplierId: "HD", customerId: ownerId, visitId: v3Id });
  draftIds.push(e.id);
  photoE = (await draftPhoto(e.id, "Wrong customer")).id;
});

afterAll(async () => {
  await prisma.visitPhoto.deleteMany({ where: { id: { in: mine() } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estimateIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estimateIds } } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estimateIds } } });
  await prisma.draftPhoto.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visit.deleteMany({ where: { id: { in: [v1Id, v2Id, v3Id] } } });
  await prisma.property.deleteMany({ where: { id: { in: [p1Id, p3Id] } } });
  await prisma.customer.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
  await deleteAtomics([GOOD]);
});

describe("draft photos migrate onto their jobs", () => {
  it("states a rule for every awkward case", async () => {
    expect(await resolveDraftVisit(prisma, draftIds[0])).toMatchObject({ ok: true, visitId: v1Id, source: "draft.visitId" });
    // A voided estimate still names the job — the estimate's fate is irrelevant to the photo.
    expect(await resolveDraftVisit(prisma, draftIds[1])).toMatchObject({ ok: true, visitId: v2Id, source: "estimate.jobVisitId" });
    expect(await resolveDraftVisit(prisma, draftIds[2])).toMatchObject({ ok: false, reason: "draft has no visit and no issued estimate" });
    const d = await resolveDraftVisit(prisma, draftIds[3]);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("no longer exists");
    const e = await resolveDraftVisit(prisma, draftIds[4]);
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.reason).toContain(`on customer ${otherId}, not ${ownerId}`);
  });

  it("dry run: decides everything, writes nothing", async () => {
    const report = await migrateDraftPhotos(prisma, { apply: false });
    expect(report.apply).toBe(false);
    expect(report.migrated.map((p) => p.id).filter((id) => mine().includes(id)).sort()).toEqual([photoA, photoB].sort());
    expect(report.unresolved.map((p) => p.id).filter((id) => mine().includes(id)).sort()).toEqual([photoC, photoD, photoE].sort());
    expect(report.alreadyDone.filter((p) => mine().includes(p.id))).toEqual([]);
    expect(report.failed.filter((p) => mine().includes(p.id))).toEqual([]);

    expect(await prisma.visitPhoto.count({ where: { id: { in: mine() } } })).toBe(0);
    expect(await prisma.draftPhoto.count({ where: { id: { in: mine() } } })).toBe(5);
  });

  it("apply: resolvable photos land on their job with bytes, caption and date intact", async () => {
    const report = await migrateDraftPhotos(prisma, { apply: true });
    expect(report.migrated.map((p) => p.id).filter((id) => mine().includes(id)).sort()).toEqual([photoA, photoB].sort());
    expect(report.failed.filter((p) => mine().includes(p.id))).toEqual([]);

    const a = await prisma.visitPhoto.findUnique({ where: { id: photoA } });
    expect(a).not.toBeNull();
    expect(a!.visitId).toBe(v1Id);
    expect(Buffer.from(a!.data).equals(TINY_PNG)).toBe(true);
    expect(a!.mimeType).toBe("image/png");
    expect(a!.sizeBytes).toBe(TINY_PNG.length);
    expect(a!.caption).toBe("Panel before");
    expect(a!.tag).toBeNull();
    expect(a!.technicianId).toBeNull();
    expect(a!.uploadedAt.getTime()).toBe(photoCreatedAt.getTime());

    const b = await prisma.visitPhoto.findUnique({ where: { id: photoB } });
    expect(b?.visitId).toBe(v2Id);
    expect(b?.caption).toBe("Meter base");
  });

  it("an unresolvable photo STAYS WHERE IT IS, and is reported with its reason", async () => {
    const report = await migrateDraftPhotos(prisma, { apply: true });
    const unresolved = report.unresolved.filter((p) => mine().includes(p.id));
    expect(unresolved.map((p) => p.id).sort()).toEqual([photoC, photoD, photoE].sort());
    for (const p of unresolved) {
      expect(p.draftTitle).toContain(MARK);
      expect(p.reason.length).toBeGreaterThan(0);
    }
    // Still in the DraftPhoto table, bytes and all; never written to VisitPhoto.
    for (const id of [photoC, photoD, photoE]) {
      const row = await prisma.draftPhoto.findUnique({ where: { id } });
      expect(row, `DraftPhoto ${id} must still exist`).not.toBeNull();
      expect(Buffer.from(row!.bytes).equals(TINY_PNG)).toBe(true);
      expect(await prisma.visitPhoto.findUnique({ where: { id } })).toBeNull();
    }
  });

  it("deletes nothing — the migrated rows are still in DraftPhoto too", async () => {
    expect(await prisma.draftPhoto.count({ where: { id: { in: mine() } } })).toBe(5);
  });

  it("a second run duplicates nothing: migrated photos count as already done", async () => {
    const before = await prisma.visitPhoto.count({ where: { id: { in: mine() } } });
    expect(before).toBe(2);

    const report = await migrateDraftPhotos(prisma, { apply: true });
    expect(report.migrated.filter((p) => mine().includes(p.id))).toEqual([]);
    expect(report.alreadyDone.map((p) => p.id).filter((id) => mine().includes(id)).sort()).toEqual([photoA, photoB].sort());
    expect(report.unresolved.map((p) => p.id).filter((id) => mine().includes(id)).sort()).toEqual([photoC, photoD, photoE].sort());

    expect(await prisma.visitPhoto.count({ where: { id: { in: mine() } } })).toBe(2);
    expect(await prisma.visitPhoto.count({ where: { visitId: { in: [v1Id, v2Id] } } })).toBe(2);
    expect(await prisma.draftPhoto.count({ where: { id: { in: mine() } } })).toBe(5);
  });
});
