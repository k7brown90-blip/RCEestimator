/**
 * THE BALLPARK ON A LEAD (Kyle, 2026-11-15, plan lead-intake-fixes F4).
 *
 * "Online ballparks are saved (never sent from the CRM) and adjusted after field observation." A
 * lead from Yelp or Nextdoor often has no street address, so the usual Account -> Property ->
 * Create Estimate route is closed to it. This section is the office's way in: ONE saved ballpark,
 * built in the existing Estimate Intake builder, that sits on the lead.
 *
 *   - "Start a ballpark estimate" opens the builder tied to this lead. Once the lead has one the
 *     SAME button reads "Open ballpark estimate" — one tool for one task, never a second button.
 *   - It cannot be sent while it sits on the lead; the builder says so on screen.
 *   - Converting the lead moves it onto the consultation, and the technician's Quote screen opens
 *     that same draft.
 *   - The way OUT lives here: "Delete ballpark" (confirms what it removes).
 *
 * One component for both places the office stands on a lead: the lead drawer and the lead page.
 * This narrows Kyle's 2026-08-18 / 2026-08-19 rulings for a lead's ballpark and does not repeal them.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type { Lead } from "../lib/types";

const dollars = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const when = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "numeric", day: "numeric", year: "numeric" });

/** Where "Open ballpark estimate" lands. A converted lead also names its account and address, as every other door into the builder does. */
export function ballparkPath(lead: Pick<Lead, "id" | "customerId" | "propertyId">, draftId: string | null): string {
  const params = new URLSearchParams({ lead: lead.id });
  if (draftId) {
    params.set("draft", draftId);
    params.set("tab", "review");
  }
  if (lead.customerId && lead.propertyId) {
    params.set("account", lead.customerId);
    params.set("address", lead.propertyId);
  }
  return `/estimate-intake?${params.toString()}`;
}

export function LeadBallparkSection({ lead, onNotice }: { lead: Lead; onNotice?: (message: string) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ballpark = lead.ballparks?.[0] ?? null;
  const converted = lead.status === "converted";
  /** Starting one is closed to a converted lead: the job's own estimate is built from the job. */
  const startBlocked = !ballpark && converted;

  const remove = useMutation({
    mutationFn: (draftId: string) => api.pbDeleteDraft(draftId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["leads"] });
      void queryClient.invalidateQueries({ queryKey: ["pb-drafts"] });
    },
    onError: (err) => onNotice?.((err as Error).message),
  });

  return (
    <section className="space-y-2 rounded-lg border border-rce-border p-3 text-sm" aria-label="Ballpark estimate">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-rce-soft">Ballpark estimate</h3>

      {ballpark && (
        <div className="space-y-0.5" data-testid="lead-ballpark">
          <p className="font-medium">{ballpark.title}</p>
          <p className="text-xs text-rce-muted">
            {ballpark.total !== null ? `${dollars(ballpark.total)} · ` : ""}
            {ballpark.lineCount === 0 ? "no lines yet · " : `${ballpark.lineCount} line${ballpark.lineCount === 1 ? "" : "s"} · `}
            updated {when(ballpark.updatedAt)}
          </p>
          <p className="text-xs text-rce-muted">
            {ballpark.visitId
              ? "On the consultation — the technician's Quote screen opens this same estimate."
              : "Saved on this lead. It can't be sent — convert the lead first, and it moves onto the job."}
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-secondary text-xs"
          disabled={startBlocked}
          onClick={() => navigate(ballparkPath(lead, ballpark?.id ?? null))}
          title={startBlocked ? "This lead was already converted" : undefined}
        >
          {ballpark ? "Open ballpark estimate" : "Start a ballpark estimate"}
        </button>
        {ballpark && (
          <button
            type="button"
            className="btn btn-danger text-xs"
            disabled={remove.isPending}
            onClick={() => {
              const consequence = ballpark.visitId
                ? "It is also this consultation's quote, so the technician's Quote screen will lose it. This cannot be undone."
                : "Nothing was sent from it. This cannot be undone.";
              if (window.confirm(`Delete the ballpark estimate "${ballpark.title}"? ${consequence}`)) remove.mutate(ballpark.id);
            }}
          >
            {remove.isPending ? "Deleting…" : "Delete ballpark"}
          </button>
        )}
      </div>

      {startBlocked && (
        <p className="text-xs text-rce-muted">
          This lead was already converted, so a ballpark can't be started on it. The job's estimate starts from the account, as every estimate does.
        </p>
      )}
    </section>
  );
}
