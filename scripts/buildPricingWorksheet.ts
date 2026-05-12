/**
 * Catalog Pricing Worksheet Generator
 *
 * Scans the three CSV catalogs (new_work, old_work, service) for any row that
 * is still flagged "PRICE TBD" or carries a baseMaterialCost of $0.00 while
 * representing a real material/labor item (TRIM-*, DIAG-*, etc).
 *
 * Output: `app/PRICING-WORKSHEET.md` — a markdown table grouped by catalog +
 * code prefix. Fill the "Landed Cost (USD)" column with real contractor-cost
 * numbers, then propagate values back into the CSVs and re-run
 * `npx tsx scripts/seedAtomicUnits.ts` to apply.
 *
 * Run: `cd app && npx tsx scripts/buildPricingWorksheet.ts`
 */

import fs from "node:fs";
import path from "node:path";

type Row = {
  catalog: string;
  category: string;
  code: string;
  name: string;
  unitType: string;
  laborHrs: string;
  materialCost: string;
  description: string;
};

const CATALOGS = [
  { file: "new_work_catalog.csv", label: "new_work" },
  { file: "old_work_catalog.csv", label: "old_work" },
  { file: "service_catalog.csv", label: "service" },
];

const APP_DIR = path.resolve(__dirname, "..");

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

const tbdRows: Row[] = [];

for (const { file, label } of CATALOGS) {
  const fullPath = path.join(APP_DIR, file);
  if (!fs.existsSync(fullPath)) continue;
  const lines = fs.readFileSync(fullPath, "utf8").split(/\r?\n/);
  // First line is header. Skip blank lines.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    // Expected: category, code, name, unitType, laborHrs, materialCost, description
    if (cols.length < 7) continue;
    const [category, code, name, unitType, laborHrs, materialCost, description] = cols;
    const matFloat = parseFloat(materialCost);
    const isTBD = /PRICE TBD/i.test(description);
    const isZero = !Number.isNaN(matFloat) && matFloat === 0;
    if (isTBD || (isZero && /^(TRIM|DIAG)/.test(code))) {
      tbdRows.push({
        catalog: label,
        category,
        code,
        name,
        unitType,
        laborHrs,
        materialCost,
        description,
      });
    }
  }
}

// Group rows by catalog -> code prefix
const grouped: Record<string, Record<string, Row[]>> = {};
for (const row of tbdRows) {
  const prefix = row.code.split("-")[0] + (row.code.includes("-ASD") ? "-ASD" : "");
  grouped[row.catalog] ??= {};
  grouped[row.catalog][prefix] ??= [];
  grouped[row.catalog][prefix].push(row);
}

const md: string[] = [];
md.push("# Red Cedar Electric — Catalog Pricing Worksheet");
md.push("");
md.push(`_Auto-generated ${new Date().toISOString().split("T")[0]} by \`scripts/buildPricingWorksheet.ts\`. ${tbdRows.length} row(s) need landed costs._`);
md.push("");
md.push("## How to use");
md.push("");
md.push("1. Fill the **Landed Cost (USD)** column with your real contractor-cost numbers (per-unit, contractor pack basis where applicable).");
md.push("2. Propagate the values back into the source CSV in `app/<catalog>_catalog.csv` — column 6 (`materialCost`).");
md.push("3. Remove the trailing `PRICE TBD.` token from the description column.");
md.push("4. Re-run the seed: `cd app && npx tsx scripts/seedAtomicUnits.ts`. The seed will refuse to complete while any `PRICE TBD` row remains active.");
md.push("5. After seeding, run `scripts/refreshDraftItemSnapshots.ts` to backfill `EstimateItem.materialCost` on any draft/review estimates that already reference these codes.");
md.push("");
md.push("Notes:");
md.push("- TRIM-D## and TRIM-T## entries duplicate across `new_work` and `old_work`. Price both rows with the same per-unit cost — labor differs, material does not.");
md.push("- TRIM-ASD## fixtures are contractor-provided by ASD Lighting. Use the per-unit cost out of the carton (case price ÷ qty).");
md.push("- DIAG-001 is the diagnostic hourly billable rate — enter the full billable rate (not landed cost).");
md.push("");

for (const catalog of Object.keys(grouped).sort()) {
  md.push(`## ${catalog}`);
  md.push("");
  for (const prefix of Object.keys(grouped[catalog]).sort()) {
    md.push(`### ${prefix}`);
    md.push("");
    md.push("| Code | Name | Unit | Labor (hrs) | Landed Cost (USD) | Source / Reference |");
    md.push("|------|------|------|-------------|-------------------|---------------------|");
    for (const row of grouped[catalog][prefix].sort((a, b) => a.code.localeCompare(b.code))) {
      // Strip the PRICE TBD trailer for legibility
      const refOnly = row.description.replace(/\s*PRICE TBD\.?\s*$/i, "").trim();
      md.push(
        `| \`${row.code}\` | ${row.name} | ${row.unitType} | ${row.laborHrs} | _$ TBD_ | ${refOnly} |`
      );
    }
    md.push("");
  }
}

const outPath = path.join(APP_DIR, "PRICING-WORKSHEET.md");
fs.writeFileSync(outPath, md.join("\n"), "utf8");
console.log(`Wrote ${tbdRows.length} rows to ${outPath}`);
