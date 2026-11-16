/**
 * Move this month's card swipes onto the truck whose card made them (Kyle, 2026-11-15).
 *
 * "The cards are already assigned to the trucks though" — Truck.stripeCardId is set for both cards,
 * but until 2026-11-15 a swipe routed by the shared Field Expenses financial account and every one
 * landed on the oldest truck. New swipes now route by card (cardSpend.ts createCardResolver); this
 * is the one pass that moves the rows already on the wrong truck. It is only ever run by
 * scripts/rerouteCardSpendByCard.ts: dry by default, `--apply` writes.
 *
 * Rules (the same ones the ingest keeps):
 * - The card comes ONLY from the received debit behind the row, read from Stripe. The ic_ id stored on
 *   a row is never trusted: until 2026-11-15 the ingest stamped every account-routed row with the
 *   account truck's own card, so a stored ic_ is usually that truck's stamp, not the card that made
 *   the swipe (Kyle, 2026-11-15, review fix). A card that cannot be read leaves the row exactly where
 *   it is, with the reason printed.
 * - A card no truck owns also leaves the row where it is — the account fallback is for new swipes.
 * - A PO moves with its swipe ONLY when it was auto-drafted from that swipe ("PO after the fact", no
 *   other card spend on it, still on the truck the swipe was on, not landed into stock, not
 *   cancelled). Any other PO — one the office opened, a PO carrying several swipes, a landed one —
 *   stays put and is printed, because it is Kyle's document, not this row's.
 * - Ignored rows (voids, Kyle's own ignores) are off every money figure and are not touched.
 */

import { prisma } from "../lib/prisma";
import { logSystemEvent } from "./systemEvents";
import { createCardResolver, type CardResolver } from "./cardSpend";

export type RerouteOutcome = "moved" | "already_right" | "card_unknown" | "card_on_no_truck";

export interface RerouteLine {
  spendId: string;
  occurredAt: Date;
  merchant: string;
  amount: number;
  outcome: RerouteOutcome;
  /** The card that made the swipe, when it could be read. */
  cardId: string | null;
  fromTruck: string | null;
  toTruck: string | null;
  /** Why a card was unknown, or why it belongs to no truck. */
  reason: string | null;
  /** The PO the swipe sits on, with its own truck and purpose. */
  po: { number: string; truck: string | null; purpose: string; status: string } | null;
  /** What happened (or would happen) to that PO. */
  poAction: "moved" | "left" | null;
  poNote: string | null;
}

export interface RerouteReport {
  apply: boolean;
  monthLabel: string;
  lines: RerouteLine[];
  counts: { moved: number; alreadyRight: number; cardUnknown: number; cardOnNoTruck: number };
  posMoved: number;
}

// ─── America/Chicago calendar month ──────────────────────────────────────────

const chicagoParts = (d: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") };
};

/** The UTC instant at which America/Chicago reads 00:00 on the 1st of (year, month0). Chicago is UTC-5 or UTC-6. */
function chicagoMonthStart(year: number, month0: number): Date {
  for (const offsetHours of [5, 6]) {
    const candidate = new Date(Date.UTC(year, month0, 1, offsetHours));
    const p = chicagoParts(candidate);
    if (p.day === 1 && p.hour === 0) return candidate;
  }
  return new Date(Date.UTC(year, month0, 1, 6));
}

/** [start, end) of the Chicago calendar month containing `now`, and a label like "2026-11". */
export function chicagoMonthBounds(now: Date): { start: Date; end: Date; label: string } {
  const { year, month } = chicagoParts(now);
  const month0 = month - 1;
  return {
    start: chicagoMonthStart(year, month0),
    end: chicagoMonthStart(month0 === 11 ? year + 1 : year, (month0 + 1) % 12),
    label: `${year}-${String(month).padStart(2, "0")}`,
  };
}

// ─── The pass ────────────────────────────────────────────────────────────────

const AUTO_DRAFT_NOTE = "PO after the fact — created from card transaction";

/** The received-debit id a stored row came from (money.stripeAuthorizationId, else the raw feed row). */
function receivedDebitOf(row: { stripeAuthorizationId: string | null; rawJson: string | null }): string | null {
  if (row.stripeAuthorizationId) return row.stripeAuthorizationId;
  if (!row.rawJson) return null;
  try {
    const parsed = JSON.parse(row.rawJson) as { flow?: { received_debit?: string | null } };
    return parsed.flow?.received_debit ?? null;
  } catch {
    return null;
  }
}

export async function rerouteCardSpendByCard(
  opts: { apply?: boolean; now?: Date; cards?: CardResolver } = {},
): Promise<RerouteReport> {
  const apply = Boolean(opts.apply);
  const cards = opts.cards ?? createCardResolver();
  const { start, end, label } = chicagoMonthBounds(opts.now ?? new Date());

  const trucks = await prisma.truck.findMany({ select: { id: true, name: true, stripeCardId: true } });
  const truckById = new Map(trucks.map((t) => [t.id, t]));
  const truckByCard = new Map(trucks.filter((t) => t.stripeCardId).map((t) => [t.stripeCardId!, t]));

  const rows = await prisma.cardSpend.findMany({
    where: { occurredAt: { gte: start, lt: end }, status: { not: "ignored" } },
    orderBy: { occurredAt: "asc" },
    include: {
      purchaseOrder: {
        select: {
          id: true, number: true, status: true, purpose: true, truckId: true, afterTheFact: true, openedBy: true, notes: true,
          landedAt: true, _count: { select: { cardSpends: true } },
        },
      },
    },
  });

  const lines: RerouteLine[] = [];
  const counts = { moved: 0, alreadyRight: 0, cardUnknown: 0, cardOnNoTruck: 0 };
  let posMoved = 0;

  for (const row of rows) {
    const fromTruck = row.truckId ? truckById.get(row.truckId)?.name ?? row.truckId : null;
    const po = row.purchaseOrder
      ? { number: row.purchaseOrder.number, truck: row.purchaseOrder.truckId ? truckById.get(row.purchaseOrder.truckId)?.name ?? row.purchaseOrder.truckId : null, purpose: row.purchaseOrder.purpose, status: row.purchaseOrder.status }
      : null;
    const base = {
      spendId: row.id, occurredAt: row.occurredAt, merchant: row.merchantName, amount: row.amount, fromTruck, po,
    };

    // The real card, read off the received debit every time. The ic_ on the row is not evidence (see
    // the header): it is usually the truck-card stamp the old account routing wrote.
    const found = await cards.lookup(receivedDebitOf(row));
    const cardId: string | null = found.cardId;
    const reason: string | null = found.reason;
    if (!cardId) {
      counts.cardUnknown += 1;
      lines.push({ ...base, outcome: "card_unknown", cardId: null, toTruck: null, reason: reason ?? "the card could not be read", poAction: null, poNote: null });
      continue;
    }

    const target = truckByCard.get(cardId);
    if (!target) {
      counts.cardOnNoTruck += 1;
      lines.push({ ...base, outcome: "card_on_no_truck", cardId, toTruck: null, reason: `no truck has card ${cardId}`, poAction: null, poNote: null });
      continue;
    }

    if (row.truckId === target.id) {
      counts.alreadyRight += 1;
      lines.push({ ...base, outcome: "already_right", cardId, toTruck: target.name, reason: null, poAction: null, poNote: null });
      if (apply && row.stripeCardId !== cardId) {
        await prisma.cardSpend.update({ where: { id: row.id }, data: { stripeCardId: cardId } });
      }
      continue;
    }

    // The swipe moves. Its PO moves with it only when the PO was drafted from this swipe alone.
    const p = row.purchaseOrder;
    let poAction: RerouteLine["poAction"] = null;
    let poNote: string | null = null;
    if (p) {
      const draftedFromThisSwipe = p.afterTheFact && p.openedBy === "system" && (p.notes ?? "").startsWith(AUTO_DRAFT_NOTE);
      if (!draftedFromThisSwipe) poNote = "PO was not drafted from this swipe (the office opened it) — left on its truck";
      else if (p._count.cardSpends > 1) poNote = `${p._count.cardSpends} card swipes sit on this PO — left on its truck`;
      else if (p.truckId !== row.truckId) poNote = "PO is not on the truck the swipe was on — left alone";
      else if (p.landedAt) poNote = "PO's material has already landed into stock — left on its truck";
      else if (p.status === "cancelled") poNote = "PO is cancelled — left on its truck";
      poAction = poNote ? "left" : "moved";
    }

    lines.push({ ...base, outcome: "moved", cardId, toTruck: target.name, reason: null, poAction, poNote });
    counts.moved += 1;
    if (poAction === "moved") posMoved += 1;

    if (apply) {
      const why = `Re-routed from ${fromTruck ?? "no truck"} to ${target.name}: the swipe was made on ${target.name}'s card`;
      await prisma.$transaction(async (tx) => {
        await tx.cardSpend.update({
          where: { id: row.id },
          // A note Kyle wrote stays; the audit trail for the move is the system event below.
          data: { truckId: target.id, stripeCardId: cardId!, ...(row.note ? {} : { note: why }) },
        });
        if (p && poAction === "moved") {
          await tx.purchaseOrder.update({ where: { id: p.id }, data: { truckId: target.id } });
          await tx.purchaseOrderEvent.create({
            data: {
              purchaseOrderId: p.id, actor: "system", kind: "edited", reason: why,
              before: JSON.stringify({ truckId: p.truckId }), after: JSON.stringify({ truckId: target.id }),
            },
          });
        }
      });
      logSystemEvent("info", "card-spend", `${why} — ${row.merchantName} $${row.amount.toFixed(2)}`, {
        cardSpendId: row.id, cardId, fromTruckId: row.truckId, toTruckId: target.id, purchaseOrderId: p?.id ?? null, purchaseOrderMoved: poAction === "moved",
      });
    }
  }

  return { apply, monthLabel: label, lines, counts, posMoved };
}
