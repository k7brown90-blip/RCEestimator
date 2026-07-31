import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { InspectionResultChip } from "./InspectionResultChip";
import { ProtectedImage } from "./ProtectedImage";

/**
 * Health Record panel for the visit workspace: assign the inspection to a
 * technician and review inspections synced back from the field PWA.
 */
export function HealthRecordPanel({ visitId }: { visitId: string }) {
  const queryClient = useQueryClient();
  const [technicianId, setTechnicianId] = useState("");
  const [expandedInspectionId, setExpandedInspectionId] = useState<string | null>(null);

  const { data: technicians } = useQuery({ queryKey: ["technicians"], queryFn: api.technicians });
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

  const assignMutation = useMutation({
    mutationFn: () => api.assignTechnician(visitId, { technicianId }),
    onSuccess: () => {
      setTechnicianId("");
      void queryClient.invalidateQueries({ queryKey: ["visitAssignments", visitId] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (assignmentId: string) => api.removeAssignment(assignmentId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["visitAssignments", visitId] }),
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

  const activeTechs = (technicians ?? []).filter((t) => t.isActive);
  const criticalOf = (json: string): string[] => {
    try {
      return JSON.parse(json) as string[];
    } catch {
      return [];
    }
  };

  const loadCalcSummary = (() => {
    if (!inspectionDetail?.loadCalcJson) return null;
    try {
      const parsed = JSON.parse(inspectionDetail.loadCalcJson) as {
        result?: { governingAmps?: number; serviceAmps?: number; loadPct?: number; spareAmps?: number };
      };
      return parsed.result ?? null;
    } catch {
      return null;
    }
  })();

  return (
    <article className="card rounded-2xl border border-rce-border/70 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Electrical Health Record</h2>
        <span className="text-xs text-rce-muted">Field inspection PWA</span>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-sm font-medium">
          Assign technician
          <select
            className="field mt-1 min-w-56"
            value={technicianId}
            onChange={(e) => setTechnicianId(e.target.value)}
          >
            <option value="">Select technician…</option>
            {activeTechs.map((tech) => (
              <option key={tech.id} value={tech.id}>
                {tech.name} ({tech.role})
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-primary text-xs"
          disabled={!technicianId || assignMutation.isPending}
          onClick={() => assignMutation.mutate()}
        >
          Assign inspection
        </button>
        {activeTechs.length === 0 && (
          <span className="text-xs text-rce-muted">No technicians yet — add them in the Team tab.</span>
        )}
      </div>

      {(assignments ?? []).length > 0 && (
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
              {assignment.status !== "completed" && (
                <button
                  type="button"
                  className="text-xs font-medium text-red-600"
                  onClick={() => removeMutation.mutate(assignment.id)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
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
                      {loadCalcSummary && (
                        <p className="mt-1">
                          Load calculation: {loadCalcSummary.governingAmps} A on a{" "}
                          {loadCalcSummary.serviceAmps} A service — {loadCalcSummary.loadPct}% used,{" "}
                          {loadCalcSummary.spareAmps} A spare (NEC 230.42 basis).
                        </p>
                      )}
                      {(inspectionDetail.photos ?? []).length > 0 && (
                        <div className="mt-2">
                          <p className="font-medium">Photo evidence ({inspectionDetail.photos!.length})</p>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {inspectionDetail.photos!.map((photo) => (
                              <ProtectedImage
                                key={photo.id}
                                path={`/health-record-admin/photos/${photo.id}`}
                                alt="Inspection evidence"
                                className="h-16 w-16 rounded border border-rce-border object-cover"
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
