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
 * ONE EXCEPTION (W2, Kyle 2026-11-23 items 4 and 5, supersedes the ids-only rule for this type ONLY): message.team also
 * carries the author's first name (or the agent's key name), the message TEXT, mentions[] and a per-receiver reply_expected.
 * The text goes through the one scrub (agentApi/respond.ts scrub, withholdContact: phones, emails and street addresses become
 * "[withheld]" - team answer 4 stands, deliberately); the summary stays a template and NEVER holds the text (it shows on the Agent
 * events log). message.dev and message.inbound keep ids only.
 * Each type's builder below is a projection: it lists the fields it sends, so a field nobody listed
 * cannot leak. The finished payload then goes through the ONE scrub layer (agentApi/respond.ts
 * scrub), with every live technician token and every secret-named environment value as exact
 * matches, as a last net.
 *
 * SIGNING (team answer 2; per-agent secrets, work order C6b; W2 R-h). X-RCE-Signature is `sha256=` + hex HMAC-SHA256(secret,
 * `${X-RCE-Timestamp}.${payloadJson}`), and the same timestamp and signature are ALSO the last two members of the JSON body
 * ("timestamp", "signature"), because some receivers strip custom headers. The STORED payloadJson (HubEvent.payloadJson, scrubbed
 * once at emit) never holds them and is identical on every attempt; at each attempt the sender takes a FRESH timestamp (Unix seconds),
 * signs `${timestamp}.${payloadJson}` and splices `,"timestamp":"..","signature":".."` in before the final `}` (shared/hub/events.ts
 * wireBodyFor: a string splice, never a re-serialise), so the receiver's 5-minute window accepts a retry an hour later and a Resend.
 * RECEIVER RECIPE: take the raw body, cut it at the LAST `,"timestamp":`, append `}` - that is payloadJson; verify the HMAC over
 * `<timestamp>.<payloadJson>`; or use the headers when your platform shows them. Every type is sent this way, test.ping included.
 * (The scrub would drop a key named signature and redact the hex, which is why the two members are added AFTER it, at send time.)
 * event_id (the row id, also sent as X-RCE-Event-Id) never changes. With no secret set nothing is ever sent unsigned.
 * The secret is the target's OWN signing secret (Settings -> Agent webhooks, stored encrypted). Admin
 * with none falls back to HUB_WEBHOOK_SECRET, exactly as its address falls back to
 * HUB_AGENT_WEBHOOK_URL; Inventory with none has no secret, so its events are kept, not sent. ONE
 * function decides: signingSecretFor.
 *
 * CUSTOM HEADERS (work order C6b). A target may carry up to five custom headers (an Authorization
 * bearer, for example), stored encrypted. They are decrypted at EVERY attempt (so a retry and a Resend
 * carry them) and sent alongside X-RCE-Signature, X-RCE-Timestamp and X-RCE-Event-Id, which they can
 * never override. A value is never logged, never in a payload and never in an attempt error.
 *
 * TEST EVENTS (C6b). "Send test event" delivers ONE signed `test.ping` (event_id, type, occurred_at,
 * target; nothing else) to one target through the same deliverEvent, recorded as a HubEvent row so it
 * shows in the log. It is not a routable type, is never retried (the worker skips it) and is never
 * resent.
 *
 * RETRIES (team answer 1). Any 2xx is delivered. A 408, a 429, a 5xx, a timeout or a connection
 * error is retried at +30 seconds, 2 minutes, 10 minutes, 1 hour, 6 hours, and dead after the 6th
 * failure. Every other answer (the other 4xx, a redirect) is dead at once, not retried.
 *
 * WHERE IT GOES. Each event type has one target (shared/hub/events.ts DEFAULT_EVENT_ROUTES, changed by
 * Kyle in the owner setting `agentWebhooks`) - EXCEPT message.team, which is decided by the FAN-OUT (W2, Kyle 2026-11-23 item 4):
 * emitTeamMessageEvents writes ONE row per agent role whose live key can read the thread (and, in a group, is a member), all sharing
 * one eventKey, and never one for the role whose key wrote the message (the loop guard). A target's address is the setting's, or for
 * Admin the HUB_AGENT_WEBHOOK_URL variable. No address, or the target turned Off, records the event as
 * `no_target` (kept, never retried by the worker) until Resend finds an address.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { HubEvent, HubEventAttempt, Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { toChicagoIso } from "../../shared/calendarDay";
import { normalizeLeadPlatform } from "../../shared/leadPlatform";
import { closedLeadSource } from "../../shared/leadSources";
import {
  DEFAULT_EVENT_ROUTES, HUB_EVENT_MAX_ATTEMPTS, HUB_EVENT_RETRY_SECONDS, HUB_TEST_EVENT_TYPE, HUB_WEBHOOK_TARGET_LABELS,
  HUB_WEBHOOK_TARGET_IDS, RESEND_DELIVERED_REASON, TEST_RESEND_REASON, isFanOutEventType, isHubWebhookTargetId, wireBodyFor,
  type HubEventType, type HubWebhookTargetId,
} from "../../shared/hub/events";
import { hubKindsFor } from "../../shared/agentScopes";
import { parseMentions, replyExpectedFor } from "../../shared/hub/mentions";
import { isReservedWebhookHeader } from "../../shared/hub/webhookHeaders";
import { activeKeyWhere, currentAgentEnvironment } from "../agentApi/keys";
import { authorFirstName, loadSecretValues, scrub, scrubMessageText, type LinkedContacts } from "../agentApi/respond";
import { getAgentWebhooks, isAllowedWebhookUrl, type AgentWebhooks } from "./ownerSettings";
import { SettingSecretsError, decryptSecret } from "./settingSecrets";
import { announceDecision } from "./hubBus";
import { AI_ADMIN_SUB } from "./adminLogin";
import { getPrincipalLogin } from "./crmLogin";
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

/**
 * What an emitter hands over: the type and the ids of the records it happened to. Never a name or text. (message.team is not here:
 * it is written by emitTeamMessageEvents, one row per receiving agent, because its payload differs per receiver.)
 */
export type EmitInput =
  | { type: "message.inbound" | "message.dev"; messageId: string; context?: { kind: string; id: string } | null }
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

/** Where a conversation was started from: the caller's own context, else the thread's own record. */
function contextFor(
  thread: { kind: string; customerId: string | null; leadId: string | null; visitId: string | null }, threadId: string,
  given: { kind: string; id: string } | null | undefined,
): { kind: string; id: string } {
  return given
    ?? (thread.kind === "job" && thread.visitId ? { kind: "job", id: thread.visitId }
      : thread.kind === "customer" && thread.customerId ? { kind: "account", id: thread.customerId }
        : thread.kind === "customer" && thread.leadId ? { kind: "lead", id: thread.leadId }
          : { kind: thread.kind, id: threadId });
}

/** One builder per type: a projection that names every field it sends. */
async function build(input: EmitInput, db: PrismaClient): Promise<Built> {
  switch (input.type) {
    case "message.inbound":
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
      const context = contextFor(m.thread, m.threadId, input.context);
      const where = input.type === "message.inbound" ? "customer message" : "dev-thread message";
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

/**
 * Which target an event type goes to: Kyle's re-pointing, else the default table. A fan-out type (message.team) has no route: the
 * fan-out decides, so a stored routes["message.team"] is ignored (W2).
 */
export function targetIdFor(type: HubEventType, settings: AgentWebhooks): HubWebhookTargetId {
  if (isFanOutEventType(type)) return DEFAULT_EVENT_ROUTES[type];
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
 * Whether Admin (the default target of every routed event type: leads, estimates, payments, customer messages, jobs) has an address,
 * for the Agent events banner, and whether that address is the HUB_AGENT_WEBHOOK_URL variable's (for the Agent webhooks card). A Team,
 * group or crew-chat message goes to every agent whose key can read it, not to Admin alone (W2), so this is about Admin's own events.
 * Booleans only; never the address and never the secret.
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
    // Admin can sign: it has its own signing secret, or HUB_WEBHOOK_SECRET is set (the one signing rule).
    secretSet: Boolean(settings.targets.find((t) => t.id === "admin")?.signingSecret) || Boolean(process.env.HUB_WEBHOOK_SECRET),
    // The variable itself: set and allowed (Admin falls back to it when no address is saved), or set and refused.
    adminEnvUrlSet: envAllowed,
    adminEnvUrlRefused: envUrl !== null && !envAllowed,
  };
}

// ── what one delivery to a target is made of: its secret and its custom headers ─────────────────────

/** Why a target has nothing to sign with, as the one line the Agent events screen shows. */
function noSecretReason(id: HubWebhookTargetId): string {
  return id === "admin" ? "HUB_WEBHOOK_SECRET not set" : `No signing secret is set for ${HUB_WEBHOOK_TARGET_LABELS[id]}`;
}

export type DeliveryParts =
  | { ok: true; secret: string; headers: Headers }
  | { ok: false; error: string };

/**
 * The ONE signing rule: a target with its own secret signs with it; Admin with none signs with
 * HUB_WEBHOOK_SECRET; anything else has no secret (null). Throws SettingSecretsError when its own
 * secret cannot be decrypted (AGENT_KEY_PEPPER unset or changed).
 */
export function signingSecretFor(id: HubWebhookTargetId, settings: AgentWebhooks): string | null {
  const own = settings.targets.find((t) => t.id === id)?.signingSecret;
  if (own) return decryptSecret(own.enc);
  if (id === "admin") return process.env.HUB_WEBHOOK_SECRET || null;
  return null;
}

/** The target's custom headers, decrypted. A reserved name is skipped (it cannot be saved, and a hand-edited row must not override a signature header). */
function customHeadersFor(id: HubWebhookTargetId, settings: AgentWebhooks): Headers {
  const headers = new Headers();
  for (const h of settings.targets.find((t) => t.id === id)?.headers ?? []) {
    if (isReservedWebhookHeader(h.name)) continue;
    headers.set(h.name, decryptSecret(h.enc));
  }
  return headers;
}

/** Everything one attempt to this target needs, or the one-line reason it cannot go (never a secret or a header value). */
export function deliveryPartsFor(id: HubWebhookTargetId, settings: AgentWebhooks): DeliveryParts {
  let secret: string | null;
  try {
    secret = signingSecretFor(id, settings);
  } catch (err) {
    return { ok: false, error: err instanceof SettingSecretsError ? "The signing secret could not be read - is AGENT_KEY_PEPPER set?" : "The signing secret could not be read" };
  }
  if (!secret) return { ok: false, error: noSecretReason(id) };
  try {
    return { ok: true, secret, headers: customHeadersFor(id, settings) };
  } catch {
    // Fixed words only: the HTTP client's own message can quote the value it refused.
    return { ok: false, error: "A custom header could not be read - is AGENT_KEY_PEPPER set?" };
  }
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

// ── the team-thread fan-out (W2, Kyle 2026-11-23 items 4 and 5) ─────────────────────────────────────

/** The conversations an agent hears about message by message: a Team chat, a group chat and a job's crew chat (work order W2, R-b). */
const TEAM_THREAD_KINDS: readonly string[] = ["team", "group", "job"];
const AI_AUTHOR_TYPES: readonly string[] = ["ai_agent", "claude"];

/** The shared key of one message's rows: the same message always gets the same key, so announcing it twice cannot write it twice. */
export const teamEventKey = (messageId: string): string => `message.team:${messageId}`;

/**
 * The agent roles that hear of a new message in this thread: ONE rule, the same one the door reads with (hubKindsFor over the key's
 * scopes and thread-kind limit), over every live key (activeKeyWhere: not revoked, not expired, not retired, and of THIS deployment's
 * environment - a "test" key cannot authenticate in production, so it hears nothing there). A group thread also needs the key to be a
 * MEMBER. Two live keys of one role (a rotation's grace window) are ONE role, so the agent is woken once. Only roles that have a
 * webhook target count (Claude Code and Other do not). In the order the Agent webhooks card lists the agents.
 */
export async function receivingRolesFor(
  thread: { id: string; kind: string }, db: PrismaClient = defaultPrisma, now: Date = new Date(),
): Promise<HubWebhookTargetId[]> {
  const keys = await db.agentKey.findMany({
    where: { ...activeKeyWhere(now), environment: currentAgentEnvironment(), agentRole: { in: [...HUB_WEBHOOK_TARGET_IDS] } },
    select: { id: true, agentRole: true, scopes: true, hubThreadKinds: true },
  });
  let memberKeyIds: Set<string> | null = null;
  if (thread.kind === "group") {
    const members = await db.hubThreadMember.findMany({ where: { threadId: thread.id, agentKeyId: { not: null } }, select: { agentKeyId: true } });
    memberKeyIds = new Set(members.flatMap((m) => (m.agentKeyId ? [m.agentKeyId] : [])));
  }
  const roles = new Set<string>();
  for (const k of keys) {
    if (!(hubKindsFor(k.scopes, "read", k.hubThreadKinds) as string[]).includes(thread.kind)) continue;
    if (memberKeyIds && !memberKeyIds.has(k.id)) continue;
    roles.add(k.agentRole);
  }
  return HUB_WEBHOOK_TARGET_IDS.filter((id) => roles.has(id));
}

/**
 * Write the message.team events for ONE new, posted message in a Team, group or job crew chat: one HubEvent row per receiving agent
 * role (receivingRolesFor), all sharing one eventKey, each with its own payload (the text is scrubbed the same way, but reply_expected
 * differs per receiver). Returns the event ids it wrote ([] when nobody hears it, or the message was already announced).
 *
 * WHO WROTE IT decides two things. LOOP GUARD: the role whose key wrote the message never gets it back (authorBotKeyId -> AgentKey.agentRole).
 * An edit-and-approve copy of an agent's draft is re-authored as the approver (hubApproval.editApproveMessage: authorType office,
 * linked back by editedFromId), but the words were the agent's: it counts as written by the ORIGINAL agent for both the loop guard
 * and for mentions, so an edited "@Inventory ..." from Admin's draft wakes Inventory (reply_expected), never wakes Admin, and does not
 * give Admin the "nobody mentioned, so Admin answers" fallback as if Kyle had written it.
 *
 * A receiver with no address (or turned Off) gets its row as `no_target` and one with no signing secret waits, exactly as the single
 * target path always has: nothing is dropped silently, and it shows in that agent's Recent events.
 */
export async function emitTeamMessageEvents(
  input: { messageId: string; context?: { kind: string; id: string } | null }, db: PrismaClient = defaultPrisma, occurredAt: Date = new Date(),
): Promise<string[]> {
  const m = await db.hubMessage.findUnique({
    where: { id: input.messageId },
    include: {
      thread: true,
      attachments: { where: { deletedAt: null, removedAt: null }, select: { id: true } },
      editedFrom: { select: { authorType: true, authorBotKeyId: true, authorDisplay: true, authorKey: true } },
    },
  });
  if (!m) throw new HubEventError("Message not found", 404);
  if (!TEAM_THREAD_KINDS.includes(m.thread.kind)) return [];

  // Who really wrote it: an agent, or an approver's edited copy of an agent's draft, or a person.
  const agentAuthor = AI_AUTHOR_TYPES.includes(m.authorType)
    ? { keyId: m.authorBotKeyId, display: m.authorDisplay, kind: m.authorType, readerKey: m.authorKey }
    : m.editedFromId && m.editedFrom && AI_AUTHOR_TYPES.includes(m.editedFrom.authorType)
      ? { keyId: m.editedFrom.authorBotKeyId, display: m.editedFrom.authorDisplay, kind: m.editedFrom.authorType, readerKey: m.editedFrom.authorKey }
      : null;
  const authorKey = agentAuthor?.keyId ? await db.agentKey.findUnique({ where: { id: agentAuthor.keyId }, select: { agentRole: true } }) : null;
  // LOOP GUARD, the AI admin session (Settings -> AI admin login): the Admin agent's own login to the CRM writes ai_agent posts with no
  // AgentKey (authorBotKeyId null, authorKey "ai-admin"). Those are Admin's words, so they count as written by role admin: Admin is never
  // sent its own post back, and author_agent reads "admin" (Kyle 2026-11-23 item 5: "never send an agent its own post back").
  const authorRole = authorKey?.agentRole ?? (agentAuthor && agentAuthor.readerKey === AI_ADMIN_SUB ? "admin" : null);
  // The person id is Technician.id. Kyle's PIN session (reader kind owner) stores no technician on the message; it acts as the
  // principal login's person (hub.ts personIdOf), so the same post from the field app and from the CRM PIN carries the same id.
  const personId = agentAuthor ? null : m.authorTechnicianId ?? (m.authorKey === "owner" ? (await getPrincipalLogin(db))?.technicianId ?? null : null);

  const receivers = (await receivingRolesFor(m.thread, db, occurredAt)).filter((role) => role !== authorRole);
  if (receivers.length === 0) return [];

  const eventKey = teamEventKey(m.id);
  const settings = await getAgentWebhooks(db);
  const secrets = await loadSecretValues(); // once for the whole fan-out, not once per receiver
  // The same text pass the door gives every key's read (profiles.ts projectMessageRead -> scrubMessageText), with the linked record's
  // own phone, email and address removed exactly for a crew chat. Mentions are parsed from the RAW body, before any scrub.
  const mentions = parseMentions(m.body);
  let linked: LinkedContacts | undefined;
  if (m.thread.customerId || m.thread.leadId || m.thread.visitId || m.thread.phone) {
    // Imported on demand: hubDoor imports the hub, which imports this file.
    linked = await (await import("../agentApi/hubDoor")).linkedFor([m.thread]);
  }
  const text = scrubMessageText(m.body, linked);
  const context = contextFor(m.thread, m.threadId, input.context);

  const rows = receivers.map((role) => {
    const id = randomUUID();
    const target = resolveTarget(role, settings);
    const reachable = Boolean(target.url) && target.enabled;
    // Scrub the built content only (event_id, type, occurred_at and created_at are made here; see emitHubEvent).
    const body = scrub({
      thread_id: m.threadId,
      message_id: m.id,
      thread_kind: m.thread.kind,
      // person | agent. author_kind keeps the stored kind (tech, office, ai_agent, claude) for a receiver that tells them apart.
      author_type: agentAuthor ? "agent" : "person",
      author_kind: agentAuthor ? agentAuthor.kind : m.authorType,
      // A person's FIRST name or the agent's key name: a team-thread author is never a customer.
      author_name: agentAuthor ? agentAuthor.display : authorFirstName(m.authorDisplay, true),
      author_id: idOnly(personId),
      author_agent: authorRole,
      text,
      mentions,
      reply_expected: replyExpectedFor(role, mentions, agentAuthor === null),
      context: { kind: context.kind, id: context.id },
      attachment_ids: m.attachments.map((a) => a.id),
      summary: "New team message",
    }, { withholdContact: true, secrets });
    const payload = { event_id: id, type: "message.team", occurred_at: toChicagoIso(occurredAt), created_at: toChicagoIso(m.createdAt), ...body };
    return {
      reachable,
      data: {
        id, eventKey, type: "message.team", payloadJson: JSON.stringify(payload), target: role,
        status: reachable ? "pending" : "no_target",
        nextAttemptAt: reachable ? occurredAt : null,
        lastError: reachable ? null : noTargetReason(target),
      },
    };
  });

  // One row per target per message, however many times the message is announced: the lock and the check make a second call a no-op.
  const wrote = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${eventKey}))`;
    if ((await tx.hubEvent.count({ where: { eventKey } })) > 0) return false;
    await tx.hubEvent.createMany({ data: rows.map((r) => r.data) });
    return true;
  });
  if (!wrote) return [];
  for (const r of rows) {
    if (r.reachable) void deliverEvent(r.data.id, db).catch((err) => logSystemEvent("error", "agent_events", `Immediate delivery failed: ${errorLabel(err)}`));
  }
  return rows.map((r) => r.data.id);
}

/** The call fanOutMessage makes, as `void emitTeamMessageEventsSafe({...})` after the message is committed. Never throws. */
export async function emitTeamMessageEventsSafe(
  input: { messageId: string; context?: { kind: string; id: string } | null }, db: PrismaClient = defaultPrisma,
): Promise<string[]> {
  try {
    return await emitTeamMessageEvents(input, db);
  } catch (err) {
    logSystemEvent(err instanceof HubEventError && err.status === 404 ? "warn" : "error", "agent_events", `Could not record message.team: ${errorLabel(err)}`);
    return [];
  }
}

// ── delivery ─────────────────────────────────────────────────────────────────────────────────────

/** The signature a receiver recomputes: sha256= + hex HMAC-SHA256(secret, `${timestamp}.${payloadJson}`) - the body WITHOUT the timestamp and signature members. */
export function signEvent(secret: string, timestamp: string, payloadJson: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${payloadJson}`).digest("hex")}`;
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

async function post(url: string, event: HubEvent, secret: string, custom: Headers): Promise<Outcome> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  // The custom headers first, then the CRM's own with .set: a custom header can never override these.
  const headers = new Headers(custom);
  headers.set("Content-Type", "application/json");
  headers.set("X-RCE-Event-Id", event.id);
  headers.set("X-RCE-Timestamp", timestamp);
  const signature = signEvent(secret, timestamp, event.payloadJson);
  headers.set("X-RCE-Signature", signature);
  // W2 (Kyle 2026-11-23): the same timestamp and signature are ALSO the last two members of the body, for receivers that strip custom
  // headers. The signed text is the STORED payloadJson, never this wire body (a body cannot contain its own signature).
  const wireBody = wireBodyFor(event.payloadJson, timestamp, signature);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deliveryTimeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers,
      body: wireBody,
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

const MESSAGE_DELETED_NOT_SENT = "The message was deleted - not sent";
const CANNOT_READ_NOT_SENT = "This agent can no longer read that conversation - not sent";

/** Why a queued message.team row must not be sent now, or null when it may go. */
async function teamRowStopReason(event: HubEvent, db: PrismaClient, now: Date): Promise<string | null> {
  let messageId: unknown;
  try { messageId = (JSON.parse(event.payloadJson) as { message_id?: unknown }).message_id; } catch { return null; }
  if (typeof messageId !== "string") return null;
  const msg = await db.hubMessage.findUnique({ where: { id: messageId }, select: { deletedAt: true, thread: { select: { id: true, kind: true } } } });
  if (!msg || msg.deletedAt) return MESSAGE_DELETED_NOT_SENT;
  const roles = await receivingRolesFor(msg.thread, db, now);
  return roles.includes(event.target as HubWebhookTargetId) ? null : CANNOT_READ_NOT_SENT;
}

/** The stored payload with the message text (and who it mentions) taken out, for a row that will never be sent. */
function withoutText(payloadJson: string): string {
  try {
    const p = JSON.parse(payloadJson) as Record<string, unknown>;
    delete p.text;
    delete p.mentions;
    return JSON.stringify(p);
  } catch { return payloadJson; }
}

/**
 * Mark a message's unsent message.team rows dead (and drop their text): the message was deleted. Delivered rows are history and stay.
 * Called inside softDeleteMessage's transaction.
 */
export async function voidTeamEventsForDeletedMessage(tx: Prisma.TransactionClient, messageId: string): Promise<void> {
  const rows = await tx.hubEvent.findMany({
    where: { eventKey: teamEventKey(messageId), status: { in: ["pending", "retrying", "no_target"] } },
    select: { id: true, payloadJson: true },
  });
  for (const r of rows) {
    await tx.hubEvent.update({
      where: { id: r.id },
      data: { status: "dead", nextAttemptAt: null, lastError: MESSAGE_DELETED_NOT_SENT, payloadJson: withoutText(r.payloadJson) },
    });
  }
}

/**
 * One delivery attempt of one event, if it is due and nobody else has it. Returns the event's status
 * after, or null when it did not run. Writes one HubEventAttempt row per real attempt. With no secret
 * it sends nothing, counts nothing and tries again in 30 seconds.
 */
export async function deliverEvent(id: string, db: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<string | null> {
  const event = await claim(id, db, now);
  if (!event) return null;

  const isTest = event.type === HUB_TEST_EVENT_TYPE;

  // W2 (Kyle 2026-11-23 item 4): a message.team row holds the message's full text from the moment it is written, and may wait a long time
  // (no signing secret yet, a receiver that keeps answering 5xx, a Resend). So at SEND time, every time, the message must still exist and
  // this agent must still be allowed to read that conversation (key live, still able to read the kind, still a group member). Otherwise
  // the text is not sent and the row ends dead with the reason: the door's read would not show it to this agent either.
  if (event.type === "message.team" && isHubWebhookTargetId(event.target)) {
    const stop = await teamRowStopReason(event, db, now);
    if (stop) {
      await db.hubEvent.update({ where: { id }, data: { status: "dead", nextAttemptAt: null, lastError: stop, payloadJson: withoutText(event.payloadJson) } });
      return "dead";
    }
  }

  const settings = await getAgentWebhooks(db);
  const targetId = isHubWebhookTargetId(event.target) ? event.target : null;
  const target = targetId ? resolveTarget(targetId, settings) : null;
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

  // This target's signing secret and custom headers (one rule: signingSecretFor). With no secret, or
  // one that cannot be read, nothing is sent and nothing is counted: the event waits 30 seconds and
  // looks again. A test is one try, so it ends here instead.
  const parts = deliveryPartsFor(target.id, settings);
  if (!parts.ok) {
    if (isTest) {
      await db.hubEvent.update({ where: { id }, data: { status: "dead", nextAttemptAt: null, lastError: `${parts.error} - the test was not sent` } });
      return "dead";
    }
    await db.hubEvent.update({
      where: { id },
      data: { lastError: parts.error, nextAttemptAt: new Date(now.getTime() + SECRET_UNSET_RETRY_MS) },
    });
    return event.status;
  }

  const started = Date.now();
  inFlight.add(id);
  let outcome: Outcome;
  try {
    outcome = await post(target.url, event, parts.secret, parts.headers);
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
  } else if (isTest) {
    // A test is one try: a timeout or a 5xx is the answer, not a reason to retry.
    data = { status: "dead", attempts, nextAttemptAt: null, lastStatusCode: outcome.status, lastError: `${outcome.error} - a test is not retried` };
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
    where: { status: { in: ["pending", "retrying"] }, nextAttemptAt: { lte: now }, type: { not: HUB_TEST_EVENT_TYPE } },
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
  if (row.type === HUB_TEST_EVENT_TYPE) throw new HubEventError(TEST_RESEND_REASON, 409);
  if (row.status === "delivered") throw new HubEventError(RESEND_DELIVERED_REASON, 409);
  if (inFlight.has(id)) throw new HubEventError("This event is being sent right now - wait a moment and look again.", 409);
  const settings = await getAgentWebhooks(db);
  const targetId = isHubWebhookTargetId(row.target) ? row.target : targetIdFor(row.type as HubEventType, settings);
  await db.hubEvent.update({
    where: { id },
    data: { target: targetId, status: "pending", nextAttemptAt: new Date(), lastError: null },
  });
  await deliverEvent(id, db);
  return db.hubEvent.findUniqueOrThrow({ where: { id } });
}

/** What "Send test event" answers: the logged row and how the receiver answered. */
export interface TestEventResult {
  event: HubEventView;
  statusCode: number | null;
  ms: number | null;
  error: string | null;
}

/**
 * Deliver ONE signed test.ping to ONE target now, with its custom headers, through the same
 * deliverEvent as a real event. The payload is exactly event_id, type, occurred_at and target (no
 * summary, no ids of records, nothing personal). Recorded as a HubEvent row for that target so it shows
 * in the log; it is not retried and cannot be resent. Refused 409, with the reason in words, when the
 * target has no address, is turned Off or has nothing to sign with.
 */
export async function sendTestEvent(targetId: HubWebhookTargetId, db: PrismaClient = defaultPrisma): Promise<TestEventResult> {
  const settings = await getAgentWebhooks(db);
  const target = resolveTarget(targetId, settings);
  if (!target.enabled) throw new HubEventError(`${HUB_WEBHOOK_TARGET_LABELS[targetId]} is turned Off - turn it on first.`, 409);
  if (!target.url) throw new HubEventError(`${HUB_WEBHOOK_TARGET_LABELS[targetId]} has no receiving address - set one first.`, 409);
  const parts = deliveryPartsFor(targetId, settings);
  if (!parts.ok) throw new HubEventError(parts.error, 409);

  const id = randomUUID();
  const payload = { event_id: id, type: HUB_TEST_EVENT_TYPE, occurred_at: toChicagoIso(new Date()), target: targetId };
  await db.hubEvent.create({
    data: { id, eventKey: randomUUID(), type: HUB_TEST_EVENT_TYPE, payloadJson: JSON.stringify(payload), target: targetId, status: "pending", nextAttemptAt: null },
  });
  await deliverEvent(id, db);
  const row = await db.hubEvent.findUniqueOrThrow({ where: { id }, include: { attemptLog: { orderBy: { at: "asc" } } } });
  const last = row.attemptLog[row.attemptLog.length - 1];
  return {
    event: viewEvent(row),
    statusCode: last?.statusCode ?? null,
    ms: last?.ms ?? null,
    error: row.status === "delivered" ? null : (row.lastError ?? last?.error ?? null),
  };
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
    summary: summaryOf(row.payloadJson) || (row.type === HUB_TEST_EVENT_TYPE ? "Test event (ids only)" : ""),
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
  filter: { status?: string; type?: string; target?: HubWebhookTargetId; before?: Date; limit?: number },
  db: PrismaClient = defaultPrisma,
): Promise<{ events: HubEventView[]; nextBefore: string | null }> {
  const take = Math.min(Math.max(filter.limit ?? EVENT_PAGE_SIZE, 1), 200);
  const where: Prisma.HubEventWhereInput = {};
  if (filter.status === "retrying") where.status = { in: ["pending", "retrying"] };
  else if (filter.status && filter.status !== "all") where.status = filter.status;
  if (filter.type) where.type = filter.type;
  if (filter.target) where.target = filter.target;
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
