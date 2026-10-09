/**
 * Options continue past C, up to H (Kyle, 2026-10-08; one-estimating-system plan, Phase 0).
 *
 * "I want to be able to add more than 3 options for projects that are more expansive ... continue
 *  the options past 'C'." · "Capping it at eight is good."
 *
 * Phase 0 puts ONE list of letters underneath everything and removes the caps that would have
 * refused a customer who takes four or more. Pinned here:
 *   1. the shared list (A-H, base A-C, cap 8) and its hint text;
 *   2. the engine summarises D-H only when a line is in them — an A/B/C estimate still gets
 *      exactly A, B, C;
 *   3. a line can be put in D and later (the server accepts every letter), and issuing freezes
 *      only the options that hold lines — never eight headings;
 *   4. CRM "Record acceptance" takes more than three options (it used to refuse at .max(3)) and
 *      stops at eight;
 *   5. (Phase 1, unit 1a) a FIVE-option estimate reaches the customer whole: the /e/:token page and
 *      the PDF list D and E, all three signing doors take them, the presentation maths adds them,
 *      and an A/B/C estimate is exactly what it was, with no D in sight.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
vi.mock("stripe", () => ({ default: class MockStripe { constructor() { throw new Error("Stripe must not be constructed in tests"); } } }));
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
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
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { addLine, computeDraft, createDraft, editLine, setOptionMeta } from "../src/services/atomicEstimateService";
import { computeEstimate, summarizeOptions, type DraftLineInput, type EngineAtomic, type RateConfig } from "../src/services/atomicEstimateEngine";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { buildOptions } from "../client/src/lib/presentation";
import { buildQuoteMoney } from "../src/services/quoteMoney";
import { selectionPrice } from "../shared/quoteMoney";
import type { PbComputed } from "../client/src/lib/types";
import { TEST_SIGNATURE } from "./helpers/signature";
import {
  ALL_OPTIONS,
  BASE_OPTIONS,
  MAX_OPTIONS,
  OPTION_HINT_FALLBACK,
  isEstimateOption,
  optionHint,
} from "../shared/estimateOptions";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "OPTSPASTC";
const ATOMIC = "OP001";

/**
 * The text drawn on a pdfkit page. pdfkit writes text as hex runs, so a plain substring search of
 * the bytes finds nothing (see tests/issuedEstimatePdf.test.ts). The trailer's random /ID is cut
 * first, as in tests/materialsListPdf.test.ts.
 */
function pdfText(buf: Buffer): string {
  const raw = buf.toString("latin1").replace(/\/ID\s*\[[^\]]*\]/g, "");
  const parts: string[] = [];
  for (const m of raw.matchAll(/<([0-9A-Fa-f]+)>/g)) {
    if (m[1].length % 2 !== 0) continue;
    parts.push(Buffer.from(m[1], "hex").toString("latin1"));
  }
  return parts.join("");
}

describe("the shared option list", () => {
  it("runs A to H, with A/B/C as the base and eight as the cap", () => {
    expect([...ALL_OPTIONS]).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
    expect([...BASE_OPTIONS]).toEqual(["A", "B", "C"]);
    expect(MAX_OPTIONS).toBe(8);
  });

  it("knows a letter from a non-letter", () => {
    expect(isEstimateOption("H")).toBe(true);
    expect(isEstimateOption("I")).toBe(false);
    expect(isEstimateOption("a")).toBe(false);
    expect(isEstimateOption(undefined)).toBe(false);
  });

  it("keeps Kyle's wording for A/B/C and tells the user to name D-H", () => {
    expect(optionHint("A")).toBe("what the client called for");
    expect(optionHint("B")).toBe("code violations & hazards found");
    expect(optionHint("C")).toBe("recommended beyond A and B");
    expect(optionHint("D")).toBe(OPTION_HINT_FALLBACK);
    expect(OPTION_HINT_FALLBACK).toBe("name this option in Review");
  });
});

describe("the engine's per-option summary", () => {
  const RATE = { billedLaborRate: 100, jobFixedCost: 200, markupTiers: [] } as unknown as RateConfig;
  const atomics = new Map<string, EngineAtomic>([
    ["a1", {
      itemId: "a1", description: "a1", unit: "each", laborUnitBasis: "EACH", laborUnitDivisor: 1,
      laborNormal: 1, laborDifficult: 1, laborVeryDifficult: 1, supplierPrice: 0, materialSellPerUnit: 0, rowType: "LABOR",
    } as unknown as EngineAtomic],
  ]);
  const line = (option: DraftLineInput["option"]): DraftLineInput =>
    ({ id: `l-${option}`, itemId: "a1", quantity: 1, quantitySource: "COUNT", difficulty: "NORMAL", option });

  it("an A/B/C estimate still summarises exactly A, B, C", () => {
    const s = summarizeOptions(computeEstimate([line("A"), line("C")], atomics, RATE, "supplier"));
    expect(s.map((x) => x.option)).toEqual(["A", "B", "C"]);
  });

  it("D and later appear only once a line is in them", () => {
    const s = summarizeOptions(computeEstimate([line("A"), line("D"), line("F")], atomics, RATE, "supplier"));
    expect(s.map((x) => x.option)).toEqual(["A", "B", "C", "D", "F"]);
    expect(s.find((x) => x.option === "D")!.lineCount).toBe(1);
    expect(s.find((x) => x.option === "D")!.subtotal).toBe(100);
  });
});

describe("a draft with options past C, issued and accepted", () => {
  let customerId: string;
  let propertyId: string;
  const draftIds: string[] = [];

  beforeAll(async () => {
    await ensurePriceBookGates();
    await seedAtomics([quotableAtomic(ATOMIC)]);
    const customer = await prisma.customer.create({
      data: { name: `${MARK} Customer`, email: "opts-past-c@example.com", phone: "615-555-0178" },
    });
    customerId = customer.id;
    const property = await prisma.property.create({
      data: { customerId, name: `${MARK} House`, addressLine1: "8 Many Options Ct", city: "Smyrna", state: "TN", postalCode: "37167" },
    });
    propertyId = property.id;
  });

  afterAll(async () => {
    const ests = await prisma.issuedEstimate.findMany({ where: { customerId }, select: { id: true } });
    const ids = ests.map((e) => e.id);
    await prisma.payment.deleteMany({ where: { estimateId: { in: ids } } });
    await prisma.document.deleteMany({ where: { issuedEstimateId: { in: ids } } });
    await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: ids } } });
    await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: ids } } });
    await prisma.issuedEstimateOption.deleteMany({ where: { estimateId: { in: ids } } });
    await prisma.issuedEstimate.updateMany({ where: { id: { in: ids } }, data: { supersedesId: null, changeOrderForId: null } });
    await prisma.issuedEstimate.deleteMany({ where: { id: { in: ids } } });
    await prisma.priceBookDraftOption.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { job: { customerId } } });
    await prisma.visit.deleteMany({ where: { customerId } });
    await prisma.property.deleteMany({ where: { id: propertyId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await deleteAtomics([ATOMIC]);
  });

  async function issueWith(letters: Array<(typeof ALL_OPTIONS)[number]>, title: string) {
    const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId: null });
    draftIds.push(d.id);
    for (const option of letters) {
      await addLine(prisma, d.id, { itemId: ATOMIC, quantity: 1, quantitySource: "COUNT", option });
    }
    const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    if (!g.ok) throw new Error(`graduation failed: ${JSON.stringify(g)}`);
    await prisma.issuedEstimate.update({ where: { id: g.estimateId }, data: { status: "sent", sentAt: new Date(), sentTo: "opts-past-c@example.com" } });
    return g.estimateId;
  }

  const accept = (id: string, selectedOptions?: string[]) =>
    request(app).post(`/issued-estimates/${id}/accept`).send({ acceptedVia: "phone", acceptedBy: "Bryan Crawford", selectedOptions });

  it("a line can be put in D, and moved there from A, by the service", async () => {
    const d = await createDraft(prisma, { title: `${MARK} move`, supplierId: "HD", visitId: null });
    draftIds.push(d.id);
    const l = await addLine(prisma, d.id, { itemId: ATOMIC, quantity: 1, quantitySource: "COUNT" });
    expect(l.option).toBe("A");
    await editLine(prisma, l.id, { option: "D" });
    expect((await prisma.priceBookDraftLine.findUniqueOrThrow({ where: { id: l.id } })).option).toBe("D");
  });

  it("issuing freezes only the options that hold lines — five lines, five options, not eight", async () => {
    const id = await issueWith(["A", "B", "C", "D", "E"], "five");
    const rows = await prisma.issuedEstimateOption.findMany({ where: { estimateId: id }, orderBy: { option: "asc" } });
    expect(rows.map((r) => r.option)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("an A/B/C estimate freezes exactly A, B, C, as before", async () => {
    const id = await issueWith(["A", "B", "C"], "abc");
    const rows = await prisma.issuedEstimateOption.findMany({ where: { estimateId: id }, orderBy: { option: "asc" } });
    expect(rows.map((r) => r.option)).toEqual(["A", "B", "C"]);
  });

  it("Record acceptance takes four or more options (it used to refuse at three)", async () => {
    const id = await issueWith(["A", "B", "C", "D", "E"], "accept-five");
    const res = await accept(id, ["A", "B", "C", "D", "E"]);
    expect(res.status).toBe(200);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id } })).selectedOptions).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("Record acceptance stops at the cap of eight", async () => {
    const id = await issueWith(["A"], "accept-nine");
    const nine = await accept(id, ["A", "B", "C", "D", "E", "F", "G", "H", "A"]);
    expect(nine.status).toBe(400);
  });

  // ── The customer sees all of it (plan item 5) ───────────────────────────────────────────────

  const tokenOf = async (id: string) => (await prisma.issuedEstimate.findUniqueOrThrow({ where: { id } })).token;

  const pdfOf = async (id: string, audience: "customer" | "company" = "customer") => {
    const res = await request(app)
      .get(`/issued-estimates/${id}/pdf?audience=${audience}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    return pdfText(res.body as Buffer);
  };

  it("the customer page lists a five-option estimate: a card, a tick box and a combination price for D and E", async () => {
    const d = await createDraft(prisma, { title: `${MARK} page-five`, supplierId: "HD", visitId: null });
    draftIds.push(d.id);
    for (const option of ["A", "B", "C", "D", "E"] as const) {
      await addLine(prisma, d.id, { itemId: ATOMIC, quantity: 1, quantitySource: "COUNT", option });
    }
    // D is named in Review; E is left as the bare letter.
    await setOptionMeta(prisma, d.id, "D", { label: "Pool pump circuit" });
    const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    if (!g.ok) throw new Error(`graduation failed: ${JSON.stringify(g)}`);
    await prisma.issuedEstimate.update({ where: { id: g.estimateId }, data: { status: "sent", sentAt: new Date(), sentTo: "opts-past-c@example.com" } });

    const page = await request(app).get(`/e/${await tokenOf(g.estimateId)}`);
    expect(page.status).toBe(200);
    for (const o of ["A", "B", "C", "D", "E"]) {
      expect(page.text, `Option ${o} card`).toContain(`data-optcard="${o}"`);
      expect(page.text).toContain(`data-option="${o}"`);
    }
    expect(page.text).toContain("Pool pump circuit");
    expect(page.text).toContain("Option E");
    // Never eight headings: F, G and H hold nothing, so they are not on the page.
    for (const o of ["F", "G", "H"]) expect(page.text).not.toContain(`data-optcard="${o}"`);
    // All 2^5 - 1 = 31 combinations are priced for the page's script (7 for an A/B/C estimate).
    expect(page.text).toContain('"A+B+C+D+E"');
    expect(page.text).toContain('"D+E"');
    expect(page.text).not.toContain('"F+');
  });

  it("the PDF lists D and E (customer and company copy), and not the options nobody offered", async () => {
    const id = await issueWith(["A", "B", "C", "D", "E"], "pdf-five");
    for (const audience of ["customer", "company"] as const) {
      const text = await pdfOf(id, audience);
      for (const o of ["A", "B", "C", "D", "E"]) expect(text, `${audience} copy lists Option ${o}`).toContain(`Option ${o}`);
      for (const o of ["F", "G", "H"]) expect(text).not.toContain(`Option ${o}`);
    }
  });

  it("an A/B/C estimate is unchanged: three cards, seven combinations, no D anywhere", async () => {
    const id = await issueWith(["A", "B", "C"], "page-three");
    const page = await request(app).get(`/e/${await tokenOf(id)}`);
    expect(page.status).toBe(200);
    for (const o of ["A", "B", "C"]) expect(page.text).toContain(`data-optcard="${o}"`);
    expect(page.text).not.toContain('data-optcard="D"');
    expect(page.text).toContain('"A+B+C"');
    expect(page.text).not.toContain('"A+B+C+D"');
    const text = await pdfOf(id);
    for (const o of ["A", "B", "C"]) expect(text).toContain(`Option ${o}`);
    expect(text).not.toContain("Option D");
  });

  it("signing door 1 of 3: the emailed link takes D and E, and the signed page and PDF show what was bought", async () => {
    const id = await issueWith(["A", "B", "C", "D", "E"], "sign-link");
    const token = await tokenOf(id);
    const signed = await request(app)
      .post(`/e/${token}/sign`)
      .type("form")
      .send({ signerName: "Bryan Crawford", signatureImage: TEST_SIGNATURE, selectedOptions: "A,D,E" });
    expect(signed.status, signed.text.slice(0, 300)).toBe(200);
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id } });
    expect(row.selectedOptions).toEqual(["A", "D", "E"]);
    // Once signed, the document shows what was bought: D and E are there, B and C are not.
    const page = await request(app).get(`/e/${token}`);
    expect(page.text).toContain('data-optcard="D"');
    expect(page.text).toContain('data-optcard="E"');
    expect(page.text).not.toContain('data-optcard="B"');
    const text = await pdfOf(id);
    expect(text).toContain("Option D");
    expect(text).toContain("Option E");
    expect(text).not.toContain("Option B");
  });

  it("signing door 2 of 3: CRM Record acceptance takes D and E", async () => {
    const id = await issueWith(["A", "B", "C", "D", "E"], "sign-accept");
    const res = await accept(id, ["D", "E"]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id } })).selectedOptions).toEqual(["D", "E"]);
  });

  it("signing door 3 of 3: the CRM in-person screen takes D and E", async () => {
    const id = await issueWith(["A", "B", "C", "D", "E"], "sign-in-person");
    const res = await request(app)
      .post(`/issued-estimates/${id}/sign-in-person`)
      .send({ signerName: "Bryan Crawford", signatureImage: TEST_SIGNATURE, selectedOptions: ["B", "D", "E"] });
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ signed: true });
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id } })).selectedOptions).toEqual(["B", "D", "E"]);
  });

  it("the presentation maths lists and adds five options (the customer view carries no hours)", async () => {
    const d = await createDraft(prisma, { title: `${MARK} presentation-five`, supplierId: "HD", visitId: null });
    draftIds.push(d.id);
    for (const [i, option] of (["A", "B", "C", "D", "E"] as const).entries()) {
      await addLine(prisma, d.id, { itemId: ATOMIC, quantity: i + 1, quantitySource: "COUNT", option });
    }
    const { computed, rate } = await computeDraft(prisma, d.id);
    const summaries = summarizeOptions(computed);
    expect(summaries.map((s) => s.option)).toEqual(["A", "B", "C", "D", "E"]);
    // The client library is typed against the CRM's payload shapes; the engine's output is the
    // same data, so the casts only bridge the two declarations.
    const customer = buildOptions(computed as unknown as PbComputed, summaries as never, "customer");
    expect(customer.map((o) => o.option)).toEqual(["A", "B", "C", "D", "E"]);
    for (const o of customer) {
      for (const l of o.lines) {
        expect(l).not.toHaveProperty("laborHours");
        expect(l).not.toHaveProperty("materialCost");
      }
    }
    // The total of what is ticked is the server's one pricer now (2026-10-08, Phase 3 unit A) — D and E
    // price like A-C: their subtotals added, the trip once.
    const trip = rate.rc.jobFixedCost ?? 0;
    const money = buildQuoteMoney(computed, { discountType: null, discountPercent: null, exclusiveOptions: false });
    expect(money.pickable).toEqual(["A", "B", "C", "D", "E"]);
    const de = selectionPrice(money, ["D", "E"])!.total;
    expect(de).toBeCloseTo((customer[3].total ?? 0) + (customer[4].total ?? 0) + trip, 2);
    const all = selectionPrice(money, ["A", "B", "C", "D", "E"])!.total;
    expect(all).toBeCloseTo(customer.reduce((n, o) => n + (o.total ?? 0), 0) + trip, 2);
    expect(selectionPrice(money, [])).toBeNull();
  });
});
