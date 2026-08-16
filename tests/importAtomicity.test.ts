/**
 * P018 — the import is all-or-nothing, and the parser reads the workbook's convention.
 *
 * Both defects are evidenced in `_architect/reports/P016-2026-08-16-production-price-book-import.md`:
 * two failed production attempts each left a partial catalog behind (§4, §8), and the parser
 * accepted free-text `NO — NEVER <reason>` while treating free-text `NO - <reason>` as fatal (§1).
 *
 * The quotable fixtures below are the FOUR REAL CELL TEXTS from that report, quoted verbatim.
 * Nothing here invents a price or a cell value — where a fixture is synthetic it says so.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PriceBookQuotable } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { parseQuotable } from "../../app/scripts/price-book/quotable";

// ─── parseQuotable (Scope — do 2, 3) ─────────────────────────────────────────────────────────

describe("parseQuotable reads Kyle's annotation convention", () => {
  /** Verbatim from P016 §8 — the four cells that stopped two production imports. */
  const REAL_CELLS = [
    "NO - KYLE RULING 2026-08-16 (SUTHERLANDS is not an RCE buying channel)",
    "NO - SUPERSEDED (Kyle ruling 2026-08-12; $2.18 verified)",
    "NO - SUPERSEDED DUPLICATE (same Item x Supplier as row 90; consolidated 2026-08-14 local verify)",
    "NO - SUPERSEDED BY KYLE RULING 2026-08-14 (GB001 = 12-terminal PK12GTACP, single system-wide ground bar)",
  ];

  it("parses all four real cells to NO", () => {
    for (const cell of REAL_CELLS) {
      expect(parseQuotable(cell, "fixture"), cell).toBe(PriceBookQuotable.NO);
    }
  });

  it("still maps NEVER variants to NEVER — precedence, not luck", () => {
    expect(parseQuotable("NO — NEVER", "fixture")).toBe(PriceBookQuotable.NEVER);
    expect(parseQuotable("NO — NEVER (employer account)", "fixture")).toBe(PriceBookQuotable.NEVER);
    // The plain-NO pattern also matches this string; NEVER must win.
    expect(parseQuotable("NO - NEVER, employer account", "fixture")).toBe(PriceBookQuotable.NEVER);
  });

  it("keeps exact YES and NO", () => {
    expect(parseQuotable("YES", "fixture")).toBe(PriceBookQuotable.YES);
    expect(parseQuotable(" yes ", "fixture")).toBe(PriceBookQuotable.YES);
    expect(parseQuotable("NO", "fixture")).toBe(PriceBookQuotable.NO);
  });

  it("still refuses anything it cannot read", () => {
    for (const bad of ["NOPE", "NOT SURE", "NONE", "MAYBE", "", "   ", "TBD", "1", "TRUE"]) {
      expect(() => parseQuotable(bad, "fixture"), bad).toThrow(/Unrecognised Quotable value/);
    }
    expect(() => parseQuotable(null, "fixture")).toThrow(/Unrecognised Quotable value/);
  });

  it("does NOT loosen YES — an annotated YES stays fatal", () => {
    // The asymmetry is the point: a value that MIGHT mean quotable must never default in.
    // "a wrong price outranks a missing one" — decisions/2026-08-14-accuracy-standard.
    for (const bad of ["YES - verified 2026-08-14", "YES (HD)", "YES — quotable"]) {
      expect(() => parseQuotable(bad, "fixture"), bad).toThrow(/Unrecognised Quotable value/);
    }
  });

  it("names the offending value and location in the error", () => {
    expect(() => parseQuotable("MAYBE", "Suppliers!F for ACME")).toThrow(/"MAYBE".*Suppliers!F for ACME/s);
  });
});

// ─── Import atomicity (Scope — do 1, 3) ──────────────────────────────────────────────────────

/**
 * The importer's write phase is one interactive transaction. Rather than shell out to the real
 * script (which needs Python, a workbook, and three minutes), this reproduces its shape: a
 * multi-table write that throws part-way, wrapped the same way. What is under test is the
 * PROPERTY — a throw leaves every catalog table exactly as it was — not the script's plumbing.
 *
 * Every value below is a synthetic fixture. None of it is a real workbook price.
 */
const FIXTURE_SUPPLIER = "P018_FIXTURE_SUP";
const FIXTURE_ATOMICS = ["P018_FIX_A", "P018_FIX_B", "P018_FIX_C"];

async function catalogCounts() {
  return {
    suppliers: await prisma.priceBookSupplier.count({ where: { id: FIXTURE_SUPPLIER } }),
    atomics: await prisma.priceBookAtomic.count({ where: { itemId: { in: FIXTURE_ATOMICS } } }),
    prices: await prisma.priceBookSupplierPrice.count({ where: { supplierId: FIXTURE_SUPPLIER } }),
  };
}

/** The importer's write phase, in miniature. `failAt` injects a mid-run throw. */
async function runFixtureImport(failAt: string | null): Promise<"ok" | "failed"> {
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.priceBookSupplier.upsert({
          where: { id: FIXTURE_SUPPLIER },
          create: { id: FIXTURE_SUPPLIER, name: "P018 fixture supplier", quotable: "YES" },
          update: { quotable: "YES" },
        });

        for (const itemId of FIXTURE_ATOMICS) {
          if (failAt === itemId) {
            throw new Error(`Unrecognised Quotable value "MAYBE" at fixture row for ${itemId}.`);
          }
          await tx.priceBookAtomic.upsert({
            where: { itemId },
            create: { itemId, description: `P018 fixture ${itemId}`, category: "FIXTURE" },
            update: { description: `P018 fixture ${itemId}` },
          });
          await tx.priceBookSupplierPrice.upsert({
            where: { itemId_supplierId: { itemId, supplierId: FIXTURE_SUPPLIER } },
            create: { itemId, supplierId: FIXTURE_SUPPLIER, unitCost: 1.23, quotable: "YES" },
            update: { unitCost: 1.23 },
          });
        }
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    return "ok";
  } catch {
    return "failed";
  }
}

async function cleanup() {
  await prisma.priceBookSupplierPrice.deleteMany({ where: { supplierId: FIXTURE_SUPPLIER } });
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: FIXTURE_ATOMICS } } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: FIXTURE_SUPPLIER } });
}

describe("a mid-run failure leaves the catalog exactly as it was", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("rolls back every table — the supplier written before the throw does not survive", async () => {
    const before = await catalogCounts();
    expect(before).toEqual({ suppliers: 0, atomics: 0, prices: 0 });

    // Fails on the THIRD atomic, so a supplier, two atomics and two prices are already written
    // when the throw lands. That is exactly the shape of the 2026-08-16 production failures.
    const outcome = await runFixtureImport("P018_FIX_C");
    expect(outcome).toBe("failed");

    const after = await catalogCounts();
    expect(after, "every catalog table must be at its pre-run count").toEqual(before);
  });

  it("rolls back an UPDATE too, not just inserts", async () => {
    // Land a clean import, then fail a second one — the pre-existing rows must be untouched,
    // which is the case that matters once production's catalog is populated.
    expect(await runFixtureImport(null)).toBe("ok");
    await prisma.priceBookAtomic.update({
      where: { itemId: "P018_FIX_A" },
      data: { description: "ORIGINAL — must survive a failed re-import" },
    });

    expect(await runFixtureImport("P018_FIX_C")).toBe("failed");

    const row = await prisma.priceBookAtomic.findUnique({ where: { itemId: "P018_FIX_A" } });
    expect(row?.description).toBe("ORIGINAL — must survive a failed re-import");
  });

  it("the clean run lands fully, and a second run changes nothing", async () => {
    expect(await runFixtureImport(null)).toBe("ok");
    const first = await catalogCounts();
    expect(first).toEqual({ suppliers: 1, atomics: 3, prices: 3 });

    const rowsBefore = await prisma.priceBookAtomic.findMany({
      where: { itemId: { in: FIXTURE_ATOMICS } },
      orderBy: { itemId: "asc" },
      select: { itemId: true, description: true },
    });

    expect(await runFixtureImport(null)).toBe("ok");

    expect(await catalogCounts()).toEqual(first);
    const rowsAfter = await prisma.priceBookAtomic.findMany({
      where: { itemId: { in: FIXTURE_ATOMICS } },
      orderBy: { itemId: "asc" },
      select: { itemId: true, description: true },
    });
    expect(rowsAfter).toEqual(rowsBefore);
  });
});

describe("the importer's own source keeps the run row outside the transaction", () => {
  it("creates and updates PriceBookImportRun outside $transaction, so failures are recorded", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.join(__dirname, "..", "scripts", "price-book", "importPriceBook.ts"),
      "utf8",
    );

    const txStart = src.indexOf("await prisma.$transaction(");
    const txEnd = src.indexOf("// ── 7. Parity ──");
    expect(txStart).toBeGreaterThan(0);
    expect(txEnd).toBeGreaterThan(txStart);

    const inTransaction = src.slice(txStart, txEnd);
    // The run row is the one thing that must survive a rollback — it is the record that an
    // attempt happened at all.
    expect(inTransaction).not.toContain("priceBookImportRun");
    expect(src).toContain("prisma.priceBookImportRun.create");
    expect(src).toContain('status: "failed"');

    // And nothing inside the transaction may write through the non-transactional client.
    expect(inTransaction).not.toContain("prisma.priceBook");
  });
});
