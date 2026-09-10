/**
 * Email bounce watcher — reads Gmail's Delivery Status Notifications so a bounced
 * message stops looking like a delivered one.
 *
 * Kyle, 2026-09-09: *"My emails are not getting to the clients"* / *"very few are
 * actually getting through, this is priority number one."*
 *
 * The transport is not the problem: a mail-tester probe the same day scored 9.5/10
 * with SPF pass, DKIM valid and aligned, DMARC present. What was missing was
 * VISIBILITY. When a receiver rejects a message, Gmail puts a "Delivery Status
 * Notification (Failure)" from mailer-daemon@googlemail.com in the inbox, in the
 * same thread as the sent message — and nothing in the CRM read the inbox. So
 * estimate 2026-1067 (comcast, "554 ... ESMTP server not available", 5.7.0) and
 * 2026-1035 (gmail, "550 5.1.1 ... address couldn't be found") both sat on the
 * Estimates page as "sent — not opened yet", indistinguishable from an estimate
 * the customer simply hadn't read.
 *
 * ── HOW ──────────────────────────────────────────────────────────────────────
 * The OAuth refresh token the SMTP sender uses for XOAUTH2 carries the
 * https://mail.google.com/ scope (SMTP OAuth requires it), so the same token
 * reads the mailbox through the Gmail REST API. Every 10 minutes (and once, 60 s
 * after boot) `pollBounces` lists messages from mailer-daemon newer than a few
 * days, parses the RFC 3464 fields out of each DSN, reads the original send's
 * subject from the thread to learn WHAT bounced (estimate / invoice / appointment
 * / deposit / ...), files one EmailBounce row per DSN (idempotent on the Gmail
 * message id), stamps the estimate's lastBounceAt / lastBounceReason when the
 * subject named one, and writes a WARN SystemEvent the FIRST time each DSN is seen.
 *
 * This is INBOUND — it reads, it never sends — so it is deliberately not behind
 * automationGate. It runs whenever Gmail is configured.
 *
 * Auth or permission failures are reported ({available:false, reason}) and logged
 * once per process; nothing here ever throws into the scheduler.
 */

import { google } from "googleapis";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { logSystemEvent } from "./systemEvents";

export type BounceKind =
  | "estimate" | "invoice" | "appointment" | "deposit" | "balance" | "receipt" | "health_record" | "document" | "campaign" | "other";

export interface ParsedDsn {
  recipient: string | null;
  action: string | null;
  status: string | null;
  diagnostic: string | null;
  remoteMta: string | null;
}

export type PollResult =
  | { available: true; scanned: number; new: number; errors: number }
  | { available: false; reason: string };

/** The slice of the Gmail v1 client this service touches — injectable for tests. */
export interface GmailLike {
  users: {
    messages: {
      list(params: { userId: string; q: string; maxResults?: number }): Promise<{ data: GmailListData }>;
      get(params: { userId: string; id: string; format?: string }): Promise<{ data: GmailMessage }>;
    };
    threads: {
      get(params: {
        userId: string; id: string; format?: string; metadataHeaders?: string[];
      }): Promise<{ data: { messages?: GmailMessage[] } }>;
    };
  };
}

interface GmailListData {
  messages?: Array<{ id?: string | null; threadId?: string | null }> | null;
  nextPageToken?: string | null;
}

interface GmailHeader { name?: string | null; value?: string | null }
interface GmailPart {
  mimeType?: string | null;
  headers?: GmailHeader[] | null;
  body?: { data?: string | null; size?: number | null } | null;
  parts?: GmailPart[] | null;
}
interface GmailMessage {
  id?: string | null;
  threadId?: string | null;
  internalDate?: string | null;
  payload?: GmailPart | null;
}

const MAILER_DAEMON = "mailer-daemon@googlemail.com";
const DIAGNOSTIC_MAX = 500;
const REASON_MAX = 300;
const LIST_MAX = 100;

// ── Parsing ──────────────────────────────────────────────────────────────────

/** base64url → utf8. Gmail bodies are base64url without padding. */
export function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

/**
 * Every text-bearing part of a message, in order. The DSN's structured fields live in
 * the message/delivery-status part; Gmail's human-readable summary is text/plain; the
 * original message rides along as message/rfc822 (its own text/plain is harmless here —
 * none of the RFC 3464 fields appear in an estimate email).
 */
export function collectText(payload: GmailPart | null | undefined): string {
  if (!payload) return "";
  const out: string[] = [];
  const walk = (part: GmailPart) => {
    const mime = (part.mimeType ?? "").toLowerCase();
    const data = part.body?.data;
    if (data && (mime === "text/plain" || mime === "message/delivery-status" || mime === "")) {
      out.push(decodeBase64Url(data));
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return out.join("\n");
}

/** Headers from the top-level payload and every nested part (the attached original carries its own). */
function collectHeaders(payload: GmailPart | null | undefined): GmailHeader[] {
  if (!payload) return [];
  const out: GmailHeader[] = [];
  const walk = (part: GmailPart) => {
    for (const h of part.headers ?? []) out.push(h);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}

function headerValue(headers: GmailHeader[], name: string): string | null {
  const hit = headers.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase());
  return hit?.value?.trim() || null;
}

const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** A bare address out of "Name <addr>" / "rfc822; addr" / "addr". */
function bareAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(EMAIL_RE);
  return m ? m[0].toLowerCase() : null;
}

/**
 * The RFC 3464 fields out of a DSN body. Tolerant of Gmail's layout: the structured
 * block ("Final-Recipient: rfc822; …", "Action: failed", "Status: 5.7.0",
 * "Diagnostic-Code: smtp; 554 …", "Remote-MTA: dns; …") when it is there, and the
 * human paragraph ("Your message wasn't delivered to … The response from the remote
 * server was: 550 …") as the fallback when it is not.
 */
export function parseDsn(text: string): ParsedDsn {
  const field = (name: string): string | null => {
    // A field may fold onto continuation lines that begin with whitespace (RFC 5322 folding).
    const re = new RegExp(`^${name}:[ \\t]*([^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*)`, "im");
    const m = text.match(re);
    if (!m) return null;
    const v = m[1].replace(/\s+/g, " ").trim();
    return v || null;
  };

  const recipient =
    bareAddress(field("Final-Recipient")) ??
    bareAddress(field("Original-Recipient")) ??
    bareAddress(field("X-Failed-Recipients")) ??
    bareAddress(text.match(/wasn'?t delivered to\s+([^\s]+)/i)?.[1]) ??
    null;

  const action = field("Action")?.split(/\s+/)[0]?.toLowerCase() ?? null;

  const statusField = field("Status");
  const status =
    statusField?.match(/\b(\d\.\d{1,3}\.\d{1,3})\b/)?.[1] ??
    text.match(/\b(5\.\d{1,3}\.\d{1,3})\b/)?.[1] ??
    null;

  let diagnostic = field("Diagnostic-Code");
  if (!diagnostic) {
    const m = text.match(/response from the remote server was:\s*([^\r\n]+(?:\r?\n(?![ \t]*\r?\n)[^\r\n]+)*)/i);
    if (m) diagnostic = `smtp; ${m[1].replace(/\s+/g, " ").trim()}`;
  }
  if (diagnostic && diagnostic.length > DIAGNOSTIC_MAX) diagnostic = diagnostic.slice(0, DIAGNOSTIC_MAX);

  const remoteMtaRaw = field("Remote-MTA");
  const remoteMta = remoteMtaRaw ? remoteMtaRaw.replace(/^dns;\s*/i, "").split(/\s+/)[0] || null : null;

  return { recipient, action, status, diagnostic, remoteMta };
}

/**
 * What was sent, from the original message's subject. The subjects are the CRM's own
 * (issuedEstimateSend.ts, paymentReceipts.ts, confirmationEmail.ts, visitConfirmations.ts),
 * so this is a lookup, not a guess. Unknown subjects are "other" — the row is still filed.
 */
export function classifySubject(subject: string | null | undefined): { kind: BounceKind; estimateNumber: string | null } {
  const s = (subject ?? "").trim();
  const estimateNumber = s.match(/(\d{4}-\d{4})/)?.[1] ?? null;
  const kind: BounceKind =
    /^\[TEST\]/i.test(s) ? "campaign"
    : /^Your estimate from Red Cedar Electric/i.test(s) ? "estimate"
    : /^Your invoice from Red Cedar Electric/i.test(s) ? "invoice"
    : /^Next step — your deposit/i.test(s) ? "deposit"
    : /^(Your bill for |Friendly reminder — )/i.test(s) ? "balance"
    : /^(Paid in full — receipt|Receipt — )/i.test(s) ? "receipt"
    : /^(Appointment (Confirmed|Rescheduled|Cancelled)|Please confirm your appointment|Reminder: your appointment)/i.test(s)
      ? "appointment"
    : /^Your Proposal from Red Cedar Electric/i.test(s) ? "estimate"
    : "other";
  return { kind, estimateNumber };
}

/** One line for the estimate flag and the SystemEvent: "5.7.0 554 resimta… ESMTP server not available". */
export function bounceReason(p: ParsedDsn): string {
  const diag = (p.diagnostic ?? "").replace(/^smtp;\s*/i, "").trim();
  const reason = [p.status, diag].filter(Boolean).join(" ").trim() || "delivery failed (no diagnostic in the DSN)";
  return reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 1)}…` : reason;
}

// ── Gmail client ─────────────────────────────────────────────────────────────

export function gmailConfigured(): boolean {
  return Boolean(
    process.env.GMAIL_USER && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN,
  );
}

/** Same OAuth2 construction as googleCalendar.ts — one token, two APIs. */
function getGmailClient(): GmailLike {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth }) as unknown as GmailLike;
}

function describeError(err: unknown): string {
  const e = err as { message?: string; code?: number | string; response?: { status?: number } };
  const status = e?.response?.status ?? e?.code;
  const msg = e?.message ?? String(err);
  return status ? `${status}: ${msg}` : msg;
}

function isAuthError(err: unknown): boolean {
  const e = err as { code?: number | string; response?: { status?: number }; message?: string };
  const status = Number(e?.response?.status ?? e?.code);
  if (status === 401 || status === 403) return true;
  return /invalid_grant|insufficient|unauthori[sz]ed|permission|forbidden|login required|access.?not.?configured|has not been used|not enabled|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i
    .test(e?.message ?? "");
}

// ── The poll ─────────────────────────────────────────────────────────────────

/** Once per process, reset on the next healthy poll — a 10-minute cron must not write the same warning 144 times a day. */
let unavailableLogged = false;

export async function pollBounces(opts: {
  sinceDays?: number;
  prisma?: PrismaClient;
  /** Test seam — production builds the client from the env. */
  gmail?: GmailLike;
} = {}): Promise<PollResult> {
  const sinceDays = Math.max(1, Math.floor(opts.sinceDays ?? 3));
  const prisma = opts.prisma ?? defaultPrisma;

  if (!opts.gmail && !gmailConfigured()) {
    return { available: false, reason: "Gmail is not configured (GMAIL_USER / GOOGLE_* variables)." };
  }

  let gmail: GmailLike;
  try {
    gmail = opts.gmail ?? getGmailClient();
  } catch (err) {
    return unavailable(`Could not build the Gmail client: ${describeError(err)}`);
  }

  // 1. Every DSN in the window. One page of 100 is plenty — a mailbox with more than a
  //    hundred bounces in three days has a bigger problem than a missed row.
  let listed: Array<{ id: string; threadId: string | null }>;
  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: `from:${MAILER_DAEMON} newer_than:${sinceDays}d`,
      maxResults: LIST_MAX,
    });
    listed = (res.data.messages ?? [])
      .filter((m): m is { id: string; threadId?: string | null } => Boolean(m?.id))
      .map((m) => ({ id: m.id, threadId: m.threadId ?? null }));
  } catch (err) {
    const why = describeError(err);
    return unavailable(
      isAuthError(err)
        ? `Gmail refused the mailbox read (${why}). The refresh token needs the https://mail.google.com/ scope and the Gmail API enabled on the OAuth project.`
        : `Gmail list failed (${why}).`,
    );
  }
  unavailableLogged = false;

  // 2. Skip what is already filed — one query, no Gmail reads for known rows.
  const known = new Set(
    (await prisma.emailBounce.findMany({
      where: { gmailMessageId: { in: listed.map((m) => m.id) } },
      select: { gmailMessageId: true },
    })).map((r) => r.gmailMessageId),
  );

  let created = 0;
  let errors = 0;
  for (const item of listed) {
    if (known.has(item.id)) continue;
    try {
      const made = await fileBounce(prisma, gmail, item.id);
      if (made) created += 1;
    } catch (err) {
      errors += 1;
      console.warn(`[BounceWatcher] Could not file DSN ${item.id}: ${describeError(err)}`);
    }
  }

  return { available: true, scanned: listed.length, new: created, errors };
}

function unavailable(reason: string): PollResult {
  if (!unavailableLogged) {
    unavailableLogged = true;
    logSystemEvent("warn", "email", `Bounce watcher cannot read the mailbox — ${reason}`, {
      likelyCause: "Bounced customer emails will not be surfaced until this is fixed.",
    });
  } else {
    console.warn(`[BounceWatcher] ${reason}`);
  }
  return { available: false, reason };
}

/** Read one DSN, parse it, file it. Returns true when a NEW row was written. */
async function fileBounce(prisma: PrismaClient, gmail: GmailLike, messageId: string): Promise<boolean> {
  const { data: msg } = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const text = collectText(msg.payload);
  const dsnHeaders = collectHeaders(msg.payload);
  const parsed = parseDsn(text);
  const recipient =
    parsed.recipient ?? bareAddress(headerValue(dsnHeaders, "X-Failed-Recipients"));
  const bouncedAt = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date();
  const threadId = msg.threadId ?? null;

  // 3. What was sent: the thread's first message is the original send. When Gmail did
  //    not thread them (or the thread is only the DSN), the attached original's own
  //    headers, nested inside the message/rfc822 part, are the fallback.
  let originalSubject: string | null = null;
  let originalTo: string | null = null;
  let originalDate: Date | null = null;
  if (threadId) {
    try {
      const { data: thread } = await gmail.users.threads.get({
        userId: "me", id: threadId, format: "metadata", metadataHeaders: ["Subject", "To", "Date"],
      });
      const first = (thread.messages ?? []).find((m) => m.id && m.id !== messageId) ?? null;
      if (first) {
        const h = first.payload?.headers ?? [];
        originalSubject = headerValue(h, "Subject");
        originalTo = bareAddress(headerValue(h, "To"));
        originalDate = first.internalDate ? new Date(Number(first.internalDate)) : null;
      }
    } catch (err) {
      console.warn(`[BounceWatcher] Thread ${threadId} unreadable: ${describeError(err)}`);
    }
  }
  if (!originalSubject) {
    // The DSN's own Subject is "Delivery Status Notification (Failure)"; skip it.
    const nested = dsnHeaders.filter((h) => (h.name ?? "").toLowerCase() === "subject")
      .map((h) => h.value?.trim() ?? "")
      .find((v) => v && !/^Delivery Status Notification/i.test(v));
    originalSubject = nested ?? (text.match(/^Subject:[ \t]*([^\r\n]+)/im)?.[1]?.trim() ?? null);
  }
  if (!originalTo) {
    const nested = dsnHeaders.find((h) => (h.name ?? "").toLowerCase() === "to");
    originalTo = bareAddress(nested?.value);
  }

  const finalRecipient = recipient ?? originalTo;
  if (!finalRecipient) {
    // Not a bounce we can attribute to anyone — nothing to flag, nothing to file.
    console.warn(`[BounceWatcher] DSN ${messageId} names no recipient; skipped.`);
    return false;
  }

  const { kind, estimateNumber } = classifySubject(originalSubject);

  // 4. Resolve the estimate by number (latest revision) and, for appointment mail, the visit.
  const estimate = estimateNumber
    ? await prisma.issuedEstimate.findFirst({
        where: { number: estimateNumber },
        orderBy: { revision: "desc" },
        select: { id: true, lastBounceAt: true },
      })
    : null;
  const visitId = kind === "appointment"
    ? await resolveVisit(prisma, finalRecipient, originalDate ?? bouncedAt)
    : null;

  const reason = bounceReason(parsed);

  // 5. File it. The unique index on gmailMessageId makes a race between two polls a
  //    no-op rather than a duplicate: a P2002 here means the other poll already filed it.
  try {
    await prisma.emailBounce.create({
      data: {
        gmailMessageId: messageId,
        gmailThreadId: threadId,
        recipient: finalRecipient,
        status: parsed.status,
        diagnostic: parsed.diagnostic,
        action: parsed.action,
        remoteMta: parsed.remoteMta,
        originalSubject,
        kind,
        estimateNumber,
        issuedEstimateId: estimate?.id ?? null,
        visitId,
        bouncedAt,
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return false;
    throw err;
  }

  // 6. Stamp the estimate — newest bounce wins, an older DSN never overwrites a newer flag.
  if (estimate && (!estimate.lastBounceAt || estimate.lastBounceAt <= bouncedAt)) {
    await prisma.issuedEstimate.update({
      where: { id: estimate.id },
      data: { lastBounceAt: bouncedAt, lastBounceReason: `${finalRecipient} — ${reason}` },
    });
  }

  // 7. Say so, once — this is the row Kyle reads in the system log.
  logSystemEvent("warn", "email",
    `Email bounced: ${finalRecipient} — ${reason}${estimateNumber ? ` (estimate ${estimateNumber})` : ""}`,
    {
      gmailMessageId: messageId,
      kind,
      estimateNumber,
      status: parsed.status,
      remoteMta: parsed.remoteMta,
      originalSubject,
      bouncedAt: bouncedAt.toISOString(),
      likelyCause: parsed.status?.startsWith("5.1.")
        ? "The address does not exist — check it with the customer."
        : parsed.status?.startsWith("5.7.")
          ? "The receiver's server refused the message (policy/reputation) — try another address or call."
          : null,
    });

  return true;
}

/**
 * The visit an appointment email was about, when it can be named without guessing:
 * the recipient matches exactly one account (primary email or a stored contact), and that
 * account has exactly one visit with a start date created or scheduled within two days
 * of the send. Anything else is null — a wrong link is worse than none.
 */
async function resolveVisit(prisma: PrismaClient, recipient: string, sentAt: Date): Promise<string | null> {
  const [byPrimary, byContact] = await Promise.all([
    prisma.customer.findMany({ where: { email: { equals: recipient, mode: "insensitive" } }, select: { id: true } }),
    prisma.customerContact.findMany({ where: { email: { equals: recipient, mode: "insensitive" } }, select: { customerId: true } }),
  ]);
  const customerIds = [...new Set([...byPrimary.map((c) => c.id), ...byContact.map((c) => c.customerId)])];
  if (customerIds.length !== 1) return null;

  const window = 2 * 86_400_000;
  const lo = new Date(sentAt.getTime() - window);
  const hi = new Date(sentAt.getTime() + window);
  const visits = await prisma.visit.findMany({
    where: {
      customerId: customerIds[0],
      scheduledStart: { not: null },
      OR: [
        { createdAt: { gte: lo, lte: hi } },
        { scheduledStart: { gte: lo, lte: hi } },
      ],
    },
    select: { id: true },
    take: 2,
  });
  return visits.length === 1 ? visits[0].id : null;
}

// ── Clearing ─────────────────────────────────────────────────────────────────

/**
 * After a send SUCCEEDS to `to`: if the estimate carries a bounce flag and this send went
 * to a DIFFERENT address than the one(s) that bounced, the flag comes off and those bounce
 * rows are resolved with a note. A resend to the SAME address leaves the flag — the SMTP
 * accept says nothing about delivery, and if it bounces again the next poll re-stamps it.
 */
export async function clearBounceIfDifferentAddress(
  prisma: PrismaClient,
  estimateId: string,
  to: string,
): Promise<boolean> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: { id: true, lastBounceAt: true, sentTo: true, number: true },
  });
  if (!est?.lastBounceAt) return false;

  const open = await prisma.emailBounce.findMany({
    where: { issuedEstimateId: est.id, resolvedAt: null },
    select: { id: true, recipient: true },
  });
  const bounced = new Set(open.map((b) => b.recipient.toLowerCase()));
  if (bounced.size === 0 && est.sentTo) bounced.add(est.sentTo.toLowerCase());
  const target = to.trim().toLowerCase();
  if (bounced.has(target)) return false;

  await prisma.$transaction([
    prisma.issuedEstimate.update({
      where: { id: est.id },
      data: { lastBounceAt: null, lastBounceReason: null },
    }),
    ...(open.length > 0
      ? [prisma.emailBounce.updateMany({
          where: { id: { in: open.map((b) => b.id) } },
          data: { resolvedAt: new Date(), resolvedNote: `Re-sent to a different address: ${to.trim()}` },
        })]
      : []),
  ]);
  logSystemEvent("info", "email", `Bounce flag cleared on ${est.number} — re-sent to ${to.trim()}`, {
    estimateId: est.id,
    resolvedBounces: open.length,
  });
  return true;
}
