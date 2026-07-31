import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { CustomerMatchPicker } from "../components/CustomerMatchPicker";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import {
  LEAD_CALL_TYPES,
  LEAD_CONTACT_PREFERENCES,
  LEAD_FOLLOW_UP_REASONS,
  LEAD_LOST_REASONS,
  LEAD_SOURCES,
  type Lead,
  type LeadWriteInput,
} from "../lib/types";

/**
 * Manual lead entry and editing.
 *
 * A page rather than a modal: there are twenty-odd fields, and at `Modal`'s
 * max-w-lg the save button scrolls out of sight. One component serves both
 * `/leads/new` and `/leads/:leadId/edit` so the field set, the validation and the
 * duplicate picker exist once — the old inline row-edit form covered six fields
 * and would have drifted from this immediately.
 */

interface FormState {
  name: string;
  phone: string;
  email: string;
  contactPreference: string;
  bestTimeToReach: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  jobType: string;
  callType: string;
  urgentFlag: boolean;
  warrantyCall: boolean;
  warrantyNote: string;
  notes: string;
  source: string;
  referredBy: string;
  status: string;
  leadStatus: string;
  followUpDate: string;
  followUpReason: string;
  lostReason: string;
  lostNotes: string;
}

const blank = (): FormState => ({
  name: "", phone: "", email: "", contactPreference: "", bestTimeToReach: "",
  addressLine1: "", addressLine2: "", city: "", state: "TN", postalCode: "",
  jobType: "", callType: "", urgentFlag: false, warrantyCall: false, warrantyNote: "",
  notes: "", source: "manual", referredBy: "",
  status: "new", leadStatus: "new", followUpDate: "", followUpReason: "",
  lostReason: "", lostNotes: "",
});

const fromLead = (lead: Lead): FormState => ({
  name: lead.name,
  phone: lead.phone ?? "",
  email: lead.email ?? "",
  contactPreference: lead.contactPreference ?? "",
  bestTimeToReach: lead.bestTimeToReach ?? "",
  addressLine1: lead.addressLine1 ?? "",
  addressLine2: lead.addressLine2 ?? "",
  city: lead.city ?? "",
  state: lead.state ?? "TN",
  postalCode: lead.postalCode ?? "",
  jobType: lead.jobType ?? "",
  callType: lead.callType ?? "",
  urgentFlag: lead.urgentFlag ?? false,
  warrantyCall: lead.warrantyCall ?? false,
  warrantyNote: lead.warrantyNote ?? "",
  notes: lead.notes ?? "",
  source: lead.source,
  referredBy: lead.referredBy ?? "",
  status: lead.status,
  leadStatus: lead.leadStatus ?? "new",
  followUpDate: lead.followUpDate ? lead.followUpDate.slice(0, 10) : "",
  followUpReason: lead.followUpReason ?? "",
  lostReason: lead.lostReason ?? "",
  lostNotes: lead.lostNotes ?? "",
});

/** Empty string means "not set", never "set to blank". */
const orNull = (value: string) => (value.trim() ? value.trim() : null);

function toPayload(form: FormState, link: { customerId: string | null; propertyId: string | null }): LeadWriteInput {
  // An address chosen from an existing account lives on propertyId — writing the
  // structured fields too would leave a shadow copy that could drift from it.
  const usingExistingAddress = Boolean(link.propertyId);
  return {
    name: form.name.trim(),
    phone: orNull(form.phone),
    email: orNull(form.email),
    contactPreference: orNull(form.contactPreference) as LeadWriteInput["contactPreference"],
    bestTimeToReach: orNull(form.bestTimeToReach),
    addressLine1: usingExistingAddress ? null : orNull(form.addressLine1),
    addressLine2: usingExistingAddress ? null : orNull(form.addressLine2),
    city: usingExistingAddress ? null : orNull(form.city),
    state: usingExistingAddress ? null : orNull(form.state)?.toUpperCase() ?? null,
    postalCode: usingExistingAddress ? null : orNull(form.postalCode),
    jobType: orNull(form.jobType),
    callType: orNull(form.callType),
    urgentFlag: form.urgentFlag,
    warrantyCall: form.warrantyCall,
    warrantyNote: form.warrantyCall ? orNull(form.warrantyNote) : null,
    notes: orNull(form.notes),
    source: form.source as LeadWriteInput["source"],
    referredBy: orNull(form.referredBy),
    status: form.status as LeadWriteInput["status"],
    leadStatus: form.leadStatus as LeadWriteInput["leadStatus"],
    followUpDate: orNull(form.followUpDate),
    followUpReason: orNull(form.followUpReason) as LeadWriteInput["followUpReason"],
    lostReason: form.status === "lost" ? (orNull(form.lostReason) as LeadWriteInput["lostReason"]) : null,
    lostNotes: form.status === "lost" ? orNull(form.lostNotes) : null,
    customerId: link.customerId,
    propertyId: link.propertyId,
  };
}

export function LeadFormPage() {
  const { leadId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isEdit = Boolean(leadId);

  const [form, setForm] = useState<FormState>(blank());
  const [link, setLink] = useState<{ customerId: string | null; propertyId: string | null }>({
    customerId: null, propertyId: null,
  });
  const [showPipeline, setShowPipeline] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);

  const { data: existing, isLoading } = useQuery({
    queryKey: ["leads", { leadId }],
    queryFn: async () => (await api.leads()).find((l) => l.id === leadId) ?? null,
    enabled: isEdit,
  });

  useEffect(() => {
    if (!existing) return;
    setForm(fromLead(existing));
    setLink({ customerId: existing.customerId ?? null, propertyId: existing.propertyId ?? null });
    // Open the pipeline section when there's something in it worth seeing.
    if (existing.status !== "new" || existing.followUpDate || existing.lostReason) setShowPipeline(true);
  }, [existing]);

  const set = (patch: Partial<FormState>) => setForm((prev) => ({ ...prev, ...patch }));

  const save = useMutation({
    mutationFn: async () => {
      const payload = toPayload(form, link);
      if (isEdit) return api.updateLead(leadId!, payload);
      const { lead } = await api.createLead(payload);
      return lead;
    },
    onSuccess: (lead) => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      queryClient.invalidateQueries({ queryKey: ["crm-analytics"] });
      navigate("/leads", { state: { highlight: lead.id } });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setAddressError(null);

    // Mirror of the server's all-or-nothing rule, so the owner hears it here
    // rather than as a 400 after filling out the whole form.
    if (!link.propertyId) {
      const parts = [form.addressLine1, form.city, form.state, form.postalCode];
      const filled = parts.filter((p) => p.trim()).length;
      if (filled > 0 && filled < 4) {
        setAddressError(
          "An address needs street, city, state and ZIP together — or leave all four blank and add it later.",
        );
        return;
      }
    }
    save.mutate();
  }

  if (isEdit && isLoading) return <p className="text-sm text-rce-muted">Loading lead…</p>;
  if (isEdit && !existing) return <p className="text-sm text-rce-muted">Lead not found.</p>;

  return (
    <form onSubmit={submit} className="pb-24">
      <PageHeader
        title={isEdit ? `Edit ${existing?.name}` : "New Lead"}
        subtitle={
          isEdit
            ? "Everything the phone agent can record, editable here."
            : "A walk-in, a referral, a job written on the back of an invoice."
        }
      />

      {/* ── Who ──────────────────────────────────────────────────────────── */}
      <section className="card mb-4 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-rce-soft">Who</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-sm font-medium">
            Name
            <input className="field mt-1" value={form.name} onChange={(e) => set({ name: e.target.value })} required />
          </label>
          <label className="text-sm font-medium">
            Phone
            <input className="field mt-1" type="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
          </label>
          <label className="text-sm font-medium">
            Email
            <input className="field mt-1" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
          </label>
          <label className="text-sm font-medium">
            Contact preference
            <select className="field mt-1" value={form.contactPreference} onChange={(e) => set({ contactPreference: e.target.value })}>
              <option value="">Not stated</option>
              {LEAD_CONTACT_PREFERENCES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="text-sm font-medium md:col-span-2">
            Best time to reach
            <input className="field mt-1" placeholder="mornings, after 3pm…" value={form.bestTimeToReach} onChange={(e) => set({ bestTimeToReach: e.target.value })} />
          </label>
        </div>

        <div className="mt-3">
          <CustomerMatchPicker
            phone={form.phone}
            email={form.email}
            name={form.name}
            linkedCustomerId={link.customerId}
            linkedPropertyId={link.propertyId}
            onLink={(customerId, propertyId) => setLink({ customerId, propertyId })}
            onUnlink={() => setLink({ customerId: null, propertyId: null })}
          />
        </div>
      </section>

      {/* ── Where ────────────────────────────────────────────────────────── */}
      {!link.propertyId && (
        <section className="card mb-4 p-4">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-rce-soft">Where</h2>
          <p className="mb-3 text-xs text-rce-muted">
            Optional now — but a lead can't be converted into a job without one.
          </p>
          <div className="grid gap-3 md:grid-cols-4">
            <label className="text-sm font-medium md:col-span-2">
              Street address
              <input className="field mt-1" value={form.addressLine1} onChange={(e) => set({ addressLine1: e.target.value })} />
            </label>
            <label className="text-sm font-medium">
              Unit / Apt
              <input className="field mt-1" value={form.addressLine2} onChange={(e) => set({ addressLine2: e.target.value })} />
            </label>
            <label className="text-sm font-medium">
              City
              <input className="field mt-1" value={form.city} onChange={(e) => set({ city: e.target.value })} />
            </label>
            <label className="text-sm font-medium">
              State
              <input className="field mt-1" maxLength={2} value={form.state} onChange={(e) => set({ state: e.target.value.toUpperCase() })} />
            </label>
            <label className="text-sm font-medium">
              ZIP
              <input className="field mt-1" value={form.postalCode} onChange={(e) => set({ postalCode: e.target.value })} />
            </label>
          </div>
          {addressError && <p className="mt-2 text-sm text-red-600">{addressError}</p>}
        </section>
      )}

      {/* ── What ─────────────────────────────────────────────────────────── */}
      <section className="card mb-4 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-rce-soft">What they need</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-sm font-medium">
            Job type
            <input className="field mt-1" placeholder="Panel upgrade, EV charger…" value={form.jobType} onChange={(e) => set({ jobType: e.target.value })} />
          </label>
          <label className="text-sm font-medium">
            Call type
            <select className="field mt-1" value={form.callType} onChange={(e) => set({ callType: e.target.value })}>
              <option value="">Not classified</option>
              {LEAD_CALL_TYPES.map((c) => <option key={c} value={c}>{c.replaceAll("_", " ")}</option>)}
            </select>
          </label>
          <div className="flex items-end gap-4 text-sm font-medium">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.urgentFlag} onChange={(e) => set({ urgentFlag: e.target.checked })} />
              Urgent
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.warrantyCall} onChange={(e) => set({ warrantyCall: e.target.checked })} />
              Warranty call
            </label>
          </div>
          {form.warrantyCall && (
            <label className="text-sm font-medium md:col-span-3">
              What's the warranty claim?
              <input className="field mt-1" value={form.warrantyNote} onChange={(e) => set({ warrantyNote: e.target.value })} />
            </label>
          )}
          <label className="text-sm font-medium md:col-span-3">
            Notes
            <textarea className="field mt-1" rows={3} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
          </label>
        </div>
      </section>

      {/* ── Where it came from ───────────────────────────────────────────── */}
      <section className="card mb-4 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-rce-soft">Where it came from</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm font-medium">
            Source
            <select className="field mt-1" value={form.source} onChange={(e) => set({ source: e.target.value })}>
              {LEAD_SOURCES.map((s) => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}
            </select>
          </label>
          <label className="text-sm font-medium">
            Referred by
            <input className="field mt-1" value={form.referredBy} onChange={(e) => set({ referredBy: e.target.value })} />
          </label>
        </div>
      </section>

      {/* ── Pipeline ─────────────────────────────────────────────────────── */}
      <section className="card mb-4 p-4">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left"
          onClick={() => setShowPipeline((open) => !open)}
        >
          <span className="text-sm font-semibold uppercase tracking-wide text-rce-soft">
            Pipeline &amp; follow-up
          </span>
          <span className="text-xs text-rce-accent">{showPipeline ? "hide" : "show"}</span>
        </button>

        {showPipeline && (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-sm font-medium">
              Status
              <select className="field mt-1" value={form.status} onChange={(e) => set({ status: e.target.value })}>
                <option value="new">new</option>
                <option value="contacted">contacted</option>
                <option value="lost">lost</option>
                {/* "converted" is deliberately absent — conversion is a
                    transition that creates an account, address and job, not a
                    status you can type. */}
              </select>
            </label>
            <label className="text-sm font-medium">
              Funnel state
              <select className="field mt-1" value={form.leadStatus} onChange={(e) => set({ leadStatus: e.target.value })}>
                {["new", "booked", "unresolved", "planning", "no_answer", "lost", "won"].map((s) => (
                  <option key={s} value={s}>{s.replaceAll("_", " ")}</option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium">
              Follow up on
              <input className="field mt-1" type="date" value={form.followUpDate} onChange={(e) => set({ followUpDate: e.target.value })} />
            </label>
            <label className="text-sm font-medium">
              Why follow up
              <select className="field mt-1" value={form.followUpReason} onChange={(e) => set({ followUpReason: e.target.value })}>
                <option value="">Not stated</option>
                {LEAD_FOLLOW_UP_REASONS.map((r) => <option key={r} value={r}>{r.replaceAll("_", " ")}</option>)}
              </select>
            </label>

            {form.status === "lost" && (
              <>
                <label className="text-sm font-medium">
                  Lost because
                  <select className="field mt-1" value={form.lostReason} onChange={(e) => set({ lostReason: e.target.value })} required>
                    <option value="">Pick one</option>
                    {LEAD_LOST_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </label>
                <label className="text-sm font-medium">
                  What they said
                  <input className="field mt-1" value={form.lostNotes} onChange={(e) => set({ lostNotes: e.target.value })} />
                  <span className="mt-1 block text-xs text-rce-soft">
                    Internal only — never shared with the customer.
                  </span>
                </label>
              </>
            )}
          </div>
        )}
      </section>

      {save.error && <p className="mb-3 text-sm text-red-600">{(save.error as Error).message}</p>}

      <div className="flex gap-2">
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : isEdit ? "Save Lead" : "Create Lead"}
        </button>
        <button className="btn btn-secondary" type="button" onClick={() => navigate("/leads")}>
          Cancel
        </button>
      </div>
    </form>
  );
}
