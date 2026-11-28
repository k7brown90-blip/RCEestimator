/**
 * P023 — the intake screen reaches the proposer, and the wire changes none of P011's guarantees.
 *
 * The live model run is the acceptance fixture and lives in the report (it costs money and needs a
 * key). What is pinned here is everything that must hold WITHOUT calling the model:
 *
 *   * the degraded path is honest — it says "basic", it says why, and it writes nothing;
 *   * the AI path goes through `proposeLines()`, so a hallucinated itemId cannot become a line;
 *   * nothing in the new code can confirm, price or finalize.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { proposeLines, createDraft } from "../src/services/atomicEstimateService";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const SRC = (p: string) => readFileSync(path.join(__dirname, "..", p), "utf8");

/** A real, resolvable catalog code — proposeLines() must accept it and resolve-walkthrough must
 * find it, so it needs to exist and to carry words a "duplex receptacle" search would hit. */
const REAL_ITEM = "P023_R001";

let draftId: string;

beforeAll(async () => {
  // Own fixture, not the deleted importer's — see tests/helpers/priceBookFixture.ts and
  // .claude/plans/2026-09-15-tests-build-their-own-price-data.md. The old guard here only ever
  // proved "the import ran"; it is meaningless once the catalog is built by hand, and is why it
  // is deleted below rather than pointed at a bigger number.
  await ensurePriceBookGates();
  await seedAtomics([
    quotableAtomic(REAL_ITEM, { description: "Duplex receptacle, 15A tamper-resistant" }),
  ]);
  const d = await createDraft(prisma, { title: "P023 wiring fixture", supplierId: "HD" });
  draftId = d.id;
});

afterAll(async () => {
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: draftId } });
  await deleteAtomics([REAL_ITEM]);
});

describe("the degraded path is honest", () => {
  const saved = process.env.OPENAI_API_KEY;
  beforeAll(() => { delete process.env.OPENAI_API_KEY; });
  afterAll(() => { if (saved) process.env.OPENAI_API_KEY = saved; });

  it('returns path "basic" with a reason rather than pretending the AI ran', async () => {
    const res = await request(app)
      .post(`/price-book/drafts/${draftId}/propose`)
      .send({ text: "5 duplex receptacles" });

    expect(res.status).toBe(200);
    expect(res.body.path).toBe("basic");
    expect(String(res.body.degradedReason)).toContain("OPENAI_API_KEY");
  });

  it("writes nothing to the draft when it degrades", async () => {
    const before = await prisma.priceBookDraftLine.count({ where: { draftId } });
    await request(app).post(`/price-book/drafts/${draftId}/propose`).send({ text: "4 LED wafer lights" });
    expect(await prisma.priceBookDraftLine.count({ where: { draftId } })).toBe(before);
  });

  it("still refuses an empty walkthrough", async () => {
    const res = await request(app).post(`/price-book/drafts/${draftId}/propose`).send({ text: "" });
    expect(res.status).toBe(400);
  });
});

describe("a hallucinated itemId cannot become a line", () => {
  // Kyle, 2026-11-28: "I dont want these questions as I already confirmed the line item once." This
  // test used to pin that the invented id became a QUESTION row on the draft. It now pins that it is
  // reported as NOT PLACED - a note in the result - and that no question row is written at all.
  it("is reported as not placed (no question row), through the same gate the MCP tool uses", async () => {
    // This is the guarantee the wire depends on: the proposer hands its output to proposeLines(),
    // which resolves every itemId against the live catalog before anything is written.
    const result = await proposeLines(
      prisma,
      draftId,
      [
        { itemId: REAL_ITEM, quantity: 2, quantitySource: "COUNT", reasoning: "real code" },
        { itemId: "TOTALLY-MADE-UP-001", quantity: 3, quantitySource: "COUNT", reasoning: "invented by a model" },
      ],
      [],
      "ai:test",
    );

    expect(result.proposed.map((p) => p.itemId)).toEqual([REAL_ITEM]);
    expect(result.rejected.map((r) => r.itemId)).toEqual(["TOTALLY-MADE-UP-001"]);
    expect(result.notPlaced).toHaveLength(1);
    expect(result.notPlaced[0]!.text).toBe("invented by a model");
    expect(result.notPlaced[0]!.reason).toContain("TOTALLY-MADE-UP-001");
    expect(await prisma.priceBookDraftQuestion.count({ where: { draftId } }), "no question row").toBe(0);

    const lines = await prisma.priceBookDraftLine.findMany({ where: { draftId } });
    expect(lines.every((l) => l.state === "PROPOSED"), "the model cannot confirm").toBe(true);
    expect(lines.map((l) => l.itemId)).not.toContain("TOTALLY-MADE-UP-001");
  });
});

describe("scope the model cannot place is a note, never a question (Kyle, 2026-11-28)", () => {
  it("the model's own notPlaced list comes back as notPlaced and writes nothing", async () => {
    const before = await prisma.priceBookDraftLine.count({ where: { draftId } });
    const result = await proposeLines(
      prisma,
      draftId,
      [],
      [
        { text: "that weird outdoor plug by the pool", reason: "nothing in the price book fits" },
        { text: "   ", reason: "blank text is dropped" },
      ],
      "ai:test",
    );
    expect(result.notPlaced).toEqual([{ text: "that weird outdoor plug by the pool", reason: "nothing in the price book fits" }]);
    expect(result.proposed).toEqual([]);
    expect(await prisma.priceBookDraftQuestion.count({ where: { draftId } }), "no question row").toBe(0);
    expect(await prisma.priceBookDraftLine.count({ where: { draftId } })).toBe(before);
  });

  it("a rejected line (non-positive quantity) is still on the rejected list, and an unknown id is on both lists", async () => {
    const result = await proposeLines(
      prisma,
      draftId,
      [
        { itemId: REAL_ITEM, quantity: 0, reasoning: "zero is nothing" },
        { itemId: "NOT-A-REAL-CODE", quantity: 1, reasoning: "invented" },
      ],
      [],
      "ai:test",
    );
    expect(result.rejected.map((r) => r.itemId).sort()).toEqual([REAL_ITEM, "NOT-A-REAL-CODE"].sort());
    expect(result.notPlaced.map((n) => n.text)).toEqual(["invented"]);
  });

  it("the instructions and the output schema no longer ask for questions", () => {
    const proposer = SRC("src/services/aiProposer.ts");
    const schema = proposer.slice(proposer.indexOf("const SCHEMA"), proposer.indexOf("interface ModelLine"));
    expect(schema).toContain('required: ["lines", "notPlaced"]');
    expect(schema).not.toMatch(/questions/);
    expect(schema).toContain("notPlaced");
    const instructions = proposer.slice(proposer.indexOf("const INSTRUCTIONS"), proposer.indexOf("const SCHEMA"));
    expect(instructions).toContain("do NOT ask a question");
    expect(instructions).not.toContain("becomes a question");
    // The model still never guesses an itemId (P011).
    expect(instructions).toContain("Never invent an itemId");
  });
});

describe("the wire adds no authority", () => {
  const proposer = SRC("src/services/aiProposer.ts");

  /**
   * Strip comments before asserting. This file's own instruction block tells the model it cannot
   * "price, confirm, or finalize" — searching the raw source finds that safety copy and reports
   * it as the hazard. Same trap `aiProposeOnly.test.ts` documented; assert on code.
   */
  const codeOnly = (t: string) =>
    t
      .split(String.fromCharCode(10))
      .filter((l) => {
        const x = l.trim();
        return !x.startsWith("//") && !x.startsWith("*") && !x.startsWith("/*");
      })
      .join(" ");

  it("routes everything through proposeLines and writes nothing itself", () => {
    expect(proposer).toContain("proposeLines(");
    // No direct writes to lines, drafts or the catalog from the proposer.
    expect(proposer).not.toMatch(/prisma\.priceBookDraftLine\.(create|update|upsert)/);
    expect(proposer).not.toMatch(/prisma\.priceBookDraftEstimate\.(create|update|upsert)/);
    // No finalize call in executable code — the word survives only in the copy telling the
    // model it has no such authority.
    expect(codeOnly(proposer)).not.toMatch(/finalize\s*\(/);
  });

  it("never asks the model for a price, a multiplier, or a status", () => {
    // The schema is the contract with the model; a money field in it would be the whole failure.
    const schema = proposer.slice(proposer.indexOf("const SCHEMA"), proposer.indexOf("interface ModelLine"));
    for (const banned of ["price", "cost", "rate", "markup", "multiplier", "total", "status"]) {
      expect(schema.toLowerCase(), `${banned} must not be a model-supplied field`).not.toContain(banned);
    }
    // Difficulty travels as the three published NECA columns, never as a number.
    expect(schema).toContain('"NORMAL", "DIFFICULT", "VERY_DIFFICULT"');
  });

  it("does not ask the model to cite code it cannot ground", () => {
    // Phase 4's NEC retrieval grounds citations; until then an NEC reference is a fabrication
    // with a reference number attached.
    expect(proposer).toContain("Do not cite NEC code sections");
  });

  it("instructs the model that a room dimension is not a quantity", () => {
    expect(proposer).toContain("ROOM DIMENSION IS NOT A QUANTITY");
  });
});

describe("the token matcher survives as the degraded path", () => {
  it("resolve-walkthrough still exists and still works", async () => {
    const res = await request(app)
      .post("/price-book/resolve-walkthrough")
      .send({ rows: [{ raw: "duplex receptacle" }] });
    expect(res.status).toBe(200);
    expect(res.body.rows[0].candidates.length).toBeGreaterThan(0);
  });
});
