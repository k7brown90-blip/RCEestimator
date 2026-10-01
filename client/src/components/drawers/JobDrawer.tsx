/**
 * The job drawer (2026-09-20): the working job furniture from the visit workspace —
 * `ScheduleOnCalendar` (what is booked, and the door to the Calendar to schedule / reschedule /
 * cancel it — the picker itself lives ONLY on the Calendar page since 2026-10-01, plan item E3),
 * `PaymentPanel` (deposit, balance, record a payment, the warranty split), `JobCloseoutPanel`
 * (P.O.s, receipts, materials, mark complete) — plus the visit's own details, editable, and its
 * way out (delete, while nothing is signed).
 * Since 2026-09-29 it also raises a CHANGE ORDER against the job's invoice: this is the screen
 * the office is on when a technician rings to say the job grew.
 *
 * What stays on the WORKSPACE (/visits/:id, linked from the header): photos, the finding ledger,
 * the job clock, materials used, the contractor review of an assessment, the load-calc editor, the
 * generator designer, and "Quote this work" (the builder). Those are company-internal operations,
 * not things that reach the customer. The one part of the health record that IS client-facing —
 * emailing the homeowner their assessment — is here, as `SendAssessmentReport`; a send it has to
 * refuse links back to the workspace for the review rather than duplicating it.
 *
 * Kyle's ruling, 2026-09-29 ("the operations are different as they do not have actions that
 * directly involve clients ... an admin can complete these tasks on their assigned page") is why
 * that split is the RIGHT one rather than unfinished work: the job clock, materials used and the
 * finding ledger are company-internal operations and belong on the page. What moves here is what
 * reaches the customer — the money, the invoice, and agreeing new work.
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
import { OpenDrawerButton } from "./OpenDrawerButton";
import { PaymentPanel } from "../PaymentPanel";
import { RaiseChangeOrderButton } from "../RaiseChangeOrderButton";
import { ScheduleOnCalendar } from "../ScheduleOnCalendar";
import { SendAssessmentReport } from "../SendAssessmentReport";
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
  // The SIGNED invoice that owns this job (root, not the legacy record above) — same
  // ["paymentInfo", visitId] cache PaymentPanel already fills below, so this costs no second
  // fetch. PUNCHLIST K7: the estimate drawer already opens the job (its "Job" button); nothing
  // opened the estimate from here.
  // A variable key, like PaymentPanel's own ["paymentInfo", jobId ?? estimateId] — both read the
  // SAME PaymentInfo shape off either id (tests/queryKeyCollisions.test.ts only flags a shape
  // mismatch under one literal key; jobPaymentInfo/estimatePaymentInfo share a return type).
  const paymentInfoKey = ["paymentInfo", visitId];
  const { data: paymentInfo } = useQuery({
    queryKey: paymentInfoKey,
    queryFn: () => api.jobPaymentInfo(visitId),
    enabled: Boolean(visitId),
  });

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
          {/*
            "Workspace", not "Full page" (2026-09-29). Kyle's ruling: "the operations are different
            as they do not have actions that directly involve clients ... an admin can complete
            these tasks on their assigned page." So /visits/:id is not a fuller version of this
            drawer that the drawer is a cut-down copy of — it is the INTERNAL side of the job, and
            this drawer is the customer-facing side. "Full page" said the drawer was the lesser
            surface, which is the inversion the ruling corrects.
          */}
          <Link to={`/visits/${visitId}`} className="btn btn-secondary px-2 py-1 text-xs min-h-0" title="The internal side of this job: photos, health record, findings, the job clock, materials used and the quote builder">
            Workspace →
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
            {paymentInfo?.estimateId && (
              <OpenDrawerButton kind="estimate" id={paymentInfo.estimateId} onOpen={drawers.open} label="Estimate" />
            )}
            {/*
              THE JOB NAMES ITS INVOICE, AND OPENS IT (2026-09-29, findability audit B5).

              The job drawer carried the MONEY (the payment panel below) but no invoice IDENTITY
              and no door to the invoice record — so from the screen Kyle is on when a tech calls,
              there was no route to the PDFs, the reminder, the signed copy or the delivery state.
              `paymentInfo.estimateId` is the ROOT (signedRootForJob), which is exactly the id the
              invoice drawer lists, so this door never lands on the change-order dead end that
              EstimateDrawer's did before today.
            */}
            {paymentInfo?.estimateId && (
              <OpenDrawerButton
                kind="invoice"
                id={paymentInfo.estimateId}
                onOpen={drawers.open}
                label={`Invoice ${paymentInfo.number}`}
              />
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

          {/*
            ONE SCHEDULER (2026-10-01, plan item E3). This drawer used to host its own
            `JobScheduler` in idle mode — a "Book Estimate Visit" button that opened a second
            month grid inside the drawer — while the Calendar opened straight into its picker.
            Kyle: "the date picker would only come up in one scheduling page and not the other."
            Now the drawer shows what is booked and ONE door to the Calendar with this job selected.
          */}
          <ScheduleOnCalendar
            visitId={visitId}
            status={status}
            scheduledStart={visit.scheduledStart}
            scheduledEnd={visit.scheduledEnd}
            durationDays={visit.estimatedDurationDays}
            completedAt={visit.completedAt}
            onChanged={refreshVisit}
          />
          {/* Renders itself only when a signed estimate exists (reactive flow, Kyle 2026-08-25). */}
          <PaymentPanel jobId={visitId} />

          {/*
            THE JOB GREW (2026-09-29).

            This is the screen Kyle is on when a technician rings to say there is more work than
            the quote covered, and until now it had no way to record that — the only CRM button
            lived in the estimate builder's Review tab, reachable only with the original draft's
            URL. `paymentInfo.estimateId` is the ROOT invoice (signedRootForJob returns live
            signed rows only), so the new work joins this job's existing invoice: one balance,
            one payment. Greyed with the reason when the job has nothing signed on it yet.
          */}
          <div className="flex flex-wrap items-center gap-2">
            <RaiseChangeOrderButton
              target={{
                estimateId: paymentInfo?.estimateId ?? null,
                status: paymentInfo ? "signed" : null,
                signed: Boolean(paymentInfo),
              }}
            />
          </div>

          {/*
            The customer's copy of their assessment (2026-09-29). Client-facing, so it belongs on
            the record under Kyle's ruling — the only button for it was three levels down
            /visits/:id, inside HealthRecordPanel, inside an inspection row you had to expand.
            Renders itself away when the job has no assessment. The REVIEW and the report
            generation stay on the workspace: those are internal work, and a refused send here
            links to them rather than duplicating them.
          */}
          <SendAssessmentReport visitId={visitId} />
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
