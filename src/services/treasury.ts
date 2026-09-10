/**
 * Treasury — floats, the month-end sweep, and Stripe's processing fees
 * (Kyle, 2026-09-09).
 *
 * "At the end of each month I will take whatever money is over that value and
 * deposit it into the Chase savings accounts for taxes and owner distributions."
 *
 * Ratified the same day:
 * - The FLOATS (working balances) are set in Settings when the accounts are
 *   opened — one for the main financial account, one per truck.
 * - The SWEEP happens ON A CLICK, from the number Financials shows on the first
 *   of the month. Never automatic, never scheduled — nothing in this file runs
 *   on a timer, and nothing here should ever be wired to one.
 * - Stripe processing fees were shown nowhere; they belong in the P&L as their
 *   own expense line. Collected stays GROSS (ONE PRICE: the customer pays the
 *   invoice amount; the fee is the company's expense).
 *
 * Every Stripe read or write degrades to a plain reason. The restricted key on
 * Railway gets its Money Management (and balance-transaction) scope from Kyle
 * in the Dashboard; until then the sweep card says which scope is missing and
 * the fee column says it cannot be read — never a crash.
 *
 * Stripe's Financial Accounts for a direct business are the v2 money-management
 * preview API (see cardSpend.ts listFinancialAccounts). The installed SDK has no
 * typed resource for it, so the outbound transfer goes through rawRequest with
 * the preview Stripe-Version. The request shape is read from Stripe's v2
 * reference and sent ONCE: if Stripe rejects it, the exact message goes back to
 * Kyle — this code never guesses a second shape.
 */

import { z } from "zod";
import type { TreasurySweep } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { parseJsonObject } from "../lib/json";
import { logSystemEvent } from "./systemEvents";
import { stripe, stripeConfigured } from "./stripePayments";
import { describeStripeError, previewApiVersion, readBalances, resetBalancesCache } from "./cardSpend";

const round2 = (n: number) => Math.round(n * 100) / 100;

// ─── Settings (CompanySetting key "treasury") ────────────────────────────────

export const TREASURY_SETTING_KEY = "treasury";

const money = z.number().finite().min(0, "must be zero or more");

/** The write shape — every number must be ≥ 0; ids and labels are free text. */
export const treasurySettingsSchema = z.object({
  mainFinancialAccountId: z.string().trim().max(100).nullable().optional(),
  mainFloat: money.default(0),
  truckFloats: z.record(z.string(), money).default({}),
  chaseAccountLabel: z.string().trim().max(200).nullable().optional(),
  /** Stripe's outbound-payment destination (payout-method id) for the Chase account, when Kyle has it. */
  chaseExternalAccountId: z.string().trim().max(100).nullable().optional(),
});
export type TreasurySettingsInput = z.input<typeof treasurySettingsSchema>;

export interface TreasurySettings {
  mainFinancialAccountId: string | null;
  mainFloat: number;
  truckFloats: Record<string, number>;
  chaseAccountLabel: string | null;
  chaseExternalAccountId: string | null;
}

export const DEFAULT_TREASURY: TreasurySettings = {
  mainFinancialAccountId: null,
  mainFloat: 0,
  truckFloats: {},
  chaseAccountLabel: null,
  chaseExternalAccountId: null,
};

const text = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
const nonNeg = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? round2(v) : 0);

/** Tolerant read — a malformed row means defaults (floats 0, nothing chosen), never a 500 on Financials. */
export async function getTreasurySettings(): Promise<TreasurySettings> {
  const row = await prisma.companySetting.findUnique({ where: { key: TREASURY_SETTING_KEY } }).catch(() => null);
  const raw = parseJsonObject<Record<string, unknown>>(row?.valueJson);
  if (!raw) return DEFAULT_TREASURY;
  const floats: Record<string, number> = {};
  const rawFloats = raw.truckFloats;
  if (rawFloats && typeof rawFloats === "object" && !Array.isArray(rawFloats)) {
    for (const [truckId, v] of Object.entries(rawFloats as Record<string, unknown>)) floats[truckId] = nonNeg(v);
  }
  return {
    mainFinancialAccountId: text(raw.mainFinancialAccountId),
    mainFloat: nonNeg(raw.mainFloat),
    truckFloats: floats,
    chaseAccountLabel: text(raw.chaseAccountLabel),
    chaseExternalAccountId: text(raw.chaseExternalAccountId),
  };
}

/** Validated write (throws ZodError → 400 through the app's error handler). */
export async function saveTreasurySettings(input: unknown): Promise<TreasurySettings> {
  const body = treasurySettingsSchema.parse(input);
  const value: TreasurySettings = {
    mainFinancialAccountId: text(body.mainFinancialAccountId),
    mainFloat: round2(body.mainFloat),
    truckFloats: Object.fromEntries(Object.entries(body.truckFloats).map(([k, v]) => [k, round2(v)])),
    chaseAccountLabel: text(body.chaseAccountLabel),
    chaseExternalAccountId: text(body.chaseExternalAccountId),
  };
  const valueJson = JSON.stringify(value);
  await prisma.companySetting.upsert({
    where: { key: TREASURY_SETTING_KEY },
    update: { valueJson },
    create: { key: TREASURY_SETTING_KEY, valueJson },
  });
  return value;
}

// ─── The sweep number ────────────────────────────────────────────────────────

/**
 * What can leave the main account: balance − float − outbound already in
 * flight, floored at zero. Pure so the test can pin it.
 */
export function sweepExcess(balance: number, float: number, outboundPending: number): number {
  return round2(Math.max(0, balance - float - outboundPending));
}

export interface SweepTruckRow {
  truckId: string;
  truckName: string;
  financialAccountId: string | null;
  /** Null when the truck has no financial account, or Stripe could not be read. */
  balance: number | null;
  float: number;
  /** balance − float; negative is a shortfall (the truck needs topping up). Null when balance is null. */
  excessOrShortfall: number | null;
}

export interface SweepView {
  asOf: string;
  stripeAvailable: boolean;
  stripeReason: string | null;
  main: {
    financialAccountId: string;
    balance: number;
    inboundPending: number;
    outboundPending: number;
    float: number;
    excess: number;
  } | null;
  trucks: SweepTruckRow[];
  destination: { label: string; externalAccountId: string } | null;
  canSweep: boolean;
  /** Why not, in Kyle's words, when canSweep is false. */
  reason: string | null;
  recent: TreasurySweep[];
}

function scopeReason(reason: string | undefined): string {
  if (!stripeConfigured()) return "Stripe is not configured on the server (STRIPE_SECRET_KEY) — nothing to read.";
  return `Stripe key needs Money Management read scope — ${reason ?? "the financial accounts could not be read"}`;
}

/**
 * The number on the first of the month. Reads through readBalances (cached five
 * minutes); `fresh` forgets the cache first — the sweep POST always reads fresh
 * before moving money.
 */
export async function readSweep(opts: { fresh?: boolean } = {}): Promise<SweepView> {
  if (opts.fresh) resetBalancesCache();
  const [balances, settings, trucks, recent] = await Promise.all([
    readBalances(),
    getTreasurySettings(),
    prisma.truck.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, stripeFinancialAccountId: true },
    }),
    prisma.treasurySweep.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
  ]);
  const faById = new Map(balances.financialAccounts.map((fa) => [fa.id, fa]));

  const truckRows: SweepTruckRow[] = trucks.map((t) => {
    const fa = t.stripeFinancialAccountId ? faById.get(t.stripeFinancialAccountId) ?? null : null;
    const float = settings.truckFloats[t.id] ?? 0;
    return {
      truckId: t.id,
      truckName: t.name,
      financialAccountId: t.stripeFinancialAccountId,
      balance: fa ? fa.cashUsd : null,
      float,
      excessOrShortfall: fa ? round2(fa.cashUsd - float) : null,
    };
  });

  const destination = settings.chaseExternalAccountId
    ? { label: settings.chaseAccountLabel ?? settings.chaseExternalAccountId, externalAccountId: settings.chaseExternalAccountId }
    : null;

  let main: SweepView["main"] = null;
  let reason: string | null = null;
  if (!balances.available) {
    reason = scopeReason(balances.reason);
  } else if (!settings.mainFinancialAccountId) {
    reason = "Choose the main financial account in Settings → Treasury.";
  } else {
    const fa = faById.get(settings.mainFinancialAccountId);
    if (!fa) {
      reason = `Stripe did not return the main financial account (${settings.mainFinancialAccountId}) — pick it again in Settings → Treasury.`;
    } else {
      main = {
        financialAccountId: fa.id,
        balance: fa.cashUsd,
        inboundPending: fa.inboundPending,
        outboundPending: fa.outboundPending,
        float: settings.mainFloat,
        excess: sweepExcess(fa.cashUsd, settings.mainFloat, fa.outboundPending),
      };
      if (!destination) reason = "Add the Chase destination (Stripe payout-method id) in Settings → Treasury.";
      else if (main.excess <= 0) reason = "No excess — the balance is at or below the float.";
    }
  }

  return {
    asOf: balances.readAt.toISOString(),
    stripeAvailable: balances.available,
    stripeReason: balances.reason ?? null,
    main,
    trucks: truckRows,
    destination,
    canSweep: reason === null,
    reason,
    recent,
  };
}

// ─── The click ───────────────────────────────────────────────────────────────

export class TreasuryError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly stripe?: { type?: string; code?: string }) {
    super(message);
    this.name = "TreasuryError";
  }
}

export const SWEEP_CONFIRM_WORD = "SWEEP";
const SWEEP_DESCRIPTION = "Month-end sweep to Chase — taxes & owner distributions";

/**
 * Move `amount` from the main financial account to the Chase destination.
 * Kyle types SWEEP; the amount can never exceed the excess read FRESH at the
 * moment of the click. One request to Stripe, one TreasurySweep row either way.
 */
export async function executeSweep(input: { amount: number; confirm: string }): Promise<{ sweep: TreasurySweep; view: SweepView }> {
  if (input.confirm !== SWEEP_CONFIRM_WORD) throw new TreasuryError(`Type ${SWEEP_CONFIRM_WORD} to confirm the sweep.`, 400);
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new TreasuryError("The sweep amount must be more than zero.", 400);
  const amount = round2(input.amount);

  const view = await readSweep({ fresh: true });
  if (!view.canSweep || !view.main || !view.destination) throw new TreasuryError(view.reason ?? "The sweep is not available right now.", 409);
  if (amount > view.main.excess + 0.005) {
    throw new TreasuryError(`$${amount.toFixed(2)} is more than the excess ($${view.main.excess.toFixed(2)}) — sweep at most the excess.`, 409);
  }

  const cents = Math.round(amount * 100);
  const base = {
    financialAccountId: view.main.financialAccountId,
    amount,
    destinationLabel: view.destination.label,
    requestedBy: "owner",
  };

  let res: { id?: string; status?: string } | null = null;
  try {
    // Stripe v2 money management: POST /v2/money_management/outbound_transfers.
    // Sent as read from the reference; on refusal the message goes to Kyle unchanged.
    res = (await stripe().rawRequest(
      "POST",
      "/v2/money_management/outbound_transfers",
      {
        from: { financial_account: view.main.financialAccountId, currency: "usd" },
        to: { payout_method: view.destination.externalAccountId },
        amount: { value: cents, currency: "usd" },
        description: SWEEP_DESCRIPTION,
      },
      { apiVersion: previewApiVersion(), idempotencyKey: `sweep-${view.main.financialAccountId}-${cents}-${Date.now()}` },
    )) as { id?: string; status?: string };
  } catch (err) {
    const e = err as { type?: string; code?: string; message?: string };
    const { permission, reason } = describeStripeError(err);
    const message = e?.message ?? reason;
    const sweep = await prisma.treasurySweep.create({ data: { ...base, status: "failed", error: message } });
    logSystemEvent("warn", "treasury", `Month-end sweep of $${amount.toFixed(2)} refused by Stripe: ${message}`, {
      sweepId: sweep.id, financialAccountId: base.financialAccountId, destination: view.destination.externalAccountId, permission, code: e?.code, type: e?.type,
    });
    throw new TreasuryError(
      permission
        ? `Stripe refused the transfer — the key needs Money Management write scope (outbound transfers). Stripe said: ${message}`
        : `Stripe refused the transfer: ${message}`,
      502,
      { type: e?.type, code: e?.code },
    );
  }

  const sweep = await prisma.treasurySweep.create({
    data: { ...base, status: "created", stripeTransferId: typeof res?.id === "string" ? res.id : null },
  });
  logSystemEvent("info", "treasury", `Month-end sweep: $${amount.toFixed(2)} from ${base.financialAccountId} to ${base.destinationLabel} (${res?.id ?? "no id returned"}, Stripe status ${res?.status ?? "?"})`, {
    sweepId: sweep.id, stripeTransferId: res?.id ?? null, stripeStatus: res?.status ?? null, excessAtClick: view.main.excess,
  });
  // The balance moved — the next read must not show the pre-sweep number.
  resetBalancesCache();
  return { sweep, view };
}

// ─── Stripe processing fees (the P&L expense line) ───────────────────────────

export interface StripeFeeRow {
  month: number;
  /** The fee in dollars — the expense. */
  amount: number;
  /** The charge / payment the fee was taken from. */
  chargeId: string;
  /** What actually landed after the fee, dollars. */
  net: number;
  date: Date;
}
export interface StripeFeesResult { rows: StripeFeeRow[]; available: boolean; reason?: string }

const FEE_TTL = 30 * 60 * 1000;
const FEE_FAILURE_TTL = 5 * 60 * 1000;
const feeCache = new Map<number, { at: number; ttl: number; value: StripeFeesResult }>();

/** Test/diagnostic hook: forget the cached fee rows. */
export function resetStripeFeeCache(): void {
  feeCache.clear();
}

/**
 * Every processing fee Stripe took in `year`, from the balance transactions of
 * type "charge" (cards) and "payment" (bank debits, Link). Auto-paginated;
 * cached per year for thirty minutes. On any Stripe error the rows are empty
 * and `reason` says why — a restricted key without balance-transaction read
 * scope is the usual answer.
 */
export async function stripeFeeRows(year: number, bounds?: { from: Date; to: Date }): Promise<StripeFeesResult> {
  if (!stripeConfigured()) return { rows: [], available: false, reason: "STRIPE_SECRET_KEY is not set." };
  const hit = feeCache.get(year);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;

  const from = bounds?.from ?? new Date(`${year}-01-01`);
  const to = bounds?.to ?? new Date(`${year + 1}-01-01`);
  const created = { gte: Math.floor(from.getTime() / 1000), lt: Math.floor(to.getTime() / 1000) };
  const rows: StripeFeeRow[] = [];
  try {
    for (const type of ["charge", "payment"] as const) {
      for await (const tx of stripe().balanceTransactions.list({ created, type, limit: 100 })) {
        const fee = tx.fee ?? 0;
        if (fee === 0) continue;
        const date = new Date(tx.created * 1000);
        const source = tx.source;
        rows.push({
          month: date.getMonth(),
          amount: round2(fee / 100),
          chargeId: typeof source === "string" ? source : source?.id ?? tx.id,
          net: round2((tx.net ?? 0) / 100),
          date,
        });
      }
    }
  } catch (err) {
    const { permission, reason } = describeStripeError(err);
    const e = err as { message?: string };
    const value: StripeFeesResult = {
      rows: [],
      available: false,
      reason: permission
        ? `The Stripe key cannot read balance transactions — add Balance transactions read scope to the restricted key in the Stripe Dashboard. (${e?.message ?? reason})`
        : `Stripe fees could not be read: ${e?.message ?? reason}`,
    };
    feeCache.set(year, { at: Date.now(), ttl: FEE_FAILURE_TTL, value });
    return value;
  }
  const value: StripeFeesResult = { rows, available: true };
  feeCache.set(year, { at: Date.now(), ttl: FEE_TTL, value });
  return value;
}
