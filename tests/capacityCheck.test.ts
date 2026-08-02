import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

/**
 * The 220.83 → 220.87 decision rule, enforced server-side.
 *
 * The rule is: run 220.83; if it clears, quote the addition; if it doesn't,
 * quote the service upgrade. A 30-day metered demand study is the exception a
 * customer explicitly asks for, not a default the software offers — so the gate
 * lives here, where a form cannot route around it.
 */

let customerId: string;
let propertyId: string;

const CHECK_ID = "cap-check-0001";

const EXISTING_LOADS = [
  { id: "sa1", type: "smallAppliance", label: "Small appliance 1" },
  { id: "sa2", type: "smallAppliance", label: "Small appliance 2" },
  { id: "la", type: "laundry", label: "Laundry" },
  { id: "range", type: "range", label: "Range", nameplateKW: 12, nameplateRead: true },
  { id: "dryer", type: "dryer", label: "Dryer", nameplateKW: 5, nameplateRead: true },
  { id: "wh", type: "waterHeaterTank", label: "Water heater", nameplateKW: 4.5, nameplateRead: true },
  { id: "ac", type: "cooling", label: "Central A/C", nameplateVA: 5760, nameplateRead: true },
];

const check = (id: string, newLoads: Record<string, unknown>[], serviceAmps = 100) => ({
  id,
  propertyId,
  serviceAmps,
  floorAreaSqFt: 1500,
  loads: EXISTING_LOADS,
  newLoads,
});

/**
 * A 48 A EVSE on a 100 A service — the case that makes 220.83 worth running.
 * Everything past the first 8 kVA is staged at 40%, so this clears on paper at
 * 100 A even though the connected load is nearly 48 kVA. Quote the addition.
 */
const nearMiss = (id = CHECK_ID) =>
  check(id, [{ id: "evse", type: "evse", label: "48 A EVSE", amps: 48, volts: 240, nameplateRead: true }]);

/**
 * A new heat pump on the same service — 220.83(B), where the HVAC comes off the
 * staged pile and lands at 100%. This is the one that doesn't clear.
 */
const overloaded = (id: string) =>
  check(id, [
    {
      id: "hp", type: "heatPump", label: "New 5-ton heat pump",
      heatPump: { compressorVA: 6000, supplementalVA: 15000, lockout: false },
      nameplateRead: true,
    },
  ]);

const bigService = (id: string) => check(id, [], 400);

beforeAll(async () => {
  const customer = await prisma.customer.create({ data: { name: "Capacity Test Customer" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: {
      customerId,
      name: "Capacity Test House",
      addressLine1: "77 Ampacity Ave",
      city: "Murfreesboro",
      state: "TN",
      postalCode: "37127",
    },
  });
  propertyId = property.id;
});

beforeEach(async () => {
  await prisma.capacityCheck.deleteMany({ where: { propertyId } });
  await prisma.visit.deleteMany({ where: { propertyId } });
});

afterAll(async () => {
  await prisma.capacityCheck.deleteMany({ where: { propertyId } });
  await prisma.visit.deleteMany({ where: { propertyId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
});

describe("POST /capacity-checks", () => {
  it("clears a 48 A EVSE on a 100 A service — the reason to run 220.83 first", async () => {
    // Nearly 48 kVA of connected load, and it still calculates to 100 A, because
    // 220.83(A) stages everything past the first 8 kVA at 40%. Quoting a service
    // upgrade here would be selling something the code says isn't needed.
    const res = await request(app).post("/health-record-admin/capacity-checks").send(nearMiss()).expect(201);
    expect(res.body.method).toBe("220.83");
    expect(res.body.variant).toBe("A"); // an EVSE is not A/C or space heat
    expect(res.body.amps).toBe(100);
    expect(res.body.fits).toBe(true);
    expect(res.body.nextStep).toBe("quote_addition");
    expect(res.body.citation).toContain("220.83(A)");
  });

  it("switches to 220.83(B) and fails on new HVAC", async () => {
    const res = await request(app).post("/health-record-admin/capacity-checks").send(overloaded("cap-hp")).expect(201);
    expect(res.body.variant).toBe("B");
    expect(res.body.fits).toBe(false);
    expect(res.body.nextStep).toBe("quote_service_upgrade");
    expect(res.body.citation).toContain("220.83(B)");
  });

  it("tells you to quote the addition when the service clears", async () => {
    const res = await request(app).post("/health-record-admin/capacity-checks").send(bigService("cap-big")).expect(201);
    expect(res.body.fits).toBe(true);
    expect(res.body.nextStep).toBe("quote_addition");
  });

  it("is idempotent on the client UUID", async () => {
    await request(app).post("/health-record-admin/capacity-checks").send(nearMiss()).expect(201);
    await request(app).post("/health-record-admin/capacity-checks").send(nearMiss()).expect(201);
    const rows = await prisma.capacityCheck.findMany({ where: { propertyId } });
    expect(rows.length).toBe(1);
  });

  it("recomputes server-side rather than trusting a verdict from the client", async () => {
    // The gate below reads `fits` off this row. If a client could write it, a
    // client could unlock a priced study by claiming failure.
    await request(app)
      .post("/health-record-admin/capacity-checks")
      .send({ ...bigService("cap-liar"), fits: false, calculatedAmps: 999 })
      .expect(201);
    const row = await prisma.capacityCheck.findUniqueOrThrow({ where: { id: "cap-liar" } });
    expect(row.fits).toBe(true);
    expect(row.calculatedAmps).toBeLessThan(400);
  });

  it("404s on an unknown property", async () => {
    await request(app)
      .post("/health-record-admin/capacity-checks")
      .send({ ...nearMiss("cap-nowhere"), propertyId: "does-not-exist" })
      .expect(404);
  });
});

describe("the A2 calculation joins the same history", () => {
  // An assessment and a phone quote must read from one list. Two stores is how
  // two Red Cedar documents end up quoting different amperages for one service.
  // Its own address: the suite-level beforeEach clears visits at the shared
  // property, and a HealthInspection holds a Restrict reference to its visit.
  let a2CustomerId: string;
  let a2PropertyId: string;
  let technicianId: string;
  let techToken: string;
  let visitId: string;
  const INSPECTION_ID = "cap-a2-inspection-0001";

  const loadCalc = {
    input: {
      mode: "tech",
      occupancy: "dwellingSingleFamily",
      serviceAmps: 100,
      serviceVoltage: 240,
      floorAreaSqFt: 1500,
      loads: EXISTING_LOADS,
      futureLoads: [
        { id: "evse", type: "evse", label: "48 A EVSE", amps: 48, volts: 240, nameplateRead: true },
      ],
    },
    result: { governingAmps: 109 },
  };

  const push = (overrides: Record<string, unknown> = {}) => ({
    inspectionId: INSPECTION_ID,
    visitId,
    jurisdictionId: "murfreesboro",
    inspectionDate: "2026-08-01T15:30:00Z",
    schemaVersion: "v2",
    scope: "phase1",
    itemsAssessed: 1,
    criticalFindings: [],
    contractorReviewed: false,
    items: [{ itemId: "A2", result: "PASS", measured: {}, photoIds: [] }],
    loadCalc,
    ...overrides,
  });

  beforeAll(async () => {
    const tech = await request(app)
      .post("/health-record-admin/technicians")
      .send({ name: "Capacity A2 Tech" })
      .expect(201);
    technicianId = tech.body.id;
    techToken = tech.body.accessToken;

    const customer = await prisma.customer.create({ data: { name: "Capacity A2 Customer" } });
    a2CustomerId = customer.id;
    const property = await prisma.property.create({
      data: {
        customerId: a2CustomerId,
        name: "Capacity A2 House",
        addressLine1: "12 Calculation Court",
        city: "Murfreesboro",
        state: "TN",
        postalCode: "37127",
      },
    });
    a2PropertyId = property.id;

    const visit = await prisma.visit.create({
      data: { propertyId: a2PropertyId, customerId: a2CustomerId, mode: "diagnostic", status: "scheduled" },
    });
    visitId = visit.id;
    await request(app)
      .post(`/health-record-admin/visits/${visitId}/assign`)
      .send({ technicianId })
      .expect(201);
  });

  beforeEach(async () => {
    await prisma.capacityCheck.deleteMany({ where: { propertyId: a2PropertyId } });
    await prisma.healthInspection.deleteMany({ where: { propertyId: a2PropertyId } });
  });

  afterAll(async () => {
    await prisma.capacityCheck.deleteMany({ where: { propertyId: a2PropertyId } });
    await prisma.healthInspection.deleteMany({ where: { propertyId: a2PropertyId } });
    await prisma.visitAssignment.deleteMany({ where: { visitId } });
    await prisma.technician.deleteMany({ where: { id: technicianId } });
    await prisma.visit.deleteMany({ where: { id: visitId } });
    await prisma.property.deleteMany({ where: { id: a2PropertyId } });
    await prisma.customer.deleteMany({ where: { id: a2CustomerId } });
  });

  it("files the A2 calculation as a capacity check on the same property", async () => {
    await request(app)
      .post("/health-record/inspections")
      .set("Authorization", `Bearer ${techToken}`)
      .send(push())
      .expect(201);

    const rows = await prisma.capacityCheck.findMany({
      where: { propertyId: a2PropertyId, sourceInspectionId: INSPECTION_ID },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].method).toBe("220.83");
    expect(rows[0].variant).toBe("A");
    // The panel's future loads are 220.83's new loads — same list, same question.
    expect(rows[0].newLoadLabel).toContain("48 A EVSE");
    expect(rows[0].calculatedAmps).toBe(100);
  });

  it("reconciles on re-push instead of stacking a new calculation each retry", async () => {
    // The offline queue replays. An account should not accumulate one
    // calculation per retry.
    await request(app)
      .post("/health-record/inspections")
      .set("Authorization", `Bearer ${techToken}`)
      .send(push())
      .expect(201);
    await request(app)
      .post("/health-record/inspections")
      .set("Authorization", `Bearer ${techToken}`)
      .send(push())
      .expect(201);

    const rows = await prisma.capacityCheck.findMany({
      where: { propertyId: a2PropertyId, sourceInspectionId: INSPECTION_ID },
    });
    expect(rows.length).toBe(1);
  });

  it("still accepts a record whose load calc is unusable", async () => {
    // A malformed loadCalc from an old bundle must not cost a technician the
    // whole record — the assessment is the thing that matters.
    await request(app)
      .post("/health-record/inspections")
      .set("Authorization", `Bearer ${techToken}`)
      .send(push({ inspectionId: "cap-a2-bad-0001", loadCalc: { input: { nonsense: true } } }))
      .expect(201);

    const inspection = await prisma.healthInspection.findUnique({ where: { id: "cap-a2-bad-0001" } });
    expect(inspection).not.toBeNull();
    const rows = await prisma.capacityCheck.findMany({
      where: { sourceInspectionId: "cap-a2-bad-0001" },
    });
    expect(rows.length).toBe(0);

    await prisma.healthInspection.deleteMany({ where: { id: "cap-a2-bad-0001" } });
  });

  it("marks where each calculation came from, so their weight is distinguishable", async () => {
    await request(app)
      .post("/health-record/inspections")
      .set("Authorization", `Bearer ${techToken}`)
      .send(push())
      .expect(201);
    // A quote run against the same address, so both land in one history.
    await request(app)
      .post("/health-record-admin/capacity-checks")
      .send({ ...nearMiss("cap-a2-standalone"), propertyId: a2PropertyId })
      .expect(201);

    const all = await prisma.capacityCheck.findMany({ where: { propertyId: a2PropertyId } });
    const fromRecord = all.filter((row) => row.sourceInspectionId !== null);
    const quoted = all.filter((row) => row.sourceInspectionId === null);
    expect(fromRecord.length).toBe(1);
    expect(quoted.length).toBe(1);
  });
});

describe("POST /capacity-checks/:id/order-demand-study", () => {
  const order = {
    customerDeclinedUpgrade: true,
    customerStatement: "I'd rather pay for the study than replace the panel right now.",
    startDate: "2026-09-01",
  };

  it("refuses when the 220.83 check already cleared the service", async () => {
    await request(app).post("/health-record-admin/capacity-checks").send(bigService("cap-passes")).expect(201);
    const res = await request(app)
      .post("/health-record-admin/capacity-checks/cap-passes/order-demand-study")
      .send(order)
      .expect(409);
    expect(res.body.error).toContain("Quote the addition");
  });

  it("refuses without the customer's explicit acknowledgement", async () => {
    await request(app).post("/health-record-admin/capacity-checks").send(overloaded(CHECK_ID)).expect(201);
    await request(app)
      .post(`/health-record-admin/capacity-checks/${CHECK_ID}/order-demand-study`)
      .send({ startDate: "2026-09-01", customerStatement: "sure" })
      .expect(422);
  });

  it("creates two scheduled visits 31 days apart when the rule is satisfied", async () => {
    // Two trips is the honest shape of this service, and putting the delay on
    // the calendar is how everyone sees what it costs in time.
    await request(app).post("/health-record-admin/capacity-checks").send(overloaded(CHECK_ID)).expect(201);
    const res = await request(app)
      .post(`/health-record-admin/capacity-checks/${CHECK_ID}/order-demand-study`)
      .send(order)
      .expect(201);

    expect(res.body.recordingWindow).toEqual({
      start: "2026-09-01",
      end: "2026-10-02",
      days: 31,
    });

    const install = await prisma.visit.findUniqueOrThrow({ where: { id: res.body.installVisitId } });
    const removal = await prisma.visit.findUniqueOrThrow({ where: { id: res.body.removalVisitId } });
    expect(install.jobType).toContain("recorder install");
    expect(removal.jobType).toContain("removal & calculation");
    // The customer's own words, and the sunk-cost warning, ride on the job.
    expect(install.notes).toContain("rather pay for the study");
    expect(install.notes).toContain("study fee is spent");
  });

  it("refuses to order the same study twice", async () => {
    await request(app).post("/health-record-admin/capacity-checks").send(overloaded(CHECK_ID)).expect(201);
    await request(app).post(`/health-record-admin/capacity-checks/${CHECK_ID}/order-demand-study`).send(order).expect(201);
    await request(app).post(`/health-record-admin/capacity-checks/${CHECK_ID}/order-demand-study`).send(order).expect(409);
  });
});

describe("POST /capacity-checks/:id/complete-demand-study", () => {
  const order = {
    customerDeclinedUpgrade: true,
    customerStatement: "Try the study first.",
    startDate: "2026-09-01",
  };

  async function orderedCheck() {
    await request(app).post("/health-record-admin/capacity-checks").send(overloaded(CHECK_ID)).expect(201);
    await request(app).post(`/health-record-admin/capacity-checks/${CHECK_ID}/order-demand-study`).send(order).expect(201);
  }

  it("writes a new 220.87 record rather than editing the 220.83 one", async () => {
    // Both calculations were issued, under different code sections. Overwriting
    // one with the other would erase what the customer was actually told.
    await orderedCheck();
    const res = await request(app)
      .post(`/health-record-admin/capacity-checks/${CHECK_ID}/complete-demand-study`)
      .send({
        id: "cap-study-result",
        measuredMaxDemandVA: 9600,
        source: "recorded_30day",
        recordedDays: 31,
        intervalMinutes: 15,
        windowStart: "2026-09-01",
        windowEnd: "2026-10-02",
      })
      .expect(201);

    expect(res.body.method).toBe("220.87");
    expect(res.body.qualifies).toBe(true);
    // 9600 × 1.25 = 12 000 VA existing + 21 000 VA heat pump = 33 000 VA ÷ 240 = 138 A.
    expect(res.body.amps).toBe(138);
    // The sunk-cost case, and the reason not to sell this study casually: thirty
    // days later the service still doesn't take the load, the upgrade is needed
    // anyway, and the study fee is spent.
    expect(res.body.fits).toBe(false);
    expect(res.body.nextStep).toBe("quote_service_upgrade");

    const original = await prisma.capacityCheck.findUniqueOrThrow({ where: { id: CHECK_ID } });
    expect(original.method).toBe("220.83");
    expect(original.fits).toBe(false);

    const study = await prisma.capacityCheck.findUniqueOrThrow({ where: { id: "cap-study-result" } });
    expect(study.supersedesId).toBe(CHECK_ID);
  });

  it("reports data that does not meet 220.87 rather than producing a number", async () => {
    await orderedCheck();
    const res = await request(app)
      .post(`/health-record-admin/capacity-checks/${CHECK_ID}/complete-demand-study`)
      .send({
        id: "cap-study-short",
        measuredMaxDemandVA: 9600,
        source: "recorded_30day",
        recordedDays: 18,
        intervalMinutes: 60,
      })
      .expect(201);

    expect(res.body.qualifies).toBe(false);
    expect(res.body.nextStep).toBe("data_insufficient");
    expect(res.body.disqualifications.length).toBe(2);
  });

  it("refuses when no study was ordered", async () => {
    await request(app).post("/health-record-admin/capacity-checks").send(overloaded(CHECK_ID)).expect(201);
    await request(app)
      .post(`/health-record-admin/capacity-checks/${CHECK_ID}/complete-demand-study`)
      .send({ id: "cap-orphan", measuredMaxDemandVA: 9600, source: "utility_12mo", monthsOfData: 12 })
      .expect(409);
  });
});
