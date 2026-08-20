/**
 * `Atomics (Kyle's Copy)` → the estimator catalog. (P030)
 *
 * Kyle, 2026-08-18: *"I want only my tab (Kyle's Copy) to be the source of truth… I want this
 * able to be ran end to end today."*
 *
 * USAGE
 *   npx tsx scripts/price-book/importKylesTab.ts --workbook "<path>" [--dry-run] [--report <path>]
 *
 * EXIT CODES
 *   0  success (or a clean dry run)
 *   1  unexpected error
 *   2  the tab's shape is not what the mapping expects
 *   3  workbook missing / unreadable
 *   4  UNCOMPUTED FORMULAS — Kyle has not opened and saved since the last edit
 *   5  PARITY FAILURE — a sell price does not equal labour x rate + material
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE FILE IS READ-ONLY. This script opens Kyle's workbook to read and never to write. It is
 * stated twice in the prompt because it is the rule that matters most: that file is his, it is
 * the source of truth, and an agent editing it is how a source of truth stops being one.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT MAKES THIS SAFE TO POINT AT PRODUCTION, all four borrowed from P018:
 *
 *   1. **It reads CACHED VALUES, never formulas.** Excel computes; this script does not. A
 *      formula with no cached value means Kyle has not saved since the edit, and that is exit 4 —
 *      never an evaluation of our own, because a number we computed is a number he did not.
 *   2. **Per-row parity, asserted before anything is written.** Every item's sell price must
 *      equal `labour x rate + companyPrice` to the cent, at each difficulty the row carries. One
 *      mismatch stops the whole import. A catalog that is 225 right and 1 wrong is worse than no
 *      catalog, because the wrong one is the one that quotes.
 *   3. **One transaction.** Insert-or-update the 226, retire everything else, or change nothing.
 *   4. **Idempotent.** Keys derive from names, so the same sheet imports to the same rows. An
 *      immediate re-run reports zero changes.
 *
 * RETIRE, NEVER DELETE. The outgoing 323-row catalog is flagged `retiredAt`, which drops it out
 * of browse, search and AI proposal while leaving every foreign key intact — the two legacy
 * drafts still resolve their lines, and every issued estimate keeps its frozen snapshot.
 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

import { checkParity, slugify, toNum, unitFromName, type KyleItem, type ParityRow } from "./kylesTabMapping";

const TAB = "Atomics (Kyle's Copy)";
const SOURCE = "kyles-tab";
/**
 * A sanity FLOOR, not an expected count.
 *
 * This used to assert exactly 226 items / 34 sections, which tripped the moment Kyle legitimately
 * edited his own book — and he edits it constantly. A count that changes is normal; a count that
 * collapses means the tab was misread. The real structural guard is the header check below.
 */
const MIN_ITEMS = 150;

const prisma = new PrismaClient();

interface Args {
  workbook: string | null;
  dryRun: boolean;
  report: string | null;
  emitJson: string | null;
  fromJson: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const fromJson = get("--from-json");
  const workbook = get("--workbook");
  if (!workbook && !fromJson) {
    console.error("FATAL: --workbook is required. This pipeline never guesses which file is the source.");
    process.exit(3);
  }
  return {
    workbook,
    dryRun: argv.includes("--dry-run"),
    report: get("--report"),
    emitJson: get("--emit-json"),
    fromJson,
  };
}

/**
 * ── WHY THE IMPORT COMES APART IN THE MIDDLE ───────────────────────────────────────────────────
 *
 * The two halves of this script need to run in two different places, and until 2026-08-19 they
 * could not:
 *
 *   * READING needs Kyle's workbook, which lives on his machine and never leaves it.
 *   * WRITING needs the production database, which listens on `postgres.railway.internal` — a
 *     private network address that resolves only inside the Railway container. `railway run`
 *     injects the variable but cannot reach the host, and `railway ssh` reaches the host but has
 *     no workbook and does not accept piped stdin.
 *
 * So `--emit-json` runs the three gates and writes a verified PAYLOAD; `--from-json` takes that
 * payload and does the write, wherever it happens to be running.
 *
 * THE PAYLOAD IS NOT TRUSTED. `--from-json` re-runs the duplicate-key gate and RE-COMPUTES PARITY
 * from the item rows themselves, rather than believing the "0 failures" recorded in the file. A
 * hand-edited or truncated payload therefore fails the same way a bad workbook would. The only
 * thing taken on trust is the one fact that cannot be rechecked without the file — that Excel had
 * computed every formula — and that is recorded in `meta` so the report can say where it came
 * from.
 */
interface Payload {
  meta: {
    workbook: string;
    sha256: string;
    tab: string;
    generatedAt: string;
    itemCount: number;
    sectionCount: number;
    parityCells: number;
    parityFailures: number;
    uncomputedCells: number;
  };
  items: KyleItem[];
  sections: string[];
  unpriced: UnpricedItem[];
}

// ─── Extraction ─────────────────────────────────────────────────────────────────

/**
 * Read the tab via a short Python helper, because openpyxl is the toolchain that already reads
 * these workbooks in this repo and reimplementing xlsx parsing in TypeScript to save one process
 * would be a second answer to a solved problem.
 */
export interface UnpricedItem { row: number; name: string; section: string | null }

function readTab(workbook: string): { items: KyleItem[]; sections: string[]; uncomputed: string[]; unpriced: UnpricedItem[] } {
  const script = path.join(__dirname, "extract_kyles_tab.py");
  const res = spawnSync("python", [script, workbook, TAB], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) {
    console.error(`FATAL: could not run the extractor: ${res.error.message}`);
    process.exit(3);
  }
  if (res.status !== 0) {
    if (res.stderr) process.stderr.write(res.stderr);
    process.exit(res.status === 2 ? 2 : 3);
  }

  const raw = JSON.parse(res.stdout) as {
    rows: Array<{ row: number; name: string; section: string | null; cells: (string | number | null)[]; unit?: string | null; sellFormulas: (string | null)[] }>;
    uncomputed: string[];
    sections: string[];
    unpriced?: UnpricedItem[];
  };

  const items: KyleItem[] = [];
  for (const r of raw.rows) {
    const c = r.cells.map(toNum);
    items.push({
      key: slugify(r.name),
      name: r.name,
      section: r.section ?? "UNSECTIONED",
      /*
        ── THE UNIT COMES FROM COLUMN J (Kyle, 2026-08-20) ─────────────────────────────────────

        "I want the column in because I do not want 'per foot' or 'each' in the customer facing
         pdf."

        It used to be parsed out of the item NAME — "NM-B 12/3 w/Grd — per ft" — which put the
        unit into the one string a customer reads. He stripped those suffixes from his names for
        exactly that reason, and the parse has been returning null for almost every row ever
        since, which is why `unit` has been null across the whole catalog and
        `isContinuousLength` false for everything.

        A column keeps the unit where it belongs: available for ordering, for the entry screen and
        for the company copy, and structurally unable to reach a customer document.

        The name parse stays as a fallback for the four rows that still carry a suffix.
      */
      unitLabel: (r.unit ?? "").trim() || unitFromName(r.name),
      laborNormal: c[0], laborDifficult: c[1], laborVeryDifficult: c[2],
      companyCost: c[3], companyPrice: c[4],
      sellNormal: c[5], sellDifficult: c[6], sellVeryDifficult: c[7],
      sellFormulas: [r.sellFormulas?.[0] ?? null, r.sellFormulas?.[1] ?? null, r.sellFormulas?.[2] ?? null],
      row: r.row,
    });
  }
  return { items, sections: raw.sections, uncomputed: raw.uncomputed, unpriced: raw.unpriced ?? [] };
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  let items: KyleItem[];
  let sections: string[];
  let uncomputed: string[];
  let unpriced: UnpricedItem[];

  if (args.fromJson) {
    if (!fs.existsSync(args.fromJson)) {
      console.error(`FATAL: payload not found: ${args.fromJson}`);
      return 3;
    }
    const payload = JSON.parse(fs.readFileSync(args.fromJson, "utf8")) as Payload;
    console.log(`source : ${payload.meta.workbook}  (payload)`);
    console.log(`sha256 : ${payload.meta.sha256}`);
    console.log(`read at: ${payload.meta.generatedAt}`);
    console.log(`tab    : ${payload.meta.tab}`);
    console.log(`mode   : ${args.dryRun ? "DRY RUN — nothing will be written" : "LIVE"}`);
    items = payload.items;
    sections = payload.sections;
    unpriced = payload.unpriced ?? [];
    // Recorded, not rechecked — it is a fact about the workbook, which is not here.
    uncomputed = payload.meta.uncomputedCells > 0
      ? [`payload recorded ${payload.meta.uncomputedCells} uncomputed cell(s)`]
      : [];
    if (items.length !== payload.meta.itemCount) {
      console.error(`
⛔ FATAL: payload says ${payload.meta.itemCount} items but carries ${items.length}.`);
      return 2;
    }
  } else {
    const workbook = args.workbook as string;
    if (!fs.existsSync(workbook)) {
      console.error(`FATAL: workbook not found: ${workbook}`);
      return 3;
    }
    console.log(`source : ${path.basename(workbook)}`);
    console.log(`tab    : ${TAB}`);
    console.log(`mode   : ${args.emitJson ? "EXTRACT ONLY — no database access" : args.dryRun ? "DRY RUN — nothing will be written" : "LIVE"}`);
    ({ items, sections, uncomputed, unpriced } = readTab(workbook));
  }

  // ── Gate 1: Excel must have computed. We never evaluate a formula ourselves. ──
  if (uncomputed.length > 0) {
    console.error(`\n⛔ FATAL: ${uncomputed.length} cell(s) hold a formula with no computed value.`);
    console.error("   Kyle must open the workbook in Excel and save once, so the numbers compute.");
    console.error("   This script will not evaluate them — a number we computed is a number he did not.\n");
    for (const u of uncomputed.slice(0, 20)) console.error(`     ${u}`);
    return 4;
  }

  console.log(`\nread   : ${items.length} items across ${sections.length} sections`);

  // -- Gate 0: the floor. --
  //
  // MIN_ITEMS was declared with a paragraph explaining its purpose and then never consulted, so
  // the "sanity floor" that comment described did not exist. It matters now that a PAYLOAD can be
  // the input: a truncated file, or a tab misread into a handful of rows, would sail through
  // parity (nothing is wrong with the rows that survived) and retire the entire catalog on the
  // strength of them.
  if (items.length < MIN_ITEMS) {
    console.error(`\n[FATAL] only ${items.length} items - below the floor of ${MIN_ITEMS}.`);
    console.error("   A catalog this small means the source was misread or truncated, not that");
    console.error("   Kyle deleted three quarters of his price book. Nothing was written.\n");
    return 2;
  }

  // ── Gate 2: keys must be unique, or one item would overwrite another ──
  const byKey = new Map<string, KyleItem[]>();
  for (const it of items) {
    const list = byKey.get(it.key);
    if (list) list.push(it); else byKey.set(it.key, [it]);
  }
  const dupes = [...byKey.entries()].filter(([, v]) => v.length > 1);
  if (dupes.length > 0) {
    console.error(`\n⛔ FATAL: ${dupes.length} duplicate key(s) — two items would collide.`);
    for (const [k, v] of dupes) {
      console.error(`   ${k}`);
      for (const it of v) console.error(`      row ${it.row}  ${it.name}`);
    }
    return 2;
  }

  // ── Gate 3: parity, per row, to the cent ──
  const { rows: parity, failures } = checkParity(items);
  console.log(`parity : ${parity.length} price cells checked, ${failures.length} failure(s)`);
  if (failures.length > 0) {
    console.error("\n⛔ FATAL: parity failed. Nothing was written.\n");
    for (const f of failures.slice(0, 30)) {
      console.error(
        `   row ${String(f.row).padStart(4)} ${f.name.slice(0, 46).padEnd(48)} ${f.tag.padEnd(3)} ` +
          `shape=${f.shape} labour=${f.labor} material=${f.material} sell=${f.sell} expected=${f.expected}`
      );
    }
    return 5;
  }

  // ── Extract-only: hand the verified rows on, and touch no database ──
  //
  // Everything above this line is the SAME code path the direct import runs — the gates are not
  // skipped or weakened to produce a payload. What gets written out is what already passed them.
  if (args.emitJson) {
    const workbook = args.workbook as string;
    const payload: Payload = {
      meta: {
        workbook: path.basename(workbook),
        sha256: createHash("sha256").update(fs.readFileSync(workbook)).digest("hex"),
        tab: TAB,
        generatedAt: new Date().toISOString(),
        itemCount: items.length,
        sectionCount: sections.length,
        parityCells: parity.length,
        parityFailures: failures.length,
        uncomputedCells: uncomputed.length,
      },
      items,
      sections,
      unpriced,
    };
    fs.writeFileSync(args.emitJson, JSON.stringify(payload, null, 2));
    console.log(`
EXTRACTED -> ${args.emitJson}`);
    console.log(`   ${items.length} items, ${sections.length} sections, parity clean, keys unique.`);
    console.log("   Run the write with:  --from-json <that file>");
    printSummary(items, sections);
    return 0;
  }

  // ── Write ──
  const existingKyle = await prisma.priceBookAtomic.findMany({
    where: { source: SOURCE },
    select: { itemId: true },
  });
  const existingKeys = new Set(existingKyle.map((r) => r.itemId));
  const incomingKeys = new Set(items.map((i) => i.key));

  const toRetire = await prisma.priceBookAtomic.count({
    where: { retiredAt: null, itemId: { notIn: [...incomingKeys] } },
  });

  console.log(`\nplan   : ${items.length - [...incomingKeys].filter((k) => existingKeys.has(k)).length} new, ` +
    `${[...incomingKeys].filter((k) => existingKeys.has(k)).length} updated, ${toRetire} retired`);

  if (args.dryRun) {
    console.log("\nDRY RUN — no writes. Parity clean, keys unique, shape as expected.");
    printSummary(items, sections);
    return 0;
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const it of items) {
      const data = {
        description: it.name,
        category: it.section,
        source: SOURCE,
        unit: it.unitLabel?.replace(/^per\s+/, "") ?? null,
        unitLabel: it.unitLabel,
        rowType:
          it.companyPrice === null ? "LABOR ONLY"
          : (it.laborNormal ?? 0) === 0 ? "MATERIAL ONLY"
          : "MATERIAL + LABOR",
        laborNormal: it.laborNormal,
        laborDifficult: it.laborDifficult,
        laborVeryDifficult: it.laborVeryDifficult,
        // Kyle's hours are already per-unit and resolved, so the E/C/M question does not arise.
        // Written as E / divisor 1 so any hours-based reader stays arithmetically correct.
        laborUnitBasis: "E",
        laborUnitDivisor: 1,
        laborUnitBasisRaw: "E [Kyle's tab — per-unit hours, already resolved]",
        laborStatus: "KYLE",
        companyCost: it.companyCost,
        companyPrice: it.companyPrice,
        sellNormal: it.sellNormal,
        sellDifficult: it.sellDifficult,
        sellVeryDifficult: it.sellVeryDifficult,
        // The engine's legacy cost/sell fields, kept consistent for anything still reading them.
        costBasisUsed: it.companyCost,
        sellPricePerUnit: it.companyPrice,
        workbookRow: it.row,
        retiredAt: null,
      };
      await tx.priceBookAtomic.upsert({
        where: { itemId: it.key },
        create: { itemId: it.key, ...data },
        update: data,
      });
    }

    // Retire everything that is not in Kyle's tab. Flag, never DELETE — the two legacy drafts
    // and every issued estimate keep their foreign keys.
    await tx.priceBookAtomic.updateMany({
      where: { retiredAt: null, itemId: { notIn: [...incomingKeys] } },
      data: { retiredAt: now },
    });
  }, { timeout: 120_000 });

  const live = await prisma.priceBookAtomic.count({ where: { retiredAt: null } });
  const retired = await prisma.priceBookAtomic.count({ where: { retiredAt: { not: null } } });
  console.log(`\ndone   : ${live} live items, ${retired} retired`);

  printSummary(items, sections);

  if (args.report) {
    fs.writeFileSync(args.report, buildReport(items, sections, parity), "utf8");
    console.log(`report : ${args.report}`);
  }
  return 0;
}

function printSummary(items: KyleItem[], sections: string[]) {
  console.log(`\nsections (${sections.length}):`);
  for (const s of sections) {
    const n = items.filter((i) => i.section === s).length;
    console.log(`   ${String(n).padStart(3)}  ${s}`);
  }
  const named = items.filter((i) => /diagnostic|permit/i.test(i.name));
  console.log("\nthe two rows Kyle named:");
  for (const i of named) {
    console.log(`   ${i.key}`);
    console.log(`     ${i.name}`);
    console.log(`     N=$${i.sellNormal} D=$${i.sellDifficult} VD=$${i.sellVeryDifficult}`);
  }
}

function buildReport(items: KyleItem[], sections: string[], parity: ParityRow[]): string {
  const L: string[] = [];
  L.push(`# Kyle's tab import — ${new Date().toISOString()}`);
  L.push("");
  L.push(`- items: ${items.length}`);
  L.push(`- sections: ${sections.length}`);
  L.push(`- parity cells checked: ${parity.length}, failures: ${parity.filter((p) => !p.ok).length}`);
  L.push("");
  L.push("| key | section | unit | sell N | sell D | sell VD |");
  L.push("|---|---|---|---|---|---|");
  for (const i of items) {
    L.push(`| ${i.key} | ${i.section} | ${i.unitLabel ?? ""} | ${i.sellNormal ?? ""} | ${i.sellDifficult ?? ""} | ${i.sellVeryDifficult ?? ""} |`);
  }
  return L.join("\n");
}

main()
  .then((code) => prisma.$disconnect().then(() => process.exit(code)))
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
