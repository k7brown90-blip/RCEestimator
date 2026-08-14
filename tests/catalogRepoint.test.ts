/**
 * P014 — the catalog surfaces read ONE catalog.
 *
 * The invariant: the catalog the AI proposes from is the catalog the engine prices from. Before
 * this, `GET /atomic-units` and the `query_atomic_units` MCP tool read the legacy `AtomicUnit`
 * table while the engine read `PriceBookAtomic`, and the two code spaces are disjoint
 * (`LINE-002` vs `A016`). A tech's AI candidates could cite items the engine would refuse.
 *
 * The expensive failure here is quiet: a half-moved code space looks like a working catalog right
 * up until an estimate refuses to price. So these tests assert the negative as hard as the
 * positive — a legacy code must be neither browsable nor proposable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { proposeLines } from "../src/services/atomicEstimateService";

const SRC = (p: string) => readFileSync(path.join(__dirname, "..", p), "utf8");

/** A workbook-shaped atomic and a legacy-shaped one, so "disjoint" is testable. */
const PB_CODE = "A016";
const PB_CODE_2 = "SD002";
const LEGACY_CODE = "LINE-002";

let draftId: string | null = null;
const SUPPLIER_ID = "P014_SUP";

beforeAll(async () => {
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: [PB_CODE, PB_CODE_2] } } });
  await prisma.priceBookAtomic.createMany({
    data: [
      {
        itemId: PB_CODE,
        description: "P014 test — receptacle, 20A duplex",
        category: "DEVICES",
        unit: "ea",
        rowType: "MATERIAL + LABOR",
        laborNormal: 0.32,
        laborDifficult: 0.41,
        laborVeryDifficult: 0.55,
        laborUnitBasis: "E",
        laborUnitDivisor: 1,
        necArticle: "210",
        costBasisUsed: 4.25,
      },
      {
        // No labour basis and no supplier price — the gaps must surface, not hide the row.
        itemId: PB_CODE_2,
        description: "P014 test — smoke detector",
        category: "PROTECTION",
        unit: "ea",
        rowType: "MATERIAL + LABOR",
        laborNormal: 0.5,
        laborDifficult: null,
        laborVeryDifficult: null,
        laborUnitBasis: null,
        necArticle: "760",
        costBasisUsed: null,
      },
    ],
  });

  // LINE-002 is a REAL row, seeded from the legacy CSV catalog by globalSetup. It is not
  // created here on purpose: the assertion that matters is that a genuine legacy row still
  // exists on disk and is simply unreachable from the catalog surfaces.

  await prisma.priceBookSupplier.upsert({
    where: { id: SUPPLIER_ID },
    create: { id: SUPPLIER_ID, name: "P014 Supply", quotable: "YES" },
    update: { quotable: "YES" },
  });
  const draft = await prisma.priceBookDraftEstimate.create({
    data: { title: "P014 proposal test", supplierId: SUPPLIER_ID },
  });
  draftId = draft.id;
});

afterAll(async () => {
  if (draftId) {
    await prisma.priceBookDraftLine.deleteMany({ where: { draftId } });
    await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId } });
    await prisma.priceBookDraftEstimate.deleteMany({ where: { id: draftId } });
  }
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: [PB_CODE, PB_CODE_2] } } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: SUPPLIER_ID } });
  // AtomicUnit is deliberately not cleaned up — nothing here created a row in it.
});

describe("GET /atomic-units — browse reads the price book", () => {
  it("returns price-book codes and never a legacy code", async () => {
    const res = await request(app).get("/atomic-units?limit=200");
    expect(res.status).toBe(200);
    const ids: string[] = res.body.atomics.map((a: { itemId: string }) => a.itemId);
    expect(ids).toContain(PB_CODE);
    expect(ids).not.toContain(LEGACY_CODE);
    // The legacy row is still on disk — the point is that it is not served here.
    expect(await prisma.atomicUnit.findFirst({ where: { code: LEGACY_CODE } })).not.toBeNull();
  });

  it("carries the three published labour columns and the unit basis, not one labour number", async () => {
    const res = await request(app).get(`/atomic-units?search=${PB_CODE}`);
    const row = res.body.atomics.find((a: { itemId: string }) => a.itemId === PB_CODE);
    expect(row).toBeDefined();
    expect(row.laborNormal).toBe(0.32);
    expect(row.laborDifficult).toBe(0.41);
    expect(row.laborVeryDifficult).toBe(0.55);
    expect(row.laborUnitBasis).toBe("E");
    expect(row.hasLabourUnitBasis).toBe(true);
    expect(row.necArticle).toBe("210");
    // The legacy one-number shape must be gone, not merely supplemented.
    expect(row.baseLaborHrs).toBeUndefined();
    expect(row.baseLaborRate).toBeUndefined();
    expect(row.baseMaterialCost).toBeUndefined();
  });

  it("shows a missing labour basis and a missing price as gaps rather than hiding the row", async () => {
    const res = await request(app).get(`/atomic-units?search=${PB_CODE_2}`);
    const row = res.body.atomics.find((a: { itemId: string }) => a.itemId === PB_CODE_2);
    expect(row).toBeDefined();
    expect(row.laborUnitBasis).toBeNull();
    expect(row.hasLabourUnitBasis).toBe(false);
    expect(row.hasPriceAtActiveSupplier).toBe(false);
  });

  it("refuses the retired `tier` filter instead of silently ignoring it", async () => {
    const res = await request(app).get("/atomic-units?tier=1");
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("tier");
  });

  it("reports the true catalog size even when the page cap truncates the rows", async () => {
    const res = await request(app).get("/atomic-units?limit=1");
    expect(res.body.count).toBe(1);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    expect(res.body.truncated).toBe(true);
    // `total` counts matches, not the page — the two must not be the same number here.
    expect(res.body.total).not.toBe(res.body.count);
  });

  it("filters by the workbook's category", async () => {
    const res = await request(app).get("/atomic-units?category=DEVICES");
    const ids: string[] = res.body.atomics.map((a: { itemId: string }) => a.itemId);
    expect(ids).toContain(PB_CODE);
    expect(ids).not.toContain(PB_CODE_2);
  });
});

describe("GET /atomic-units/:code — by-code lookup", () => {
  it("returns the three labour columns for a real imported ID", async () => {
    const res = await request(app).get(`/atomic-units/${PB_CODE}`);
    expect(res.status).toBe(200);
    expect(res.body.itemId).toBe(PB_CODE);
    expect(res.body.laborNormal).toBe(0.32);
    expect(res.body.laborDifficult).toBe(0.41);
    expect(res.body.laborVeryDifficult).toBe(0.55);
    expect(res.body.laborUnitBasis).toBe("E");
  });

  it("404s a legacy code, and says why rather than just 'not found'", async () => {
    const res = await request(app).get(`/atomic-units/${LEGACY_CODE}`);
    expect(res.status).toBe(404);
    expect(String(res.body.detail)).toContain("legacy");
  });

  it("404s an unknown code without inventing a nearest match", async () => {
    const res = await request(app).get("/atomic-units/ZZZ999");
    expect(res.status).toBe(404);
    expect(res.body.itemId).toBeUndefined();
  });
});

describe("the browse API and the intake API are one read path", () => {
  it("/atomic-units and /price-book/atomics return the same row for the same code", async () => {
    const [legacyRoute, pbRoute] = await Promise.all([
      request(app).get(`/atomic-units?search=${PB_CODE}`),
      request(app).get(`/price-book/atomics?search=${PB_CODE}`),
    ]);
    const a = legacyRoute.body.atomics.find((r: { itemId: string }) => r.itemId === PB_CODE);
    const b = pbRoute.body.atomics.find((r: { itemId: string }) => r.itemId === PB_CODE);
    expect(a).toEqual(b);
  });
});

describe("candidate matching proposes only price-book codes", () => {
  it("accepts a price-book code and rejects a legacy code into a question", async () => {
    const result = await proposeLines(
      prisma,
      draftId!,
      [
        { itemId: PB_CODE, quantity: 4, quantitySource: "COUNT", reasoning: "four receptacles counted" },
        { itemId: LEGACY_CODE, quantity: 20, quantitySource: "MEASURED_LENGTH", reasoning: "legacy code" },
      ],
      [],
      "ai:test"
    );

    expect(result.proposed.map((p) => p.itemId)).toEqual([PB_CODE]);
    expect(result.rejected.map((r) => r.itemId)).toEqual([LEGACY_CODE]);
    expect(result.rejected[0].reason).toContain("not in PriceBookAtomic");
    // Rejected is not silently dropped — it becomes a question for the tech.
    expect(result.questions.some((q) => q.question.includes(LEGACY_CODE))).toBe(true);

    const lines = await prisma.priceBookDraftLine.findMany({ where: { draftId: draftId! } });
    expect(lines.map((l) => l.itemId)).toEqual([PB_CODE]);
  });
});

describe("the model's tool surface has one catalog tool", () => {
  const mcp = SRC("src/mcp/server.ts");

  it("query_atomic_units is retired, not live", () => {
    expect(mcp).not.toMatch(/server\.registerTool\(\s*\n?\s*"query_atomic_units"/);
    expect(mcp, "kept on the retired server — move, never delete").toMatch(
      /retired\.registerTool\(\s*\n?\s*"query_atomic_units"/
    );
  });

  it("query_price_book_atomics is the live catalog tool", () => {
    expect(mcp).toMatch(/server\.registerTool\(\s*\n?\s*"query_price_book_atomics"/);
  });

  it("no live tool reads prisma.atomicUnit for catalog search", () => {
    // `atomicUnit` still appears via `include: { atomicUnit: true }` on EstimateItem — that is
    // historical estimate rendering and is deliberately untouched. What must be gone is a
    // catalog-wide findMany against the legacy table on a reachable tool.
    const live = mcp.slice(0, mcp.indexOf('retired.registerTool(\n    "query_atomic_units"'));
    expect(live).not.toContain("prisma.atomicUnit.findMany");
  });

  it("the agent instructions no longer point at the legacy list", () => {
    const instructions = SRC("src/agentInstructions.ts");
    expect(instructions).toContain("query_price_book_atomics");
    expect(instructions).not.toMatch(/query_atomic_units reads/);
  });
});

describe("the legacy catalog itself is untouched", () => {
  it("AtomicUnit is still a model with its EstimateItem relation", () => {
    const schema = SRC("prisma/schema.prisma");
    expect(schema).toContain("model AtomicUnit");
    expect(schema).toContain("estimateItems        EstimateItem[]");
  });

  it("its rows still exist and are still readable directly", async () => {
    const row = await prisma.atomicUnit.findFirst({ where: { code: LEGACY_CODE } });
    expect(row, `${LEGACY_CODE} should still be seeded in AtomicUnit`).not.toBeNull();
    expect(row!.isActive).toBe(true);
    expect(row!.baseLaborHrs).toBeGreaterThan(0);
    // Same code, both catalogs, disjoint spaces — the row exists and is still not browsable.
    expect(await prisma.priceBookAtomic.findUnique({ where: { itemId: LEGACY_CODE } })).toBeNull();
  });
});
