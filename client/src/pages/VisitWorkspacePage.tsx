import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { api } from "../lib/api";
import { money, shortDate } from "../lib/utils";
import { JobScheduler } from "../components/JobScheduler";
import { HealthRecordPanel } from "../components/HealthRecordPanel";
import { JobCloseoutPanel } from "../components/JobCloseoutPanel";
import { PaymentPanel } from "../components/PaymentPanel";
import { FindingLedgerPanel } from "../components/FindingLedgerPanel";
import { PhotoGalleryPanel } from "../components/PhotoGalleryPanel";

/**
 * The visit workspace, after the 2026-08-28 cleanout.
 *
 * Kyle: "This is an old section in the CRM I want it replaced with a photo
 * gallery where photos taken on the job can be added."
 *
 * The Estimate/Proposal/AI Estimate tab strip and everything that lived under
 * it — the legacy option/assembly builder, the proposal preview and send, the
 * permit/inspection forms, the workflow modals — are GONE. All of that fed the
 * retired estimate system; every estimate Kyle actually writes is a price-book
 * one, and the price book has its own send-and-sign flow (P027/P028).
 *
 * What remains is the working job furniture (scheduler, payment, close-out,
 * health record, finding ledger), the "Quote this work" door into the price
 * book, and the photo gallery that replaced the tabs. A visit that still
 * carries a legacy estimate shows a read-only record card — the data stays;
 * only the dead controls went.
 */
export function VisitWorkspacePage() {
  const { visitId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editingVisit, setEditingVisit] = useState(false);
  const [visitEditForm, setVisitEditForm] = useState({ mode: "", purpose: "", jobType: "", notes: "" });

  const { data: visit, isLoading } = useQuery({
    queryKey: ["visit", visitId],
    queryFn: () => api.visit(visitId),
    enabled: Boolean(visitId),
  });
  const estimateId = visit?.estimates?.[0]?.id;
  const { data: estimate } = useQuery({
    queryKey: ["estimate", estimateId],
    queryFn: () => api.estimate(String(estimateId)),
    enabled: Boolean(estimateId),
  });

  const refreshVisit = () => {
    void queryClient.invalidateQueries({ queryKey: ["visit", visitId] });
    if (estimateId) {
      void queryClient.invalidateQueries({ queryKey: ["estimate", estimateId] });
    }
    void queryClient.invalidateQueries({ queryKey: ["jobs"] });
  };

  const updateVisitMutation = useMutation({
    mutationFn: () => api.updateVisit(visitId, visitEditForm),
    onSuccess: () => { setEditingVisit(false); refreshVisit(); },
  });
  const deleteVisitMutation = useMutation({
    mutationFn: () => api.deleteVisit(visitId),
    onSuccess: () => navigate("/"),
  });

  if (isLoading || !visit) {
    return <p className="text-sm text-rce-muted">Loading visit...</p>;
  }

  const hasAcceptedEstimate = estimate?.status === "accepted";
  const status = estimate?.status;

  function startEditVisit() {
    if (!visit) return;
    setVisitEditForm({
      mode: visit.mode ?? "",
      purpose: visit.purpose ?? "",
      jobType: visit.jobType ?? "",
      notes: visit.notes ?? "",
    });
    setEditingVisit(true);
  }

  return (
    <div className="relative">
      <PageHeader
        title={visit.property?.addressLine1 ?? "Visit"}
        subtitle={`${shortDate(visit.visitDate)} | ${visit.mode.replaceAll("_", " ")} | ${visit.customer?.name ?? ""}`}
        actions={
          <div className="flex items-center gap-2">
            {status ? <StatusBadge status={status} /> : null}
            {!hasAcceptedEstimate && (
              <>
                <button type="button" className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100" onClick={startEditVisit}>Edit</button>
                <button type="button" className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100" disabled={deleteVisitMutation.isPending} onClick={() => { if (window.confirm("Delete this visit and all its data? This cannot be undone.")) deleteVisitMutation.mutate(); }}>Delete</button>
              </>
            )}
          </div>
        }
      />

      {editingVisit && (
        <form className="card mb-4 space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); updateVisitMutation.mutate(); }}>
          <h3 className="text-sm font-semibold">Edit Visit</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-rce-soft">Mode</label>
              <select className="field" value={visitEditForm.mode} onChange={(e) => setVisitEditForm({ ...visitEditForm, mode: e.target.value })}>
                <option value="inspection">Inspection</option>
                <option value="troubleshooting">Troubleshooting</option>
                <option value="service_call">Service Call</option>
                <option value="follow_up">Follow Up</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-rce-soft">Job Type</label>
              <input className="field" value={visitEditForm.jobType} onChange={(e) => setVisitEditForm({ ...visitEditForm, jobType: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-rce-soft">Purpose</label>
            <input className="field" value={visitEditForm.purpose} onChange={(e) => setVisitEditForm({ ...visitEditForm, purpose: e.target.value })} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-rce-soft">Notes</label>
            <textarea className="field" rows={2} value={visitEditForm.notes} onChange={(e) => setVisitEditForm({ ...visitEditForm, notes: e.target.value })} />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600" onClick={() => setEditingVisit(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary text-xs" disabled={updateVisitMutation.isPending}>Save</button>
          </div>
        </form>
      )}

      <section className="space-y-5 pb-10">
        <JobScheduler
          jobId={visitId}
          status={visit.status ?? "estimate"}
          scheduledStart={visit.scheduledStart}
          scheduledEnd={visit.scheduledEnd}
          durationDays={visit.estimatedDurationDays}
          completedAt={visit.completedAt}
          onScheduled={refreshVisit}
        />
        {/* Money renders itself only when a signed estimate exists — the
            panel returns null otherwise, so an unquoted visit shows nothing
            (reactive flow, Kyle 2026-08-25). */}
        <PaymentPanel jobId={visitId} />
        {/* Close-out is JOB furniture. An estimate-stage visit has no job to
            close, no POs to raise, no receipts to file — showing the panel
            there was "buttons placed with no reference" (Kyle, 2026-08-25).
            It appears once the visit is contracted work. */}
        {["contracted", "scheduled", "in_progress", "completed"].includes(visit.status ?? "") && (
          <JobCloseoutPanel visitId={visitId} status={visit.status ?? "estimate"} />
        )}

        {/* ── The photo gallery that replaced the legacy tabs (2026-08-28) ── */}
        <PhotoGalleryPanel visitId={visitId} propertyId={visit.propertyId} />

        <HealthRecordPanel visitId={visitId} />
        <FindingLedgerPanel propertyId={visit.propertyId} />

        <article className="card rounded-2xl border border-rce-border/70 p-5">
          <h2 className="text-lg font-semibold">Quote this work</h2>
          <p className="mt-1 text-sm text-rce-muted">
            Estimates are built in the price book, tied to this account and address.
          </p>
          <button
            className="btn btn-primary mt-3"
            type="button"
            onClick={() =>
              navigate(`/estimate-intake?account=${visit.customerId}&address=${visit.propertyId}`)
            }
          >
            Open the estimate builder
          </button>
        </article>

        {/* A visit that still carries a legacy estimate keeps its record
            visible — read-only. The builder that made it is retired. */}
        {estimate && (
          <article className="card rounded-2xl border border-rce-border/70 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">{estimate.title} <span className="text-sm font-normal text-rce-soft">(legacy estimate — record only)</span></h2>
              <StatusBadge status={estimate.status} />
            </div>
            <p className="mt-1 text-sm text-rce-muted">Revision {estimate.revision}</p>
            {estimate.options.length > 0 && (
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {estimate.options.map((option) => (
                  <div key={option.id} className="rounded-lg border border-rce-border p-3">
                    <p className="font-semibold">{option.optionLabel}{option.accepted ? " · accepted" : ""}</p>
                    <p className="text-sm text-rce-muted">Labor {money(option.subtotalLabor)} | Material {money(option.subtotalMaterial)}</p>
                    <p className="mt-1 font-semibold">Total {money(option.totalCost)}</p>
                  </div>
                ))}
              </div>
            )}
            {estimate.changeOrders.length > 0 && (
              <div className="mt-3 space-y-2">
                {estimate.changeOrders.map((changeOrder) => (
                  <div key={changeOrder.id} className="rounded-lg border border-rce-border p-3 text-sm">
                    <p className="font-medium">CO #{changeOrder.sequenceNumber} - {changeOrder.title}</p>
                    <p className="text-rce-muted">{changeOrder.reasonType || "n/a"} | {money(changeOrder.deltaTotal)}</p>
                  </div>
                ))}
              </div>
            )}
          </article>
        )}
      </section>
    </div>
  );
}
