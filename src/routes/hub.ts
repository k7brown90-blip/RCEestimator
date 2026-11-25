/**
 * The CRM's Messages routes (work order agent-team, U2 and U3): the record conversation on the Account
 * page, the Lead and Job drawers and the Property page, and the Messages page with its Thread drawer.
 *
 * Behind the session gate like every CRM route (NOT on the public allowlist); a technician's token and
 * an agent key never reach it. The identity is `readerFor(req)`: Kyle's PIN, a person's CRM login, or
 * the AI admin. All the work is services/hub.ts (writes), services/hubInbox.ts and
 * services/hubTimeline.ts (reads); nothing here re-implements it.
 *
 *   GET    /hub/timeline?customerId=|leadId=|visitId=|propertyId=   one record's conversation
 *   GET    /hub/threads?kind=&status=&needs=approval&q=             the Messages page
 *   GET    /hub/threads/:id                                          one thread with its messages
 *   GET    /hub/threads/:id/messages                                 the same thread, for an agent key only (the contract's path)
 *   PATCH  /hub/threads/:id            { title? , status? }          Rename, Close thread / Reopen
 *   POST   /hub/threads/job/:visitId                                 open (or make) a job's crew thread
 *   GET    /hub/groups/choices                                       who can be put in a group chat (C7: people and active agent keys)
 *   POST   /hub/groups  { name, technicianIds, agentKeyIds }         New group chat
 *   POST   /hub/groups/:id/members  { technicianIds, agentKeyIds }   Add members
 *   DELETE /hub/groups/:id/members  { technicianId | agentKeyId }    Remove a member
 *   DELETE /hub/groups/:id                                           Delete group (only while it holds no message)
 *   POST   /hub/threads/:id/messages   { body, subject? }            Post to crew / Post to team
 *   POST   /hub/threads/:id/read                                     mark read
 *   PATCH  /hub/messages/:id           { body }                      edit your own message
 *   DELETE /hub/messages/:id           { reason }                    delete your own message (leaves a mark)
 *   GET    /hub/badge                                                the nav badge
 *   GET    /hub/approvals?status=&threadId=                          the approval cards (any office reader)
 *   POST   /hub/messages/:id/approve                                 Approve and send / Send now   (approve_drafts)
 *   POST   /hub/messages/:id/edit-approve  { body, subject?, to?, cc? }   Send my version         (approve_drafts)
 *   POST   /hub/messages/:id/reject        { reason }                Reject draft                  (approve_drafts)
 *   GET    /hub/audit?threadId=&actor=&action=&before=               the Message audit log (Kyle only)
 *   GET    /hub/stream                                               live updates (U6): text/event-stream, ids only
 *   POST   /hub/threads/:id/attachments   raw image                  Add photo on your Team thread (U5, held on the message)
 *   GET    /hub/attachments/:id                                      the picture, with the session (never a token in a URL)
 *   DELETE /hub/attachments/:id                                      take back a photo added and not sent
 *   GET    /hub/push/key                                             are notifications set up, and the public key (U7)
 *   POST   /hub/push/subscription  { endpoint, keys }                Turn on notifications on this device
 *   DELETE /hub/push/subscription  { endpoint }                      Turn off
 *
 * AGENT KEYS (K-U7, work order agent-team): exactly three of these routes also answer an agent key, through
 * the agent gate (middleware/publicRoutes.ts AGENT_KEY_ROUTES) and src/agentApi/hubDoor.ts:
 *   GET  /hub/threads, GET /hub/threads/:id/messages   (hub:read)   what the key may read, as the every-key message profile
 *   POST /hub/messages  { thread_id | one record link, channel, body, ... idempotency_key }   (hub:draft)
 * a DRAFT, never approved or sent. It is the same route table the CRM uses, not a second router; every
 * other route here is refused to an agent key (401 at the session gate, 403 in withReader). The CRM keeps
 * GET /hub/threads/:id; an agent key is not accepted there.
 *
 * Deliberately NOT here: any way to make or delete a Team thread (team answer 9a: one per person,
 * made on first use; only an office-made GROUP, C7, is made and deleted by hand), and any way to post into a customer thread (a customer conversation takes a
 * call note or the "Email the customer" panel, so there is one writer for each). The three decisions
 * run services/hubApproval.ts, which sends through hubSend and nothing else; there is no route that
 * calls hubSend directly, and a technician's token or an agent key never reaches any of these.
 */
import express from "express";
import { z } from "zod";
import { asyncHandler, readParam } from "../lib/routeHelpers";
import { canApprove, requireKyle, requireKylePower } from "../middleware/kylePowers";
import {
  CLIENT_MESSAGE_ID_MAX, CLIENT_MESSAGE_ID_MIN, HubError, editOwnMessage, ensureThreadFor, findVisibleThread, markThreadRead, postMessageResult, readerFor,
  renameThread, setThreadStatus, softDeleteMessage, type HubReader,
} from "../services/hub";
import { hubBadge, listThreads, threadDetail } from "../services/hubInbox";
import { addGroupMembers, createGroup, deleteGroup, groupChoices, removeGroupMember } from "../services/hubGroups";
import { approveMessage, decisionView, editApproveMessage, editApproveSchema, rejectMessage, rejectSchema } from "../services/hubApproval";
import { listApprovalCards } from "../services/hubCards";
import { listAudit } from "../services/hubAuditView";
import { buildTimeline, type TimelineTarget } from "../services/hubTimeline";
import { isHubThreadKind } from "../../shared/agentScopes";
import { agentCreateMessage, agentListThreads, agentRefusal, agentThreadDetail } from "../agentApi/hubDoor";
import { openHubStream } from "../services/hubStream";
import { readAttachment, removeAttachment, uploadAttachment } from "../services/hubAttachments";
import { PushError, isSubscribedHere, pushConfig, removeSubscription, saveSubscription, subscriptionCount } from "../services/hubPush";

export const hubRouter = express.Router();

type Handler = (req: express.Request, res: express.Response, reader: HubReader) => Promise<void>;

/**
 * Identify the reader (ONE resolver: readerFor, an agent key or a session), turn the hub's own refusals into
 * their status, and keep technicians out. An agent key is let through ONLY on a route that says `agent: true`
 * (the three in the header above); there its handler answers through src/agentApi/hubDoor.ts, and any refusal
 * is answered in the agent error shape with its audit row.
 */
const withReader = (fn: Handler, opts: { agent?: boolean } = {}): express.RequestHandler => asyncHandler(async (req, res) => {
  const reader = readerFor(req);
  if (!reader) {
    res.status(401).json({ error: "Sign in to use Messages." });
    return;
  }
  if (reader.kind === "tech" || (reader.kind === "agent" && !opts.agent)) {
    res.status(403).json({ error: "Messages in the CRM are for the office." });
    return;
  }
  try {
    await fn(req, res, reader);
  } catch (err) {
    if (reader.kind === "agent") {
      await agentRefusal(req, res, err);
      return;
    }
    if (err instanceof HubError || err instanceof PushError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: err.issues.map((i) => i.message).join(" ") });
      return;
    }
    throw err;
  }
});

const queryText = (req: express.Request, key: string): string | undefined => {
  const raw = req.query[key];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

hubRouter.get("/hub/timeline", withReader(async (req, res, reader) => {
  const keys = ["customerId", "leadId", "visitId", "propertyId"] as const;
  const found = keys.flatMap((k) => {
    const v = queryText(req, k);
    return v ? [{ key: k, id: v }] : [];
  });
  if (found.length !== 1) {
    res.status(400).json({ error: "Ask for one record: customerId, leadId, visitId or propertyId." });
    return;
  }
  const { key, id } = found[0]!;
  res.json(await buildTimeline(reader, { [key]: id } as TimelineTarget));
}));

hubRouter.get("/hub/threads", withReader(async (req, res, reader) => {
  // An agent's query is validated by its own door, so a bad kind, status or since (and any q) is the agent error
  // shape with its audit row, like every other refusal an agent gets.
  if (reader.kind === "agent") {
    await agentListThreads(req, res, reader, {
      kind: queryText(req, "kind"), status: queryText(req, "status"), q: queryText(req, "q"), since: queryText(req, "since"),
    });
    return;
  }
  const kind = queryText(req, "kind");
  if (kind && !isHubThreadKind(kind)) {
    res.status(400).json({ error: "Unknown thread kind." });
    return;
  }
  const status = queryText(req, "status");
  if (status && !["open", "closed", "all"].includes(status)) {
    res.status(400).json({ error: "Unknown status filter." });
    return;
  }
  res.json(await listThreads(reader, {
    kind, status, needsApproval: queryText(req, "needs") === "approval", q: queryText(req, "q"),
  }, canApprove(req)));
}, { agent: true }));

hubRouter.get("/hub/badge", withReader(async (req, res, reader) => {
  res.json(await hubBadge(reader, canApprove(req)));
}));

// A job's crew thread, made the first time somebody opens it. Before :id so "job" is never read as an id.
hubRouter.post("/hub/threads/job/:visitId", withReader(async (req, res, reader) => {
  const thread = await ensureThreadFor({ visitId: readParam(req, "visitId") });
  const seen = await findVisibleThread(reader, thread.id);
  if (!seen) throw new HubError("Conversation not found", 404);
  res.json({ id: seen.id });
}));

hubRouter.get("/hub/threads/:id", withReader(async (req, res, reader) => {
  res.json(await threadDetail(reader, readParam(req, "id")));
}));

// An agent key reads a thread here (hub:read; the path the team's contract names). The CRM's screens use
// GET /hub/threads/:id above, so a session gets a plain 404 and there is still one reader of a thread per door.
hubRouter.get("/hub/threads/:id/messages", withReader(async (req, res, reader) => {
  if (reader.kind !== "agent") {
    res.status(404).json({ error: "Not found. The CRM reads a conversation at /hub/threads/:id." });
    return;
  }
  await agentThreadDetail(req, res, reader, readParam(req, "id"));
}, { agent: true }));

// An agent key leaves a DRAFT here (hub:draft). The CRM has no use for this route: a person posts in a
// conversation's own box, so a session gets a plain 403. The work is src/agentApi/hubDoor.ts, which calls
// createDraftMessage (customer conversations, incl. the customerId/jobId links) or postMessageResult (Team, group, job crew chat and Training) - never hubSend.
hubRouter.post("/hub/messages", withReader(async (req, res, reader) => {
  if (reader.kind !== "agent") {
    res.status(403).json({ error: "Only an AI agent key leaves a draft here. Post in the conversation's own box." });
    return;
  }
  await agentCreateMessage(req, res, reader);
}, { agent: true }));

// ── office-made group chats (C7): any office sign-in; services/hubGroups.ts says who ───────────────────────────────

hubRouter.get("/hub/groups/choices", withReader(async (_req, res, reader) => {
  res.json(await groupChoices(reader));
}));

const idList = z.array(z.string().trim().min(1).max(64)).max(100).default([]);
const groupSchema = z.object({ name: z.string().trim().min(1, "A group needs a name.").max(120), technicianIds: idList, agentKeyIds: idList });
const membersSchema = z.object({ technicianIds: idList, agentKeyIds: idList });
const removeMemberSchema = z.object({ technicianId: z.string().trim().min(1).max(64).optional(), agentKeyId: z.string().trim().min(1).max(64).optional() });

hubRouter.post("/hub/groups", withReader(async (req, res, reader) => {
  const body = groupSchema.parse(req.body ?? {});
  const thread = await createGroup(reader, body);
  res.status(201).json({ id: thread.id });
}));

hubRouter.post("/hub/groups/:id/members", withReader(async (req, res, reader) => {
  const id = readParam(req, "id");
  await addGroupMembers(reader, id, membersSchema.parse(req.body ?? {}));
  res.json(await threadDetail(reader, id));
}));

hubRouter.delete("/hub/groups/:id/members", withReader(async (req, res, reader) => {
  const id = readParam(req, "id");
  await removeGroupMember(reader, id, removeMemberSchema.parse(req.body ?? {}));
  res.json(await threadDetail(reader, id));
}));

hubRouter.delete("/hub/groups/:id", withReader(async (req, res, reader) => {
  await deleteGroup(reader, readParam(req, "id"));
  res.status(204).end();
}));

const patchThreadSchema = z.object({
  title: z.string().max(200).optional(),
  status: z.enum(["open", "closed"]).optional(),
}).refine((v) => v.title !== undefined || v.status !== undefined, { message: "Nothing to change." });

hubRouter.patch("/hub/threads/:id", withReader(async (req, res, reader) => {
  const id = readParam(req, "id");
  const body = patchThreadSchema.parse(req.body ?? {});
  if (body.title !== undefined) await renameThread(reader, id, body.title);
  if (body.status !== undefined) await setThreadStatus(reader, id, body.status);
  res.json(await threadDetail(reader, id));
}));

const postSchema = z.object({
  // A photo can go on its own, so the words may be empty when one is attached (postMessage says so otherwise).
  body: z.string().trim().max(10_000).default(""),
  subject: z.string().trim().max(200).nullish(),
  /** A job thread's photos: VisitPhoto ids already filed on that job. */
  photoIds: z.array(z.string().min(1)).max(6).default([]),
  /** A Team, Training or group thread's photos: HubAttachment ids added to this thread and not yet sent. */
  attachmentIds: z.array(z.string().min(1)).max(6).default([]),
  /** One id per composed message, sent again on every retry of it: a repeat answers with the message already made. */
  clientMessageId: z.string().trim().min(CLIENT_MESSAGE_ID_MIN).max(CLIENT_MESSAGE_ID_MAX).optional(),
});

hubRouter.post("/hub/threads/:id/messages", withReader(async (req, res, reader) => {
  const id = readParam(req, "id");
  const body = postSchema.parse(req.body ?? {});
  const thread = await findVisibleThread(reader, id);
  if (!thread) throw new HubError("Conversation not found", 404);
  if (thread.kind === "customer") {
    // One writer per thing: a call note is the notes route's, an email is the "Email the customer" panel's.
    throw new HubError("A customer's conversation takes a call note or an email: use Add call note or Email the customer on the account.", 409);
  }
  const { message, replayed } = await postMessageResult(reader, {
    threadId: id, body: body.body, subject: body.subject ?? null, photoIds: body.photoIds, attachmentIds: body.attachmentIds,
    clientMessageId: body.clientMessageId ?? null,
  });
  // 200 when this id had already made the message (a retry), 201 when this call made it.
  res.status(replayed ? 200 : 201).json({ id: message.id });
}));

hubRouter.post("/hub/threads/:id/read", withReader(async (req, res, reader) => {
  await markThreadRead(reader, readParam(req, "id"));
  res.status(204).end();
}));

const editSchema = z.object({ body: z.string().trim().min(1, "A message needs text.").max(10_000) });

hubRouter.patch("/hub/messages/:id", withReader(async (req, res, reader) => {
  const body = editSchema.parse(req.body ?? {});
  const message = await editOwnMessage(reader, readParam(req, "id"), body.body);
  res.json({ id: message.id, editedAt: message.editedAt ? message.editedAt.toISOString() : null });
}));

const deleteSchema = z.object({ reason: z.string().trim().min(1, "Say why it is being deleted.").max(500) });

hubRouter.delete("/hub/messages/:id", withReader(async (req, res, reader) => {
  const body = deleteSchema.parse(req.body ?? {});
  await softDeleteMessage(reader, readParam(req, "id"), body.reason);
  res.status(204).end();
}));

// ── approvals (U4 + TC1/TC3) ─────────────────────────────────────────────────────────────────────

hubRouter.get("/hub/approvals", withReader(async (req, res, reader) => {
  const status = queryText(req, "status");
  if (status && !["pending", "all"].includes(status)) {
    res.status(400).json({ error: "Unknown status filter." });
    return;
  }
  res.json(await listApprovalCards(reader, {
    status: status === "all" ? "all" : "pending", threadId: queryText(req, "threadId"), messageId: queryText(req, "messageId"),
  }, canApprove(req)));
}));

const decided = decisionView;

// The approve_drafts power is the ONE approver gate (Kyle only at launch). Without it: 403 with the power's sentence.
const approver = requireKylePower("approve_drafts");

hubRouter.post("/hub/messages/:id/approve", approver, withReader(async (req, res, reader) => {
  res.json(decided(await approveMessage(reader, readParam(req, "id"))));
}));

hubRouter.post("/hub/messages/:id/edit-approve", approver, withReader(async (req, res, reader) => {
  const edit = editApproveSchema.parse(req.body ?? {});
  res.json(decided(await editApproveMessage(reader, readParam(req, "id"), edit)));
}));

hubRouter.post("/hub/messages/:id/reject", approver, withReader(async (req, res, reader) => {
  const { reason } = rejectSchema.parse(req.body ?? {});
  res.json(decided(await rejectMessage(reader, readParam(req, "id"), reason)));
}));

// ── the Message audit log (Kyle only) ────────────────────────────────────────────────────────────

hubRouter.get("/hub/audit", requireKyle("Only Kyle can read the message audit log."), withReader(async (req, res) => {
  res.json(await listAudit({
    threadId: queryText(req, "threadId"), actor: queryText(req, "actor"), action: queryText(req, "action"), before: queryText(req, "before"),
  }));
}));

// ── live updates, photos and notifications (U5, U6, U7) ──────────────────────────────────────────

// Not wrapped in withReader's try/catch once it starts: the stream owns the response until it ends.
hubRouter.get("/hub/stream", (req, res, next) => {
  const reader = readerFor(req);
  if (!reader) {
    res.status(401).json({ error: "Sign in to use Messages." });
    return;
  }
  if (reader.kind === "tech" || reader.kind === "agent") {
    res.status(403).json({ error: "Messages in the CRM are for the office." });
    return;
  }
  try {
    openHubStream(req, res, reader);
  } catch (err) {
    next(err);
  }
});

// A photo on a Team (or Training or group) thread, held on the message. Raw image bytes - the CRM shrinks the picture to
// 1600 px first - so the global 1 MB JSON parser never sees it. A job's photo is filed on the job instead.
hubRouter.post(
  "/hub/threads/:id/attachments",
  express.raw({ type: "image/*", limit: "11mb" }),
  withReader(async (req, res, reader) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "Add a picture first (Content-Type: image/*)." });
      return;
    }
    res.status(201).json(await uploadAttachment(reader, readParam(req, "id"), body));
  }),
);

hubRouter.get("/hub/attachments/:id", withReader(async (req, res, reader) => {
  const found = await readAttachment(reader, readParam(req, "id"));
  if (!found) {
    res.status(404).json({ error: "Photo not found." });
    return;
  }
  res.setHeader("Content-Type", found.mimeType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.send(found.data);
}));

hubRouter.delete("/hub/attachments/:id", withReader(async (req, res, reader) => {
  await removeAttachment(reader, readParam(req, "id"));
  res.status(204).end();
}));

// Notifications are for people: the AI admin is never notified by push.
const pushPerson = (reader: HubReader): void => {
  if (reader.kind === "ai-admin") throw new HubError("Notifications are for people, not the AI admin.", 403);
};

hubRouter.get("/hub/push/key", withReader(async (_req, res, reader) => {
  const cfg = pushConfig();
  const people = reader.kind !== "ai-admin";
  res.json({
    configured: cfg.configured && people,
    publicKey: people ? cfg.publicKey : null,
    reason: people ? cfg.reason : "Notifications are for people, not the AI admin.",
    subscribed: people ? (await subscriptionCount(reader.key)) > 0 : false,
  });
}));

const subscriptionSchema = z.object({
  endpoint: z.string().min(1).max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(200) }),
});

hubRouter.post("/hub/push/subscription", withReader(async (req, res, reader) => {
  pushPerson(reader);
  const sub = subscriptionSchema.parse(req.body ?? {});
  await saveSubscription(reader.key, sub, typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null);
  res.status(201).json({ subscribed: true });
}));

hubRouter.delete("/hub/push/subscription", withReader(async (req, res, reader) => {
  const { endpoint } = z.object({ endpoint: z.string().min(1).max(1000) }).parse(req.body ?? {});
  // "removed" is false when this device is not this person's: the browser must then keep its own subscription.
  const removed = await removeSubscription(reader.key, endpoint);
  res.json({ subscribed: false, removed });
}));

// Is THIS device on for this person? The endpoint is in the body (it is a capability URL), never in the address.
hubRouter.post("/hub/push/subscription/status", withReader(async (req, res, reader) => {
  const { endpoint } = z.object({ endpoint: z.string().min(1).max(1000) }).parse(req.body ?? {});
  res.json({ subscribedHere: reader.kind === "ai-admin" ? false : await isSubscribedHere(reader.key, endpoint) });
}));
