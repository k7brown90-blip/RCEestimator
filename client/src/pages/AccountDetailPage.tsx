import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { InspectionResultChip } from "../components/InspectionResultChip";
import { FindingLedger } from "../components/FindingLedger";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { api } from "../lib/api";
import { ADDRESS_QUERY_KEYS } from "../lib/queryKeys";
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

/**
 * One address, add and edit. Includes the fields the add form used to drop —
 * the unit line and notes were accepted by the API and collected nowhere, and
 * the code jurisdiction is what the Health Record reads to decide which NEC
 * edition an address is assessed under.
 */
interface AddressForm {
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  occupancyType: string;
  jurisdictionId: string;
  notes: string;
}

const blankAddress = (): AddressForm => ({
  name: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "TN",
  postalCode: "",
  occupancyType: "residential",
  jurisdictionId: "",
  notes: "",
});

/** Empty strings mean "not set" on the wire, not "set to blank". */
function toPropertyPayload(form: AddressForm) {
  return {
    name: form.name,
    addressLine1: form.addressLine1,
    addressLine2: form.addressLine2 || null,
    city: form.city,
    state: form.state,
    postalCode: form.postalCode,
    occupancyType: form.occupancyType,
    // Null hands the decision back to services/jurisdictionResolver.ts, which
    // derives it from the ZIP. That's the right default — an explicit value here
    // is an override the office has deliberately made.
    jurisdictionId: form.jurisdictionId || null,
    notes: form.notes || null,
  };
}

const JURISDICTIONS = ["murfreesboro", "brentwood", "rutherford", "franklin", "nashville"];

function AddressFields({ form, onChange }: { form: AddressForm; onChange: (next: AddressForm) => void }) {
  const set = (patch: Partial<AddressForm>) => onChange({ ...form, ...patch });
  return (
    <>
      <label className="text-sm font-medium">
        Property Name
        <input className="field mt-1" value={form.name} onChange={(e) => set({ name: e.target.value })} required />
      </label>
      <label className="text-sm font-medium md:col-span-2">
        Address
        <input className="field mt-1" value={form.addressLine1} onChange={(e) => set({ addressLine1: e.target.value })} required />
      </label>
      <label className="text-sm font-medium">
        Unit / Apt <span className="text-rce-soft">(optional)</span>
        <input className="field mt-1" value={form.addressLine2} onChange={(e) => set({ addressLine2: e.target.value })} />
      </label>
      <label className="text-sm font-medium">
        City
        <input className="field mt-1" value={form.city} onChange={(e) => set({ city: e.target.value })} required />
      </label>
      <label className="text-sm font-medium">
        State / ZIP
        <div className="mt-1 grid grid-cols-2 gap-2">
          <input className="field" value={form.state} onChange={(e) => set({ state: e.target.value.toUpperCase() })} maxLength={2} required />
          <input className="field" value={form.postalCode} onChange={(e) => set({ postalCode: e.target.value })} required />
        </div>
      </label>
      <label className="text-sm font-medium">
        Occupancy
        <select className="field mt-1" value={form.occupancyType} onChange={(e) => set({ occupancyType: e.target.value })}>
          <option value="residential">Residential</option>
          <option value="commercial">Commercial</option>
        </select>
      </label>
      <label className="text-sm font-medium">
        Code jurisdiction
        <select className="field mt-1" value={form.jurisdictionId} onChange={(e) => set({ jurisdictionId: e.target.value })}>
          <option value="">Derive from ZIP</option>
          {JURISDICTIONS.map((id) => (
            <option key={id} value={id}>{id}</option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium md:col-span-2">
        Notes <span className="text-rce-soft">(optional)</span>
        <input className="field mt-1" value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
      </label>
    </>
  );
}

export function AccountDetailPage() {
  const { accountId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: summary, isLoading, error } = useQuery({
    // NOT ["account", id] — that key belongs to `api.account`, whose response has no `jobs`.
    // See the note in lib/queryKeys.ts; sharing it crashed this page.
    queryKey: ["account-summary", accountId],
    queryFn: () => api.accountSummary(accountId),
    enabled: Boolean(accountId),
  });

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");

  const [showAddProperty, setShowAddProperty] = useState(false);
  const [addForm, setAddForm] = useState<AddressForm>(blankAddress());

  const [editingPropertyId, setEditingPropertyId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<AddressForm>(blankAddress());

  // Every list that shows an address, invalidated together. Missing
  // ["properties"] here is what kept a newly added address out of the Jobs
  // page's picker until a hard reload.
  const invalidate = () => {
    for (const key of ADDRESS_QUERY_KEYS) {
      queryClient.invalidateQueries({ queryKey: [...key] });
    }
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
      invalidate();
      navigate("/accounts");
    },
  });

  const createProperty = useMutation({
    mutationFn: api.createProperty,
    onSuccess: () => {
      invalidate();
      setAddForm(blankAddress());
      setShowAddProperty(false);
    },
  });

  const updateProperty = useMutation({
    mutationFn: (input: { propertyId: string; form: AddressForm }) =>
      api.updateProperty(input.propertyId, toPropertyPayload(input.form)),
    onSuccess: () => {
      invalidate();
      setEditingPropertyId(null);
    },
  });

  const deleteProperty = useMutation({
    mutationFn: (propertyId: string) => api.deleteProperty(propertyId),
    onSuccess: invalidate,
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
    createProperty.mutate({ customerId: accountId, ...toPropertyPayload(addForm) });
  }

  function startEditProperty(property: AccountSummary["properties"][number]) {
    // No extra fetch: the account summary already spreads the whole property row.
    setEditForm({
      name: property.name,
      addressLine1: property.addressLine1,
      addressLine2: property.addressLine2 ?? "",
      city: property.city,
      state: property.state,
      postalCode: property.postalCode,
      occupancyType: property.occupancyType ?? "residential",
      jurisdictionId: property.jurisdictionId ?? "",
      notes: property.notes ?? "",
    });
    setEditingPropertyId(property.id);
    setShowAddProperty(false);
  }

  function confirmDeleteProperty(property: AccountSummary["properties"][number]) {
    if (window.confirm(`Remove ${property.name} — ${property.addressLine1} from this account?`)) {
      deleteProperty.mutate(property.id);
    }
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
            <AddressFields form={addForm} onChange={setAddForm} />
            <div className="md:col-span-5">
              <button className="btn btn-primary" type="submit" disabled={createProperty.isPending}>
                {createProperty.isPending ? "Adding…" : "Add Property"}
              </button>
            </div>
            {createProperty.error && (
              <p className="text-sm text-red-600 md:col-span-5">{(createProperty.error as Error).message}</p>
            )}
          </form>
        )}

        <div className="mt-4 space-y-2">
          {properties.map((property) => {
            const jobCount = property.activeJobCount + property.completedJobCount;
            return editingPropertyId === property.id ? (
              <form
                key={property.id}
                className="grid gap-3 rounded-lg border border-rce-accent p-3 md:grid-cols-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  updateProperty.mutate({ propertyId: property.id, form: editForm });
                }}
              >
                <AddressFields form={editForm} onChange={setEditForm} />
                <div className="flex gap-2 md:col-span-5">
                  <button className="btn btn-primary" type="submit" disabled={updateProperty.isPending}>
                    {updateProperty.isPending ? "Saving…" : "Save Address"}
                  </button>
                  <button className="btn btn-secondary" type="button" onClick={() => setEditingPropertyId(null)}>
                    Cancel
                  </button>
                </div>
                {updateProperty.error && (
                  <p className="text-sm text-red-600 md:col-span-5">{(updateProperty.error as Error).message}</p>
                )}
              </form>
            ) : (
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
                    {property.jurisdictionId && ` · ${property.jurisdictionId}`}
                  </p>
                  {property.openFindingCount > 0 && (
                    <p className="mt-1 text-xs font-medium text-amber-700">
                      {property.openFindingCount} open finding{property.openFindingCount === 1 ? "" : "s"}
                      {property.openDefectCount > 0 &&
                        ` · ${property.openDefectCount} needing correction`}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button className="btn btn-secondary" onClick={() => startEditProperty(property)}>Edit</button>
                  {/* Hidden once there's job history, but the server's 409 is the
                      real guard — findings and documents aren't in these counts. */}
                  {jobCount === 0 && (
                    <button className="btn btn-danger" onClick={() => confirmDeleteProperty(property)}>
                      Delete
                    </button>
                  )}
                  <Link to={`/properties/${property.id}`} className="btn btn-secondary">Open Property</Link>
                </div>
              </div>
            );
          })}
          {properties.length === 0 && (
            <p className="text-sm text-rce-muted">No addresses on this account yet.</p>
          )}
          {deleteProperty.error && (
            <p className="text-sm text-red-600">{(deleteProperty.error as Error).message}</p>
          )}
        </div>
      </section>

      <StartWorkCard accountId={account.id} properties={properties} />
      <AccountEstimates accountId={account.id} properties={properties} />

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

/**
 * Where work starts. (P029)
 *
 * Kyle, 2026-08-18: *"Now we have an account established and if they call back we go to their
 * account and schedule an appointment -> estimate -> signed quote -> job -> payment."*
 *
 * Before this the account page showed properties, jobs, findings and inspections — and had no way
 * to begin any of it. The estimate flow lived on its own page with no connection to the customer,
 * which is the thing Kyle filed three times.
 *
 * THE ADDRESS IS PICKED, NEVER ASSUMED. When the account has one property it is preselected
 * because there is nothing to choose; with several, the operator chooses and the buttons stay
 * disabled until they have. Silently defaulting to the first address is how the wrong street ends
 * up on a signed document.
 */
function StartWorkCard({
  accountId,
  properties,
}: {
  accountId: string;
  properties: AccountSummary["properties"];
}) {
  const navigate = useNavigate();
  const [addressId, setAddressId] = useState(properties.length === 1 ? properties[0].id : "");
  const [error, setError] = useState<string | null>(null);

  const scheduleVisit = useMutation({
    mutationFn: () =>
      api.createVisit({
        customerId: accountId,
        propertyId: addressId,
        mode: "onsite",
        purpose: "Appointment",
      }),
    onSuccess: (visit) => navigate(`/visits/${visit.id}`),
    onError: (err) => setError((err as Error).message),
  });

  const need = () => {
    if (!addressId) {
      setError("Pick the address you are working at first.");
      return false;
    }
    setError(null);
    return true;
  };

  if (properties.length === 0) {
    return (
      <section className="card mb-5 p-4">
        <h2 className="text-lg font-semibold">Start work</h2>
        <p className="mt-2 text-sm text-rce-muted">
          Add an address to this account first — every appointment, estimate and job links to the
          address it happens at.
        </p>
      </section>
    );
  }

  return (
    <section className="card mb-5 p-4">
      <h2 className="text-lg font-semibold">Start work</h2>
      <p className="mt-1 text-xs text-rce-soft">
        Appointment &rarr; estimate &rarr; signed quote &rarr; job. All of it links to this account,
        at the address you pick.
      </p>

      {properties.length > 1 ? (
        <label className="mt-3 block text-sm font-medium">
          Address being worked
          <select
            className="field mt-1 w-full"
            value={addressId}
            onChange={(e) => {
              setAddressId(e.target.value);
              setError(null);
            }}
          >
            <option value="">Pick an address…</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.addressLine1}, {p.city}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="mt-3 text-sm text-rce-text">
          {properties[0].name} — {properties[0].addressLine1}, {properties[0].city}
        </p>
      )}

      {error && <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-900">{error}</p>}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <button
          className="btn btn-primary flex-1"
          disabled={scheduleVisit.isPending}
          onClick={() => {
            if (!need()) return;
            scheduleVisit.mutate();
          }}
        >
          {scheduleVisit.isPending ? "Creating…" : "Schedule a visit"}
        </button>
        <button
          className="btn btn-primary flex-1"
          onClick={() => {
            if (!need()) return;
            // The intake screen opens already bound to this account and address.
            navigate(`/estimate-intake?account=${accountId}&address=${addressId}`);
          }}
        >
          Start an estimate
        </button>
      </div>
    </section>
  );
}

/**
 * Everything quoted for this account — the estimate half of Kyle's funnel, per address.
 *
 * Filterable by address because an account with three properties has three separate histories,
 * and "what have I quoted at this house" is the question being asked.
 */
function AccountEstimates({
  accountId,
  properties,
}: {
  accountId: string;
  properties: AccountSummary["properties"];
}) {
  const [addressId, setAddressId] = useState("");
  const { data } = useQuery({
    queryKey: ["account-estimates", accountId, addressId],
    queryFn: () => api.accountEstimates(accountId, addressId || undefined),
  });
  const rows = data?.estimates ?? [];

  return (
    <section className="card mb-5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          Estimates <span className="text-sm font-normal text-rce-muted">({rows.length})</span>
        </h2>
        {properties.length > 1 && (
          <select
            className="field text-sm"
            value={addressId}
            onChange={(e) => setAddressId(e.target.value)}
          >
            <option value="">All addresses</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.addressLine1}
              </option>
            ))}
          </select>
        )}
      </div>

      {rows.length === 0 && (
        <p className="mt-3 text-sm text-rce-muted">
          Nothing quoted{addressId ? " at this address" : ""} yet.
        </p>
      )}

      <div className="mt-3 space-y-2">
        {rows.map((e) => (
          <Link
            key={e.id}
            to={`/estimate-intake?estimate=${e.id}`}
            className="block rounded-lg border border-rce-border/70 p-3 active:opacity-70"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{e.title}</p>
                <p className="text-xs text-rce-soft">
                  {e.number}
                  {e.revision > 1 ? ` rev ${e.revision}` : ""} ·{" "}
                  {/* The FROZEN text, not a live lookup — this is what the signed document says. */}
                  {e.serviceAddress ?? "address missing"}
                </p>
                <p className="text-xs uppercase tracking-wide text-rce-muted">{e.status}</p>
              </div>
              <p className="shrink-0 font-semibold">${e.total.toFixed(2)}</p>
            </div>
          </Link>
        ))}
      </div>
    </section>
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
