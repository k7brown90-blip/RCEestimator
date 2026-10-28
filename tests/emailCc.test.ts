/**
 * CC on every CRM send (Kyle, 2026-10-24: "I need to be able to send emails to multiple recipients
 * at once." / "The email will be the same as doing a CC email.").
 *
 * One message, one To, any number of CCs - through the REAL mail pipe (Resend fetch stubbed,
 * nodemailer mocked, never real network). Pins:
 *   1. The CC list reaches the Resend body as `cc`, and the Gmail fallback gets it too.
 *   2. No CC = no `cc` key on the wire (the byte-identical default every other test relies on).
 *   3. The EmailDelivery row records the CC list.
 *   4. A CC equal to the To (any case) is dropped, repeats collapse, addresses are lower-cased.
 *   5. A bad CC is refused with a message that names it - nothing is sent.
 *   6. The estimate send and the invoice send both carry it; IssuedEstimate.sentTo stays the To
 *      address only; the trail event names everyone.
 *   7. The field door (same sendEstimateEmailFromBody) still works with no cc at all.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

process.env.GMAIL_USER = "service@example.test";
process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
process.env.RESEND_API_KEY = "re_test_key_never_used";
delete process.env.TRANSACTIONAL_EMAIL_PROVIDER;

vi.mock("../src/services/twilio");
vi.mock("googleapis");

const mail = vi.hoisted(() => ({ sendMail: vi.fn<(opts: Record<string, unknown>) => Promise<unknown>>() }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: mail.sendMail }) } }));

const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

function resendOk(id: string): Response {
  return new Response(JSON.stringify({ id }), { status: 200, headers: { "Content-Type": "application/json" } });
}

import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { sendInvoiceEmail, sendEstimateEmailFromBody } from "../src/services/issuedEstimateSend";
import { cleanCc } from "../src/services/emailCc";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const RUN = Date.now();
const DOMAIN = `cctest-${RUN}.example`;
const TAG = "CcTest";
const ITEM = "CCT001";

let accountId: string;
let propertyId: string;
let visitId: string;
let leadId: string;
const draftIds: string[] = [];
const estimateIds: string[] = [];

function lastResendBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("nothing was sent to Resend");
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
}

async function newIssuedEstimate(title: string) {
  const d = await createDraft(prisma, { title: `${TAG} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, quantitySource: "COUNT" });
  const g = await graduateDraft(prisma, { draftId: d.id, accountId, serviceAddressId: propertyId });
  if (!g.ok) throw new Error(`fixture estimate failed to graduate: ${JSON.stringify(g)}`);
  estimateIds.push(g.estimateId);
  return g.estimateId;
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ITEM)]);
  const account = await prisma.customer.create({ data: { name: `${TAG} Account`, email: `owner@${DOMAIN}`, phone: "615-555-0191" } });
  accountId = account.id;
  const property = await prisma.property.create({
    data: { customerId: accountId, name: `${TAG} House`, addressLine1: "7 Copy Way", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({ data: { customerId: accountId, propertyId, mode: "onsite", purpose: `${TAG} job`, status: "estimate" } });
  visitId = visit.id;
  const lead = await prisma.lead.create({ data: { name: `${TAG} Lead`, email: `lead@${DOMAIN}`, source: "web" } });
  leadId = lead.id;
});

afterAll(async () => {
  await prisma.emailDelivery.deleteMany({ where: { to: { endsWith: `@${DOMAIN}` } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estimateIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estimateIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estimateIds } }, data: { supersedesId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estimateIds } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.lead.deleteMany({ where: { id: leadId } });
  await prisma.visit.deleteMany({ where: { customerId: accountId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: accountId } });
  await deleteAtomics([ITEM]);
  await prisma.$disconnect();
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(resendOk(`cctest_${RUN}_${Math.random()}`));
  mail.sendMail.mockReset();
  mail.sendMail.mockResolvedValue({});
});

describe("cleanCc", () => {
  it("lower-cases, de-dupes, drops the To in any case, and refuses a malformed address by name", () => {
    expect(cleanCc(["A@x.com", "a@X.com", "TO@x.com", " b@x.com "], "to@x.com")).toEqual({ ok: true, cc: ["a@x.com", "b@x.com"] });
    expect(cleanCc(undefined, "to@x.com")).toEqual({ ok: true, cc: [] });
    const bad = cleanCc(["fine@x.com", "not an address"], "to@x.com");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("not an address");
  });
});

describe("POST /communications/email with cc", () => {
  it("puts the CC list on the Resend body, records it on the EmailDelivery row, and answers with it", async () => {
    const res = await request(app)
      .post("/communications/email")
      .send({ target: "account", id: accountId, cc: [`pm@${DOMAIN}`, `Books@${DOMAIN}`], subject: "Your quote", body: "Any questions, just reply." })
      .expect(200);

    expect(res.body).toMatchObject({ sent: true, to: `owner@${DOMAIN}`, cc: [`pm@${DOMAIN}`, `books@${DOMAIN}`] });
    const body = lastResendBody();
    expect(body.to).toEqual([`owner@${DOMAIN}`]);
    expect(body.cc).toEqual([`pm@${DOMAIN}`, `books@${DOMAIN}`]);

    const rows = await prisma.emailDelivery.findMany({ where: { customerId: accountId, subject: "Your quote" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].to).toBe(`owner@${DOMAIN}`);
    expect(rows[0].cc).toEqual([`pm@${DOMAIN}`, `books@${DOMAIN}`]);

    // The thread the drawers read shows who was CC'd.
    const thread = await request(app).get(`/email-deliveries?customerId=${accountId}`).expect(200);
    expect(thread.body.find((r: { subject: string }) => r.subject === "Your quote").cc).toEqual([`pm@${DOMAIN}`, `books@${DOMAIN}`]);
  });

  it("sends NO cc key when there is no CC", async () => {
    await request(app).post("/communications/email").send({ target: "lead", id: leadId, subject: "No cc", body: "Hello." }).expect(200);
    expect(Object.keys(lastResendBody())).not.toContain("cc");
    const row = await prisma.emailDelivery.findFirst({ where: { leadId, subject: "No cc" } });
    expect(row!.cc).toEqual([]);
  });

  it("drops a CC that equals the To (any case) and collapses repeats", async () => {
    const res = await request(app)
      .post("/communications/email")
      .send({ target: "lead", id: leadId, cc: [`LEAD@${DOMAIN}`, `x@${DOMAIN}`, `X@${DOMAIN}`], subject: "Dedupe", body: "Hello." })
      .expect(200);
    expect(res.body.cc).toEqual([`x@${DOMAIN}`]);
    expect(lastResendBody().cc).toEqual([`x@${DOMAIN}`]);
  });

  it("refuses a malformed CC with a 400 that names the problem, and sends nothing", async () => {
    const res = await request(app)
      .post("/communications/email")
      .send({ target: "lead", id: leadId, cc: ["not-an-address"], subject: "Bad cc", body: "Hello." })
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/CC address is not a valid email/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses more than ten CCs", async () => {
    const many = Array.from({ length: 11 }, (_, i) => `c${i}@${DOMAIN}`);
    await request(app).post("/communications/email").send({ target: "lead", id: leadId, cc: many, subject: "Many", body: "Hello." }).expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the Gmail fallback carries the CC too", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await request(app)
      .post("/communications/email")
      .send({ target: "lead", id: leadId, cc: [`gm@${DOMAIN}`], subject: "Gmail path", body: "Hello." })
      .expect(200);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(mail.sendMail.mock.calls[0][0]).toMatchObject({ to: `lead@${DOMAIN}`, cc: [`gm@${DOMAIN}`] });
  });
});

describe("estimate and invoice sends with cc", () => {
  // 2026-10-27 (one email tool): the estimate and invoice sends are POST /customer-emails { kind }; the
  // routes /issued-estimates/:id/send and /send-invoice these cases used to hit are gone.
  it("POST /customer-emails (estimate) carries the CC, keeps sentTo as the To address, and names everyone on the trail", async () => {
    const id = await newIssuedEstimate("estimate cc");
    const res = await request(app)
      .post("/customer-emails")
      .send({ kind: "estimate", estimateId: id, to: `tenant@${DOMAIN}`, cc: [`owner@${DOMAIN}`, `TENANT@${DOMAIN}`] })
      .expect(200);

    expect(res.body).toMatchObject({ sent: true, kind: "estimate", to: `tenant@${DOMAIN}`, cc: [`owner@${DOMAIN}`] });
    const body = lastResendBody();
    expect(body.to).toEqual([`tenant@${DOMAIN}`]);
    expect(body.cc).toEqual([`owner@${DOMAIN}`]);

    const est = await prisma.issuedEstimate.findUnique({ where: { id } });
    expect(est!.sentTo).toBe(`tenant@${DOMAIN}`);
    const event = await prisma.issuedEstimateEvent.findFirst({ where: { estimateId: id, type: "sent" } });
    expect(event!.detail).toContain(`Emailed to tenant@${DOMAIN} · cc owner@${DOMAIN}`);
    const delivery = await prisma.emailDelivery.findFirst({ where: { issuedEstimateId: id } });
    expect(delivery!.cc).toEqual([`owner@${DOMAIN}`]);
  });

  it("a bad CC on the estimate send is a 400 and nothing goes out", async () => {
    const id = await newIssuedEstimate("estimate bad cc");
    const res = await request(app).post("/customer-emails").send({ kind: "estimate", estimateId: id, cc: ["nope"] }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/CC address is not a valid email/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an estimate send with no cc is unchanged: no cc key, empty list recorded, event text has no 'cc'", async () => {
    const id = await newIssuedEstimate("estimate no cc");
    await request(app).post("/customer-emails").send({ kind: "estimate", estimateId: id }).expect(200);
    expect(Object.keys(lastResendBody())).not.toContain("cc");
    const event = await prisma.issuedEstimateEvent.findFirst({ where: { estimateId: id, type: "sent" } });
    expect(event!.detail).not.toContain(" · cc ");
    const delivery = await prisma.emailDelivery.findFirst({ where: { issuedEstimateId: id } });
    expect(delivery!.cc).toEqual([]);
  });

  it("the field door (sendEstimateEmailFromBody) works with no cc", async () => {
    const id = await newIssuedEstimate("field door");
    const result = await sendEstimateEmailFromBody(prisma, id, {}, "tech:test");
    expect(result).toMatchObject({ ok: true, to: `owner@${DOMAIN}`, cc: [] });
  });

  it("POST /customer-emails (invoice) carries the CC and names everyone on the trail", async () => {
    const id = await newIssuedEstimate("invoice cc");
    await prisma.issuedEstimate.update({ where: { id }, data: { signedAt: new Date() } });

    const res = await request(app)
      .post("/customer-emails")
      .send({ kind: "invoice", estimateId: id, to: `tenant@${DOMAIN}`, cc: [`owner@${DOMAIN}`, `bk@${DOMAIN}`] })
      .expect(200);
    expect(res.body).toMatchObject({ sent: true, kind: "invoice", to: `tenant@${DOMAIN}`, cc: [`owner@${DOMAIN}`, `bk@${DOMAIN}`] });
    expect(lastResendBody().cc).toEqual([`owner@${DOMAIN}`, `bk@${DOMAIN}`]);
    const event = await prisma.issuedEstimateEvent.findFirst({ where: { estimateId: id, type: "invoice_sent" } });
    expect(event!.detail).toContain(`Invoice emailed to tenant@${DOMAIN} · cc owner@${DOMAIN}, bk@${DOMAIN}`);
  });

  it("a bad CC straight into sendInvoiceEmail is refused by name (the service re-checks, not only the route)", async () => {
    const id = await newIssuedEstimate("invoice bad cc");
    await prisma.issuedEstimate.update({ where: { id }, data: { signedAt: new Date() } });
    const result = await sendInvoiceEmail(prisma, id, { sentBy: "test", cc: ["no way"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no way");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
