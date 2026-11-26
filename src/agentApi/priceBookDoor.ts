/**
 * The agents' door onto the PRICE BOOK (Kyle, 2026-11-24 "Add price book access for agent keys in the RCE CRM", amended 2026-11-25). Scopes
 * pricebook:read and pricebook:write (shared/agentScopes.ts); the Inventory key holds both by default, every other key but Other reads.
 *
 * Five operations, each ONE core that takes a DoorCall (the same shape the hub door uses), so the REST routes (src/routes/agentPriceBook.ts,
 * AGENT_KEY_ROUTES in middleware/publicRoutes.ts) and the /mcp tools (src/agentApi/tools.ts) run the SAME code - the same validation, the same
 * idempotency table, the same scrub, the same audit rows, the same events:
 *
 *   GET  /api/agent/price-book/categories         pricebook:read   listCategories
 *   GET  /api/agent/price-book/items              pricebook:read   browseAtomics (the ONE search path) + the item rows behind it
 *   GET  /api/agent/price-book/items/:id          pricebook:read   one item, with an assembly's parts
 *   POST /api/agent/price-book/items              pricebook:write  a NEW item (labor, material or assembly). Never an edit.
 *   POST /api/agent/price-book/items/:id/proposals pricebook:write  a proposed price, hours or name change to an EXISTING item: a card in
 *                                                                   Messages -> "Waiting for approval", applied only when Kyle (or Michael,
 *                                                                   once Kyle grants him price_book_edit) approves it.
 *
 * THERE IS NO DELETE, RETIRE, ARCHIVE OR EDIT ROUTE OR TOOL, and none may be added here (Kyle: "No delete, retire, or archive for agents").
 *
 * WHAT AN AGENT TYPES, AND WHAT THE SERVER DOES WITH IT
 *   - material_cost is the PRE-TAX shelf price. The book records pre-tax cost; sell prices are computed by the book's ONE computation
 *     (priceBookCatalog computePricing, called inside createAtomic / createAssembly / updateAtomic) - nothing here prices anything.
 *   - hours come from the agent's own NECA library (Kyle 2026-11-25: "they can type the hours in themselves"): PER UNIT, for the three
 *     difficulties. The agent converts per-100 / per-1000 itself. A tier it leaves out stays BLANK (the estimate engine then blocks that
 *     difficulty). neca_reference (edition, page, table, row) is stored as the item's labour source and shown on the CRM item drawer.
 *     Hours are refused when they are not above 0 or are above MAX_HOURS_PER_UNIT.
 *   - type: labor -> LABOR ONLY (hours, no material); material with hours -> MATERIAL + LABOR; material without -> MATERIAL ONLY;
 *     assembly -> an assembly of existing items (cost and hours roll up from the parts; none may be retired or unpriced).
 *   - unit (REQUIRED on create, Kyle 2026-11-25 "yes they should add the specific unit"): what ONE unit is ("each", "ft", "box of 25"). Stored as
 *     the item's unitLabel; material_cost and hours are per that unit. A unit of ft / lf / foot / feet / per foot / per ft / linear feet groups the
 *     item with the continuous-length material the estimate's job-level material cap works on (the loader passes unitLabel to the engine). A proposal cannot change it (Kyle asked for create only).
 *   - every write goes through createAtomic / createAssembly / planAtomicUpdate. Never a raw insert: a raw row has no unit basis, and an item
 *     with hours but no unit basis prices its labour as $0.
 *
 * DUPLICATES. A new item whose name is a near-duplicate of a live item in the same category is refused 409 duplicate_item with the existing item
 * in the body. A twin is the SAME name said differently: the same words and the same sizes/amps (stockSeed wordTokens / specTokens, so case,
 * spacing, punctuation, word order and "Romex" for "NM-B" do not make a new item), and the same subcategory/brand when both carry one. A name that
 * only contains another ("20A Breaker GFCI" beside "20A Breaker") is a different product and is accepted; there is no second matcher. The idempotency_key (required, 8 to 128 characters) is a separate thing: it makes a RETRY of
 * the same request return the first answer and make nothing twice.
 *
 * AUDIT. PriceBookEdit records every create and every proposal and decision with editedBy `agent:<key name>`; AgentAuditLog records the call
 * (inside the same transaction as the write); the Messages audit log records a created item and a proposal (hubAudit). The events
 * pricebook.item_created / pricebook.change_proposed go out AFTER the transaction commits, never on a replay, to every other live key that can
 * read the price book (services/hubEvents.ts).
 */
import { Prisma, type PriceBookAtomic, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AgentApiError, OWN_REASON_PREFIX, ownReasonsOf } from "./errors";
import { agentRespond, type AgentToolOutput } from "./respond";
import {
  priceBookCategoriesSchema, priceBookItemListSchema, priceBookItemSchema, priceBookProposalSchema, type PriceBookItemRead,
} from "./profiles";
import { idempotencyKeySchema, requestHashOf, withIdempotency } from "./idempotency";
import { recordAgentCall } from "./audit";
import type { DoorCall, DoorResult } from "./hubDoor";
import { browseAtomics } from "../services/atomicEstimateService";
import { createAtomic, listCategories, planAtomicUpdate, type AtomicPatch } from "../services/priceBookCatalog";
import { computeComponentRollup, createAssembly, isAssemblyRowType, type ComponentAtomicFacts } from "../services/priceBookAssembly";
import { normalizeName, specTokens, wordTokens } from "../services/stockSeed";
import {
  PROPOSABLE_FIELDS, agentEditorName, ensurePriceBookThread, insertPriceChangeCard, type PriceChangePayload,
} from "../services/priceBookProposals";
import { fanOutMessage, hubAudit } from "../services/hub";
import { emitHubEventSafe } from "../services/hubEvents";
import { laborSourceText } from "../../shared/priceBookLaborSource";
import type { AgentScope } from "../../shared/agentScopes";

// ── the scopes, the operations and the limits ─────────────────────────────────────────────────────

export const PRICEBOOK_READ_SCOPES: readonly AgentScope[] = ["pricebook:read"];
export const PRICEBOOK_WRITE_SCOPES: readonly AgentScope[] = ["pricebook:write"];

export const CREATE_OPERATION = "pricebook.item.create";
export const PROPOSE_OPERATION = "pricebook.item.propose";

/** The most hours ONE unit of an item may take, at any difficulty. A bigger number is a per-100 or per-1000 value that was not converted. */
export const MAX_HOURS_PER_UNIT = 100;
export const SEARCH_LIMIT_DEFAULT = 50;
export const SEARCH_LIMIT_MAX = 200;

const readOut = (name: string, schema: z.ZodType): AgentToolOutput => ({
  name, profiles: PRICEBOOK_READ_SCOPES.concat(PRICEBOOK_WRITE_SCOPES).map((scope) => ({ scope, schema, withholdContact: false })),
});
// A price book holds no customer data, so these answers withhold no contact details (an item name like "100 Amp Main Lug" must not be mangled
// by the street-address pass). Secrets, tokens and card numbers are still removed by agentRespond's scrub.
const CATEGORIES_OUT = readOut("pricebook.categories", priceBookCategoriesSchema);
const ITEMS_OUT = readOut("pricebook.items.search", priceBookItemListSchema);
const ITEM_OUT = readOut("pricebook.items.get", priceBookItemSchema);
const PROPOSAL_OUT = readOut("pricebook.items.propose", priceBookProposalSchema);

// ── the inputs ────────────────────────────────────────────────────────────────────────────────────

const hoursSchema = z.object({
  normal: z.number().optional(),
  difficult: z.number().optional(),
  very_difficult: z.number().optional(),
});
const hoursInput = z.union([z.number(), hoursSchema]);

const componentSchema = z.object({ item_id: z.string().trim().min(1).max(64), quantity: z.number() });

/**
 * The unit the item is sold and priced PER (Kyle 2026-11-25, asked whether agents send a unit when they add an item: "yes they should add the
 * specific unit"). REQUIRED on every create. Stored as the item's unitLabel, which the estimate engine reads: a unit of ft, lf, foot, feet, per foot,
 * per ft or linear feet groups the item with continuous-length material (isContinuousLengthMaterial in services/atomicEstimateEngine.ts; loadCatalogAtSupplier passes unitLabel to it). The matcher also recognises wire, cable and conduit by name.
 */
export const UNIT_MAX_LENGTH = 24;
export const UNIT_REFUSAL = `unit is required: the unit this item is priced per, 1 to ${UNIT_MAX_LENGTH} characters, no control characters, e.g. "each", "ft", "box of 25". material_cost and hours are PER THAT UNIT. Use "ft" (or lf, foot, feet, per foot, per ft, linear feet) for wire, cable and conduit sold by the foot.`;
const unitMessage = { error: `${OWN_REASON_PREFIX}${UNIT_REFUSAL}` };
export const unitSchema = z.string(unitMessage).trim().min(1, unitMessage).max(UNIT_MAX_LENGTH, unitMessage)
  // eslint-disable-next-line no-control-regex
  .refine((u) => !/[\u0000-\u001f\u007f-\u009f]/.test(u), unitMessage);

export const createItemInputSchema = z.object({
  idempotency_key: idempotencyKeySchema,
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(120),
  unit: unitSchema,
  subcategory_or_brand: z.string().trim().max(120).nullish(),
  type: z.enum(["labor", "material", "assembly"]),
  hours: hoursInput.optional(),
  neca_reference: z.string().trim().max(300).optional(),
  material_cost: z.number().optional(),
  notes: z.string().trim().max(2000).nullish(),
  components: z.array(componentSchema).max(100).optional(),
});
export type CreateItemInput = z.infer<typeof createItemInputSchema>;

export const proposeChangeInputSchema = z.object({
  item_id: z.string().trim().min(1).max(64),
  idempotency_key: idempotencyKeySchema,
  name: z.string().trim().min(1).max(200).optional(),
  material_cost: z.number().optional(),
  hours: hoursInput.optional(),
});
export type ProposeChangeInput = z.infer<typeof proposeChangeInputSchema>;

export const searchInputSchema = z.object({
  search: z.string().trim().max(120).optional(),
  category: z.string().trim().max(120).optional(),
  limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
});

const badRequest = (reason: string): AgentApiError => new AgentApiError("bad_request", { reason });
const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;
const money = (n: number): string => `$${n.toFixed(2)}`;

/** Refuse a body that names a field this door does not take, saying which (a typo like `cost` must not be silently dropped). */
function refuseUnknownFields(raw: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw badRequest(`Unknown field${extra.length > 1 ? "s" : ""}: ${extra.slice(0, 5).join(", ")}. This request takes: ${allowed.join(", ")}.`);
}

function parseOrRefuse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Fields only, never the values sent (the one rule for every agent refusal).
  const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))].slice(0, 10);
  // A schema's own sentences (a constant written here, e.g. the unit's) are added; no value the caller sent ever is.
  const own = ownReasonsOf(parsed.error);
  throw badRequest(`${"The request was not valid."} Check: ${fields.join(", ")}.${own.length > 0 ? ` ${own.join(" ")}` : ""}`);
}

// ── hours and money ───────────────────────────────────────────────────────────────────────────────

export interface HourTiers { laborNormal?: number; laborDifficult?: number; laborVeryDifficult?: number }
const TIER_LABELS = { laborNormal: "normal", laborDifficult: "difficult", laborVeryDifficult: "very_difficult" } as const;

/** A single number is the Normal tier; an object names the tiers. Each given tier must be above 0 and at most MAX_HOURS_PER_UNIT, with the reason. */
export function readHours(hours: number | { normal?: number; difficult?: number; very_difficult?: number } | undefined): HourTiers {
  if (hours === undefined) return {};
  const given: Array<["laborNormal" | "laborDifficult" | "laborVeryDifficult", number | undefined]> = typeof hours === "number"
    ? [["laborNormal", hours]]
    : [["laborNormal", hours.normal], ["laborDifficult", hours.difficult], ["laborVeryDifficult", hours.very_difficult]];
  const out: HourTiers = {};
  for (const [tier, value] of given) {
    if (value === undefined) continue;
    const label = `hours.${TIER_LABELS[tier]}`;
    if (!Number.isFinite(value)) throw badRequest(`${label} must be a number.`);
    if (value < 0) throw badRequest(`${label} cannot be negative (got ${value}).`);
    if (value === 0) throw badRequest(`${label} must be more than 0. Leave a tier out when NECA publishes no time for it: it then stays blank.`);
    if (value > MAX_HOURS_PER_UNIT) {
      throw badRequest(`${label} is ${value} hours for ONE unit, which is more than the ${MAX_HOURS_PER_UNIT} a unit may take. Hours are per unit: divide a per-100 or per-1000 NECA value down to one.`);
    }
    out[tier] = round6(value);
  }
  return out;
}

function checkCost(value: number | undefined, label = "material_cost"): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) throw badRequest(`${label} must be a number.`);
  if (value < 0) throw badRequest(`${label} cannot be negative (got ${value}). It is the PRE-TAX shelf price per unit.`);
  return Math.round(value * 100) / 100;
}

const hasTiers = (t: HourTiers): boolean => t.laborNormal !== undefined || t.laborDifficult !== undefined || t.laborVeryDifficult !== undefined;

// ── projecting an item for an agent ───────────────────────────────────────────────────────────────

type ItemRow = PriceBookAtomic;

/** Hours as the agent reads them: per unit (a stored value is per `laborUnitDivisor` units), a tier with no value or no verified basis is null. */
function perUnit(row: ItemRow, value: number | null): number | null {
  if (value === null) return null;
  const divisor = row.laborUnitDivisor;
  if (divisor === null || divisor === undefined || divisor <= 0) return null;
  return round6(value / divisor);
}

export function typeOf(rowType: string | null): "labor" | "material" | "assembly" {
  if (isAssemblyRowType(rowType)) return "assembly";
  return (rowType ?? "").toUpperCase().includes("LABOR ONLY") ? "labor" : "material";
}

export function projectItem(row: ItemRow, components?: Array<{ item_id: string; name: string | null; quantity: number }>): PriceBookItemRead {
  return {
    item_id: row.itemId,
    name: row.description,
    category: row.category,
    sub_category: row.subCategory,
    type: typeOf(row.rowType),
    row_type: row.rowType,
    unit: row.unitLabel ?? row.unit,
    hours: { normal: perUnit(row, row.laborNormal), difficult: perUnit(row, row.laborDifficult), very_difficult: perUnit(row, row.laborVeryDifficult) },
    cost: row.companyCost,
    // cost is PRE-TAX; cost_with_tax is cost x (1 + the book's sales tax rate), null for an item with no cost, an item the book has not been repriced for sales tax yet (the rate is saved once in Settings -> Purchasing), or a hand-set price the tax reprice left alone.
    cost_with_tax: row.companyCostWithTax,
    sell: { normal: row.sellNormal, difficult: row.sellDifficult, very_difficult: row.sellVeryDifficult },
    labour_source: laborSourceText(row.laborUnitBasisRaw),
    notes: row.notes,
    retired: row.retiredAt !== null,
    ...(components ? { components } : {}),
  };
}

async function componentsOf(db: PrismaClient | Prisma.TransactionClient, row: ItemRow): Promise<Array<{ item_id: string; name: string | null; quantity: number }> | undefined> {
  if (!isAssemblyRowType(row.rowType)) return undefined;
  const parts = await db.priceBookItemComponent.findMany({
    where: { parentItemId: row.itemId }, include: { child: { select: { description: true } } }, orderBy: { id: "asc" },
  });
  return parts.map((p) => ({ item_id: p.childItemId, name: p.child.description, quantity: p.quantity }));
}

const answerWith = async (call: DoorCall, out: AgentToolOutput, raw: unknown): Promise<unknown> =>
  (await agentRespond(call.principal, out, raw)).data;

// ── the three reads ───────────────────────────────────────────────────────────────────────────────

export async function listCategoriesCore(call: DoorCall): Promise<DoorResult> {
  const rows = await listCategories(prisma);
  const body = await answerWith(call, CATEGORIES_OUT, {
    categories: rows.map((c) => ({ name: c.name, count: c.count, sub_categories: c.subCategories.map((s) => ({ name: s.name, count: s.count })) })),
  });
  return { status: 200, body, recordIds: [] };
}

export async function searchItemsCore(call: DoorCall, rawQuery: { search?: string; category?: string; limit?: string | number }): Promise<DoorResult> {
  const limitNumber = rawQuery.limit === undefined || rawQuery.limit === "" ? undefined : Number(rawQuery.limit);
  const input = parseOrRefuse(searchInputSchema, {
    search: rawQuery.search || undefined, category: rawQuery.category || undefined,
    ...(limitNumber !== undefined ? { limit: limitNumber } : {}),
  });
  // browseAtomics is THE search (code or description match, live items only, the same cap and total as every other surface); its rows are the
  // ids and the order, and the full item rows are read behind them so an agent sees cost, hours and sell without a second call per item.
  const found = await browseAtomics(prisma, { search: input.search ?? null, category: input.category ?? null, limit: input.limit ?? SEARCH_LIMIT_DEFAULT });
  const rows = await prisma.priceBookAtomic.findMany({ where: { itemId: { in: found.atomics.map((a) => a.itemId) } } });
  const byId = new Map(rows.map((r) => [r.itemId, r]));
  const items = found.atomics.flatMap((a) => (byId.has(a.itemId) ? [projectItem(byId.get(a.itemId)!)] : []));
  const body = await answerWith(call, ITEMS_OUT, { items, count: found.count, total: found.total, truncated: found.truncated });
  return { status: 200, body, recordIds: items.map((i) => i.item_id).slice(0, 50) };
}

export async function getItemCore(call: DoorCall, itemId: string): Promise<DoorResult> {
  const id = itemId.trim();
  const row = id ? await prisma.priceBookAtomic.findUnique({ where: { itemId: id.toUpperCase() } }) : null;
  if (!row) throw new AgentApiError("not_found", { reason: "No price book item with that id." });
  const body = await answerWith(call, ITEM_OUT, projectItem(row, await componentsOf(prisma, row)));
  return { status: 200, body, recordIds: [row.itemId] };
}

// ── create ────────────────────────────────────────────────────────────────────────────────────────

const CREATE_FIELDS = ["idempotency_key", "name", "category", "unit", "subcategory_or_brand", "type", "hours", "neca_reference", "material_cost", "notes", "components"] as const;

interface CreatePlan {
  kind: "atomic" | "assembly";
  rowType: string;
  cost: number | undefined;
  tiers: HourTiers;
  components: Array<{ childItemId: string; quantity: number }>;
}

/** Everything that can be refused without reading the book: the shape of each type. */
function planCreate(body: CreateItemInput): CreatePlan {
  const tiers = readHours(body.hours);
  const cost = checkCost(body.material_cost);
  if (body.neca_reference !== undefined && !hasTiers(tiers)) {
    throw badRequest("neca_reference says where the hours came from, so send the hours too, or leave it out.");
  }
  if (body.type === "labor") {
    if (!hasTiers(tiers)) throw badRequest("A labor item needs hours: send hours (a number for Normal, or {normal, difficult, very_difficult}).");
    if (cost !== undefined) throw badRequest("A labor item is hours only, with no material cost. To sell material with it, use type material and send both.");
    if (body.components !== undefined) throw badRequest("components belong to an assembly only.");
    return { kind: "atomic", rowType: "LABOR ONLY", cost: undefined, tiers, components: [] };
  }
  if (body.type === "material") {
    if (cost === undefined) throw badRequest("A material item needs material_cost, the PRE-TAX cost per unit.");
    if (body.components !== undefined) throw badRequest("components belong to an assembly only.");
    return { kind: "atomic", rowType: hasTiers(tiers) ? "MATERIAL + LABOR" : "MATERIAL ONLY", cost, tiers, components: [] };
  }
  // assembly
  if (!body.components || body.components.length === 0) throw badRequest("An assembly needs components: [{item_id, quantity}], at least one.");
  if (cost !== undefined || hasTiers(tiers) || body.neca_reference !== undefined) {
    throw badRequest("An assembly's cost and hours come from its components: send components only, not material_cost, hours or neca_reference.");
  }
  return {
    kind: "assembly", rowType: "ASSEMBLY", cost: undefined, tiers: {},
    components: body.components.map((c) => ({ childItemId: c.item_id.trim().toUpperCase(), quantity: c.quantity })),
  };
}

/** The assembly's parts must be live and the cost rollup complete: an unpriced or retired part would sell the assembly for labour alone. */
async function checkAssemblyParts(tx: Prisma.TransactionClient, components: CreatePlan["components"]): Promise<void> {
  for (const c of components) {
    if (!Number.isFinite(c.quantity) || c.quantity <= 0) throw badRequest(`Component ${c.childItemId}: quantity must be a positive number.`);
  }
  const ids = components.map((c) => c.childItemId);
  if (new Set(ids).size !== ids.length) throw badRequest("A component is listed twice. Combine it into one line.");
  const rows = await tx.priceBookAtomic.findMany({
    where: { itemId: { in: ids } },
    select: { itemId: true, description: true, rowType: true, companyCost: true, laborNormal: true, laborDifficult: true, laborVeryDifficult: true, laborUnitDivisor: true, retiredAt: true },
  });
  const byId = new Map(rows.map((r) => [r.itemId, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw badRequest(`No price book item: ${missing.join(", ")}.`);
  const retired = ids.filter((id) => byId.get(id)!.retiredAt !== null);
  if (retired.length > 0) throw badRequest(`${retired.join(", ")} ${retired.length > 1 ? "have" : "has"} been retired and cannot be part of a new assembly.`);
  const nested = ids.filter((id) => isAssemblyRowType(byId.get(id)!.rowType));
  if (nested.length > 0) throw badRequest(`${nested.join(", ")} ${nested.length > 1 ? "are" : "is"} itself an assembly. An assembly cannot contain another assembly.`);
  const facts = new Map<string, ComponentAtomicFacts>(rows.map((r) => [r.itemId, r]));
  const rollup = computeComponentRollup(components, facts);
  if (!rollup.costComplete) {
    // A labor-only part has no material cost BY DESIGN, so "price it first" cannot be done (a labor item takes no cost). Say what the agent CAN do.
    const laborOnly = rollup.unpricedComponentItemIds.filter((id) => (byId.get(id)?.rowType ?? "").toUpperCase().includes("LABOR ONLY"));
    if (laborOnly.length > 0) {
      const many = laborOnly.length > 1;
      throw badRequest(`${laborOnly.join(", ")} ${many ? "are" : "is"} labor only and ${many ? "carry" : "carries"} no material cost, so ${many ? "they cannot" : "it cannot"} be part of an assembly. Use a material item with hours (type material and send hours), or leave the labor out.`);
    }
    throw badRequest(`${rollup.unpricedComponentItemIds.join(", ")} ${rollup.unpricedComponentItemIds.length > 1 ? "have" : "has"} no cost, so the assembly could not be priced. Price those items first.`);
  }
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The category the way the book already spells it (the match ignores case), or the agent's own for a new one. */
async function categoryAs(tx: Prisma.TransactionClient, category: string): Promise<string> {
  const same = await tx.priceBookAtomic.findFirst({ where: { category: { equals: norm(category), mode: "insensitive" } }, select: { category: true } });
  return same?.category ?? norm(category);
}

const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((t) => b.has(t));

/** True when `a` and `b` are the same name said differently: the same words and the same spec tokens (sizes, amps, wire gauges), nothing more or less. */
function sameName(a: string, b: string): boolean {
  const wa = wordTokens(a);
  const sa = specTokens(a);
  if (wa.size === 0 && sa.size === 0) return normalizeName(a) === normalizeName(b);
  return sameSet(wa, wordTokens(b)) && sameSet(sa, specTokens(b));
}

/**
 * The first live item in this category that is a twin of `name`, or null. A name that merely contains another is NOT a twin, and two items that
 * both name a different subcategory/brand are not twins either.
 */
async function nearDuplicate(tx: Prisma.TransactionClient, name: string, category: string, brand: string | null): Promise<ItemRow | null> {
  const siblings = await tx.priceBookAtomic.findMany({
    where: { retiredAt: null, category: { equals: category, mode: "insensitive" } }, orderBy: { itemId: "asc" },
  });
  const wanted = norm(name);
  const wantedBrand = brand ? norm(brand).toLowerCase() : null;
  return siblings.find((s) => {
    if (!s.description || !sameName(wanted, norm(s.description))) return false;
    const theirs = s.subCategory ? norm(s.subCategory).toLowerCase() : null;
    return !(wantedBrand && theirs && wantedBrand !== theirs);
  }) ?? null;
}

const isUniqueViolation = (err: unknown): boolean => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * The id numbers are "the next free one", read then written: two creates at once can both pick the same, and the second insert fails (P2002). The creates
 * of this door queue on one advisory lock (below), so they cannot collide with each other; the CRM's own "+ New item" takes no such lock, so a create that
 * still loses the race is run again (the transaction rolled back whole, its idempotency record with it) and reads the winner's number.
 */
const ID_RACE_ATTEMPTS = 3;
async function retryOnIdRace<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= ID_RACE_ATTEMPTS) throw err;
    }
  }
}

const hoursNote = (t: HourTiers): string =>
  `hours ${[t.laborNormal, t.laborDifficult, t.laborVeryDifficult].map((h) => (h === undefined ? "blank" : String(h))).join(" / ")} per unit`;

export async function createItemCore(call: DoorCall, raw: Record<string, unknown>): Promise<DoorResult> {
  const principal = call.principal;
  refuseUnknownFields(raw, CREATE_FIELDS);
  const body = parseOrRefuse(createItemInputSchema, raw);
  const plan = planCreate(body);
  const { idempotency_key: idempotencyKey, ...hashed } = body;
  const editedBy = agentEditorName(principal.name);

  const run = () => withIdempotency({ keyId: principal.keyId, role: principal.role }, CREATE_OPERATION, idempotencyKey, hashed, async (tx) => {
    const client = tx as unknown as PrismaClient;
    // One new item at a time across the agent door (released when this transaction ends): the next id is read after the previous create committed.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pricebook:new-item-id'))`;
    const category = await categoryAs(tx, body.category);
    const twin = await nearDuplicate(tx, body.name, category, body.subcategory_or_brand ?? null);
    if (twin) {
      throw new AgentApiError("duplicate_item", {
        reason: `${twin.itemId} (${twin.description ?? ""}) is already in ${twin.category ?? category} with a very similar name. Use it, or give this item a name that tells them apart.`,
        existingItem: await answerWith(call, ITEM_OUT, projectItem(twin, await componentsOf(tx, twin))),
      });
    }
    if (plan.kind === "assembly") await checkAssemblyParts(tx, plan.components);

    const note = plan.kind === "assembly"
      ? `Created by agent key "${principal.name}": assembly of ${plan.components.length} part(s).`
      : `Created by agent key "${principal.name}": ${plan.cost !== undefined ? `cost ${money(plan.cost)} before tax` : "no material"}${hasTiers(plan.tiers) ? `, ${hoursNote(plan.tiers)}` : ""}${body.neca_reference ? `, source ${body.neca_reference}` : ""}.`;
    const made = plan.kind === "assembly"
      ? await createAssembly(client, {
        description: body.name, category, subCategory: body.subcategory_or_brand ?? null, unitLabel: body.unit, notes: body.notes ?? null,
        components: plan.components, editNote: note,
      }, editedBy)
      : await createAtomic(client, {
        description: body.name, category, subCategory: body.subcategory_or_brand ?? null, unitLabel: body.unit, notes: body.notes ?? null, rowType: plan.rowType,
        companyCost: plan.cost ?? null, laborNormal: plan.tiers.laborNormal ?? null, laborDifficult: plan.tiers.laborDifficult ?? null,
        laborVeryDifficult: plan.tiers.laborVeryDifficult ?? null, laborSource: body.neca_reference ?? null, editNote: note,
      }, editedBy);
    if (!made.ok) throw badRequest(made.reason);
    const row = made.atomic as ItemRow;

    await hubAudit(tx, {
      actorKey: `agent:${principal.keyId}`, actorDisplay: principal.name, action: "price_item_created", entityType: "price_book_item", entityId: row.itemId,
      afterText: `${row.itemId} ${row.description ?? ""}`, details: { itemId: row.itemId, type: body.type, category, unit: body.unit },
    });
    const answer = await answerWith(call, ITEM_OUT, projectItem(row, await componentsOf(tx, row)));
    // The audit row commits WITH the item and its idempotency record.
    await recordAgentCall(call.auditRecord({ status: 201, body: answer, recordIds: [row.itemId], resultCode: "ok", idempotencyKey }), tx);
    return answer;
  });

  const out = await retryOnIdRace(run);
  if (out.replayed) return { status: 200, body: out.result, recordIds: [], replayed: true, idempotencyKey };
  const itemId = (out.result as { item_id: string }).item_id;
  // After the commit, and never for a replay: tell the other agents that can read the price book.
  void emitHubEventSafe({ type: "pricebook.item_created", itemId, authorKeyId: principal.keyId });
  return { status: 201, body: out.result, recordIds: [itemId], auditWritten: true, idempotencyKey };
}

// ── propose a change to an existing item ──────────────────────────────────────────────────────────

const PROPOSE_FIELDS = ["item_id", "idempotency_key", "name", "material_cost", "hours"] as const;
const FIELD_WORD: Record<(typeof PROPOSABLE_FIELDS)[number], string> = {
  description: "name", companyCost: "cost", laborNormal: "hours_normal", laborDifficult: "hours_difficult", laborVeryDifficult: "hours_very_difficult",
};

/** The proposal as the book's patch: stored hours are per `divisor` units, so a per-unit hour typed by the agent is multiplied up for an item stored per 100 or 1000. */
function patchFor(item: ItemRow, body: ProposeChangeInput): PriceChangePayload["proposed"] {
  const assembly = isAssemblyRowType(item.rowType);
  const laborOnly = (item.rowType ?? "").toUpperCase().includes("LABOR ONLY");
  const materialOnly = (item.rowType ?? "").toUpperCase().includes("MATERIAL ONLY");
  const tiers = readHours(body.hours);
  const cost = checkCost(body.material_cost);
  if (assembly && (cost !== undefined || hasTiers(tiers))) {
    throw badRequest(`${item.itemId} is an assembly: its cost and hours come from its components. Propose a change to a component, or to the assembly's name.`);
  }
  if (laborOnly && cost !== undefined) throw badRequest(`${item.itemId} is a labor item with no material, so it has no cost to change.`);
  if (materialOnly && hasTiers(tiers)) throw badRequest(`${item.itemId} is material only, with no hours. A change to its hours is not possible.`);
  const divisor = item.laborUnitDivisor !== null && item.laborUnitDivisor > 0 ? item.laborUnitDivisor : 1;

  const proposed: PriceChangePayload["proposed"] = {};
  if (body.name !== undefined && norm(body.name) !== (item.description ?? "")) proposed.description = norm(body.name);
  if (cost !== undefined && cost !== item.companyCost) proposed.companyCost = cost;
  for (const tier of ["laborNormal", "laborDifficult", "laborVeryDifficult"] as const) {
    const wanted = tiers[tier];
    if (wanted === undefined) continue;
    const stored = round6(wanted * divisor);
    if (stored !== item[tier]) proposed[tier] = stored;
  }
  return proposed;
}

export async function proposeChangeCore(call: DoorCall, itemIdParam: string | null, raw: Record<string, unknown>): Promise<DoorResult> {
  const principal = call.principal;
  // REST puts the item in the path; the tool puts it in its arguments. One input either way.
  const merged = itemIdParam !== null ? { ...raw, item_id: itemIdParam } : raw;
  refuseUnknownFields(merged, PROPOSE_FIELDS);
  const body = parseOrRefuse(proposeChangeInputSchema, merged);
  if (body.name === undefined && body.material_cost === undefined && body.hours === undefined) {
    throw badRequest("Say what to change: name, material_cost (PRE-TAX) or hours.");
  }
  const itemId = body.item_id.toUpperCase();
  const { idempotency_key: idempotencyKey, ...hashed } = { ...body, item_id: itemId };
  const threadId = await ensurePriceBookThread(prisma);

  const out = await withIdempotency({ keyId: principal.keyId, role: principal.role }, PROPOSE_OPERATION, idempotencyKey, hashed, async (tx) => {
    const item = await tx.priceBookAtomic.findUnique({ where: { itemId } });
    if (!item) throw new AgentApiError("not_found", { reason: "No price book item with that id." });
    if (item.retiredAt) throw badRequest(`${itemId} has been retired, so its price cannot be changed.`);
    const proposed = patchFor(item, body);
    if (Object.keys(proposed).length === 0) throw badRequest(`${itemId} already holds those values: there is nothing to propose.`);
    // A dry run through the book's own update path, so a refusal (an assembly guard) is told to the agent now, not at the approver's tap.
    const plan = await planAtomicUpdate(tx as unknown as PrismaClient, itemId, proposed as AtomicPatch);
    if (!plan.ok) throw badRequest(plan.reason);

    const card = await insertPriceChangeCard(tx, { threadId, itemId, proposed, principal: { keyId: principal.keyId, name: principal.name, role: principal.role } });
    const editedBy = agentEditorName(principal.name);
    const changes: Array<{ field: string; before: string | number | null; after: string | number | null }> = [];
    for (const field of PROPOSABLE_FIELDS) {
      const after = proposed[field];
      if (after === undefined) continue;
      const before = item[field as keyof ItemRow] as string | number | null;
      const divisor = item.laborUnitDivisor !== null && item.laborUnitDivisor > 0 ? item.laborUnitDivisor : 1;
      const perUnitOf = (v: string | number | null) => (typeof v === "number" && field.startsWith("labor") ? round6(v / divisor) : v);
      changes.push({ field: FIELD_WORD[field], before: perUnitOf(before ?? null), after: perUnitOf(after) });
      await tx.priceBookEdit.create({
        data: {
          itemId, field: `proposed:${field}`, oldValue: before === null ? null : String(before), newValue: String(after), editedBy,
          note: `Proposed by agent key "${principal.name}" (card ${card.id}).`,
        },
      });
    }
    const answer = await answerWith(call, PROPOSAL_OUT, {
      proposal_id: card.id, item_id: itemId, status: "pending_approval",
      waiting_for: "A person with the price book power approves it in the CRM: Messages, Waiting for approval.", changes,
    });
    await recordAgentCall(call.auditRecord({ status: 201, body: answer, recordIds: [itemId, card.id], resultCode: "ok", idempotencyKey }), tx);
    return answer;
  });

  if (out.replayed) return { status: 200, body: out.result, recordIds: [], replayed: true, idempotencyKey };
  const proposalId = (out.result as { proposal_id: string }).proposal_id;
  // After the commit: the open screens and the approvers' devices hear of the card (the ONE fan-out), and the other agents of the event.
  const [card, thread] = await Promise.all([
    prisma.hubMessage.findUnique({ where: { id: proposalId } }),
    prisma.hubThread.findUnique({ where: { id: threadId } }),
  ]);
  if (card && thread) fanOutMessage(card, thread);
  void emitHubEventSafe({ type: "pricebook.change_proposed", proposalId, authorKeyId: principal.keyId });
  return { status: 201, body: out.result, recordIds: [itemId, proposalId], auditWritten: true, idempotencyKey };
}
