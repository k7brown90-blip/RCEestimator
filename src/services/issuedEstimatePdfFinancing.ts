/**
 * The "Financing options (Synchrony)" section of the CUSTOMER's estimate / invoice PDF
 * (Kyle, 2026-10-09, final layout 2026-10-10).
 *
 *   2026-10-09: "They should at very least get an overview of what the 4 plans monthly cost would
 *                be while looking at the pdf they sign."
 *   2026-10-10: "synchrony provides all the legal details we just need them to know what the APR
 *                is, the total months, and the monthly payment amount and the link." ... "With
 *                plan id." ... "do not forget the apr %."
 *
 * So the section is: a heading, ONE line per active plan (Settings order), and the Synchrony link.
 * No table, no fee note, no "Financing terms" page - Synchrony's own page carries the legal
 * disclosure. The ONE exception, Kyle 2026-11-27 ("when someone chooses financing it needs to be
 * clear they pay a deposit still"): under the link, the same single deposit sentence the estimate
 * email carries (shared/financingDisplay.ts financingDepositLine) - the deposit amount and nothing
 * about credit.
 *
 *   Reduced-APR plan:  "Plan 965 · 11.99% APR · 86 months · $109/mo"
 *   Deferred plan:     "Plan 920 · No interest if paid in full · 6 months · $1,036/mo"
 *
 * ── NO SECOND FORMULA ──────────────────────────────────────────────────────────────────────────
 * Every dollar figure comes from `buildQuoteFinancing` (shared/financing.ts) - the one calculator
 * behind the customer page, the CRM Presentation page, the field and the estimate email - fed the
 * PDF's own printed total (the homeowner's share after any warranty coverage). The plans are the
 * snapshot frozen onto the estimate at issue; an estimate issued before snapshots existed uses
 * today's active Settings plans (the same fallback the financing fee takes, financingFee.ts).
 * Nothing is calculated in this file.
 *
 * ── RATES ARE RED CEDAR'S COST ─────────────────────────────────────────────────────────────────
 * The plans passed in carry Synchrony's discount rate (the server needs it to calculate). Only the
 * customer-safe `FinancingPlanView` / `FinancingFigures` the shared builder returns are ever read
 * below, so no rate can be drawn.
 */

import type { PrismaClient } from "@prisma/client";
import { buildQuoteFinancing, type FinancingPlan } from "../../shared/financing";
import { financingDepositLine } from "../../shared/financingDisplay";
import { getActiveFinancingPlans, plansFromSnapshot } from "./financingSettings";
import { getIssuedQuoteMoney } from "./quoteMoney";
import { paymentSummary } from "./stripePayments";

type Doc = PDFKit.PDFDocument;

/** What `renderEstimatePdf` is handed to print financing: server-side inputs, no figures yet. */
export interface PdfFinancing {
  /** The active plans in force for this estimate (frozen snapshot, else Settings), in Settings order. */
  plans: FinancingPlan[];
  /**
   * What the deposit sentence under "Finance this project" may say (Kyle, 2026-11-27). Absent = an
   * unsigned estimate (or a hand-built input): the calculator's own one-third of the printed total.
   * On a signed invoice: `asked` is false only when a required deposit is already in - then there is
   * no sentence. Decision 8 (financingFee.ts): there is no no-deposit financing, so a customer who finances pays the one-third deposit even where "Deposit required" is unticked (the office ticks it before the fee can go on). Only a change order, whose deposit belongs to its root, carries no sentence. `due` is the deposit the customer is actually asked for
   * (paymentSummary.depositDue: a third of only the documents that require one), so the PDF never
   * prints a second deposit figure; null when "Deposit required" is unticked, and the sentence is
   * then worded without an amount.
   */
  deposit?: { asked: boolean; due: number | null };
}

/**
 * Load the financing inputs for an issued estimate. Null when nothing should be offered: the
 * estimate is gone, void or lost, is a change order (financing is worked on the whole invoice, not
 * on a change order's own few dollars), no plan is active, or - on a signed invoice - the question
 * has been answered: a financing fee is already applied (the invoice appendix names the plan and the
 * fee; four hypothetical plans beside it would be a second story) or the homeowner owes nothing.
 */
export async function loadPdfFinancing(prisma: PrismaClient, estimateId: string): Promise<PdfFinancing | null> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: { status: true, voidedAt: true, lostAt: true, changeOrderForId: true, financingPlansJson: true, signedAt: true },
  });
  if (!est || est.voidedAt || est.lostAt || est.status === "void" || est.status === "lost" || est.changeOrderForId) return null;
  // No snapshot at all (issued before financing existed): today's Settings plans. A snapshot that IS
  // there but is garbled or holds no active plan offers nothing, exactly as the customer page does
  // (getIssuedQuoteMoney) - never a quiet substitution of today's plans for the frozen ones.
  const plans = est.financingPlansJson ? (plansFromSnapshot(est.financingPlansJson) ?? []) : await getActiveFinancingPlans();
  if (plans.length === 0) return null;
  let deposit: { asked: boolean; due: number | null } | undefined;
  if (est.signedAt) {
    // The origin only builds pay links, which are not read here.
    const summary = await paymentSummary(prisma, estimateId, "");
    if (summary && (summary.financingFee || summary.paidInFull)) return null;
    // A signed invoice: the amount is the summary's deposit (a third of only the documents that
    // require one). No sentence once a required deposit is in; unticked still says it, unpriced.
    if (summary) {
      const required = summary.depositRequired && summary.depositDue > 0;
      deposit = { asked: !(required && summary.depositSatisfied), due: required ? summary.depositDue : null };
    }
  }
  // Same guard as the customer page: an estimate the shared pricer cannot price offers nothing.
  const money = await getIssuedQuoteMoney(prisma, estimateId);
  if (!money) return null;
  return { plans, deposit };
}

// ─── The lines: one per plan ────────────────────────────────────────────────────────────────────

export interface FinancingLinesInput {
  financing: PdfFinancing;
  /** What the printed total bills across both payers, before warranty coverage (the PDF's `jobBilled`). */
  billedBeforeCoverage: number;
  /** Home-warranty coverage on the claim, 0 when none - the homeowner finances only their share. */
  coveredAmount: number;
  /** A signed invoice with change orders joined: the whole invoice's homeowner total replaces `billedBeforeCoverage`. */
  wholeInvoiceTotal?: number | null;
}

const dollarsPerMonth = (n: number) => `$${n.toLocaleString("en-US")}/mo`;
const monthsOf = (n: number) => `${n} ${n === 1 ? "month" : "months"}`;

/**
 * One text line per active plan, Settings order, worked on the PDF's own printed total through the
 * shared calculator. Null when nothing is offered (no active plan, or nothing owed: no "$0/mo").
 */
export function financingLinesFor(input: FinancingLinesInput): string[] | null {
  return financingFiguresFor(input)?.lines ?? null;
}

/**
 * The one-line deposit sentence under "Finance this project" (Kyle, 2026-11-27) - worked from the
 * SAME calculator result as the plan lines, so its amount is the deposit those figures assume.
 * Null exactly when there are no plan lines.
 */
export function financingDepositLineFor(input: FinancingLinesInput): string | null {
  const figures = financingFiguresFor(input);
  if (!figures) return null;
  // A required deposit already in: no sentence. On a signed invoice the amount is the deposit
  // actually asked (or none when "Deposit required" is unticked), never a third of the PDF total.
  const asked = input.financing.deposit;
  if (!asked) return financingDepositLine(figures.deposit);
  if (!asked.asked) return null;
  return financingDepositLine(asked.due);
}

function financingFiguresFor(input: FinancingLinesInput): { lines: string[]; deposit: number } | null {
  const whole = input.wholeInvoiceTotal != null;
  const total = whole ? (input.wholeInvoiceTotal as number) : input.billedBeforeCoverage;
  const covered = whole ? 0 : input.coveredAmount;
  const built = buildQuoteFinancing(input.financing.plans, { row: total }, covered);
  const offers = built?.bySelection.row?.offers ?? [];
  if (!built || offers.length === 0) return null;
  const lines: string[] = [];
  for (const p of built.plans) {
    const offer = offers.find((o) => o.planNumber === p.planNumber);
    if (!offer) continue;
    const terms = p.type === "reduced_apr" ? `${p.apr}% APR` : "No interest if paid in full";
    lines.push(`Plan ${p.planNumber} · ${terms} · ${monthsOf(p.months)} · ${dollarsPerMonth(offer.monthly)}`);
  }
  return lines.length > 0 ? { lines, deposit: offers[0].deposit } : null;
}

// ─── Drawing ────────────────────────────────────────────────────────────────────────────────────

const LEFT = 50;
const WIDTH = 512;

/** Start a new page when `needed` points will not fit above the bottom margin. */
function ensureRoom(doc: Doc, needed: number): void {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

/**
 * Heading, a line per plan, and "Finance this project: <url>" with the URL printed in full (it has
 * to work on paper) and clickable. The heading, every line and the link travel together on a page.
 */
export function drawFinancingOptions(doc: Doc, lines: readonly string[], financingUrl: string, depositLine: string | null = null): void {
  ensureRoom(doc, 40 + lines.length * 14 + 24 + (depositLine ? 16 : 0));
  doc.moveDown(1.2);
  doc.x = LEFT;
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#000").text("Financing options (Synchrony)", LEFT, doc.y, { width: WIDTH });
  doc.font("Helvetica").fontSize(10);
  doc.moveDown(0.4);
  for (const line of lines) doc.text(line, LEFT, doc.y, { width: WIDTH });
  doc.moveDown(0.5);
  doc.font("Helvetica-Bold").text("Finance this project: ", LEFT, doc.y, { width: WIDTH, continued: true });
  doc.font("Helvetica").fillColor("#1155cc").text(financingUrl, { link: financingUrl, underline: true });
  doc.fillColor("#000");
  doc.x = LEFT;
  // The deposit is still paid up front (Kyle, 2026-11-27): one sentence, under the link.
  if (depositLine) doc.font("Helvetica").fontSize(10).text(depositLine, LEFT, doc.y + 2, { width: WIDTH });
  doc.x = LEFT;
}
