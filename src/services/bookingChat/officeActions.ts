/**
 * What the OFFICE does with a website booking chat, from the lead's drawer (plan
 * 2026-10-30-website-booking-chat, U3, decision A): Confirm booking, Release hold, delete a photo,
 * and the clean-up when a lead that holds a slot goes away.
 *
 * Every function here answers with an outcome ({ok:true,...} | {ok:false,status,body}) instead of
 * throwing, because the routes in app.ts turn it straight into an HTTP answer and the duplicate-
 * account refusal is a QUESTION for the drawer, not an error.
 *
 * THE HOLD IS A REAL EVENT ON GOOGLE CALENDAR. Every path that ends a chat's hold must also remove
 * that event, or a slot nobody is coming for stays blocked forever:
 *   - Confirm booking     → the hold becomes the job's own event (this file)
 *   - Release hold        → releaseHold()
 *   - Delete the lead     → deleteHoldForLead() (called from DELETE /leads/:leadId)
 *   - Mark the lead lost  → releaseHoldIfHeld() (called from both lost routes)
 *   - Visitor re-picks    → holdSlotForChat() in scheduling.ts, which deletes the old one (U2)
 */

import crypto from "node:crypto";
import type { BookingChat, Lead } from "@prisma/client";
import type { ConvertLeadInput, ConvertLeadOutcome } from "../../app";
import { prisma } from "../../lib/prisma";
import { parseJsonArray, parseJsonStringArray } from "../../lib/json";
import { escapeHtml, sendKyleNotificationEmail } from "../confirmationEmail";
import { deleteCalendarEvent } from "../schedule";
import { scheduleJob } from "../scheduling";
import { logSystemEvent } from "../systemEvents";
import { describeBlock } from "./scheduling";
import { jobLink } from "./leadLink";

export type ActionOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; status: number; body: Record<string, unknown> };

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): { ok: false; status: number; body: Record<string, unknown> } =>
  ({ ok: false, status, body: { error, ...extra } });

const TZ = "America/Chicago";
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Google answers 404 / 410 for an event that is already gone — which is the state we wanted. */
function isGone(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  return [e?.code, e?.status, e?.response?.status].some((c) => c === 404 || c === 410);
}

/** Delete one calendar event. Returns "removed" (including already gone) or the error text. */
async function removeEvent(eventId: string): Promise<"removed" | string> {
  try {
    await deleteCalendarEvent(eventId);
    return "removed";
  } catch (err) {
    if (isGone(err)) return "removed";
    return err instanceof Error ? err.message : String(err);
  }
}

/** Central-Time date (YYYY-MM-DD) and clock ("HH:MM") for scheduleJob(). */
function centralDateAndTime(d: Date): { date: string; time: string } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date, time: `${get("hour")}:${get("minute")}` };
}

// ── Confirm booking ──────────────────────────────────────────────────────────

export interface ConfirmBookingResult {
  visitId: string;
  customerId: string;
  scheduledStart: string;
  scheduledEnd: string;
  label: string;
  photosCopied: number;
  /** The address the confirmation email went to, or null when the account has no email. */
  customerEmail: string | null;
  kyleEmailed: boolean;
  /** Things that did not stop the booking but the office should know. */
  warnings: string[];
}

/** One confirm per lead at a time — a double-click must not convert and schedule twice. */
const confirming = new Set<string>();

/** A deterministic, UUID-shaped id so copying the same photo twice is a no-op, not a duplicate. */
function visitPhotoIdFor(leadPhotoId: string): string {
  const h = crypto.createHash("sha1").update(`lead-photo:${leadPhotoId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

interface ConcernRow { room?: unknown; description?: unknown; photoId?: unknown }

/**
 * ONE server operation:
 *   1. convert the lead through the EXISTING path (same duplicate-account refusal) — a refusal
 *      writes NOTHING, so the hold stays and no photo is copied;
 *   2. schedule the job at the held time through scheduleJob() as an estimate; its customer
 *      confirmation email carries the prep reminder;
 *   3. remove the HOLD event;
 *   4. copy the lead's photos onto the visit so they are in the field app;
 *   5. mark the chat confirmed, and email Kyle the appointment.
 *
 * ORDER NOTE (a deliberate change to the brief, reported): the hold is removed AFTER the job is
 * scheduled, not before. An estimate booking does not consult the calendar (scheduleJob skips the
 * availability check for estimates), so the hold cannot block its own confirmation; and removing
 * it first meant a failed schedule left the customer with NEITHER unless the hold was re-created
 * — which fails the same way when Google is the thing that is down. This way a failed schedule
 * never touches the hold.
 *
 * RETRYABLE. If conversion succeeded but scheduling failed, the lead is converted with a job that
 * has no time yet; pressing Confirm booking again carries on with that job instead of refusing
 * "already converted".
 */
export async function confirmBooking(
  leadId: string,
  convert: (leadId: string, input: ConvertLeadInput) => Promise<ConvertLeadOutcome>,
  convertInput: ConvertLeadInput,
): Promise<ActionOutcome<ConfirmBookingResult>> {
  const chat = await prisma.bookingChat.findUnique({ where: { leadId }, include: { lead: true } });
  if (!chat || !chat.lead) return fail(404, "This lead has no website chat to confirm.");
  if (chat.status !== "held" || !chat.heldStart || !chat.heldEnd) {
    return fail(409, chat.status === "confirmed"
      ? "This booking is already confirmed."
      : "There is no held time on this lead to confirm.");
  }
  if (confirming.has(leadId)) return fail(409, "This booking is already being confirmed.");
  confirming.add(leadId);
  try {
    return await confirmLocked(chat, convert, convertInput);
  } finally {
    confirming.delete(leadId);
  }
}

type ChatWithLead = BookingChat & { lead: Lead | null };

async function confirmLocked(
  chat: ChatWithLead,
  convert: (leadId: string, input: ConvertLeadInput) => Promise<ConvertLeadOutcome>,
  convertInput: ConvertLeadInput,
): Promise<ActionOutcome<ConfirmBookingResult>> {
  const lead = chat.lead!;
  const heldStart = chat.heldStart!;
  const heldEnd = chat.heldEnd!;
  const warnings: string[] = [];

  // ── 1. Convert (or carry on with a job an earlier attempt already made) ──────────────────
  let visitId: string;
  let customerId: string;
  if (lead.status === "converted") {
    if (!lead.visitId || !lead.customerId) {
      return fail(409, "This lead is marked converted but has no job. Open the job from the lead, or release the hold.");
    }
    visitId = lead.visitId;
    customerId = lead.customerId;
  } else {
    const outcome = await convert(lead.id, convertInput);
    // Duplicate account (409 + matches) or no usable address (400): nothing was written.
    if (!outcome.ok) return { ok: false, status: outcome.status, body: outcome.body };
    if (!outcome.result.visit) {
      return fail(409, "The lead was converted but no job was created, so there is nothing to schedule. Open the lead and add its address.");
    }
    visitId = outcome.result.visit.id;
    customerId = outcome.result.customer.id;
  }

  // ── 2. Schedule at the held time ─────────────────────────────────────────────────────────
  const existing = await prisma.visit.findUnique({ where: { id: visitId }, select: { scheduledStart: true, googleEventId: true } });
  if (!existing) return fail(409, "The job for this lead no longer exists.", { converted: true });
  const prepAreas = parseJsonStringArray(chat.prepAreasJson);

  if (existing.scheduledStart && existing.scheduledStart.getTime() !== heldStart.getTime()) {
    const when = describeBlock(existing.scheduledStart, new Date(existing.scheduledStart.getTime() + 2 * 3_600_000)).label;
    return fail(409, `This lead's job is already scheduled for ${when}, not the held time. Use Release hold to drop the hold, or reschedule the job on the Calendar.`, {
      converted: true, visitId,
    });
  }
  if (!existing.scheduledStart) {
    const { date, time } = centralDateAndTime(heldStart);
    try {
      await scheduleJob(visitId, date, time, null, null, { prepAreas });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSystemEvent("error", "bookingChat", "Confirm booking: the job could not be scheduled — the hold is untouched", {
        leadId: lead.id, visitId, error: message,
      });
      return fail(502, `The lead was converted, but the job could not be scheduled: ${message}. The hold is still in place — press Confirm booking again to retry.`, {
        converted: true, visitId,
      });
    }
  }

  // ── 3. The HOLD has done its job; remove it so the calendar shows ONE event ──────────────
  let clearedEventId = true;
  if (chat.heldEventId) {
    const removed = await removeEvent(chat.heldEventId);
    if (removed !== "removed") {
      clearedEventId = false;
      warnings.push("The job is booked, but the old HOLD event could not be removed from Google Calendar — delete the event that starts with \"HOLD:\" by hand.");
      logSystemEvent("error", "bookingChat", "Confirm booking: HOLD event could not be deleted — remove it from the calendar by hand", {
        leadId: lead.id, eventId: chat.heldEventId, error: removed,
      });
    }
  }

  // ── 4 + 5. Photos onto the visit, chat confirmed — together ───────────────────────────────
  const concerns = parseJsonArray<ConcernRow>(chat.concernsJson);
  const photos = await prisma.leadPhoto.findMany({ where: { leadId: lead.id }, orderBy: { uploadedAt: "asc" } });
  const rows = photos.map((p) => {
    const concern = concerns.find((c) => str(c.photoId) === p.id);
    const room = p.room ?? (concern ? str(concern.room) : "");
    const what = p.kind === "panel" ? "Electrical panel (homeowner's photo)" : (str(concern?.description) || p.caption || "");
    return {
      id: visitPhotoIdFor(p.id),
      visitId,
      technicianId: null,
      mimeType: p.mimeType,
      sizeBytes: p.sizeBytes,
      caption: [p.kind === "panel" ? null : room, what].filter(Boolean).join(" — ") || null,
      tag: "reference",
      data: p.data,
      uploadedAt: p.uploadedAt,
    };
  });
  let photosCopied = 0;
  try {
    const [copied] = await prisma.$transaction([
      prisma.visitPhoto.createMany({ data: rows, skipDuplicates: true }),
      prisma.bookingChat.update({
        where: { id: chat.id },
        data: {
          status: "confirmed",
          confirmedAt: new Date(),
          ...(clearedEventId ? { heldEventId: null } : {}),
        },
      }),
    ]);
    photosCopied = copied.count;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logSystemEvent("error", "bookingChat", "Confirm booking: job is scheduled but photos/status could not be saved", {
      leadId: lead.id, visitId, error: message,
    });
    return fail(502, `The job is booked at the held time, but saving the photos failed: ${message}. Press Confirm booking again to finish.`, {
      converted: true, visitId,
    });
  }

  // ── 6. Kyle's copy of the appointment (an operator email — not behind the customer-send gate) ──
  const visit = await prisma.visit.findUnique({ where: { id: visitId }, include: { customer: true, property: true } });
  const parts = describeBlock(heldStart, heldEnd);
  const prep = prepAreas;
  const lines: string[] = [];
  if (chat.priority) lines.push(`PRIORITY — customer's exact words: "${chat.priorityQuote ?? ""}"`, "");
  lines.push(`Booking CONFIRMED: ${parts.label}`);
  lines.push(`Name: ${visit?.customer.name ?? lead.name}`);
  lines.push(`Phone: ${visit?.customer.phone ?? lead.phone ?? "(not given)"}`);
  lines.push(`Email: ${visit?.customer.email ?? lead.email ?? "(not given)"}`);
  lines.push(`Address: ${visit ? `${visit.property.addressLine1}, ${visit.property.city}, ${visit.property.state} ${visit.property.postalCode}` : lead.address ?? "(not given)"}`);
  lines.push(`Request: ${chat.originalRequest ?? "(not given)"}`);
  lines.push(`Prep areas: ${prep.length ? prep.join("; ") : "(none)"}`);
  lines.push(`Photos on the job: ${photosCopied}`);
  lines.push("");
  lines.push(`Open the job: ${jobLink(visitId)}`);
  let kyleEmailed = false;
  try {
    kyleEmailed = await sendKyleNotificationEmail(escapeHtml(`Booking confirmed: ${parts.label}`), escapeHtml(lines.join("\n")));
  } catch (err) {
    logSystemEvent("error", "bookingChat", "Confirm booking: email to Kyle threw", {
      leadId: lead.id, error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!kyleEmailed) warnings.push("Your confirmation email could not be sent (the booking itself is done).");

  const customerEmail = visit?.customer.email ?? null;
  if (!customerEmail) warnings.push("This account has no email address, so no confirmation email went to the customer.");

  return {
    ok: true,
    result: {
      visitId,
      customerId,
      scheduledStart: heldStart.toISOString(),
      scheduledEnd: heldEnd.toISOString(),
      label: parts.label,
      photosCopied,
      customerEmail,
      kyleEmailed,
      warnings,
    },
  };
}

// ── Release hold ─────────────────────────────────────────────────────────────

/**
 * Delete the HOLD event, mark the chat released, keep the lead. If Google refuses (anything but
 * "already gone"), NOTHING changes — the hold really is still there and the office can retry.
 */
export async function releaseHold(leadId: string): Promise<ActionOutcome<{ released: true }>> {
  const chat = await prisma.bookingChat.findUnique({ where: { leadId } });
  if (!chat) return fail(404, "This lead has no website chat.");
  if (chat.status !== "held") return fail(409, "There is no held time on this lead to release.");

  if (chat.heldEventId) {
    const removed = await removeEvent(chat.heldEventId);
    if (removed !== "removed") {
      logSystemEvent("error", "bookingChat", "Release hold: the calendar event could not be deleted — nothing changed", {
        leadId, eventId: chat.heldEventId, error: removed,
      });
      return fail(502, `Google Calendar would not remove the hold (${removed}). Nothing was changed — try again in a moment.`);
    }
  }
  await prisma.bookingChat.update({
    where: { id: chat.id },
    data: { status: "released", releasedAt: new Date(), heldEventId: null, heldStart: null, heldEnd: null },
  });
  return { ok: true, result: { released: true } };
}

/**
 * For a path that is ending the lead's life anyway (marked lost): drop a live hold, best effort.
 * Never throws and never blocks the caller — a failed delete is logged with the event id so the
 * leaked HOLD can be removed by hand.
 */
export async function releaseHoldIfHeld(leadId: string): Promise<void> {
  try {
    const chat = await prisma.bookingChat.findUnique({ where: { leadId } });
    if (!chat || chat.status !== "held") return;
    if (chat.heldEventId) {
      const removed = await removeEvent(chat.heldEventId);
      if (removed !== "removed") {
        logSystemEvent("error", "bookingChat", "A lead with a held slot was closed but its HOLD event could not be deleted — remove it from the calendar by hand", {
          leadId, eventId: chat.heldEventId, error: removed,
        });
        return;
      }
    }
    await prisma.bookingChat.update({
      where: { id: chat.id },
      data: { status: "released", releasedAt: new Date(), heldEventId: null, heldStart: null, heldEnd: null },
    });
  } catch (err) {
    logSystemEvent("error", "bookingChat", "releaseHoldIfHeld threw", { leadId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Before the lead row is deleted: the cascade removes the BookingChat but not the Google event, so
 * a held slot would stay blocked forever. A failed event delete is logged and the lead is deleted
 * anyway (Kyle's instruction: the office asked to delete it, and the hold is findable in the log).
 */
export async function deleteHoldForLead(leadId: string): Promise<void> {
  try {
    const chat = await prisma.bookingChat.findUnique({ where: { leadId }, select: { status: true, heldEventId: true } });
    if (!chat?.heldEventId || chat.status !== "held") return;
    const removed = await removeEvent(chat.heldEventId);
    if (removed !== "removed") {
      logSystemEvent("error", "bookingChat", "Lead deleted but its HOLD event could not be deleted — remove it from the calendar by hand", {
        leadId, eventId: chat.heldEventId, error: removed,
      });
    }
  } catch (err) {
    logSystemEvent("error", "bookingChat", "deleteHoldForLead threw", { leadId, error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Photos ───────────────────────────────────────────────────────────────────

/**
 * Delete one of the lead's photos and take its id out of the concerns that point at it, so
 * nothing dangles. The photo must belong to THIS lead. Photos already copied onto a job are the
 * job's own and are not touched.
 */
export async function deleteLeadPhoto(leadId: string, photoId: string): Promise<ActionOutcome<{ deleted: true }>> {
  const photo = await prisma.leadPhoto.findFirst({ where: { id: photoId, leadId }, select: { id: true } });
  if (!photo) return fail(404, "Photo not found on this lead.");
  const chat = await prisma.bookingChat.findUnique({ where: { leadId }, select: { id: true, concernsJson: true } });

  await prisma.$transaction(async (tx) => {
    await tx.leadPhoto.delete({ where: { id: photoId } });
    if (chat) {
      const concerns = parseJsonArray<ConcernRow & Record<string, unknown>>(chat.concernsJson).map((c) => {
        if (str(c.photoId) !== photoId) return c;
        const { photoId: _removed, ...rest } = c;
        return rest;
      });
      await tx.bookingChat.update({ where: { id: chat.id }, data: { concernsJson: JSON.stringify(concerns) } });
    }
  });
  return { ok: true, result: { deleted: true } };
}

// ── What the drawer reads ────────────────────────────────────────────────────

export interface LeadChatView {
  bookingChat: {
    id: string;
    status: string;
    srcParam: string | null;
    platform: string | null;
    priority: boolean;
    priorityQuote: string | null;
    originalRequest: string | null;
    squareFootage: string | null;
    yearBuilt: string | null;
    concerns: Array<{ room: string; description: string; photoId: string | null }>;
    questionsForKyle: string[];
    prepAreas: string[];
    transcript: Array<{ role: string; content: string; at: string }>;
    heldStart: string | null;
    heldEnd: string | null;
    /** "Tuesday, November 3, 8:00 AM – 10:00 AM" in Central Time, worded by the server. */
    heldLabel: string | null;
    messageCount: number;
    lastActivityAt: string;
    kyleNotifiedAt: string | null;
    confirmedAt: string | null;
    releasedAt: string | null;
    createdAt: string;
  } | null;
  /** Metadata only — the bytes come from GET /leads/:leadId/photos/:photoId. */
  photos: Array<{ id: string; kind: string; room: string | null; caption: string | null; mimeType: string; sizeBytes: number; uploadedAt: string }>;
}

/**
 * The chat and photo metadata for one lead. NEVER the photo bytes, and never the chat's `token`
 * (the capability the website holds to keep talking to it) or the hashed visitor IP — the office
 * has no use for either.
 */
export async function loadLeadChatView(leadId: string): Promise<LeadChatView> {
  const [chat, photos] = await Promise.all([
    prisma.bookingChat.findUnique({ where: { leadId } }),
    prisma.leadPhoto.findMany({
      where: { leadId },
      select: { id: true, kind: true, room: true, caption: true, mimeType: true, sizeBytes: true, uploadedAt: true },
      orderBy: { uploadedAt: "asc" },
    }),
  ]);
  const photoView = photos.map((p) => ({ ...p, uploadedAt: p.uploadedAt.toISOString() }));
  if (!chat) return { bookingChat: null, photos: photoView };

  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    bookingChat: {
      id: chat.id,
      status: chat.status,
      srcParam: chat.srcParam,
      platform: chat.platform,
      priority: chat.priority,
      priorityQuote: chat.priorityQuote,
      originalRequest: chat.originalRequest,
      squareFootage: chat.squareFootage,
      yearBuilt: chat.yearBuilt,
      concerns: parseJsonArray<ConcernRow>(chat.concernsJson).map((c) => ({
        room: str(c.room), description: str(c.description), photoId: str(c.photoId) || null,
      })),
      questionsForKyle: parseJsonStringArray(chat.questionsJson),
      prepAreas: parseJsonStringArray(chat.prepAreasJson),
      transcript: parseJsonArray<Record<string, unknown>>(chat.transcriptJson).map((t) => ({
        role: str(t.role), content: str(t.content), at: str(t.at),
      })),
      heldStart: iso(chat.heldStart),
      heldEnd: iso(chat.heldEnd),
      heldLabel: chat.heldStart && chat.heldEnd ? describeBlock(chat.heldStart, chat.heldEnd).label : null,
      messageCount: chat.messageCount,
      lastActivityAt: chat.lastActivityAt.toISOString(),
      kyleNotifiedAt: iso(chat.kyleNotifiedAt),
      confirmedAt: iso(chat.confirmedAt),
      releasedAt: iso(chat.releasedAt),
      createdAt: chat.createdAt.toISOString(),
    },
    photos: photoView,
  };
}
