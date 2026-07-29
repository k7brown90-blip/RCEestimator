import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { InspectionResultChip } from "../components/InspectionResultChip";
import { FindingLedger } from "../components/FindingLedger";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { api } from "../lib/api";
import type { AccountJob, AccountSummary } from "../lib/types";
import { money, shortDate } from "../lib/utils";

const JOB_STATUS_CLASS: Record<string, string> = {
  estimate: "bg-zinc-200 text-zinc-700",
  contracted: "bg-blue-100 text-blue-700",
  scheduled: "bg-rce-accentBg text-rce-warning",
  in_progress: "bg-amber-100 text-amber-800",
  completed: "bg-green-100 text-rce-success",
  cancelled: "bg-red-100 text-red-700",
};

function JobStatusPill({ status }: { status: string }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase ${JOB_STATUS_CLASS[status] ?? "bg-zinc-200 text-zinc-700"}`}>
      {status.replaceAll("_", " ")}
    </span>
  );
}

export function AccountDetailPage() {
  const { accountId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: summary, isLoading, error } = useQuery({
    queryKey: ["account", accountId],
    queryFn: () => api.accountSummary(accountId),
    enabled: Boolean(accountId),
  });

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");

  const [propertyName, setPropertyName] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("TN");
  const [postalCode, setPostalCode] = useState("");
  const [showAddProperty, setShowAddProperty] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["account", accountId] });
    queryClient.invalidateQueries({ queryKey: ["accounts"] });
  };

  const updateAccount = useMutation({
    mutationFn: (input: { name: string; email?: string | null; phone?: string | null }) =>
      api.updateAccount(accountId, input),
    onSuccess: () => {
      invalidate();
      setEditing(false);
    },
  });

  const deleteAccount = useMutation({
    mutationFn: () => api.deleteAccount(accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      navigate("/accounts");
    },
  });

  const createProperty = useMutation({
    mutationFn: api.createProperty,
    onSuccess: () => {
      invalidate();
      setPropertyName("");
      setAddressLine1("");
      setCity("");
      setPostalCode("");
      setShowAddProperty(false);
    },
  });

  function startEdit() {
    setEditName(summary?.account.name ?? "");
    setEditEmail(summary?.account.email ?? "");
    setEditPhone(summary?.account.phone ?? "");
    setEditing(true);
  }

  function submitEdit(event: FormEvent) {
    event.preventDefault();
    updateAccount.mutate({ name: editName, email: editEmail || null, phone: editPhone || null });
  }

  function submitProperty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createProperty.mutate({ customerId: accountId, name: propertyName, addressLine1, city, state, postalCode });
  }

  function confirmDelete() {
    if (window.confirm(`Delete ${summary?.account.name}? This cannot be undone.`)) {
      deleteAccount.mutate();
    }
  }

  if (isLoading) return <p className="text-sm text-rce-muted">Loading account…</p>;
  if (error) return <p className="text-sm text-red-500">Error loading account: {error.message}</p>;
  if (!summary) return <p className="text-sm text-rce-muted">Account not found.</p>;

  const { account, properties, jobs, totals } = summary;
  const activeJobs = jobs.filter((job) => !job.archived);
  const pastJobs = jobs.filter((job) => job.archived);

  return (
    <div>
      <PageHeader title={account.name} subtitle="Account record" />

      {/* ── Lifetime totals ─────────────────────────────────────────────── */}
      <div className="card mb-5 grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Lifetime revenue" value={money(totals.lifetimeRevenue)} />
        <Stat label="Lifetime cost" value={money(totals.lifetimeCost)} />
        <Stat
          label="Lifetime profit"
          value={money(totals.lifetimeProfit)}
          hint={totals.lifetimeMargin != null ? `${totals.lifetimeMargin}% margin` : undefined}
          tone={totals.lifetimeProfit < 0 ? "bad" : "good"}
        />
        <Stat label="Active jobs" value={String(totals.activeJobCount)} />
        <Stat
          label="Properties"
          value={String(totals.propertyCount)}
          hint={`${totals.completedJobCount} completed ${totals.completedJobCount === 1 ? "job" : "jobs"}`}
        />
      </div>

      {/* ── Contact ─────────────────────────────────────────────────────── */}
      <div className="card mb-5 p-4">
        {editing ? (
          <form onSubmit={submitEdit} className="grid gap-3 md:grid-cols-3">
            <label className="text-sm font-medium">
              Name
              <input className="field mt-1" value={editName} onChange={(e) => setEditName(e.target.value)} required />
            </label>
            <label className="text-sm font-medium">
              Email
              <input className="field mt-1" type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} />
            </label>
            <label className="text-sm font-medium">
              Phone
              <input className="field mt-1" type="tel" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} />
            </label>
            <div className="flex gap-2 md:col-span-3">
              <button className="btn btn-primary" type="submit" disabled={updateAccount.isPending}>Save</button>
              <button className="btn btn-secondary" type="button" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm text-rce-muted">{account.email || <span className="italic text-rce-soft">No email</span>}</p>
              <p className="text-sm text-rce-muted">{account.phone || <span className="italic text-rce-soft">No phone</span>}</p>
              <p className="text-xs text-rce-soft">Account opened {shortDate(account.createdAt)}</p>
            </div>
            <div className="flex gap-2">
              <button className="btn btn-secondary" onClick={startEdit}>Edit Contact</button>
              <button
                className="btn btn-secondary text-red-600 hover:border-red-400"
                onClick={confirmDelete}
                disabled={deleteAccount.isPending}
              >
                Delete
              </button>
            </div>
          </div>
        )}
        {deleteAccount.error && (
          <p className="mt-2 text-sm text-red-600">{(deleteAccount.error as Error).message}</p>
        )}
      </div>

      {/* ── Addresses ───────────────────────────────────────────────────── */}
      <section className="card mb-5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Addresses</h2>
            <p className="text-xs text-rce-muted">
              One account, any number of properties. Work is always recorded against a
              specific address.
            </p>
          </div>
          <button className="btn btn-secondary" onClick={() => setShowAddProperty((open) => !open)}>
            {showAddProperty ? "Cancel" : "+ Add Property"}
          </button>
        </div>

        {showAddProperty && (
          <form className="mt-4 grid gap-3 rounded-lg border border-rce-border p-3 md:grid-cols-5" onSubmit={submitProperty}>
            <label className="text-sm font-medium">
              Property Name
              <input className="field mt-1" value={propertyName} onChange={(e) => setPropertyName(e.target.value)} required />
            </label>
            <label className="text-sm font-medium md:col-span-2">
              Address
              <input className="field mt-1" value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} required />
            </label>
            <label className="text-sm font-medium">
              City
              <input className="field mt-1" value={city} onChange={(e) => setCity(e.target.value)} required />
            </label>
            <label className="text-sm font-medium">
              State / ZIP
              <div className="mt-1 grid grid-cols-2 gap-2">
                <input className="field" value={state} onChange={(e) => setState(e.target.value)} required />
                <input className="field" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} required />
              </div>
            </label>
            <div className="md:col-span-5">
              <button className="btn btn-primary" type="submit" disabled={createProperty.isPending}>
                {createProperty.isPending ? "Adding…" : "Add Property"}
              </button>
            </div>
          </form>
        )}

        <div className="mt-4 space-y-2">
          {properties.map((property) => (
            <div key={property.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rce-border p-3">
              <div>
                <p className="font-medium">{property.name}</p>
                <p className="text-sm text-rce-muted">
                  {property.addressLine1}
                  {property.addressLine2 ? `, ${property.addressLine2}` : ""}, {property.city}, {property.state} {property.postalCode}
                </p>
                <p className="mt-1 text-xs text-rce-soft">
                  {property.activeJobCount} active · {property.completedJobCount} completed
                  {property.lastInspectionDate && ` · last assessed ${shortDate(property.lastInspectionDate)}`}
                </p>
                {property.openFindingCount > 0 && (
                  <p className="mt-1 text-xs font-medium text-amber-700">
                    {property.openFindingCount} open finding{property.openFindingCount === 1 ? "" : "s"}
                    {property.openDefectCount > 0 &&
                      ` · ${property.openDefectCount} needing correction`}
                  </p>
                )}
              </div>
              <Link to={`/properties/${property.id}`} className="btn btn-secondary">Open Property</Link>
            </div>
          ))}
          {properties.length === 0 && (
            <p className="text-sm text-rce-muted">No addresses on this account yet.</p>
          )}
        </div>
      </section>

      {/* ── Jobs ────────────────────────────────────────────────────────── */}
      <JobSection title="Current jobs" jobs={activeJobs} emptyText="No jobs in flight." defaultOpen />
      <JobSection title="Past jobs" jobs={pastJobs} emptyText="No completed jobs yet." />

      <FindingLedger
        findings={summary.findings ?? []}
        propertyLabels={Object.fromEntries(
          properties.map((property) => [property.id, `${property.name} — ${property.addressLine1}`]),
        )}
      />

      <HealthInspectionHistory summary={summary} />
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "bad" }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-rce-soft">{label}</p>
      <p className={`text-xl font-semibold ${tone === "bad" ? "text-red-600" : ""}`}>{value}</p>
      {hint && <p className="text-xs text-rce-muted">{hint}</p>}
    </div>
  );
}

function JobSection({
  title, jobs, emptyText, defaultOpen = false,
}: { title: string; jobs: AccountJob[]; emptyText: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="card mb-5 p-4">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <h2 className="text-lg font-semibold">
          {title} <span className="text-sm font-normal text-rce-muted">({jobs.length})</span>
        </h2>
        <span className="text-sm text-rce-muted">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {jobs.map((job) => <JobCard key={job.visitId} job={job} />)}
          {jobs.length === 0 && <p className="text-sm text-rce-muted">{emptyText}</p>}
        </div>
      )}
    </section>
  );
}

function JobCard({ job }: { job: AccountJob }) {
  const [showCosts, setShowCosts] = useState(false);
  const { costs } = job;
  const hasCostDetail = job.purchaseOrders.length > 0 || job.receipts.length > 0 || job.documents.length > 0;

  return (
    <article className="rounded-lg border border-rce-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link to={`/visits/${job.visitId}`} className="font-medium hover:text-rce-accent">
            {job.jobType || job.purpose || job.mode.replaceAll("_", " ")}
          </Link>
          <p className="text-sm text-rce-muted">{job.propertyLabel}</p>
          <p className="text-xs text-rce-soft">
            {shortDate(job.visitDate)}
            {job.scheduledStart && ` · scheduled ${shortDate(job.scheduledStart)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <JobStatusPill status={job.status} />
          {job.latestEstimate && <StatusBadge status={job.latestEstimate.status} />}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Metric label="Revenue" value={money(costs.revenue)} />
        <Metric label="Cost" value={money(costs.totalCost)} />
        <Metric
          label="Profit"
          value={money(costs.grossProfit)}
          tone={costs.grossProfit != null && costs.grossProfit < 0 ? "bad" : undefined}
        />
        <Metric label="Margin" value={costs.margin != null ? `${costs.margin}%` : "-"} />
      </div>

      {hasCostDetail && (
        <button
          type="button"
          className="mt-2 text-xs font-medium text-rce-accent"
          onClick={() => setShowCosts((s) => !s)}
        >
          {showCosts ? "Hide cost detail" : "Cost detail"}
          {" · "}
          {job.purchaseOrders.length} PO{job.purchaseOrders.length === 1 ? "" : "s"}
          {" · "}
          {job.receipts.length} receipt{job.receipts.length === 1 ? "" : "s"}
        </button>
      )}

      {showCosts && (
        <div className="mt-3 space-y-3 rounded-md bg-rce-bg p-3 text-xs">
          <CostBreakdown job={job} />

          {job.purchaseOrders.length > 0 && (
            <div>
              <p className="font-semibold uppercase tracking-wide text-rce-soft">Purchase orders</p>
              <ul className="mt-1 space-y-1">
                {job.purchaseOrders.map((order) => (
                  <li key={order.id} className="flex justify-between gap-2">
                    <span>{order.supplier} · {order.itemCount} item{order.itemCount === 1 ? "" : "s"}</span>
                    <span className="text-rce-muted">
                      {order.sentAt ? `sent ${shortDate(order.sentAt)}` : "not sent"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {job.receipts.length > 0 && (
            <div>
              <p className="font-semibold uppercase tracking-wide text-rce-soft">Receipts</p>
              <ul className="mt-1 space-y-1">
                {job.receipts.map((receipt) => (
                  <li key={receipt.id} className="flex justify-between gap-2">
                    <span>
                      {receipt.vendor || "Unknown vendor"} · {receipt.category}
                      {receipt.status === "pending_review" && (
                        <span className="ml-1 rounded bg-amber-100 px-1 text-amber-800">needs review</span>
                      )}
                    </span>
                    <span className="text-rce-muted">{money(receipt.amount)} · {shortDate(receipt.receivedAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {job.documents.length > 0 && (
            <div>
              <p className="font-semibold uppercase tracking-wide text-rce-soft">Documents</p>
              <ul className="mt-1 space-y-1">
                {job.documents.map((doc) => (
                  <li key={doc.id} className="flex justify-between gap-2">
                    <span>{doc.type.replaceAll("_", " ")}</span>
                    <span className="text-rce-muted">
                      {doc.signedAt ? `signed ${shortDate(doc.signedAt)}` : doc.sentAt ? `sent ${shortDate(doc.sentAt)}` : "draft"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function CostBreakdown({ job }: { job: AccountJob }) {
  const { costs } = job;
  return (
    <div>
      <p className="font-semibold uppercase tracking-wide text-rce-soft">Cost breakdown</p>
      <ul className="mt-1 space-y-1">
        <li className="flex justify-between gap-2"><span>Materials</span><span>{money(costs.materialCost)}</span></li>
        <li className="flex justify-between gap-2">
          <span>Labor · {costs.laborHours} hr @ {money(costs.laborRate)}/hr</span>
          <span>{money(costs.laborCost)}</span>
        </li>
        <li className="flex justify-between gap-2"><span>Overhead</span><span>{money(costs.overhead)}</span></li>
        <li className="flex justify-between gap-2 border-t border-rce-border pt-1 font-medium">
          <span>Total cost</span><span>{money(costs.totalCost)}</span>
        </li>
      </ul>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-rce-soft">{label}</p>
      <p className={`font-medium ${tone === "bad" ? "text-red-600" : ""}`}>{value}</p>
    </div>
  );
}

function HealthInspectionHistory({ summary }: { summary: AccountSummary }) {
  const { inspections, properties } = summary;
  if (inspections.length === 0) return null;

  const propertyLabel = (propertyId: string) =>
    properties.find((p) => p.id === propertyId)?.addressLine1 ?? "Unknown address";

  return (
    <section className="card mt-5 p-4">
      <h2 className="text-lg font-semibold">Electrical health record history</h2>
      <p className="text-xs text-rce-muted">
        Inspections recorded from the field app, per address — the account's retention record.
      </p>
      <ul className="mt-3 space-y-2">
        {inspections.map((inspection) => (
          <li key={inspection.id} className="rounded-lg border border-rce-border p-3 text-sm">
            <Link to={`/visits/${inspection.visitId}`} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <span className="mr-2">
                  <InspectionResultChip
                    criticalCount={inspection.criticalFindings.length}
                    failCount={inspection.failCount}
                    monitorCount={inspection.monitorCount}
                    schemaVersion={inspection.schemaVersion}
                    score={inspection.score}
                  />
                </span>
                {shortDate(inspection.inspectionDate)} · {propertyLabel(inspection.propertyId)} ·{" "}
                {inspection.itemsAssessed} items
                {inspection.scope === "phase1" && " (Phase 1)"}
                {inspection.criticalFindings.length > 0 && (
                  <span className="ml-2 font-semibold text-red-600">
                    ⚠ {inspection.criticalFindings.join(", ")}
                  </span>
                )}
                {!inspection.contractorReviewed && inspection.criticalFindings.length > 0 && (
                  <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-800">awaiting review</span>
                )}
              </span>
              <span className="text-xs text-rce-muted">open visit →</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
