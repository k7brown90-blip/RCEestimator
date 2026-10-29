/**
 * The JOB COMPLETION REPORT contract (Kyle, 2026-10-29) - what one invoice line's write-up is, and
 * what the two doors (the office's CRM, the technician's field app) send and read. ONE record, two
 * doors: services/jobCompletion.ts is the only implementation; routes in src/app.ts (CRM) and
 * src/routes/health-record.ts (field) are thin doors onto it, and both frontends import the shapes
 * and limits from here, never their own.
 *
 * Kyle: "Each separate line item can get photos and an explination of what was done and why. It
 * will follow our same standard as the electrical assesment report so everyone gets the code
 * compliance and empirical data that is specific to our brand."
 *
 * Nothing in here carries a price, a cost or labour hours. The report is a third party's document
 * (the customer's realtor) - the list shape below has no field a figure could ride in on.
 */
import { z } from "zod";
import {
  COMPLETION_REPORT_ID,
  MAX_COMPLETION_PHOTOS,
  MAX_EXPLANATION_LENGTH,
  MAX_NEC_REF_LENGTH,
  MAX_NEC_REFS,
  MAX_READING_LABEL_LENGTH,
  MAX_READING_UNIT_LENGTH,
  MAX_READING_VALUE_LENGTH,
  MAX_READINGS,
  MAX_RECEIPT_REPORTS,
} from "./jobCompletionLimits";

// The limits live in jobCompletionLimits.ts (no zod, so the frontends can import them); re-exported here.
export * from "./jobCompletionLimits";

// ── One reading ──────────────────────────────────────────────────────────────────────────────────
export const completionReadingSchema = z.object({
  label: z.string().trim().min(1, "A reading needs a label").max(MAX_READING_LABEL_LENGTH),
  value: z.string().trim().min(1, "A reading needs a value").max(MAX_READING_VALUE_LENGTH),
  unit: z.string().trim().max(MAX_READING_UNIT_LENGTH).default(""),
});
export type CompletionReading = z.infer<typeof completionReadingSchema>;

// ── One line's entry: what the office or the technician writes, and what the doors accept ────────
export const completionEntryInputSchema = z
  .object({
    /** What was done and why. */
    explanation: z.string().trim().max(MAX_EXPLANATION_LENGTH).default(""),
    /** NEC articles, e.g. "210.8(A)". Duplicates are dropped; an empty list prints no citation. */
    necRefs: z
      .array(z.string().trim().min(1).max(MAX_NEC_REF_LENGTH))
      .max(MAX_NEC_REFS, `At most ${MAX_NEC_REFS} NEC articles on one line`)
      .default([])
      .transform((refs) => [...new Set(refs)]),
    readings: z.array(completionReadingSchema).max(MAX_READINGS, `At most ${MAX_READINGS} readings on one line`).default([]),
    /** VisitPhoto ids of THIS job. A photo from another job is refused by the service, never dropped. */
    photoIds: z
      .array(z.string().trim().min(1))
      .max(MAX_COMPLETION_PHOTOS, `At most ${MAX_COMPLETION_PHOTOS} photos on one line`)
      .default([])
      .transform((ids) => [...new Set(ids)]),
  })
  .refine((v) => v.explanation.length > 0 || v.readings.length > 0 || v.photoIds.length > 0, {
    message: "Write what was done and why, add a reading or add a photo - or use Clear to take this line's write-up off the report.",
    path: ["explanation"],
  });
/** What a door parses to (defaults applied). */
export type CompletionEntryInput = z.infer<typeof completionEntryInputSchema>;
/** What a door SENDS: `unit`, and any list left out, default. */
export type CompletionEntryBody = z.input<typeof completionEntryInputSchema>;

// ── What the list endpoint returns ───────────────────────────────────────────────────────────────
/** A saved entry, as read back. Identical through both doors. */
export interface CompletionEntry {
  explanation: string;
  necRefs: string[];
  readings: CompletionReading[];
  photoIds: string[];
  updatedBy: string | null;
  /** ISO timestamp. */
  updatedAt: string;
}

/** One invoice line (selected options only) with its entry, or null when it is not written up yet. */
export interface CompletionLineView {
  /** IssuedEstimateLine.id - the key the save / clear routes take. */
  lineId: string;
  /** The invoice document the line sits on: the root, or a signed change order. */
  documentId: string;
  documentNumber: string;
  documentKind: "invoice" | "change_order";
  /** "A" | "B" | "C" - the option the customer took. */
  option: string;
  /** The customer-facing line name (custom name when it has one). */
  name: string;
  quantity: number;
  /** The price-book item's NEC article, offered as the starting citation; [] when the item has none. */
  defaultNecRefs: string[];
  entry: CompletionEntry | null;
}

export interface CompletionLinesResponse {
  visitId: string;
  /** The ROOT invoice's number, or null when the job has no signed invoice. */
  invoiceNumber: string | null;
  lines: CompletionLineView[];
  /** How many lines have an entry. */
  writtenUp: number;
  /** Why `lines` is empty (no signed invoice, ...); null when there are lines. */
  reason: string | null;
}

// ── Report ids a receipt can attach ──────────────────────────────────────────────────────────────
/**
 * A report is named by one string, used by the receipt request (`reports`) and by the payment-info
 * list (`ReceiptReportOption.id`):
 *   "completion"              the Job Completion Report (one per job)
 *   "health:<inspectionId>"   an Electrical Health Record
 *   "generator:<inspectionId>" the Generator Sizing sheet of that same inspection
 *   "diagnostic:<reportId>"   a Circuit Diagnostic report
 */
export type ReceiptReportRef =
  | { kind: "completion" }
  | { kind: "health" | "generator" | "diagnostic"; id: string };

export function reportIdOf(ref: ReceiptReportRef): string {
  return ref.kind === "completion" ? COMPLETION_REPORT_ID : `${ref.kind}:${ref.id}`;
}

export function parseReportId(raw: string): ReceiptReportRef | null {
  const s = raw.trim();
  if (s === COMPLETION_REPORT_ID) return { kind: "completion" };
  const m = /^(health|generator|diagnostic):(.+)$/.exec(s);
  return m ? { kind: m[1] as "health" | "generator" | "diagnostic", id: m[2] } : null;
}

/** The `reports` field of a receipt request. */
export const receiptReportIdsSchema = z.array(z.string().trim().min(1)).max(MAX_RECEIPT_REPORTS).optional();

/** One row of the receipt's "Attach reports" list (payment-info `email.reports`). */
export interface ReceiptReportOption {
  /** See ReceiptReportRef. */
  id: string;
  kind: "completion" | "health" | "generator" | "diagnostic";
  /** "Job Completion Report", "Electrical Health Record", "Generator Sizing sheet", "Circuit Diagnostic report - Kitchen". */
  label: string;
  /** ISO date the report is dated (completion: the last time a line was written up), or null. */
  date: string | null;
  /** False = shown greyed with `blockedReason`. */
  available: boolean;
  blockedReason?: string;
}
