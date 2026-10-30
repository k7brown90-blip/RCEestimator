/**
 * The email Kyle gets about a website booking chat (plan: "Email to Kyle").
 *
 * ONE email per chat that has a Lead, when the chat ends (end_conversation) or after IDLE_MINUTES
 * of silence (runBookingChatIdleSweep, a cron in server.ts). Idempotent: the BookingChat's
 * kyleNotifiedAt is CLAIMED with a conditional update before anything is sent, so two sweeps, or a
 * sweep racing end_conversation, cannot both send. A send that fails gives the claim back so the
 * next sweep retries.
 *
 * It is an OPERATOR email (sendKyleNotificationEmail), so the customer-send gate does not apply.
 *
 * sendKyleNotificationEmail interpolates its subject and body into HTML UNESCAPED, and this body
 * carries text a stranger typed into a website. Everything is escaped HERE, before the call —
 * existing callers of that function are unchanged.
 */

import { prisma } from "../../lib/prisma";
import { parseJsonArray, parseJsonStringArray } from "../../lib/json";
import { escapeHtml, sendKyleNotificationEmail } from "../confirmationEmail";
import { logSystemEvent } from "../systemEvents";
import { describeBlock } from "./scheduling";
import { IDLE_MINUTES } from "./limits";
import { leadLink } from "./leadLink";

interface ConcernRow {
  room?: unknown;
  description?: unknown;
  photoId?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Plain-text email body + subject for one chat. Exported so tests can read exactly what Kyle gets. */
export async function buildKyleEmail(chatId: string): Promise<{ subject: string; body: string } | null> {
  const chat = await prisma.bookingChat.findUnique({ where: { id: chatId }, include: { lead: true } });
  if (!chat || !chat.lead) return null;
  const lead = chat.lead;
  const photos = await prisma.leadPhoto.findMany({ where: { leadId: lead.id }, select: { kind: true } });
  const panelCount = photos.filter((p) => p.kind === "panel").length;

  const held = chat.heldStart && chat.heldEnd && chat.status === "held" ? describeBlock(chat.heldStart, chat.heldEnd) : null;
  const outcome = held
    ? `HELD ${held.label} (not yet confirmed)`
    : chat.status === "out_of_scope"
      ? "UNBOOKED — out of area / out of scope"
      : "UNBOOKED — call back";
  // Server-generated text only: nothing a visitor typed goes into the subject.
  const subject = `${chat.priority ? "PRIORITY — " : ""}Website chat lead: ${outcome}`;

  const lines: string[] = [];
  if (chat.priority) {
    lines.push(`PRIORITY — customer's exact words: "${chat.priorityQuote ?? ""}"`, "");
  }
  lines.push(`Outcome: ${outcome}`);
  lines.push(`Name: ${lead.name}`);
  lines.push(`Phone: ${lead.phone ?? "(not given)"}`);
  lines.push(`Email: ${lead.email ?? "(not given)"}`);
  lines.push(`Address: ${lead.address ?? "(not given)"}`);
  lines.push(`Request: ${chat.originalRequest ?? "(not given)"}`);
  lines.push(`Square footage: ${chat.squareFootage ?? "(not given)"}`);
  lines.push(`Year built: ${chat.yearBuilt ?? "(not given)"}`);

  const concerns = parseJsonArray<ConcernRow>(chat.concernsJson);
  lines.push(`Concerns (${concerns.length}):`);
  for (const c of concerns) {
    lines.push(`  - ${str(c.room) || "(room not given)"}: ${str(c.description)}${str(c.photoId) ? " [photo attached]" : ""}`);
  }
  const questions = parseJsonStringArray(chat.questionsJson);
  lines.push(`Questions for Kyle (${questions.length}):`);
  for (const q of questions) lines.push(`  - ${q}`);
  const prep = parseJsonStringArray(chat.prepAreasJson);
  lines.push(`Prep areas: ${prep.length ? prep.join("; ") : "(none)"}`);
  lines.push(`Photos: ${photos.length} (panel photo: ${panelCount > 0 ? "yes" : "not provided"})`);
  lines.push(`OK to text: ${lead.smsConsent === true ? "yes" : lead.smsConsent === false ? "no" : "not asked"}`);
  lines.push(`Source: ${chat.platform ?? "unknown"}${chat.srcParam ? ` (src=${chat.srcParam})` : ""}`);
  lines.push("");
  lines.push(`Lead id: ${lead.id}`);
  lines.push(`Open this lead (Website chat section): ${leadLink(lead.id)}`);

  return { subject: escapeHtml(subject), body: escapeHtml(lines.join("\n")) };
}

/**
 * Send Kyle the email for this chat if — and only if — it has a Lead and has not been emailed.
 * Returns true when THIS call sent it.
 */
export async function notifyKyleOnce(chatId: string): Promise<boolean> {
  const claimed = await prisma.bookingChat.updateMany({
    where: { id: chatId, kyleNotifiedAt: null, leadId: { not: null } },
    data: { kyleNotifiedAt: new Date() },
  });
  if (claimed.count === 0) return false;

  let sent = false;
  try {
    const email = await buildKyleEmail(chatId);
    if (email) sent = await sendKyleNotificationEmail(email.subject, email.body);
  } catch (err) {
    logSystemEvent("error", "bookingChat", "Email to Kyle threw", {
      chatId, error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!sent) {
    // Give the claim back so the next idle sweep retries instead of the lead going unannounced.
    await prisma.bookingChat.updateMany({ where: { id: chatId }, data: { kyleNotifiedAt: null } });
    logSystemEvent("warn", "bookingChat", "Email to Kyle was not sent — will retry on the next sweep", { chatId });
  }
  return sent;
}

/**
 * A hold made AFTER Kyle was already emailed about this chat (the visitor chatted, went quiet, the
 * 30-minute sweep told Kyle "UNBOOKED — call back", then came back and picked a time). Without
 * this he would keep calling back a customer who has a slot held. A short update, not a second
 * full lead email. Does nothing when Kyle has not been emailed yet — the one email will carry the
 * hold. Never throws: the visitor's turn must not fail because an email did.
 */
export async function notifyKyleHeldUpdate(chatId: string): Promise<boolean> {
  try {
    const chat = await prisma.bookingChat.findUnique({ where: { id: chatId }, include: { lead: true } });
    if (!chat || !chat.lead || !chat.kyleNotifiedAt) return false;
    if (chat.status !== "held" || !chat.heldStart || !chat.heldEnd) return false;
    const held = describeBlock(chat.heldStart, chat.heldEnd);
    const lead = chat.lead;
    const lines = [
      `Update: this customer has now HELD ${held.label} (not yet confirmed).`,
      "Earlier you were told this chat was UNBOOKED. Confirm booking or Release hold from the lead.",
      "",
      `Name: ${lead.name}`,
      `Phone: ${lead.phone ?? "(not given)"}`,
      `Address: ${lead.address ?? "(not given)"}`,
      "",
      `Open this lead: ${leadLink(lead.id)}`,
    ];
    return await sendKyleNotificationEmail(escapeHtml(`Website chat lead: now HELD ${held.label}`), escapeHtml(lines.join("\n")));
  } catch (err) {
    logSystemEvent("error", "bookingChat", "Held-update email to Kyle threw", {
      chatId, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Chats older than this are not retried — Kyle sees them on the Leads page. */
const SWEEP_LOOKBACK_MS = 3 * 86_400_000;

/**
 * The idle sweep (cron every 10 minutes in server.ts): email Kyle about every chat that has a Lead
 * and has been quiet for IDLE_MINUTES. Confirmed/released chats are skipped — Kyle already acted.
 * Exported without the cron so tests can call it directly.
 */
export async function runBookingChatIdleSweep(now: Date = new Date()): Promise<{ notified: number }> {
  const idleBefore = new Date(now.getTime() - IDLE_MINUTES * 60_000);
  const chats = await prisma.bookingChat.findMany({
    where: {
      leadId: { not: null },
      kyleNotifiedAt: null,
      status: { in: ["open", "unbooked", "held", "out_of_scope"] },
      lastActivityAt: { lt: idleBefore, gt: new Date(now.getTime() - SWEEP_LOOKBACK_MS) },
    },
    select: { id: true },
    orderBy: { lastActivityAt: "asc" },
    take: 50,
  });
  let notified = 0;
  for (const c of chats) {
    if (await notifyKyleOnce(c.id)) notified += 1;
  }
  return { notified };
}
