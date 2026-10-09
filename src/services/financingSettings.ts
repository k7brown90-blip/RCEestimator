/**
 * The Synchrony plan list - Settings "Financing plans (Synchrony)" (2026-10-08, one-estimating-system
 * plan, Phase 5 / Detail B build audit B and D).
 *
 * Kyle, 2026-10-08: the plan list is editable "because Synchrony changes rates. Nothing hardcoded."
 * Backed by CompanySetting key "financingPlans" (same key-value store purchasingSettings.ts reads),
 * stored as an array of plans exactly as `FinancingPlan` (shared/financing.ts) - PERCENTS, never
 * fractions: 6.1 means 6.1%. A rate typed as 0.061 would make the financing fee a hundredth of what
 * it should be and the estimate would quietly under-charge, so the PUT REFUSES that shape (the same
 * trap purchasingSettings.ts guards from the other side: a percent stored where a fraction belongs).
 *
 * Until Kyle saves the list, `DEFAULT_FINANCING_PLANS` (his four plans, 965/964/920/924, with
 * Synchrony's text verbatim) is what the app reads - "seeded", with nothing written to the database.
 *
 * ── WHO WRITES THIS KEY ─────────────────────────────────────────────────────────────────────────
 * Exactly one path: PUT /crm/settings/financingPlans (app.ts), which runs `validateFinancingPlans`
 * below. companySetting.upsert is called in two other places (that same generic route for the
 * OTHER keys, and treasury.ts for "treasury"); neither can reach this key.
 *
 * ── RATES ARE RED CEDAR'S COST ──────────────────────────────────────────────────────────────────
 * `getFinancingPlans` returns full plans WITH `discountRatePct`; call it from server code and the
 * Settings route only. Anything that leaves the server for a customer or a technician goes through
 * `planView` / `buildQuoteFinancing` (shared/financing.ts), which carry no rate.
 */

import { prisma } from "../lib/prisma";
import { parseJsonObject } from "../lib/json";
import {
  FINANCING_PLAN_TYPES,
  orderedPlans,
  type FinancingPlan,
  type FinancingPlanType,
} from "../../shared/financing";
import { DEFAULT_FINANCING_PLANS } from "./financingPlanDefaults";
import { logSystemEvent } from "./systemEvents";

export const FINANCING_PLANS_KEY = "financingPlans";

/** A customer-facing list this long is a data-entry mistake, not a lender's menu. */
export const MAX_FINANCING_PLANS = 12;

const MAX_DISCLOSURE_PART = 8000;

/** Percent fields are held to four decimals (the calculator scales by 10,000). */
const hasAtMostFourDecimals = (n: number) => Math.abs(n * 10_000 - Math.round(n * 10_000)) < 1e-6;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type PlanValidation =
  | { ok: true; plans: FinancingPlan[] }
  | { ok: false; errors: string[] };

/**
 * Validate and normalise a plan list typed into Settings. Accepts the array, or `{ plans: [...] }`.
 * Returns the plans in display order with sortOrder renumbered 1..n, or every problem found in
 * words Kyle can act on (each names the plan). Pure - no database - so the rules are testable.
 *
 * Rules, each there because the opposite is a wrong number in front of a customer:
 * - rates are PERCENTS: a Synchrony discount rate must be 0, or at least 1 (reject 0.061-style),
 *   and at most 40; a payment factor between 0.1 and 10 (reject 0.0175); an APR between 1 and 60;
 * - at most four decimals on any percent;
 * - an ACTIVE plan carries all three disclosure texts: credit terms are never shown without the
 *   lender's own words beside them (constants.md "Credit terms in customer copy");
 * - plan numbers unique (a duplicate would make "Plan 965" mean two things).
 */
export function validateFinancingPlans(input: unknown): PlanValidation {
  const list = Array.isArray(input) ? input : isRecord(input) && Array.isArray(input.plans) ? input.plans : null;
  if (list === null) {
    return { ok: false, errors: ["Send the plan list as an array of plans."] };
  }
  if (list.length > MAX_FINANCING_PLANS) {
    return { ok: false, errors: [`At most ${MAX_FINANCING_PLANS} plans - this list has ${list.length}.`] };
  }

  const errors: string[] = [];
  const plans: FinancingPlan[] = [];
  const seen = new Set<string>();

  list.forEach((raw, index) => {
    const where = isRecord(raw) && typeof raw.planNumber === "string" && raw.planNumber.trim()
      ? `Plan ${raw.planNumber.trim()}`
      : `Plan #${index + 1}`;
    const bad = (msg: string) => errors.push(`${where}: ${msg}`);
    if (!isRecord(raw)) { bad("is not a plan."); return; }

    const planNumber = typeof raw.planNumber === "string" ? raw.planNumber.trim() : "";
    if (!planNumber) bad("needs a plan number.");
    else if (planNumber.length > 12) bad("plan number is too long (12 characters at most).");
    // Letters, digits and hyphens only: the customer page finds a plan's card with a selector built from
    // this value, and a quote or backslash in it would make that throw and freeze every figure on the
    // page (review finding, 2026-10-08). Synchrony's own plan numbers are digits.
    else if (!/^[A-Za-z0-9-]+$/.test(planNumber)) bad("plan number may use only letters, numbers and hyphens.");
    else if (seen.has(planNumber)) bad("this plan number is listed twice.");
    seen.add(planNumber);

    const type = raw.type as FinancingPlanType;
    if (!FINANCING_PLAN_TYPES.includes(type)) bad('type must be "reduced_apr" or "deferred_interest".');

    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    if (!description) bad("needs a description (what the customer reads on the card).");
    else if (description.length > 200) bad("description is too long (200 characters at most).");

    const months = raw.months;
    if (typeof months !== "number" || !Number.isInteger(months) || months < 1 || months > 120) {
      bad("months must be a whole number from 1 to 120.");
    }

    const pct = (value: unknown, label: string, min: number, max: number, allowZero: boolean, example: string): number | null => {
      if (typeof value !== "number" || !Number.isFinite(value)) { bad(`${label} must be a number.`); return null; }
      if (!hasAtMostFourDecimals(value)) { bad(`${label} can have at most four decimal places.`); return null; }
      if (allowZero && value === 0) return value;
      if (value < min) {
        bad(`${label} is ${value} - that looks like a fraction. Type it as a percent (for example ${example}).`);
        return null;
      }
      if (value > max) { bad(`${label} cannot be more than ${max}.`); return null; }
      return value;
    };

    let apr: number | null = null;
    if (type === "reduced_apr") apr = pct(raw.apr, "APR", 1, 60, false, "10.99");

    const paymentFactorPct = pct(raw.paymentFactorPct, "Payment factor", 0.1, 10, false, "1.75");
    const discountRatePct = pct(raw.discountRatePct, "Discount rate", 1, 40, true, "6.1");

    const active = raw.active === true;
    if (typeof raw.active !== "boolean") bad("on/off must be true or false.");

    const sortOrder = typeof raw.sortOrder === "number" && Number.isFinite(raw.sortOrder) ? raw.sortOrder : index + 1;

    const d = isRecord(raw.disclosure) ? raw.disclosure : {};
    const part = (v: unknown, label: string): string => {
      if (typeof v !== "string") { return ""; }
      if (v.length > MAX_DISCLOSURE_PART) bad(`${label} is too long (${MAX_DISCLOSURE_PART} characters at most).`);
      return v;
    };
    // Stored AS PASTED - no trim, no rewrap: "never paraphrased, never trimmed" (constants.md).
    const disclosure = {
      explanation: part(d.explanation, "Disclosure explanation"),
      important: part(d.important, "Disclosure IMPORTANT line"),
      terms: part(d.terms, "Disclosure terms"),
    };
    if (active) {
      if (!disclosure.explanation.trim()) bad("is turned on but has no disclosure explanation - paste Synchrony's text, or turn the plan off.");
      if (!disclosure.important.trim()) bad("is turned on but has no disclosure IMPORTANT line - paste Synchrony's text, or turn the plan off.");
      if (!disclosure.terms.trim()) bad("is turned on but has no disclosure terms - paste Synchrony's text, or turn the plan off.");
    }

    if (paymentFactorPct === null || discountRatePct === null) return;
    plans.push({
      planNumber,
      type,
      description,
      months: months as number,
      apr: type === "reduced_apr" ? apr : null,
      paymentFactorPct,
      discountRatePct,
      active,
      sortOrder,
      disclosure,
    });
  });

  if (errors.length > 0) return { ok: false, errors };
  const ordered = orderedPlans(plans).map((p, i) => ({ ...p, sortOrder: i + 1 }));
  return { ok: true, plans: ordered };
}

/**
 * The plan list in force, ALL plans (active or not), in display order. Read per call - a Settings
 * change is live on the very next estimate. Absent row -> the seeded defaults. A garbled or invalid
 * row falls back to the defaults and says so in the system log, never to an empty list that would
 * quietly hide financing from every customer.
 */
export async function getFinancingPlans(): Promise<FinancingPlan[]> {
  try {
    const row = await prisma.companySetting.findUnique({ where: { key: FINANCING_PLANS_KEY } });
    if (!row) return orderedPlans([...DEFAULT_FINANCING_PLANS]);
    let parsed: unknown = null;
    try { parsed = JSON.parse(row.valueJson); } catch { parsed = null; }
    const checked = validateFinancingPlans(parsed);
    if (checked.ok) return checked.plans;
    logSystemEvent(
      "warn",
      "financingSettings",
      "CompanySetting.financingPlans is not a valid plan list - falling back to the default plans",
      { errors: checked.errors.slice(0, 5) },
    );
    return orderedPlans([...DEFAULT_FINANCING_PLANS]);
  } catch (err) {
    logSystemEvent(
      "error",
      "financingSettings",
      "Failed to read CompanySetting.financingPlans - falling back to the default plans",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return orderedPlans([...DEFAULT_FINANCING_PLANS]);
  }
}

/** The plans a customer may be offered right now: switched on, in display order. */
export async function getActiveFinancingPlans(): Promise<FinancingPlan[]> {
  return (await getFinancingPlans()).filter((p) => p.active);
}

// ─── The snapshot frozen onto an issued estimate ────────────────────────────────────────────

/** What `IssuedEstimate.financingPlansJson` holds. */
interface FinancingSnapshot {
  version: 1;
  takenAt: string;
  plans: FinancingPlan[];
}

/**
 * The ACTIVE plan list as a JSON string for `IssuedEstimate.financingPlansJson`, taken at issue so a
 * later Settings edit never changes a quote already sent (Kyle: a quote is a document; same reason
 * as jobBandsJson). Holds the full plans, rates included - the server must recompute from it - and
 * is therefore a SERVER-SIDE column: it is never selected into a customer or field payload.
 * Null when no plan is active at issue (the estimate then offers no financing, honestly).
 */
export async function snapshotActiveFinancingPlansJson(now: Date = new Date()): Promise<string | null> {
  const plans = await getActiveFinancingPlans();
  if (plans.length === 0) return null;
  const snapshot: FinancingSnapshot = { version: 1, takenAt: now.toISOString(), plans };
  return JSON.stringify(snapshot);
}

/**
 * Read a snapshot back. Null for a missing, garbled or invalid column (an estimate issued before
 * this existed has none): no financing is offered on it, never a guess from today's Settings -
 * that would restate a quote already sent.
 */
export function plansFromSnapshot(json: string | null | undefined): FinancingPlan[] | null {
  if (!json) return null;
  const raw = parseJsonObject<{ plans?: unknown }>(json);
  if (!raw) return null;
  const checked = validateFinancingPlans(raw.plans);
  if (!checked.ok) {
    logSystemEvent("warn", "financingSettings", "An issued estimate's financing snapshot is not a valid plan list - no financing offered on it", {
      errors: checked.errors.slice(0, 5),
    });
    return null;
  }
  const active = checked.plans.filter((p) => p.active);
  return active.length > 0 ? active : null;
}
