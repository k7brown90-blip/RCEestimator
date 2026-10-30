/**
 * Website booking chat — the endpoints the public website relays to (plan
 * 2026-10-30-website-booking-chat, U2).
 *
 * Server-to-server ONLY: the website's own server calls these with the `webhook_secret` header
 * (the same secret /leads uses) and the visitor's IP in `x-visitor-ip`. The secret never reaches a
 * browser, so the CRM grows no unauthenticated endpoint. Every route here is listed in
 * middleware/publicRoutes.ts as `webhook_secret header`.
 *
 * The logic lives in services/bookingChat/; this file is the thin door. Errors are always JSON
 * `{ error, reply }` where `reply` is something the chat can show the visitor as-is.
 */

import express from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireWebhookSecret } from "../middleware/webhookSecret";
import { logSystemEvent } from "../services/systemEvents";
import {
  bytesMatchImageType,
  handleMessage,
  handlePhoto,
  isAcceptedImageType,
  startChat,
} from "../services/bookingChat/chat";
import { BOOKING_PHONE, FALLBACK_REPLY, MAX_PHOTO_BYTES, MAX_TEXT_CHARS } from "../services/bookingChat/limits";

export const bookingChatRouter = express.Router();

const headerOf = (req: express.Request, name: string): string => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
};

/** The visitor's IP as the website forwarded it (first hop of a list, trimmed, bounded). */
function visitorIp(req: express.Request): string | null {
  const first = headerOf(req, "x-visitor-ip").split(",")[0]?.trim() ?? "";
  return first && first.length <= 64 ? first : null;
}

const skipLimiter = () => process.env.NODE_ENV === "test";

// All callers arrive from the website's server, so req.ip is the website, not the visitor: the
// budget is keyed on the forwarded visitor IP when there is one.
const chatLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipLimiter,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => `visitor:${visitorIp(req as express.Request) ?? `ip:${req.ip ?? "unknown"}`}`,
  handler: (_req, res) => {
    res.status(429).json({ error: "rate_limited", reply: `You're going a little fast. Please wait a moment, or call us at ${BOOKING_PHONE}.` });
  },
});

// The secret first: an unauthenticated caller costs one 401 and touches nothing else.
bookingChatRouter.use(requireWebhookSecret);
bookingChatRouter.use(chatLimiter);

const sanitize = (s: string, max: number): string => s.replace(/[\r\n\t[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Wrap a handler so nothing escapes as a bare 500: log it, answer with the phone number. */
const door = (fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler =>
  (req, res) => {
    fn(req, res).catch((err) => {
      logSystemEvent("error", "bookingChat", "Booking chat route failed", {
        route: `${req.method} ${req.path.replace(/^\/[^/]+\//, "/…/")}`,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) res.status(500).json({ error: "server_error", reply: FALLBACK_REPLY });
    });
  };

const NOT_FOUND = { error: "chat_not_found", reply: `I can't find that conversation. Please refresh the page to start again, or call us at ${BOOKING_PHONE}.` };

// ── POST /booking-chat/start ─────────────────────────────────────────────────

const startSchema = z.object({ src: z.string().max(200).optional() }).strip();

bookingChatRouter.post("/start", door(async (req, res) => {
  const body = startSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "bad_request", reply: FALLBACK_REPLY });
    return;
  }
  const result = await startChat({ src: body.data.src, visitorIp: visitorIp(req) });
  if (!result.ok) {
    res.status(429).json({ error: "too_many_chats", reply: result.reply });
    return;
  }
  res.status(201).json({ token: result.token, reply: result.reply });
}));

// ── POST /booking-chat/:token/message ────────────────────────────────────────

// Not .max(): an over-long message is answered politely by the engine, not rejected as a 400.
const messageSchema = z.object({
  text: z.string().trim().min(1).max(MAX_TEXT_CHARS * 20),
  smsConsent: z.boolean().optional(),
  /** What the website saw the visitor typing on. Anything else is dropped, never a 400. */
  device: z.enum(["phone", "computer"]).optional().catch(undefined),
});

bookingChatRouter.post("/:token/message", door(async (req, res) => {
  const body = messageSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "bad_request", reply: "I didn't catch that. Could you type it again?" });
    return;
  }
  const out = await handleMessage(String(req.params.token), body.data.text, body.data.smsConsent, body.data.device);
  if (!out.found) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  res.json(out.result);
}));

// ── POST /booking-chat/:token/photo ──────────────────────────────────────────

const photoQuerySchema = z.object({
  kind: z.enum(["concern", "panel"]).default("concern"),
  room: z.string().max(300).optional(),
  caption: z.string().max(1000).optional(),
});

bookingChatRouter.post(
  "/:token/photo",
  // Mounted on THIS route only: the global express.json limit (1mb, app.ts) stays as it is.
  express.raw({ type: "image/*", limit: MAX_PHOTO_BYTES }),
  door(async (req, res) => {
    const query = photoQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "bad_request", reply: "I couldn't read that photo's details. Please try again." });
      return;
    }
    const mimeType = headerOf(req, "content-type").split(";")[0].trim().toLowerCase();
    const bytes = req.body as unknown;
    if (!isAcceptedImageType(mimeType) || !Buffer.isBuffer(bytes) || bytes.length === 0) {
      res.status(415).json({ error: "unsupported_image", reply: "I can take JPEG, PNG, WebP or HEIC photos. Could you try another one?" });
      return;
    }
    if (!bytesMatchImageType(bytes, mimeType)) {
      res.status(415).json({ error: "unsupported_image", reply: "That file doesn't look like a photo I can accept. Could you try another one?" });
      return;
    }

    const out = await handlePhoto(String(req.params.token), {
      bytes,
      mimeType,
      kind: query.data.kind,
      room: query.data.room ? sanitize(query.data.room, 100) || null : null,
      caption: query.data.caption ? sanitize(query.data.caption, 500) || null : null,
    });
    if (!out.found) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    res.status(out.status).json(out.body);
  }),
);

// ── Errors from this router (e.g. express.raw's 413 on an oversized photo) ───
bookingChatRouter.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) { next(err); return; }
  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
  if (status === 413) {
    res.status(413).json({ error: "photo_too_large", reply: "That photo is too large. Please try a smaller one." });
    return;
  }
  if (status >= 400 && status < 500) {
    res.status(status).json({ error: "bad_request", reply: FALLBACK_REPLY });
    return;
  }
  logSystemEvent("error", "bookingChat", "Booking chat router error", { error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ error: "server_error", reply: FALLBACK_REPLY });
});
