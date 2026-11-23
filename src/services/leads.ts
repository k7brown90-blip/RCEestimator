/**
 * Lead writes, in ONE place (work order agent-team, TM0): the lead vocabularies, the address helpers,
 * and the three route bodies that were inline in app.ts - POST /crm/leads (createCrmLead),
 * PATCH /leads/:leadId (updateLead) and the conversion (convertLeadToOpportunity, which
 * PATCH /leads/:leadId/convert, PATCH /leads/:id/won and POST /leads/:leadId/confirm-booking all call).
 * The routes are thin doors now: they parse the request, call these, and send the answer. No behaviour
 * changed. The actor is a parameter ('human:crm-session' today; 'agent:<key>' for the agent tools); no
 * lead column records it, so none of these reads it yet.
 *
 * `lead.created` is emitted by the two ROUTES that make a live lead (POST /leads and POST /crm/leads),
 * never in here, so a lead an agent drafts never fires it (team answer 5).
 */
import { z } from "zod";
import type { Lead, PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { LEAD_SOURCES } from "../../shared/leadSources";
import { LEAD_PLATFORMS } from "../../shared/leadPlatform";
import { LOST_REASONS as SHARED_LOST_REASONS } from "../../shared/estimateStatus";
import { parseReceivedAt, parseSourceUrl, toFollowUpInstant } from "../../shared/calendarDay";
import { reconcileLeadState, WON_OUTCOME_ERROR } from "./leadState";
import { findCustomerMatches } from "./customerMatch";
import { announceThreadMoved, mergeLeadThread } from "./hub";
import { moveBallparkToVisit } from "./leadBallpark";
import { KNOWN_JURISDICTION_IDS } from "./jurisdictionResolver";
import { releaseHoldIfHeld } from "./bookingChat/officeActions";
import { logSystemEvent } from "./systemEvents";
import { HUMAN_CRM_SESSION, type DoorActor } from "./doorActor";
import { ACCOUNT_NOTE_BODY_MAX, createAccountNote } from "./customerNotes";

/** A refusal: the status the route sends and the sentence in the body. */
const fail = <S extends 400 | 404>(status: S, error: string) => ({ ok: false as const, status, error });

// ─── Lead vocabularies ──────────────────────────────────────────────────────
// Shared by every lead write path. `PATCH /leads/:id/lost` (line 829) validated
// lostReason against an enum while `PATCH /leads/:leadId` stored anything, so one
// typo from any caller permanently skewed GET /leads/loss-report. One definition
// each, used everywhere, so they cannot drift again.

export const LEAD_STATUSES = ["new", "contacted", "converted", "lost"] as const;
export const LEAD_PIPELINE_STATUSES = [
  "new", "booked", "unresolved", "planning", "no_answer", "lost", "won",
] as const;
// ONE list for leads AND estimates (Kyle, 2026-09-20) — defined in shared/estimateStatus.ts.
export const LOST_REASONS = SHARED_LOST_REASONS;
export const FOLLOW_UP_REASONS = [
  "comparing_estimates", "still_planning", "consulting_partner", "no_answer",
] as const;
export const CONTACT_PREFERENCES = ["phone", "email", "either"] as const;
export const CALL_TYPES = [
  "new_job", "warranty", "reschedule", "cancellation", "estimate_followup", "callback",
  "vendor", "referral", "invoice", "dispute", "wrong_number", "solicitation", "other",
] as const;
/** The one list lives in shared/leadSources.ts (the signed agent events read it too); re-exported so callers here are unchanged. */
export { LEAD_SOURCES };

/**
 * A lead's address, resolved once into something that cannot be half-formed.
 *
 * The old convert path kept four mutable strings and a regex that silently left
 * three of them empty. Making the empty case its own variant means a Property can
 * never be created from a partial address — the type won't let you.
 */
type LeadAddress =
  | { kind: "structured" | "parsed"; parts: { addressLine1: string; addressLine2: string | null; city: string; state: string; postalCode: string } }
  | { kind: "none" };

/** Exactly `line1, city, ST 12345`. Webhook and voice-agent leads only. */
const FREE_TEXT_ADDRESS = /^(.+?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i;

function resolveLeadAddress(lead: {
  address: string | null; addressLine1: string | null; addressLine2: string | null;
  city: string | null; state: string | null; postalCode: string | null;
}): LeadAddress {
  // Structured wins outright when present — it was typed by a person into
  // labelled fields, which beats anything a regex can infer.
  const line1 = lead.addressLine1?.trim();
  const city = lead.city?.trim();
  const state = lead.state?.trim();
  const zip = lead.postalCode?.trim();
  if (line1 && city && state && zip) {
    return {
      kind: "structured",
      parts: {
        addressLine1: line1, addressLine2: lead.addressLine2?.trim() || null,
        city, state: state.toUpperCase(), postalCode: zip,
      },
    };
  }

  const match = lead.address?.trim().match(FREE_TEXT_ADDRESS);
  if (match) {
    return {
      kind: "parsed",
      parts: {
        addressLine1: match[1].trim(), addressLine2: null, city: match[2].trim(),
        state: match[3].trim().toUpperCase(), postalCode: match[4].trim(),
      },
    };
  }

  // Present but unparseable counts as none. Writing "somewhere off Rutherford
  // Blvd" into addressLine1 with a blank city is worse than refusing.
  return { kind: "none" };
}

/** jobType → Visit mode. Module scope; it was being rebuilt per request. */
function deriveVisitMode(jobType: string | null): string {
  if (!jobType) return "service_diagnostic";
  const jt = jobType.toLowerCase();
  if (jt.includes("remodel") || jt.includes("renovation") || jt.includes("addition")) return "remodel";
  if (jt.includes("new construction") || jt.includes("new build")) return "new_construction";
  return "service_diagnostic";
}

/**
 * One way to birth a Property.
 *
 * `POST /properties` seeded `deficienciesJson: "[]"` and convert seeded neither,
 * so anything parsing that column had to handle null on converted properties
 * only. Both paths come through here now.
 */
export async function createPropertyWithSnapshot(
  tx: Pick<typeof prisma, "property" | "systemSnapshot">,
  data: {
    customerId: string; name: string; addressLine1: string; addressLine2?: string | null;
    city: string; state: string; postalCode: string; notes?: string | null;
    occupancyType?: string; jurisdictionId?: string | null;
  },
) {
  const property = await tx.property.create({ data });
  await tx.systemSnapshot.create({
    data: { propertyId: property.id, deficienciesJson: "[]", changeLogJson: "[]" },
  });
  return property;
}

/**
 * A lead's structured address. Every part may be absent OR null — the CRM form sends null for a
 * blank box (zod's `.optional()` alone rejects null, which is what refused a no-address lead).
 *
 * A lead SAVES with any part of an address (Kyle, 2026-11-15: "Allow part" — Yelp and Nextdoor
 * give a city and ZIP, not a street). CONVERTING it still needs all four: `resolveLeadAddress`
 * returns "none" for a fragment and `convertLeadToOpportunity` refuses with nothing written, so a
 * Property can never be created from a partial address.
 */
export const leadAddressSchema = z.object({
  addressLine1: z.string().trim().min(1).nullish(),
  addressLine2: z.string().trim().nullable().optional(),
  city: z.string().trim().min(1).nullish(),
  state: z.string().trim().length(2).nullish(),
  postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "ZIP must be 12345 or 12345-6789").nullish(),
});

/**
 * Whether an address is complete, empty, or a fragment. A fragment SAVES on a lead; only convert
 * (and anything that builds a Property) needs "complete".
 */
function addressCompleteness(a: {
  addressLine1?: string | null; city?: string | null; state?: string | null; postalCode?: string | null;
}): "complete" | "empty" | "partial" {
  const present = [a.addressLine1, a.city, a.state, a.postalCode].filter((v) => Boolean(v?.trim())).length;
  if (present === 4) return "complete";
  if (present === 0) return "empty";
  return "partial";
}

/** Which of the four convert-required parts a lead's address is still missing, in screen order. */
function missingAddressParts(a: {
  addressLine1?: string | null; city?: string | null; state?: string | null; postalCode?: string | null;
}): string[] {
  const missing: string[] = [];
  if (!a.addressLine1?.trim()) missing.push("street address");
  if (!a.city?.trim()) missing.push("city");
  if (!a.state?.trim()) missing.push("state");
  if (!a.postalCode?.trim()) missing.push("ZIP");
  return missing;
}


/**
 * POST /crm/leads - manual lead entry (the office door). Not `POST /leads`: that is the website
 * webhook, gated on a `webhook_secret` a browser cannot hold. `/crm/*` is the established CRM-only
 * prefix: after pin auth, not rate-limited.
 *
 * The whole route body lives here (work order agent-team, TM0), so the CRM form and an agent's lead
 * draft make a lead by one code path. `lead.created` is NOT emitted in here: the two ROUTES that make
 * a live lead (POST /leads, POST /crm/leads) emit it after this returns (team answer 5), so a lead an
 * agent drafts never fires it.
 */
export const crmLeadSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email().nullable().optional(),
  phone: z.string().trim().nullable().optional(),
  source: z.enum(LEAD_SOURCES).default("manual"),
  // WHICH PLATFORM sent it (Kyle, 2026-09-20) — the thing the marketing spend goes to, tagged
  // at intake and kept separate from `source` (the channel). Optional: a lead nobody tagged
  // reads "unknown" in the funnel, which is honest, and refusing the lead would be worse.
  platform: z.enum(LEAD_PLATFORMS).nullable().optional(),
  // A lead being entered by hand is by definition not yet converted —
  // conversion is a transition that creates records, not an initial state.
  status: z.enum(["new", "contacted", "lost"]).default("new"),
  leadStatus: z.enum(LEAD_PIPELINE_STATUSES).default("new"),
  notes: z.string().trim().nullable().optional(),
  jobType: z.string().trim().nullable().optional(),
  callType: z.enum(CALL_TYPES).nullable().optional(),
  referredBy: z.string().trim().nullable().optional(),
  urgentFlag: z.boolean().default(false),
  warrantyCall: z.boolean().default(false),
  warrantyNote: z.string().trim().nullable().optional(),
  contactPreference: z.enum(CONTACT_PREFERENCES).nullable().optional(),
  bestTimeToReach: z.string().trim().nullable().optional(),
  // A bare YYYY-MM-DD is a calendar day, stored as noon UTC (shared/calendarDay.ts); a full
  // timestamp parses as it always did.
  followUpDate: z.union([z.string(), z.date()]).nullable().optional().transform((value, ctx) => {
    if (value === null || value === undefined || value === "") return null;
    const date = value instanceof Date ? value : toFollowUpInstant(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: "custom", message: "Invalid followUpDate" });
      return z.NEVER;
    }
    return date;
  }),
  followUpReason: z.enum(FOLLOW_UP_REASONS).nullable().optional(),
  lostReason: z.enum(LOST_REASONS).nullable().optional(),
  lostNotes: z.string().trim().nullable().optional(),
  address: z.string().trim().nullable().optional(),
  customerId: z.string().min(1).nullable().optional(),
  propertyId: z.string().min(1).nullable().optional(),
  // The day a back-entered Yelp/Angi lead REALLY arrived (plan lead-intake-fixes F3). Blank
  // (null / "" / absent) is NOT 1970 and NOT null: it becomes undefined, so the column's
  // `@default(now())` applies. A day in the future is refused.
  receivedAt: z.union([z.string(), z.date()]).nullable().optional().transform((value, ctx) => {
    if (value === null || value === undefined || value === "") return undefined;
    const parsed = parseReceivedAt(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: parsed.error });
      return z.NEVER;
    }
    return parsed.date;
  }),
  // The marketplace's own link: http or https only, "" clears it.
  sourceUrl: z.string().nullable().optional().transform((value, ctx) => {
    const parsed = parseSourceUrl(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: parsed.error });
      return z.NEVER;
    }
    return parsed.value;
  }),
}).merge(leadAddressSchema);

export type CrmLeadInput = z.infer<typeof crmLeadSchema>;

export type CrmLeadOutcome =
  | { ok: true; lead: Lead; matches: Awaited<ReturnType<typeof findCustomerMatches>> }
  | { ok: false; status: 400 | 404; error: string };

export async function createCrmLead(
  db: PrismaClient,
  body: CrmLeadInput,
  // The door's identity; a lead has no author column, so nothing here reads it yet.
  _actor: DoorActor = HUMAN_CRM_SESSION,
): Promise<CrmLeadOutcome> {
  // Only Convert makes an opportunity — a new lead cannot start life as one by hand.
  if (body.leadStatus === "won") {
    return fail(400, WON_OUTCOME_ERROR);
  }
  // Status and the call outcome say the same thing about lost (services/leadState.ts).
  const pair = reconcileLeadState(null, { status: body.status, leadStatus: body.leadStatus });

  if (body.customerId) {
    const customer = await db.customer.findUnique({ where: { id: body.customerId }, select: { id: true } });
    if (!customer) { return fail(400, "Linked account not found"); }
  }
  if (body.propertyId) {
    const property = await db.property.findUnique({
      where: { id: body.propertyId },
      select: { id: true, customerId: true },
    });
    if (!property) { return fail(400, "Linked address not found"); }
    // Without this a lead could point at another account's address, and convert
    // would then attach a Visit across two accounts.
    if (body.customerId && property.customerId !== body.customerId) {
      return fail(400, "That address belongs to a different account");
    }
  }

  const lead = await db.lead.create({
    data: {
      ...body,
      status: pair.status,
      leadStatus: pair.leadStatus,
      state: body.state ? body.state.toUpperCase() : undefined,
    },
  });

  // Returned even though the client normally looks matches up first: a second
  // tab or a fast typist can submit without ever having called the lookup, and
  // the owner asked to be shown duplicates rather than stopped by them.
  const matches = await findCustomerMatches({
    phone: lead.phone, email: lead.email, name: lead.name,
  });
  return { ok: true, lead, matches };
}

/**
 * PATCH /leads/:leadId - edit a lead (the route body, lifted, TM0). Every refusal names its status and
 * says what to do; nothing is written on a refusal.
 */
export interface LeadPatchBody {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  jobType?: string;
  status?: string;
  notes?: string;
  callType?: string;
  referredBy?: string;
  urgentFlag?: boolean;
  warrantyCall?: boolean;
  warrantyNote?: string;
  estimateId?: string;
  existingVisitId?: string;
  leadStatus?: string;
  followUpDate?: string | null;
  followUpReason?: string | null;
  followUpCount?: number;
  lostReason?: string | null;
  lostNotes?: string | null;
  bestTimeToReach?: string | null;
  contactPreference?: string | null;
  /** The day the lead really arrived (YYYY-MM-DD); blank resets to the day the row was entered. */
  receivedAt?: string | null;
  /** The marketplace's own link; http or https only, blank clears it. */
  sourceUrl?: string | null;
  // ── Added for manual editing ──
  source?: string;
  /**
   * WHICH PLATFORM sent the lead (Kyle, 2026-09-20). Editable after the fact on purpose: a
   * phone lead arrives untagged and Kyle picks it once the caller says where they
   * found Red Cedar. `null` clears it back to "unknown".
   */
  platform?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  // Re-pointing a lead at a known account is the common case: a webhook lead
  // arrives, the owner recognizes the customer, and links it before converting.
  // `visitId` is deliberately NOT accepted — that's conversion's output and the
  // scheduler's business, and writing it here could point a lead at someone
  // else's job.
  customerId?: string | null;
  propertyId?: string | null;
}

export type LeadUpdateOutcome =
  | { ok: true; lead: Lead }
  | { ok: false; status: 400 | 404; error: string };

export async function updateLead(
  db: PrismaClient,
  leadId: string,
  body: LeadPatchBody,
  // The door's identity; a lead has no author column, so nothing here reads it yet.
  _actor: DoorActor = HUMAN_CRM_SESSION,
): Promise<LeadUpdateOutcome> {

  // Existing row first: PATCH was the only lead route with no 404 guard, so a bad
  // id surfaced as a Prisma error and a 500. It's also needed to evaluate the
  // address against the MERGED result rather than the patch alone.
  const existing = await db.lead.findUnique({ where: { id: leadId } });
  if (!existing) { return fail(404, "Lead not found"); }

  // Conversion creates the account, property and job — it is its own endpoint
  // (PATCH /leads/:leadId/convert), never a plain status write here. Dashboard's
  // old "Mark Won" button PATCHed status:"converted" directly and minted a
  // converted lead with no job behind it, and a converted lead can never be
  // deleted (Kyle, 2026-09-20 drawers plan).
  // Only a MOVE to converted is refused: the edit form re-sends a converted lead's own status, and
  // that edit must still save.
  if (body.status === "converted" && existing.status !== "converted") {
    return fail(400, "A lead becomes converted only through PATCH /leads/:leadId/convert, which creates the account, "
        + "property and job together. This endpoint cannot set that status directly.",);
  }
  // The same door for the call outcome "won" — only a CHANGE to it is refused. A row that already
  // holds "won" (Convert writes it; deleting an account resets a lead to new but leaves
  // it) saves any other edit untouched.
  if (body.leadStatus === "won" && existing.leadStatus !== "won") {
    return fail(400, WON_OUTCOME_ERROR);
  }

  const oneOf = (value: string | null | undefined, allowed: readonly string[], field: string) => {
    if (value === undefined || value === null) return null;
    return allowed.includes(value) ? null : `Invalid ${field}. Must be one of: ${allowed.join(", ")}`;
  };
  const invalid =
    oneOf(body.status, LEAD_STATUSES, "status") ??
    oneOf(body.leadStatus, LEAD_PIPELINE_STATUSES, "leadStatus") ??
    oneOf(body.source, LEAD_SOURCES, "source") ??
    oneOf(body.platform, LEAD_PLATFORMS, "platform") ??
    oneOf(body.lostReason, LOST_REASONS, "lostReason") ??
    oneOf(body.followUpReason, FOLLOW_UP_REASONS, "followUpReason") ??
    oneOf(body.contactPreference, CONTACT_PREFERENCES, "contactPreference") ??
    oneOf(body.callType, CALL_TYPES, "callType");
  if (invalid) { return fail(400, invalid); }

  const pick = <T,>(patched: T | undefined, current: T): T => (patched === undefined ? current : patched);
  // A lead saves with any part of an address (Kyle, 2026-11-15: "Allow part"). Convert is where
  // all four are required — convertLeadToOpportunity refuses a fragment and writes nothing.
  if (body.postalCode && !/^\d{5}(-\d{4})?$/.test(body.postalCode.trim())) {
    return fail(400, "ZIP must be 12345 or 12345-6789");
  }

  // An address must belong to the account the lead will end up on.
  const effectiveCustomerId = pick(body.customerId, existing.customerId);
  if (body.propertyId) {
    const property = await db.property.findUnique({
      where: { id: body.propertyId }, select: { id: true, customerId: true },
    });
    if (!property) { return fail(400, "Linked address not found"); }
    if (effectiveCustomerId && property.customerId !== effectiveCustomerId) {
      return fail(400, "That address belongs to a different account");
    }
  }
  if (body.customerId) {
    const customer = await db.customer.findUnique({ where: { id: body.customerId }, select: { id: true } });
    if (!customer) { return fail(400, "Linked account not found"); }
  }

  const data: Record<string, unknown> = {};
  if (body.source !== undefined) data.source = body.source;
  if (body.platform !== undefined) data.platform = body.platform || null;
  if (body.addressLine1 !== undefined) data.addressLine1 = body.addressLine1?.trim() || null;
  if (body.addressLine2 !== undefined) data.addressLine2 = body.addressLine2?.trim() || null;
  if (body.city !== undefined) data.city = body.city?.trim() || null;
  if (body.state !== undefined) data.state = body.state?.trim().toUpperCase() || null;
  if (body.postalCode !== undefined) data.postalCode = body.postalCode?.trim() || null;
  if (body.customerId !== undefined) data.customerId = body.customerId;
  if (body.propertyId !== undefined) data.propertyId = body.propertyId;
  if (body.name !== undefined) data.name = body.name.trim();
  if (body.email !== undefined) data.email = body.email?.trim() || null;
  if (body.phone !== undefined) data.phone = body.phone?.trim() || null;
  if (body.address !== undefined) data.address = body.address?.trim() || null;
  if (body.jobType !== undefined) data.jobType = body.jobType?.trim() || null;
  if (body.status) data.status = body.status;
  if (body.notes !== undefined) data.notes = body.notes;
  if (body.callType !== undefined) data.callType = body.callType;
  if (body.referredBy !== undefined) data.referredBy = body.referredBy;
  if (body.urgentFlag !== undefined) data.urgentFlag = body.urgentFlag;
  if (body.warrantyCall !== undefined) data.warrantyCall = body.warrantyCall;
  if (body.warrantyNote !== undefined) data.warrantyNote = body.warrantyNote;
  if (body.estimateId !== undefined) data.estimateId = body.estimateId;
  if (body.existingVisitId !== undefined) data.existingVisitId = body.existingVisitId;
  if (body.leadStatus !== undefined) data.leadStatus = body.leadStatus;
  if (body.followUpReason !== undefined) data.followUpReason = body.followUpReason;
  if (body.followUpCount !== undefined) data.followUpCount = body.followUpCount;
  if (body.lostReason !== undefined) data.lostReason = body.lostReason;
  if (body.lostNotes !== undefined) data.lostNotes = body.lostNotes;
  if (body.bestTimeToReach !== undefined) data.bestTimeToReach = body.bestTimeToReach;
  if (body.contactPreference !== undefined) data.contactPreference = body.contactPreference;

  if (body.followUpDate !== undefined) {
    if (body.followUpDate === null || body.followUpDate === "") {
      data.followUpDate = null;
    } else {
      // A bare YYYY-MM-DD is a calendar day -> noon UTC (shared/calendarDay.ts), so it reads as the
      // same day in Chicago. Anything else parses as it always did.
      const parsed = toFollowUpInstant(body.followUpDate);
      if (Number.isNaN(parsed.getTime())) {
        return fail(400, "Invalid followUpDate");
      }
      data.followUpDate = parsed;
    }
  }

  // Received day (plan lead-intake-fixes F3). The column is NOT null, so a blank is not "no date":
  // it puts the lead back on the day the row was entered. A bare YYYY-MM-DD lands at noon UTC.
  if (body.receivedAt !== undefined) {
    if (body.receivedAt === null || body.receivedAt === "") {
      data.receivedAt = existing.createdAt;
    } else if (typeof body.receivedAt !== "string") {
      return fail(400, "Invalid original received date");
    } else {
      const parsed = parseReceivedAt(body.receivedAt);
      if (!parsed.ok) { return fail(400, parsed.error); }
      data.receivedAt = parsed.date;
    }
  }
  if (body.sourceUrl !== undefined) {
    const parsed = body.sourceUrl !== null && typeof body.sourceUrl !== "string"
      ? ({ ok: false, error: "Invalid marketplace link" } as const)
      : parseSourceUrl(body.sourceUrl);
    if (!parsed.ok) { return fail(400, parsed.error); }
    data.sourceUrl = parsed.value;
  }

  // Status and the call outcome say the same thing about lost (services/leadState.ts). Only when
  // this write touches either; a converted lead and a held "won" are left as they are.
  if (body.status !== undefined || body.leadStatus !== undefined) {
    const pair = reconcileLeadState(existing, { status: body.status, leadStatus: body.leadStatus });
    if (body.status !== undefined || pair.status !== existing.status) data.status = pair.status;
    if (body.leadStatus !== undefined || pair.leadStatus !== existing.leadStatus) data.leadStatus = pair.leadStatus;
  }

  // Linking the lead to an account: its conversation so far joins the account's, in the same
  // transaction (ensureThreadFor resolves a linked lead to the account's thread, so without this the
  // earlier conversation would be stranded in a thread nobody reaches). Unlinking changes nothing:
  // the account keeps its thread.
  const linking = body.customerId !== undefined && body.customerId !== null && body.customerId !== existing.customerId;
  let linkedThread: { threadId: string | null } = { threadId: null };
  const lead = linking
    ? await db.$transaction(async (tx) => {
        const updated = await tx.lead.update({ where: { id: leadId }, data });
        linkedThread = await mergeLeadThread(tx, { leadId, customerId: body.customerId as string });
        return updated;
      })
    : await db.lead.update({ where: { id: leadId }, data });
  // The merge committed: open Messages screens refetch (U6; the writer inside the transaction cannot say it).
  announceThreadMoved(linkedThread);
  // Same rule as PATCH /leads/:id/lost: marking a lead lost frees the slot its chat was holding.
  if (lead.status === "lost" || lead.leadStatus === "lost") await releaseHoldIfHeld(leadId);
  return { ok: true, lead };
}


/**
 * PATCH /leads/:leadId/convert — lead becomes account + address + job.
 *
 * Three things changed here, all of them about not writing records nobody asked
 * for:
 *
 * 1. **The duplicate guard rail.** This used to create a brand-new Customer every
 *    time, with no phone or email matching anywhere — so a repeat customer asking
 *    about a second property got a duplicate account instead of a second address.
 *    Now, if it's about to mint an account and a match exists, it refuses with 409
 *    and the matches, having written nothing. It never adopts a match on its own,
 *    even a perfect one: that's a merge decision, and merges are hard to undo.
 *    One flag (`createNewAccount`) says "yes, genuinely new".
 * 2. **No half-conversions.** An unparseable or missing address used to produce a
 *    Customer, no Property, no Visit — and because the lead was then marked
 *    converted, `DELETE` 409'd on it forever. Now that's a 400 with nothing
 *    written, so the lead stays fixable and deletable.
 * 3. **No empty-string addresses.** `resolveLeadAddress` returns a complete
 *    address or none at all.
 */
export const leadConvertSchema = z.object({
  customerId: z.string().min(1).optional(),
  propertyId: z.string().min(1).optional(),
  propertyName: z.string().trim().min(1).optional(),
  jurisdictionId: z.enum(KNOWN_JURISDICTION_IDS).optional(),
  /** Explicit acknowledgement that a duplicate-looking account is intended. */
  createNewAccount: z.boolean().optional(),
}).merge(leadAddressSchema);

export type ConvertLeadInput = z.infer<typeof leadConvertSchema>;

/** What happened to the newsletter enrolment — reported, never a reason to fail the conversion. */
export type NewsletterEnrolment =
  | { enrolled: true; listName: string; alreadyOnList: boolean }
  | { enrolled: false; reason: "no_email" | "unsubscribed" | "failed"; listName?: string; detail?: string };

export type ConvertLeadOutcome =
  | {
    ok: true;
    result: {
      customer: Awaited<ReturnType<typeof prisma.customer.findUniqueOrThrow>>;
      property: { id: string } | null;
      visit: { id: string } | null;
      lead: Awaited<ReturnType<typeof prisma.lead.update>>;
      /** Kyle, 2026-09-20: converting enrols the account on the newsletter. This says whether it did. */
      newsletter: NewsletterEnrolment;
    };
  }
  | { ok: false; status: number; body: Record<string, unknown> };

/** Who the "From the lead:" note says took it when the door has no person (the webhook-secret /won door). */
export const LEAD_INTAKE_TAKEN_BY = "Lead intake";

/**
 * The lead's "What they need" section (client LeadForm.tsx) as the first line-by-line call note on
 * its account (Kyle, 2026-11-22: "the lead info ... what they need, job notes should also convert
 * over to the account"). Only the filled items, one per line, in the form's own words; `null` when
 * the section is empty, so nothing is written. The warranty claim only counts while "Warranty call"
 * is ticked, exactly as the form hides its box otherwise.
 */
export function leadNeedsNoteBody(
  lead: Pick<Lead, "jobType" | "callType" | "urgentFlag" | "warrantyCall" | "warrantyNote" | "notes">,
): string | null {
  const lines: string[] = [];
  const jobType = lead.jobType?.trim();
  if (jobType) lines.push(`Job type: ${jobType}`);
  const callType = lead.callType?.trim();
  if (callType) lines.push(`Call type: ${callType.replaceAll("_", " ")}`);
  if (lead.urgentFlag) lines.push("Urgent");
  if (lead.warrantyCall) {
    const claim = lead.warrantyNote?.trim();
    lines.push(claim ? `Warranty claim: ${claim}` : "Warranty call");
  }
  const notes = lead.notes?.trim();
  if (notes) lines.push(`Notes: ${notes}`);
  if (lines.length === 0) return null;
  const body = ["From the lead:", ...lines].join("\n");
  if (body.length <= ACCOUNT_NOTE_BODY_MAX) return body;
  // Over the cap the note's own Edit could never save (PATCH /accounts/:id/notes/:noteId refuses
  // it), and refusing here would roll the whole conversion back. Cut it; the full text stays on the
  // lead and in Visit.purpose. Never split a surrogate pair.
  let cut = body.slice(0, ACCOUNT_NOTE_BODY_MAX - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}\u2026`;
}

/**
 * CONVERTING A LEAD MAKES AN OPPORTUNITY — account + address + job + newsletter (Kyle, 2026-09-20:
 * "When a lead gets converted it should be considered an opportunity"). Nothing is WON here; a win
 * is a signed estimate (phase 3 of the funnel, services/leadFunnel.ts).
 *
 * Extracted from `PATCH /leads/:leadId/convert` so the automation door `PATCH /leads/:id/won` can
 * run the SAME path instead of stamping `status: "converted"` on a lead with nothing behind it
 * (PUNCHLIST A2 — an orphan lead that can then never be deleted). Both callers get the same
 * refusals, so the two doors cannot drift.
 *
 * It answers with an outcome rather than throwing, because the two callers report differently: the
 * CRM shows the duplicate picker, the webhook writes a SystemEvent.
 *
 * Three refusals, all of them writing NOTHING so the lead stays editable and deletable:
 *
 * 1. **The duplicate guard rail.** If it is about to mint an account and a match exists, it
 *    refuses with 409 and the matches. It never adopts a match on its own, even a perfect one:
 *    that is a merge decision and merges are hard to undo. One flag (`createNewAccount`) says
 *    "yes, genuinely new".
 * 2. **No half-conversions.** An unparseable or missing address used to produce a Customer, no
 *    Property and no Visit — and the lead was marked converted anyway, so `DELETE` 409'd on it
 *    forever. That is now a 400 with nothing written.
 * 3. **No empty-string addresses.** `resolveLeadAddress` returns a complete address or none.
 *
 * PLATFORM (Kyle's ruling 2): a NEW account takes the lead's platform. An EXISTING account is
 * never overwritten and never back-filled, because `Customer.platform` means "which marketing
 * brought this account" and this lead is by definition not the one that did — an account that
 * already exists was acquired earlier, and stamping it with a later lead's platform (most often
 * `repeat_customer`) would make phase 4 read its own output.
 */
export async function convertLeadToOpportunity(
  leadId: string,
  input: ConvertLeadInput,
  // The door's identity (TM0); the conversion records its outcome on the rows it writes, so nothing reads it yet.
  actor: DoorActor = HUMAN_CRM_SESSION,
  // Who pressed the button, for the "From the lead:" call note's `takenBy` (the CRM doors pass the
  // signed-in person's name; the webhook door has no person and takes LEAD_INTAKE_TAKEN_BY).
  { takenBy = LEAD_INTAKE_TAKEN_BY }: { takenBy?: string } = {},
): Promise<ConvertLeadOutcome> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, status: 404, body: { error: "Lead not found" } };
  if (lead.status === "converted") {
    // 409, matching DELETE's vocabulary for the same state conflict.
    return { ok: false, status: 409, body: { error: "Lead already converted" } };
  }

  // An address supplied on the request beats the lead's own — this is the picker
  // saying "actually, put it here".
  const address = addressCompleteness(input) === "complete"
    ? resolveLeadAddress({
      address: null, addressLine1: input.addressLine1!, addressLine2: input.addressLine2 ?? null,
      city: input.city!, state: input.state!, postalCode: input.postalCode!,
    })
    : resolveLeadAddress(lead);

  const customerId = input.customerId ?? lead.customerId;
  const propertyId = input.propertyId ?? lead.propertyId;

  if (customerId) {
    const exists = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!exists) return { ok: false, status: 400, body: { error: "Linked account not found" } };
  } else if (!input.createNewAccount) {
    // About to mint an account. Check first — this is the whole point.
    const matches = await findCustomerMatches({ phone: lead.phone, email: lead.email, name: lead.name });
    if (matches.length > 0) {
      return {
        ok: false,
        status: 409,
        body: {
          error: "Possible duplicate account",
          message:
            "This lead's contact details match an account you already have. Link it to that " +
            "account and choose an address, or confirm you want a new account.",
          matches,
        },
      };
    }
  }

  if (propertyId) {
    const property = await prisma.property.findUnique({
      where: { id: propertyId }, select: { id: true, customerId: true },
    });
    if (!property) return { ok: false, status: 400, body: { error: "Linked address not found" } };
    if (customerId && property.customerId !== customerId) {
      return { ok: false, status: 400, body: { error: "That address belongs to a different account" } };
    }
  } else if (address.kind === "none") {
    // Nothing is written. The lead stays unconverted, so it remains editable and
    // deletable rather than becoming a permanent orphan. A lead may SAVE with part of an
    // address (Kyle, 2026-11-15: "Allow part"), but converting needs all four — and says
    // which are missing, so the office knows what to add.
    const missing = missingAddressParts(lead);
    const partial = missing.length > 0 && missing.length < 4;
    return {
      ok: false,
      status: 400,
      body: {
        error: "This lead has no usable address",
        message: partial
          ? `This lead has only part of an address — still missing the ${missing.join(", ")}. ` +
            "Add the full street address, city, state and ZIP before converting — a job has to belong " +
            "to somewhere. Nothing was created."
          : "Add a street address, city, state and ZIP before converting — a job has to belong " +
            "to somewhere. Nothing was created.",
        needs: "address",
      },
    };
  }

  let movedThread: { threadId: string | null } = { threadId: null };
  const result = await prisma.$transaction(async (tx) => {
    const customer = customerId
      ? (await tx.customer.findUniqueOrThrow({ where: { id: customerId } }))
      : await tx.customer.create({
        data: {
          name: lead.name, email: lead.email, phone: lead.phone, smsConsent: lead.smsConsent,
          // WHICH PLATFORM brought the account (Kyle, 2026-09-20). Set only here, at the moment
          // the account is created — see the note above on why an existing account is left alone.
          platform: lead.platform,
        },
      });

    let property: { id: string } | null = propertyId
      ? await tx.property.findUnique({ where: { id: propertyId }, select: { id: true } })
      : null;

    if (!property && address.kind !== "none") {
      property = await createPropertyWithSnapshot(tx, {
        customerId: customer.id,
        name: input.propertyName ?? address.parts.addressLine1,
        ...address.parts,
        // Left null unless the office said otherwise, so jurisdictionResolver
        // derives it from the ZIP — which now actually exists.
        jurisdictionId: input.jurisdictionId ?? null,
      });
    }

    const visit = property
      ? await tx.visit.create({
        data: {
          propertyId: property.id,
          customerId: customer.id,
          mode: deriveVisitMode(lead.jobType),
          // Convert used to drop jobType, so a hand-typed "Panel upgrade"
          // vanished at exactly the moment it became a job — and both the Jobs
          // page and the funnel badge read visit.jobType.
          jobType: lead.jobType,
          purpose: lead.notes ?? undefined,
        },
      })
      : null;

    // What the lead said they need goes on the account's Conversation as an ordinary call note, in
    // THIS transaction so all three doors carry it and a refusal (which returns before here) never
    // leaves one. Filed through the one note writer; tagged to the job when there is one, so it also
    // shows under "Conversation at this address". Kept apart from `Visit.purpose`, which is unchanged.
    const needs = leadNeedsNoteBody(lead);
    if (needs) {
      const made = await createAccountNote(tx, customer.id, { body: needs, takenBy, visitId: visit?.id ?? null }, actor);
      if (!made.ok) throw new Error(`Could not file the lead's notes on the account: ${made.error}`);
    }

    // The lead's saved ballpark becomes this consultation's quote (Kyle, 2026-11-15). The field
    // finds a visit's quote ONLY by visitId (workingDraftForVisit), so the visit is what moves —
    // setting customerId alone would leave it invisible on the tech's Quote screen. Here, inside
    // the transaction, so the convert, mark-won and confirm-booking doors all carry it.
    if (visit) await moveBallparkToVisit(tx, { leadId, customerId: customer.id, visitId: visit.id });

    const updatedLead = await tx.lead.update({
      where: { id: leadId },
      data: {
        status: "converted",
        leadStatus: "won",
        followUpDate: null,
        customerId: customer.id,
        propertyId: property?.id ?? null,
        visitId: visit?.id ?? null,
      },
    });

    // The lead's conversation joins the account's (work order agent-team, U1), inside this transaction
    // so all three conversion doors (convert, mark won, confirm booking) carry it.
    movedThread = await mergeLeadThread(tx, { leadId, customerId: customer.id });

    return { customer, property, visit, lead: updatedLead };
  });
  // The conversation moved and the transaction committed: open Messages screens refetch (U6).
  announceThreadMoved(movedThread);

  const newsletter = await enrolAccountInNewsletter(
    { id: result.customer.id, name: result.customer.name, email: result.customer.email ?? lead.email },
    leadId,
  );

  return { ok: true, result: { ...result, newsletter } };
}

/**
 * "Converting a lead automatically adds the account to the newsletter list — that is what makes it
 * an opportunity in Kyle's words" (2026-09-20 plan, ruling 2). The unsubscribe link is already in
 * every campaign email, so this needs no second consent step.
 *
 * Deliberately OUTSIDE the conversion transaction and deliberately unable to fail it: a mailing
 * list that is momentarily unreachable must not cost Kyle an account, an address and a job. The
 * outcome is returned so the caller can say what happened instead of implying it worked.
 *
 * It writes a real `EmailListMember` row rather than leaning on the default list's
 * `includeAllAccounts` flag: that flag is editable, and an enrolment Kyle can SEE (and remove —
 * the standing rule) is the thing the ruling asked for.
 *
 * An address that has unsubscribed is never re-added. That is the same refusal
 * `POST /leads/:leadId/add-to-campaign` makes and it is not negotiable.
 */
async function enrolAccountInNewsletter(
  account: { id: string; name: string; email: string | null },
  leadId: string,
): Promise<NewsletterEnrolment> {
  if (!account.email) return { enrolled: false, reason: "no_email" };
  try {
    const { ensureDefaultList, isSuppressed } = await import("./emailCampaigns");
    const list = await ensureDefaultList(prisma);
    if (await isSuppressed(prisma, account.email)) {
      return { enrolled: false, reason: "unsubscribed", listName: list.name };
    }
    const existing = await prisma.emailListMember.findUnique({
      where: { listId_email: { listId: list.id, email: account.email } },
      select: { id: true },
    });
    await prisma.emailListMember.upsert({
      where: { listId_email: { listId: list.id, email: account.email } },
      create: { listId: list.id, email: account.email, name: account.name, leadId },
      update: { name: account.name, leadId },
    });
    return { enrolled: true, listName: list.name, alreadyOnList: Boolean(existing) };
  } catch (err) {
    logSystemEvent("warn", "leads", "Converted the lead but could not add the account to the newsletter list", {
      leadId, customerId: account.id, error: err instanceof Error ? err.message : String(err),
    });
    return { enrolled: false, reason: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

