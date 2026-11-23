/**
 * Settings -> "Agent events" (work order agent-team, BA5): the log of every signed event the CRM has
 * sent, or kept, for the AI agents, and the Resend button. Behind the session gate (never public) and
 * behind `requireBotKeys()`, the same gate as the Agent keys card: Kyle always passes, a person only
 * with the bot_keys power Kyle granted, the AI admin and every agent key never. An agent key
 * presented here is refused by the session gate before it reaches this file.
 *
 *   GET  /hub/events?status=&type=&target=&before=&limit=   newest first, 50 a page (limit 1-200); status all | delivered
 *                                            | retrying (pending too) | dead | no_target; target admin | inventory (the
 *                                            per-webhook delivery log is this same list filtered by target)
 *   GET  /hub/events/config                  { urlSet, secretSet } as booleans only: never the address
 *                                            and never the secret
 *   POST /hub/events/:id/resend              try this event again now, as the same event (same id,
 *                                            prior attempts kept). Refused 409 on a delivered one.
 *
 *   POST   /hub/webhooks/:target/signing-secret   (Kyle only) make or replace that agent's own signing secret; the
 *                                            answer is the ONLY time it leaves the server (never stored in the clear)
 *   DELETE /hub/webhooks/:target/signing-secret   (Kyle only) remove it (Admin signs with HUB_WEBHOOK_SECRET again)
 *   POST   /hub/webhooks/:target/test        (Kyle only) deliver ONE signed test.ping to that agent now; answers the
 *                                            HTTP status and response time. Recorded in the log, never retried.
 *
 * Nothing here returns a payload: the screen shows the templated summary, which is already free of
 * names, links and contact details.
 */
import express from "express";
import { asyncHandler, readParam } from "../lib/routeHelpers";
import { requireBotKeys, requireKyle } from "../middleware/kylePowers";
import { actorNameOf } from "../lib/actorName";
import { logSystemEvent } from "../services/systemEvents";
import { HubEventError, listEvents, resendEvent, sendTestEvent, viewEvent, webhookConfigState } from "../services/hubEvents";
import { OwnerSettingInputError, generateWebhookSigningSecret, removeWebhookSigningSecret } from "../services/ownerSettings";
import { HUB_EVENT_STATUSES, HUB_WEBHOOK_TARGET_LABELS, isHubEventType, isHubWebhookTargetId } from "../../shared/hub/events";
import { prisma } from "../lib/prisma";

export const hubEventsRouter = express.Router();

const guard = requireBotKeys();
const kyleOnly = requireKyle("Only Kyle can change where agent events go.");

const readQuery = (req: express.Request, key: string): string | undefined => {
  const raw = req.query[key];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" ? v : undefined;
};

hubEventsRouter.get("/hub/events/config", guard, asyncHandler(async (_req, res) => {
  res.json(await webhookConfigState());
}));

hubEventsRouter.get("/hub/events", guard, asyncHandler(async (req, res) => {
  const status = readQuery(req, "status") || "all";
  if (status !== "all" && status !== "retrying" && !(HUB_EVENT_STATUSES as readonly string[]).includes(status)) {
    res.status(400).json({ error: "Unknown status filter" });
    return;
  }
  const type = readQuery(req, "type");
  if (type && !isHubEventType(type)) {
    res.status(400).json({ error: "Unknown event type" });
    return;
  }
  const target = readQuery(req, "target");
  if (target && !isHubWebhookTargetId(target)) {
    res.status(400).json({ error: "Unknown agent" });
    return;
  }
  const beforeText = readQuery(req, "before");
  let before: Date | undefined;
  if (beforeText) {
    before = new Date(beforeText);
    if (Number.isNaN(before.getTime())) {
      res.status(400).json({ error: "before must be a date" });
      return;
    }
  }
  const limitText = readQuery(req, "limit");
  const limit = limitText !== undefined && /^\d{1,3}$/.test(limitText) ? Number(limitText) : undefined;
  res.json(await listEvents({ status, type: type || undefined, target: target && isHubWebhookTargetId(target) ? target : undefined, before, limit }));
}));

hubEventsRouter.post("/hub/events/:id/resend", guard, asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  try {
    const row = await resendEvent(id);
    const full = await prisma.hubEvent.findUniqueOrThrow({ where: { id: row.id }, include: { attemptLog: { orderBy: { at: "asc" } } } });
    logSystemEvent("info", "agent_events", `Event ${full.type} resent`, {
      route: "POST /hub/events/:id/resend", actor: await actorNameOf(req), eventId: full.id, status: full.status,
    });
    res.json({ event: viewEvent(full) });
  } catch (err) {
    if (err instanceof HubEventError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
}));

// ── the webhook cards (work order C6b): the signing secret and the test event ───────────────────────

/** The :target of a /hub/webhooks route, or null after answering 400. */
function targetParam(req: express.Request, res: express.Response) {
  const id = readParam(req, "target");
  if (isHubWebhookTargetId(id)) return id;
  res.status(400).json({ error: "Unknown agent" });
  return null;
}

hubEventsRouter.post("/hub/webhooks/:target/signing-secret", kyleOnly, asyncHandler(async (req, res) => {
  const id = targetParam(req, res);
  if (id === null) return;
  try {
    const made = await generateWebhookSigningSecret(id);
    // Names the agent and who, never the secret or any part of it.
    logSystemEvent("info", "agent_events", `${HUB_WEBHOOK_TARGET_LABELS[id]} signing secret ${made.replaced ? "regenerated" : "generated"}`, {
      route: "POST /hub/webhooks/:target/signing-secret", actor: await actorNameOf(req), target: id,
    });
    // This answer is the only time the secret leaves the server: it must not be kept by a cache.
    res.set("Cache-Control", "no-store");
    res.json({ secret: made.secret, masked: made.masked, replaced: made.replaced });
  } catch (err) {
    if (err instanceof OwnerSettingInputError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
}));

hubEventsRouter.delete("/hub/webhooks/:target/signing-secret", kyleOnly, asyncHandler(async (req, res) => {
  const id = targetParam(req, res);
  if (id === null) return;
  const had = await removeWebhookSigningSecret(id);
  logSystemEvent("info", "agent_events", `${HUB_WEBHOOK_TARGET_LABELS[id]} signing secret removed`, {
    route: "DELETE /hub/webhooks/:target/signing-secret", actor: await actorNameOf(req), target: id, hadOwnSecret: had,
  });
  res.json({ removed: had });
}));

hubEventsRouter.post("/hub/webhooks/:target/test", kyleOnly, asyncHandler(async (req, res) => {
  const id = targetParam(req, res);
  if (id === null) return;
  try {
    const result = await sendTestEvent(id);
    logSystemEvent("info", "agent_events", `Test event sent to ${HUB_WEBHOOK_TARGET_LABELS[id]}`, {
      route: "POST /hub/webhooks/:target/test", actor: await actorNameOf(req), target: id, eventId: result.event.id, status: result.event.status,
      statusCode: result.statusCode, ms: result.ms,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof HubEventError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
}));
