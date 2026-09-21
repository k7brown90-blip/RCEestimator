import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { BouncedEmailsCard } from "../components/BouncedEmailsCard";
import { Modal } from "../components/Modal";
import { OpenDrawerButton } from "../components/drawers/OpenDrawerButton";
import { api } from "../lib/api";
import { useDrawerParams } from "../lib/drawers";
import { LEAD_LOST_REASONS, type CrmFunnelReport, type OverdueLead } from "../lib/types";
import { money } from "../lib/utils";
import { platformLabel } from "../../../shared/leadPlatform";

function formatDateInput(value: Date) {
  return value.toISOString().slice(0, 10);
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ").toUpperCase();
}

const asPercent = (rate: number | null) => (rate == null ? "—" : `${rate}%`);

/**
 * ONE PHASE OF THE FUNNEL, with its numerator and its denominator stated on the card.
 *
 * The rebuild exists because "Win Rate" was won leads over won + lost leads — phase 1 data
 * wearing a phase 3 label (Kyle, 2026-09-20). A rate whose two numbers are not written down is
 * how that happened, so every card here shows "N of D" underneath the percentage.
 */
function PhaseCard({ phase, title, rate, numerator, denominator, measure, note, tone }: {
  phase: 1 | 2 | 3 | 4;
  title: string;
  rate: string;
  numerator: number;
  denominator: number;
  measure: string;
  note?: string;
  tone?: "headline";
}) {
  return (
    <div className={`card p-4 ${tone === "headline" ? "border-rce-success/60" : ""}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-rce-muted">Phase {phase}</p>
      <p className="text-xs font-semibold text-rce-soft">{title}</p>
      <p className={`mt-2 text-2xl font-semibold ${tone === "headline" ? "text-rce-success" : "text-rce-text"}`}>{rate}</p>
      <p className="text-sm text-rce-text">{numerator} of {denominator}</p>
      <p className="mt-1 text-xs text-rce-muted">{measure}</p>
      {note ? <p className="mt-1 text-xs text-rce-soft">{note}</p> : null}
    </div>
  );
}

/** Why something was lost. TWO of these render, over two different populations — never merged. */
function LossReasons({ title, subtitle, reasons, total }: {
  title: string; subtitle: string; reasons: Record<string, number>; total: number;
}) {
  const rows = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  return (
    <div className="rounded-lg border border-rce-border/70 bg-rce-bg/70 p-3">
      <h3 className="text-sm font-semibold text-rce-text">{title}</h3>
      <p className="text-xs text-rce-muted">{subtitle}</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-rce-muted">
          {total === 0 ? "Nothing lost in this range." : "None of them has a reason recorded."}
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {rows.map(([reason, count]) => (
            <li key={reason} className="flex items-center justify-between rounded-md border border-rce-border/70 px-3 py-1.5 text-sm">
              <span className="text-rce-text">{reason === "unrecorded" ? "no reason recorded" : reason.replaceAll("_", " ")}</span>
              <span className="font-semibold text-rce-muted">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Phase 1 read by platform — the answer to "is Google / Yelp / Nextdoor / Angi worth it". */
function PlatformTable({ rows }: { rows: CrmFunnelReport["opportunity"]["byPlatform"] }) {
  if (rows.length === 0) return <p className="mt-2 text-sm text-rce-muted">No leads in this range.</p>;
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs font-semibold text-rce-soft">
            <th className="py-1 pr-3">Platform</th>
            <th className="py-1 pr-3 text-right">Leads</th>
            <th className="py-1 pr-3 text-right">Opportunities</th>
            <th className="py-1 pr-3 text-right">Quoted</th>
            <th className="py-1 pr-3 text-right">Lost</th>
            <th className="py-1 text-right">Opportunity rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.platform} className="border-t border-rce-border/70">
              <td className="py-1.5 pr-3 text-rce-text">{platformLabel(row.platform === "unknown" ? null : row.platform)}</td>
              <td className="py-1.5 pr-3 text-right text-rce-text">{row.leads}</td>
              <td className="py-1.5 pr-3 text-right text-rce-text">{row.opportunities}</td>
              <td className="py-1.5 pr-3 text-right text-rce-text">{row.quoted}</td>
              <td className="py-1.5 pr-3 text-right text-rce-text">{row.lost}</td>
              <td className="py-1.5 text-right font-semibold text-rce-text">{asPercent(row.opportunityRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardPage() {
  const queryClient = useQueryClient();
  const drawers = useDrawerParams();
  const today = useMemo(() => new Date(), []);
  const defaultStart = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - 29);
    return formatDateInput(d);
  }, [today]);
  const defaultEnd = useMemo(() => formatDateInput(today), [today]);

  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);
  // Mark Lost needs a reason — the Top Loss Reasons card on this same page
  // reads exactly this field, and it was going unset from here.
  const [losingLead, setLosingLead] = useState<OverdueLead | null>(null);
  const [lostReason, setLostReason] = useState("");
  const [lostNotes, setLostNotes] = useState("");

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["crm-analytics", "overview", startDate, endDate],
    queryFn: () => api.crmOverview({ startDate, endDate }),
  });

  const invalidateLeads = () => {
    queryClient.invalidateQueries({ queryKey: ["crm-analytics", "overview"] });
    queryClient.invalidateQueries({ queryKey: ["leads"] });
  };

  const leadActionMutation = useMutation({
    mutationFn: ({ leadId, input }: { leadId: string; input: Parameters<typeof api.updateLead>[1] }) =>
      api.updateLead(leadId, input),
    onSuccess: invalidateLeads,
  });

  const runLeadAction = (leadId: string, input: Parameters<typeof api.updateLead>[1]) => {
    leadActionMutation.mutate({ leadId, input });
  };

  /**
   * Mark Won used to PATCH status:"converted" directly, which mints a
   * converted lead with no account/property/job behind it — and a converted
   * lead can never be deleted. Routes through the real convert endpoint
   * instead, same as the Leads page.
   */
  const convertMutation = useMutation({
    mutationFn: (leadId: string) => api.convertLead(leadId),
    onSuccess: invalidateLeads,
    onError: (err: unknown) => {
      const body = (err as { body?: { matches?: unknown[]; needs?: string; message?: string } })?.body;
      if (body?.matches?.length) {
        window.alert(
          "This lead's contact details match an account you already have. Open it on the Leads page to link it to that account or confirm a new one.",
        );
        return;
      }
      if (body?.needs === "address") {
        window.alert(
          body.message ?? "This lead has no usable address, so it can't be converted yet. Add one on the Leads page.",
        );
        return;
      }
      window.alert((err as Error).message ?? "Could not mark this lead won.");
    },
  });

  /**
   * Marking a lead lost with no reason left the loss report — the card right
   * below this one — reading nothing for it.
   */
  const lostMutation = useMutation({
    mutationFn: (input: { leadId: string; lostReason: string; lostNotes: string }) =>
      api.updateLead(input.leadId, {
        status: "lost",
        leadStatus: "lost",
        lostReason: input.lostReason as never,
        lostNotes: input.lostNotes.trim() || null,
        followUpDate: null,
      }),
    onSuccess: () => {
      invalidateLeads();
      setLosingLead(null);
      setLostReason("");
      setLostNotes("");
    },
  });

  const isoDatePlusDays = (days: number) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString();
  };

  const topOverdue = data?.followUps.overdueLeads.slice(0, 8) ?? [];
  const phases = data?.phases;

  return (
    <div>
      {/* Kyle, 2026-09-11: "Bounced emails should display in the Dashboard not on the
          financials page." A customer who never got the estimate is the day's first
          problem, so it sits above everything else and hides itself when the list is
          empty. */}
      <BouncedEmailsCard />

      <PageHeader
        title="CRM Dashboard"
        subtitle="The four phases — lead to account, lead to estimate, estimate to job, and account to repeat — plus what is overdue."
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
            <p className="text-xs text-rce-muted">
              The range windows phases 1–3: leads by when they arrived, quotes by when they were first issued.
              Phase 4 is lifetime and ignores it.
            </p>
          </div>
        </div>
      </PageHeader>

      {isLoading ? <p className="text-sm text-rce-muted">Loading CRM analytics...</p> : null}
      {error ? <p className="text-sm text-red-600">Failed to load dashboard: {(error as Error).message}</p> : null}

      {data && phases ? (
        <div className="space-y-4">
          {/*
            THE FOUR MEASURES (Kyle, 2026-09-20). "We have to recognize the difference between
            winning a job and gaining an opportunity." Nothing is WON at the lead stage: a lead
            becomes an opportunity or it is lost, and the win rate is the estimate that became a
            signed job.
          */}
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <PhaseCard
              phase={1}
              title="Lead → account"
              rate={asPercent(phases.opportunity.rate)}
              numerator={phases.opportunity.opportunities}
              denominator={phases.opportunity.leads}
              measure="Opportunities (account + address + job) out of the leads that arrived."
              note={phases.opportunity.notLeads > 0
                ? `${phases.opportunity.notLeads} call${phases.opportunity.notLeads === 1 ? "" : "s"} excluded — wrong number, solicitation or vendor.`
                : undefined}
            />
            <PhaseCard
              phase={2}
              title="Lead → estimate"
              rate={asPercent(phases.quoted.rate)}
              numerator={phases.quoted.quoted}
              denominator={phases.quoted.leads}
              measure="Leads we actually got in front of with a quote. No time window on the quote."
            />
            <PhaseCard
              phase={3}
              title="Estimate → job (THE win rate)"
              rate={asPercent(phases.winRate.rate)}
              numerator={phases.winRate.contracted}
              denominator={phases.winRate.issued}
              measure="Signed quotes out of quotes put in front of a customer. One estimate number counts once, at its latest revision."
              note={`${phases.winRate.open} still out • ${phases.winRate.lost} lost • ${phases.winRate.unsent} never sent and ${phases.winRate.voided} void, both outside the rate.`}
              tone="headline"
            />
            <PhaseCard
              phase={4}
              title="Account → repeat"
              rate={money(phases.retention.lifetimeCollected)}
              numerator={phases.retention.repeatAccounts}
              denominator={phases.retention.payingAccounts}
              measure="Lifetime money COLLECTED, and the paying accounts that came back for a second signed job."
              note={`Newsletter reaches ${phases.retention.newsletter.reachable} of ${phases.retention.accounts} accounts • ${phases.retention.newsletter.unsubscribed} unsubscribed • ${phases.retention.newsletter.noEmail} with no email.`}
            />
          </section>

          {/*
            Phase 1 BY PLATFORM — the whole reason the platform field exists. Accounts and leads
            tagged before it did read "Unknown"; that is honest, and it fills as leads come in.
          */}
          <section className="card p-4">
            <h2 className="text-lg font-semibold text-rce-text">Where the leads came from</h2>
            <p className="text-xs text-rce-muted">
              Which platform sent the lead — separate from how it arrived. This is the number that
              says whether Google, Yelp, Nextdoor or Angi is worth what it costs.
            </p>
            <PlatformTable rows={phases.opportunity.byPlatform} />
          </section>

          {/*
            TWO LOSS QUESTIONS, NEVER ONE LIST (Kyle, 2026-09-20). Why a lead never became an
            opportunity and why a quote was lost are different populations with different fixes,
            even though they share one vocabulary.
          */}
          <section className="card p-4">
            <h2 className="text-lg font-semibold text-rce-text">Why we lost</h2>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <LossReasons
                title={`Leads that never became an account (${phases.opportunity.lost})`}
                subtitle="Before a quote ever existed — reachability, fit, timing."
                reasons={phases.opportunity.lostReasons}
                total={phases.opportunity.lost}
              />
              <LossReasons
                title={`Quotes lost after we priced them (${phases.winRate.lost})`}
                subtitle="They hired someone else, or stopped. This is what pricing and closing move."
                reasons={phases.winRate.lostReasons}
                total={phases.winRate.lost}
              />
            </div>
          </section>

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
              <p className="text-xs font-semibold text-rce-soft">Accounts that have paid</p>
              <p className="mt-2 text-2xl font-semibold text-rce-text">{phases.retention.payingAccounts}</p>
              <p className="text-xs text-rce-muted">
                Average {phases.retention.averagePerPayingAccount == null ? "—" : money(phases.retention.averagePerPayingAccount)} collected each
              </p>
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
                        {/* The lead carries its own actions (2026-09-20): the name opens its drawer. */}
                        <OpenDrawerButton kind="lead" id={lead.id} onOpen={drawers.open} className="font-medium text-rce-text hover:underline">
                          {lead.name}
                        </OpenDrawerButton>
                        <p className="text-xs text-rce-muted">
                          {lead.jobType || "Unknown job"} • {lead.source} • Due {lead.followUpDate ? new Date(lead.followUpDate).toLocaleDateString() : "N/A"}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="rounded-md border border-blue-300 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
                            disabled={leadActionMutation.isPending}
                            onClick={() =>
                              runLeadAction(lead.id, {
                                status: "contacted",
                                leadStatus: "unresolved",
                              })}
                          >
                            Mark Contacted
                          </button>
                          <button
                            type="button"
                            className="rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
                            disabled={leadActionMutation.isPending}
                            onClick={() =>
                              runLeadAction(lead.id, {
                                leadStatus: "planning",
                                followUpDate: isoDatePlusDays(2),
                              })}
                          >
                            Snooze +2d
                          </button>
                          <button
                            type="button"
                            className="rounded-md border border-green-300 bg-green-50 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-100"
                            disabled={convertMutation.isPending}
                            onClick={() => convertMutation.mutate(lead.id)}
                          >
                            {convertMutation.isPending ? "Converting…" : "Convert"}
                          </button>
                          <button
                            type="button"
                            className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                            disabled={leadActionMutation.isPending}
                            onClick={() => { setLosingLead(lead); setLostReason(""); setLostNotes(""); }}
                          >
                            Mark Lost
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/*
              PHASE 4 — the accounts, lifetime. Deliberately not windowed by the date range: a
              customer's lifetime spend is not a fact about September.
            */}
            <div className="card p-4">
              <h2 className="text-lg font-semibold text-rce-text">Accounts and repeat work</h2>
              <p className="text-xs text-rce-muted">
                Lifetime, all time. Spend is money COLLECTED, not invoiced — one definition, the same
                one the Accounts list and the account page now show.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <div className="rounded-lg border border-rce-border/70 bg-rce-bg/70 p-3">
                  <p className="text-xs font-semibold text-rce-soft">Collected</p>
                  <p className="mt-1 text-xl font-semibold text-rce-success">{money(phases.retention.lifetimeCollected)}</p>
                </div>
                <div className="rounded-lg border border-rce-border/70 bg-rce-bg/70 p-3">
                  <p className="text-xs font-semibold text-rce-soft">Paying accounts</p>
                  <p className="mt-1 text-xl font-semibold text-rce-text">{phases.retention.payingAccounts}</p>
                </div>
                <div className="rounded-lg border border-rce-border/70 bg-rce-bg/70 p-3">
                  <p className="text-xs font-semibold text-rce-soft">Came back</p>
                  <p className="mt-1 text-xl font-semibold text-rce-text">{phases.retention.repeatAccounts}</p>
                  <p className="text-xs text-rce-muted">Two or more signed jobs</p>
                </div>
              </div>

              <div className="mt-4">
                <h3 className="text-sm font-semibold text-rce-text">Biggest accounts</h3>
                {phases.retention.topAccounts.length === 0 ? (
                  <p className="mt-2 text-sm text-rce-muted">Nothing collected yet.</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {phases.retention.topAccounts.map((account) => (
                      <li key={account.id} className="flex items-center justify-between rounded-md border border-rce-border/70 px-3 py-2 text-sm">
                        <span className="text-rce-text">
                          {account.name}
                          <span className="ml-2 text-xs text-rce-muted">
                            {platformLabel(account.platform)} • {account.signedInvoices} signed
                          </span>
                        </span>
                        <span className="font-semibold text-rce-muted">{money(account.collected)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {losingLead && (
        <Modal
          title={`Mark ${losingLead.name} lost`}
          subtitle="Why it didn't close — this is what the Top Loss Reasons card above reads."
          onClose={() => setLosingLead(null)}
        >
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              lostMutation.mutate({ leadId: losingLead.id, lostReason, lostNotes });
            }}
          >
            <label className="block text-sm font-medium">
              Reason
              <select className="field mt-1" value={lostReason} onChange={(e) => setLostReason(e.target.value)} required>
                <option value="">Pick one</option>
                {LEAD_LOST_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label className="block text-sm font-medium">
              What they said <span className="text-rce-soft">(optional)</span>
              <textarea className="field mt-1" rows={2} value={lostNotes} onChange={(e) => setLostNotes(e.target.value)} />
              <span className="mt-1 block text-xs text-rce-soft">
                Internal only — never shared with the customer.
              </span>
            </label>
            {lostMutation.error && (
              <p className="text-sm text-red-600">{(lostMutation.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-secondary text-xs" onClick={() => setLosingLead(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary text-xs" disabled={lostMutation.isPending}>
                {lostMutation.isPending ? "Saving…" : "Mark Lost"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
