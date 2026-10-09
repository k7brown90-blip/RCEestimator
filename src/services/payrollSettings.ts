/**
 * Payroll settings — the employer cost on top of wages (Kyle, 2026-10-08, decision 10 of the
 * one-estimating-system plan, Phase 6 Unit 6D).
 *
 * Kyle: labor on a job "should be the total cost that we pay because that all comes out of the
 * field work." The wage is on the time entry (frozen rateApplied); what Red Cedar pays ON TOP of
 * the wage — employer Social Security 6.2%, Medicare 1.45%, federal and Tennessee unemployment,
 * workers' comp — is one editable number here, set by Kyle from his payroll provider. Labor at
 * total cost = wage × (1 + employerCostPercent / 100).
 *
 * Backed by CompanySetting key "payroll" (the same key-value store purchasingSettings.ts and
 * financingSettings.ts read). Stored as a PERCENT, never a fraction: 9.5 means 9.5%. A value
 * typed as 0.095 would burden labor by a tenth of a percent and quietly overstate every job's
 * profit, so the PUT REFUSES that shape (the same trap financingSettings.ts guards).
 *
 * NEVER DEFAULTED (rule 6 of timeTracking.ts, extended): until Kyle sets it, the reader returns
 * null and the commission basis says "employer cost % not set" — the same way a missing hourly
 * rate shows — never a silent 0%.
 *
 * ── WHO WRITES THIS KEY ──────────────────────────────────────────────────────────────────────
 * Exactly one path: PUT /crm/settings/payroll (app.ts), which runs `validatePayrollSettings`.
 */

import { prisma } from "../lib/prisma";
import { parseJsonObject } from "../lib/json";
import { logSystemEvent } from "./systemEvents";

export const PAYROLL_SETTINGS_KEY = "payroll";

/** Employer cost on top of wages is a percent between 0 and this. Above it is a typo. */
export const MAX_EMPLOYER_COST_PERCENT = 50;

export interface PayrollSettings {
  /** Percent on top of wages (9.5 = 9.5%); null until Kyle sets it. */
  employerCostPercent: number | null;
}

export type PayrollValidation =
  | { ok: true; value: PayrollSettings }
  | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Percent fields are held to four decimals, like the financing plan rates. */
const hasAtMostFourDecimals = (n: number) => Math.abs(n * 10_000 - Math.round(n * 10_000)) < 1e-6;

/**
 * Validate what Settings sends: `{ employerCostPercent: number | null }`. Pure — no database —
 * so the rules are testable. null (or an absent / empty field) CLEARS the value, which is honest:
 * the basis then says "not set" rather than carrying a stale number.
 */
export function validatePayrollSettings(input: unknown): PayrollValidation {
  if (!isRecord(input)) return { ok: false, errors: ["Send the payroll settings as an object."] };
  const raw = input.employerCostPercent;
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: { employerCostPercent: null } };
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return { ok: false, errors: ["Employer cost on top of wages must be a number of percent, e.g. 9.5."] };
  }
  if (n < 0) return { ok: false, errors: ["Employer cost on top of wages cannot be negative."] };
  if (n > 0 && n < 1) {
    return { ok: false, errors: [`Employer cost on top of wages is a PERCENT — type 9.5 for 9.5%, not a fraction like ${n}.`] };
  }
  if (n > MAX_EMPLOYER_COST_PERCENT) {
    return { ok: false, errors: [`Employer cost on top of wages cannot be more than ${MAX_EMPLOYER_COST_PERCENT}% — ${n} looks like a typo.`] };
  }
  if (!hasAtMostFourDecimals(n)) {
    return { ok: false, errors: ["Employer cost on top of wages takes at most four decimals."] };
  }
  return { ok: true, value: { employerCostPercent: n } };
}

/**
 * Read PER USE — never cached at process start, so a Settings change is live on the very next
 * commission quote. A missing row reads as null (not set). A garbled row also reads as null and
 * logs once per read — never a default, because 0% would understate labor on every job.
 */
export async function getEmployerCostPercent(): Promise<number | null> {
  try {
    const row = await prisma.companySetting.findUnique({ where: { key: PAYROLL_SETTINGS_KEY } });
    if (!row) return null;
    const raw = parseJsonObject<{ employerCostPercent?: unknown }>(row.valueJson);
    const checked = validatePayrollSettings(raw ?? {});
    if (checked.ok) return checked.value.employerCostPercent;
    logSystemEvent("warn", "payrollSettings", "CompanySetting.payroll has no usable employerCostPercent — treating it as not set", {
      rawValueJson: row.valueJson, errors: checked.errors,
    });
    return null;
  } catch (err) {
    logSystemEvent("error", "payrollSettings", "Failed to read CompanySetting.payroll — treating the employer cost percent as not set", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
