/**
 * The one-time pass that moves this month's card swipes onto the truck whose card made them
 * (Kyle, 2026-11-15; services/cardSpendReroute.ts, run by scripts/rerouteCardSpendByCard.ts).
 *
 * Dry by default; `apply` writes. A swipe whose card cannot be read is left where it is. A PO moves
 * with its swipe only when it was auto-drafted from that one swipe. Nothing here reaches Stripe: the
 * card lookup is a stub with the same shape as createCardResolver()'s.
 *
 * Review fix, 2026-11-15: the seeded rows carry what PRODUCTION holds — the OLDER truck's own ic_ card
 * (the old account routing stamped every swipe with it). The pass must not take that stamp as the card
 * that made the swipe; it asks Stripe (the stub) for every row.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;

import { chicagoMonthBounds, rerouteCardSpendByCard } from "../src/services/cardSpendReroute";
import type { CardLookup, CardResolver } from "../src/services/cardSpend";
import { createPurchaseOrder } from "../src/services/purchaseOrders";

const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const CARD_1 = `ic_rr1_${suffix}`;
const CARD_2 = `ic_rr2_${suffix}`;
const CARD_STRANGER = `ic_rrX_${suffix}`;
const AUTO_NOTE = "PO after the fact — created from card transaction";

// A fixed "now" mid-November 2026 (CDT ended 2026-11-01), so the month never depends on the day the suite runs.
const NOW = new Date("2026-11-15T18:00:00.000Z");
const inMonth = (day: number) => new Date(Date.UTC(2026, 10, day, 18));
const lastMonth = new Date("2026-10-20T18:00:00.000Z");

let t1: string;
let t2: string;
const ids: Record<string, string> = {};

/** A stub with createCardResolver()'s shape: the answer for each received-debit id. */
const asked: string[] = [];
function stubCards(answers: Record<string, CardLookup>): CardResolver {
  return { lookup: async (id) => { asked.push(id ?? "(none)"); return (id ? answers[id] : undefined) ?? { cardId: null, reason: "no answer in the stub" }; } };
}
const answers: Record<string, CardLookup> = {
  [`rd_${suffix}_1`]: { cardId: CARD_2, reason: null },
  [`rd_${suffix}_2`]: { cardId: CARD_1, reason: null },
  [`rd_${suffix}_3`]: { cardId: null, reason: "the key lacks received_debits read scope" },
  [`rd_${suffix}_4`]: { cardId: CARD_2, reason: null },
  [`rd_${suffix}_5`]: { cardId: CARD_STRANGER, reason: null },
  [`rd_${suffix}_6`]: { cardId: CARD_2, reason: null },
  [`rd_${suffix}_7`]: { cardId: CARD_2, reason: null },
  [`rd_${suffix}_8a`]: { cardId: CARD_2, reason: null },
  [`rd_${suffix}_8b`]: { cardId: CARD_2, reason: null },
  [`rd_${suffix}_9`]: { cardId: CARD_2, reason: null },
};

async function spend(key: string, input: { truckId: string; merchant: string; occurredAt: Date; poId?: string; status?: string; stripeCardId?: string }) {
  const row = await prisma.cardSpend.create({
    data: {
      stripeTransactionId: `trxn_${suffix}_${key}`,
      stripeAuthorizationId: `rd_${suffix}_${key}`,
      // Production's shape: the old account routing stamped the older truck's own ic_ card on every swipe.
      stripeCardId: input.stripeCardId ?? CARD_1,
      truckId: input.truckId,
      kind: "materials",
      amount: 25,
      merchantName: input.merchant,
      occurredAt: input.occurredAt,
      purchaseOrderId: input.poId ?? null,
      status: input.status ?? "unmatched",
    },
  });
  ids[key] = row.id;
  return row;
}

const reread = (key: string) => prisma.cardSpend.findUniqueOrThrow({ where: { id: ids[key] } });

beforeAll(async () => {
  // t1 is the older truck, the one the shared account used to send everything to.
  t1 = (await prisma.truck.create({ data: { name: `Reroute One ${suffix}`, stripeCardId: CARD_1 } })).id;
  t2 = (await prisma.truck.create({ data: { name: `Reroute Two ${suffix}`, stripeCardId: CARD_2 } })).id;

  const drafted = await createPurchaseOrder({
    purpose: "truck_stock", truckId: t1, supplier: "HOME DEPOT", openedBy: "system", openedAt: inMonth(10), notes: AUTO_NOTE, afterTheFact: true, actor: "system",
  });
  const officePo = await createPurchaseOrder({
    purpose: "truck_stock", truckId: t1, supplier: "LOWES", openedBy: "owner", openedAt: inMonth(11), actor: "owner",
  });
  const sharedDraft = await createPurchaseOrder({
    purpose: "truck_stock", truckId: t1, supplier: "CITY ELECTRIC", openedBy: "system", openedAt: inMonth(12), notes: AUTO_NOTE, afterTheFact: true, actor: "system",
  });
  ids.draftedPo = drafted.id;
  ids.officePo = officePo.id;
  ids.sharedPo = sharedDraft.id;

  await spend("1", { truckId: t1, merchant: "HOME DEPOT #1", occurredAt: inMonth(10), poId: drafted.id }); // moves, its auto-drafted PO moves
  await spend("2", { truckId: t1, merchant: "SHELL OIL", occurredAt: inMonth(10) }); // already right
  await spend("3", { truckId: t1, merchant: "SHELL OIL 2", occurredAt: inMonth(10) }); // card unknown
  await spend("4", { truckId: t1, merchant: "LOWES #2", occurredAt: inMonth(11), poId: officePo.id }); // moves, the office's PO stays
  await spend("5", { truckId: t1, merchant: "SOME OTHER CARD", occurredAt: inMonth(11) }); // card on no truck
  await spend("6", { truckId: t1, merchant: "LAST MONTH", occurredAt: lastMonth }); // not this month
  await spend("7", { truckId: t1, merchant: "IGNORED", occurredAt: inMonth(11), status: "ignored" }); // ignored
  await spend("8a", { truckId: t1, merchant: "CITY ELECTRIC", occurredAt: inMonth(12), poId: sharedDraft.id }); // moves; two swipes share the PO
  await spend("8b", { truckId: t1, merchant: "CITY ELECTRIC", occurredAt: inMonth(12), poId: sharedDraft.id });
  // Kyle already moved this one by hand (updateCardSpend changes truckId, not stripeCardId): on Two, still stamped
  // with One's card. The card on the debit is Two's, so it is already right and must NOT be moved back to One.
  await spend("9", { truckId: t2, merchant: "MOVED BY HAND", occurredAt: inMonth(13) });
});

afterAll(async () => {
  const poIds = [ids.draftedPo, ids.officePo, ids.sharedPo].filter(Boolean);
  await prisma.cardSpend.deleteMany({ where: { stripeTransactionId: { startsWith: `trxn_${suffix}_` } } });
  await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: { in: poIds } } });
  await prisma.purchaseOrderEvent.deleteMany({ where: { purchaseOrderId: { in: poIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
  await prisma.truck.deleteMany({ where: { id: { in: [t1, t2] } } });
});

describe("the America/Chicago calendar month", () => {
  it("runs from the 1st at Chicago midnight to the 1st of next month, across the daylight-saving change", () => {
    const nov = chicagoMonthBounds(NOW);
    expect(nov.label).toBe("2026-11");
    expect(nov.start.toISOString()).toBe("2026-11-01T05:00:00.000Z"); // CDT
    expect(nov.end.toISOString()).toBe("2026-12-01T06:00:00.000Z"); // CST
  });

  it("puts 11pm Chicago on the last day of the month in THAT month, though it is already the next day in UTC", () => {
    // 2026-12-01T04:30Z is still 22:30 on Nov 30 in Chicago (UTC-6).
    expect(chicagoMonthBounds(new Date("2026-12-01T04:30:00.000Z")).label).toBe("2026-11");
    expect(chicagoMonthBounds(new Date("2026-12-01T06:30:00.000Z")).label).toBe("2026-12");
  });
});

describe("dry run", () => {
  it("lists what would move and writes nothing", async () => {
    asked.length = 0;
    const report = await rerouteCardSpendByCard({ now: NOW, cards: stubCards(answers) });
    // Every row in the month was looked up on Stripe — a stored ic_ is never taken as the answer.
    const wanted = ["1", "2", "3", "4", "5", "8a", "8b", "9"].map((k) => `rd_${suffix}_${k}`);
    for (const rd of wanted) expect(asked).toContain(rd);
    const mine = report.lines.filter((l) => Object.values(ids).includes(l.spendId));

    expect(report.apply).toBe(false);
    expect(mine.filter((l) => l.outcome === "moved").map((l) => l.merchant).sort()).toEqual(["CITY ELECTRIC", "CITY ELECTRIC", "HOME DEPOT #1", "LOWES #2"]);
    expect(mine.filter((l) => l.outcome === "already_right").map((l) => l.merchant).sort()).toEqual(["MOVED BY HAND", "SHELL OIL"]);
    const unknown = mine.filter((l) => l.outcome === "card_unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].reason).toMatch(/received_debits/);
    expect(mine.filter((l) => l.outcome === "card_on_no_truck")).toHaveLength(1);
    // Last month's row and the ignored row are not in the pass at all.
    expect(mine.map((l) => l.merchant)).not.toContain("LAST MONTH");
    expect(mine.map((l) => l.merchant)).not.toContain("IGNORED");

    const hd = mine.find((l) => l.merchant === "HOME DEPOT #1")!;
    expect(hd.fromTruck).toContain("Reroute One");
    expect(hd.toTruck).toContain("Reroute Two");
    expect(hd.po?.purpose).toBe("truck_stock");
    expect(hd.poAction).toBe("moved");

    // Nothing written.
    expect((await reread("1")).truckId).toBe(t1);
    expect((await reread("1")).stripeCardId).toBe(CARD_1);
    expect((await reread("9")).truckId).toBe(t2);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: ids.draftedPo } })).truckId).toBe(t1);
  });
});

describe("--apply", () => {
  it("moves each row to its card's truck, moves only the PO that was drafted from that one swipe, and leaves unknown cards alone", async () => {
    const report = await rerouteCardSpendByCard({ apply: true, now: NOW, cards: stubCards(answers) });
    expect(report.apply).toBe(true);

    expect((await reread("1")).truckId).toBe(t2);
    expect((await reread("1")).stripeCardId).toBe(CARD_2);
    expect((await reread("4")).truckId).toBe(t2);
    expect((await reread("8a")).truckId).toBe(t2);
    expect((await reread("8b")).truckId).toBe(t2);

    // Already right keeps its truck and gains its real card id.
    expect((await reread("2")).truckId).toBe(t1);
    expect((await reread("2")).stripeCardId).toBe(CARD_1);
    // The row Kyle moved by hand stays on Two (it was never moved back to One) and gains Two's real card.
    expect((await reread("9")).truckId).toBe(t2);
    expect((await reread("9")).stripeCardId).toBe(CARD_2);

    // Unknown card, a card no truck owns, last month and an ignored row: exactly where they were.
    expect((await reread("3")).truckId).toBe(t1);
    expect((await reread("3")).stripeCardId).toBe(CARD_1); // not rewritten: nothing was confirmed
    expect((await reread("5")).truckId).toBe(t1);
    expect((await reread("6")).truckId).toBe(t1);
    expect((await reread("7")).truckId).toBe(t1);

    // The PO drafted from swipe 1 alone follows it, with an audit event...
    const drafted = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: ids.draftedPo } });
    expect(drafted.truckId).toBe(t2);
    const event = await prisma.purchaseOrderEvent.findFirst({ where: { purchaseOrderId: ids.draftedPo, kind: "edited" } });
    expect(event?.actor).toBe("system");
    // ...the office's PO and the PO carrying two swipes stay put.
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: ids.officePo } })).truckId).toBe(t1);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: ids.sharedPo } })).truckId).toBe(t1);

    const office = report.lines.find((l) => l.merchant === "LOWES #2")!;
    expect(office.poAction).toBe("left");
    expect(office.poNote).toMatch(/office opened it/);
  });

  it("a second pass has nothing left to move", async () => {
    const report = await rerouteCardSpendByCard({ apply: true, now: NOW, cards: stubCards(answers) });
    const mine = report.lines.filter((l) => Object.values(ids).includes(l.spendId));
    expect(mine.filter((l) => l.outcome === "moved")).toHaveLength(0);
    expect(mine.filter((l) => l.outcome === "already_right")).toHaveLength(6);
  });
});
