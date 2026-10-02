import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { FindingLedgerPanel } from "../components/FindingLedgerPanel";
import { InspectionResultChip } from "../components/InspectionResultChip";
import { PropertyPhotoSection } from "../components/PhotoGalleryPanel";
import { api } from "../lib/api";
import { money, shortDate } from "../lib/utils";

export function PropertyDetailPage() {
  const { propertyId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: property, isLoading } = useQuery({ queryKey: ["property", propertyId], queryFn: () => api.property(propertyId), enabled: Boolean(propertyId) });

  // The property's health record (Kyle, 2026-10-02, plan item C): every electrical assessment and
  // circuit diagnostic ever run at THIS address, across every visit — read-only here. Editing a
  // load calc, running the generator designer, marking a contractor review, and emailing a report
  // all stay where they already live (the visit workspace's HealthRecordPanel, and the account
  // page's HealthInspectionHistory) so this page is not a second editor for either.
  const { data: inspections } = useQuery({
    queryKey: ["propertyInspections", propertyId],
    queryFn: () => api.propertyInspections(propertyId),
    enabled: Boolean(propertyId),
  });
  const { data: diagnosticReportsData } = useQuery({
    queryKey: ["propertyDiagnosticReports", propertyId],
    queryFn: () => api.propertyDiagnosticReports(propertyId),
    enabled: Boolean(propertyId),
  });

  const [scheduleError, setScheduleError] = useState<string | null>(null);
  // Schedule Consultation (Kyle, 2026-10-02): creates the consultation visit for this customer at
  // this property, then lands on the Calendar with it selected — the ONE scheduler
  // (`/calendar?schedule=<visitId>`, constants.md "ONE SCHEDULER, AND IT LIVES ON THE CALENDAR").
  // This button is also the fold-in point for "Open a visit" (D2, 2026-10-02): the Calendar's four
  // preset blocks plus its free time input already cover an ordinary daytime consultation or an
  // after-hours/emergency call, so nothing extra is built here — only the wording avoids implying
  // business hours.
  const scheduleConsultation = useMutation({
    mutationFn: () => {
      if (!property) return Promise.reject(new Error("Property not loaded yet"));
      return api.createVisit({
        customerId: property.customerId,
        propertyId: property.id,
        mode: "service_diagnostic",
        purpose: "Consultation — estimate visit",
      });
    },
    onSuccess: (visit) => navigate(`/calendar?schedule=${visit.id}`),
    onError: (err) => setScheduleError((err as Error).message),
  });

  const [editingProperty, setEditingProperty] = useState(false);
  const [propertyForm, setPropertyForm] = useState({ name: "", addressLine1: "", city: "", state: "", postalCode: "", notes: "" });

  const updatePropertyMutation = useMutation({
    mutationFn: () => api.updateProperty(propertyId, propertyForm),
    onSuccess: () => { setEditingProperty(false); queryClient.invalidateQueries({ queryKey: ["property", propertyId] }); },
  });
  const deletePropertyMutation = useMutation({
    mutationFn: () => api.deleteProperty(propertyId),
    onSuccess: () => navigate(`/accounts/${property?.customerId}`),
  });

  function startEditProperty() {
    if (!property) return;
    setPropertyForm({
      name: property.name ?? "",
      addressLine1: property.addressLine1 ?? "",
      city: property.city ?? "",
      state: property.state ?? "",
      postalCode: property.postalCode ?? "",
      notes: property.notes ?? "",
    });
    setEditingProperty(true);
  }

  const hasVisits = (property?.visits?.length ?? 0) > 0;

  if (isLoading || !property) {
    return <p className="text-sm text-rce-muted">Loading property...</p>;
  }

  return (
    <div>
      <PageHeader
        title={property.addressLine1}
        subtitle={`${property.city}, ${property.state} ${property.postalCode}`}
        actions={
          <div className="flex items-center gap-2">
            <Link className="btn btn-secondary" to={`/accounts/${property.customerId}`}>Back to Account</Link>
            <button type="button" className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100" onClick={startEditProperty}>Edit</button>
            {!hasVisits && (
              <button type="button" className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100" disabled={deletePropertyMutation.isPending} onClick={() => { if (window.confirm("Delete this property? This cannot be undone.")) deletePropertyMutation.mutate(); }}>Delete</button>
            )}
          </div>
        }
      />

      {editingProperty && (
        <form className="card mb-4 space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); updatePropertyMutation.mutate(); }}>
          <h3 className="text-sm font-semibold">Edit Property</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-rce-soft">Name</label>
              <input className="field" value={propertyForm.name} onChange={(e) => setPropertyForm({ ...propertyForm, name: e.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-rce-soft">Address</label>
              <input className="field" value={propertyForm.addressLine1} onChange={(e) => setPropertyForm({ ...propertyForm, addressLine1: e.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-rce-soft">City</label>
              <input className="field" value={propertyForm.city} onChange={(e) => setPropertyForm({ ...propertyForm, city: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-rce-soft">State</label>
                <input className="field" value={propertyForm.state} onChange={(e) => setPropertyForm({ ...propertyForm, state: e.target.value })} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-rce-soft">Zip</label>
                <input className="field" value={propertyForm.postalCode} onChange={(e) => setPropertyForm({ ...propertyForm, postalCode: e.target.value })} />
              </div>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-rce-soft">Notes</label>
            <textarea className="field" rows={2} value={propertyForm.notes} onChange={(e) => setPropertyForm({ ...propertyForm, notes: e.target.value })} />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600" onClick={() => setEditingProperty(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary text-xs" disabled={updatePropertyMutation.isPending}>Save</button>
          </div>
        </form>
      )}

      {/* ── The two doors into work at this address (Kyle, 2026-10-02, plan item C) ──────────
          "The top card will have the 'estimates for this address' will be removed. The top card
          will have no title. The buttons in this card will be Schedule Consultation ... and
          Create New Estimate." No <h2> here on purpose — this card is intentionally untitled. */}
      <section className="card mb-5 p-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            className="btn btn-primary flex-1"
            disabled={scheduleConsultation.isPending}
            onClick={() => { setScheduleError(null); scheduleConsultation.mutate(); }}
          >
            {scheduleConsultation.isPending ? "Scheduling…" : "Schedule Consultation"}
          </button>
          <Link
            className="btn btn-secondary flex-1"
            to={`/estimate-intake?account=${property.customerId}&address=${property.id}`}
          >
            Create New Estimate
          </Link>
        </div>
        <p className="mt-2 text-xs text-rce-soft">
          Schedule Consultation covers any visit to this address — an ordinary consultation or an
          after-hours/emergency call — and lands on the Calendar to pick the time.
        </p>
        {scheduleError && <p className="mt-2 text-xs text-red-600">{scheduleError}</p>}
      </section>

      {/* "Previous Estimates" and "Sold Work" (Kyle, 2026-08-19) moved out of the now-untitled
          top card (plan item C) but kept — each is the sole route from this page to its filtered
          view (the account's estimates filtered to this address, and the Jobs page's open work
          orders filtered to this address). */}
      <div className="mb-5 flex flex-col gap-2 sm:flex-row">
        <Link className="btn btn-secondary flex-1" to={`/accounts/${property.customerId}?address=${property.id}`}>
          Previous Estimates
        </Link>
        <Link className="btn btn-secondary flex-1" to={`/jobs?address=${property.id}&open=1`}>
          Sold Work
        </Link>
      </div>

      {/* ── This property's HEALTH RECORD (Kyle, 2026-10-02, plan item C) ─────────────────────
          "The system snapshot on this page is not being utilized and should be where this
          particular properties health record lives (findings ledger, load calc, generator sizing
          tool, and electrical assessment results) ... we can also add in diagnostics reports
          here ... Property photos will also show up here."

          Read-only aggregation across every visit at this address. Editing a load calc, running
          the generator designer, marking a contractor review, and emailing a report to the
          customer all stay on the visit workspace (HealthRecordPanel) and the account page
          (HealthInspectionHistory) — duplicating those controls here would be a second editor for
          a record that already has one. This page only lists and links out.

          NOTE for the architect: the old "System Snapshot" form (service/panel/grounding/wiring
          summaries + deficiencies) is removed per Kyle's own instruction above, but it was the
          ONLY CRM read/write surface for that data — SystemSnapshot is still written by the
          Savannah phone-intake agent (src/routes/agent.ts, agent-jerry.ts). Flagging since nothing
          in the CRM can view or edit it after this change; no other screen showed it before. */}
      <section className="card mb-5 space-y-5 p-4">
        <h2 className="text-lg font-semibold">Health Record</h2>

        <FindingLedgerPanel propertyId={property.id} />

        <div>
          <h3 className="mb-2 text-sm font-semibold">Electrical assessments</h3>
          {(inspections?.length ?? 0) === 0 && (
            <p className="text-sm text-rce-soft">No electrical assessment on file for this address yet.</p>
          )}
          {(inspections?.length ?? 0) > 0 && (
            <ul className="space-y-2">
              {inspections!.map((inspection) => {
                let criticals: string[] = [];
                try { criticals = JSON.parse(inspection.criticalFindingsJson) as string[]; } catch { /* malformed, treat as none */ }
                return (
                  <li key={inspection.id} className="rounded-lg border border-rce-border p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <span className="mr-2">
                          <InspectionResultChip
                            criticalCount={criticals.length}
                            failCount={inspection.failCount}
                            monitorCount={inspection.monitorCount}
                            schemaVersion={inspection.schemaVersion}
                            score={inspection.score}
                          />
                        </span>
                        {shortDate(inspection.inspectionDate)} · {inspection.itemsAssessed} items
                        {inspection.scope === "phase1" && " (Phase 1)"}
                        {inspection.technician && ` · ${inspection.technician.name}`}
                        {inspection.hasLoadCalc && " · load calc + generator sizing on file"}
                        {criticals.length > 0 && (
                          <span className="ml-2 font-semibold text-red-600">⚠ {criticals.join(", ")}</span>
                        )}
                      </span>
                      <Link to={`/visits/${inspection.visitId}`} className="btn btn-secondary px-2 py-0.5 text-xs min-h-0">
                        open visit →
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">Diagnostic reports</h3>
          {(diagnosticReportsData?.reports.length ?? 0) === 0 && (
            <p className="text-sm text-rce-soft">No circuit diagnostic on file for this address yet.</p>
          )}
          {(diagnosticReportsData?.reports.length ?? 0) > 0 && (
            <ul className="space-y-2">
              {diagnosticReportsData!.reports.map((report) => (
                <li key={report.id} className="rounded-lg border border-rce-border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {shortDate(report.reportDate)} · {report.complaint} · circuit {report.circuitLabel}
                      {report.status === "void" && <span className="ml-2 text-xs font-semibold text-red-600">VOIDED</span>}
                      {report.status === "in_progress" && <span className="ml-2 text-xs text-amber-700">in progress</span>}
                      {report.defectCount > 0 && (
                        <span className="ml-2 text-xs text-amber-700">{report.defectCount} defective</span>
                      )}
                    </span>
                    <Link to={`/visits/${report.visitId}`} className="btn btn-secondary px-2 py-0.5 text-xs min-h-0">
                      open visit →
                    </Link>
                  </div>
                  <p className="mt-1 text-xs text-rce-soft">{report.coverageStatement}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">Photos</h3>
          <PropertyPhotoSection propertyId={property.id} propertyLabel={property.addressLine1} defaultOpen />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Visits and Estimates</h2>
        {property.visits?.map((visit) => {
          const estimate = visit.estimates?.[0];
          return (
            <Link key={visit.id} to={`/visits/${visit.id}`} className="card block p-4 hover:border-rce-accent">
              <div className="flex items-center justify-between">
                <p className="font-medium">{visit.mode.replaceAll("_", " ")} | {shortDate(visit.visitDate)}</p>
                {estimate ? <StatusBadge status={estimate.status} /> : <span className="text-xs text-rce-soft">NO ESTIMATE</span>}
              </div>
              <p className="text-sm text-rce-muted">{estimate ? `${estimate.title} | Rev ${estimate.revision} | ${money(estimate.options?.[0]?.totalCost)}` : "No estimate yet"}</p>
            </Link>
          );
        })}
      </section>
    </div>
  );
}
