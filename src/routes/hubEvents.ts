/**
 * Settings -> "Agent events" (work order agent-team, BA5): the log of every signed event the CRM has
 * sent, or kept, for the AI agents, and the Resend button. Behind the session gate (never public) and
 * behind `requireBotKeys()`, the same gate as the Agent keys card: Kyle always passes, a person only
 * with the bot_keys power Kyle granted, the AI admin and every agent key never. An agent key
 * presented here is refused by the session gate before it reaches this file.
 *
 *   GET  /hub/events?status=&type=&before=&limit=   newest first, 50 a page (limit 1-200); status all | delivered | retrying
 *                                            (pending too) | dead | no_target
 *   GET  /hub/events/config                  { urlSet, secretSet } as booleans only: never the address
 *                                            and never the secret
 *   POST /hub/events/:id/resend              try this event again now, as the same event (same id,
 *                                            prior attempts kept). Refused 409 on a delivered one.
 *
 * Nothing here returns a payload: the screen shows the templated summary, which is already free of
 * names, links and contact details.
 */
import express from "express";
import { asyncHandler, readParam } from "../lib/routeHelpers";
import { requireBotKeys } from "../middleware/kylePowers";
import { actorNameOf } from "../lib/actorName";
import { logSystemEvent } from "../services/systemEvents";
import { HubEventError, listEvents, resendEvent, viewEvent, webhookConfigState } from "../services/hubEvents";
import { HUB_EVENT_STATUSES, isHubEventType } from "../../shared/hub/events";
import { prisma } from "../lib/prisma";

export const hubEventsRouter = express.Router();

const guard = requireBotKeys();

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
  res.json(await listEvents({ status, type: type || undefined, before, limit }));
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
