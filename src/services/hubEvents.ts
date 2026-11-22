/**
 * The signed outbound event outbox (work order agent-team, BA4 + TC4). When something happens that an
 * AI agent should hear about - a customer opens or signs an estimate, a payment lands, a lead
 * arrives, a job is completed, material is used, a person posts in a team thread - the code site
 * calls `emitHubEventSafe`. That writes one HubEvent row per target, and a worker POSTs it, signed, to
 * the agent's address, retrying what can be retried and dead-lettering the rest.
 *
 * THE PAYLOAD (team answer 1). Exactly: event_id, type, occurred_at (ISO 8601 with the Chicago
 * offset), the record ids, and a templated non-personal summary. NEVER a name, a link, a phone, an
 * email, an address, a message excerpt or any free text; the agent fetches the rest through /mcp.
 * Each type's builder below is a projection: it lists the fields it sends, so a field nobody listed
 * cannot leak. The finished payload then goes through the ONE scrub layer (agentApi/respond.ts
 * scrub), with every live technician token and every secret-named environment value as exact
 * matches, as a last net.
 *
 * SIGNING (team answer 2). X-RCE-Signature is `sha256=` + hex HMAC-SHA256(HUB_WEBHOOK_SECRET,
 * `${X-RCE-Timestamp}.${raw body}`). The timestamp (Unix seconds) is taken FRESH at each attempt and
 * the signature is recomputed, while the body is byte-identical and occurred_at inside it stays fixed,
 * so the receiver's 5-minute window accepts a retry an hour later and a Resend. event_id (the row
 * id, also sent as X-RCE-Event-Id) never changes. With no secret set nothing is ever sent unsigned.
 *
 * RETRIES (team answer 1). Any 2xx is delivered. A 408, a 429, a 5xx, a timeout or a connection
 * error is retried at +30 seconds, 2 minutes, 10 minutes, 1 hour, 6 hours, and dead after the 6th
 * failure. Every other answer (the other 4xx, a redirect) is dead at once, not retried.
 *
 * WHERE IT GOES. Each event type has one target (shared/hub/events.ts DEFAULT_EVENT_ROUTES, changed by
 * Kyle in the owner setting `agentWebhooks`). A target's address is the setting's, or for Admin the
 * HUB_AGENT_WEBHOOK_URL variable. No address, or the target turned Off, records the event as
 * `no_target` (kept, never retried by the worker) until Resend finds an address.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { HubEvent, HubEventAttempt, Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { toChicagoIso } from "../../shared/calendarDay";
import { normalizeLeadPlatform } from "../../shared/leadPlatform";
import { closedLeadSource } from "../../shared/leadSources";
import {
  DEFAULT_EVENT_ROUTES, HUB_EVENT_MAX_ATTEMPTS, HUB_EVENT_RETRY_SECONDS, RESEND_DELIVERED_REASON,
  type HubEventType, type HubWebhookTargetId,
} from "../../shared/hub/events";
import { loadSecretValues, scrub } from "../agentApi/respond";
import { getAgentWebhooks, isAllowedWebhookUrl, type AgentWebhooks } from "./ownerSettings";
import { announceDecision } from "./hubBus";
import { logSystemEvent } from "./systemEvents";

let deliveryTimeoutMs = 10_000;
/** Tests only: how long one attempt waits for the receiver before it counts as a timeout. */
export function _setDeliveryTimeoutMsForTests(ms: number): void {
  deliveryTimeoutMs = ms;
}
/** Event ids whose POST is on the wire in this process right now (Resend refuses them). */
const inFlight = new Set<string>();
/** A claimed event is leased this long; the 10-second timeout is well inside it. */
const LEASE_MS = 120_000;
const SECRET_UNSET_RETRY_MS = 30_000;

export class HubEventError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "HubEventError";
    this.status = status;
  }
}

// ── what can be emitted ──────────────────────────────────────────────────────────────────────────

/** What an emitter hands over: the type and the ids of the records it happened to. Never a name or text. */
export type EmitInput =
  | { type: "message.inbound" | "message.team" | "message.dev"; messageId: string; context?: { kind: string; id: string } | null }
  | { type: "approval.decided"; messageId: string; status: string; actionKind?: string | null; resultIds?: Record<string, string> | null }
  | { type: "estimate.viewed" | "estimate.signed" | "estimate.accepted"; estimateId: string }
  | { type: "payment.received"; paymentId: string }
  | { type: "lead.created" | "lead.web_chat"; leadId: string }
  | { type: "job.completed"; visitId: string }
  | { type: "material.used"; jobId: string; movementIds: readonly string[]; truckId?: string | null };

type Fields = Record<string, unknown>;
interface Built { fields: Fields; summary: string }

const money = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const idOnly = (v: string | null | undefined): string | null => (v ? v : null);

/** One builder per type: a projection that names every field it sends. */
async function build(input: EmitInput, db: PrismaClient): Promise<Built> {
  switch (input.type) {
    case "message.inbound":
    case "message.team":
    case "message.dev": {
      const m = await db.hubMessage.findUnique({
        where: { id: input.messageId },
        select: {
          id: true, threadId: true, authorType: true, authorTechnicianId: true, visitId: true,
          thread: { select: { kind: true, customerId: true, leadId: true, visitId: true } },
          attachments: { where: { deletedAt: null, removedAt: null }, select: { id: true } },
        },
      });
      if (!m) throw new HubEventError("Message not found", 404);
      const context = input.context
        ?? (m.thread.kind === "job" && m.thread.visitId ? { kind: "job", id: m.thread.visitId }
          : m.thread.kind === "customer" && m.thread.customerId ? { kind: "account", id: m.thread.customerId }
            : m.thread.kind === "customer" && m.thread.leadId ? { kind: "lead", id: m.thread.leadId }
              : { kind: m.thread.kind, id: m.threadId });
      const where = input.type === "message.inbound" ? "customer message" : input.type === "message.dev" ? "dev-thread message" : "team message";
      return {
        fields: {
          thread_id: m.threadId,
          message_id: m.id,
          author_type: m.authorType,
          author_id: idOnly(m.authorTechnicianId),
          context: { kind: context.kind, id: context.id },
          attachment_ids: m.attachments.map((a) => a.id),
        },
        summary: `New ${where}`,
      };
    }
    case "approval.decided": {
      const m = await db.hubMessage.findUnique({ where: { id: input.messageId }, select: { id: true, threadId: true, actionKind: true } });
      if (!m) throw new HubEventError("Message not found", 404);
      // Never the reject reason and never an edited text: the agent reads those through get_draft_status.
      return {
        fields: {
          message_id: m.id,
          thread_id: m.threadId,
          action_kind: input.actionKind ?? m.actionKind ?? null,
          status: input.status,
          result_ids: input.resultIds ?? {},
        },
        summary: `Draft ${input.status}`,
      };
    }
    case "estimate.viewed":
    case "estimate.signed":
    case "estimate.accepted": {
      const e = await db.issuedEstimate.findUnique({
        where: { id: input.estimateId },
        select: { id: true, number: true, revision: true, customerId: true, leadId: true, total: true, acceptedVia: true, selectedOptions: true },
      });
      if (!e) throw new HubEventError("Estimate not found", 404);
      const base: Fields = {
        estimate_id: e.id,
        estimate_number: e.number,
        revision: e.revision,
        customer_id: e.customerId,
        lead_id: idOnly(e.leadId),
      };
      if (input.type === "estimate.viewed") return { fields: base, summary: `Estimate ${e.number} rev ${e.revision} viewed` };
      if (input.type === "estimate.signed") {
        return { fields: { ...base, total: e.total }, summary: `Estimate ${e.number} rev ${e.revision} signed, ${money(e.total)}` };
      }
      // The office-recorded acceptance: how they told us, and the option letters. Never who accepted
      // (a person's name) and never a job id (the job is made after this returns).
      return {
        fields: { ...base, total: e.total, accepted_via: e.acceptedVia, option_letters: [...e.selectedOptions].map(String) },
        summary: `Estimate ${e.number} rev ${e.revision} accepted by the office, ${money(e.total)}`,
      };
    }
    case "payment.received": {
      const p = await db.payment.findUnique({
        where: { id: input.paymentId },
        select: { id: true, estimateId: true, customerId: true, visitId: true, amount: true, method: true, kind: true, payer: true },
      });
      if (!p) throw new HubEventError("Payment not found", 404);
      return {
        fields: {
          payment_id: p.id,
          estimate_id: idOnly(p.estimateId),
          customer_id: idOnly(p.customerId),
          job_id: idOnly(p.visitId),
          amount: p.amount,
          method: p.method,
          kind: p.kind,
          payer: p.payer,
        },
        summary: `Payment ${money(p.amount)} received by ${p.method}`,
      };
    }
    case "lead.created":
    case "lead.web_chat": {
      const l = await db.lead.findUnique({ where: { id: input.leadId }, select: { id: true, source: true, platform: true, urgentFlag: true } });
      if (!l) throw new HubEventError("Lead not found", 404);
      // The website door stores whatever source and platform string it was sent, so both are held to
      // their closed lists here: anything else goes out as "other", never as the text it was.
      const source = closedLeadSource(l.source);
      const platform = normalizeLeadPlatform(l.platform);
      return {
        fields: { lead_id: l.id, source, platform, urgent: l.urgentFlag },
        summary: input.type === "lead.web_chat" ? "New website-chat lead" : `New lead from ${source}`,
      };
    }
    case "job.completed": {
      // Visit.jobType is copied from what the customer typed on the website form, so it is never sent
      // (team answer 1: no free text). The agents read it through /mcp.
      const v = await db.visit.findUnique({ where: { id: input.visitId }, select: { id: true, customerId: true } });
      if (!v) throw new HubEventError("Job not found", 404);
      return {
        fields: { job_id: v.id, customer_id: v.customerId },
        summary: "Job marked complete",
      };
    }
    case "material.used": {
      return {
        fields: { job_id: input.jobId, truck_id: idOnly(input.truckId ?? null), movement_ids: [...input.movementIds], line_count: input.movementIds.length },
        summary: `Material used on a job, ${input.movementIds.length} line${input.movementIds.length === 1 ? "" : "s"}`,
      };
    }
  }
}

// ── targets ──────────────────────────────────────────────────────────────────────────────────────

export interface ResolvedTarget {
  id: HubWebhookTargetId; url: string | null; enabled: boolean;
  /** True when HUB_AGENT_WEBHOOK_URL is set for Admin but is not an allowed address, so it is ignored. */
  envRefused?: boolean;
}

/** Which target an event type goes to: Kyle's re-pointing, else the default table. */
export function targetIdFor(type: HubEventType, settings: AgentWebhooks): HubWebhookTargetId {
  return settings.routes[type] ?? DEFAULT_EVENT_ROUTES[type];
}

/** The receiving address for a target now: the setting's, or for Admin the HUB_AGENT_WEBHOOK_URL variable. Null for none. */
export function resolveTarget(id: HubWebhookTargetId, settings: AgentWebhooks): ResolvedTarget {
  const t = settings.targets.find((x) => x.id === id);
  const enabled = t?.enabled ?? true;
  let url = t?.url ?? null;
  let envRefused = false;
  if (!url && id === "admin") {
    // The variable gets the same check the setting does (https, no user name or password): a value
    // that fails it is treated as no address at all, so nothing is ever POSTed to it.
    const envUrl = process.env.HUB_AGENT_WEBHOOK_URL?.trim() || null;
    if (envUrl && isAllowedWebhookUrl(envUrl)) url = envUrl;
    else if (envUrl) envRefused = true;
  }
  return { id, url, enabled, envRefused };
}

/** Why a target cannot be sent to, as the one line the Agent events screen shows. */
function noTargetReason(target: ResolvedTarget): string {
  if (!target.enabled) return "This agent is turned Off";
  if (target.envRefused) return "HUB_AGENT_WEBHOOK_URL is not an allowed https address";
  return "No receiving address is set";
}

/**
 * Whether Admin (the default target of eleven of the twelve event types) has an address, for the Agent
 * events banner, and whether that address is the HUB_AGENT_WEBHOOK_URL variable's (for the Agent
 * webhooks card). Booleans only; never the address and never the secret.
 */
export async function webhookConfigState(db: PrismaClient = defaultPrisma): Promise<{
  urlSet: boolean; secretSet: boolean; adminEnvUrlSet: boolean; adminEnvUrlRefused: boolean;
}> {
  const settings = await getAgentWebhooks(db);
  const admin = resolveTarget("admin", settings);
  const envUrl = process.env.HUB_AGENT_WEBHOOK_URL?.trim() || null;
  const envAllowed = envUrl !== null && isAllowedWebhookUrl(envUrl);
  return {
    urlSet: Boolean(admin.url),
    secretSet: Boolean(process.env.HUB_WEBHOOK_SECRET),
    // The variable itself: set and allowed (Admin falls back to it when no address is saved), or set and refused.
    adminEnvUrlSet: envAllowed,
    adminEnvUrlRefused: envUrl !== null && !envAllowed,
  };
}

// ── emit ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Record the event for its target and return the new row's id (the event_id). Throws on a database
 * or builder failure: callers use emitHubEventSafe, which never does.
 */
export async function emitHubEvent(input: EmitInput, db: PrismaClient = defaultPrisma, occurredAt: Date = new Date()): Promise<string> {
  const built = await build(input, db);
  const settings = await getAgentWebhooks(db);
  const targetId = targetIdFor(input.type, settings);
  const target = resolveTarget(targetId, settings);

  const id = randomUUID();
  // Scrub the built content only. event_id, type and occurred_at are made here and cannot carry a
  // secret, and a UUID's digit runs can look like a phone or card number to the scrubber: scrubbing
  // them changed about 2% of event_ids, so the body no longer matched X-RCE-Event-Id (answer 2).
  const secrets = await loadSecretValues();
  const body = scrub({ ...built.fields, summary: built.summary }, { withholdContact: true, secrets });
  const payload = { event_id: id, type: input.type, occurred_at: toChicagoIso(occurredAt), ...body };
  const reachable = Boolean(target.url) && target.enabled;
  await db.hubEvent.create({
    data: {
      id,
      eventKey: randomUUID(),
      type: input.type,
      payloadJson: JSON.stringify(payload),
      target: targetId,
      status: reachable ? "pending" : "no_target",
      nextAttemptAt: reachable ? new Date() : null,
      lastError: reachable ? null : noTargetReason(target),
    },
  });
  if (reachable) void deliverEvent(id, db).catch((err) => logSystemEvent("error", "agent_events", `Immediate delivery failed: ${errorLabel(err)}`));
  return id;
}

/**
 * The call every code site uses, as `void emitHubEventSafe({...})` after its own write has
 * committed. It NEVER throws or rejects: a failure is logged to SystemEvent (source agent_events) and
 * the caller carries on. It resolves to the event_id, or null when it could not record the event.
 */
export async function emitHubEventSafe(input: EmitInput, db: PrismaClient = defaultPrisma): Promise<string | null> {
  // Every draft decision (approve, edit, reject, auto-approve, blocked) comes through here: the open Messages
  // screens hear it too (ids only), so the queue and the badge move without a refresh.
  if (input.type === "approval.decided") announceDecision(input.messageId);
  try {
    return await emitHubEvent(input, db);
  } catch (err) {
    // A record that vanished between the business write and this (a test, a delete) is a warning; anything else is an error.
    logSystemEvent(err instanceof HubEventError && err.status === 404 ? "warn" : "error", "agent_events", `Could not record ${input.type}: ${errorLabel(err)}`);
    return null;
  }
}

// ── delivery ─────────────────────────────────────────────────────────────────────────────────────

/** The signature a receiver recomputes: sha256= + hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`). */
export function signEvent(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/** An error as one label that carries no address, host or secret. */
function errorLabel(err: unknown): string {
  if (err instanceof Error) return err.name === "AbortError" ? "timeout" : err.message.slice(0, 200);
  return "error";
}

type Outcome =
  | { kind: "delivered"; status: number }
  | { kind: "retry"; status: number | null; error: string }
  | { kind: "refused"; status: number };

async function post(url: string, event: HubEvent, secret: string): Promise<Outcome> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deliveryTimeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-RCE-Event-Id": event.id,
        "X-RCE-Timestamp": timestamp,
        "X-RCE-Signature": signEvent(secret, timestamp, event.payloadJson),
      },
      body: event.payloadJson,
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 200 && res.status < 300) return { kind: "delivered", status: res.status };
    if (res.status === 408 || res.status === 429 || res.status >= 500) return { kind: "retry", status: res.status, error: `Receiver answered HTTP ${res.status}` };
    return { kind: "refused", status: res.status };
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "AbortError" || controller.signal.aborted);
    return { kind: "retry", status: null, error: aborted ? "Timed out after 10 seconds" : "Could not connect to the receiving address" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Take the event for ONE delivery attempt, or null when it is not due or somebody else took it. The
 * claim is a conditional update that moves nextAttemptAt out (the lease), so two overlapping workers,
 * or the worker and the immediate send, cannot both send it.
 */
async function claim(id: string, db: PrismaClient, now: Date): Promise<HubEvent | null> {
  const row = await db.hubEvent.findUnique({ where: { id } });
  if (!row || (row.status !== "pending" && row.status !== "retrying")) return null;
  if (row.nextAttemptAt && row.nextAttemptAt > now) return null;
  const lease = new Date(now.getTime() + LEASE_MS);
  const won = await db.hubEvent.updateMany({
    where: { id, status: { in: ["pending", "retrying"] }, nextAttemptAt: row.nextAttemptAt },
    data: { nextAttemptAt: lease },
  });
  return won.count === 1 ? { ...row, nextAttemptAt: lease } : null;
}

/**
 * One delivery attempt of one event, if it is due and nobody else has it. Returns the event's status
 * after, or null when it did not run. Writes one HubEventAttempt row per real attempt. With no secret
 * it sends nothing, counts nothing and tries again in 30 seconds.
 */
export async function deliverEvent(id: string, db: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<string | null> {
  const event = await claim(id, db, now);
  if (!event) return null;

  const secret = process.env.HUB_WEBHOOK_SECRET;
  if (!secret) {
    await db.hubEvent.update({
      where: { id },
      data: { lastError: "HUB_WEBHOOK_SECRET not set", nextAttemptAt: new Date(now.getTime() + SECRET_UNSET_RETRY_MS) },
    });
    return event.status;
  }

  const settings = await getAgentWebhooks(db);
  const target = event.target ? resolveTarget(event.target as HubWebhookTargetId, settings) : null;
  if (!target || !target.url || !target.enabled) {
    await db.hubEvent.update({
      where: { id },
      data: {
        status: "no_target", nextAttemptAt: null,
        lastError: target ? noTargetReason(target) : "No receiving address is set",
      },
    });
    return "no_target";
  }

  const started = Date.now();
  inFlight.add(id);
  let outcome: Outcome;
  try {
    outcome = await post(target.url, event, secret);
  } finally {
    inFlight.delete(id);
  }
  const ms = Date.now() - started;
  const attempts = event.attempts + 1;

  const attempt: Prisma.HubEventAttemptUncheckedCreateInput = {
    eventId: id,
    statusCode: outcome.status,
    error: outcome.kind === "retry" ? outcome.error : outcome.kind === "refused" ? `Receiver refused (HTTP ${outcome.status}) — not retried` : null,
    ms,
  };

  let data: Prisma.HubEventUpdateManyMutationInput;
  if (outcome.kind === "delivered") {
    data = { status: "delivered", attempts, nextAttemptAt: null, lastError: null, lastStatusCode: outcome.status, deliveredAt: new Date() };
  } else if (outcome.kind === "refused") {
    data = {
      status: "dead", attempts, nextAttemptAt: null, lastStatusCode: outcome.status,
      lastError: `Receiver refused (HTTP ${outcome.status}) — not retried`,
    };
  } else if (attempts >= HUB_EVENT_MAX_ATTEMPTS) {
    data = { status: "dead", attempts, nextAttemptAt: null, lastStatusCode: outcome.status, lastError: `${outcome.error} — gave up after ${attempts} tries` };
  } else {
    const wait = HUB_EVENT_RETRY_SECONDS[attempts - 1] ?? HUB_EVENT_RETRY_SECONDS[HUB_EVENT_RETRY_SECONDS.length - 1];
    data = { status: "retrying", attempts, nextAttemptAt: new Date(Date.now() + wait * 1000), lastStatusCode: outcome.status, lastError: outcome.error };
  }
  // The outcome is written only while this attempt still holds the lease it claimed with. If a Resend
  // (or anything else) took the row over while the POST was in flight, the attempt is still logged but
  // it must not overwrite the status the newer attempt decided (a delivered event shown Retrying).
  const [, written] = await db.$transaction([
    db.hubEventAttempt.create({ data: attempt }),
    db.hubEvent.updateMany({ where: { id, nextAttemptAt: event.nextAttemptAt }, data }),
  ]);
  if (written.count === 1) return data.status as string;
  const current = await db.hubEvent.findUnique({ where: { id }, select: { status: true } });
  return current?.status ?? null;
}

/**
 * The worker's pass (every 30 seconds, server.ts): every event that is due, oldest first, a batch at
 * a time. Each goes through deliverEvent's claim, so a second run overlapping this one sends nothing
 * twice. Returns how many it tried.
 */
export async function deliverDueEvents(db: PrismaClient = defaultPrisma, now: Date = new Date(), limit = 25): Promise<number> {
  const due = await db.hubEvent.findMany({
    where: { status: { in: ["pending", "retrying"] }, nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let ran = 0;
  for (const { id } of due) {
    const status = await deliverEvent(id, db, now).catch((err) => {
      logSystemEvent("error", "agent_events", `Delivery pass failed: ${errorLabel(err)}`);
      return null;
    });
    if (status !== null) ran += 1;
  }
  return ran;
}

/**
 * Resend: try this event again now, as the SAME event (same id, prior attempts kept). A delivered
 * event is refused (the agents drop a repeat of an event_id, so it would do nothing). A row with no
 * target re-reads the CURRENT address first, so setting the address and pressing Resend delivers the
 * events that were kept.
 */
export async function resendEvent(id: string, db: PrismaClient = defaultPrisma): Promise<HubEvent> {
  const row = await db.hubEvent.findUnique({ where: { id } });
  if (!row) throw new HubEventError("Event not found", 404);
  if (row.status === "delivered") throw new HubEventError(RESEND_DELIVERED_REASON, 409);
  if (inFlight.has(id)) throw new HubEventError("This event is being sent right now - wait a moment and look again.", 409);
  const settings = await getAgentWebhooks(db);
  const targetId = row.target && (row.target === "admin" || row.target === "inventory")
    ? row.target as HubWebhookTargetId
    : targetIdFor(row.type as HubEventType, settings);
  await db.hubEvent.update({
    where: { id },
    data: { target: targetId, status: "pending", nextAttemptAt: new Date(), lastError: null },
  });
  await deliverEvent(id, db);
  return db.hubEvent.findUniqueOrThrow({ where: { id } });
}

// ── reading the log (the Agent events screen) ───────────────────────────────────────────────────

export interface HubEventView {
  id: string;
  type: string;
  createdAt: string;
  summary: string;
  status: string;
  target: string | null;
  attempts: number;
  lastError: string | null;
  lastStatusCode: number | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  attemptLog: Array<{ at: string; statusCode: number | null; error: string | null; ms: number | null }>;
}

function summaryOf(payloadJson: string): string {
  try {
    const parsed = JSON.parse(payloadJson) as { summary?: unknown };
    return typeof parsed.summary === "string" ? parsed.summary : "";
  } catch {
    return "";
  }
}

export function viewEvent(row: HubEvent & { attemptLog?: HubEventAttempt[] }): HubEventView {
  return {
    id: row.id,
    type: row.type,
    createdAt: toChicagoIso(row.createdAt),
    summary: summaryOf(row.payloadJson),
    status: row.status,
    target: row.target,
    attempts: row.attempts,
    lastError: row.lastError,
    lastStatusCode: row.lastStatusCode,
    nextAttemptAt: row.nextAttemptAt ? toChicagoIso(row.nextAttemptAt) : null,
    deliveredAt: row.deliveredAt ? toChicagoIso(row.deliveredAt) : null,
    attemptLog: (row.attemptLog ?? []).map((a) => ({ at: toChicagoIso(a.at), statusCode: a.statusCode, error: a.error, ms: a.ms })),
  };
}

export const EVENT_PAGE_SIZE = 50;

/** Newest first. `status` filters (retrying also covers pending); `before` is the createdAt of the last row seen. */
export async function listEvents(
  filter: { status?: string; type?: string; before?: Date; limit?: number },
  db: PrismaClient = defaultPrisma,
): Promise<{ events: HubEventView[]; nextBefore: string | null }> {
  const take = Math.min(Math.max(filter.limit ?? EVENT_PAGE_SIZE, 1), 200);
  const where: Prisma.HubEventWhereInput = {};
  if (filter.status === "retrying") where.status = { in: ["pending", "retrying"] };
  else if (filter.status && filter.status !== "all") where.status = filter.status;
  if (filter.type) where.type = filter.type;
  if (filter.before) where.createdAt = { lt: filter.before };
  const rows = await db.hubEvent.findMany({
    where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1,
    include: { attemptLog: { orderBy: { at: "asc" } } },
  });
  const page = rows.slice(0, take);
  return {
    events: page.map(viewEvent),
    nextBefore: rows.length > take ? page[page.length - 1].createdAt.toISOString() : null,
  };
}
