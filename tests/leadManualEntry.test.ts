import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/services/twilio");
vi.mock("googleapis");

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

/**
 * Manual lead entry, and conversion without minting duplicate accounts.
 *
 * Its own file, not added to leadsPipeline.test.ts: that file's partition test
 * hard-codes eight leads and its whole value is that the number is written down.
 * `fileParallelism: false` means these two files never overlap in time, and each
 * wipes in its own beforeEach.
 */

const TAG = "LME";
const PHONE_STORED = "(615) 555-0142"; // deliberately punctuated — see below
const PHONE_TYPED = "615-555-0142";     // a third formatting of the same number

async function wipe() {
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.visit.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.systemSnapshot.deleteMany({ where: { property: { customer: { name: { startsWith: TAG } } } } });
  await prisma.property.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
}

beforeEach(wipe);
afterAll(wipe);

const newLead = (overrides: Record<string, unknown> = {}) => ({
  name: `${TAG} Household`,
  phone: PHONE_TYPED,
  addressLine1: "220 Oak St",
  city: "Smyrna",
  state: "TN",
  postalCode: "37167",
  jobType: "Panel upgrade",
  ...overrides,
});

const countCustomers = () => prisma.customer.count({ where: { name: { startsWith: TAG } } });

describe("POST /crm/leads", () => {
  it("creates a lead by hand", async () => {
    const res = await request(app).post("/crm/leads").send(newLead()).expect(201);
    expect(res.body.lead.name).toBe(`${TAG} Household`);
    expect(res.body.lead.source).toBe("manual");
    expect(res.body.lead.status).toBe("new");
    expect(res.body.lead.city).toBe("Smyrna");
    expect(res.body.lead.state).toBe("TN");
  });

  it("requires a name", async () => {
    await request(app).post("/crm/leads").send({ phone: PHONE_TYPED }).expect(400);
  });

  it("refuses a partial address rather than storing blanks", async () => {
    // The old convert path wrote empty-string city/state/ZIP. This is where that
    // becomes impossible.
    await request(app)
      .post("/crm/leads")
      .send(newLead({ city: undefined }))
      .expect(400)
      .expect((res) => expect(res.body.error).toMatch(/street, city, state and ZIP together/));
  });

  it("accepts a lead with no address at all", async () => {
    // Perfectly normal — someone calls, you take a name and number, the address
    // comes later. It just can't be converted yet.
    const res = await request(app)
      .post("/crm/leads")
      .send({ name: `${TAG} No Address`, phone: PHONE_TYPED })
      .expect(201);
    expect(res.body.lead.addressLine1).toBeNull();
  });

  it("validates the ZIP shape", async () => {
    await request(app).post("/crm/leads").send(newLead({ postalCode: "371" })).expect(400);
  });

  it("refuses to create a lead already marked converted", async () => {
    // Conversion is a transition that creates records, not an initial state.
    await request(app).post("/crm/leads").send(newLead({ status: "converted" })).expect(400);
  });

  it("returns matching accounts alongside the created lead", async () => {
    await prisma.customer.create({ data: { name: `${TAG} Existing`, phone: PHONE_STORED } });
    const res = await request(app).post("/crm/leads").send(newLead()).expect(201);
    expect(res.body.matches.some((m: { name: string }) => m.name === `${TAG} Existing`)).toBe(true);
  });

  it("rejects an address belonging to a different account", async () => {
    const a = await prisma.customer.create({ data: { name: `${TAG} A` } });
    const b = await prisma.customer.create({ data: { name: `${TAG} B` } });
    const property = await prisma.property.create({
      data: {
        customerId: b.id, name: "B's place", addressLine1: "1 Elsewhere",
        city: "Franklin", state: "TN", postalCode: "37064",
      },
    });

    await request(app)
      .post("/crm/leads")
      .send({ name: `${TAG} Crossed`, customerId: a.id, propertyId: property.id })
      .expect(400)
      .expect((res) => expect(res.body.error).toMatch(/different account/));
  });
});

describe("PATCH /leads/:leadId", () => {
  it("404s on an unknown lead instead of 500ing", async () => {
    await request(app).patch("/leads/does-not-exist").send({ name: "x" }).expect(404);
  });

  it("re-points a lead at a known account and address", async () => {
    // The common case: a webhook lead arrives, the owner recognizes the customer.
    const customer = await prisma.customer.create({ data: { name: `${TAG} Known`, phone: PHONE_STORED } });
    const property = await prisma.property.create({
      data: {
        customerId: customer.id, name: "Rental", addressLine1: "220 Oak St",
        city: "Smyrna", state: "TN", postalCode: "37167",
      },
    });
    const created = await request(app).post("/crm/leads").send(newLead()).expect(201);

    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}`)
      .send({ customerId: customer.id, propertyId: property.id })
      .expect(200);
    expect(res.body.customerId).toBe(customer.id);
    expect(res.body.propertyId).toBe(property.id);
  });

  it("evaluates the address against the merged row, not the patch alone", async () => {
    // Clearing one field of a complete address leaves a fragment — which is
    // exactly what the all-or-nothing rule exists to stop.
    const created = await request(app).post("/crm/leads").send(newLead()).expect(201);
    await request(app)
      .patch(`/leads/${created.body.lead.id}`)
      .send({ city: null })
      .expect(400);
  });

  it("rejects a lost reason outside the enum", async () => {
    // The loss report groups by this column; one typo skews it permanently.
    const created = await request(app).post("/crm/leads").send(newLead()).expect(201);
    await request(app)
      .patch(`/leads/${created.body.lead.id}`)
      .send({ status: "lost", lostReason: "vibes" })
      .expect(400);
  });
});

describe("PATCH /leads/:leadId/convert", () => {
  it("uses the structured address verbatim, with no parsing", async () => {
    // The free-text line would parse to somewhere else entirely. Structured wins.
    const created = await request(app)
      .post("/crm/leads")
      .send(newLead({ address: "999 Wrong Way, Nashville, TN 37201" }))
      .expect(201);

    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}/convert`)
      .send({ createNewAccount: true })
      .expect(200);

    expect(res.body.property.addressLine1).toBe("220 Oak St");
    expect(res.body.property.city).toBe("Smyrna");
    expect(res.body.property.postalCode).toBe("37167");
  });

  it("still parses a webhook lead's free-text address", async () => {
    const lead = await prisma.lead.create({
      data: { name: `${TAG} Webhook`, address: "12 Funnel St, Murfreesboro, TN 37130", source: "web" },
    });
    const res = await request(app)
      .patch(`/leads/${lead.id}/convert`)
      .send({ createNewAccount: true })
      .expect(200);

    expect(res.body.property.addressLine1).toBe("12 Funnel St");
    expect(res.body.property.city).toBe("Murfreesboro");
    expect(res.body.property.state).toBe("TN");
    expect(res.body.property.postalCode).toBe("37130");
  });

  it("carries the job type onto the visit", async () => {
    // Convert used to drop it, so a hand-typed job type vanished at exactly the
    // moment it became a job — and the Jobs page reads visit.jobType.
    const created = await request(app).post("/crm/leads").send(newLead()).expect(201);
    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}/convert`)
      .send({ createNewAccount: true })
      .expect(200);
    expect(res.body.visit.jobType).toBe("Panel upgrade");
  });

  it("writes NOTHING when the address is unparseable, and leaves the lead deletable", async () => {
    // Before: a Customer appeared, no Property, no Visit — and because the lead
    // was marked converted, DELETE 409'd on it forever.
    const lead = await prisma.lead.create({
      data: { name: `${TAG} Vague`, address: "somewhere off Rutherford Blvd", source: "phone" },
    });
    const before = await countCustomers();

    await request(app)
      .patch(`/leads/${lead.id}/convert`)
      .send({ createNewAccount: true })
      .expect(400)
      .expect((res) => expect(res.body.needs).toBe("address"));

    expect(await countCustomers()).toBe(before);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe("new");
    await request(app).delete(`/leads/${lead.id}`).expect(204);
  });

  it("writes nothing when there's no address at all", async () => {
    const created = await request(app)
      .post("/crm/leads")
      .send({ name: `${TAG} Bare`, phone: "615-555-0199" })
      .expect(201);
    const before = await countCustomers();

    await request(app)
      .patch(`/leads/${created.body.lead.id}/convert`)
      .send({ createNewAccount: true })
      .expect(400);
    expect(await countCustomers()).toBe(before);
  });

  it("refuses with 409 and the matches when it would mint a duplicate account", async () => {
    // The guard rail. Note the stored number is punctuated and the lead's is
    // hyphenated — neither normalized equality nor a naive `contains` would find
    // this, so a 409 here also proves the matcher.
    await prisma.customer.create({ data: { name: `${TAG} Existing`, phone: PHONE_STORED } });
    const created = await request(app).post("/crm/leads").send(newLead()).expect(201);
    const before = await countCustomers();

    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}/convert`)
      .send({})
      .expect(409);

    expect(res.body.error).toBe("Possible duplicate account");
    expect(res.body.matches[0].name).toBe(`${TAG} Existing`);
    expect(await countCustomers()).toBe(before); // nothing written
  });

  it("creates a second account when told to", async () => {
    await prisma.customer.create({ data: { name: `${TAG} Existing`, phone: PHONE_STORED } });
    const created = await request(app).post("/crm/leads").send(newLead()).expect(201);

    await request(app)
      .patch(`/leads/${created.body.lead.id}/convert`)
      .send({ createNewAccount: true })
      .expect(200);
    expect(await countCustomers()).toBe(2);
  });

  it("adds an address to the existing account instead of duplicating it", async () => {
    // The headline: one account, two addresses, no duplicate.
    const customer = await prisma.customer.create({ data: { name: `${TAG} Existing`, phone: PHONE_STORED } });
    await prisma.property.create({
      data: {
        customerId: customer.id, name: "Main House", addressLine1: "100 Cedar Ln",
        city: "Murfreesboro", state: "TN", postalCode: "37130",
      },
    });
    const created = await request(app).post("/crm/leads").send(newLead()).expect(201);

    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}/convert`)
      .send({ customerId: customer.id })
      .expect(200);

    expect(res.body.customer.id).toBe(customer.id);
    expect(await countCustomers()).toBe(1);
    expect(await prisma.property.count({ where: { customerId: customer.id } })).toBe(2);
    expect(res.body.property.addressLine1).toBe("220 Oak St");
  });

  it("uses an address already on the account without creating a second copy", async () => {
    const customer = await prisma.customer.create({ data: { name: `${TAG} Existing`, phone: PHONE_STORED } });
    const property = await prisma.property.create({
      data: {
        customerId: customer.id, name: "Rental", addressLine1: "220 Oak St",
        city: "Smyrna", state: "TN", postalCode: "37167",
      },
    });
    const created = await request(app).post("/crm/leads").send(newLead()).expect(201);

    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}/convert`)
      .send({ customerId: customer.id, propertyId: property.id })
      .expect(200);

    expect(res.body.property.id).toBe(property.id);
    expect(await prisma.property.count({ where: { customerId: customer.id } })).toBe(1);
    expect(res.body.visit.propertyId).toBe(property.id);
  });

  it("409s on a second conversion", async () => {
    const created = await request(app).post("/crm/leads").send(newLead()).expect(201);
    await request(app).patch(`/leads/${created.body.lead.id}/convert`).send({ createNewAccount: true }).expect(200);
    await request(app).patch(`/leads/${created.body.lead.id}/convert`).send({ createNewAccount: true }).expect(409);
  });

  it("derives the visit mode from the job type", async () => {
    const cases: [string, string][] = [
      ["Kitchen remodel", "remodel"],
      ["New construction wiring", "new_construction"],
      ["Panel swap", "service_diagnostic"],
    ];
    for (const [jobType, mode] of cases) {
      const created = await request(app)
        .post("/crm/leads")
        .send(newLead({ name: `${TAG} ${jobType}`, jobType }))
        .expect(201);
      const res = await request(app)
        .patch(`/leads/${created.body.lead.id}/convert`)
        .send({ createNewAccount: true })
        .expect(200);
      expect(res.body.visit.mode).toBe(mode);
    }
  });

  it("seeds the system snapshot the same way POST /properties does", async () => {
    // Two ways to birth a Property meant two snapshot shapes, and anything
    // parsing deficienciesJson had to handle null on converted properties only.
    const created = await request(app).post("/crm/leads").send(newLead()).expect(201);
    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}/convert`)
      .send({ createNewAccount: true })
      .expect(200);

    const snapshot = await prisma.systemSnapshot.findUniqueOrThrow({
      where: { propertyId: res.body.property.id },
    });
    expect(snapshot.deficienciesJson).toBe("[]");
    expect(snapshot.changeLogJson).toBe("[]");
  });
});
