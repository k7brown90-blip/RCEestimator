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
import { sendBrandedEmail, escapeHtml } from "./confirmationEmail";
import { checkSignatureImage } from "./signatureImage";
import { logSystemEvent } from "./systemEvents";
import { selectionCap } from "./materialMarkupCap";

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
  /**
   * THE SPINE (P029). Both required — an issued estimate cannot exist unattached.
   *
   * Kyle, 2026-08-18: "All of it links to their account… if they have multiple addresses on file
   * it needs to link to the address that we are working at." Account-level linkage alone does
   * not satisfy that, so the caller must name the address too. When the draft came from a visit
   * the UI prefills both from it; when the account has several addresses the operator PICKS —
   * this function never defaults to the first, because a silently-chosen address puts the wrong
   * street on a signed document.
   */
  accountId: string;
  serviceAddressId: string;
  title?: string | null;
  scopeText?: string | null;
  includedText?: string | null;
  /** Kyle waives the trip on plenty of jobs; the PDFs show it as a $0.00 LINE, never a hidden one. */
  waiveTrip?: boolean;
  createdBy?: string;
}

export type GraduateResult =
  | {
      ok: true;
      estimateId: string;
      number: string;
      revision: number;
      /**
       * Lines frozen at zero because the engine had no price for them (2026-08-20).
       *
       * Present only when it happened. The estimate is CHEAPER THAN THE WORK by whatever these
       * were worth, and the operator has to be told before a customer sees the number — so this
       * travels back with the success rather than being buried in a log.
       */
      unpriced?: string[];
    }
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
  const draft = await prisma.priceBookDraftEstimate.findUnique({
    where: { id: input.draftId },
    // Kyle's names for the options come along for the ride — they are frozen onto the issued
    // estimate below, so the document keeps the names it was presented under even if the draft
    // is later renamed.
    include: { optionMeta: true },
  });
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
    // Frozen for the COMPANY copy — the material to order and the hours to schedule. Rebuilding
    // these from the draft later would read a document that is allowed to change.
    option: "A" | "B" | "C";
    laborHours: number | null;
    materialSell: number | null;
    materialCost: number | null;
  }> = [];
  const refusals: string[] = [];
  /** Lines frozen at zero because the engine had no price for them. Never silently dropped. */
  const unpriced: string[] = [];

  computed.lines.forEach((l, i) => {
    const atomic = atomics.get(l.itemId);
    const sells = rowTypeSells(atomic?.rowType ?? null);

    /*
      ── A MISSING PRICE NO LONGER REFUSES, BUT IT IS NEVER INVENTED (Kyle, 2026-08-20) ────────

      "These checks are becoming a preventative block. They need removed. Nothing should block me
       from completing the estimate."

      These three used to refuse graduation outright. They now let the estimate through, because
      that is his instruction and because the gates upstream had been refusing correct work.

      What has NOT changed is "never make up a number". A line the engine could not price is
      frozen at zero and RECORDED as unpriced — it is not given a guessed price, and it is not
      quietly dropped either. Dropping it would be the worst of the three options: the work
      vanishes from the document and the total looks deliberate.

      The cost is real and is stated where it lands: the estimate is CHEAPER THAN THE WORK by
      whatever those lines were worth. `unpriced` is returned to the caller so the operator is
      told before a customer sees a number.
    */
    if (sells.labour && l.laborDollars === null) {
      unpriced.push(`${l.itemId} — no labour price`);
    }
    if (sells.material && l.materialSell === null) {
      unpriced.push(`${l.itemId} — no material price`);
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
      // `!== 0`, not `> 0`. A change-order line may carry a NEGATIVE count to remove work, and
      // the old test sent those down the divide-by-nothing branch — storing the whole line total
      // as the unit price, so a "-2 fans" line would have read as one unit at the full amount.
      unitPrice: l.quantity !== 0 ? round2(lineTotal / l.quantity) : lineTotal,
      lineTotal,
      sortOrder: i,
      option: l.option,
      // Carried through as-is, including null. A null labour figure means the engine had no
      // hours for that row; recording 0 would claim the work takes no time.
      laborHours: l.laborHours,
      // F — what the customer is charged for material.
      materialSell: l.materialSell,
      // E — what it costs Red Cedar. Kyle tracks spending against this, so it is frozen with the
      // rest rather than re-derived later from a catalog that will have moved on.
      materialCost: l.materialCost,
    });
  });

  if (refusals.length > 0) return { ok: false, reasons: refusals };

  /*
    ── THE OPTIONS THEMSELVES, NOT JUST THE LETTER ON EACH LINE (Kyle, 2026-08-20) ─────────────

    "the options are not persisting into the pdf or allowing to pick and choose between them.
     Only adding them all together."

    Every frozen line already carried its option letter, so nothing was being LOST — but a letter
    on a line is not an option. There was nowhere to say what an option is called, what it covers,
    or what it costs by itself, so the issued document could only render one flat list and one
    total, and the customer had nothing to choose between.

    These rows are that missing thing. Built from the lines that were just frozen, so the option
    subtotal and the lines always agree, and named from the draft so the customer sees the scope
    rather than a bare letter.

    The trip charge is deliberately NOT distributed across them: it is charged once for the visit,
    however many options are taken, and dividing it up would make each option look more expensive
    than it is and would double-charge anyone taking two.
  */
  const optionRows = (["A", "B", "C"] as const)
    .map((option) => {
      const inOption = lines.filter((l) => l.option === option);
      const meta = draft.optionMeta.find((m) => m.option === option);
      return {
        option,
        label: meta?.label?.trim() || null,
        note: meta?.note?.trim() || null,
        subtotal: round2(inOption.reduce((s, l) => s + l.lineTotal, 0)),
        lineCount: inOption.length,
      };
    })
    // An option with no work in it is not offered. An empty "Option C" on a customer's screen is
    // an invitation to ask what is missing from it.
    .filter((o) => o.lineCount > 0);

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

  const context = await resolveSpine(prisma, input.accountId, input.serviceAddressId, draft);
  if ("error" in context) return { ok: false, reasons: [context.error] };

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
        customerId: input.accountId,
        serviceAddressId: input.serviceAddressId,
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
        /*
          ── THE MATERIAL CHECK'S WORKING, AND THE SHORTER CLOCK (2026-08-21) ────────────────────

          The frozen lines above already carry the CAPPED material charge — the engine applied the
          job-level check before this function ever saw them. What is stored here is the check's
          working (cost, what the tiers wanted, the ceiling, the reduction) so the company copy can
          print it. An adjustment Kyle cannot see is one he cannot defend to a customer who asks.

          validDays: a material-heavy quote holds a supplier-priced bill of goods at a 1.25x
          ceiling — roughly 25 points of cover. Thirty days is long enough for copper or gear to
          eat that. Fourteen days is the pairing Kyle accepted with the tighter top band: the
          protection is a shorter promise, not a fatter margin.
        */
        materialCapsJson:
          Object.keys(computed.materialCaps ?? {}).length > 0
            ? JSON.stringify(computed.materialCaps)
            : null,
        validDays: computed.materialCost >= 3000 ? 14 : 30,
        lines: { create: lines },
        options: { create: optionRows },
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

  if (unpriced.length > 0) {
    logSystemEvent(
      "warn",
      "issued-estimate",
      `Estimate ${number} issued with ${unpriced.length} unpriced line(s) — the total is lower than the work`,
      { estimateId: created.id, unpriced },
    );
  }

  return {
    ok: true,
    estimateId: created.id,
    number,
    revision: created.revision,
    unpriced: unpriced.length > 0 ? unpriced : undefined,
  };
}

/**
 * Resolve the account and the address this estimate is for, then freeze what the document says.
 *
 * Two jobs in one place, deliberately:
 *   1. VALIDATE the spine — the account exists, the address exists, and the address belongs to
 *      that account. The third check is the one that matters: without it an operator (or a
 *      malformed request) could put one customer's street on another customer's estimate, and
 *      both ids would still be individually valid.
 *   2. SNAPSHOT the text. Name, phone, email and the address as it reads today are copied onto
 *      the row so the signed document cannot be moved by a later edit to the account record.
 *
 * Refuses rather than guesses. There is no "pick the first address" branch anywhere in here.
 */
async function resolveSpine(
  prisma: PrismaClient,
  accountId: string,
  serviceAddressId: string,
  draft: { leadId: string | null }
): Promise<
  | { error: string }
  | {
      customerName: string;
      customerEmail: string | null;
      customerPhone: string | null;
      serviceAddress: string | null;
    }
> {
  const account = await prisma.customer.findUnique({ where: { id: accountId } });
  if (!account) return { error: `Account ${accountId} not found. An estimate must belong to an account.` };

  const property = await prisma.property.findUnique({ where: { id: serviceAddressId } });
  if (!property) {
    return { error: `Service address ${serviceAddressId} not found. An estimate must name the address being worked.` };
  }
  if (property.customerId !== accountId) {
    return {
      error:
        `That address belongs to a different account. An estimate must link to the address being ` +
        `worked ON THIS account — quoting one customer's job against another customer's street is ` +
        `the mistake this check exists to stop.`,
    };
  }

  let customerEmail = account.email;
  let customerPhone = account.phone;
  // A lead can carry contact details the account record has not picked up yet; it never overrides
  // what the account already knows.
  if ((!customerEmail || !customerPhone) && draft.leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: draft.leadId } });
    if (lead) {
      customerEmail = customerEmail ?? lead.email;
      customerPhone = customerPhone ?? lead.phone;
    }
  }

  const serviceAddress =
    [property.addressLine1, property.city, property.state, property.postalCode]
      .filter(Boolean)
      .join(", ") || null;

  return { customerName: account.name, customerEmail, customerPhone, serviceAddress };
}

// ─── Reading ────────────────────────────────────────────────────────────────────

async function loadByToken(prisma: PrismaClient, token: string) {
  return prisma.issuedEstimate.findUnique({
    where: { token },
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
      options: { orderBy: { option: "asc" } },
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
  /**
   * The DRAWN signature, as a PNG data URL (Kyle, 2026-08-20).
   *
   * Required for any new signature. The typed name stays alongside it — that is how a signature
   * is searched for and addressed — but the drawing is what was actually made.
   */
  signatureImage?: string | null;
  /**
   * WHICH OPTIONS THE CUSTOMER IS BUYING (Kyle, 2026-08-20).
   *
   * "the options are not persisting into the pdf or allowing to pick and choose between them.
   *  Only adding them all together."
   *
   * Undefined means the caller did not express a choice — an older client, or a signature made
   * with JavaScript off — and is treated as "all of them", which is what the estimate quoted and
   * what those clients actually displayed. It is NOT treated as "none".
   *
   * Whatever arrives is validated against the options the estimate really has before anything is
   * recorded. This comes from a form on a public page, so it is an assertion by the customer, not
   * a fact, until the server has checked it.
   */
  selectedOptions?: string[] | null;
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
  /*
    Checked HERE rather than in each route, for the same reason the signature itself is written
    here: there are two doors — the emailed link and the operator's device — and a rule enforced
    at one door is a rule that does not exist. `checkSignatureImage` is the only thing that
    decides whether a drawing is acceptable.
  */
  const drawn = checkSignatureImage(input.signatureImage);
  if (!drawn.ok) return { ok: false, reason: drawn.reason };

  /*
    ── WHAT THEY ACTUALLY BOUGHT ────────────────────────────────────────────────────────────────

    The tick boxes live on a public page, so what comes back is a claim to be checked rather than
    a fact to be stored. Anything that is not a real option on THIS estimate is discarded — a
    hand-edited form cannot add an option that was never offered or priced.

    Silence means all of them. A customer signing from a client that never showed tick boxes saw
    the full scope at the full price, and recording "none" for them would be a worse lie than the
    flattening this change exists to fix.

    An explicit empty choice is refused outright: signing for no work is not a sale, and a $0
    agreement with a real signature on it is the sort of document nobody wants to explain later.
  */
  const offered = await prisma.issuedEstimateOption.findMany({
    where: { estimateId },
    select: { option: true },
  });
  const valid = new Set(offered.map((o) => o.option as string));
  let bought: string[];
  if (input.selectedOptions == null) {
    bought = [...valid];
  } else {
    bought = input.selectedOptions.map((o) => o.trim().toUpperCase()).filter((o) => valid.has(o));
    if (valid.size > 0 && bought.length === 0) {
      return { ok: false, reason: "Please choose at least one option before accepting." };
    }
  }

  /*
    ── THE THIRD GATE, WRITTEN DOWN AT THE MOMENT OF SIGNING (2026-08-22) ──────────────────────

    Kyle: "Let's add the final check against the total combined options and treat them as a
    single job."

    The combined-selection discount was computed live on every unsigned render. Now the selection
    is final, so the result is frozen alongside it — the bands live in code, and an edit to them
    must never restate a price a customer signed. Computed from the FROZEN lines of the options
    bought, the same figures every other document surface reads.
  */
  const frozenLines = await prisma.issuedEstimateLine.findMany({
    where: { estimateId },
    select: { option: true, materialCost: true, materialSell: true },
  });
  const comboCap = selectionCap(frozenLines, new Set(bought));

  const result = await prisma.issuedEstimate.updateMany({
    where: { id: estimateId, signedAt: null },
    data: {
      selectedOptions: bought as never,
      comboCapJson: JSON.stringify(comboCap),
      signedAt: new Date(),
      signatureImage: drawn.dataUrl,
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

  /*
    ── FILING AND NOTIFYING, NEITHER OF WHICH MAY UNDO A SIGNATURE ─────────────────────────────

    Kyle, 2026-08-20: "When they sign I should get a notification and a copy of the signed
    agreement to their account too."

    Filing happens AFTER the signature is committed and is not awaited into the result. A
    customer has signed; that fact is recorded and must not be lost because a document row could
    not be written. The Gmail token expiring for two days is not a hypothetical here — it already
    happened, and anything in the signature's path that can fail will eventually fail during a
    signature.

    So: signature first, always. Everything else is best-effort and reports its own failure.
    Notifying Kyle is `notifyOwnerSigned`, called by both routes, and predates this.
  */
  void fileSignedCopies(prisma, estimateId, number);

  return { ok: true, estimateId };
}

/**
 * File the signed agreement on the account — BOTH copies.
 *
 * Kyle, 2026-08-20: *"after they sign the signed copy needs to be saved to their account along
 * side our copy."*
 *
 * Two rows, one estimate. The customer's copy is what they agreed to; the company's carries the
 * material to order and the hours to schedule against. Neither stores bytes — each points at the
 * immutable estimate and is rendered on request, so they cannot drift from each other or from the
 * record, and they survive a deploy that deletes `generated/`.
 *
 * NOT EXPORTED AND NOT AWAITED — see the note at its only call site. A customer has signed; that
 * fact must not be undone by a failure to file it.
 *
 * NOTIFICATION IS NOT DONE HERE. `notifyOwnerSigned` already exists in issuedEstimateSend.ts and
 * is already called by both sign routes. I wrote a second one before finding it, which would have
 * sent Kyle two emails per signature. It looked missing because it had been silent for two days —
 * the Gmail refresh token was dead, not the code.
 */
async function fileSignedCopies(prisma: PrismaClient, estimateId: string, number: string): Promise<void> {
  const est = await prisma.issuedEstimate.findUnique({ where: { id: estimateId } }).catch(() => null);
  if (!est) return;

  const common = {
    jobId: est.jobVisitId ?? est.visitId ?? null,
    propertyId: est.serviceAddressId,
    issuedEstimateId: est.id,
    signedAt: est.signedAt,
    signedByName: est.signerName,
  };

  for (const [type, audience] of [
    ["signed_estimate", "customer"],
    ["signed_estimate_company", "company"],
  ] as const) {
    await prisma.document
      .create({ data: { ...common, type, pdfUrl: `/api/issued-estimates/${est.id}/pdf?audience=${audience}` } })
      .catch((err: unknown) => {
        logSystemEvent("error", "issued-estimate", `Could not file the ${audience} copy for ${number}`, {
          estimateId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
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
    // A revision stays on the same account and the same address. Changing either is not a
    // revision of this estimate — it is a different estimate for a different job.
    accountId: prev.customerId,
    serviceAddressId: prev.serviceAddressId,
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
