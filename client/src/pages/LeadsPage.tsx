import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { JobScheduler } from "../components/JobScheduler";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import { shortDate } from "../lib/utils";
import type { JobStatus, Lead, LeadLinkedVisit, LeadPipeline, LeadSource, LeadStatus } from "../lib/types";

/**
 * The funnel, not the lead's own state. A lead sits here until it's booked;
 * once it has an appointment it belongs to the Calendar.
 */
const PIPELINE_TABS: Array<{ value: LeadPipeline; label: string; blurb: string }> = [
  { value: "open", label: "Open", blurb: "Not yet contacted or scheduled — this is your work queue." },
  { value: "scheduled", label: "Scheduled", blurb: "Booked. Managed on the Calendar." },
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

const sourceBadgeClass: Record<LeadSource, string> = {
  email: "bg-purple-100 text-purple-700",
  phone: "bg-teal-100 text-teal-700",
  web: "bg-indigo-100 text-indigo-700",
};

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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", email: "", phone: "", address: "", jobType: "", notes: "" });
  const [schedulingLead, setSchedulingLead] = useState<Lead | null>(null);

  const { data: leads = [], isLoading, error } = useQuery({
    queryKey: ["leads", { pipeline, statusFilter }],
    queryFn: () => api.leads({ pipeline, status: statusFilter || undefined }),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["leads"] });

  const convertMutation = useMutation({
    mutationFn: (leadId: string) => api.convertLead(leadId),
    onSuccess: (result) => {
      invalidate();
      if (result.visit?.id) navigate(`/visits/${result.visit.id}`);
    },
  });

  /**
   * Convert-then-schedule. An unconverted lead has no Visit to hang an
   * appointment on, so booking one implies conversion — doing both in a single
   * click is the whole point of scheduling from this tab.
   */
  const convertAndSchedule = useMutation({
    mutationFn: (leadId: string) => api.convertLead(leadId),
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

  const lostMutation = useMutation({
    mutationFn: (leadId: string) => api.updateLead(leadId, { status: "lost" }),
    onSuccess: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...input }: { id: string; name?: string; email?: string; phone?: string; address?: string; jobType?: string; notes?: string }) =>
      api.updateLead(id, input),
    onSuccess: () => {
      invalidate();
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (leadId: string) => api.deleteLead(leadId),
    onSuccess: invalidate,
  });

  function startEdit(lead: Lead) {
    setEditingId(lead.id);
    setEditForm({
      name: lead.name,
      email: lead.email ?? "",
      phone: lead.phone ?? "",
      address: lead.address ?? "",
      jobType: lead.jobType ?? "",
      notes: lead.notes ?? "",
    });
  }

  function saveEdit() {
    if (!editingId) return;
    updateMutation.mutate({ id: editingId, ...editForm });
  }

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
      <PageHeader title="Leads" subtitle="Inbound inquiries from email, phone, and web" />

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
          const isEditing = editingId === lead.id;

          return (
            <div key={lead.id} className="card block p-4">
              {isEditing ? (
                <form onSubmit={(e) => { e.preventDefault(); saveEdit(); }} className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-xs font-medium text-rce-soft">
                      Name
                      <input className="field mt-1 w-full" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required />
                    </label>
                    <label className="text-xs font-medium text-rce-soft">
                      Email
                      <input className="field mt-1 w-full" type="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
                    </label>
                    <label className="text-xs font-medium text-rce-soft">
                      Phone
                      <input className="field mt-1 w-full" value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
                    </label>
                    <label className="text-xs font-medium text-rce-soft">
                      Job Type
                      <input className="field mt-1 w-full" value={editForm.jobType} onChange={(e) => setEditForm({ ...editForm, jobType: e.target.value })} />
                    </label>
                  </div>
                  <label className="block text-xs font-medium text-rce-soft">
                    Address
                    <input className="field mt-1 w-full" value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} />
                  </label>
                  <label className="block text-xs font-medium text-rce-soft">
                    Notes
                    <textarea className="field mt-1 w-full" rows={2} value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} />
                  </label>
                  <div className="flex justify-end gap-2">
                    <button type="button" className="btn btn-secondary text-xs" onClick={() => setEditingId(null)}>Cancel</button>
                    <button type="submit" className="btn btn-primary text-xs" disabled={updateMutation.isPending}>Save</button>
                  </div>
                </form>
              ) : (
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

                  {(lead.address || lead.jobType) ? (
                    <div className="mt-2 flex flex-wrap gap-x-5 text-sm">
                      {lead.address ? <p><span className="text-rce-soft">Address:</span> {lead.address}</p> : null}
                      {lead.jobType ? <p><span className="text-rce-soft">Job Type:</span> {lead.jobType}</p> : null}
                    </div>
                  ) : null}

                  {lead.notes ? <p className="mt-2 text-sm text-rce-muted">{lead.notes}</p> : null}

                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <button type="button" className="btn btn-secondary text-xs" onClick={() => startEdit(lead)}>
                      Edit
                    </button>

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
                            convertMutation.mutate(lead.id);
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
                        disabled={lostMutation.isPending}
                        onClick={() => {
                          if (window.confirm("Mark this lead as lost?")) lostMutation.mutate(lead.id);
                        }}
                      >
                        Mark Lost
                      </button>
                    )}

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
                  </div>
                </>
              )}
            </div>
          );
        })}
      </section>

      {schedulingLead?.linkedVisit && (
        <Modal
          title={`Schedule ${schedulingLead.name}`}
          subtitle={schedulingLead.address ?? undefined}
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
    </div>
  );
}
