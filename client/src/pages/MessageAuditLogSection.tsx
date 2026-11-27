/**
 * Settings -> "Message audit log" (work order agent-team, U4; Kyle only). The read-only record of what the
 * Messages hub did with every draft and every text, with a "Blocked texts" filter for the ones the CRM
 * refused to send. Click path from the Dashboard: left nav "Settings" -> click the "Message audit log" row to
 * open it -> Show: "Blocked texts" (three clicks). The list shows the newest 20 first (Kyle, 2026-11-26, "Shorter
 * logs") and "Show older" does the rest. The list itself is components/MessageAuditLog.tsx, which the Thread
 * drawer's "Audit" button shows for one conversation (it keeps its own full-length list).
 */
import { CollapsibleCard } from "../components/CollapsibleCard";
import { AUDIT_LOCK_REASON, MessageAuditLog } from "../components/MessageAuditLog";
import { useIsKyle, useSession } from "../lib/session";

/** Rows the Message audit log card shows before "Show older". */
export const AUDIT_FIRST_ROWS = 20;

export function MessageAuditLogSection() {
  const session = useSession();
  const isKyle = useIsKyle();
  const allowed = isKyle && session?.kind !== "ai-admin";
  return (
    <CollapsibleCard
      id="settings-message-audit-log"
      title="Message audit log"
      aria-label="Message audit log section"
      subtitle="A read-only record of what the Messages hub did with each AI draft and each text, with a Blocked texts filter for texts the CRM refused to send."
      summary={allowed ? "Read-only record" : AUDIT_LOCK_REASON}
    >
      <MessageAuditLog firstRows={AUDIT_FIRST_ROWS} />
    </CollapsibleCard>
  );
}
