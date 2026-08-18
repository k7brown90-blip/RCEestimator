/**
 * price-book.xlsx  ->  estimator database.  Read-only, idempotent, headless.
 *
 * Runs the extractor (extract_workbook.py), validates the snapshot, upserts the catalog
 * keyed on the workbook's own stable IDs, writes a dated delta report, and optionally
 * runs the parity harness.
 *
 * USAGE
 *   npx tsx scripts/price-book/importPriceBook.ts \
 *     --workbook "<path to price-book.xlsx>" \
 *     --report   "<path to write the dated markdown delta report>" \
 *     [--parity] [--no-recalc] [--dry-run] [--snapshot <path>]
 *
 * EXIT CODES — 0 ONLY when the import succeeded AND (if requested) parity held.
 *   0  success
 *   1  unexpected error
 *   2  workbook shape drift (mapping is stale — update workbook-mapping.json)
 *   3  workbook missing / unreadable
 *   4  extraction problems (component formulas inconsistent, workbook changed mid-read)
 *   5  import failed
 *   6  parity failed
 *
 * NON-NEGOTIABLES
 *   * The workbook is never written. The extractor copies it and verifies the SHA-256
 *     is identical before and after.
 *   * A blank price imports as NULL. Never 0, never a guess.
 *   * Rows that vanish from the workbook are RETIRED (retiredAt set), never deleted —
 *     write protocol rule 5, and estimate history must not lose its catalog rows.
 *   * Nothing about Vapi, Twilio, or any customer-send path is touched. All deferred
 *     by decisions/2026-08-11-manual-first-automation-deferral.md.
 */

import { PrismaClient, PriceBookQuotable } from "@prisma/client";
// Extracted by P018 so it can be unit-tested — this file runs main() on import.
import { parseQuotable } from "./quotable";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeAssembly,
  evaluateLiteralArithmetic,
  markupTierFor,
  resolveCostBasis,
  sellPriceFor,
  type MarkupTiers,
  type RateConfig,
  type SupplierPriceRow,
} from "../../src/services/priceBookPricing";

const prisma = new PrismaClient();
const HERE = __dirname;
const EXTRACTOR = path.join(HERE, "extract_workbook.py");

/** Kyle's ruled company-wide billed rate. decisions/2026-08-11-billed-rate-and-no-memberships.md */
const RULED_BILLED_RATE = 150;

// ─── CLI ────────────────────────────────────────────────────────────────────────

interface Args {
  workbook: string;
  report: string | null;
  snapshot: string | null;
  parity: boolean;
  noRecalc: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const workbook = get("--workbook");
  if (!workbook) {
    console.error(
      "FATAL: --workbook is required.\n" +
        "  The workbook path is not hard-coded: this pipeline must never guess which file is\n" +
        "  the live price book. Backups are named _backup-price-book-*.xlsx and staged copies\n" +
        "  price-book-STAGED-*.xlsx; neither is ever the source."
    );
    process.exit(3);
  }
  return {
    workbook,
    report: get("--report"),
    snapshot: get("--snapshot"),
    parity: argv.includes("--parity"),
    noRecalc: argv.includes("--no-recalc"),
    dryRun: argv.includes("--dry-run"),
  };
}

// ─── Snapshot types (mirror of extract_workbook.py output) ──────────────────────

interface SnapRateCell { row: number; label: string; number: number | null; text: string | null }
interface SnapAtomic {
  rowNumber: number; itemId: string; description: string | null; category: string | null;
  sector: string | null; unit: string | null; retailCost: number | null; tradeCost: number | null;
  laborNormal: number | null; laborDifficult: number | null; laborVeryDifficult: number | null;
  // Atomics!AA, added by the 04:00 task 2026-08-13. null = UNVERIFIED, which blocks.
  laborUnitBasis: string | null; laborUnitDivisor: number | null; laborUnitBasisRaw: string | null;
  difficultyCurve: string | null; necaUnitBasis: string | null; necaPdfPage: unknown;
  laborStatus: string | null; notes: string | null; purchaseUnit: string | null;
  purchasePackQty: number | null; purchasePrice: number | null; rowType: string | null;
  necArticle: string | null;
}
interface SnapComponent { itemId: string; atomicRow: number; quantity: number }
interface SnapAssembly {
  rowNumber: number; assemblyId: string; name: string | null; sectorTab: string;
  sectorColumn: string | null; useCase: string | null; componentProse: string | null;
  totalLaborNormalFormula: string | null; laborFormulaReferencesAtomics: boolean;
  necCodeRefs: string | null; notes: string | null; status: string | null;
  difficultySetting: string | null; pricingFlags: string | null;
  componentsTotalDeclared: number | null; jobType: string | null; permitRequired: string | null;
  utilityStandbyRequired: string | null; ceilingHeightBand: string | null;
  heightAccessAdderHours: number | null; sourcingChannel: string | null;
  necCategory: string | null; fieldDifficulty: string | null; components: SnapComponent[];
}
interface SnapSupplier {
  supplierId: string; name: string | null; branch: string | null; channel: string | null;
  accountClass: string | null; quotableRaw: string | null; leadTime: string | null;
  terms: string | null; notes: string | null;
}
interface SnapSupplierPrice {
  rowNumber: number; itemId: string; supplierId: string; priceAsPrinted: number | null;
  pricedUom: string | null; packQty: number | null; datePriced: string | null;
  source: string | null; availability: string | null; accountClass: string | null;
  quotableRaw: string | null; confidence: string | null; notes: string | null;
}
interface SnapNec { article: string; title: string | null; onKyleList: string | null; scopeRule: string | null }
interface Snapshot {
  generatedAt: string; mappingVersion: string; workbookPath: string; workbookSha256: string;
  workbookMtime: string; counts: Record<string, number>;
  rateConfig: Record<string, SnapRateCell>;
  atomics: SnapAtomic[]; assemblies: SnapAssembly[]; suppliers: SnapSupplier[];
  supplierPrices: SnapSupplierPrice[]; necCategories: SnapNec[];
  workbookComputed: {
    assemblies: Record<string, Record<string, unknown>>;
    atomics: Record<string, Record<string, unknown>>;
    supplierPrices: Record<string, Record<string, unknown>>;
  } | null;
  recalcError: string | null;
  extractionProblems: string[];
  structuralNotes: string[];
  duplicateSupplierPrices?: Array<{
    key: string;
    winningRow: number; winningPrice: number | null; winningDate: string | null;
    shadowedRow: number; shadowedPrice: number | null; shadowedDate: string | null;
  }>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** A status carrying SUPERSEDED / DO NOT QUOTE takes the row out of the quote path. */
function isSuperseded(status: string | null): boolean {
  const s = (status ?? "").toUpperCase();
  return s.includes("SUPERSEDED") || s.includes("DO NOT QUOTE");
}

interface Delta { created: string[]; updated: string[]; unchanged: string[]; retired: string[] }
const emptyDelta = (): Delta => ({ created: [], updated: [], unchanged: [], retired: [] });

/**
 * Bookkeeping columns that change on every run by design. Excluded from the change
 * comparison so the nightly delta report shows what actually MOVED. A report that
 * lists all 90 supplier prices as "updated" every night trains the reader to skip it,
 * and then the one night a price really moves it goes unread.
 */
const BOOKKEEPING_FIELDS = new Set(["lastSeenImportId", "lastSeenAt", "firstSeenAt"]);

/** Field-by-field comparison so "updated" means something actually moved. */
function changedFields(existing: Record<string, unknown> | null, next: Record<string, unknown>): string[] {
  if (!existing) return Object.keys(next).filter((k) => !BOOKKEEPING_FIELDS.has(k));
  const out: string[] = [];
  for (const [k, v] of Object.entries(next)) {
    if (BOOKKEEPING_FIELDS.has(k)) continue;
    const a = existing[k];
    const bothNullish = (a === null || a === undefined) && (v === null || v === undefined);
    if (bothNullish) continue;
    if (typeof a === "number" && typeof v === "number") {
      if (Math.abs(a - v) > 1e-9) out.push(k);
      continue;
    }
    if (a instanceof Date || v instanceof Date) continue;
    if (String(a ?? "") !== String(v ?? "")) out.push(k);
  }
  return out;
}

// ─── Extraction ─────────────────────────────────────────────────────────────────

function runExtractor(args: Args): { snapshot: Snapshot; snapshotPath: string } {
  const outPath =
    args.snapshot ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pb-import-")), "workbook-snapshot.json");

  const py = process.env.PYTHON_BIN || "python";
  const cliArgs = [EXTRACTOR, "--workbook", args.workbook, "--out", outPath];
  if (args.noRecalc) cliArgs.push("--no-recalc");

  console.log(`[extract] ${py} ${EXTRACTOR}`);
  const res = spawnSync(py, cliArgs, { encoding: "utf8", timeout: 15 * 60 * 1000 });

  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);

  if (res.error) {
    console.error(`FATAL: could not run the extractor: ${res.error.message}`);
    process.exit(3);
  }
  if (res.status !== 0) {
    console.error(`FATAL: extractor exited ${res.status}. Nothing was imported.`);
    process.exit(res.status === 2 ? 2 : res.status === 3 ? 3 : 4);
  }

  const snapshot = JSON.parse(fs.readFileSync(outPath, "utf8")) as Snapshot;
  if (snapshot.extractionProblems.length > 0) {
    console.error("FATAL: extraction reported problems; refusing to import a partial catalog.");
    process.exit(4);
  }
  assertNoDuplicateAtomicIds(snapshot);
  return { snapshot, snapshotPath: outPath };
}

/**
 * A duplicated Item ID in Atomics is a SILENT PRODUCT SUBSTITUTION, and it aborts the import.
 *
 * `PriceBookAtomic.itemId` is the primary key. The upsert loop below walks the sheet in order, so
 * two rows sharing an ID do not collide loudly — the second one simply overwrites the first, and
 * the catalog ends up holding whichever product happened to sit lower on the sheet, wearing the
 * other one's ID.
 *
 * This is live today and is why the import is held. Workbook rows 51 and 326 both claim CD009:
 *
 *   row  51  Single Receptacle, 20A 125V, NEMA 5-20R, Commercial Grade   (labour 30/37.5/45, basis C)
 *   row 326  Outlet Box, 4-inch Square, 2-1/8 in. DEEP, Welded Steel     (no labour, basis E)
 *
 * Production currently holds row 51. An unguarded import would replace the receptacle with a box
 * — same ID, different product, no labour value, different unit basis — and nothing would say so.
 * Any estimate later drawing CD009 would quote a box where a receptacle was meant.
 *
 * WHY ABORT RATHER THAN WARN. The file already warns about duplicate SUPPLIER PRICE rows, which
 * are the milder version of this: a stale price on the right product. This is the wrong product.
 * The workbook's own rule for the labour-unit column — "the app must BLOCK, not default" — is the
 * same instinct, and the same reasoning applies harder here: a plausible-looking wrong row is
 * exactly what the accuracy standard exists to stop. Refusing costs an import; not refusing costs
 * a quote nobody can explain afterwards.
 *
 * Fixing it is a WORKBOOK decision (which product keeps CD009, and what the other is re-keyed to)
 * and belongs to the price-book lane, not to this script.
 */
function assertNoDuplicateAtomicIds(snapshot: Snapshot): void {
  const byId = new Map<string, SnapAtomic[]>();
  for (const a of snapshot.atomics) {
    const key = String(a.itemId ?? "").trim();
    if (!key) continue;
    const list = byId.get(key);
    if (list) list.push(a);
    else byId.set(key, [a]);
  }

  const collisions = [...byId.entries()].filter(([, rows]) => rows.length > 1);
  if (collisions.length === 0) return;

  console.error("");
  console.error("⛔ FATAL: DUPLICATE ITEM IDs IN Atomics — refusing to import.");
  console.error("");
  console.error("   Item ID is the catalog's primary key. Importing would keep only the LAST row");
  console.error("   for each of these and silently discard the other product.");
  console.error("");
  for (const [itemId, rows] of collisions) {
    console.error(`   ${itemId} appears ${rows.length} times:`);
    for (const r of rows) {
      console.error(`     row ${String(r.rowNumber).padStart(4)}  ${String(r.description ?? "").slice(0, 80)}`);
    }
  }
  console.error("");
  console.error("   Fix in the workbook: decide which product keeps the ID and re-key the other.");
  console.error("   Nothing was imported.");
  process.exit(4);
}

// ─── Import ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

  const { snapshot, snapshotPath } = runExtractor(args);

  const rc = snapshot.rateConfig;
  const billedLaborRate = rc.billedLaborRate?.number ?? null;
  const activeSupplierId = rc.activeSupplier?.text ?? null;

  // ── B2 guard. Report the value found; do NOT hard-code 150 as an override. ──
  let provisional = false;
  let provisionalReason: string | null = null;
  if (billedLaborRate === null) {
    provisional = true;
    provisionalReason = `Rate Config B2 is BLANK. No labour rate — no labour dollars can be computed.`;
  } else if (Math.abs(billedLaborRate - RULED_BILLED_RATE) > 1e-9) {
    provisional = true;
    provisionalReason =
      `Rate Config B2 reads $${billedLaborRate.toFixed(2)}/hr. Kyle's standing ruling is ` +
      `$${RULED_BILLED_RATE.toFixed(2)}/hr (decisions/2026-08-11-billed-rate-and-no-memberships.md). ` +
      `The cell is applied by the 02:00 price-book task, not by this pipeline — an agent may ` +
      `compute, source and recommend, but may not set a number (decisions/2026-08-04-who-sets-numbers.md). ` +
      `Imported AS FOUND and marked PROVISIONAL.`;
  }

  if (provisional) {
    console.warn("\n" + "!".repeat(78));
    console.warn("!! IMPORT IS PROVISIONAL");
    console.warn("!! " + provisionalReason);
    console.warn("!".repeat(78) + "\n");
  }

  const run = args.dryRun
    ? null
    : await prisma.priceBookImportRun.create({
        data: {
          status: "running",
          workbookSha256: snapshot.workbookSha256,
          workbookPath: snapshot.workbookPath,
          workbookMtime: new Date(snapshot.workbookMtime),
          mappingVersion: snapshot.mappingVersion,
          billedLaborRate,
          provisional,
          provisionalReason,
          activeSupplierId,
        },
      });

  const deltas: Record<string, Delta> = {
    suppliers: emptyDelta(),
    supplierPrices: emptyDelta(),
    atomics: emptyDelta(),
    assemblies: emptyDelta(),
    rateConfig: emptyDelta(),
    necCategories: emptyDelta(),
  };

  // Populated inside the transaction, read by parity after it commits.
  let tiers: MarkupTiers = { tier1: 0, tier2: 0, tier3: 0, tier4: 0, tier5: 0 };
  const atomicCost = new Map<string, { costBasis: number | null; sellPerUnit: number | null }>();

  try {
    // ── ALL-OR-NOTHING (P018) ────────────────────────────────────────────────────────────
    //
    // Sections 1-6 are one interactive transaction. Before this, a throw part-way through left
    // whatever had already been written: on 2026-08-16 two failed production attempts left 6
    // then 8 supplier rows plus a stray price row behind (P016 §4, §8). Harmless against an
    // empty catalog; not harmless the day the same throw lands part-way through 323 atomics on
    // a populated one, which would leave the app quoting from a book that is half old and half
    // new with no marker but a `failed` run row.
    //
    // TRANSACTION, NOT STAGE-AND-SWAP. Stage-and-swap would need a parallel set of tables and a
    // rename step — new schema, new failure modes, and a much larger diff — to buy the same
    // guarantee at this row count (~600 upserts). Postgres handles that in one transaction
    // comfortably. If the catalog grows by an order of magnitude, revisit.
    //
    // The `PriceBookImportRun` row is created BEFORE this block and updated AFTER it, both
    // outside the transaction, so the history of a failed attempt survives the rollback. That
    // is the one thing that must NOT be atomic with the data.
    //
    // Parity (section 7) stays outside too: it reads committed data, and a parity FAILURE is a
    // reported result rather than a throw, so it must not roll back an otherwise-good import.
    await prisma.$transaction(
      async (tx) => {
      // ── 1. Suppliers ──
      for (const s of snapshot.suppliers) {
        const data = {
          name: s.name ?? s.supplierId,
          branch: s.branch,
          channel: s.channel,
          accountClass: s.accountClass,
          quotable: parseQuotable(s.quotableRaw, `Suppliers!F for ${s.supplierId}`),
          quotableRaw: s.quotableRaw,
          leadTime: s.leadTime,
          terms: s.terms,
          notes: s.notes,
        };
        const existing = await tx.priceBookSupplier.findUnique({ where: { id: s.supplierId } });
        const diff = changedFields(existing as Record<string, unknown> | null, data);
        if (!args.dryRun) {
          await tx.priceBookSupplier.upsert({
            where: { id: s.supplierId },
            create: { id: s.supplierId, ...data },
            update: data,
          });
        }
        if (!existing) deltas.suppliers.created.push(s.supplierId);
        else if (diff.length) deltas.suppliers.updated.push(`${s.supplierId} (${diff.join(", ")})`);
        else deltas.suppliers.unchanged.push(s.supplierId);
      }

      // ── 2. Supplier prices ──
      //
      // FIRST ROW WINS, because that is what the workbook does. Cost resolves through
      // MATCH(key, 'Supplier Prices'!$L:$L, 0), and MATCH returns the first match — so a
      // duplicate Item ID x Supplier is priced by whichever row sits higher on the sheet,
      // not by whichever is newer. A last-write-wins upsert would put a different number
      // in the database than the one the workbook quotes, and parity would still pass as
      // long as the in-memory resolver disagreed with the table in the same direction.
      // That is precisely the kind of silent divergence this pipeline exists to stop.
      const seenPriceKeys = new Set<string>();
      const supplierPriceRows: SupplierPriceRow[] = [];
      for (const p of snapshot.supplierPrices) {
        const dedupeKey = `${p.itemId}|${p.supplierId}`;
        if (seenPriceKeys.has(dedupeKey)) {
          // Shadowed by an earlier row. Excel never reads it, so neither do we.
          continue;
        }
        seenPriceKeys.add(dedupeKey);
        const where = `Supplier Prices!K row ${p.rowNumber} (${p.itemId}|${p.supplierId})`;
        const quotable = parseQuotable(p.quotableRaw, where);
        // Recomputed here rather than read from the workbook so the app's own arithmetic
        // is what parity tests. Workbook formula: Supplier Prices!F.
        const unitCost = (() => {
          if (p.priceAsPrinted === null) return null;
          const uom = (p.pricedUom ?? "").trim();
          if (uom === "/c") return p.priceAsPrinted / 100;
          if (uom === "/m") return p.priceAsPrinted / 1000;
          if (p.packQty !== null && p.packQty > 0) return p.priceAsPrinted / p.packQty;
          return p.priceAsPrinted;
        })();
        const quotableKey = quotable === PriceBookQuotable.YES ? `${p.itemId}|${p.supplierId}` : null;

        supplierPriceRows.push({
          itemId: p.itemId,
          supplierId: p.supplierId,
          unitCost,
          quotable: quotable as unknown as SupplierPriceRow["quotable"],
          quotableKey,
        });

        const data = {
          priceAsPrinted: p.priceAsPrinted,
          pricedUom: p.pricedUom,
          packQty: p.packQty,
          unitCost,
          datePriced: p.datePriced,
          source: p.source,
          availability: p.availability,
          accountClass: p.accountClass,
          quotable,
          quotableRaw: p.quotableRaw,
          quotableKey,
          confidence: p.confidence,
          notes: p.notes,
          workbookRow: p.rowNumber,
          lastSeenImportId: run?.id ?? null,
        };
        const key = { itemId_supplierId: { itemId: p.itemId, supplierId: p.supplierId } };
        const existing = await tx.priceBookSupplierPrice.findUnique({ where: key });
        const diff = changedFields(existing as Record<string, unknown> | null, data);
        if (!args.dryRun) {
          await tx.priceBookSupplierPrice.upsert({
            where: key,
            create: { itemId: p.itemId, supplierId: p.supplierId, ...data },
            update: data,
          });
        }
        const label = `${p.itemId}|${p.supplierId}`;
        if (!existing) deltas.supplierPrices.created.push(label);
        else if (diff.length) deltas.supplierPrices.updated.push(`${label} (${diff.join(", ")})`);
        else deltas.supplierPrices.unchanged.push(label);
      }

      // ── 3. Atomics, with cost resolved at the active supplier ──
      // Assigned here, declared outside the transaction: section 7 (parity) runs after the
      // commit and needs both, and recomputing them there would be a second source of truth
      // for the resolved cost.
      tiers = {
        tier1: rc.markupTier1?.number ?? 0,
        tier2: rc.markupTier2?.number ?? 0,
        tier3: rc.markupTier3?.number ?? 0,
        tier4: rc.markupTier4?.number ?? 0,
        tier5: rc.markupTier5?.number ?? 0,
      };

      for (const a of snapshot.atomics) {
        const { costBasis, supplierId } = resolveCostBasis(a.itemId, activeSupplierId, supplierPriceRows);
        const sell = sellPriceFor(costBasis, tiers);
        atomicCost.set(a.itemId, { costBasis, sellPerUnit: sell });

        const data = {
          description: a.description,
          category: a.category,
          sector: a.sector,
          unit: a.unit,
          rowType: a.rowType,
          laborNormal: a.laborNormal,
          laborDifficult: a.laborDifficult,
          laborVeryDifficult: a.laborVeryDifficult,
          // NECA labour unit basis (Atomics!AA). Null when the workbook says UNVERIFIED — the
          // estimating engine blocks the line rather than defaulting to E, per the column's own
          // instruction. E vs C is a 100x labour error that still looks like a real number.
          laborUnitBasis: a.laborUnitBasis ?? null,
          laborUnitDivisor: a.laborUnitDivisor ?? null,
          laborUnitBasisRaw: a.laborUnitBasisRaw ?? null,
          difficultyCurve: a.difficultyCurve,
          laborStatus: a.laborStatus,
          necaUnitBasis: a.necaUnitBasis,
          necaPdfPage: str(a.necaPdfPage),
          retailCost: a.retailCost,
          tradeCost: a.tradeCost,
          purchaseUnit: a.purchaseUnit,
          purchasePackQty: a.purchasePackQty,
          purchasePrice: a.purchasePrice,
          costBasisUsed: costBasis,
          costBasisSupplier: supplierId,
          markupTier: markupTierFor(costBasis),
          sellPricePerUnit: sell,
          necArticle: a.necArticle,
          notes: a.notes,
          workbookRow: a.rowNumber,
          retiredAt: null,
        };
        const existing = await tx.priceBookAtomic.findUnique({ where: { itemId: a.itemId } });
        const diff = changedFields(existing as Record<string, unknown> | null, data);
        if (!args.dryRun) {
          await tx.priceBookAtomic.upsert({
            where: { itemId: a.itemId },
            create: { itemId: a.itemId, ...data },
            update: data,
          });
        }
        if (!existing) deltas.atomics.created.push(a.itemId);
        else if (diff.length) deltas.atomics.updated.push(`${a.itemId} (${diff.join(", ")})`);
        else deltas.atomics.unchanged.push(a.itemId);
      }

      // ── 4. Assemblies + components ──
      for (const asm of snapshot.assemblies) {
        const wb = snapshot.workbookComputed?.assemblies?.[asm.assemblyId] ?? null;
        const data = {
          name: asm.name,
          sector: asm.sectorColumn ?? asm.sectorTab,
          useCase: asm.useCase,
          status: asm.status,
          superseded: isSuperseded(asm.status),
          totalLaborNormal: num(wb?.totalLaborNormal),
          totalLaborFormula: asm.totalLaborNormalFormula,
          laborFormulaIsFrozen: !asm.laborFormulaReferencesAtomics,
          difficultySetting: asm.difficultySetting,
          fieldDifficulty: asm.fieldDifficulty,
          permitRequiredRaw: asm.permitRequired,
          utilityStandbyRaw: asm.utilityStandbyRequired,
          heightAccessAdderHours: asm.heightAccessAdderHours,
          ceilingHeightBand: asm.ceilingHeightBand,
          jobType: asm.jobType,
          sourcingChannel: asm.sourcingChannel,
          wbLaborHoursAdjusted: num(wb?.laborHoursAdjusted),
          wbLaborDollars: num(wb?.laborDollars),
          wbMaterialCost: num(wb?.materialCost),
          wbMaterialSell: num(wb?.materialSell),
          wbJobAdderHours: num(wb?.jobAdderHours),
          wbJobAdderDollars: num(wb?.jobAdderDollars),
          wbPermitFee: num(wb?.permitFee),
          wbTotalFlatRate: num(wb?.totalFlatRate),
          wbComponentsUnpriced: num(wb?.componentsUnpriced) === null ? null : Math.round(num(wb?.componentsUnpriced)!),
          wbMaterialComplete: str(wb?.materialComplete),
          wbTotalJobHours: num(wb?.totalJobHours),
          wbJobFixedCost: num(wb?.jobFixedCost),
          wbTotalWithFixedCost: num(wb?.totalWithFixedCost),
          necCodeRefs: asm.necCodeRefs,
          necCategory: asm.necCategory,
          pricingFlags: asm.pricingFlags,
          notes: asm.notes,
          componentProse: asm.componentProse,
          componentsTotalDeclared:
            asm.componentsTotalDeclared === null ? null : Math.round(asm.componentsTotalDeclared),
          workbookRow: asm.rowNumber,
          retiredAt: null,
        };
        const existing = await tx.priceBookAssembly.findUnique({ where: { assemblyId: asm.assemblyId } });
        const diff = changedFields(existing as Record<string, unknown> | null, data);
        if (!args.dryRun) {
          await tx.priceBookAssembly.upsert({
            where: { assemblyId: asm.assemblyId },
            create: { assemblyId: asm.assemblyId, ...data },
            update: data,
          });
          // Components are replaced wholesale: the workbook's material formula IS the
          // component list, so a removed term must disappear here too. Anything else
          // would keep re-adding what Kyle's 2026-08-09 sweep removed.
          await tx.priceBookAssemblyComponent.deleteMany({ where: { assemblyId: asm.assemblyId } });
          for (const c of asm.components) {
            await tx.priceBookAssemblyComponent.create({
              data: {
                assemblyId: asm.assemblyId,
                itemId: c.itemId,
                quantity: c.quantity,
                atomicRow: c.atomicRow,
              },
            });
          }
        }
        if (!existing) deltas.assemblies.created.push(asm.assemblyId);
        else if (diff.length) deltas.assemblies.updated.push(`${asm.assemblyId} (${diff.join(", ")})`);
        else deltas.assemblies.unchanged.push(asm.assemblyId);
      }

      // ── 5. Rate Config + NEC categories ──
      for (const [key, cell] of Object.entries(rc)) {
        const data = {
          label: cell.label,
          workbookRow: cell.row,
          numberValue: cell.number,
          textValue: cell.text,
        };
        const existing = await tx.priceBookRateConfig.findUnique({ where: { key } });
        const diff = changedFields(existing as Record<string, unknown> | null, data);
        if (!args.dryRun) {
          await tx.priceBookRateConfig.upsert({ where: { key }, create: { key, ...data }, update: data });
        }
        if (!existing) deltas.rateConfig.created.push(key);
        else if (diff.length) deltas.rateConfig.updated.push(`${key} (${diff.join(", ")})`);
        else deltas.rateConfig.unchanged.push(key);
      }

      for (const n of snapshot.necCategories) {
        const data = { title: n.title, onKyleList: n.onKyleList, scopeRule: n.scopeRule };
        const existing = await tx.priceBookNecCategory.findUnique({ where: { article: n.article } });
        const diff = changedFields(existing as Record<string, unknown> | null, data);
        if (!args.dryRun) {
          await tx.priceBookNecCategory.upsert({
            where: { article: n.article },
            create: { article: n.article, ...data },
            update: data,
          });
        }
        if (!existing) deltas.necCategories.created.push(n.article);
        else if (diff.length) deltas.necCategories.updated.push(`${n.article} (${diff.join(", ")})`);
        else deltas.necCategories.unchanged.push(n.article);
      }

      // ── 6. Retire what the workbook no longer carries. Never delete. ──
      const seenAtomics = new Set(snapshot.atomics.map((a) => a.itemId));
      const seenAssemblies = new Set(snapshot.assemblies.map((a) => a.assemblyId));
      for (const row of await tx.priceBookAtomic.findMany({ where: { retiredAt: null } })) {
        if (!seenAtomics.has(row.itemId)) {
          if (!args.dryRun) {
            await tx.priceBookAtomic.update({ where: { itemId: row.itemId }, data: { retiredAt: new Date() } });
          }
          deltas.atomics.retired.push(row.itemId);
        }
      }
      for (const row of await tx.priceBookAssembly.findMany({ where: { retiredAt: null } })) {
        if (!seenAssemblies.has(row.assemblyId)) {
          if (!args.dryRun) {
            await tx.priceBookAssembly.update({
              where: { assemblyId: row.assemblyId },
              data: { retiredAt: new Date() },
            });
          }
          deltas.assemblies.retired.push(row.assemblyId);
        }
      }
      },
      {
        // The write phase is ~600 upserts over a possibly-remote connection; the default 5s
        // interactive-transaction budget is nowhere near it. Measured production write phase is
        // well under a minute, so ten minutes is generous without being unbounded.
        timeout: 600_000,
        maxWait: 30_000,
      },
    );

    // ── 7. Parity ──
    let parityResult: ParityResult | null = null;
    if (args.parity) {
      parityResult = runParity(snapshot, atomicCost, {
        billedLaborRate,
        inspectionCoordination: rc.inspectionCoordination?.number ?? null,
        inspectionFolded: rc.inspectionFolded?.number ?? null,
        utilityStandby: rc.utilityStandby?.number ?? null,
        permitFee: rc.permitFee?.number ?? null,
        jobFixedCost: rc.jobFixedCost?.number ?? null,
        activeSupplier: activeSupplierId,
        markupTiers: tiers,
      });
    }

    const reportPath = args.report ?? null;
    const report = buildReport(snapshot, deltas, {
      billedLaborRate,
      provisional,
      provisionalReason,
      activeSupplierId,
      parity: parityResult,
      dryRun: args.dryRun,
      snapshotPath,
    });
    if (reportPath) {
      fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
      fs.writeFileSync(reportPath, report, "utf8");
      console.log(`\n[report] written: ${reportPath}`);
    } else {
      console.log("\n[report] no --report path given; delta report not written to disk.");
    }

    const parityPassed = parityResult === null ? null : parityResult.passed;
    if (run && !args.dryRun) {
      await prisma.priceBookImportRun.update({
        where: { id: run.id },
        data: {
          status: "success",
          finishedAt: new Date(),
          countsJson: JSON.stringify(
            Object.fromEntries(
              Object.entries(deltas).map(([k, d]) => [
                k,
                { created: d.created.length, updated: d.updated.length, unchanged: d.unchanged.length, retired: d.retired.length },
              ])
            )
          ),
          parityRan: args.parity,
          parityPassed,
          parityJson: parityResult ? JSON.stringify(parityResult.rows) : null,
          deltaReportPath: reportPath,
        },
      });
    }

    console.log("\n── SUMMARY ─────────────────────────────────────────────");
    for (const [k, d] of Object.entries(deltas)) {
      console.log(
        `  ${k.padEnd(16)} created=${d.created.length} updated=${d.updated.length} ` +
          `unchanged=${d.unchanged.length} retired=${d.retired.length}`
      );
    }
    console.log(`  billedLaborRate  ${billedLaborRate ?? "BLANK"}  provisional=${provisional}`);
    console.log(`  activeSupplier   ${activeSupplierId ?? "BLANK"}`);
    if (parityResult) {
      console.log(
        `  parity           ${parityResult.passed ? "PASS" : "FAIL"} ` +
          `(${parityResult.rowsPassed}/${parityResult.rowsChecked} rows to the cent)`
      );
    }
    console.log(`  elapsed          ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s`);

    if (args.parity && parityResult && !parityResult.passed) return 6;
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nFATAL: import failed — ${message}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    if (run && !args.dryRun) {
      await prisma.priceBookImportRun.update({
        where: { id: run.id },
        data: { status: "failed", finishedAt: new Date(), errorMessage: message },
      });
    }
    return 5;
  }
}

// ─── Parity ─────────────────────────────────────────────────────────────────────

interface ParityRow {
  assemblyId: string;
  field: string;
  app: number | string | null;
  workbook: number | string | null;
  delta: number | null;
  ok: boolean;
}
interface ParityResult {
  passed: boolean;
  rowsChecked: number;
  rowsPassed: number;
  mismatches: ParityRow[];
  rows: ParityRow[];
  skipped: string[];
}

const MONEY_FIELDS: Array<[string, keyof ReturnType<typeof computeAssembly>, string]> = [
  ["Labor $", "laborDollars", "laborDollars"],
  ["Material Cost $", "materialCost", "materialCost"],
  ["Material Sell $", "materialSell", "materialSell"],
  ["Job Adder $", "jobAdderDollars", "jobAdderDollars"],
  ["TOTAL FLAT RATE $", "totalFlatRate", "totalFlatRate"],
  ["TOTAL w/ Fixed Cost $", "totalWithFixedCost", "totalWithFixedCost"],
];

function runParity(
  snapshot: Snapshot,
  atomicCost: Map<string, { costBasis: number | null; sellPerUnit: number | null }>,
  rcfg: RateConfig
): ParityResult {
  const rows: ParityRow[] = [];
  const skipped: string[] = [];

  if (!snapshot.workbookComputed) {
    // No oracle, no claim. A parity "pass" with nothing to compare against would be
    // the most dangerous output this pipeline could produce.
    return {
      passed: false,
      rowsChecked: 0,
      rowsPassed: 0,
      mismatches: [],
      rows: [],
      skipped: [
        `NO WORKBOOK-COMPUTED VALUES AVAILABLE — ${snapshot.recalcError ?? "unknown reason"}. ` +
          `Parity cannot be claimed without the workbook's own numbers to compare against.`,
      ],
    };
  }

  for (const asm of snapshot.assemblies) {
    const wb = snapshot.workbookComputed.assemblies[asm.assemblyId];
    if (!wb) {
      skipped.push(`${asm.assemblyId}: no workbook-computed row`);
      continue;
    }

    // Labour hours are evaluated from the formula TEXT by the app's own parser, not
    // taken from Excel's answer. Without this the labour half of parity would be the
    // workbook checked against itself. If the formula is not pure literal arithmetic
    // the parser returns null and the row is reported unverifiable — never guessed.
    const appHours = evaluateLiteralArithmetic(asm.totalLaborNormalFormula);
    const wbHours = num(wb.totalLaborNormal);
    rows.push({
      assemblyId: asm.assemblyId,
      field: "Total Labor Normal (hr, independently evaluated)",
      app: appHours,
      workbook: wbHours,
      delta: appHours !== null && wbHours !== null ? appHours - wbHours : null,
      ok:
        appHours !== null &&
        wbHours !== null &&
        Math.abs(appHours - wbHours) < 5e-5,
    });
    if (appHours === null) {
      skipped.push(
        `${asm.assemblyId}: labour formula ${JSON.stringify(asm.totalLaborNormalFormula)} is not pure ` +
          `literal arithmetic and was not independently evaluated.`
      );
    }

    const app = computeAssembly(
      {
        assemblyId: asm.assemblyId,
        status: asm.status,
        superseded: isSuperseded(asm.status),
        // The app's own evaluation drives its arithmetic; Excel's value is only the
        // thing it is compared against.
        totalLaborNormal: appHours ?? wbHours,
        permitRequiredRaw: asm.permitRequired,
        utilityStandbyRaw: asm.utilityStandbyRequired,
        heightAccessAdderHours: asm.heightAccessAdderHours,
      },
      asm.components.map((c) => ({ itemId: c.itemId, quantity: c.quantity })),
      atomicCost,
      rcfg
    );

    for (const [label, appKey, wbKey] of MONEY_FIELDS) {
      const a = app[appKey] as number | null;
      const b = num((wb as Record<string, unknown>)[wbKey]);
      const ca = a === null ? null : Math.round(a * 100);
      const cb = b === null ? null : Math.round(b * 100);
      rows.push({
        assemblyId: asm.assemblyId,
        field: label,
        app: a,
        workbook: b,
        delta: a !== null && b !== null ? a - b : null,
        ok: ca === cb,
      });
    }

    // Not money, but the field that decides whether a number may be shown at all.
    const wbUnpriced = num(wb.componentsUnpriced);
    rows.push({
      assemblyId: asm.assemblyId,
      field: "Components Unpriced",
      app: app.componentsUnpriced,
      workbook: wbUnpriced,
      delta: wbUnpriced === null ? null : app.componentsUnpriced - wbUnpriced,
      ok: wbUnpriced !== null && app.componentsUnpriced === Math.round(wbUnpriced),
    });
    rows.push({
      assemblyId: asm.assemblyId,
      field: "Material Complete?",
      app: app.materialComplete,
      workbook: str(wb.materialComplete),
      delta: null,
      ok: app.materialComplete === str(wb.materialComplete),
    });
  }

  const mismatches = rows.filter((r) => !r.ok);
  return {
    passed: mismatches.length === 0 && rows.length > 0,
    rowsChecked: rows.length,
    rowsPassed: rows.length - mismatches.length,
    mismatches,
    rows,
    skipped,
  };
}

// ─── Delta report ───────────────────────────────────────────────────────────────

function fmt(v: number | string | null): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4);
  return v;
}

function buildReport(
  snapshot: Snapshot,
  deltas: Record<string, Delta>,
  ctx: {
    billedLaborRate: number | null;
    provisional: boolean;
    provisionalReason: string | null;
    activeSupplierId: string | null;
    parity: ParityResult | null;
    dryRun: boolean;
    snapshotPath: string;
  }
): string {
  const L: string[] = [];
  // Local date, not UTC. The Architect files these as _architect/sync/YYYY-MM-DD.md on
  // Kyle's calendar day; a UTC header would read one day ahead every evening run and
  // disagree with its own filename.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  L.push(`# Price book → app import — delta report ${today}`);
  L.push("");
  L.push(`Generated by \`scripts/price-book/importPriceBook.ts\`${ctx.dryRun ? " **(DRY RUN — nothing written)**" : ""}.`);
  L.push("");
  L.push("| | |");
  L.push("|---|---|");
  L.push(`| Workbook | \`${snapshot.workbookPath}\` |`);
  L.push(`| Workbook SHA-256 | \`${snapshot.workbookSha256}\` |`);
  L.push(`| Workbook modified | ${snapshot.workbookMtime} |`);
  L.push(`| Mapping version | ${snapshot.mappingVersion} |`);
  L.push(`| Extracted at | ${snapshot.generatedAt} |`);
  L.push(`| Active supplier (B161) | **${ctx.activeSupplierId ?? "BLANK"}** |`);
  L.push(`| Billed labour rate (B2) | **$${ctx.billedLaborRate?.toFixed(2) ?? "BLANK"}/hr** |`);
  L.push(`| Import status | ${ctx.provisional ? "⚠️ **PROVISIONAL**" : "✅ normal"} |`);
  L.push("");
  L.push("_The workbook is read-only to this pipeline. It was copied before reading and its");
  L.push("SHA-256 was identical before and after — see `readOnlyProof` in the snapshot._");
  L.push("");

  if (ctx.provisional) {
    L.push("## ⚠️ PROVISIONAL — read before using any number below");
    L.push("");
    L.push(`> ${ctx.provisionalReason}`);
    L.push("");
    L.push("The rate was imported **as found**. Nothing was overridden and $150 was not");
    L.push("hard-coded anywhere. Customer-facing quoting is blocked while this flag is set;");
    L.push("internal computation still runs so the gap is visible.");
    L.push("");
  }

  L.push("## Delta");
  L.push("");
  L.push("| Entity | Created | Updated | Unchanged | Retired |");
  L.push("|---|---:|---:|---:|---:|");
  for (const [k, d] of Object.entries(deltas)) {
    L.push(`| ${k} | ${d.created.length} | ${d.updated.length} | ${d.unchanged.length} | ${d.retired.length} |`);
  }
  L.push("");
  L.push("_Retired = present in the app, no longer in the workbook. Rows are flagged");
  L.push("`retiredAt`, never deleted (write protocol rule 5: move, never delete)._");
  L.push("");

  for (const [k, d] of Object.entries(deltas)) {
    const any = d.created.length || d.updated.length || d.retired.length;
    if (!any) continue;
    L.push(`### ${k}`);
    L.push("");
    if (d.created.length) {
      L.push(`**Created (${d.created.length}):** ${d.created.slice(0, 60).join(", ")}` + (d.created.length > 60 ? ` … +${d.created.length - 60} more` : ""));
      L.push("");
    }
    if (d.updated.length) {
      L.push(`**Updated (${d.updated.length}):**`);
      L.push("");
      for (const u of d.updated.slice(0, 80)) L.push(`- ${u}`);
      if (d.updated.length > 80) L.push(`- … +${d.updated.length - 80} more`);
      L.push("");
    }
    if (d.retired.length) {
      L.push(`**Retired (${d.retired.length}):** ${d.retired.join(", ")}`);
      L.push("");
    }
  }

  // Quotability posture — the number that decides what can actually be sold.
  const activeSupplier = ctx.activeSupplierId;
  const priced = snapshot.supplierPrices.filter(
    (p) => (p.quotableRaw ?? "").trim().toUpperCase() === "YES" && p.supplierId === activeSupplier
  ).length;
  const quarantined = snapshot.supplierPrices.filter(
    (p) => (p.quotableRaw ?? "").trim().toUpperCase() !== "YES"
  );

  L.push("## Quotability posture");
  L.push("");
  L.push(`- Atomics in the book: **${snapshot.counts.atomics}**`);
  L.push(`- Supplier price rows: **${snapshot.counts.supplierPrices}**, of which **${priced}** are quotable at the active supplier (${activeSupplier ?? "none"}).`);
  L.push(`- Quarantined rows (structurally unable to reach a quote): **${quarantined.length}**` + (quarantined.length ? ` — ${quarantined.map((q) => `${q.itemId}|${q.supplierId} (${q.quotableRaw})`).join(", ")}` : ""));
  L.push("");

  if (ctx.parity) {
    L.push("## Parity — app vs workbook, to the cent");
    L.push("");
    if (ctx.parity.skipped.length && ctx.parity.rowsChecked === 0) {
      L.push(`**NOT RUN.** ${ctx.parity.skipped.join(" ")}`);
      L.push("");
    } else {
      L.push(
        `**${ctx.parity.passed ? "PASS" : "FAIL"}** — ${ctx.parity.rowsPassed}/${ctx.parity.rowsChecked} checks agree to the cent.`
      );
      L.push("");
      if (ctx.parity.mismatches.length) {
        L.push("### Mismatches");
        L.push("");
        L.push("| Assembly | Field | App | Workbook | Δ |");
        L.push("|---|---|---:|---:|---:|");
        for (const m of ctx.parity.mismatches.slice(0, 100)) {
          L.push(`| ${m.assemblyId} | ${m.field} | ${fmt(m.app)} | ${fmt(m.workbook)} | ${fmt(m.delta)} |`);
        }
        L.push("");
      }
      L.push("### Per-assembly");
      L.push("");
      L.push("| Assembly | Labor $ | Material Sell $ | TOTAL FLAT RATE $ | Unpriced | Verdict |");
      L.push("|---|---:|---:|---:|---:|---|");
      const byAsm = new Map<string, ParityRow[]>();
      for (const r of ctx.parity.rows) {
        if (!byAsm.has(r.assemblyId)) byAsm.set(r.assemblyId, []);
        byAsm.get(r.assemblyId)!.push(r);
      }
      for (const [aid, rs] of byAsm) {
        const pick = (f: string) => rs.find((r) => r.field === f);
        const ok = rs.every((r) => r.ok);
        L.push(
          `| ${aid} | ${fmt(pick("Labor $")?.workbook ?? null)} | ${fmt(pick("Material Sell $")?.workbook ?? null)} ` +
            `| ${fmt(pick("TOTAL FLAT RATE $")?.workbook ?? null)} | ${fmt(pick("Components Unpriced")?.workbook ?? null)} ` +
            `| ${ok ? "✅ to the cent" : "❌ MISMATCH"} |`
        );
      }
      L.push("");
    }
  }

  // Findings the plan should learn — reported, never acted on.
  L.push("## Findings — reported, not acted on");
  L.push("");

  const dupes = snapshot.duplicateSupplierPrices ?? [];
  if (dupes.length) {
    L.push(
      `0. **⛔ DUPLICATE SUPPLIER PRICE ROWS (${dupes.length}) — A STALE PRICE IS DOING THE QUOTING.** ` +
        `The workbook resolves cost with \`MATCH(..., 0)\`, which returns the FIRST match, so where the ` +
        `same Item ID × Supplier appears twice the HIGHER row on the sheet prices every assembly ` +
        `drawing that atomic — regardless of which row is newer or better sourced. The import ` +
        `reproduces that behaviour exactly so the app cannot disagree with the workbook, and the ` +
        `shadowed rows are listed here rather than resolved. **Which price is right is a number, and ` +
        `numbers are Kyle's** — this pipeline will not pick one.`
    );
    L.push("");
    L.push("| Key | Quoting row | Price | Dated | Shadowed row | Price | Dated |");
    L.push("|---|---:|---:|---|---:|---:|---|");
    for (const d of dupes) {
      L.push(
        `| \`${d.key}\` | ${d.winningRow} | **$${d.winningPrice?.toFixed(2) ?? "—"}** | ${d.winningDate ?? "—"} ` +
          `| ${d.shadowedRow} | $${d.shadowedPrice?.toFixed(2) ?? "—"} | ${d.shadowedDate ?? "—"} |`
      );
    }
    L.push("");
  }

  const frozen = snapshot.assemblies.filter((a) => !a.laborFormulaReferencesAtomics).length;
  L.push(
    `1. **Assembly labour is frozen literal arithmetic on ${frozen} of ${snapshot.assemblies.length} rows.** ` +
      `No assembly labour formula references the Atomics tab, so changing an atomic's Labor Normal ` +
      `moves nothing in any assembly. Material *is* live-linked. This is the same defect class fixed ` +
      `for material on 2026-08-05, still open for labour. Not changed — the fix is a workbook edit and ` +
      `the numbers are Kyle's.`
  );
  const noCost = snapshot.atomics.length - Array.from(new Set(snapshot.supplierPrices.filter((p) => p.supplierId === activeSupplier && (p.quotableRaw ?? "").toUpperCase() === "YES").map((p) => p.itemId))).length;
  L.push(
    `2. **${noCost} of ${snapshot.counts.atomics} atomics resolve no cost basis at the active supplier.** ` +
      `Imported as NULL, never as $0. Every assembly drawing one reads INCOMPLETE and cannot be quoted.`
  );
  L.push(
    `3. **Components are read from the material-cost formula, not column E.** Column E carries ` +
      `"OUT OF THIS ROW — FIELD-MEASURED" and "WALKTHROUGH-COUNTED" blocks; parsing it would re-import ` +
      `exactly what the 2026-08-09 sweep removed.`
  );
  L.push(
    `4. **Atomics are referenced by ROW NUMBER in every assembly formula.** An inserted or deleted ` +
      `Atomics row silently repoints every assembly below it with no Excel error. The importer records ` +
      `the row number alongside the resolved Item ID and aborts if a referenced row is empty, but the ` +
      `hazard lives in the workbook, not here.`
  );
  if (snapshot.structuralNotes.length) {
    for (const n of snapshot.structuralNotes) L.push(`5. **${n}**`);
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push("_Snapshot: `" + ctx.snapshotPath + "`_");
  L.push("");
  L.push("**This report closes nothing.** A rollup row closes on the Architect's APPROVED review,");
  L.push("and live-use confirmation is Kyle's: he opens the estimator and prices one real assembly");
  L.push("against the workbook.");
  return L.join("\n");
}

main()
  .then((code) => prisma.$disconnect().then(() => process.exit(code)))
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
