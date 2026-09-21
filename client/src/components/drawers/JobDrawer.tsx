/**
 * The job drawer (2026-09-20): the working job furniture from the visit workspace —
 * `JobScheduler` (schedule / reschedule / cancel), `PaymentPanel` (deposit, balance, record a
 * payment, the warranty split), `JobCloseoutPanel` (P.O.s, receipts, materials, mark complete)
 * — plus the visit's own details, editable, and its way out (delete, while nothing is signed).
 *
 * What stays on the full page and is linked to from the header: photos, the health record,
 * the finding ledger, the job clock, and "Quote this work" (the builder). Those are the
 * screen's own workshop, not the record's actions.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { useDrawerParams } from "../../lib/drawers";
import { useVisit } from "../../lib/recordQueries";
import { shortDate } from "../../lib/utils";
import { Drawer } from "../Drawer";
import { JobCloseoutPanel } from "../JobCloseoutPanel";
import { JobScheduler } from "../JobScheduler";
import { PaymentPanel } from "../PaymentPanel";
import { SendEmailPanel } from "../SendEmailPanel";
import { StatusBadge } from "../StatusBadge";

const CLOSEOUT_STATUSES = ["contracted", "scheduled", "in_progress", "completed"];

export function JobDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const visitId = id;
  const queryClient = useQueryClient();
  const drawers = useDrawerParams();
  const { data: visit, isLoading, error } = useVisit(visitId);
  // The legacy estimate record, if the visit still carries one — same read as the page, so the
  // Edit / Delete guard below is the page's guard.
  const estimateId = visit?.estimates?.[0]?.id;
  const { data: estimate } = useQuery({
    queryKey: ["estimate", estimateId],
    queryFn: () => api.estimate(String(estimateId)),
    enabled: Boolean(estimateId),
  });
  const hasAcceptedEstimate = estimate?.status === "accepted";

  const refreshVisit = () => {
    void queryClient.invalidateQueries({ queryKey: ["visit", visitId] });
    if (estimateId) void queryClient.invalidateQueries({ queryKey: ["estimate", estimateId] });
    void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    void queryClient.invalidateQueries({ queryKey: ["calendar"] });
    void queryClient.invalidateQueries({ queryKey: ["account-summary"] });
  };

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ mode: "", purpose: "", jobType: "", notes: "" });
  const [error2, setError2] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: () => api.updateVisit(visitId, form),
    onSuccess: () => { setEditing(false); setError2(null); refreshVisit(); },
    onError: (err) => setError2((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteVisit(visitId),
    onSuccess: () => { refreshVisit(); onClose(); },
    onError: (err) => setError2((err as Error).message),
  });
  const startEdit = () => {
    if (!visit) return;
    setForm({ mode: visit.mode ?? "", purpose: visit.purpose ?? "", jobType: visit.jobType ?? "", notes: visit.notes ?? "" });
    setEditing(true);
  };

  const status = visit?.status ?? "estimate";

  return (
    <Drawer
      title={visit?.property?.addressLine1 ?? "Job"}
      subtitle={visit ? `${shortDate(visit.visitDate)} · ${visit.mode.replaceAll("_", " ")} · ${visit.customer?.name ?? ""}` : undefined}
      onClose={onClose}
      wide
      headerActions={
        <>
          {estimate?.status ? <StatusBadge status={estimate.status} /> : null}
          <Link to={`/visits/${visitId}`} className="btn btn-secondary px-2 py-1 text-xs min-h-0" title="Photos, health record, findings, the job clock, and the quote builder">
            Full page →
          </Link>
        </>
      }
    >
      {error && <p className="text-sm text-red-600">Could not load this job: {(error as Error).message}</p>}
      {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}
      {visit && (
        <div className="space-y-4 pb-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-rce-bg px-2 py-0.5 font-semibold uppercase">{status.replaceAll("_", " ")}</span>
            {visit.jobType && <span className="text-rce-muted">{visit.jobType}</span>}
            {visit.purpose && <span className="text-rce-muted">· {visit.purpose}</span>}
            {visit.customerId && (
              <Link to={`/accounts/${visit.customerId}`} className="btn btn-secondary px-2 py-0.5 text-xs min-h-0">
                {visit.customer?.name ?? "Account"} →
              </Link>
            )}
            {!hasAcceptedEstimate && !editing && (
              <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={startEdit}>Edit details</button>
            )}
            {!hasAcceptedEstimate && (
              <button
                type="button"
                className="btn btn-danger px-2 py-0.5 text-xs min-h-0"
                disabled={remove.isPending}
                onClick={() => { if (window.confirm("Delete this visit and all its data? This cannot be undone.")) remove.mutate(); }}
              >
                Delete
              </button>
            )}
          </div>
          {visit.notes && !editing && <p className="text-sm text-rce-muted">{visit.notes}</p>}

          {editing && (
            <form className="card space-y-3 p-3" onSubmit={(e) => { e.preventDefault(); update.mutate(); }}>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-medium text-rce-soft">
                  Mode
                  <select className="field mt-1" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                    <option value="inspection">Inspection</option>
                    <option value="troubleshooting">Troubleshooting</option>
                    <option value="service_call">Service Call</option>
                    <option value="follow_up">Follow Up</option>
                  </select>
                </label>
                <label className="text-xs font-medium text-rce-soft">
                  Job type
                  <input className="field mt-1" value={form.jobType} onChange={(e) => setForm({ ...form, jobType: e.target.value })} />
                </label>
              </div>
              <label className="block text-xs font-medium text-rce-soft">
                Purpose
                <input className="field mt-1" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} />
              </label>
              <label className="block text-xs font-medium text-rce-soft">
                Notes
                <textarea className="field mt-1" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn btn-secondary text-xs" onClick={() => setEditing(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary text-xs" disabled={update.isPending}>Save</button>
              </div>
            </form>
          )}
          {error2 && <p className="text-xs text-red-600">{error2}</p>}

          <SendEmailPanel target="job" id={visitId} primaryEmail={visit.customer?.email ?? null} accountIdForContacts={visit.customerId} />

          <JobScheduler
            jobId={visitId}
            status={status}
            scheduledStart={visit.scheduledStart}
            scheduledEnd={visit.scheduledEnd}
            durationDays={visit.estimatedDurationDays}
            completedAt={visit.completedAt}
            onScheduled={refreshVisit}
          />
          {/* Renders itself only when a signed estimate exists (reactive flow, Kyle 2026-08-25). */}
          <PaymentPanel jobId={visitId} />
          {/* Close-out is JOB furniture — it appears once the visit is contracted work (Kyle, 2026-08-25). */}
          {CLOSEOUT_STATUSES.includes(status) && <JobCloseoutPanel visitId={visitId} status={status} />}

          {estimateId && (
            <p className="text-xs text-rce-muted">
              This visit still carries a legacy estimate (record only) — it is shown on the{" "}
              <button type="button" className="underline" onClick={() => drawers.close("job")}>full page</button>.
            </p>
          )}
        </div>
      )}
    </Drawer>
  );
}
