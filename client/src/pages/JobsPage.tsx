import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { api, type VisitMode } from "../lib/api";
import type { JobSummary } from "../lib/types";
import { money, shortDate } from "../lib/utils";

const MODES: Array<{ value: VisitMode; label: string }> = [
  { value: "service_diagnostic", label: "Service / Diagnostic" },
  { value: "remodel", label: "Remodel / Addition" },
  { value: "new_construction", label: "New Construction" },
  { value: "maintenance", label: "Maintenance" },
];

/**
 * Estimate-lifecycle filters. These only apply to Active — an estimate's status
 * is meaningless once the job itself is finished or cancelled.
 */
const ESTIMATE_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "review", label: "Review" },
  { value: "sent", label: "Sent" },
  { value: "accepted", label: "Accepted" },
  { value: "no_estimate", label: "No Estimate" },
];

const JOB_STATUS_CLASS: Record<string, string> = {
  estimate: "bg-zinc-200 text-zinc-700",
  contracted: "bg-blue-100 text-blue-700",
  scheduled: "bg-rce-accentBg text-rce-warning",
  in_progress: "bg-amber-100 text-amber-800",
  completed: "bg-green-100 text-rce-success",
  cancelled: "bg-red-100 text-red-700",
};

type ArchiveTab = "active" | "archived";

export function JobsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ArchiveTab>("active");
  const [showNewVisit, setShowNewVisit] = useState(false);
  const [propertyId, setPropertyId] = useState("");
  const [mode, setMode] = useState<VisitMode>("service_diagnostic");
  const [purpose, setPurpose] = useState("");
  /*
    Both filters can arrive in the URL, because the property page links here for "Sold Work" and
    that button has to actually show sold work AT THAT ADDRESS. A link that lands on an unfiltered
    list is worse than no link — it looks like the address has sold work it does not have.
  */
  const [searchParams] = useSearchParams();
  const [estimateFilter, setEstimateFilter] = useState(searchParams.get("estimate") ?? "");
  const addressFilter = searchParams.get("address");
  /*
    ── SOLD WORK MEANS OPEN WORK ORDERS (Kyle, R9, 2026-08-20) ─────────────────────────────────

    "Sold work will have to lead to a page that shows the open work orders."

    Sold work that has been finished and paid is history. Listing it beside work still to do
    buries the part that needs action, which is the only part that button is for. `?open=1` keeps
    the signed jobs that are not yet completed or cancelled.
  */
  const openWorkOrders = searchParams.get("open") === "1";
  const [sortNewestFirst, setSortNewestFirst] = useState(true);

  const archived = tab === "archived";
  const { data: jobs = [], isLoading, error } = useQuery({
    queryKey: ["jobs", { archived }],
    queryFn: () => api.jobs({ archived }),
  });
  const { data: properties = [] } = useQuery({ queryKey: ["properties"], queryFn: api.properties });

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  const visibleJobs = useMemo(() => {
    const atAddress = addressFilter ? jobs.filter((j) => j.property.id === addressFilter) : jobs;
    // Signed, and not yet finished. `hasAcceptance` is set the moment an estimate is signed.
    const scoped = openWorkOrders
      ? atAddress.filter(
          (j) =>
            Boolean(j.estimate?.hasAcceptance) &&
            j.status !== "completed" &&
            j.status !== "cancelled",
        )
      : atAddress;
    const filtered = archived || !estimateFilter
      ? scoped
      : scoped.filter((job) => {
        if (estimateFilter === "no_estimate") return !job.estimate;
        return job.estimate?.status === estimateFilter;
      });

    if (!archived) return filtered;
    // Archived is a ledger, so let the owner flip the ordering.
    return [...filtered].sort((a, b) => {
      const diff = new Date(b.visitDate).getTime() - new Date(a.visitDate).getTime();
      return sortNewestFirst ? diff : -diff;
    });
  }, [jobs, archived, estimateFilter, addressFilter, openWorkOrders, sortNewestFirst]);

  function submitVisit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = properties.find((property) => property.id === propertyId);
    if (!selected) return;
    createVisit.mutate({ propertyId, customerId: selected.customerId, mode, purpose });
  }

  return (
    <div>
      <PageHeader
        title="Jobs"
        subtitle={archived ? "Completed and cancelled work" : "Active and ongoing work"}
        actions={
          <button className="btn btn-primary" type="button" onClick={() => setShowNewVisit((value) => !value)}>
            + Start New Visit
          </button>
        }
      />

      {/* Active / Archived */}
      <div className="mb-4 inline-flex rounded-lg border border-rce-border p-1">
        {(["active", "archived"] as ArchiveTab[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium capitalize transition ${
              tab === value ? "bg-rce-accent text-white" : "text-rce-muted hover:bg-rce-border/40"
            }`}
          >
            {value}
          </button>
        ))}
      </div>

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
            <select className="field mt-1" value={mode} onChange={(event) => setMode(event.target.value as VisitMode)}>
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

      {openWorkOrders && (
        <p className="mb-4 rounded-lg bg-rce-accentBg p-3 text-sm text-rce-accentDark">
          <strong>Open work orders</strong> — signed and not yet finished. Completed and cancelled
          jobs are hidden.
        </p>
      )}

      {/* Secondary filter — estimate lifecycle only makes sense on live work */}
      {!archived && (
        <div className="mb-5 flex flex-wrap gap-2">
          {ESTIMATE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setEstimateFilter(f.value)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                estimateFilter === f.value
                  ? "bg-rce-accent text-white"
                  : "bg-rce-border/40 text-rce-muted hover:bg-rce-border"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {archived && (
        <div className="mb-5">
          <button
            type="button"
            className="text-sm font-medium text-rce-accent"
            onClick={() => setSortNewestFirst((s) => !s)}
          >
            {sortNewestFirst ? "Newest first ↓" : "Oldest first ↑"}
          </button>
        </div>
      )}

      {isLoading ? <p className="text-sm text-rce-muted">Loading jobs…</p> : null}
      {error ? <p className="text-sm text-red-500">Error loading jobs: {error.message}</p> : null}

      <section className="space-y-3">
        {visibleJobs.map((job) => (
          <JobCard
            key={job.visitId}
            job={job}
            onDeleteEstimate={(estimateId) => deleteEstimate.mutate(estimateId)}
            deleting={deleteEstimate.isPending}
          />
        ))}
        {!isLoading && visibleJobs.length === 0 && (
          <p className="text-sm text-rce-muted">
            {archived
              ? "No completed or cancelled jobs."
              : estimateFilter
                ? "No active jobs match that estimate status."
                : "No active jobs. Start a visit to open one."}
          </p>
        )}
      </section>
    </div>
  );
}

function JobCard({
  job, onDeleteEstimate, deleting,
}: { job: JobSummary; onDeleteEstimate: (estimateId: string) => void; deleting: boolean }) {
  const hasCostData = job.costs.revenue != null || job.costs.materialCost > 0 || job.costs.laborHours > 0;

  const scheduleLine = job.scheduledStart
    ? new Date(job.scheduledStart).toLocaleString("en-US", {
      timeZone: "America/Chicago",
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    })
    : null;

  return (
    <Link to={`/visits/${job.visitId}`} className="card block p-4 transition hover:border-rce-accent">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{job.property.addressLine1} — {job.customer.name}</h2>
        <div className="flex items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase ${JOB_STATUS_CLASS[job.status] ?? "bg-zinc-200 text-zinc-700"}`}>
            {job.status.replaceAll("_", " ")}
          </span>
          {job.estimate ? <StatusBadge status={job.estimate.status} /> : <span className="text-xs text-rce-soft">NO ESTIMATE YET</span>}
        </div>
      </div>

      <p className="mt-1 text-sm text-rce-muted">
        {job.jobType || job.mode.replaceAll("_", " ")} · Opened {shortDate(job.visitDate)}
        {scheduleLine && ` · Scheduled ${scheduleLine}`}
        {job.estimatedDurationDays && job.estimatedDurationDays > 1 && ` (${job.estimatedDurationDays} days)`}
      </p>

      {job.technicians.length > 0 && (
        <p className="mt-1 text-xs text-rce-soft">
          Assigned: {job.technicians.map((t) => t.name).join(", ")}
        </p>
      )}

      <div className="mt-3 grid gap-2 text-sm md:grid-cols-3">
        <p><span className="text-rce-soft">Estimate:</span> {job.estimate?.title ?? "No estimate yet"}</p>
        <p><span className="text-rce-soft">Revision:</span> {job.estimate ? `Rev ${job.estimate.revision}` : "-"}</p>
        <p className="font-semibold"><span className="text-rce-soft">Total:</span> {money(job.estimate?.totalCost)}</p>
      </div>

      {hasCostData ? (
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
            disabled={deleting}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (window.confirm("Delete this estimate? This cannot be undone.")) {
                onDeleteEstimate(job.estimate!.id);
              }
            }}
          >
            Delete Estimate
          </button>
        </div>
      ) : null}
    </Link>
  );
}
