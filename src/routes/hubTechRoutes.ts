/**
 * THE FIELD APP'S MESSAGES, the technician's door (work order agent-team, U5, U6 and U7). Registered on
 * healthRecordTechRouter (routes/health-record.ts), so it sits behind the technician's bearer token like
 * every other field route and is already public-allowlisted under /health-record; nothing is added to
 * PUBLIC_ROUTES. Thin: every route is a call into services/hubTech.ts (what the phone reads) or the hub's
 * own writers (services/hub.ts postMessage, editOwnMessage, softDeleteMessage, markThreadRead), so the
 * office and the field share ONE message writer.
 *
 *   GET    /health-record/hub/threads                    the Messages list (Team, Training, one row per job)
 *   GET    /health-record/hub/badge                      { unread } for the home screen's "Messages (n new)"
 *   POST   /health-record/hub/job/:visitId/thread        open (or make) the crew thread of a job you are on
 *   GET    /health-record/hub/threads/:id/messages       one thread with its readable messages
 *   POST   /health-record/hub/threads/:id/messages       { body, photoIds?, attachmentIds? }  Send
 *   POST   /health-record/hub/threads/:id/read           mark read
 *   PATCH  /health-record/hub/messages/:id               { body }  Edit (your own)
 *   DELETE /health-record/hub/messages/:id               { reason? }  Delete (your own; leaves a mark)
 *   POST   /health-record/hub/threads/:id/attachments    raw image: a photo on your Team thread (HubAttachment)
 *   DELETE /health-record/hub/attachments/:id            take back a photo you added and did not send
 *   GET    /health-record/hub/attachments/:id            the picture, with your bearer (never a token in a URL)
 *   GET    /health-record/hub/stream                     live updates (U6): text/event-stream, ids only
 *   GET    /health-record/hub/push/key                   whether notifications are set up, and the public key (U7)
 *   POST   /health-record/hub/push/subscription          { endpoint, keys }   Turn on notifications on this device
 *   DELETE /health-record/hub/push/subscription          { endpoint }         Turn off ({ removed } says whether it was this person's)
 *   POST   /health-record/hub/push/subscription/status   { endpoint }         is THIS device on for me ({ subscribedHere })
 *
 * A job's PHOTO is not sent here: the phone files it on the job through the existing
 * PUT /health-record/visits/:visitId/photos/:photoId and then sends the message with that id in photoIds.
 * Responses never carry the technician's access token or any key: the author is the technician's name.
 */
import express from "express";
import { z } from "zod";
import { asyncHandler, readParam } from "../lib/routeHelpers";
import type { TechRequest } from "./technicianAuth";
import {
  HubError, editOwnMessage, ensureThreadFor, markThreadRead, postMessage, softDeleteMessage, type HubReader,
} from "../services/hub";
import { listTechThreads, techBadge, techReader, techThread, techThreadDetail } from "../services/hubTech";
import { readAttachment, removeAttachment, uploadAttachment } from "../services/hubAttachments";
import { openHubStream } from "../services/hubStream";
import { PushError, isSubscribedHere, pushConfig, removeSubscription, saveSubscription, subscriptionCount } from "../services/hubPush";

type Handler = (req: TechRequest, res: express.Response, reader: HubReader) => Promise<void>;

const fail = (res: express.Response, status: number, message: string): void => {
  res.status(status).json({ success: false, error: { code: status === 403 ? "forbidden" : status === 404 ? "not_found" : "bad_request", message } });
};

const postSchema = z.object({
  body: z.string().trim().max(10_000).default(""),
  photoIds: z.array(z.string().min(1)).max(6).default([]),
  attachmentIds: z.array(z.string().min(1)).max(6).default([]),
});
const editSchema = z.object({ body: z.string().trim().min(1, "A message needs text.").max(10_000) });
const deleteSchema = z.object({ reason: z.string().trim().max(500).optional() });
const subscriptionSchema = z.object({
  endpoint: z.string().min(1).max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(200) }),
});
const endpointSchema = z.object({ endpoint: z.string().min(1).max(1000) });

export function registerHubTechRoutes(
  router: express.Router,
  requireAssigned: (req: TechRequest, res: express.Response, visitId: string) => Promise<boolean>,
): void {
  const route = (fn: Handler): express.RequestHandler => asyncHandler(async (req: TechRequest, res) => {
    const reader = techReader(req.technician!);
    try {
      await fn(req, res, reader);
    } catch (err) {
      if (err instanceof HubError || err instanceof PushError) {
        fail(res, err.status, err.message);
        return;
      }
      throw err;
    }
  });

  router.get("/hub/threads", route(async (_req, res, reader) => {
    res.json({ success: true, data: await listTechThreads(reader) });
  }));

  router.get("/hub/badge", route(async (_req, res, reader) => {
    res.json({ success: true, data: await techBadge(reader) });
  }));

  // The job's crew thread, made the first time somebody opens it - and only for a job this technician is on.
  router.post("/hub/job/:visitId/thread", route(async (req, res) => {
    const visitId = readParam(req, "visitId");
    if (!(await requireAssigned(req, res, visitId))) return;
    const thread = await ensureThreadFor({ visitId });
    res.json({ success: true, data: { id: thread.id } });
  }));

  router.get("/hub/threads/:id/messages", route(async (req, res, reader) => {
    res.json({ success: true, data: await techThreadDetail(reader, readParam(req, "id")) });
  }));

  router.post("/hub/threads/:id/messages", route(async (req, res, reader) => {
    const id = readParam(req, "id");
    const body = postSchema.parse(req.body ?? {});
    await techThread(reader, id); // 404 / 403 before anything is written
    const message = await postMessage(reader, { threadId: id, body: body.body, photoIds: body.photoIds, attachmentIds: body.attachmentIds });
    res.status(201).json({ success: true, data: { id: message.id } });
  }));

  router.post("/hub/threads/:id/read", route(async (req, res, reader) => {
    const id = readParam(req, "id");
    await techThread(reader, id);
    await markThreadRead(reader, id);
    res.json({ success: true, data: { read: true } });
  }));

  router.patch("/hub/messages/:id", route(async (req, res, reader) => {
    const body = editSchema.parse(req.body ?? {});
    const message = await editOwnMessage(reader, readParam(req, "id"), body.body);
    res.json({ success: true, data: { id: message.id, editedAt: message.editedAt ? message.editedAt.toISOString() : null } });
  }));

  router.delete("/hub/messages/:id", route(async (req, res, reader) => {
    const body = deleteSchema.parse(req.body ?? {});
    await softDeleteMessage(reader, readParam(req, "id"), body.reason ?? null);
    res.json({ success: true, data: { deleted: true } });
  }));

  // A photo on the technician's own Team (or Training) thread, held on the message: the raw-image pattern of
  // the job-photo upload above it, which the global 1 MB JSON parser never touches.
  router.post(
    "/hub/threads/:id/attachments",
    express.raw({ type: "image/*", limit: "11mb" }),
    route(async (req, res, reader) => {
      const id = readParam(req, "id");
      await techThread(reader, id);
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        fail(res, 400, "Raw image body required (Content-Type: image/*)");
        return;
      }
      const saved = await uploadAttachment(reader, id, body);
      res.status(201).json({ success: true, data: saved });
    }),
  );

  router.delete("/hub/attachments/:id", route(async (req, res, reader) => {
    await removeAttachment(reader, readParam(req, "id"));
    res.json({ success: true, data: { removed: true } });
  }));

  router.get("/hub/attachments/:id", route(async (req, res, reader) => {
    const found = await readAttachment(reader, readParam(req, "id"));
    if (!found) {
      fail(res, 404, "Photo not found");
      return;
    }
    res.setHeader("Content-Type", found.mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(found.data);
  }));

  // Live updates. Not wrapped: the stream owns the response until it ends.
  router.get("/hub/stream", (req: TechRequest, res) => {
    openHubStream(req, res, techReader(req.technician!));
  });

  router.get("/hub/push/key", route(async (_req, res, reader) => {
    const cfg = pushConfig();
    res.json({ success: true, data: { configured: cfg.configured, publicKey: cfg.publicKey, reason: cfg.reason, subscribed: (await subscriptionCount(reader.key)) > 0 } });
  }));

  router.post("/hub/push/subscription", route(async (req, res, reader) => {
    const sub = subscriptionSchema.parse(req.body ?? {});
    await saveSubscription(reader.key, sub, typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null);
    res.status(201).json({ success: true, data: { subscribed: true } });
  }));

  router.delete("/hub/push/subscription", route(async (req, res, reader) => {
    const { endpoint } = endpointSchema.parse(req.body ?? {});
    const removed = await removeSubscription(reader.key, endpoint);
    res.json({ success: true, data: { subscribed: false, removed } });
  }));

  // Is THIS device on for this technician? The endpoint is in the body (a capability URL), never in the address.
  router.post("/hub/push/subscription/status", route(async (req, res, reader) => {
    const { endpoint } = endpointSchema.parse(req.body ?? {});
    res.json({ success: true, data: { subscribedHere: await isSubscribedHere(reader.key, endpoint) } });
  }));
}
