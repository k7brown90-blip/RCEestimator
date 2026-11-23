/**
 * Output profiles an agent can be answered with (work order agent-team, K-U4). Each is a zod object
 * schema, and zod stripping IS the allowlist: a field not named here never reaches an agent. None of
 * them may use passthrough, looseObject, record, any or unknown (tests/agentRespond.test.ts scans
 * this folder for them).
 *
 * Only the SHAPES are defined here, plus the projections that need no hub tables. The tools that
 * return them arrive with the tool registry (K-U5, Step 2) and the hub (Step 1c), which add their own
 * schemas beside these.
 */
import { z } from "zod";
import { authorFirstName, scrubMessageText, scrubTrainingText, toChicagoIso, type LinkedContacts } from "./respond";

// ── message read: ONE profile for every key (team answer 4) ───────────────────────────────────────

/**
 * What any key gets of a hub message. No toAddress, no cc, no thread phone, no contact details in
 * the text; the author is a first name or null (never a full name, and null for a profile that
 * allows no names, such as Inventory's). Times are Chicago ISO. The hub's own fields (U1) extend
 * this shape; they do not widen the text rules.
 */
export const messageReadSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  authorType: z.string().max(40),
  authorFirstName: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
});
export type MessageRead = z.infer<typeof messageReadSchema>;

export interface RawMessage {
  id: string;
  threadId: string;
  authorType: string;
  authorDisplay: string | null;
  subject: string | null;
  body: string;
  createdAt: Date;
}

/** A raw hub message to its every-key read shape. `allowNames` is the profile's own ceiling. */
export function projectMessageRead(raw: RawMessage, linked: LinkedContacts | undefined, allowNames: boolean): MessageRead {
  return messageReadSchema.parse({
    id: raw.id,
    threadId: raw.threadId,
    authorType: raw.authorType,
    authorFirstName: authorFirstName(raw.authorDisplay, allowNames),
    subject: raw.subject === null ? null : scrubMessageText(raw.subject, linked),
    body: scrubMessageText(raw.body, linked),
    createdAt: toChicagoIso(raw.createdAt),
  });
}

// ── scout-training: the Scout key's read of a training thread (team answer 16a) ───────────────────

/**
 * Message id, thread id, the apprentice's first name, author type, time and the message text, and
 * nothing else: no context refs, no record links, no attachments (a photo can show a house number).
 * The text is the every-key message pass PLUS the full names and addresses of customers on the
 * records linked from the thread or the apprentice's visits: never weaker than the every-key
 * profile (ruling R2).
 */
export const scoutTrainingMessageSchema = z.object({
  messageId: z.string(),
  threadId: z.string(),
  apprenticeFirstName: z.string().nullable(),
  authorType: z.string().max(40),
  createdAt: z.string(),
  text: z.string(),
});
export type ScoutTrainingMessage = z.infer<typeof scoutTrainingMessageSchema>;

export function projectScoutTrainingMessage(
  raw: { id: string; threadId: string; apprenticeName: string | null; authorType: string; body: string; createdAt: Date },
  linked: LinkedContacts & { names?: readonly string[] },
): ScoutTrainingMessage {
  return scoutTrainingMessageSchema.parse({
    messageId: raw.id,
    threadId: raw.threadId,
    apprenticeFirstName: authorFirstName(raw.apprenticeName, true),
    authorType: raw.authorType,
    createdAt: toChicagoIso(raw.createdAt),
    text: scrubTrainingText(raw.body, linked),
  });
}

// ── marketing-original: media:original:read (team answer 15a) ─────────────────────────────────────

/** A box in the served rendition's pixel space. */
export const pixelBoxSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});

export const MARKETING_COPY_STATES = ["none", "uploaded", "confirmed", "rejected"] as const;

/**
 * What the Facebook key learns about an ORIGINAL job photo it may edit: an opaque ref (never a
 * VisitPhoto id, visit id, caption, customer, address or GPS), the stage, job type, city, the month
 * (YYYY-MM, Chicago), whether a copy exists and where it stands, and the office-marked access-hole
 * boxes. The file itself is a stripped rendition delivered through the one file-grant door, never in
 * this answer. Defined now; the tools that return it arrive in Step 8.
 */
export const marketingOriginalSchema = z.object({
  photoRef: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  stage: z.enum(["before", "after"]),
  jobType: z.string().max(80),
  city: z.string().max(80),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  copyState: z.enum(MARKETING_COPY_STATES),
  accessHoles: z.array(pixelBoxSchema).max(50),
});
export type MarketingOriginal = z.infer<typeof marketingOriginalSchema>;

// ── hub reads and the draft answer (K-U7: REST /api/hub/*) ───────────────────────────────────────

/**
 * What an agent gets of a hub message on REST GET /api/hub/threads/:id/messages: the every-key message read
 * (`messageReadSchema`, team answer 4) plus the hub's own fields. NEVER toAddress, cc, a thread's
 * phone, the masked recipient, the send error or a record's contact details: those keys are not here,
 * so zod strips them, and the text is the three-pass scrubbed text.
 */
export const hubMessageReadSchema = messageReadSchema.extend({
  channel: z.string().max(20),
  direction: z.string().max(20),
  status: z.string().max(30),
  messageClass: z.string().max(20).nullable(),
  editedAt: z.string().nullable(),
});
export type HubMessageRead = z.infer<typeof hubMessageReadSchema>;

export const hubThreadLastLineSchema = z.object({
  authorType: z.string().max(40),
  authorFirstName: z.string().nullable(),
  status: z.string().max(30),
  text: z.string(),
  at: z.string(),
});

/**
 * One thread as an agent sees it: ids, never a phone number. The title of a customer, lead or job thread is the
 * contact's FIRST name only (null when the key's profile allows no names), "Unknown sender" for a number nobody
 * knows; any other kind keeps its scrubbed title.
 */
export const hubThreadReadSchema = z.object({
  id: z.string(),
  kind: z.string().max(20),
  title: z.string().nullable(),
  status: z.string().max(20),
  lastMessageAt: z.string(),
  /** Messages in this thread waiting for someone to approve them. */
  pending: z.number().int(),
  customerId: z.string().nullable(),
  leadId: z.string().nullable(),
  visitId: z.string().nullable(),
  technicianId: z.string().nullable(),
  lastLine: hubThreadLastLineSchema.nullable(),
});
export type HubThreadRead = z.infer<typeof hubThreadReadSchema>;

export const hubThreadListSchema = z.object({ threads: z.array(hubThreadReadSchema) });
export const hubThreadDetailSchema = z.object({
  thread: hubThreadReadSchema,
  messages: z.array(hubMessageReadSchema),
  truncated: z.boolean(),
});

/**
 * A training thread as the Scout key sees it (amendment 16a): the thread row without the record links
 * (customerId, leadId, visitId) and the messages in the Scout training profile (`scoutTrainingMessageSchema`).
 */
export const scoutTrainingThreadReadSchema = hubThreadReadSchema.omit({ customerId: true, leadId: true, visitId: true });
export type ScoutTrainingThreadRead = z.infer<typeof scoutTrainingThreadReadSchema>;
export const scoutTrainingThreadListSchema = z.object({ threads: z.array(scoutTrainingThreadReadSchema) });
export const scoutTrainingThreadDetailSchema = z.object({
  thread: scoutTrainingThreadReadSchema,
  messages: z.array(scoutTrainingMessageSchema),
  truncated: z.boolean(),
});

/** The answer to a draft: ids and states only. The words the agent sent are not echoed back. */
export const hubDraftResultSchema = z.object({
  messageId: z.string(),
  threadId: z.string(),
  status: z.string().max(30),
  channel: z.string().max(20),
  category: z.string().max(60).nullable(),
  createdAt: z.string(),
});
export type HubDraftResult = z.infer<typeof hubDraftResultSchema>;
