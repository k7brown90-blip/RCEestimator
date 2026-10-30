/**
 * The website booking chat's ZIP check — reads the SAME owner-editable list the rest of the CRM
 * uses: Settings → "Service territories" (CompanySetting key `territories`, valueJson = array of
 * { zip, area, jurisdictionId? }; same row jurisdictionResolver.ts:73 reads).
 *
 * FAIL OPEN, LOUDLY. If the list is empty or unreadable the chat must not turn every customer
 * away: the ZIP is treated as in-area and a warn lands in SystemEvent so Kyle can fill the list.
 */

import { prisma } from "../../lib/prisma";
import { parseJsonArray } from "../../lib/json";
import { logSystemEvent } from "../systemEvents";

interface TerritoryRow {
  zip?: unknown;
  area?: unknown;
}

export interface ServiceAreaResult {
  inArea: boolean;
  /** The territory's area name when the ZIP is on the list. */
  area: string | null;
  /** False when the territories list is empty — the answer is then "in area" by default. */
  listConfigured: boolean;
  /** The 5-digit ZIP that was checked, or null when none could be read. */
  zip: string | null;
}

/** First 5-digit ZIP in a string, or null. */
export function extractZip(text: string | null | undefined): string | null {
  if (!text) return null;
  // Prefer a ZIP at the end of the address ("..., TN 37064" / "37064-1234"), else any 5 digits.
  const tail = text.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  if (tail) return tail[1];
  const any = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  return any ? any[1] : null;
}

export async function checkServiceArea(rawZip: string | null | undefined): Promise<ServiceAreaResult> {
  const zip = extractZip(typeof rawZip === "string" ? rawZip.trim() : null);

  const row = await prisma.companySetting.findUnique({ where: { key: "territories" } });
  const entries = new Map<string, string | null>();
  for (const entry of parseJsonArray<TerritoryRow>(row?.valueJson)) {
    const z = typeof entry.zip === "string" ? entry.zip.trim().slice(0, 5) : "";
    if (z) entries.set(z, typeof entry.area === "string" && entry.area.trim() ? entry.area.trim() : null);
  }

  if (entries.size === 0) {
    logSystemEvent(
      "warn",
      "bookingChat",
      "Service territories list is empty — website booking chat is treating every ZIP as in the service area. Fill Settings → Service territories.",
      { zip },
    );
    return { inArea: true, area: null, listConfigured: false, zip };
  }

  if (!zip) return { inArea: false, area: null, listConfigured: true, zip: null };
  const hit = entries.has(zip);
  return { inArea: hit, area: hit ? entries.get(zip) ?? null : null, listConfigured: true, zip };
}

export type RecordedAddressGate =
  | { ok: true; zip: string }
  | { ok: false; code: "need_zip" | "out_of_area"; message: string };

/**
 * The gate in front of offering AND holding a time: the address recorded on the Lead must carry a
 * ZIP, and that ZIP must be in the service area. Enforced by the server, not left to the prompt —
 * Kyle, 2026-10-30, after the bot offered times for "123 mary joe martin dr" with no city or ZIP:
 * "How is it verifying the area?"
 */
export async function gateRecordedAddress(address: string | null | undefined): Promise<RecordedAddressGate> {
  const zip = extractZip(address);
  if (!zip) {
    return {
      ok: false,
      code: "need_zip",
      message: "The recorded address has no ZIP code. Ask for the city and ZIP, record the full address with update_work_order, then check_service_area.",
    };
  }
  const area = await checkServiceArea(zip);
  if (!area.inArea) {
    return { ok: false, code: "out_of_area", message: "The service address is outside the service area. Do not book; follow the out-of-scope reply." };
  }
  return { ok: true, zip };
}
