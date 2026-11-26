/**
 * The lead form — create and edit, one field set (moved out of LeadFormPage on 2026-09-20 so
 * the lead DRAWER can edit a lead in place: Kyle, "the drawer allows edits throughout as the
 * user finds and corrects or updates any information"). The page still renders it for
 * `/leads/new` and `/leads/:leadId/edit`; the drawer renders it `compact`.
 *
 * `Lead.smsConsent` is deliberately NOT a field here. Kyle 2026-11-26: texting needs no consent, and `false` now means one
 * thing only, that the person replied STOP (routes/inboundSms.ts writes it). Nothing in the CRM form writes it, and no screen shows it.
 */

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CustomerMatchPicker } from "./CustomerMatchPicker";
import { api } from "../lib/api";
import {
  LEAD_CALL_TYPES,
  LEAD_CONTACT_PREFERENCES,
  LEAD_FOLLOW_UP_REASONS,
  LEAD_LOST_REASONS,
  LEAD_PLATFORM_OPTIONS,
  LEAD_SOURCES,
  type Lead,
  type LeadWriteInput,
} from "../lib/types";
import { LEAD_PLATFORM_LABELS } from "../../../shared/leadPlatform";
import { chicagoToday, dayOf, parseReceivedAt, parseSourceUrl, receivedDay } from "../../../shared/calendarDay";
import { SEARCH_QUERY_KEYS } from "../lib/queryKeys";

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
  /** WHICH PLATFORM sent it. "" = untagged, which the funnel reads as "unknown". */
  platform: string;
  referredBy: string;
  /** The day it really reached Red Cedar, `YYYY-MM-DD`. Blank = "it came in when I typed it". */
  receivedAt: string;
  /** The marketplace's own link to the lead. */
  sourceUrl: string;
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
  notes: "", source: "manual", platform: "", referredBy: "", receivedAt: "", sourceUrl: "",
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
  platform: lead.platform ?? "",
  referredBy: lead.referredBy ?? "",
  // The calendar day it arrived (receivedDay): a typed day reads as stored, a real moment reads as
  // its Chicago day - never the UTC date part, which is the NEXT day for a lead that came in after
  // about 7 PM and would shift the date on any unrelated edit.
  receivedAt: lead.receivedAt ? receivedDay(lead.receivedAt) : "",
  sourceUrl: lead.sourceUrl ?? "",
  status: lead.status,
  // Status alone decides Open vs Lost, so a lead whose Status says lost shows the outcome as lost
  // too (the server writes the pair the same way — services/leadState.ts).
  leadStatus: lead.status === "lost" ? "lost" : (lead.leadStatus ?? "new"),
  // The day as stored (its UTC date part) — never the browser's local read (shared/calendarDay.ts).
  followUpDate: lead.followUpDate ? dayOf(lead.followUpDate) : "",
  followUpReason: lead.followUpReason ?? "",
  lostReason: lead.lostReason ?? "",
  lostNotes: lead.lostNotes ?? "",
});

/** Empty string means "not set", never "set to blank". */
const orNull = (value: string) => (value.trim() ? value.trim() : null);

/**
 * The received day is sent ONLY when the person changed it. A new lead with the box blank leaves it
 * out, so the server stamps "now" (a null would be read as 1970 by a naive coercion); an edit that
 * left the box alone leaves it out, so saving an unrelated field can never move the stored day.
 * Clearing a stored day sends "", which the server reads as "put it back on the day it was entered".
 */
function receivedAtPayload(form: FormState, seed: Lead | null | undefined): Pick<LeadWriteInput, "receivedAt"> {
  const typed = form.receivedAt.trim();
  if (!seed) return typed ? { receivedAt: typed } : {};
  const original = seed.receivedAt ? receivedDay(seed.receivedAt) : "";
  return typed === original ? {} : { receivedAt: typed };
}

function toPayload(
  form: FormState,
  link: { customerId: string | null; propertyId: string | null },
  seed?: Lead | null,
): LeadWriteInput {
  // An address chosen from an existing account lives on propertyId — writing the
  // structured fields too would leave a shadow copy that could drift from it.
  const usingExistingAddress = Boolean(link.propertyId);
  // State starts at "TN", so State ALONE is a blank address, not a one-part address (a lead
  // may save with part of an address — Kyle, 2026-11-15 "Allow part" — but a default is not part).
  const onlyStateFilled = !form.addressLine1.trim() && !form.city.trim() && !form.postalCode.trim();
  return {
    name: form.name.trim(),
    phone: orNull(form.phone),
    email: orNull(form.email),
    contactPreference: orNull(form.contactPreference) as LeadWriteInput["contactPreference"],
    bestTimeToReach: orNull(form.bestTimeToReach),
    addressLine1: usingExistingAddress ? null : orNull(form.addressLine1),
    addressLine2: usingExistingAddress ? null : orNull(form.addressLine2),
    city: usingExistingAddress ? null : orNull(form.city),
    state: usingExistingAddress || onlyStateFilled ? null : orNull(form.state)?.toUpperCase() ?? null,
    postalCode: usingExistingAddress ? null : orNull(form.postalCode),
    jobType: orNull(form.jobType),
    callType: orNull(form.callType),
    urgentFlag: form.urgentFlag,
    warrantyCall: form.warrantyCall,
    warrantyNote: form.warrantyCall ? orNull(form.warrantyNote) : null,
    notes: orNull(form.notes),
    source: form.source as LeadWriteInput["source"],
    platform: orNull(form.platform) as LeadWriteInput["platform"],
    referredBy: orNull(form.referredBy),
    ...receivedAtPayload(form, seed),
    sourceUrl: orNull(form.sourceUrl),
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

export function LeadForm({
  existing, onSaved, onCancel, compact = false,
}: {
  /** The lead being edited; absent for a new one. */
  existing?: Lead | null;
  onSaved: (lead: Lead) => void;
  onCancel: () => void;
  /** Narrower grids — the drawer is 520px wide. */
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const isEdit = Boolean(existing);

  const [form, setForm] = useState<FormState>(() => (existing ? fromLead(existing) : blank()));
  const [link, setLink] = useState<{ customerId: string | null; propertyId: string | null }>(() => ({
    customerId: existing?.customerId ?? null, propertyId: existing?.propertyId ?? null,
  }));
  const [showPipeline, setShowPipeline] = useState(() =>
    Boolean(existing && (existing.status !== "new" || existing.followUpDate || existing.lostReason)));

  // A refetch of the lead (another surface saved it) re-seeds the form.
  useEffect(() => {
    if (!existing) return;
    setForm(fromLead(existing));
    setLink({ customerId: existing.customerId ?? null, propertyId: existing.propertyId ?? null });
    if (existing.status !== "new" || existing.followUpDate || existing.lostReason) setShowPipeline(true);
  }, [existing]);

  const set = (patch: Partial<FormState>) => setForm((prev) => ({ ...prev, ...patch }));

  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const payload = toPayload(form, link, existing);
      if (existing) return api.updateLead(existing.id, payload);
      const { lead } = await api.createLead(payload);
      return lead;
    },
    onSuccess: (lead) => {
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      queryClient.invalidateQueries({ queryKey: ["crm-analytics"] });
      // The Search panel (Ctrl K) lists each lead's status and stays open under the drawer.
      for (const key of SEARCH_QUERY_KEYS) queryClient.invalidateQueries({ queryKey: [...key] });
      onSaved(lead);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    // No address check here: a lead saves with any part of an address (Kyle, 2026-11-15: "Allow
    // part"). Converting it is where the full street, city, state and ZIP are required, and the
    // server says which are missing.
    // The two optional boxes under "Where it came from" are checked here so the message sits at
    // the Save button; the server repeats both checks.
    const received = form.receivedAt.trim() ? parseReceivedAt(form.receivedAt.trim()) : null;
    if (received && !received.ok) { setFormError(received.error); return; }
    const marketplaceLink = parseSourceUrl(form.sourceUrl);
    if (!marketplaceLink.ok) { setFormError(marketplaceLink.error); return; }
    setFormError(null);
    save.mutate();
  }

  // Status alone decides Open vs Lost; the call outcome follows it (services/leadState.ts does the
  // same on the server). Moving Status off lost lets an outcome of "lost" go back to "new".
  function changeStatus(status: string) {
    set({
      status,
      leadStatus: status === "lost" ? "lost" : form.leadStatus === "lost" ? "new" : form.leadStatus,
    });
  }
  const statusLocked = form.status === "converted";
  const outcomeLocked = form.status === "lost";
  const OUTCOME_CHOICES = ["new", "booked", "unresolved", "planning", "no_answer"];
  const outcomeLabel = (value: string) =>
    value === "new" ? "no outcome yet"
      : value === "lost" ? "lost — follows Status"
        : value === "won" ? "won — set by Convert"
          : value.replaceAll("_", " ");

  const grid3 = compact ? "grid gap-3 sm:grid-cols-2" : "grid gap-3 md:grid-cols-3";
  const grid2 = compact ? "grid gap-3 sm:grid-cols-2" : "grid gap-3 md:grid-cols-2";
  const grid4 = compact ? "grid gap-3 sm:grid-cols-2" : "grid gap-3 md:grid-cols-4";
  const span2 = compact ? "" : "md:col-span-2";
  const span3 = compact ? "sm:col-span-2" : "md:col-span-3";

  return (
    <form onSubmit={submit} data-lead-form="">
      {/* ── Who ──────────────────────────────────────────────────────────── */}
      <section className="card mb-4 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-rce-soft">Who</h2>
        <div className={grid3}>
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
          <label className={`text-sm font-medium ${span2}`}>
            Best time to reach
            <input className="field mt-1" placeholder="mornings, after 3pm…" value={form.bestTimeToReach} onChange={(e) => set({ bestTimeToReach: e.target.value })} />
          </label>
        </div>

        <div className="mt-3">
          <CustomerMatchPicker
            phone={form.phone}
            email={form.email}
            name={form.name}
            // The lead form alone also warns about a same-name account and about leads already on
            // the Leads page (plan lead-intake-fixes F2). A lead being edited never lists itself.
            includeNameOnly
            includeLeads
            excludeLeadId={existing?.id ?? null}
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
            Optional. A partial address is fine — a city and ZIP is enough to save the lead. Converting it
            needs the full street address, city, state and ZIP.
          </p>
          <div className={grid4}>
            <label className={`text-sm font-medium ${span2}`}>
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
        </section>
      )}

      {/* ── What ─────────────────────────────────────────────────────────── */}
      <section className="card mb-4 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-rce-soft">What they need</h2>
        <div className={grid3}>
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
            <label className={`text-sm font-medium ${span3}`}>
              What's the warranty claim?
              <input className="field mt-1" value={form.warrantyNote} onChange={(e) => set({ warrantyNote: e.target.value })} />
            </label>
          )}
          <label className={`text-sm font-medium ${span3}`}>
            Notes
            <textarea className="field mt-1" rows={3} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
          </label>
        </div>
      </section>

      {/* ── Where it came from ───────────────────────────────────────────── */}
      <section className="card mb-4 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-rce-soft">Where it came from</h2>
        <div className={grid2}>
          <label className="text-sm font-medium">
            Source
            <select className="field mt-1" value={form.source} onChange={(e) => set({ source: e.target.value })}>
              {LEAD_SOURCES.map((s) => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}
            </select>
          </label>
          {/*
            PLATFORM, TAGGED AT INTAKE (Kyle, 2026-09-20). Separate from Source on purpose: source
            is HOW it arrived (phone, web, email), platform is WHO SENT IT — the thing the
            marketing spend goes to, and the only way phase 1 of the funnel can say whether
            Google, Yelp, Nextdoor or Angi is worth it. Left blank it reads "unknown", which is
            honest; guessing would be worse than not knowing.
          */}
          <label className="text-sm font-medium">
            Platform
            <select className="field mt-1" value={form.platform} onChange={(e) => set({ platform: e.target.value })}>
              <option value="">Not asked / unknown</option>
              {LEAD_PLATFORM_OPTIONS.map((p) => (
                <option key={p} value={p}>{LEAD_PLATFORM_LABELS[p]}</option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-rce-soft">Where they found us — not how they got in touch.</span>
          </label>
          <label className="text-sm font-medium">
            Referred by
            <input className="field mt-1" value={form.referredBy} onChange={(e) => set({ referredBy: e.target.value })} />
          </label>
          {/*
            ORIGINAL RECEIVED DATE + MARKETPLACE LINK (Kyle, 2026-11-15, plan lead-intake-fixes F3).
            A Yelp or Angi lead typed in a month late keeps the day it really arrived, so the funnel
            and the Dashboard count it in that month; the link is the marketplace's own page for it.
            Both are optional. A blank date means "it came in when I typed it".
          */}
          <label className="text-sm font-medium">
            Original received date
            <input
              className="field mt-1"
              type="date"
              max={chicagoToday()}
              value={form.receivedAt}
              onChange={(e) => set({ receivedAt: e.target.value })}
            />
            <span className="mt-1 block text-xs text-rce-soft">
              {isEdit
                ? "The day it came in on Yelp, Angi or the other marketplace. Clear it to put the lead back on the day it was entered."
                : "The day it came in on Yelp, Angi or the other marketplace. Leave blank if it came in today."}
            </span>
          </label>
          <label className="text-sm font-medium">
            Marketplace link
            <input
              className="field mt-1"
              type="url"
              placeholder="https://"
              value={form.sourceUrl}
              onChange={(e) => set({ sourceUrl: e.target.value })}
            />
            <span className="mt-1 block text-xs text-rce-soft">
              The link to this lead on the marketplace. Optional; opens from the lead's drawer.
            </span>
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
          <div className={`mt-3 ${grid2}`}>
            <label className="text-sm font-medium">
              Status
              <select className="field mt-1" value={form.status} disabled={statusLocked} onChange={(e) => changeStatus(e.target.value)}>
                <option value="new">new</option>
                <option value="contacted">contacted</option>
                <option value="lost">lost</option>
                {/* "converted" is never a choice — conversion is a transition that creates an
                    account, address and job, not a status you can type. A converted lead shows
                    it greyed, with the reason, so the select never reads as something else. */}
                {statusLocked && <option value="converted">converted</option>}
              </select>
              <span className="mt-1 block text-xs text-rce-soft">
                {statusLocked
                  ? "Converted — set by the Convert button, not editable here."
                  : "Status decides whether the lead is Open or Lost."}
              </span>
            </label>
            <label className="text-sm font-medium">
              Call outcome
              <select
                className="field mt-1"
                value={form.leadStatus}
                disabled={outcomeLocked || statusLocked}
                onChange={(e) => set({ leadStatus: e.target.value })}
              >
                {[...OUTCOME_CHOICES, ...(OUTCOME_CHOICES.includes(form.leadStatus) ? [] : [form.leadStatus])].map((s) => (
                  <option key={s} value={s}>{outcomeLabel(s)}</option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-rce-soft">
                {outcomeLocked
                  ? "Lost — set by Status. Pick Status new or contacted to reopen the lead."
                  : statusLocked
                    ? "The lead is converted, so its outcome is set by Convert."
                    : "How the last call went — booked, unresolved, planning or no answer."}
              </span>
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

      {formError && <p className="mb-3 text-sm text-red-600">{formError}</p>}
      {save.error && <p className="mb-3 text-sm text-red-600">{(save.error as Error).message}</p>}

      <div className="flex gap-2">
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : isEdit ? "Save Lead" : "Create Lead"}
        </button>
        <button className="btn btn-secondary" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
