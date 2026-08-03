/**
 * Call disposition — the structured end-of-call outcome shared by the
 * log_call_disposition tool (agent-shared.ts) and the /vapi/end-of-call-report
 * fallback (app.ts). Resolves the lead by id, then phone, and creates one as
 * a last resort so an outcome is never dropped on the floor.
 */
import { prisma } from "../lib/prisma";
import { normalizePhone } from "../routes/agent-helpers";

export interface CallDispositionInput {
  leadId?: string;
  phone?: string;
  name?: string;
  callType: string;
  leadStatus: "new" | "booked" | "unresolved" | "planning" | "no_answer" | "lost" | "won";
  followUpDate?: string; // YYYY-MM-DD
  followUpReason?: string;
  lostReason?: string;
  bestTimeToReach?: string;
  notes?: string;
}

export interface CallDispositionResult {
  lead: Awaited<ReturnType<typeof prisma.lead.update>>;
  created: boolean;
}

export async function applyCallDisposition(input: CallDispositionInput): Promise<CallDispositionResult> {
  let lead = input.leadId
    ? await prisma.lead.findUnique({ where: { id: input.leadId } })
    : null;
  if (!lead && input.phone) {
    const normalized = normalizePhone(input.phone);
    lead = await prisma.lead.findFirst({
      where: { phone: { in: [input.phone, normalized] } },
      orderBy: { createdAt: "desc" },
    });
  }

  const followUpDate = input.followUpDate ? new Date(`${input.followUpDate}T12:00:00Z`) : undefined;
  const dispositionNote = `[Call ${new Date().toISOString().slice(0, 10)}] ${input.callType}/${input.leadStatus}${input.notes ? ` — ${input.notes}` : ""}`;

  let created = false;
  if (lead) {
    lead = await prisma.lead.update({
      where: { id: lead.id },
      data: {
        leadStatus: input.leadStatus,
        callType: input.callType,
        ...(followUpDate ? { followUpDate, followUpCount: { increment: 1 } } : {}),
        ...(input.followUpReason ? { followUpReason: input.followUpReason } : {}),
        ...(input.lostReason ? { lostReason: input.lostReason } : {}),
        ...(input.bestTimeToReach ? { bestTimeToReach: input.bestTimeToReach } : {}),
        notes: lead.notes ? `${lead.notes}\n${dispositionNote}` : dispositionNote,
      },
    });
  } else {
    created = true;
    lead = await prisma.lead.create({
      data: {
        name: input.name ?? "Unknown caller",
        phone: input.phone ? normalizePhone(input.phone) : null,
        source: "phone",
        leadStatus: input.leadStatus,
        callType: input.callType,
        followUpDate: followUpDate ?? null,
        followUpReason: input.followUpReason ?? null,
        lostReason: input.lostReason ?? null,
        bestTimeToReach: input.bestTimeToReach ?? null,
        notes: dispositionNote,
      },
    });
  }

  return { lead, created };
}
