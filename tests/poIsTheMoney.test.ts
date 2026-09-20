/**
 * THE P.O. IS THE MONEY (Kyle, 2026-09-19).
 *
 * "There are too many points of failure right now." One rule: the charge is
 * the money, the receipt is proof, never money. Money reaches the P&L from
 * exactly two places a P.O. can carry — a card charge and an amount typed as
 * not-on-card — plus company bills and Stripe fees. A job's material is the
 * money on the P.O.s tagged to it. Nothing here decides between a receipt and
 * a charge, so nothing can count twice: the 9/17 Home Depot buy that rang up
 * as $651.73 + $114.01 against one $765.74 receipt is $765.74 of expense, once.
 *
 * Sentinel year 2032, far from every other fixture, so the ledger is ours alone.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { createPurchaseOrder, defaultTruckId, setPurchaseOrderMoney, transitionPurchaseOrder } from "../src/services/purchaseOrders";
import { materialCostForJobs } from "../src/services/jobCosting";
import { updateCardSpend } from "../src/services/cardSpend";

const YEAR = 2032;
const SEP = new Date(`${YEAR}-09-17T18:00:00.000Z`);
const newId = () => crypto.randomUUID().replaceAll("-", "");
const jpg = Buffer.from("ffd8ffe000104a464946", "hex");
const r2 = (n: number) => Math.round(n * 100) / 100;

let truckId: string;
let customerId: string;
let propertyId: string;
let job: string;
let quoteVisit: string;
let soldJob: string;

type Month = { expenses: number; net: number; invoiced: number };
async function september(): Promise<{ month: Month; category: (c: string) => number }> {
  const res = await request(app).get(`/financials/summary?year=${YEAR}`);
  expect(res.status).toBe(200);
  const month = res.body.months[8] as Month;
  return { month, category: (c: string) => res.body.expensesByCategory.find((r: { category: string }) => r.category === c)?.monthly[8] ?? 0 };
}
const costOf = async (visitId: string) => (await materialCostForJobs([{ visitId }])).get(visitId)!;

async function charge(purchaseOrderId: string | null, amount: number, merchant: string, kind = "materials", at = SEP) {
  return prisma.cardSpend.create({
    data: { stripeTransactionId: `pim_${newId()}`, stripeCardId: "card_pim", truckId, kind, amount, merchantName: merchant, purchaseOrderId, occurredAt: at },
  });
}

beforeAll(async () => {
  truckId = await defaultTruckId();
  const customer = await prisma.customer.create({ data: { name: "PIM Co", phone: "+16155501234" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "Money House", addressLine1: "1 Money Ln", city: "Franklin", state: "TN", postalCode: "37064" },
  });
  propertyId = property.id;
  const mk = async (purpose: string, status = "completed") =>
    (await prisma.visit.create({ data: { customerId, propertyId, mode: "onsite", purpose, jobType: purpose, status, visitDate: SEP, completedAt: SEP } })).id;
  job = await mk("PIM job");
  quoteVisit = await mk("PIM quote", "estimate");
  soldJob = await mk("PIM sold job");
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: "pim draft", supplierId: "PIM-SUP" } });
  await prisma.issuedEstimate.create({
    data: {
      number: "0000-PIM-SOLD", token: `pim-token-${newId()}`, status: "signed", draftId: draft.id,
      customerId, serviceAddressId: propertyId, visitId: quoteVisit, jobVisitId: soldJob,
      customerName: "PIM Co", serviceAddress: "1 Money Ln, Franklin", title: "PIM sold",
      workSubtotal: 1000, total: 1000, selectedOptions: ["A"], signedAt: SEP, signedChannel: "email",
    },
  });
});

afterAll(async () => {
  await prisma.cardSpend.deleteMany({ where: { stripeCardId: "card_pim" } });
  await prisma.receipt.deleteMany({ where: { vendor: { startsWith: "PIM" } } });
  await prisma.purchaseOrder.deleteMany({ where: { supplier: { startsWith: "PIM" } } });
  await prisma.issuedEstimate.deleteMany({ where: { number: "0000-PIM-SOLD" } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: "pim draft" } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { customerId } });
  await prisma.customer.delete({ where: { id: customerId } });
});

describe("the P&L: charges + typed amounts + bills + fees, and nothing else", () => {
  it("the 9/17 split counts $765.74 once; the $765.74 receipt on the same P.O. adds nothing", async () => {
    const before = await september();
    const po = await createPurchaseOrder({ supplier: "PIM Home Depot", truckId, jobId: job, openedBy: "owner", actor: "test", openedAt: SEP });
    await charge(po.id, 651.73, "THE HOME DEPOT #0776");
    await charge(po.id, 114.01, "THE HOME DEPOT #0776");
    await prisma.receipt.create({
      data: { id: newId(), jobId: job, purchaseOrderId: po.id, category: "materials", vendor: "PIM Home Depot", amount: 765.74, status: "confirmed", source: "manual", receivedAt: SEP, imageData: jpg, imageMime: "image/jpeg" },
    });
    const after = await september();
    expect(r2(after.month.expenses - before.month.expenses)).toBe(765.74);
    expect(r2(after.category("materials") - before.category("materials"))).toBe(765.74);
    expect(await costOf(job)).toMatchObject({ materialCost: 765.74, materialSource: "po", po: { card: 765.74, typed: 0, net: 765.74, poCount: 1 } });
  });

  it("a receipt with no charge behind it is worth nothing until an amount is typed on its P.O. — the 9/3 $406.74 case", async () => {
    const before = await september();
    const po = await createPurchaseOrder({ supplier: "PIM Womack Depot", truckId, jobId: job, openedBy: "owner", actor: "test", openedAt: SEP });
    await prisma.receipt.create({
      data: { id: newId(), jobId: job, purchaseOrderId: po.id, category: "materials", vendor: "PIM Womack Depot", amount: 406.74, status: "confirmed", source: "manual", receivedAt: SEP },
    });
    expect((await september()).month.expenses).toBe(before.month.expenses);
    expect((await costOf(job)).materialCost).toBe(765.74);

    const typed = await request(app).patch(`/purchase-orders/${po.id}/money`).send({
      offCardAmount: 406.74, offCardMethod: "personal_card", offCardAt: `${YEAR}-09-03`, reason: "Paid on my personal card",
    });
    expect(typed.status).toBe(200);
    expect(typed.body.status).toBe("purchased"); // money typed on an open P.O. means the purchase happened
    const after = await september();
    expect(r2(after.month.expenses - before.month.expenses)).toBe(406.74);
    expect(await costOf(job)).toMatchObject({ materialCost: r2(765.74 + 406.74), po: { card: 765.74, typed: 406.74, poCount: 2 } });

    // Editable in any status (the standing rule), reason required, with a trail.
    await transitionPurchaseOrder(po.id, "cancelled", { actor: "test", reason: "test" });
    const noReason = await request(app).patch(`/purchase-orders/${po.id}/money`).send({ offCardAmount: 400 });
    expect(noReason.status).toBe(400);
    const edited = await request(app).patch(`/purchase-orders/${po.id}/money`).send({ offCardAmount: 400, reason: "Receipt says 400 after the return" });
    expect(edited.status).toBe(200);
    expect(edited.body.offCardAmount).toBe(400);
    const events = await prisma.purchaseOrderEvent.findMany({ where: { purchaseOrderId: po.id, kind: "money_edited" }, orderBy: { at: "asc" } });
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[1].before!)).toMatchObject({ offCardAmount: 406.74 });
    expect(JSON.parse(events[1].after!)).toMatchObject({ offCardAmount: 400 });
    expect((await costOf(job)).po?.typed).toBe(400);

    // Back on the card after all: the amount, method and date go together.
    const cleared = await request(app).patch(`/purchase-orders/${po.id}/money`).send({ offCardAmount: null, reason: "It was on the card" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.offCardAmount).toBeNull();
    expect(cleared.body.offCardMethod).toBeNull();
    expect((await september()).month.expenses).toBe(before.month.expenses);
  });

  it("the CSV carries every charge and typed amount, and no receipt row", async () => {
    const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { supplier: "PIM Womack Depot" } });
    await setPurchaseOrderMoney(po.id, { offCardAmount: 406.74, offCardMethod: "check", offCardAt: new Date(`${YEAR}-09-03T12:00:00Z`) }, { actor: "test", reason: "Typed for the export" });
    const csv = await request(app).get(`/financials/export?year=${YEAR}`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(`${YEAR}-09-17,expense,materials,"Card — THE HOME DEPOT #0776 (Truck 1)",651.73`);
    expect(csv.text).toContain(`${YEAR}-09-17,expense,materials,"Card — THE HOME DEPOT #0776 (Truck 1)",114.01`);
    expect(csv.text).toContain(`${YEAR}-09-03,expense,materials,"${po.number} — PIM Womack Depot (check)",406.74`);
    expect(csv.text).not.toContain("765.74");
  });
});

describe("the job: the money on its P.O.s, wherever they sit", () => {
  it("an ignored charge leaves the job and the P&L; a charge unlinked with a reason leaves the job but stays on the P&L", async () => {
    const before = await september();
    const po = await createPurchaseOrder({ supplier: "PIM Lowes", truckId, jobId: job, openedBy: "owner", actor: "test", openedAt: SEP });
    const a = await charge(po.id, 100, "LOWES #1");
    const b = await charge(po.id, 25, "LOWES #1");
    const start = (await costOf(job)).materialCost;

    await updateCardSpend(a.id, { status: "ignored" }, { actor: "test", reason: "Duplicate of the split" });
    expect((await costOf(job)).materialCost).toBe(r2(start - 100));
    expect(r2((await september()).month.expenses - before.month.expenses)).toBe(25);

    await updateCardSpend(b.id, { purchaseOrderId: null }, { actor: "test", reason: "Rang up on the wrong P.O." });
    expect((await costOf(job)).materialCost).toBe(r2(start - 125));
    expect(r2((await september()).month.expenses - before.month.expenses)).toBe(25);
    const detached = await prisma.purchaseOrderEvent.findFirst({ where: { purchaseOrderId: po.id, kind: "card_detached" } });
    expect(detached?.reason).toBe("Rang up on the wrong P.O.");
  });

  it("a permit charge on the job's P.O. is a fee, not material; a fuel charge is truck overhead", async () => {
    const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { supplier: "PIM Lowes" } });
    const start = (await costOf(job)).materialCost;
    await charge(po.id, 150, "RUTHERFORD COUNTY", "permit");
    await charge(po.id, 60, "SHELL", "fuel");
    expect((await costOf(job)).materialCost).toBe(start);
    const s = await september();
    expect(s.category("permit")).toBe(150);
    expect(s.category("gas")).toBe(60);
  });

  it("a P.O. opened on the quote visit belongs to the sold job — the helper follows the signed estimate on its own", async () => {
    const po = await createPurchaseOrder({ supplier: "PIM NES", truckId, jobId: quoteVisit, openedBy: "tech", actor: "test", openedAt: SEP });
    await charge(po.id, 45, "NES");
    expect(await costOf(soldJob)).toMatchObject({ materialCost: 45, materialSource: "po" });

    const [jobs, summary, profit] = await Promise.all([
      request(app).get("/jobs"),
      request(app).get(`/accounts/${customerId}/summary`),
      request(app).get(`/financials/job-profitability?year=${YEAR}`),
    ]);
    const fromJobs = jobs.body.find((j: { visitId: string }) => j.visitId === soldJob);
    const fromSummary = summary.body.jobs.find((j: { visitId: string }) => j.visitId === soldJob);
    const fromProfit = profit.body.find((j: { visitId: string }) => j.visitId === soldJob);
    expect(fromJobs.costs.materialCost).toBe(45);
    expect(fromSummary.costs).toEqual(fromJobs.costs);
    expect(fromProfit.materialSpend).toBe(45);
    expect(fromProfit.materialSource).toBe("po");
  });

  it("verified needs money AND proof; a typed amount plus a receipt file gets there with no amount comparison", async () => {
    const po = await createPurchaseOrder({ supplier: "PIM SiteOne", truckId, openedBy: "owner", actor: "test", openedAt: SEP });
    const upload = await request(app)
      .put(`/purchase-orders/${po.id}/receipts/${newId()}?vendor=PIM%20SiteOne&amount=381.90&category=materials`)
      .set("Content-Type", "image/jpeg")
      .send(jpg);
    expect(upload.status).toBe(201);
    // Proof but no money: purchased, not verified.
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe("purchased");
    await setPurchaseOrderMoney(po.id, { offCardAmount: 380, offCardMethod: "cash" }, { actor: "test", reason: "Cash, close enough is not the point" });
    const detail = await request(app).get(`/purchase-orders/${po.id}`);
    expect(detail.body.status).toBe("verified");
    expect(detail.body.proofCount).toBe(1);
    expect(detail.body.moneyTotal).toBe(380);
  });

  it("a test account's typed amounts stay out of the company P&L exactly like its charges", async () => {
    const before = await september();
    const test = await prisma.customer.create({ data: { name: "PIM Test Account", phone: "+16155509876", isTestAccount: true } });
    const prop = await prisma.property.create({ data: { customerId: test.id, name: "Bench", addressLine1: "0 Bench", city: "Franklin", state: "TN", postalCode: "37064" } });
    const practice = (await prisma.visit.create({ data: { customerId: test.id, propertyId: prop.id, mode: "onsite", purpose: "practice", status: "completed", visitDate: SEP } })).id;
    const po = await createPurchaseOrder({ supplier: "PIM Practice Supply", truckId, jobId: practice, openedBy: "owner", actor: "test", openedAt: SEP });
    await charge(po.id, 500, "PRACTICE");
    await setPurchaseOrderMoney(po.id, { offCardAmount: 300, offCardMethod: "cash", offCardAt: SEP }, { actor: "test", reason: "practice" });
    expect((await september()).month.expenses).toBe(before.month.expenses);
    await prisma.cardSpend.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.purchaseOrder.delete({ where: { id: po.id } });
    await prisma.visit.delete({ where: { id: practice } });
    await prisma.property.delete({ where: { id: prop.id } });
    await prisma.customer.delete({ where: { id: test.id } });
  });
});
