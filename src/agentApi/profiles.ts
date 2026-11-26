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
  /** W2: when status is pending_approval, why it is waiting, in plain words; null when it posted. Without this line zod would strip it. */
  pending_reason: z.string().max(400).nullable().optional(),
  /** Kyle 2026-11-24 (no check-ins): a customer message that did NOT go out (blocked by a guard, failed, or kept as a draft): why, in plain words. Null when sent. */
  not_sent_reason: z.string().max(400).nullable().optional(),
});
export type HubDraftResult = z.infer<typeof hubDraftResultSchema>;

// ── reports:read and finance:read (W2-B, R-f): the Research and CFO read tools ────────────────────

/**
 * The ONE field profile for the Research (reports:read) and CFO (finance:read) read tools, de-identified (Kyle, 2026-11-23): record ids,
 * status and enum fields, dates, money amounts, job and invoice numbers and at most a customer's FIRST name. The names a field can hold are
 * these and no others; zod stripping is the allowlist, so a column added to a query later cannot reach an agent until it is named here.
 * NEVER named here: phone, email, street, last name, tokens or pay links, free text (notes, purpose, titles, scopes of work, call outcomes,
 * transcripts), pay rates, commission or payroll, card or bank details.
 */
const day = z.string().max(40).nullable();
export const reportJobSchema = z.object({
  id: z.string(), status: z.string().max(40), mode: z.string().max(60),
  visit_date: z.string().max(40), scheduled_start: day, scheduled_end: day, completed_at: day, contracted_at: day,
  customer_id: z.string(), customer_first_name: z.string().max(60).nullable(), invoice_number: z.string().max(40).nullable(),
  contracted_revenue: z.number().nullable(), labor_hours: z.number().nullable(),
});
export const reportJobListSchema = z.object({ items: z.array(reportJobSchema), truncated: z.boolean() });

export const reportInvoiceSchema = z.object({
  id: z.string(), number: z.string().max(40), revision: z.number().int(), status: z.string().max(30),
  payment_status: z.enum(["paid", "deposit_paid", "partial", "unpaid"]),
  customer_id: z.string(), customer_first_name: z.string().max(60).nullable(), job_id: z.string().nullable(), signed_at: day,
  billed_total: z.number(), deposit_due: z.number(), deposit_required: z.boolean(), financing_fee: z.number(),
  total_paid: z.number(), balance: z.number(), last_paid_at: day,
  change_orders: z.array(z.object({ number: z.string().max(40), billed_total: z.number(), signed_at: day })),
});
export const reportInvoiceListSchema = z.object({ items: z.array(reportInvoiceSchema), truncated: z.boolean() });

export const reportVisitSchema = z.object({
  id: z.string(), status: z.string().max(40), mode: z.string().max(60),
  scheduled_start: day, scheduled_end: day, customer_id: z.string(), customer_first_name: z.string().max(60).nullable(),
  technician_first_names: z.array(z.string().max(60)),
});
export const reportVisitListSchema = z.object({ items: z.array(reportVisitSchema), truncated: z.boolean() });

export const reportPaymentSchema = z.object({
  id: z.string(), invoice_id: z.string().nullable(), job_id: z.string().nullable(), amount: z.number(), refunded_amount: z.number(),
  method: z.string().max(30), kind: z.string().max(30), status: z.string().max(30), payer: z.string().max(30),
  received_at: day, voided: z.boolean(),
});
export const reportPaymentListSchema = z.object({ items: z.array(reportPaymentSchema), truncated: z.boolean() });

export const reportLeadSourcesSchema = z.object({
  from: z.string().max(12).nullable(), to: z.string().max(12).nullable(), total: z.number().int(),
  by_source: z.array(z.object({ source: z.string().max(60), count: z.number().int() })),
  by_platform: z.array(z.object({ platform: z.string().max(60), count: z.number().int() })),
});

// ── the price book (Kyle 2026-11-24: pricebook:read / pricebook:write) ────────────────────────────

/**
 * An item as an agent reads it: the one shape for a search row, one item and a created item. Costs are PRE-TAX (the shelf price); `sell` is what the
 * customer is charged per difficulty. `hours` are per-unit; a tier that is null is blank (the estimate engine will not price that difficulty).
 * `cost_with_tax` is cost with the sales tax in it (null when the item has no cost, the book has not been repriced for sales tax yet, or the price was set by hand). No customer data lives in the price book, so these answers withhold nothing.
 */
const priceBookTiers = z.object({ normal: z.number().nullable(), difficult: z.number().nullable(), very_difficult: z.number().nullable() });
export const priceBookItemSchema = z.object({
  item_id: z.string().max(64),
  name: z.string().nullable(),
  category: z.string().nullable(),
  sub_category: z.string().nullable(),
  type: z.enum(["labor", "material", "assembly"]),
  row_type: z.string().nullable(),
  unit: z.string().nullable(),
  hours: priceBookTiers,
  cost: z.number().nullable(),
  cost_with_tax: z.number().nullable().optional(),
  sell: priceBookTiers,
  labour_source: z.string().nullable(),
  notes: z.string().nullable(),
  retired: z.boolean(),
  components: z.array(z.object({ item_id: z.string().max(64), name: z.string().nullable(), quantity: z.number() })).optional(),
});
export type PriceBookItemRead = z.infer<typeof priceBookItemSchema>;
export const priceBookItemListSchema = z.object({
  items: z.array(priceBookItemSchema), count: z.number().int(), total: z.number().int(), truncated: z.boolean(),
});
export const priceBookCategoriesSchema = z.object({
  categories: z.array(z.object({
    name: z.string(), count: z.number().int(),
    sub_categories: z.array(z.object({ name: z.string().nullable(), count: z.number().int() })),
  })),
});
/** What a proposal answers: the card waiting for approval. */
export const priceBookProposalSchema = z.object({
  proposal_id: z.string(), item_id: z.string().max(64), status: z.string().max(30), waiting_for: z.string().max(200),
  changes: z.array(z.object({ field: z.string().max(30), before: z.union([z.string(), z.number()]).nullable(), after: z.union([z.string(), z.number()]).nullable() })),
});
