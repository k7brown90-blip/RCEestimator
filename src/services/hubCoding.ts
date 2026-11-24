/**
 * "@Coding": a person asks Claude Code to change the app from the field app (work order agent-team, W2-E; Kyle 2026-11-23 item 7 and
 * reading R-k). A person's message in a Team, group or crew chat that mentions @Coding becomes ONE CodingRun row and, when it is allowed,
 * one GitHub `repository_dispatch` (event_type "hub_coding_request") that starts .github/workflows/hub-coding.yml. The workflow runs Claude
 * Code on Kyle's subscription, opens a branch and a pull request for any change, and posts its answer back in the SAME thread through the
 * ordinary agent door (POST /api/hub/messages with the Coding key). It never pushes main and never deploys.
 *
 * Where this is called from (ONE place each, no second fan-out):
 *   - hub.ts fanOutMessage, for a PERSON's posted message that mentions @Coding  -> handleCodingRequestSafe (here);
 *   - hub.ts fanOutMessage, for a message the Claude Code key posted             -> closeCodingRunOnReplySafe (here);
 *   - src/server.ts's 30-second worker                                           -> sweepCodingRuns (here), the 60-minute timeout.
 *
 * WHO MAY ASK. The `coding_requests` power (shared/crmPowers.ts, "Ask Claude Code to change the app"): Kyle always holds it, Kyle grants it
 * to others on Team -> CRM login. It is decided from the message's STORED authorKey through the ONE login resolver (hub.readerForKey, which
 * also reads a technician's linked CRM login for a "tech:" key), never from a display name and never from a role. An AGENT's post never
 * asks (authorType ai_agent or claude, and the AI admin session), and neither does an edit-approved copy whose original was an agent's.
 *
 * NOTHING SECRET MOVES. GITHUB_DISPATCH_TOKEN is read by name from the environment, used in one Authorization header, and never stored,
 * logged, put in a row, an audit line, a system line or an error. A failed dispatch records the HTTP STATUS only (never a body). The text
 * that goes to GitHub is the message's text through the ONE scrub layer (agentApi/respond.ts: phones, emails and street addresses withheld,
 * known secrets removed - the same pass every webhook gets), cut at 20,000 characters. THE REPOSITORY IS PUBLIC: the workflow keeps that text
 * out of every log (see .github/workflows/hub-coding.yml).
 *
 * ONE OPEN RUN PER THREAD. Open = requested or dispatched. The check and the insert run in ONE transaction under
 * pg_advisory_xact_lock(hashtext('coding:' + threadId)), and every query of that transaction runs ON that transaction (never a second pooled
 * connection while waiters hold theirs - the lesson of the 2026-11-23 CI failure); posts to one thread also take their turn in this process
 * first (src/lib/keyedMutex.ts), so a burst costs no connections while it waits. There is no partial unique index (see CrmLogin in the schema).
 */
import type { HubMessage, HubThread, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { withKeyedMutex } from "../lib/keyedMutex";
import { toChicagoIso } from "../../shared/calendarDay";
import { hubKindsFor } from "../../shared/agentScopes";
import { parseMentions } from "../../shared/hub/mentions";
import { activeKeyWhere, currentAgentEnvironment } from "../agentApi/keys";
import { authorFirstName, loadSecretValues, scrub, scrubMessageText, type LinkedContacts } from "../agentApi/respond";
import {
  SYSTEM_ACTOR, bumpThreadForMessage, createMessageRow, fanOutMessage, hubAudit, logHubFailure, readerForKey,
  type HubAuditEntry,
} from "./hub";
import { AI_ADMIN_SUB } from "./adminLogin";
import { getAgentAccess } from "./ownerSettings";

// ── constants ────────────────────────────────────────────────────────────────────────────────────

/** The repository the dispatch goes to. ONE constant: no environment variable decides where Claude Code runs. */
export const GITHUB_CODING_REPO = "k7brown90-blip/RCEestimator";
export const GITHUB_DISPATCH_EVENT_TYPE = "hub_coding_request";
export const GITHUB_DISPATCH_URL = `https://api.github.com/repos/${GITHUB_CODING_REPO}/dispatches`;
/** The REST API version the research (map-gh-research.md section 3) names. */
export const GITHUB_API_VERSION = "2026-03-10";
export const GITHUB_DISPATCH_TIMEOUT_MS = 10_000;
/** The request text that goes to GitHub is cut here (the dispatch allows 64KB in all; the door's own body limit is 10,000). */
export const CODING_TEXT_CAP = 20_000;
export const CODING_TEXT_CUT_NOTE = "\n[The request was cut at 20,000 characters.]";
/** An open run closes on its own after this long. */
export const CODING_RUN_TIMEOUT_MS = 60 * 60 * 1000;

export const CODING_OPEN_STATUSES = ["requested", "dispatched"] as const;
const OPEN: string[] = [...CODING_OPEN_STATUSES];

/** The conversations @Coding works in (the three W1b already calls team chats). */
const CODING_THREAD_KINDS: readonly string[] = ["team", "group", "job"];
const AI_AUTHOR_TYPES: readonly string[] = ["ai_agent", "claude"];

/** Every sentence this module puts in a conversation. Fixed words: nothing from a request, a response body or a secret ever goes in one. */
export const CODING_LINES = {
  notAllowed: "Only someone Kyle has allowed can ask Claude Code to change the app (Team → CRM login → Ask Claude Code to change the app).",
  noKey: "Claude Code cannot be asked yet: there is no Coding key. Create the Coding key on Settings → Agent keys (Agent: Claude Code) and tick Allow writes.",
  writesOff: "Claude Code cannot be asked yet: the Coding key has Allow writes off. Tick Allow writes on the Coding key on Settings → Agent keys.",
  keyScopes: "Claude Code cannot be asked yet: the Coding key cannot read and post in this kind of conversation. Tick Read team and Post team on the Coding key on Settings → Agent keys.",
  agentAccessNotOn: "Claude Code cannot be asked right now: Agent access is not On. Turn Agent access On at the top of Settings → Agent keys.",
  notAMember: "Claude Code cannot be asked yet: it is not in this group. Add Claude Code to this group (open the group, then Members).",
  cancelled: "Claude Code request cancelled. A run already started on GitHub may still post its result.",
  nothingToCancel: "Nothing to cancel.",
  started: "Claude Code is on it. It will reply here with a pull request link or an answer.",
  timedOut: "Claude Code did not answer within an hour. Ask again with @Coding if you still need it.",
  alreadyRunning: (askedAt: Date): string =>
    `Claude Code is still working on the last request in this conversation (asked ${chicagoClock(askedAt)}). Say "@Coding cancel" to stop waiting.`,
  notStarted: (why: string): string => `Claude Code could not be started (${why}).`,
} as const;

const CHICAGO_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
function chicagoClock(at: Date): string {
  return CHICAGO_CLOCK.format(at);
}

// ── reading the message ──────────────────────────────────────────────────────────────────────────

const CODING_MENTION = /(^|[^A-Za-z0-9_])@coding(?![A-Za-z0-9_])/gi;

/** True when the message mentions @Coding. The ONE mention parser (shared/hub/mentions.ts) decides. */
export const mentionsCoding = (body: string): boolean => parseMentions(body).includes("claude_code");

/** "@Coding cancel": once the @Coding mention is taken out, the rest is the word "cancel" (any case, trimmed). */
export function isCancelRequest(body: string): boolean {
  return body.replace(CODING_MENTION, "$1").trim().toLowerCase() === "cancel";
}

const REPO_PATTERN = GITHUB_CODING_REPO.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
const PR_URL = new RegExp(`https://github\\.com/${REPO_PATTERN}/pull/\\d+`);
const BRANCH = /hub\/coding-[A-Za-z0-9_-]+/;
/**
 * The first line of every reply the workflow posts: "Claude Code run <id>" (the run id the CRM sent, validated by the workflow against
 * ^[A-Za-z0-9_-]{1,64}$). A reply closes ONLY the run it names: a late answer from a cancelled or timed-out run must never close the NEXT one.
 * Anchored to the start of the body so the words further down (Claude's own text) cannot name another run.
 */
export const CODING_RUN_MARKER = /^Claude Code run ([A-Za-z0-9_-]{1,64})(?:\r?\n|$)/;

const isUniqueRace = (err: unknown): boolean => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

// ── the thread's one voice: a system line ────────────────────────────────────────────────────────

/**
 * Say something in the conversation as the system (authorType system, in_app, internal, posted), so it shows on the field phone
 * (hubTech TECH_MESSAGE_WHERE) and in the CRM. Made by createMessageRow (the ONE writer) and announced by fanOutMessage (the ONE fan-out
 * call site). A system author is not a person and not an agent, so fanOutMessage routes it to nothing: it can never start another run.
 * A conversation that was CLOSED meanwhile is left closed (a message would bring it back): the run's row and audit still say what happened.
 * Never throws.
 */
export async function postCodingLine(threadId: string, body: string, db: PrismaClient = defaultPrisma): Promise<void> {
  try {
    const thread = await db.hubThread.findUnique({ where: { id: threadId } });
    if (!thread || thread.status === "closed") return;
    const row = await db.$transaction(async (tx) => {
      const made = await createMessageRow(tx, {
        threadId: thread.id, authorType: "system", authorKey: SYSTEM_ACTOR.key, authorDisplay: SYSTEM_ACTOR.display,
        channel: "in_app", direction: "internal", status: "posted", body,
      });
      await bumpThreadForMessage(tx, thread.id, made, SYSTEM_ACTOR);
      return made;
    });
    fanOutMessage(row, thread);
  } catch (err) {
    logHubFailure("posting a Claude Code line", err);
  }
}

// ── the request ──────────────────────────────────────────────────────────────────────────────────

/** The call fanOutMessage makes (as `void`) for a person's posted message that mentions @Coding. Never throws. */
export async function handleCodingRequestSafe(messageId: string, db: PrismaClient = defaultPrisma): Promise<void> {
  try {
    await handleCodingRequest(messageId, db);
  } catch (err) {
    if (isUniqueRace(err)) return; // the same message was announced twice at once: the first one has it
    logHubFailure("handling an @Coding request", err);
  }
}

type RunOutcome = { kind: "run"; runId: string } | { kind: "busy"; askedAt: Date };

export async function handleCodingRequest(messageId: string, db: PrismaClient = defaultPrisma): Promise<void> {
  const m = await db.hubMessage.findUnique({
    where: { id: messageId },
    include: { thread: true, editedFrom: { select: { authorType: true } } },
  });
  if (!m || m.deletedAt || m.status !== "posted") return;
  if (m.channel !== "in_app" || m.direction !== "internal") return;
  // Only a PERSON asks. An agent (ai_agent, claude, the AI admin session) never does, and a message an approver edited from an agent's draft is
  // the agent's words, not a person's.
  if (m.authorType !== "tech" && m.authorType !== "office") return;
  if (m.authorKey === AI_ADMIN_SUB) return;
  if (m.editedFromId && (!m.editedFrom || AI_AUTHOR_TYPES.includes(m.editedFrom.authorType))) return;
  if (!CODING_THREAD_KINDS.includes(m.thread.kind)) return;
  if (!mentionsCoding(m.body)) return;
  // One run per message: a replay of the same announcement finds the row and does nothing.
  if (await db.codingRun.findUnique({ where: { triggerMessageId: m.id }, select: { id: true } })) return;

  const thread = m.thread;
  const found = m.authorKey ? await readerForKey(m.authorKey, db) : null;
  const who = {
    key: m.authorKey ?? "unknown",
    display: authorFirstName(found?.reader.display ?? m.authorDisplay, true) ?? "Someone",
  };

  // (a) not allowed: the author's stored login does not hold coding_requests (or resolves to no enabled login at all).
  if (found?.canAskCoding !== true) {
    await refuse(db, m, thread, who, "not_allowed", CODING_LINES.notAllowed);
    return;
  }

  // (c) "@Coding cancel": close the thread's open run.
  if (isCancelRequest(m.body)) {
    const open = await withKeyedMutex(`coding:${thread.id}`, () => db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`coding:${thread.id}`}))`;
      const run = await tx.codingRun.findFirst({ where: { threadId: thread.id, status: { in: OPEN } }, orderBy: { createdAt: "desc" }, select: { id: true } });
      if (!run) return null;
      await tx.codingRun.update({ where: { id: run.id }, data: { status: "cancelled", cancelledByKey: who.key, finishedAt: new Date() } });
      await hubAudit(tx, auditEntry(who, "coding_cancelled", thread.id, run.id, { messageId: m.id }));
      return run;
    }));
    await postCodingLine(thread.id, open ? CODING_LINES.cancelled : CODING_LINES.nothingToCancel, db);
    return;
  }

  // (b) the Coding key has to be able to hear the request and answer it.
  const missing = await missingCodingKey(db, thread);
  if (missing) {
    await refuse(db, m, thread, who, missing.reason, missing.line);
    return;
  }

  // (d) one open run per thread, and (e) the new run, in ONE transaction under the thread's coding lock.
  const outcome = await withKeyedMutex<RunOutcome>(`coding:${thread.id}`, () => db.$transaction(async (tx): Promise<RunOutcome> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`coding:${thread.id}`}))`;
    const open = await tx.codingRun.findFirst({ where: { threadId: thread.id, status: { in: OPEN } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    if (open) {
      const refused = await tx.codingRun.create({
        data: {
          threadId: thread.id, triggerMessageId: m.id, requestedByKey: who.key, requestedByDisplay: who.display,
          status: "refused", refusedReason: "already_running", finishedAt: new Date(),
        },
      });
      await hubAudit(tx, auditEntry(who, "coding_refused", thread.id, refused.id, { messageId: m.id, reason: "already_running" }));
      return { kind: "busy", askedAt: open.createdAt };
    }
    const run = await tx.codingRun.create({
      data: { threadId: thread.id, triggerMessageId: m.id, requestedByKey: who.key, requestedByDisplay: who.display, status: "requested" },
    });
    await hubAudit(tx, auditEntry(who, "coding_requested", thread.id, run.id, { messageId: m.id }));
    return { kind: "run", runId: run.id };
  }));

  if (outcome.kind === "busy") {
    await postCodingLine(thread.id, CODING_LINES.alreadyRunning(outcome.askedAt), db);
    return;
  }
  await dispatchRun(db, outcome.runId, m, thread, who.display);
}

function auditEntry(
  actor: { key: string; display: string }, action: string, threadId: string, runId: string, more: { messageId?: string; reason?: string; githubStatus?: number | null } = {},
): HubAuditEntry {
  // Ids and the status code only: never the request text, never the token, never a response body.
  return {
    actorKey: actor.key, actorDisplay: actor.display, action, entityType: "coding_run", entityId: runId, threadId,
    messageId: more.messageId ?? null,
    details: { runId, threadId, ...(more.reason !== undefined ? { reason: more.reason } : {}), ...(more.githubStatus !== undefined ? { githubStatus: more.githubStatus } : {}) },
  };
}

/** A request that sends nothing: the run row says why (fixed words), the audit says who asked, the thread is told what to fix. */
async function refuse(
  db: PrismaClient, m: HubMessage, thread: HubThread, who: { key: string; display: string }, reason: string, line: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const row = await tx.codingRun.create({
      data: {
        threadId: thread.id, triggerMessageId: m.id, requestedByKey: who.key, requestedByDisplay: who.display,
        status: "refused", refusedReason: reason, finishedAt: new Date(),
      },
    });
    await hubAudit(tx, auditEntry(who, "coding_refused", thread.id, row.id, { messageId: m.id, reason }));
  });
  await postCodingLine(thread.id, line, db);
}

/**
 * The reason a request cannot be answered, when there is one: the thread needs a live Claude Code key of THIS deployment that has Allow writes
 * on, can read AND post in this kind of conversation (the ONE scope rule, hubKindsFor), and, for a group, is a member of it. Null when it is fine.
 */
async function missingCodingKey(db: PrismaClient, thread: HubThread): Promise<{ reason: string; line: string } | null> {
  // The owner's kill switch (Settings -> Agent keys): Off refuses the Coding key's reads, Read only refuses its reply. Either way the run would
  // spend the subscription and then sit until the 60-minute timeout, so say so now.
  if ((await getAgentAccess(db)).mode !== "on") return { reason: "agents_not_on", line: CODING_LINES.agentAccessNotOn };
  const keys = await db.agentKey.findMany({
    where: { ...activeKeyWhere(new Date()), environment: currentAgentEnvironment(), agentRole: "claude_code" },
    select: { id: true, scopes: true, hubThreadKinds: true, writesEnabled: true },
  });
  if (keys.length === 0) return { reason: "no_coding_key", line: CODING_LINES.noKey };
  const writers = keys.filter((k) => k.writesEnabled);
  if (writers.length === 0) return { reason: "no_coding_key", line: CODING_LINES.writesOff };
  const able = writers.filter((k) => {
    const kinds = (access: "read" | "post") => hubKindsFor(k.scopes, access, k.hubThreadKinds) as string[];
    return kinds("read").includes(thread.kind) && kinds("post").includes(thread.kind);
  });
  if (able.length === 0) return { reason: "no_coding_key", line: CODING_LINES.keyScopes };
  if (thread.kind === "group") {
    const member = await db.hubThreadMember.count({ where: { threadId: thread.id, agentKeyId: { in: able.map((k) => k.id) } } });
    if (member === 0) return { reason: "not_a_member", line: CODING_LINES.notAMember };
  }
  return null;
}

// ── the dispatch ─────────────────────────────────────────────────────────────────────────────────

type DispatchResult = { ok: true } | { ok: false; githubStatus: number | null; why: string };

/** What reaches GitHub. Eight top-level keys at most (the limit is ten) and far under 64KB. */
export interface CodingDispatchPayload {
  run_id: string;
  thread_id: string;
  message_id: string;
  author: string;
  author_type: "person";
  text: string;
  created_at: string;
}

/**
 * POST the dispatch. 204 is the only success. The answer's BODY is never read, never stored, never put in a line: only the status number
 * leaves this function. No redirects are followed (a 3xx is a failure), 10 seconds at most, and the token goes in the Authorization header only.
 */
async function postDispatch(payload: CodingDispatchPayload): Promise<DispatchResult> {
  const token = process.env.GITHUB_DISPATCH_TOKEN?.trim();
  if (!token) return { ok: false, githubStatus: null, why: "GITHUB_DISPATCH_TOKEN is not set on Railway" };
  try {
    const res = await fetch(GITHUB_DISPATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "rce-crm",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: GITHUB_DISPATCH_EVENT_TYPE, client_payload: payload }),
      redirect: "manual",
      signal: AbortSignal.timeout(GITHUB_DISPATCH_TIMEOUT_MS),
    });
    void res.body?.cancel().catch(() => undefined);
    if (res.status === 204) return { ok: true };
    return { ok: false, githubStatus: res.status, why: `GitHub answered ${res.status}` };
  } catch {
    // The error's own text is never used: it can carry a URL or a header. A timeout and a refused connection read the same.
    return { ok: false, githubStatus: null, why: "GitHub could not be reached" };
  }
}

/** The text that goes to GitHub: the message through the ONE scrub (the same pass a webhook's text gets), cut at 20,000 characters. */
async function scrubbedRequestText(m: HubMessage, thread: HubThread): Promise<string> {
  let linked: LinkedContacts | undefined;
  if (thread.customerId || thread.leadId || thread.visitId || thread.phone) {
    // Imported on demand: hubDoor imports the hub, which imports this file.
    linked = await (await import("../agentApi/hubDoor")).linkedFor([thread]);
  }
  const secrets = await loadSecretValues();
  const { text } = scrub({ text: scrubMessageText(m.body, linked) }, { withholdContact: true, secrets });
  return text.length > CODING_TEXT_CAP ? text.slice(0, CODING_TEXT_CAP) + CODING_TEXT_CUT_NOTE : text;
}

async function dispatchRun(db: PrismaClient, runId: string, m: HubMessage, thread: HubThread, authorName: string): Promise<void> {
  let result: DispatchResult;
  try {
    result = await postDispatch({
      run_id: runId, thread_id: thread.id, message_id: m.id, author: authorName, author_type: "person",
      text: await scrubbedRequestText(m, thread), created_at: toChicagoIso(m.createdAt),
    });
  } catch (err) {
    logHubFailure("preparing a Claude Code request", err);
    result = { ok: false, githubStatus: null, why: "the CRM could not prepare the request" };
  }

  const now = new Date();
  // Only a run that is still "requested" takes the outcome: one that was cancelled while the call was out keeps "cancelled".
  const changed = await db.codingRun.updateMany({
    where: { id: runId, status: "requested" },
    data: result.ok
      ? { status: "dispatched", dispatchedAt: now, githubStatus: 204 }
      : { status: "dispatch_failed", githubStatus: result.githubStatus, finishedAt: now },
  });
  if (changed.count === 0) return;
  await hubAudit(db, auditEntry(
    SYSTEM_ACTOR, result.ok ? "coding_dispatched" : "coding_dispatch_failed", thread.id, runId,
    { githubStatus: result.ok ? 204 : result.githubStatus },
  ));
  await postCodingLine(thread.id, result.ok ? CODING_LINES.started : CODING_LINES.notStarted(result.why), db);
}

// ── the answer ───────────────────────────────────────────────────────────────────────────────────

/** The call fanOutMessage makes (as `void`) for a message the Claude Code key posted. Never throws. */
export async function closeCodingRunOnReplySafe(messageId: string, db: PrismaClient = defaultPrisma): Promise<void> {
  try {
    await closeCodingRunOnReply(messageId, db);
  } catch (err) {
    logHubFailure("closing a Claude Code run", err);
  }
}

/**
 * Coding answered in this conversation. Closes the ONE run the reply names (its first line, "Claude Code run <id>", written by the workflow),
 * and only while that run is still dispatched: a late reply from a cancelled or timed-out run, or a hand-written post that names no run,
 * closes nothing and the thread's open-run rule keeps holding for the run that is really in flight. Records the reply, the pull request link
 * when the body names one of THIS repository's pull requests, and the branch when it names hub/coding-*.
 *
 * The author is the Claude Code role (authorType "claude"), or an approver's edit-approved copy of a draft that role wrote (the key had
 * "Team posts publish immediately" off, so Kyle approved it with edits): the run is read from the original's first line if the edit dropped it.
 */
export async function closeCodingRunOnReply(messageId: string, db: PrismaClient = defaultPrisma): Promise<void> {
  const m = await db.hubMessage.findUnique({
    where: { id: messageId },
    include: { editedFrom: { select: { authorType: true, authorKey: true, authorDisplay: true, body: true } } },
  });
  if (!m || m.deletedAt || m.direction !== "internal") return;
  const original = m.editedFrom && m.editedFrom.authorType === "claude" ? m.editedFrom : null;
  if (m.authorType !== "claude" && !original) return;
  const named = CODING_RUN_MARKER.exec(m.body) ?? (original ? CODING_RUN_MARKER.exec(original.body) : null);
  if (!named) return;
  const changed = await db.codingRun.updateMany({
    where: { id: named[1], threadId: m.threadId, status: "dispatched" },
    data: {
      status: "replied", replyMessageId: m.id, finishedAt: new Date(),
      prUrl: PR_URL.exec(m.body)?.[0] ?? null, branch: BRANCH.exec(m.body)?.[0] ?? null,
    },
  });
  if (changed.count === 0) return;
  const run = await db.codingRun.findUnique({ where: { id: named[1] }, select: { githubStatus: true } });
  const actor = original ?? m;
  await hubAudit(db, {
    actorKey: actor.authorKey ?? "agent", actorDisplay: actor.authorDisplay, action: "coding_replied", entityType: "coding_run", entityId: named[1],
    threadId: m.threadId, messageId: m.id, details: { runId: named[1], threadId: m.threadId, githubStatus: run?.githubStatus ?? null },
  });
}

// ── the sweep ────────────────────────────────────────────────────────────────────────────────────

/** Close every run that has been open longer than 60 minutes (the worker calls this every 30 seconds). Returns how many it closed. */
export async function sweepCodingRuns(db: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<number> {
  const stale = await db.codingRun.findMany({
    where: { status: { in: OPEN }, createdAt: { lt: new Date(now.getTime() - CODING_RUN_TIMEOUT_MS) } },
    select: { id: true, threadId: true, githubStatus: true },
  });
  let closed = 0;
  for (const run of stale) {
    // A second replica (or a reply that landed a moment ago) may have closed it: only the one that changes the row speaks.
    const changed = await db.codingRun.updateMany({ where: { id: run.id, status: { in: OPEN } }, data: { status: "timed_out", finishedAt: now } });
    if (changed.count === 0) continue;
    closed += 1;
    await hubAudit(db, auditEntry(SYSTEM_ACTOR, "coding_timed_out", run.threadId, run.id, { githubStatus: run.githubStatus }));
    await postCodingLine(run.threadId, CODING_LINES.timedOut, db);
  }
  return closed;
}
