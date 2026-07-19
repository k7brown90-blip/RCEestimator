import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";

function formatDateInput(value: Date) {
  return value.toISOString().slice(0, 10);
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ").toUpperCase();
}

export function DashboardPage() {
  const today = useMemo(() => new Date(), []);
  const defaultStart = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - 29);
    return formatDateInput(d);
  }, [today]);
  const defaultEnd = useMemo(() => formatDateInput(today), [today]);

  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["crm-analytics", "overview", startDate, endDate],
    queryFn: () => api.crmOverview({ startDate, endDate }),
  });

  const topOverdue = data?.followUps.overdueLeads.slice(0, 8) ?? [];
  const topLossReasons = Object.entries(data?.winLoss.lossReasons ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div>
      <PageHeader
        title="CRM Dashboard"
        subtitle="Pipeline health, follow-up risk, win/loss trends, and close-cycle pace."
        actions={(
          <button className="btn btn-secondary" type="button" disabled={isFetching} onClick={() => refetch()}>
            {isFetching ? "Refreshing..." : "Refresh"}
          </button>
        )}
      >
        <div className="grid gap-2 rounded-xl border border-rce-border/80 bg-rce-bg/60 p-3 md:grid-cols-4">
          <label className="text-xs font-medium text-rce-soft">
            Start date
            <input className="field mt-1" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label className="text-xs font-medium text-rce-soft">
            End date
            <input className="field mt-1" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </label>
          <div className="md:col-span-2 flex items-end">
            <p className="text-xs text-rce-muted">Date range applies to funnel, win/loss, and cycle-time metrics.</p>
          </div>
        </div>
      </PageHeader>

      {isLoading ? <p className="text-sm text-rce-muted">Loading CRM analytics...</p> : null}
      {error ? <p className="text-sm text-red-600">Failed to load dashboard: {(error as Error).message}</p> : null}

      {data ? (
        <div className="space-y-4">
          <section className="grid gap-3 md:grid-cols-4">
            <div className="card p-4">
              <p className="text-xs font-semibold text-rce-soft">Total Leads</p>
              <p className="mt-2 text-2xl font-semibold text-rce-text">{data.funnel.total}</p>
            </div>
            <div className="card p-4">
              <p className="text-xs font-semibold text-rce-soft">Open Leads</p>
              <p className="mt-2 text-2xl font-semibold text-rce-text">{data.funnel.openCount}</p>
            </div>
            <div className="card p-4">
              <p className="text-xs font-semibold text-rce-soft">Overdue Follow-ups</p>
              <p className="mt-2 text-2xl font-semibold text-red-700">{data.followUps.overdueCount}</p>
            </div>
            <div className="card p-4">
              <p className="text-xs font-semibold text-rce-soft">Win Rate</p>
              <p className="mt-2 text-2xl font-semibold text-rce-success">{data.winLoss.winRate}%</p>
            </div>
          </section>

          <section className="card p-4">
            <h2 className="text-lg font-semibold text-rce-text">Pipeline Funnel</h2>
            <div className="mt-3 grid gap-2 md:grid-cols-4">
              {data.funnel.stages.map((stage) => (
                <div key={stage.status} className="rounded-lg border border-rce-border/70 bg-rce-bg/70 p-3">
                  <p className="text-xs font-semibold text-rce-soft">{statusLabel(stage.status)}</p>
                  <p className="mt-1 text-xl font-semibold text-rce-text">{stage.count}</p>
                  <p className="text-xs text-rce-muted">{stage.percent}% of range total</p>
                </div>
              ))}
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <div className="card p-4">
              <h2 className="text-lg font-semibold text-rce-text">Follow-up Risk</h2>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <div className="rounded-lg border border-rce-border/70 bg-rce-bg/70 p-3">
                  <p className="text-xs font-semibold text-rce-soft">Due Today</p>
                  <p className="mt-1 text-xl font-semibold text-rce-text">{data.followUps.dueTodayCount}</p>
                </div>
                <div className="rounded-lg border border-rce-border/70 bg-rce-bg/70 p-3">
                  <p className="text-xs font-semibold text-rce-soft">Next 7 Days</p>
                  <p className="mt-1 text-xl font-semibold text-rce-text">{data.followUps.dueNext7DaysCount}</p>
                </div>
                <div className="rounded-lg border border-rce-border/70 bg-rce-bg/70 p-3">
                  <p className="text-xs font-semibold text-rce-soft">Missing Date</p>
                  <p className="mt-1 text-xl font-semibold text-rce-text">{data.followUps.noFollowUpCount}</p>
                </div>
              </div>

              <div className="mt-4">
                <h3 className="text-sm font-semibold text-rce-text">Oldest Overdue Leads</h3>
                {topOverdue.length === 0 ? (
                  <p className="mt-2 text-sm text-rce-muted">No overdue follow-ups.</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {topOverdue.map((lead) => (
                      <li key={lead.id} className="rounded-md border border-rce-border/70 px-3 py-2 text-sm">
                        <p className="font-medium text-rce-text">{lead.name}</p>
                        <p className="text-xs text-rce-muted">
                          {lead.jobType || "Unknown job"} • {lead.source} • Due {lead.followUpDate ? new Date(lead.followUpDate).toLocaleDateString() : "N/A"}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="card p-4">
              <h2 className="text-lg font-semibold text-rce-text">Close Outcomes</h2>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-rce-border/70 bg-rce-bg/70 p-3">
                  <p className="text-xs font-semibold text-rce-soft">Won</p>
                  <p className="mt-1 text-xl font-semibold text-rce-success">{data.winLoss.won}</p>
                </div>
                <div className="rounded-lg border border-rce-border/70 bg-rce-bg/70 p-3">
                  <p className="text-xs font-semibold text-rce-soft">Lost</p>
                  <p className="mt-1 text-xl font-semibold text-red-700">{data.winLoss.lost}</p>
                </div>
              </div>

              <div className="mt-4">
                <h3 className="text-sm font-semibold text-rce-text">Top Loss Reasons</h3>
                {topLossReasons.length === 0 ? (
                  <p className="mt-2 text-sm text-rce-muted">No loss reasons recorded in this range.</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {topLossReasons.map(([reason, count]) => (
                      <li key={reason} className="flex items-center justify-between rounded-md border border-rce-border/70 px-3 py-2 text-sm">
                        <span className="text-rce-text">{reason.replaceAll("_", " ")}</span>
                        <span className="font-semibold text-rce-muted">{count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="mt-4 rounded-lg border border-rce-border/70 bg-rce-bg/70 p-3">
                <p className="text-xs font-semibold text-rce-soft">Estimate Acceptance (Sent → Accepted)</p>
                <p className="mt-1 text-xl font-semibold text-rce-text">{data.cycleTime.estimateAcceptanceRateFromSent}%</p>
                <p className="text-xs text-rce-muted">Avg close: {data.cycleTime.averageDaysToClose ?? "-"} days • Median: {data.cycleTime.medianDaysToClose ?? "-"} days</p>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
