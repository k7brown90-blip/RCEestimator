/**
 * The JOB COMPLETION REPORT and the paid-in-full RECEIPT (Kyle, 2026-10-29; plan
 * 2026-10-29-receipt-with-reports-and-photos, Unit A).
 *
 * What these pin:
 *   1. The lines are the job's signed invoice - the ROOT and every signed change order - SELECTED
 *      OPTIONS ONLY; each carries its entry or null and the NEC article its price-book item holds
 *      (null-safe: no article, no citation).
 *   2. ONE record, two doors: an entry saved through the technician's route reads back identically
 *      through the CRM's; Clear removes it; a photo from another job, a line of a declined option, an
 *      empty entry and an unassigned technician are all refused.
 *   3. The receipt: refused while anything is owing; once paid in full it goes to the typed To + CC,
 *      names the ROOT invoice (even when asked about a change order), always carries the itemized
 *      invoice PDF, plus the reports ticked and the photos picked; a report from another job, an
 *      empty Job Completion Report, or another customer's photo refuses the whole send.
 *   4. The report (and the email) never print a cost, a material sell price or labour hours.
 *   5. The payment-info response lists what is on file; the preview PDF is not a public route.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import zlib from "node:zlib";
import sharp from "sharp";
import { prisma } from "../src/lib/prisma";

delete process.env.STRIPE_SECRET_KEY;
vi.mock("stripe", () => ({ default: class MockStripe { constructor() { throw new Error("Stripe must not be constructed in tests"); } } }));
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials() {}
  }
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
type SentMail = {
  to: string; cc?: string[]; subject: string; headline: string; bodyHtml: string; kind?: string; issuedEstimateId?: string | null;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
};
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn() }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { isPublicRoute } from "../src/middleware/publicRoutes";

const MARK = "JCR";
const CUSTOMER_EMAIL = "jcr-customer@example.com";
const ITEM_NEC = "JCR01"; // necArticle "210.8(A); 406.4"
const ITEM_BARE = "JCR02"; // necArticle null
const ITEM_DECLINED = "JCR03"; // the declined option's item
// Figures that sit on the rows and must NEVER reach the report or the email.
const COST_MARKERS = ["7654.32", "8888.77", "9.87", "123.45", "5432.1"];

const SCRATCH = "C:\\Users\\Kyle\\AppData\\Local\\Temp\\claude\\c--Users-Kyle-Desktop-Red-Cedar-Electric-LLC-RCE-Coding-Agent\\a4f9a5e8-4a50-4c95-9621-546b405462d1\\scratchpad";

let customerId: string, otherCustomerId: string;
let propertyId: string, otherPropertyId: string;
let jobId: string, consultId: string, otherJobId: string, noInvoiceVisitId: string;
let techId: string, techToken: string, strangerId: string, strangerToken: string;
let draftId: string;
let rootId: string, coId: string;
let lineGfci: string, lineBare: string, lineDeclined: string, lineCo: string;
let photoA: string, photoB: string, photoOtherJob: string, photoOtherCustomer: string;
let inspectionId: string, otherInspectionId: string;

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);
const mails = () => emailMock.sendBrandedEmail.mock.calls.map((c) => c[0] as SentMail);
const lastMail = () => mails().at(-1)!;
const postEmail = (body: Record<string, unknown>) => request(app).post("/customer-emails").send(body);

/** pdfkit deflates its streams; inflate each, then read the hex/literal text runs. */
function pdfText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const parts: string[] = [];
  const scan = (chunk: string) => {
    for (const m of chunk.matchAll(/<([0-9A-Fa-f]+)>/g)) {
      if (m[1].length % 2 === 0) parts.push(Buffer.from(m[1], "hex").toString("latin1"));
    }
  };
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      const inflated = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
      if (inflated.includes(" TJ")) scan(inflated); // a content stream, not an image or font
    } catch { /* not deflated */ }
  }
  return parts.join("");
}

async function makeEstimate(opts: {
  number: string; changeOrderForId?: string | null; total: number; tripCharge: number; subtotalA: number;
  lines: Array<{ itemId: string; description: string; option: "A" | "B"; sortOrder: number }>;
}) {
  return prisma.issuedEstimate.create({
    data: {
      number: opts.number,
      token: `jcr${opts.number.replace(/\W/g, "")}${Date.now().toString(16)}`.padEnd(64, "0"),
      status: "signed",
      draftId,
      customerId,
      serviceAddressId: propertyId,
      customerName: `${MARK} Customer`,
      customerEmail: CUSTOMER_EMAIL,
      serviceAddress: "12 Completion Way, Hermitage, TN",
      title: "Outlet and circuit work",
      scopeText: "Outlet and circuit work.",
      workSubtotal: opts.subtotalA,
      tripCharge: opts.tripCharge,
      total: opts.total,
      sentAt: new Date(),
      sentTo: CUSTOMER_EMAIL,
      visitId: opts.changeOrderForId ? jobId : consultId,
      jobVisitId: jobId,
      changeOrderForId: opts.changeOrderForId ?? null,
      signedAt: new Date(),
      signerName: `${MARK} Customer`,
      signedChannel: "email",
      depositRequired: false,
      selectedOptions: ["A"],
      comboCapJson: JSON.stringify({ applied: false, reduction: 0, ceiling: 0, bandLabel: "n/a" }),
      options: { create: [{ option: "A", label: "Work", subtotal: opts.subtotalA, lineCount: 2 }] },
      lines: {
        create: opts.lines.map((l) => ({
          itemId: l.itemId, description: l.description, option: l.option, sortOrder: l.sortOrder, quantity: 1,
          unitPrice: 111, lineTotal: 222,
          // The internal figures that share the row - the report must never print these.
          laborHours: 9.87, materialSell: 8888.77, materialCost: 7654.32,
        })),
      },
    },
    include: { lines: true },
  });
}

const cleanup = async () => {
  const estIds = (await prisma.issuedEstimate.findMany({ where: { number: { startsWith: `0000-${MARK}` } }, select: { id: true } })).map((e) => e.id);
  const visitIds = (await prisma.visit.findMany({ where: { purpose: { startsWith: `${MARK} ` } }, select: { id: true } })).map((v) => v.id);
  await prisma.jobCompletionLine.deleteMany({ where: { visitId: { in: visitIds } } });
  await prisma.emailDelivery.deleteMany({ where: { issuedEstimateId: { in: estIds } } });
  await prisma.payment.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { changeOrderForId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.document.deleteMany({ where: { jobId: { in: visitIds } } });
  await prisma.healthInspection.deleteMany({ where: { visitId: { in: visitIds } } });
  await prisma.visitPhoto.deleteMany({ where: { visitId: { in: visitIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: visitIds } } });
  await prisma.technician.deleteMany({ where: { name: { startsWith: `${MARK} ` } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: `${MARK} draft` } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: `${MARK}-SUP` } });
  await prisma.visit.deleteMany({ where: { id: { in: visitIds } } });
  await prisma.property.deleteMany({ where: { name: { startsWith: `${MARK} ` } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: `${MARK} ` } } });
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: [ITEM_NEC, ITEM_BARE, ITEM_DECLINED] } } });
  await prisma.systemEvent.deleteMany({ where: { message: { contains: `0000-${MARK}` } } });
};

async function photo(visitId: string, caption: string, color: { r: number; g: number; b: number }) {
  const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: color } })
    .composite([{ input: Buffer.from(`<svg width="900" height="600"><rect x="60" y="60" width="780" height="480" fill="none" stroke="white" stroke-width="12"/><text x="450" y="320" font-size="60" fill="white" text-anchor="middle">${caption}</text></svg>`) }])
    .png().toBuffer();
  const id = `jcr-${caption.replace(/\W/g, "").toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.visitPhoto.create({ data: { id, visitId, mimeType: "image/png", sizeBytes: png.length, data: png, caption } });
  return id;
}

beforeAll(async () => {
  await cleanup();
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: CUSTOMER_EMAIL } });
  customerId = customer.id;
  otherCustomerId = (await prisma.customer.create({ data: { name: `${MARK} Other Customer`, email: "jcr-other@example.com" } })).id;
  propertyId = (await prisma.property.create({ data: { customerId, name: `${MARK} property`, addressLine1: "12 Completion Way", city: "Hermitage", state: "TN", postalCode: "37076" } })).id;
  otherPropertyId = (await prisma.property.create({ data: { customerId: otherCustomerId, name: `${MARK} other property`, addressLine1: "9 Elsewhere Rd", city: "Antioch", state: "TN", postalCode: "37013" } })).id;

  consultId = (await prisma.visit.create({ data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} consult`, status: "completed" } })).id;
  jobId = (await prisma.visit.create({
    data: {
      customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "completed",
      scheduledStart: new Date("2026-10-20T14:00:00Z"), completedAt: new Date("2026-10-21T20:00:00Z"),
    },
  })).id;
  otherJobId = (await prisma.visit.create({ data: { customerId: otherCustomerId, propertyId: otherPropertyId, mode: "onsite", purpose: `${MARK} otherjob`, status: "completed" } })).id;
  noInvoiceVisitId = (await prisma.visit.create({ data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} noinvoice`, status: "scheduled" } })).id;

  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `jcr-tech-${customer.id}` } });
  techId = tech.id; techToken = tech.accessToken;
  await prisma.visitAssignment.create({ data: { visitId: jobId, technicianId: techId } });
  const stranger = await prisma.technician.create({ data: { name: `${MARK} Stranger`, accessToken: `jcr-stranger-${customer.id}` } });
  strangerId = stranger.id; strangerToken = stranger.accessToken;

  await prisma.priceBookAtomic.createMany({
    data: [
      { itemId: ITEM_NEC, description: "GFCI receptacle", category: "DEVICES", unit: "ea", necArticle: "210.8(A); 406.4", companyCost: 123.45, companyPrice: 5432.1 },
      { itemId: ITEM_BARE, description: "20A circuit", category: "DEVICES", unit: "ea", necArticle: null, companyCost: 123.45 },
      { itemId: ITEM_DECLINED, description: "Whole-home surge protector", category: "DEVICES", unit: "ea", necArticle: "999.9", companyCost: 123.45 },
    ],
  });
  await prisma.priceBookSupplier.create({ data: { id: `${MARK}-SUP`, name: `${MARK} Supply`, quotable: "YES" } });
  draftId = (await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} draft`, supplierId: `${MARK}-SUP` } })).id;

  const root = await makeEstimate({
    number: `0000-${MARK}1`, total: 425, tripCharge: 75, subtotalA: 350,
    lines: [
      { itemId: ITEM_NEC, description: "Replace kitchen outlets with GFCI", option: "A", sortOrder: 0 },
      { itemId: ITEM_BARE, description: "Add a dedicated 20A circuit", option: "A", sortOrder: 1 },
      { itemId: ITEM_DECLINED, description: "Whole-home surge protector", option: "B", sortOrder: 0 },
    ],
  });
  rootId = root.id;
  lineGfci = root.lines.find((l) => l.itemId === ITEM_NEC)!.id;
  lineBare = root.lines.find((l) => l.itemId === ITEM_BARE)!.id;
  lineDeclined = root.lines.find((l) => l.itemId === ITEM_DECLINED)!.id;
  const co = await makeEstimate({
    number: `0000-${MARK}2`, changeOrderForId: rootId, total: 100, tripCharge: 0, subtotalA: 100,
    lines: [{ itemId: ITEM_BARE, description: "Extra bathroom circuit (change order)", option: "A", sortOrder: 0 }],
  });
  coId = co.id;
  lineCo = co.lines[0].id;

  photoA = await photo(jobId, "Before - old outlet", { r: 70, g: 90, b: 140 });
  photoB = await photo(jobId, "After - GFCI installed", { r: 40, g: 120, b: 80 });
  photoOtherJob = await photo(consultId, "Consult photo", { r: 120, g: 60, b: 60 });
  photoOtherCustomer = await photo(otherJobId, "Someone else", { r: 100, g: 100, b: 30 });

  // A Health Record taken on the CONSULTATION visit (the job chain), and one on another customer's job.
  inspectionId = `jcr-insp-${customer.id}`;
  await prisma.healthInspection.create({
    data: { id: inspectionId, visitId: consultId, propertyId, customerId, jurisdictionId: "TN-DEFAULT", inspectionDate: new Date("2026-10-10T15:00:00Z"), score: 82, itemsAssessed: 0, criticalFindingsJson: "[]", itemsJson: "[]" },
  });
  otherInspectionId = `jcr-insp-other-${customer.id}`;
  await prisma.healthInspection.create({
    data: { id: otherInspectionId, visitId: otherJobId, propertyId: otherPropertyId, customerId: otherCustomerId, jurisdictionId: "TN-DEFAULT", inspectionDate: new Date("2026-10-11T15:00:00Z"), score: 70, itemsAssessed: 0, criticalFindingsJson: "[]", itemsJson: "[]" },
  });
});

afterAll(async () => {
  delete process.env.STRIPE_SECRET_KEY;
  await cleanup();
});

beforeEach(() => {
  emailMock.sendBrandedEmail.mockReset();
  emailMock.sendBrandedEmail.mockResolvedValue(true);
});

const entry = (over: Record<string, unknown> = {}) => ({
  explanation: "Replaced the two kitchen counter outlets with tamper-resistant GFCI receptacles because the originals were ungrounded two-prong devices within six feet of the sink.",
  necRefs: ["210.8(A)", "406.12"],
  readings: [
    { label: "Voltage L1-N", value: "121.4", unit: "V" },
    { label: "GFCI trip test", value: "Tripped on test button", unit: "" },
  ],
  photoIds: [photoA, photoB],
  ...over,
});

describe("which lines are on the report", () => {
  it("is the ROOT invoice plus the signed change order - selected options only - each with its NEC article (null-safe)", async () => {
    const res = await request(app).get(`/jobs/${jobId}/completion-lines`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reason).toBeNull();
    expect(res.body.invoiceNumber).toBe(`0000-${MARK}1`); // the ROOT's number
    const byId = Object.fromEntries((res.body.lines as Array<{ lineId: string }>).map((l) => [l.lineId, l]));
    expect(Object.keys(byId).sort()).toEqual([lineGfci, lineBare, lineCo].sort());
    expect(byId[lineDeclined]).toBeUndefined(); // the declined option's line never appears
    // invoice order: root lines (by sortOrder) then the change order
    expect((res.body.lines as Array<{ lineId: string }>).map((l) => l.lineId)).toEqual([lineGfci, lineBare, lineCo]);
    expect(byId[lineGfci]).toMatchObject({ documentKind: "invoice", documentNumber: `0000-${MARK}1`, name: "Replace kitchen outlets with GFCI", defaultNecRefs: ["210.8(A)", "406.4"], entry: null });
    expect((byId[lineBare] as unknown as { defaultNecRefs: string[] }).defaultNecRefs).toEqual([]); // no article on the price-book item -> no citation, never invented
    expect(byId[lineCo]).toMatchObject({ documentKind: "change_order", documentNumber: `0000-${MARK}2` });
    // Nothing priced rides the list.
    const json = JSON.stringify(res.body);
    for (const m of COST_MARKERS) expect(json).not.toContain(m);
    expect(json).not.toMatch(/materialCost|materialSell|laborHours|unitPrice|lineTotal|companyCost|companyPrice/);
  });

  it("answers an empty list with a reason (not a 500) for a job with no signed invoice", async () => {
    const res = await request(app).get(`/jobs/${noInvoiceVisitId}/completion-lines`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lines: [], writtenUp: 0, invoiceNumber: null });
    expect(res.body.reason).toMatch(/no signed invoice/i);
    expect((await request(app).get("/jobs/does-not-exist/completion-lines")).status).toBe(404);
  });
});

describe("one record, two doors", () => {
  it("an entry saved through the technician's route reads back identically through the CRM's", async () => {
    const put = await auth(request(app).put(`/health-record/visits/${jobId}/completion-lines/${lineGfci}`)).send(entry());
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data.entry.updatedBy).toBe(`tech:${techId}`);

    const tech = await auth(request(app).get(`/health-record/visits/${jobId}/completion-lines`));
    const crm = await request(app).get(`/jobs/${jobId}/completion-lines`);
    expect(tech.status).toBe(200);
    expect(tech.body.data).toEqual(crm.body); // same record, same shape, both doors
    const saved = crm.body.lines.find((l: { lineId: string }) => l.lineId === lineGfci);
    expect(saved.entry).toMatchObject({
      explanation: entry().explanation,
      necRefs: ["210.8(A)", "406.12"],
      readings: entry().readings,
      photoIds: [photoA, photoB],
    });
    expect(crm.body.writtenUp).toBe(1);
  });

  it("the CRM saves the same way, and a save replaces rather than adds", async () => {
    const put = await request(app).put(`/jobs/${jobId}/completion-lines/${lineBare}`).send(entry({ explanation: "Ran a new 20A circuit.", necRefs: [], readings: [], photoIds: [] }));
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.entry.updatedBy).toBe("human:crm-session");
    expect(put.body.entry.necRefs).toEqual([]); // stored as written: no citation
    const again = await request(app).put(`/jobs/${jobId}/completion-lines/${lineBare}`).send(entry({ explanation: "Ran a new 20A circuit to the garage.", necRefs: ["210.11(C)"], readings: [], photoIds: [] }));
    expect(again.body.entry.explanation).toBe("Ran a new 20A circuit to the garage.");
    expect(await prisma.jobCompletionLine.count({ where: { issuedEstimateLineId: lineBare } })).toBe(1);
  });

  it("refuses a photo from another job (same customer) and another customer's - never dropped silently", async () => {
    for (const bad of [photoOtherJob, photoOtherCustomer]) {
      const res = await request(app).put(`/jobs/${jobId}/completion-lines/${lineCo}`).send(entry({ photoIds: [photoA, bad] }));
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error).toMatch(/not on this job/i);
      const viaTech = await auth(request(app).put(`/health-record/visits/${jobId}/completion-lines/${lineCo}`)).send(entry({ photoIds: [bad] }));
      expect(viaTech.status).toBe(400);
    }
    expect(await prisma.jobCompletionLine.count({ where: { issuedEstimateLineId: lineCo } })).toBe(0);
  });

  it("refuses a line of a declined option, an unknown line, an empty entry, and an unassigned technician", async () => {
    expect((await request(app).put(`/jobs/${jobId}/completion-lines/${lineDeclined}`).send(entry())).status).toBe(404);
    expect((await request(app).put(`/jobs/${jobId}/completion-lines/nope`).send(entry())).status).toBe(404);
    const empty = await request(app).put(`/jobs/${jobId}/completion-lines/${lineCo}`).send({ explanation: "", necRefs: ["210.8"] });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/Clear/);
    const stranger = await request(app).put(`/health-record/visits/${jobId}/completion-lines/${lineCo}`).set("Authorization", `Bearer ${strangerToken}`).send(entry({ photoIds: [] }));
    expect(stranger.status).toBe(403);
    expect((await request(app).get(`/health-record/visits/${jobId}/completion-lines`).set("Authorization", `Bearer ${strangerToken}`)).status).toBe(403);
    expect((await request(app).delete(`/health-record/visits/${jobId}/completion-lines/${lineGfci}`).set("Authorization", `Bearer ${strangerToken}`)).status).toBe(403);
    // limits live in the shared contract
    const long = await request(app).put(`/jobs/${jobId}/completion-lines/${lineCo}`).send(entry({ explanation: "x".repeat(4001), photoIds: [] }));
    expect(long.status).toBe(400);
  });

  it("Clear takes the entry off through either door; a second Clear says nothing was there", async () => {
    await request(app).put(`/jobs/${jobId}/completion-lines/${lineCo}`).send(entry({ explanation: "Extra circuit.", photoIds: [] }));
    const cleared = await request(app).delete(`/jobs/${jobId}/completion-lines/${lineCo}`);
    expect(cleared.body).toEqual({ cleared: true });
    expect((await request(app).delete(`/jobs/${jobId}/completion-lines/${lineCo}`)).body).toEqual({ cleared: false });
    const viaTech = await auth(request(app).delete(`/health-record/visits/${jobId}/completion-lines/${lineBare}`));
    expect(viaTech.body.data).toEqual({ cleared: true });
    const list = await request(app).get(`/jobs/${jobId}/completion-lines`);
    expect(list.body.lines.find((l: { lineId: string }) => l.lineId === lineCo).entry).toBeNull();
    expect(list.body.lines.find((l: { lineId: string }) => l.lineId === lineBare).entry).toBeNull();
    expect(list.body.writtenUp).toBe(1); // the GFCI line from the tech's save is still there
  });

  it("an entry removed with its photo: a deleted photo drops off the line instead of 404ing the door", async () => {
    const extra = await photo(jobId, "Temp", { r: 10, g: 10, b: 10 });
    await request(app).put(`/jobs/${jobId}/completion-lines/${lineCo}`).send(entry({ explanation: "Extra circuit.", photoIds: [extra] }));
    await prisma.visitPhoto.delete({ where: { id: extra } });
    const list = await request(app).get(`/jobs/${jobId}/completion-lines`);
    expect(list.body.lines.find((l: { lineId: string }) => l.lineId === lineCo).entry.photoIds).toEqual([]);
    await request(app).delete(`/jobs/${jobId}/completion-lines/${lineCo}`);
  });
});

describe("the technician's read-only list of this visit's photos (the field's picker)", () => {
  it("an assigned technician gets this visit's photos - id, caption, tag, time - and NO image bytes", async () => {
    const res = await auth(request(app).get(`/health-record/visits/${jobId}/photos`));
    expect(res.status).toBe(200);
    const ids = (res.body.data.photos as Array<Record<string, unknown>>).map((p) => p.id);
    expect(ids).toContain(photoA);
    expect(ids).toContain(photoB);
    // another visit's photos are not on this visit's list
    expect(ids).not.toContain(photoOtherJob);
    expect(ids).not.toContain(photoOtherCustomer);
    for (const p of res.body.data.photos as Array<Record<string, unknown>>) {
      expect(Object.keys(p).sort()).toEqual(["caption", "id", "tag", "uploadedAt"]);
    }
    expect(JSON.stringify(res.body)).not.toMatch(/"type":\s*"Buffer"/);
    expect(res.body.data.photos.find((p: { id: string }) => p.id === photoA).caption).toBe("Before - old outlet");
  });

  it("serves one photo's bytes with its own mimeType, and a small JPEG for ?size=thumb", async () => {
    const full = await auth(request(app).get(`/health-record/visits/${jobId}/photos/${photoA}/image`)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(full.status).toBe(200);
    expect(full.headers["content-type"]).toMatch(/^image\/png/);
    const stored = await prisma.visitPhoto.findUniqueOrThrow({ where: { id: photoA }, select: { data: true } });
    expect((full.body as Buffer).equals(Buffer.from(stored.data))).toBe(true);
    const thumb = await auth(request(app).get(`/health-record/visits/${jobId}/photos/${photoA}/image?size=thumb`)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(thumb.status).toBe(200);
    expect(thumb.headers["content-type"]).toMatch(/^image\/jpeg/);
  });

  it("an unassigned technician is refused (403) on both, with no token at all it is refused too", async () => {
    const stranger = (path: string) => request(app).get(path).set("Authorization", `Bearer ${strangerToken}`);
    expect((await stranger(`/health-record/visits/${jobId}/photos`)).status).toBe(403);
    expect((await stranger(`/health-record/visits/${jobId}/photos/${photoA}/image`)).status).toBe(403);
    expect((await request(app).get(`/health-record/visits/${jobId}/photos`)).status).toBe(401);
    expect((await request(app).get(`/health-record/visits/${jobId}/photos/${photoA}/image`)).status).toBe(401);
  });

  it("another visit's photo id (or one that does not exist) is a 404 through this visit - never served", async () => {
    for (const id of [photoOtherJob, photoOtherCustomer, "does-not-exist"]) {
      const res = await auth(request(app).get(`/health-record/visits/${jobId}/photos/${id}/image`));
      expect(res.status).toBe(404);
    }
  });
});

describe("the report PDF", () => {
  it("is not a public route, and the preview refuses (409 with the reason) while nothing is written up", async () => {
    expect(isPublicRoute("GET", `/jobs/${jobId}/completion-report.pdf`)).toBe(false);
    expect(isPublicRoute("GET", `/jobs/${jobId}/completion-lines`)).toBe(false);
    await request(app).delete(`/jobs/${jobId}/completion-lines/${lineGfci}`);
    const res = await request(app).get(`/jobs/${jobId}/completion-report.pdf`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/No lines are written up yet/);
    expect((await request(app).get(`/jobs/${noInvoiceVisitId}/completion-report.pdf`)).status).toBe(409);
  });

  it("prints PAID IN FULL first, the job block, one section per written line, readings, NEC, photos - and no cost or labour figure", async () => {
    // owing: no PAID IN FULL box
    await request(app).put(`/jobs/${jobId}/completion-lines/${lineGfci}`).send(entry());
    const owing = await request(app).get(`/jobs/${jobId}/completion-report.pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(owing.status).toBe(200);
    expect(owing.headers["content-type"]).toContain("application/pdf");
    expect((owing.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    expect(pdfText(owing.body as Buffer)).not.toContain("PAID IN FULL");

    // pay the whole invoice (root 425 + change order 100)
    await prisma.payment.create({ data: { estimateId: rootId, customerId, amount: 525, method: "check", kind: "final", status: "paid", payer: "customer", paidAt: new Date("2026-10-22T18:00:00Z"), checkNumber: "1042" } });
    await request(app).put(`/jobs/${jobId}/completion-lines/${lineBare}`).send(entry({ explanation: "Ran a dedicated 20A circuit from the panel to the kitchen counter.", necRefs: [], readings: [{ label: "Breaker", value: "20", unit: "A" }], photoIds: [] }));
    await request(app).put(`/jobs/${jobId}/completion-lines/${lineCo}`).send(entry({ explanation: "Added a bathroom circuit.", necRefs: ["210.11(C)(3)"], readings: [], photoIds: [photoB] }));

    const { generateCompletionReport } = await import("../src/services/pdfGenerator");
    const { pdf, filename } = await generateCompletionReport(jobId);
    expect(filename).toBe(`job-completion-report-0000-${MARK}1.pdf`);
    fs.mkdirSync(SCRATCH, { recursive: true });
    fs.writeFileSync(`${SCRATCH}\\sample-job-completion-report.pdf`, pdf);

    const text = pdfText(pdf);
    expect(text).toContain("Job Completion Report");
    expect(text).toContain("PAID IN FULL");
    expect(text.indexOf("PAID IN FULL")).toBeLessThan(text.indexOf("Customer:")); // the box comes first
    expect(text).toContain(`Invoice 0000-${MARK}1`); // the ROOT's number
    expect(text).not.toContain(`0000-${MARK}2`); // never the change order's own
    expect(text).toContain("$525.00");
    expect(text).toContain("Balance: $0.00");
    expect(text).toContain(`${MARK} Customer`);
    expect(text).toContain("12 Completion Way");
    expect(text).toContain(`${MARK} Tech`);
    expect(text).toContain("Replace kitchen outlets with GFCI");
    expect(text).toContain("What was done and why");
    expect(text).toContain("tamper-resistant GFCI receptacles");
    expect(text).toContain("Code compliance");
    expect(text).toContain("NEC 210.8(A)");
    expect(text).toContain("Voltage L1-N");
    expect(text).toContain("121.4");
    expect(text).toContain("Add a dedicated 20A circuit");
    expect(text).toContain("Extra bathroom circuit (change order)");
    expect(text).not.toContain("Whole-home surge protector"); // declined option
    expect(text).toContain("paid by check");
    for (const m of COST_MARKERS) expect(text).not.toContain(m);
    // invoice order: root lines before the change order's
    expect(text.indexOf("Replace kitchen outlets")).toBeLessThan(text.indexOf("Add a dedicated 20A circuit"));
    expect(text.indexOf("Add a dedicated 20A circuit")).toBeLessThan(text.indexOf("Extra bathroom circuit"));
    // a line with no citation chosen prints no Code compliance heading under it
    const bareSection = text.slice(text.indexOf("Add a dedicated 20A circuit"), text.indexOf("Extra bathroom circuit"));
    expect(bareSection).not.toContain("Code compliance");
  });

  it("omits a line with no write-up", async () => {
    await request(app).delete(`/jobs/${jobId}/completion-lines/${lineBare}`);
    const { generateCompletionReport } = await import("../src/services/pdfGenerator");
    const text = pdfText((await generateCompletionReport(jobId)).pdf);
    expect(text).not.toContain("Add a dedicated 20A circuit");
    expect(text).toContain("Replace kitchen outlets with GFCI");
    await request(app).put(`/jobs/${jobId}/completion-lines/${lineBare}`).send(entry({ explanation: "Ran a dedicated 20A circuit.", necRefs: [], readings: [], photoIds: [] }));
  });
});

describe("the payment card's list of reports on file", () => {
  it("lists the completion report first, then each Health Record on the job chain - never another customer's", async () => {
    const res = await request(app).get(`/jobs/${jobId}/payment-info`);
    expect(res.status).toBe(200);
    const reports = res.body.email.reports as Array<{ id: string; kind: string; available: boolean; blockedReason?: string; label: string }>;
    expect(reports[0]).toMatchObject({ id: "completion", kind: "completion", label: "Job Completion Report", available: true });
    expect(reports.find((r) => r.id === `health:${inspectionId}`)).toMatchObject({ kind: "health", available: true });
    expect(reports.some((r) => r.id.includes(otherInspectionId))).toBe(false);
    // same list through the estimate-keyed door
    const viaEstimate = await request(app).get(`/issued-estimates/${coId}/payment-info`);
    expect(viaEstimate.body.email.reports.map((r: { id: string }) => r.id)).toEqual(reports.map((r) => r.id));
  });
});

describe("the receipt", () => {
  it("is refused while anything is owing", async () => {
    // a second, unpaid job's invoice: pull the payment off ours for this check, then restore it
    const pay = await prisma.payment.findFirstOrThrow({ where: { estimateId: rootId } });
    await prisma.payment.update({ where: { id: pay.id }, data: { amount: 400 } });
    const res = await postEmail({ kind: "receipt", estimateId: rootId, reports: ["completion"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/A receipt can go once the invoice is paid in full/);
    expect(res.body.error).toContain("$125.00");
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
    await prisma.payment.update({ where: { id: pay.id }, data: { amount: 525 } });
  });

  it("goes to the typed To + CC with the completion report, a Health Record, a photo and the invoice PDF - naming the ROOT invoice", async () => {
    // asked about the CHANGE ORDER's id: still the root's number
    const res = await postEmail({
      kind: "receipt", estimateId: coId, to: "realtor@example.com", cc: ["Owner@Example.com", "REALTOR@example.com"],
      message: "For the punch list.", reports: ["completion", `health:${inspectionId}`], photoIds: [photoA],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ sent: true, kind: "receipt", to: "realtor@example.com", cc: ["owner@example.com"] });

    const mail = lastMail();
    expect(mail.kind).toBe("receipt");
    expect(mail.issuedEstimateId).toBe(rootId);
    expect(mail.subject).toBe(`Paid in full — receipt for Invoice 0000-${MARK}1`);
    expect(mail.to).toBe("realtor@example.com");
    expect(mail.cc).toEqual(["owner@example.com"]);
    expect(mail.bodyHtml).toContain("For the punch list.");
    expect(mail.bodyHtml).toContain("PAID IN FULL");
    expect(mail.bodyHtml).not.toContain("Hi "); // not greeted as the homeowner
    for (const m of COST_MARKERS) expect(mail.bodyHtml).not.toContain(m);

    const names = mail.attachments!.map((a) => a.filename);
    expect(names).toContain(`invoice-0000-${MARK}1.pdf`);
    expect(names).toContain(`job-completion-report-0000-${MARK}1.pdf`);
    expect(names.some((n) => n.startsWith("electrical-health-record-"))).toBe(true);
    expect(names.some((n) => n.startsWith("photo-") && n.endsWith(".jpg"))).toBe(true);
    for (const a of mail.attachments!.filter((x) => x.contentType === "application/pdf")) {
      expect(a.content.subarray(0, 4).toString()).toBe("%PDF");
    }
    const events = await prisma.issuedEstimateEvent.findMany({ where: { estimateId: rootId, type: "receipt_sent" } });
    expect(events).toHaveLength(1);
  });

  it("with nothing ticked sends just the itemized invoice, to the customer on file", async () => {
    const res = await postEmail({ kind: "receipt", estimateId: rootId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.to).toBe(CUSTOMER_EMAIL);
    expect(lastMail().attachments!.map((a) => a.filename)).toEqual([`invoice-0000-${MARK}1.pdf`]);
    expect(lastMail().bodyHtml).toContain("Hi JCR,");
  });

  it("refuses the whole send - nothing emailed - for a report from another job, an unknown id, or a photo from another account", async () => {
    for (const bad of [`health:${otherInspectionId}`, "health:no-such-id", "nonsense", "diagnostic:no-such-id"]) {
      const res = await postEmail({ kind: "receipt", estimateId: rootId, reports: ["completion", bad] });
      expect(res.status, bad).toBe(400);
      expect(res.body.error).toMatch(/not on this invoice's job/);
    }
    const photo = await postEmail({ kind: "receipt", estimateId: rootId, reports: ["completion"], photoIds: [photoA, photoOtherCustomer] });
    expect(photo.status).toBe(400);
    expect(photo.body.error).toMatch(/can't be sent/);
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
  });

  it("refuses the Job Completion Report when no line is written up - never sends thinner than ticked", async () => {
    const saved = await prisma.jobCompletionLine.findMany({ where: { visitId: jobId } });
    await prisma.jobCompletionLine.deleteMany({ where: { visitId: jobId } });
    const res = await postEmail({ kind: "receipt", estimateId: rootId, reports: ["completion"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Job Completion Report can't be attached: No lines are written up yet/);
    const info = await request(app).get(`/jobs/${jobId}/payment-info`);
    expect(info.body.email.reports[0]).toMatchObject({ id: "completion", available: false, blockedReason: "No lines are written up yet" });
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();
    await prisma.jobCompletionLine.createMany({ data: saved.map(({ id: _id, ...rest }) => ({ ...rest, readingsJson: rest.readingsJson as object })) });
  });

  it("an unrelated kind still refuses photos (only invoice, estimate and receipt carry them)", async () => {
    const res = await postEmail({ kind: "deposit", estimateId: rootId, photoIds: [photoA] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invoice, an estimate or a receipt/);
  });
});
