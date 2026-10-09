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
import type { Prisma, PrismaClient } from "@prisma/client";
import { DraftError, computeDraft, draftCopyReason, draftDeleteReason, finalizeDraft } from "./atomicEstimateService";
import { rowTypeSells } from "./atomicEstimateEngine";
import type { DraftLifecycle, DraftLifecycleIssued } from "../../shared/draftLifecycle";
import { FIELD_SIGNED_REVISE_REASON } from "../../shared/draftLifecycle";
import { sendBrandedEmail, escapeHtml } from "./confirmationEmail";
import { checkSignatureImage } from "./signatureImage";
import { logSystemEvent } from "./systemEvents";
import { bandsFrom, selectionCap, type MarkupBand } from "./materialMarkupCap";
import { frozenSelectionDiscount, programmeFor } from "./discounts";
import { snapshotActiveFinancingPlansJson } from "./financingSettings";
import { notifyOwnerViewed } from "./issuedEstimateSend";
import { ALL_OPTIONS, type EstimateOptionLetter } from "../../shared/estimateOptions";
import { CONSENT_TEXT } from "../../shared/consentText";
import { signedRootForJob } from "./invoiceGroup";
import { z } from "zod";

/** House numbering continues the issued PDFs, the last of which was 2026-1010. */
const NUMBER_FLOOR = 1010;
const NUMBER_YEAR = "2026";

// The consent sentence lives in shared/ (2026-10-08): the field app's signing screen must show the
// customer exactly the words recorded here. Re-exported so every `import { CONSENT_TEXT }` still works.
export { CONSENT_TEXT };

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
  /**
   * P031: attach the generator sizing one-pager. The operator checks this while
   * issuing (the human approval in the propose-only chain); the recommendation
   * itself comes from the field assessment's capacity check at this address.
   * Refuses with a plain reason when none is on file — never a silent no-op.
   */
  includeGenerator?: boolean;
  /** Revision path only: carry the previous estimate's snapshot forward verbatim. */
  generatorJson?: string | null;
  /**
   * THE DEPOSIT IS OPTIONAL (Kyle, 2026-09-20: "a deposit required check box for a manual
   * override"). Absent = the default: ON for an estimate, OFF for a change order. On = this
   * document's homeowner share counts toward the invoice's ⅓ and gates scheduling.
   */
  depositRequired?: boolean;
  /**
   * "Add to current job" (Kyle, 2026-09-20) — change orders only. Absent = ON when the parent
   * has a live job. Ignored on an ordinary estimate.
   */
  addToCurrentJob?: boolean;
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

/**
 * Next house number. HARDENED 2026-08-25: this used to take the single
 * lexicographically-highest row and parse it — so one row with a number outside
 * the house format ("TEST-PAY-1" sorted above every "2026-…", parsed to NaN,
 * fell back to the floor) collided with an existing number and 500'd every
 * issue until the row was renamed. Broke production during Kyle's Stripe test.
 * Now only rows IN the house format are considered, and the numeric max is
 * taken across them — a foreign number can exist without being load-bearing.
 */
async function nextNumber(prisma: PrismaClient): Promise<string> {
  const rows = await prisma.issuedEstimate.findMany({
    where: { number: { startsWith: `${NUMBER_YEAR}-` } },
    select: { number: true },
  });
  const highest = rows.reduce((max, row) => {
    const parsed = Number(row.number.split("-")[1]);
    return Number.isFinite(parsed) && parsed > max ? parsed : max;
  }, NUMBER_FLOOR);
  return `${NUMBER_YEAR}-${highest + 1}`;
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
    option: EstimateOptionLetter;
    laborHours: number | null;
    materialSell: number | null;
    materialCost: number | null;
    /** Kyle's flat book price — informational, for the company copy. */
    flatPriced: boolean;
    /** Continuous-length material — the only lines the combination discount reads (2026-08-31). */
    inMaterialCap: boolean;
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
      flatPriced: l.flatPriced,
      // Frozen so the cap's scope at signing never depends on the live catalog's descriptions.
      inMaterialCap: l.inMaterialCap,
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
  const optionRows = ALL_OPTIONS
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
    // an invitation to ask what is missing from it. (This is also why walking all eight letters
    // is safe: only the options that actually hold lines become IssuedEstimateOption rows.)
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

  // ── P031: the generator one-pager, snapshot at issuance ──
  // Revision passes the previous snapshot through verbatim; a fresh issue with
  // includeGenerator looks up the newest recommendation at THIS address. No
  // recommendation on file is a stated refusal, not a silently thinner document.
  let generatorJson: string | null = input.generatorJson ?? null;
  if (generatorJson === null && input.includeGenerator) {
    const check = await prisma.capacityCheck.findFirst({
      where: { propertyId: input.serviceAddressId, generatorJson: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { generatorJson: true },
    });
    if (!check?.generatorJson) {
      return {
        ok: false,
        reasons: [
          "No generator sizing recommendation is on file for this address — run one from the load calculation in the field app first, or uncheck the attachment.",
        ],
      };
    }
    generatorJson = check.generatorJson;
  }

  /*
    THE QUOTED-ON VISIT (2026-09-06 review: "the severed cost chain"). The
    estimate's visitId is what lets hours clocked and receipts filed on the
    appointment merge onto the sold job — and 11 of 12 signed estimates had
    none, because the office intake starts from an account, not a visit. When
    the draft carries no visit, link the newest OPEN estimate-stage visit at
    this exact account + address (45-day window). Field quotes already link;
    a truly visit-less speculative draft stays unlinked, which is honest.
  */
  let linkedVisitId = draft.visitId;
  if (!linkedVisitId) {
    const candidate = await prisma.visit.findFirst({
      where: {
        customerId: input.accountId,
        propertyId: input.serviceAddressId,
        status: "estimate",
        completedAt: null,
        createdAt: { gte: new Date(Date.now() - 45 * 86_400_000) },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (candidate) {
      linkedVisitId = candidate.id;
      logSystemEvent("info", "issued-estimate", `Estimate auto-linked to its quoted-on visit`, {
        draftId: draft.id,
        visitId: candidate.id,
      });
    }
  }

  const number = await nextNumber(prisma);
  const token = newToken();

  /*
    ── A CHANGE ORDER JOINS ITS INVOICE (Kyle, 2026-09-20) ────────────────────────────────────
    The draft's `changeOrderForId` is FROZEN onto the issued row — the draft can be edited or
    unlinked later; the document cannot. It always names the ROOT invoice (the change-order route
    flattens a change order raised against a change order), so the money group is one level deep.
    The deposit defaults OFF for a change order and ON otherwise; "add to current job" defaults ON
    when the parent already has a job that is still live.
  */
  const parent = draft.changeOrderForId
    ? await prisma.issuedEstimate.findUnique({
        where: { id: draft.changeOrderForId },
        select: { id: true, changeOrderForId: true, jobVisitId: true },
      })
    : null;
  const changeOrderForId = parent ? (parent.changeOrderForId ?? parent.id) : null;
  const parentJob = parent?.jobVisitId
    ? await prisma.visit.findUnique({ where: { id: parent.jobVisitId }, select: { status: true } })
    : null;
  const parentJobLive = Boolean(parentJob && parentJob.status !== "cancelled" && parentJob.status !== "completed");
  const depositRequired = input.depositRequired ?? !changeOrderForId;
  const addToCurrentJob = changeOrderForId ? (input.addToCurrentJob ?? parentJobLive) : false;

  /*
    THE FINANCING PLANS, FROZEN WITH THE PRICES (2026-10-08, one estimating system, Phase 5).
    Kyle edits the Synchrony plan list in Settings as Synchrony changes rates; an estimate already
    in a customer's hands must keep the plans (and the monthly figures they produce) it was sent
    with - the same reason the band schedule is frozen below. Read once, before the transaction.
    Null when no plan is active: the estimate then offers no financing figures.
  */
  const financingPlansJson = await snapshotActiveFinancingPlansJson();

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
        visitId: linkedVisitId,
        customerName: context.customerName,
        customerEmail: context.customerEmail,
        customerPhone: context.customerPhone,
        serviceAddress: context.serviceAddress,
        title: (input.title ?? "").trim() || draft.title,
        scopeText: input.scopeText ?? draft.jobDescription ?? null,
        includedText: input.includedText ?? null,
        generatorJson,
        workSubtotal,
        tripCharge,
        tripWaived: Boolean(input.waiveTrip),
        total,
        createdBy: input.createdBy ?? "human:crm-session",
        changeOrderForId,
        depositRequired,
        addToCurrentJob,
        /*
          ── THE MATERIAL CHECK'S WORKING, AND THE SHORTER CLOCK (2026-08-21) ────────────────────

          The frozen lines above already carry the CAPPED material charge — the engine applied the
          job-level check before this function ever saw them. What is stored here is the check's
          working (cost, what the tiers wanted, the ceiling, the reduction) so the company copy can
          print it. An adjustment Kyle cannot see is one he cannot defend to a customer who asks.

          validDays: a flat 30, every estimate (Kyle, 2026-09-06: "The 30 day expiration is
          fine for both, we do not need to implement a 14 day for heavy material cost. Most of
          that heavy material is ordered and some of it even takes longer to get than 30 days.")
          The earlier 14-day fuse on $3k+ material quotes fought his own supply chain.
        */
        // The discount programme rides from the draft; the AMOUNT waits for the signature. The
        // custom percentage is frozen here (2026-09-01) — the draft can change, the document cannot.
        discountType: programmeFor(draft.discountType, draft.discountPercent)?.type ?? null,
        discountPercent: programmeFor(draft.discountType, draft.discountPercent)?.type === "custom" ? draft.discountPercent : null,
        // Option mode rides from the draft too (Kyle, 2026-08-25): exclusive
        // means the customer signs for exactly ONE option.
        exclusiveOptions: draft.exclusiveOptions,
        materialCapsJson:
          Object.keys(computed.materialCaps ?? {}).length > 0
            ? JSON.stringify(computed.materialCaps)
            : null,
        validDays: 30,
        // The band schedule in force right now, frozen with the prices it produced. Without this
        // a retune in Rate Config would restate the combination discounts on an estimate already
        // in a customer's hands.
        jobBandsJson: JSON.stringify(bandsFrom(rate.rc.jobBands)),
        // The Synchrony plans in force right now (rates included - SERVER-SIDE column, never selected
        // into a customer or field payload), so a Settings edit never changes a quote already sent.
        financingPlansJson,
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

/**
 * First view flips sent → viewed. Idempotent: only the FIRST view is recorded.
 *
 * A LOST estimate records nothing (2026-09-20): the link still reads, but a customer re-opening
 * an old quote must not un-lose it, write a "viewed" event on a closed decision, or page Kyle to
 * call about a price they already turned down. Reopen is the office's door, not the customer's.
 */
export async function recordFirstView(prisma: PrismaClient, estimateId: string): Promise<void> {
  const est = await prisma.issuedEstimate.findUnique({ where: { id: estimateId } });
  if (!est || est.firstViewedAt || est.signedAt || est.status === "lost") return;
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

  /*
    Kyle's heads-up, AFTER the record is durable and fire-and-forget (2026-08-22): the customer is
    looking at the price right now, which is when a call lands best. A notification failure must
    never fail the customer's page load — same rule as the signature notification.
  */
  void notifyOwnerViewed(prisma, estimateId).catch(() => {});
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
  /**
   * WHO HELD THE DEVICE (Phase 3 unit C, 2026-10-08). The customer's signature is the customer's;
   * this is the technician whose phone it was drawn on, so "signed in person" names the person who
   * was standing there ("tech:<id>"). Recorded in the signed event's detail and the system log only -
   * the event's actor stays "customer:in-person" (the signature is theirs). Absent on the office
   * door and the emailed link, whose records read exactly as before.
   */
  recordedBy?: string | null;
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
 * Reached only from a route inside a SIGNING-SCOPED session —
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
    ── THE 30 DAYS MEAN IT (Kyle, 2026-09-06) ──────────────────────────────────────────────────
    Every document prints "Valid N days" and until now nothing enforced it — a customer could
    sign a stale price sheet months later. Checked HERE, at the one write path both doors share,
    and by date arithmetic rather than the sweep's label, so a signature at 12:01 AM on day 31
    is refused even if the cron hasn't relabeled the row yet.
  */
  const validity = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: { createdAt: true, validDays: true, status: true },
  });
  // LOST is checked at the same shared write path, for the same reason as the 30 days (2026-09-20):
  // both doors — the emailed link and the operator's device — must refuse it, and the office
  // reopens it before anyone signs so the record reads "lost, then reopened, then signed".
  if (validity?.status === "lost") {
    return {
      ok: false,
      reason: "This estimate has been closed. Call Red Cedar Electric if you would like to move forward — we will reopen it for you.",
    };
  }
  if (validity) {
    const expiresAt = new Date(validity.createdAt.getTime() + validity.validDays * 86_400_000);
    if (Date.now() > expiresAt.getTime()) {
      return {
        ok: false,
        reason: `This estimate expired on ${expiresAt.toLocaleDateString("en-US", { timeZone: "America/Chicago" })} — material prices are no longer guaranteed. Call Red Cedar Electric for a current quote.`,
      };
    }
  }

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
    ── ONE-OR-THE-OTHER OPTIONS (Kyle, 2026-08-25) ─────────────────────────────────────────────

    "Since these are to help decide the location and not 3 different EV Chargers they cannot be
     additive." An exclusive estimate signs for exactly ONE option — signing for two lengths of
    the same wire run is not a sale, it is a mistake, and the guard lives here at the write so no
    client (page script, hand-edited form, in-person app) can produce it.
  */
  const modeRow = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: { exclusiveOptions: true },
  });
  if (modeRow?.exclusiveOptions && valid.size > 1 && bought.length !== 1) {
    return {
      ok: false,
      reason: "This estimate offers one-or-the-other options — please choose exactly one before accepting.",
    };
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
  // Only continuous-length material is in the cap (Kyle, 2026-08-31, "split the difference");
  // unit items keep their book price and contribute nothing to the band — same population the
  // engine used at issue, read off the frozen flag.
  const frozenLines = (await prisma.issuedEstimateLine.findMany({
    where: { estimateId },
    select: { option: true, materialCost: true, materialSell: true, inMaterialCap: true },
  })).map((l) => ({
    option: l.option,
    materialCost: l.inMaterialCap ? l.materialCost : null,
    materialSell: l.inMaterialCap ? l.materialSell : null,
  }));
  /*
    Priced with the schedule frozen AT ISSUE, not whatever Rate Config says today. The customer is
    signing the document they were shown; a band Kyle retuned in between is not part of it.
  */
  const issuedWith = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: {
      jobBandsJson: true,
      discountType: true,
      discountPercent: true,
      tripCharge: true,
      options: { select: { option: true, subtotal: true } },
    },
  });
  const frozenBands = issuedWith?.jobBandsJson
    ? (JSON.parse(issuedWith.jobBandsJson) as MarkupBand[])
    : undefined;
  const comboCap = selectionCap(frozenLines, new Set(bought), frozenBands);

  /*
    The programme discount, frozen with the same pen (2026-08-22). 5% of what they are actually
    paying — bought options + trip − combination discount — capped at $250. Computed here and
    nowhere else at signing time, from the same frozen figures every rendering surface reads.
  */
  /*
    Priced by the SAME pure function every screen uses (shared/quoteMoney.ts priceSelection, via
    frozenSelectionDiscount), which rounds the base to the cent before taking the percentage. The
    frozen discount therefore cannot differ by a cent from the figure the customer ticked and was
    shown on the page, the CRM Present screen or the phone (review finding, 2026-10-08).
  */
  const discount = frozenSelectionDiscount(
    {
      discountType: issuedWith?.discountType,
      discountPercent: issuedWith?.discountPercent,
      tripCharge: issuedWith?.tripCharge,
      options: issuedWith?.options ?? [],
    },
    bought,
    comboCap.applied ? comboCap.reduction : 0,
  );

  /*
    The signature and the invoice it takes over are ONE transaction (2026-09-21, PUNCHLIST A1):
    if this row is the signed revision of an estimate the customer had already signed, the old
    signed row's change orders, payments and job move here before anyone can read the new
    signature — see adoptSupersededInvoice. Either both happen or the customer sees an error and
    signs again; a signature recorded with the money left behind on a row nothing lists would be
    the defect this exists to remove.
  */
  const signed = await prisma.$transaction(async (tx) => {
    const result = await tx.issuedEstimate.updateMany({
      /*
        Every refusal that guards the WRITE lives in this one WHERE (review finding, 2026-10-08):
        unsigned, not void, not lost and not replaced by a newer revision. The reads above give
        the customer a friendly reason early, but a read is a snapshot — the office voiding,
        closing or revising this estimate in the gap between that read and this write must not
        let the signature land on it. Whichever condition failed is re-read below for the reason.
      */
      where: {
        id: estimateId,
        signedAt: null,
        status: { notIn: ["void", "lost"] },
        supersededBy: { is: null },
      },
      data: {
        selectedOptions: bought as never,
        comboCapJson: JSON.stringify(comboCap),
        discountJson: discount ? JSON.stringify(discount) : null,
        signedAt: new Date(),
        signatureImage: drawn.dataUrl,
        signerName: name,
        signerIp: input.ip ?? null,
        signerUserAgent: input.userAgent ?? null,
        consentText: CONSENT_TEXT,
        signedChannel: channel,
        status: "signed",
        // A signed row is never an archived row (services/estimateArchive.ts): archiving does
        // not block the customer's link, so a signature on a put-away estimate takes it back out
        // in the same write — "archived ⇒ unsigned" is what keeps archiving off every money surface.
        archivedAt: null,
        archivedReason: null,
      },
    });
    if (result.count === 0) return { signed: false as const, adopted: null };
    const adopted = await adoptSupersededInvoice(tx, estimateId, channel === "in_person" ? "customer:in-person" : "customer");
    return { signed: true as const, adopted };
  });
  if (!signed.signed) {
    // Which guard stopped the write? Say that, not a blanket "already signed".
    const now = await prisma.issuedEstimate.findUnique({
      where: { id: estimateId },
      select: { signedAt: true, status: true, supersededBy: { select: { id: true } } },
    });
    if (now && !now.signedAt) {
      if (now.supersededBy) return { ok: false, reason: "This estimate has been replaced by a newer revision." };
      if (now.status === "void") return { ok: false, reason: "This estimate is void." };
      if (now.status === "lost") {
        return {
          ok: false,
          reason: "This estimate has been closed. Call Red Cedar Electric if you would like to move forward — we will reopen it for you.",
        };
      }
    }
    return { ok: false, reason: "This estimate has already been signed." };
  }
  if (signed.adopted) {
    const a = signed.adopted;
    logSystemEvent("info", "issued-estimate", `Estimate ${number} rev ${revision} signed — took over the invoice from rev ${a.replaced.map((r) => r.revision).join(", ")}: ${a.changeOrders} change order(s), ${a.payments} payment(s), ${a.jobVisitId ? "same job" : "no job to inherit"}`, {
      estimateId,
      replacedEstimateIds: a.replaced.map((r) => r.id),
      changeOrders: a.changeOrders,
      payments: a.payments,
      jobVisitId: a.jobVisitId,
    });
  }

  const where = channel === "in_person" ? "in person on the operator's device" : "from the emailed link";
  await prisma.issuedEstimateEvent.create({
    data: {
      estimateId,
      type: "signed",
      actor: channel === "in_person" ? "customer:in-person" : "customer",
      detail: `Signed by "${name}" ${where} (rev ${revision}) from ${input.ip ?? "unknown IP"}${input.recordedBy ? ` - device held by ${input.recordedBy}` : ""}`,
    },
  });
  logSystemEvent("info", "issued-estimate", `Estimate ${number} signed by ${name} (${channel})`, {
    estimateId,
    revision,
    channel,
    ip: input.ip ?? null,
    recordedBy: input.recordedBy ?? null,
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

export interface AdoptedInvoice {
  /** The signed, live revisions this one replaced — normally exactly one. */
  replaced: { id: string; number: string; revision: number }[];
  changeOrders: number;
  payments: number;
  /** The job inherited from the replaced revision, when it had a live one. */
  jobVisitId: string | null;
}

/**
 * A SIGNED revision takes over the invoice of the signed revision it replaces (2026-09-21,
 * PUNCHLIST A1 — and the larger form of it: the old signed root vanished from /invoices the
 * moment a revision was created, and if the revision was then signed the P&L counted both).
 *
 * WHEN: at the new revision's signature, inside the signature's own transaction — never at
 * revise time. Until the revision is signed the OLD row is the only agreement the customer has
 * signed: it stays the invoice, its change orders stay on it, its deposit stays on it, and the
 * job stays its job. Re-pointing anything at an unsigned draft would hide it all behind a row
 * /invoices does not list — and if the draft were never signed, hang real money off a document
 * nobody agreed to.
 *
 * WHAT MOVES, all by the same rule ("the invoice is the newest SIGNED revision of the number"):
 *   - change orders: `changeOrderForId` now names this row, which is the ROOT (constants: the
 *     column always names the root — and the root changed);
 *   - payments: `Payment.estimateId` now names this row, the way a new payment recorded against
 *     a change order is written on the root — the money sits on the live root by construction,
 *     so every reader (paymentSummary, /invoices, GET /jobs, the account, the receipts) sees it
 *     without knowing about revisions;
 *   - the job: this row takes the old revision's `jobVisitId` when that job is still live, and
 *     the job's "contracted for" figure moves by the difference between the two totals. A
 *     completed or cancelled job is not inherited — createJobFromSignedEstimate then mints a
 *     fresh one, exactly as it does for a change order whose parent's job is gone.
 *   - the old revision is VOIDED with the reason written down. Void is the one status a signed
 *     row may move to (PUNCHLIST A9's allow-list rests on that), it is already excluded from
 *     every money surface, and a superseded signed document is a dead document — the vocabulary
 *     the lost migration wrote down ("void is ... wrong price, superseded, job cancelled").
 *
 * Unsigned revisions between the two (a draft re-issued several times before it was sent) are
 * walked through; a replaced revision that is already void (Kyle voided it, then revised it)
 * has nothing live to hand over and is left alone. Idempotent per signature: a row is signed
 * once, so this runs once for it.
 */
export async function adoptSupersededInvoice(
  tx: Prisma.TransactionClient,
  estimateId: string,
  actor: string,
): Promise<AdoptedInvoice | null> {
  const select = { id: true, number: true, revision: true, total: true, signedAt: true, voidedAt: true, status: true, jobVisitId: true, supersedesId: true } as const;
  const me = await tx.issuedEstimate.findUnique({ where: { id: estimateId }, select });
  if (!me?.supersedesId) return null;

  const chain: (typeof me)[] = [];
  let cursor = me;
  for (let hop = 0; cursor.supersedesId && hop < 25; hop += 1) {
    const prev = await tx.issuedEstimate.findUnique({ where: { id: cursor.supersedesId }, select });
    if (!prev) break;
    chain.push(prev);
    cursor = prev;
  }
  const replaced = chain.filter((r) => r.signedAt && !r.voidedAt && r.status === "signed");
  if (replaced.length === 0) return null;
  const replacedIds = replaced.map((r) => r.id);

  const [changeOrders, payments, financingFees] = await Promise.all([
    tx.issuedEstimate.updateMany({ where: { changeOrderForId: { in: replacedIds } }, data: { changeOrderForId: me.id } }),
    tx.payment.updateMany({ where: { estimateId: { in: replacedIds } }, data: { estimateId: me.id } }),
    // The financing fee (2026-10-09, services/financingFee.ts) is owed on the INVOICE, so it
    // moves with it the way the payments do — the live one and the removed history alike. Its
    // base was the OLD revision's balance; if the revision changed the price the office removes
    // it and adds it again on the new balance (the panel shows the base beside the fee).
    tx.financingFee.updateMany({ where: { estimateId: { in: replacedIds } }, data: { estimateId: me.id } }),
  ]);

  // The job: the nearest replaced revision's, if it is still live.
  let jobVisitId: string | null = null;
  const donor = replaced.find((r) => r.jobVisitId);
  if (donor?.jobVisitId) {
    const job = await tx.visit.findUnique({ where: { id: donor.jobVisitId }, select: { id: true, status: true, estimatedCost: true } });
    if (job && job.status !== "cancelled" && job.status !== "completed") {
      await tx.issuedEstimate.update({ where: { id: me.id }, data: { jobVisitId: job.id } });
      await tx.visit.update({
        where: { id: job.id },
        data: { estimatedCost: Math.round(((job.estimatedCost ?? 0) - donor.total + me.total) * 100) / 100 },
      });
      jobVisitId = job.id;
    }
  }

  const now = new Date();
  const summary = `${changeOrders.count} change order(s), ${payments.count} payment(s)${financingFees.count > 0 ? `, ${financingFees.count} financing fee record(s)` : ""}${jobVisitId ? ", the job" : ""}`;
  await tx.issuedEstimate.updateMany({
    where: { id: { in: replacedIds } },
    data: { status: "void", voidedAt: now, voidReason: `Replaced by signed revision ${me.revision} — its ${summary} moved there.` },
  });
  await tx.issuedEstimateEvent.createMany({
    data: [
      ...replaced.map((r) => ({
        estimateId: r.id,
        type: "voided",
        actor,
        detail: `Rev ${me.revision} was signed and took over this invoice: ${summary} now sit on rev ${me.revision}.`,
      })),
      {
        estimateId: me.id,
        type: "invoice_taken_over",
        actor,
        detail: `Took over the invoice from rev ${replaced.map((r) => r.revision).join(", ")}: ${summary}.`,
      },
    ],
  });
  return { replaced: replaced.map((r) => ({ id: r.id, number: r.number, revision: r.revision })), changeOrders: changeOrders.count, payments: payments.count, jobVisitId };
}

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
  opts: {
    actor?: string;
    waiveTrip?: boolean;
    /**
     * Refuse a SIGNED estimate with this sentence — checked here, and again under a row lock at
     * the moment of the supersede (review finding, 2026-10-09: `issueDraft` read signedAt once,
     * then this function re-read the row without refusing signed, so a customer signing in the
     * gap had the just-signed agreement superseded by an unsigned copy — the exact thing ruling 1
     * exists to prevent). Both Issue doors pass it; the office's own Revise button does not, so a
     * signed estimate can still be revised from there.
     */
    refuseSignedWith?: string;
  } = {}
): Promise<GraduateResult> {
  const prev = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    include: { supersededBy: { select: { id: true } } },
  });
  if (!prev) return { ok: false, reasons: [`Estimate ${estimateId} not found.`] };
  if (prev.supersededBy) {
    return { ok: false, reasons: ["That estimate has already been superseded by a newer revision."] };
  }
  if (opts.refuseSignedWith && prev.signedAt) {
    return { ok: false, reasons: [opts.refuseSignedWith] };
  }
  // LOST (2026-10-08): Kyle's standing rule is that Reopen is the way back. A revision made behind
  // a lost row would leave the row and its reason standing with a live estimate on top of it that
  // nobody marked reopened. The refusal lives HERE, not in issueDraft, because both buttons reach
  // this function — the builder's "Save changes to the estimate" (POST /issued-estimates/:id/revise)
  // and, through issueDraft, the Issue buttons in both apps — and a rule that only one of them
  // carried would be the two-decisions problem this move exists to end. A SIGNED estimate is
  // deliberately NOT refused here: revising it is how the office changes the trip charge,
  // warranty or discount on a signed estimate (the customer signs the new revision again).
  if (prev.status === "lost") {
    return { ok: false, reasons: [lostReopenReason(prev.number)] };
  }

  const graduated = await graduateDraft(prisma, {
    draftId: prev.draftId,
    // A revision stays on the same account and the same address. Changing either is not a
    // revision of this estimate — it is a different estimate for a different job.
    accountId: prev.customerId,
    serviceAddressId: prev.serviceAddressId,
    // The TITLE and the SCOPE come from the DRAFT, as on a first issue (2026-10-08, Phase 2):
    // both apps can now edit them on the draft (setDraftDetails), and like a changed line or the
    // discount they reach the customer only through this revision. Until now the previous
    // document's were copied forward, so a renamed draft never reached anyone. Null here means
    // graduateDraft reads draft.title / draft.jobDescription.
    title: null,
    scopeText: null,
    includedText: prev.includedText,
    // A revision keeps what the previous document carried — including the
    // generator one-pager the customer already saw (P031).
    generatorJson: prev.generatorJson,
    waiveTrip: opts.waiveTrip ?? prev.tripWaived,
    // The deposit flag and "add to current job" ride the revision too (2026-09-20) — a
    // revision changes the work, not the terms Kyle set when he issued it.
    depositRequired: prev.depositRequired,
    addToCurrentJob: prev.addToCurrentJob,
    createdBy: opts.actor ?? "human:crm-session",
  });
  if (!graduated.ok) return graduated;

  // Re-key the new row onto the SAME house number, one revision up, and link the chain.
  /**
   * THE SUPERSEDE IS CHECKED AGAIN UNDER A ROW LOCK (review finding, 2026-10-09). graduateDraft
   * above ran outside any transaction, so the previous row may have changed since `prev` was
   * read: a customer may have SIGNED it (the signature's own write refuses a superseded row, so
   * whichever of the two commits first wins — this is the losing side's refusal), or another
   * revise may have superseded it. Either way the row built above must not become its revision:
   * it is unlinked, unnumbered and seconds old, never sent and never seen — it is rolled back
   * (deleted, children cascade) and the caller gets the refusal it would have had.
   */
  class SupersedeRefused extends Error {
    constructor(public readonly reason: string) { super(reason); }
  }
  let next: { id: string; number: string; revision: number };
  try {
    next = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "IssuedEstimate" WHERE "id" = ${prev.id} FOR UPDATE`;
      const locked = await tx.issuedEstimate.findUniqueOrThrow({
        where: { id: prev.id },
        select: { signedAt: true, supersededBy: { select: { id: true } } },
      });
      if (locked.supersededBy) throw new SupersedeRefused("That estimate has already been superseded by a newer revision.");
      if (opts.refuseSignedWith && locked.signedAt) throw new SupersedeRefused(opts.refuseSignedWith);
      return linkRevision(tx, prev, graduated.estimateId, opts.actor);
    });
  } catch (err) {
    if (!(err instanceof SupersedeRefused)) throw err;
    await prisma.issuedEstimate.delete({ where: { id: graduated.estimateId } });
    logSystemEvent("warn", "issued-estimate", `Revision of ${prev.number} refused at the supersede — the estimate changed while the revision was being built; the unlinked revision was rolled back`, {
      estimateId: prev.id, rolledBackEstimateId: graduated.estimateId, reason: err.reason, actor: opts.actor ?? "human:crm-session",
    });
    return { ok: false, reasons: [err.reason] };
  }

  return { ok: true, estimateId: next.id, number: next.number, revision: next.revision };
}

/** Re-key the graduated row onto the previous one's house number, one revision up, and link the chain. */
async function linkRevision(
  tx: Prisma.TransactionClient,
  prev: { id: string; number: string; revision: number; warrantyJson: string | null },
  estimateId: string,
  actor: string | undefined,
): Promise<{ id: string; number: string; revision: number }> {
  const updated = await tx.issuedEstimate.update({
    where: { id: estimateId },
    select: { id: true, number: true, revision: true },
    data: {
      number: prev.number,
      revision: prev.revision + 1,
      supersedesId: prev.id,
      // The home-warranty claim rides the revision (Kyle, 2026-09-09): same claim number, same
      // authorization — a revision changes the WORK, not who is paying for it. The credit is
      // re-capped live against the new figures, and the new revision is unsigned, so Kyle can
      // change or clear it there (that is what "revise to change coverage after signing" means).
      warrantyJson: prev.warrantyJson,
    },
  });
  await tx.issuedEstimateEvent.create({
    data: {
      estimateId: prev.id,
      type: "superseded",
      actor: actor ?? "human:crm-session",
      detail: `Superseded by ${prev.number} rev ${prev.revision + 1}. This revision's link no longer opens.`,
    },
  });
  return updated;
}

// ─── ISSUE: ONE DECISION FOR BOTH DOORS (Kyle, 2026-10-08, "one estimating system") ───────────

/**
 * The refusals the issue door and the revise door share, worded ONCE. `getDraftLifecycle` hands the
 * same sentence to a screen as `reviseReason`, so it greys its button with the exact words the
 * server would answer with.
 *
 * ── CHANGING A SIGNED ESTIMATE IS OFFICE ONLY (Kyle, 2026-10-09, ruling 1) ───────────────────
 * "Save changes to the estimate" on a SIGNED estimate is a deliberate CRM-only power, in the same
 * family as void and mark-lost. The OFFICE revises it (reviseEstimate, POST /issued-estimates/:id/
 * revise - the customer signs the new revision); the FIELD is refused, in FIELD_SIGNED_REVISE_REASON
 * (shared/draftLifecycle.ts), and the phone offers "Raise a change order" for new work instead.
 *
 * This sentence is the office's ISSUE-route refusal only (POST /price-book/drafts/:id/issue): Issue
 * would replace the signed agreement with an unsigned copy of itself, so it points at the revise
 * button that does the job.
 */
export function signedReissueReason(est: { number: string; revision: number }): string {
  return (
    `Estimate ${est.number} rev ${est.revision} from this draft is SIGNED. Issuing again would replace the signed ` +
    `agreement with an unsigned copy - press "Save changes to the estimate" on the estimate to revise it ` +
    `(the customer signs the new revision), or raise a change order for new work.`
  );
}
/** Which app is asking: the office (CRM) or the truck (field). Only the SIGNED-revise rule differs between them. */
export type EstimateDoor = "crm" | "field";
/** The SIGNED refusal for a door: the field gets Kyle's exact sentence; the office is not refused on a revise. */
export function signedReviseReasonFor(door: EstimateDoor): string | null {
  return door === "field" ? FIELD_SIGNED_REVISE_REASON : null;
}
export function lostReopenReason(number: string): string {
  return `Estimate ${number} is marked lost — reopen it before changing or issuing it again.`;
}

/**
 * The three checkboxes the issue step carries, validated ONCE for both doors (2026-10-08, Phase 2
 * unit E). The CRM's POST /price-book/drafts/:draftId/issue extends this with the account/address
 * it needs from the operator; the tech's POST /health-record/quotes/:draftId/issue takes it as is
 * (the account and address come from the visit). Same words, same defaults, same refusals:
 *   - depositRequired: absent = ON for an estimate, OFF for a change order.
 *   - includeGenerator (P031): attach the generator sizing one-pager from this address's field
 *     assessment. Absent = off. Refused with "No generator sizing recommendation is on file ..."
 *     when the address has none (graduateDraft) - never a silent no-op.
 *   - addToCurrentJob: change orders only; absent = ON when the parent job is still live. The
 *     service ignores it on an ordinary estimate.
 * All three take effect on the FIRST issue only; a revision carries the previous document's values.
 */
export const issueExtrasBodySchema = z.object({
  depositRequired: z.boolean().optional(),
  includeGenerator: z.boolean().optional(),
  addToCurrentJob: z.boolean().optional(),
});

export interface IssueDraftInput {
  draftId: string;
  /** The spine (P029) — both required on a FIRST issue; a revision keeps the previous estimate's. */
  accountId: string;
  serviceAddressId: string;
  title?: string | null;
  scopeText?: string | null;
  includedText?: string | null;
  /** Absent on a revision means "what the previous document carried"; on a first issue, false. */
  waiveTrip?: boolean;
  includeGenerator?: boolean;
  depositRequired?: boolean;
  addToCurrentJob?: boolean;
  /** "human:crm-session" from the office, "tech:<id>" from the driveway. */
  actor: string;
  /**
   * Which app is asking (default "crm"). Decides only the wording of the SIGNED refusal - the field
   * gets FIELD_SIGNED_REVISE_REASON (Kyle, 2026-10-09, ruling 1: changing a signed estimate is office
   * only), the office's Issue route points at "Save changes to the estimate". Both are refused.
   */
  door?: EstimateDoor;
  /**
   * What a REVISION records as its author, when that differs from `actor`. The field's Issue route
   * has always written `tech:<name>` on the revision and `tech:<id>` on a first issue; collapsing
   * the two into one actor on 2026-10-08 silently changed the audit trail of every field
   * re-issue (review finding), so the route passes both and the stored values stay as they were.
   */
  reviseActor?: string;
}

/**
 * Issue a draft — as a NEW estimate, or as a REVISION of the one it already has.
 *
 * ── ISSUING A DRAFT THAT IS ALREADY ISSUED IS A REVISION, NOT A SECOND ESTIMATE ───────────────
 *
 * Kyle, 2026-08-20: the estimator "is filled with redundancies and duplicate paths", and he
 * asked for an Edit button that reopens an unfinished estimate in the builder.
 *
 * Those two things collide here. Without this branch, editing a draft and pressing Issue again
 * minted a BRAND NEW estimate number for the same job — so the account grew a second row, the
 * first one stayed live with its own working customer link, and nothing recorded that they were
 * the same quote. The Edit button would have put that one tap away.
 *
 * A draft has one live estimate at a time. Re-issuing it supersedes what was there: same house
 * number, revision up, the old link dead so a customer cannot sign a version Kyle has replaced.
 *
 * The guard lives HERE and not in graduateDraft because reviseEstimate calls graduateDraft — a
 * check inside it would recurse forever.
 *
 * ── ONE DECISION, TWO DOORS (2026-10-08) ─────────────────────────────────────────────────────
 *
 * The CRM's POST /price-book/drafts/:draftId/issue and the tech's POST /quotes/:draftId/issue
 * each carried their own copy of the "live" lookup, and "live" excluded only void — so a SIGNED
 * or a LOST estimate counted as live and pressing Issue quietly revised it. Two refusals now,
 * the same from either door:
 *
 *   SIGNED — the draft is shut (`reopenForEditIfUnsigned`), so nothing on it can have changed;
 *   re-issuing could only supersede a signed agreement with an unsigned copy of itself and kill
 *   the customer's signed link. The office's own Revise button (POST /issued-estimates/:id/revise
 *   → reviseEstimate) is the deliberate way to change the trip charge or warranty on a signed
 *   estimate and is NOT this path; Issue is "publish my edits", and there are none.
 *   (2026-10-08 review: "there are none" is not quite true. The discount, option names, option mode,
 *   title and scope stay editable on a signed draft - signedStaysEditable, Kyle 2026-09-29 - and
 *   only the office's Revise button can publish them. So the SAME label, "Save changes to the
 *   estimate", proceeds in the CRM and is refused here for the truck. That split is deliberate in
 *   the code and an OPEN RULING for Kyle: allow it on both doors, or refuse it on both. It is not
 *   decided in this file.)
 *
 *   LOST — Kyle's standing rule is that Reopen is the way back. Superseding a lost quote from the
 *   builder would leave the lost row and its reason behind a revision nobody marked reopened.
 *   Same door the change-order rule names: reopen it first. The refusal itself is in
 *   `reviseEstimate`, which this calls — so the builder's "Save changes to the estimate" (which
 *   calls `reviseEstimate` directly) is refused for the same reason, in the same words.
 */
/** The estimate a draft's Issue button would REVISE — the one lookup `issueDraft` and `getDraftLifecycle` share. */
async function liveEstimateOfDraft(prisma: PrismaClient, draftId: string) {
  return prisma.issuedEstimate.findFirst({
    where: { draftId, supersededBy: null, status: { not: "void" } },
    orderBy: { revision: "desc" },
    select: { id: true, number: true, revision: true, signedAt: true, status: true, archivedAt: true },
  });
}

export async function issueDraft(prisma: PrismaClient, input: IssueDraftInput): Promise<GraduateResult> {
  const live = await liveEstimateOfDraft(prisma, input.draftId);

  const signedRefusal = (est: { number: string; revision: number }) =>
    input.door === "field" ? FIELD_SIGNED_REVISE_REASON : signedReissueReason(est);
  if (live?.signedAt) {
    // Refused on BOTH doors (Issue would supersede a signed agreement with an unsigned copy). The
    // office has its own deliberate way in (reviseEstimate); the field has none - ruling 1.
    return { ok: false, reasons: [signedRefusal(live)] };
  }
  if (live) {
    // The same refusal is checked AGAIN under a row lock at the supersede (reviseEstimate): this
    // read is a snapshot, and a customer signing between it and the supersede must win.
    return reviseEstimate(prisma, live.id, { actor: input.reviseActor ?? input.actor, waiveTrip: input.waiveTrip, refuseSignedWith: signedRefusal(live) });
  }
  // A title or scope handed to the issue route is written onto the DRAFT first (2026-10-08, Phase
  // 2): the draft's title and jobDescription are the estimate's — graduateDraft reads them, every
  // revision re-reads them (reviseEstimate), and both apps edit them there (setDraftDetails). Kept
  // on the route for the callers that always sent one; it no longer bypasses the record.
  const title = (input.title ?? "").trim();
  if (title || input.scopeText !== undefined) {
    await prisma.priceBookDraftEstimate.update({
      where: { id: input.draftId },
      data: {
        ...(title ? { title } : {}),
        ...(input.scopeText !== undefined ? { jobDescription: (input.scopeText ?? "").trim() || null } : {}),
      },
    });
  }
  return graduateDraft(prisma, {
    draftId: input.draftId,
    accountId: input.accountId,
    serviceAddressId: input.serviceAddressId,
    title: null,
    scopeText: null,
    includedText: input.includedText ?? null,
    waiveTrip: input.waiveTrip ?? false,
    // P031: the operator chose to attach the generator one-pager (the human approval; the
    // field tech's include flag proposed it).
    includeGenerator: input.includeGenerator ?? false,
    depositRequired: input.depositRequired,
    addToCurrentJob: input.addToCurrentJob,
    createdBy: input.actor,
  });
}

/**
 * Where a draft stands — for BOTH apps, from ONE lookup (2026-10-08, Phase 2 unit B;
 * shared/draftLifecycle.ts has the field-by-field contract).
 *
 * `issued` is exactly the estimate `issueDraft` would revise (`liveEstimateOfDraft`), so what a
 * screen says will happen on the press and what the press does cannot disagree. `reviseReason` is
 * the sentence the press would be refused with FOR THIS DOOR (signed: field only; lost: both), and
 * `deleteReason` is the draft-side rule from atomicEstimateService. Carried in the CRM's review and
 * compute payloads and the field's quote payload; the presentation screen reads it to stop issuing
 * a fresh revision on every press.
 */
export async function getDraftLifecycle(prisma: PrismaClient, draftId: string, door: EstimateDoor = "crm"): Promise<DraftLifecycle> {
  const draft = await prisma.priceBookDraftEstimate.findUnique({ where: { id: draftId }, select: { status: true } });
  if (!draft) throw new DraftError(`Draft ${draftId} not found.`, 404);
  const live = await liveEstimateOfDraft(prisma, draftId);
  const issued: DraftLifecycleIssued | null = live
    ? {
        estimateId: live.id,
        number: live.number,
        revision: live.revision,
        status: live.status,
        signedAt: live.signedAt?.toISOString() ?? null,
        archived: live.archivedAt !== null,
        customerUrl: null,
      }
    : null;
  return {
    status: draft.status,
    issued,
    hasUnsavedChanges: issued !== null && draft.status === "draft",
    // SIGNED: office-only power (ruling 1) - null for the CRM (reviseEstimate allows it), Kyle's sentence for the field.
    reviseReason: !live ? null : live.signedAt ? signedReviseReasonFor(door) : live.status === "lost" ? lostReopenReason(live.number) : null,
    deleteReason: await draftDeleteReason(prisma, draftId),
    copyReason: await draftCopyReason(prisma, draftId),
  };
}

// ─── CHANGE ORDER — a new draft under a signed estimate, from either door ─────────────────────

export type ChangeOrderDraftResult =
  | { ok: true; draftId: string; changeOrderFor: string; /** An open change order was reopened; nothing new was made. */ resumed: boolean }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Open a change-order draft against a signed estimate - or REOPEN the one already open.
 *
 * Kyle, 2026-08-19: "additional sections that add the work or remove the work". A change order is
 * its own document with its own signature, raised against the estimate the customer signed, so
 * the extra work is agreed in writing rather than tacked onto the job a second time. It inherits
 * the account, the address and the job, so the change lands on the work it belongs to.
 *
 * The signed estimate is not touched. It is refused outright if it was never signed, because the
 * thing to do with an unsigned estimate is edit it.
 *
 * ONE RULE FOR BOTH DOORS (Phase 3 unit C, 2026-10-08): "Raise a change order" in the office
 * (POST /issued-estimates/:id/change-order) and in the field (POST /health-record/visits/:visitId/
 * change-order, through raiseChangeOrderForVisit) both land here, and both REOPEN the change order
 * that is already open for the invoice instead of starting a second. Before this the field reopened
 * and the office always created, so pressing the office button twice (or once after the tech had
 * started one) stacked empty drafts on the same invoice. "Open" is openChangeOrderDraft below.
 *
 * WHERE A NEW ONE IS FILED is the one thing the doors still do differently, on purpose: the office
 * files it on the JOB (the default); the field files it on the visit the technician is standing on
 * (`opts.visitId`), exactly as a diagnostic's resolutions change order is (diagnosticReport.ts:
 * `visitId: report.visitId`) - right after a signature the job is a freshly minted visit nobody is
 * assigned to yet, and the Quote screen answers 403 on a draft whose visit is not the tech's.
 * When the open change order is on some OTHER visit than the one the technician stands on, the
 * field door asks the one question the Quote screen itself asks (quoteDraftForTech): is THIS
 * technician assigned to the visit the draft is filed on? If so it reopens the draft - the phone can
 * open it, so the refusal would be wrong (a tech who raised it on the estimate visit and now stands
 * on the job visit is the ordinary case). If not, starting a second would stack two on one invoice
 * and this phone cannot open the first, so the field door is told so, in words that do not guess who
 * started it; the office door (no visit named) opens it wherever it is.
 *
 * Moved out of the CRM route on 2026-10-08 so the field can raise one from the job with the same
 * rules (Phase 2 item 12). The wording and status codes of every refusal are preserved verbatim -
 * the client greys its button with these same reasons.
 */
export async function createChangeOrderDraft(
  prisma: PrismaClient,
  estimateId: string,
  /** File a NEW draft on THIS visit instead of the job (the field's door). See above. */
  opts: { visitId?: string; /** The technician on the phone: may reopen an open draft filed on ANY visit they are assigned to. */ technicianId?: string } = {},
): Promise<ChangeOrderDraftResult> {
  const target = await resolveChangeOrderTarget(prisma, estimateId);
  if (!target.ok) return target;
  const { est, root } = target;

  const open = await openChangeOrderDraft(prisma, root.id);
  if (open) {
    if (opts.visitId && open.visitId !== opts.visitId) {
      // The field's own access rule, not visit equality: assigned to the visit the draft is filed on
      // = this phone can open it (quoteDraftForTech), so reopen it rather than refuse.
      const canOpen =
        opts.technicianId && open.visitId
          ? await prisma.visitAssignment.findFirst({
              where: { visitId: open.visitId, technicianId: opts.technicianId },
              select: { id: true },
            })
          : null;
      if (!canOpen) {
        return {
          ok: false,
          status: 409,
          error: `A change order for ${root.number} is already open on a visit you are not assigned to, so this phone cannot open it. Ask the office to finish it or delete it, then raise a new one.`,
        };
      }
    }
    return { ok: true, draftId: open.id, changeOrderFor: root.number, resumed: true };
  }

  const draft = await prisma.priceBookDraftEstimate.create({
    data: {
      title: `Change order — ${root.number}`,
      changeOrderForId: root.id,
      // The draft's spine mirrors the estimate's: same account, same job. The address lives on
      // the issued estimate rather than the draft, and graduation re-derives it there.
      customerId: root.customerId,
      visitId: opts.visitId ?? target.visitId,
      // Same default the ordinary create-draft route uses: the configured active supplier,
      // falling back to HD. A change order prices against today's supplier, not the one that was
      // active when the original was signed — the material is bought now.
      supplierId:
        (await prisma.priceBookRateConfig.findUnique({ where: { key: "activeSupplier" } }))?.textValue ?? "HD",
    },
  });

  logSystemEvent("info", "issued-estimate", `Change order raised against ${est.number}`, {
    estimateId: est.id,
    draftId: draft.id,
  });

  return { ok: true, draftId: draft.id, changeOrderFor: root.number, resumed: false };
}

/**
 * The change-order draft that is still OPEN for an invoice, or null: the newest draft raised
 * against this root that has not been signed and has not been lost. "Open" means a draft that has
 * not been issued, or whose live estimate is still waiting on the customer. Not open: one issued
 * and then voided/superseded away (finished), one signed (done), one the office marked lost
 * (closed), and a diagnostic's own resolutions change order - that one is reached from its
 * diagnostic, by id, and arrives pre-seeded with the outlets found beyond the quote.
 */
async function openChangeOrderDraft(
  prisma: PrismaClient,
  rootId: string,
): Promise<{ id: string; visitId: string | null } | null> {
  const drafts = await prisma.priceBookDraftEstimate.findMany({
    where: { changeOrderForId: rootId },
    orderBy: { createdAt: "desc" },
    select: { id: true, visitId: true },
    take: 10,
  });
  for (const d of drafts) {
    if ((await prisma.diagnosticReport.count({ where: { changeOrderDraftId: d.id } })) > 0) continue;
    const live = await liveEstimateOfDraft(prisma, d.id);
    const everIssued = await prisma.issuedEstimate.count({ where: { draftId: d.id } });
    if (everIssued > 0 && !live) continue; // issued, then voided/superseded away: finished
    if (live?.signedAt || live?.status === "lost") continue; // done, or the office closed it
    return d;
  }
  return null;
}

type IssuedEstimateRow = NonNullable<Awaited<ReturnType<PrismaClient["issuedEstimate"]["findUnique"]>>>;

/**
 * THE RULES for raising a change order against an estimate, and where the new draft will be
 * filed — one place, so the CRM's button and the field's button cannot disagree about either.
 * Refuses (404/409) a missing, never-signed, void or lost estimate; resolves to the ROOT invoice;
 * and names the visit the draft lands on (the root's job, else its visit).
 */
async function resolveChangeOrderTarget(
  prisma: PrismaClient,
  estimateId: string,
): Promise<
  | { ok: true; est: IssuedEstimateRow; root: IssuedEstimateRow; visitId: string | null }
  | { ok: false; status: 404 | 409; error: string }
> {
  const est = await prisma.issuedEstimate.findUnique({ where: { id: estimateId } });
  if (!est) return { ok: false, status: 404, error: "Estimate not found" };
  if (!est.signedAt) {
    return {
      ok: false,
      status: 409,
      error: "That estimate has not been signed. Change orders are for work already agreed — edit the estimate instead.",
    };
  }
  /*
    A VOID OR LOST INVOICE TAKES NO NEW WORK (2026-09-29).

    `signedAt` survives a void — the signature happened, and the audit trail keeps it — so the
    signed-only guard above let a change order be raised against an invoice that is off the
    books. Its money would roll into a root that `loadInvoiceGroup` deliberately refuses to
    group (services/invoiceGroup.ts: a void parent means the change order "stands alone as its
    own invoice, honestly"), so the work would be agreed against nothing.

    Added when this action moved onto the job, estimate and invoice drawers, which is the first
    time a surface showing a VOID record could reach it. The client greys the button with this
    same reason; this is the server saying no regardless of which surface asked.
  */
  if (est.status === "void" || est.voidedAt) {
    return {
      ok: false,
      status: 409,
      error: "That invoice is void — a voided record takes no new work. Issue a new estimate instead.",
    };
  }
  if (est.status === "lost") {
    return {
      ok: false,
      status: 409,
      error: "That estimate is marked lost — reopen it before raising a change order against it.",
    };
  }

  // Always the ROOT invoice (2026-09-20): a change order raised against a change order joins
  // the same invoice as its parent, so the money group stays one level deep.
  const rootId = est.changeOrderForId ?? est.id;
  const root = rootId === est.id ? est : (await prisma.issuedEstimate.findUnique({ where: { id: rootId } })) ?? est;
  return { ok: true, est, root, visitId: root.jobVisitId ?? root.visitId ?? est.jobVisitId ?? est.visitId };
}

export type FieldChangeOrderResult = ChangeOrderDraftResult;

/**
 * "Raise a change order" from the job in the field (Phase 2 unit E, 2026-10-08).
 *
 * The technician is standing on a VISIT, not looking at an estimate id (the job brief never
 * carries one), so this finds the estimate the way the brief does - the job's live signed ROOT
 * (signedRootForJob) - and hands it to createChangeOrderDraft, the same function and the same
 * rules the CRM's button runs, INCLUDING reopening a change order that is already open instead of
 * starting a second (Phase 3 unit C moved that rule into the shared function). When no live signed
 * root exists it still names the newest estimate on the visit so the refusal is the real one
 * (unsigned / void / lost) and not a generic "nothing".
 *
 * The only difference from the office's door is where a NEW draft is filed: on THE VISIT THE
 * TECHNICIAN IS ON, not on the signed job (see createChangeOrderDraft for why).
 */
export async function raiseChangeOrderForVisit(
  prisma: PrismaClient,
  visitId: string,
  /** The technician pressing the button - lets an open change order on another of THEIR visits be reopened. */
  technicianId?: string,
): Promise<FieldChangeOrderResult> {
  const signed = await signedRootForJob(prisma, visitId);
  const against =
    signed?.id ??
    (
      await prisma.issuedEstimate.findFirst({
        where: { OR: [{ visitId }, { jobVisitId: visitId }], supersededBy: null },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      })
    )?.id;
  if (!against) {
    return {
      ok: false,
      status: 409,
      error: "Nothing has been quoted on this job yet. Change orders are for work already agreed - build the quote first.",
    };
  }
  return createChangeOrderDraft(prisma, against, { visitId, technicianId });
}

