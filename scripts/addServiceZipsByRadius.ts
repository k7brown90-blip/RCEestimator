/**
 * Add every ZIP within 45 miles of La Vergne (37086) to Settings → Service territories.
 *
 * Kyle, 2026-10-30: "I want all zip codes within 60 mile radius of La Vergne TN, 37086 to be
 * accepted." / "we need to search all zip codes in the 60 mile raduis and add them to the service
 * areas that it checks." Then, the same day: "Lets shorten that to 45 miles."
 *
 * The website booking chat checks the SAME list the rest of the CRM reads (CompanySetting key
 * `territories`, services/bookingChat/serviceArea.ts), so this fills that list rather than adding a
 * second rule. Every row stays editable and deletable in Settings → Service territories.
 *
 * The ZIPs: US Census Bureau 2024 Gazetteer ZCTA file (2024_Gaz_zcta_national.txt), great-circle
 * distance from the 37086 internal point (36.022237, -86.559384) to each ZCTA's internal point,
 * kept when ≤ 45 miles. 114 ZIPs. A ZCTA is the Census's ZIP area; PO-box-only ZIPs have none,
 * and nobody books service at a PO box.
 *
 * MERGE, NEVER REPLACE: a ZIP already on the list keeps its row untouched (area, jurisdiction,
 * utility and inspector notes); only missing ZIPs are added.
 *
 *   node dist/scripts/addServiceZipsByRadius.js           dry run — prints what would be added
 *   node dist/scripts/addServiceZipsByRadius.js --apply   writes it
 */

import { PrismaClient } from "@prisma/client";
import { parseJsonArray } from "../src/lib/json";

const prisma = new PrismaClient();
const SCRIPT_REV = "addServiceZipsByRadius rev 2026-10-30"; // grep target so a deploy check cannot match an older build

/** [ZIP, miles from 37086], nearest first. */
const ZIPS_WITHIN_45_MILES: Array<[string, number]> = [
  ["37086", 0], ["37167", 4.4], ["37013", 4.5], ["37217", 8.1], ["37076", 8.5], ["37129", 8.8],
  ["37211", 9.7], ["37135", 9.9], ["37014", 11.1], ["37122", 11.5], ["37214", 11.7],
  ["37027", 12.7], ["37210", 13.1], ["37204", 13.4], ["37220", 13.4], ["37067", 14],
  ["37206", 14.5], ["37138", 15.1], ["37213", 15.4], ["37203", 15.6], ["37212", 15.6],
  ["37201", 15.8], ["37238", 15.8], ["37128", 15.9], ["37215", 15.9], ["37232", 15.9],
  ["37090", 16], ["37219", 16], ["37132", 16.3], ["37216", 16.3], ["37085", 16.4], ["37130", 16.6],
  ["37208", 17.6], ["37153", 17.8], ["37115", 17.9], ["37228", 18.2], ["37046", 18.4],
  ["37205", 18.5], ["37207", 18.9], ["37060", 19.3], ["37069", 19.3], ["37127", 21.2],
  ["37118", 21.8], ["37075", 22.1], ["37218", 22.5], ["37221", 23.2], ["37087", 23.3],
  ["37189", 23.3], ["37184", 23.6], ["37064", 24], ["37209", 24.1], ["37179", 24.4],
  ["37037", 24.9], ["37072", 25.1], ["37016", 25.2], ["37149", 25.3], ["37066", 26.7],
  ["37143", 27], ["37034", 27.7], ["37180", 27.7], ["37020", 28.1], ["37174", 28.3],
  ["37031", 28.5], ["37080", 29.3], ["37012", 31.1], ["37082", 31.5], ["37073", 31.8],
  ["37190", 32], ["38547", 32], ["37062", 32.3], ["37048", 32.4], ["37188", 32.4], ["38563", 32.7],
  ["37018", 33.3], ["37095", 33.7], ["37026", 33.9], ["37151", 35], ["37015", 35.3],
  ["37074", 35.9], ["38567", 36.2], ["37022", 36.6], ["37187", 36.6], ["37059", 36.8],
  ["37146", 37.3], ["38482", 37.4], ["38401", 37.5], ["37049", 37.9], ["38476", 38.4],
  ["37030", 38.5], ["37148", 38.5], ["37091", 38.6], ["37183", 38.8], ["37160", 39.4],
  ["37029", 39.7], ["38569", 39.7], ["37172", 39.8], ["37057", 40.2], ["37035", 40.5],
  ["38560", 41.6], ["37141", 41.7], ["37036", 41.8], ["37025", 42.2], ["37032", 43.1],
  ["37098", 43.1], ["38487", 43.2], ["37145", 43.6], ["37166", 43.8], ["38552", 43.8],
  ["37186", 43.9], ["37360", 43.9], ["38548", 44.1], ["37019", 44.4], ["37355", 44.5],
  ["38582", 44.7]
];

type TerritoryRow = Record<string, unknown> & { zip?: unknown };

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(SCRIPT_REV, apply ? "(APPLY)" : "(dry run — add --apply to write)");

  const row = await prisma.companySetting.findUnique({ where: { key: "territories" } });
  const existing = parseJsonArray<TerritoryRow>(row?.valueJson);
  const have = new Set(existing.map((t) => (typeof t.zip === "string" ? t.zip.trim().slice(0, 5) : "")).filter(Boolean));

  const added = ZIPS_WITHIN_45_MILES.filter(([zip]) => !have.has(zip)).map(([zip, miles]) => ({
    zip,
    area: `Within 45 mi of La Vergne (${miles} mi)`,
    codeCycle: "",
    utilityProvider: "",
    utilityPhone: "",
    utilityEmail: "",
    utilityNotes: "",
    inspectorName: "",
    inspectorPhone: "",
    inspectorEmail: "",
    inspectorNotes: "",
  }));

  console.log(`On the list now: ${existing.length}. Within 45 miles: ${ZIPS_WITHIN_45_MILES.length}. Already listed: ${ZIPS_WITHIN_45_MILES.length - added.length}. To add: ${added.length}.`);
  if (added.length > 0) console.log(`Adding: ${added.map((a) => a.zip).join(" ")}`);

  if (!apply || added.length === 0) return;
  const valueJson = JSON.stringify([...existing, ...added]);
  await prisma.companySetting.upsert({
    where: { key: "territories" },
    create: { key: "territories", valueJson },
    update: { valueJson },
  });
  console.log(`Saved. Service territories now holds ${existing.length + added.length} ZIPs.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
