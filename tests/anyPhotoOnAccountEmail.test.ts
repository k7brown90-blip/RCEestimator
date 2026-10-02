/**
 * Item J (2026-10-01): "ANY photo on the account can be emailed."
 *
 * Kyle: "Having the photos linked to the job is necessary but that should not eleminate them
 * from being selected because building an estimate will often come from what is found on the
 * job and sending the photos as evidence is our standard."
 *
 * Before this, `photoAttachments` (issuedEstimateSend.ts) only accepted a `VisitPhoto` taken at
 * THIS estimate's own `serviceAddressId`. This pins the replacement rule — "this photo belongs
 * to THIS CUSTOMER", not "this photo is at this one address" — and, just as importantly, that
 * the widening did NOT become "any id at all":
 *
 *   1. A visit photo at a DIFFERENT property on the SAME account attaches.
 *   2. A photo added while BUILDING the estimate attaches — it is a `VisitPhoto` on the
 *      consultation job the estimate came from (plan A, Kyle 2026-10-02: "Draft photos don't
 *      make sense to me"), so it is covered by the one rule, not by a second store.
 *   3. A visit photo belonging to ANOTHER customer is refused.
 *   4. An id from the RETIRED `DraftPhoto` store is refused, even when it sits on this very
 *      estimate's own draft — nothing reads that table on a send any more.
 *   5. The 10-photo cap still holds.
 *   6. End to end through `sendEstimateEmail`: a mixed batch of valid, cross-customer and
 *      retired-store ids sends successfully and attaches only the valid ones.
 *
 * On (4): the `DraftPhoto` MODEL still exists while production's rows are migrated
 * (scripts/migrateDraftPhotosToVisits.ts). When the table is finally dropped, the fixture row
 * for (4) goes with it and the case becomes "a never-real id is refused", which (5) already
 * covers.
 *
 * Builds its own price-book fixture rather than depending on an imported catalog (Kyle's
 * 2026-09-15 ruling — see tests/helpers/priceBookFixture.ts).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { photoAttachments, sendEstimateEmail } from "../src/services/issuedEstimateSend";

const MARK = "PJPH";
const GOOD = "PJPH001";

// A valid 1x1 PNG — sharp must actually be able to decode it for the "attaches" assertions to
// mean anything (a corrupt image is silently refused too, which would hide a real guard bug).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let ownerCustomerId: string;
let otherCustomerId: string;
let p1Id: string;
let p2Id: string;
let p3Id: string;
let v1Id: string;
let v2Id: string;
let v3Id: string;
let draftId: string;
let otherDraftId: string;
let estimateId: string;

/** VisitPhoto at a DIFFERENT property, same account as the estimate. */
let photoSameAccountOtherProperty: string;
/** VisitPhoto belonging to a completely different customer. */
let photoOtherCustomer: string;
/** VisitPhoto on the consultation visit THIS estimate was issued from — what "a photo added
 * while building the estimate" IS now. */
let photoOnEstimateVisit: string;
/** A row in the RETIRED DraftPhoto store, on this estimate's own draft. Must be refused. */
let retiredDraftPhotoId: string;

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(GOOD)]);

  const owner = await prisma.customer.create({
    data: { name: `${MARK} Owner`, email: "pjph-owner@example.com", phone: "615-555-0171" },
  });
  ownerCustomerId = owner.id;
  const other = await prisma.customer.create({
    data: { name: `${MARK} Other`, email: "pjph-other@example.com", phone: "615-555-0172" },
  });
  otherCustomerId = other.id;

  const p1 = await prisma.property.create({
    data: { customerId: ownerCustomerId, name: `${MARK} House 1`, addressLine1: "1 PJPH Way", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  p1Id = p1.id;
  const p2 = await prisma.property.create({
    data: { customerId: ownerCustomerId, name: `${MARK} House 2`, addressLine1: "2 PJPH Way", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  p2Id = p2.id;
  const p3 = await prisma.property.create({
    data: { customerId: otherCustomerId, name: `${MARK} House 3`, addressLine1: "3 PJPH Way", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  p3Id = p3.id;

  const v1 = await prisma.visit.create({ data: { customerId: ownerCustomerId, propertyId: p1Id, mode: "onsite", purpose: `${MARK} job 1`, status: "scheduled" } });
  v1Id = v1.id;
  const v2 = await prisma.visit.create({ data: { customerId: ownerCustomerId, propertyId: p2Id, mode: "onsite", purpose: `${MARK} job 2`, status: "scheduled" } });
  v2Id = v2.id;
  const v3 = await prisma.visit.create({ data: { customerId: otherCustomerId, propertyId: p3Id, mode: "onsite", purpose: `${MARK} job 3`, status: "scheduled" } });
  v3Id = v3.id;

  // The id is client-generated on VisitPhoto (idempotency key) — mint one ourselves.
  photoSameAccountOtherProperty = crypto.randomUUID();
  await prisma.visitPhoto.create({
    data: { id: photoSameAccountOtherProperty, visitId: v2Id, mimeType: "image/png", sizeBytes: TINY_PNG.length, data: TINY_PNG, caption: "House 2 panel" },
  });

  photoOtherCustomer = crypto.randomUUID();
  await prisma.visitPhoto.create({
    data: { id: photoOtherCustomer, visitId: v3Id, mimeType: "image/png", sizeBytes: TINY_PNG.length, data: TINY_PNG, caption: "Someone else's panel" },
  });

  // The draft that becomes the owner's estimate, created from the consultation visit v1. The
  // photo added while building it is a VisitPhoto ON THAT VISIT (plan A) — same table, same
  // rule as every other job photo.
  const draft = await createDraft(prisma, { title: `${MARK} draft`, supplierId: "HD", visitId: v1Id });
  draftId = draft.id;
  await addLine(prisma, draftId, { itemId: GOOD, quantity: 1, quantitySource: "COUNT" });
  photoOnEstimateVisit = crypto.randomUUID();
  await prisma.visitPhoto.create({
    data: { id: photoOnEstimateVisit, visitId: v1Id, mimeType: "image/png", sizeBytes: TINY_PNG.length, data: TINY_PNG, caption: "Walkthrough shot" },
  });

  // A row in the RETIRED store, on this estimate's OWN draft — the one id the old second branch
  // would have accepted. Written straight to the table: no route writes it any more.
  const retired = await prisma.draftPhoto.create({
    data: { draftId, mime: "image/png", bytes: TINY_PNG, size: TINY_PNG.length, note: "Retired store" },
  });
  retiredDraftPhotoId = retired.id;

  // A SEPARATE draft — a different customer's own pricing work. Never linked to the owner's
  // estimate in any way; exists so the cleanup below mirrors a realistic account.
  const otherDraft = await createDraft(prisma, { title: `${MARK} other draft`, supplierId: "HD", visitId: v3Id });
  otherDraftId = otherDraft.id;

  const result = await graduateDraft(prisma, { draftId, accountId: ownerCustomerId, serviceAddressId: p1Id });
  if (!result.ok) throw new Error(`fixture estimate failed to graduate: ${JSON.stringify(result)}`);
  estimateId = result.estimateId;
});

afterAll(async () => {
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId } });
  await prisma.issuedEstimate.updateMany({ where: { id: estimateId }, data: { supersedesId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: estimateId } });
  await prisma.draftPhoto.deleteMany({ where: { draftId: { in: [draftId, otherDraftId] } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: [draftId, otherDraftId] } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: [draftId, otherDraftId] } } });
  await prisma.visitPhoto.deleteMany({ where: { id: { in: [photoSameAccountOtherProperty, photoOtherCustomer, photoOnEstimateVisit] } } });
  await prisma.visit.deleteMany({ where: { id: { in: [v1Id, v2Id, v3Id] } } });
  await prisma.property.deleteMany({ where: { id: { in: [p1Id, p2Id, p3Id] } } });
  await prisma.customer.deleteMany({ where: { id: { in: [ownerCustomerId, otherCustomerId] } } });
  await deleteAtomics([GOOD]);
});

describe("photoAttachments — the ownership guard (item J)", () => {
  it("attaches a visit photo from a DIFFERENT property on the SAME account", async () => {
    const { attachments, refused } = await photoAttachments(
      prisma,
      [photoSameAccountOtherProperty],
      { customerId: ownerCustomerId },
    );
    expect(refused).toEqual([]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].contentType).toBe("image/jpeg");
  });

  it("attaches a photo added while building the estimate — a VisitPhoto on its consultation job", async () => {
    const { attachments, refused } = await photoAttachments(
      prisma,
      [photoOnEstimateVisit],
      { customerId: ownerCustomerId },
    );
    expect(refused).toEqual([]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toContain("Walkthrough-shot");
  });

  it("REFUSES a visit photo belonging to ANOTHER customer", async () => {
    const { attachments, refused } = await photoAttachments(
      prisma,
      [photoOtherCustomer],
      { customerId: ownerCustomerId },
    );
    expect(attachments).toEqual([]);
    expect(refused).toEqual([photoOtherCustomer]);
  });

  it("REFUSES an id from the retired DraftPhoto store, even on this estimate's own draft", async () => {
    const { attachments, refused } = await photoAttachments(
      prisma,
      [retiredDraftPhotoId],
      { customerId: ownerCustomerId },
    );
    expect(attachments).toEqual([]);
    expect(refused).toEqual([retiredDraftPhotoId]);
  });

  it("holds the 10-photo cap even when more ids are offered", async () => {
    const manyIds = Array.from({ length: 15 }, (_, i) => `not-a-real-id-${i}`);
    const { attachments, refused } = await photoAttachments(
      prisma,
      manyIds,
      { customerId: ownerCustomerId },
    );
    expect(attachments).toEqual([]);
    // Truncated to MAX_EMAIL_PHOTOS BEFORE the lookup — 15 offered, only 10 considered at all.
    expect(refused).toHaveLength(10);
    expect(refused).toEqual(manyIds.slice(0, 10));
  });

  it("end to end: sendEstimateEmail attaches only the valid ids out of a mixed batch", async () => {
    const mod = await import("../src/services/confirmationEmail");
    const spy = vi.spyOn(mod, "sendBrandedEmail").mockResolvedValue(true);
    try {
      const result = await sendEstimateEmail(prisma, estimateId, {
        sentBy: "test:anyPhotoOnAccountEmail",
        photoIds: [photoSameAccountOtherProperty, photoOnEstimateVisit, photoOtherCustomer, retiredDraftPhotoId],
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      const call = spy.mock.calls[0][0] as { attachments?: Array<{ filename: string }> };
      // Two valid ids in, two valid attachments out — the other customer's photo and the
      // retired-store id never reached the email, and a bad id did not sink the whole send.
      expect(call.attachments).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });
});
