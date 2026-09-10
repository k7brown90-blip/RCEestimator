/**
 * "Email bounced" — the red badge an estimate, invoice or account row wears when Gmail
 * reported that the last email about it came back.
 *
 * Kyle, 2026-09-09: *"My emails are not getting to the clients"* / *"very few are actually
 * getting through, this is priority number one."* Before this a bounced estimate read
 * "sent — not opened yet", exactly like one the customer simply hadn't read. The server's
 * bounce watcher stamps `lastBounceAt` / `lastBounceReason`; this renders it wherever the
 * row is shown, with the reason in full so Kyle knows whether it is a dead address (5.1.1)
 * or a receiver refusing us (5.7.0) before he picks up the phone.
 */

export function BounceBadge({ at, reason, compact }: { at?: string | null; reason?: string | null; compact?: boolean }) {
  if (!at) return null;
  const when = new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1" title={reason ?? undefined}>
      <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-800">
        Email bounced {when}
      </span>
      {!compact && reason && (
        <span className="break-words text-[11px] text-red-700">{reason}</span>
      )}
    </span>
  );
}
