/**
 * Global search (2026-09-20, drawers plan Phase 5).
 *
 * Kyle: "There are too many separate pages and I end up having to jump around too much. I can't
 * keep track of where everything is." The drawers made every record reachable; this makes every
 * record FINDABLE. Type a name, an address, an estimate number or a P.O. number — get the record,
 * open its drawer, fix it in place.
 *
 * ── ONE ENDPOINT, SIX KINDS ──────────────────────────────────────────────────────────────────
 * Accounts (Customer), addresses (Property), leads, jobs (Visit), issued estimates and purchase
 * orders. One bounded query per kind, run in parallel, ranked together in memory. Nothing here
 * is a full-text engine: every text match is `contains`, case-insensitive (`ILIKE '%term%'`),
 * served by the trigram GIN indexes migration 20260921120000 adds. No tokenising — "108 Maple"
 * matches an address that contains "108 Maple"; "Maple 108" does not.
 *
 * ── NUMBERS FIRST ───────────────────────────────────────────────────────────────────────────
 * An estimate number or a P.O. number typed whole is the cheapest, highest-confidence result and
 * outranks every name match; typed as a prefix ("PO-2026-00", "2026-10") it still outranks them.
 * A FRAGMENT of a number ("0021", "1010") ranks below text matches: "1010" is also an address,
 * and a fragment is a fragment. In practice a fragment has no text competitors and still lands
 * on top. Within a rank: account, address, lead, job, estimate, P.O. (the account is the hub the
 * rest hang off), then most recent first.
 *
 * ── WHAT NEVER LEAVES THIS FILE (PUNCHLIST B4) ───────────────────────────────────────────────
 * Every query is an explicit `select`. `IssuedEstimate.token`, `Visit.confirmationToken` and
 * document cuids are unrevokable capability links and cannot enter a search payload; there is no
 * `{ ...row }` anywhere here and tests/globalSearch.test.ts pins the word "token" out of the
 * response. The test account (Customer.isTestAccount) is excluded on every kind.
 *
 * ── CAPS ─────────────────────────────────────────────────────────────────────────────────────
 * `per` results per kind, default 5, at most 10 — so a response is at most 60 rows and usually
 * 30. Each kind fetches `per + 1` to report `more` without a count query. Nothing here is
 * unbounded (PUNCHLIST E4 / G3 are the pattern this must not repeat).
 */

import type { PrismaClient } from "@prisma/client";
import { EXCLUDE_TEST_ACCOUNT, EXCLUDE_TEST_JOB } from "./accountSpine";
import { logSystemEvent } from "./systemEvents";

export const SEARCH_KINDS = ["account", "property", "lead", "job", "estimate", "po"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** How the row matched — what the ranking is built from. */
export type SearchMatch = "number" | "number_prefix" | "text" | "number_part";

/**
 * The drawers the client has (client/src/lib/drawers.ts DRAWER_KINDS, minus `invoice` and
 * `receipt`, which search does not return). An account has no drawer and navigates to its page.
 */
export type SearchDrawerKind = "po" | "job" | "estimate" | "lead";

export interface SearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string | null;
  status: string | null;
  match: SearchMatch;
  /** Open this drawer on the current route — or null, and use `href`. */
  drawer: { kind: SearchDrawerKind; id: string } | null;
  /** Navigate here — only when there is no drawer for the kind. */
  href: string | null;
  /** ISO timestamp used for recency ordering within a rank. */
  at: string;
}

export interface SearchResponse {
  q: string;
  per: number;
  /** False when pg_trgm is not installed — search works, on sequential scans. */
  indexed: boolean;
  results: SearchResult[];
  /** True for a kind that had more matches than `per`. */
  more: Partial<Record<SearchKind, boolean>>;
}

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 80;
export const PER_KIND_DEFAULT = 5;
export const PER_KIND_MAX = 10;

const RANK: Record<SearchMatch, number> = { number: 0, number_prefix: 1, text: 2, number_part: 3 };
const KIND_ORDER: Record<SearchKind, number> = { account: 0, property: 1, lead: 2, job: 3, estimate: 4, po: 5 };

/**
 * How wide the phone candidate net is. The SQL predicate is `phone contains <last four digits>`
 * (the only substring guaranteed to survive every stored format — see customerMatch.ts), and
 * the typed digits are then checked against the row's digits in JS. Same limit and reasoning as
 * PHONE_CANDIDATE_LIMIT there, scaled to a search.
 */
const PHONE_CANDIDATE_WINDOW = 50;

/** `ILIKE '%term%'`. Prisma escapes `%` and `_` in `contains`, so a typed wildcard is literal. */
const ci = (term: string) => ({ contains: term, mode: "insensitive" as const });

function numberMatch(number: string, term: string): SearchMatch {
  const n = number.toLowerCase();
  const t = term.toLowerCase();
  if (n === t) return "number";
  if (n.startsWith(t)) return "number_prefix";
  if (n.includes(t)) return "number_part";
  return "text";
}

/**
 * The digits of a phone-shaped term ("615-555", "(615) 555-0101", "5550101"), or null when the
 * term contains anything but digits and phone punctuation — "108 Maple" is an address, not a
 * phone, and must not run the phone branch.
 */
export function phoneNeedle(term: string): string | null {
  if (!/^[\d\s().+-]+$/.test(term)) return null;
  const digits = term.replace(/\D/g, "");
  return digits.length >= 4 ? digits : null;
}

const digitsOf = (raw: string | null | undefined) => (raw ?? "").replace(/\D/g, "");
const has = (value: string | null | undefined, term: string) => (value ?? "").toLowerCase().includes(term.toLowerCase());

function addressLine(p: { addressLine1: string; addressLine2?: string | null; city: string; state?: string; postalCode?: string }): string {
  const line = p.addressLine2 ? `${p.addressLine1}, ${p.addressLine2}` : p.addressLine1;
  return `${line}, ${p.city}${p.state ? ` ${p.state}` : ""}${p.postalCode ? ` ${p.postalCode}` : ""}`;
}

/** Ranked in place: rank, then kind order, then most recent first. Exported for the test. */
export function rankResults(results: SearchResult[]): SearchResult[] {
  return results.sort((a, b) =>
    RANK[a.match] - RANK[b.match]
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || b.at.localeCompare(a.at));
}

// ─── pg_trgm presence — checked once per process, reported once ──────────────────────────────

let trigramCheck: Promise<boolean> | null = null;

/**
 * Whether the trigram indexes can exist at all. The migration that creates them survives a role
 * that cannot install pg_trgm (it warns and skips) — which means production could be running
 * search unindexed with nothing saying so. This makes it say so: one SystemEvent (`source:
 * "search"`, warn) on the first search of the process, readable with the pinned
 * readSystemEvents rule.
 */
export function trigramIndexed(prisma: PrismaClient): Promise<boolean> {
  if (!trigramCheck) {
    trigramCheck = prisma
      .$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pg_trgm'`
      .then((rows) => {
        const installed = (rows[0]?.n ?? 0) > 0;
        if (!installed) {
          logSystemEvent("warn", "search",
            "pg_trgm is not installed — global search is running on sequential scans. " +
            "Install the extension and re-run the CREATE INDEX statements in migration 20260921120000_global_search_finds_every_record.");
        }
        return installed;
      })
      .catch((err) => {
        // Could not even ask. Answer "no" this time and ask again next time.
        trigramCheck = null;
        logSystemEvent("warn", "search", "Could not read pg_extension to check for pg_trgm.", { error: String(err) });
        return false;
      });
  }
  return trigramCheck;
}

// ─── The six queries ─────────────────────────────────────────────────────────────────────────

type Fetched = { rows: SearchResult[]; more: boolean };

async function accounts(prisma: PrismaClient, term: string, per: number): Promise<Fetched> {
  const needle = phoneNeedle(term);
  const rows = await prisma.customer.findMany({
    where: {
      isTestAccount: false,
      OR: [
        { name: ci(term) },
        { email: ci(term) },
        ...(needle ? [{ phone: { contains: needle.slice(-4) } }] : []),
      ],
    },
    select: { id: true, name: true, email: true, phone: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: needle ? PHONE_CANDIDATE_WINDOW : per + 1,
  });
  const kept = rows.filter((c) => has(c.name, term) || has(c.email, term) || (needle !== null && digitsOf(c.phone).includes(needle)));
  return {
    more: kept.length > per,
    rows: kept.slice(0, per).map((c) => ({
      kind: "account",
      id: c.id,
      title: c.name,
      subtitle: [c.phone, c.email].filter(Boolean).join(" · ") || null,
      status: null,
      match: "text",
      drawer: null,
      href: `/accounts/${c.id}`,
      at: c.updatedAt.toISOString(),
    })),
  };
}

async function properties(prisma: PrismaClient, term: string, per: number): Promise<Fetched> {
  const rows = await prisma.property.findMany({
    where: {
      customer: { isTestAccount: false },
      OR: [{ addressLine1: ci(term) }, { city: ci(term) }, { postalCode: ci(term) }],
    },
    select: {
      id: true, customerId: true, addressLine1: true, addressLine2: true, city: true, state: true, postalCode: true, updatedAt: true,
      customer: { select: { name: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: per + 1,
  });
  return {
    more: rows.length > per,
    rows: rows.slice(0, per).map((p) => ({
      kind: "property",
      id: p.id,
      title: addressLine(p),
      subtitle: p.customer.name,
      status: null,
      match: "text",
      // An address's history lives on its account (tab purposes: "Accounts — customer and
      // address history"). There is no address drawer.
      drawer: null,
      href: `/accounts/${p.customerId}`,
      at: p.updatedAt.toISOString(),
    })),
  };
}

async function leads(prisma: PrismaClient, term: string, per: number): Promise<Fetched> {
  const needle = phoneNeedle(term);
  // A lead linked to the practice account is practice too; an unlinked lead is real. `Lead` has
  // no `customer` relation — only the scalar `customerId` — so the exclusion goes by id (one tiny
  // query; there is normally one practice account or none). `customerId: null` must be spelled
  // out: SQL's `NOT IN` never matches a NULL.
  const practiceIds = (await prisma.customer.findMany({ where: { isTestAccount: true }, select: { id: true } })).map((c) => c.id);
  const rows = await prisma.lead.findMany({
    where: {
      AND: [
        practiceIds.length > 0 ? { OR: [{ customerId: null }, { customerId: { notIn: practiceIds } }] } : {},
        {
          OR: [
            { name: ci(term) },
            { email: ci(term) },
            { address: ci(term) },
            { addressLine1: ci(term) },
            { city: ci(term) },
            ...(needle ? [{ phone: { contains: needle.slice(-4) } }] : []),
          ],
        },
      ],
    },
    select: { id: true, name: true, email: true, phone: true, status: true, address: true, addressLine1: true, city: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: needle ? PHONE_CANDIDATE_WINDOW : per + 1,
  });
  const kept = rows.filter((l) =>
    has(l.name, term) || has(l.email, term) || has(l.address, term) || has(l.addressLine1, term) || has(l.city, term)
    || (needle !== null && digitsOf(l.phone).includes(needle)));
  return {
    more: kept.length > per,
    rows: kept.slice(0, per).map((l) => ({
      kind: "lead",
      id: l.id,
      title: l.name,
      subtitle: [l.addressLine1 ? `${l.addressLine1}${l.city ? `, ${l.city}` : ""}` : l.address, l.phone].filter(Boolean).join(" · ") || null,
      status: l.status,
      match: "text",
      drawer: { kind: "lead", id: l.id },
      href: null,
      at: l.updatedAt.toISOString(),
    })),
  };
}

async function jobs(prisma: PrismaClient, term: string, per: number): Promise<Fetched> {
  const rows = await prisma.visit.findMany({
    where: {
      customer: { isTestAccount: false },
      OR: [{ property: { addressLine1: ci(term) } }, { customer: { name: ci(term) } }],
    },
    select: {
      id: true, status: true, visitDate: true, scheduledStart: true, jobType: true, purpose: true,
      property: { select: { addressLine1: true, city: true } },
      customer: { select: { name: true } },
    },
    orderBy: { visitDate: "desc" },
    take: per + 1,
  });
  return {
    more: rows.length > per,
    rows: rows.slice(0, per).map((v) => ({
      kind: "job",
      id: v.id,
      title: `${v.property.addressLine1}, ${v.property.city}`,
      subtitle: [v.customer.name, v.jobType ?? v.purpose].filter(Boolean).join(" · ") || null,
      status: v.status,
      match: "text",
      drawer: { kind: "job", id: v.id },
      href: null,
      at: (v.scheduledStart ?? v.visitDate).toISOString(),
    })),
  };
}

async function estimates(prisma: PrismaClient, term: string, per: number): Promise<Fetched> {
  const rows = await prisma.issuedEstimate.findMany({
    where: {
      ...EXCLUDE_TEST_ACCOUNT,
      // Live rows only: one result per estimate number, at its latest revision.
      supersededBy: null,
      OR: [{ number: ci(term) }, { title: ci(term) }, { customerName: ci(term) }, { serviceAddress: ci(term) }],
    },
    // Explicit, and `token` is not in it. Never `{ ...row }` here (PUNCHLIST B4).
    select: {
      id: true, number: true, revision: true, status: true, title: true, customerName: true, serviceAddress: true,
      total: true, createdAt: true, changeOrderForId: true,
    },
    orderBy: { createdAt: "desc" },
    take: per + 1,
  });
  return {
    more: rows.length > per,
    rows: rows.slice(0, per).map((e) => ({
      kind: "estimate",
      id: e.id,
      title: `${e.changeOrderForId ? "Change order" : "Estimate"} ${e.number}${e.revision > 1 ? ` rev ${e.revision}` : ""} — ${e.title}`,
      subtitle: [e.customerName, e.serviceAddress].filter(Boolean).join(" · ") || null,
      status: e.status,
      match: numberMatch(e.number, term),
      drawer: { kind: "estimate", id: e.id },
      href: null,
      at: e.createdAt.toISOString(),
    })),
  };
}

async function purchaseOrders(prisma: PrismaClient, term: string, per: number): Promise<Fetched> {
  const rows = await prisma.purchaseOrder.findMany({
    // EXCLUDE_TEST_JOB is itself an OR; it must sit beside ours, never be spread over it.
    where: { AND: [EXCLUDE_TEST_JOB, { OR: [{ number: ci(term) }, { supplier: ci(term) }] }] },
    select: {
      id: true, number: true, supplier: true, status: true, openedAt: true, jobId: true,
      job: { select: { property: { select: { addressLine1: true } } } },
    },
    orderBy: { openedAt: "desc" },
    take: per + 1,
  });
  return {
    more: rows.length > per,
    rows: rows.slice(0, per).map((po) => ({
      kind: "po",
      id: po.id,
      title: `${po.number} — ${po.supplier}`,
      subtitle: po.job ? po.job.property.addressLine1 : "restock",
      status: po.status,
      match: numberMatch(po.number, term),
      drawer: { kind: "po", id: po.id },
      href: null,
      at: po.openedAt.toISOString(),
    })),
  };
}

// ─── The search ──────────────────────────────────────────────────────────────────────────────

/** `q` is already validated (length) by the route; whitespace is collapsed here. */
export async function globalSearch(prisma: PrismaClient, q: string, perRequested?: number): Promise<SearchResponse> {
  const term = q.trim().replace(/\s+/g, " ");
  const per = Math.min(PER_KIND_MAX, Math.max(1, perRequested ?? PER_KIND_DEFAULT));

  const [indexed, account, property, lead, job, estimate, po] = await Promise.all([
    trigramIndexed(prisma),
    accounts(prisma, term, per),
    properties(prisma, term, per),
    leads(prisma, term, per),
    jobs(prisma, term, per),
    estimates(prisma, term, per),
    purchaseOrders(prisma, term, per),
  ]);

  const fetched: Record<SearchKind, Fetched> = { account, property, lead, job, estimate, po };
  const more: Partial<Record<SearchKind, boolean>> = {};
  for (const kind of SEARCH_KINDS) if (fetched[kind].more) more[kind] = true;

  return {
    q: term,
    per,
    indexed,
    results: rankResults(SEARCH_KINDS.flatMap((kind) => fetched[kind].rows)),
    more,
  };
}
