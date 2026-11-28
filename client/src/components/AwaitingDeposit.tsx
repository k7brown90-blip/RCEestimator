import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type AwaitingDepositJob } from "../lib/api";
import { useDrawerParams } from "../lib/drawers";
import { OpenDrawerButton } from "./drawers/OpenDrawerButton";

/** The one query behind every mount of the list - same key, so the Jobs page and the Calendar share one fetch. */
export const AWAITING_DEPOSIT_KEY = ["jobs", "awaiting-deposit"] as const;

export function useAwaitingDeposit() {
  return useQuery<AwaitingDepositJob[]>({
    queryKey: AWAITING_DEPOSIT_KEY,
    queryFn: () => api.awaitingDeposit(),
    refetchInterval: 60_000,
  });
}

/**
 * Signed - awaiting deposit (Kyle, 2026-11-27: "she signed and hasn't paid so we need to see that
 * and process a payment for those who are financing").
 *
 * ONE component, two mounts: the Jobs page (Active tab) and the Calendar's needs-scheduling rail.
 * These are NOT jobs and cannot be scheduled - the Jobs list stays signed + deposit paid (Kyle,
 * 2026-08-26) - so each row's one action is Take payment, which opens the job's drawer where the
 * existing Take payment card (PaymentPanel) records the deposit or sends the deposit request. No
 * second payment tool lives here. Financing customers owe the one-third deposit too (the
 * Synchrony payment stays locked until it is in).
 *
 * Hidden when empty. If the list cannot be loaded it says so, rather than going quiet - a list of
 * money owed that silently vanishes is the very gap this exists to close.
 */
export function AwaitingDeposit() {
  const drawers = useDrawerParams();
  const { data, isError } = useAwaitingDeposit();

  if (isError) {
    return (
      <p className="mb-3 text-xs text-red-500">
        Couldn't load the signed jobs that are waiting on a deposit. Reload the page to try again.
      </p>
    );
  }
  if (!data || data.length === 0) return null;

  return (
    <section className="mb-5 rounded-lg border border-amber-300 bg-amber-50 p-4" data-testid="awaiting-deposit">
      <h2 className="text-sm font-semibold text-amber-900">Signed — awaiting deposit ({data.length})</h2>
      <p className="mt-1 text-xs text-amber-900">
        Signed, deposit not in yet. Not on the schedule until it is. Financing customers pay the one-third deposit too.
      </p>
      <div className="mt-2 space-y-2">
        {data.map((job) => (
          <div key={job.visitId} className="rounded-lg border border-amber-200 bg-white p-3">
            <Link to={`/accounts/${job.customerId}`} className="text-sm font-medium hover:text-rce-accent">
              {job.customerName}
            </Link>
            <p className="text-xs text-rce-muted">{job.address}</p>
            <p className="mt-1 text-xs text-rce-soft">
              {job.jobType ?? job.purpose ?? "Sold job"} · Estimate {job.estimateNumber}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">Deposit unpaid</span>
              <OpenDrawerButton
                kind="job"
                id={job.visitId}
                onOpen={drawers.open}
                label="Take payment"
                title="Open this job's Take payment card to record the deposit or send a deposit request"
                className="btn btn-primary text-xs"
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
