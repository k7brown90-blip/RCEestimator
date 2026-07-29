import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { prisma } from "../src/lib/prisma";
import {
  generateCureCertificate,
  generateFindingDeclination,
  generateUpgradeRecord,
} from "../src/services/pdfGenerator";
import {
  declineFinding,
  reconcileInspection,
  resolveFinding,
  type IncomingFinding,
} from "../src/services/findingLedger";

/**
 * A cure certificate is a code-cited legal document. These tests hold the two
 * lines it must not cross: it cannot recite a citation it wasn't issued under,
 * and it cannot claim work that the ledger does not record as done.
 */

let customerId: string;
let propertyId: string;
let visitId: string;

const C4_UNDER_2017: IncomingFinding = {
  itemId: "C4",
  result: "FAIL",
  title: "Main bonding jumper & EGC-bar bonding at the service",
  citations: ["250.24(B) as adopted in the 2017 NEC"],
  critical: true,
  findingText: "Bars separated; EGC bar linked to neutral only through the enclosure.",
};

const H2_MONITOR: IncomingFinding = {
  itemId: "H2",
  result: "MONITOR",
  title: "Panel condition & remaining life",
  citations: ["manufacturer rated life (~30 yrs)"],
  findingText: "Installed 1994, Square D QO, condition sound.",
  expectedEolYear: 2024,
};

const ctx = (inspectionId: string) => ({
  inspectionId,
  visitId,
  propertyId,
  customerId,
  jurisdictionId: "murfreesboro",
  inspectionDate: new Date("2020-06-01T15:00:00Z"),
  technicianName: "Cert Test Tech",
});

beforeAll(async () => {
  const customer = await prisma.customer.create({ data: { name: "Cert Test Customer" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: {
      customerId,
      name: "Cert Test House",
      addressLine1: "44 Certificate Court",
      city: "Murfreesboro",
      state: "TN",
      postalCode: "37127",
    },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { propertyId, customerId, mode: "diagnostic", status: "completed" },
  });
  visitId = visit.id;
});

beforeEach(async () => {
  await prisma.document.deleteMany({ where: { propertyId } });
  await prisma.propertyFinding.deleteMany({ where: { propertyId } });
});

afterAll(async () => {
  await prisma.document.deleteMany({ where: { propertyId } });
  await prisma.propertyFinding.deleteMany({ where: { propertyId } });
  await prisma.visit.deleteMany({ where: { id: visitId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
});

async function openAndCorrect(finding: IncomingFinding, method: "corrected" | "replaced" = "corrected") {
  await reconcileInspection(ctx(`cert-insp-${finding.itemId}`), [finding]);
  const row = await prisma.propertyFinding.findFirstOrThrow({ where: { propertyId, itemId: finding.itemId } });
  await resolveFinding({
    findingId: row.id,
    resolutionMethod: method,
    resolvedByParty: "red_cedar",
    resolutionDetail: "Work completed and verified on site.",
    attestedBy: "Kyle Whitaker",
  });
  return row.id;
}

describe("generateCureCertificate", () => {
  it("cites what the finding was issued under, not what the checklist says today", async () => {
    const findingId = await openAndCorrect(C4_UNDER_2017);

    // The county adopts a newer code, and the checklist moves with it. The
    // certificate must still recite the notice that was actually given.
    await prisma.propertyFinding.update({
      where: { id: findingId },
      data: { jurisdictionId: "murfreesboro" },
    });

    const result = await generateCureCertificate({
      propertyId,
      findingIds: [findingId],
      attestedBy: "Kyle Whitaker",
      visitId,
    });

    expect(fs.existsSync(result.pdfPath)).toBe(true);
    const row = await prisma.propertyFinding.findUniqueOrThrow({ where: { id: findingId } });
    expect(JSON.parse(row.citationsJson)).toEqual(["250.24(B) as adopted in the 2017 NEC"]);
    expect(row.certificateDocId).toBe(result.documentId);
  });

  it("files the document against the address, so a third-party cure needs no job", async () => {
    await reconcileInspection(ctx("cert-insp-third-party"), [C4_UNDER_2017]);
    const row = await prisma.propertyFinding.findFirstOrThrow({ where: { propertyId, itemId: "C4" } });
    await resolveFinding({
      findingId: row.id,
      resolutionMethod: "verified_prior_repair",
      resolvedByParty: "third_party",
      resolvedByPartyName: "Cumberland Electric",
      resolutionDetail: "Owner supplied an invoice; bar-to-bar conductor observed in place.",
      attestedBy: "Kyle Whitaker",
    });

    const result = await generateCureCertificate({
      propertyId,
      findingIds: [row.id],
      attestedBy: "Kyle Whitaker",
    });

    const document = await prisma.document.findUniqueOrThrow({ where: { id: result.documentId } });
    expect(document.jobId).toBeNull();
    expect(document.propertyId).toBe(propertyId);
    expect(document.type).toBe("cure_certificate");
  });

  it("refuses to certify a finding that is still open", async () => {
    await reconcileInspection(ctx("cert-insp-open"), [C4_UNDER_2017]);
    const row = await prisma.propertyFinding.findFirstOrThrow({ where: { propertyId, itemId: "C4" } });

    await expect(
      generateCureCertificate({ propertyId, findingIds: [row.id], attestedBy: "Kyle Whitaker" }),
    ).rejects.toThrow(/only defect-track findings at status "corrected"/);
  });

  it("refuses to put an upgrade on a certificate of correction", async () => {
    // Nothing on the upgrade track was ever a violation, so "corrected" would be
    // a false statement about a code condition that never existed.
    const findingId = await openAndCorrect(H2_MONITOR, "replaced");
    await expect(
      generateCureCertificate({ propertyId, findingIds: [findingId], attestedBy: "Kyle Whitaker" }),
    ).rejects.toThrow(/upgrade\/upgraded/);
  });

  it("issues the upgrade record for the same finding", async () => {
    const findingId = await openAndCorrect(H2_MONITOR, "replaced");
    const result = await generateUpgradeRecord({
      propertyId,
      findingIds: [findingId],
      attestedBy: "Kyle Whitaker",
      visitId,
    });
    const document = await prisma.document.findUniqueOrThrow({ where: { id: result.documentId } });
    expect(document.type).toBe("upgrade_record");
  });

  it("refuses a finding belonging to a different property", async () => {
    const other = await prisma.customer.create({ data: { name: "Cert Other Customer" } });
    const otherProperty = await prisma.property.create({
      data: {
        customerId: other.id,
        name: "Other",
        addressLine1: "1 Elsewhere",
        city: "Franklin",
        state: "TN",
        postalCode: "37064",
      },
    });
    const findingId = await openAndCorrect(C4_UNDER_2017);

    await expect(
      generateCureCertificate({
        propertyId: otherProperty.id,
        findingIds: [findingId],
        attestedBy: "Kyle Whitaker",
      }),
    ).rejects.toThrow(/No findings supplied|not found/);

    await prisma.property.delete({ where: { id: otherProperty.id } });
    await prisma.customer.delete({ where: { id: other.id } });
  });
});

describe("generateFindingDeclination", () => {
  it("records the refusal and leaves the document unsigned for the customer", async () => {
    await reconcileInspection(ctx("cert-insp-declined"), [C4_UNDER_2017]);
    const row = await prisma.propertyFinding.findFirstOrThrow({ where: { propertyId, itemId: "C4" } });
    await declineFinding({
      findingId: row.id,
      declinedByName: "Sam Okafor",
      declinedByRelation: "owner",
      declinedVerbatim: "I'll deal with it next spring.",
      declinedChannel: "in_person",
      actorType: "technician",
      actorName: "Cert Test Tech",
    });

    const result = await generateFindingDeclination({
      propertyId,
      findingIds: [row.id],
      preparedBy: "Kyle Whitaker",
    });

    const document = await prisma.document.findUniqueOrThrow({ where: { id: result.documentId } });
    expect(document.type).toBe("finding_declination");
    // Unsigned on purpose — this is the one ledger document the customer signs,
    // via the existing public /sign/:documentId page.
    expect(document.signedAt).toBeNull();
    expect(document.jobId).toBeNull();

    const after = await prisma.propertyFinding.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.declinationDocId).toBe(result.documentId);
  });

  it("will not draft a declination for a finding nobody declined", async () => {
    await reconcileInspection(ctx("cert-insp-not-declined"), [C4_UNDER_2017]);
    const row = await prisma.propertyFinding.findFirstOrThrow({ where: { propertyId, itemId: "C4" } });
    await expect(
      generateFindingDeclination({ propertyId, findingIds: [row.id], preparedBy: "Kyle Whitaker" }),
    ).rejects.toThrow(/No declined findings/);
  });
});
