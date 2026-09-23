/**
 * Purchasing configuration — currently just the sales tax rate applied to
 * landed cost (Kyle, 2026-09-23: "Get the direct cost and apply TN tax rate.
 * This allows us to read each line and avoid miscalculation.").
 *
 * Backed by CompanySetting.purchasing — same key-value store companyProfile.ts
 * reads (prisma/schema.prisma:529), owned by the Settings UI. Stored as a
 * DECIMAL FRACTION (0.0975), never a percent (9.75) — a rate stored as 9.75
 * would multiply every landed cost by ten.
 */

import { prisma } from "../lib/prisma";
import { parseJsonObject } from "../lib/json";
import { logSystemEvent } from "./systemEvents";

/** TN state 7% + the full 2.75% local option (Kyle's choice, 2026-09-23). */
export const DEFAULT_SALES_TAX_RATE = 0.0975;

/**
 * Read PER LANDING — never cached at process start, so a Settings change is
 * live on the very next landing (Kyle: "Read it per landing, never cached at
 * process start"). A missing row, a garbled row, or a value that looks like a
 * percent instead of a fraction (>= 1) all fall back to the default rate and
 * log the fallback — never to 0, which would silently under-cost every line.
 */
export async function getSalesTaxRate(): Promise<number> {
  try {
    const row = await prisma.companySetting.findUnique({ where: { key: "purchasing" } });
    const raw = parseJsonObject<{ salesTaxRate?: unknown }>(row?.valueJson);
    const rate = raw?.salesTaxRate;
    if (typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate < 1) {
      return rate;
    }
    if (row) {
      logSystemEvent(
        "warn",
        "purchasingSettings",
        "CompanySetting.purchasing has no usable salesTaxRate (missing, non-numeric, or >= 1 — a percent stored where a fraction belongs) — falling back to the default rate",
        { rawValueJson: row.valueJson },
      );
    }
    return DEFAULT_SALES_TAX_RATE;
  } catch (err) {
    logSystemEvent(
      "error",
      "purchasingSettings",
      "Failed to read CompanySetting.purchasing — falling back to the default sales tax rate",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return DEFAULT_SALES_TAX_RATE;
  }
}
