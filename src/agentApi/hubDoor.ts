/**
 * The agents' REST door onto the Messages hub (work order agent-team, K-U7 = BA3). It is NOT a second
 * router: the three routes below are the CRM's own hub routes (routes/hub.ts), which call into here when
 * the actor is an agent key (req.agentPrincipal, set by the agent gate, src/agentApi/gate.ts). The
 * entries that let a key reach them are the three AGENT_KEY_ROUTES in middleware/publicRoutes.ts:
 *
 *   GET  /api/hub/threads                 any scope that opens a kind (HUB_KIND_SCOPES; the gate takes any one of them) - the threads the key
 *                                         may read (filters: kind, status, since; NO search)
 *   GET  /api/hub/threads/:id/messages    the same scopes - one thread and its messages (the path the team's contract names)
 *   POST /api/hub/messages                hub:draft (customer message) / team:reply (Team, group, job crew chat) / training:write: a customer
 *                                         email or text is SENT when it is posted (Kyle 2026-11-24, no check-ins: services/hubDrafts.ts and
 *                                         hubAgentSend.ts, through every guard); a Training post is published; a Team, group or crew post is
 *                                         published at once when its key's "Team posts publish immediately" box is ticked, else it waits.
 *                                         The answer says which (status) and, when a customer message did not go, why (not_sent_reason),
 *                                         or, when a team post waits, why (pending_reason).
 *
 * W2-B: each of the three is a CORE (listThreadsCore, threadDetailCore, createMessageCore) that takes a DoorCall instead of an Express request. The REST
 * handlers below are thin wrappers; the /mcp tools list_threads, read_thread and post_message (src/agentApi/tools.ts) call the SAME cores, so the
 * scrub, the idempotency table, the draft slot, the agent-loop limit and the Team publish rule are one implementation.
 *
 * Every other hub route (approve, edit-approve, reject, send, audit, stream, attachments, push, thread
 * writes) is refused to an agent key by the session gate (401) and again by `withReader` (403).
 *
 * What an agent can and cannot do here, and where it is enforced:
 *   * ONE reader. readerFor(req) turns the key into a HubReader of kind "agent" carrying the key's
 *     hubThreadKinds; the author of every row it writes is forced from that reader (name, key id, type),
 *     never from the body.
 *   * GROUPS (C7). An office-made group chat is read and posted in as a Team post (team:reply), and ONLY by a key that
 *     is a member of it: a group the key is not in is the same 404 as an unknown id, and is not in its list.
 *   * THREAD KINDS. Which kinds a key may read or draft in comes from its scopes (shared/agentScopes.ts
 *     HUB_KIND_SCOPES: customer = hub:read / hub:draft, job (the crew chat) = team:read, team:reply or hub:read to read and team:reply to post,
 *     team and group = team:read or team:reply to read and team:reply to post, dev = dev:read, training = training:read or training:write), narrowed by its hubThreadKinds. A thread of a kind
 *     the key may not use is 403 (not 404), on a read and on a write. An agent never creates a team thread
 *     (team answer 9a) and never a dev thread (step 7): a record link makes a CUSTOMER thread only.
 *   * NO SEARCH. `q` is refused to an agent: a search that matches raw titles and bodies would let a key rebuild a
 *     phone, email, address or withheld name by guessing.
 *   * STATUS. missing (or the old 'pending_approval', kept so an older agent script still works) = send now; 'draft' = a draft that goes
 *     nowhere; anything else = 403 and no row. createDraftMessage and postMessageResult refuse the same again.
 *   * CLASS. messageClass and purposeKey are never read from the body: createMessageRow derives them
 *     from `category`, which is validated against shared/hub/messageCategories.ts.
 *   * RECIPIENT. A draft takes no address, phone or cc (400): the CRM fills the recipient in at send.
 *   * ANSWERS. Every body an agent receives goes through agentRespond with the one message-read profile
 *     (team answer 4): no phone, email or street address, no toAddress, no cc, no thread phone.
 *   * WRITES. Through withIdempotency (idempotency_key required) with the audit row inside the same
 *     transaction as the idempotency record; a retry returns the first draft. The draft's clientMessageId is
 *     made from the key AND the request, so a corrected request under a reused key is a new draft.
 *
 * Nothing in this file imports hubSend, hubApproval or any decision function, and none may.
 */
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import type { HubThread, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { withKeyedMutex } from "../lib/keyedMutex";
import { HubError, agentPostCategory, ensureThreadFor, memberGroupIds, postMessageResult, type HubReader } from "../services/hub";
import { LAST_LINE_MAX, listThreads, threadDetail } from "../services/hubInbox";
import { createDraftMessage } from "../services/hubDrafts";
import { notSentReasonFor } from "../services/hubAgentSend";
import { campaignFirstName } from "../services/emailCampaigns";
import { messageCategoryFor } from "../../shared/hub/messageCategories";
import {
  agentScopeChoiceText, hubKindsFor, hubRouteScopes, HUB_KIND_SCOPES, HUB_THREAD_KINDS, isHubThreadKind, type AgentScope, type HubKindAccess,
} from "../../shared/agentScopes";
import { AgentApiError, toAgentError, type AgentErrorCode } from "./errors";
import {
  agentDateTime, agentRespond, authorFirstName, scrubMessageText, scrubTrainingText, toChicagoIso, type AgentToolOutput, type LinkedContacts,
} from "./respond";
import {
  hubDraftResultSchema, hubThreadDetailSchema, hubThreadListSchema, projectMessageRead, projectScoutTrainingMessage,
  scoutTrainingThreadDetailSchema, scoutTrainingThreadListSchema, type HubMessageRead, type HubThreadRead,
} from "./profiles";
import {
  agentAuditRecord, finishAgentCall, reserveAgentDraftSlot, sendAgentResult, type AgentPrincipal, type AgentRequest, type FinishAgentCall,
} from "./gate";
import { recordAgentCall, type AgentCallRecord } from "./audit";
import { idempotencyKeySchema, requestHashOf, withIdempotency } from "./idempotency";

// ── the tools (what the one response layer answers with, by scope) ───────────────────────────────

// W2 (trap T2): EVERY scope that can open the tool must have a profile here, or a key the gate lets in (a team-only reader, a team-only poster) would
// be refused by agentRespond AFTER the message was already written. The lists come from the one table (HUB_KIND_SCOPES), so they cannot drift from the gate.
const profilesFor = (scopes: readonly AgentScope[], schema: z.ZodType) => scopes.map((scope) => ({ scope, schema, withholdContact: true }));
const THREADS_OUT: AgentToolOutput = { name: "hub.threads.list", profiles: profilesFor(hubRouteScopes("read"), hubThreadListSchema) };
const THREAD_OUT: AgentToolOutput = { name: "hub.threads.get", profiles: profilesFor(hubRouteScopes("read"), hubThreadDetailSchema) };
// A key limited to training threads (Scout) is answered with the Scout training profile (amendment 16a), not the
// every-key one. The door chooses it; the scopes here are only what agentRespond needs to find a profile.
const SCOUT_THREADS_OUT: AgentToolOutput = {
  name: "hub.threads.list",
  profiles: [
    { scope: "training:read", schema: scoutTrainingThreadListSchema, withholdContact: true },
    { scope: "training:write", schema: scoutTrainingThreadListSchema, withholdContact: true },
  ],
};
const SCOUT_THREAD_OUT: AgentToolOutput = {
  name: "hub.threads.get",
  profiles: [
    { scope: "training:read", schema: scoutTrainingThreadDetailSchema, withholdContact: true },
    { scope: "training:write", schema: scoutTrainingThreadDetailSchema, withholdContact: true },
  ],
};
const DRAFT_OUT: AgentToolOutput = { name: "hub.messages.draft", profiles: profilesFor(hubRouteScopes("post"), hubDraftResultSchema) };

/** The one operation name idempotency stores (a later /mcp draft tool shares it, so a retry through the other door replays). */
export const DRAFT_OPERATION = "hub.messages.draft";

/** Tags an agent may put on a draft. Today only the opt-out hint (team answer 7), and only on a customer draft. */
export const AGENT_DRAFT_TAGS = ["possible_opt_out"] as const;

// ── errors ───────────────────────────────────────────────────────────────────────────────────────

/**
 * W2-B (one tool for one task): the hub door's three operations are CORES that take a DoorCall instead of an Express request, so the REST routes
 * (the thin wrappers at the foot of each section) and the /mcp tools (src/agentApi/registry.ts) run the SAME code - the same scrub, idempotency
 * table, draft slot, agent-loop limit, Team publish path and pending_reason. A DoorCall is what a core needs from "the call it is part of".
 */
export interface DoorCall {
  principal: AgentPrincipal;
  /** The scope that opened the thread kind, for the audit row (HUB_KIND_SCOPES), when it is not the one the gate matched. */
  markScope(scope: string): void;
  /** Take one of the key's draft slots for a CUSTOMER draft: null when taken, else the seconds to wait. */
  reserveDraft(): Promise<number | null>;
  /** The audit row for a WRITE, as data, built with this call's tool, route and scope; the core inserts it inside the idempotency transaction. */
  auditRecord(result: FinishAgentCall): AgentCallRecord;
}

/** What a core answers with. `auditWritten` is true when the core already inserted the call's audit row (a fresh write does, inside its transaction). */
export interface DoorResult {
  status: number;
  body: unknown;
  recordIds: string[];
  replayed?: boolean;
  auditWritten?: boolean;
  idempotencyKey?: string;
}

/** The REST door's DoorCall: the request the gate accepted (the hub routes here and the price-book routes, src/routes/agentPriceBook.ts). */
export function restCall(req: Request, res: Response): DoorCall {
  const state = req as AgentRequest;
  return {
    principal: state.agentPrincipal!,
    markScope: (scope) => { if (state.agentCall) state.agentCall.scopeUsed = scope; },
    reserveDraft: () => reserveAgentDraftSlot(req, res),
    auditRecord: (result) => agentAuditRecord(req, result),
  };
}

/** A hub refusal as the agent error it is. The sentence is scrubbed: it can name a record, never reveal contact details. */
export function agentErrorFrom(err: unknown): unknown {
  if (err instanceof HubError) {
    const code: AgentErrorCode = err.status === 404 ? "not_found" : err.status === 403 ? "forbidden" : "bad_request";
    return new AgentApiError(code, { reason: scrubMessageText(err.message) });
  }
  return err;
}

/** Answer a failed agent call: map it, write the ONE audit row, send the body. Never throws. */
export async function agentRefusal(req: Request, res: Response, err: unknown): Promise<void> {
  const state = req as AgentRequest;
  const route = state.agentCall?.route ? `${req.method} ${state.agentCall.route.path}` : req.method;
  const { status, body } = toAgentError(agentErrorFrom(err), route);
  if (body.retry_after !== undefined) res.setHeader("Retry-After", String(body.retry_after));
  await finishAgentCall(req, res, { status, body, resultCode: body.code });
}

const forbidden = (reason: string): AgentApiError => new AgentApiError("forbidden", { reason });
const badRequest = (reason: string): AgentApiError => new AgentApiError("bad_request", { reason });

// ── which threads a key may touch ────────────────────────────────────────────────────────────────

type Access = Exclude<HubKindAccess, "any">;

/** The kinds this key may read, or draft in: what its scopes open (HUB_KIND_SCOPES), narrowed by its hubThreadKinds. */
const kindsFor = (reader: HubReader, access: Access): string[] => hubKindsFor(reader.agentScopes ?? [], access, reader.threadKinds);

const kindAllowed = (reader: HubReader, kind: string, access: Access): boolean => kindsFor(reader, access).includes(kind);

/**
 * W2 audit: once the thread is known, the audit row's scopeUsed is the scope that opened THAT kind (HUB_KIND_SCOPES), not the first any-of scope the gate matched
 * for the whole route - an Admin key posting in the Team chat is audited as team:reply, never as hub:draft (Draft customer). The gate's value stays when the kind
 * names none the key holds. Both finishAgentCall and agentAuditRecord copy it from the call.
 */
function markScopeUsed(call: DoorCall, reader: HubReader, kind: string, access: Access): void {
  if (!isHubThreadKind(kind)) return;
  const held = HUB_KIND_SCOPES[kind][access].find((s) => (reader.agentScopes ?? []).includes(s));
  if (held) call.markScope(held);
}

const kindName = (kind: string): string => (isHubThreadKind(kind) ? HUB_THREAD_KINDS[kind] : kind).toLowerCase();

/**
 * Why a kind is refused: the key's own kind limit, the dev door, or the scope that would open it - named the way Settings -> Agent keys names it
 * (W2: "Read team (team:read)"), so Kyle or the agent's author can tick the right box.
 */
function refusalSentence(reader: HubReader, kind: string, access: Access): string {
  if (reader.threadKinds.length > 0 && !reader.threadKinds.includes(kind)) {
    return `This key may only use ${reader.threadKinds.join(", ")} threads. Change the limit on Settings \u2192 Agent keys.`;
  }
  if (kind === "dev" && access === "post") return "Dev threads are written through the dev door, not here.";
  const needed = isHubThreadKind(kind) ? HUB_KIND_SCOPES[kind][access] : [];
  if (needed.length === 0) return `This key's scopes do not open ${kindName(kind)} threads.`;
  return `This key needs ${agentScopeChoiceText(needed)} to ${access === "post" ? "post in" : "read"} ${kindName(kind)} threads. Tick it on Settings \u2192 Agent keys.`;
}

/**
 * The 403 for a key whose scopes (with its thread limit) open no conversation to read at all. It used to be a quiet 200 with an empty list (the
 * 2026-11-23 Facebook failure); now it says which box to tick, or which limit to change.
 */
function noKindsSentence(reader: HubReader): string {
  const scopes = reader.agentScopes ?? [];
  if (reader.threadKinds.length > 0 && hubKindsFor(scopes, "read", []).length > 0) {
    const open = hubKindsFor(scopes, "read", []).map(kindName).join(", ");
    const wantedForLimit = [...new Set(reader.threadKinds.flatMap((k) => (isHubThreadKind(k) ? HUB_KIND_SCOPES[k].read : [])))];
    const needs = wantedForLimit.length > 0 ? ` It needs ${agentScopeChoiceText(wantedForLimit)} for ${reader.threadKinds.join(", ")} threads.` : "";
    return `This key is limited to ${reader.threadKinds.join(", ")} threads, but its scopes open only ${open} threads.${needs} Tick it, or change the limit, on Settings \u2192 Agent keys.`;
  }
  const wanted = reader.threadKinds.length > 0
    ? [...new Set(reader.threadKinds.flatMap((k) => (isHubThreadKind(k) ? HUB_KIND_SCOPES[k].read : [])))]
    : hubRouteScopes("read");
  return `This key needs ${agentScopeChoiceText(wanted)}. Tick it on Settings \u2192 Agent keys.`;
}

/**
 * The thread by id, or 404; a thread of a kind the key may not use is 403 (team answer 16a), not hidden. A GROUP (C7) the
 * key is not a member of is answered EXACTLY like an id nobody has - the same 404, checked BEFORE the kind and scope
 * rules - so a key cannot tell a group it is not in from one that does not exist.
 */
async function threadFor(reader: HubReader, id: string, access: Access): Promise<HubThread> {
  const thread = await prisma.hubThread.findUnique({ where: { id } });
  if (!thread || (thread.kind === "group" && !(await memberGroupIds(reader, [thread.id])).has(thread.id))) {
    throw new AgentApiError("not_found", { reason: "Conversation not found." });
  }
  if (!kindAllowed(reader, thread.kind, access)) throw forbidden(refusalSentence(reader, thread.kind, access));
  return thread;
}

/**
 * The Scout training profile (no record links, the apprentice's first name only, the customers' names removed) is the answer for the Scout KEY (its role) and
 * for any key limited to training threads - W2 trap T4: Scout lost its "training only" limit, so the choice can no longer rest on the limit alone. It needs one of the
 * training scopes, or the profile list would have nothing the key holds. For a thread that is not a training one the every-key message profile still answers.
 */
const scoutShaped = (reader: HubReader): boolean => {
  const holdsTraining = (reader.agentScopes ?? []).some((s) => s === "training:read" || s === "training:write");
  const trainingOnly = reader.threadKinds.length > 0 && reader.threadKinds.every((k) => k === "training");
  return holdsTraining && (trainingOnly || reader.agentRole === "scout");
};

// ── projections: what an agent sees of the CRM's own reads ───────────────────────────────────────

type Linked = {
  phones: string[]; emails: string[]; addresses: string[]; names: string[];
  /** thread id -> the full name of the contact a customer, lead or job thread is about (turned into a first name at the title). */
  titleNames: Map<string, string>;
} & LinkedContacts;

const addressText = (p: { addressLine1: string; city: string; state: string; postalCode: string }): string =>
  `${p.addressLine1}, ${p.city}, ${p.state} ${p.postalCode}`;

/**
 * The phone, email and address strings of the records these threads hang on, so the text passes can remove
 * them exactly. For a TRAINING thread, also the full names of the customers on the apprentice's assigned
 * visits (Scout's extra name removal, ruling R2). Also who each customer, lead and job thread is about, for
 * its first-name title. One round of queries for all the threads.
 */
export async function linkedFor(threads: readonly HubThread[]): Promise<Linked> {
  const customerIds = new Set<string>();
  const leadIds = new Set<string>();
  const visitIds = new Set<string>();
  const trainingTechs = new Set<string>();
  const out = {
    phones: [] as string[], emails: [] as string[], addresses: [] as string[], names: [] as string[],
    titleNames: new Map<string, string>(),
  };
  for (const t of threads) {
    if (t.customerId) customerIds.add(t.customerId);
    if (t.leadId) leadIds.add(t.leadId);
    if (t.visitId) visitIds.add(t.visitId);
    if (t.phone) out.phones.push(t.phone);
    if (t.kind === "training" && t.technicianId) trainingTechs.add(t.technicianId);
  }
  const trainingCustomers = new Set<string>();
  const trainingVisits = new Set<string>();
  if (trainingTechs.size > 0) {
    const assigned = await prisma.visitAssignment.findMany({
      where: { technicianId: { in: [...trainingTechs] } }, select: { visit: { select: { id: true, customerId: true } } },
      orderBy: { assignedAt: "desc" }, take: 300,
    });
    for (const a of assigned) { trainingVisits.add(a.visit.id); trainingCustomers.add(a.visit.customerId); }
  }
  const allVisitIds = [...new Set([...visitIds, ...trainingVisits])];
  const visits = allVisitIds.length === 0 ? [] : await prisma.visit.findMany({
    where: { id: { in: allVisitIds } }, select: { id: true, customerId: true },
  });
  const visitCustomer = new Map<string, string>();
  for (const v of visits) { customerIds.add(v.customerId); visitCustomer.set(v.id, v.customerId); }
  for (const c of trainingCustomers) customerIds.add(c);

  const customerName = new Map<string, string>();
  const leadName = new Map<string, string>();
  if (customerIds.size > 0) {
    const [customers, properties] = await Promise.all([
      prisma.customer.findMany({ where: { id: { in: [...customerIds] } }, select: { id: true, name: true, email: true, phone: true } }),
      prisma.property.findMany({
        where: { customerId: { in: [...customerIds] } }, select: { addressLine1: true, city: true, state: true, postalCode: true },
      }),
    ]);
    for (const c of customers) {
      customerName.set(c.id, c.name);
      if (c.email) out.emails.push(c.email);
      if (c.phone) out.phones.push(c.phone);
      if (trainingCustomers.has(c.id) || threads.some((t) => t.kind === "training" && t.customerId === c.id)) out.names.push(c.name);
    }
    for (const p of properties) out.addresses.push(addressText(p), p.addressLine1);
  }
  if (leadIds.size > 0) {
    const leads = await prisma.lead.findMany({
      where: { id: { in: [...leadIds] } },
      select: { id: true, name: true, email: true, phone: true, address: true, addressLine1: true, city: true, state: true, postalCode: true },
    });
    for (const l of leads) {
      leadName.set(l.id, l.name);
      if (l.email) out.emails.push(l.email);
      if (l.phone) out.phones.push(l.phone);
      if (l.address) out.addresses.push(l.address);
      if (l.addressLine1) {
        out.addresses.push(l.addressLine1);
        if (l.city && l.state && l.postalCode) out.addresses.push(addressText({ addressLine1: l.addressLine1, city: l.city, state: l.state, postalCode: l.postalCode }));
      }
      if (threads.some((t) => t.kind === "training" && t.leadId)) out.names.push(l.name);
    }
  }
  for (const t of threads) {
    if (t.kind !== "customer" && t.kind !== "job") continue;
    const name = (t.visitId ? customerName.get(visitCustomer.get(t.visitId) ?? "") : undefined)
      ?? (t.customerId ? customerName.get(t.customerId) : undefined)
      ?? (t.leadId ? leadName.get(t.leadId) : undefined);
    if (name) out.titleNames.set(t.id, name);
  }
  return out;
}

/** Inventory's profile allows no customer names; every other key may see a first name (a ceiling, never a grant). */
const allowNamesFor = (reader: HubReader): boolean => reader.agentRole !== "inventory";

interface RawRow {
  id: string; kind: string; title: string; status: string; lastMessageAt: string; pending: number;
  customerId: string | null; leadId: string | null; visitId: string | null; technicianId: string | null;
  lastLine: { authorType: string; authorDisplay: string; status: string; text: string; at: string } | null;
}

/** The text pass for this key: every key's three passes, plus a training thread's customer names for a Scout-shaped key. */
const scrubFor = (scout: boolean) => (text: string, linked: Linked): string =>
  scout ? scrubTrainingText(text, linked) : scrubMessageText(text, linked);

/**
 * The title an agent sees (team answer 4: ids, and at most a first name). A customer, lead or job thread is the
 * contact's FIRST name, never the stored title ("Jane Homeowner", "Jane Homeowner - 88 Cedar Hollow Court"), and
 * null where the key's profile allows no names (Inventory). A conversation from a number nobody knows is "Unknown
 * sender" (its stored title is the number). Any other kind keeps its title, scrubbed.
 */
function titleFor(row: RawRow, linked: Linked, allowNames: boolean, scout: boolean): string | null {
  if (!allowNames) return null;
  if (row.kind === "customer" || row.kind === "job") {
    if (row.kind === "customer" && !row.customerId && !row.leadId) return "Unknown sender";
    const name = linked.titleNames.get(row.id);
    return name ? campaignFirstName(name) : null;
  }
  return scrubFor(scout)(row.title, linked);
}

/** Scrub the WHOLE text first, then cut: a number split by the cut would otherwise slip past every pattern. */
function scrubbedThenCut(text: string, linked: Linked, scout: boolean): string {
  const clean = scrubFor(scout)(text, linked);
  return clean.length > LAST_LINE_MAX ? `${clean.slice(0, LAST_LINE_MAX)}…` : clean;
}

function threadRead(row: RawRow, linked: Linked, allowNames: boolean, scout: boolean): HubThreadRead {
  return {
    id: row.id, kind: row.kind,
    title: titleFor(row, linked, allowNames, scout),
    status: row.status, lastMessageAt: toChicagoIso(row.lastMessageAt), pending: row.pending,
    customerId: row.customerId, leadId: row.leadId, visitId: row.visitId, technicianId: row.technicianId,
    lastLine: row.lastLine ? {
      authorType: row.lastLine.authorType, authorFirstName: authorFirstName(row.lastLine.authorDisplay, allowNames),
      status: row.lastLine.status, text: scrubbedThenCut(row.lastLine.text, linked, scout), at: toChicagoIso(row.lastLine.at),
    } : null,
  };
}

interface RawThreadMessage {
  id: string; authorType: string; authorDisplay: string; channel: string; direction: string; status: string;
  subject: string | null; body: string; messageClass: string | null; editedAt: string | null; createdAt: string;
}

/**
 * ONE message projection: projectMessageRead (profiles.ts, the every-key profile) plus the hub's own fields. A key
 * limited to training threads (Scout) is answered with projectScoutTrainingMessage instead (amendment 16a). A
 * training thread read by any other key also loses the customers' full names from its text (ruling R2).
 */
function messageRead(m: RawThreadMessage, thread: HubThread, linked: Linked, allowNames: boolean, scout: boolean): HubMessageRead | ScoutMessage {
  const createdAt = new Date(m.createdAt);
  if (scout) {
    return projectScoutTrainingMessage({
      id: m.id, threadId: thread.id, apprenticeName: m.authorType === "tech" ? m.authorDisplay : null,
      authorType: m.authorType, body: m.body, createdAt,
    }, linked);
  }
  const training = thread.kind === "training";
  const base = projectMessageRead({
    id: m.id, threadId: thread.id, authorType: m.authorType, authorDisplay: m.authorDisplay, createdAt,
    subject: m.subject !== null && training ? scrubTrainingText(m.subject, linked) : m.subject,
    body: training ? scrubTrainingText(m.body, linked) : m.body,
  }, linked, allowNames);
  return {
    ...base, channel: m.channel, direction: m.direction, status: m.status, messageClass: m.messageClass,
    editedAt: m.editedAt ? toChicagoIso(m.editedAt) : null,
  };
}
type ScoutMessage = ReturnType<typeof projectScoutTrainingMessage>;

// ── GET /hub/threads and GET /hub/threads/:id/messages ───────────────────────────────────────────

/** What the list route reads off the query string, still raw: the door validates it, so a bad value is an agent error. */
export interface AgentListQuery { kind?: string; status?: string; q?: string; since?: string }

/** GET /hub/threads and the list_threads tool: the ONE core. */
export async function listThreadsCore(call: DoorCall, reader: HubReader, query: AgentListQuery): Promise<DoorResult> {
  const principal = call.principal;
  // Every refusal here is thrown, so withReader answers it in the agent error shape and writes the audit row.
  // Search is not offered: it matches raw titles and bodies, so a key could rebuild a phone, email, address or
  // a withheld name by guessing (the answers are scrubbed, the match is not).
  if (query.q !== undefined) throw badRequest("Search is not available to agent keys.");
  if (query.kind !== undefined && !isHubThreadKind(query.kind)) throw badRequest("Unknown thread kind.");
  if (query.status !== undefined && !["open", "closed", "all"].includes(query.status)) throw badRequest("Unknown status filter.");
  let since: Date | undefined;
  if (query.since !== undefined) {
    if (!agentDateTime.safeParse(query.since).success) throw new AgentApiError("bad_time", { reason: "since must be an ISO 8601 time with an offset, like 2026-11-23T09:00:00-06:00." });
    since = new Date(query.since);
  }
  const kinds = kindsFor(reader, "read");
  // W2: a key whose scopes open nothing is told so (403), never answered with an empty list that looks like "no conversations".
  if (kinds.length === 0) throw forbidden(noKindsSentence(reader));
  if (query.kind && !kinds.includes(query.kind)) throw forbidden(refusalSentence(reader, query.kind, "read"));

  const list = await listThreads(reader, { kind: query.kind, status: query.status, kinds, since, wholeLastLine: true }, false);
  const rows = await prisma.hubThread.findMany({ where: { id: { in: list.threads.map((t) => t.id) } } });
  const linked = await linkedFor(rows);
  const allowNames = allowNamesFor(reader);
  const scout = scoutShaped(reader);
  const raw = { threads: list.threads.map((t) => threadRead(t, linked, allowNames, scout)) };
  const { data } = await agentRespond(principal, scout ? SCOUT_THREADS_OUT : THREADS_OUT, raw, { linked });
  return { status: 200, body: data, recordIds: list.threads.map((t) => t.id) };
}

export async function agentListThreads(req: Request, res: Response, reader: HubReader, query: AgentListQuery): Promise<void> {
  const out = await listThreadsCore(restCall(req, res), reader, query);
  await finishAgentCall(req, res, { status: out.status, body: out.body, recordIds: out.recordIds });
}

/** GET /hub/threads/:id/messages and the read_thread tool: the ONE core. */
export async function threadDetailCore(call: DoorCall, reader: HubReader, threadId: string): Promise<DoorResult> {
  const principal = call.principal;
  const thread = await threadFor(reader, threadId, "read");
  markScopeUsed(call, reader, thread.kind, "read");
  const detail = await threadDetail(reader, thread.id, undefined, { wholeLastLine: true });
  const linked = await linkedFor([thread]);
  const allowNames = allowNamesFor(reader);
  const scout = scoutShaped(reader) && thread.kind === "training";
  const raw = {
    thread: threadRead(detail.thread, linked, allowNames, scout),
    // A deleted message carries no text for anyone; an agent is not told it existed.
    messages: detail.messages
      .filter((m) => !m.deleted && m.body !== null)
      .map((m) => messageRead({ ...m, body: m.body as string }, thread, linked, allowNames, scout)),
    truncated: detail.truncated,
  };
  const { data } = await agentRespond(principal, scout ? SCOUT_THREAD_OUT : THREAD_OUT, raw, { linked });
  return { status: 200, body: data, recordIds: [thread.id] };
}

export async function agentThreadDetail(req: Request, res: Response, reader: HubReader, threadId: string): Promise<void> {
  const out = await threadDetailCore(restCall(req, res), reader, threadId);
  await finishAgentCall(req, res, { status: out.status, body: out.body, recordIds: out.recordIds });
}

// ── POST /hub/messages ───────────────────────────────────────────────────────────────────────────

/** Keys an agent may NOT send: a draft takes no recipient (the CRM fills it in at send time, team answer 4). */
const RECIPIENT_KEYS = ["toAddress", "to_address", "to", "cc", "bcc", "toPhone", "to_phone", "phone", "email"] as const;

const linkId = z.string().trim().min(1).max(64);

/**
 * W2 (R-j): the agent-to-agent limit. In one thread an AI may leave at most this many posts within this window with no person's post after them;
 * the next one is refused 429 `thread_agent_limit`. A person's post (a technician or the office) starts the count over. It runs from the
 * existing HubMessage (threadId, createdAt) index. Only threads that are not a customer's: the loop it prevents is agents answering agents.
 */
export const THREAD_AGENT_POST_LIMIT = 8;
export const THREAD_AGENT_WINDOW_MS = 10 * 60 * 1000;
const AI_MESSAGE_STATES = ["posted", "sent", "approved", "approving", "pending_approval"];
/** How long a post waits on another process's hold of the thread's database lock before it is answered retryable instead of left hanging. */
export const THREAD_LOCK_TIMEOUT_MS = 5000;

/**
 * Take the thread's advisory lock on this transaction, bounded by lock_timeout. If another process (another replica) holds it past
 * THREAD_LOCK_TIMEOUT_MS the post is refused `rate_limited` (429, retryable, retry_after 2) rather than hung inside a connection.
 * lock_timeout is put back to 0 once the lock is ours so it cannot cut short the later statements of this transaction.
 */
async function lockThreadForPost(tx: Prisma.TransactionClient, threadId: string): Promise<void> {
  try {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${Math.floor(THREAD_LOCK_TIMEOUT_MS)}`);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${threadId}))`;
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = 0");
  } catch (err) {
    const text = `${(err as { message?: string })?.message ?? ""} ${JSON.stringify((err as { meta?: unknown })?.meta ?? {})}`;
    if (text.includes("55P03") || /lock timeout|lock_not_available/i.test(text)) {
      throw new AgentApiError("rate_limited", { reason: "This conversation is busy with another post. Retry shortly.", retryAfterSeconds: 2 });
    }
    throw err;
  }
}

/** `db` is the lock holder's own transaction when there is one: the count then runs on the connection that already holds the thread lock, never a second pooled one. */
async function refuseAgentLoop(threadId: string, db: Pick<PrismaClient, "hubMessage"> = prisma, now: Date = new Date()): Promise<void> {
  const lastPerson = await db.hubMessage.findFirst({
    where: { threadId, authorType: { in: ["tech", "office"] }, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const windowStart = new Date(now.getTime() - THREAD_AGENT_WINDOW_MS);
  const since = lastPerson && lastPerson.createdAt > windowStart ? lastPerson.createdAt : windowStart;
  const posts = await db.hubMessage.count({
    where: { threadId, authorType: { in: ["ai_agent", "claude"] }, deletedAt: null, status: { in: AI_MESSAGE_STATES }, createdAt: { gt: since } },
  });
  if (posts >= THREAD_AGENT_POST_LIMIT) throw new AgentApiError("thread_agent_limit");
}

/** What a post that did not publish says about itself: the reason it was given, or a plain default. Null for anything that is not waiting. */
const pendingReasonFor = (status: string, reason: string | null | undefined): string | null =>
  status === "pending_approval" ? reason ?? "It is waiting for a person to approve it." : null;

const draftBodySchema = z.object({
  thread_id: linkId.optional(),
  leadId: linkId.optional(),
  customerId: linkId.optional(),
  jobId: linkId.optional(),
  estimateId: linkId.optional(),
  channel: z.enum(["email", "sms", "in_app"]).optional(),
  body: z.string().trim().min(1, "A message needs text.").max(10_000),
  subject: z.string().trim().max(200).nullish(),
  category: z.string().trim().max(60).nullish(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  status: z.string().max(40).optional(),
  idempotency_key: idempotencyKeySchema,
});

const LINK_KEYS = ["leadId", "customerId", "jobId", "estimateId"] as const;
type LinkKey = (typeof LINK_KEYS)[number];

interface Target {
  thread: HubThread;
  /** The job (Visit.id) the draft is tagged to, when a jobId link was used. */
  visitId: string | null;
  issuedEstimateId: string | null;
}

/** The customer-kind thread a record link means, made on first use. Never a crew job thread (amendment 3). */
async function resolveLink(
  reader: HubReader, key: LinkKey, id: string,
): Promise<{ thread: () => Promise<HubThread>; accountId: string | null; leadId: string | null; visitId: string | null; issuedEstimateId: string | null }> {
  // A key that may not draft in customer threads (Scout, or a key without hub:draft) can never create one: refuse BEFORE anything is made.
  if (!kindAllowed(reader, "customer", "post")) throw forbidden(refusalSentence(reader, "customer", "post"));
  if (key === "customerId") {
    return { thread: () => ensureThreadFor({ customerId: id }), accountId: id, leadId: null, visitId: null, issuedEstimateId: null };
  }
  if (key === "leadId") {
    const lead = await prisma.lead.findUnique({ where: { id }, select: { customerId: true } });
    if (!lead) throw new AgentApiError("not_found", { reason: "Lead not found." });
    return { thread: () => ensureThreadFor({ leadId: id }), accountId: lead.customerId, leadId: id, visitId: null, issuedEstimateId: null };
  }
  if (key === "jobId") {
    const visit = await prisma.visit.findUnique({ where: { id }, select: { customerId: true } });
    if (!visit) throw new AgentApiError("not_found", { reason: "Job not found." });
    return { thread: () => ensureThreadFor({ customerId: visit.customerId }), accountId: visit.customerId, leadId: null, visitId: id, issuedEstimateId: null };
  }
  const est = await prisma.issuedEstimate.findUnique({ where: { id }, select: { customerId: true } });
  if (!est) throw new AgentApiError("not_found", { reason: "Estimate not found." });
  return { thread: () => ensureThreadFor({ customerId: est.customerId }), accountId: est.customerId, leadId: null, visitId: null, issuedEstimateId: id };
}

/** thread_id OR exactly one record link; a link that points at a different conversation than thread_id is a 400. */
async function resolveTarget(reader: HubReader, body: z.infer<typeof draftBodySchema>): Promise<Target> {
  const links = LINK_KEYS.filter((k) => body[k] !== undefined);
  if (links.length > 1) throw badRequest("Give one record link (leadId, customerId, jobId or estimateId), not several.");
  if (!body.thread_id && links.length === 0) throw badRequest("Say where it goes: thread_id, or one of leadId, customerId, jobId, estimateId.");

  if (links.length === 0) {
    return { thread: await threadFor(reader, body.thread_id!, "post"), visitId: null, issuedEstimateId: null };
  }
  const key = links[0]!;
  const link = await resolveLink(reader, key, body[key]!);
  if (body.thread_id) {
    const given = await threadFor(reader, body.thread_id, "post");
    const sameAccount = given.kind === "customer" && link.accountId !== null && given.customerId === link.accountId;
    const sameLead = given.kind === "customer" && link.leadId !== null && given.leadId === link.leadId;
    if (!sameAccount && !sameLead) throw badRequest("That record link does not belong to the conversation in thread_id.");
    return { thread: given, visitId: link.visitId, issuedEstimateId: link.issuedEstimateId };
  }
  return { thread: await link.thread(), visitId: link.visitId, issuedEstimateId: link.issuedEstimateId };
}

/**
 * The id a retry keeps: 37 characters, inside the hub's own 8 to 100. It is made from the idempotency key AND
 * the request hash, so a true retry (same key, same request) finds the draft it already made even when the
 * idempotency row is gone, while a corrected request under a reused key (after the 24 hours, or after a failed
 * attempt) is a new id and so a new draft - never the old one.
 */
const clientIdFor = (idempotencyKey: string, requestHash: string): string =>
  `idem-${createHash("sha256").update(`${idempotencyKey}:${requestHash}`).digest("hex").slice(0, 32)}`;

/** What a thread's own draft/post body is, as the tool's input schema (the registry's post_message input is this same object). */
export const postMessageInputSchema = draftBodySchema;

/**
 * POST /hub/messages and the post_message tool: the ONE core. A fresh write has its audit row inserted inside the idempotency
 * transaction (`auditWritten`); a replay returns the first result and leaves the audit row to the caller.
 */
export async function createMessageCore(call: DoorCall, reader: HubReader, raw: Record<string, unknown>): Promise<DoorResult> {
  const principal = call.principal;

  const sentRecipient = RECIPIENT_KEYS.filter((k) => raw[k] !== undefined);
  if (sentRecipient.length > 0) throw badRequest("A message takes no recipient or cc: the CRM fills in the customer's address on file when it sends.");
  const body = draftBodySchema.parse(raw);

  // The ONE status rule. Missing sends (the old "pending_approval" is read the same way: there is no approval step left for an agent's own
  // request); draft keeps it as a draft; nothing else is allowed, and nothing is written.
  const wanted = body.status === undefined || body.status === "pending_approval" ? "send" : body.status;
  if (wanted !== "send" && wanted !== "draft") throw forbidden("An agent can only send a message or leave a draft (status: draft).");
  const status: "draft" | "send" = wanted;

  // Tags are checked against the small list an agent may use; the opt-out hint is for customer drafts only.
  const badTag = body.tags.find((t) => !(AGENT_DRAFT_TAGS as readonly string[]).includes(t));
  if (badTag) throw badRequest(`Unknown tag. An agent may use: ${AGENT_DRAFT_TAGS.join(", ")}.`);
  // A send type is always checked, whatever the channel. messageClass and purposeKey come only from it.
  const entry = body.category ? messageCategoryFor(body.category) : null;
  if (body.category && !entry) throw badRequest("Unknown send type (category).");

  const target = await resolveTarget(reader, body);
  const thread = target.thread;
  // W1b: for an agent a JOB thread is the crew chat (an in-app crew post, like a Team post), never a message to the
  // homeowner. Only a customer thread takes an email or a text, and a record link (customerId, jobId) resolves to it.
  const toCustomer = thread.kind === "customer";
  if (thread.kind === "dev") throw forbidden("Dev threads are written through the dev door, not here.");
  if (thread.kind === "job" && (body.channel === "email" || body.channel === "sms")) {
    throw badRequest("A customer message goes in the customer's conversation (use customerId or jobId), not the crew chat.");
  }
  // The send type of a post in a Team, group, crew or Training conversation is decided by where it goes (the key's Team-post box reads it).
  let postCategory: string | null = null;

  let channel: "email" | "sms" | "in_app";
  if (toCustomer) {
    if (body.channel !== "email" && body.channel !== "sms") throw badRequest("A customer draft needs a channel: email or sms.");
    channel = body.channel;
    if (entry && !entry.customerFacing) throw badRequest("That send type never reaches a customer.");
    if (channel === "sms" && !entry) throw badRequest("A text needs a send type (category).");
  } else {
    if (body.channel !== undefined && body.channel !== "in_app") throw badRequest("A message in this conversation is in_app.");
    channel = "in_app";
    if (body.tags.length > 0) throw badRequest("The possible_opt_out tag goes on a draft in a customer's conversation only.");
    const sort = agentPostCategory(thread.kind, body.category);
    if (!sort.ok) throw badRequest(sort.reason);
    postCategory = sort.category;
  }

  const { idempotency_key: idempotencyKey, ...hashed } = body;
  const clientMessageId = clientIdFor(idempotencyKey, requestHashOf(hashed));

  // W2: a CUSTOMER draft takes one of the key's 500-a-day slots (the gate no longer does it for the whole route, because a Team post is not a draft).
  markScopeUsed(call, reader, thread.kind, "post");
  if (toCustomer) {
    const wait = await call.reserveDraft();
    if (wait !== null) throw new AgentApiError("daily_draft_limit", { retryAfterSeconds: wait });
  }

  const runIdempotent = () => withIdempotency(
    { keyId: principal.keyId, role: principal.role }, DRAFT_OPERATION, idempotencyKey, hashed,
    async (tx) => {
      let message;
      let replayedInside = false;
      let heldBecause: string | null | undefined;
      let notSent: string | null = null;
      // A retry that already made its post is answered from what it made (below); only a NEW post is counted against the loop limit.
      // W2: the check and the insert are not one step, so concurrent posts (every agent answering one person's post at once) would all read the same count.
      // Two layers make them one step. In this process, the posts to one thread wait their turn BEFORE any transaction opens (withKeyedMutex, below),
      // so a waiter holds no database connection and a burst larger than the pool cannot starve it. Across replicas, the transaction-scoped advisory
      // lock (bounded by lock_timeout) makes the next poster count AFTER this post has committed. The count runs on this transaction's own
      // connection, so the holder needs no second pooled connection for it.
      if (!toCustomer) {
        await lockThreadForPost(tx, thread.id);
        await refuseAgentLoop(thread.id, tx);
      }
      if (toCustomer) {
        const made = await createDraftMessage(reader, {
          threadId: thread.id, channel: channel as "email" | "sms", body: body.body, subject: body.subject ?? null,
          category: body.category ?? null, tags: body.tags, status, visitId: target.visitId,
          issuedEstimateId: target.issuedEstimateId, clientMessageId,
        });
        message = made.message;
        replayedInside = made.replayed === true;
        notSent = made.notSentReason;
      } else {
        const made = await postMessageResult(reader, {
          threadId: thread.id, body: body.body, subject: body.subject ?? null, tags: body.tags, status: status === "draft" ? "draft" : undefined, category: postCategory,
          visitId: target.visitId, issuedEstimateId: target.issuedEstimateId, clientMessageId,
        });
        message = made.message;
        replayedInside = made.replayed;
        heldBecause = made.pendingReason;
      }
      const raw = {
        messageId: message.id, threadId: message.threadId, status: message.status, channel: message.channel,
        category: message.category, createdAt: toChicagoIso(message.createdAt),
        // W2: why a team post is still waiting, in plain words (the agent is told "posted", or "pending" and the reason).
        pending_reason: pendingReasonFor(message.status, heldBecause),
        // Kyle 2026-11-24: a customer message is SENT when posted (status "sent"); when a guard refused it or the send failed, the status says
        // so (blocked, failed) and this says why, so the agent is never left to guess that nothing went out.
        not_sent_reason: toCustomer && message.status !== "sent" ? notSent ?? notSentReasonFor(message) : null,
      };
      const answer = await agentRespond(principal, DRAFT_OUT, raw);
      // The audit row commits WITH the idempotency record. A retry that found the draft already made is not a new draft.
      await recordAgentCall(call.auditRecord({
        // Only a draft to a customer counts toward the 500 a day; a Team, group or crew post is a post (W2).
        status: 201, body: answer.data, recordIds: [message.id, message.threadId], madeDraft: toCustomer && !replayedInside,
        // Kyle 2026-11-24: the agent audit says what became of a customer message, so Settings -> Agent keys -> Activity tells a send from a refusal:
        // "sent" went out, "not_sent" was refused by a guard or failed (the reason is in the Message audit log), "ok" is a draft kept as asked or a post.
        resultCode: replayedInside ? "replayed" : toCustomer ? (message.status === "sent" ? "sent" : message.status === "draft" ? "ok" : "not_sent") : "ok",
        idempotencyKey,
      }), tx);
      return answer.data;
    },
  );
  // A post to a Team, group or crew thread takes its turn in this process before it opens a transaction; a customer draft has no loop count to protect.
  const out = toCustomer ? await runIdempotent() : await withKeyedMutex(`agent-thread-post:${thread.id}`, runIdempotent);

  const ids = out.replayed ? [] : [(out.result as { messageId?: string }).messageId, thread.id].filter((v): v is string => typeof v === "string");
  if (out.replayed) return { status: 200, body: out.result, recordIds: [], replayed: true, idempotencyKey };
  return { status: 201, body: out.result, recordIds: ids, auditWritten: true, idempotencyKey };
}

export async function agentCreateMessage(req: Request, res: Response, reader: HubReader): Promise<void> {
  const out = await createMessageCore(restCall(req, res), reader, (req.body ?? {}) as Record<string, unknown>);
  if (out.replayed) {
    await finishAgentCall(req, res, { status: 200, body: out.body, resultCode: "replayed", idempotencyKey: out.idempotencyKey });
    return;
  }
  sendAgentResult(res, 201, out.body);
}
