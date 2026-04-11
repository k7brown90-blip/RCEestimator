import type { EstimateStatus } from "../lib/types";
import { statusBadgeClass, statusLabel } from "../lib/utils";

export function StatusBadge({ status }: { status: EstimateStatus }) {
  return (
    <span className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-semibold ${statusBadgeClass[status]}`}>
      {statusLabel[status]}
    </span>
  );
}
