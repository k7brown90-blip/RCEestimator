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
 * from the merchant name, settlement pending → posted (or void).
 *
 * ONE CARD CHARGE, ONE EXPENSE (Kyle, 2026-09-21, PUNCHLIST N9): the classic
 * Issuing WEBHOOK still delivers events on this account even though the
 * Issuing LIST call is refused, and every one of those events duplicated a v2
 * row that had already recorded the same swipe — no id is shared between the
 * two feeds, so dedup-by-stripeTransactionId let both live. THE V2 FEED IS
 * THE ONE SOURCE OF CARD SPEND. `ingestIssuingTransaction` and
 * `syncIssuingTransactions` are gone; the webhook (stripePayments.ts) now
 * acknowledges `issuing_transaction.*` events without creating anything.
 *
 * The rulings this file enforces:
 * - Gas and maintenance belong to the truck, never a job (per-truck overhead).
 *   Tools never enter job cost; a tool purchase is simply kind "tool".
 * - "PO first" is enforced by the money trail: a supplier card transaction
 *   with no PO behind it drafts a PO on its own, flagged "PO after the fact"
 *   (purpose truck_stock for that card's truck), which cannot close until a
 *   receipt photo is attached and the purpose confirmed.
 * - THE CHARGE IS THE MONEY, THE RECEIPT IS PROOF (Kyle, 2026-09-19, "the P.O.
 *   is the money"). Every non-ignored row here lands on the P&L once, in the
 *   month it occurred (routes/financials.ts), and a row on a PO tagged to a job
 *   is that job's material cost (services/jobCosting.ts). Many rows may sit on
 *   one PO — a split transaction is two rows on the same PO. A PO is verified
 *   when it has money and a receipt file; nothing compares the two amounts.
 *   The penny-and-three-day receipt matcher that used to live here is gone.
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
import { RECEIPT_HAS_FILE, createPurchaseOrder, transitionPurchaseOrder, verifyPurchaseOrderIfComplete } from "./purchaseOrders";
import { EXCLUDE_TEST_CARD_SPEND } from "./accountSpine";

// permit and inspection joined the list on 2026-09-11: they are JOB FEES, the
// third term in Kyle's commission math (job profit = revenue − material − fees).
// Never auto-assigned from a merchant — Kyle re-kinds the swipe with a reason.
export const CARD_SPEND_KINDS = ["materials", "fuel", "maintenance", "tool", "permit", "inspection", "other"] as const;
export type CardSpendKind = (typeof CARD_SPEND_KINDS)[number];
// "unmatched" is simply LIVE (the name predates 2026-09-19, when "matched" — paired
// with a receipt — was retired). "ignored" takes the row off every money figure.
export const CARD_SPEND_STATUSES = ["unmatched", "ignored"] as const;
export type CardSpendStatus = (typeof CARD_SPEND_STATUSES)[number];

const round2 = (n: number) => Math.round(n * 100) / 100;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ─── Merchant name → kind ─────────────────────────────────────────────────────

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
 * Materials spend goes looking for its PO: a live PO on the same truck at the
 * same supplier, opened within 7 days before the swipe (the feed can lag a day
 * or two) — the most recently opened one wins. MANY CHARGES MAY ATTACH TO ONE
 * PO (Kyle, 2026-09-19): the 9/17 Home Depot buy rang up as $651.73 + $114.01,
 * and both belong on the one PO for that trip. A PO drafted after the fact from
 * an earlier swipe catches the rest of the same trip (same store, within a
 * day) so a split never drafts twice. None found → the PO is drafted after the
 * fact. Refunds never draft a PO; they ride the PO of the prior spend at that
 * store. Fuel, maintenance, tool and other just sit on the truck ledger.
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
  // had been verified or landed and closed — so every live status is searched,
  // 7 days back, because the feed can lag. Kyle, 2026-09-19: no receipt-amount
  // lookup and no "one swipe per PO" — the most recently opened PO at that
  // store on that truck takes the charge, and takes the next one of the same
  // trip too. An after-the-fact PO only catches charges within a day of the
  // swipe that drafted it, so two separate trips do not collapse into one.
  const candidates = await prisma.purchaseOrder.findMany({
    where: {
      status: { in: ["open", "purchased", "verified", "closed"] },
      ...(spend.truckId ? { truckId: spend.truckId } : {}),
      OR: [
        { afterTheFact: false, openedAt: { gte: new Date(spend.occurredAt.getTime() - 7 * DAY), lte: new Date(spend.occurredAt.getTime() + DAY) } },
        { afterTheFact: true, openedAt: { gte: new Date(spend.occurredAt.getTime() - DAY), lte: new Date(spend.occurredAt.getTime() + DAY) } },
      ],
    },
    orderBy: { openedAt: "desc" },
    take: 50,
  });
  // A PO someone OPENED (office or tech) beats one the feed drafted: the
  // office PO is the document for the trip, whatever state it reached before
  // the feed caught up. Among drafted POs the one nearest the swipe wins.
  const distance = (c: { openedAt: Date }) => Math.abs(c.openedAt.getTime() - spend.occurredAt.getTime());
  const po = [...candidates]
    .sort((a, b) => (a.afterTheFact === b.afterTheFact ? (a.afterTheFact ? distance(a) - distance(b) : 0) : a.afterTheFact ? 1 : -1))
    .find((c) => merchantMatches(c.supplier, spend.merchantName));

  if (po) {
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.cardSpend.update({ where: { id: spend.id }, data: { purchaseOrderId: po.id } });
      await poEvent(tx, po.id, "card_matched", "system", "Card transaction matched to this PO", spendPayload(row));
      return row;
    });
    if (po.status === "open") {
      await transitionPurchaseOrder(po.id, "purchased", { actor: "system", reason: "Card transaction landed" });
    }
    await verifyPurchaseOrderIfComplete(po.id, "system");
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

export interface CardSpendSyncSummary extends SyncCounts {
  available: boolean;
  reason?: string;
  dry: boolean;
  transactions: SyncedTransaction[];
  /** What the feed said, for the script and the log. Kept as an object (not
   * flattened) so scripts/syncCardSpend.ts's existing destructuring shape
   * survives — issuing is gone (2026-09-21, "one card charge, one expense"):
   * the classic Issuing webhook is acknowledged and creates nothing, and its
   * LIST call has always been refused on this account. */
  feeds: { financialAccounts: SyncResult };
}

/**
 * The one sync: the v2 money-management feed — the ONE source of card spend
 * (Kyle, 2026-09-21). Classic Issuing is never polled here: this account's
 * Issuing LIST call is refused ("not set up to use Issuing"), and even where
 * Issuing events reach the account they arrive only as webhooks, which
 * stripePayments.ts now acknowledges without creating a row. The route, the
 * script and the cron all call this.
 */
export async function syncCardSpend(sinceDays: number, opts: { dry?: boolean } = {}): Promise<CardSpendSyncSummary> {
  const v2 = await syncFinancialAccountTransactions({ sinceDays, dry: opts.dry });
  return {
    available: v2.available,
    reason: v2.available ? undefined : v2.reason,
    seen: v2.available ? v2.seen : 0,
    created: v2.available ? v2.created : 0,
    updated: v2.available ? v2.updated : 0,
    voided: v2.available ? v2.voided : 0,
    dry: Boolean(opts.dry),
    transactions: v2.available ? v2.transactions : [],
    feeds: { financialAccounts: v2 },
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
  // The proof lives on the PO (Kyle, 2026-09-19): any receipt file on it proves the charge.
  purchaseOrder: { select: { id: true, number: true, status: true, afterTheFact: true, jobId: true, receipts: { where: RECEIPT_HAS_FILE, select: { id: true }, take: 1 } } },
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
    purchaseOrderJobId: row.purchaseOrder?.jobId ?? null,
    /** A receipt photo/PDF sits on this charge's PO — the proof (Kyle, 2026-09-19). */
    proven: (row.purchaseOrder?.receipts.length ?? 0) > 0,
    /** A live materials charge with no proof on its PO (or no PO) — the prompt for the photo. */
    needsProof: needsProof(row),
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

/**
 * "PO-XXXX, $651.73 at Home Depot — attach the receipt" (Kyle, 2026-09-19):
 * a live materials purchase whose PO carries no receipt file yet, or that
 * has no PO at all. Fuel, maintenance and refunds never prompt.
 */
export function needsProof(row: Pick<CardSpendRow, "kind" | "status" | "amount" | "purchaseOrder">): boolean {
  return row.kind === "materials" && row.status !== "ignored" && row.amount > 0 && (row.purchaseOrder?.receipts.length ?? 0) === 0;
}

/** Month-to-date and needs-proof rollups per truck. */
export async function truckSpendRollups(now = new Date()) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [mtd, materials] = await Promise.all([
    prisma.cardSpend.groupBy({
      by: ["truckId", "kind"],
      where: { status: { not: "ignored" }, occurredAt: { gte: monthStart }, ...EXCLUDE_TEST_CARD_SPEND },
      _sum: { amount: true },
    }),
    prisma.cardSpend.findMany({
      where: { status: { not: "ignored" }, kind: "materials", amount: { gt: 0 } },
      select: { truckId: true, kind: true, status: true, amount: true, purchaseOrder: { select: { receipts: { where: RECEIPT_HAS_FILE, select: { id: true }, take: 1 } } } },
    }),
  ]);
  const unmatched = new Map<string | null, number>();
  for (const m of materials) {
    if (needsProof(m as Pick<CardSpendRow, "kind" | "status" | "amount" | "purchaseOrder">)) unmatched.set(m.truckId, (unmatched.get(m.truckId) ?? 0) + 1);
  }
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
  for (const [truckId, count] of unmatched) row(truckId).unmatched = count;
  return byTruck;
}

// ─── Hand edits (reason required) ────────────────────────────────────────────

export interface CardSpendPatch {
  kind?: CardSpendKind;
  truckId?: string | null;
  purchaseOrderId?: string | null;
  status?: "ignored" | "unmatched";
}

/**
 * Kyle's one-line-reason edits. A PO link/unlink writes a PurchaseOrderEvent
 * (card_matched / card_detached) — the standing rule's way OUT for a charge
 * that landed on the wrong PO; everything else keeps the reason on the row.
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
      await verifyPurchaseOrderIfComplete(patch.purchaseOrderId, meta.actor);
    }
  }
  if (patch.status !== undefined && patch.status !== spend.status) {
    if (patch.status === "ignored") {
      spend = await prisma.cardSpend.update({ where: { id }, data: { status: "ignored", ignoredReason: meta.reason, note: meta.reason } });
    } else {
      spend = await prisma.cardSpend.update({ where: { id }, data: { status: "unmatched", ignoredReason: null, note: meta.reason } });
      if (spend.purchaseOrderId) await verifyPurchaseOrderIfComplete(spend.purchaseOrderId, meta.actor);
    }
  }
  return spend;
}
