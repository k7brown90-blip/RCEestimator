import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import { shortDate } from "../lib/utils";
import type { LeadStatus, LeadSource, Lead } from "../lib/types";

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "converted", label: "Converted" },
  { value: "lost", label: "Lost" },
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

export function LeadsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", email: "", phone: "", address: "", jobType: "", notes: "" });

  const { data: leads = [], isLoading, error } = useQuery({
    queryKey: ["leads", filter],
    queryFn: () => api.leads(filter || undefined),
  });

  const convertMutation = useMutation({
    mutationFn: (leadId: string) => api.convertLead(leadId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      if (result.visit?.id) {
        navigate(`/visits/${result.visit.id}`);
      }
    },
  });

  const contactMutation = useMutation({
    mutationFn: (leadId: string) => api.updateLead(leadId, { status: "contacted" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["leads"] }),
  });

  const lostMutation = useMutation({
    mutationFn: (leadId: string) => api.updateLead(leadId, { status: "lost" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["leads"] }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...input }: { id: string; name?: string; email?: string; phone?: string; address?: string; jobType?: string; notes?: string }) =>
      api.updateLead(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (leadId: string) => api.deleteLead(leadId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["leads"] }),
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

  return (
    <div>
      <PageHeader title="Leads" subtitle="Inbound inquiries from email, phone, and web" />

      {/* Status filter tabs */}
      <div className="mb-5 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              filter === f.value
                ? "bg-rce-accent text-white"
                : "bg-rce-border/40 text-rce-muted hover:bg-rce-border"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? <p className="text-sm text-rce-muted">Loading leads...</p> : null}
      {error ? <p className="text-sm text-red-500">Error loading leads: {(error as Error).message}</p> : null}

      {!isLoading && leads.length === 0 ? (
        <p className="text-sm text-rce-muted">No leads found.</p>
      ) : null}

      <section className="space-y-3">
        {leads.map((lead) => (
          <div key={lead.id} className="card block p-4">
            {editingId === lead.id ? (
              /* ── Inline Edit Form ── */
              <form onSubmit={(e) => { e.preventDefault(); saveEdit(); }} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-rce-soft">Name</label>
                    <input className="input w-full" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-rce-soft">Email</label>
                    <input className="input w-full" type="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-rce-soft">Phone</label>
                    <input className="input w-full" value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-rce-soft">Job Type</label>
                    <input className="input w-full" value={editForm.jobType} onChange={(e) => setEditForm({ ...editForm, jobType: e.target.value })} />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-rce-soft">Address</label>
                  <input className="input w-full" value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-rce-soft">Notes</label>
                  <textarea className="input w-full" rows={2} value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} />
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600" onClick={() => setEditingId(null)}>Cancel</button>
                  <button type="submit" className="btn btn-primary text-xs" disabled={updateMutation.isPending}>Save</button>
                </div>
              </form>
            ) : (
              /* ── Read-only Display ── */
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-semibold">{lead.name}</h2>
                  <div className="flex items-center gap-2">
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

                {lead.notes ? (
                  <p className="mt-2 text-sm text-rce-muted">{lead.notes}</p>
                ) : null}

                {lead.status !== "converted" ? (
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
                      onClick={() => startEdit(lead)}
                    >
                      Edit
                    </button>
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
                    {lead.status === "new" ? (
                      <button
                        type="button"
                        className="rounded-lg border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 transition hover:bg-blue-100"
                        disabled={contactMutation.isPending}
                        onClick={() => contactMutation.mutate(lead.id)}
                      >
                        Mark Contacted
                      </button>
                    ) : null}
                    {lead.status !== "lost" ? (
                      <button
                        type="button"
                        className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
                        disabled={lostMutation.isPending}
                        onClick={() => {
                          if (window.confirm("Mark this lead as lost?")) {
                            lostMutation.mutate(lead.id);
                          }
                        }}
                      >
                        Mark Lost
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={convertMutation.isPending}
                      onClick={() => {
                        if (window.confirm("Convert this lead into a Customer, Property, and Visit?")) {
                          convertMutation.mutate(lead.id);
                        }
                      }}
                    >
                      Convert
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 flex justify-end">
                    {lead.visitId ? (
                      <button
                        type="button"
                        className="rounded-lg border border-green-300 bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 transition hover:bg-green-100"
                        onClick={() => navigate(`/visits/${lead.visitId}`)}
                      >
                        Go to Visit
                      </button>
                    ) : null}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
