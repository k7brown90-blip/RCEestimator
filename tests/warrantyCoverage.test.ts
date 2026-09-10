/**
 * Home-warranty coverage on an issued estimate (Kyle, 2026-09-09).
 *
 *   "The warranty company is covering $370 of this bill. I need to get a
 *    signature from the home owner first to clarify they owe the remainder and
 *    be able to show on the invoice sent to her that the warranty is covering
 *    what ever their chosen amount is with the claim number."
 *
 * The live case: 2026-1065, Option A $425 (service fee $75 + 54-inch fan
 * install $350), RELY Home WO 343467219, auth45978673 for $370. The homeowner
 * signs; the warranty company is a second payer; the credit is generated from
 * the claim record; deposit and balance are computed on the homeowner share.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import {
  billedTotalOf,
  depositDueOf,
  paymentSummary,
  preCoverageTotalOf,
  warrantyCoverageOf,
} from "../src/services/stripePayments";
import { renderEstimatePage } from "../src/services/issuedEstimateRender";
import { renderEstimatePdf } from "../src/services/issuedEstimatePdf";
import type { CompanyProfile } from "../src/services/companyProfile";

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

import { app } from "../src/app";

const RELY = {
  company: "RELY Home",
  claimNumber: "343467219",
  authNumber: "auth45978673",
  coveredAmount: 370,
  note: "3 hrs labor + $70 toward fan; other issues not covered",
  setAt: "2026-09-09T15:00:00.000Z",
};
const RELY_JSON = JSON.stringify(RELY);

const PROFILE: CompanyProfile = {
  legalName: "Red Cedar Electric LLC",
  phone: "615-625-2163",
  email: "service@redcedarelectricllc.com",
  tagline: "Licensed & Insured",
  licenseNumber: null,
  licenseState: "TN",
};

let customerId: string;
let propertyId: string;
let draftId: string;

const cleanup = async () => {
  await prisma.payment.deleteMany({ where: { note: "warranty-test" } });
  await prisma.issuedEstimate.deleteMany({ where: { number: { startsWith: "0000-WTY" } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: "warranty-test draft" } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: "WTYTEST-SUP" } });
  await prisma.visit.deleteMany({ where: { purpose: "warranty-test visit" } });
  await prisma.property.deleteMany({ where: { name: "warranty-test property" } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: "Warranty Test" } } });
};

/** Option A $425 = trip $75 + $350 fan install; the 2026-1065 shape. */
async function issue(input: {
  suffix: string;
  signed?: boolean;
  status?: string;
  warrantyJson?: string | null;
  discountJson?: string | null;
  visitId?: string | null;
  jobVisitId?: string | null;
  voided?: boolean;
}) {
  return prisma.issuedEstimate.create({
    data: {
      number: `0000-WTY${input.suffix}`,
      token: `${"w".repeat(40)}${input.suffix.padStart(24, "0")}`.slice(0, 64).replace(/[^0-9a-f]/g, "a"),
      status: input.status ?? (input.signed ? "signed" : "sent"),
      draftId,
      customerId,
      serviceAddressId: propertyId,
      customerName: "Warranty Test Copeland",
      customerEmail: "copeland@example.com",
      serviceAddress: "5937 New Hope Court, Hermitage, TN",
      title: "Warranty Call + Electrical Assessment",
      scopeText: "Ceiling fan install and balance, 54-inch, customer-supplied fan.",
      workSubtotal: 350,
      tripCharge: 75,
      total: 425,
      sentAt: new Date(),
      sentTo: "copeland@example.com",
      warrantyJson: input.warrantyJson ?? null,
      discountJson: input.discountJson ?? null,
      visitId: input.visitId ?? null,
      jobVisitId: input.jobVisitId ?? null,
      ...(input.signed
        ? {
            signedAt: new Date(),
            signerName: "Patricia Copeland",
            signedChannel: "email",
            selectedOptions: ["A"],
            comboCapJson: JSON.stringify({ applied: false, reduction: 0, ceiling: 0, bandLabel: "n/a" }),
          }
        : {}),
      ...(input.voided ? { voidedAt: new Date(), voidReason: "test", status: "void" } : {}),
      options: {
        create: [{ option: "A", label: "Warranty call + fan install", subtotal: 350, lineCount: 2 }],
      },
    },
    include: { options: true },
  });
}

beforeAll(async () => {
  await cleanup();
  const customer = await prisma.customer.create({ data: { name: "Warranty Test Copeland", email: "copeland@example.com" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: {
      customerId,
      name: "warranty-test property",
      addressLine1: "5937 New Hope Court",
      city: "Hermitage",
      state: "TN",
      postalCode: "37076",
    },
  });
  propertyId = property.id;
  await prisma.priceBookSupplier.create({ data: { id: "WTYTEST-SUP", name: "Warranty Test Supply", quotable: "YES" } });
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: "warranty-test draft", supplierId: "WTYTEST-SUP" } });
  draftId = draft.id;
});

afterAll(cleanup);

// ─── billedTotalOf ────────────────────────────────────────────────────────────

describe("billedTotalOf with warranty coverage", () => {
  const base = {
    total: 425,
    tripCharge: 75,
    selectedOptions: ["A"],
    comboCapJson: null,
    discountJson: null,
    optionsSubtotals: [{ option: "A", subtotal: 350 }],
  };

  it("$425 single option, $370 covered → $55 homeowner share", () => {
    expect(preCoverageTotalOf({ ...base, warrantyJson: RELY_JSON })).toBe(425);
    expect(billedTotalOf({ ...base, warrantyJson: RELY_JSON })).toBe(55);
    expect(warrantyCoverageOf({ ...base, warrantyJson: RELY_JSON })).toMatchObject({
      applied: 370,
      claim: { company: "RELY Home", claimNumber: "343467219", authNumber: "auth45978673" },
    });
  });

  it("coverage above the bill is capped — $500 on a $425 job → $0, never negative", () => {
    const json = JSON.stringify({ ...RELY, coveredAmount: 500 });
    expect(billedTotalOf({ ...base, warrantyJson: json })).toBe(0);
    expect(warrantyCoverageOf({ ...base, warrantyJson: json })?.applied).toBe(425);
  });

  it("applies AFTER the programme discount", () => {
    // 5% senior on $425 = $21.25 → $403.75 before coverage → $33.75 homeowner share.
    const discountJson = JSON.stringify({ type: "senior", rate: 0.05, cap: 250, base: 425, amount: 21.25 });
    expect(billedTotalOf({ ...base, discountJson, warrantyJson: RELY_JSON })).toBe(33.75);
    expect(warrantyCoverageOf({ ...base, discountJson, warrantyJson: RELY_JSON })?.applied).toBe(370);
    // And the cap reads the discounted figure: $400 covered on $403.75 applies in full, $410 does not.
    expect(billedTotalOf({ ...base, discountJson, warrantyJson: JSON.stringify({ ...RELY, coveredAmount: 410 }) })).toBe(0);
  });

  it("with nothing selected yet, bills est.total minus coverage", () => {
    expect(billedTotalOf({ ...base, selectedOptions: [], warrantyJson: RELY_JSON })).toBe(55);
  });

  it("is unchanged for estimates without a claim (absent or null)", () => {
    expect(billedTotalOf(base)).toBe(425);
    expect(billedTotalOf({ ...base, warrantyJson: null })).toBe(425);
    expect(warrantyCoverageOf(base)).toBeNull();
  });
});

// ─── PATCH /issued-estimates/:id/warranty ────────────────────────────────────

describe("PATCH /issued-estimates/:id/warranty", () => {
  it("sets warrantyJson on a sent estimate and writes an audit event", async () => {
    const est = await issue({ suffix: "1" });
    const res = await request(app).patch(`/issued-estimates/${est.id}/warranty`).send({
      claimNumber: "343467219",
      authNumber: "auth45978673",
      coveredAmount: 370,
      note: "3 hrs labor + $70 toward fan",
    });
    expect(res.status).toBe(200);
    expect(res.body.warranty).toMatchObject({ company: "RELY Home", claimNumber: "343467219", authNumber: "auth45978673", coveredAmount: 370 });
    expect(res.body.warrantyCovered).toBe(370);
    expect(res.body.preCoverageTotal).toBe(425);
    expect(res.body.homeownerTotal).toBe(55);
    expect(res.body.depositDue).toBe(18.33);

    const row = await prisma.issuedEstimate.findUnique({ where: { id: est.id }, include: { events: true } });
    const stored = JSON.parse(row!.warrantyJson!);
    expect(stored).toMatchObject({ company: "RELY Home", claimNumber: "343467219", authNumber: "auth45978673", coveredAmount: 370 });
    expect(typeof stored.setAt).toBe("string");
    expect(row!.events.some((e) => e.type === "warranty_set" && e.detail?.includes("343467219"))).toBe(true);
  });

  it("refuses coverage above the pre-coverage total with a clear 400", async () => {
    const est = await issue({ suffix: "2" });
    const res = await request(app).patch(`/issued-estimates/${est.id}/warranty`).send({
      claimNumber: "343467219",
      coveredAmount: 500,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/\$500\.00 is more than this estimate bills \(\$425\.00\)/);
    const row = await prisma.issuedEstimate.findUnique({ where: { id: est.id } });
    expect(row!.warrantyJson).toBeNull();
  });

  it("requires a claim number", async () => {
    const est = await issue({ suffix: "3" });
    const res = await request(app).patch(`/issued-estimates/${est.id}/warranty`).send({ coveredAmount: 370 });
    expect(res.status).toBe(400);
  });

  it("{ clear: true } (the client's form of null) clears the claim and records it", async () => {
    const est = await issue({ suffix: "4", warrantyJson: RELY_JSON });
    const res = await request(app).patch(`/issued-estimates/${est.id}/warranty`).send({ clear: true });
    expect(res.status).toBe(200);
    expect(res.body.warranty).toBeNull();
    expect(res.body.warrantyCovered).toBe(0);
    expect(res.body.homeownerTotal).toBe(425);
    const row = await prisma.issuedEstimate.findUnique({ where: { id: est.id }, include: { events: true } });
    expect(row!.warrantyJson).toBeNull();
    expect(row!.events.some((e) => e.type === "warranty_cleared" && e.detail?.includes("343467219"))).toBe(true);

    // An empty body clears too — Express's strict JSON parser refuses a bare `null`.
    const again = await issue({ suffix: "4b", warrantyJson: RELY_JSON });
    const res2 = await request(app).patch(`/issued-estimates/${again.id}/warranty`).send({});
    expect(res2.status).toBe(200);
    expect((await prisma.issuedEstimate.findUnique({ where: { id: again.id } }))!.warrantyJson).toBeNull();
  });

  it("409 after signing — revise to change coverage", async () => {
    const est = await issue({ suffix: "5", signed: true, warrantyJson: RELY_JSON });
    const res = await request(app).patch(`/issued-estimates/${est.id}/warranty`).send({
      claimNumber: "343467219",
      coveredAmount: 100,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Revise the estimate to change warranty coverage after signing");
    const row = await prisma.issuedEstimate.findUnique({ where: { id: est.id } });
    expect(JSON.parse(row!.warrantyJson!).coveredAmount).toBe(370);
  });

  it("409 on a voided estimate", async () => {
    const est = await issue({ suffix: "6", voided: true });
    const res = await request(app).patch(`/issued-estimates/${est.id}/warranty`).send({ claimNumber: "x", coveredAmount: 1 });
    expect(res.status).toBe(409);
  });
});

// ─── paymentSummary ──────────────────────────────────────────────────────────

describe("paymentSummary on a signed $425 estimate with $370 coverage", () => {
  it("bills the homeowner share: billedTotal 55, depositDue 18.33, warrantyCovered 370", async () => {
    const est = await issue({ suffix: "7", signed: true, warrantyJson: RELY_JSON });
    const summary = (await paymentSummary(prisma, est.id, "https://unused.invalid"))!;
    expect(summary.billedTotal).toBe(55);
    expect(summary.depositDue).toBe(18.33);
    expect(summary.depositDue).toBe(depositDueOf(55));
    expect(summary.balance).toBe(55);
    expect(summary.warrantyCovered).toBe(370);
    expect(summary.warrantyClaim).toEqual({ company: "RELY Home", claimNumber: "343467219", authNumber: "auth45978673" });

    // The route the admin panels read carries the same figures.
    const res = await request(app).get(`/issued-estimates/${est.id}/payment-info`);
    expect(res.status).toBe(200);
    expect(res.body.billedTotal).toBe(55);
    expect(res.body.warrantyCovered).toBe(370);
    expect(res.body.warrantyClaim.claimNumber).toBe("343467219");
  });
});

// ─── Rendering ───────────────────────────────────────────────────────────────

describe("rendering the claim", () => {
  const load = (id: string) =>
    prisma.issuedEstimate.findUniqueOrThrow({
      where: { id },
      include: {
        lines: { orderBy: { sortOrder: "asc" } },
        options: { orderBy: { option: "asc" } },
        supersededBy: { select: { id: true, number: true, revision: true } },
      },
    });

  it("the customer page carries the credit row, the homeowner total, and the notice above the signature", async () => {
    const est = await issue({ suffix: "8", warrantyJson: RELY_JSON });
    const html = renderEstimatePage(await load(est.id));
    expect(html).toContain("Warranty coverage — RELY Home, claim 343467219, auth auth45978673");
    expect(html).toContain("billed to RELY Home");
    expect(html).toContain("&minus;$370.00");
    expect(html).toContain("YOUR TOTAL");
    expect(html).toContain('<span id="grandTotal">$55.00</span>');
    expect(html).toContain("Home warranty claim 343467219, RELY Home.");
    expect(html).toContain("(authorization auth45978673)");
    expect(html).toContain("(1) you may choose your own technician");
    expect(html).toContain("Any amount RELY Home does not pay within 45 days of the invoice is due from you.");
    // The notice sits ABOVE the signature block.
    expect(html.indexOf("Home warranty claim 343467219")).toBeLessThan(html.indexOf("Accept this estimate"));
    // No hours reach the customer — the second line of defence, kept.
    expect(html).not.toMatch(/\d+(\.\d+)?\s*(hr|hrs|hours)\b/i);
  });

  it("omits the authorization parenthetical when there is no auth number", async () => {
    const est = await issue({ suffix: "9", warrantyJson: JSON.stringify({ ...RELY, authNumber: null }) });
    const html = renderEstimatePage(await load(est.id));
    expect(html).toContain("Warranty coverage — RELY Home, claim 343467219 · billed to RELY Home");
    expect(html).not.toContain("(authorization");
    expect(html).toContain("service contract and is billed to RELY Home");
  });

  it("the signed copy shows the frozen share and the notice; the deposit ask is ⅓ of it", async () => {
    const est = await issue({ suffix: "10", signed: true, warrantyJson: RELY_JSON });
    const html = renderEstimatePage(await load(est.id), {
      deposit: { due: 18.33, satisfied: false, paidInFull: false, payUrl: "https://example.invalid/pay" },
    });
    expect(html).toContain('<span id="grandTotal">$55.00</span>');
    expect(html).toContain("Warranty coverage — RELY Home, claim 343467219, auth auth45978673");
    expect(html).toContain("(1) you may choose your own technician");
    expect(html).toContain("Pay your deposit — $18.33");
    expect(html.indexOf("Home warranty claim 343467219")).toBeLessThan(html.indexOf("Accepted &amp; signed"));
  });

  it("the interactive page hands the script the recorded coverage to cap live", async () => {
    // Two options → tick boxes → the picker script runs and must know the coverage.
    const est = await prisma.issuedEstimate.create({
      data: {
        number: "0000-WTY11",
        token: "b".repeat(64),
        status: "sent",
        draftId, customerId, serviceAddressId: propertyId,
        customerName: "Warranty Test Copeland",
        title: "Two options",
        workSubtotal: 500, tripCharge: 0, total: 500,
        warrantyJson: RELY_JSON,
        options: { create: [
          { option: "A", label: "Fan", subtotal: 350, lineCount: 1 },
          { option: "B", label: "Outlet", subtotal: 150, lineCount: 1 },
        ] },
      },
    });
    const html = renderEstimatePage(await load(est.id));
    expect(html).toContain("var warrantyCovered = 370;");
    expect(html).toContain('id="warrantyRow"');
    expect(html).toContain("Math.min(warrantyCovered, pre)");
  });

  it("the PDF renders for both audiences and the route serves it", async () => {
    const est = await issue({ suffix: "12", signed: true, warrantyJson: RELY_JSON });
    const row = await load(est.id);
    const input = {
      number: row.number, revision: row.revision, title: row.title, customerName: row.customerName,
      serviceAddress: row.serviceAddress, scopeText: row.scopeText, total: row.total, tripCharge: row.tripCharge,
      signedAt: row.signedAt, signedByName: row.signerName, createdAt: row.createdAt,
      options: row.options, selectedOptions: row.selectedOptions,
      comboCap: row.comboCapJson ? JSON.parse(row.comboCapJson) : null,
      warranty: RELY,
      lines: [],
    };
    const customer = await renderEstimatePdf(input, "customer", PROFILE);
    const company = await renderEstimatePdf(input, "company", PROFILE);
    expect(customer.length).toBeGreaterThan(1000);
    expect(company.length).toBeGreaterThan(customer.length); // the working sheet + claim header

    const res = await request(app).get(`/issued-estimates/${est.id}/pdf?audience=company`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const res2 = await request(app).get(`/issued-estimates/${est.id}/pdf`);
    expect(res2.status).toBe(200);
  });

  it("the account rows and the invoices list show billed = homeowner share beside the credit", async () => {
    const est = await issue({ suffix: "13", signed: true, warrantyJson: RELY_JSON });
    const acct = await request(app).get(`/accounts/${customerId}/estimates`);
    expect(acct.status).toBe(200);
    const row = acct.body.estimates.find((e: { id: string }) => e.id === est.id);
    expect(row.billedTotal).toBe(55);
    expect(row.warrantyCovered).toBe(370);
    expect(row.warranty.claimNumber).toBe("343467219");

    const inv = await request(app).get("/invoices");
    expect(inv.status).toBe(200);
    const invoice = inv.body.find((i: { id: string }) => i.id === est.id);
    expect(invoice.billedTotal).toBe(55);
    expect(invoice.depositDue).toBe(18.33);
    expect(invoice.balance).toBe(55);
    expect(invoice.warrantyCovered).toBe(370);
    expect(invoice.warrantyClaim.company).toBe("RELY Home");

    const chain = await request(app).get("/issued-estimates/chain");
    const chainRow = chain.body.estimates.find((e: { id: string }) => e.id === est.id);
    expect(chainRow.billedTotal).toBe(55);
    expect(chainRow.warrantyCovered).toBe(370);
  });
});

// ─── Money invariant ─────────────────────────────────────────────────────────

describe("GET /jobs and GET /accounts/:id/summary agree about a job sold on a covered estimate", () => {
  // Kyle, 2026-09-10: the job earned $425 on Option A, $370 of it from RELY — revenue is the
  // FULL bill (both payers); the invoice / deposit / balance surfaces stay on the homeowner share.
  it("both quote the full bill (homeowner + warranty) as revenue, byte-identical", async () => {
    const visit = await prisma.visit.create({
      data: {
        customerId,
        propertyId,
        mode: "service_diagnostic",
        purpose: "warranty-test visit",
        status: "scheduled",
      },
    });
    const est = await issue({ suffix: "14", signed: true, warrantyJson: RELY_JSON, visitId: visit.id, jobVisitId: visit.id });
    // The ⅓ deposit of the homeowner share opens the Jobs gate.
    await prisma.payment.create({
      data: { estimateId: est.id, customerId, visitId: visit.id, amount: 18.33, method: "check", kind: "deposit", status: "paid", paidAt: new Date(), note: "warranty-test" },
    });

    const jobs = await request(app).get("/jobs");
    const summary = await request(app).get(`/accounts/${customerId}/summary`);
    expect(jobs.status).toBe(200);
    expect(summary.status).toBe(200);

    const fromJobs = jobs.body.find((j: { visitId: string }) => j.visitId === visit.id);
    const fromSummary = summary.body.jobs.find((j: { visitId: string }) => j.visitId === visit.id);
    expect(fromJobs).toBeTruthy();
    expect(fromSummary).toBeTruthy();
    expect(fromSummary.costs).toEqual(fromJobs.costs);
    expect(fromJobs.costs.revenue).toBe(425);
    // The job card's estimate figure stays the homeowner share — what the invoice charges her.
    expect(fromJobs.estimate.totalCost).toBe(55);
  });
});
