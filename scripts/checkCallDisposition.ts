/**
 * Checks whether a Vapi call.id has a logged disposition, and shows the lead
 * it produced — the read side of the /vapi/end-of-call-report safety net.
 *
 * Usage (against production):
 *   railway run npx tsx scripts/checkCallDisposition.ts <callId>
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const callId = process.argv[2];
  if (!callId) {
    console.error("Usage: checkCallDisposition.ts <callId>");
    process.exit(1);
  }

  const auditRows = await prisma.agentAuditLog.findMany({
    where: { callId },
    orderBy: { createdAt: "asc" },
  });

  if (auditRows.length === 0) {
    console.log(`No AgentAuditLog rows found for callId=${callId}.`);
    console.log("Either the call hasn't happened yet, the tool/webhook didn't send x-vapi-call-id, or the end-of-call-report webhook hasn't fired.");
    return;
  }

  console.log(`${auditRows.length} AgentAuditLog row(s) for callId=${callId}:\n`);
  for (const row of auditRows) {
    const ts = row.createdAt.toLocaleString("en-US", { timeZone: "America/Chicago" });
    console.log(`[${ts}] action=${row.action} endpoint=${row.endpoint ?? "-"} entityType=${row.entityType ?? "-"} entityId=${row.entityId ?? "-"} status=${row.responseStatus ?? "-"}`);
    if (row.payloadJson) console.log(`  payload: ${row.payloadJson}`);
  }

  const leadIds = [...new Set(auditRows.filter((r) => r.entityType === "lead" && r.entityId).map((r) => r.entityId!))];
  if (leadIds.length === 0) {
    console.log("\nNo lead entity attached to any row for this call.");
    return;
  }

  console.log(`\n${leadIds.length} lead(s) attached to this call:\n`);
  for (const leadId of leadIds) {
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) {
      console.log(`  ${leadId}: NOT FOUND (deleted?)`);
      continue;
    }
    console.log(`  id: ${lead.id}`);
    console.log(`  leadStatus: ${lead.leadStatus}`);
    console.log(`  callType: ${lead.callType ?? "-"}`);
    console.log(`  phone: ${lead.phone ?? "-"}`);
    console.log(`  followUpDate: ${lead.followUpDate?.toISOString() ?? "-"}`);
    console.log(`  createdAt: ${lead.createdAt.toISOString()}`);
    console.log(`  updatedAt: ${lead.updatedAt.toISOString()}`);
    console.log(`  notes: ${lead.notes ?? "-"}`);
    console.log("");
  }

  const dispositionCount = auditRows.filter((r) => r.action === "call_disposition").length;
  console.log(dispositionCount > 1
    ? `⚠️  ${dispositionCount} call_disposition rows for this call.id — confirm each had a distinct disposition_event_id, or this may be a duplicate rather than a mid-call + final pair.`
    : `${dispositionCount} call_disposition row — idempotency looks correct for this call.`);
}

main().finally(() => prisma.$disconnect());
