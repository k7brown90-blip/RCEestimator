import { prisma } from "../lib/prisma";

const LEAD_STATUS_ORDER = [
  "new",
  "booked",
  "unresolved",
  "planning",
  "no_answer",
  "won",
  "lost",
] as const;

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
      createdAt: {
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
  const wonCount = counts.get("won") ?? 0;
  const lostCount = counts.get("lost") ?? 0;

  return {
    range,
    total,
    openCount,
    wonCount,
    lostCount,
    stages,
  };
}

export async function getLeadFollowUpMetrics() {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  const sevenDaysOut = new Date(endOfToday);
  sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);

  const openLeadFilter = { leadStatus: { in: OPEN_LEAD_STATUSES } } as const;

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
        followUpDate: { lt: now },
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

export async function getWinLossMetrics(range: AnalyticsRange) {
  const outcomes = await prisma.lead.findMany({
    where: {
      leadStatus: { in: ["won", "lost"] },
      updatedAt: {
        gte: range.start,
        lte: range.end,
      },
    },
    select: {
      leadStatus: true,
      lostReason: true,
      source: true,
    },
  });

  const won = outcomes.filter((lead) => lead.leadStatus === "won").length;
  const lost = outcomes.filter((lead) => lead.leadStatus === "lost").length;
  const totalClosed = won + lost;

  const lossReasons: Record<string, number> = {};
  const sourceSummary: Record<string, { won: number; lost: number }> = {};

  for (const lead of outcomes) {
    const source = lead.source || "unknown";
    sourceSummary[source] = sourceSummary[source] ?? { won: 0, lost: 0 };

    if (lead.leadStatus === "won") {
      sourceSummary[source].won += 1;
      continue;
    }

    sourceSummary[source].lost += 1;

    if (lead.lostReason) {
      lossReasons[lead.lostReason] = (lossReasons[lead.lostReason] ?? 0) + 1;
    }
  }

  return {
    range,
    totalClosed,
    won,
    lost,
    winRate: totalClosed > 0 ? Math.round((won / totalClosed) * 100) : 0,
    lossReasons,
    sourceSummary,
  };
}

export async function getCycleTimeMetrics(range: AnalyticsRange) {
  const wonLeads = await prisma.lead.findMany({
    where: {
      leadStatus: "won",
      updatedAt: {
        gte: range.start,
        lte: range.end,
      },
    },
    select: {
      id: true,
      name: true,
      source: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const cycleTimes = wonLeads
    .map((lead) => ({
      id: lead.id,
      name: lead.name,
      source: lead.source,
      daysToClose: Math.max(0, Math.round((lead.updatedAt.getTime() - lead.createdAt.getTime()) / (24 * 60 * 60 * 1000))),
    }))
    .sort((a, b) => a.daysToClose - b.daysToClose);

  const averageDaysToClose =
    cycleTimes.length > 0
      ? Number((cycleTimes.reduce((sum, item) => sum + item.daysToClose, 0) / cycleTimes.length).toFixed(1))
      : null;

  const medianDaysToClose =
    cycleTimes.length > 0
      ? cycleTimes[Math.floor(cycleTimes.length / 2)]?.daysToClose ?? null
      : null;

  const estimateStatusCounts = await prisma.estimate.groupBy({
    by: ["status"],
    where: {
      createdAt: {
        gte: range.start,
        lte: range.end,
      },
    },
    _count: { _all: true },
  });

  const estimateCounts = Object.fromEntries(
    estimateStatusCounts.map((row) => [row.status, row._count._all]),
  ) as Record<string, number>;

  const sentEstimateCount = estimateCounts.sent ?? 0;
  const acceptedEstimateCount = estimateCounts.accepted ?? 0;

  return {
    range,
    wonLeadCount: cycleTimes.length,
    averageDaysToClose,
    medianDaysToClose,
    cycleTimes,
    estimateCounts,
    estimateAcceptanceRateFromSent:
      sentEstimateCount > 0 ? Math.round((acceptedEstimateCount / sentEstimateCount) * 100) : 0,
  };
}

export async function getCrmOverview(range: AnalyticsRange) {
  const [funnel, followUps, winLoss, cycleTime] = await Promise.all([
    getLeadFunnelMetrics(range),
    getLeadFollowUpMetrics(),
    getWinLossMetrics(range),
    getCycleTimeMetrics(range),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    funnel,
    followUps,
    winLoss,
    cycleTime,
  };
}
