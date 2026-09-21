/**
 * ONE definition of "money collected" — and of an account's LIFETIME collected
 * (Kyle, 2026-09-20, the four-phase funnel; PUNCHLIST E5).
 *
 * Before this the Accounts list summed `Visit.revenue` on the client, the account page summed
 * signed-estimate revenue through jobCosting, and Financials summed `/invoices`' per-invoice
 * `collected` — three numbers for the same words. The funnel's fourth phase is "the life time
 * spend of each account", and the architect's default is that spend is MONEY COLLECTED, not
 * invoiced: a signed estimate is a promise; a Payment row is the money.
 *
 * The rule, in one place, in the shape every reader needs:
 *   - status "paid";
 *   - method != "discount" (the retired 3% non-card programme's rows close invoices but were
 *     never revenue — the same carve-out routes/financials.ts and /invoices already make);
 *   - EITHER payer: the homeowner's money and the warranty company's money are both money
 *     collected on this account's work (Kyle, 2026-09-10: "money is money");
 *   - the test account never counts.
 *
 * `collectedByCustomer` attributes a payment to an account by its own `customerId`, else through
 * the invoice it paid (`estimateId` -> IssuedEstimate.customerId) — Stripe webhooks and hand-typed
 * payments do not always carry the customer.
 */

import type { PrismaClient } from "@prisma/client";

/** The Prisma `where` fragment every "collected" query starts from. Add a date window or a scope; never loosen this. */
export const COLLECTED_PAYMENT_WHERE = { status: "paid", method: { not: "discount" } } as const;

export interface LifetimeCollected {
  /** Every dollar collected on this account's work, either payer. */
  collected: number;
  customerPaid: number;
  warrantyPaid: number;
  paymentCount: number;
  firstPaidAt: Date | null;
  lastPaidAt: Date | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function emptyLifetime(): LifetimeCollected {
  return { collected: 0, customerPaid: 0, warrantyPaid: 0, paymentCount: 0, firstPaidAt: null, lastPaidAt: null };
}

/**
 * Lifetime collected per account. Pass `customerIds` to scope it; omit for every account.
 * Accounts with nothing collected are absent from the map — read with `?? emptyLifetime()`.
 */
export async function collectedByCustomer(
  prisma: PrismaClient,
  customerIds?: string[],
): Promise<Map<string, LifetimeCollected>> {
  if (customerIds && customerIds.length === 0) return new Map();

  // Payments with no customer of their own are attributed through the invoice they paid.
  const estimateOwner = await prisma.issuedEstimate.findMany({
    where: customerIds ? { customerId: { in: customerIds } } : {},
    select: { id: true, customerId: true },
  });
  const ownerOfEstimate = new Map(estimateOwner.map((e) => [e.id, e.customerId]));

  const payments = await prisma.payment.findMany({
    where: {
      ...COLLECTED_PAYMENT_WHERE,
      ...(customerIds
        ? { OR: [{ customerId: { in: customerIds } }, { estimateId: { in: [...ownerOfEstimate.keys()] } }] }
        : {}),
    },
    select: { customerId: true, estimateId: true, amount: true, payer: true, paidAt: true, createdAt: true },
  });

  const testIds = new Set(
    (await prisma.customer.findMany({ where: { isTestAccount: true }, select: { id: true } })).map((c) => c.id),
  );

  const out = new Map<string, LifetimeCollected>();
  for (const p of payments) {
    const owner = p.customerId ?? (p.estimateId ? ownerOfEstimate.get(p.estimateId) ?? null : null);
    if (!owner || testIds.has(owner)) continue;
    if (customerIds && !customerIds.includes(owner)) continue;
    const row = out.get(owner) ?? emptyLifetime();
    row.collected = round2(row.collected + p.amount);
    if (p.payer === "warranty") row.warrantyPaid = round2(row.warrantyPaid + p.amount);
    else row.customerPaid = round2(row.customerPaid + p.amount);
    row.paymentCount += 1;
    const at = p.paidAt ?? p.createdAt;
    if (!row.firstPaidAt || at < row.firstPaidAt) row.firstPaidAt = at;
    if (!row.lastPaidAt || at > row.lastPaidAt) row.lastPaidAt = at;
    out.set(owner, row);
  }
  return out;
}

/** One account's lifetime collected — the number the account page and the Accounts list show. */
export async function lifetimeCollectedFor(prisma: PrismaClient, customerId: string): Promise<LifetimeCollected> {
  return (await collectedByCustomer(prisma, [customerId])).get(customerId) ?? emptyLifetime();
}
