import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { FindingLedger } from "./FindingLedger";

/**
 * The ledger for the address this job is at, on the job's own page.
 *
 * Everything a technician is about to be dispatched into, in the place the
 * dispatcher is already standing. The declined rows matter most: quoting work
 * the customer refused three months ago is how a good account goes cold.
 */
export function FindingLedgerPanel({ propertyId }: { propertyId?: string | null }) {
  const query = useQuery({
    queryKey: ["ledgerFindings", propertyId],
    queryFn: () => api.ledgerFindings({ propertyId: propertyId! }),
    enabled: Boolean(propertyId),
  });

  if (!propertyId) return null;
  if (query.isLoading) {
    return (
      <article className="card rounded-2xl border border-rce-border/70 p-5">
        <h2 className="text-lg font-semibold">Finding ledger</h2>
        <p className="mt-1 text-sm text-rce-muted">Loading…</p>
      </article>
    );
  }
  if (query.error) {
    return (
      <article className="card rounded-2xl border border-rce-border/70 p-5">
        <h2 className="text-lg font-semibold">Finding ledger</h2>
        <p className="mt-1 text-sm text-red-600">{(query.error as Error).message}</p>
      </article>
    );
  }

  return <FindingLedger findings={query.data ?? []} title="Findings at this address" />;
}
