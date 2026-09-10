/**
 * Transactional email — the ONE door every customer email leaves through.
 *
 * Kyle, 2026-09-09: *"I need the emails working, very few are actually getting through, this is
 * priority number one."*
 *
 * Customer email went out through Gmail SMTP. Authentication was clean (mail-tester 9.5/10, SPF
 * pass, DKIM aligned) and Comcast still refused three sends to one customer in a day ("554 ESMTP
 * server not available") while iCloud accepted silently into Junk. Kyle signed a $3,586 estimate
 * with her on the phone and she received nothing on either address.
 *
 * Resend is already configured and verified on the root domain for campaigns, and it reports
 * per-message delivered / bounced / complained events by webhook. So:
 *
 *   1. RESEND FIRST. `from` is service@ on the verified root domain — the customer must see the
 *      address they reply to and that Kyle's Gmail owns. reply_to is service@. Kyle's own mailbox
 *      is bcc'd (TRANSACTIONAL_BCC_SELF, default on) so it keeps a copy the way the Sent folder
 *      used to.
 *   2. GMAIL AS THE AUTOMATIC FALLBACK. Any Resend failure — network, 4xx/5xx, missing key — is
 *      logged as a WARN and the same message (html, text, attachments) goes out through the
 *      existing Gmail transporter. Gmail gives no delivery events; the DSN watcher covers its
 *      bounces.
 *   3. EVERY SEND IS A ROW. EmailDelivery records which pipe took it, the Resend id, and the
 *      status the webhook (services/resendWebhook.ts) reports. If both pipes fail the row says
 *      "failed" with the error, and a SystemEvent error says so.
 *
 * Provider selection: TRANSACTIONAL_EMAIL_PROVIDER ("resend" | "gmail") when set; otherwise
 * "resend" when RESEND_API_KEY is present, else "gmail". Tests and a Gmail-only environment get
 * exactly the old behaviour.
 */

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { getGmailTransporter, describeGmailFailure, missingGmailEnvVars } from "./gmailTransport";
import { logSystemEvent } from "./systemEvents";

export type EmailKind =
  | "estimate" | "invoice" | "appointment" | "deposit" | "balance" | "receipt"
  | "health_record" | "document" | "campaign" | "other";

export type EmailProvider = "resend" | "gmail";

export type DeliveryStatus = "sent" | "delivered" | "delayed" | "bounced" | "complained" | "failed";

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface CustomerEmailInput {
  to: string;
  subject: string;
  html: string;
  /** The plain-text twin. Built by the caller (htmlToPlainText) so both pipes send the same pair. */
  text?: string;
  attachments?: EmailAttachment[];
  /** Extra headers, passed through to either pipe (List-Unsubscribe on the campaign fallback). */
  headers?: Record<string, string>;
  kind: EmailKind;
  estimateNumber?: string | null;
  issuedEstimateId?: string | null;
  visitId?: string | null;
  replyTo?: string;
}

export type SendCustomerEmailResult =
  | { ok: true; provider: EmailProvider; id: string | null; deliveryId: string }
  | { ok: false; error: string; deliveryId: string | null };

export const RESEND_API_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 20_000;
const ERROR_MAX = 600;

/** What the customer sees in From. The ROOT domain is verified at Resend, so any local part works. */
export function transactionalFrom(): string {
  return process.env.TRANSACTIONAL_FROM ?? "Red Cedar Electric <service@redcedarelectricllc.com>";
}

export function transactionalReplyTo(): string {
  return process.env.TRANSACTIONAL_REPLY_TO ?? process.env.RESEND_REPLY_TO ?? "service@redcedarelectricllc.com";
}

export function transactionalProvider(): EmailProvider {
  const forced = (process.env.TRANSACTIONAL_EMAIL_PROVIDER ?? "").trim().toLowerCase();
  if (forced === "resend" || forced === "gmail") return forced;
  return process.env.RESEND_API_KEY ? "resend" : "gmail";
}

/** Kyle's mailbox keeps a copy of every Resend send unless TRANSACTIONAL_BCC_SELF is off. */
export function bccSelfEnabled(): boolean {
  const v = (process.env.TRANSACTIONAL_BCC_SELF ?? "on").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

function bccSelfAddress(to: string): string | null {
  if (!bccSelfEnabled()) return null;
  const self = (process.env.GMAIL_USER ?? "").trim();
  if (!self) return null;
  return self.toLowerCase() === to.trim().toLowerCase() ? null : self;
}

function clip(s: string): string {
  return s.length > ERROR_MAX ? `${s.slice(0, ERROR_MAX - 1)}…` : s;
}

/** Resend tag values may only hold ASCII letters, numbers, underscores and dashes. */
function tagValue(v: string): string {
  return v.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
}

class ResendError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ResendError";
  }
}

/** One message through Resend's HTTP API. Returns the Resend email id. Throws on any failure. */
async function sendViaResend(input: CustomerEmailInput): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new ResendError("RESEND_API_KEY is not set");

  const bcc = bccSelfAddress(input.to);
  const tags = [{ name: "kind", value: tagValue(input.kind) }];
  if (input.estimateNumber) tags.push({ name: "estimate", value: tagValue(input.estimateNumber) });

  const body = {
    from: transactionalFrom(),
    to: [input.to],
    reply_to: input.replyTo ?? transactionalReplyTo(),
    ...(bcc ? { bcc: [bcc] } : {}),
    subject: input.subject,
    html: input.html,
    ...(input.text ? { text: input.text } : {}),
    ...(input.attachments && input.attachments.length > 0
      ? {
          attachments: input.attachments.map((a) => ({
            filename: a.filename,
            content: a.content.toString("base64"),
            ...(a.contentType ? { content_type: a.contentType } : {}),
          })),
        }
      : {}),
    ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
    tags,
  };

  let res: Response;
  try {
    res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ResendError(`Resend unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ResendError(`Resend refused (${res.status}): ${text.slice(0, 300)}`, res.status);
  }
  const json = (await res.json().catch(() => null)) as { id?: string } | null;
  if (!json?.id) throw new ResendError("Resend accepted the message but returned no id");
  return json.id;
}

/** The same message through the Gmail transporter. Throws on any failure. */
async function sendViaGmail(input: CustomerEmailInput): Promise<void> {
  const mail = getGmailTransporter();
  if (!mail) {
    throw new Error(`Gmail is not configured (missing ${missingGmailEnvVars().join(", ")})`);
  }
  await mail.transporter.sendMail({
    from: mail.from,
    to: input.to,
    replyTo: input.replyTo,
    subject: input.subject,
    html: input.html,
    text: input.text,
    attachments: input.attachments,
    headers: input.headers,
  });
}

/**
 * Send one customer email. Never throws — the answer is the result.
 *
 * Order of business: the preferred pipe, then the other one, then a "failed" row. A Resend
 * failure is a WARN (the customer still gets the email through Gmail); a total failure is an
 * ERROR with the reason from each pipe.
 */
export async function sendCustomerEmail(
  input: CustomerEmailInput,
  opts: { prisma?: PrismaClient } = {},
): Promise<SendCustomerEmailResult> {
  const prisma = opts.prisma ?? defaultPrisma;
  const to = input.to.trim();
  const base = {
    to,
    subject: input.subject,
    kind: input.kind,
    estimateNumber: input.estimateNumber ?? null,
    issuedEstimateId: input.issuedEstimateId ?? null,
    visitId: input.visitId ?? null,
  };
  const record = async (data: { provider: EmailProvider; providerMessageId?: string | null; status: DeliveryStatus; error?: string | null }) => {
    try {
      const row = await prisma.emailDelivery.create({
        data: { ...base, ...data, statusAt: new Date() },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      // Bookkeeping must never turn a sent email into a reported failure.
      console.error("[TransactionalEmail] EmailDelivery write failed:", err);
      return null;
    }
  };

  const provider = transactionalProvider();
  let resendError: string | null = null;

  if (provider === "resend") {
    try {
      const id = await sendViaResend({ ...input, to });
      const deliveryId = await record({ provider: "resend", providerMessageId: id, status: "sent" });
      console.log(`[TransactionalEmail] Resend accepted "${input.subject}" to ${to} (${id})`);
      return { ok: true, provider: "resend", id, deliveryId: deliveryId ?? "" };
    } catch (err) {
      resendError = clip(err instanceof Error ? err.message : String(err));
      const status = err instanceof ResendError ? err.status : undefined;
      logSystemEvent("warn", "email", `Resend did not take "${input.subject}" to ${to} — falling back to Gmail: ${resendError}`, {
        subject: input.subject,
        kind: input.kind,
        estimateNumber: input.estimateNumber ?? null,
        resendStatus: status ?? null,
        likelyCause: status === 401 || status === 403
          ? "RESEND_API_KEY is wrong or revoked."
          : status === 422
            ? "Resend rejected the message (address, domain, or payload) — the Gmail copy still went out."
            : status === 429
              ? "Resend plan/rate limit — the Gmail copy still went out."
              : !process.env.RESEND_API_KEY
                ? "RESEND_API_KEY is not set on the service."
                : null,
      });
    }
  }

  // Gmail — the preferred pipe when Resend is off, the fallback when it failed.
  try {
    await sendViaGmail({ ...input, to });
    const deliveryId = await record({ provider: "gmail", status: "sent", error: resendError ? `Resend fallback: ${resendError}` : null });
    console.log(`[TransactionalEmail] Gmail sent "${input.subject}" to ${to}${resendError ? " (Resend fallback)" : ""}`);
    return { ok: true, provider: "gmail", id: null, deliveryId: deliveryId ?? "" };
  } catch (err) {
    const gmail = describeGmailFailure(err);
    const error = clip(
      resendError
        ? `Resend: ${resendError} · Gmail: ${gmail.message}`
        : `Gmail: ${gmail.message}`,
    );
    const deliveryId = await record({ provider: resendError ? "resend" : "gmail", status: "failed", error });
    logSystemEvent("error", "email", `Not sent to ${to} — ${error}`, {
      subject: input.subject,
      kind: input.kind,
      estimateNumber: input.estimateNumber ?? null,
      provider,
      code: gmail.code,
      responseCode: gmail.responseCode,
      response: gmail.response,
      missingEnvVars: missingGmailEnvVars(),
      likelyCause: gmail.likelyCause ?? (missingGmailEnvVars().length > 0 ? "Set the missing variables on the service; nothing was attempted." : null),
    });
    return { ok: false, error, deliveryId };
  }
}

// ── Read side ────────────────────────────────────────────────────────────────

export interface LastDelivery {
  provider: EmailProvider;
  status: DeliveryStatus;
  statusAt: Date | null;
  to: string;
  error: string | null;
  createdAt: Date;
}

/** The newest delivery per estimate — one query for the whole list, never N. */
export async function lastDeliveriesForEstimates(
  prisma: PrismaClient,
  estimateIds: string[],
): Promise<Map<string, LastDelivery>> {
  const out = new Map<string, LastDelivery>();
  if (estimateIds.length === 0) return out;
  const rows = await prisma.emailDelivery.findMany({
    where: { issuedEstimateId: { in: estimateIds } },
    orderBy: { createdAt: "desc" },
    distinct: ["issuedEstimateId"],
    select: { issuedEstimateId: true, provider: true, status: true, statusAt: true, to: true, error: true, createdAt: true },
  });
  for (const r of rows) {
    if (!r.issuedEstimateId) continue;
    out.set(r.issuedEstimateId, {
      provider: r.provider as EmailProvider,
      status: r.status as DeliveryStatus,
      statusAt: r.statusAt,
      to: r.to,
      error: r.error,
      createdAt: r.createdAt,
    });
  }
  return out;
}
