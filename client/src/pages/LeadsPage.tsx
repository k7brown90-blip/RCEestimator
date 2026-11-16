import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { AttentionStrip } from "../components/AttentionStrip";
import { OpenDrawerButton } from "../components/drawers/OpenDrawerButton";
import { api } from "../lib/api";
import { useDrawerParams } from "../lib/drawers";
import { formatDay, formatReceived } from "../../../shared/calendarDay";
import type { Lead, LeadPipeline, LeadSource, LeadStatus } from "../lib/types";

/**
 * The funnel, not the lead's own state. A lead sits here until it's booked;
 * once it has an appointment it belongs to the Calendar.
 *
 * THE CARD SHOWS; THE DRAWER ACTS (2026-09-21, drawers plan Phase 6). Every action a lead
 * card used to carry — Edit, Mark Contacted, Go to Job, Schedule / Reschedule, Convert only
 * (with the duplicate-account question), Mark Lost with a reason, join / leave the email
 * campaign, Delete — lives in the lead's drawer (`LeadDrawer`), which Open on each card
 * raises over this list without leaving it. The card-side buttons, the scheduling modal, the
 * mark-lost modal and the duplicate picker that shipped beside the drawer in build #2 were
 * the duplicate surface Kyle chose to delete ("drawers win").
 */
/*
  NO "Scheduled" TAB (Kyle, 2026-08-22): "When someone is scheduled it should move them to the
  jobs page and take them out of the leads page."

  The server's "open" pipeline already dropped scheduled leads; this tab was a second home for
  them inside Leads, so a booked customer appeared to still be a lead. Scheduling a visit creates
  the job, and the Jobs page is where booked work lives — one place per stage of the funnel.
*/
const PIPELINE_TABS: Array<{ value: LeadPipeline; label: string; blurb: string }> = [
  { value: "open", label: "Open", blurb: "Not yet contacted or scheduled — this is your work queue." },
  { value: "closed", label: "Closed", blurb: "Lost, or the job is finished." },
];

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "converted", label: "Converted" },
];

const statusBadgeClass: Record<LeadStatus, string> = {
  new: "bg-rce-accentBg text-rce-warning",
  contacted: "bg-blue-100 text-blue-700",
  converted: "bg-green-100 text-rce-success",
  lost: "bg-zinc-200 text-zinc-700",
};

const statusLabel: Record<LeadStatus, string> = {
  new: "NEW",
  contacted: "CONTACTED",
  converted: "CONVERTED",
  lost: "LOST",
};

// Every source that actually reaches this column. `savannah_text` and
// `retention` were missing and rendered as unstyled badges.
const sourceBadgeClass: Record<LeadSource, string> = {
  manual: "bg-zinc-200 text-zinc-700",
  email: "bg-purple-100 text-purple-700",
  phone: "bg-teal-100 text-teal-700",
  web: "bg-indigo-100 text-indigo-700",
  referral: "bg-amber-100 text-amber-800",
  savannah_text: "bg-teal-100 text-teal-700",
  retention: "bg-green-100 text-green-700",
};

/**
 * The address to show, from whichever track has one.
 *
 * Manually entered leads fill the structured columns; webhook and voice-agent
 * leads fill the single free-text line.
 */
function displayAddress(lead: Lead): string | null {
  // A part address counts (plan lead-intake-fixes B1, "Allow part") — State alone does not, the
  // form defaults it. Same guard as LeadDrawer's copy.
  if (lead.addressLine1 || lead.city || lead.postalCode) {
    return [
      lead.addressLine1,
      lead.addressLine2,
      lead.city,
      [lead.state, lead.postalCode].filter(Boolean).join(" "),
    ].filter(Boolean).join(", ");
  }
  return lead.address ?? null;
}

/**
 * Does this lead match what was typed in "Search leads…"? (Plan lead-intake-fixes F1.)
 *
 * Name, email and address match as text (case aside); `displayAddress` covers both address tracks
 * (the structured columns and the webhook's free-text line), and city and ZIP are matched on their
 * own for a lead that has them without a street. A PHONE matches on digits, so "(615) 555-0101"
 * finds a lead stored as "+16155550101" — but only when the whole box looks like a phone number and
 * has at least four digits, the same rule the global Search uses (`phoneNeedle` in
 * services/globalSearch.ts). Otherwise "Apt 101" would match every phone containing 101.
 */
function leadMatchesSearch(lead: Lead, rawNeedle: string): boolean {
  const needle = rawNeedle.trim().toLowerCase();
  if (!needle) return true;
  const text = [lead.name, lead.email, displayAddress(lead), lead.city, lead.postalCode]
    .some((field) => field?.toLowerCase().includes(needle));
  if (text) return true;
  if (!/^[\d\s().+-]+$/.test(needle)) return false;
  const digits = needle.replace(/\D/g, "");
  return digits.length >= 4 && (lead.phone ?? "").replace(/\D/g, "").includes(digits);
}

/** What this lead is waiting on, derived from its linked visit. */
function funnelState(lead: Lead): { label: string; className: string } | null {
  const visit = lead.linkedVisit;
  if (lead.status === "lost") return { label: "Lost", className: "bg-zinc-200 text-zinc-700" };
  if (!visit) return null;
  if (visit.status === "completed") return { label: "Job completed", className: "bg-green-100 text-rce-success" };
  if (visit.status === "cancelled") return { label: "Job cancelled", className: "bg-red-100 text-red-700" };
  if (visit.scheduledStart) {
    const when = new Date(visit.scheduledStart).toLocaleString("en-US", {
      timeZone: "America/Chicago",
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    return { label: `Scheduled ${when}`, className: "bg-rce-accentBg text-rce-warning" };
  }
  return { label: "Converted — needs scheduling", className: "bg-amber-100 text-amber-800" };
}

/**
 * The tab's question (attention strip, 2026-09-20): which leads are waiting on a call? Read
 * from `/crm/analytics/follow-ups` — the same numbers the Dashboard shows in its overdue
 * list, on the tab where the lead can actually be worked. (`/leads/follow-ups-due` is the
 * webhook-secret automation pull and is not reachable from a session; this one is.)
 */
function LeadsAttention() {
  const { data } = useQuery({ queryKey: ["crm-analytics", "follow-ups"], queryFn: api.crmFollowUps });
  const drawers = useDrawerParams();
  if (!data) return null;
  return (
    <AttentionStrip
      chips={[
        { key: "overdue", label: `${data.overdueCount} follow-up${data.overdueCount === 1 ? "" : "s"} overdue`, count: data.overdueCount, tone: "red" },
        { key: "today", label: `${data.dueTodayCount} due today`, count: data.dueTodayCount },
        { key: "none", label: `${data.noFollowUpCount} open with no follow-up date`, count: data.noFollowUpCount },
      ]}
      rows={data.overdueLeads.map((lead) => ({
        key: lead.id,
        text: <>{lead.name} — follow-up was due {lead.followUpDate ? formatDay(lead.followUpDate) : "earlier"}</>,
        detail: [lead.jobType, lead.phone, lead.leadStatus.replaceAll("_", " ")].filter(Boolean).join(" · "),
        action: <OpenDrawerButton kind="lead" id={lead.id} onOpen={drawers.open} />,
      }))}
      moreText="the rest are in the Open queue"
    />
  );
}

export function LeadsPage() {
  const drawers = useDrawerParams();
  const [pipeline, setPipeline] = useState<LeadPipeline>("open");
  const [statusFilter, setStatusFilter] = useState("");
  // "Search leads…" (Kyle, 2026-11-15, plan lead-intake-fixes F1) — the Accounts box, for leads.
  // Typing searches Open AND Closed together; empty = the tab view below, unchanged.
  const [search, setSearch] = useState("");
  const searching = search.trim() !== "";

  const { data: tabLeads = [], isLoading: tabLoading, error: tabError } = useQuery({
    queryKey: ["leads", { pipeline, statusFilter }],
    queryFn: () => api.leads({ pipeline, status: statusFilter || undefined }),
  });

  // The two tabs' own lists, under the same query keys the tabs use (statusFilter "") so a lead
  // saved from its drawer — which invalidates ["leads"] — refreshes the search results too. The
  // server stays the only place that decides which tab a lead is on; the card is tagged from the
  // list that returned it. Scheduled leads live on Jobs, not here, so they are not searched.
  const tabSearches = useQueries({
    queries: (["open", "closed"] as const).map((pipeline) => {
      const statusFilter = "";
      return {
        queryKey: ["leads", { pipeline, statusFilter }],
        queryFn: () => api.leads({ pipeline, status: statusFilter || undefined }),
        enabled: searching,
      };
    }),
  });
  const openResult = tabSearches[0];
  const closedResult = tabSearches[1];

  const searchRows = useMemo(() => {
    if (!searching) return [];
    const byId = new Map<string, { lead: Lead; tab: LeadPipeline }>();
    for (const lead of openResult?.data ?? []) byId.set(lead.id, { lead, tab: "open" });
    // Closed wins a tie: a lost lead is lost whatever else is on its calendar.
    for (const lead of closedResult?.data ?? []) byId.set(lead.id, { lead, tab: "closed" });
    return [...byId.values()].filter((row) => leadMatchesSearch(row.lead, search));
  }, [searching, search, openResult?.data, closedResult?.data]);

  const rows: Array<{ lead: Lead; tab: LeadPipeline | null }> = searching
    ? searchRows
    : tabLeads.map((lead) => ({ lead, tab: null }));
  const isLoading = searching ? tabSearches.some((q) => q.isLoading) : tabLoading;
  const error = searching ? (tabSearches.find((q) => q.error)?.error ?? null) : tabError;

  /**
   * Email campaign membership (Kyle, 2026-09-02) is SHOWN on the card — which leads are on the
   * Storm Preparedness list, at a glance. Joining and leaving the list are actions, and they
   * are in the lead's drawer beside its other actions.
   */
  const { data: campaignMembership } = useQuery({
    queryKey: ["campaignLeadMembership"],
    queryFn: api.campaignLeadMembership,
  });
  const campaignLeadIds = new Set(campaignMembership?.leadIds ?? []);

  const activeTab = PIPELINE_TABS.find((tab) => tab.value === pipeline)!;

  return (
    <div>
      <PageHeader
        title="Leads"
        subtitle="Inbound inquiries, and anything you take down by hand"
        actions={<Link to="/leads/new" className="btn btn-primary">+ New Lead</Link>}
      />

      <LeadsAttention />

      {/* One box over both tabs. Always shown — gating it on "there are leads" would hide it on an
          empty Open tab, which is where the page opens. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          className="field w-full md:max-w-sm"
          placeholder="Search leads…"
          aria-label="Search leads"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {searching ? (
          <button type="button" className="btn btn-secondary text-xs" onClick={() => setSearch("")}>
            Clear search
          </button>
        ) : null}
      </div>

      {searching ? (
        <p className="mb-4 text-xs text-rce-muted">
          Searching Open and Closed together — name, phone, email or address. Clear the box to go back to the tabs.
        </p>
      ) : (
        <>
      {/* Pipeline tabs */}
      <div className="mb-2 flex flex-wrap gap-2">
        {PIPELINE_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => { setPipeline(tab.value); setStatusFilter(""); }}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
              pipeline === tab.value
                ? "bg-rce-accent text-rce-text"
                : "bg-rce-border/40 text-rce-muted hover:bg-rce-border"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <p className="mb-4 text-xs text-rce-muted">{activeTab.blurb}</p>

      {/* Secondary status filter — only meaningful inside the open queue */}
      {pipeline === "open" && (
        <div className="mb-5 flex flex-wrap gap-2">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setStatusFilter(f.value)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                statusFilter === f.value
                  ? "bg-rce-accentBg text-rce-warning"
                  : "bg-rce-border/30 text-rce-muted hover:bg-rce-border"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
        </>
      )}

      {isLoading ? <p className="text-sm text-rce-muted">Loading leads…</p> : null}
      {error ? <p className="text-sm text-red-500">Error loading leads: {(error as Error).message}</p> : null}

      {!isLoading && rows.length === 0 ? (
        <p className="text-sm text-rce-muted">
          {searching
            ? "No leads match that search."
            : pipeline === "open" ? "Nothing waiting — the queue is clear." : "No leads here."}
        </p>
      ) : null}

      <section className="space-y-3">
        {rows.map(({ lead, tab }) => {
          const state = funnelState(lead);

          return (
            <div key={lead.id} className="card block p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">{lead.name}</h2>
                <div className="flex flex-wrap items-center gap-2">
                  {/* Which tab this lead is on — only while searching both. */}
                  {tab ? (
                    <span
                      data-lead-tab={tab}
                      className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-semibold ${
                        tab === "open" ? "bg-rce-accentBg text-rce-warning" : "bg-zinc-200 text-zinc-700"
                      }`}
                    >
                      {tab === "open" ? "OPEN" : "CLOSED"}
                    </span>
                  ) : null}
                  {lead.callType ? (
                    <span className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-semibold ${
                      lead.callType === "warranty" ? "bg-orange-100 text-orange-700" :
                      lead.callType === "callback" ? "bg-blue-100 text-blue-700" :
                      lead.callType === "new_job" ? "bg-green-100 text-green-700" :
                      lead.callType === "cancellation" ? "bg-red-100 text-red-700" :
                      "bg-zinc-100 text-zinc-600"
                    }`}>
                      {lead.callType.replace(/_/g, " ").toUpperCase()}
                    </span>
                  ) : null}
                  <span className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-semibold ${sourceBadgeClass[lead.source]}`}>
                    {lead.source.toUpperCase()}
                  </span>
                  <span className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-semibold ${statusBadgeClass[lead.status]}`}>
                    {statusLabel[lead.status]}
                  </span>
                </div>
              </div>

              {state && (
                <p className={`mt-2 inline-block rounded px-2 py-1 text-xs font-medium ${state.className}`}>
                  {state.label}
                </p>
              )}

              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-rce-muted">
                {lead.email ? <span>{lead.email}</span> : null}
                {lead.phone ? <span>{lead.phone}</span> : null}
                <span>Received {formatReceived(lead.receivedAt)}</span>
              </div>

              {(displayAddress(lead) || lead.jobType) ? (
                <div className="mt-2 flex flex-wrap gap-x-5 text-sm">
                  {displayAddress(lead) ? <p><span className="text-rce-soft">Address:</span> {displayAddress(lead)}</p> : null}
                  {lead.jobType ? <p><span className="text-rce-soft">Job Type:</span> {lead.jobType}</p> : null}
                </div>
              ) : null}

              {lead.customerId && (
                <p className="mt-1 text-xs text-rce-accent">Linked to an existing account</p>
              )}

              {lead.notes ? <p className="mt-2 text-sm text-rce-muted">{lead.notes}</p> : null}

              {lead.status === "lost" && lead.lostReason && (
                <p className="mt-2 text-xs text-rce-muted">
                  Lost — {lead.lostReason}
                  {lead.lostNotes ? `: "${lead.lostNotes}"` : ""}
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                {lead.email && campaignLeadIds.has(lead.id) && (
                  <span className="rounded-lg border border-green-300 bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700">
                    ✓ On email campaign
                  </span>
                )}
                {/* The record carries its own actions: everything that can be done to this
                    lead is in its drawer, over this list. */}
                <OpenDrawerButton kind="lead" id={lead.id} onOpen={drawers.open} label="Open" className="btn btn-primary text-xs" />
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
