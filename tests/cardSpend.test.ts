/**
 * Trucks, cards, card spend (Kyle, 2026-09-09).
 *
 * "Each tech will have their own card for material and gas through stripe."
 * Spend routes to a truck BY THE CARD. Gas and maintenance sit on the truck;
 * a materials swipe with no PO behind it drafts one after the fact.
 *
 * Kyle, 2026-09-19 ("the P.O. is the money"): THE CHARGE IS THE MONEY, THE
 * RECEIPT IS PROOF. Every live charge lands on the P&L once; many charges may
 * sit on one PO (the $651.73 + $114.01 split); a PO is verified when it has
 * money and a receipt file, with no amount comparison; a receipt's amount
 * changes nothing.
 *
 * Kyle, 2026-09-21 ("one card charge, one expense", PUNCHLIST N9): classic
 * Issuing is not enabled on this account and its webhook events now create
 * NOTHING — the v2 money-management feed (`ingestFinancialAccountTransaction`)
 * is the ONE source of card spend. This file used to build its fixtures with
 * `ingestIssuingTransaction` (now deleted); every ingest below goes through
 * the v2 path instead, matching production. `tests/oneCardChargeOneExpense.test.ts`
 * pins that the Issuing webhook itself creates no row.
 *
 * No Stripe call is made anywhere in here: transactions are hand-built
 * objects, and STRIPE_SECRET_KEY is deleted so every Stripe read degrades to
 * { available: false }.
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
import { ingestFinancialAccountTransaction, merchantMatches } from "../src/services/cardSpend";
import { createPurchaseOrder, defaultTruckId } from "../src/services/purchaseOrders";

const newId = () => crypto.randomUUID().replaceAll("-", "");
const jpg = Buffer.from("ffd8ffe000104a464946", "hex");
// The v2 feed routes by FINANCIAL ACCOUNT id, but `truckForFinancialAccount`
// falls back to Truck.stripeCardId when no truck claims the account directly
// (services/cardSpend.ts) — so mapping the truck's stripeCardId to this
// string, same as production's Trucks page, is enough to route these rows.
const CARD = "fa_test_truck1";
const STRAY_CARD = "fa_test_nobody";

let truckId: string;
// Mid current month, noon local — every row in this file lands in one P&L column.
const base = new Date();
base.setDate(15);
base.setHours(12, 0, 0, 0);
const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);
const year = base.getFullYear();
const month = base.getMonth();

/** A v2 money-management transaction row, shaped like production (Kyle, 2026-09-10). */
function txn(input: { id: string; amount: number; merchant: string; created: Date; card?: string }) {
  return {
    id: input.id,
    object: "v2.money_management.transaction",
    amount: { value: input.amount, currency: "usd" },
    category: "received_debit",
    counterparty: { name: input.merchant },
    created: input.created.toISOString(),
    description: input.merchant,
    financial_account: input.card ?? CARD,
    flow: { received_debit: `rd_${input.id}`, type: "received_debit" },
    status: "posted",
    livemode: false,
  };
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

describe("supplier ~ merchant matching", () => {
  it("contains or first five alphanumerics", () => {
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

describe("ingesting v2 financial-account transactions", () => {
  it("a materials swipe with no PO behind it drafts a PO after the fact, purchased, on the card's truck", async () => {
    const pos = await poCount();
    const { spend, created } = await ingestFinancialAccountTransaction(txn({
      id: "trxn_hd_1", amount: -32433, merchant: "THE HOME DEPOT #0776", created: at(0),
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
    const again = await ingestFinancialAccountTransaction(txn({
      id: "trxn_hd_1", amount: -32433, merchant: "THE HOME DEPOT #0776", created: at(0),
    }));
    expect(again.created).toBe(false);
    expect(again.spend.purchaseOrderId).toBe(po.id);
    expect(await poCount()).toBe(pos + 1);
  });

  it("a swipe at the same store with an OPEN PO on the truck links to it — no new PO — and the PO becomes purchased", async () => {
    const open = await createPurchaseOrder({
      supplier: "Home Depot", truckId, openedBy: "owner", actor: "test", openedAt: at(5),
      lines: [{ name: "12-2 NM-B 250ft", qty: 1 }],
    });
    const pos = await poCount();
    const { spend } = await ingestFinancialAccountTransaction(txn({
      id: "trxn_hd_2", amount: -5000, merchant: "THE HOME DEPOT #0776", created: at(10),
    }));
    expect(spend.amount).toBe(50);
    expect(spend.purchaseOrderId).toBe(open.id);
    expect(await poCount()).toBe(pos);
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: open.id } });
    expect(po.status).toBe("purchased");
    expect(po.afterTheFact).toBe(false);
  });

  it("a fuel swipe sits on the truck ledger: kind fuel, no PO", async () => {
    const pos = await poCount();
    const { spend } = await ingestFinancialAccountTransaction(txn({
      id: "trxn_shell_1", amount: -6012, merchant: "SHELL OIL 57442", created: at(60),
    }));
    expect(spend.kind).toBe("fuel");
    expect(spend.amount).toBe(60.12);
    expect(spend.purchaseOrderId).toBeNull();
    expect(spend.truckId).toBe(truckId);
    expect(await poCount()).toBe(pos);
  });

  it("a refund is a negative spend that never drafts a PO; it rides the prior spend's PO at that store", async () => {
    const pos = await poCount();
    const { spend } = await ingestFinancialAccountTransaction(txn({
      id: "trxn_hd_refund", amount: 1500, merchant: "THE HOME DEPOT #0776", created: at(24 * 60),
    }));
    expect(spend.amount).toBe(-15);
    expect(spend.kind).toBe("materials");
    expect(await poCount()).toBe(pos);
    const prior = await spendFor("trxn_hd_2");
    expect(spend.purchaseOrderId).toBe(prior.purchaseOrderId);
  });

  it("an account no truck claims leaves truckId null (and never guesses)", async () => {
    const { spend } = await ingestFinancialAccountTransaction(txn({
      id: "trxn_stray", amount: -2000, merchant: "SOME OTHER STORE", created: at(90), card: STRAY_CARD,
    }));
    expect(spend.truckId).toBeNull();
    expect(spend.kind).toBe("other");
    expect(spend.purchaseOrderId).toBeNull();
  });
});

describe("many charges on one PO; verified when money and proof are both there (Kyle, 2026-09-19)", () => {
  let splitPoId: string;

  it("the 9/17 split: a second swipe at the same store minutes later joins the first swipe's after-the-fact PO", async () => {
    const pos = await poCount();
    const a = await ingestFinancialAccountTransaction(txn({
      id: "trxn_ces_split_a", amount: -65173, merchant: "CITY ELECTRIC SUPPLY 689", created: at(400),
    }));
    expect(await poCount()).toBe(pos + 1);
    const b = await ingestFinancialAccountTransaction(txn({
      id: "trxn_ces_split_b", amount: -11401, merchant: "CITY ELECTRIC SUPPLY 689", created: at(403),
    }));
    expect(b.spend.purchaseOrderId).toBe(a.spend.purchaseOrderId);
    expect(await poCount()).toBe(pos + 1);
    splitPoId = a.spend.purchaseOrderId!;

    const detail = await request(app).get(`/purchase-orders/${splitPoId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.cardSpends).toHaveLength(2);
    expect(detail.body.cardTotal).toBe(765.74);
    expect(detail.body.moneyTotal).toBe(765.74);
    expect(detail.body.proofCount).toBe(0);
    expect(detail.body.status).toBe("purchased");
  });

  it("a receipt file on the PO verifies it — the receipt's amount is not compared to the money", async () => {
    // The photo says $700.00, deliberately not $765.74: proof is proof.
    const res = await request(app)
      .put(`/purchase-orders/${splitPoId}/receipts/${newId()}?vendor=CS-test%20CES&amount=700&category=materials`)
      .set("Content-Type", "image/jpeg")
      .send(jpg);
    expect(res.status).toBe(201);
    const detail = await request(app).get(`/purchase-orders/${splitPoId}`);
    expect(detail.body.status).toBe("verified");
    expect(detail.body.proofCount).toBe(1);
    expect(detail.body.moneyTotal).toBe(765.74);
    expect(detail.body.events.map((e: { kind: string }) => e.kind)).toContain("status");
  });

  it("the typed not-on-card amount is the other money: it moves an open PO to purchased and lands on the P&L", async () => {
    const open = await createPurchaseOrder({ supplier: "CS-test Cash Supply", truckId, openedBy: "owner", actor: "test", openedAt: at(500) });
    const noReason = await request(app).patch(`/purchase-orders/${open.id}/money`).send({ offCardAmount: 40 });
    expect(noReason.status).toBe(400);
    const typed = await request(app).patch(`/purchase-orders/${open.id}/money`).send({
      offCardAmount: 40, offCardMethod: "cash", offCardAt: at(500).toISOString(), reason: "Paid cash at the counter",
    });
    expect(typed.status).toBe(200);
    expect(typed.body.offCardAmount).toBe(40);
    expect(typed.body.offCardMethod).toBe("cash");
    expect(typed.body.moneyTotal).toBe(40);
    expect(typed.body.status).toBe("purchased");
    const ev = await prisma.purchaseOrderEvent.findFirst({ where: { purchaseOrderId: open.id, kind: "money_edited" } });
    expect(ev?.reason).toBe("Paid cash at the counter");
    expect(JSON.parse(ev!.after!)).toMatchObject({ offCardAmount: 40 });
  });
});

describe("the P&L counts every charge once, and a receipt never", () => {
  it("expenses = live charges + typed amounts; the $700 receipt on the split PO adds nothing", async () => {
    const now = await summary();
    // Materials: 324.33 + 50.00 − 15.00 + 651.73 + 114.01 (charges) + 40.00 (typed cash).
    expect(r2(catMonth(now, "materials") - catMonth(before, "materials"))).toBe(r2(324.33 + 50 - 15 + 651.73 + 114.01 + 40));
    // Gas: SHELL only — the classic-Issuing webhook (Kyle, 2026-09-21) creates
    // no second EXXON row any more.
    expect(r2(catMonth(now, "gas") - catMonth(before, "gas"))).toBe(60.12);
    expect(r2(catMonth(now, "overhead") - catMonth(before, "overhead"))).toBe(20);
    const delta = now.months[month].expenses - before.months[month].expenses;
    expect(r2(delta)).toBe(r2(324.33 + 50 - 15 + 651.73 + 114.01 + 40 + 60.12 + 20));

    const csv = await request(app).get(`/financials/export?year=${year}`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("Card — SHELL OIL 57442");
    expect(csv.text).toContain("Card — CITY ELECTRIC SUPPLY 689 (Truck 1)\",651.73");
    expect(csv.text).toContain("Card — CITY ELECTRIC SUPPLY 689 (Truck 1)\",114.01");
    expect(csv.text).toContain("— CS-test Cash Supply (cash)\",40.00");
    expect(csv.text).not.toContain("700.00");
  });
});

describe("the truck ledger and hand edits", () => {
  it("GET /trucks rolls up MTD by kind and the charges still needing proof; GET /trucks/:id is the ledger", async () => {
    const list = await request(app).get("/trucks");
    expect(list.status).toBe(200);
    const truck = list.body.trucks.find((t: { id: string }) => t.id === truckId);
    expect(truck.cardLast4).toBe("4242");
    expect(truck.balance).toBeNull();
    expect(list.body.balancesAvailable).toBe(false);
    // MTD only when `base` is this month (it always is — base is the 15th of the current month).
    expect(truck.mtd.fuel).toBe(60.12);
    // hd_1 and hd_2 ride POs with no receipt file yet; the split PO is proven; the refund never prompts.
    expect(truck.unmatchedMaterials).toBe(2);
    expect(list.body.unassigned.other).toBe(20);

    const detail = await request(app).get(`/trucks/${truckId}?year=${year}`);
    expect(detail.status).toBe(200);
    const fuel = detail.body.ledger.find((k: { kind: string }) => k.kind === "fuel");
    expect(fuel.total).toBe(60.12);
    expect(fuel.rows.map((r: { merchantName: string }) => r.merchantName).sort()).toEqual(["SHELL OIL 57442"]);
    const materials = detail.body.ledger.find((k: { kind: string }) => k.kind === "materials");
    const hd1 = materials.rows.find((r: { stripeTransactionId: string }) => r.stripeTransactionId === "trxn_hd_1");
    expect(hd1.purchaseOrderNumber).toMatch(/^PO-\d{4}-\d{4}$/);
    expect(hd1.needsProof).toBe(true);
    expect(materials.rows.find((r: { stripeTransactionId: string }) => r.stripeTransactionId === "trxn_ces_split_a").proven).toBe(true);
    expect(detail.body.needingReceipt.map((r: { stripeTransactionId: string }) => r.stripeTransactionId).sort()).toEqual(["trxn_hd_1", "trxn_hd_2"]);
    expect(detail.body.purchaseOrders.some((p: { afterTheFact: boolean; cardMatched: boolean }) => p.afterTheFact && p.cardMatched)).toBe(true);
  });

  it("PATCH /card-spend/:id needs a reason; ignore, re-kind, PO link and unlink leave a trail", async () => {
    const stray = await spendFor("trxn_stray");
    const noReason = await request(app).patch(`/card-spend/${stray.id}`).send({ status: "ignored" });
    expect(noReason.status).toBe(400);
    const ignored = await request(app).patch(`/card-spend/${stray.id}`).send({ status: "ignored", reason: "Personal — reimbursed" });
    expect(ignored.status).toBe(200);
    expect(ignored.body.status).toBe("ignored");
    expect(ignored.body.ignoredReason).toBe("Personal — reimbursed");
    // Ignored spend leaves the P&L.
    const now = await summary();
    expect(r2(catMonth(now, "overhead") - catMonth(before, "overhead"))).toBe(0);

    const shell = await spendFor("trxn_shell_1");
    const rekind = await request(app).patch(`/card-spend/${shell.id}`).send({ kind: "maintenance", truckId, reason: "It was an oil change at the station" });
    expect(rekind.status).toBe(200);
    expect(rekind.body.kind).toBe("maintenance");
    expect(rekind.body.note).toBe("It was an oil change at the station");

    const hd2 = await spendFor("trxn_hd_2");
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

    // The way OUT (the standing rule): off the PO with a reason; the charge still counts on the P&L.
    const unlink = await request(app).patch(`/card-spend/${hd2.id}`).send({ purchaseOrderId: null, reason: "Belongs to no PO" });
    expect(unlink.status).toBe(200);
    expect(unlink.body.purchaseOrderId).toBeNull();
    const after = await summary();
    expect(r2(catMonth(after, "materials") - catMonth(now, "materials"))).toBe(0);
  });

  it("an after-the-fact PO cannot reach verified or closed without a receipt photo", async () => {
    const { spend } = await ingestFinancialAccountTransaction(txn({
      id: "trxn_menards_1", amount: -1200, merchant: "MENARDS #77", created: at(300),
    }));
    const poId = spend.purchaseOrderId!;
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).afterTheFact).toBe(true);

    // Since 2026-09-19 the photo is required a step earlier: verified means the
    // money is proved, so a PO with a charge and no receipt cannot get there.
    const verify = await request(app).post(`/purchase-orders/${poId}/status`).send({ to: "verified" });
    expect(verify.status).toBe(409);
    expect(verify.body.error).toMatch(/no receipt yet/i);
    const close = await request(app).post(`/purchase-orders/${poId}/status`).send({ to: "closed" });
    expect(close.status).toBe(409);

    // With the photo on it, the same PO verifies and closes.
    await prisma.receipt.create({
      data: { purchaseOrderId: poId, category: "materials", vendor: "MENARDS #77", amount: 12, imageMime: "image/jpeg", imageData: Buffer.from([1]) },
    });
    expect((await request(app).post(`/purchase-orders/${poId}/status`).send({ to: "verified" })).status).toBe(200);
    expect((await request(app).post(`/purchase-orders/${poId}/status`).send({ to: "closed" })).status).toBe(200);
  });
});
