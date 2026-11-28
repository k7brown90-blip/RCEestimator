/**
 * A one-or-the-other estimate shows a PRICE RANGE, never the sum of its options
 * (Kyle, 2026-11-18, "Price range"; plan admin-reports-1117 unit R1).
 *
 * The bug: `IssuedEstimate.total` adds every option and the unsigned row's billedTotal equals it,
 * so the Lewis property page read $115,997.60 for four alternatives ($3,383.58 ... $63,028.99).
 * `total` itself must not change (warranty cap, deposits, invoices read it), so every surface asks
 * for `quotedRange` instead: each end is what the customer pays for that ONE option alone, from
 * the same table the customer's page uses.
 *
 * Four layers pinned here:
 *   1. shared/quoteMoney.ts  pickOneRange / quotedRangeText: the gate and the definition.
 *   2. src/services/quoteMoney.ts quotedRangeOfIssued: unsigned + exclusive + 2 options only.
 *   3. the routes that feed the office screens: quotedRange present for the unsigned exclusive
 *      row, null for a signed one and an additive one; the sum is not what a range row carries.
 *   4. the customer's page, the PDF and the emails: first paint is ONE option, and nothing prints
 *      the all-options sum.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
process.env.SUMMARY_EMAIL = "kyle-summary@example.test";
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
import { notifyOwnerViewed, sendEstimateEmail } from "../src/services/issuedEstimateSend";
import { quotedRangeOfIssued } from "../src/services/quoteMoney";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";
import { programmeFor } from "../src/services/discounts";
import {
  buildMoneyTable,
  pickOneRange,
  quotedRangeText,
  type PricingFigures,
} from "../shared/quoteMoney";

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n);

// ─── 1. The shared helper ────────────────────────────────────────────────────────────────────

describe("pickOneRange — the gate and the definition", () => {
  const figures = (over: Partial<PricingFigures> = {}): PricingFigures => ({
    options: [
      { option: "A", subtotal: 100 },
      { option: "B", subtotal: 300 },
    ],
    tripCharge: 50,
    comboSavings: {},
    programme: null,
    ...over,
  });
  const table = (f: PricingFigures, exclusive: boolean, programme: Parameters<typeof buildMoneyTable>[2] = null) =>
    buildMoneyTable(f, exclusive, programme);

  it("exclusive with two or more priced options -> a range; anything else -> null", () => {
    expect(pickOneRange(table(figures(), true))).toEqual({ min: 150, max: 350 });
    // Additive: the customer takes any mix, so there is no "pick one" range.
    expect(pickOneRange(table(figures(), false))).toBeNull();
    // One option: nothing to choose between, even with the box ticked.
    expect(pickOneRange(table(figures({ options: [{ option: "A", subtotal: 100 }] }), true))).toBeNull();
    // An option still unpriced: never a guess.
    expect(pickOneRange(table(figures({ options: [{ option: "A", subtotal: 100 }, { option: "B", subtotal: null }] }), true))).toBeNull();
  });

  it("each end is the finished price for that option alone: trip included, discount taken", () => {
    const money = table(figures({ programme: { rate: 0.1, cap: null } }), true, programmeFor("custom", 10));
    // (100 + 50) - 10% = 135 ; (300 + 50) - 10% = 315
    expect(pickOneRange(money)).toEqual({ min: 135, max: 315 });
    // buildMoneyTable's own discountedRange is read through this helper: they cannot disagree.
    expect(money.discountedRange).toEqual(pickOneRange(money));
  });

  it("the Lewis estimate reads $3,383.58 - $63,028.99, not the $115,997.60 sum", () => {
    const lewis: PricingFigures = {
      options: [
        { option: "A", subtotal: 3383.58 },
        { option: "B", subtotal: 4349.42 },
        { option: "C", subtotal: 45235.61 },
        { option: "D", subtotal: 63028.99 },
      ],
      tripCharge: 0,
      comboSavings: {},
      programme: null,
    };
    const range = pickOneRange(table(lewis, true));
    expect(range).toEqual({ min: 3383.58, max: 63028.99 });
    expect(quotedRangeText(range!, usd)).toBe("$3,383.58 – $63,028.99 · choose one");
  });
});

// ─── 2. The server rule over an issued row ───────────────────────────────────────────────────

describe("quotedRangeOfIssued — unsigned, one-or-the-other, two or more options", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    tripCharge: 50,
    jobBandsJson: null,
    discountType: null,
    discountPercent: null,
    exclusiveOptions: true,
    signedAt: null,
    options: [{ option: "A", subtotal: 100 }, { option: "B", subtotal: 300 }],
    lines: [
      { option: "A", materialCost: 0, materialSell: 0, inMaterialCap: true },
      { option: "B", materialCost: 0, materialSell: 0, inMaterialCap: true },
    ],
    ...over,
  });

  it("returns the range for the gated row", () => {
    expect(quotedRangeOfIssued(row() as never)).toEqual({ min: 150, max: 350 });
  });

  it("is null for a signed row, an additive row and a single-option row", () => {
    expect(quotedRangeOfIssued(row({ signedAt: new Date() }) as never)).toBeNull();
    expect(quotedRangeOfIssued(row({ exclusiveOptions: false }) as never)).toBeNull();
    expect(quotedRangeOfIssued(row({ options: [{ option: "A", subtotal: 100 }] }) as never)).toBeNull();
  });
});

// ─── 3 and 4. The routes, the customer's page, the PDF and the emails ────────────────────────

const RUN = `PR${Date.now().toString(36)}`;
const ATOMIC_A = `${RUN}A`;
const ATOMIC_B = `${RUN}B`;
let customerId: string;
let propertyId: string;
let draftId: string;
const made: string[] = [];

/** Option A $100 + B $300, trip $50: the stored `total` is the sum of everything, $450. */
async function issue(
  tag: string,
  over: { exclusiveOptions?: boolean; signed?: boolean; discountType?: string; discountPercent?: number } = {},
) {
  const est = await prisma.issuedEstimate.create({
    data: {
      number: `${RUN}-${tag}`,
      token: randomBytes(32).toString("hex"), // the page only opens a 64-hex token
      status: over.signed ? "signed" : "sent",
      draftId,
      customerId,
      serviceAddressId: propertyId,
      customerName: "Range Test",
      customerEmail: "range-test@example.com",
      serviceAddress: "1 Range Ct, Smyrna",
      title: `Range ${tag}`,
      workSubtotal: 400,
      tripCharge: 50,
      total: 450,
      sentAt: new Date(),
      exclusiveOptions: over.exclusiveOptions ?? true,
      discountType: over.discountType ?? null,
      discountPercent: over.discountPercent ?? null,
      ...(over.signed ? { signedAt: new Date(), signerName: "Range Test", selectedOptions: ["A"] } : {}),
      options: {
        create: [
          { option: "A", subtotal: 100, lineCount: 1 },
          { option: "B", subtotal: 300, lineCount: 1 },
        ],
      },
      lines: {
        create: [
          { itemId: ATOMIC_A, description: "Alpha work", quantity: 1, unitPrice: 100, lineTotal: 100, option: "A", laborHours: 1, materialSell: 0, materialCost: 0 },
          { itemId: ATOMIC_B, description: "Bravo work", quantity: 1, unitPrice: 300, lineTotal: 300, option: "B", laborHours: 1, materialSell: 0, materialCost: 0 },
        ],
      },
    },
  });
  made.push(est.id);
  return est;
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ATOMIC_A), quotableAtomic(ATOMIC_B)]);
  const customer = await prisma.customer.create({ data: { name: `${RUN} Customer`, email: "range-test@example.com" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${RUN} House`, addressLine1: "1 Range Ct", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  propertyId = property.id;
  // "finalized" = the draft as issued, nothing edited since. These estimates are written straight onto the
  // draft (none came from it), and an email now SAVES a draft that has unsaved edits first (Kyle, 2026-11-27,
  // "email sends what is on screen") - a synthetic estimate has nothing to save, so the fixture says so.
  draftId = (await prisma.priceBookDraftEstimate.create({ data: { title: `${RUN} draft`, supplierId: "HD", status: "finalized" } })).id;
});

afterAll(async () => {
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: made } } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: made } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: draftId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ATOMIC_A, ATOMIC_B]);
});

beforeEach(() => emailMock.sendBrandedEmail.mockClear());

describe("the office rows carry quotedRange, not the sum", () => {
  it("account list + record + chain + detail: unsigned exclusive -> range; signed and additive unchanged", async () => {
    const ranged = await issue("r1");
    const signed = await issue("s1", { signed: true });
    const additive = await issue("a1", { exclusiveOptions: false });

    const list = await request(app).get(`/accounts/${customerId}/estimates`);
    expect(list.status).toBe(200);
    const byId = (id: string) => list.body.estimates.find((e: { id: string }) => e.id === id);
    expect(byId(ranged.id).quotedRange).toEqual({ min: 150, max: 350 });
    // The sum is still what `total`/`billedTotal` hold (they feed money), but the row carries the range to print.
    expect(byId(ranged.id).total).toBe(450);
    expect(byId(signed.id).quotedRange).toBeNull();
    expect(byId(signed.id).billedTotal).toBe(150); // what was taken: A + trip
    expect(byId(additive.id).quotedRange).toBeNull();
    expect(byId(additive.id).billedTotal).toBe(450);

    const record = await request(app).get(`/issued-estimates/${ranged.id}/record`);
    expect(record.body.estimate.quotedRange).toEqual({ min: 150, max: 350 });

    const chain = await request(app).get("/issued-estimates/chain");
    const chainRow = (id: string) => chain.body.estimates.find((e: { id: string }) => e.id === id);
    expect(chainRow(ranged.id)).toMatchObject({ exclusiveOptions: true, quotedRange: { min: 150, max: 350 } });
    expect(chainRow(signed.id).quotedRange).toBeNull();
    expect(chainRow(additive.id).quotedRange).toBeNull();

    const detail = await request(app).get(`/issued-estimates/${ranged.id}`);
    expect(detail.body.estimate.quotedRange).toEqual({ min: 150, max: 350 });
    const signedDetail = await request(app).get(`/issued-estimates/${signed.id}`);
    expect(signedDetail.body.estimate.quotedRange).toBeNull();
  });

  it("the programme discount is inside each end of the range", async () => {
    const e = await issue("d1", { discountType: "custom", discountPercent: 10 });
    const res = await request(app).get(`/issued-estimates/${e.id}/record`);
    expect(res.body.estimate.quotedRange).toEqual({ min: 135, max: 315 });
  });
});

describe("the customer's page opens on ONE option", () => {
  it("/e/:token first paint: Option A's price, never the all-options sum", async () => {
    const e = await issue("p1");
    const res = await request(app).get(`/e/${e.token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="grandTotal">$150.00');
    expect(res.text).not.toContain("$450.00");
    // The radio for Option A is the checked one, and the multi-option saving row is not painted.
    expect(res.text).toMatch(/data-option="A"[^>]*checked/);
    expect(res.text).not.toMatch(/data-option="B"[^>]*checked/);
    expect(res.text).toMatch(/id="comboSaving" class="saving" style="display:none;"/);
  });

  it("an additive estimate still opens on everything ticked (unchanged)", async () => {
    const e = await issue("p2", { exclusiveOptions: false });
    const res = await request(app).get(`/e/${e.token}`);
    expect(res.text).toContain('id="grandTotal">$450.00');
  });

  it("in person: the option chosen on Present is the one painted (the iframe runs no script)", async () => {
    const e = await issue("p3");
    const none = await request(app).get(`/issued-estimates/${e.id}/customer-view`);
    expect(none.text).toContain('id="grandTotal">$150.00');
    const b = await request(app).get(`/issued-estimates/${e.id}/customer-view?selectedOptions=B`);
    expect(b.status).toBe(200);
    expect(b.text).toContain('id="grandTotal">$350.00');
    expect(b.text).not.toContain("$450.00");
    expect(b.text).toMatch(/data-option="B"[^>]*checked/);
    // An option this estimate does not hold falls back to Option A rather than painting nothing.
    const bad = await request(app).get(`/issued-estimates/${e.id}/customer-view?selectedOptions=Z`);
    expect(bad.text).toContain('id="grandTotal">$150.00');
  });
});

describe("the PDF prints the range on the total row", () => {
  const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  };
  const textOf = (buf: Buffer) => {
    const parts: string[] = [];
    for (const m of buf.toString("latin1").matchAll(/<([0-9A-Fa-f]+)>/g)) {
      if (m[1].length % 2 === 0) parts.push(Buffer.from(m[1], "hex").toString("latin1"));
    }
    return parts.join("");
  };

  it("ESTIMATE TOTAL carries '$135.00 – $315.00 · choose one' (10% inside each end) and nothing is worked on the 450.00 sum", async () => {
    const e = await issue("f1", { discountType: "custom", discountPercent: 10 });
    const res = await request(app).get(`/issued-estimates/${e.id}/pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const text = textOf(res.body as Buffer);
    expect(text).toContain("ESTIMATE TOTAL");
    // 10% off each: 135 and 315.
    expect(text).toContain("$135.00");
    expect(text).toContain("$315.00");
    expect(text).toContain("choose one");
    expect(text).not.toContain("450.00");
    // The 10% of the SUM (45.00) is not taken anywhere.
    expect(text).not.toContain("-$45.00");
    expect(text).not.toContain("405.00");
  });

  it("an additive estimate's PDF is unchanged: the sum is its total", async () => {
    const e = await issue("f2", { exclusiveOptions: false });
    const res = await request(app).get(`/issued-estimates/${e.id}/pdf`).buffer(true).parse(binary);
    const text = textOf(res.body as Buffer);
    expect(text).toContain("450.00");
    expect(text).not.toContain("choose one");
  });
});

describe("the emails print the range", () => {
  it("the estimate email's Total line is the range, and carries no monthly figure worked on the sum", async () => {
    const e = await issue("m1");
    const sent = await sendEstimateEmail(prisma, e.id, { sentBy: "test", includeFinancingLink: true });
    expect(sent.ok).toBe(true);
    const call = emailMock.sendBrandedEmail.mock.calls.at(-1)![0] as { bodyHtml: string };
    expect(call.bodyHtml).toContain("Total $150.00 – $350.00 · choose one");
    expect(call.bodyHtml).not.toContain("450.00");
    expect(call.bodyHtml).not.toContain("/mo");
    // Kyle, 2026-11-27: the Finance this project block still says the deposit is paid - WITHOUT an
    // amount here, because no monthly figure (and so no deposit) is worked on a price range.
    expect(call.bodyHtml).toContain("Financing covers the balance. The one-third deposit is still paid up front, before we schedule.");
    expect(call.bodyHtml).not.toMatch(/one-third deposit of \$/);
  });

  it("Kyle's VIEWED alert shows the range in the body and the subject", async () => {
    const e = await issue("m2");
    await prisma.issuedEstimate.update({ where: { id: e.id }, data: { firstViewedAt: new Date() } });
    expect(await notifyOwnerViewed(prisma, e.id)).toBe(true);
    const call = emailMock.sendBrandedEmail.mock.calls.at(-1)![0] as { bodyHtml: string; subject: string };
    expect(call.subject).toContain("$150.00 – $350.00 · choose one");
    expect(call.bodyHtml).toContain("$150.00 – $350.00 · choose one");
    expect(call.subject).not.toContain("450.00");
  });

  it("an additive estimate's email keeps its flat total", async () => {
    const e = await issue("m3", { exclusiveOptions: false });
    await sendEstimateEmail(prisma, e.id, { sentBy: "test", includeFinancingLink: false });
    const call = emailMock.sendBrandedEmail.mock.calls.at(-1)![0] as { bodyHtml: string };
    expect(call.bodyHtml).toContain("Total $450.00");
  });
});
