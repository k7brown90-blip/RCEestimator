interface Props {
  criticalCount: number;
  failCount: number;
  monitorCount: number;
  /** v1 records predate the counts and carry a headline score instead. */
  schemaVersion?: "v1" | "v2" | "v3";
  score?: number | null;
}

/**
 * The at-a-glance verdict on an inspection, replacing the old 0-100 badge.
 *
 * A number invited "why isn't it 100?"; a count of what needs correcting is the
 * thing the customer and the office actually act on. Historical v1 records still
 * show their score, greyed, so the list stays honest about what was delivered.
 */
export function InspectionResultChip({
  criticalCount, failCount, monitorCount, schemaVersion = "v2", score,
}: Props) {
  if (criticalCount > 0) {
    return (
      <Chip className="bg-red-600 text-white">
        {criticalCount} critical
      </Chip>
    );
  }

  if (schemaVersion === "v1" && typeof score === "number") {
    return <Chip className="bg-zinc-400 text-white">Legacy score {score}</Chip>;
  }

  if (failCount > 0) {
    return (
      <Chip className="bg-red-500 text-white">
        {failCount} need{failCount === 1 ? "s" : ""} correction
      </Chip>
    );
  }

  if (monitorCount > 0) {
    return (
      <Chip className="bg-amber-500 text-white">
        {monitorCount} to monitor
      </Chip>
    );
  }

  return <Chip className="bg-emerald-600 text-white">All pass</Chip>;
}

function Chip({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${className}`}>
      {children}
    </span>
  );
}
