/**
 * The lead drawer (2026-09-20). Everything a lead card on the Leads page can do — Mark
 * Contacted, Schedule (converting first when it must), Convert only (with the duplicate-account
 * question), Mark Lost with a reason, the email campaign, Delete — plus the edit form in place
 * (Kyle: "the drawer allows edits throughout as the user finds and corrects or updates any
 * information"), and its job's drawer once it has one.
 *
 * `smsConsent` is shown as three words and never as a control (PUNCHLIST E1): `null` is "never
 * asked", the state the A2P registration attests to, and only `true` opens the SMS gate.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { useDrawerParams } from "../../lib/drawers";
import { ADDRESS_QUERY_KEYS } from "../../lib/queryKeys";
import { useLead } from "../../lib/recordQueries";
import { LEAD_LOST_REASONS, type CustomerMatch, type JobStatus, type Lead, type LeadLinkedVisit } from "../../lib/types";
import { shortDate } from "../../lib/utils";
import { platformLabel } from "../../../../shared/leadPlatform";
import { Drawer } from "../Drawer";
import { JobScheduler } from "../JobScheduler";
import { LeadDuplicatePicker, type ConvertInput } from "../LeadDuplicatePicker";
import { LeadForm } from "../LeadForm";
import { SendEmailPanel } from "../SendEmailPanel";
import { OpenDrawerButton } from "./OpenDrawerButton";

const STATUS_TONE: Record<string, string> = {
  new: "bg-rce-accentBg text-rce-warning",
  contacted: "bg-blue-100 text-blue-700",
  converted: "bg-green-100 text-rce-success",
  lost: "bg-zinc-200 text-zinc-700",
};

/** The address to show, from whichever track has one (structured fields, or the webhook's line). */
function displayAddress(lead: Lead): string | null {
  if (lead.addressLine1) {
    return [lead.addressLine1, lead.addressLine2, lead.city, [lead.state, lead.postalCode].filter(Boolean).join(" ")]
      .filter(Boolean)
      .join(", ");
  }
  return lead.address ?? null;
}

function consentLabel(value: boolean | null | undefined): string {
  if (value === true) return "yes — ticked on the website form";
  if (value === false) return "declined — shown the box, left it unticked";
  return "never asked";
}

export function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const drawers = useDrawerParams();
  const { data: lead, isLoading, error } = useLead(id);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["leads"] });
    void queryClient.invalidateQueries({ queryKey: ["crm-analytics"] });
    void queryClient.invalidateQueries({ queryKey: ["calendar"] });
    for (const key of ADDRESS_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [...key] });
  };

  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<CustomerMatch[] | null>(null);
  /** A visit to schedule right here, after a convert (or a lead that already has one). */
  const [scheduling, setScheduling] = useState<LeadLinkedVisit | null>(null);
  const [losing, setLosing] = useState(false);
  const [lostReason, setLostReason] = useState("");
  const [lostNotes, setLostNotes] = useState("");

  /**
   * 409 = "this might already be a customer" — a question, so open the picker. 400 with
   * `needs: "address"` = cannot convert yet — say so instead of doing nothing.
   */
  const handleConvertError = (err: unknown) => {
    const body = (err as { body?: { matches?: CustomerMatch[]; needs?: string; message?: string } })?.body;
    if (body?.matches?.length) { setDuplicate(body.matches); return; }
    if (body?.needs === "address") {
      setNotice(body.message ?? "This lead has no usable address, so it can't be converted yet. Add a complete street address, city, state, and ZIP, then convert again.");
      return;
    }
    setNotice((err as Error).message);
  };

  const [convertIntent, setConvertIntent] = useState<"convert" | "schedule">("convert");
  const convert = useMutation({
    mutationFn: (input?: ConvertInput) => api.convertLead(id, input),
    onSuccess: (result) => {
      invalidate();
      setDuplicate(null);
      setNotice(null);
      if (result.visit && convertIntent === "schedule") {
        setScheduling({
          id: result.visit.id,
          status: (result.visit.status as JobStatus | null) ?? "estimate",
          scheduledStart: null,
          scheduledEnd: null,
          estimatedDurationDays: result.visit.estimatedDurationDays ?? null,
          jobType: result.visit.jobType ?? null,
          purpose: result.visit.purpose ?? null,
        });
      } else if (result.visit) {
        setNotice("Converted — account, address and job created.");
      }
    },
    onError: handleConvertError,
  });
  const contact = useMutation({
    mutationFn: () => api.updateLead(id, { status: "contacted" }),
    onSuccess: invalidate,
    onError: (err) => setNotice((err as Error).message),
  });
  const lost = useMutation({
    mutationFn: () => api.updateLead(id, { status: "lost", leadStatus: "lost", lostReason: lostReason as never, lostNotes: lostNotes.trim() || null }),
    onSuccess: () => { invalidate(); setLosing(false); setLostReason(""); setLostNotes(""); },
    onError: (err) => setNotice((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteLead(id),
    onSuccess: () => { invalidate(); onClose(); },
    onError: (err) => setNotice((err as Error).message),
  });
  const { data: membership } = useQuery({ queryKey: ["campaignLeadMembership"], queryFn: api.campaignLeadMembership });
  const onCampaign = Boolean(membership?.leadIds.includes(id));
  const addToCampaign = useMutation({
    mutationFn: () => api.addLeadToCampaign(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["campaignLeadMembership"] }),
    onError: (err) => setNotice((err as Error).message),
  });
  // The standing rule's exit for the button above (CLAUDE.md: whatever can be added must be
  // removable from the same surface) — same drawer, opposite action.
  const removeFromCampaign = useMutation({
    mutationFn: () => api.removeLeadFromCampaign(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["campaignLeadMembership"] }),
    onError: (err) => setNotice((err as Error).message),
  });

  const startSchedule = () => {
    if (!lead) return;
    if (lead.linkedVisit) { setScheduling(lead.linkedVisit); return; }
    if (window.confirm(`Booking an appointment for ${lead.name} will first convert this lead into an account, property, and job. Continue?`)) {
      setConvertIntent("schedule");
      convert.mutate(undefined);
    }
  };

  const visit = lead?.linkedVisit ?? null;
  const closed = lead?.status === "lost" || visit?.status === "completed" || visit?.status === "cancelled";
  const address = lead ? displayAddress(lead) : null;

  /*
    Platform beside source, because they are different facts (Kyle, 2026-09-20): source is HOW it
    arrived, platform is WHO SENT IT. An untagged lead reads "unknown" here rather than showing
    nothing, so it is obvious there is something to set in the edit form.
  */
  const subtitle = lead
    ? `${lead.source.replaceAll("_", " ")} · ${platformLabel(lead.platform).toLowerCase()} · received ${shortDate(lead.createdAt)}`
    : undefined;

  return (
    <Drawer
      title={lead?.name ?? "Lead"}
      subtitle={subtitle}
      onClose={onClose}
      wide={editing}
      headerActions={lead ? (
        <>
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${STATUS_TONE[lead.status] ?? ""}`}>{lead.status}</span>
          <Link to={`/leads/${lead.id}/edit`} className="btn btn-secondary px-2 py-1 text-xs min-h-0">Full page →</Link>
        </>
      ) : null}
    >
      {error && <p className="text-sm text-red-600">Could not load this lead: {(error as Error).message}</p>}
      {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}
      {lead && !editing && (
        <div className="space-y-3 pb-4 text-sm">
          <div className="space-y-1 text-rce-muted">
            {(lead.email || lead.phone) && <p>{[lead.email, lead.phone].filter(Boolean).join(" · ")}</p>}
            {address && <p><span className="text-rce-soft">Address:</span> {address}</p>}
            {lead.jobType && <p><span className="text-rce-soft">Job type:</span> {lead.jobType}</p>}
            {lead.callType && <p><span className="text-rce-soft">Call type:</span> {lead.callType.replaceAll("_", " ")}</p>}
            {lead.followUpDate && <p><span className="text-rce-soft">Follow up:</span> {shortDate(lead.followUpDate)}{lead.followUpReason ? ` — ${lead.followUpReason.replaceAll("_", " ")}` : ""}</p>}
            {lead.notes && <p className="whitespace-pre-wrap">{lead.notes}</p>}
            {lead.status === "lost" && lead.lostReason && (
              <p>Lost — {lead.lostReason}{lead.lostNotes ? `: "${lead.lostNotes}"` : ""}</p>
            )}
            <p className="text-xs" data-sms-consent={lead.smsConsent === true ? "true" : lead.smsConsent === false ? "false" : "null"}>
              <span className="text-rce-soft">SMS consent:</span> {consentLabel(lead.smsConsent)}
              <span className="text-rce-soft"> · read-only; the website form is the only opt-in channel</span>
            </p>
            {lead.customerId && <p className="text-xs text-rce-accent">Linked to an existing account</p>}
          </div>

          {visit && (
            <p className="text-xs">
              {visit.scheduledStart
                ? <span className="rounded bg-rce-accentBg px-2 py-1 font-medium text-rce-warning">Scheduled {new Date(visit.scheduledStart).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                : visit.status === "completed" ? <span className="rounded bg-green-100 px-2 py-1 font-medium text-rce-success">Job completed</span>
                : visit.status === "cancelled" ? <span className="rounded bg-red-100 px-2 py-1 font-medium text-red-700">Job cancelled</span>
                : <span className="rounded bg-amber-100 px-2 py-1 font-medium text-amber-800">Converted — needs scheduling</span>}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary text-xs" onClick={() => setEditing(true)}>Edit</button>
            {lead.status === "new" && (
              <button type="button" className="btn btn-secondary text-xs" disabled={contact.isPending} onClick={() => contact.mutate()}>Mark Contacted</button>
            )}
            {visit && <OpenDrawerButton kind="job" id={visit.id} onOpen={drawers.open} label="Go to Job" className="btn btn-secondary text-xs" />}
            {!closed && (
              <button type="button" className="btn btn-primary text-xs" disabled={convert.isPending} onClick={startSchedule}>
                {visit?.scheduledStart ? "Reschedule" : "Schedule"}
              </button>
            )}
            {!closed && !visit && lead.status !== "converted" && (
              <button
                type="button"
                className="btn btn-secondary text-xs"
                disabled={convert.isPending}
                onClick={() => { if (window.confirm("Convert this lead into an account, property, and job?")) { setConvertIntent("convert"); convert.mutate(undefined); } }}
              >
                Convert only
              </button>
            )}
            {lead.status !== "lost" && (
              <button type="button" className="btn btn-secondary text-xs" onClick={() => { setLosing((s) => !s); setLostReason(""); setLostNotes(""); }}>Mark Lost</button>
            )}
            {lead.email && (onCampaign ? (
              <button
                type="button"
                className="rounded-lg border border-green-300 bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700"
                disabled={removeFromCampaign.isPending}
                onClick={() => removeFromCampaign.mutate()}
                title="Remove from the email campaign list"
              >
                ✓ On email campaign — remove
              </button>
            ) : (
              <button type="button" className="btn btn-secondary text-xs" disabled={addToCampaign.isPending} onClick={() => addToCampaign.mutate()}>+ Email campaign</button>
            ))}
            {/* A converted lead can't be deleted — the server 409s. */}
            {lead.status !== "converted" && (
              <button
                type="button"
                className="btn btn-danger text-xs"
                disabled={remove.isPending}
                onClick={() => { if (window.confirm(`Delete lead "${lead.name}"? This cannot be undone.`)) remove.mutate(); }}
              >
                Delete
              </button>
            )}
          </div>

          {losing && (
            <form
              className="space-y-2 rounded-lg border border-rce-border p-3"
              onSubmit={(event) => { event.preventDefault(); lost.mutate(); }}
            >
              <p className="text-xs text-rce-muted">Why it didn't close — this is what the loss report reads.</p>
              <label className="block text-xs font-medium">
                Reason
                <select className="field mt-1" value={lostReason} onChange={(e) => setLostReason(e.target.value)} required>
                  <option value="">Pick one</option>
                  {LEAD_LOST_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label className="block text-xs font-medium">
                What they said <span className="text-rce-soft">(optional, internal only)</span>
                <textarea className="field mt-1" rows={2} value={lostNotes} onChange={(e) => setLostNotes(e.target.value)} />
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn btn-secondary text-xs" onClick={() => setLosing(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary text-xs" disabled={lost.isPending || !lostReason}>{lost.isPending ? "Saving…" : "Save as lost"}</button>
              </div>
            </form>
          )}

          {scheduling && (
            <div className="rounded-lg border border-rce-border p-3">
              <JobScheduler
                autoOpen
                jobId={scheduling.id}
                status={scheduling.status}
                scheduledStart={scheduling.scheduledStart}
                scheduledEnd={scheduling.scheduledEnd}
                durationDays={scheduling.estimatedDurationDays}
                onScheduled={() => { setScheduling(null); invalidate(); }}
              />
              <button type="button" className="btn btn-secondary mt-2 px-2 py-0.5 text-xs min-h-0" onClick={() => setScheduling(null)}>Close scheduler</button>
            </div>
          )}

          {notice && <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">{notice}</p>}

          {lead.email && (
            <SendEmailPanel target="lead" id={id} primaryEmail={lead.email} accountIdForContacts={lead.customerId ?? undefined} />
          )}
        </div>
      )}

      {lead && editing && (
        <div className="pb-4">
          <LeadForm existing={lead} compact onSaved={() => { setEditing(false); setNotice("Saved."); }} onCancel={() => setEditing(false)} />
        </div>
      )}

      {lead && duplicate && (
        <LeadDuplicatePicker
          lead={lead}
          matches={duplicate}
          busy={convert.isPending}
          error={convert.error ? (convert.error as Error).message : null}
          onPick={(input) => convert.mutate(input)}
          onClose={() => setDuplicate(null)}
        />
      )}
    </Drawer>
  );
}
