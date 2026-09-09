/**
 * Trucks, cards, card spend (Kyle, 2026-09-09).
 *
 * "Each tech will have their own card for material and gas through stripe."
 * Spend routes to a truck BY THE CARD. Gas and maintenance sit on the truck;
 * a materials swipe with no PO behind it drafts one after the fact; "photo
 * verifies, card proves" pairs the receipt with the money; and the P&L counts
 * every expense ONCE — a spend matched to a receipt rides that receipt.
 *
 * No Stripe call is made anywhere in here: transactions are hand-built
 * objects, and STRIPE_SECRET_KEY is deleted so every Stripe read degrades to
 * { available: false }.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import type Stripe from "stripe";
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
import { ingestIssuingTransaction, kindForCategory, matchReceipt, merchantMatches } from "../src/services/cardSpend";
import { createPurchaseOrder, defaultTruckId } from "../src/services/purchaseOrders";
import { dispatchStripeEvent } from "../src/services/stripePayments";

const newId = () => crypto.randomUUID().replaceAll("-", "");
const jpg = Buffer.from("ffd8ffe000104a464946", "hex");
const CARD = "ic_test_truck1";
const STRAY_CARD = "ic_test_nobody";

let truckId: string;
// Mid current month, noon local — every row in this file lands in one P&L column.
const base = new Date();
base.setDate(15);
base.setHours(12, 0, 0, 0);
const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);
const year = base.getFullYear();
const month = base.getMonth();

function tx(input: {
  id: string; amount: number; merchant: string; category: string; created: Date; card?: string; type?: "capture" | "refund";
}): Stripe.Issuing.Transaction {
  return {
    id: input.id,
    object: "issuing.transaction",
    amount: input.amount,
    authorization: `iauth_${input.id}`,
    card: input.card ?? CARD,
    created: Math.floor(input.created.getTime() / 1000),
    currency: "usd",
    livemode: false,
    merchant_amount: input.amount,
    merchant_currency: "usd",
    merchant_data: {
      category: input.category, category_code: "5200", city: "Smyrna", country: "US", name: input.merchant,
      network_id: "n", postal_code: "37167", state: "TN", terminal_id: null, url: null,
    },
    metadata: {},
    type: input.type ?? "capture",
  } as unknown as Stripe.Issuing.Transaction;
}

const poCount = () => prisma.purchaseOrder.count();
const spendFor = (stripeTransactionId: string) => prisma.cardSpend.findUniqueOrThrow({ where: { stripeTransactionId } });

type Summary = { months: { month: number; expenses: number }[]; expensesByCategory: { category: string; monthly: number[] }[] };
async function summary(): Promise<Summary> {
  const res = await request(app).get(`/financials/summary?year=${year}`);
  expect(res.status).toBe(200);
  return res.body as Summary;
}
const catMonth = (s: Summary, category: string) => s.expensesByCategory.find((c) => c.category === category)?.monthly[month] ?? 0;
const r2 = (n: number) => Math.round(n * 100) / 100;

beforeAll(async () => {
  await prisma.cardSpend.deleteMany();
  await prisma.receipt.deleteMany({ where: { vendor: { startsWith: "CS-test" } } });
  await prisma.receipt.updateMany({ where: { purchaseOrderId: { not: null } }, data: { purchaseOrderId: null } });
  await prisma.purchaseOrder.deleteMany();
  await prisma.purchaseOrderCounter.deleteMany();
  truckId = await defaultTruckId();
  await prisma.truck.update({ where: { id: truckId }, data: { stripeCardId: null, cardLast4: null, stripeFinancialAccountId: null } });
});

afterAll(async () => {
  await prisma.cardSpend.deleteMany();
  await prisma.receipt.deleteMany({ where: { vendor: { startsWith: "CS-test" } } });
  await prisma.purchaseOrder.deleteMany();
  await prisma.purchaseOrderCounter.deleteMany();
  await prisma.truck.update({ where: { id: truckId }, data: { stripeCardId: null, cardLast4: null, stripeFinancialAccountId: null } });
});

let before: Summary;

describe("merchant category → kind", () => {
  it("pins the explicit map", () => {
    expect(kindForCategory("service_stations")).toBe("fuel");
    expect(kindForCategory("automated_fuel_dispensers")).toBe("fuel");
    expect(kindForCategory("hardware_stores")).toBe("materials");
    expect(kindForCategory("nurseries_lawn_and_garden_supply_stores")).toBe("materials");
    expect(kindForCategory("automotive_service_shops")).toBe("maintenance");
    expect(kindForCategory("some_new_category")).toBe("other");
    expect(kindForCategory(null)).toBe("other");
  });

  it("supplier ~ merchant: contains or first five alphanumerics", () => {
    expect(merchantMatches("Home Depot", "THE HOME DEPOT #0776")).toBe(true);
    expect(merchantMatches("homedepot", "HOMEDEPOT0776")).toBe(true);
    expect(merchantMatches("City Electric", "CES 689")).toBe(false);
  });
});

describe("the card maps to the truck", () => {
  it("PATCH /trucks/:id sets the Issuing card; a second truck cannot claim the same card", async () => {
    before = await summary();
    const res = await request(app).patch(`/trucks/${truckId}`).send({ stripeCardId: CARD, cardLast4: "4242" });
    expect(res.status).toBe(200);
    expect(res.body.stripeCardId).toBe(CARD);
    expect(res.body.cardLast4).toBe("4242");

    const other = await request(app).post("/trucks").send({ name: "CS-test Truck 2" });
    expect(other.status).toBe(201);
    const clash = await request(app).patch(`/trucks/${other.body.id}`).send({ stripeCardId: CARD });
    expect(clash.status).toBe(409);
    await prisma.truck.delete({ where: { id: other.body.id } });
  });

  it("Stripe reads degrade gracefully without a key", async () => {
    const cards = await request(app).get("/trucks/stripe-cards");
    expect(cards.status).toBe(200);
    expect(cards.body.available).toBe(false);
    const balances = await request(app).get("/financials/balances");
    expect(balances.status).toBe(200);
    expect(balances.body.available).toBe(false);
    expect(balances.body.financialAccounts).toEqual([]);
    const sync = await request(app).post("/card-spend/sync").send({ days: 30 });
    expect(sync.status).toBe(200);
    expect(sync.body.available).toBe(false);
  });
});

describe("ingesting Issuing transactions", () => {
  it("a materials capture with no PO behind it drafts a PO after the fact, purchased, on the card's truck", async () => {
    const pos = await poCount();
    const { spend, created } = await ingestIssuingTransaction(tx({
      id: "ipi_hd_1", amount: -32433, merchant: "THE HOME DEPOT #0776", category: "home_supply_warehouse_stores", created: at(0),
    }));
    expect(created).toBe(true);
    expect(spend.amount).toBe(324.33);
    expect(spend.kind).toBe("materials");
    expect(spend.truckId).toBe(truckId);
    expect(spend.status).toBe("unmatched");
    expect(spend.purchaseOrderId).toBeTruthy();
    expect(await poCount()).toBe(pos + 1);

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: spend.purchaseOrderId! } });
    expect(po.afterTheFact).toBe(true);
    expect(po.status).toBe("purchased");
    expect(po.supplier).toBe("THE HOME DEPOT #0776");
    expect(po.purpose).toBe("truck_stock");
    expect(po.truckId).toBe(truckId);
    expect(po.openedBy).toBe("system");
    const events = await prisma.purchaseOrderEvent.findMany({ where: { purchaseOrderId: po.id }, orderBy: { at: "asc" } });
    expect(events.map((e) => e.kind)).toEqual(["created", "status", "card_matched"]);

    // Re-delivery of the same transaction is an update, not a second row or a second PO.
    const again = await ingestIssuingTransaction(tx({
      id: "ipi_hd_1", amount: -32433, merchant: "THE HOME DEPOT #0776", category: "home_supply_warehouse_stores", created: at(0),
    }));
    expect(again.created).toBe(false);
    expect(again.spend.purchaseOrderId).toBe(po.id);
    expect(await poCount()).toBe(pos + 1);
  });

  it("a capture at the same store with an OPEN PO on the truck links to it — no new PO — and the PO becomes purchased", async () => {
    const open = await createPurchaseOrder({
      supplier: "Home Depot", truckId, openedBy: "owner", actor: "test", openedAt: at(5),
      lines: [{ name: "12-2 NM-B 250ft", qty: 1 }],
    });
    const pos = await poCount();
    const { spend } = await ingestIssuingTransaction(tx({
      id: "ipi_hd_2", amount: -5000, merchant: "THE HOME DEPOT #0776", category: "home_supply_warehouse_stores", created: at(10),
    }));
    expect(spend.amount).toBe(50);
    expect(spend.purchaseOrderId).toBe(open.id);
    expect(await poCount()).toBe(pos);
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: open.id } });
    expect(po.status).toBe("purchased");
    expect(po.afterTheFact).toBe(false);
  });

  it("a fuel capture sits on the truck ledger: kind fuel, no PO", async () => {
    const pos = await poCount();
    const { spend } = await ingestIssuingTransaction(tx({
      id: "ipi_shell_1", amount: -6012, merchant: "SHELL OIL 57442", category: "service_stations", created: at(60),
    }));
    expect(spend.kind).toBe("fuel");
    expect(spend.amount).toBe(60.12);
    expect(spend.purchaseOrderId).toBeNull();
    expect(spend.truckId).toBe(truckId);
    expect(await poCount()).toBe(pos);
  });

  it("a refund is a negative spend that never drafts a PO; it rides the prior spend's PO at that store", async () => {
    const pos = await poCount();
    const { spend } = await ingestIssuingTransaction(tx({
      id: "ipi_hd_refund", amount: 1500, type: "refund", merchant: "THE HOME DEPOT #0776", category: "home_supply_warehouse_stores", created: at(24 * 60),
    }));
    expect(spend.amount).toBe(-15);
    expect(spend.kind).toBe("materials");
    expect(await poCount()).toBe(pos);
    const prior = await spendFor("ipi_hd_2");
    expect(spend.purchaseOrderId).toBe(prior.purchaseOrderId);
  });

  it("a card no truck claims leaves truckId null (and never guesses)", async () => {
    const { spend } = await ingestIssuingTransaction(tx({
      id: "ipi_stray", amount: -2000, merchant: "SOME OTHER STORE", category: "misc", created: at(90), card: STRAY_CARD,
    }));
    expect(spend.truckId).toBeNull();
    expect(spend.kind).toBe("other");
    expect(spend.purchaseOrderId).toBeNull();
  });

  it("the webhook dispatcher routes issuing_transaction.created into the same ingest", async () => {
    const event = {
      id: "evt_test_issuing", object: "event", type: "issuing_transaction.created",
      data: { object: tx({ id: "ipi_webhook_fuel", amount: -3000, merchant: "EXXON", category: "automated_fuel_dispensers", created: at(120) }) },
    } as unknown as Stripe.Event;
    await dispatchStripeEvent(prisma, event);
    const spend = await spendFor("ipi_webhook_fuel");
    expect(spend.kind).toBe("fuel");
    expect(spend.amount).toBe(30);
    expect(spend.truckId).toBe(truckId);
  });
});

describe("photo verifies, card proves", () => {
  it("a receipt off by 17 cents does NOT match; the exact one links, joins the spend's PO, and verifies it", async () => {
    const spend = await spendFor("ipi_hd_1");
    await prisma.receipt.create({
      // pending_review, so it also stays out of the P&L check below — only the match is under test here.
      data: { id: newId(), category: "materials", vendor: "CS-test Home Depot wrong", amount: 324.5, status: "pending_review", source: "tech_pwa", receivedAt: at(30) },
    });
    const miss = await matchReceipt(spend.id);
    expect(miss.receiptId).toBeNull();
    expect(miss.status).toBe("unmatched");

    const receipt = await prisma.receipt.create({
      data: {
        id: newId(), category: "materials", vendor: "CS-test Home Depot", amount: 324.33, status: "confirmed", source: "manual",
        receivedAt: at(30), imageData: jpg, imageMime: "image/jpeg",
      },
    });
    const hit = await matchReceipt(spend.id);
    expect(hit.receiptId).toBe(receipt.id);
    expect(hit.status).toBe("matched");
    const after = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(after.purchaseOrderId).toBe(spend.purchaseOrderId);
    // Photo + card agree → the after-the-fact PO is verified.
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: spend.purchaseOrderId! } });
    expect(po.status).toBe("verified");

    // The review queues carry the link.
    const needing = await request(app).get("/receipts-needing-po");
    expect(needing.status).toBe(200);
    expect(needing.body.find((r: { id: string }) => r.id === receipt.id)).toBeUndefined(); // it is on a PO now
  });

  it("confirming a receipt through the admin PATCH pairs it with the waiting spend", async () => {
    const spend = await spendFor("ipi_hd_2");
    expect(spend.receiptId).toBeNull();
    const receipt = await prisma.receipt.create({
      data: { id: newId(), category: "materials", vendor: "CS-test HD second", amount: 50, status: "pending_review", source: "tech_pwa", receivedAt: at(40) },
    });
    // Unconfirmed and untouched: nothing has matched yet.
    expect((await spendFor("ipi_hd_2")).receiptId).toBeNull();
    const res = await request(app).patch(`/health-record-admin/receipts/${receipt.id}`).send({ status: "confirmed" });
    expect(res.status).toBe(200);
    const matched = await spendFor("ipi_hd_2");
    expect(matched.receiptId).toBe(receipt.id);
    expect(matched.status).toBe("matched");
    expect(res.body.purchaseOrderId).toBe(matched.purchaseOrderId);

    const review = await request(app).get("/receipt-review");
    expect(review.status).toBe(200);
    expect(review.body.every((r: { cardMatched: boolean }) => typeof r.cardMatched === "boolean")).toBe(true);
  });
});

describe("the P&L counts every expense once", () => {
  it("matched spend rides its receipt; unmatched fuel / other / refund land on their own", async () => {
    const now = await summary();
    // Receipts: 324.33 + 50.00 (both matched — their spends are NOT added again).
    // Unmatched spend: fuel 60.12 + 30.00, other 20.00, materials refund −15.00.
    expect(r2(catMonth(now, "materials") - catMonth(before, "materials"))).toBe(r2(324.33 + 50 - 15));
    expect(r2(catMonth(now, "gas") - catMonth(before, "gas"))).toBe(r2(60.12 + 30));
    expect(r2(catMonth(now, "overhead") - catMonth(before, "overhead"))).toBe(20);
    const delta = now.months[month].expenses - before.months[month].expenses;
    expect(r2(delta)).toBe(r2(324.33 + 50 + 60.12 + 30 + 20 - 15));

    const csv = await request(app).get(`/financials/export?year=${year}`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("Card — SHELL OIL 57442");
    expect(csv.text).not.toContain("Card — THE HOME DEPOT #0776 (Truck 1)\",324.33");
  });
});

describe("the truck ledger and hand edits", () => {
  it("GET /trucks rolls up MTD by kind and the unmatched count; GET /trucks/:id is the ledger", async () => {
    const list = await request(app).get("/trucks");
    expect(list.status).toBe(200);
    const truck = list.body.trucks.find((t: { id: string }) => t.id === truckId);
    expect(truck.cardLast4).toBe("4242");
    expect(truck.balance).toBeNull();
    expect(list.body.balancesAvailable).toBe(false);
    // MTD only when `base` is this month (it always is — base is the 15th of the current month).
    expect(truck.mtd.fuel).toBe(r2(60.12 + 30));
    expect(truck.unmatchedMaterials).toBe(0);
    expect(list.body.unassigned.other).toBe(20);

    const detail = await request(app).get(`/trucks/${truckId}?year=${year}`);
    expect(detail.status).toBe(200);
    const fuel = detail.body.ledger.find((k: { kind: string }) => k.kind === "fuel");
    expect(fuel.total).toBe(r2(60.12 + 30));
    expect(fuel.rows.map((r: { merchantName: string }) => r.merchantName).sort()).toEqual(["EXXON", "SHELL OIL 57442"]);
    const materials = detail.body.ledger.find((k: { kind: string }) => k.kind === "materials");
    expect(materials.rows.find((r: { stripeTransactionId: string }) => r.stripeTransactionId === "ipi_hd_1").purchaseOrderNumber).toMatch(/^PO-\d{4}-\d{4}$/);
    expect(detail.body.purchaseOrders.some((p: { afterTheFact: boolean; cardMatched: boolean }) => p.afterTheFact && p.cardMatched)).toBe(true);
  });

  it("PATCH /card-spend/:id needs a reason; ignore, re-kind, and PO link leave a trail", async () => {
    const stray = await spendFor("ipi_stray");
    const noReason = await request(app).patch(`/card-spend/${stray.id}`).send({ status: "ignored" });
    expect(noReason.status).toBe(400);
    const ignored = await request(app).patch(`/card-spend/${stray.id}`).send({ status: "ignored", reason: "Personal — reimbursed" });
    expect(ignored.status).toBe(200);
    expect(ignored.body.status).toBe("ignored");
    expect(ignored.body.ignoredReason).toBe("Personal — reimbursed");
    // Ignored spend leaves the P&L.
    const now = await summary();
    expect(r2(catMonth(now, "overhead") - catMonth(before, "overhead"))).toBe(0);

    const shell = await spendFor("ipi_shell_1");
    const rekind = await request(app).patch(`/card-spend/${shell.id}`).send({ kind: "maintenance", truckId, reason: "It was an oil change at the station" });
    expect(rekind.status).toBe(200);
    expect(rekind.body.kind).toBe("maintenance");
    expect(rekind.body.note).toBe("It was an oil change at the station");

    const hd2 = await spendFor("ipi_hd_2");
    const oldPo = hd2.purchaseOrderId!;
    const newPo = await createPurchaseOrder({ supplier: "Lowes", truckId, openedBy: "owner", actor: "test", openedAt: at(200) });
    const relink = await request(app).patch(`/card-spend/${hd2.id}`).send({ purchaseOrderId: newPo.id, reason: "Rang up on the wrong PO" });
    expect(relink.status).toBe(200);
    expect(relink.body.purchaseOrderId).toBe(newPo.id);
    const detached = await prisma.purchaseOrderEvent.findFirst({ where: { purchaseOrderId: oldPo, kind: "card_detached" } });
    expect(detached?.reason).toBe("Rang up on the wrong PO");
    const attached = await prisma.purchaseOrderEvent.findFirst({ where: { purchaseOrderId: newPo.id, kind: "card_matched" } });
    expect(attached).not.toBeNull();
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: newPo.id } })).status).toBe("purchased");
  });

  it("an after-the-fact PO cannot close without a receipt photo", async () => {
    const { spend } = await ingestIssuingTransaction(tx({
      id: "ipi_lowes_1", amount: -1200, merchant: "LOWES #1234", category: "hardware_stores", created: at(300),
    }));
    const poId = spend.purchaseOrderId!;
    const verify = await request(app).post(`/purchase-orders/${poId}/status`).send({ to: "verified" });
    expect(verify.status).toBe(200);
    const close = await request(app).post(`/purchase-orders/${poId}/status`).send({ to: "closed" });
    expect(close.status).toBe(409);
    expect(close.body.error).toMatch(/receipt photo/);

    // Candidate receipts for the picker: none matched, right category, near in amount.
    const candidates = await request(app).get(`/card-spend/${spend.id}/receipt-candidates`);
    expect(candidates.status).toBe(200);
    expect(candidates.body.some((r: { vendor: string }) => r.vendor === "CS-test Home Depot wrong")).toBe(true);
  });
});
