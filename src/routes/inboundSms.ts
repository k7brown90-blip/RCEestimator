/**
 * Inbound SMS/MMS routing — the Twilio messaging webhook.
 *
 * Every message is matched against known senders and routed:
 * - Kyle            → dispatch log (existing behavior) or MMS receipt capture
 * - Known tech      → MMS receipt capture, or text logged as a job note
 * - Known customer  → confirmation keyword parsing (YES / RESCHEDULE / NO)
 *                     against their next upcoming visit, else forwarded to Kyle
 * - Unknown         → forwarded to Kyle with sender context
 *
 * Twilio expects a TwiML response; we return an empty <Response/> and do our
 * own outbound replies via the REST API (keeps reply logic in one place).
 */

import express from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "./agent-helpers";
import { sendSms, KYLE_PHONE, isFromKyle, fetchTwilioMedia } from "../services/twilio";
import { parseReceiptImage } from "../services/receiptVision";
import { applyConfirmationAction, type ConfirmationAction } from "../services/visitConfirmations";
import { findCustomerMatches, phoneDigits10 } from "../services/customerMatch";
import { customerSendsEnabled, logCustomerSendSkipped } from "../services/automationGate";

export const inboundSmsRouter = express.Router();

const TZ = "America/Chicago";

const last10 = (phone: string): string => phoneDigits10(phone) ?? "";

function formatWhen(d: Date): string {
  return `${d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" })} at ${d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" })}`;
}

/** Parse a customer reply into a confirmation action, or null when free-form. */
export function parseConfirmationKeyword(body: string): ConfirmationAction | null {
  const text = body.trim().toUpperCase();
  if (/^(YES|Y|CONFIRM|CONFIRMED|C)\b/.test(text)) return "confirm";
  if (/^(RESCHEDULE|CHANGE|MOVE|R)\b/.test(text)) return "reschedule";
  if (/^(NO|N|CANCEL|CANCELLED)\b/.test(text)) return "cancel";
  return null;
}

async function matchTechnician(from10: string) {
  if (!from10) return null;
  const techs = await prisma.technician.findMany({ where: { isActive: true, phone: { not: null } } });
  return techs.find((t) => last10(t.phone!) === from10) ?? null;
}

/**
 * The best-scoring account for an inbound number.
 *
 * This route's last-4-narrow-then-confirm-in-JS approach is what
 * services/customerMatch.ts generalized, so it now calls the shared version
 * rather than keeping a second copy of the strategy.
 */
async function matchCustomer(from10: string) {
  if (!from10) return null;
  const [best] = await findCustomerMatches({ phone: from10, limit: 1 });
  if (!best) return null;
  return prisma.customer.findUnique({ where: { id: best.customerId } });
}

/** Extract Twilio media URLs from the webhook payload. */
function mediaUrls(body: Record<string, unknown>): string[] {
  const num = Number(body.NumMedia ?? body.numMedia ?? 0);
  const urls: string[] = [];
  for (let i = 0; i < num; i += 1) {
    const url = body[`MediaUrl${i}`];
    if (typeof url === "string") urls.push(url);
  }
  return urls;
}

/** Capture MMS attachments from a trusted sender (Kyle or a tech) as receipts. */
async function captureReceipts(
  urls: string[],
  senderPhone: string,
  technicianId: string | null,
  noteText: string,
): Promise<{ captured: number; summaries: string[] }> {
  let captured = 0;
  const summaries: string[] = [];

  for (const url of urls) {
    const media = await fetchTwilioMedia(url);
    if (!media || !media.contentType.startsWith("image/")) continue;

    const parsed = await parseReceiptImage(media.buffer, media.contentType);
    const receipt = await prisma.receipt.create({
      data: {
        category: parsed?.category ?? "overhead",
        vendor: parsed?.vendor ?? null,
        amount: parsed?.total ?? 0,
        lineItems: parsed && parsed.lineItems.length > 0 ? JSON.stringify(parsed.lineItems) : null,
        source: "mms",
        status: "pending_review",
        technicianId,
        imageData: media.buffer,
        imageMime: media.contentType,
        ...(parsed?.purchaseDate ? { receivedAt: new Date(`${parsed.purchaseDate}T12:00:00Z`) } : {}),
      },
    });
    captured += 1;
    summaries.push(
      parsed?.total != null
        ? `$${parsed.total.toFixed(2)} ${parsed.category}${parsed.vendor ? ` — ${parsed.vendor}` : ""}`
        : `unreadable — saved for manual review (${receipt.id.slice(-6)})`,
    );
  }

  if (captured > 0) {
    const ack = `Receipt${captured === 1 ? "" : "s"} logged: ${summaries.join("; ")}. ${noteText ? `Note: "${noteText}". ` : ""}Review & confirm in the CRM.`;
    // Reply to the sender's own MMS — Kyle or a tech, never a campaign message.
    await sendSms(senderPhone, ack, { bypassConsentCheck: true }).catch(() => {});
  }
  return { captured, summaries };
}

inboundSmsRouter.post("/sms/inbound", asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const from = String(body.From ?? body.from ?? "");
  const text = String(body.Body ?? body.body ?? "").trim();
  const urls = mediaUrls(body);
  const from10 = last10(from);

  // Twilio is satisfied with an empty TwiML response; replies go via REST.
  const respond = () => {
    res.type("text/xml").send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
  };

  const log = async (matchType: string, matchId: string | null, handledAs: string) => {
    await prisma.inboundMessage.create({
      data: { fromPhone: from, body: text.slice(0, 2000), numMedia: urls.length, matchType, matchId, handledAs },
    }).catch((err) => console.error("[InboundSMS] Log failed:", err));
  };

  if (!from10) {
    await log("unknown", null, "ignored");
    respond();
    return;
  }

  // ── Opt-out / opt-in keywords ──────────────────────────────────────
  // Twilio already blocks delivery after STOP at the carrier level (and sends
  // the mandated confirmation itself — no reply here). Recording it keeps our
  // consent records true, which is what the send gate in services/twilio.ts
  // reads and what A2P registration attests to. Applied to every Customer and
  // Lead sharing the number — consent belongs to the person, not the row.
  const optKeyword = /^(STOP|STOPALL|UNSUBSCRIBE|QUIT|END|REVOKE)$/i.test(text)
    ? false
    : /^(START|UNSTOP|YES\s+SUBSCRIBE)$/i.test(text)
      ? true
      : null;
  if (optKeyword !== null && !isFromKyle(from)) {
    // Match in JS on normalized digits — stored formats vary, so a SQL
    // `contains` on digits would miss punctuated rows.
    const [customers, leads] = await Promise.all([
      prisma.customer.findMany({ where: { phone: { not: null } }, select: { id: true, phone: true } }),
      prisma.lead.findMany({ where: { phone: { not: null } }, select: { id: true, phone: true } }),
    ]);
    const customerIds = customers.filter((c) => last10(c.phone!) === from10).map((c) => c.id);
    const leadIds = leads.filter((l) => last10(l.phone!) === from10).map((l) => l.id);
    await Promise.all([
      customerIds.length > 0 ? prisma.customer.updateMany({ where: { id: { in: customerIds } }, data: { smsConsent: optKeyword } }) : null,
      leadIds.length > 0 ? prisma.lead.updateMany({ where: { id: { in: leadIds } }, data: { smsConsent: optKeyword } }) : null,
    ]);
    await log(customerIds.length > 0 ? "customer" : "unknown", customerIds[0] ?? null, optKeyword ? "opt_in" : "opt_out");
    respond();
    return;
  }

  // ── Kyle ──────────────────────────────────────────────────────────────────
  if (isFromKyle(from)) {
    if (urls.length > 0) {
      const { captured } = await captureReceipts(urls, from, null, text);
      await log("kyle", null, captured > 0 ? "receipt" : "ignored");
    } else {
      console.log(`[SMS] From Kyle: ${text}`);
      await log("kyle", null, "kyle_dispatch");
    }
    respond();
    return;
  }

  // ── Known technician ─────────────────────────────────────────────────────
  const tech = await matchTechnician(from10);
  if (tech) {
    if (urls.length > 0) {
      const { captured } = await captureReceipts(urls, from, tech.id, text);
      await log("technician", tech.id, captured > 0 ? "receipt" : "ignored");
      respond();
      return;
    }

    // Text from a tech → append as a note on their most recent active assignment
    const assignment = await prisma.visitAssignment.findFirst({
      where: { technicianId: tech.id, status: { in: ["assigned", "in_progress"] } },
      orderBy: { assignedAt: "desc" },
      include: { visit: { include: { customer: { select: { name: true } } } } },
    });

    if (assignment) {
      const stamp = new Date().toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const note = `[${stamp} — ${tech.name} via SMS] ${text}`;
      await prisma.visit.update({
        where: { id: assignment.visitId },
        data: { notes: assignment.visit.notes ? `${assignment.visit.notes}\n${note}` : note },
      });
      await sendSms(from, `Noted on the ${assignment.visit.customer.name} job. — Red Cedar Electric`, { bypassConsentCheck: true }).catch(() => {});
      await sendSms(KYLE_PHONE, `TECH NOTE — ${tech.name} on ${assignment.visit.customer.name}: "${text}"`).catch(() => {});
      await log("technician", tech.id, "tech_note");
    } else {
      await sendSms(KYLE_PHONE, `TECH SMS (no active job) — ${tech.name}: "${text}"`).catch(() => {});
      await log("technician", tech.id, "forwarded");
    }
    respond();
    return;
  }

  // ── Known customer ───────────────────────────────────────────────────────
  const customer = await matchCustomer(from10);
  if (customer) {
    const action = parseConfirmationKeyword(text);
    if (action) {
      const upcoming = await prisma.visit.findFirst({
        where: {
          customerId: customer.id,
          scheduledStart: { gte: new Date() },
          status: { notIn: ["cancelled", "completed"] },
        },
        orderBy: { scheduledStart: "asc" },
      });

      if (upcoming) {
        const outcome = await applyConfirmationAction(upcoming.id, action, "sms_reply");
        const when = upcoming.scheduledStart ? formatWhen(upcoming.scheduledStart) : "your appointment";
        const replies: Record<ConfirmationAction, string> = {
          confirm: `You're confirmed for ${when}. See you then! — Red Cedar Electric`,
          reschedule: `Got it — we'll call you shortly to arrange a new time. — Red Cedar Electric`,
          cancel: `Understood — we've flagged your cancellation request and will follow up to confirm. — Red Cedar Electric`,
        };
        // Direct reply to a message they just sent — answering an inbound text
        // is permitted even for a recipient whose broadcast consent is false.
        //
        // GATED (manual-first, 2026-08-11): consent is not the question here — automation is.
        // The customer's action still lands in the CRM and Kyle is still forwarded the text
        // below, so nothing is lost; he answers it himself rather than the system answering
        // for him.
        if (customerSendsEnabled("inboundAutoReply")) {
          await sendSms(from, replies[outcome.action], { bypassConsentCheck: true }).catch(() => {});
        } else {
          logCustomerSendSkipped("inboundAutoReply", `Auto-reply to ${outcome.action} from customer ${customer.id} suppressed; Kyle still notified.`);
          await sendSms(KYLE_PHONE, `CUSTOMER ${outcome.action.toUpperCase()} — ${customer.name} (${from}). Auto-reply is OFF; reply manually.`).catch(() => {});
        }
        await log("customer", customer.id, "confirmation_reply");
        respond();
        return;
      }
    }

    // Free-form customer text (or keyword with no upcoming visit) → forward
    await sendSms(KYLE_PHONE, `CUSTOMER SMS — ${customer.name} (${from}): "${text}"`).catch(() => {});
    await log("customer", customer.id, "forwarded");
    respond();
    return;
  }

  // ── Unknown sender ───────────────────────────────────────────────────────
  await sendSms(KYLE_PHONE, `UNKNOWN SMS — ${from}: "${text}"${urls.length > 0 ? ` (+${urls.length} attachment${urls.length === 1 ? "" : "s"})` : ""}`).catch(() => {});
  await log("unknown", null, "forwarded");
  respond();
}));
