/**
 * Headless demo — atomic-first custom estimate engine (Phase 2.0).
 *
 * Recomposes the live job S-2026-08-11-G (100 A sub-panel feeder, Murfreesboro) line by line
 * from the atomic catalog and prints the result, then exercises the three refusal guards.
 *
 * The scenario's own recorded lines are in the workbook's `Test Scenarios` tab and in
 * projects/electrical-price-book.md. It is the right test precisely because it was priced
 * atomic-by-atomic in the field rather than from an assembly — it is the shape of job this
 * engine exists to serve, and it is already documented as being only partly atomic-backed.
 *
 * USAGE
 *   npx tsx scripts/price-book/demoAtomicEstimate.ts [--keep]
 *
 * EXIT CODES
 *   0  demo ran and every assertion about the engine's BEHAVIOUR held
 *   1  unexpected error
 *   7  a guard that should have fired did not
 *
 * Note on what "pass" means here: the demo does NOT assert that the job prices completely —
 * it cannot, and that is the finding. It asserts the engine reports the right gaps to the
 * right people and refuses to finalize. "Use is validation" — the real bar is Kyle pricing a
 * job with it.
 */

import { PrismaClient } from "@prisma/client";
import {
  addLine,
  computeDraft,
  createDraft,
  finalizeDraft,
  loadRateContext,
} from "../../src/services/atomicEstimateService";
import type { QuantitySource } from "../../src/services/atomicEstimateEngine";

const prisma = new PrismaClient();
const KEEP = process.argv.includes("--keep");

/**
 * S-2026-08-11-G as recorded, restricted to the lines that HAVE an atomic.
 *
 * The scenario's own "Assemblies Exercised" cell says it plainly:
 *   Atomic-backed:              A008, C004 (labour only), A002, A018, N004, DS006
 *   NECA-backed but NO ATOMIC:  knockout, bushing, 1-1/4 couplings/connectors/straps/LB, SER
 *   PROXY:                      25 A 2-pole on A005 labour
 *   MISSING ENTIRELY:           masonry through-bore, 408.40 EGC bar
 * plus the 2026-08-11 re-run additions TH008 (#2 THHN ×100 ft) and TH004 (#8 THHN ×100 ft).
 *
 * Recorded hours per line are carried here ONLY to compare against — they are never fed into
 * the engine. The engine computes from the atomic and the tech input alone.
 */
const SCENARIO_LINES: Array<{
  itemId: string;
  quantity: number;
  source: QuantitySource;
  label: string;
  recordedHours: number | null;
}> = [
  { itemId: "A008", quantity: 1, source: "COUNT", label: "100 A 2-pole feeder breaker", recordedHours: 0.94 },
  { itemId: "C004", quantity: 50, source: "MEASURED_LENGTH", label: "1-1/4 in. EMT, 50 ft", recordedHours: 3.1 },
  { itemId: "TH008", quantity: 100, source: "MEASURED_LENGTH", label: "#2 THHN, 100 ft", recordedHours: 1.7 },
  { itemId: "TH004", quantity: 100, source: "MEASURED_LENGTH", label: "#8 THHN, 100 ft", recordedHours: 0.9 },
  { itemId: "A002", quantity: 1, source: "COUNT", label: "100 A sub-panel (material)", recordedHours: null },
  { itemId: "A018", quantity: 1, source: "COUNT", label: "enclosure mounting labour", recordedHours: 2.2 },
  { itemId: "A005", quantity: 1, source: "COUNT", label: "25 A 2-pole breaker (proxy on A005)", recordedHours: 0.58 },
  { itemId: "N004", quantity: 30, source: "MEASURED_LENGTH", label: "10/2 NM-B, 30 ft", recordedHours: 1.2 },
  { itemId: "DS006", quantity: 1, source: "COUNT", label: "AC disconnect", recordedHours: 2.5 },
];

/**
 * Lines the scenario records with NO atomic — carried so the demo can state the shortfall.
 *
 * `hours: null` means the recorded scenario names the line but this demo does not have its
 * published figure to hand. Null is carried as null and excluded from every subtotal rather
 * than entered as 0.0 — a zero here would quietly understate the job and make the arithmetic
 * below look like it reconciled when it did not.
 */
const NO_ATOMIC_LINES: Array<{ label: string; hours: number | null }> = [
  { label: "1-1/4 in. field-cut knockout (NECA p.196)", hours: 0.3 },
  { label: "1-1/4 in. insulated bushing (NECA p.174)", hours: 0.17 },
  { label: "1-1/4 in. compression couplings x4 (NECA p.181)", hours: 0.8 },
  { label: "1-1/4 in. compression connectors x2 (NECA p.181)", hours: 0.8 },
  { label: "1-1/4 in. one-hole straps x7 (NECA p.167)", hours: 0.3 },
  { label: "1-1/4 in. LB conduit body (NECA p.182)", hours: 1.0 },
  { label: "SER 4/C #1 AL, 50 ft (NECA p.260)", hours: 3.17 },
  { label: "junction box 8x8x4 (NECA p.196)", hours: null },
  { label: "Polaris insulated multi-tap, per port (NECA p.148)", hours: null },
];

/** The scenario's own recorded total after Kyle's 2026-08-11 method clarification. */
const SCENARIO_RECORDED_TOTAL_HOURS = 23.36;

const money = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `$${v.toFixed(2)}`);
const hrs = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(4));
const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);

let guardFailures = 0;
function expect(condition: boolean, what: string) {
  if (condition) {
    console.log(`   PASS  ${what}`);
  } else {
    console.log(`   ***FAIL***  ${what}`);
    guardFailures++;
  }
}

async function main(): Promise<number> {
  const rate = await loadRateContext(prisma);
  const supplierId = rate.rc.activeSupplier ?? "HD";

  console.log("═".repeat(96));
  console.log("ATOMIC-FIRST CUSTOM ESTIMATE ENGINE — headless demo");
  console.log("═".repeat(96));
  console.log(`  supplier (tech-selected)  ${supplierId}`);
  console.log(`  billed labour rate (B2)   $${rate.rc.billedLaborRate?.toFixed(2) ?? "BLANK"}/hr`);
  console.log(`  provisional               ${rate.provisional}`);
  if (rate.provisional) console.log(`                            ${rate.provisionalReason}`);
  console.log(`  job fixed cost (B67)      ${money(rate.rc.jobFixedCost)}`);

  // ── 1. Recompose S-2026-08-11-G ──────────────────────────────────────────────
  console.log("\n" + "─".repeat(96));
  console.log("1. RECOMPOSE S-2026-08-11-G — 100 A sub-panel feeder, Murfreesboro");
  console.log("─".repeat(96));

  const draft = await createDraft(prisma, {
    title: "S-2026-08-11-G recompose — 100 A sub-panel feeder",
    supplierId,
    scenarioRef: "S-2026-08-11-G",
    jobDescription:
      "Sub-panel fed from an existing 225 A exterior main. 50 ft 1-1/4 EMT + THHN to a crawl-space " +
      "junction box on Polaris taps, then 50 ft SER to a new 100 A sub-panel; 25 A 2-pole breaker " +
      "and ~30 ft #10 to a 240 V AC disconnect.",
  });

  for (const [i, l] of SCENARIO_LINES.entries()) {
    await addLine(prisma, draft.id, {
      itemId: l.itemId,
      quantity: l.quantity,
      quantitySource: l.source,
      difficulty: "NORMAL", // Kyle 2026-08-11: NORMAL is the default; the tech raises it on observation
      note: l.label,
      sortOrder: i,
    });
  }

  const { computed } = await computeDraft(prisma, draft.id);

  console.log(
    `\n  ${pad("Atomic", 8)} ${pad("Qty", 7)} ${pad("Basis", 6)} ${pad("Hours", 9)} ${pad("Recorded", 9)} ` +
      `${pad("Labour $", 11)} ${pad("Mat sell", 10)} Status`
  );
  console.log("  " + "-".repeat(92));

  let matchedHours = 0;
  let recordedForMatched = 0;
  for (const [i, line] of computed.lines.entries()) {
    const rec = SCENARIO_LINES[i]?.recordedHours ?? null;
    let status = "ok";
    if (line.gaps.length) status = line.gaps.map((g) => g.kind).join(",");
    if (line.laborHours !== null && rec !== null) {
      matchedHours += line.laborHours;
      recordedForMatched += rec;
    }
    console.log(
      `  ${pad(line.itemId, 8)} ${pad(String(line.quantity), 7)} ${pad(line.laborUnitBasis ?? "—", 6)} ` +
        `${pad(hrs(line.laborHours), 9)} ${pad(rec === null ? "—" : rec.toFixed(4), 9)} ` +
        `${pad(money(line.laborDollars), 11)} ${pad(money(line.materialSell), 10)} ${status}`
    );
  }

  console.log("\n  ── Engine totals (computable lines only) ──");
  console.log(`     labour hours     ${hrs(computed.laborHours)}`);
  console.log(`     labour $         ${money(computed.laborDollars)}`);
  console.log(`     material cost    ${money(computed.materialCost)}`);
  console.log(`     material sell    ${money(computed.materialSell)}`);
  console.log(`     subtotal         ${money(computed.subtotal)}`);
  console.log(`     + job fixed cost ${money(computed.jobFixedCost)}`);
  console.log(`     TOTAL            ${money(computed.total)}`);
  console.log(`     completeness     ${computed.completenessSummary}`);

  console.log("\n  ── Labour reconciliation against the recorded scenario ──");
  console.log(`     computed from atomics, lines the engine could price : ${matchedHours.toFixed(4)} hr`);
  console.log(`     recorded hours for those same lines                 : ${recordedForMatched.toFixed(4)} hr`);
  const agree = Math.abs(matchedHours - recordedForMatched) < 5e-4;
  expect(agree, `every line the engine CAN compute reproduces its recorded hours exactly`);

  const blockedHours = SCENARIO_LINES.filter((l, i) => computed.lines[i]?.laborHours === null && l.recordedHours)
    .reduce((s, l) => s + (l.recordedHours ?? 0), 0);
  const knownNoAtomic = NO_ATOMIC_LINES.filter((l) => l.hours !== null);
  const unknownNoAtomic = NO_ATOMIC_LINES.filter((l) => l.hours === null);
  const noAtomicHours = knownNoAtomic.reduce((s, l) => s + (l.hours ?? 0), 0);

  console.log(`     blocked on an UNVERIFIED unit basis                 : ${blockedHours.toFixed(4)} hr`);
  console.log(
    `     recorded on lines with NO atomic at all             : ${noAtomicHours.toFixed(4)} hr ` +
      `(+ ${unknownNoAtomic.length} line(s) whose hours this demo does not hold)`
  );
  const accounted = matchedHours + blockedHours + noAtomicHours;
  console.log(`     accounted for above                                 : ${accounted.toFixed(4)} hr`);
  console.log(`     scenario total as recorded in the workbook          : ${SCENARIO_RECORDED_TOTAL_HOURS.toFixed(4)} hr`);
  console.log(
    `     UNRECONCILED                                        : ` +
      `${(SCENARIO_RECORDED_TOTAL_HOURS - accounted).toFixed(4)} hr ` +
      `— the ${unknownNoAtomic.length} line(s) above, not carried as 0.0`
  );

  console.log("\n  ── Gaps, grouped by who closes them ──");
  const byRoute = new Map<string, Set<string>>();
  for (const g of computed.gaps) {
    if (!byRoute.has(g.routesTo)) byRoute.set(g.routesTo, new Set());
    byRoute.get(g.routesTo)!.add(`${g.itemId} (${g.kind})`);
  }
  for (const [route, items] of byRoute) {
    console.log(`     ${route}: ${Array.from(items).join(", ")}`);
  }
  console.log("\n  ── Lines the scenario records with NO atomic (cannot be composed at all) ──");
  for (const l of NO_ATOMIC_LINES) {
    console.log(`     ${l.hours === null ? "  ?  " : l.hours.toFixed(2)} hr  ${l.label}`);
  }

  // ── 2. Finalize refuses ──────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(96));
  console.log("2. FINALIZE GATE — customer context");
  console.log("─".repeat(96));
  const fin = await finalizeDraft(prisma, draft.id, "customer");
  console.log(`  finalized: ${fin.finalized}`);
  if (!fin.finalized) for (const r of fin.reasons) console.log(`    • ${r}`);
  expect(!fin.finalized, "a job with unpriced material and blocked labour refuses to finalize");
  expect(
    !fin.finalized && fin.reasons.some((r) => r.includes("PROVISIONAL RATE")),
    "the PROVISIONAL customer-context gate fired"
  );
  expect(
    !fin.finalized && fin.reasons.some((r) => r.includes("No price at the selected supplier")),
    "no-fallback refusal uses the Phase 1 message shape"
  );
  expect(
    !fin.finalized && fin.reasons.some((r) => r.includes("No verified NECA labour unit basis")),
    "UNVERIFIED labour unit basis blocks rather than defaulting to E"
  );

  // ── 3. Measured-line guard ───────────────────────────────────────────────────
  console.log("\n" + "─".repeat(96));
  console.log("3. MEASURED-LINE GUARD — raceway with no measured conductor line");
  console.log("─".repeat(96));
  const bare = await createDraft(prisma, {
    title: "Guard test — EMT and terminations, no measured cable",
    supplierId,
    jobDescription: "Deliberately incomplete: buys raceway and terminations and no conductors.",
  });
  await addLine(prisma, bare.id, { itemId: "C004", quantity: 5, quantitySource: "COUNT", note: "1-1/4 EMT sticks" });
  await addLine(prisma, bare.id, { itemId: "CD007", quantity: 1, quantitySource: "COUNT", note: "4-square box" });
  const bareFin = await finalizeDraft(prisma, bare.id, "internal");
  console.log(`  finalized: ${bareFin.finalized}`);
  if (!bareFin.finalized) for (const r of bareFin.reasons) console.log(`    • ${r}`);
  expect(
    !bareFin.finalized && bareFin.reasons.some((r) => r.includes("MEASURED LINES MISSING")),
    "raceway present + zero measured-length lines refuses to finalize"
  );

  // ── 4. Difficulty is read, not scaled ────────────────────────────────────────
  console.log("\n" + "─".repeat(96));
  console.log("4. DIFFICULTY IS READ FROM THE ATOMIC, NOT SCALED FROM NORMAL");
  console.log("─".repeat(96));
  const diff = await createDraft(prisma, { title: "Difficulty demo", supplierId });
  for (const d of ["NORMAL", "DIFFICULT", "VERY_DIFFICULT"] as const) {
    await addLine(prisma, diff.id, { itemId: "A008", quantity: 1, quantitySource: "COUNT", difficulty: d, note: d });
  }
  const diffComputed = (await computeDraft(prisma, diff.id)).computed;
  for (const l of diffComputed.lines) {
    console.log(
      `  A008 ${pad(l.difficulty, 15)} published unit = ${pad(String(l.laborUnitValue), 8)} -> ${hrs(l.laborHours)} hr`
    );
  }
  const [n, d1, d2] = diffComputed.lines.map((l) => l.laborHours ?? 0);
  console.log(
    `  ratios vs NORMAL: DIFFICULT ${(d1 / n).toFixed(4)}x, VERY_DIFFICULT ${(d2 / n).toFixed(4)}x ` +
      `(published values, not 1.25/1.50 multipliers)`
  );
  expect(d1 > n && d2 > d1, "the three published columns are distinct and increasing");

  // ── 5. Composition-rules seam ────────────────────────────────────────────────
  console.log("\n" + "─".repeat(96));
  console.log("5. COMPOSITION RULES SEAM — declared not-implemented, not 'nothing required'");
  console.log("─".repeat(96));
  const { suggestCompanionLines } = await import("../../src/services/atomicEstimateEngine");
  const seam = suggestCompanionLines([]);
  console.log(`  available: ${seam.available}`);
  console.log(`  reason:    ${seam.reason}`);
  expect(seam.available === false, "the seam reports unavailable rather than returning an empty suggestion list");

  // ── cleanup ──
  if (!KEEP) {
    for (const id of [draft.id, bare.id, diff.id]) {
      await prisma.priceBookDraftEstimate.delete({ where: { id } });
    }
    console.log("\n  (demo drafts deleted; pass --keep to retain them)");
  } else {
    console.log(`\n  drafts kept: ${draft.id}, ${bare.id}, ${diff.id}`);
  }

  console.log("\n" + "═".repeat(96));
  console.log(
    guardFailures === 0
      ? "DEMO OK — every guard fired as specified."
      : `DEMO FAILED — ${guardFailures} guard(s) did not fire.`
  );
  console.log(
    "This is not sign-off. 'Use is validation' — the bar is Kyle pricing a real job with it."
  );
  console.log("═".repeat(96));
  return guardFailures === 0 ? 0 : 7;
}

main()
  .then((code) => prisma.$disconnect().then(() => process.exit(code)))
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
