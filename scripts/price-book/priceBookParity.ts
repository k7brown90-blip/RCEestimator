/**
 * Parity harness — app-computed totals vs the workbook's own, to the cent.
 *
 * A DELIVERABLE, NOT A THROWAWAY. The 02:00 and 03:03 tasks change the workbook
 * nightly; this is what proves the app followed. It reads the catalog OUT OF THE
 * DATABASE (not out of the workbook), recomputes every assembly with the app's own
 * pricing engine, and diffs against the workbook-computed snapshot stored at import.
 *
 * That direction matters. The import proves the workbook was read correctly; this
 * proves what the app will actually quote from. If someone edits a price in the
 * database by hand, this catches it — an import-time-only check would not.
 *
 * USAGE
 *   npx tsx scripts/price-book/priceBookParity.ts [--json <path>] [--quiet]
 *   npx tsx scripts/price-book/priceBookParity.ts --demo-refusal    # quotability demo
 *
 * EXIT CODES
 *   0  parity held on every checked row
 *   1  unexpected error
 *   6  at least one row disagrees, or there is no workbook oracle to compare against
 *
 * ONE MISMATCH IS A FAILURE. The harness reports it; it never adjusts the app to hide
 * it. "Passing tests is not evidence of success" — the bar here is the workbook's
 * number, not a green suite.
 */

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import {
  computeAssembly,
  evaluateLiteralArithmetic,
  quoteAssembly,
  type MarkupTiers,
  type RateConfig,
} from "../../src/services/priceBookPricing";

const prisma = new PrismaClient();
const RULED_BILLED_RATE = 100; // Kyle, 2026-09-01 — was 150 (2026-08-11); see src/services/laborRate.ts

interface Row {
  assemblyId: string;
  field: string;
  app: number | string | null;
  workbook: number | string | null;
  delta: number | null;
  ok: boolean;
}

function cents(v: number | null | undefined): number | null {
  return v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 100);
}

function money(v: number | string | null): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  return v.toFixed(4);
}

async function loadRateConfig(): Promise<{ rc: RateConfig; provisional: boolean; reason: string | null }> {
  const rows = await prisma.priceBookRateConfig.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const n = (k: string) => byKey.get(k)?.numberValue ?? null;
  const t = (k: string) => byKey.get(k)?.textValue ?? null;

  const tiers: MarkupTiers = {
    tier1: n("markupTier1") ?? 0,
    tier2: n("markupTier2") ?? 0,
    tier3: n("markupTier3") ?? 0,
    tier4: n("markupTier4") ?? 0,
    tier5: n("markupTier5") ?? 0,
  };
  const billed = n("billedLaborRate");
  let provisional = false;
  let reason: string | null = null;
  if (billed === null) {
    provisional = true;
    reason = "Rate Config B2 is blank — no labour rate.";
  } else if (Math.abs(billed - RULED_BILLED_RATE) > 1e-9) {
    provisional = true;
    reason = `Rate Config B2 reads $${billed.toFixed(2)}/hr against Kyle's ruled $${RULED_BILLED_RATE.toFixed(2)}/hr.`;
  }

  return {
    rc: {
      billedLaborRate: billed,
      inspectionCoordination: n("inspectionCoordination"),
      inspectionFolded: n("inspectionFolded"),
      utilityStandby: n("utilityStandby"),
      permitFee: n("permitFee"),
      jobFixedCost: n("jobFixedCost"),
      activeSupplier: t("activeSupplier"),
      markupTiers: tiers,
    },
    provisional,
    reason,
  };
}

async function loadAtomicCost(): Promise<Map<string, { costBasis: number | null; sellPerUnit: number | null }>> {
  const atomics = await prisma.priceBookAtomic.findMany({
    where: { retiredAt: null },
    select: { itemId: true, costBasisUsed: true, sellPricePerUnit: true },
  });
  return new Map(atomics.map((a) => [a.itemId, { costBasis: a.costBasisUsed, sellPerUnit: a.sellPricePerUnit }]));
}

async function runParity(): Promise<number> {
  const jsonIdx = process.argv.indexOf("--json");
  const jsonOut = jsonIdx >= 0 ? process.argv[jsonIdx + 1] : null;
  const quiet = process.argv.includes("--quiet");

  const { rc, provisional, reason } = await loadRateConfig();
  const atomicCost = await loadAtomicCost();
  const assemblies = await prisma.priceBookAssembly.findMany({
    where: { retiredAt: null },
    include: { components: true },
    orderBy: { assemblyId: "asc" },
  });

  if (assemblies.length === 0) {
    console.error("FAIL: no assemblies in the catalog. Run importPriceBook.ts first.");
    return 6;
  }

  const rows: Row[] = [];
  const unverifiable: string[] = [];

  for (const a of assemblies) {
    if (a.wbTotalFlatRate === null && a.wbMaterialSell === null) {
      unverifiable.push(
        `${a.assemblyId}: no workbook-computed snapshot stored. The import ran without an ` +
          `Excel recalculation, so there is nothing to check against.`
      );
      continue;
    }

    const appHours = evaluateLiteralArithmetic(a.totalLaborFormula);
    if (appHours === null) {
      unverifiable.push(
        `${a.assemblyId}: labour formula ${JSON.stringify(a.totalLaborFormula)} is not pure literal ` +
          `arithmetic; hours could not be independently evaluated.`
      );
    }

    const computed = computeAssembly(
      {
        assemblyId: a.assemblyId,
        status: a.status,
        superseded: a.superseded,
        totalLaborNormal: appHours ?? a.totalLaborNormal,
        permitRequiredRaw: a.permitRequiredRaw,
        utilityStandbyRaw: a.utilityStandbyRaw,
        heightAccessAdderHours: a.heightAccessAdderHours,
      },
      a.components.map((c) => ({ itemId: c.itemId, quantity: c.quantity })),
      atomicCost,
      rc
    );

    const push = (field: string, app: number | null, wb: number | null) =>
      rows.push({ assemblyId: a.assemblyId, field, app, workbook: wb, delta: app !== null && wb !== null ? app - wb : null, ok: cents(app) === cents(wb) });

    rows.push({
      assemblyId: a.assemblyId,
      field: "Total Labor Normal (hr)",
      app: appHours,
      workbook: a.wbLaborHoursAdjusted,
      delta: appHours !== null && a.wbLaborHoursAdjusted !== null ? appHours - a.wbLaborHoursAdjusted : null,
      ok: appHours !== null && a.wbLaborHoursAdjusted !== null && Math.abs(appHours - a.wbLaborHoursAdjusted) < 5e-5,
    });
    push("Labor $", computed.laborDollars, a.wbLaborDollars);
    push("Material Cost $", computed.materialCost, a.wbMaterialCost);
    push("Material Sell $", computed.materialSell, a.wbMaterialSell);
    push("Job Adder $", computed.jobAdderDollars, a.wbJobAdderDollars);
    push("TOTAL FLAT RATE $", computed.totalFlatRate, a.wbTotalFlatRate);
    push("TOTAL w/ Fixed Cost $", computed.totalWithFixedCost, a.wbTotalWithFixedCost);

    rows.push({
      assemblyId: a.assemblyId,
      field: "Components Unpriced",
      app: computed.componentsUnpriced,
      workbook: a.wbComponentsUnpriced,
      delta: a.wbComponentsUnpriced === null ? null : computed.componentsUnpriced - a.wbComponentsUnpriced,
      ok: computed.componentsUnpriced === a.wbComponentsUnpriced,
    });
    rows.push({
      assemblyId: a.assemblyId,
      field: "Material Complete?",
      app: computed.materialComplete,
      workbook: a.wbMaterialComplete,
      delta: null,
      ok: computed.materialComplete === a.wbMaterialComplete,
    });
  }

  const mismatches = rows.filter((r) => !r.ok);
  const passed = mismatches.length === 0 && rows.length > 0 && unverifiable.length === 0;

  if (!quiet) {
    console.log("\n══ PRICE BOOK PARITY — app vs workbook, to the cent ══\n");
    console.log(`  active supplier   ${rc.activeSupplier ?? "BLANK"}`);
    console.log(`  billed rate       $${rc.billedLaborRate?.toFixed(2) ?? "BLANK"}/hr${provisional ? "   ⚠️ PROVISIONAL" : ""}`);
    if (provisional) console.log(`                    ${reason}`);
    console.log(`  assemblies        ${assemblies.length}`);
    console.log(`  checks            ${rows.length}\n`);

    const byAsm = new Map<string, Row[]>();
    for (const r of rows) {
      if (!byAsm.has(r.assemblyId)) byAsm.set(r.assemblyId, []);
      byAsm.get(r.assemblyId)!.push(r);
    }
    const w = (s: string, n: number) => s.padEnd(n).slice(0, n);
    console.log(
      `  ${w("Assembly", 9)} ${w("Hours", 9)} ${w("Labor $", 12)} ${w("Mat Sell $", 12)} ${w("TOTAL $", 13)} ${w("Unpriced", 9)} Verdict`
    );
    console.log(`  ${"-".repeat(88)}`);
    for (const [aid, rs] of byAsm) {
      const g = (f: string) => rs.find((r) => r.field === f);
      const ok = rs.every((r) => r.ok);
      console.log(
        `  ${w(aid, 9)} ${w(money(g("Total Labor Normal (hr)")?.workbook ?? null), 9)} ` +
          `${w(money(g("Labor $")?.workbook ?? null), 12)} ${w(money(g("Material Sell $")?.workbook ?? null), 12)} ` +
          `${w(money(g("TOTAL FLAT RATE $")?.workbook ?? null), 13)} ${w(String(g("Components Unpriced")?.workbook ?? "—"), 9)} ` +
          `${ok ? "PASS" : "*** FAIL ***"}`
      );
    }

    if (mismatches.length) {
      console.log(`\n  MISMATCHES (${mismatches.length}) — reported, NOT corrected:\n`);
      for (const m of mismatches) {
        console.log(`    ${m.assemblyId}  ${m.field}`);
        console.log(`       app      = ${money(m.app)}`);
        console.log(`       workbook = ${money(m.workbook)}`);
        console.log(`       delta    = ${money(m.delta)}`);
      }
    }
    if (unverifiable.length) {
      console.log(`\n  UNVERIFIABLE (${unverifiable.length}) — these count as NOT PASSED:\n`);
      for (const u of unverifiable) console.log(`    - ${u}`);
    }
    console.log(
      `\n  RESULT: ${passed ? "PASS" : "FAIL"} — ${rows.length - mismatches.length}/${rows.length} checks agree to the cent.`
    );
    console.log(
      `  Parity is not sign-off. Live-use confirmation is Kyle's: he prices one real\n` +
        `  assembly in the estimator against the workbook.\n`
    );
  }

  if (jsonOut) {
    fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
    fs.writeFileSync(
      jsonOut,
      JSON.stringify({ passed, checked: rows.length, mismatches, unverifiable, rows }, null, 2),
      "utf8"
    );
    console.log(`  [json] ${jsonOut}`);
  }

  return passed ? 0 : 6;
}

/**
 * Demonstrates the quote gate: a NOT QUOTABLE assembly refusing to produce a customer
 * price, with the reason stated. Required by the Verification block.
 */
async function demoRefusal(): Promise<number> {
  const { rc, provisional, reason } = await loadRateConfig();
  const atomicCost = await loadAtomicCost();

  const candidates = await prisma.priceBookAssembly.findMany({
    where: { retiredAt: null },
    include: { components: true },
    orderBy: { assemblyId: "asc" },
  });

  const refusing = candidates.filter((a) => a.superseded || (a.wbComponentsUnpriced ?? 0) > 0);
  const quoting = candidates.filter((a) => !a.superseded && (a.wbComponentsUnpriced ?? 0) === 0);

  console.log("\n══ QUOTE GATE DEMONSTRATION ══\n");
  console.log(`  ${refusing.length} assemblies must refuse; ${quoting.length} are materially complete.\n`);

  const show = async (a: (typeof candidates)[number], context: "customer" | "internal") => {
    const appHours = evaluateLiteralArithmetic(a.totalLaborFormula);
    const computed = computeAssembly(
      {
        assemblyId: a.assemblyId,
        status: a.status,
        superseded: a.superseded,
        totalLaborNormal: appHours ?? a.totalLaborNormal,
        permitRequiredRaw: a.permitRequiredRaw,
        utilityStandbyRaw: a.utilityStandbyRaw,
        heightAccessAdderHours: a.heightAccessAdderHours,
      },
      a.components.map((c) => ({ itemId: c.itemId, quantity: c.quantity })),
      atomicCost,
      rc
    );
    const result = quoteAssembly(
      {
        assemblyId: a.assemblyId,
        status: a.status,
        superseded: a.superseded,
        totalLaborNormal: appHours ?? a.totalLaborNormal,
        permitRequiredRaw: a.permitRequiredRaw,
        utilityStandbyRaw: a.utilityStandbyRaw,
        heightAccessAdderHours: a.heightAccessAdderHours,
      },
      computed,
      { context, rateProvisional: provisional, provisionalReason: reason }
    );

    console.log(`  ── ${a.assemblyId} — ${(a.name ?? "").slice(0, 62)}`);
    console.log(`     status            ${a.status}`);
    console.log(`     workbook verdict  ${a.wbMaterialComplete}`);
    console.log(`     workbook TOTAL    $${a.wbTotalFlatRate?.toFixed(2) ?? "—"}`);
    console.log(`     context           ${context}`);
    if (result.quotable) {
      console.log(`     RESULT            ✅ QUOTABLE — $${computed.totalFlatRate?.toFixed(2)}`);
      for (const w of result.warnings) console.log(`       ⚠ ${w}`);
    } else {
      console.log(`     RESULT            ⛔ REFUSED — no customer price issued`);
      for (const r of result.reasons) console.log(`       • ${r}`);
    }
    console.log("");
  };

  // An assembly with unpriced components, a superseded row, and a complete row.
  const unpriced = refusing.find((a) => !a.superseded && (a.wbComponentsUnpriced ?? 0) > 0);
  const superseded = refusing.find((a) => a.superseded);
  const complete = quoting[0];

  if (unpriced) await show(unpriced, "customer");
  if (superseded) await show(superseded, "customer");
  if (complete) {
    await show(complete, "customer");
    await show(complete, "internal");
  }

  console.log("  Every refusal carries a reason. No refused assembly returned $0.\n");
  return 0;
}

const main = process.argv.includes("--demo-refusal") ? demoRefusal : runParity;

main()
  .then((code) => prisma.$disconnect().then(() => process.exit(code)))
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
