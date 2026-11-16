/**
 * The job's schedule, and the ONE door to change it (2026-10-01, plan item E3).
 *
 * This replaces the inline `JobScheduler` the job drawer, the visit workspace and the lead
 * drawer used to render. Kyle, 2026-10-01: "It would not let me schedule the consultation as in
 * the date picker would only come up in one scheduling page and not the other. It all needs
 * consolidated into a single scheduling system in one place." Two of the four hosts opened
 * straight into a picker and two showed a button first — four schedulers, four grids, two
 * behaviours. Now there is one scheduler, on the Calendar page, where the month grid is the
 * picker, and everywhere else shows THIS: what is booked, and a labelled button that lands on
 * the Calendar with this job already selected (`/calendar?schedule=<visitId>`).
 *
 * What stays here on purpose: the booked date and time (information a person standing on the
 * job needs without leaving it) and "Mark consultation complete" — that is a close-out, not a
 * date choice, and before today the drawer was the only screen that showed it on the job.
 *
 * Also here (Kyle, 2026-11-15): "Technicians on this job" (`JobCrew`) - add, remove and choose the lead,
 * with or without a date. The crew is the job's, so it is not behind the Calendar door.
 *
 * When the door is unavailable it says why (CLAUDE.md click-through rule 5) rather than hiding.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { SCHEDULE_QUERY_KEYS } from "../lib/queryKeys";
import { canReachScheduler, scheduleDoorLabel, scheduleDoorPath } from "../lib/scheduleDoor";
import { JobCrew } from "./JobCrew";

interface Props {
  visitId: string;
  status: string;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  durationDays?: number | null;
  /** Set once the consultation was closed out — swaps the card to its archived state. */
  completedAt?: string | null;
  /** After "Mark consultation complete" or a field-app change — the host refreshes its own reads. */
  onChanged?: () => void;
  /**
   * The visit's customer is the Test Account (2026-10-11). Kyle: "since this is the test account
   * we need to have a test booking that doesn't show on the calendar but places either a
   * consultation, or job on the field app to run tests." The Calendar refuses these visits
   * (2026-09-02: the marked test account never rides the rail), so instead of a dead-end door the
   * card puts the visit straight on a technician's field app — no date, no Calendar entry, no
   * Google event, no customer email.
   */
  isTestAccount?: boolean;
}

const formatScheduled = (iso: string) => new Date(iso).toLocaleDateString("en-US", {
  timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric",
});
const formatTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", {
  timeZone: "America/Chicago", hour: "numeric", minute: "2-digit",
});

export function ScheduleOnCalendar({ visitId, status, scheduledStart, scheduledEnd, durationDays, completedAt, onChanged, isTestAccount }: Props) {
  const queryClient = useQueryClient();
  // Consultations get marked completed and archived — signed estimates are what become active
  // jobs (Kyle, 2026-08-29). Same mutation JobScheduler carries; the Calendar keeps its copy.
  const completeConsultation = useMutation({
    mutationFn: () => api.completeConsultation(visitId),
    onSuccess: () => {
      for (const key of SCHEDULE_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: key });
      onChanged?.();
    },
  });

  const isEstimateVisit = status === "estimate";
  const isScheduled = Boolean(scheduledStart);
  const closedConsultation = isEstimateVisit && Boolean(completedAt);
  const doorOpen = !closedConsultation && canReachScheduler(status, scheduledStart);

  if (isTestAccount) {
    return (
      <div data-schedule-on-calendar data-test-visit-card className="rounded-lg border border-rce-border bg-rce-bg p-4">
        <h3 className="mb-3 text-sm font-semibold">Test visit — field app</h3>
        {closedConsultation && completedAt ? (
          <div className="mb-3 rounded-md border border-rce-border bg-rce-surface p-3 text-sm">
            <p className="font-medium text-rce-muted">Consultation completed</p>
            <p className="text-xs text-rce-soft">
              {formatScheduled(completedAt)} — archived. A signed estimate is what becomes an active job.
            </p>
          </div>
        ) : (
          <TestVisitFieldAppCard
            visitId={visitId}
            status={status}
            completedAt={completedAt}
            onChanged={onChanged}
            canComplete={isEstimateVisit}
            completeConsultation={completeConsultation}
          />
        )}
      </div>
    );
  }

  return (
    <div data-schedule-on-calendar className="rounded-lg border border-rce-border bg-rce-bg p-4">
      <h3 className="mb-3 text-sm font-semibold">
        {isEstimateVisit ? "Estimate Appointment" : "Job Scheduling"}
      </h3>

      {closedConsultation && completedAt ? (
        <div className="mb-3 rounded-md border border-rce-border bg-rce-surface p-3 text-sm">
          <p className="font-medium text-rce-muted">Consultation completed</p>
          <p className="text-xs text-rce-soft">
            {formatScheduled(completedAt)} — archived. A signed estimate is what becomes an active job.
          </p>
        </div>
      ) : isScheduled && scheduledStart ? (
        <div className="mb-3 rounded-md border border-green-200 bg-green-50 p-3 text-sm">
          <p className="font-medium text-green-800">{isEstimateVisit ? "Estimate booked" : "Scheduled"}</p>
          <p className="text-green-700">
            {formatScheduled(scheduledStart)}
            {isEstimateVisit
              ? ` · ${formatTime(scheduledStart)}${scheduledEnd ? `–${formatTime(scheduledEnd)}` : ""}`
              : scheduledEnd && ` – ${formatScheduled(scheduledEnd)}`}
          </p>
          {isEstimateVisit
            ? <p className="text-xs text-green-600">2 hr visit + 1 hr travel leeway</p>
            : durationDays ? <p className="text-xs text-green-600">{durationDays} day(s)</p> : null}
          {/* The close-out Kyle asked for (2026-08-29): "This appointment has been completed and
              there is no way to close it out." Not a date choice, so it stays on the job. */}
          {isEstimateVisit && (
            <button
              type="button"
              className="btn btn-secondary mt-2 text-xs"
              disabled={completeConsultation.isPending}
              onClick={() => completeConsultation.mutate()}
            >
              {completeConsultation.isPending ? "Completing…" : "Mark consultation complete"}
            </button>
          )}
          {completeConsultation.error && (
            <p className="mt-1 text-xs text-red-600">{(completeConsultation.error as Error).message}</p>
          )}
        </div>
      ) : doorOpen ? (
        <p className="mb-3 text-sm text-rce-muted">{isEstimateVisit ? "Not booked yet." : "Not scheduled yet."}</p>
      ) : null}

      {doorOpen ? (
        <>
          <Link to={scheduleDoorPath(visitId)} data-schedule-door className="btn btn-primary text-sm">
            {scheduleDoorLabel(status, scheduledStart)}
          </Link>
          <p className="mt-2 text-xs text-rce-muted">
            Dates are picked on the Calendar page — its month grid is the date picker. This job will
            already be selected there.
          </p>
        </>
      ) : !closedConsultation ? (
        // Greyed with the reason beats hidden (CLAUDE.md click-through rule 5).
        <p className="text-xs text-rce-muted">Not schedulable — status: {status.replaceAll("_", " ")}</p>
      ) : null}

      {/* Who is on this job (Kyle, 2026-11-15). The crew belongs to the job, not to its date, so
          this is here whether or not the job is booked; a closed job shows it greyed with why. */}
      <div className="mt-3">
        <JobCrew visitId={visitId} status={status} completedAt={completedAt} onChanged={onChanged} />
      </div>
    </div>
  );
}

/**
 * The Test Account's door: straight onto a technician's field app. The crew control is the same
 * `JobCrew` every other job uses (one tool for one task, Kyle 2026-10-27). Its routes set no date,
 * make no Google event (a test visit has none, so nothing syncs) and send the customer nothing; the
 * server only emails the technician.
 */
function TestVisitFieldAppCard({ visitId, status, completedAt, onChanged, canComplete, completeConsultation }: {
  visitId: string;
  status: string;
  completedAt?: string | null;
  onChanged?: () => void;
  canComplete: boolean;
  completeConsultation: { isPending: boolean; error: unknown; mutate: () => void };
}) {
  return (
    <>
      <p className="mb-3 text-sm text-rce-muted">
        Test account: this visit goes straight to the field app. It never appears on the Calendar or
        Google Calendar, and the customer gets no booking email. A technician added below sees it on
        their field app.
      </p>

      <JobCrew visitId={visitId} status={status} completedAt={completedAt} onChanged={onChanged} />

      {canComplete && (
        <div className="mt-3">
          <button
            type="button"
            className="btn btn-secondary text-xs"
            disabled={completeConsultation.isPending}
            onClick={() => completeConsultation.mutate()}
          >
            {completeConsultation.isPending ? "Completing…" : "Mark consultation complete"}
          </button>
          {completeConsultation.error != null && (
            <p className="mt-1 text-xs text-red-600">{(completeConsultation.error as Error).message}</p>
          )}
        </div>
      )}
    </>
  );
}
