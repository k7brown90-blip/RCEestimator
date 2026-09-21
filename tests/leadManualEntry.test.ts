import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  await prisma.emailListMember.deleteMany({ where: { email: { contains: "lme-" } } });
  await prisma.emailSuppression.deleteMany({ where: { email: { contains: "lme-" } } });
  await prisma.systemEvent.deleteMany({ where: { source: "leads-won" } });
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

  it("refuses status:\"converted\" — conversion is its own endpoint", async () => {
    // Dashboard's old "Mark Won" button PATCHed status:"converted" directly here,
    // minting a converted lead with no account/property/job behind it — and a
    // converted lead can never be deleted (2026-09-20 drawers plan).
    const created = await request(app).post("/crm/leads").send(newLead()).expect(201);
    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}`)
      .send({ status: "converted" })
      .expect(400);
    expect(res.body.error).toMatch(/convert/i);

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: created.body.lead.id } });
    expect(after.status).not.toBe("converted");
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

/**
 * CONVERTING A LEAD MAKES AN OPPORTUNITY (Kyle, 2026-09-20, the four-phase funnel).
 *
 * "When a lead gets converted it should be considered an opportunity." Two of his three rulings
 * land here: the platform is carried onto the Customer at convert (ruling 1 — without it phase 4
 * of the funnel can never be read by phase 1's dimension), and converting enrols the account on
 * the newsletter list (ruling 2 — that enrolment is part of what MAKES it an opportunity).
 */
describe("converting a lead makes an opportunity", () => {
  const defaultListMember = (email: string) =>
    prisma.emailListMember.findFirst({ where: { email } });

  it("carries the platform onto a NEW account", async () => {
    const created = await request(app)
      .post("/crm/leads")
      .send(newLead({ name: `${TAG} Google Lead`, platform: "google" }))
      .expect(201);
    expect(created.body.lead.platform).toBe("google");

    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}/convert`)
      .send({ createNewAccount: true })
      .expect(200);

    expect(res.body.customer.platform).toBe("google");
  });

  it("leaves an existing account's platform alone — it is an acquisition fact, not the latest lead's", async () => {
    // An account that already exists was acquired earlier, by definition. Stamping it with this
    // lead's platform (most often "repeat_customer") would make phase 4 read its own output.
    const tagged = await prisma.customer.create({
      data: { name: `${TAG} Tagged`, phone: "615-555-0301", platform: "yelp" },
    });
    const untagged = await prisma.customer.create({
      data: { name: `${TAG} Untagged`, phone: "615-555-0302" },
    });

    for (const account of [tagged, untagged]) {
      const created = await request(app)
        .post("/crm/leads")
        .send(newLead({ name: `${TAG} Repeat ${account.id}`, platform: "repeat_customer" }))
        .expect(201);
      await request(app)
        .patch(`/leads/${created.body.lead.id}/convert`)
        .send({ customerId: account.id })
        .expect(200);
    }

    expect((await prisma.customer.findUniqueOrThrow({ where: { id: tagged.id } })).platform).toBe("yelp");
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: untagged.id } })).platform).toBeNull();
  });

  it("adds the account to the newsletter list", async () => {
    const created = await request(app)
      .post("/crm/leads")
      .send(newLead({ name: `${TAG} Newsletter`, email: "lme-newsletter@example.com" }))
      .expect(201);

    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}/convert`)
      .send({ createNewAccount: true })
      .expect(200);

    expect(res.body.newsletter.enrolled).toBe(true);
    const member = await defaultListMember("lme-newsletter@example.com");
    expect(member).not.toBeNull();
    expect(member!.leadId).toBe(created.body.lead.id);
  });

  it("never re-adds an address that unsubscribed, and converts anyway", async () => {
    await prisma.emailSuppression.create({ data: { email: "lme-gone@example.com" } });
    const created = await request(app)
      .post("/crm/leads")
      .send(newLead({ name: `${TAG} Unsubscribed`, email: "lme-gone@example.com" }))
      .expect(201);

    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}/convert`)
      .send({ createNewAccount: true })
      .expect(200);

    // The opportunity is real; only the mailing list declined.
    expect(res.body.visit.id).toBeTruthy();
    expect(res.body.newsletter).toEqual(expect.objectContaining({ enrolled: false, reason: "unsubscribed" }));
    expect(await defaultListMember("lme-gone@example.com")).toBeNull();
  });

  it("says there was no email rather than implying it enrolled", async () => {
    const created = await request(app)
      .post("/crm/leads")
      .send(newLead({ name: `${TAG} No Email`, email: null }))
      .expect(201);

    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}/convert`)
      .send({ createNewAccount: true })
      .expect(200);

    expect(res.body.newsletter).toEqual({ enrolled: false, reason: "no_email" });
  });
});

/**
 * PATCH /leads/:id/won — the automation door (PUNCHLIST A2).
 *
 * It used to write `status: "converted"` with no account, property or job behind it: the same
 * orphan-lead bug the Dashboard's "Mark Won" had, on a webhook-secret route with no consumer in
 * this repo. Kyle's ruling 3: make it CONVERT, return a clear error when it cannot, and log every
 * call so the closing audit can see whether anything calls it at all.
 */
describe("PATCH /leads/:id/won", () => {
  const SECRET = "lme-webhook-secret";
  let previousSecret: string | undefined;

  beforeAll(() => {
    previousSecret = process.env.WEBHOOK_SECRET;
    process.env.WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = previousSecret;
  });

  /** logSystemEvent is fire-and-forget, so the row lands just after the response. */
  const wonEvents = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const rows = await prisma.systemEvent.findMany({ where: { source: "leads-won" } });
      if (rows.length > 0) return rows;
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    return prisma.systemEvent.findMany({ where: { source: "leads-won" } });
  };

  it("still requires the webhook secret", async () => {
    const created = await request(app).post("/crm/leads").send(newLead({ name: `${TAG} NoSecret` })).expect(201);
    await request(app).patch(`/leads/${created.body.lead.id}/won`).send({}).expect(401);
  });

  it("converts the lead instead of stamping a status onto nothing", async () => {
    const created = await request(app)
      .post("/crm/leads")
      .send(newLead({ name: `${TAG} Automation`, platform: "angi" }))
      .expect(201);

    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}/won`)
      .set("webhook_secret", SECRET)
      .send({})
      .expect(200);

    // The lead row is still the response, so an external caller reads the same fields.
    expect(res.body.id).toBe(created.body.lead.id);
    expect(res.body.status).toBe("converted");
    // And an account, an address and a job now exist behind it.
    expect(res.body.opportunity.customer.platform).toBe("angi");
    expect(res.body.opportunity.property.addressLine1).toBe("220 Oak St");
    expect(res.body.opportunity.visit.id).toBeTruthy();
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: created.body.lead.id } });
    expect(lead.customerId).toBe(res.body.opportunity.customer.id);
    expect(lead.visitId).toBe(res.body.opportunity.visit.id);
  });

  it("refuses with a clear error when there is no address, writing nothing", async () => {
    const created = await request(app)
      .post("/crm/leads")
      .send({ name: `${TAG} Addressless`, phone: "615-555-0303" })
      .expect(201);
    const before = await countCustomers();

    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}/won`)
      .set("webhook_secret", SECRET)
      .send({})
      .expect(400);

    expect(res.body.needs).toBe("address");
    expect(await countCustomers()).toBe(before);
    // Nothing was written, so the lead is still fixable and still deletable.
    await request(app).delete(`/leads/${created.body.lead.id}`).expect(204);
  });

  it("refuses when the account might already exist", async () => {
    await prisma.customer.create({ data: { name: `${TAG} Existing`, phone: PHONE_STORED } });
    const created = await request(app).post("/crm/leads").send(newLead({ name: `${TAG} Duplicate` })).expect(201);

    const res = await request(app)
      .patch(`/leads/${created.body.lead.id}/won`)
      .set("webhook_secret", SECRET)
      .send({})
      .expect(409);

    expect(res.body.error).toBe("Possible duplicate account");
    expect(res.body.matches[0].name).toBe(`${TAG} Existing`);
  });

  it("logs every call, so the closing audit can see whether anything calls it", async () => {
    const created = await request(app).post("/crm/leads").send(newLead({ name: `${TAG} Logged` })).expect(201);
    await request(app).patch(`/leads/${created.body.lead.id}/won`).set("webhook_secret", SECRET).send({}).expect(200);

    const events = await wonEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].route).toBe("PATCH /leads/:id/won");
    expect(events[0].detailsJson).toContain(created.body.lead.id);
  });
});
