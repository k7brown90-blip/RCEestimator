/**
 * Finalized draft → issued estimate → emailed → signed. (P027)
 *
 * Kyle, 2026-08-17: *"get the estimates working to the point where I can email the customer and
 * have them sign an estimate in the app."*
 *
 * THE ONE RULE THIS MODULE EXISTS TO HOLD, above all the others:
 *
 *   **NO HOURS, NO RATES, NO HOUR-DERIVED ARITHMETIC REACHES THE CUSTOMER.**
 *   Kyle, verbatim, 2026-08-17: "Never show labor hour estimate to the customer." That is the
 *   2026-08-04 flat-rate ruling restated as a template rule, because it was violated in
 *   practice — estimate PDFs 2026-1001 and 2026-1002 carried a "Labor Hrs" column and the
 *   2026-08-17 session copied that template into four more before Kyle caught it.
 *
 *   The defence here is STRUCTURAL rather than editorial: `IssuedEstimate` has no hours column
 *   and `IssuedEstimateLine` has no hours column. Graduation collapses the engine's labour
 *   dollars and material sell into one flat `unitPrice` and discards the hours. A template
 *   cannot leak a number the model never carried. `tests/issuedEstimate.test.ts` greps the
 *   rendered customer HTML for hour patterns on top of that.
 *
 * IMMUTABILITY. Everything the customer sees is snapshot at graduation: description, quantity,
 * price, the customer's own name and address. A line's `atomic` relation is provenance only and
 * the render never reads through it. That is what makes a signed estimate reproducible
 * byte-for-byte after the catalog, the rate config, or the customer record moves underneath it.
 * Editing after send never mutates — it supersedes.
 *
 * MANUAL-FIRST. `sendEstimate` has exactly one caller: a PIN-authenticated operator route behind
 * a confirm. It is deliberately NOT a member of `automationGate`'s `CustomerSendWorkflow` union —
 * that union enumerates AUTOMATED sends and the 2026-08-11 deferral gates them off. Kyle's
 * 2026-08-17 ruling orders an operator-TRIGGERED send, which is a different lane. No cron, no
 * trigger and no retry queue may call this function.
 */

import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { computeDraft, finalizeDraft } from "./atomicEstimateService";
import { rowTypeSells } from "./atomicEstimateEngine";
import { logSystemEvent } from "./systemEvents";

/** House numbering continues the issued PDFs, the last of which was 2026-1010. */
const NUMBER_FLOOR = 1010;
const NUMBER_YEAR = "2026";

export const CONSENT_TEXT =
  "By typing my full name below and tapping Accept, I agree to the scope and the price on this " +
  "estimate, and I authorize Red Cedar Electric LLC to perform the work described. I understand " +
  "this is an electronic signature with the same effect as a written one.";

/**
 * A fresh, unguessable customer credential: 32 bytes = 256 bits of entropy, hex-encoded.
 *
 * Not a cuid. Cuids embed a timestamp and a monotonic counter, so possessing one issued link
 * would narrow the search space for the next one — which is exactly the property a capability
 * URL must not have.
 */
export function newToken(): string {
  return randomBytes(32).toString("hex");
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ─── Graduation ─────────────────────────────────────────────────────────────────

export interface GraduateInput {
  draftId: string;
  title?: string | null;
  scopeText?: string | null;
  includedText?: string | null;
  /** Kyle waives the trip on plenty of jobs; the PDFs show it as a $0.00 LINE, never a hidden one. */
  waiveTrip?: boolean;
  createdBy?: string;
}

export type GraduateResult =
  | { ok: true; estimateId: string; number: string; revision: number }
  | { ok: false; reasons: string[] };

async function nextNumber(prisma: PrismaClient): Promise<string> {
  const rows = await prisma.issuedEstimate.findMany({
    select: { number: true },
    orderBy: { number: "desc" },
    take: 1,
  });
  const parsed = rows.length > 0 ? Number(rows[0].number.split("-")[1]) : NaN;
  const highest = Number.isFinite(parsed) ? parsed : NUMBER_FLOOR;
  return `${NUMBER_YEAR}-${Math.max(highest, NUMBER_FLOOR) + 1}`;
}

/**
 * Turn a finalized, gap-free draft into an issued estimate.
 *
 * The gate is `finalizeDraft` itself rather than a second implementation of the same rules — it
 * already refuses on unconfirmed AI proposals, open questions, missing labour, missing supplier
 * price, a raceway with no measured conductor line, and a provisional rate. Re-deriving that
 * list here would create a second answer to "is this quotable?" that could drift from the first.
 * Its refusal reasons are returned VERBATIM, because the wording is what tells Kyle what to fix.
 */
export async function graduateDraft(
  prisma: PrismaClient,
  input: GraduateInput
): Promise<GraduateResult> {
  const draft = await prisma.priceBookDraftEstimate.findUnique({ where: { id: input.draftId } });
  if (!draft) return { ok: false, reasons: [`Draft ${input.draftId} not found.`] };

  // The same gate the Finalize button uses. A clean, customer-context finalize marks the draft.
  const gate = await finalizeDraft(prisma, input.draftId, "customer");
  if (!gate.finalized) return { ok: false, reasons: gate.reasons };

  const { computed, rate, atomics } = await computeDraft(prisma, input.draftId);
  if (computed.lines.length === 0) return { ok: false, reasons: ["The estimate has no lines."] };

  // ── Collapse to flat prices. This is where the hours stop. ──
  const lines: Array<{
    itemId: string;
    description: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    sortOrder: number;
  }> = [];
  const refusals: string[] = [];

  computed.lines.forEach((l, i) => {
    const atomic = atomics.get(l.itemId);
    const sells = rowTypeSells(atomic?.rowType ?? null);

    // "Never make up a number." A null on a component the row actually SELLS is a missing price,
    // not a zero — and a gap-free draft should never produce one, so reaching this is a refusal
    // rather than a default.
    if (sells.labour && l.laborDollars === null) {
      refusals.push(`${l.itemId} has no labour price and cannot be quoted flat.`);
      return;
    }
    if (sells.material && l.materialSell === null) {
      refusals.push(`${l.itemId} has no material price and cannot be quoted flat.`);
      return;
    }

    const lineTotal = round2((l.laborDollars ?? 0) + (l.materialSell ?? 0));
    if (!Number.isFinite(lineTotal)) {
      refusals.push(`${l.itemId} produced a non-finite price.`);
      return;
    }
    lines.push({
      itemId: l.itemId,
      description: l.description ?? l.itemId,
      quantity: l.quantity,
      unitPrice: l.quantity > 0 ? round2(lineTotal / l.quantity) : lineTotal,
      lineTotal,
      sortOrder: i,
    });
  });

  if (refusals.length > 0) return { ok: false, reasons: refusals };

  const workSubtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const tripCharge = input.waiveTrip ? 0 : round2(rate.rc.jobFixedCost ?? 0);
  const total = round2(workSubtotal + tripCharge);

  // Integrity check against the engine's own subtotal — the same "agree to the cent" discipline
  // the intake screen holds. A mismatch means the collapse dropped or double-counted something,
  // and issuing a customer price on that is the failure this codebase keeps closing. The
  // tolerance is one cent per line, which is the most per-line rounding can accumulate.
  const engineWork = round2(computed.laborDollars + computed.materialSell);
  if (Math.abs(engineWork - workSubtotal) > 0.01 * lines.length + 0.001) {
    return {
      ok: false,
      reasons: [
        `Internal check failed: the flat lines total $${workSubtotal.toFixed(2)} but the engine ` +
          `computed $${engineWork.toFixed(2)} for the same draft. Refusing to issue a price that ` +
          `does not reconcile.`,
      ],
    };
  }

  const context = await loadCustomerContext(prisma, draft);
  const number = await nextNumber(prisma);
  const token = newToken();

  const created = await prisma.$transaction(async (tx) => {
    const est = await tx.issuedEstimate.create({
      data: {
        number,
        revision: 1,
        status: "draft",
        token,
        draftId: draft.id,
        customerId: draft.customerId,
        leadId: draft.leadId,
        visitId: draft.visitId,
        customerName: context.customerName,
        customerEmail: context.customerEmail,
        customerPhone: context.customerPhone,
        serviceAddress: context.serviceAddress,
        title: (input.title ?? "").trim() || draft.title,
        scopeText: input.scopeText ?? draft.jobDescription ?? null,
        includedText: input.includedText ?? null,
        workSubtotal,
        tripCharge,
        tripWaived: Boolean(input.waiveTrip),
        total,
        createdBy: input.createdBy ?? "human:crm-session",
        lines: { create: lines },
      },
    });
    await tx.issuedEstimateEvent.create({
      data: {
        estimateId: est.id,
        type: "created",
        actor: input.createdBy ?? "human:crm-session",
        detail: `${number} rev 1 — ${lines.length} line(s), total $${total.toFixed(2)}`,
      },
    });
    return est;
  });

  return { ok: true, estimateId: created.id, number, revision: created.revision };
}

/**
 * Who this estimate is for, resolved once and then frozen onto the row.
 *
 * Prefers the customer record and falls back to the lead — P024 records all three anchors when
 * known and defers which is authoritative, so this reads them in the order that produces the
 * most complete customer-facing block.
 */
async function loadCustomerContext(
  prisma: PrismaClient,
  draft: { customerId: string | null; leadId: string | null; visitId: string | null }
) {
  let customerName = "Customer";
  let customerEmail: string | null = null;
  let customerPhone: string | null = null;
  let serviceAddress: string | null = null;

  if (draft.customerId) {
    const c = await prisma.customer.findUnique({ where: { id: draft.customerId } });
    if (c) {
      customerName = c.name;
      customerEmail = c.email;
      customerPhone = c.phone;
    }
  }
  if (draft.leadId) {
    const l = await prisma.lead.findUnique({ where: { id: draft.leadId } });
    if (l) {
      if (customerName === "Customer") customerName = l.name;
      customerEmail = customerEmail ?? l.email;
      customerPhone = customerPhone ?? l.phone;
    }
  }
  if (draft.visitId) {
    const v = await prisma.visit.findUnique({
      where: { id: draft.visitId },
      include: { property: true },
    });
    if (v?.property) {
      serviceAddress =
        [v.property.addressLine1, v.property.city, v.property.state, v.property.postalCode]
          .filter(Boolean)
          .join(", ") || null;
    }
  }
  return { customerName, customerEmail, customerPhone, serviceAddress };
}

// ─── Reading ────────────────────────────────────────────────────────────────────

async function loadByToken(prisma: PrismaClient, token: string) {
  return prisma.issuedEstimate.findUnique({
    where: { token },
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
      supersededBy: { select: { id: true, number: true, revision: true } },
    },
  });
}

export type IssuedEstimateWithLines = NonNullable<Awaited<ReturnType<typeof loadByToken>>>;

export type TokenLookup =
  | { ok: true; estimate: IssuedEstimateWithLines }
  | { ok: false; reason: "not_found" | "superseded" | "void" };

/**
 * Resolve a customer token to exactly one estimate.
 *
 * The shape is checked before the query, so a short or malformed path segment never becomes a
 * lookup at all. Callers are expected to render the same page for every failure reason — someone
 * probing tokens should learn "no", never whether a token was well-formed, replaced, or simply
 * wrong.
 */
export async function getEstimateByToken(
  prisma: PrismaClient,
  token: string
): Promise<TokenLookup> {
  if (!token || token.length !== 64 || !/^[0-9a-f]+$/.test(token)) {
    return { ok: false, reason: "not_found" };
  }
  const est = await loadByToken(prisma, token);
  if (!est) return { ok: false, reason: "not_found" };
  // A superseded revision's link stops working the moment a newer one exists — the customer must
  // never be able to sign a version Kyle has already replaced.
  if (est.supersededBy) return { ok: false, reason: "superseded" };
  if (est.status === "void") return { ok: false, reason: "void" };
  return { ok: true, estimate: est };
}

/** First view flips sent → viewed. Idempotent: only the FIRST view is recorded. */
export async function recordFirstView(prisma: PrismaClient, estimateId: string): Promise<void> {
  const est = await prisma.issuedEstimate.findUnique({ where: { id: estimateId } });
  if (!est || est.firstViewedAt || est.signedAt) return;
  await prisma.$transaction(async (tx) => {
    await tx.issuedEstimate.update({
      where: { id: estimateId },
      data: {
        firstViewedAt: new Date(),
        status: est.status === "sent" ? "viewed" : est.status,
      },
    });
    await tx.issuedEstimateEvent.create({
      data: { estimateId, type: "viewed", actor: "customer" },
    });
  });
}

// ─── Signing ────────────────────────────────────────────────────────────────────

export interface SignInput {
  signerName: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Which door the signature came through.
 *
 * "in_person" — the customer signed on the operator's device at the job (P028, Kyle's FIRST
 * option). "email" — the customer opened the tokenized link (P027). The channel changes NOTHING
 * about the signature's weight, the lock, the audit line, the status or the owner notification;
 * it is recorded because "he signed it in my truck" and "he signed it from his kitchen" are
 * different facts about the same agreement.
 */
export type SignChannel = "in_person" | "email";

export type SignResult = { ok: true; estimateId: string } | { ok: false; reason: string };

/**
 * Record the customer's signature and LOCK the estimate.
 *
 * Sign-once is enforced by a CONDITIONAL update rather than read-then-write: the update matches
 * on `signedAt: null`, so two taps arriving together produce one signature and one "already
 * signed" answer — never two signatures, and never a first signer silently overwritten by a
 * second.
 */
export async function signEstimate(
  prisma: PrismaClient,
  token: string,
  input: SignInput
): Promise<SignResult> {
  const name = input.signerName.trim();
  if (name.length < 2) return { ok: false, reason: "Please type your full name to sign." };

  const found = await getEstimateByToken(prisma, token);
  if (!found.ok) return { ok: false, reason: "This estimate link is no longer valid." };
  if (found.estimate.signedAt) return { ok: false, reason: "This estimate has already been signed." };

  return applySignature(prisma, found.estimate.id, found.estimate.number, found.estimate.revision, name, input, "email");
}

/**
 * Sign an estimate the customer is reading on the operator's own device. (P028)
 *
 * Reached only from a route inside a SIGNING-SCOPED session — see middleware/signingScope.ts —
 * so there is no token here: the capability is the narrowed session itself, and it names this one
 * estimate. Everything after the lookup is the SAME code path the email signature takes, which is
 * the point: one signature model, one lock, one audit shape, two doors.
 */
export async function signEstimateInPerson(
  prisma: PrismaClient,
  estimateId: string,
  input: SignInput
): Promise<SignResult> {
  const name = input.signerName.trim();
  if (name.length < 2) return { ok: false, reason: "Please type your full name to sign." };

  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    include: { supersededBy: { select: { id: true } } },
  });
  if (!est) return { ok: false, reason: "This estimate is no longer available." };
  if (est.supersededBy) {
    return { ok: false, reason: "This estimate has been replaced by a newer revision." };
  }
  if (est.status === "void") return { ok: false, reason: "This estimate is void." };
  if (est.signedAt) return { ok: false, reason: "This estimate has already been signed." };

  return applySignature(prisma, est.id, est.number, est.revision, name, input, "in_person");
}

/**
 * The one place a signature is written, for both channels.
 *
 * Sign-once is enforced by a CONDITIONAL update rather than read-then-write: the update matches
 * on `signedAt: null`, so two taps arriving together — or one tap on the phone racing one on the
 * emailed link — produce one signature and one "already signed" answer. Never two, and never a
 * first signer silently overwritten by a second.
 */
async function applySignature(
  prisma: PrismaClient,
  estimateId: string,
  number: string,
  revision: number,
  name: string,
  input: SignInput,
  channel: SignChannel
): Promise<SignResult> {
  const result = await prisma.issuedEstimate.updateMany({
    where: { id: estimateId, signedAt: null },
    data: {
      signedAt: new Date(),
      signerName: name,
      signerIp: input.ip ?? null,
      signerUserAgent: input.userAgent ?? null,
      consentText: CONSENT_TEXT,
      signedChannel: channel,
      status: "signed",
    },
  });
  if (result.count === 0) return { ok: false, reason: "This estimate has already been signed." };

  const where = channel === "in_person" ? "in person on the operator's device" : "from the emailed link";
  await prisma.issuedEstimateEvent.create({
    data: {
      estimateId,
      type: "signed",
      actor: channel === "in_person" ? "customer:in-person" : "customer",
      detail: `Signed by "${name}" ${where} (rev ${revision}) from ${input.ip ?? "unknown IP"}`,
    },
  });
  logSystemEvent("info", "issued-estimate", `Estimate ${number} signed by ${name} (${channel})`, {
    estimateId,
    revision,
    channel,
    ip: input.ip ?? null,
  });

  return { ok: true, estimateId };
}

// ─── Revision ───────────────────────────────────────────────────────────────────

/**
 * Supersede an issued estimate with a new revision built from the draft as it stands now.
 *
 * The old row is NEVER edited beyond being linked: its lines, its prices and — if it was signed —
 * its signature stay exactly as they were. That is the whole point. What changes is that its
 * token stops resolving, so a customer cannot sign, or re-sign, a version that has been replaced.
 * Sending the new revision is a separate, explicit operator action.
 */
export async function reviseEstimate(
  prisma: PrismaClient,
  estimateId: string,
  opts: { actor?: string; waiveTrip?: boolean } = {}
): Promise<GraduateResult> {
  const prev = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    include: { supersededBy: { select: { id: true } } },
  });
  if (!prev) return { ok: false, reasons: [`Estimate ${estimateId} not found.`] };
  if (prev.supersededBy) {
    return { ok: false, reasons: ["That estimate has already been superseded by a newer revision."] };
  }

  const graduated = await graduateDraft(prisma, {
    draftId: prev.draftId,
    title: prev.title,
    scopeText: prev.scopeText,
    includedText: prev.includedText,
    waiveTrip: opts.waiveTrip ?? prev.tripWaived,
    createdBy: opts.actor ?? "human:crm-session",
  });
  if (!graduated.ok) return graduated;

  // Re-key the new row onto the SAME house number, one revision up, and link the chain.
  const next = await prisma.$transaction(async (tx) => {
    const updated = await tx.issuedEstimate.update({
      where: { id: graduated.estimateId },
      data: { number: prev.number, revision: prev.revision + 1, supersedesId: prev.id },
    });
    await tx.issuedEstimateEvent.create({
      data: {
        estimateId: prev.id,
        type: "superseded",
        actor: opts.actor ?? "human:crm-session",
        detail: `Superseded by ${prev.number} rev ${prev.revision + 1}. This revision's link no longer opens.`,
      },
    });
    return updated;
  });

  return { ok: true, estimateId: next.id, number: next.number, revision: next.revision };
}
