import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";
import {
  declineFinding,
  reconcileInspection,
  reopenFinding,
  resolveFinding,
  scheduleFinding,
  type IncomingFinding,
  type ReconcileContext,
} from "../src/services/findingLedger";

/**
 * The ledger's job is to say what is known at an address and whether it was ever
 * fixed. These tests pin the two properties that make that claim trustworthy:
 * a replayed sync cannot invent history, and nothing but a person closes a
 * finding out.
 */

let customerId: string;
let propertyId: string;
let visitId: string;

const FAIL_C4: IncomingFinding = {
  itemId: "C4",
  result: "FAIL",
  title: "Main bonding jumper & EGC-bar bonding at the service",
  section: "C — Grounding & Bonding",
  citations: ["250.24(B)", "250.118"],
  critical: true,
  findingText: "Configuration separate bars; EGC-bar-to-neutral linked only through the enclosure.",
  resolutionNote: "Install a copper conductor bar to bar.",
};

const MONITOR_H2: IncomingFinding = {
  itemId: "H2",
  result: "MONITOR",
  title: "Panel condition & remaining life",
  citations: ["manufacturer rated life (~30 yrs)"],
  findingText: "Installed 1994 (32 yrs), Square D QO, condition sound.",
  expectedEolYear: 2024,
};

/** The newest C4 row at the test property — the one most assertions are about. */
const latestC4 = () =>
  prisma.propertyFinding.findFirstOrThrow({
    where: { propertyId, itemId: "C4" },
    orderBy: { cycle: "desc" },
  });

const ctx = (overrides: Partial<ReconcileContext> = {}): ReconcileContext => ({
  inspectionId: "ledger-insp-1",
  visitId,
  propertyId,
  customerId,
  jurisdictionId: "murfreesboro",
  inspectionDate: new Date("2026-08-01T15:00:00Z"),
  technicianId: null,
  technicianName: "Ledger Test Tech",
  ...overrides,
});

beforeAll(async () => {
  const customer = await prisma.customer.create({ data: { name: "Ledger Test Customer" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: {
      customerId,
      name: "Ledger Test House",
      addressLine1: "9 Ledger Lane",
      city: "Murfreesboro",
      state: "TN",
      postalCode: "37127",
    },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { propertyId, customerId, mode: "diagnostic", status: "scheduled" },
  });
  visitId = visit.id;
});

beforeEach(async () => {
  await prisma.propertyFinding.deleteMany({ where: { propertyId } });
});

afterAll(async () => {
  await prisma.propertyFinding.deleteMany({ where: { propertyId } });
  await prisma.visit.deleteMany({ where: { id: visitId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
});

describe("reconcileInspection", () => {
  it("opens a defect-track row for a FAIL and snapshots its citations", async () => {
    const result = await reconcileInspection(ctx(), [FAIL_C4]);
    expect(result.opened).toBe(1);

    const finding = await prisma.propertyFinding.findFirstOrThrow({ where: { propertyId, itemId: "C4" } });
    expect(finding.track).toBe("defect");
    expect(finding.status).toBe("open");
    expect(finding.cycle).toBe(1);
    expect(finding.critical).toBe(true);
    expect(JSON.parse(finding.citationsJson)).toEqual(["250.24(B)", "250.118"]);
    expect(finding.locationKey).toBe("_default");
  });

  it("routes MONITOR to the upgrade track and dates its follow-up from the EOL year", async () => {
    await reconcileInspection(ctx(), [MONITOR_H2]);
    const finding = await prisma.propertyFinding.findFirstOrThrow({ where: { propertyId, itemId: "H2" } });
    expect(finding.track).toBe("upgrade");
    expect(finding.expectedEolYear).toBe(2024);
    expect(finding.followUpAt?.getUTCFullYear()).toBe(2024);
  });

  it("carries no EOL date on the defect track", async () => {
    // "Replace this before it wears out" is not a thing you say about a code
    // violation, and a follow-up date on one would put it in the wrong queue.
    await reconcileInspection(ctx(), [{ ...FAIL_C4, expectedEolYear: 2030 }]);
    const finding = await prisma.propertyFinding.findFirstOrThrow({ where: { propertyId, itemId: "C4" } });
    expect(finding.expectedEolYear).toBeNull();
    expect(finding.followUpAt).toBeNull();
  });

  it("is idempotent — replaying the same push leaves one row and one event", async () => {
    await reconcileInspection(ctx(), [FAIL_C4]);
    await reconcileInspection(ctx(), [FAIL_C4]);

    const findings = await prisma.propertyFinding.findMany({ where: { propertyId, itemId: "C4" } });
    expect(findings.length).toBe(1);

    const events = await prisma.propertyFindingEvent.findMany({ where: { findingId: findings[0].id } });
    expect(events.filter((e) => e.toStatus === "open").length).toBe(1);
  });

  it("counts a genuine re-observation on a later record", async () => {
    await reconcileInspection(ctx(), [FAIL_C4]);
    await reconcileInspection(ctx({ inspectionId: "ledger-insp-2" }), [FAIL_C4]);

    const finding = await latestC4();
    expect(finding.observedCount).toBe(2);
    expect(finding.lastObservedInspectionId).toBe("ledger-insp-2");
    expect(finding.status).toBe("open");
  });

  it("records a changed severity on the event and never rewrites the original notice", async () => {
    await reconcileInspection(ctx(), [FAIL_C4]);
    await reconcileInspection(ctx({ inspectionId: "ledger-insp-2" }), [{ ...FAIL_C4, result: "MONITOR" }]);

    const finding = await latestC4();
    expect(finding.severity).toBe("FAIL"); // what the customer was told
    const events = await prisma.propertyFindingEvent.findMany({ where: { findingId: finding.id } });
    expect(events.some((e) => e.note?.includes("originally documented FAIL"))).toBe(true);
  });

  it("treats a later PASS as evidence, not a cure", async () => {
    await reconcileInspection(ctx(), [FAIL_C4]);
    const result = await reconcileInspection(
      ctx({ inspectionId: "ledger-insp-2", passedItemIds: ["C4"] }),
      [],
    );

    const finding = await latestC4();
    expect(finding.status).toBe("open"); // NOT corrected
    expect(finding.verifiedPassAt).not.toBeNull();
    expect(finding.verifiedPassInspectionId).toBe("ledger-insp-2");
    expect(result.awaitingCloseout).toEqual([finding.id]);
  });

  it("clears a stale pass when the finding is seen again", async () => {
    await reconcileInspection(ctx(), [FAIL_C4]);
    await reconcileInspection(ctx({ inspectionId: "ledger-insp-2", passedItemIds: ["C4"] }), []);
    await reconcileInspection(ctx({ inspectionId: "ledger-insp-3" }), [FAIL_C4]);

    const finding = await latestC4();
    expect(finding.verifiedPassAt).toBeNull();
  });

  it("supersedes rather than resolves when an item is later recorded N/A", async () => {
    // The equipment went away. Nobody corrected anything, and a certificate must
    // not be able to claim otherwise.
    await reconcileInspection(ctx(), [FAIL_C4]);
    await reconcileInspection(ctx({ inspectionId: "ledger-insp-2", naItemIds: ["C4"] }), []);

    const finding = await latestC4();
    expect(finding.status).toBe("superseded");
    expect(finding.resolvedAt).toBeNull();
  });

  it("opens a new cycle when a finding recurs after being corrected", async () => {
    await reconcileInspection(ctx(), [FAIL_C4]);
    const first = await latestC4();
    await resolveFinding({
      findingId: first.id,
      resolutionMethod: "corrected",
      resolvedByParty: "red_cedar",
      resolutionDetail: "Bar-to-bar #6 Cu installed.",
      attestedBy: "Kyle",
    });

    await reconcileInspection(ctx({ inspectionId: "ledger-insp-9" }), [FAIL_C4]);

    const rows = await prisma.propertyFinding.findMany({
      where: { propertyId, itemId: "C4" },
      orderBy: { cycle: "asc" },
    });
    expect(rows.map((r) => r.cycle)).toEqual([1, 2]);
    expect(rows[0].status).toBe("corrected"); // history is not mutated
    expect(rows[1].status).toBe("open");
  });

  it("keeps findings at different locations apart", async () => {
    await reconcileInspection(ctx(), [
      { ...FAIL_C4, itemId: "D2", locationKey: "_default" },
      { ...FAIL_C4, itemId: "D2", locationKey: "sub-garage" },
    ]);
    const rows = await prisma.propertyFinding.findMany({ where: { propertyId, itemId: "D2" } });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.cycle === 1)).toBe(true);
  });

  it("lets the database, not the reconciler, forbid two live rows for one key", async () => {
    // The reconciler reads-then-writes, so two concurrent pushes could both find
    // nothing and both create. PropertyFinding_live_unique is what makes that a
    // constraint violation instead of a duplicate finding on a legal document.
    // It is a partial index, which Prisma's schema language cannot express — so
    // if this fails, tests/globalSetup.ts stopped applying it by hand.
    await reconcileInspection(ctx(), [FAIL_C4]);
    const existing = await latestC4();

    await expect(
      prisma.propertyFinding.create({
        data: {
          propertyId,
          customerId,
          itemId: existing.itemId,
          locationKey: existing.locationKey,
          track: "defect",
          title: existing.title,
          citationsJson: "[]",
          jurisdictionId: "murfreesboro",
          severity: "FAIL",
          findingText: "Duplicate live row.",
          status: "open",
          openedInspectionId: "ledger-insp-race",
          openedVisitId: visitId,
          openedAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    // A resolved row for the same key is fine — that's how recurrence works.
    await prisma.propertyFinding.update({ where: { id: existing.id }, data: { status: "corrected" } });
    const second = await prisma.propertyFinding.create({
      data: {
        propertyId,
        customerId,
        itemId: existing.itemId,
        locationKey: existing.locationKey,
        cycle: 2,
        track: "defect",
        title: existing.title,
        citationsJson: "[]",
        jurisdictionId: "murfreesboro",
        severity: "FAIL",
        findingText: "Recurred.",
        status: "open",
        openedInspectionId: "ledger-insp-race-2",
        openedVisitId: visitId,
        openedAt: new Date(),
      },
    });
    expect(second.cycle).toBe(2);
  });

  it("names an undescribed finding after its id instead of inventing citations", async () => {
    const result = await reconcileInspection(ctx(), [{ itemId: "Z9", result: "FAIL" }]);
    expect(result.undescribed).toEqual(["Z9"]);

    const finding = await prisma.propertyFinding.findFirstOrThrow({ where: { propertyId, itemId: "Z9" } });
    expect(finding.title).toContain("Z9");
    expect(JSON.parse(finding.citationsJson)).toEqual([]);
  });
});

describe("owner transitions", () => {
  it("ends a defect at corrected and an upgrade at upgraded", async () => {
    await reconcileInspection(ctx(), [FAIL_C4, MONITOR_H2]);
    const defect = await prisma.propertyFinding.findFirstOrThrow({ where: { propertyId, itemId: "C4" } });
    const upgrade = await prisma.propertyFinding.findFirstOrThrow({ where: { propertyId, itemId: "H2" } });

    const corrected = await resolveFinding({
      findingId: defect.id,
      resolutionMethod: "corrected",
      resolvedByParty: "red_cedar",
      resolutionDetail: "Bar-to-bar conductor installed.",
      attestedBy: "Kyle",
    });
    const upgraded = await resolveFinding({
      findingId: upgrade.id,
      resolutionMethod: "replaced",
      resolvedByParty: "red_cedar",
      resolutionDetail: "Panel replaced with a 200 A load center.",
      attestedBy: "Kyle",
    });

    expect(corrected.status).toBe("corrected");
    expect(upgraded.status).toBe("upgraded");
    expect(upgraded.followUpAt).toBeNull();
  });

  it("refuses to resolve a finding that is already closed", async () => {
    await reconcileInspection(ctx(), [FAIL_C4]);
    const finding = await latestC4();
    const input = {
      findingId: finding.id,
      resolutionMethod: "corrected" as const,
      resolvedByParty: "red_cedar" as const,
      resolutionDetail: "Done.",
      attestedBy: "Kyle",
    };
    await resolveFinding(input);
    await expect(resolveFinding(input)).rejects.toThrow(/not open/);
  });

  it("captures who declined and in what capacity", async () => {
    // A tenant declining a repair is not the owner declining it. Blurring the
    // two protects nobody.
    await reconcileInspection(ctx(), [FAIL_C4]);
    const finding = await latestC4();

    const declined = await declineFinding({
      findingId: finding.id,
      declinedByName: "Dana Reyes",
      declinedByRelation: "tenant",
      declinedVerbatim: "The landlord handles that, not me.",
      declinedChannel: "in_person",
      actorType: "technician",
      actorName: "Ledger Test Tech",
    });
    expect(declined.status).toBe("declined");
    expect(declined.declinedByRelation).toBe("tenant");
    expect(declined.declinedVerbatim).toContain("landlord");
  });

  it("lets a declined finding be reopened but never a resolved one", async () => {
    await reconcileInspection(ctx(), [FAIL_C4, MONITOR_H2]);
    const declinedRow = await prisma.propertyFinding.findFirstOrThrow({ where: { propertyId, itemId: "C4" } });
    const resolvedRow = await prisma.propertyFinding.findFirstOrThrow({ where: { propertyId, itemId: "H2" } });

    await declineFinding({
      findingId: declinedRow.id,
      declinedByName: "Sam Okafor",
      declinedByRelation: "owner",
      declinedVerbatim: "Not this year.",
      declinedChannel: "phone",
      actorType: "owner",
      actorName: "Kyle",
    });
    const reopened = await reopenFinding(declinedRow.id, "Kyle", "Owner called back.");
    expect(reopened.status).toBe("open");
    expect(reopened.declinedAt).toBeNull();

    await resolveFinding({
      findingId: resolvedRow.id,
      resolutionMethod: "replaced",
      resolvedByParty: "red_cedar",
      resolutionDetail: "Panel replaced.",
      attestedBy: "Kyle",
    });
    await expect(reopenFinding(resolvedRow.id, "Kyle")).rejects.toThrow(/declined finding/);
  });

  it("keeps a scheduled finding live, so it still reads as outstanding", async () => {
    await reconcileInspection(ctx(), [FAIL_C4]);
    const finding = await latestC4();
    const scheduled = await scheduleFinding(finding.id, visitId, new Date("2026-09-01T14:00:00Z"), "Kyle");
    expect(scheduled.status).toBe("scheduled");
    expect(scheduled.scheduledVisitId).toBe(visitId);

    // And a re-observation while scheduled must not knock it back to open.
    await reconcileInspection(ctx({ inspectionId: "ledger-insp-5" }), [FAIL_C4]);
    const after = await latestC4();
    expect(after.status).toBe("scheduled");
  });
});
