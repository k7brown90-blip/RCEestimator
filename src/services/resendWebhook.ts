/**
 * Resend delivery events → EmailDelivery status, EmailBounce rows, estimate bounce flags.
 *
 * Kyle, 2026-09-09: *"I need the emails working, very few are actually getting through, this is
 * priority number one."* Transactional email now leaves Resend-first (services/transactionalEmail.ts).
 * Resend reports what became of each message by webhook — sent, delivered, delivery_delayed,
 * bounced, complained (opened / clicked exist too and are ignored: they say nothing about
 * delivery and a scanner opens more mail than a customer does). This is the receiver.
 *
 * ── SIGNATURE ────────────────────────────────────────────────────────────────
 * Resend signs with Svix. Headers `svix-id`, `svix-timestamp`, `svix-signature`; the secret is
 * RESEND_WEBHOOK_SECRET = "whsec_<base64>". Signed content is `${id}.${timestamp}.${rawBody}`,
 * HMAC-SHA256 with the base64-DECODED secret, base64 output. The signature header may carry
 * several space-separated `v1,<sig>` entries (key rotation) — any match accepts. Timestamps more
 * than five minutes from now are refused (replay). Done by hand with node:crypto; no dependency.
 *
 * Verification runs over the RAW bytes, so app.ts mounts this route with express.raw BEFORE
 * express.json — the same placement as /stripe/webhook.
 *
 * ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
 * Svix retries. A status update is a monotonic write (a late "sent" never overwrites
 * "delivered"); a bounce is filed once per Resend email id (unique providerMessageId) and its
 * WARN SystemEvent is written only when the row is new.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { logSystemEvent } from "./systemEvents";
import type { DeliveryStatus, EmailKind } from "./transactionalEmail";

export const SVIX_TOLERANCE_SECONDS = 5 * 60;
const REASON_MAX = 300;
/** A webhook can beat the EmailDelivery write for the same send by a few hundred ms. */
const LOOKUP_RETRY_MS = 1500;

export interface SvixHeaders {
  id?: string | null;
  timestamp?: string | null;
  signature?: string | null;
}

export interface ResendEvent {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    created_at?: string;
    from?: string;
    to?: string[] | string;
    subject?: string;
    bounce?: { message?: string; subType?: string; type?: string };
    tags?: Record<string, string>;
  };
}

export type SvixVerification = { ok: true } | { ok: false; reason: string };

/** Pure: the Svix check, injectable clock for the tests. */
export function verifySvixSignature(
  rawBody: Buffer | string,
  headers: SvixHeaders,
  secret: string,
  nowMs: number = Date.now(),
): SvixVerification {
  const id = headers.id?.trim();
  const ts = headers.timestamp?.trim();
  const sig = headers.signature?.trim();
  if (!id || !ts || !sig) return { ok: false, reason: "Missing svix-id, svix-timestamp or svix-signature header." };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "svix-timestamp is not a number." };
  const skew = Math.abs(nowMs / 1000 - tsNum);
  if (skew > SVIX_TOLERANCE_SECONDS) return { ok: false, reason: "svix-timestamp is outside the five-minute window." };

  const keyB64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(keyB64, "base64");
  } catch {
    return { ok: false, reason: "RESEND_WEBHOOK_SECRET is not valid base64." };
  }
  if (key.length === 0) return { ok: false, reason: "RESEND_WEBHOOK_SECRET is empty." };

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const signed = Buffer.concat([Buffer.from(`${id}.${ts}.`, "utf8"), body]);
  const expected = createHmac("sha256", key).update(signed).digest();

  for (const entry of sig.split(/\s+/)) {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) continue;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(value, "base64");
    } catch {
      continue;
    }
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return { ok: true };
  }
  return { ok: false, reason: "No v1 signature matched." };
}

/** Compute a signature the way Svix does — exported so a test (or a manual probe) can sign a payload. */
export function signSvixPayload(rawBody: Buffer | string, id: string, timestamp: string, secret: string): string {
  const keyB64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, "utf8"), body]);
  return `v1,${createHmac("sha256", Buffer.from(keyB64, "base64")).update(signed).digest("base64")}`;
}

// ── Status bookkeeping ───────────────────────────────────────────────────────

/** Monotonic: a retry of an earlier event never rewinds a later state. */
const STATUS_RANK: Record<DeliveryStatus, number> = {
  failed: 0,
  sent: 1,
  delayed: 2,
  delivered: 3,
  bounced: 4,
  complained: 5,
};

const EVENT_STATUS: Record<string, DeliveryStatus | undefined> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

const IGNORED_EVENTS = new Set(["email.opened", "email.clicked", "email.received", "email.failed", "email.scheduled", "email.suppressed"]);

let lastEventAt: Date | null = null;
let missingSecretLogged = false;

/** When the last verified Resend event arrived in THIS process (the /email-status strip also checks the table). */
export function lastResendWebhookEventAt(): Date | null {
  return lastEventAt;
}

/** Test seam. */
export function resetResendWebhookState(): void {
  lastEventAt = null;
  missingSecretLogged = false;
}

export type ApplyResult = {
  type: string;
  emailId: string | null;
  matched: boolean;
  status: DeliveryStatus | null;
  bounceFiled: boolean;
  ignored: boolean;
};

function firstAddress(to: string[] | string | undefined): string | null {
  const raw = Array.isArray(to) ? to[0] : to;
  const m = (raw ?? "").match(/[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
}

function eventTime(event: ResendEvent): Date {
  const raw = event.data?.created_at ?? event.created_at;
  const d = raw ? new Date(raw) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function bounceReasonOf(event: ResendEvent): string {
  const b = event.data?.bounce;
  const parts = [b?.type, b?.subType, b?.message].filter((v): v is string => Boolean(v && v.trim()));
  const reason = parts.length > 0 ? parts.join(" · ") : event.type === "email.complained" ? "recipient marked it as spam" : event.type;
  return reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 1)}…` : reason;
}

/** Apply one verified event. Exported so a test can drive it without HTTP. */
export async function applyResendEvent(prisma: PrismaClient, event: ResendEvent): Promise<ApplyResult> {
  const type = String(event.type ?? "");
  const emailId = event.data?.email_id ?? null;
  const base: ApplyResult = { type, emailId, matched: false, status: null, bounceFiled: false, ignored: false };

  const status = EVENT_STATUS[type];
  if (!status) {
    if (!IGNORED_EVENTS.has(type)) console.log(`[ResendWebhook] Unhandled event type ${type || "(none)"} — ignored.`);
    return { ...base, ignored: true };
  }
  if (!emailId) return base;

  const at = eventTime(event);

  // 1. The delivery row — with one short retry, because the webhook can arrive before the
  //    sender has finished writing the row for that very email.
  let delivery = await prisma.emailDelivery.findUnique({ where: { providerMessageId: emailId } });
  if (!delivery) {
    await new Promise((r) => setTimeout(r, LOOKUP_RETRY_MS));
    delivery = await prisma.emailDelivery.findUnique({ where: { providerMessageId: emailId } });
  }

  if (delivery) {
    const current = delivery.status as DeliveryStatus;
    if ((STATUS_RANK[status] ?? 0) >= (STATUS_RANK[current] ?? 0)) {
      await prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: {
          status,
          statusAt: at,
          ...(status === "bounced" || status === "complained" ? { error: bounceReasonOf(event) } : {}),
        },
      });
    }
  }

  const result: ApplyResult = { ...base, matched: Boolean(delivery), status };
  if (status !== "bounced" && status !== "complained") return result;

  // 2. A bounce or a complaint is filed beside the Gmail DSNs, once per Resend email id.
  const recipient = firstAddress(event.data?.to) ?? delivery?.to.toLowerCase() ?? null;
  if (!recipient) {
    console.warn(`[ResendWebhook] ${type} for ${emailId} names no recipient; not filed.`);
    return result;
  }
  const existing = await prisma.emailBounce.findUnique({ where: { providerMessageId: emailId }, select: { id: true } });
  if (existing) return result;

  const reason = bounceReasonOf(event);
  const kind = (delivery?.kind ?? "other") as EmailKind;
  const estimateNumber = delivery?.estimateNumber ?? null;
  const issuedEstimateId = delivery?.issuedEstimateId ?? null;
  try {
    await prisma.emailBounce.create({
      data: {
        provider: "resend",
        providerMessageId: emailId,
        gmailMessageId: null,
        recipient,
        status: event.data?.bounce?.type ?? (status === "complained" ? "complaint" : null),
        diagnostic: event.data?.bounce?.message ?? event.data?.bounce?.subType ?? type,
        action: status === "complained" ? "complained" : "failed",
        originalSubject: event.data?.subject ?? delivery?.subject ?? null,
        kind,
        estimateNumber,
        issuedEstimateId,
        visitId: delivery?.visitId ?? null,
        bouncedAt: at,
      },
    });
  } catch (err) {
    // The unique index makes a retry race a no-op rather than a duplicate.
    if ((err as { code?: string })?.code === "P2002") return result;
    throw err;
  }

  // 3. Stamp the estimate like the DSN watcher does — newest bounce wins.
  if (issuedEstimateId) {
    const est = await prisma.issuedEstimate.findUnique({ where: { id: issuedEstimateId }, select: { lastBounceAt: true } });
    if (est && (!est.lastBounceAt || est.lastBounceAt <= at)) {
      await prisma.issuedEstimate.update({
        where: { id: issuedEstimateId },
        data: { lastBounceAt: at, lastBounceReason: `${recipient} — ${reason}` },
      });
    }
  }

  // 4. Say so, once.
  logSystemEvent("warn", "email",
    `Email ${status} (Resend): ${recipient} — ${reason}${estimateNumber ? ` (estimate ${estimateNumber})` : ""}`,
    {
      provider: "resend",
      resendEmailId: emailId,
      kind,
      estimateNumber,
      bounceType: event.data?.bounce?.type ?? null,
      bounceSubType: event.data?.bounce?.subType ?? null,
      originalSubject: event.data?.subject ?? delivery?.subject ?? null,
      bouncedAt: at.toISOString(),
      likelyCause: status === "complained"
        ? "The recipient reported the email as spam — do not email this address again without asking."
        : /suppress/i.test(event.data?.bounce?.subType ?? "")
          ? "The address is on Resend's suppression list from an earlier hard bounce — confirm it with the customer."
          : event.data?.bounce?.type === "Transient"
            ? "The receiver refused it for now (mailbox full / greylisting) — Resend will not retry; try again later or call."
            : "The receiver rejected the address — check it with the customer.",
    });

  return { ...result, bounceFiled: true };
}

// ── The HTTP handler ─────────────────────────────────────────────────────────

export type WebhookResponse = { status: number; body: Record<string, unknown> };

export async function handleResendWebhook(
  prisma: PrismaClient,
  rawBody: unknown,
  headers: SvixHeaders,
  opts: { nowMs?: number } = {},
): Promise<WebhookResponse> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    if (!missingSecretLogged) {
      missingSecretLogged = true;
      logSystemEvent("warn", "email", "Resend webhook received but RESEND_WEBHOOK_SECRET is not set — delivery events are being refused (503)", {
        likelyCause: "Add the signing secret from the Resend dashboard (Webhooks → the endpoint → Signing Secret) as RESEND_WEBHOOK_SECRET on the service.",
      });
    }
    return { status: 503, body: { error: "RESEND_WEBHOOK_SECRET is not set — the webhook cannot be verified. Add it on the service and redeploy." } };
  }

  if (!Buffer.isBuffer(rawBody)) {
    return { status: 400, body: { error: "Expected a raw application/json body." } };
  }

  const verified = verifySvixSignature(rawBody, headers, secret, opts.nowMs);
  if (!verified.ok) {
    logSystemEvent("warn", "email", `Resend webhook signature rejected: ${verified.reason}`, {
      svixId: headers.id ?? null,
    });
    return { status: 400, body: { error: verified.reason } };
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(rawBody.toString("utf8")) as ResendEvent;
  } catch {
    return { status: 400, body: { error: "Body is not JSON." } };
  }
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    return { status: 400, body: { error: "Event has no type." } };
  }

  lastEventAt = new Date();
  const applied = await applyResendEvent(prisma, event);
  return { status: 200, body: { received: true, ...applied } };
}
