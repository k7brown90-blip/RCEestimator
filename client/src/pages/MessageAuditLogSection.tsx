/**
 * Settings -> "Message audit log" (work order agent-team, U4; Kyle only). The read-only record of what the
 * Messages hub did with every draft and every text, with a "Blocked texts" filter for the ones the CRM
 * refused to send. Click path from the Dashboard: left nav "Settings" -> "Message audit log" -> Show:
 * "Blocked texts" (three clicks). The list itself is components/MessageAuditLog.tsx, which the Thread
 * drawer's "Audit" button shows for one conversation.
 */
import { MessageAuditLog } from "../components/MessageAuditLog";

export function MessageAuditLogSection() {
  return (
    <section className="card mt-5 p-6" aria-label="Message audit log section">
      <h2 className="text-lg font-semibold">Message audit log</h2>
      <p className="mt-1 text-sm text-rce-muted">
        What the Messages hub did with each AI draft and each text: approved, edited, rejected, sent, held or blocked. Pick "Blocked texts"
        to see every text the CRM refused to send and why. Read-only: nothing here can be changed or removed.
      </p>
      <div className="mt-4">
        <MessageAuditLog />
      </div>
    </section>
  );
}
