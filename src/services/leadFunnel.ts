/**
 * THE FOUR-PHASE FUNNEL (Kyle, 2026-09-20).
 *
 * "We have to recognize the difference between winning a job and gaining an opportunity. When a
 * lead gets converted it should be considered an opportunity... The won vs lost tracking should
 * be done comparing issued estimates with contracted jobs... Leads to accounts tracks how well
 * the marketing is doing via google, yelp, nextdoor, and angi leads. The leads to estimate tracks
 * how many of these leads are turning into real contact with the clients, and the estimate to
 * job tracks how many of those contacts produce revenue, the last is the campaigns which is the
 * life time spend of each account and retention of clients. So there really is 4 distinct phases."
 *
 *   1  Lead -> Account (OPPORTUNITY)   opportunities / leads, BY PLATFORM
 *   2  Lead -> Estimate                leads quoted / leads
 *   3  Estimate -> Job (THE WIN RATE)  contracted / issued
 *   4  Account -> repeat               lifetime collected, repeat accounts, newsletter reach
 *
 * Before this the Dashboard's headline "Win Rate" was `won leads / (won + lost leads)` — phase 1
 * data wearing a phase 3 label. Nothing is won at the lead stage; a lead becomes an OPPORTUNITY
 * (account + address + job + newsletter) or it is lost. A win is a SIGNED estimate.
 *
 * The rules, as implemented (the architect's defaults, 2026-09-20 plan):
 *   - Phase 3 counts DOCUMENTS, not revisions: one estimate number = one quote, judged at its
 *     latest revision. A quote revised three times is one chance to win.
 *   - Contracted = SIGNED. The deposit gates scheduling, not the win.
 *   - VOID leaves the denominator (dead document); LOST stays in it (the customer decided).
 *     A superseded revision is never the latest, so it drops out on its own. A DRAFT was never
 *     presented, so it is not yet a chance to win — reported as "unsent", outside the rate.
 *   - Change orders are not quotes: they ride a job that was already won.
 *   - Lead -> estimate attribution has NO time window.
 *   - Phase 4 lifetime spend = MONEY COLLECTED (services/lifetimeCollected.ts), not invoiced.
 *   - The test account never reaches any number.
 *
 * Phases 1-3 are windowed on the lead's arrival (1, 2) or the estimate's first issue (3).
 * Phase 4 is lifetime by definition and ignores the range.
 */

import type { PrismaClient } from "@prisma/client";
import { UNKNOWN_PLATFORM } from "../../shared/leadPlatform";
import { collectedByCustomer } from "./lifetimeCollected";

export type FunnelRange = { start: Date; end: Date; startDate: string; endDate: string };

/** Calls that are not leads at all — nothing was being asked for. They leave every lead count. */
export const NOT_A_LEAD_CALL_TYPES = ["wrong_number", "solicitation", "vendor"] as const;

/** Statuses at which a quote has actually been put in front of the customer. */
const PRESENTED = new Set(["sent", "viewed", "expired", "lost", "signed"]);

const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 100) : null);
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PlatformRow {
  platform: string;
  leads: number;
  opportunities: number;
  lost: number;
  quoted: number;
  opportunityRate: number | null;
}

export interface FunnelReport {
  range: FunnelRange;
  /** Phase 1 — Lead -> Account. */
  opportunity: {
    leads: number;
    opportunities: number;
    lost: number;
    open: number;
    /** Calls in the range that were not leads (wrong number, solicitation, vendor) — shown, never counted. */
    notLeads: number;
    rate: number | null;
    byPlatform: PlatformRow[];
    /** Why a lead never became an opportunity. "unrecorded" = lost with no reason typed. */
    lostReasons: Record<string, number>;
  };
  /** Phase 2 — Lead -> Estimate. */
  quoted: {
    leads: number;
    quoted: number;
    rate: number | null;
  };
  /** Phase 3 — Estimate -> Job. THE win rate. */
  winRate: {
    /** Documents (estimate numbers) first issued in the range that reached the customer: contracted + lost + open. */
    issued: number;
    contracted: number;
    lost: number;
    /** Sent, viewed or expired — no decision yet. */
    open: number;
    /** Outside the rate: issued but never presented (draft) and dead documents (void). */
    unsent: number;
    voided: number;
    rate: number | null;
    /** Why a quote was lost. "unrecorded" = lost with no reason typed. */
    lostReasons: Record<string, number>;
  };
  /** Phase 4 — Account -> repeat. Lifetime, no window. */
  retention: {
    accounts: number;
    payingAccounts: number;
    /** Accounts with two or more signed invoices. */
    repeatAccounts: number;
    lifetimeCollected: number;
    averagePerPayingAccount: number | null;
    newsletter: {
      /** Accounts with an email that has not unsubscribed — what a campaign reaches today. */
      reachable: number;
      unsubscribed: number;
      noEmail: number;
    };
    byPlatform: Array<{ platform: string; accounts: number; payingAccounts: number; repeatAccounts: number; collected: number }>;
    topAccounts: Array<{ id: string; name: string; platform: string | null; collected: number; signedInvoices: number }>;
  };
}

type LeadRow = {
  id: string; status: string; leadStatus: string; lostReason: string | null; platform: string | null;
  customerId: string | null; visitId: string | null; existingVisitId: string | null; createdAt: Date;
};

type EstimateRow = {
  id: string; number: string; revision: number; status: string; lostReason: string | null; createdAt: Date;
  leadId: string | null; visitId: string | null; jobVisitId: string | null; customerId: string;
};

/** One quote = one number, judged at its latest revision, dated from its first. */
interface QuoteDoc {
  number: string;
  latest: EstimateRow;
  firstIssuedAt: Date;
  leadIds: Set<string>;
  visitIds: Set<string>;
  customerId: string;
}

function groupByNumber(rows: EstimateRow[]): QuoteDoc[] {
  const byNumber = new Map<string, QuoteDoc>();
  for (const r of rows) {
    const doc = byNumber.get(r.number);
    if (!doc) {
      byNumber.set(r.number, {
        number: r.number, latest: r, firstIssuedAt: r.createdAt, customerId: r.customerId,
        leadIds: new Set(r.leadId ? [r.leadId] : []),
        visitIds: new Set([r.visitId, r.jobVisitId].filter((v): v is string => Boolean(v))),
      });
      continue;
    }
    if (r.revision > doc.latest.revision) doc.latest = r;
    if (r.createdAt < doc.firstIssuedAt) doc.firstIssuedAt = r.createdAt;
    if (r.leadId) doc.leadIds.add(r.leadId);
    if (r.visitId) doc.visitIds.add(r.visitId);
    if (r.jobVisitId) doc.visitIds.add(r.jobVisitId);
  }
  return [...byNumber.values()];
}

/** The account fallback needs every lead on the account, in range or not — see `attributeQuote`. */
type AccountLead = { id: string; createdAt: Date };

/**
 * Which lead a quote belongs to — no time window. Direct link first (the draft named the lead),
 * then the visit the lead was converted into, then the account: the LATEST lead on that account
 * created at or before the quote's first issue. A quote that predates every lead on the account
 * was not produced by any of them.
 *
 * The account fallback is ranked over EVERY lead on the account, not only the ones inside the
 * report's window, and the winner is then checked against the window. Ranking in-range leads only
 * would hand a September lead the credit for a quote that an October lead actually produced —
 * phase 2 would read high for the month you are looking at and never for the month that earned it.
 * Returns null when the closest lead is outside the window: that quote belongs to another period.
 */
function attributeQuote(
  doc: QuoteDoc,
  byId: Map<string, LeadRow>,
  byVisit: Map<string, LeadRow>,
  accountLeads: Map<string, AccountLead[]>,
): LeadRow | null {
  for (const id of doc.leadIds) {
    const lead = byId.get(id);
    if (lead) return lead;
  }
  for (const v of doc.visitIds) {
    const lead = byVisit.get(v);
    if (lead) return lead;
  }
  const closest = (accountLeads.get(doc.customerId) ?? [])
    .filter((l) => l.createdAt <= doc.firstIssuedAt)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return closest ? byId.get(closest.id) ?? null : null;
}

function tally(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

export async function getFunnelReport(prisma: PrismaClient, range: FunnelRange): Promise<FunnelReport> {
  const testIds = new Set(
    (await prisma.customer.findMany({ where: { isTestAccount: true }, select: { id: true } })).map((c) => c.id),
  );

  // ── Phases 1 and 2: the leads that arrived in the range ──────────────────────────────────
  const arrivals = await prisma.lead.findMany({
    where: { createdAt: { gte: range.start, lte: range.end } },
    select: {
      id: true, status: true, leadStatus: true, lostReason: true, platform: true, callType: true,
      customerId: true, visitId: true, existingVisitId: true, createdAt: true,
    },
  });
  const notLeads = arrivals.filter((l) => (NOT_A_LEAD_CALL_TYPES as readonly string[]).includes(l.callType ?? "")).length;
  const leads: LeadRow[] = arrivals.filter(
    (l) => !(NOT_A_LEAD_CALL_TYPES as readonly string[]).includes(l.callType ?? "") && !(l.customerId && testIds.has(l.customerId)),
  );

  const isOpportunity = (l: LeadRow) => l.status === "converted";
  const isLost = (l: LeadRow) => !isOpportunity(l) && (l.status === "lost" || l.leadStatus === "lost");

  const opportunities = leads.filter(isOpportunity);
  const lostLeads = leads.filter(isLost);
  const leadLostReasons: Record<string, number> = {};
  for (const l of lostLeads) tally(leadLostReasons, l.lostReason ?? "unrecorded");

  // Quotes that could belong to any of these leads (no window on the estimate side).
  const leadIds = leads.map((l) => l.id);
  const visitIds = leads.flatMap((l) => [l.visitId, l.existingVisitId]).filter((v): v is string => Boolean(v));
  const customerIds = [...new Set(leads.map((l) => l.customerId).filter((c): c is string => Boolean(c)))];
  const ESTIMATE_SELECT = {
    id: true, number: true, revision: true, status: true, lostReason: true, createdAt: true,
    leadId: true, visitId: true, jobVisitId: true, customerId: true,
  } as const;
  const candidateRows: EstimateRow[] = leads.length === 0 ? [] : await prisma.issuedEstimate.findMany({
    where: {
      changeOrderForId: null,
      account: { isTestAccount: false },
      OR: [
        { leadId: { in: leadIds } },
        ...(visitIds.length ? [{ visitId: { in: visitIds } }, { jobVisitId: { in: visitIds } }] : []),
        ...(customerIds.length ? [{ customerId: { in: customerIds } }] : []),
      ],
    },
    select: ESTIMATE_SELECT,
  });
  const byId = new Map(leads.map((l) => [l.id, l]));
  const byVisit = new Map<string, LeadRow>();
  for (const l of leads) {
    if (l.visitId) byVisit.set(l.visitId, l);
    if (l.existingVisitId && !byVisit.has(l.existingVisitId)) byVisit.set(l.existingVisitId, l);
  }
  // EVERY lead on the candidate accounts, in range or not — the ranking above needs them all.
  const accountLeadRows = customerIds.length === 0 ? [] : await prisma.lead.findMany({
    where: { customerId: { in: customerIds } },
    select: { id: true, customerId: true, createdAt: true },
  });
  const accountLeads = new Map<string, AccountLead[]>();
  for (const l of accountLeadRows) {
    if (!l.customerId) continue;
    accountLeads.set(l.customerId, [...(accountLeads.get(l.customerId) ?? []), { id: l.id, createdAt: l.createdAt }]);
  }
  const quotedLeadIds = new Set<string>();
  for (const doc of groupByNumber(candidateRows)) {
    if (!PRESENTED.has(doc.latest.status)) continue;
    const lead = attributeQuote(doc, byId, byVisit, accountLeads);
    if (lead) quotedLeadIds.add(lead.id);
  }

  const platformRows = new Map<string, PlatformRow>();
  for (const l of leads) {
    const key = l.platform ?? UNKNOWN_PLATFORM;
    const row = platformRows.get(key) ?? { platform: key, leads: 0, opportunities: 0, lost: 0, quoted: 0, opportunityRate: null };
    row.leads += 1;
    if (isOpportunity(l)) row.opportunities += 1;
    if (isLost(l)) row.lost += 1;
    if (quotedLeadIds.has(l.id)) row.quoted += 1;
    platformRows.set(key, row);
  }
  const byPlatform = [...platformRows.values()]
    .map((r) => ({ ...r, opportunityRate: pct(r.opportunities, r.leads) }))
    .sort((a, b) => b.leads - a.leads || a.platform.localeCompare(b.platform));

  // ── Phase 3: every quote first issued in the range, at its latest revision ───────────────
  const allRows: EstimateRow[] = await prisma.issuedEstimate.findMany({
    where: { changeOrderForId: null, account: { isTestAccount: false } },
    select: ESTIMATE_SELECT,
  });
  const allDocs = groupByNumber(allRows);
  const docs = allDocs.filter((d) => d.firstIssuedAt >= range.start && d.firstIssuedAt <= range.end);
  let contracted = 0, quoteLost = 0, quoteOpen = 0, unsent = 0, voided = 0;
  const quoteLostReasons: Record<string, number> = {};
  for (const d of docs) {
    switch (d.latest.status) {
      case "signed": contracted += 1; break;
      case "lost": quoteLost += 1; tally(quoteLostReasons, d.latest.lostReason ?? "unrecorded"); break;
      case "sent": case "viewed": case "expired": quoteOpen += 1; break;
      case "draft": unsent += 1; break;
      case "void": voided += 1; break;
      default: quoteOpen += 1;
    }
  }
  const issued = contracted + quoteLost + quoteOpen;

  // ── Phase 4: every account, lifetime ─────────────────────────────────────────────────────
  const accounts = await prisma.customer.findMany({
    where: { isTestAccount: false },
    select: { id: true, name: true, email: true, platform: true },
  });
  const collected = await collectedByCustomer(prisma);
  const signedDocs = allDocs.filter((d) => d.latest.status === "signed");
  const signedByCustomer = new Map<string, number>();
  for (const d of signedDocs) signedByCustomer.set(d.customerId, (signedByCustomer.get(d.customerId) ?? 0) + 1);
  const emails = accounts.map((a) => a.email?.toLowerCase()).filter((e): e is string => Boolean(e));
  const suppressed = new Set(
    (emails.length ? await prisma.emailSuppression.findMany({ where: { email: { in: emails } }, select: { email: true } }) : [])
      .map((s) => s.email.toLowerCase()),
  );

  let payingAccounts = 0, repeatAccounts = 0, lifetimeCollected = 0, reachable = 0, unsubscribed = 0, noEmail = 0;
  const retentionByPlatform = new Map<string, { platform: string; accounts: number; payingAccounts: number; repeatAccounts: number; collected: number }>();
  const ranked: FunnelReport["retention"]["topAccounts"] = [];
  for (const a of accounts) {
    const money = collected.get(a.id)?.collected ?? 0;
    const signed = signedByCustomer.get(a.id) ?? 0;
    const paying = money > 0;
    const repeat = signed >= 2;
    if (paying) payingAccounts += 1;
    if (repeat) repeatAccounts += 1;
    lifetimeCollected = round2(lifetimeCollected + money);
    const email = a.email?.toLowerCase();
    if (!email) noEmail += 1;
    else if (suppressed.has(email)) unsubscribed += 1;
    else reachable += 1;
    const key = a.platform ?? UNKNOWN_PLATFORM;
    const row = retentionByPlatform.get(key) ?? { platform: key, accounts: 0, payingAccounts: 0, repeatAccounts: 0, collected: 0 };
    row.accounts += 1;
    if (paying) row.payingAccounts += 1;
    if (repeat) row.repeatAccounts += 1;
    row.collected = round2(row.collected + money);
    retentionByPlatform.set(key, row);
    if (paying) ranked.push({ id: a.id, name: a.name, platform: a.platform, collected: money, signedInvoices: signed });
  }
  ranked.sort((x, y) => y.collected - x.collected || x.name.localeCompare(y.name));

  return {
    range,
    opportunity: {
      leads: leads.length,
      opportunities: opportunities.length,
      lost: lostLeads.length,
      open: leads.length - opportunities.length - lostLeads.length,
      notLeads,
      rate: pct(opportunities.length, leads.length),
      byPlatform,
      lostReasons: leadLostReasons,
    },
    quoted: {
      leads: leads.length,
      quoted: quotedLeadIds.size,
      rate: pct(quotedLeadIds.size, leads.length),
    },
    winRate: {
      issued,
      contracted,
      lost: quoteLost,
      open: quoteOpen,
      unsent,
      voided,
      rate: pct(contracted, issued),
      lostReasons: quoteLostReasons,
    },
    retention: {
      accounts: accounts.length,
      payingAccounts,
      repeatAccounts,
      lifetimeCollected,
      averagePerPayingAccount: payingAccounts > 0 ? round2(lifetimeCollected / payingAccounts) : null,
      newsletter: { reachable, unsubscribed, noEmail },
      byPlatform: [...retentionByPlatform.values()].sort((a, b) => b.collected - a.collected || a.platform.localeCompare(b.platform)),
      topAccounts: ranked.slice(0, 5),
    },
  };
}
