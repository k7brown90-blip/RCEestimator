/**
 * Opening truck stock from history (Kyle, 2026-09-10).
 *
 * "Can you scan past receipts and purchases and completed jobs to populate the
 * truck stock on there now and I will fill in everything that is not there …
 * fill the truck stock off of what has been spent and recorded in the receipts
 * so I can fill in the gaps on what was purchased before the system was made
 * and what I have on the truck that doesn't match the price book."
 *
 * Bought = confirmed materials receipts' parsed line items, matched to the
 * price book by name. Used = the material lines of signed estimates whose job
 * is completed (the best record of what was installed). Proposed on-hand per
 * item = bought − used, never negative, valued at the weighted purchase cost.
 * The proposal is a starting point Kyle corrects — every guess is flagged.
 *
 * The pure functions here (matching, proposal arithmetic) are what
 * scripts/seedTruckStockFromHistory.ts prints and tests exercise; the loaders
 * and applyProposal talk to the database. Writes go through countStock so
 * StockLevel is only ever written by applyMovement.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { adhocItemId, countStock, truckLocationKey } from "./inventory";

type Db = Prisma.TransactionClient | typeof prisma;

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** One parsed receipt line as the vision parser writes it (itemId/total are tolerated extras). */
export interface ReceiptLineIn {
  name: string;
  qty?: number | null;
  unit?: string | null;
  unitCost?: number | null;
  total?: number | null;
  itemId?: string | null;
}

export interface BookItem {
  itemId: string;
  description: string | null;
  unit: string | null;
  purchaseUnit: string | null;
  purchasePackQty: number | null;
  purchasePrice: number | null;
  costBasisUsed: number | null;
}

/** Where a purchase's unit cost came from (Kyle, 2026-09-10: a book-price fallback must be visible, not silent). */
export type PurchaseCostSource = "receipt" | "book" | "none";

export interface Purchase {
  key: string;
  name: string;
  qty: number;
  unit: string | null;
  unitCost: number | null;
  costSource: PurchaseCostSource;
  receiptId: string;
  /** How the key was chosen. */
  match: { kind: "itemId" | "name" | "adhoc"; score: number };
}

export interface Usage {
  key: string;
  name: string;
  qty: number;
  unit: string | null;
  estimateNumber: string;
}

export interface ProposalRow {
  key: string;
  name: string;
  isBook: boolean;
  boughtQty: number;
  boughtUnit: string | null;
  usedQty: number;
  usedUnit: string | null;
  proposedQty: number;
  unitCost: number;
  /** "receipt" when any purchase carried its own price; "book" when the price book filled in; "none" when nothing did. */
  costSource: PurchaseCostSource;
  value: number;
  flags: string[];
  receiptIds: string[];
}

export const SEED_REASON = "Opening count seeded from receipts and completed jobs (2026-09-10) — Kyle to correct";
/** The count reason carries where the cost came from, so a book-price guess reads as one in the trail. */
export const SEED_COST_SUFFIX: Record<PurchaseCostSource, string> = {
  receipt: "cost from receipt line",
  book: "cost from book price — receipt had no line price",
  none: "no cost — receipt had no line price and the book has none",
};
export const seedReasonFor = (source: PurchaseCostSource) => `${SEED_REASON} — ${SEED_COST_SUFFIX[source]}`;
export const SEED_ACTOR = "system";
export const MATCH_THRESHOLD = 0.5;

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const r2 = (n: number) => Math.round(n * 100) / 100;

// ─── Name matching ───────────────────────────────────────────────────────────

const STOP_WORDS = new Set(["the", "of", "and", "with", "w", "for", "a", "an", "per", "in", "x"]);

/** Receipt spellings the book does not use: Home Depot says "Romex", the book says "NM-B". */
const SYNONYMS: Record<string, string[]> = {
  romex: ["nm", "b"], nmb: ["nm", "b"], gfi: ["gfci"], recept: ["receptacle"], rec: ["receptacle"],
  feet: ["ft"], foot: ["ft"], wht: ["white"], blk: ["black"], cu: ["copper"],
};

/** lowercase, a foot mark after a number → " ft", punctuation → space, collapsed. */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/(\d)\s*['′]/g, "$1 ft").replace(/[^a-z0-9/]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The tokens that decide an electrical match: a wire size ("12/2", "12-2",
 * "14/3"), an amperage ("20a", "20 amp"), a dimension ("4x4") or a fraction
 * trade size ("1/2", "3/4"). a/b with a < b reads as a fraction, otherwise as
 * gauge/conductors — 12/2 is wire, 1/2 is conduit.
 */
export function specTokens(s: string): Set<string> {
  const out = new Set<string>();
  const text = s.toLowerCase();
  for (const m of text.matchAll(/(?<![\d.])(\d{1,2})\s*[/-]\s*(\d)(?![\d/])/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    out.add(a < b ? `frac:${a}/${b}` : `wire:${a}/${b}`);
  }
  for (const m of text.matchAll(/(?<![\d.])(\d{1,4})\s*(?:a|amp|amps)\b/g)) out.add(`amp:${m[1]}`);
  for (const m of text.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)(?![\d.])/g)) out.add(`dim:${m[1]}x${m[2]}`);
  return out;
}

/** Word tokens with the spec tokens' text removed, digit/letter boundaries split ("250ft" → 250, ft). */
export function wordTokens(s: string): Set<string> {
  const stripped = s
    .toLowerCase()
    .replace(/(?<![\d.])\d{1,2}\s*[/-]\s*\d(?![\d/])/g, " ")
    .replace(/(?<![\d.])\d{1,4}\s*(?:a|amp|amps)\b/g, " ")
    .replace(/(?<![\d.])\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?(?![\d.])/g, " ")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2");
  const out = new Set<string>();
  for (const t of normalizeName(stripped).split(" ")) {
    if (!t || STOP_WORDS.has(t)) continue;
    for (const w of SYNONYMS[t] ?? [t]) out.add(w);
  }
  return out;
}

/**
 * Jaccard over word tokens, +0.25 per matching spec token (capped at 1).
 * A spec conflict on the same axis (line says 12/2, item says 14/2) is a hard
 * zero — token overlap on "nm b copper" must never buy the wrong gauge.
 */
export function scoreMatch(lineName: string, description: string): number {
  const ls = specTokens(lineName);
  const ds = specTokens(description);
  let bonus = 0;
  for (const axis of ["wire", "amp", "dim", "frac"]) {
    const a = [...ls].filter((t) => t.startsWith(`${axis}:`));
    const b = [...ds].filter((t) => t.startsWith(`${axis}:`));
    if (a.length === 0 || b.length === 0) continue;
    const hit = a.some((t) => b.includes(t));
    if (!hit) return 0;
    bonus += 0.25;
  }
  const lw = wordTokens(lineName);
  const dw = wordTokens(description);
  const union = new Set([...lw, ...dw]);
  if (union.size === 0) return 0;
  let inter = 0;
  for (const t of lw) if (dw.has(t)) inter += 1;
  return Math.min(1, r4(inter / union.size + bonus));
}

export interface NameMatch { item: BookItem; score: number }

/** The best-scoring book item at or above the threshold, else null. Ties go to the shorter description. */
export function matchBookItem(lineName: string, book: BookItem[]): NameMatch | null {
  let best: NameMatch | null = null;
  for (const item of book) {
    if (!item.description) continue;
    const score = scoreMatch(lineName, item.description);
    if (score < MATCH_THRESHOLD) continue;
    if (!best || score > best.score || (score === best.score && item.description.length < (best.item.description?.length ?? Infinity))) {
      best = { item, score };
    }
  }
  return best;
}

/** itemId on the line wins when the book has it; else the name match; else adhoc. */
export function resolveLineKey(line: ReceiptLineIn, book: BookItem[], byId: Map<string, BookItem>): { key: string; name: string; item: BookItem | null; match: Purchase["match"] } {
  const name = line.name.trim();
  if (line.itemId && byId.has(line.itemId)) {
    const item = byId.get(line.itemId)!;
    return { key: item.itemId, name: item.description ?? name, item, match: { kind: "itemId", score: 1 } };
  }
  const hit = matchBookItem(name, book);
  if (hit) return { key: hit.item.itemId, name: hit.item.description ?? name, item: hit.item, match: { kind: "name", score: hit.score } };
  return { key: adhocItemId(name), name, item: null, match: { kind: "adhoc", score: 0 } };
}

/** line.unitCost → line total ÷ qty (both "receipt") → book purchasePrice ÷ pack qty ("book") → null ("none"). */
export function lineCost(line: ReceiptLineIn, qty: number, item: BookItem | null): { unitCost: number | null; source: PurchaseCostSource } {
  if (typeof line.unitCost === "number" && Number.isFinite(line.unitCost) && line.unitCost > 0) return { unitCost: line.unitCost, source: "receipt" };
  if (typeof line.total === "number" && Number.isFinite(line.total) && line.total > 0 && qty > 0) return { unitCost: r4(line.total / qty), source: "receipt" };
  if (item?.purchasePrice != null) return { unitCost: r4(item.purchasePrice / (item.purchasePackQty ?? 1)), source: "book" };
  return { unitCost: null, source: "none" };
}

export function lineUnitCost(line: ReceiptLineIn, qty: number, item: BookItem | null): number | null {
  return lineCost(line, qty, item).unitCost;
}

// ─── Units ───────────────────────────────────────────────────────────────────

const UNIT_ALIASES: Record<string, string> = {
  ft: "ft", feet: "ft", foot: "ft", "'": "ft",
  ea: "ea", each: "ea", pc: "ea", pcs: "ea", piece: "ea", pieces: "ea", unit: "ea", units: "ea",
  bx: "box", box: "box", boxes: "box",
  rl: "roll", roll: "roll", rolls: "roll",
  bag: "bag", bags: "bag", pk: "pack", pack: "pack", pkg: "pack",
};

export function normalizeUnit(u: string | null | undefined): string | null {
  const t = (u ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!t) return null;
  return UNIT_ALIASES[t] ?? t;
}

/** Same unit, or one side blank (assumed the same) — anything else is a mismatch Kyle reconciles. */
export function unitsAgree(a: string | null, b: string | null): boolean {
  const na = normalizeUnit(a);
  const nb = normalizeUnit(b);
  return na == null || nb == null || na === nb;
}

// ─── The proposal ────────────────────────────────────────────────────────────

/**
 * Per key: Σ bought (receipt unit) − Σ used (estimate unit), floored at 0;
 * cost = weighted average of purchase costs, else the book price, else 0.
 */
export function buildProposal(purchases: Purchase[], usages: Usage[], byId: Map<string, BookItem>): ProposalRow[] {
  type Acc = {
    name: string; boughtQty: number; boughtUnit: string | null; boughtUnits: Set<string>;
    usedQty: number; usedUnit: string | null; usedUnits: Set<string>;
    costQty: number; costSum: number; receiptIds: Set<string>;
  };
  const acc = new Map<string, Acc>();
  const get = (key: string, name: string): Acc => {
    let a = acc.get(key);
    if (!a) {
      a = { name, boughtQty: 0, boughtUnit: null, boughtUnits: new Set(), usedQty: 0, usedUnit: null, usedUnits: new Set(), costQty: 0, costSum: 0, receiptIds: new Set() };
      acc.set(key, a);
    }
    return a;
  };
  for (const p of purchases) {
    const a = get(p.key, p.name);
    a.boughtQty += p.qty;
    const u = normalizeUnit(p.unit);
    if (u) { a.boughtUnits.add(u); a.boughtUnit = a.boughtUnit ?? u; }
    // Only a price the receipt itself carried counts toward the average; a book fallback stays a fallback.
    if (p.unitCost != null && p.qty > 0 && p.costSource === "receipt") { a.costQty += p.qty; a.costSum += p.qty * p.unitCost; }
    a.receiptIds.add(p.receiptId);
  }
  for (const u of usages) {
    const a = get(u.key, u.name);
    a.usedQty += u.qty;
    const unit = normalizeUnit(u.unit);
    if (unit) { a.usedUnits.add(unit); a.usedUnit = a.usedUnit ?? unit; }
  }

  const rows: ProposalRow[] = [];
  for (const [key, a] of acc) {
    const flags: string[] = [];
    const item = byId.get(key) ?? null;
    const boughtQty = r4(a.boughtQty);
    const usedQty = r4(a.usedQty);
    if (a.boughtUnits.size > 1) flags.push(`receipts disagree on unit (${[...a.boughtUnits].join(", ")})`);
    if (a.usedUnits.size > 1) flags.push(`estimates disagree on unit (${[...a.usedUnits].join(", ")})`);

    let proposedQty: number;
    if (usedQty > 0 && boughtQty > 0 && !unitsAgree(a.boughtUnit, a.usedUnit)) {
      proposedQty = boughtQty;
      const pack = item?.purchasePackQty != null && item.purchasePackQty > 1
        ? ` (book: 1 ${item.purchaseUnit ?? "pack"} = ${[item.purchasePackQty, item.unit].filter(Boolean).join(" ")})`
        : "";
      flags.push(`unit mismatch — bought ${a.boughtUnit}, used ${a.usedUnit}${pack} — Kyle to reconcile`);
    } else {
      proposedQty = r4(boughtQty - usedQty);
      if (proposedQty < 0) {
        proposedQty = 0;
        flags.push("used more than bought — earlier purchases not recorded");
      }
    }

    let unitCost: number;
    let costSource: PurchaseCostSource;
    if (a.costQty > 0) { unitCost = r4(a.costSum / a.costQty); costSource = "receipt"; }
    else if (item?.purchasePrice != null) { unitCost = item.purchasePrice; costSource = "book"; }
    else if (item?.costBasisUsed != null) { unitCost = item.costBasisUsed; costSource = "book"; }
    else { unitCost = 0; costSource = "none"; flags.push("no cost"); }
    if (!item) flags.push("not in price book (adhoc)");

    rows.push({
      key, name: a.name, isBook: Boolean(item),
      boughtQty, boughtUnit: a.boughtUnit, usedQty, usedUnit: a.usedUnit,
      proposedQty, unitCost, costSource, value: r2(proposedQty * unitCost), flags, receiptIds: [...a.receiptIds],
    });
  }
  return rows.sort((x, y) => x.key.localeCompare(y.key));
}

// ─── Loaders ─────────────────────────────────────────────────────────────────

export async function loadBook(db: Db = prisma): Promise<{ book: BookItem[]; byId: Map<string, BookItem> }> {
  const rows = await db.priceBookAtomic.findMany({
    select: { itemId: true, description: true, unit: true, purchaseUnit: true, purchasePackQty: true, purchasePrice: true, costBasisUsed: true, retiredAt: true },
  });
  const byId = new Map(rows.map((r) => [r.itemId, r as BookItem]));
  // Name matching considers live items only; an exact itemId on a line may still name a retired one.
  const book = rows.filter((r) => r.retiredAt == null) as BookItem[];
  return { book, byId };
}

export interface PurchaseLoad { purchases: Purchase[]; notes: string[]; receiptCount: number }

/** Every confirmed materials receipt, any job or none; bad JSON is a note, not a crash. */
export async function loadPurchases(book: BookItem[], byId: Map<string, BookItem>, db: Db = prisma): Promise<PurchaseLoad> {
  const receipts = await db.receipt.findMany({
    where: { category: "materials", status: "confirmed" },
    select: { id: true, vendor: true, lineItems: true, receivedAt: true },
    orderBy: { receivedAt: "asc" },
  });
  const purchases: Purchase[] = [];
  const notes: string[] = [];
  for (const r of receipts) {
    if (!r.lineItems) { notes.push(`receipt ${r.id.slice(-6)} (${r.vendor ?? "no vendor"}) has no line items — skipped`); continue; }
    let lines: unknown;
    try { lines = JSON.parse(r.lineItems); } catch { notes.push(`receipt ${r.id.slice(-6)} (${r.vendor ?? "no vendor"}) line items are not valid JSON — skipped`); continue; }
    if (!Array.isArray(lines)) { notes.push(`receipt ${r.id.slice(-6)} line items are not an array — skipped`); continue; }
    for (const raw of lines) {
      if (!raw || typeof raw !== "object" || typeof (raw as { name?: unknown }).name !== "string" || !(raw as { name: string }).name.trim()) continue;
      const line = raw as ReceiptLineIn;
      const qtyRaw = Number(line.qty);
      const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
      const { key, name, item, match } = resolveLineKey(line, book, byId);
      const cost = lineCost(line, qty, item);
      purchases.push({
        key, name, qty, unit: line.unit?.toString().trim() || (item?.purchaseUnit ?? item?.unit ?? null),
        unitCost: cost.unitCost, costSource: cost.source, receiptId: r.id, match,
      });
    }
  }
  return { purchases, notes, receiptCount: receipts.length };
}

/** Taken material lines of signed, non-void estimates whose job is completed. */
export async function loadUsage(byId: Map<string, BookItem>, db: Db = prisma): Promise<{ usages: Usage[]; estimateCount: number }> {
  const estimates = await db.issuedEstimate.findMany({
    where: { status: "signed", voidedAt: null },
    select: {
      id: true, number: true, revision: true, visitId: true, jobVisitId: true, selectedOptions: true,
      lines: { select: { itemId: true, description: true, quantity: true, option: true, materialCost: true } },
    },
  });
  const jobIds = [...new Set(estimates.map((e) => e.jobVisitId ?? e.visitId).filter((x): x is string => Boolean(x)))];
  const completed = new Set(
    jobIds.length
      ? (await db.visit.findMany({ where: { id: { in: jobIds }, status: "completed" }, select: { id: true } })).map((v) => v.id)
      : [],
  );
  const usages: Usage[] = [];
  let estimateCount = 0;
  for (const est of estimates) {
    const jobId = est.jobVisitId ?? est.visitId;
    if (!jobId || !completed.has(jobId)) continue;
    estimateCount += 1;
    // Same selection rule as jobCosting.estimateMaterialCost: the selected options, every line when none.
    const taken = new Set(est.selectedOptions.map(String));
    const lines = taken.size > 0 ? est.lines.filter((l) => taken.has(String(l.option))) : est.lines;
    for (const l of lines) {
      if (l.materialCost == null || l.materialCost <= 0 || !(l.quantity > 0)) continue;
      const item = byId.get(l.itemId);
      usages.push({ key: l.itemId, name: item?.description ?? l.description, qty: l.quantity, unit: item?.unit ?? null, estimateNumber: `${est.number}${est.revision > 1 ? ` r${est.revision}` : ""}` });
    }
  }
  return { usages, estimateCount };
}

/** The truck to seed: --truck by id or name; else the one active truck not named "Truck 1"; else the oldest active. */
export async function chooseTruck(wanted: string | undefined, db: Db = prisma): Promise<{ id: string; name: string; how: string } | null> {
  const trucks = await db.truck.findMany({ where: { isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
  if (wanted) {
    const hit = trucks.find((t) => t.id === wanted) ?? trucks.find((t) => t.name.toLowerCase() === wanted.toLowerCase());
    return hit ? { ...hit, how: "--truck" } : null;
  }
  const named = trucks.filter((t) => t.name !== "Truck 1");
  if (named.length === 1) return { ...named[0], how: 'the one active truck not named "Truck 1"' };
  return trucks[0] ? { ...trucks[0], how: "the oldest active truck" } : null;
}

// ─── Apply ───────────────────────────────────────────────────────────────────

export interface ApplyResult {
  written: Array<{ key: string; name: string; qty: number; unitCost: number; movementId: string }>;
  skipped: Array<{ key: string; name: string; qtyOnHand: number }>;
}

/**
 * One "count" per row with a proposed on-hand > 0, on the truck, through the
 * inventory service's count path. A level that already holds stock there is
 * skipped so a second run cannot double up.
 */
export async function applyProposal(truckId: string, rows: ProposalRow[]): Promise<ApplyResult> {
  const locationKey = truckLocationKey(truckId);
  const candidates = rows.filter((r) => r.proposedQty > 0);
  const existing = await prisma.stockLevel.findMany({
    where: { locationKey, itemId: { in: candidates.map((r) => r.key) } },
    select: { itemId: true, qtyOnHand: true },
  });
  const onHand = new Map(existing.map((l) => [l.itemId, l.qtyOnHand]));
  const skipped: ApplyResult["skipped"] = [];
  const toWrite: ProposalRow[] = [];
  for (const r of candidates) {
    const have = onHand.get(r.key) ?? 0;
    if (have > 0) skipped.push({ key: r.key, name: r.name, qtyOnHand: have });
    else toWrite.push(r);
  }
  const written: ApplyResult["written"] = [];
  // One count per cost source so each movement's reason says where its cost came from.
  for (const source of ["receipt", "book", "none"] as PurchaseCostSource[]) {
    const group = toWrite.filter((r) => r.costSource === source);
    if (group.length === 0) continue;
    const movements = await countStock({
      locationKey,
      lines: group.map((r) => ({ itemId: r.key, name: r.name, unit: r.boughtUnit ?? r.usedUnit ?? null, qty: r.proposedQty, unitCost: r.unitCost })),
      reason: seedReasonFor(source),
      actor: SEED_ACTOR,
    });
    movements.forEach((m, i) => written.push({ key: group[i].key, name: group[i].name, qty: group[i].proposedQty, unitCost: group[i].unitCost, movementId: m.id }));
  }
  written.sort((x, y) => x.key.localeCompare(y.key));
  return { written, skipped };
}
