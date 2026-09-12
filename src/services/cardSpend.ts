/**
 * Card spend — the money trail behind purchasing (Kyle, 2026-09-09).
 *
 * "Each tech will have their own card for material and gas through stripe and
 * I will have to set up a financial account for each." Every Stripe Issuing
 * transaction becomes a CardSpend, routed to a truck BY THE CARD (Truck.
 * stripeCardId) — never by guessing.
 *
 * Kyle, 2026-09-10: classic Issuing is NOT enabled on the account ("Your
 * account is not set up to use Issuing"). The Field Expenses card ••••3805 is
 * issued by Stripe's Financial Accounts product and its spend arrives on the
 * v2 money-management transaction feed (category received_debit, no merchant
 * category code). Those rows route BY THE FINANCIAL ACCOUNT
 * (Truck.stripeFinancialAccountId) through the same CardSpend upsert, kind
 * from the merchant name, settlement pending → posted (or void). Issuing
 * ingest stays for an account that has it.
 *
 * The rulings this file enforces:
 * - Gas and maintenance belong to the truck, never a job (per-truck overhead).
 *   Tools never enter job cost; a tool purchase is simply kind "tool".
 * - "PO first" is enforced by the money trail: a supplier card transaction
 *   with no PO behind it drafts a PO on its own, flagged "PO after the fact"
 *   (purpose truck_stock for that card's truck), which cannot close until a
 *   receipt photo is attached and the purpose confirmed.
 * - Photo verifies, card proves: the receipt photo is the itemized record; the
 *   card transaction is the money. A PO is verified when it has both and they
 *   agree.
 * - Expenses count ONCE: a spend matched to a receipt is counted by that
 *   receipt on the P&L (routes/financials.ts reads only unmatched spend).
 * - Job costing is unchanged: receipts on a job still count as that job's
 *   material. Nothing here touches jobCosting.ts / receiptCosting.ts.
 *
 * Every Stripe read degrades gracefully: the restricted key on Railway gets its
 * Issuing/Treasury read scope from Kyle in the Dashboard, and until then the
 * readers answer { available: false, reason } instead of throwing.
 */

import Stripe from "stripe";
import type { CardSpend, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logSystemEvent } from "./systemEvents";
import { stripe, stripeConfigured } from "./stripePayments";
import { attachReceiptToPurchaseOrder, createPurchaseOrder, transitionPurchaseOrder } from "./purchaseOrders";

// permit and inspection joined the list on 2026-09-11: they are JOB FEES, the
// third term in Kyle's commission math (job profit = revenue − material − fees).
// Never auto-assigned from a merchant — Kyle re-kinds the swipe with a reason.
export const CARD_SPEND_KINDS = ["materials", "fuel", "maintenance", "tool", "permit", "inspection", "other"] as const;
export type CardSpendKind = (typeof CARD_SPEND_KINDS)[number];
export const CARD_SPEND_STATUSES = ["unmatched", "matched", "ignored"] as const;
export type CardSpendStatus = (typeof CARD_SPEND_STATUSES)[number];

const round2 = (n: number) => Math.round(n * 100) / 100;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ─── Merchant category → kind ────────────────────────────────────────────────

const FUEL_CATEGORIES = new Set(["service_stations", "automated_fuel_dispensers", "fuel_dealers_non_automotive"]);
const MAINTENANCE_CATEGORIES = new Set([
  "automotive_service_shops", "auto_parts_and_accessories_stores", "car_washes", "automotive_tire_stores",
  "towing_services", "auto_body_repair_shops",
]);
const MATERIALS_CATEGORIES = new Set([
  "hardware_stores", "electrical_parts_and_equipment", "home_supply_warehouse_stores", "building_materials_lumber",
  "lumber_building_materials_stores", "plumbing_heating_equipment_and_supplies", "glass_paint_and_wallpaper_stores",
  // SiteOne is coded as a nursery.
  "nurseries_lawn_and_garden_supply_stores", "wholesale_clubs", "electronics_stores",
]);

/**
 * Stripe's merchant category slug → what the spend is. Explicit map, no
 * guessing: fuel and maintenance are truck overhead, materials go looking for
 * a PO, everything else is "other" until Kyle says otherwise. The MCC is
 * accepted for callers that only have the code, but the slug decides.
 */
export function kindForCategory(category: string | null | undefined, _mcc?: string | null): CardSpendKind {
  const slug = (category ?? "").trim().toLowerCase();
  if (FUEL_CATEGORIES.has(slug)) return "fuel";
  if (MAINTENANCE_CATEGORIES.has(slug)) return "maintenance";
  if (MATERIALS_CATEGORIES.has(slug)) return "materials";
  return "other";
}

/**
 * Kind from the merchant NAME, for feeds that carry no merchant category
 * (Kyle, 2026-09-10: the v2 money-management transaction has only
 * `counterparty.name`, e.g. "THE HOME DEPOT #0733/HERMITAGE/USA"). Explicit,
 * case-insensitive patterns; first list that matches wins. The order matters:
 * a rental yard is a tool before "AUTO" or "GAS" could catch it, and Harbor
 * Freight is a tool store, not a materials house. Anything unlisted is
 * "other" until Kyle re-kinds it with a reason.
 */
const KIND_PATTERNS: Array<[CardSpendKind, RegExp[]]> = [
  ["tool", [/SUNBELT\s*RENTALS?/i, /UNITED\s*RENTALS?/i, /HARBOR\s*FREIGHT/i, /RENTAL/i, /\bTOOL/i]],
  ["materials", [
    /HOME\s*DEPOT/i, /LOWE'?S/i, /CITY\s*ELECTRIC/i, /\bCES\b/i, /GRAYBAR/i, /SITE\s*ONE/i, /ELECTRICAL\s*SUPPLY/i,
    /WESCO/i, /REXEL/i, /MENARDS/i, /FASTENAL/i, /GRAINGER/i,
  ]],
  ["fuel", [
    /\bSHELL\b/i, /EXXON/i, /\bMOBIL\b/i, /\bBP\b/i, /MARATHON/i, /CHEVRON/i, /TEXACO/i, /CITGO/i, /SPEEDWAY/i, /\bPILOT\b/i,
    /LOVE'?S/i, /RACETRAC/i, /KROGER\s*FUEL/i, /\bWAWA\b/i, /SUNOCO/i, /\bFUEL\b/i, /\bGAS\b/i,
  ]],
  ["maintenance", [
    /AUTOZONE/i, /O'?REILLY/i, /ADVANCE\s*AUTO/i, /\bNAPA\b/i, /JIFFY\s*LUBE/i, /VALVOLINE/i, /DISCOUNT\s*TIRE/i, /FIRESTONE/i,
    /\bTIRE/i, /\bAUTO\b/i,
  ]],
];

export function kindForMerchantName(name: string | null | undefined): CardSpendKind {
  const text = (name ?? "").trim();
  if (!text) return "other";
  for (const [kind, patterns] of KIND_PATTERNS) {
    if (patterns.some((re) => re.test(text))) return kind;
  }
  return "other";
}

/**
 * The v2 feed's counterparty name is "MERCHANT/CITY/COUNTRY". Split the
 * trailing city and country off: "THE HOME DEPOT #0733/HERMITAGE/USA" →
 * { merchantName: "THE HOME DEPOT #0733", merchantCity: "HERMITAGE" }. A name
 * without that tail comes back whole with no city.
 */
export function splitCounterpartyName(raw: string | null | undefined): { merchantName: string; merchantCity: string | null } {
  const text = (raw ?? "").trim();
  if (!text) return { merchantName: "Unknown merchant", merchantCity: null };
  const parts = text.split("/").map((p) => p.trim());
  if (parts.length >= 3 && parts[parts.length - 1].length > 0 && parts[parts.length - 2].length > 0) {
    const merchantName = parts.slice(0, -2).join("/").trim();
    if (merchantName) return { merchantName, merchantCity: parts[parts.length - 2] };
  }
  return { merchantName: text, merchantCity: null };
}

/** "THE HOME DEPOT #0776" → "thehomedepot0776". */
export function normalizeMerchant(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Does a PO's supplier name mean the same store as a card merchant string?
 * One contains the other, or the first five alphanumerics agree
 * ("homedepot0776" ~ "homedepot"; "cityelectric" vs "ces689" does NOT — fine).
 */
export function merchantMatches(supplier: string, merchant: string): boolean {
  const a = normalizeMerchant(supplier);
  const b = normalizeMerchant(merchant);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  return a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5);
}

// ─── Ingest ───────────────────────────────────────────────────────────────────

class CardSpendError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "CardSpendError";
  }
}

function cardIdOf(tx: Stripe.Issuing.Transaction): string {
  return typeof tx.card === "string" ? tx.card : tx.card.id;
}

function authorizationIdOf(tx: Stripe.Issuing.Transaction): string | null {
  if (!tx.authorization) return null;
  return typeof tx.authorization === "string" ? tx.authorization : tx.authorization.id;
}

/**
 * Upsert the CardSpend for one Issuing transaction, then route it. Stripe
 * sends captures NEGATIVE in cents, so `-amount / 100` makes a purchase
 * positive and a refund negative. On an update event only the money fields
 * are refreshed — kind, truck, PO, receipt and status are Kyle's once he has
 * touched them.
 */
export async function ingestIssuingTransaction(
  tx: Stripe.Issuing.Transaction,
): Promise<{ spend: CardSpend; created: boolean }> {
  const cardId = cardIdOf(tx);
  const amount = round2(-(tx.amount ?? 0) / 100);
  const merchant = tx.merchant_data;
  const occurredAt = new Date((tx.created ?? Math.floor(Date.now() / 1000)) * 1000);
  const truck = await prisma.truck.findUnique({ where: { stripeCardId: cardId }, select: { id: true } });
  const existing = await prisma.cardSpend.findUnique({ where: { stripeTransactionId: tx.id } });

  const money = {
    stripeAuthorizationId: authorizationIdOf(tx),
    stripeCardId: cardId,
    amount,
    currency: tx.currency ?? "usd",
    merchantName: merchant?.name?.trim() || "Unknown merchant",
    merchantCategory: merchant?.category ?? null,
    merchantCategoryCode: merchant?.category_code ?? null,
    merchantCity: merchant?.city ?? null,
    merchantState: merchant?.state ?? null,
    occurredAt,
    rawJson: JSON.stringify(tx),
  };

  let spend: CardSpend;
  if (existing) {
    spend = await prisma.cardSpend.update({
      where: { id: existing.id },
      data: { ...money, ...(existing.truckId === null && truck ? { truckId: truck.id } : {}) },
    });
  } else {
    spend = await prisma.cardSpend.create({
      data: {
        stripeTransactionId: tx.id,
        ...money,
        truckId: truck?.id ?? null,
        kind: kindForCategory(merchant?.category, merchant?.category_code),
      },
    });
    if (!truck) {
      logSystemEvent("warn", "card-spend", `Card ${cardId} is not assigned to a truck — ${money.merchantName} $${amount.toFixed(2)} is sitting unrouted`, {
        stripeTransactionId: tx.id, cardId, amount, merchant: money.merchantName,
      });
    }
  }

  await routeCardSpend(spend.id);
  await matchReceipt(spend.id);
  const fresh = await prisma.cardSpend.findUniqueOrThrow({ where: { id: spend.id } });
  return { spend: fresh, created: !existing };
}

// ─── Ingest: v2 money-management transactions (Financial Accounts card) ──────

/**
 * One row of GET /v2/money_management/transactions as production returned it
 * (Kyle, 2026-09-10). Card spend is category "received_debit"; the amount is
 * minor units, negative for a purchase. No merchant category code exists.
 */
export interface FinancialAccountTransaction {
  id: string;
  object?: string;
  amount?: { value?: number; currency?: string } | null;
  category?: string | null;
  counterparty?: { name?: string | null } | null;
  created?: string | null;
  description?: string | null;
  financial_account?: string | null;
  flow?: { type?: string | null; received_debit?: string | null; [k: string]: unknown } | null;
  status?: string | null;
  status_transitions?: { posted_at?: string | null; void_at?: string | null } | null;
  livemode?: boolean;
  [k: string]: unknown;
}

export const SETTLEMENTS = ["pending", "posted", "void"] as const;
export type Settlement = (typeof SETTLEMENTS)[number];

function settlementOf(status: string | null | undefined): Settlement {
  const s = (status ?? "").trim().toLowerCase();
  return (SETTLEMENTS as readonly string[]).includes(s) ? (s as Settlement) : "posted";
}

/** Is this v2 row card spend? Transfers in from Payments, sweeps out, and fees are not. */
export function isCardSpendRow(row: FinancialAccountTransaction): boolean {
  return row.category === "received_debit" || row.flow?.type === "received_debit";
}

/**
 * The truck behind a financial account: Truck.stripeFinancialAccountId first
 * (the mapping Kyle makes on the Trucks page), else a truck whose card id was
 * typed as the account id. Never a guess.
 */
async function truckForFinancialAccount(financialAccountId: string | null): Promise<{ id: string; stripeCardId: string | null } | null> {
  if (!financialAccountId) return null;
  const byAccount = await prisma.truck.findFirst({
    where: { stripeFinancialAccountId: financialAccountId },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    select: { id: true, stripeCardId: true },
  });
  if (byAccount) return byAccount;
  return prisma.truck.findUnique({ where: { stripeCardId: financialAccountId }, select: { id: true, stripeCardId: true } });
}

/**
 * Upsert the CardSpend for one v2 money-management transaction, then route it
 * exactly like an Issuing row (Kyle, 2026-09-10: Issuing is not enabled on the
 * account; the ••••3805 card is issued by the Financial Accounts product).
 *
 * - amount = −value/100: a debit is a purchase (positive), a positive value is
 *   a refund (negative).
 * - merchantName / merchantCity come from counterparty.name split at
 *   "/CITY/USA"; the raw string stays in rawJson. No MCC → kindForMerchantName.
 * - stripeCardId is the truck's card id when a truck owns the account, else
 *   the financial account id — so a truck mapped later claims the rows.
 * - settlement mirrors Stripe's status; a void sets status "ignored", reason
 *   "voided by Stripe" — never a delete.
 * - On re-delivery only money, merchant and settlement refresh; kind, truck,
 *   PO, receipt and status stay Kyle's.
 */
export async function ingestFinancialAccountTransaction(
  row: FinancialAccountTransaction,
): Promise<{ spend: CardSpend; created: boolean; voided: boolean }> {
  if (!row?.id) throw new CardSpendError("v2 transaction has no id", 400);
  const financialAccountId = row.financial_account ?? null;
  const value = typeof row.amount?.value === "number" ? row.amount.value : 0;
  const amount = round2(-value / 100);
  const { merchantName, merchantCity } = splitCounterpartyName(row.counterparty?.name ?? row.description ?? null);
  const createdMs = row.created ? Date.parse(row.created) : NaN;
  const occurredAt = Number.isFinite(createdMs) ? new Date(createdMs) : new Date();
  const settlement = settlementOf(row.status);
  const truck = await truckForFinancialAccount(financialAccountId);
  const cardId = truck?.stripeCardId ?? financialAccountId ?? "fa_unknown";
  const existing = await prisma.cardSpend.findUnique({ where: { stripeTransactionId: row.id } });

  const money = {
    stripeAuthorizationId: row.flow?.received_debit ?? null,
    stripeCardId: cardId,
    amount,
    currency: (row.amount?.currency ?? "usd").toLowerCase(),
    merchantName,
    merchantCategory: null,
    merchantCategoryCode: null,
    merchantCity,
    merchantState: null,
    occurredAt,
    settlement,
    rawJson: JSON.stringify(row),
  };
  // A void never deletes: the row is ignored with the reason on it. Kyle's own
  // ignore reason, if he got there first, stays.
  const voidPatch = settlement === "void" && (existing?.status ?? "unmatched") !== "ignored"
    ? { status: "ignored" as const, ignoredReason: "voided by Stripe" }
    : {};
  const voided = Object.keys(voidPatch).length > 0;

  let spend: CardSpend;
  if (existing) {
    spend = await prisma.cardSpend.update({
      where: { id: existing.id },
      data: { ...money, ...voidPatch, ...(existing.truckId === null && truck ? { truckId: truck.id } : {}) },
    });
  } else {
    spend = await prisma.cardSpend.create({
      data: {
        stripeTransactionId: row.id,
        ...money,
        ...voidPatch,
        truckId: truck?.id ?? null,
        kind: kindForMerchantName(merchantName),
      },
    });
    if (!truck) {
      logSystemEvent("warn", "card-spend", `Financial account ${financialAccountId ?? "?"} is not assigned to a truck — ${merchantName} $${amount.toFixed(2)} is sitting unrouted`, {
        stripeTransactionId: row.id, financialAccountId, amount, merchant: merchantName,
      });
    }
  }

  await routeCardSpend(spend.id);
  await matchReceipt(spend.id);
  const fresh = await prisma.cardSpend.findUniqueOrThrow({ where: { id: spend.id } });
  return { spend: fresh, created: !existing, voided };
}

// ─── Routing: the PO behind the money ────────────────────────────────────────

async function poEvent(
  db: Prisma.TransactionClient | typeof prisma,
  purchaseOrderId: string,
  kind: "card_matched" | "card_detached",
  actor: string,
  reason: string | null,
  payload: Record<string, unknown>,
) {
  await db.purchaseOrderEvent.create({
    data: {
      purchaseOrderId, actor, kind, reason,
      ...(kind === "card_detached" ? { before: JSON.stringify(payload) } : { after: JSON.stringify(payload) }),
    },
  });
}

function spendPayload(spend: CardSpend) {
  return { cardSpendId: spend.id, merchant: spend.merchantName, amount: spend.amount, kind: spend.kind, occurredAt: spend.occurredAt };
}

/**
 * Materials spend goes looking for its PO: an open/purchased PO on the same
 * truck, same supplier, opened within 48 hours before the swipe, not already
 * backed by a card transaction. None found → the PO is drafted after the fact.
 * Refunds never draft a PO; they ride the PO of the prior spend at that store.
 * Fuel, maintenance, tool and other just sit on the truck ledger.
 */
export async function routeCardSpend(spendId: string): Promise<CardSpend> {
  const spend = await prisma.cardSpend.findUniqueOrThrow({ where: { id: spendId } });
  if (spend.purchaseOrderId || spend.kind !== "materials" || spend.status === "ignored") return spend;

  if (spend.amount < 0) {
    const prior = await prisma.cardSpend.findMany({
      where: {
        id: { not: spend.id },
        purchaseOrderId: { not: null },
        amount: { gt: 0 },
        occurredAt: { gte: new Date(spend.occurredAt.getTime() - 30 * DAY), lte: spend.occurredAt },
        ...(spend.truckId ? { truckId: spend.truckId } : {}),
      },
      orderBy: { occurredAt: "desc" },
      take: 50,
    });
    const match = prior.find((p) => merchantMatches(p.merchantName, spend.merchantName));
    if (!match?.purchaseOrderId) return spend;
    return prisma.$transaction(async (tx) => {
      const updated = await tx.cardSpend.update({ where: { id: spend.id }, data: { purchaseOrderId: match.purchaseOrderId } });
      await poEvent(tx, match.purchaseOrderId!, "card_matched", "system", "Refund at the same merchant within 30 days", spendPayload(updated));
      return updated;
    });
  }
  if (spend.amount === 0) return spend;

  // Kyle, 2026-09-11 (the duplicate POs 0005–0008): the card feed only became
  // readable a day after the purchases, by which time the office POs for them
  // had been verified by their receipts or landed and closed — and this search
  // only looked at "open"/"purchased", so it drafted a second PO for money that
  // already had one. Two fixes, strongest signal first:
  //  1. A receipt for exactly this amount, near this date, already sitting on a
  //     PO that has no card money yet → that PO is the one. Nothing beats the
  //     receipt that was photographed against it.
  //  2. Supplier match across every live status (open, purchased, verified,
  //     closed) within 7 days before the swipe, because the feed can lag.
  // A PO still takes one swipe only (cardSpends: none), so nothing doubles up.
  const byReceipt = await prisma.receipt.findFirst({
    where: {
      purchaseOrderId: { not: null },
      amount: { gte: spend.amount - 0.01, lte: spend.amount + 0.01 },
      receivedAt: { gte: new Date(spend.occurredAt.getTime() - 3 * DAY), lte: new Date(spend.occurredAt.getTime() + 3 * DAY) },
      purchaseOrder: { status: { not: "cancelled" }, cardSpends: { none: {} }, ...(spend.truckId ? { OR: [{ truckId: spend.truckId }, { truckId: null }] } : {}) },
    },
    orderBy: { receivedAt: "desc" },
    select: { purchaseOrderId: true },
  });
  const receiptPo = byReceipt?.purchaseOrderId
    ? await prisma.purchaseOrder.findUnique({ where: { id: byReceipt.purchaseOrderId } })
    : null;

  const candidates = receiptPo ? [] : await prisma.purchaseOrder.findMany({
    where: {
      status: { in: ["open", "purchased", "verified", "closed"] },
      ...(spend.truckId ? { truckId: spend.truckId } : {}),
      openedAt: { gte: new Date(spend.occurredAt.getTime() - 7 * DAY), lte: new Date(spend.occurredAt.getTime() + DAY) },
      cardSpends: { none: {} },
      afterTheFact: false,
    },
    orderBy: { openedAt: "desc" },
    take: 50,
  });
  const po = receiptPo ?? candidates.find((c) => merchantMatches(c.supplier, spend.merchantName));

  if (po) {
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.cardSpend.update({ where: { id: spend.id }, data: { purchaseOrderId: po.id } });
      await poEvent(tx, po.id, "card_matched", "system", "Card transaction matched to this PO", spendPayload(row));
      return row;
    });
    if (po.status === "open") {
      await transitionPurchaseOrder(po.id, "purchased", { actor: "system", reason: "Card transaction landed" });
    }
    return updated;
  }

  // No PO behind the money: draft one after the fact.
  const drafted = await createPurchaseOrder({
    purpose: "truck_stock",
    truckId: spend.truckId ?? undefined,
    supplier: spend.merchantName,
    openedBy: "system",
    openedAt: spend.occurredAt,
    notes: "PO after the fact — created from card transaction",
    afterTheFact: true,
    actor: "system",
  });
  await transitionPurchaseOrder(drafted.id, "purchased", { actor: "system", reason: "Card transaction landed (PO after the fact)" });
  return prisma.$transaction(async (tx) => {
    const row = await tx.cardSpend.update({ where: { id: spend.id }, data: { purchaseOrderId: drafted.id } });
    await poEvent(tx, drafted.id, "card_matched", "system", "PO drafted after the fact from this card transaction", spendPayload(row));
    return row;
  });
}

// ─── Receipt matching: photo verifies, card proves ───────────────────────────

/** Receipt categories that can itemize a spend of this kind. */
export function receiptCategoriesFor(kind: string): string[] {
  switch (kind) {
    case "materials": return ["materials"];
    case "fuel": return ["gas"];
    case "maintenance": return ["maintenance"];
    case "permit": return ["permit"];
    case "inspection": return ["inspection"];
    default: return ["overhead", "materials"];
  }
}

/** Spend kinds a receipt of this category can prove. */
function spendKindsFor(category: string): string[] {
  switch (category) {
    case "materials": return ["materials", "tool", "other"];
    case "gas": return ["fuel"];
    case "maintenance": return ["maintenance"];
    case "permit": return ["permit"];
    case "inspection": return ["inspection"];
    default: return ["other", "tool"];
  }
}

const RECEIPT_MATCH_SELECT = {
  id: true, jobId: true, purchaseOrderId: true, amount: true, category: true, receivedAt: true, imageMime: true, imageUrl: true,
} satisfies Prisma.ReceiptSelect;
type MatchableReceipt = Prisma.ReceiptGetPayload<{ select: typeof RECEIPT_MATCH_SELECT }>;

/**
 * Link one spend to one receipt: the spend is "matched", a receipt with no PO
 * joins the spend's PO (through the one attach path, so the job keeps rolling
 * and the trail gets its receipt_attached event), a spend with no PO takes the
 * receipt's, and a purchased PO that now has both photo and card — and they
 * agree on the amount — is verified.
 */
export async function linkSpendToReceipt(spendId: string, receiptId: string, actor: string, reason?: string | null): Promise<CardSpend> {
  const spend = await prisma.cardSpend.findUniqueOrThrow({ where: { id: spendId } });
  const receipt = await prisma.receipt.findUnique({ where: { id: receiptId }, select: { ...RECEIPT_MATCH_SELECT, cardSpend: { select: { id: true } } } });
  if (!receipt) throw new CardSpendError("Receipt not found", 404);
  if (receipt.cardSpend && receipt.cardSpend.id !== spend.id) throw new CardSpendError("That receipt already matches another card transaction.", 409);

  let purchaseOrderId = spend.purchaseOrderId;
  if (!purchaseOrderId && receipt.purchaseOrderId) purchaseOrderId = receipt.purchaseOrderId;

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.cardSpend.update({
      where: { id: spend.id },
      data: { receiptId: receipt.id, status: "matched", purchaseOrderId, ...(reason ? { note: reason } : {}) },
    });
    if (purchaseOrderId && purchaseOrderId !== spend.purchaseOrderId) {
      await poEvent(tx, purchaseOrderId, "card_matched", actor, reason ?? "Card transaction matched through its receipt", spendPayload(row));
    }
    return row;
  });

  if (purchaseOrderId && !receipt.purchaseOrderId) {
    await attachReceiptToPurchaseOrder(receipt.id, purchaseOrderId, actor);
  }
  if (purchaseOrderId) {
    const po = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, select: { status: true } });
    const agree = Math.abs(receipt.amount - spend.amount) <= 0.01;
    const photo = Boolean(receipt.imageMime || receipt.imageUrl);
    if (po?.status === "purchased" && agree && photo) {
      await transitionPurchaseOrder(purchaseOrderId, "verified", { actor, reason: "Receipt photo and card transaction agree" });
    }
  }
  return updated;
}

/** Detach the receipt; the spend goes back to unmatched (an ignored spend stays ignored). */
export async function unlinkSpendFromReceipt(spendId: string, reason: string): Promise<CardSpend> {
  const spend = await prisma.cardSpend.findUniqueOrThrow({ where: { id: spendId } });
  return prisma.cardSpend.update({
    where: { id: spendId },
    data: { receiptId: null, note: reason, ...(spend.status === "matched" ? { status: "unmatched" } : {}) },
  });
}

function closestInTime<T extends { receivedAt: Date }>(rows: T[], at: Date): T | undefined {
  return [...rows].sort((a, b) => Math.abs(a.receivedAt.getTime() - at.getTime()) - Math.abs(b.receivedAt.getTime() - at.getTime()))[0];
}

/**
 * Find the receipt that itemizes this spend: first the receipts already on the
 * linked PO, else any receipt with no card match, of a category this kind can
 * have, within a cent and three days. Closest in time wins.
 */
export async function matchReceipt(spendId: string): Promise<CardSpend> {
  const spend = await prisma.cardSpend.findUniqueOrThrow({ where: { id: spendId } });
  if (spend.receiptId || spend.status === "ignored" || spend.amount <= 0) return spend;

  const amountWindow = { gte: spend.amount - 0.011, lte: spend.amount + 0.011 };
  let candidates: MatchableReceipt[] = [];
  if (spend.purchaseOrderId) {
    candidates = await prisma.receipt.findMany({
      where: { purchaseOrderId: spend.purchaseOrderId, cardSpend: null, amount: amountWindow },
      select: RECEIPT_MATCH_SELECT,
    });
  }
  if (candidates.length === 0) {
    candidates = await prisma.receipt.findMany({
      where: {
        cardSpend: null,
        category: { in: receiptCategoriesFor(spend.kind) },
        amount: amountWindow,
        receivedAt: { gte: new Date(spend.occurredAt.getTime() - 3 * DAY), lte: new Date(spend.occurredAt.getTime() + 3 * DAY) },
      },
      select: RECEIPT_MATCH_SELECT,
    });
  }
  const pick = closestInTime(candidates.filter((r) => Math.abs(r.amount - spend.amount) <= 0.01), spend.occurredAt);
  if (!pick) return spend;
  return linkSpendToReceipt(spend.id, pick.id, "system", null);
}

/**
 * The receipt side of the same match — called after a receipt is confirmed,
 * its amount edited, or uploaded from the CRM/tech app. Same rule, mirrored:
 * an unmatched spend of a kind this receipt's category can prove, within a
 * cent and three days; a spend on the receipt's own PO wins, then closest.
 */
export async function matchSpendForReceipt(receiptId: string): Promise<CardSpend | null> {
  const receipt = await prisma.receipt.findUnique({
    where: { id: receiptId },
    select: { ...RECEIPT_MATCH_SELECT, cardSpend: { select: { id: true } } },
  });
  if (!receipt || receipt.cardSpend || receipt.amount <= 0) return null;
  const spends = await prisma.cardSpend.findMany({
    where: {
      status: "unmatched",
      receiptId: null,
      kind: { in: spendKindsFor(receipt.category) },
      amount: { gte: receipt.amount - 0.011, lte: receipt.amount + 0.011 },
      occurredAt: { gte: new Date(receipt.receivedAt.getTime() - 3 * DAY), lte: new Date(receipt.receivedAt.getTime() + 3 * DAY) },
    },
  });
  const close = spends.filter((s) => Math.abs(s.amount - receipt.amount) <= 0.01);
  if (close.length === 0) return null;
  const onPo = receipt.purchaseOrderId ? close.find((s) => s.purchaseOrderId === receipt.purchaseOrderId) : undefined;
  const pick = onPo ?? [...close].sort((a, b) =>
    Math.abs(a.occurredAt.getTime() - receipt.receivedAt.getTime()) - Math.abs(b.occurredAt.getTime() - receipt.receivedAt.getTime()))[0];
  return linkSpendToReceipt(pick.id, receipt.id, "system", null);
}

// ─── Stripe reads (graceful when the key lacks scope) ────────────────────────

export interface Unavailable { available: false; reason: string }

/** Was this a scope refusal, and what to tell Kyle. Shared with services/treasury.ts. */
export function describeStripeError(err: unknown): { permission: boolean; reason: string } {
  const e = err as { type?: string; code?: string; message?: string; statusCode?: number };
  const message = e?.message ?? String(err);
  const permission = e?.statusCode === 403 || e?.statusCode === 401 || e?.type === "StripePermissionError"
    || /permission|not have access|restricted|does not have the required/i.test(message);
  return {
    permission,
    reason: permission
      ? `The Stripe key on the server is not permitted to read this yet — add Issuing and Money Management (financial accounts) read scope to the restricted key in the Stripe Dashboard. (${message})`
      : message,
  };
}

/**
 * Pull every Issuing transaction from the last `sinceDays` days and ingest it.
 * Idempotent (upsert by transaction id) — safe to run on a schedule or by hand.
 */
export async function syncIssuingTransactions(
  sinceDays: number,
  opts: { dry?: boolean } = {},
): Promise<{ available: true; seen: number; created: number; updated: number; dry: boolean; transactions: { id: string; merchant: string; amount: number; category: string | null; card: string; occurredAt: Date }[] } | Unavailable> {
  if (!stripeConfigured()) return { available: false, reason: "STRIPE_SECRET_KEY is not set." };
  const days = Number.isFinite(sinceDays) && sinceDays > 0 ? Math.min(sinceDays, 365) : 30;
  const gte = Math.floor((Date.now() - days * DAY) / 1000);
  let seen = 0, created = 0, updated = 0;
  const transactions: { id: string; merchant: string; amount: number; category: string | null; card: string; occurredAt: Date }[] = [];
  try {
    for await (const tx of stripe().issuing.transactions.list({ created: { gte }, limit: 100 })) {
      seen += 1;
      transactions.push({
        id: tx.id, merchant: tx.merchant_data?.name ?? "?", amount: round2(-(tx.amount ?? 0) / 100),
        category: tx.merchant_data?.category ?? null, card: cardIdOf(tx), occurredAt: new Date(tx.created * 1000),
      });
      if (opts.dry) continue;
      const result = await ingestIssuingTransaction(tx);
      if (result.created) created += 1; else updated += 1;
    }
  } catch (err) {
    const { permission, reason } = describeStripeError(err);
    logSystemEvent(permission ? "warn" : "error", "card-spend", `Issuing sync stopped: ${reason}`, { seen, created, updated });
    return { available: false, reason };
  }
  return { available: true, seen, created, updated, dry: Boolean(opts.dry), transactions };
}

// ─── v2 money-management sync (Kyle, 2026-09-10) ─────────────────────────────
//
// "Your account is not set up to use Issuing" — the Field Expenses card
// ••••3805 is issued by Stripe's Financial Accounts product, and its spend is
// on GET /v2/money_management/transactions (preview API version). No webhook
// reaches the classic endpoint for v2 objects, so this is polled from
// server.ts every ten minutes. Rows are read for EVERY financial account, not
// only the mapped ones, so unrouted spend is visible on the Trucks page.

export interface SyncedTransaction { id: string; merchant: string; amount: number; category: string | null; card: string; occurredAt: Date; settlement?: string }
export interface SyncCounts { seen: number; created: number; updated: number; voided: number }
export type SyncResult = ({ available: true; dry: boolean; transactions: SyncedTransaction[] } & SyncCounts) | Unavailable;

/** Non-card categories already logged this process — one INFO per category, so we learn the feed without flooding it. */
const seenNonCardCategories = new Set<string>();

/** Strip the origin off a v2 `next_page_url` (Stripe returns a path; be safe if it ever returns a full URL). */
function pagePath(nextPageUrl: string): string {
  return nextPageUrl.replace(/^https?:\/\/[^/]+/i, "");
}

/**
 * Every v2 transaction on one financial account created since `since`,
 * following `next_page_url` until it is absent or the page is entirely older
 * than the window. `created_gte` is sent as a filter; the window is enforced
 * here too, so an ignored filter costs pages, never correctness.
 */
export async function listFinancialAccountTransactions(
  financialAccountId: string,
  since: Date,
  opts: { limit?: number; maxPages?: number } = {},
): Promise<FinancialAccountTransaction[]> {
  const limit = opts.limit ?? 100;
  const maxPages = opts.maxPages ?? 50;
  const out: FinancialAccountTransaction[] = [];
  const first = `/v2/money_management/transactions?limit=${limit}&financial_account=${encodeURIComponent(financialAccountId)}&created_gte=${encodeURIComponent(since.toISOString())}`;
  let path: string | null = first;
  let pages = 0;
  while (path && pages < maxPages) {
    pages += 1;
    let res: { data?: FinancialAccountTransaction[]; next_page_url?: string | null };
    try {
      res = (await stripe().rawRequest("GET", path, undefined, { apiVersion: previewApiVersion() })) as typeof res;
    } catch (err) {
      // The filter name is the one unverified piece of the request: if Stripe
      // rejects it, list unfiltered and let the window below do the work.
      if (pages === 1 && /created_gte/i.test((err as Error)?.message ?? "")) {
        path = `/v2/money_management/transactions?limit=${limit}&financial_account=${encodeURIComponent(financialAccountId)}`;
        pages = 0;
        continue;
      }
      throw err;
    }
    const rows = Array.isArray(res?.data) ? res.data : [];
    let allOlder = rows.length > 0;
    for (const row of rows) {
      const ms = row.created ? Date.parse(row.created) : NaN;
      const inWindow = !Number.isFinite(ms) || ms >= since.getTime();
      if (inWindow) { out.push(row); allOlder = false; }
    }
    path = res?.next_page_url && !allOlder ? pagePath(res.next_page_url) : null;
  }
  return out;
}

/**
 * Pull card spend from the v2 money-management feed for the last `sinceDays`
 * days and ingest it. Idempotent (upsert by transaction id). Categories other
 * than received_debit — transfers in from Payments, outbound sweeps, fees —
 * are NOT card spend: each new one is logged once (INFO) and not stored.
 */
export async function syncFinancialAccountTransactions(
  { sinceDays, dry }: { sinceDays: number; dry?: boolean },
): Promise<SyncResult> {
  if (!stripeConfigured()) return { available: false, reason: "STRIPE_SECRET_KEY is not set." };
  const days = Number.isFinite(sinceDays) && sinceDays > 0 ? Math.min(sinceDays, 365) : 30;
  const since = new Date(Date.now() - days * DAY);
  let seen = 0, created = 0, updated = 0, voided = 0;
  const transactions: SyncedTransaction[] = [];
  try {
    const accounts = await listFinancialAccounts();
    for (const fa of accounts) {
      const rows = await listFinancialAccountTransactions(fa.id, since);
      for (const row of rows) {
        if (!isCardSpendRow(row)) {
          const category = row.category ?? row.flow?.type ?? "unknown";
          if (!seenNonCardCategories.has(category)) {
            seenNonCardCategories.add(category);
            logSystemEvent("info", "card-spend", `v2 transaction category ${category} seen — not card spend`, {
              financialAccountId: fa.id, stripeTransactionId: row.id, amount: row.amount?.value ?? null, status: row.status ?? null,
            });
          }
          continue;
        }
        seen += 1;
        const { merchantName } = splitCounterpartyName(row.counterparty?.name ?? row.description ?? null);
        transactions.push({
          id: row.id, merchant: merchantName, amount: round2(-(row.amount?.value ?? 0) / 100), category: null, card: fa.id,
          occurredAt: row.created ? new Date(row.created) : new Date(), settlement: settlementOf(row.status),
        });
        if (dry) continue;
        const result = await ingestFinancialAccountTransaction(row);
        if (result.created) created += 1; else updated += 1;
        if (result.voided) voided += 1;
      }
    }
  } catch (err) {
    const { permission, reason } = describeStripeError(err);
    logSystemEvent(permission ? "warn" : "error", "card-spend", `v2 card-spend sync stopped: ${reason}`, { seen, created, updated, voided });
    return { available: false, reason };
  }
  return { available: true, seen, created, updated, voided, dry: Boolean(dry), transactions };
}

/** Per-process memory of "Your account is not set up to use Issuing" — probed once, not every ten minutes. */
let issuingProbe: "unknown" | "unavailable" = "unknown";
/** Test hook: forget the Issuing answer. */
export function resetIssuingProbe(): void {
  issuingProbe = "unknown";
}
export function issuingUnavailableCached(): boolean {
  return issuingProbe === "unavailable";
}

export interface CardSpendSyncSummary extends SyncCounts {
  available: boolean;
  reason?: string;
  dry: boolean;
  transactions: SyncedTransaction[];
  /** What each feed said, for the script and the log. */
  feeds: { financialAccounts: SyncResult; issuing: SyncResult | null };
}

/**
 * The one sync: v2 money-management first (that is where the ••••3805 card
 * lives), then classic Issuing only while the account has it. "Not set up to
 * use Issuing" is remembered for the life of the process and logged once.
 * The route, the script and the cron all call this.
 */
export async function syncCardSpend(sinceDays: number, opts: { dry?: boolean } = {}): Promise<CardSpendSyncSummary> {
  const v2 = await syncFinancialAccountTransactions({ sinceDays, dry: opts.dry });
  let issuing: SyncResult | null = null;
  if (issuingProbe !== "unavailable") {
    const raw = await syncIssuingTransactions(sinceDays, opts);
    issuing = raw.available ? { ...raw, voided: 0 } : raw;
    if (!raw.available && /not set up to use Issuing/i.test(raw.reason)) {
      issuingProbe = "unavailable";
      logSystemEvent("info", "card-spend", "Issuing is not enabled on this Stripe account — card spend is read from the v2 money-management feed only (remembered for this process)");
    }
  }
  const feeds = [v2, issuing].filter((f): f is Extract<SyncResult, { available: true }> => Boolean(f?.available));
  const sum = (k: keyof SyncCounts) => feeds.reduce((s, f) => s + f[k], 0);
  const available = feeds.length > 0;
  return {
    available,
    reason: available ? undefined : (v2.available ? undefined : v2.reason),
    seen: sum("seen"), created: sum("created"), updated: sum("updated"), voided: sum("voided"),
    dry: Boolean(opts.dry),
    transactions: feeds.flatMap((f) => f.transactions),
    feeds: { financialAccounts: v2, issuing },
  };
}

export interface IssuingCardRow { id: string; last4: string; cardholderName: string | null; status: string; financialAccountId: string | null }

/** The Issuing cards, for the truck picker. */
export async function listIssuingCards(): Promise<{ available: true; cards: IssuingCardRow[] } | Unavailable> {
  if (!stripeConfigured()) return { available: false, reason: "STRIPE_SECRET_KEY is not set." };
  try {
    const list = await stripe().issuing.cards.list({ limit: 100 });
    return {
      available: true,
      cards: list.data.map((c) => ({
        id: c.id,
        last4: c.last4,
        cardholderName: typeof c.cardholder === "object" && c.cardholder ? c.cardholder.name : null,
        status: c.status,
        financialAccountId: (c as { financial_account?: string | null }).financial_account ?? null,
      })),
    };
  } catch (err) {
    return { available: false, reason: describeStripeError(err).reason };
  }
}

export interface FinancialAccountBalance {
  id: string;
  cashUsd: number;
  inboundPending: number;
  outboundPending: number;
  status: string;
  truckId: string | null;
  truckName: string | null;
}
export interface Balances {
  payments: { available: number; pending: number } | null;
  financialAccounts: FinancialAccountBalance[];
  available: boolean;
  reason?: string;
  readAt: Date;
}

const BALANCE_TTL = 5 * 60 * 1000;
let balanceCache: { at: number; value: Balances } | null = null;

/** Test/diagnostic hook: forget the cached balances. */
export function resetBalancesCache(): void {
  balanceCache = null;
}

/**
 * Payments balance + every Treasury financial account with its truck. Cached
 * in-process for five minutes — Financials and every truck row read it.
 */
/**
 * The preview Stripe-Version for v2 preview endpoints: the SDK's pinned
 * version date with ".preview" in place of its release name
 * ("2026-07-29.dahlia" → "2026-07-29.preview").
 */
export function previewApiVersion(): string {
  const pinned = String(Stripe.API_VERSION ?? "");
  const date = pinned.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return date ? `${date}.preview` : pinned;
}

/**
 * Financial accounts, whichever Stripe product Kyle's account actually has.
 *
 * Kyle's Dashboard shows a "Financial account" that payouts transfer into and
 * the Issuing card draws on. That is Stripe's Financial Accounts product for
 * direct businesses, served by the v2 money-management API — NOT the
 * Connect-platform Treasury API, which answers "Unrecognized request URL ...
 * have you onboarded to Treasury?" on this account (checkStripe, 2026-09-09).
 * The installed SDK (22.5) has no typed v2 money-management resource, so the
 * v2 call goes through rawRequest; the v1 Treasury list stays as the fallback
 * for an account that is a platform. Amounts normalise to dollars.
 */
export async function listFinancialAccounts(): Promise<
  { id: string; status: string; cashUsd: number; inboundPending: number; outboundPending: number }[]
> {
  const minor = (v: unknown): number => {
    if (typeof v === "number") return v;
    if (v && typeof v === "object" && typeof (v as { value?: unknown }).value === "number") return (v as { value: number }).value;
    if (v && typeof v === "object" && typeof (v as { usd?: unknown }).usd === "number") return (v as { usd: number }).usd;
    if (v && typeof v === "object" && (v as { usd?: { value?: unknown } }).usd && typeof (v as { usd: { value?: unknown } }).usd.value === "number") {
      return (v as { usd: { value: number } }).usd.value;
    }
    return 0;
  };
  // v2 money management first. It is a preview API: Stripe answers "The API
  // method cannot be found ... specify a .preview Stripe-Version" without the
  // preview version header (production, 2026-09-09).
  try {
    const res = (await stripe().rawRequest("GET", "/v2/money_management/financial_accounts", undefined, { apiVersion: previewApiVersion() })) as {
      data?: Array<{ id: string; status?: string; balance?: { available?: unknown; inbound_pending?: unknown; outbound_pending?: unknown } }>;
    };
    if (Array.isArray(res?.data)) {
      return res.data.map((fa) => ({
        id: fa.id,
        status: fa.status ?? "unknown",
        cashUsd: round2(minor(fa.balance?.available) / 100),
        inboundPending: round2(minor(fa.balance?.inbound_pending) / 100),
        outboundPending: round2(minor(fa.balance?.outbound_pending) / 100),
      }));
    }
  } catch (err) {
    // A permission error here is the real answer; anything else (URL not
    // recognised, product not enabled) falls through to the Treasury list.
    const { reason, permission } = describeStripeError(err);
    if (permission) throw err;
    logSystemEvent("info", "card-spend", `v2 financial accounts not readable, trying Treasury: ${reason}`);
  }
  const list = await stripe().treasury.financialAccounts.list({ limit: 100 });
  return list.data.map((fa) => ({
    id: fa.id,
    status: fa.status,
    cashUsd: round2((fa.balance?.cash?.usd ?? 0) / 100),
    inboundPending: round2((fa.balance?.inbound_pending?.usd ?? 0) / 100),
    outboundPending: round2((fa.balance?.outbound_pending?.usd ?? 0) / 100),
  }));
}

export async function readBalances(): Promise<Balances> {
  if (balanceCache && Date.now() - balanceCache.at < BALANCE_TTL) return balanceCache.value;
  const readAt = new Date();
  if (!stripeConfigured()) {
    const value: Balances = { payments: null, financialAccounts: [], available: false, reason: "STRIPE_SECRET_KEY is not set.", readAt };
    balanceCache = { at: Date.now(), value };
    return value;
  }
  const usd = (rows: { amount: number; currency: string }[]) =>
    round2(rows.filter((r) => r.currency === "usd").reduce((s, r) => s + r.amount, 0) / 100);

  let payments: Balances["payments"] = null;
  try {
    const bal = await stripe().balance.retrieve();
    payments = { available: usd(bal.available), pending: usd(bal.pending) };
  } catch (err) {
    logSystemEvent("warn", "card-spend", `Payments balance not readable: ${describeStripeError(err).reason}`);
  }

  let financialAccounts: FinancialAccountBalance[] = [];
  let available = true;
  let reason: string | undefined;
  try {
    const trucks = await prisma.truck.findMany({ where: { stripeFinancialAccountId: { not: null } }, select: { id: true, name: true, stripeFinancialAccountId: true } });
    const truckByFa = new Map(trucks.map((t) => [t.stripeFinancialAccountId!, t]));
    financialAccounts = (await listFinancialAccounts()).map((fa) => {
      const truck = truckByFa.get(fa.id);
      return { ...fa, truckId: truck?.id ?? null, truckName: truck?.name ?? null };
    });
  } catch (err) {
    available = false;
    reason = describeStripeError(err).reason;
  }
  const value: Balances = { payments, financialAccounts, available, reason, readAt };
  balanceCache = { at: Date.now(), value };
  return value;
}

// ─── Read shapes ─────────────────────────────────────────────────────────────

export const CARD_SPEND_INCLUDE = {
  truck: { select: { id: true, name: true } },
  purchaseOrder: { select: { id: true, number: true, status: true, afterTheFact: true } },
  receipt: { select: { id: true, vendor: true, amount: true, category: true, status: true, receivedAt: true, jobId: true, imageMime: true } },
} satisfies Prisma.CardSpendInclude;
type CardSpendRow = Prisma.CardSpendGetPayload<{ include: typeof CARD_SPEND_INCLUDE }>;

export function serializeCardSpend(row: CardSpendRow) {
  return {
    id: row.id,
    stripeTransactionId: row.stripeTransactionId,
    stripeCardId: row.stripeCardId,
    truckId: row.truckId,
    truckName: row.truck?.name ?? null,
    kind: row.kind,
    amount: row.amount,
    currency: row.currency,
    merchantName: row.merchantName,
    merchantCategory: row.merchantCategory,
    merchantCity: row.merchantCity,
    merchantState: row.merchantState,
    purchaseOrderId: row.purchaseOrderId,
    purchaseOrderNumber: row.purchaseOrder?.number ?? null,
    purchaseOrderStatus: row.purchaseOrder?.status ?? null,
    purchaseOrderAfterTheFact: row.purchaseOrder?.afterTheFact ?? false,
    receiptId: row.receiptId,
    receipt: row.receipt
      ? { id: row.receipt.id, vendor: row.receipt.vendor, amount: row.receipt.amount, category: row.receipt.category, status: row.receipt.status, receivedAt: row.receipt.receivedAt, jobId: row.receipt.jobId, hasImage: Boolean(row.receipt.imageMime) }
      : null,
    status: row.status,
    ignoredReason: row.ignoredReason,
    note: row.note,
    // Kyle, 2026-09-10: Stripe's pending → posted (or void) on the v2 row.
    settlement: row.settlement,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}
export type CardSpendView = ReturnType<typeof serializeCardSpend>;

/** Month-to-date and unmatched rollups per truck, one query each. */
export async function truckSpendRollups(now = new Date()) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [mtd, unmatched] = await Promise.all([
    prisma.cardSpend.groupBy({
      by: ["truckId", "kind"],
      where: { status: { not: "ignored" }, occurredAt: { gte: monthStart } },
      _sum: { amount: true },
    }),
    prisma.cardSpend.groupBy({
      by: ["truckId"],
      where: { status: "unmatched", kind: "materials", receiptId: null, amount: { gt: 0 } },
      _count: { _all: true },
    }),
  ]);
  // Truck overhead only. permit/inspection are JOB fees (Kyle, 2026-09-11) and
  // deliberately have no truck column — they never belong to a vehicle.
  type TruckKind = "fuel" | "maintenance" | "materials" | "tool" | "other";
  const byTruck = new Map<string | null, { fuel: number; maintenance: number; materials: number; tool: number; other: number; unmatched: number }>();
  const row = (id: string | null) => {
    const r = byTruck.get(id) ?? { fuel: 0, maintenance: 0, materials: 0, tool: 0, other: 0, unmatched: 0 };
    byTruck.set(id, r);
    return r;
  };
  for (const m of mtd) {
    const r = row(m.truckId);
    const k = m.kind as TruckKind;
    if (k in r) r[k] = round2(r[k] + (m._sum.amount ?? 0));
  }
  for (const u of unmatched) row(u.truckId).unmatched = u._count._all;
  return byTruck;
}

// ─── Hand edits (reason required) ────────────────────────────────────────────

export interface CardSpendPatch {
  kind?: CardSpendKind;
  truckId?: string | null;
  purchaseOrderId?: string | null;
  receiptId?: string | null;
  status?: "ignored" | "unmatched";
}

/**
 * Kyle's one-line-reason edits. A PO link/unlink writes a PurchaseOrderEvent
 * (card_matched / card_detached); everything else keeps the reason on the row.
 */
export async function updateCardSpend(id: string, patch: CardSpendPatch, meta: { actor: string; reason: string }): Promise<CardSpend> {
  let spend = await prisma.cardSpend.findUnique({ where: { id } });
  if (!spend) throw new CardSpendError("Card transaction not found", 404);

  if (patch.truckId !== undefined && patch.truckId !== spend.truckId) {
    if (patch.truckId) {
      const truck = await prisma.truck.findUnique({ where: { id: patch.truckId }, select: { id: true } });
      if (!truck) throw new CardSpendError("Truck not found", 404);
    }
    spend = await prisma.cardSpend.update({ where: { id }, data: { truckId: patch.truckId, note: meta.reason } });
  }
  if (patch.kind !== undefined && patch.kind !== spend.kind) {
    spend = await prisma.cardSpend.update({ where: { id }, data: { kind: patch.kind, note: meta.reason } });
  }
  if (patch.purchaseOrderId !== undefined && patch.purchaseOrderId !== spend.purchaseOrderId) {
    const previous = spend.purchaseOrderId;
    if (patch.purchaseOrderId) {
      const po = await prisma.purchaseOrder.findUnique({ where: { id: patch.purchaseOrderId }, select: { id: true, status: true, number: true } });
      if (!po) throw new CardSpendError("Purchase order not found", 404);
      if (po.status === "cancelled") throw new CardSpendError(`${po.number} is cancelled; link the card transaction to a live PO.`, 409);
    }
    spend = await prisma.$transaction(async (tx) => {
      const row = await tx.cardSpend.update({ where: { id }, data: { purchaseOrderId: patch.purchaseOrderId, note: meta.reason } });
      if (previous) await poEvent(tx, previous, "card_detached", meta.actor, meta.reason, spendPayload(row));
      if (patch.purchaseOrderId) await poEvent(tx, patch.purchaseOrderId, "card_matched", meta.actor, meta.reason, spendPayload(row));
      return row;
    });
    if (patch.purchaseOrderId) {
      const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: patch.purchaseOrderId }, select: { status: true } });
      if (po.status === "open") await transitionPurchaseOrder(patch.purchaseOrderId, "purchased", { actor: meta.actor, reason: meta.reason });
    }
  }
  if (patch.receiptId !== undefined && patch.receiptId !== spend.receiptId) {
    spend = patch.receiptId
      ? await linkSpendToReceipt(id, patch.receiptId, meta.actor, meta.reason)
      : await unlinkSpendFromReceipt(id, meta.reason);
  }
  if (patch.status !== undefined && patch.status !== spend.status) {
    if (patch.status === "ignored") {
      spend = await prisma.cardSpend.update({ where: { id }, data: { status: "ignored", ignoredReason: meta.reason, note: meta.reason } });
    } else {
      // Back from ignored: matched if a receipt is on it, else unmatched.
      spend = await prisma.cardSpend.update({
        where: { id },
        data: { status: spend.receiptId ? "matched" : "unmatched", ignoredReason: null, note: meta.reason },
      });
    }
  }
  return spend;
}
