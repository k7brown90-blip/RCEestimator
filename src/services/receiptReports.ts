/**
 * The reports a receipt can carry (Kyle, 2026-10-29: "We still need to be able to attach any report
 * we do but this will be a new 'Job Completion Report'").
 *
 * ONE function decides what is on file for a job (`listReceiptReports`) and the receipt email's
 * "Attach reports" list, the payment-info response and the send's own validation all read it - so
 * the panel can never offer a report the send would refuse, and the send can never accept one the
 * panel did not offer.
 *
 * WHICH REPORTS BELONG TO THE JOB. The job chain: the job visit plus the consultation visit its
 * signed invoice was raised from (jobCosting.jobChainOfVisits - the same chain that rolls a job's
 * hours, P.O.s and photos together). The Electrical Health Record is usually taken on that
 * consultation visit, not on the install visit, so a report scoped to the install visit alone would
 * never show up on the job it led to. A report from any other visit is "not on this job".
 *
 * NEVER THINNER THAN TICKED. A report that cannot be produced refuses the whole send with the
 * reason (`renderReceiptReports`); nothing is skipped quietly.
 */
import fs from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import {
  COMPLETION_REPORT_ID,
  NO_LINES_WRITTEN_UP,
  parseReportId,
  reportIdOf,
  type ReceiptReportOption,
} from "../../shared/jobCompletion";
import { jobChainOfVisits } from "./jobCosting";
import { listCompletionLines } from "./jobCompletion";
import {
  CompletionReportError,
  generateCompletionReport,
  generateDiagnosticReport,
  generateGeneratorReport,
  generateHealthReport,
} from "./pdfGenerator";

/** The job an invoice belongs to: the install visit it was linked to, else the visit it was raised on. */
export function jobOfInvoice(root: { jobVisitId: string | null; visitId: string | null }): string | null {
  return root.jobVisitId ?? root.visitId ?? null;
}

export async function listReceiptReports(
  prisma: PrismaClient,
  root: { jobVisitId: string | null; visitId: string | null },
): Promise<ReceiptReportOption[]> {
  const jobId = jobOfInvoice(root);
  if (!jobId) return [];
  const chain = await jobChainOfVisits([jobId, root.visitId]);
  const out: ReceiptReportOption[] = [];

  // The Job Completion Report - one per job, first in the list.
  const lines = await listCompletionLines(prisma, jobId).catch(() => null);
  const written = lines?.lines.filter((l) => l.entry) ?? [];
  const latest = written.map((l) => l.entry!.updatedAt).sort().at(-1) ?? null;
  out.push({
    id: COMPLETION_REPORT_ID,
    kind: "completion",
    label: "Job Completion Report",
    date: latest,
    available: written.length > 0,
    ...(written.length > 0 ? {} : { blockedReason: lines?.reason ?? NO_LINES_WRITTEN_UP }),
  });

  const inspections = await prisma.healthInspection.findMany({
    where: { visitId: { in: chain }, supersededById: null },
    orderBy: { inspectionDate: "desc" },
    select: { id: true, inspectionDate: true, loadCalcJson: true },
  });
  // No contractor-review gate (Kyle, 2026-10-30): "Red Cedar Electric is the contractor creating
  // the report." A critical finding no longer greys the record.
  for (const i of inspections) {
    out.push({
      id: reportIdOf({ kind: "health", id: i.id }),
      kind: "health",
      label: "Electrical Health Record",
      date: i.inspectionDate.toISOString(),
      available: true,
    });
    if (i.loadCalcJson) {
      out.push({
        id: reportIdOf({ kind: "generator", id: i.id }),
        kind: "generator",
        label: "Generator Sizing sheet",
        date: i.inspectionDate.toISOString(),
        available: true,
      });
    }
  }

  const diagnostics = await prisma.diagnosticReport.findMany({
    where: { visitId: { in: chain }, status: { not: "void" } },
    orderBy: { reportDate: "desc" },
    select: { id: true, reportDate: true, circuitLabel: true, status: true, _count: { select: { outlets: true } } },
  });
  for (const d of diagnostics) {
    const blocked = d.status !== "complete"
      ? "This diagnostic is still in progress - finish the circuit and mark it complete first."
      : d._count.outlets === 0 ? "No outlets were recorded, so there is no diagnostic to send." : null;
    out.push({
      id: reportIdOf({ kind: "diagnostic", id: d.id }),
      kind: "diagnostic",
      label: `Circuit Diagnostic report - ${d.circuitLabel}`,
      date: d.reportDate.toISOString(),
      available: !blocked,
      ...(blocked ? { blockedReason: blocked } : {}),
    });
  }
  return out;
}

export type RenderedReport = { filename: string; content: Buffer; contentType: "application/pdf" };

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "report");

/**
 * Turn the ticked report ids into PDF attachments, freshly rendered. Refuses the whole list on the
 * first one that is not this job's, is unavailable, or fails to render.
 */
export async function renderReceiptReports(
  prisma: PrismaClient,
  root: { jobVisitId: string | null; visitId: string | null },
  reportIds: readonly string[],
): Promise<{ ok: true; attachments: RenderedReport[] } | { ok: false; reason: string }> {
  const wanted = [...new Set(reportIds.map((r) => r.trim()).filter(Boolean))];
  if (wanted.length === 0) return { ok: true, attachments: [] };
  const jobId = jobOfInvoice(root);
  const options = await listReceiptReports(prisma, root);
  const attachments: RenderedReport[] = [];
  const used = new Set<string>();
  const nameFor = (base: string) => {
    let name = `${base}.pdf`;
    for (let n = 2; used.has(name); n += 1) name = `${base}-${n}.pdf`;
    used.add(name);
    return name;
  };

  for (const id of wanted) {
    const ref = parseReportId(id);
    const option = ref ? options.find((o) => o.id === reportIdOf(ref)) : undefined;
    if (!ref || !option) return { ok: false, reason: `The report "${id}" is not on this invoice's job, so it was not sent. Nothing was emailed.` };
    if (!option.available) return { ok: false, reason: `${option.label} can't be attached: ${option.blockedReason ?? "it isn't ready"}. Nothing was emailed.` };

    try {
      if (ref.kind === "completion") {
        const r = await generateCompletionReport(jobId!);
        attachments.push({ filename: nameFor(r.filename.replace(/\.pdf$/, "")), content: r.pdf, contentType: "application/pdf" });
      } else if (ref.kind === "health") {
        const r = await generateHealthReport(ref.id);
        attachments.push({ filename: nameFor(`electrical-health-record-${day(option.date)}`), content: await fs.readFile(r.pdfPath), contentType: "application/pdf" });
      } else if (ref.kind === "generator") {
        const r = await generateGeneratorReport(ref.id);
        attachments.push({ filename: nameFor(`generator-sizing-data-sheet-${day(option.date)}`), content: await fs.readFile(r.pdfPath), contentType: "application/pdf" });
      } else {
        const r = await generateDiagnosticReport(ref.id);
        attachments.push({ filename: nameFor(`circuit-diagnostic-${day(option.date)}`), content: await fs.readFile(r.pdfPath), contentType: "application/pdf" });
      }
    } catch (err) {
      const why = err instanceof CompletionReportError ? err.message : "it could not be produced right now";
      return { ok: false, reason: `${option.label} can't be attached: ${why}. Nothing was emailed.` };
    }
  }
  return { ok: true, attachments };
}
