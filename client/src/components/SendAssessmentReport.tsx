/**
 * "Email the assessment report" — the client-facing half of the health record, on the record.
 *
 * Kyle's ruling, 2026-09-29: the drawer is for company-to-client communication; company-internal
 * operations stay on their assigned page. Emailing a homeowner their electrical assessment is as
 * client-facing as an invoice — but until now the only button for it was on `/visits/:id`, inside
 * `HealthRecordPanel`, inside an inspection row the operator had to expand first. Three levels
 * down a page, for something the customer is waiting on.
 *
 * ── WHAT STAYS ON THE WORKSPACE, AND WHY THAT IS RIGHT ───────────────────────────────────────
 * The contractor review, the load-calc editor, the generator designer and report GENERATION are
 * company-internal work. Under the ruling they belong on `/visits/:id` and this component
 * deliberately does not duplicate them. It only SENDS, and when a send is refused it names the
 * workspace as the place to go and fix it.
 *
 * ── ONE QUERY ────────────────────────────────────────────────────────────────────────────────
 * `HealthInspectionSummary` already carries `criticalFindingsJson`, `contractorReviewed`,
 * `hasLoadCalc` and `deliveries`, so the gate, the label and the "already sent" line all come off
 * the list the visit already exposes. Same query key as `HealthRecordPanel`'s
 * (`["visitInspections", visitId]`) and the same shape, so the two share one cache entry.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { HealthInspectionSummary } from "../lib/api";

/** The critical findings on a record, tolerating a malformed column rather than throwing. */
function criticalsOf(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Why this report cannot go to the customer, in words, or null when it can.
 * Mirrors the server's refusal on `POST /health-record-admin/inspections/:id/email`.
 */
export function reportSendBlock(row: HealthInspectionSummary): string | null {
  if (criticalsOf(row.criticalFindingsJson).length > 0 && !row.contractorReviewed) {
    return "A critical finding was recorded, so this needs a contractor review before it can go to the customer.";
  }
  return null;
}

export function SendAssessmentReport({ visitId }: { visitId: string }) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<string | null>(null);
  const { data: inspections } = useQuery({
    queryKey: ["visitInspections", visitId],
    queryFn: () => api.visitInspections(visitId),
    enabled: Boolean(visitId),
  });

  const send = useMutation({
    mutationFn: (row: HealthInspectionSummary) =>
      api.emailHealthReport(row.id, undefined, Boolean(row.hasLoadCalc)),
    onSuccess: (r) => {
      setResult(`Report emailed to ${r.sentTo}.`);
      void queryClient.invalidateQueries({ queryKey: ["visitInspections", visitId] });
    },
    onError: (err) => setResult((err as Error).message),
  });

  // No assessment on this job — nothing to offer, and an empty panel would be noise.
  if (!inspections || inspections.length === 0) return null;

  return (
    <div className="rounded-lg border border-rce-border p-2 text-xs">
      <p className="font-semibold text-rce-soft">Electrical assessment</p>
      {inspections.map((row) => {
        const block = reportSendBlock(row);
        const lastSent = row.deliveries?.[row.deliveries.length - 1] ?? null;
        return (
          <div key={row.id} className="mt-1 space-y-1">
            <p className="text-rce-muted">
              {new Date(row.inspectionDate).toLocaleDateString()}
              {row.technician?.name ? ` · ${row.technician.name}` : ""}
              {` · ${row.failCount} fail / ${row.monitorCount} monitor / ${row.passCount} pass`}
              {row.hasLoadCalc ? " · load calc on file" : ""}
            </p>
            {lastSent && (
              <p className="text-rce-soft">
                Last sent to {lastSent.sentTo} on {new Date(lastSent.sentAt).toLocaleDateString()}
              </p>
            )}
            <button
              type="button"
              className="btn btn-secondary text-xs"
              // Greyed with the reason below, never hidden (CLAUDE.md click-through rule 5).
              disabled={Boolean(block) || send.isPending}
              title={block ?? "Emails the homeowner their assessment report, with the delivery logged"}
              onClick={() => send.mutate(row)}
            >
              {send.isPending
                ? "Sending…"
                : `Email the assessment report${row.hasLoadCalc ? " + generator sizing" : ""}`}
            </button>
            {block && (
              <p className="text-amber-800">
                {block}{" "}
                {/* Names WHERE the review is done — a refusal that does not say where to go is a
                    dead end, which is the whole point of the click-through rule. */}
                <Link to={`/visits/${visitId}`} className="underline">
                  Review it on the workspace →
                </Link>
              </p>
            )}
          </div>
        );
      })}
      {result && <p className="mt-1 text-rce-muted">{result}</p>}
    </div>
  );
}
