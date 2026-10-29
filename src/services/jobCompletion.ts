/**
 * The JOB COMPLETION REPORT's record (Kyle, 2026-10-29): one entry per line of the job's signed
 * invoice - what was done and why, the NEC articles, the readings, the photos.
 *
 *   "Each separate line item can get photos and an explination of what was done and why. It will
 *    follow our same standard as the electrical assesment report so everyone gets the code
 *    compliance and empirical data that is specific to our brand."
 *
 * Asked who fills it in: "Both" - the technician at the job (field app) and the office (CRM). This
 * file is the ONE implementation; the CRM routes in src/app.ts and the technician's routes in
 * src/routes/health-record.ts are thin doors onto these three functions, and the contract they
 * parse and return is shared/jobCompletion.ts.
 *
 * WHICH LINES. The job's signed invoice: the ROOT and every signed, live change order on it
 * (invoiceGroup.loadInvoiceGroup), and on each document ONLY the options the customer took
 * (IssuedEstimate.selectedOptions vs IssuedEstimateLine.option) - the same rule the invoice PDF
 * prints by (issuedEstimatePdf.ts), so a line of a declined option is never offered, never saved,
 * never printed. A signed document with NO recorded selection (legacy rows) declined nothing that
 * is known, and the invoice PDF prints all of it, so this does too.
 *
 * WHAT IS NEVER READ. Only the customer-facing name, the quantity and the option come off a line.
 * materialCost, materialSell, laborHours, unitPrice and lineTotal are not selected here at all -
 * the report goes to a third party and cannot print what its loader never fetched.
 */
import type { PrismaClient, Prisma } from "@prisma/client";
import {
  completionEntryInputSchema,
  completionReadingSchema,
  type CompletionEntry,
  type CompletionLineView,
  type CompletionLinesResponse,
  type CompletionReading,
} from "../../shared/jobCompletion";
import { loadInvoiceGroup, signedRootForJob } from "./invoiceGroup";

export class CompletionError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404) {
    super(message);
    this.name = "CompletionError";
  }
}

/** The same split the catalog's NEC filter uses (app.ts, the price-book article list). */
export function splitNecArticles(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of String(raw ?? "").split(/[,;/]/)) {
    const ref = part.trim();
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}

function readingsOf(json: Prisma.JsonValue | null): CompletionReading[] {
  const parsed = completionReadingSchema.array().safeParse(json ?? []);
  return parsed.success ? parsed.data : [];
}

function entryView(row: {
  explanation: string;
  necRefs: string[];
  readingsJson: Prisma.JsonValue | null;
  photoIds: string[];
  updatedBy: string | null;
  updatedAt: Date;
}): CompletionEntry {
  return {
    explanation: row.explanation,
    necRefs: row.necRefs,
    readings: readingsOf(row.readingsJson),
    photoIds: row.photoIds,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const empty = (visitId: string, reason: string, invoiceNumber: string | null = null): CompletionLinesResponse =>
  ({ visitId, invoiceNumber, lines: [], writtenUp: 0, reason });

/**
 * The job's invoice lines (selected options only), each with its entry or null. A job with no
 * signed invoice answers an empty list with the reason - never an error.
 */
export async function listCompletionLines(prisma: PrismaClient, visitId: string): Promise<CompletionLinesResponse> {
  const visit = await prisma.visit.findUnique({ where: { id: visitId }, select: { id: true } });
  if (!visit) throw new CompletionError("Job not found.", 404);

  const root = await signedRootForJob(prisma, visitId);
  if (!root) return empty(visitId, "This job has no signed invoice yet, so there are no lines to write up.");
  const group = await loadInvoiceGroup(prisma, root.id);
  if (!group) return empty(visitId, "This job has no signed invoice yet, so there are no lines to write up.");

  const documents = [group.root, ...group.changeOrders];
  const rows = await prisma.issuedEstimateLine.findMany({
    where: { estimateId: { in: documents.map((d) => d.id) } },
    select: {
      id: true, estimateId: true, description: true, quantity: true, option: true, sortOrder: true,
      atomic: { select: { necArticle: true } },
    },
  });

  const lines: CompletionLineView[] = [];
  for (const doc of documents) {
    const taken = new Set((doc.selectedOptions ?? []) as string[]);
    const mine = rows
      .filter((l) => l.estimateId === doc.id && (taken.size === 0 || taken.has(l.option)))
      .sort((a, b) => (a.option === b.option ? a.sortOrder - b.sortOrder : a.option < b.option ? -1 : 1));
    for (const l of mine) {
      lines.push({
        lineId: l.id,
        documentId: doc.id,
        documentNumber: doc.number,
        documentKind: doc.changeOrderForId ? "change_order" : "invoice",
        option: l.option,
        name: l.description,
        quantity: l.quantity,
        defaultNecRefs: splitNecArticles(l.atomic?.necArticle),
        entry: null,
      });
    }
  }
  if (lines.length === 0) return empty(visitId, "The signed invoice has no lines to write up.", group.root.number);

  const entries = await prisma.jobCompletionLine.findMany({
    where: { issuedEstimateLineId: { in: lines.map((l) => l.lineId) } },
  });
  const byLine = new Map(entries.map((e) => [e.issuedEstimateLineId, e]));
  // A photo that has since been deleted from the job drops off the entry it was on - the list never
  // hands a door an id that 404s.
  const wanted = [...new Set(entries.flatMap((e) => e.photoIds))];
  const alive = new Set(
    wanted.length === 0
      ? []
      : (await prisma.visitPhoto.findMany({ where: { id: { in: wanted }, visitId }, select: { id: true } })).map((p) => p.id),
  );
  for (const l of lines) {
    const e = byLine.get(l.lineId);
    if (!e) continue;
    const view = entryView(e);
    view.photoIds = view.photoIds.filter((id) => alive.has(id));
    l.entry = view;
  }
  return {
    visitId,
    invoiceNumber: group.root.number,
    lines,
    writtenUp: lines.filter((l) => l.entry).length,
    reason: null,
  };
}

/**
 * Save (create or replace) one line's entry. The line must be on this job's invoice with its option
 * taken, and every photo must be a VisitPhoto of THIS visit - a photo from another job is refused
 * with a sentence, never silently dropped.
 */
export async function saveCompletionLine(
  prisma: PrismaClient,
  visitId: string,
  lineId: string,
  rawInput: unknown,
  updatedBy: string,
): Promise<CompletionLineView> {
  const input = completionEntryInputSchema.parse(rawInput ?? {});

  const listed = await listCompletionLines(prisma, visitId);
  const line = listed.lines.find((l) => l.lineId === lineId);
  if (!line) {
    throw new CompletionError(
      listed.reason ?? "That line is not on this job's invoice (or the option it belongs to was not taken).",
      404,
    );
  }

  if (input.photoIds.length > 0) {
    const found = await prisma.visitPhoto.findMany({
      where: { id: { in: input.photoIds }, visitId },
      select: { id: true },
    });
    const ok = new Set(found.map((p) => p.id));
    const bad = input.photoIds.filter((id) => !ok.has(id));
    if (bad.length > 0) {
      throw new CompletionError(
        `${bad.length === 1 ? "A photo you picked is" : `${bad.length} photos you picked are`} not on this job. Only this job's own photos can go on its completion report.`,
        400,
      );
    }
  }

  const data = {
    visitId,
    explanation: input.explanation,
    necRefs: input.necRefs,
    readingsJson: input.readings as unknown as Prisma.InputJsonValue,
    photoIds: input.photoIds,
    updatedBy,
  };
  const saved = await prisma.jobCompletionLine.upsert({
    where: { issuedEstimateLineId: lineId },
    create: { issuedEstimateLineId: lineId, ...data },
    update: data,
  });
  return { ...line, entry: entryView(saved) };
}

/** The exit (standing rule): take one line's write-up off the report. True when there was one. */
export async function clearCompletionLine(prisma: PrismaClient, visitId: string, lineId: string): Promise<{ cleared: boolean }> {
  const visit = await prisma.visit.findUnique({ where: { id: visitId }, select: { id: true } });
  if (!visit) throw new CompletionError("Job not found.", 404);
  // visitId in the filter: a line's entry can only be cleared from the job it was written on.
  const r = await prisma.jobCompletionLine.deleteMany({ where: { issuedEstimateLineId: lineId, visitId } });
  return { cleared: r.count > 0 };
}
