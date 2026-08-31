import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { InspectionResultChip } from "./InspectionResultChip";
import { ProtectedImage } from "./ProtectedImage";
import { GeneratorDesigner } from "./GeneratorDesigner";
import { PhotoLightbox } from "./PhotoLightbox";

/**
 * Health Record panel for the visit workspace — read-only from the CRM's side.
 *
 * The CRM is scheduling/management only: technician assignment happens in the
 * scheduler (JobScheduler tech picker) when the appointment is booked, and the
 * inspection itself — including its load calculation — is the Health Report
 * product, owned by the field PWA. What the office needs here is to see synced
 * results, mark the contractor review, and generate/send the report PDF.
 */
export function HealthRecordPanel({ visitId }: { visitId: string }) {
  const queryClient = useQueryClient();
  const [expandedInspectionId, setExpandedInspectionId] = useState<string | null>(null);
  // The CRM-side generator designer (Kyle, 2026-08-31) — one open at a time.
  const [designerInspectionId, setDesignerInspectionId] = useState<string | null>(null);
  // Zoomable viewer for nameplate-reading (Kyle, 2026-08-31).
  const [lightbox, setLightbox] = useState<{ path: string; alt: string } | null>(null);

  const { data: assignments } = useQuery({
    queryKey: ["visitAssignments", visitId],
    queryFn: () => api.visitAssignments(visitId),
    enabled: Boolean(visitId),
  });
  const { data: inspections } = useQuery({
    queryKey: ["visitInspections", visitId],
    queryFn: () => api.visitInspections(visitId),
    enabled: Boolean(visitId),
  });
  const { data: inspectionDetail } = useQuery({
    queryKey: ["healthInspection", expandedInspectionId],
    queryFn: () => api.healthInspection(String(expandedInspectionId)),
    enabled: Boolean(expandedInspectionId),
  });

  const reviewMutation = useMutation({
    mutationFn: (inspectionId: string) => {
      const reviewedBy = window.prompt("Reviewer name (licensed contractor):", "Kyle");
      if (!reviewedBy) return Promise.reject(new Error("cancelled"));
      return api.reviewInspection(inspectionId, { reviewedBy });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["visitInspections", visitId] });
      void queryClient.invalidateQueries({ queryKey: ["healthInspection", expandedInspectionId] });
    },
  });

  const reportMutation = useMutation({
    mutationFn: (inspectionId: string) => api.generateHealthReport(inspectionId),
    onSuccess: (result) => {
      window.open(`/api/documents/${result.documentId}/pdf`, "_blank");
    },
  });

  // P031 generator sizing report — same open-the-PDF flow as the health report.
  const generatorReportMutation = useMutation({
    mutationFn: (inspectionId: string) => api.generateGeneratorReport(inspectionId),
    onSuccess: (result) => {
      window.open(`/api/documents/${result.documentId}/pdf`, "_blank");
    },
  });

  // Email the report to the customer (2026-08-24). The server refuses an
  // unreviewed critical report and logs every send as a delivery.
  const [emailResult, setEmailResult] = useState<string | null>(null);
  const emailMutation = useMutation({
    mutationFn: (inspectionId: string) => api.emailHealthReport(inspectionId),
    onSuccess: (r) => setEmailResult(`Sent to ${r.sentTo}.`),
    onError: (err) => setEmailResult((err as Error).message),
  });

  const criticalOf = (json: string): string[] => {
    try {
      return JSON.parse(json) as string[];
    } catch {
      return [];
    }
  };

  return (
    <article className="card rounded-2xl border border-rce-border/70 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Electrical Health Record</h2>
        <span className="text-xs text-rce-muted">Field inspection PWA</span>
      </div>
      {lightbox && (
        <PhotoLightbox path={lightbox.path} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      )}

      {/* Read-only: assignment happens in the scheduler when the appointment
          is booked. This just shows who's on it. */}
      {(assignments ?? []).length > 0 ? (
        <ul className="mt-3 space-y-1">
          {(assignments ?? []).map((assignment) => (
            <li key={assignment.id} className="flex items-center justify-between rounded-lg border border-rce-border bg-white px-3 py-2 text-sm">
              <span>
                <span className="font-medium">{assignment.technician.name}</span>
                {assignment.technician.employeeNumber ? (
                  <span className="ml-1.5 rounded bg-rce-accentBg px-1 py-0.5 font-mono text-[10px] text-rce-accentDark">
                    {assignment.technician.employeeNumber}
                  </span>
                ) : null}
                <span className="ml-2 text-xs text-rce-muted">
                  {assignment.role} · {assignment.status}
                  {assignment.completedAt ? ` · completed ${new Date(assignment.completedAt).toLocaleDateString()}` : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-rce-muted">
          No technician assigned yet — assign one when booking the appointment above.
        </p>
      )}

      <div className="mt-4">
        <h3 className="text-sm font-semibold text-rce-soft">Synced inspections</h3>
        {(inspections ?? []).length === 0 ? (
          <p className="mt-1 text-sm text-rce-muted">
            None yet — completed field inspections sync here automatically and save to the
            customer's account.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {(inspections ?? []).map((inspection) => {
              const criticals = criticalOf(inspection.criticalFindingsJson);
              const expanded = expandedInspectionId === inspection.id;
              return (
                <li key={inspection.id} className="rounded-lg border border-rce-border bg-white p-3 text-sm">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between text-left"
                    onClick={() => setExpandedInspectionId(expanded ? null : inspection.id)}
                  >
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
                      {new Date(inspection.inspectionDate).toLocaleDateString()} ·{" "}
                      {inspection.itemsAssessed} items
                      {inspection.scope === "phase1" && " (Phase 1)"} ·{" "}
                      {inspection.technician?.name ?? "unassigned"}
                      {inspection.technician?.employeeNumber ? ` (${inspection.technician.employeeNumber})` : ""}
                      {criticals.length > 0 && (
                        <span className="ml-2 font-semibold text-red-600">
                          ⚠ {criticals.length} critical ({criticals.join(", ")})
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-rce-muted">{expanded ? "collapse" : "details"}</span>
                  </button>
                  {expanded && inspectionDetail?.id === inspection.id && (
                    <div className="mt-2 border-t border-rce-border pt-2 text-xs text-rce-muted">
                      <p>
                        Jurisdiction: {inspectionDetail.jurisdictionId} · Contractor reviewed:{" "}
                        {inspectionDetail.contractorReviewed
                          ? `yes${inspectionDetail.reviewedBy ? ` (${inspectionDetail.reviewedBy}${inspectionDetail.reviewedAt ? `, ${new Date(inspectionDetail.reviewedAt).toLocaleDateString()}` : ""})` : ""}`
                          : "no"}{" "}
                        · Synced {new Date(inspectionDetail.syncedAt).toLocaleString()}
                      </p>
                      {/* Load calculation deliberately not shown — it belongs to
                          the Health Report product, not the CRM. */}
                      {(inspectionDetail.photos ?? []).length > 0 && (
                        <div className="mt-2">
                          <p className="font-medium">Photo evidence ({inspectionDetail.photos!.length})</p>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {inspectionDetail.photos!.map((photo) => (
                              <ProtectedImage
                                key={photo.id}
                                path={`/health-record-admin/photos/${photo.id}`}
                                alt="Inspection evidence"
                                className="h-16 w-16 cursor-zoom-in rounded border border-rce-border object-cover"
                                onClick={() =>
                                  setLightbox({
                                    path: `/health-record-admin/photos/${photo.id}`,
                                    alt: "Inspection evidence",
                                  })
                                }
                              />
                            ))}
                          </div>
                        </div>
                      )}
                      {!inspectionDetail.contractorReviewed && (
                        <button
                          type="button"
                          className="btn btn-primary mt-2 text-xs"
                          disabled={reviewMutation.isPending}
                          onClick={() => reviewMutation.mutate(inspection.id)}
                        >
                          Mark contractor-reviewed
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-secondary ml-2 mt-2 text-xs"
                        disabled={reportMutation.isPending}
                        onClick={() => reportMutation.mutate(inspection.id)}
                      >
                        {reportMutation.isPending ? "Generating…" : "Generate PDF report"}
                      </button>
                      {/* P031 (Kyle, 2026-08-28): the generator sizing report
                          unlocks once the A2 load calc is on the record —
                          without one there is nothing to size from. */}
                      {inspection.hasLoadCalc && (
                        <>
                          <button
                            type="button"
                            className="btn btn-secondary ml-2 mt-2 text-xs"
                            disabled={generatorReportMutation.isPending}
                            onClick={() => generatorReportMutation.mutate(inspection.id)}
                          >
                            {generatorReportMutation.isPending ? "Generating…" : "Generator sizing report"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary ml-2 mt-2 text-xs"
                            onClick={() =>
                              setDesignerInspectionId(designerInspectionId === inspection.id ? null : inspection.id)
                            }
                          >
                            {designerInspectionId === inspection.id ? "Close designer" : "Design generator"}
                          </button>
                        </>
                      )}
                      {designerInspectionId === inspection.id && (
                        <GeneratorDesigner
                          inspectionId={inspection.id}
                          onClose={() => setDesignerInspectionId(null)}
                        />
                      )}
                      <button
                        type="button"
                        className="btn btn-primary ml-2 mt-2 text-xs"
                        disabled={
                          emailMutation.isPending ||
                          (criticals.length > 0 && !inspectionDetail.contractorReviewed)
                        }
                        title={
                          criticals.length > 0 && !inspectionDetail.contractorReviewed
                            ? "Critical finding — contractor review required before this can be emailed"
                            : undefined
                        }
                        onClick={() => emailMutation.mutate(inspection.id)}
                      >
                        {emailMutation.isPending ? "Sending…" : "Email report to customer"}
                      </button>
                      {emailResult && <p className="mt-1 text-xs">{emailResult}</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </article>
  );
}
