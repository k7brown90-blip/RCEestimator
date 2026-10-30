/**
 * The website booking chat — conversation engine (plan 2026-10-30-website-booking-chat, U2).
 *
 * The website (a separate project) relays each visitor action here, server-to-server, with the
 * webhook_secret header. This file runs one AI turn at a time against the OpenAI Responses API,
 * lets the model call the tools in tools.ts, and records everything on the BookingChat / Lead.
 *
 * The model never sees image bytes. A photo reaches it only as a server-written note carrying the
 * photo's id ("[photo uploaded: id=…]").
 */

import crypto from "node:crypto";
import { prisma } from "../../lib/prisma";
import { parseJsonArray } from "../../lib/json";
import { normalizeLeadPlatform } from "../../../shared/leadPlatform";
import { logSystemEvent } from "../systemEvents";
import { buildInstructions, BOOKING_CHAT_GREETING, type WorkOrderState } from "./prompt";
import { BOOKING_CHAT_TOOLS, runTool, type ToolContext } from "./tools";
import { describeBlock, PLACEHOLDER_NAME } from "./scheduling";
import { notifyKyleOnce } from "./notifyKyle";
import {
  CHAT_LIMIT_REPLY,
  CLOSED_REPLY,
  FALLBACK_REPLY,
  MAX_AI_CALLS_PER_CHAT,
  MAX_CHATS_PER_IP_PER_DAY,
  MAX_MESSAGES_PER_CHAT,
  MAX_PHOTOS_PER_CHAT,
  MAX_TEXT_CHARS,
  MAX_TOOL_ROUNDS_PER_TURN,
  PHOTO_LIMIT_REPLY,
  START_LIMIT_REPLY,
  TOO_LONG_REPLY,
} from "./limits";

// ── Types ────────────────────────────────────────────────────────────────────

export type TranscriptRole = "user" | "assistant" | "tool" | "note" | "event";

export interface TranscriptEntry {
  role: TranscriptRole;
  content: string;
  at: string;
}

export interface ChatView {
  status: string;
  heldSlot: { start: string; end: string; label: string } | null;
  acceptsPhotos: boolean;
  ended: boolean;
}

export interface MessageResult extends ChatView {
  reply: string;
  /** Present when a limit stopped the turn, so the website can tell it from a normal reply. */
  limit?: "message_length" | "message_count" | "ai_calls";
}

const ENDED_MARKER = "conversation_ended";

const now = () => new Date();
const entry = (role: TranscriptRole, content: string): TranscriptEntry => ({ role, content, at: now().toISOString() });

// ── Small helpers ────────────────────────────────────────────────────────────

/** ?src= → Lead.platform. gbp / lsa are Google; unrecognised-but-present is "other"; absent is null. */
export function platformFromSrc(src: string | null | undefined): string | null {
  const v = typeof src === "string" ? src.trim().toLowerCase() : "";
  if (!v) return null;
  if (v === "gbp" || v === "lsa") return "google";
  return normalizeLeadPlatform(v) ?? "other";
}

export function hashVisitorIp(ip: string): string {
  return crypto.createHash("sha256").update(ip).digest("hex");
}

/** Turns for one chat run one at a time — two quick taps must not interleave their transcript writes. */
const chatLocks = new Map<string, Promise<unknown>>();
async function withChatLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chatLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  chatLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (chatLocks.get(key) === run) chatLocks.delete(key);
  }
}

type ChatRow = NonNullable<Awaited<ReturnType<typeof loadChat>>>;

async function loadChat(token: string) {
  if (!token || token.length > 200) return null;
  return prisma.bookingChat.findUnique({ where: { token }, include: { lead: true } });
}

function isEnded(chat: { transcriptJson: string }): boolean {
  return parseJsonArray<TranscriptEntry>(chat.transcriptJson).some((e) => e.role === "event" && e.content === ENDED_MARKER);
}

/** confirmed/released are the office's (U3); ended is the conversation's own end marker. */
function isClosed(chat: { status: string; transcriptJson: string }): boolean {
  return chat.status === "confirmed" || chat.status === "released" || isEnded(chat);
}

function viewOf(chat: { status: string; leadId: string | null; heldStart: Date | null; heldEnd: Date | null; transcriptJson: string }): ChatView {
  const ended = isClosed(chat);
  const heldSlot = chat.status === "held" && chat.heldStart && chat.heldEnd
    ? { start: chat.heldStart.toISOString(), end: chat.heldEnd.toISOString(), label: describeBlock(chat.heldStart, chat.heldEnd).label }
    : null;
  return { status: chat.status, heldSlot, acceptsPhotos: chat.leadId !== null && !ended, ended };
}

async function appendTranscript(chatId: string, entries: TranscriptEntry[], extra: Record<string, unknown> = {}): Promise<void> {
  const fresh = await prisma.bookingChat.findUnique({ where: { id: chatId }, select: { transcriptJson: true } });
  const all = [...parseJsonArray<TranscriptEntry>(fresh?.transcriptJson), ...entries];
  await prisma.bookingChat.update({
    where: { id: chatId },
    data: { transcriptJson: JSON.stringify(all), lastActivityAt: now(), ...extra },
  });
}

// ── Start ────────────────────────────────────────────────────────────────────

export type StartResult =
  | { ok: true; token: string; reply: string }
  | { ok: false; reply: string };

export async function startChat(input: { src?: string | null; visitorIp?: string | null }): Promise<StartResult> {
  const visitorIpHash = input.visitorIp ? hashVisitorIp(input.visitorIp) : null;

  if (visitorIpHash) {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const recent = await prisma.bookingChat.count({ where: { visitorIpHash, createdAt: { gte: since } } });
    if (recent >= MAX_CHATS_PER_IP_PER_DAY) {
      logSystemEvent("warn", "bookingChat", "Chat start refused: too many chats from one visitor in 24h", { visitorIpHash });
      return { ok: false, reply: START_LIMIT_REPLY };
    }
  } else {
    // The website is supposed to forward the visitor's IP; without it the per-visitor cap cannot work.
    logSystemEvent("warn", "bookingChat", "Chat started without an x-visitor-ip header — per-visitor chat cap not applied");
  }

  const src = input.src?.trim().slice(0, 100) || null;
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.bookingChat.create({
    data: {
      token,
      srcParam: src,
      platform: platformFromSrc(src),
      visitorIpHash,
      transcriptJson: JSON.stringify([entry("assistant", BOOKING_CHAT_GREETING)]),
    },
  });
  return { ok: true, token, reply: BOOKING_CHAT_GREETING };
}

// ── One message / one AI turn ────────────────────────────────────────────────

export type MessageOutcome = { found: false } | { found: true; result: MessageResult };

export async function handleMessage(
  token: string,
  text: string,
  smsConsent: boolean | undefined,
  device?: "phone" | "computer",
): Promise<MessageOutcome> {
  const chat = await loadChat(token);
  if (!chat) return { found: false };
  return { found: true, result: await withChatLock(chat.id, () => runMessage(chat.id, text, smsConsent, device)) };
}

async function runMessage(
  chatId: string,
  text: string,
  smsConsent: boolean | undefined,
  device?: "phone" | "computer",
): Promise<MessageResult> {
  // Re-read under the lock: the previous turn may just have changed it.
  const chat = await prisma.bookingChat.findUnique({ where: { id: chatId }, include: { lead: true } });
  if (!chat) return { reply: FALLBACK_REPLY, status: "open", heldSlot: null, acceptsPhotos: false, ended: false };

  if (isClosed(chat)) return { reply: CLOSED_REPLY, ...viewOf(chat), ended: true };
  if (text.length > MAX_TEXT_CHARS) return { reply: TOO_LONG_REPLY, ...viewOf(chat), limit: "message_length" };
  if (chat.messageCount >= MAX_MESSAGES_PER_CHAT) return { reply: CHAT_LIMIT_REPLY, ...viewOf(chat), ended: true, limit: "message_count" };
  if (chat.aiCallCount >= MAX_AI_CALLS_PER_CHAT) return { reply: CHAT_LIMIT_REPLY, ...viewOf(chat), ended: true, limit: "ai_calls" };

  // Consent is recorded only from a boolean the website sent with this message — never inferred.
  if (typeof smsConsent === "boolean" && chat.lead) {
    await prisma.lead.update({ where: { id: chat.lead.id }, data: { smsConsent } });
  }

  const ctx: ToolContext = { chatId, smsConsent, device, ended: false, summaries: [] };
  const history = parseJsonArray<TranscriptEntry>(chat.transcriptJson);
  const turn = await runModelTurn(chat, history, text, ctx);

  const entries: TranscriptEntry[] = [
    entry("user", text),
    ...ctx.summaries.map((s) => entry("tool", s.slice(0, 500))),
    entry("assistant", turn.reply),
  ];

  if (ctx.ended) {
    // The model only SIGNALS out-of-scope; a chat holding a slot is never downgraded by it.
    if (ctx.endOutcome === "out_of_scope") {
      await prisma.bookingChat.updateMany({ where: { id: chatId, status: { in: ["open", "unbooked"] } }, data: { status: "out_of_scope" } });
    }
    entries.push(entry("event", ENDED_MARKER));
  }

  await appendTranscript(chatId, entries, {
    messageCount: { increment: 1 },
    aiCallCount: { increment: turn.aiCalls },
  });

  if (ctx.ended) {
    try {
      await notifyKyleOnce(chatId);
    } catch (err) {
      logSystemEvent("error", "bookingChat", "notifyKyleOnce failed after end_conversation", {
        chatId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const fresh = await prisma.bookingChat.findUnique({ where: { id: chatId } });
  return { reply: turn.reply, ...viewOf(fresh ?? chat) };
}

async function workOrderState(chatId: string): Promise<WorkOrderState> {
  const chat = await prisma.bookingChat.findUnique({ where: { id: chatId }, include: { lead: true } });
  const lead = chat?.lead ?? null;
  const photos = lead
    ? await prisma.leadPhoto.findMany({ where: { leadId: lead.id }, select: { id: true, kind: true, room: true }, orderBy: { uploadedAt: "asc" } })
    : [];
  return {
    leadExists: lead !== null,
    hasRealName: !!lead && lead.name !== PLACEHOLDER_NAME,
    hasPhone: !!lead?.phone,
    hasEmail: !!lead?.email,
    hasAddress: !!lead?.address,
    priority: chat?.priority ?? false,
    heldSlot: chat?.status === "held" && chat.heldStart && chat.heldEnd ? describeBlock(chat.heldStart, chat.heldEnd).label : null,
    photos,
  };
}

interface ResponseItem {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type: string; text?: string }>;
}

function replyText(resp: { output_text?: string; output?: ResponseItem[] }): string {
  const direct = typeof resp.output_text === "string" ? resp.output_text : "";
  if (direct.trim()) return direct.trim();
  return (resp.output ?? [])
    .filter((i) => i.type === "message")
    .flatMap((i) => i.content ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();
}

async function runModelTurn(
  chat: ChatRow,
  history: TranscriptEntry[],
  userText: string,
  ctx: ToolContext,
): Promise<{ reply: string; aiCalls: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logSystemEvent("error", "bookingChat", "OPENAI_API_KEY is not set — website booking chat answered with the phone number", { chatId: chat.id });
    return { reply: FALLBACK_REPLY, aiCalls: 0 };
  }
  const model = process.env.BOOKING_CHAT_MODEL ?? "gpt-5.1";

  // Notes (photo uploads) ride as developer messages; tool summaries are not replayed — the
  // server state block carries what they recorded.
  const input: unknown[] = history
    .filter((e) => e.role === "user" || e.role === "assistant" || e.role === "note")
    .map((e) => ({ role: e.role === "note" ? "developer" : e.role, content: e.content }));
  input.push({ role: "user", content: userText });

  let aiCalls = 0;
  try {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey });

    for (let round = 0; round <= MAX_TOOL_ROUNDS_PER_TURN; round++) {
      if (chat.aiCallCount + aiCalls >= MAX_AI_CALLS_PER_CHAT) {
        return { reply: CHAT_LIMIT_REPLY, aiCalls };
      }
      const instructions = buildInstructions(now(), { ...(await workOrderState(chat.id)), device: ctx.device });
      const resp = (await openai.responses.create({
        model,
        instructions,
        input,
        tools: BOOKING_CHAT_TOOLS,
        // The last round forbids tools, so a model that keeps calling them still has to answer.
        tool_choice: round === MAX_TOOL_ROUNDS_PER_TURN ? "none" : "auto",
        stream: false,
        max_output_tokens: 2000,
      } as Parameters<typeof openai.responses.create>[0])) as unknown as { output_text?: string; output?: ResponseItem[] };
      aiCalls += 1;

      const calls = (resp.output ?? []).filter((i) => i.type === "function_call");
      if (calls.length === 0) {
        const reply = replyText(resp);
        return { reply: reply || FALLBACK_REPLY, aiCalls };
      }

      input.push(...(resp.output ?? []));
      for (const call of calls) {
        const run = await runTool(call.name ?? "", call.arguments ?? "", ctx);
        ctx.summaries.push(run.summary);
        input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(run.output) });
      }
    }
    return { reply: FALLBACK_REPLY, aiCalls };
  } catch (err) {
    logSystemEvent("error", "bookingChat", "OpenAI call failed — chat answered with the phone number", {
      chatId: chat.id, error: err instanceof Error ? err.message : String(err),
    });
    return { reply: FALLBACK_REPLY, aiCalls };
  }
}

// ── Photos ───────────────────────────────────────────────────────────────────

const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;
export function isAcceptedImageType(mime: string): boolean {
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(mime);
}

/** Do the first bytes look like the image type the upload claims? A label alone is not trusted. */
export function bytesMatchImageType(buf: Buffer, mime: string): boolean {
  if (buf.length < 12) return false;
  switch (mime) {
    case "image/jpeg": return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "image/png": return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/webp": return buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP";
    case "image/heic":
    case "image/heif": return buf.subarray(4, 8).toString("ascii") === "ftyp";
    default: return false;
  }
}

export type PhotoOutcome =
  | { found: false }
  | { found: true; status: 201; body: { photoId: string } }
  | { found: true; status: 409 | 429; body: { error: string; reply: string } };

export async function handlePhoto(
  token: string,
  photo: { bytes: Buffer; mimeType: string; kind: "concern" | "panel"; room: string | null; caption: string | null },
): Promise<PhotoOutcome> {
  const found = await loadChat(token);
  if (!found) return { found: false };

  return withChatLock(found.id, async (): Promise<PhotoOutcome> => {
    const chat = await prisma.bookingChat.findUnique({ where: { id: found.id }, include: { lead: true } });
    if (!chat) return { found: false };

    if (isClosed(chat)) {
      return { found: true, status: 409, body: { error: "chat_closed", reply: CLOSED_REPLY } };
    }
    if (!chat.leadId) {
      return {
        found: true,
        status: 409,
        body: { error: "phone_first", reply: "Please share your phone number first, then I can take photos for your request." },
      };
    }
    const count = await prisma.leadPhoto.count({ where: { leadId: chat.leadId } });
    if (count >= MAX_PHOTOS_PER_CHAT) {
      return { found: true, status: 429, body: { error: "photo_limit", reply: PHOTO_LIMIT_REPLY } };
    }

    const row = await prisma.leadPhoto.create({
      data: {
        leadId: chat.leadId,
        kind: photo.kind,
        room: photo.room,
        caption: photo.caption,
        mimeType: photo.mimeType,
        sizeBytes: photo.bytes.length,
        data: photo.bytes,
      },
      select: { id: true },
    });

    // The model learns a photo exists — and its id — from this note only. It never sees the image.
    await appendTranscript(chat.id, [
      entry("note", `[photo uploaded: id=${row.id}, kind=${photo.kind}${photo.room ? `, room=${photo.room}` : ""}]`),
    ]);
    return { found: true, status: 201, body: { photoId: row.id } };
  });
}
