import { prisma } from "../lib/prisma";
import { getFunnelReport, type FunnelReport } from "./leadFunnel";
import { chicagoDayBounds } from "../../shared/calendarDay";

const LEAD_STATUS_ORDER = [
  "new",
  "booked",
  "unresolved",
  "planning",
  "no_answer",
  "won",
  "lost",
] as const;

// "won" is the column value; it MEANS "became an opportunity" (Kyle, 2026-09-20) and is never
// presented as a win — a win is a signed estimate, measured in services/leadFunnel.ts.
const OPEN_LEAD_STATUSES = LEAD_STATUS_ORDER.filter((status) => status !== "won" && status !== "lost");

export type AnalyticsRange = {
  start: Date;
  end: Date;
  startDate: string;
  endDate: string;
};

export function resolveAnalyticsRange(input: { startDate?: string; endDate?: string }): AnalyticsRange {
  const now = new Date();
  const end = input.endDate ? new Date(`${input.endDate}T23:59:59.999Z`) : now;
  const start = input.startDate
    ? new Date(`${input.startDate}T00:00:00.000Z`)
    : new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);

  return {
    start,
    end,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

export async function getLeadFunnelMetrics(range: AnalyticsRange) {
  const grouped = await prisma.lead.groupBy({
    by: ["leadStatus"],
    where: {
      // The day the lead REALLY arrived (Lead.receivedAt; plan lead-intake-fixes F3), so a
      // back-entered marketplace lead counts in the month it came in.
      receivedAt: {
        gte: range.start,
        lte: range.end,
      },
    },
    _count: { _all: true },
  });

  const counts = new Map(grouped.map((row) => [row.leadStatus, row._count._all]));
  const total = LEAD_STATUS_ORDER.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);

  const stages = LEAD_STATUS_ORDER.map((status) => {
    const count = counts.get(status) ?? 0;
    return {
      status,
      count,
      percent: total > 0 ? Math.round((count / total) * 100) : 0,
    };
  });

  const openCount = OPEN_LEAD_STATUSES.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);
  const opportunityCount = counts.get("won") ?? 0;
  const lostCount = counts.get("lost") ?? 0;

  return {
    range,
    total,
    openCount,
    opportunityCount,
    lostCount,
    stages,
  };
}

export async function getLeadFollowUpMetrics() {
  const now = new Date();
  // A follow-up date is a calendar DAY (stored at noon UTC), and "today" is the Chicago day —
  // never server-local time, and never "< now", which turned today's follow-ups overdue by
  // mid-morning and counted a lead in both the overdue and due-today chips (plan lead-intake-fixes, B2).
  const { startOfToday, endOfToday, sevenDaysOut } = chicagoDayBounds(now);

  // An open lead is one that is not lost by EITHER column (the Leads > Open tab's rule,
  // isLostLead in app.ts) and not converted: "A converted lead is a consultation not a job"
  // (Kyle, 2026-11-15), so it is no lead to chase. B3 of plan lead-intake-fixes.
  const openLeadFilter = {
    leadStatus: { in: OPEN_LEAD_STATUSES },
    status: { notIn: ["lost", "converted"] },
  };

  const [openLeads, overdueLeads] = await Promise.all([
    prisma.lead.findMany({
      where: openLeadFilter,
      select: {
        id: true,
        name: true,
        phone: true,
        source: true,
        jobType: true,
        leadStatus: true,
        followUpDate: true,
      },
    }),
    prisma.lead.findMany({
      where: {
        ...openLeadFilter,
        followUpDate: { lt: startOfToday },
      },
      select: {
        id: true,
        name: true,
        phone: true,
        source: true,
        jobType: true,
        status: true,
        leadStatus: true,
        followUpDate: true,
      },
      orderBy: { followUpDate: "asc" },
      take: 25,
    }),
  ]);

  const dueTodayCount = openLeads.filter(
    (lead) => lead.followUpDate && lead.followUpDate >= startOfToday && lead.followUpDate < endOfToday,
  ).length;

  const dueNext7DaysCount = openLeads.filter(
    (lead) => lead.followUpDate && lead.followUpDate >= endOfToday && lead.followUpDate < sevenDaysOut,
  ).length;

  const noFollowUpCount = openLeads.filter((lead) => !lead.followUpDate).length;

  return {
    asOf: now.toISOString(),
    openLeadCount: openLeads.length,
    overdueCount: overdueLeads.length,
    dueTodayCount,
    dueNext7DaysCount,
    noFollowUpCount,
    overdueLeads,
  };
}

/**
 * The four-phase funnel (Kyle, 2026-09-20). Replaces `getWinLossMetrics` — whose "win rate" was
 * won leads / (won + lost leads), phase 1 data wearing a phase 3 label — and `getCycleTimeMetrics`,
 * whose acceptance rate read the retired legacy Estimate model. Both deleted with this.
 */
export async function getFourPhaseFunnel(range: AnalyticsRange): Promise<FunnelReport> {
  return getFunnelReport(prisma, range);
}

export async function getCrmOverview(range: AnalyticsRange) {
  const [funnel, followUps, phases] = await Promise.all([
    getLeadFunnelMetrics(range),
    getLeadFollowUpMetrics(),
    getFourPhaseFunnel(range),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    funnel,
    followUps,
    phases,
  };
}
