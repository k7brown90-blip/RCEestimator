import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { JobScheduler } from "../components/JobScheduler";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import { ADDRESS_QUERY_KEYS } from "../lib/queryKeys";
import { shortDate } from "../lib/utils";
import {
  LEAD_LOST_REASONS,
  type CustomerMatch,
  type JobStatus,
  type Lead,
  type LeadLinkedVisit,
  type LeadPipeline,
  type LeadSource,
  type LeadStatus,
} from "../lib/types";

/**
 * The funnel, not the lead's own state. A lead sits here until it's booked;
 * once it has an appointment it belongs to the Calendar.
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
  if (lead.addressLine1) {
    return [
      lead.addressLine1,
      lead.addressLine2,
      lead.city,
      [lead.state, lead.postalCode].filter(Boolean).join(" "),
    ].filter(Boolean).join(", ");
  }
  return lead.address ?? null;
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

export function LeadsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pipeline, setPipeline] = useState<LeadPipeline>("open");
  const [statusFilter, setStatusFilter] = useState("");
  const [schedulingLead, setSchedulingLead] = useState<Lead | null>(null);
  const [losingLead, setLosingLead] = useState<Lead | null>(null);
  const [lostReason, setLostReason] = useState("");
  const [lostNotes, setLostNotes] = useState("");
  /** The server's 409 answer when a convert would mint a duplicate account. */
  const [duplicate, setDuplicate] = useState<{ lead: Lead; matches: CustomerMatch[] } | null>(null);

  const { data: leads = [], isLoading, error } = useQuery({
    queryKey: ["leads", { pipeline, statusFilter }],
    queryFn: () => api.leads({ pipeline, status: statusFilter || undefined }),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["leads"] });
    for (const key of ADDRESS_QUERY_KEYS) queryClient.invalidateQueries({ queryKey: [...key] });
  };

  /**
   * Convert refuses with 409 when it would create an account that looks like one
   * already on the books — that isn't an error to show, it's a question to ask,
   * so it opens the picker instead. It refuses with 400 when the lead has no
   * usable address — that one WAS silently swallowed (no matches to show, so
   * nothing happened), leaving a lead that looked "stuck" with no visible next
   * step. Surface that one directly instead of doing nothing.
   */
  const handleConvertError = (err: unknown, lead: Lead) => {
    const body = (err as { body?: { matches?: CustomerMatch[]; needs?: string; message?: string } })?.body;
    if (body?.matches?.length) {
      setDuplicate({ lead, matches: body.matches });
      return true;
    }
    if (body?.needs === "address") {
      window.alert(
        body.message
          ?? `${lead.name}'s lead has no usable address, so it can't be converted yet. Add a complete street address, city, state, and ZIP, then convert again.`,
      );
      return true;
    }
    return false;
  };

  const convertMutation = useMutation({
    mutationFn: ({ leadId, input }: { leadId: string; input?: Parameters<typeof api.convertLead>[1] }) =>
      api.convertLead(leadId, input),
    onSuccess: (result) => {
      invalidate();
      setDuplicate(null);
      if (result.visit?.id) navigate(`/visits/${result.visit.id}`);
    },
    onError: (err, variables) => {
      const lead = leads.find((l) => l.id === variables.leadId);
      if (lead) handleConvertError(err, lead);
    },
  });

  /**
   * Convert-then-schedule. An unconverted lead has no Visit to hang an
   * appointment on, so booking one implies conversion — doing both in a single
   * click is the whole point of scheduling from this tab.
   */
  const convertAndSchedule = useMutation({
    mutationFn: (leadId: string) => api.convertLead(leadId),
    onError: (err, leadId) => {
      const lead = leads.find((l) => l.id === leadId);
      if (lead) handleConvertError(err, lead);
    },
    onSuccess: (result, leadId) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["calendar"] });
      const lead = leads.find((l) => l.id === leadId);
      if (!lead || !result.visit) return;
      // Hand the freshly created visit straight to the scheduler rather than
      // waiting for the list to refetch — the operator clicked "Schedule", not
      // "Convert", so the picker should already be open.
      const linkedVisit: LeadLinkedVisit = {
        id: result.visit.id,
        status: (result.visit.status as JobStatus | null) ?? "estimate",
        scheduledStart: null,
        scheduledEnd: null,
        estimatedDurationDays: result.visit.estimatedDurationDays ?? null,
        jobType: result.visit.jobType ?? null,
        purpose: result.visit.purpose ?? null,
      };
      setSchedulingLead({ ...lead, visitId: result.visit.id, linkedVisit });
    },
  });

  const contactMutation = useMutation({
    mutationFn: (leadId: string) => api.updateLead(leadId, { status: "contacted" }),
    onSuccess: invalidate,
  });

  /**
   * Marking a lead lost without a reason left `GET /leads/loss-report` reporting
   * on nothing. The reason is required; the customer's own words are optional but
   * are the part worth having.
   */
  const lostMutation = useMutation({
    mutationFn: (input: { leadId: string; lostReason: string; lostNotes: string }) =>
      api.updateLead(input.leadId, {
        status: "lost",
        leadStatus: "lost",
        lostReason: input.lostReason as never,
        lostNotes: input.lostNotes.trim() || null,
      }),
    onSuccess: () => {
      invalidate();
      setLosingLead(null);
      setLostReason("");
      setLostNotes("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (leadId: string) => api.deleteLead(leadId),
    onSuccess: invalidate,
  });

  function handleSchedule(lead: Lead) {
    if (lead.linkedVisit) {
      setSchedulingLead(lead);
      return;
    }
    if (window.confirm(
      `Booking an appointment for ${lead.name} will first convert this lead into an account, property, and job. Continue?`,
    )) {
      convertAndSchedule.mutate(lead.id);
    }
  }

  const activeTab = PIPELINE_TABS.find((tab) => tab.value === pipeline)!;

  return (
    <div>
      <PageHeader
        title="Leads"
        subtitle="Inbound inquiries, and anything you take down by hand"
        actions={<Link to="/leads/new" className="btn btn-primary">+ New Lead</Link>}
      />

      {/* Pipeline tabs */}
      <div className="mb-2 flex flex-wrap gap-2">
        {PIPELINE_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => { setPipeline(tab.value); setStatusFilter(""); }}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
              pipeline === tab.value
                ? "bg-rce-accent text-white"
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

      {isLoading ? <p className="text-sm text-rce-muted">Loading leads…</p> : null}
      {error ? <p className="text-sm text-red-500">Error loading leads: {(error as Error).message}</p> : null}

      {!isLoading && leads.length === 0 ? (
        <p className="text-sm text-rce-muted">
          {pipeline === "open" ? "Nothing waiting — the queue is clear." : "No leads here."}
        </p>
      ) : null}

      <section className="space-y-3">
        {leads.map((lead) => {
          const state = funnelState(lead);

          return (
            <div key={lead.id} className="card block p-4">
              {(
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-semibold">{lead.name}</h2>
                    <div className="flex flex-wrap items-center gap-2">
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
                    <span>Received {shortDate(lead.createdAt)}</span>
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

                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <Link to={`/leads/${lead.id}/edit`} className="btn btn-secondary text-xs">
                      Edit
                    </Link>

                    {lead.status === "new" && (
                      <button
                        type="button"
                        className="rounded-lg border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 transition hover:bg-blue-100"
                        disabled={contactMutation.isPending}
                        onClick={() => contactMutation.mutate(lead.id)}
                      >
                        Mark Contacted
                      </button>
                    )}

                    {lead.linkedVisit && (
                      <button
                        type="button"
                        className="rounded-lg border border-green-300 bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 transition hover:bg-green-100"
                        onClick={() => navigate(`/visits/${lead.linkedVisit!.id}`)}
                      >
                        Go to Job
                      </button>
                    )}

                    {pipeline !== "closed" && (
                      <button
                        type="button"
                        className="btn btn-primary text-xs"
                        disabled={convertAndSchedule.isPending}
                        onClick={() => handleSchedule(lead)}
                      >
                        {lead.linkedVisit?.scheduledStart ? "Reschedule" : "Schedule"}
                      </button>
                    )}

                    {pipeline === "open" && !lead.linkedVisit && (
                      <button
                        type="button"
                        className="btn btn-secondary text-xs"
                        disabled={convertMutation.isPending}
                        onClick={() => {
                          if (window.confirm("Convert this lead into an account, property, and job?")) {
                            convertMutation.mutate({ leadId: lead.id });
                          }
                        }}
                      >
                        Convert only
                      </button>
                    )}

                    {lead.status !== "lost" && (
                      <button
                        type="button"
                        className="btn btn-secondary text-xs"
                        onClick={() => { setLosingLead(lead); setLostReason(""); setLostNotes(""); }}
                      >
                        Mark Lost
                      </button>
                    )}

                    {/* A converted lead can't be deleted — the server 409s, and
                        the button used to just do nothing when clicked. */}
                    {lead.status !== "converted" && (
                      <button
                        type="button"
                        className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-100"
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                          if (window.confirm(`Delete lead "${lead.name}"? This cannot be undone.`)) {
                            deleteMutation.mutate(lead.id);
                          }
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </section>

      {deleteMutation.error && (
        <p className="mt-3 text-sm text-red-600">{(deleteMutation.error as Error).message}</p>
      )}

      {schedulingLead?.linkedVisit && (
        <Modal
          title={`Schedule ${schedulingLead.name}`}
          subtitle={displayAddress(schedulingLead) ?? undefined}
          onClose={() => setSchedulingLead(null)}
        >
          <JobScheduler
            autoOpen
            jobId={schedulingLead.linkedVisit.id}
            status={schedulingLead.linkedVisit.status}
            scheduledStart={schedulingLead.linkedVisit.scheduledStart}
            scheduledEnd={schedulingLead.linkedVisit.scheduledEnd}
            durationDays={schedulingLead.linkedVisit.estimatedDurationDays}
            onScheduled={() => setSchedulingLead(null)}
          />
        </Modal>
      )}

      {/* Marking a lead lost with no reason left the loss report empty. */}
      {losingLead && (
        <Modal
          title={`Mark ${losingLead.name} lost`}
          subtitle="Why it didn't close — this is what the loss report reads."
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

      {/*
        The server refused to convert because it would have created an account
        that looks like one already on the books. Not an error — a question.
      */}
      {duplicate && (
        <Modal
          title="This might already be a customer"
          subtitle={`Converting ${duplicate.lead.name} would create a new account.`}
          onClose={() => setDuplicate(null)}
        >
          <div className="space-y-3">
            {duplicate.matches.map((match) => (
              <div key={match.customerId} className="rounded border border-rce-border p-3">
                <p className="text-sm font-medium">{match.name}</p>
                <p className="text-xs text-rce-muted">
                  {[match.phone, match.email].filter(Boolean).join(" · ")}
                  {match.visitCount > 0 && ` · ${match.visitCount} job${match.visitCount === 1 ? "" : "s"}`}
                </p>
                <div className="mt-2 space-y-1">
                  {match.properties.map((property) => (
                    <button
                      key={property.id}
                      type="button"
                      className="btn btn-secondary w-full text-left text-xs"
                      disabled={convertMutation.isPending}
                      onClick={() => convertMutation.mutate({
                        leadId: duplicate.lead.id,
                        input: { customerId: match.customerId, propertyId: property.id },
                      })}
                    >
                      Use {property.name} — {property.addressLine1}, {property.city}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="btn btn-secondary w-full text-left text-xs"
                    disabled={convertMutation.isPending}
                    onClick={() => convertMutation.mutate({
                      leadId: duplicate.lead.id,
                      input: { customerId: match.customerId },
                    })}
                  >
                    Use this account — add the lead's address to it
                  </button>
                </div>
              </div>
            ))}

            <button
              type="button"
              className="btn btn-primary w-full text-xs"
              disabled={convertMutation.isPending}
              onClick={() => convertMutation.mutate({
                leadId: duplicate.lead.id,
                input: { createNewAccount: true },
              })}
            >
              Not the same customer — create a new account
            </button>
            {convertMutation.error && (
              <p className="text-sm text-red-600">{(convertMutation.error as Error).message}</p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
