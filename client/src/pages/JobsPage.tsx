import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { api } from "../lib/api";
import { money, shortDate } from "../lib/utils";

const MODES = [
  { value: "service_diagnostic", label: "Service / Diagnostic" },
  { value: "remodel", label: "Remodel / Addition" },
  { value: "new_construction", label: "New Construction" },
  { value: "maintenance", label: "Maintenance" },
];

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "review", label: "Review" },
  { value: "sent", label: "Sent" },
  { value: "accepted", label: "Accepted" },
  { value: "no_estimate", label: "No Estimate" },
];

export function JobsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: jobs = [], isLoading, error } = useQuery({ queryKey: ["jobs"], queryFn: api.jobs });
  const { data: properties = [] } = useQuery({ queryKey: ["properties"], queryFn: api.properties });
  const [showNewVisit, setShowNewVisit] = useState(false);
  const [propertyId, setPropertyId] = useState("");
  const [mode, setMode] = useState("service_diagnostic");
  const [purpose, setPurpose] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const filteredJobs = statusFilter
    ? jobs.filter((job) => {
        if (statusFilter === "no_estimate") return !job.estimate;
        return job.estimate?.status === statusFilter;
      })
    : jobs;

  const createVisit = useMutation({
    mutationFn: api.createVisit,
    onSuccess: (visit) => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      setShowNewVisit(false);
      navigate(`/visits/${visit.id}`);
    },
  });

  const deleteEstimate = useMutation({
    mutationFn: (estimateId: string) => api.deleteEstimate(estimateId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  function submitVisit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = properties.find((property) => property.id === propertyId);
    if (!selected) {
      return;
    }
    createVisit.mutate({ propertyId, customerId: selected.customerId, mode, purpose });
  }

  return (
    <div>
      <PageHeader
        title="Jobs"
        subtitle="Active visits and estimates"
        actions={<button className="btn btn-primary" type="button" onClick={() => setShowNewVisit((value) => !value)}>+ Start New Visit</button>}
      />

      {showNewVisit ? (
        <form className="card mb-5 grid gap-3 p-4 md:grid-cols-4" onSubmit={submitVisit}>
          <label className="text-sm font-medium md:col-span-2">
            Property
            <select className="field mt-1" value={propertyId} onChange={(event) => setPropertyId(event.target.value)} required>
              <option value="">Select property</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>{property.name} - {property.addressLine1}</option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium">
            Mode
            <select className="field mt-1" value={mode} onChange={(event) => setMode(event.target.value)}>
              {MODES.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium">
            Purpose
            <input className="field mt-1" value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="Optional" />
          </label>
          <div className="md:col-span-4">
            <button className="btn btn-primary" type="submit" disabled={createVisit.isPending}>Create Visit</button>
          </div>
        </form>
      ) : null}

      {isLoading ? <p className="text-sm text-rce-muted">Loading jobs...</p> : null}
      {error ? <p className="text-sm text-red-500">Error loading jobs: {error.message}</p> : null}

      <div className="mb-5 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatusFilter(f.value)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              statusFilter === f.value
                ? "bg-rce-accent text-white"
                : "bg-rce-border/40 text-rce-muted hover:bg-rce-border"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <section className="space-y-3">
        {filteredJobs.map((job) => (
          <Link key={job.visitId} to={`/visits/${job.visitId}`} className="card block p-4 transition hover:border-rce-accent">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">{job.property.addressLine1} - {job.customer.name}</h2>
              {job.estimate ? <StatusBadge status={job.estimate.status} /> : <span className="text-xs text-rce-soft">NO ESTIMATE YET</span>}
            </div>
            <p className="mt-1 text-sm text-rce-muted">{job.mode.replaceAll("_", " ")} | Opened {shortDate(job.visitDate)}</p>
            <div className="mt-3 grid gap-2 text-sm md:grid-cols-3">
              <p><span className="text-rce-soft">Estimate:</span> {job.estimate?.title ?? "No estimate yet"}</p>
              <p><span className="text-rce-soft">Revision:</span> {job.estimate ? `Rev ${job.estimate.revision}` : "-"}</p>
              <p className="font-semibold"><span className="text-rce-soft">Total:</span> {money(job.estimate?.totalCost)}</p>
            </div>

            {/* Cost / Profit Widget */}
            {(job.costs.revenue != null || job.costs.materialCost > 0 || job.costs.laborHours > 0) ? (
              <div className="mt-3 grid gap-2 rounded-lg bg-rce-bg p-3 text-xs md:grid-cols-5">
                <div>
                  <span className="text-rce-soft">Materials</span>
                  <p className="font-semibold">{money(job.costs.materialCost)}</p>
                </div>
                <div>
                  <span className="text-rce-soft">Labor ({job.costs.laborHours}h)</span>
                  <p className="font-semibold">{money(job.costs.laborCost)}</p>
                </div>
                <div>
                  <span className="text-rce-soft">Overhead</span>
                  <p className="font-semibold">{money(job.costs.overhead)}</p>
                </div>
                <div>
                  <span className="text-rce-soft">Revenue</span>
                  <p className="font-semibold">{money(job.costs.revenue)}</p>
                </div>
                <div>
                  <span className="text-rce-soft">Profit</span>
                  <p className={`font-semibold ${(job.costs.grossProfit ?? 0) >= 0 ? "text-rce-success" : "text-red-500"}`}>
                    {job.costs.grossProfit != null ? `${money(job.costs.grossProfit)} (${job.costs.margin}%)` : "—"}
                  </p>
                </div>
              </div>
            ) : null}
            {job.estimate && job.estimate.status !== "accepted" ? (
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={deleteEstimate.isPending}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (window.confirm("Delete this estimate? This cannot be undone.")) {
                      deleteEstimate.mutate(job.estimate!.id);
                    }
                  }}
                >
                  Delete Estimate
                </button>
              </div>
            ) : null}
          </Link>
        ))}
      </section>
    </div>
  );
}
