/**
 * The tools the website booking chat's model may call, and the server code that runs them.
 *
 * THE MODEL IS UNTRUSTED INPUT. Every argument is validated with zod (unknown keys are stripped,
 * so a model that sends `status` or `appointment` changes nothing), and the server — not the model
 * — owns: the chat's status, the appointment, the lead source, which photos belong to this lead,
 * and which slots are legal. This bot has NO estimate or line-item tools (it is not Savannah, and
 * it is not part of the estimating system).
 */

import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { parseJsonArray, parseJsonStringArray } from "../../lib/json";
import { logSystemEvent } from "../systemEvents";
import { BookingInputError } from "../googleCalendar";
import { FIXED_BLOCK_STARTS } from "./limits";
import { checkServiceArea, gateRecordedAddress } from "./serviceArea";
import { holdSlotForChat, listOfferableSlots, PLACEHOLDER_NAME } from "./scheduling";
import { notifyKyleHeldUpdate } from "./notifyKyle";

/** Mutable per-turn context handed to every tool run. */
export interface ToolContext {
  chatId: string;
  /** The latest message's smsConsent — only ever a boolean the website sent, never inferred. */
  smsConsent: boolean | undefined;
  /** Set by end_conversation; the turn writes the end marker and emails Kyle after the loop. */
  ended: boolean;
  /** What end_conversation said the outcome was (a signal, not a command). */
  endOutcome?: string;
  /** One short line per tool run, appended to the transcript. */
  summaries: string[];
}

// ── Argument schemas ─────────────────────────────────────────────────────────

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * Name, address and phone are copied onto records that appear in HTML emails (the customer's
 * confirmation, Kyle's "Job Scheduled") and onto the calendar. Those emails now escape what they
 * interpolate (security review U5, M1), and this is the second layer: text that is trying to be
 * markup is refused at the door, so the model asks again instead of saving it.
 */
const noMarkup = (max: number) =>
  text(max).refine((v) => !/[<>]/.test(v), { message: "must not contain < or >" });

/** Digits and the punctuation a phone number is written with — nothing else. */
const phoneText = z.string().trim().min(1).max(40)
  .regex(/^[0-9 ()+.\-]+$/, "phone may contain only digits, spaces and ( ) + - .");

const concernSchema = z.object({
  room: text(100),
  description: text(1000),
  photo_id: z.string().trim().max(64).optional(),
});

/** `status`, `appointment` and `lead_source` are deliberately absent: the server owns them. */
export const updateWorkOrderSchema = z.object({
  priority: z.boolean().optional(),
  priority_quote: text(1000).optional(),
  original_request: text(2000).optional(),
  name: noMarkup(200).optional(),
  phone: phoneText.optional(),
  email: z.string().trim().max(200).optional(),
  address: noMarkup(300).optional(),
  concerns: z.array(concernSchema).max(20).optional(),
  square_footage: text(100).optional(),
  year_built: text(100).optional(),
  questions_for_kyle: z.array(text(1000)).max(10).optional(),
  prep_areas: z.array(text(300)).max(20).optional(),
});

export const checkServiceAreaSchema = z.object({
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "zip must be a 5-digit ZIP code"),
});

export const getAvailableSlotsSchema = z.object({
  from_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().int().min(1).max(24).optional(),
});

export const bookAppointmentSchema = z.object({
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  startTime: z.enum(FIXED_BLOCK_STARTS),
});

export const endConversationSchema = z.object({
  outcome: z.enum(["completed", "out_of_scope", "customer_declined"]).optional(),
});

// ── Tool definitions (OpenAI Responses API function tools) ───────────────────

export const BOOKING_CHAT_TOOLS = [
  {
    type: "function" as const,
    name: "update_work_order",
    description:
      "Record what the customer told you, exactly as they said it. Call after each answer. Send only fields that are new this turn. The lead is saved the moment a phone number is recorded. You cannot set status, appointment or lead source.",
    strict: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        priority: { type: "boolean", description: "true if the customer described a priority condition from the prompt." },
        priority_quote: { type: "string", description: "The customer's exact words about the priority condition." },
        original_request: { type: "string", description: "The customer's description of the problem, as written." },
        name: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        address: { type: "string", description: "Full service address including the ZIP code." },
        concerns: {
          type: "array",
          description: "NEW concerns only: room, the customer's description, and optionally the photo_id the server gave you.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              room: { type: "string" },
              description: { type: "string" },
              photo_id: { type: "string" },
            },
            required: ["room", "description"],
          },
        },
        square_footage: { type: "string", description: "Customer-provided, as written." },
        year_built: { type: "string", description: "Customer-provided, as written." },
        questions_for_kyle: { type: "array", items: { type: "string" }, description: "NEW questions or handoffs only." },
        prep_areas: { type: "array", items: { type: "string" }, description: "The full list of work areas shown in the prep reminder." },
      },
    },
  },
  {
    type: "function" as const,
    name: "check_service_area",
    description: "Check a ZIP code against Red Cedar's service area. Call before moving past the address step.",
    strict: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { zip: { type: "string", description: "5-digit ZIP code." } },
      required: ["zip"],
    },
  },
  {
    type: "function" as const,
    name: "get_available_slots",
    description: "List open 2-hour appointment blocks (Central Time), earliest first. Offer 2-3 of them.",
    strict: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        from_date: { type: "string", description: "Optional YYYY-MM-DD to look at later dates." },
        limit: { type: "integer", description: "How many blocks to return (default 12)." },
      },
    },
  },
  {
    type: "function" as const,
    name: "book_appointment",
    description:
      "Hold one of the open blocks for the customer. Use the date and startTime exactly as returned by get_available_slots. Requires name, phone and address to be recorded. Returns held:true only if the hold really exists.",
    strict: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        startTime: { type: "string", enum: [...FIXED_BLOCK_STARTS] },
      },
      required: ["date", "startTime"],
    },
  },
  {
    type: "function" as const,
    name: "end_conversation",
    description: "Call once the conversation is finished: after the closing line, or when the customer is done or declines to continue.",
    strict: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        outcome: { type: "string", enum: ["completed", "out_of_scope", "customer_declined"] },
      },
    },
  },
];

// ── Executors ────────────────────────────────────────────────────────────────

export interface ToolRun {
  /** Returned to the model as the function_call_output. */
  output: Record<string, unknown>;
  /** One line for the transcript. */
  summary: string;
}

function bad(message: string, summary: string): ToolRun {
  return { output: { ok: false, error: message }, summary };
}

interface StoredConcern {
  room: string;
  description: string;
  photoId?: string;
}

function digitsOf(s: string): number {
  return s.replace(/\D/g, "").length;
}

export async function runTool(name: string, rawArguments: string, ctx: ToolContext): Promise<ToolRun> {
  let args: unknown;
  try {
    args = rawArguments ? JSON.parse(rawArguments) : {};
  } catch {
    return bad("Arguments were not valid JSON.", `${name}: rejected (bad JSON)`);
  }

  try {
    switch (name) {
      case "update_work_order": return await updateWorkOrder(args, ctx);
      case "check_service_area": return await checkArea(args, ctx);
      case "get_available_slots": return await getSlots(args, ctx);
      case "book_appointment": return await bookSlot(args, ctx);
      case "end_conversation": return endConversation(args, ctx);
      default: return bad(`Unknown tool "${name}".`, `unknown tool ${name}`);
    }
  } catch (err) {
    logSystemEvent("error", "bookingChat", `Tool ${name} threw`, {
      chatId: ctx.chatId, error: err instanceof Error ? err.message : String(err),
    });
    return bad("That tool failed. Do not mention the error; continue the conversation or give the office phone number.", `${name}: failed`);
  }
}

async function updateWorkOrder(rawArgs: unknown, ctx: ToolContext): Promise<ToolRun> {
  const parsed = updateWorkOrderSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return bad(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, "update_work_order: rejected");
  }
  const a = parsed.data;
  const ignored: string[] = [];

  const chat = await prisma.bookingChat.findUnique({ where: { id: ctx.chatId }, include: { lead: true } });
  if (!chat) return bad("Chat not found.", "update_work_order: no chat");
  let lead = chat.lead;

  // ── Validate contact fields; keep what is usable, tell the model what was not.
  let phone: string | undefined;
  if (a.phone !== undefined) {
    if (digitsOf(a.phone) >= 7) phone = a.phone;
    else ignored.push("phone looked incomplete and was not saved — ask for the full number");
  }
  let email: string | undefined;
  if (a.email !== undefined && a.email !== "") {
    if (z.string().email().safeParse(a.email).success) email = a.email;
    else ignored.push("email looked invalid and was not saved — ask once more");
  }

  // ── Fields that live on the BookingChat.
  const concernsIn: StoredConcern[] = [];
  if (a.concerns) {
    for (const c of a.concerns) {
      let photoId: string | undefined;
      if (c.photo_id) {
        // Photo ownership is the SERVER's call: only a photo uploaded to THIS lead may be referenced.
        const owned = lead
          ? await prisma.leadPhoto.findFirst({ where: { id: c.photo_id, leadId: lead.id }, select: { id: true } })
          : null;
        if (owned) photoId = owned.id;
        else ignored.push(`photo_id ${c.photo_id} is not a photo from this conversation and was dropped`);
      }
      concernsIn.push({ room: c.room, description: c.description, ...(photoId ? { photoId } : {}) });
    }
  }
  const existingConcerns = parseJsonArray<StoredConcern>(chat.concernsJson);
  for (const c of concernsIn) {
    const dup = existingConcerns.find((e) => e.room === c.room && e.description === c.description);
    if (!dup) existingConcerns.push(c);
    else if (!dup.photoId && c.photoId) dup.photoId = c.photoId;
  }
  const concerns = existingConcerns.slice(0, 60);

  const questions = parseJsonStringArray(chat.questionsJson);
  for (const q of a.questions_for_kyle ?? []) if (!questions.includes(q)) questions.push(q);

  const priority = chat.priority || a.priority === true;
  const priorityQuote = a.priority_quote ?? chat.priorityQuote;
  const originalRequest = a.original_request ?? chat.originalRequest;

  const chatData = {
    priority,
    priorityQuote,
    originalRequest,
    squareFootage: a.square_footage ?? chat.squareFootage,
    yearBuilt: a.year_built ?? chat.yearBuilt,
    concernsJson: JSON.stringify(concerns),
    questionsJson: JSON.stringify(questions.slice(0, 30)),
    prepAreasJson: a.prep_areas ? JSON.stringify(a.prep_areas) : chat.prepAreasJson,
  };

  // The Leads page shows Lead.notes under the row: the priority words first, then the request.
  const notes = [priority && priorityQuote ? `PRIORITY — "${priorityQuote}"` : null, originalRequest]
    .filter(Boolean).join("\n\n") || null;

  // ── The Lead: created the first time a phone number is on file, updated after that.
  let leadCreated = false;
  if (!lead) {
    if (phone) {
      const created = await prisma.$transaction(async (tx) => {
        const l = await tx.lead.create({
          data: {
            name: a.name ?? PLACEHOLDER_NAME,
            phone,
            email: email ?? null,
            address: a.address ?? null,
            source: "web",
            platform: chat.platform,
            notes,
            urgentFlag: priority,
            // Only a boolean the website sent is recorded; never inferred.
            smsConsent: typeof ctx.smsConsent === "boolean" ? ctx.smsConsent : null,
          },
        });
        await tx.bookingChat.update({
          where: { id: chat.id },
          data: { ...chatData, leadId: l.id, status: chat.status === "open" ? "unbooked" : chat.status },
        });
        return l;
      });
      lead = created;
      leadCreated = true;
    } else {
      await prisma.bookingChat.update({ where: { id: chat.id }, data: chatData });
    }
  } else {
    await prisma.$transaction([
      prisma.lead.update({
        where: { id: lead.id },
        data: {
          ...(a.name ? { name: a.name } : {}),
          ...(phone ? { phone } : {}),
          ...(email ? { email } : {}),
          ...(a.address ? { address: a.address } : {}),
          ...(priority ? { urgentFlag: true } : {}),
          notes,
        },
      }),
      prisma.bookingChat.update({
        where: { id: chat.id },
        data: { ...chatData, status: chat.status === "open" ? "unbooked" : chat.status },
      }),
    ]);
  }

  return {
    output: {
      ok: true,
      lead_saved: lead !== null,
      ...(leadCreated ? { note: "lead created" } : {}),
      ...(lead && lead.name === PLACEHOLDER_NAME && !a.name ? { still_needed: ["name"] } : {}),
      ...(ignored.length ? { ignored } : {}),
    },
    summary: `update_work_order: ${leadCreated ? "lead created; " : ""}saved ${Object.keys(a).join(", ") || "nothing"}${ignored.length ? ` (${ignored.length} ignored)` : ""}`,
  };
}

async function checkArea(rawArgs: unknown, ctx: ToolContext): Promise<ToolRun> {
  const parsed = checkServiceAreaSchema.safeParse(rawArgs);
  if (!parsed.success) return bad("zip must be a 5-digit ZIP code. Ask the customer for it.", "check_service_area: rejected");

  const result = await checkServiceArea(parsed.data.zip);
  const chat = await prisma.bookingChat.findUnique({ where: { id: ctx.chatId }, select: { status: true, leadId: true } });
  if (chat) {
    // A held or confirmed chat keeps its status; an out-of-area answer only affects a chat with no hold.
    if (!result.inArea && (chat.status === "open" || chat.status === "unbooked")) {
      await prisma.bookingChat.update({ where: { id: ctx.chatId }, data: { status: "out_of_scope" } });
    } else if (result.inArea && chat.status === "out_of_scope") {
      await prisma.bookingChat.update({ where: { id: ctx.chatId }, data: { status: chat.leadId ? "unbooked" : "open" } });
    }
  }

  return {
    output: {
      in_area: result.inArea,
      ...(result.area ? { area: result.area } : {}),
      ...(result.listConfigured ? {} : { note: "The service area list is not set up yet, so every ZIP is accepted for now." }),
      ...(result.inArea ? { reminder: "Make sure the address recorded with update_work_order includes this ZIP." } : {}),
    },
    summary: `check_service_area: ${result.zip} → ${result.inArea ? "in area" : "OUT of area"}${result.listConfigured ? "" : " (list empty)"}`,
  };
}

async function getSlots(rawArgs: unknown, ctx: ToolContext): Promise<ToolRun> {
  const parsed = getAvailableSlotsSchema.safeParse(rawArgs);
  if (!parsed.success) return bad("from_date must be YYYY-MM-DD; limit 1-24.", "get_available_slots: rejected");

  // No times until the recorded address has an in-area ZIP — the same gate the hold uses.
  const chat = await prisma.bookingChat.findUnique({ where: { id: ctx.chatId }, select: { lead: { select: { address: true } } } });
  const gate = await gateRecordedAddress(chat?.lead?.address);
  if (!gate.ok) return bad(gate.message, `get_available_slots: refused (${gate.code})`);

  try {
    const { slots } = await listOfferableSlots({ fromDate: parsed.data.from_date, limit: parsed.data.limit });
    return {
      output: { slots, note: "Offer 2-3. Use date and startTime exactly as shown when booking." },
      summary: `get_available_slots: ${slots.length} blocks`,
    };
  } catch (err) {
    if (err instanceof BookingInputError) return bad(err.message, "get_available_slots: bad date");
    throw err;
  }
}

async function bookSlot(rawArgs: unknown, ctx: ToolContext): Promise<ToolRun> {
  const parsed = bookAppointmentSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return bad(`date must be YYYY-MM-DD and startTime one of ${FIXED_BLOCK_STARTS.join(", ")}.`, "book_appointment: rejected");
  }
  const result = await holdSlotForChat(ctx.chatId, parsed.data);
  if (!result.ok) {
    return { output: { held: false, code: result.code, message: result.message }, summary: `book_appointment: NOT held (${result.code})` };
  }
  // Kyle may already have been told "UNBOOKED — call back" (idle sweep). A new hold must reach him.
  // No-op unless he was emailed already; never throws.
  if (!result.alreadyHeld) await notifyKyleHeldUpdate(ctx.chatId);
  return {
    output: { held: true, day: result.day, window: result.window, label: result.label, already_held: result.alreadyHeld },
    summary: `book_appointment: held ${result.label}`,
  };
}

function endConversation(rawArgs: unknown, ctx: ToolContext): ToolRun {
  const parsed = endConversationSchema.safeParse(rawArgs);
  ctx.ended = true;
  // The model may only SIGNAL out-of-scope; the turn applies it if no slot is held.
  ctx.endOutcome = parsed.success ? parsed.data.outcome : undefined;
  const outcome = ctx.endOutcome;
  return { output: { ok: true }, summary: `end_conversation${outcome ? `: ${outcome}` : ""}` };
}
