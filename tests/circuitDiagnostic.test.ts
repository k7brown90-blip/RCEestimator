/**
 * THE CIRCUIT DIAGNOSTIC (Kyle, 2026-09-20) — the server's half.
 *
 * What this file is actually defending:
 *
 *  · THE RCE STANDARD. "The standard for RCE is inspect the breaker to the last
 *    outlet ... If that circuit was bad and we stop to assume we fixed it all
 *    then a week later they call us back for that same circuit with a problem at
 *    the next outlet over ... thats a warranty call and money lost for us."
 *    The report has to STATE whole-circuit coverage on its face, and it must not
 *    be able to state it when the walk stopped short.
 *
 *  · THE DISCOVERED COUNT. "Outlets beyond the quoted count are added at their
 *    own difficulty tier. The count is discovered, not negotiated." Three normal
 *    at $25 quoted and five found is two normals of overage — NOT two of
 *    whatever tier happens to be cheapest, and not a renegotiation.
 *
 *  · THE LINE THAT DECIDES THE MONEY. Wiring fixed during the diagnostic is
 *    INCLUDED; damaged or defective equipment is NOT and becomes the resolutions
 *    change order, quoted from the recorded data.
 *
 * Self-contained by design (see .claude/constants.md, "price-book fixture gap"):
 * this file creates its own supplier and atomic rows under its own ids rather
 * than relying on an imported catalog that a clean database does not have.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 { setCredentials() {} }
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

import { app } from "../src/app";

const SUP = "DIAGTEST-SUP";
const ITEM = "DIAGTEST-OUTLET";
const OTHER_ITEM = "DIAGTEST-TRIP";
const newId = () => crypto.randomUUID().replaceAll("-", "");

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;
let strangerToken: string;
let signedEstimateId: string;
let signedNumber: string;

async function cleanup() {
  const reports = await prisma.diagnosticReport.findMany({ where: { customer: { name: "Diagnostic Test Co" } }, select: { id: true } });
  const ids = reports.map((r) => r.id);
  if (ids.length > 0) {
    await prisma.diagnosticReportDelivery.deleteMany({ where: { reportId: { in: ids } } });
    await prisma.diagnosticPhoto.deleteMany({ where: { reportId: { in: ids } } });
    await prisma.diagnosticOutlet.deleteMany({ where: { reportId: { in: ids } } });
    await prisma.diagnosticReport.deleteMany({ where: { id: { in: ids } } });
  }
  const customer = await prisma.customer.findFirst({ where: { name: "Diagnostic Test Co" }, select: { id: true } });
  if (customer) {
    const ests = await prisma.issuedEstimate.findMany({ where: { customerId: customer.id }, select: { id: true, draftId: true } });
    await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: ests.map((e) => e.id) } } });
    await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: ests.map((e) => e.id) } } });
    await prisma.document.deleteMany({ where: { issuedEstimateId: { in: ests.map((e) => e.id) } } });
    await prisma.issuedEstimate.deleteMany({ where: { customerId: customer.id } });
    await prisma.priceBookDraftLine.deleteMany({ where: { draft: { customerId: customer.id } } });
    await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: ests.map((e) => e.draftId) } } });
    await prisma.priceBookDraftEstimate.deleteMany({ where: { OR: [{ customerId: customer.id }, { id: { in: ests.map((e) => e.draftId) } }] } });
    await prisma.visitAssignment.deleteMany({ where: { visit: { customerId: customer.id } } });
    await prisma.visit.deleteMany({ where: { customerId: customer.id } });
    await prisma.property.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.delete({ where: { id: customer.id } });
  }
  await prisma.technician.deleteMany({ where: { name: { startsWith: "Diagnostic Test Tech" } } });
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: [ITEM, OTHER_ITEM] } } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: SUP } });
}

beforeAll(async () => {
  await cleanup();

  const customer = await prisma.customer.create({ data: { name: "Diagnostic Test Co", email: "diag@example.com" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "Diag House", addressLine1: "7 Circuit Ct", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "service_diagnostic", purpose: "Partial power outage", jobType: "Service", status: "in_progress", visitDate: new Date() },
  });
  visitId = visit.id;

  const tech = await prisma.technician.create({ data: { name: "Diagnostic Test Tech", accessToken: `diag-${newId()}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.visitAssignment.create({ data: { visitId, technicianId } });
  const stranger = await prisma.technician.create({ data: { name: "Diagnostic Test Tech Stranger", accessToken: `diag-x-${newId()}` } });
  strangerToken = stranger.accessToken;

  // Own catalog rows — nothing here depends on an imported price book.
  await prisma.priceBookSupplier.create({ data: { id: SUP, name: "Diagnostic Test Supply", quotable: "YES" } });
  await prisma.priceBookAtomic.create({
    data: {
      itemId: ITEM, description: "Circuit diagnostic — per outlet examined", category: "Service",
      unit: "ea", rowType: "LABOR ONLY", laborNormal: 0.4, laborDifficult: 0.6, laborVeryDifficult: 0.9,
      sellNormal: 25, sellDifficult: 35, sellVeryDifficult: 50,
    },
  });
  await prisma.priceBookAtomic.create({
    data: { itemId: OTHER_ITEM, description: "Trip charge", category: "Service", unit: "ea", rowType: "LABOR ONLY", laborNormal: 0.25 },
  });

  /*
    THE SIGNED QUOTE, exactly as Kyle described it: "3 normal outlets at $25, 2
    ceiling outlets at $35, and 1 hard to reach outlet at $50. The line items
    same diagnostic price book item ... three separate because he will show 3
    difficulties." Three DRAFT lines of one item at three tiers, graduated into
    three issued lines — and note what the issued lines do NOT carry.
  */
  const draft = await prisma.priceBookDraftEstimate.create({
    data: { title: "Diagnostic quote", supplierId: SUP, customerId, visitId },
  });
  const tiers = [
    { difficulty: "NORMAL" as const, quantity: 3, unitPrice: 25 },
    { difficulty: "DIFFICULT" as const, quantity: 2, unitPrice: 35 },
    { difficulty: "VERY_DIFFICULT" as const, quantity: 1, unitPrice: 50 },
  ];
  for (const tier of tiers) {
    await prisma.priceBookDraftLine.create({
      data: {
        draftId: draft.id, itemId: ITEM, quantity: tier.quantity, quantitySource: "COUNT",
        difficulty: tier.difficulty, option: "A", state: "CONFIRMED", confirmedBy: "test", confirmedAt: new Date(),
      },
    });
  }
  const est = await prisma.issuedEstimate.create({
    data: {
      number: "0000-DIAG1", token: `diagtest-${newId()}`, status: "signed", draftId: draft.id,
      customerId, serviceAddressId: propertyId, customerName: "Diagnostic Test Co",
      serviceAddress: "7 Circuit Ct, Smyrna", title: "Circuit diagnostic", selectedOptions: ["A"],
      workSubtotal: 205, total: 205, signedAt: new Date(), signedChannel: "in_person",
      jobVisitId: visitId,
      lines: {
        create: tiers.map((t, i) => ({
          itemId: ITEM, description: "Circuit diagnostic — per outlet examined",
          quantity: t.quantity, unitPrice: t.unitPrice, lineTotal: t.quantity * t.unitPrice,
          option: "A" as const, sortOrder: i,
        })),
      },
    },
  });
  signedEstimateId = est.id;
  signedNumber = est.number;
});

afterAll(cleanup);

const auth = (r: request.Test, token = techToken) => r.set("Authorization", `Bearer ${token}`);

const outlet = (over: Partial<Record<string, unknown>> = {}) => ({
  id: newId(),
  sequence: 1,
  locationLabel: "Kitchen, east wall",
  deviceType: "receptacle",
  difficulty: "NORMAL",
  photoIds: [newId()],
  ...over,
});

const pushBody = (over: Partial<Record<string, unknown>> = {}) => ({
  reportId: newId(),
  visitId,
  reportDate: new Date().toISOString(),
  complaint: "Half the kitchen and the dining room are dead",
  circuitLabel: "Kitchen small-appliance circuit",
  circuitNumber: "2",
  breakerInspected: true,
  coverage: "whole_circuit",
  quotedNormal: 3,
  quotedDifficult: 2,
  quotedVeryDifficult: 1,
  diagnosticItemId: ITEM,
  status: "in_progress",
  outlets: [outlet()],
  ...over,
});

const push = (body: object, token = techToken) =>
  auth(request(app).post("/health-record/diagnostic-reports"), token).send(body);

// ─────────────────────────────────────────────────────────────────────────────

describe("the quoted side — what the signed estimate bought, per access tier", () => {
  it("reads the three tiers off the draft behind the signed document, because the ISSUED line does not carry difficulty", async () => {
    const res = await auth(request(app).get(`/health-record/visits/${visitId}/diagnostic-context`));
    expect(res.status).toBe(200);
    expect(res.body.data.quoted).toEqual({ NORMAL: 3, DIFFICULT: 2, VERY_DIFFICULT: 1 });
    expect(res.body.data.diagnosticItemId).toBe(ITEM);
    expect(res.body.data.source).toBe("matched");
    expect(res.body.data.estimateNumber).toBe(signedNumber);

    // The finding this guards: the issued line genuinely has no tier on it, so
    // anyone tempted to read the counts off the signed document would get one
    // undifferentiated number and quietly charge every overage at NORMAL.
    const line = await prisma.issuedEstimateLine.findFirst({ where: { estimateId: signedEstimateId } });
    expect(line).toBeTruthy();
    expect((line as unknown as Record<string, unknown>).difficulty).toBeUndefined();
  });

  it("offers the signed document's own items as candidates and gates on assignment", async () => {
    const res = await auth(request(app).get(`/health-record/visits/${visitId}/diagnostic-context`));
    expect(res.body.data.candidates.map((c: { itemId: string }) => c.itemId)).toContain(ITEM);

    const forbidden = await auth(request(app).get(`/health-record/visits/${visitId}/diagnostic-context`), strangerToken);
    expect(forbidden.status).toBe(403);
    const noAuth = await request(app).get(`/health-record/visits/${visitId}/diagnostic-context`);
    expect(noAuth.status).toBe(401);
  });
});

describe("THE RCE STANDARD — the report states its coverage on its face", () => {
  it("says WHOLE-CIRCUIT COVERAGE, breaker to last outlet, with the examined count in it", async () => {
    const res = await push(pushBody({ outlets: [outlet({ sequence: 1 }), outlet({ sequence: 2, locationLabel: "Dining, south wall" })] }));
    expect(res.status).toBe(201);
    const view = res.body.data;
    expect(view.coverage).toBe("whole_circuit");
    expect(view.coverageStatement).toMatch(/WHOLE-CIRCUIT COVERAGE — Kitchen small-appliance circuit/);
    expect(view.coverageStatement).toMatch(/breaker to last outlet: 2 outlets examined/);
    expect(view.coverageStatement).toMatch(/The breaker was inspected/);
  });

  it("will not let a partial walk pass without saying where it stopped", async () => {
    const refused = await push(pushBody({ coverage: "partial", coverageNote: null }));
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("coverage_note_required");

    const ok = await push(pushBody({ coverage: "partial", coverageNote: "Customer stopped us at the hallway" }));
    expect(ok.status).toBe(201);
    expect(ok.body.data.coverageStatement).toMatch(/PARTIAL COVERAGE/);
    expect(ok.body.data.coverageStatement).toMatch(/Customer stopped us at the hallway/);
    expect(ok.body.data.coverageStatement).toMatch(/not covered by this report/);
    expect(ok.body.data.coverageStatement).not.toMatch(/WHOLE-CIRCUIT/);
  });

  it("refuses an outlet with no photo — a claim is not a record", async () => {
    const res = await push(pushBody({ outlets: [outlet({ photoIds: [] })] }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("outlet_needs_photo");
    // And nothing was written: a violating report must not exist in part.
    expect(await prisma.diagnosticReport.count({ where: { visitId, outlets: { none: {} } } })).toBe(0);
  });

  it("refuses defective equipment with no description — that is what the change order quotes", async () => {
    const res = await push(pushBody({ outlets: [outlet({ equipmentDefective: true, defectDescription: null })] }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("defect_needs_description");
  });
});

describe("THE DISCOVERED COUNT — outlets beyond the quote, each at its own tier", () => {
  it("counts the overage per tier, never rolled into one number", async () => {
    // Quoted 3 / 2 / 1. The circuit actually held 5 normals, 2 difficult, 2 very difficult.
    const outlets = [
      ...Array.from({ length: 5 }, (_, i) => outlet({ sequence: i + 1, difficulty: "NORMAL", locationLabel: `N${i + 1}` })),
      ...Array.from({ length: 2 }, (_, i) => outlet({ sequence: 6 + i, difficulty: "DIFFICULT", locationLabel: `D${i + 1}` })),
      ...Array.from({ length: 2 }, (_, i) => outlet({ sequence: 8 + i, difficulty: "VERY_DIFFICULT", locationLabel: `V${i + 1}` })),
    ];
    const res = await push(pushBody({ outlets }));
    expect(res.status).toBe(201);
    expect(res.body.data.money.examined).toEqual({ NORMAL: 5, DIFFICULT: 2, VERY_DIFFICULT: 2 });
    expect(res.body.data.money.overage).toEqual({ NORMAL: 2, DIFFICULT: 0, VERY_DIFFICULT: 1 });
    expect(res.body.data.money.overageTotal).toBe(3);
  });

  it("a tier examined fewer times than quoted is zero, never a credit", async () => {
    const res = await push(pushBody({ outlets: [outlet()] }));
    expect(res.body.data.money.overage).toEqual({ NORMAL: 0, DIFFICULT: 0, VERY_DIFFICULT: 0 });
    expect(res.body.data.money.examinedTotal).toBe(1);
    expect(res.body.data.money.quotedTotal).toBe(6);
  });
});

describe("the push is idempotent and its outlets SYNC", () => {
  it("a retry lands on the same rows, and an outlet deleted on the phone disappears here", async () => {
    const reportId = newId();
    const a = outlet({ sequence: 1, locationLabel: "Box A" });
    const b = outlet({ sequence: 2, locationLabel: "Box B" });

    const first = await push(pushBody({ reportId, outlets: [a, b] }));
    expect(first.status).toBe(201);
    expect(first.body.data.outlets).toHaveLength(2);
    const created = await prisma.diagnosticOutlet.findUnique({ where: { id: a.id }, select: { createdAt: true } });

    // Same report id, one outlet edited, the other removed on the phone.
    const second = await push(pushBody({ reportId, outlets: [{ ...a, findings: "Loose neutral on the line side" }] }));
    expect(second.status).toBe(201);
    expect(second.body.data.outlets).toHaveLength(1);
    expect(second.body.data.outlets[0].findings).toBe("Loose neutral on the line side");
    expect(await prisma.diagnosticReport.count({ where: { id: reportId } })).toBe(1);
    expect(await prisma.diagnosticOutlet.count({ where: { id: b.id } })).toBe(0);

    // Upserted, not recreated — a queued retry must not churn row identity.
    const after = await prisma.diagnosticOutlet.findUnique({ where: { id: a.id }, select: { createdAt: true } });
    expect(after!.createdAt.toISOString()).toBe(created!.createdAt.toISOString());
  });

  it("photo bytes upload idempotently on the phone's own photo id, and only after the report lands", async () => {
    const reportId = newId();
    const photoId = newId();
    const before = await auth(
      request(app).put(`/health-record/diagnostic-reports/${reportId}/photos/${photoId}`),
    ).set("Content-Type", "image/jpeg").send(Buffer.from("jpeg-bytes"));
    expect(before.status).toBe(404);

    await push(pushBody({ reportId, outlets: [outlet({ photoIds: [photoId] })] }));
    for (const _ of [1, 2]) {
      const res = await auth(
        request(app).put(`/health-record/diagnostic-reports/${reportId}/photos/${photoId}`),
      ).set("Content-Type", "image/jpeg").send(Buffer.from("jpeg-bytes"));
      expect(res.status).toBe(201);
    }
    expect(await prisma.diagnosticPhoto.count({ where: { reportId } })).toBe(1);
  });

  it("403s a visit this technician is not on", async () => {
    const res = await push(pushBody(), strangerToken);
    expect(res.status).toBe(403);
  });
});

describe("the report only reaches a homeowner when the walk is finished", () => {
  it("refuses to email an in-progress diagnostic, and says why", async () => {
    const reportId = newId();
    await push(pushBody({ reportId, status: "in_progress" }));
    const res = await auth(request(app).post(`/health-record/diagnostic-reports/${reportId}/email`)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/still in progress/i);
    expect(res.body.error.message).toMatch(/breaker to last outlet/i);
  });

  it("marks completedAt when the tech says the circuit is finished, and never clears it on a later retry", async () => {
    const reportId = newId();
    await push(pushBody({ reportId, status: "in_progress" }));
    const done = await push(pushBody({ reportId, status: "complete" }));
    expect(done.body.data.status).toBe("complete");
    expect(done.body.data.completedAt).toBeTruthy();

    // A stale queued payload arriving late must not un-finish a finished walk.
    const stale = await push(pushBody({ reportId, status: "in_progress" }));
    expect(stale.body.data.completedAt).toBeTruthy();
  });
});

describe("the resolutions change order", () => {
  let reportId: string;

  beforeEach(async () => {
    reportId = newId();
    const outlets = [
      ...Array.from({ length: 5 }, (_, i) => outlet({ sequence: i + 1, difficulty: "NORMAL", locationLabel: `N${i + 1}` })),
      ...Array.from({ length: 2 }, (_, i) => outlet({ sequence: 6 + i, difficulty: "VERY_DIFFICULT", locationLabel: `V${i + 1}` })),
      outlet({
        sequence: 8, difficulty: "DIFFICULT", locationLabel: "Dining ceiling fixture",
        fixed: "Re-terminated the neutral", equipmentDefective: true,
        defectDescription: "Fixture socket burned — will not hold a lamp",
      }),
    ];
    await push(pushBody({ reportId, status: "complete", outlets }));
  });

  it("is a CHANGE ORDER on the signed invoice, seeded with the overage at each tier's own difficulty", async () => {
    const res = await auth(request(app).post(`/health-record/diagnostic-reports/${reportId}/resolutions`)).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.isChangeOrder).toBe(true);
    expect(res.body.data.changeOrderFor).toBe(signedNumber);

    const lines = await prisma.priceBookDraftLine.findMany({
      where: { draftId: res.body.data.draftId },
      select: { itemId: true, quantity: true, difficulty: true, state: true },
    });
    // Quoted 3/2/1, examined 5/1/2 → overage 2 NORMAL, 0 DIFFICULT, 1 VERY_DIFFICULT.
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.difficulty === "NORMAL")).toMatchObject({ itemId: ITEM, quantity: 2, state: "CONFIRMED" });
    expect(lines.find((l) => l.difficulty === "VERY_DIFFICULT")).toMatchObject({ itemId: ITEM, quantity: 1 });
    expect(lines.find((l) => l.difficulty === "DIFFICULT")).toBeUndefined();

    const draft = await prisma.priceBookDraftEstimate.findUnique({ where: { id: res.body.data.draftId } });
    expect(draft!.changeOrderForId).toBe(signedEstimateId);
    expect(draft!.visitId).toBe(visitId);
  });

  it("writes every defective device into the scope and NEVER the wiring it fixed", async () => {
    const res = await auth(request(app).post(`/health-record/diagnostic-reports/${reportId}/resolutions`)).send({});
    const draft = await prisma.priceBookDraftEstimate.findUnique({ where: { id: res.body.data.draftId } });

    expect(res.body.data.defects).toEqual([
      { locationLabel: "Dining ceiling fixture", defectDescription: "Fixture socket burned — will not hold a lamp" },
    ]);
    expect(draft!.jobDescription).toMatch(/Dining ceiling fixture — Fixture socket burned/);
    // The line that decides the money: what we fixed was paid for by the
    // diagnostic and must not appear on a second bill.
    expect(draft!.jobDescription).not.toMatch(/Re-terminated the neutral/);
    // And the coverage statement rides the scope, so the change order carries
    // the same warranty language the report does.
    expect(draft!.jobDescription).toMatch(/WHOLE-CIRCUIT COVERAGE/);
  });

  it("a second tap RESUMES the same draft — a customer is never asked to sign two", async () => {
    const before = await prisma.priceBookDraftEstimate.count({ where: { changeOrderForId: signedEstimateId } });
    const first = await auth(request(app).post(`/health-record/diagnostic-reports/${reportId}/resolutions`)).send({});
    const second = await auth(request(app).post(`/health-record/diagnostic-reports/${reportId}/resolutions`)).send({});
    expect(second.status).toBe(200);
    expect(second.body.data.resumed).toBe(true);
    expect(second.body.data.draftId).toBe(first.body.data.draftId);
    // Exactly ONE new change order came out of two taps on the same report.
    expect(await prisma.priceBookDraftEstimate.count({ where: { changeOrderForId: signedEstimateId } })).toBe(before + 1);
  });

  /*
    THE COLLISION THIS PINS (found 2026-09-21 building this feature). The field's
    "Build the quote" resumes `findFirst({ visitId, status: "draft" })`. A change
    order raised on the same job IS such a draft, so without the
    `changeOrderForId: null` filter added in health-record.ts, tapping Build the
    quote would silently open the resolutions change order and the tech would add
    new-work lines to a document that only describes the change.
  */
  it('"Build the quote" never resumes that change order — it is a different document', async () => {
    const resolutions = await auth(request(app).post(`/health-record/diagnostic-reports/${reportId}/resolutions`)).send({});
    const quote = await auth(request(app).post(`/health-record/visits/${visitId}/quote`)).send({});
    expect([200, 201]).toContain(quote.status);
    expect(quote.body.data.draftId).not.toBe(resolutions.body.data.draftId);
    const resumed = await prisma.priceBookDraftEstimate.findUnique({
      where: { id: quote.body.data.draftId },
      select: { changeOrderForId: true },
    });
    expect(resumed!.changeOrderForId).toBeNull();
  });
});

describe("nothing the app creates is permanent (Kyle's standing rule)", () => {
  it("voids with a reason, refuses one without, and never edits a voided report back to life", async () => {
    const reportId = newId();
    await push(pushBody({ reportId, status: "complete" }));

    // Refused at the door by the route's own schema before the service is
    // reached — either way, a void without a reason cannot happen.
    const noReason = await auth(request(app).post(`/health-record/diagnostic-reports/${reportId}/void`)).send({ reason: "" });
    expect(noReason.status).toBe(422);

    const voided = await auth(request(app).post(`/health-record/diagnostic-reports/${reportId}/void`))
      .send({ reason: "Wrong circuit — started over on circuit 4" });
    expect(voided.status).toBe(200);
    expect(voided.body.data.status).toBe("void");
    expect(voided.body.data.voidReason).toMatch(/Wrong circuit/);

    const reopened = await push(pushBody({ reportId, status: "complete" }));
    expect(reopened.status).toBe(409);
    expect(reopened.body.error.code).toBe("report_void");
  });

  it("deletes one the homeowner never received, and REFUSES to delete one they hold", async () => {
    const keep = newId();
    await push(pushBody({ reportId: keep, status: "complete" }));
    await prisma.diagnosticReportDelivery.create({
      data: { reportId: keep, documentId: newId(), sentTo: "diag@example.com", sentBy: "owner:crm" },
    });
    const refused = await auth(request(app).delete(`/health-record/diagnostic-reports/${keep}`));
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/Void it with a reason instead/);

    const gone = newId();
    await push(pushBody({ reportId: gone, outlets: [outlet()] }));
    const deleted = await auth(request(app).delete(`/health-record/diagnostic-reports/${gone}`));
    expect(deleted.status).toBe(200);
    expect(await prisma.diagnosticReport.count({ where: { id: gone } })).toBe(0);
    // Outlets cascade with it.
    expect(await prisma.diagnosticOutlet.count({ where: { reportId: gone } })).toBe(0);
  });

  it("removes one photo without touching the rest of the record", async () => {
    const reportId = newId();
    const photoId = newId();
    await push(pushBody({ reportId, outlets: [outlet({ photoIds: [photoId, newId()] })] }));
    await auth(request(app).put(`/health-record/diagnostic-reports/${reportId}/photos/${photoId}`))
      .set("Content-Type", "image/jpeg").send(Buffer.from("bytes"));
    expect(await prisma.diagnosticPhoto.count({ where: { reportId } })).toBe(1);

    const res = await auth(request(app).delete(`/health-record/diagnostic-reports/${reportId}/photos/${photoId}`));
    expect(res.status).toBe(200);
    expect(await prisma.diagnosticPhoto.count({ where: { reportId } })).toBe(0);
    expect(await prisma.diagnosticReport.count({ where: { id: reportId } })).toBe(1);
  });
});
