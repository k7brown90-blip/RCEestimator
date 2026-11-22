/**
 * The waiting-approval reminder (work order agent-team, U8, team answer 8). A draft that has been waiting
 * for approval gets ONE reminder 15 minutes after it was drafted, then at most one an hour for as long as it
 * waits - never every 15 minutes. Reminders go out only inside Mon-Fri 8:00 AM-8:00 PM America/Chicago, the
 * hours from the owner setting `hubNotify` (the weekday rule is fixed, in the ONE helper
 * isSendableNow, shared/sms/quietHours.ts). A draft whose 15 minutes ended outside the window gets its first
 * reminder when the window next opens, then hourly.
 *
 * A server cron (server.ts, every 5 minutes) runs `runRenotify`. It picks the drafts that are due, CLAIMS them
 * by stamping HubMessage.lastNotifiedAt and notifyCount in one conditional update (so two overlapping runs, or
 * a run and a restart, cannot remind twice), and sends the approvers ONE push that says how many are waiting.
 * A draft that is decided (approved, edited, rejected, deleted) is no longer pending, so it is never selected.
 *
 * It reminds nobody while push is not set up (VAPID unset): nothing is stamped, so the first reminder goes
 * out the first time it can.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { isSendableNow } from "../../shared/sms/quietHours";
import { CALENDAR_DAY_TIME_ZONE } from "../../shared/calendarDay";
import { getNotifyWindow } from "./ownerSettings";
import { notifyApprovers } from "./hubNotifier";
import { pushConfig } from "./hubPush";

export const FIRST_REMINDER_MS = 15 * 60_000;
export const REPEAT_REMINDER_MS = 60 * 60_000;

export interface RenotifyResult {
  /** Drafts reminded about on this run. */
  reminded: number;
  /** Why nothing was done, when nothing was. */
  skipped: "push_not_set_up" | "outside_hours" | "none_due" | null;
}

const dueWhere = (now: Date): Prisma.HubMessageWhereInput => ({
  status: "pending_approval",
  deletedAt: null,
  OR: [
    { notifyCount: 0, createdAt: { lte: new Date(now.getTime() - FIRST_REMINDER_MS) } },
    { notifyCount: { gte: 1 }, lastNotifiedAt: { lte: new Date(now.getTime() - REPEAT_REMINDER_MS) } },
  ],
});

export async function runRenotify(now: Date = new Date(), db: PrismaClient = defaultPrisma): Promise<RenotifyResult> {
  if (!pushConfig().configured) return { reminded: 0, skipped: "push_not_set_up" };
  const window = await getNotifyWindow(db);
  if (!isSendableNow(now, window, CALENDAR_DAY_TIME_ZONE)) return { reminded: 0, skipped: "outside_hours" };

  const due = await db.hubMessage.findMany({ where: dueWhere(now), select: { id: true, threadId: true }, orderBy: { createdAt: "asc" } });
  if (due.length === 0) return { reminded: 0, skipped: "none_due" };

  // Claim them. The conditions are asked again in the update, so a draft decided or reminded since is not touched.
  const claimed = await db.hubMessage.updateMany({
    where: { AND: [{ id: { in: due.map((d) => d.id) } }, dueWhere(now)] },
    data: { lastNotifiedAt: now, notifyCount: { increment: 1 } },
  });
  if (claimed.count === 0) return { reminded: 0, skipped: "none_due" };

  // A tap opens the longest-waiting draft's conversation.
  await notifyApprovers(claimed.count, due[0]!.threadId, db);
  return { reminded: claimed.count, skipped: null };
}
