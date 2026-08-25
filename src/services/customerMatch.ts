/**
 * Finding the account a caller already has.
 *
 * Before this, converting a lead ALWAYS created a new Customer — there was no
 * phone or email matching anywhere in that path. So a repeat customer asking
 * about a second property got a duplicate account instead of a second address on
 * the one they already had, which is the single thing that made multi-address
 * accounts theoretical.
 *
 * Matching logic was also duplicated about eleven ways across the voice agents,
 * the SMS router and `/customer/lookup`, using three different strategies that
 * disagreed about which stored formats they could find.
 *
 * **This module is pure read. It never creates and never merges.** Every write
 * decision stays at the call site — that is what makes it safe to drop into the
 * convert transaction, where a wrong automatic merge would be very hard to undo.
 */

import { prisma } from "../lib/prisma";

/**
 * The last ten digits of a phone number, or null if there aren't ten.
 *
 * Ten digits is the comparison unit because that's what survives every format
 * this database contains: `+16155550101`, `(615) 555-0101`, `615-555-0101` and
 * `6155550101` all reduce to the same string, and the country code doesn't
 * (one of those has it, three don't).
 */
export function phoneDigits10(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

const normalizeName = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : null;
};

export type MatchField = "phone" | "email" | "name";

export interface MatchedProperty {
  id: string;
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
}

export interface CustomerMatch {
  customerId: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** Additive, deterministic, 0–100. Only meaningful for ordering. */
  score: number;
  /** Why this surfaced. The UI renders it in words rather than showing a score. */
  matchedOn: MatchField[];
  properties: MatchedProperty[];
  visitCount: number;
  lastVisitAt: Date | null;
}

export interface MatchQuery {
  phone?: string | null;
  email?: string | null;
  name?: string | null;
  limit?: number;
}

/**
 * How wide the SQL net is thrown before the exact check happens in JS.
 *
 * The narrowing predicate is `phone contains <last four digits>`, because the
 * last four are the only digit substring guaranteed to appear in every format
 * above — `contains "6155550101"` misses both of the punctuated forms, and a
 * b-tree index cannot serve a leading-wildcard LIKE anyway.
 *
 * Known limit: if more than this many customers share a last-four, a real match
 * can be missed. At a solo operator's row counts that is far away; the fix when
 * it arrives is a maintained normalized-phone column with a plain index, not a
 * bigger number here.
 */
const PHONE_CANDIDATE_LIMIT = 200;

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

/** Scores are additive so the resulting order is explainable to whoever reads it. */
const SCORE = {
  phoneExact: 60,
  emailExact: 35,
  nameExact: 10,
  nameContains: 4,
  hasProperty: 5,
  hasVisits: 2,
} as const;

type CustomerRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  createdAt: Date;
  properties: MatchedProperty[];
  visits: { visitDate: Date }[];
};

const SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  createdAt: true,
  properties: {
    select: {
      id: true, name: true, addressLine1: true, addressLine2: true,
      city: true, state: true, postalCode: true,
    },
    orderBy: { createdAt: "asc" },
  },
  // Enough to rank by recency and show "4 jobs" without a second round trip.
  visits: { select: { visitDate: true }, orderBy: { visitDate: "desc" }, take: 50 },
} as const;

/**
 * Accounts that might already be this caller.
 *
 * Returns newest-relevant first. An empty array means "no reason to think this
 * is a duplicate" — callers should then create freely rather than prompting,
 * because a picker that appears with nothing in it trains people to dismiss it.
 */
export async function findCustomerMatches(query: MatchQuery): Promise<CustomerMatch[]> {
  const digits10 = phoneDigits10(query.phone);
  const email = normalizeEmail(query.email);
  const name = normalizeName(query.name);
  if (!digits10 && !email && !name) return [];

  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const byId = new Map<string, { row: CustomerRow; matchedOn: Set<MatchField> }>();

  const add = (rows: CustomerRow[], field: MatchField) => {
    for (const row of rows) {
      const existing = byId.get(row.id);
      if (existing) existing.matchedOn.add(field);
      else byId.set(row.id, { row, matchedOn: new Set([field]) });
    }
  };

  if (digits10) {
    // Over-broad on purpose (see PHONE_CANDIDATE_LIMIT), then confirmed exactly.
    const candidates = await prisma.customer.findMany({
      where: { phone: { contains: digits10.slice(-4) } },
      orderBy: { updatedAt: "desc" },
      take: PHONE_CANDIDATE_LIMIT,
      select: SELECT,
    });
    add(
      candidates.filter((row) => phoneDigits10(row.phone) === digits10),
      "phone",
    );

    // Additional contacts (2026-08-25): the spouse's cell on the account must
    // match the account — a text from that number is the same household.
    const contactHits = await prisma.customerContact.findMany({
      where: { phone: { contains: digits10.slice(-4) } },
      take: PHONE_CANDIDATE_LIMIT,
      select: { customerId: true, phone: true },
    });
    const contactCustomerIds = [
      ...new Set(contactHits.filter((c) => phoneDigits10(c.phone) === digits10).map((c) => c.customerId)),
    ];
    if (contactCustomerIds.length > 0) {
      const rows = await prisma.customer.findMany({
        where: { id: { in: contactCustomerIds } },
        select: SELECT,
      });
      add(rows, "phone");
    }
  }

  if (email) {
    const rows = await prisma.customer.findMany({
      where: { email: { equals: email, mode: "insensitive" } },
      take: MAX_LIMIT * 2,
      select: SELECT,
    });
    add(rows, "email");
  }

  if (name) {
    // The FULL string, so "Bob Smith" doesn't drag in every Smith on the books.
    const rows = await prisma.customer.findMany({
      where: { name: { contains: name, mode: "insensitive" } },
      orderBy: { updatedAt: "desc" },
      take: MAX_LIMIT * 2,
      select: SELECT,
    });
    add(rows, "name");
  }

  const matches: CustomerMatch[] = [];
  for (const { row, matchedOn } of byId.values()) {
    // A name is a signal, never a duplicate trigger by itself. Two households
    // called "Smith" is ordinary; prompting on it would be noise, and worse, it
    // would invite someone to file a second family's job under the first.
    if (matchedOn.size === 1 && matchedOn.has("name")) continue;

    let score = 0;
    if (matchedOn.has("phone")) score += SCORE.phoneExact;
    if (matchedOn.has("email")) score += SCORE.emailExact;
    if (name) {
      const rowName = normalizeName(row.name);
      if (rowName && rowName.toLowerCase() === name.toLowerCase()) score += SCORE.nameExact;
      else if (matchedOn.has("name")) score += SCORE.nameContains;
    }
    if (row.properties.length > 0) score += SCORE.hasProperty;
    if (row.visits.length > 0) score += SCORE.hasVisits;

    matches.push({
      customerId: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      score: Math.min(100, score),
      matchedOn: (["phone", "email", "name"] as MatchField[]).filter((f) => matchedOn.has(f)),
      properties: row.properties,
      visitCount: row.visits.length,
      lastVisitAt: row.visits[0]?.visitDate ?? null,
    });
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aVisit = a.lastVisitAt?.getTime() ?? 0;
    const bVisit = b.lastVisitAt?.getTime() ?? 0;
    if (bVisit !== aVisit) return bVisit - aVisit;
    return a.customerId.localeCompare(b.customerId);
  });

  return matches.slice(0, limit);
}

/** Human phrasing for `matchedOn`, so both clients word it identically. */
export function describeMatch(matchedOn: MatchField[]): string {
  if (matchedOn.length === 0) return "no direct match";
  if (matchedOn.length === 1) return `matched on ${matchedOn[0]}`;
  const last = matchedOn[matchedOn.length - 1];
  return `matched on ${matchedOn.slice(0, -1).join(", ")} and ${last}`;
}
