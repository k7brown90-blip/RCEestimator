/**
 * Agent price-book access, batch 1 (Kyle, 2026-11-24 "Add price book access for agent keys", amended 2026-11-25): the scopes, the REST door
 * /api/agent/price-book/*, the five /mcp tools, agent-typed hours, proposals as approval cards, the audit and the events. Real HTTP through the
 * app and the test database.
 *
 * Price-book data: NONE is seeded. Every item here is made by the door under test (or a plain row for a component), tagged with TAG in its
 * name, and removed in afterAll (Kyle: "There should be no seeding any pricebook data ever at all"). The markup tiers are Rate Config, not
 * catalog rows; they are set to Kyle's real 1.30 and put back afterwards.
 *
 * Pinned here: who gets in (no credential, a session token and a technician token are all 401; the scope, Allow writes and kill switch are the
 * gate's); reads (categories, search by name and category, one item, retired items hidden); create (labor, material, material + labor,
 * assembly; hours typed per unit with a blank tier left blank; the NECA reference kept as the labour source; PRE-TAX cost and the book's real
 * sell numbers; the unit-basis trap; refusals with reasons); the near-duplicate 409 with the existing item; idempotency (replay, conflict, across
 * REST and MCP) and the id race; proposals (a card, nothing changes, never auto-approved, the card says before/after and which assemblies move,
 * approve applies through the book's path and the assembly cascade, reject changes nothing, only a holder of price_book_edit approves, in the CRM
 * and in the field app); NO delete / retire / archive / edit for an agent; the audit trail (PriceBookEdit editedBy, AgentAuditLog, the Messages
 * audit log); the events (every other key with pricebook:read, never the author, signed, never on a replay); the migration's data statements.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
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
  class MockOAuth2 { setCredentials() {} }
  return { google: { auth: { OAuth2: MockOAuth2 }, calendar: () => ({ freebusy: { query: vi.fn() }, events: { list: vi.fn(), delete: vi.fn() } }) } };
});

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { mintAgentKey } from "../src/agentApi/keys";
import { AGENT_TOOLS } from "../src/agentApi/tools";
import { AGENT_KEY_ROUTES } from "../src/middleware/publicRoutes";
import { saveCrmLogin, setPowers } from "../src/services/crmLogin";
import * as catalog from "../src/services/priceBookCatalog";
import { Prisma } from "@prisma/client";
import { PRICE_BOOK_THREAD_ID } from "../src/services/priceBookProposals";
import { isContinuousLengthMaterial } from "../src/services/atomicEstimateEngine";
import { draftSupplierFor, loadCatalogAtSupplier, loadRateContext } from "../src/services/atomicEstimateService";
import { splitWireBody } from "../shared/hub/events";
import { AGENT_SCOPES, DEFAULT_SCOPES_BY_ROLE, isAgentScope, type AgentRole } from "../shared/agentScopes";
import { CRM_POWERS } from "../shared/crmPowers";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";
import { ensureThreadFor, type HubReader } from "../src/services/hub";
import { waitingDraft } from "./helpers/waitingDraft"; // Kyle 2026-11-24: an agent message now SENDS when posted; these tests need a card already waiting (a pre-deploy one)
import { IN_APP_LABOR_BASIS_RAW, laborSourceText } from "../shared/priceBookLaborSource";
import { approvingLabel, cardLocks } from "../shared/hub/approvalRules";
import { ensurePriceBookGates } from "./helpers/priceBookFixture";

const TAG = "AgentPB";
const PIN = "1234";
const PASS = "correct horse battery";
const WEBHOOK_SECRET = "pricebook-hub-secret-0123456789";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const idem = () => `idem-${randomUUID()}`;

let savedPin: string | undefined;
let savedPepper: string | undefined;
let savedEnvName: string | undefined;
let savedSecret: string | undefined;
let savedUrl: string | undefined;
let pin = "";
let techToken = "";
let techId = "";
const keyIds: string[] = [];
const savedTiers = new Map<string, number | null | "absent">();
const TIER_KEYS = ["markupTier1", "markupTier2", "markupTier3", "markupTier4", "markupTier5"];

type Made = { id: string; secret: string; name: string; role: AgentRole };
async function keyFor(role: AgentRole, over: { scopes?: string[]; writesEnabled?: boolean; teamPostsPublish?: boolean } = {}): Promise<Made> {
  const name = `${TAG} ${role} ${randomUUID().slice(0, 5)}`;
  const made = await mintAgentKey({
    name, agentRole: role, createdBy: "owner", writesEnabled: over.writesEnabled ?? true, scopes: over.scopes, teamPostsPublish: over.teamPostsPublish,
  });
  keyIds.push(made.row.id);
  return { id: made.row.id, secret: made.key, name, role };
}
async function setMode(mode: "on" | "read_only" | "off") {
  const valueJson = JSON.stringify({ mode, changedAt: null, changedBy: null });
  await prisma.companySetting.upsert({ where: { key: "agentAccess" }, create: { key: "agentAccess", valueJson }, update: { valueJson } });
}

const rest = {
  get: (k: Made | string, path: string) => request(app).get(`/api/agent/price-book${path}`).set(bearer(typeof k === "string" ? k : k.secret)),
  post: (k: Made | string, path: string, body: object) => request(app).post(`/api/agent/price-book${path}`).set(bearer(typeof k === "string" ? k : k.secret)).send(body),
};
// Kyle 2026-11-25 ("yes they should add the specific unit"): every create sends a unit. "each" unless a test says otherwise (its body wins).
const create = (k: Made, body: Record<string, unknown>) => rest.post(k, "/items", { idempotency_key: idem(), unit: "each", ...body });
const propose = (k: Made, itemId: string, body: Record<string, unknown>) => rest.post(k, `/items/${itemId}/proposals`, { idempotency_key: idem(), ...body });

async function rpc(secret: string | null, method: string, params?: Record<string, unknown>) {
  let r = request(app).post("/mcp").set("Accept", "application/json, text/event-stream");
  if (secret) r = r.set(bearer(secret));
  return r.send({ jsonrpc: "2.0", id: 1, method, params });
}
async function tool(secret: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(secret, "tools/call", { name, arguments: args });
  expect(res.status, res.text).toBe(200);
  const result = res.body.result as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

async function cleanItems() {
  const items = await prisma.priceBookAtomic.findMany({ where: { description: { startsWith: TAG } }, select: { itemId: true } });
  const ids = items.map((i) => i.itemId);
  if (ids.length === 0) return;
  await prisma.priceBookItemComponent.deleteMany({ where: { OR: [{ parentItemId: { in: ids } }, { childItemId: { in: ids } }] } });
  await prisma.priceBookEdit.deleteMany({ where: { itemId: { in: ids } } });
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: ids } } });
}
async function cleanCards() {
  await prisma.hubMessage.deleteMany({ where: { threadId: PRICE_BOOK_THREAD_ID } });
}

let savedPurchasing: string | undefined;

beforeAll(async () => {
  savedPin = process.env.PIN_HASH;
  savedPepper = process.env.AGENT_KEY_PEPPER;
  savedEnvName = process.env.RAILWAY_ENVIRONMENT_NAME;
  savedSecret = process.env.HUB_WEBHOOK_SECRET;
  savedUrl = process.env.HUB_AGENT_WEBHOOK_URL;
  process.env.PIN_HASH = await hashPin(PIN);
  process.env.AGENT_KEY_PEPPER = "test-pepper-for-the-agent-price-book";
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
  delete process.env.HUB_AGENT_WEBHOOK_URL;
  delete process.env.HUB_WEBHOOK_SECRET;
  pin = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
  const tech = await prisma.technician.create({ data: { name: `${TAG} Tech`, accessToken: `${TAG}-tech-${randomUUID()}` } });
  techId = tech.id;
  techToken = tech.accessToken;
  // Rate Config (not catalog rows): the billed rate and Kyle's real 1.30 markup on every tier, put back in afterAll.
  await ensurePriceBookGates();
  for (const key of TIER_KEYS) {
    const row = await prisma.priceBookRateConfig.findUnique({ where: { key } });
    savedTiers.set(key, row ? row.numberValue : "absent");
    await prisma.priceBookRateConfig.upsert({
      where: { key }, create: { key, label: `${key} (test)`, workbookRow: 0, numberValue: 1.3 }, update: { numberValue: 1.3 },
    });
  }
  // The sales tax inside every sell (Kyle 2026-11-24 "Tax in sell, all items"): Settings -> Purchasing, saved at 9.75% for the run and put back after.
  const purchasing = await prisma.companySetting.findUnique({ where: { key: "purchasing" } });
  savedPurchasing = purchasing ? purchasing.valueJson : "absent";
  await prisma.companySetting.upsert({
    where: { key: "purchasing" }, create: { key: "purchasing", valueJson: JSON.stringify({ salesTaxRate: 0.0975 }) }, update: { valueJson: JSON.stringify({ salesTaxRate: 0.0975 }) },
  });
  await setMode("on");
});

afterAll(async () => {
  if (savedPurchasing === "absent") await prisma.companySetting.deleteMany({ where: { key: "purchasing" } });
  else if (savedPurchasing !== undefined) await prisma.companySetting.update({ where: { key: "purchasing" }, data: { valueJson: savedPurchasing } });
  await cleanItems();
  await cleanCards();
  await prisma.agentKey.deleteMany({ where: { id: { in: keyIds } } });
  await prisma.technician.deleteMany({ where: { id: techId } });
  await cleanupCrmLoginFixtures();
  for (const [key, was] of savedTiers) {
    if (was === "absent") await prisma.priceBookRateConfig.deleteMany({ where: { key } });
    else await prisma.priceBookRateConfig.update({ where: { key }, data: { numberValue: was } });
  }
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  restore("PIN_HASH", savedPin);
  restore("AGENT_KEY_PEPPER", savedPepper);
  restore("RAILWAY_ENVIRONMENT_NAME", savedEnvName);
  restore("HUB_WEBHOOK_SECRET", savedSecret);
  restore("HUB_AGENT_WEBHOOK_URL", savedUrl);
});

beforeEach(async () => { await setMode("on"); });

// ── scopes ────────────────────────────────────────────────────────────────────────────────────────

describe("the two scopes (Kyle 2026-11-24 item 1)", () => {
  it("pricebook:read and pricebook:write exist with Kyle's labels; the unused pricebook:propose is gone", () => {
    expect(isAgentScope("pricebook:read")).toBe(true);
    expect(isAgentScope("pricebook:write")).toBe(true);
    expect(isAgentScope("pricebook:propose")).toBe(false);
    expect(AGENT_SCOPES["pricebook:read"]).toBe("Read the price book");
    expect(AGENT_SCOPES["pricebook:write"]).toBe("Add to the price book and propose changes");
  });

  it("the Inventory key reads and writes the price book; every other role but Other reads it only", () => {
    expect(DEFAULT_SCOPES_BY_ROLE.inventory).toEqual(expect.arrayContaining(["pricebook:read", "pricebook:write"]));
    for (const role of ["admin", "outreach", "research", "cfo", "facebook", "scout", "nec_coach", "claude_code"] as const) {
      expect(DEFAULT_SCOPES_BY_ROLE[role], role).toContain("pricebook:read");
      expect(DEFAULT_SCOPES_BY_ROLE[role], role).not.toContain("pricebook:write");
    }
    expect(DEFAULT_SCOPES_BY_ROLE.other).toEqual([]);
  });
});

// ── who gets in ───────────────────────────────────────────────────────────────────────────────────

describe("who gets in", () => {
  it("no credential, a session token and a technician token are all 401 on every price-book route; nothing is public", async () => {
    for (const token of [null, pin, techToken]) {
      const get = request(app).get("/api/agent/price-book/categories");
      const post = request(app).post("/api/agent/price-book/items").send({});
      expect((token ? await get.set(bearer(token)) : await get).status).toBe(401);
      expect((token ? await post.set(bearer(token)) : await post).status).toBe(401);
    }
    // The bare path (no /api prefix) is the same door.
    expect((await request(app).get("/agent/price-book/categories")).status).toBe(401);
  });

  it("a key without pricebook:read is refused 403 scope_denied and told which box to tick; a read-only key cannot write", async () => {
    const noScopes = await keyFor("other", { scopes: ["team:read"] });
    const denied = await rest.get(noScopes, "/categories");
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: "scope_denied" });
    expect(denied.body.reason).toContain("pricebook:read");
    expect(denied.body.reason).toContain("Settings");

    const research = await keyFor("research");
    expect((await rest.get(research, "/categories")).status).toBe(200);
    const write = await create(research, { name: `${TAG} nope`, category: `${TAG} Cat`, type: "labor", hours: 1 });
    expect(write.status).toBe(403);
    expect(write.body.reason).toContain("pricebook:write");
    expect(await prisma.priceBookAtomic.count({ where: { description: `${TAG} nope` } })).toBe(0);
  });

  it("Allow writes off is 403 writes_disabled; the kill switch read_only refuses writes and still reads; off refuses everything", async () => {
    const noWrites = await keyFor("inventory", { writesEnabled: false });
    const r = await create(noWrites, { name: `${TAG} nowrites`, category: `${TAG} Cat`, type: "labor", hours: 1 });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("writes_disabled");

    const inv = await keyFor("inventory");
    await setMode("read_only");
    expect((await create(inv, { name: `${TAG} readonly`, category: `${TAG} Cat`, type: "labor", hours: 1 })).body.code).toBe("agents_read_only");
    expect((await rest.get(inv, "/categories")).status).toBe(200);
    await setMode("off");
    expect((await rest.get(inv, "/categories")).status).toBe(503);
    await setMode("on");
    expect(await prisma.priceBookAtomic.count({ where: { description: { in: [`${TAG} nowrites`, `${TAG} readonly`] } } })).toBe(0);
  });
});

// ── create ────────────────────────────────────────────────────────────────────────────────────────

describe("create: a NEW item through createAtomic, hours typed per unit, cost PRE-TAX", () => {
  let inv: Made;
  beforeAll(async () => { inv = await keyFor("inventory"); });

  it("labor: LABOR ONLY, three tiers typed, the NECA reference kept as the labour source, the unit basis set (hours would price at $0 without it)", async () => {
    const r = await create(inv, {
      name: `${TAG} Labor A`, category: `${TAG} Labor Cat`, subcategory_or_brand: "Brand X", type: "labor",
      hours: { normal: 0.5, difficult: 0.75, very_difficult: 1 }, neca_reference: "NECA MLU 2019-20, p.179, Table 3-4, row 12", notes: "typed by the agent",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      name: `${TAG} Labor A`, category: `${TAG} Labor Cat`, sub_category: "Brand X", type: "labor", row_type: "LABOR ONLY",
      hours: { normal: 0.5, difficult: 0.75, very_difficult: 1 }, cost: null, labour_source: "NECA MLU 2019-20, p.179, Table 3-4, row 12", retired: false,
    });
    // Labour only sells hours x the shop rate ($100 in Rate Config): no material.
    expect(r.body.sell).toEqual({ normal: 50, difficult: 75, very_difficult: 100 });
    const row = await prisma.priceBookAtomic.findUniqueOrThrow({ where: { itemId: r.body.item_id } });
    expect(row).toMatchObject({
      rowType: "LABOR ONLY", laborNormal: 0.5, laborDifficult: 0.75, laborVeryDifficult: 1, laborUnitBasis: "E", laborUnitDivisor: 1,
      laborUnitBasisRaw: "E [NECA MLU 2019-20, p.179, Table 3-4, row 12]", source: "in-app", companyCost: null,
    });
    const edit = await prisma.priceBookEdit.findFirstOrThrow({ where: { itemId: r.body.item_id, field: "created" } });
    expect(edit.editedBy).toBe(`agent:${inv.name}`);
    expect(edit.note).toContain(inv.name);
  });

  it("material only: PRE-TAX cost, sells the marked-up material with no labour line; hours are refused with the reason", async () => {
    const r = await create(inv, { name: `${TAG} Mat Only`, category: `${TAG} Mat Cat`, type: "material", material_cost: 10 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // $10.00 pre-tax + 9.75% tax = $10.98 (the sales tax is inside the sell, Kyle 2026-11-24 "Tax in sell, all items"); x Kyle's 1.30 = $14.27
    // (10 x 1.0975 x 1.3 = 14.2675, rounded once); a material-only row sells exactly that. It was $13.00 before the tax went in.
    expect(r.body).toMatchObject({ type: "material", row_type: "MATERIAL ONLY", cost: 10, cost_with_tax: 10.98, sell: { normal: 14.27, difficult: 14.27, very_difficult: 14.27 }, labour_source: null });
    expect(r.body.hours).toEqual({ normal: null, difficult: null, very_difficult: null });
    const row = await prisma.priceBookAtomic.findUniqueOrThrow({ where: { itemId: r.body.item_id } });
    expect(row).toMatchObject({ companyCost: 10, companyCostWithTax: 10.98, companyPrice: 14.27 });
  });

  it("material + labor: a single number is the Normal tier, a tier left out stays BLANK (the engine will block that difficulty)", async () => {
    const r = await create(inv, { name: `${TAG} Mat Labor`, category: `${TAG} Mat Cat`, type: "material", material_cost: 10, hours: 0.5 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ row_type: "MATERIAL + LABOR", cost: 10, hours: { normal: 0.5, difficult: null, very_difficult: null } });
    // 0.5 h x $100 + $14.27 = $64.27 (Kyle 2026-11-24 "Tax in sell, all items": $63.00 before the 9.75% tax went in); the blank tiers have no sell.
    expect(r.body.sell).toEqual({ normal: 64.27, difficult: null, very_difficult: null });
    const row = await prisma.priceBookAtomic.findUniqueOrThrow({ where: { itemId: r.body.item_id } });
    expect(row).toMatchObject({ laborNormal: 0.5, laborDifficult: null, laborVeryDifficult: null, laborUnitDivisor: 1 });
  });

  it("assembly: parts [{item_id, quantity}], cost and hours roll up from them, each part's cost counted ONCE (never its marked-up price)", async () => {
    const a = await create(inv, { name: `${TAG} Part A`, category: `${TAG} Asm Cat`, type: "material", material_cost: 10, hours: { normal: 0.25, difficult: 0.5, very_difficult: 0.75 } });
    const b = await create(inv, { name: `${TAG} Part B`, category: `${TAG} Asm Cat`, type: "material", material_cost: 4, hours: { normal: 0.1, difficult: 0.2, very_difficult: 0.3 } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const r = await create(inv, {
      name: `${TAG} Assembly One`, category: `${TAG} Asm Cat`, type: "assembly",
      components: [{ item_id: a.body.item_id, quantity: 2 }, { item_id: b.body.item_id, quantity: 3 }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ type: "assembly", row_type: "ASSEMBLY", cost: 32 }); // 10x2 + 4x3
    expect(r.body.hours.normal).toBeCloseTo(0.8, 6); // 0.25x2 + 0.1x3
    expect(r.body.components).toEqual([
      { item_id: a.body.item_id, name: `${TAG} Part A`, quantity: 2 },
      { item_id: b.body.item_id, name: `${TAG} Part B`, quantity: 3 },
    ].sort((x, y) => x.item_id.localeCompare(y.item_id)));
    expect(await prisma.priceBookItemComponent.count({ where: { parentItemId: r.body.item_id } })).toBe(2);
  });

  it("an assembly is refused when a part is retired, unpriced, missing, an assembly itself, or listed twice - and makes nothing", async () => {
    const good = await create(inv, { name: `${TAG} Good Part`, category: `${TAG} Asm Cat`, type: "material", material_cost: 5 });
    const retired = await create(inv, { name: `${TAG} Retired Part`, category: `${TAG} Asm Cat`, type: "material", material_cost: 5 });
    const laborOnly = await create(inv, { name: `${TAG} Labor Only Part`, category: `${TAG} Asm Cat`, type: "labor", hours: 1 });
    await prisma.priceBookAtomic.update({ where: { itemId: retired.body.item_id }, data: { retiredAt: new Date() } });
    const before = await prisma.priceBookAtomic.count({ where: { description: { startsWith: `${TAG} Bad Assembly` } } });
    const attempt = (name: string, components: unknown) => create(inv, { name: `${TAG} Bad Assembly ${name}`, category: `${TAG} Asm Cat`, type: "assembly", components });
    const r1 = await attempt("retired", [{ item_id: retired.body.item_id, quantity: 1 }]);
    expect(r1.status).toBe(400);
    expect(r1.body.reason).toContain("retired");
    const r2 = await attempt("unpriced", [{ item_id: good.body.item_id, quantity: 1 }, { item_id: laborOnly.body.item_id, quantity: 1 }]);
    expect(r2.status).toBe(400);
    expect(r2.body.reason).toContain("labor only");
    expect(r2.body.reason).toContain("leave the labor out");
    expect(r2.body.reason).not.toContain("Price those items first");
    const r3 = await attempt("missing", [{ item_id: "NOPE999", quantity: 1 }]);
    expect(r3.status).toBe(400);
    expect(r3.body.reason).toContain("NOPE999");
    const r4 = await attempt("twice", [{ item_id: good.body.item_id, quantity: 1 }, { item_id: good.body.item_id, quantity: 2 }]);
    expect(r4.status).toBe(400);
    expect(r4.body.reason).toContain("twice");
    const r5 = await attempt("zero", [{ item_id: good.body.item_id, quantity: 0 }]);
    expect(r5.status).toBe(400);
    expect(await prisma.priceBookAtomic.count({ where: { description: { startsWith: `${TAG} Bad Assembly` } } })).toBe(before);
    // An assembly cannot hold an assembly.
    const asm = await create(inv, { name: `${TAG} Nest Base`, category: `${TAG} Asm Cat`, type: "assembly", components: [{ item_id: good.body.item_id, quantity: 1 }] });
    const nest = await attempt("nested", [{ item_id: asm.body.item_id, quantity: 1 }]);
    expect(nest.status).toBe(400);
    expect(nest.body.reason).toContain("assembly");
  });

  it.each([
    ["negative hours", { type: "labor", hours: -1 }, "cannot be negative"],
    ["zero hours", { type: "labor", hours: { normal: 0 } }, "more than 0"],
    ["hours over 100 a unit (an unconverted per-1000 value)", { type: "labor", hours: { normal: 101 } }, "100"],
    ["a labor item with no hours", { type: "labor" }, "needs hours"],
    ["a labor item with a material cost", { type: "labor", hours: 1, material_cost: 5 }, "no material cost"],
    ["a material item with no cost", { type: "material" }, "material_cost"],
    ["a negative cost", { type: "material", material_cost: -2 }, "negative"],
    ["a NECA reference with no hours", { type: "material", material_cost: 5, neca_reference: "p.1" }, "hours"],
    ["components on a material", { type: "material", material_cost: 5, components: [{ item_id: "A1", quantity: 1 }] }, "assembly"],
    ["an assembly with no components", { type: "assembly" }, "components"],
    ["an assembly with a cost", { type: "assembly", material_cost: 5, components: [{ item_id: "A1", quantity: 1 }] }, "components only"],
  ])("refuses %s with a reason, 400, and makes nothing", async (_label, body, reasonHas) => {
    const name = `${TAG} Refuse ${randomUUID().slice(0, 6)}`;
    const r = await create(inv, { name, category: `${TAG} Refuse Cat`, ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.code).toBe("bad_request");
    expect(r.body.reason).toContain(reasonHas);
    expect(await prisma.priceBookAtomic.count({ where: { description: name } })).toBe(0);
  });

  it("refuses a field it does not take (a typo like `cost` must not be silently dropped), a missing idempotency_key and a non-number cost", async () => {
    const typo = await create(inv, { name: `${TAG} Typo`, category: `${TAG} Cat`, type: "material", cost: 5 });
    expect(typo.status).toBe(400);
    expect(typo.body.reason).toContain("cost");
    const noKey = await rest.post(inv, "/items", { unit: "each", name: `${TAG} NoKey`, category: `${TAG} Cat`, type: "labor", hours: 1 });
    expect(noKey.status).toBe(400);
    expect(noKey.body.reason).toContain("idempotency_key");
    const text = await create(inv, { name: `${TAG} Text`, category: `${TAG} Cat`, type: "material", material_cost: "ten" });
    expect(text.status).toBe(400);
    expect(JSON.stringify(text.body)).not.toContain("ten");
  });

  it("a near-duplicate name in the same category is 409 duplicate_item WITH the existing item; another category, or a retired twin, is fine", async () => {
    const first = await create(inv, { name: `${TAG} Twin Breaker 20A`, category: `${TAG} Dup Cat`, type: "material", material_cost: 7 });
    expect(first.status).toBe(201);
    for (const name of [`${TAG} Twin Breaker 20A`, `  ${TAG}   twin breaker 20a `, `20A ${TAG} twin-breaker`]) {
      const r = await create(inv, { name, category: `${TAG} dup cat`, type: "material", material_cost: 8 });
      expect(r.status, name).toBe(409);
      expect(r.body.code).toBe("duplicate_item");
      expect(r.body.retryable).toBe(false);
      expect(r.body.existing_item).toMatchObject({ item_id: first.body.item_id, name: `${TAG} Twin Breaker 20A`, cost: 7 });
    }
    // Kyle asked for NEW items: a name that only CONTAINS (or is contained in) another is a different product, not a twin (review finding 2026-11-25).
    for (const name of [`${TAG} Twin Breaker 20A GFCI`, `${TAG} Twin Breaker`, `${TAG} Twin Breaker 20A 2-pole`]) {
      const r = await create(inv, { name, category: `${TAG} dup cat`, type: "material", material_cost: 9 });
      expect(r.status, name).toBe(201);
    }
    // The same name under a different brand is a different item; under the same brand it is a twin.
    const sq = await create(inv, { name: `${TAG} Brand Breaker 20A`, category: `${TAG} Dup Cat`, subcategory_or_brand: "Square D", type: "material", material_cost: 10 });
    expect(sq.status).toBe(201);
    const siemens = await create(inv, { name: `${TAG} Brand Breaker 20A`, category: `${TAG} Dup Cat`, subcategory_or_brand: "Siemens", type: "material", material_cost: 11 });
    expect(siemens.status).toBe(201);
    const sqAgain = await create(inv, { name: `${TAG} brand breaker 20a`, category: `${TAG} Dup Cat`, subcategory_or_brand: "square d", type: "material", material_cost: 10 });
    expect(sqAgain.status).toBe(409);
    expect(sqAgain.body.existing_item.item_id).toBe(sq.body.item_id);
    const other = await create(inv, { name: `${TAG} Twin Breaker 20A`, category: `${TAG} Other Dup Cat`, type: "material", material_cost: 7 });
    expect(other.status).toBe(201);
    await prisma.priceBookAtomic.update({ where: { itemId: first.body.item_id }, data: { retiredAt: new Date() } });
    const again = await create(inv, { name: `${TAG} Twin Breaker 20A`, category: `${TAG} Dup Cat`, type: "material", material_cost: 7 });
    expect(again.status).toBe(201);
    expect(await prisma.priceBookAtomic.count({ where: { description: `${TAG} Twin Breaker 20A`, category: `${TAG} Dup Cat` } })).toBe(2);
  });

  it("the category is written the way the book already spells it (the match ignores case)", async () => {
    await create(inv, { name: `${TAG} Spell One`, category: `${TAG} Spell Cat`, type: "material", material_cost: 1 });
    const r = await create(inv, { name: `${TAG} Spell Two Different`, category: `${TAG.toLowerCase()} spell cat`, type: "material", material_cost: 1 });
    expect(r.status).toBe(201);
    expect(r.body.category).toBe(`${TAG} Spell Cat`);
  });
});

// ── idempotency and the id race ───────────────────────────────────────────────────────────────────

describe("idempotency", () => {
  it("a retry with the same key and request returns the first item (200) and makes nothing; a different request under the key is 409; the other door replays too", async () => {
    const inv = await keyFor("inventory");
    const key = idem();
    const body = { name: `${TAG} Idem One`, category: `${TAG} Idem Cat`, type: "material", material_cost: 3 };
    const first = await rest.post(inv, "/items", { idempotency_key: key, unit: "each", ...body });
    expect(first.status).toBe(201);
    const again = await rest.post(inv, "/items", { idempotency_key: key, unit: "each", ...body });
    expect(again.status).toBe(200);
    expect(again.body.item_id).toBe(first.body.item_id);
    expect(await prisma.priceBookAtomic.count({ where: { description: `${TAG} Idem One` } })).toBe(1);
    const conflict = await rest.post(inv, "/items", { idempotency_key: key, unit: "each", ...body, material_cost: 4 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("idempotency_conflict");
    // The same request through /mcp finds the first result: one operation name for both doors.
    const viaMcp = await tool(inv.secret, "create_price_book_item", { idempotency_key: key, unit: "each", ...body });
    expect(viaMcp.isError).toBe(false);
    expect(viaMcp.body.item_id).toBe(first.body.item_id);
    expect(await prisma.priceBookAtomic.count({ where: { description: `${TAG} Idem One` } })).toBe(1);
  });

  it("a create that loses the next-id race to the CRM (P2002) is run again and succeeds; if it keeps losing it is a plain 500 that makes nothing and frees the key", async () => {
    const inv = await keyFor("inventory");
    const real = catalog.createAtomic;
    const lost = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`itemId`)", { code: "P2002", clientVersion: "test" });
    const spy = vi.spyOn(catalog, "createAtomic").mockImplementationOnce(async () => { throw lost(); });
    const ok = await create(inv, { name: `${TAG} Lost Once`, category: `${TAG} Race Cat`, type: "material", material_cost: 2 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await prisma.priceBookAtomic.count({ where: { description: `${TAG} Lost Once` } })).toBe(1);

    spy.mockReset();
    spy.mockImplementation(async () => { throw lost(); });
    const key = idem();
    const body = { name: `${TAG} Lost Always`, category: `${TAG} Race Cat`, type: "material", material_cost: 2 };
    const bad = await rest.post(inv, "/items", { idempotency_key: key, unit: "each", ...body });
    expect(bad.status).toBe(500);
    expect(bad.body.code).toBe("internal");
    expect(JSON.stringify(bad.body)).not.toContain("Unique constraint");
    expect(spy).toHaveBeenCalledTimes(3);
    expect(await prisma.priceBookAtomic.count({ where: { description: `${TAG} Lost Always` } })).toBe(0);
    spy.mockImplementation(real);
    // The key was freed by the rollback: the same request goes through once the race is over.
    const again = await rest.post(inv, "/items", { idempotency_key: key, unit: "each", ...body });
    expect(again.status).toBe(201);
    spy.mockRestore();
  });

  it("two creates at the same moment each get their own id (they queue on one lock, so they cannot collide with each other)", async () => {
    const inv = await keyFor("inventory");
    const results = await Promise.all([1, 2, 3].map((n) =>
      create(inv, { name: `${TAG} Race ${n}${"x".repeat(n)}`, category: `${TAG} Race Cat ${n}`, type: "material", material_cost: n })));
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(new Set(results.map((r) => r.body.item_id)).size).toBe(3);
  });
});

// ── reads ─────────────────────────────────────────────────────────────────────────────────────────

describe("reads", () => {
  it("categories, search by name and by category, one item, retired items hidden, 404 for an unknown id", async () => {
    const inv = await keyFor("inventory");
    const reader = await keyFor("research");
    const a = await create(inv, { name: `${TAG} Read Alpha`, category: `${TAG} Read Cat`, type: "material", material_cost: 2, hours: 0.2 });
    const b = await create(inv, { name: `${TAG} Read Beta`, category: `${TAG} Read Cat`, subcategory_or_brand: "Acme", type: "material", material_cost: 3 });
    const cats = await rest.get(reader, "/categories");
    expect(cats.status).toBe(200);
    const mine = cats.body.categories.find((c: { name: string }) => c.name === `${TAG} Read Cat`);
    expect(mine).toMatchObject({ count: 2 });
    expect(mine.sub_categories).toEqual(expect.arrayContaining([{ name: "Acme", count: 1 }]));

    const byName = await rest.get(reader, `/items?search=${encodeURIComponent(`${TAG} Read Alpha`)}`);
    expect(byName.status).toBe(200);
    expect(byName.body.items).toHaveLength(1);
    expect(byName.body.items[0]).toMatchObject({ item_id: a.body.item_id, cost: 2, hours: { normal: 0.2 }, sell: { normal: 22.85 } }); // 2 x 1.0975 x 1.3 = 2.8535 -> 2.85; 0.2 h x $100 + 2.85 (was 22.60 before the tax went in the sell, Kyle 2026-11-24)
    expect(byName.body).toMatchObject({ count: 1, total: 1, truncated: false });
    const byCat = await rest.get(reader, `/items?category=${encodeURIComponent(`${TAG} Read Cat`)}&limit=1`);
    expect(byCat.body).toMatchObject({ count: 1, total: 2, truncated: true });
    const byId = await rest.get(reader, `/items/${a.body.item_id}`);
    expect(byId.status).toBe(200);
    expect(byId.body.item_id).toBe(a.body.item_id);
    expect((await rest.get(reader, "/items/NOPE-404")).status).toBe(404);

    await prisma.priceBookAtomic.update({ where: { itemId: b.body.item_id }, data: { retiredAt: new Date() } });
    const after = await rest.get(reader, `/items?category=${encodeURIComponent(`${TAG} Read Cat`)}`);
    expect(after.body.items.map((i: { item_id: string }) => i.item_id)).toEqual([a.body.item_id]);
    // A key with only pricebook:write can still read the item it just made (the write answer is the same profile).
    expect((await rest.get(await keyFor("other", { scopes: ["pricebook:write"] }), `/items/${a.body.item_id}`)).status).toBe(403);
  });

  it("an imported item's hours are read PER UNIT (a per-100 value is divided by its basis) and a tier with no unit basis is null", async () => {
    const reader = await keyFor("research");
    const row = await prisma.priceBookAtomic.create({
      data: {
        itemId: `ZPB${Math.floor(Math.random() * 90000 + 10000)}`, description: `${TAG} Per Hundred`, category: `${TAG} Read Cat`, rowType: "MATERIAL + LABOR", source: "test-fixture",
        laborNormal: 12, laborDifficult: 18, laborVeryDifficult: null, laborUnitBasis: "C", laborUnitDivisor: 100, companyCost: 1,
      },
    });
    const r = await rest.get(reader, `/items/${row.itemId}`);
    expect(r.body.hours).toEqual({ normal: 0.12, difficult: 0.18, very_difficult: null });
  });
});

// ── proposals ─────────────────────────────────────────────────────────────────────────────────────

describe("proposals: a card in Messages, applied only when a person with the price book power approves it", () => {
  let inv: Made;
  let part: string;
  let asm: string;
  beforeAll(async () => {
    inv = await keyFor("inventory", { teamPostsPublish: true });
    const p = await create(inv, { name: `${TAG} Prop Part`, category: `${TAG} Prop Cat`, type: "material", material_cost: 10, hours: { normal: 0.5, difficult: 0.75, very_difficult: 1 } });
    part = p.body.item_id;
    const a = await create(inv, { name: `${TAG} Prop Assembly`, category: `${TAG} Prop Cat`, type: "assembly", components: [{ item_id: part, quantity: 2 }] });
    asm = a.body.item_id;
  });

  const cardsFor = async (token: string) => (await request(app).get("/hub/approvals").set(bearer(token))).body as { cards: Array<Record<string, any>>; canApprove: boolean };
  const item = (id: string) => prisma.priceBookAtomic.findUniqueOrThrow({ where: { itemId: id } });
  async function makeApprover(powers: string[]) {
    const person = await makePerson(`${TAG} ${randomUUID().slice(0, 5)}`);
    const username = `pb_${randomUUID().slice(0, 8)}`;
    const login = await saveCrmLogin(person.id, { username, role: "owner", password: PASS });
    await setPowers(login.id, powers);
    const token = (await request(app).post("/auth/login").send({ username, password: PASS })).body.token as string;
    return { person, token, login };
  }

  it("a proposal makes a waiting card and changes NOTHING; the answer says what it waits for and what changes", async () => {
    const before = await item(part);
    const r = await propose(inv, part, { material_cost: 12, hours: { normal: 0.6 }, name: `${TAG} Prop Part Renamed` });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ item_id: part, status: "pending_approval" });
    expect(r.body.changes).toEqual(expect.arrayContaining([
      { field: "cost", before: 10, after: 12 },
      { field: "hours_normal", before: 0.5, after: 0.6 },
      { field: "name", before: `${TAG} Prop Part`, after: `${TAG} Prop Part Renamed` },
    ]));
    // Nothing moved: the item holds its old values, and so does the assembly that uses it.
    const after = await item(part);
    expect([after.description, after.companyCost, after.laborNormal, after.sellNormal]).toEqual([before.description, before.companyCost, before.laborNormal, before.sellNormal]);
    expect((await item(asm)).companyCost).toBe(20);
    const card = await prisma.hubMessage.findUniqueOrThrow({ where: { id: r.body.proposal_id } });
    expect(card).toMatchObject({ threadId: PRICE_BOOK_THREAD_ID, status: "pending_approval", actionKind: "price_change", authorBotKeyId: inv.id, channel: "in_app", direction: "internal" });
    // The audit trail of the proposal: before/after rows naming the key, the call, and the Messages audit log.
    const edits = await prisma.priceBookEdit.findMany({ where: { itemId: part, field: { startsWith: "proposed:" } } });
    expect(edits.map((e) => [e.field, e.oldValue, e.newValue, e.editedBy])).toEqual(expect.arrayContaining([
      ["proposed:companyCost", "10", "12", `agent:${inv.name}`],
      ["proposed:laborNormal", "0.5", "0.6", `agent:${inv.name}`],
    ]));
    expect(await prisma.hubAuditLog.count({ where: { messageId: card.id, action: "price_change_proposed" } })).toBe(1);
    const call = await prisma.agentAuditLog.findFirstOrThrow({ where: { agentKeyId: inv.id, action: "pricebook.items.propose" }, orderBy: { createdAt: "desc" } });
    expect(call).toMatchObject({ responseStatus: 201, door: "rest", agentKeyName: inv.name, scopeUsed: "pricebook:write" });
    await cleanCards();
  });

  it("the card is NEVER auto-approved, even with the key's Team posts publish immediately box ticked", async () => {
    const r = await propose(inv, part, { material_cost: 11 });
    expect(r.status).toBe(201);
    await new Promise((res) => setTimeout(res, 150));
    const card = await prisma.hubMessage.findUniqueOrThrow({ where: { id: r.body.proposal_id } });
    expect(card.status).toBe("pending_approval");
    expect(await prisma.hubAuditLog.count({ where: { messageId: card.id, action: "message_auto_approved" } })).toBe(0);
    expect((await item(part)).companyCost).toBe(10);
    await cleanCards();
  });

  it("Messages -> Waiting for approval shows the card with before and after and which assemblies it moves and by how much; Edit is greyed with a reason", async () => {
    const r = await propose(inv, part, { material_cost: 12, hours: { normal: 0.6 } });
    const list = await cardsFor(pin);
    const card = list.cards.find((c) => c.id === r.body.proposal_id)!;
    expect(card).toBeTruthy();
    expect(card).toMatchObject({ kind: "price_change", kindLabel: "Price book change", status: "pending_approval", draftedByAi: true });
    expect(card.headerLine).toBe(`Price book change · ${part}`);
    expect(card.approve).toMatchObject({ label: "Approve change", blockedReason: null });
    expect(card.approve.editBlockedReason).toContain("cannot be edited");
    expect(card.chip.text).toContain("never reaches a customer");
    const lines: string[] = card.effectLines;
    expect(lines.join("\n")).toContain("Cost (before tax): $10.00 → $12.00");
    expect(lines.join("\n")).toContain("Normal hours: 0.5 → 0.6");
    // 10 -> 12 on 2 parts moves the assembly's cost 20 -> 24 (+$4.00); its normal sell moves too.
    expect(lines.find((l) => l.startsWith(`Moves assembly ${asm}`))).toContain("cost $20.00 → $24.00 (+$4.00)");
    await cleanCards();
  });

  // Kyle 2026-09-12: a proposal "must show which assemblies it moves, and by how much, BEFORE it is accepted". An HOURS-only change moves the sell
  // tiers and the assembly's own hours, never its cost: the card must say so instead of "+$0.00" with the normal sell alone.
  it("an hours-only change shows the assembly's difficult sell and hours moving, and its cost and normal sell NOT moving", async () => {
    const r = await propose(inv, part, { hours: { difficult: 1 } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const card = (await cardsFor(pin)).cards.find((c) => c.id === r.body.proposal_id)!;
    const line = (card.effectLines as string[]).find((l) => l.startsWith(`Moves assembly ${asm}`))!;
    expect(line).toBeTruthy();
    // 2 parts x 0.75 h = 1.5 h -> 2 x 1.0 = 2 h; the assembly's PRE-TAX cost 20 is untouched, taxed ONCE: 20 x 1.0975 x 1.30 = 28.54 (Kyle 2026-11-24
    // "Tax in sell, all items"; it was 26.00). 1.5 x $100 + 28.54 = 178.54; 2 x $100 + 28.54 = 228.54.
    expect(line).toContain("cost $20.00 → $20.00 (+$0.00)");
    expect(line).toContain("sell normal $128.54 → $128.54");
    expect(line).toContain("sell difficult $178.54 → $228.54");
    expect(line).toContain("hours difficult 1.5 → 2");
    expect(line).not.toContain("hours normal");
    await cleanCards();
  });

  it("a cost change shows all three sell tiers of the assembly moving", async () => {
    const r = await propose(inv, part, { material_cost: 12 });
    const card = (await cardsFor(pin)).cards.find((c) => c.id === r.body.proposal_id)!;
    const line = (card.effectLines as string[]).find((l) => l.startsWith(`Moves assembly ${asm}`))!;
    // cost 20 -> 24 (pre-tax) is 28.54 -> 34.24 marked up WITH the 9.75% tax in (Kyle 2026-11-24 "Tax in sell, all items"; 26.00 -> 31.20 before):
    // normal 1 h = 128.54 -> 134.24, difficult 1.5 h = 178.54 -> 184.24, very difficult 2 h = 228.54 -> 234.24.
    expect(line).toContain("sell normal $128.54 → $134.24");
    expect(line).toContain("sell difficult $178.54 → $184.24");
    expect(line).toContain("sell very difficult $228.54 → $234.24");
    expect(line).not.toContain("hours ");
    await cleanCards();
  });

  it("Approve (Kyle) applies it through the book's own path: item, sell prices and the assembly cascade, with the edit rows naming the agent; Edit-and-approve is refused", async () => {
    const r = await propose(inv, part, { material_cost: 12, hours: { normal: 0.6 }, name: `${TAG} Prop Part v2` });
    const edit = await request(app).post(`/hub/messages/${r.body.proposal_id}/edit-approve`).set(bearer(pin)).send({ body: "my words" });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toContain("cannot be edited");

    const ok = await request(app).post(`/hub/messages/${r.body.proposal_id}/approve`).set(bearer(pin));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.send).toEqual({ status: "posted", error: null });
    expect(ok.body.card.outcome.text).toBe("Price book changed by Kyle");
    const part2 = await item(part);
    // 12 x 1.0975 = 13.17 with tax; x 1.30 = 17.12 (Kyle 2026-11-24 "Tax in sell, all items"; 15.60 before); 0.6 x 100 + 17.12 = 77.12
    expect(part2).toMatchObject({ description: `${TAG} Prop Part v2`, companyCost: 12, companyCostWithTax: 13.17, companyPrice: 17.12, laborNormal: 0.6, sellNormal: 77.12 });
    const asm2 = await item(asm);
    expect(asm2.companyCost).toBe(24);
    expect(asm2.laborNormal).toBeCloseTo(1.2, 6); // 0.6 x 2
    const edits = await prisma.priceBookEdit.findMany({ where: { itemId: part, field: "companyCost", editedBy: `agent:${inv.name}` } });
    expect(edits.some((e) => e.oldValue === "10" && e.newValue === "12")).toBe(true);
    const approved = await prisma.priceBookEdit.findFirstOrThrow({ where: { itemId: part, field: "priceChangeApproved" } });
    expect(approved.note).toContain("Approved by Kyle");
    expect(approved.note).toContain(inv.name);
    const cascade = await prisma.priceBookEdit.findFirstOrThrow({ where: { itemId: asm, field: "companyCost", newValue: "24" } });
    expect(cascade.editedBy).toBe(`agent:${inv.name}`);
    expect(await prisma.hubAuditLog.count({ where: { messageId: r.body.proposal_id, action: "price_change_applied" } })).toBe(1);
    // Decided once.
    expect((await request(app).post(`/hub/messages/${r.body.proposal_id}/approve`).set(bearer(pin))).status).toBe(409);
    // Put the fixture back for the tests below.
    await prisma.priceBookAtomic.update({ where: { itemId: part }, data: { companyCost: 10, companyCostWithTax: 10.98, companyPrice: 14.27, laborNormal: 0.5, sellNormal: 64.27, description: `${TAG} Prop Part` } });
    await prisma.priceBookAtomic.update({ where: { itemId: asm }, data: { companyCost: 20, laborNormal: 1 } });
    await cleanCards();
  });

  it("Reject closes it with the reason and changes nothing", async () => {
    const r = await propose(inv, part, { material_cost: 99 });
    const bad = await request(app).post(`/hub/messages/${r.body.proposal_id}/reject`).set(bearer(pin)).send({ reason: "x" });
    expect(bad.status).toBe(400);
    const rej = await request(app).post(`/hub/messages/${r.body.proposal_id}/reject`).set(bearer(pin)).send({ reason: "Too high for that part" });
    expect(rej.status).toBe(200);
    expect(rej.body.card).toMatchObject({ status: "rejected" });
    expect((await item(part)).companyCost).toBe(10);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: r.body.proposal_id } })).rejectedReason).toBe("Too high for that part");
    // The item's own history ends the proposal it began: who turned it down, why, and that the book was not changed (review 2026-11-25).
    const row = await prisma.priceBookEdit.findFirstOrThrow({ where: { itemId: part, field: "priceChangeRejected" } });
    expect(row.editedBy).toBe(`agent:${inv.name}`);
    expect(row.newValue).toBe("companyCost");
    expect(row.note).toContain("Rejected by Kyle: Too high for that part");
    expect(row.note).toContain(r.body.proposal_id);
    expect(row.note).toContain("not changed");
    expect(await prisma.priceBookEdit.count({ where: { itemId: part, field: "companyCost", newValue: "99" } })).toBe(0);
    // The proposal row no longer claims the change is still waiting.
    const proposed = await prisma.priceBookEdit.findFirstOrThrow({ where: { itemId: part, field: "proposed:companyCost", newValue: "99" } });
    expect(proposed.note).not.toContain("waiting");
    await cleanCards();
  });

  it("an approver WITHOUT price_book_edit sees Approve greyed with that power's sentence and is refused 403; Michael with the power approves", async () => {
    const r = await propose(inv, part, { material_cost: 12 });
    const plain = await makeApprover(["approve_drafts"]);
    const list = await cardsFor(plain.token);
    expect(list.canApprove).toBe(true);
    const card = list.cards.find((c) => c.id === r.body.proposal_id)!;
    expect(card.approve.blockedReason).toBe(CRM_POWERS.price_book_edit.reason);
    expect(card.approve.editBlockedReason).toBe(CRM_POWERS.price_book_edit.reason);
    // Reject is greyed too (it was open to anyone with approve_drafts before): someone who may not approve a price change may not close it either.
    expect(card.approve.rejectBlockedReason).toBe(CRM_POWERS.price_book_edit.reason);
    const refused = await request(app).post(`/hub/messages/${r.body.proposal_id}/approve`).set(bearer(plain.token));
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe(CRM_POWERS.price_book_edit.reason);
    const refusedReject = await request(app).post(`/hub/messages/${r.body.proposal_id}/reject`).set(bearer(plain.token)).send({ reason: "not mine to close" });
    expect(refusedReject.status).toBe(403);
    expect(refusedReject.body.error).toBe(CRM_POWERS.price_book_edit.reason);
    expect((await item(part)).companyCost).toBe(10);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: r.body.proposal_id } })).status).toBe("pending_approval");
    expect(await prisma.priceBookEdit.count({ where: { itemId: part, field: "priceChangeRejected", note: { contains: r.body.proposal_id } } })).toBe(0);

    const michael = await makeApprover(["approve_drafts", "price_book_edit"]);
    const shown = (await cardsFor(michael.token)).cards.find((c) => c.id === r.body.proposal_id)!;
    expect(shown.approve.blockedReason).toBeNull();
    const ok = await request(app).post(`/hub/messages/${r.body.proposal_id}/approve`).set(bearer(michael.token));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await item(part)).companyCost).toBe(12);
    await prisma.priceBookAtomic.update({ where: { itemId: part }, data: { companyCost: 10, companyCostWithTax: 10.98, companyPrice: 14.27, sellNormal: 64.27 } });
    await prisma.priceBookAtomic.update({ where: { itemId: asm }, data: { companyCost: 20 } });
    await cleanCards();
  });

  it("the field app: a technician whose login holds both powers sees and approves the card; one with approve_drafts only is refused", async () => {
    const r = await propose(inv, part, { material_cost: 12 });
    const person = await makePerson(`${TAG} Field ${randomUUID().slice(0, 5)}`);
    const tech = await prisma.technician.findUniqueOrThrow({ where: { id: person.id } });
    const login = await saveCrmLogin(person.id, { username: `fld_${randomUUID().slice(0, 8)}`, role: "owner", password: PASS });
    await setPowers(login.id, ["approve_drafts"]);
    const fieldGet = () => request(app).get("/health-record/hub/approvals").set(bearer(tech.accessToken));
    const listed = (await fieldGet()).body.data as { cards: Array<Record<string, any>> };
    const card = listed.cards.find((c) => c.id === r.body.proposal_id)!;
    expect(card.approve.blockedReason).toBe(CRM_POWERS.price_book_edit.reason);
    const refused = await request(app).post(`/health-record/hub/messages/${r.body.proposal_id}/approve`).set(bearer(tech.accessToken));
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe(CRM_POWERS.price_book_edit.reason);

    await setPowers(login.id, ["approve_drafts", "price_book_edit"]);
    const ok = await request(app).post(`/health-record/hub/messages/${r.body.proposal_id}/approve`).set(bearer(tech.accessToken));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.card.outcome.text).toContain("Price book changed by");
    expect((await item(part)).companyCost).toBe(12);
    await prisma.priceBookAtomic.update({ where: { itemId: part }, data: { companyCost: 10, companyCostWithTax: 10.98, companyPrice: 14.27, sellNormal: 64.27 } });
    await prisma.priceBookAtomic.update({ where: { itemId: asm }, data: { companyCost: 20 } });
    await cleanCards();
  });

  it("a card whose item was retired meanwhile cannot be applied: the card says why and Reject is still there", async () => {
    const x = await create(inv, { name: `${TAG} Prop Doomed`, category: `${TAG} Prop Cat`, type: "material", material_cost: 5 });
    const r = await propose(inv, x.body.item_id, { material_cost: 6 });
    await prisma.priceBookAtomic.update({ where: { itemId: x.body.item_id }, data: { retiredAt: new Date() } });
    const card = (await cardsFor(pin)).cards.find((c) => c.id === r.body.proposal_id)!;
    expect(card.approve.blockedReason).toContain("retired");
    const ok = await request(app).post(`/hub/messages/${r.body.proposal_id}/approve`).set(bearer(pin));
    expect(ok.status).toBe(200);
    expect(ok.body.send.status).toBe("failed");
    expect(ok.body.send.error).toContain("retired");
    expect((await item(x.body.item_id)).companyCost).toBe(5);
    // A price change that could not be applied is not "could not be sent": nothing was sent, and the retry button says what it does.
    expect(ok.body.card.outcome.text).toBe(`Price book not changed: ${ok.body.send.error}`);
    expect(cardLocks(ok.body.card, true, null).approveLabel).toBe("Try the change again");
    expect(approvingLabel(ok.body.card)).toBe("Applying…");
    const failedRow = await prisma.priceBookEdit.findFirstOrThrow({ where: { itemId: x.body.item_id, field: "priceChangeFailed" } });
    expect(failedRow.editedBy).toBe(`agent:${inv.name}`);
    expect(failedRow.note).toContain("retired");
    expect(failedRow.note).toContain("Approved by Kyle");
    const rej = await request(app).post(`/hub/messages/${r.body.proposal_id}/reject`).set(bearer(pin)).send({ reason: "item retired" });
    expect(rej.status).toBe(200);
    expect(await prisma.priceBookEdit.count({ where: { itemId: x.body.item_id, field: "priceChangeRejected" } })).toBe(1);
    await cleanCards();
  });

  // Kyle 2026-11-25, "Yes, same power": price_book_edit approves proposals and edits prices. It replaces approve_drafts for THIS kind and for no other.
  it("a login holding price_book_edit ALONE sees, approves and rejects price-book proposals in the CRM, and still gets 403 on a customer draft", async () => {
    const onlyPrice = await makeApprover(["price_book_edit"]);
    const r1 = await propose(inv, part, { material_cost: 12 });
    const r2 = await propose(inv, part, { material_cost: 13 });
    // A customer draft is waiting in Messages too: this login never sees it and cannot decide it.
    const customer = await prisma.customer.create({ data: { name: `${TAG} Jane`, phone: "6155550101", email: `jane@agentpb.example` } });
    const thread = await ensureThreadFor({ customerId: customer.id });
    const AI: HubReader = { key: "ai-admin", kind: "ai-admin", display: "RCE Admin", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false };
    const draft = (await waitingDraft(AI, { threadId: thread.id, channel: "email", category: "thread_reply", subject: "Tuesday", body: "We can be there Tuesday." })).message;
    try {
      const list = await cardsFor(onlyPrice.token);
      expect(list.canApprove).toBe(true);
      const ids = list.cards.map((c) => c.id);
      expect(ids).toEqual(expect.arrayContaining([r1.body.proposal_id, r2.body.proposal_id]));
      expect(ids).not.toContain(draft.id);
      const shown = list.cards.find((c) => c.id === r1.body.proposal_id)!;
      expect(shown.approve).toMatchObject({ blockedReason: null, editBlockedReason: expect.stringContaining("cannot be edited"), rejectBlockedReason: null });

      for (const route of ["approve", "reject"] as const) {
        const refused = await request(app).post(`/hub/messages/${draft.id}/${route}`).set(bearer(onlyPrice.token)).send({ reason: "not mine" });
        expect(refused.status, route).toBe(403);
        expect(refused.body.error, route).toBe(CRM_POWERS.approve_drafts.reason);
      }
      expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("pending_approval");

      const ok = await request(app).post(`/hub/messages/${r1.body.proposal_id}/approve`).set(bearer(onlyPrice.token));
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await item(part)).companyCost).toBe(12);
      const rej = await request(app).post(`/hub/messages/${r2.body.proposal_id}/reject`).set(bearer(onlyPrice.token)).send({ reason: "too high" });
      expect(rej.status, JSON.stringify(rej.body)).toBe(200);
      expect((await item(part)).companyCost).toBe(12);
    } finally {
      await prisma.hubThread.deleteMany({ where: { customerId: customer.id } });
      await prisma.customer.deleteMany({ where: { id: customer.id } });
      await prisma.priceBookAtomic.update({ where: { itemId: part }, data: { companyCost: 10, companyCostWithTax: 10.98, companyPrice: 14.27, sellNormal: 64.27 } });
      await prisma.priceBookAtomic.update({ where: { itemId: asm }, data: { companyCost: 20 } });
      await cleanCards();
    }
  });

  it("the field app: price_book_edit alone approves and rejects proposals too; without it (approve_drafts only) Reject is refused as well", async () => {
    const person = await makePerson(`${TAG} Only ${randomUUID().slice(0, 5)}`);
    const tech = await prisma.technician.findUniqueOrThrow({ where: { id: person.id } });
    const login = await saveCrmLogin(person.id, { username: `onl_${randomUUID().slice(0, 8)}`, role: "owner", password: PASS });
    await setPowers(login.id, ["price_book_edit"]);
    const r1 = await propose(inv, part, { material_cost: 12 });
    const r2 = await propose(inv, part, { material_cost: 13 });
    const listed = (await request(app).get("/health-record/hub/approvals").set(bearer(tech.accessToken))).body.data as { canApprove: boolean; cards: Array<Record<string, any>> };
    expect(listed.canApprove).toBe(true);
    expect(listed.cards.map((c) => c.id).sort()).toEqual([r1.body.proposal_id, r2.body.proposal_id].sort());
    expect(listed.cards[0]!.approve).toMatchObject({ blockedReason: null, rejectBlockedReason: null });
    const ok = await request(app).post(`/health-record/hub/messages/${r1.body.proposal_id}/approve`).set(bearer(tech.accessToken));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await item(part)).companyCost).toBe(12);
    const rej = await request(app).post(`/health-record/hub/messages/${r2.body.proposal_id}/reject`).set(bearer(tech.accessToken)).send({ reason: "too high" });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);

    // approve_drafts alone: the card is listed, greyed on Approve AND Reject, and both are refused.
    const r3 = await propose(inv, part, { material_cost: 14 });
    await setPowers(login.id, ["approve_drafts"]);
    const greyed = ((await request(app).get("/health-record/hub/approvals").set(bearer(tech.accessToken))).body.data as { cards: Array<Record<string, any>> }).cards.find((c) => c.id === r3.body.proposal_id)!;
    expect(greyed.approve.rejectBlockedReason).toBe(CRM_POWERS.price_book_edit.reason);
    const refused = await request(app).post(`/health-record/hub/messages/${r3.body.proposal_id}/reject`).set(bearer(tech.accessToken)).send({ reason: "not mine" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe(CRM_POWERS.price_book_edit.reason);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: r3.body.proposal_id } })).status).toBe("pending_approval");
    await prisma.priceBookAtomic.update({ where: { itemId: part }, data: { companyCost: 10, companyCostWithTax: 10.98, companyPrice: 14.27, sellNormal: 64.27 } });
    await prisma.priceBookAtomic.update({ where: { itemId: asm }, data: { companyCost: 20 } });
    await cleanCards();
  });

  // Review 2026-11-25: "Labour source" is the agent's NECA reference for the hours IT typed. Once the hours are changed, it no longer applies.
  it("changing the hours clears the agent's NECA reference (\"Labour source\"), recorded in the item's history; a cost-only change keeps it", async () => {
    const made = await create(inv, { name: `${TAG} Sourced`, category: `${TAG} Prop Cat`, type: "material", material_cost: 4, hours: { normal: 0.5 }, neca_reference: "NECA 2019 p.179 row 3" });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.item_id as string;
    expect(laborSourceText((await item(id)).laborUnitBasisRaw)).toBe("NECA 2019 p.179 row 3");

    // A cost-only approval keeps the reference: the hours were not touched.
    const c = await propose(inv, id, { material_cost: 5 });
    expect((await request(app).post(`/hub/messages/${c.body.proposal_id}/approve`).set(bearer(pin))).status).toBe(200);
    expect(laborSourceText((await item(id)).laborUnitBasisRaw)).toBe("NECA 2019 p.179 row 3");

    // An approved hours change replaces it with the plain in-app text.
    const h = await propose(inv, id, { hours: { normal: 0.8 } });
    expect((await request(app).post(`/hub/messages/${h.body.proposal_id}/approve`).set(bearer(pin))).status).toBe(200);
    const after = await item(id);
    expect(after.laborNormal).toBe(0.8);
    expect(after.laborUnitBasisRaw).toBe(IN_APP_LABOR_BASIS_RAW);
    expect(laborSourceText(after.laborUnitBasisRaw)).toBeNull();
    const row = await prisma.priceBookEdit.findFirstOrThrow({ where: { itemId: id, field: "laborUnitBasisRaw" } });
    expect(row.oldValue).toContain("NECA 2019 p.179 row 3");
    expect(row.newValue).toBe(IN_APP_LABOR_BASIS_RAW);

    // The CRM's own editor goes through the same planner: typing new hours there clears a reference the same way.
    const second = await create(inv, { name: `${TAG} Sourced Two`, category: `${TAG} Prop Cat`, type: "labor", hours: 1, neca_reference: "NECA table 9" });
    const edited = await catalog.updateAtomic(prisma, second.body.item_id, { laborNormal: 2 }, "human:crm-session");
    expect(edited.ok).toBe(true);
    expect(laborSourceText((await item(second.body.item_id)).laborUnitBasisRaw)).toBeNull();
    await cleanCards();
  });

  it("a retry with the same key returns the first card (200) and makes no second; the same values proposed again under a new key still make one more card", async () => {
    const key = idem();
    const first = await rest.post(inv, `/items/${part}/proposals`, { idempotency_key: key, material_cost: 14 });
    const again = await rest.post(inv, `/items/${part}/proposals`, { idempotency_key: key, material_cost: 14 });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.proposal_id).toBe(first.body.proposal_id);
    expect(await prisma.hubMessage.count({ where: { threadId: PRICE_BOOK_THREAD_ID, actionKind: "price_change" } })).toBe(1);
    await cleanCards();
  });

  it.each([
    ["nothing to change", { }, "Say what to change"],
    ["the value it already holds", { material_cost: 10 }, "already holds"],
    ["a negative cost", { material_cost: -1 }, "negative"],
    ["hours over 100", { hours: { normal: 500 } }, "100"],
    ["zero hours", { hours: 0 }, "more than 0"],
    ["a field that is not a price, hours or name", { category: "Elsewhere" }, "Unknown field"],
  ])("refuses a proposal for %s", async (_label, body, reasonHas) => {
    const r = await propose(inv, part, body);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.reason).toContain(reasonHas);
    expect(await prisma.hubMessage.count({ where: { threadId: PRICE_BOOK_THREAD_ID, actionKind: "price_change" } })).toBe(0);
  });

  it("an assembly's cost and hours cannot be proposed (they roll up); labor items have no cost; material-only items have no hours; unknown and retired items are refused", async () => {
    expect((await propose(inv, asm, { material_cost: 5 })).body.reason).toContain("assembly");
    expect((await propose(inv, asm, { name: `${TAG} Prop Assembly Renamed` })).status).toBe(201);
    const lab = await create(inv, { name: `${TAG} Prop Labor`, category: `${TAG} Prop Cat`, type: "labor", hours: 1 });
    expect((await propose(inv, lab.body.item_id, { material_cost: 5 })).body.reason).toContain("no material");
    const mat = await create(inv, { name: `${TAG} Prop MatOnly`, category: `${TAG} Prop Cat`, type: "material", material_cost: 5 });
    expect((await propose(inv, mat.body.item_id, { hours: 1 })).body.reason).toContain("no hours");
    expect((await propose(inv, "NOPE-404", { material_cost: 5 })).status).toBe(404);
    await prisma.priceBookAtomic.update({ where: { itemId: mat.body.item_id }, data: { retiredAt: new Date() } });
    expect((await propose(inv, mat.body.item_id, { material_cost: 6 })).body.reason).toContain("retired");
    await cleanCards();
  });

  it("an item stored PER 100 takes a proposed per-unit hour as a per-100 value, and the card shows it per unit", async () => {
    const row = await prisma.priceBookAtomic.create({
      data: {
        itemId: `ZPB${Math.floor(Math.random() * 90000 + 10000)}`, description: `${TAG} Per Hundred Prop`, category: `${TAG} Prop Cat`, rowType: "MATERIAL + LABOR", source: "test-fixture",
        laborNormal: 12, laborDifficult: 18, laborVeryDifficult: 24, laborUnitBasis: "C", laborUnitDivisor: 100, companyCost: 1,
      },
    });
    const r = await propose(inv, row.itemId, { hours: { normal: 0.15 } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.changes).toEqual([{ field: "hours_normal", before: 0.12, after: 0.15 }]);
    const stored = JSON.parse((await prisma.hubMessage.findUniqueOrThrow({ where: { id: r.body.proposal_id } })).actionPayloadJson!);
    expect(stored.proposed.laborNormal).toBe(15);
    await cleanCards();
  });
});

// ── no delete, retire, archive or direct edit ─────────────────────────────────────────────────────

describe("an agent can never delete, retire, archive or edit an existing item", () => {
  it("the agent door lists no such route; the CRM's own delete, retire and edit routes refuse an agent key (401); /mcp has no such tool", async () => {
    for (const r of AGENT_KEY_ROUTES.filter((e) => e.path.startsWith("/agent/price-book"))) {
      expect(r.methods.every((m) => m === "GET" || m === "POST"), r.path).toBe(true);
      expect(r.path).not.toMatch(/retire|delete|archive|restore|remove/);
    }
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(names.filter((n) => /price_book/.test(n)).sort()).toEqual([
      "create_price_book_item", "get_price_book_item", "list_price_book_categories", "propose_price_book_change", "search_price_book",
    ]);
    expect(names.filter((n) => /delete|retire|archive|remove|update|edit/.test(n))).toEqual([]);

    const inv = await keyFor("inventory");
    const made = await create(inv, { name: `${TAG} Untouchable`, category: `${TAG} Safe Cat`, type: "material", material_cost: 2 });
    const id = made.body.item_id as string;
    const attempts = [
      request(app).delete(`/api/agent/price-book/items/${id}`),
      request(app).patch(`/api/agent/price-book/items/${id}`).send({ material_cost: 1 }),
      request(app).put(`/api/agent/price-book/items/${id}`).send({ material_cost: 1 }),
      request(app).post(`/api/agent/price-book/items/${id}/retire`).send({}),
      request(app).post(`/price-book/catalog/items/${id}/retire`).send({}),
      request(app).post(`/price-book/catalog/items/${id}/restore`).send({}),
      request(app).patch(`/price-book/catalog/items/${id}`).send({ companyCost: 1 }),
      request(app).post("/price-book/catalog/items").send({ description: `${TAG} via crm`, category: "X", rowType: "MATERIAL ONLY" }),
      request(app).put(`/price-book/catalog/assemblies/${id}/components`).send({ components: [] }),
      request(app).post("/price-book/refresh/accept").send({ itemId: id, supplierName: "x" }),
    ];
    for (const a of attempts) {
      const res = await a.set(bearer(inv.secret));
      expect(res.status, `${res.request.method} ${res.request.url}`).toBe(401);
    }
    const row = await prisma.priceBookAtomic.findUniqueOrThrow({ where: { itemId: id } });
    expect(row.retiredAt).toBeNull();
    expect(row.companyCost).toBe(2);
  });
});

// ── MCP ───────────────────────────────────────────────────────────────────────────────────────────

describe("the five /mcp tools", () => {
  it("tools/list shows the read tools to a reader and all five to a key with pricebook:write", async () => {
    const reader = await keyFor("research");
    const inv = await keyFor("inventory");
    const none = await keyFor("other", { scopes: ["team:read"] });
    const namesOf = async (k: Made) => ((await rpc(k.secret, "tools/list", {})).body.result.tools as Array<{ name: string }>).map((t) => t.name).filter((n) => /price_book/.test(n)).sort();
    expect(await namesOf(reader)).toEqual(["get_price_book_item", "list_price_book_categories", "search_price_book"]);
    expect(await namesOf(inv)).toEqual(["create_price_book_item", "get_price_book_item", "list_price_book_categories", "propose_price_book_change", "search_price_book"]);
    expect(await namesOf(none)).toEqual([]);
    const tools = ((await rpc(inv.secret, "tools/list", {})).body.result.tools as Array<{ name: string; description: string }>);
    for (const n of ["create_price_book_item", "propose_price_book_change"]) {
      const d = tools.find((t) => t.name === n)!.description;
      expect(d, n).toContain("PRE-TAX");
      expect(d, n).toContain("NECA");
    }
  });

  it("each tool answers what REST answers, writes are audited as door mcp, and a tool refuses a key without its scope", async () => {
    const inv = await keyFor("inventory");
    const reader = await keyFor("research");
    const made = await tool(inv.secret, "create_price_book_item", {
      idempotency_key: idem(), unit: "each", name: `${TAG} Mcp Item`, category: `${TAG} Mcp Cat`, type: "material", material_cost: 10, hours: 0.5,
    });
    expect(made.isError).toBe(false);
    expect(made.body).toMatchObject({ type: "material", cost: 10, cost_with_tax: 10.98, sell: { normal: 64.27 } }); // Kyle 2026-11-24 "Tax in sell, all items" (63 before)
    const id = made.body.item_id as string;
    const viaRest = await rest.get(reader, `/items/${id}`);
    expect((await tool(reader.secret, "get_price_book_item", { item_id: id })).body).toEqual(viaRest.body);
    expect((await tool(reader.secret, "search_price_book", { search: `${TAG} Mcp Item` })).body.items).toHaveLength(1);
    expect((await tool(reader.secret, "list_price_book_categories")).body.categories.some((c: { name: string }) => c.name === `${TAG} Mcp Cat`)).toBe(true);

    const prop = await tool(inv.secret, "propose_price_book_change", { idempotency_key: idem(), item_id: id, material_cost: 11 });
    expect(prop.isError).toBe(false);
    expect(prop.body).toMatchObject({ item_id: id, status: "pending_approval" });
    const audit = await prisma.agentAuditLog.findMany({ where: { agentKeyId: inv.id, action: { in: ["create_price_book_item", "propose_price_book_change"] } } });
    expect(audit.map((a) => [a.action, a.door, a.responseStatus, a.scopeUsed]).sort()).toEqual([
      ["create_price_book_item", "mcp", 201, "pricebook:write"], ["propose_price_book_change", "mcp", 201, "pricebook:write"],
    ]);

    const refused = await tool(reader.secret, "create_price_book_item", { idempotency_key: idem(), unit: "each", name: `${TAG} Mcp Nope`, category: "c", type: "labor", hours: 1 });
    expect(refused.isError).toBe(true);
    expect(refused.body.code).toBe("scope_denied");
    const dup = await tool(inv.secret, "create_price_book_item", { idempotency_key: idem(), unit: "each", name: `${TAG} Mcp Item`, category: `${TAG} Mcp Cat`, type: "material", material_cost: 1 });
    expect(dup.isError).toBe(true);
    expect(dup.body).toMatchObject({ code: "duplicate_item", existing_item: { item_id: id } });
    // Writes switch and kill switch are checked inside the tool.
    const noWrites = await keyFor("inventory", { writesEnabled: false });
    expect((await tool(noWrites.secret, "create_price_book_item", { idempotency_key: idem(), unit: "each", name: `${TAG} Mcp W`, category: "c", type: "labor", hours: 1 })).body.code).toBe("writes_disabled");
    await setMode("read_only");
    expect((await tool(inv.secret, "propose_price_book_change", { idempotency_key: idem(), item_id: id, material_cost: 12 })).body.code).toBe("agents_read_only");
    await setMode("on");
    await cleanCards();
  });
});

// ── the audit and the events ──────────────────────────────────────────────────────────────────────

interface Received { headers: http.IncomingHttpHeaders; body: string }
async function startReceiver() {
  const requests: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { requests.push({ headers: req.headers, body }); res.statusCode = 200; res.end("ok"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error("timed out waiting");
};

describe("events pricebook.item_created and pricebook.change_proposed", () => {
  it("go to every OTHER live key that holds pricebook:read, never the author, with ids, words and numbers only; a replay and a refusal emit nothing", async () => {
    const author = await keyFor("inventory");
    await keyFor("admin");
    await keyFor("research");
    await keyFor("other", { scopes: ["team:read"] }); // no pricebook:read: hears nothing
    const noRead = await keyFor("cfo", { scopes: ["team:read", "finance:read"] });
    const key = idem();
    const body = { name: `${TAG} Event Item`, category: `${TAG} Event Cat`, type: "material", material_cost: 10, hours: 0.5 };
    const made = await rest.post(author, "/items", { idempotency_key: key, unit: "each", ...body });
    expect(made.status).toBe(201);
    const id = made.body.item_id as string;
    const rows = async () => prisma.hubEvent.findMany({ where: { eventKey: `pricebook.item_created:${id}` } });
    await waitFor(async () => (await rows()).length > 0);
    const created = await rows();
    const targets = created.map((e) => e.target).sort();
    // Every role with a live pricebook:read key that has a webhook target, minus the author's role: admin and research (and other keys left by earlier files).
    expect(targets).toEqual(expect.arrayContaining(["admin", "research"]));
    expect(targets).not.toContain("inventory");
    expect(targets).not.toContain("other");
    expect(created.every((e) => e.type === "pricebook.item_created")).toBe(true);
    void noRead;
    const payload = JSON.parse(created[0]!.payloadJson);
    expect(payload).toMatchObject({
      type: "pricebook.item_created", item_id: id, item_type: "material", name: `${TAG} Event Item`, category: `${TAG} Event Cat`, unit: "each", cost: 10,
      cost_with_tax: 10.98, sell: { normal: 64.27, difficult: null, very_difficult: null }, summary: "Price book item added", // Kyle 2026-11-24 "Tax in sell, all items" (63 before)
    });
    expect(Object.keys(payload).sort()).toEqual(["category", "cost", "cost_with_tax", "event_id", "item_id", "item_type", "name", "occurred_at", "sell", "summary", "type", "unit"].sort() /* unit: Kyle 2026-11-25 */);
    expect(payload.type).toBe("pricebook.item_created");
    expect(created.map((e) => e.eventKey)).toEqual(created.map(() => `pricebook.item_created:${id}`));

    // A replay of the same request: no new event. A refused one (duplicate): none either.
    await rest.post(author, "/items", { idempotency_key: key, unit: "each", ...body });
    await rest.post(author, "/items", { idempotency_key: idem(), unit: "each", ...body });
    await new Promise((r) => setTimeout(r, 150));
    expect((await rows()).length).toBe(created.length);

    // A proposal: before and after, the proposal id, the key's name - and still never the author.
    const prop = await propose(author, id, { material_cost: 12, hours: { normal: 0.6 } });
    expect(prop.status).toBe(201);
    const proposalRows = async () => prisma.hubEvent.findMany({ where: { eventKey: `pricebook.change_proposed:${prop.body.proposal_id}` } });
    await waitFor(async () => (await proposalRows()).length > 0);
    const proposed = await proposalRows();
    expect(proposed.map((e) => e.target)).not.toContain("inventory");
    const p = JSON.parse(proposed[0]!.payloadJson);
    expect(p).toMatchObject({
      type: "pricebook.change_proposed", proposal_id: prop.body.proposal_id, item_id: id, proposed_by: author.name,
      before: { cost: 10, hours_normal: 0.5 }, after: { cost: 12, hours_normal: 0.6 }, summary: "Price book change proposed",
    });
    await cleanCards();
  });

  it("is delivered signed like every event (the receiver verifies the HMAC from the body alone)", async () => {
    const receiver = await startReceiver();
    process.env.HUB_AGENT_WEBHOOK_URL = receiver.url;
    process.env.HUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    try {
      const author = await keyFor("inventory");
      await keyFor("admin");
      const made = await create(author, { name: `${TAG} Signed Item`, category: `${TAG} Event Cat`, type: "labor", hours: 1 });
      expect(made.status).toBe(201);
      await waitFor(() => receiver.requests.some((r) => r.body.includes("pricebook.item_created") && r.body.includes(made.body.item_id)));
      const hit = receiver.requests.find((r) => r.body.includes(made.body.item_id))!;
      const wire = splitWireBody(hit.body);
      expect(wire).not.toBeNull();
      const expected = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(`${wire!.timestamp}.${wire!.payloadJson}`).digest("hex")}`;
      expect(wire!.signature).toBe(expected);
      expect(hit.headers["x-rce-signature"]).toBe(expected);
      expect(hit.headers["x-rce-timestamp"]).toBe(wire!.timestamp);
      expect(JSON.parse(wire!.payloadJson)).toMatchObject({ type: "pricebook.item_created", item_id: made.body.item_id });
    } finally {
      delete process.env.HUB_AGENT_WEBHOOK_URL;
      delete process.env.HUB_WEBHOOK_SECRET;
      await receiver.close();
    }
  });
});

describe("unit: required on create, stored as the item's unit label (Kyle 2026-11-25: \"yes they should add the specific unit\")", () => {
  let inv: Made;
  beforeAll(async () => { inv = await keyFor("inventory"); });
  const noUnit = (extra: Record<string, unknown>) => rest.post(inv, "/items", { idempotency_key: idem(), ...extra });

  it("REST: a missing, blank, non-text, too long or control-character unit is a 400 that names the field and gives examples, and nothing is made", async () => {
    const base = { category: `${TAG} Unit Cat`, type: "material", material_cost: 1 };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["missing", {}], ["blank", { unit: "   " }], ["a number", { unit: 5 }], ["25 characters", { unit: "x".repeat(25) }], ["a control character", { unit: "ea\u0007ch" }],
    ];
    for (const [label, extra] of cases) {
      const name = `${TAG} Unit Refused ${label}`;
      const r = await noUnit({ name, ...base, ...extra });
      expect(r.status, label).toBe(400);
      expect(r.body.code, label).toBe("bad_request");
      expect(r.body.reason, label).toContain("unit");
      expect(r.body.reason, label).toContain('"each"');
      expect(r.body.reason, label).toContain('"ft"');
      expect(r.body.reason, label).toContain("box of 25");
      expect(r.body.reason, label).toContain("PER THAT UNIT");
      expect(await prisma.priceBookAtomic.count({ where: { description: name } }), label).toBe(0);
    }
    // 24 characters is the longest that is accepted, and the value is trimmed.
    const ok = await noUnit({ name: `${TAG} Unit Edge`, ...base, unit: `  ${"y".repeat(24)}  ` });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.unit).toBe("y".repeat(24));
  });

  it("MCP: the same refusal, with the same reason, for every item type", async () => {
    for (const body of [
      { name: `${TAG} Mcp Unit Labor`, category: `${TAG} Unit Cat`, type: "labor", hours: 1 },
      { name: `${TAG} Mcp Unit Material`, category: `${TAG} Unit Cat`, type: "material", material_cost: 1 },
      { name: `${TAG} Mcp Unit Assembly`, category: `${TAG} Unit Cat`, type: "assembly", components: [{ item_id: "X001", quantity: 1 }] },
    ]) {
      const r = await tool(inv.secret, "create_price_book_item", { idempotency_key: idem(), ...body });
      expect(r.isError, body.name).toBe(true);
      expect(r.body.code, body.name).toBe("bad_request");
      expect(r.body.reason, body.name).toContain("unit");
      expect(r.body.reason, body.name).toContain("box of 25");
      expect(await prisma.priceBookAtomic.count({ where: { description: body.name } }), body.name).toBe(0);
    }
    // The tool's own listing says it is required and what it means.
    const tools = (await rpc(inv.secret, "tools/list")).body.result.tools as Array<{ name: string; description: string; inputSchema: { required?: string[] } }>;
    const t = tools.find((x) => x.name === "create_price_book_item")!;
    expect(t.inputSchema.required).toContain("unit");
    expect(t.description).toContain("PER THAT UNIT");
    expect(t.description).toContain("per foot");
    expect(t.description).toContain("linear feet");
  });

  it("is stored as unitLabel for labor, material and assembly, and every read (one item, search, the create answer) returns it as unit", async () => {
    const labor = await create(inv, { name: `${TAG} Unit Labor`, category: `${TAG} Unit Cat`, type: "labor", hours: 1, unit: "visit" });
    const mat = await create(inv, { name: `${TAG} Unit Box`, category: `${TAG} Unit Cat`, type: "material", material_cost: 4, unit: "box of 25" });
    const asm = await create(inv, { name: `${TAG} Unit Asm`, category: `${TAG} Unit Cat`, type: "assembly", components: [{ item_id: mat.body.item_id, quantity: 2 }], unit: "kit" });
    for (const [r, unit] of [[labor, "visit"], [mat, "box of 25"], [asm, "kit"]] as const) {
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.unit).toBe(unit);
      const row = await prisma.priceBookAtomic.findUniqueOrThrow({ where: { itemId: r.body.item_id } });
      expect(row.unitLabel).toBe(unit);
      expect((await rest.get(inv, `/items/${r.body.item_id}`)).body.unit).toBe(unit);
      expect((await tool(inv.secret, "get_price_book_item", { item_id: r.body.item_id })).body.unit).toBe(unit);
    }
    const found = await rest.get(inv, `/items?search=${encodeURIComponent(`${TAG} Unit Box`)}`);
    expect(found.body.items.map((i: { unit: string }) => i.unit)).toEqual(["box of 25"]);
    expect((await tool(inv.secret, "search_price_book", { search: `${TAG} Unit Box` })).body.items[0].unit).toBe("box of 25");
    // The Messages audit log carries the unit in the details of the "item added" row.
    const hub = await prisma.hubAuditLog.findFirstOrThrow({ where: { action: "price_item_created", entityId: mat.body.item_id } });
    expect(hub.detailsJson ?? "").toContain("box of 25");
  });

  it("an agent wire item created with unit 'ft' is per-foot to the estimate engine; the same name with 'each' is not; every per-foot spelling counts", async () => {
    const ft = await create(inv, { name: `${TAG} Spool Alpha`, category: `${TAG} Spool Cat A`, type: "material", material_cost: 0.5, hours: 0.01, unit: "ft" });
    const each = await create(inv, { name: `${TAG} Spool Alpha`, category: `${TAG} Spool Cat B`, type: "material", material_cost: 0.5, hours: 0.01, unit: "each" });
    expect(ft.status, JSON.stringify(ft.body)).toBe(201);
    expect(each.status, JSON.stringify(each.body)).toBe(201);
    // Through the engine's OWN loader, not the raw row: loadCatalogAtSupplier is what the CRM estimate, the field Quote and the phone price sheet
    // price from, and it once dropped unitLabel so an agent's 'ft' never reached isContinuousLengthMaterial (review 2026-11-25).
    const rate = await loadRateContext(prisma);
    const loaded = () => loadCatalogAtSupplier(prisma, draftSupplierFor(rate.rc), rate.rc.markupTiers);
    const first = await loaded();
    expect(first.get(ft.body.item_id)?.unitLabel).toBe("ft");
    expect(isContinuousLengthMaterial(first.get(ft.body.item_id)!)).toBe(true);
    expect(isContinuousLengthMaterial(first.get(each.body.item_id)!)).toBe(false);
    let n = 0;
    const made: string[] = [];
    for (const spelling of ["lf", "foot", "feet", "per foot", "per ft", "linear feet", "FT", " Linear Feet "]) {
      n += 1;
      const r = await create(inv, { name: `${TAG} Spool Spelling ${n}`, category: `${TAG} Spool Cat C`, type: "material", material_cost: 1, unit: spelling });
      expect(r.status, spelling).toBe(201);
      made.push(r.body.item_id);
    }
    const again = await loaded();
    made.forEach((id, i) => expect(isContinuousLengthMaterial(again.get(id)!), `spelling #${i + 1}`).toBe(true));
  });

  it("a replay with the same key and unit returns the stored item; the same key with a different unit is a conflict that makes nothing", async () => {
    const key = idem();
    const body = { name: `${TAG} Unit Idem`, category: `${TAG} Unit Cat`, type: "material", material_cost: 2 };
    const first = await rest.post(inv, "/items", { idempotency_key: key, ...body, unit: "each" });
    expect(first.status).toBe(201);
    const again = await rest.post(inv, "/items", { idempotency_key: key, ...body, unit: "each" });
    expect(again.status).toBe(200);
    expect(again.body.item_id).toBe(first.body.item_id);
    expect(again.body.unit).toBe("each");
    const changed = await rest.post(inv, "/items", { idempotency_key: key, ...body, unit: "ft" });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("idempotency_conflict");
    expect(await prisma.priceBookAtomic.count({ where: { description: `${TAG} Unit Idem` } })).toBe(1);
    expect((await prisma.priceBookAtomic.findUniqueOrThrow({ where: { itemId: first.body.item_id } })).unitLabel).toBe("each");
  });

  it("a proposal cannot change the unit: unit is refused as an unknown field and nothing is queued", async () => {
    const made = await create(inv, { name: `${TAG} Unit Propose`, category: `${TAG} Unit Cat`, type: "material", material_cost: 2 });
    const before = await prisma.hubMessage.count({ where: { threadId: PRICE_BOOK_THREAD_ID } });
    const r = await propose(inv, made.body.item_id, { material_cost: 3, unit: "ft" });
    expect(r.status).toBe(400);
    expect(r.body.reason).toContain("unit");
    expect(await prisma.hubMessage.count({ where: { threadId: PRICE_BOOK_THREAD_ID } })).toBe(before);
    expect((await prisma.priceBookAtomic.findUniqueOrThrow({ where: { itemId: made.body.item_id } })).unitLabel).toBe("each");
  });
});

describe("the audit of an agent's create", () => {
  it("PriceBookEdit names the key, AgentAuditLog records the call with no body, and the Messages audit log says an item was added", async () => {
    const inv = await keyFor("inventory");
    const key = idem();
    const r = await rest.post(inv, "/items", { idempotency_key: key, unit: "each", name: `${TAG} Audited`, category: `${TAG} Audit Cat`, type: "material", material_cost: 3, notes: "SECRET-NOTE-TEXT" });
    expect(r.status).toBe(201);
    const id = r.body.item_id as string;
    expect((await prisma.priceBookEdit.findFirstOrThrow({ where: { itemId: id, field: "created" } })).editedBy).toBe(`agent:${inv.name}`);
    const call = await prisma.agentAuditLog.findFirstOrThrow({ where: { agentKeyId: inv.id, action: "pricebook.items.create" } });
    expect(call).toMatchObject({ responseStatus: 201, door: "rest", agentKeyName: inv.name, endpoint: "POST /agent/price-book/items", scopeUsed: "pricebook:write", resultCode: "ok" });
    expect(JSON.stringify(call)).not.toContain("SECRET-NOTE-TEXT");
    expect(call.recordIds).toEqual([id]);
    const hub = await prisma.hubAuditLog.findFirstOrThrow({ where: { action: "price_item_created", entityId: id } });
    expect(hub).toMatchObject({ actorKey: `agent:${inv.id}`, actorDisplay: inv.name });
  });
});

// ── the migration's data statements ───────────────────────────────────────────────────────────────

describe("migration 20261125100000_agent_price_book (data only)", () => {
  it("retires pricebook:propose and gives live keys their new defaults by role, leaving every other scope and every revoked key alone, and is idempotent", async () => {
    const sql = readFileSync(join(__dirname, "..", "prisma", "migrations", "20261125100000_agent_price_book", "migration.sql"), "utf8");
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE|ALTER)\b/i);
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(2);
    const mk = async (role: string, scopes: string[], revoked = false) => {
      const row = await prisma.agentKey.create({
        data: {
          name: `${TAG} mig ${role} ${randomUUID().slice(0, 4)}`, agentRole: role, environment: "test", displayPrefix: "rce_test_xxxx", secretHash: randomUUID(),
          scopes, createdBy: "test", revokedAt: revoked ? new Date() : null,
        },
      });
      keyIds.push(row.id);
      return row.id;
    };
    const inventory = await mk("inventory", ["inventory:read", "inventory:usage", "pricebook:propose", "team:read", "team:reply"]);
    const admin = await mk("admin", ["crm:read", "hub:read", "team:read"]);
    const other = await mk("other", ["team:read"]);
    const revoked = await mk("research", ["team:read", "pricebook:propose"], true);
    const already = await mk("scout", ["pricebook:read", "team:read"]);
    for (let run = 0; run < 2; run += 1) {
      for (const s of statements) await prisma.$executeRawUnsafe(s);
      const scopesOf = async (id: string) => (await prisma.agentKey.findUniqueOrThrow({ where: { id } })).scopes;
      expect(await scopesOf(inventory)).toEqual(["inventory:read", "inventory:usage", "team:read", "team:reply", "pricebook:read", "pricebook:write"]);
      expect(await scopesOf(admin)).toEqual(["crm:read", "hub:read", "team:read", "pricebook:read"]);
      expect(await scopesOf(other)).toEqual(["team:read"]);
      expect(await scopesOf(revoked)).toEqual(["team:read"]); // the retired string leaves a revoked key too, but it gets nothing new
      expect(await scopesOf(already)).toEqual(["pricebook:read", "team:read"]);
    }
  });
});
