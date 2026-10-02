/**
 * The two emails in the send-and-sign loop. (P027)
 *
 *   1. `sendEstimateEmail`  — OPERATOR-TRIGGERED, to the customer, carrying the tokenized link.
 *   2. `notifyOwnerSigned`  — INTERNAL, to SUMMARY_EMAIL, when a customer signs.
 *
 * ── WHY THIS IS NOT BEHIND `automationGate` ────────────────────────────────────────────────
 *
 * The 2026-08-11 manual-first deferral gates AUTOMATED customer sends: the 8 AM reminder cron,
 * booking confirmations, the web-lead auto-reply, inbound auto-replies. All four share one
 * property — they fire without a human deciding, in response to a clock or a webhook.
 *
 * Kyle's 2026-08-17 ruling orders something different: *"I can email the customer and have them
 * sign an estimate in the app."* A send that happens because Kyle tapped Send, on one estimate he
 * is looking at, after a confirm. That is not automation; it is the operator using the tool.
 *
 * So `sendEstimateEmail` is deliberately NOT a member of the `CustomerSendWorkflow` union and
 * `AUTOMATED_CUSTOMER_SENDS` is neither read nor written by this file. The gate stays exactly as
 * P013/P017 left it. What replaces the gate as the safety property is the CALLER, and the property
 * is this: **every caller is an authenticated route handler acting on a human's tap. Nothing
 * scheduled, retried or webhook-driven may call it.**
 *
 * There are TWO callers as of 2026-10-01, and the count matters enough to keep accurate here —
 * a security review (2026-10-01) caught this comment still claiming "exactly one", which is the
 * kind of invariant drift that lets a third, automated caller look permissible later:
 *   1. `POST /issued-estimates/:id/send` (src/app.ts) — the operator's Send button, behind the
 *      PIN gate, after a confirm.
 *   2. `POST /health-record/issued-estimates/:id/email` (src/routes/health-record.ts) — the
 *      technician's "Email the estimate to the customer" on the field app's post-issue screen,
 *      behind the technician bearer-token gate and refused 403 unless that visit is assigned to
 *      them. Added when Kyle ruled out share-via-text (no SMS at Red Cedar).
 * Both are human-initiated. `tests/issuedEstimate.test.ts` pins that an unauthenticated caller of
 * (1) gets a 401 rather than a sent email; `tests/fieldEstimateEmail.test.ts` pins the 403 on (2).
 *
 * ADDING A THIRD CALLER IS A SECURITY DECISION, not a wiring task: if it is not a human pressing a
 * button behind an auth gate, it belongs in `CustomerSendWorkflow` behind the automation gate
 * instead, and this comment has to be updated to say so.
 *
 * Every send is recorded on the row (sentAt / sentBy / sentTo), appended to the estimate's event
 * log, and written to SystemEvent — so a send is as visible after the fact as a suppressed one.
 *
 * NO TWILIO. Nothing in this file touches SMS. The customer gets an email; Kyle gets an email.
 */

import type { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { sendBrandedEmail, escapeHtml } from "./confirmationEmail";
import { generateGeneratorReport, generateHealthReport } from "./pdfGenerator";
import { logSystemEvent } from "./systemEvents";
// The invoice send renders the customer's PDF itself rather than reading a stored file — same
// reason the filed copies are rendered on demand: nothing to drift, nothing lost to a deploy.
import { renderEstimatePdf } from "./issuedEstimatePdf";
import { getCompanyProfile } from "./companyProfile";
import { billedTotalOf, parseWarrantyJson, paymentSummary, stripeConfigured, warrantyCoverageOf } from "./stripePayments";
import { invoiceDocumentRows } from "./paymentReceipts";
import { warrantyEmailLine } from "./warrantyNotice";
import { isOfficeAcceptance } from "../../shared/acceptance";
// Kyle, 2026-09-09 ("My emails are not getting to the clients"): a send that lands at a
// DIFFERENT address than the one that bounced clears the estimate's bounce flag.
import { clearBounceIfDifferentAddress } from "./bounceWatcher";
import sharp from "sharp";

export type SendResult = { ok: true; to: string } | { ok: false; reason: string };

/**
 * Job photos chosen by the operator to ride an estimate or invoice email (photo gallery, Kyle
 * 2026-08-28; widened to the whole account 2026-10-01, item J).
 *
 * ── THE OWNERSHIP RULE: THIS PHOTO BELONGS TO THIS CUSTOMER — enforced HERE, nowhere else ──────
 *
 * Kyle, 2026-10-01: "Having the photos linked to the job is necessary but that should not
 * eleminate them from being selected… sending the photos as evidence is our standard." The job
 * link is for ORGANISATION, not permission — so this used to require `visit.propertyId ===
 * serviceAddressId` (one address) and that guard is gone. What replaces it is NOT "no guard" —
 * it is "this photo belongs to the CUSTOMER this estimate is for":
 *
 *   - a `VisitPhoto` qualifies when its visit's `customerId` matches the estimate's
 *     `customerId` — ANY property on the account, never cross-account.
 *
 * ONE STORE, since plan A (Kyle, 2026-10-02: "Draft photos don't make sense to me"). The second
 * branch that read `DraftPhoto` by the estimate's own `draftId` is gone with the store: a photo
 * added while BUILDING an estimate is now a `VisitPhoto` on the consultation job it came from, so
 * it is covered by the one rule above and outlives the estimate. The scoping of the surviving
 * branch is EXACTLY as it was — security-reviewed 2026-10-01 — and
 * tests/anyPhotoOnAccountEmail.test.ts pins both that it attaches across properties on the
 * account and that it refuses another customer's photo and any id from the retired draft store.
 *
 * A wrong id — someone else's visit photo, a stale id for a photo that moved accounts, an id
 * from the retired draft table — cannot leak across the boundary: it is simply refused, same as
 * an id that was never real. Never an unscoped `findMany({ where: { id: { in: ids } } })`.
 * `MAX_EMAIL_PHOTOS` and the downscale-or-refuse-on-corruption behaviour are unchanged from the
 * single-address version.
 */
const MAX_EMAIL_PHOTOS = 10;

// Exported so tests/anyPhotoOnAccountEmail.test.ts can pin the ownership guard directly —
// this is the security boundary the 2026-10-01 review runs against, so it is tested as a
// unit, not only indirectly through whichever send happens to call it.
export async function photoAttachments(
  prisma: PrismaClient,
  photoIds: string[],
  owner: { customerId: string },
): Promise<{ attachments: Array<{ filename: string; content: Buffer; contentType: string }>; refused: string[] }> {
  const ids = [...new Set(photoIds)].slice(0, MAX_EMAIL_PHOTOS);

  const visitPhotos = await prisma.visitPhoto.findMany({
    where: { id: { in: ids }, visit: { customerId: owner.customerId } },
    select: { id: true, data: true, caption: true },
  });

  const found = new Set(visitPhotos.map((p) => p.id));
  const refused = ids.filter((id) => !found.has(id));

  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  let n = 0;
  for (const photo of visitPhotos) {
    n++;
    try {
      const content = await sharp(Buffer.from(photo.data))
        .rotate()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      const label = (photo.caption ?? "").trim().replace(/[^a-z0-9 _-]/gi, "").slice(0, 40);
      attachments.push({
        filename: `photo-${n}${label ? `-${label.replace(/\s+/g, "-")}` : ""}.jpg`,
        content,
        contentType: "image/jpeg",
      });
    } catch {
      refused.push(photo.id); // a corrupt image must not sink the send
    }
  }
  return { attachments, refused };
}

/** Absolute base URL for customer links. Railway sets RAILWAY_PUBLIC_DOMAIN. */
export function publicBaseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (domain) return `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return "http://localhost:8080";
}

export function estimateLink(token: string): string {
  return `${publicBaseUrl()}/e/${token}`;
}

/**
 * Email one estimate to its customer. Operator action only.
 *
 * Refuses rather than guesses when there is no address — an estimate with no customer email is a
 * data problem Kyle fixes on the account, not something to paper over by sending it to himself.
 */
/**
 * Email the SIGNED invoice to the customer, with the PDF attached.
 *
 * Kyle, 2026-08-21: *"The signed estimates need to be labeled invoices and they need to be
 * emailed."* And from the picker on the account page: *"I cannot email the invoice to the
 * client."*
 *
 * ── WHY THIS IS NOT sendEstimateEmail WITH A FLAG ──────────────────────────────────────────────
 *
 * That function refuses outright once an estimate is signed, and it should: it exists to send an
 * offer and ask for a signature, and re-sending that after the fact invites a customer to sign a
 * thing they already signed. This is the opposite document with the opposite guard — it refuses
 * anything NOT signed.
 *
 * ── THE PDF IS THE CUSTOMER'S COPY, RENDERED HERE ──────────────────────────────────────────────
 *
 * Rendered at send time from the frozen estimate rather than pulled from a stored file, for the
 * same reason the filed copies are: nothing to drift, nothing to lose to a deploy that wipes
 * `generated/`. Explicitly the "customer" audience — this is the one document that must never
 * carry line pricing or labour hours, and the bug that prompted this work was a hardcoded
 * "company" on the route that served it.
 *
 * It bills what they BOUGHT. renderEstimatePdf re-sums from `selectedOptions`, so a customer who
 * took one option out of three is invoiced for one.
 */
export async function sendInvoiceEmail(
  prisma: PrismaClient,
  estimateId: string,
  opts: { sentBy: string; toOverride?: string | null; message?: string | null; photoIds?: string[] }
): Promise<SendResult> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
      options: { orderBy: { option: "asc" } },
    },
  });
  if (!est) return { ok: false, reason: "Estimate not found." };
  if (!est.signedAt) {
    return { ok: false, reason: "This estimate has not been signed yet, so there is no invoice to send." };
  }

  const to = (opts.toOverride ?? est.customerEmail ?? "").trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return {
      ok: false,
      reason:
        "No valid customer email address on this estimate. Add one to the customer record, or " +
        "supply an address when sending.",
    };
  }

  const profile = await getCompanyProfile();
  /*
    THE INVOICE IS THE GROUP (Kyle, 2026-09-20). The attached PDF stays this frozen document;
    the email's figures — and the appendix printed under the document — are the whole invoice:
    root plus every signed change order, one total, one paid-to-date, one balance, one pay link
    (the ROOT's, so a change order's copy pays the same invoice).
  */
  const summary = (await paymentSummary(prisma, est.id, publicBaseUrl()))!;
  const invoiceAppendix = summary.documents.length > 1
    ? {
      number: summary.number,
      documents: summary.documents.map((d) => ({ number: d.number, title: d.title, kind: d.kind, billedTotal: d.billedTotal, signedAt: d.signedAt })),
      billedTotal: summary.billedTotal,
      totalPaid: summary.totalPaid,
      balance: summary.balance,
    }
    : null;
  const pdf = await renderEstimatePdf(
    {
      number: est.number,
      revision: est.revision,
      title: est.title,
      customerName: est.customerName,
      serviceAddress: est.serviceAddress,
      scopeText: est.scopeText,
      total: est.total,
      tripCharge: est.tripCharge,
      signedAt: est.signedAt,
      signedByName: est.signerName,
      signatureImage: est.signatureImage,
      // An office acceptance (2026-09-24) prints the acceptance line where the mark would go.
      signedChannel: est.signedChannel,
      acceptedVia: est.acceptedVia,
      createdAt: est.createdAt,
      invoice: invoiceAppendix,
      options: est.options,
      selectedOptions: est.selectedOptions,
      // The frozen working of the job-level material check, for the company copy (2026-08-21).
      materialCaps: est.materialCapsJson ? JSON.parse(est.materialCapsJson) : null,
      comboCap: est.comboCapJson ? JSON.parse(est.comboCapJson) : null,
      discountType: est.discountType,
      discountPercent: est.discountPercent,
      discount: est.discountJson ? JSON.parse(est.discountJson) : null,
      // Home-warranty coverage (Kyle, 2026-09-09) — the credit row and the claim notice.
      warranty: parseWarrantyJson(est.warrantyJson),
      lines: est.lines.map((l) => ({
        option: l.option,
        description: l.description,
        quantity: l.quantity,
        lineTotal: l.lineTotal,
        laborHours: l.laborHours,
        materialSell: l.materialSell,
        materialCost: l.materialCost,
      })),
    },
    "customer",
    profile,
  );

  // What they actually owe — the same arithmetic the PDF prints, so the email and its attachment
  // cannot quote different numbers. The third gate's frozen reduction (2026-08-22), the frozen
  // programme discount, and the home-warranty credit (Kyle, 2026-09-09) all come off through
  // billedTotalOf — one arithmetic, every surface. What is left is the homeowner share.
  const money = {
    total: est.total,
    tripCharge: est.tripCharge,
    selectedOptions: (est.selectedOptions ?? []) as string[],
    comboCapJson: est.comboCapJson,
    discountJson: est.discountJson,
    warrantyJson: est.warrantyJson,
    optionsSubtotals: est.options.map((o) => ({ option: o.option, subtotal: o.subtotal })),
  };
  const billed = billedTotalOf(money);
  const coverage = warrantyCoverageOf(money);
  const warrantyLine = coverage
    ? `<p style="font-size:14px;color:#1a5c2e;margin:0 0 4px;">${escapeHtml(warrantyEmailLine(coverage.claim, coverage.applied))}</p>`
    : "";
  const isChangeOrder = Boolean(est.changeOrderForId);
  const rolledUp = invoiceAppendix
    ? `<table style="width:100%;font-size:14px;border-collapse:collapse;margin:8px 0;">
        ${invoiceDocumentRows(summary)}
        <tr style="border-top:2px solid #1a5c2e;"><td style="padding:6px 0;font-weight:600;">${summary.warrantyCovered > 0 ? "Your total" : "Invoice total"}</td>
          <td style="text-align:right;font-weight:700;">$${summary.billedTotal.toFixed(2)}</td></tr>
        ${summary.totalPaid > 0 ? `<tr><td style="padding:4px 0;color:#666;">Paid to date</td><td style="text-align:right;">$${summary.totalPaid.toFixed(2)}</td></tr>
        <tr><td style="padding:4px 0;font-weight:600;">Balance</td><td style="text-align:right;font-weight:600;">$${summary.balance.toFixed(2)}</td></tr>` : ""}
      </table>`
    : "";

  const firstName = est.customerName.trim().split(/\s+/)[0] || est.customerName;
  const note = (opts.message ?? "").trim();
  // Pay online (Stripe, 2026-08-25): the link is OUR durable /pay route, which
  // mints a fresh Checkout session per click — a raw session URL would expire
  // in a day. Only rendered while Stripe is configured on the service. The
  // ROOT invoice's link (2026-09-20) — one pay link for the whole job.
  const payUrl = stripeConfigured() ? summary.payUrl : null;
  const bodyHtml = `
    <p style="font-size:15px;">Hi ${escapeHtml(firstName)},</p>
    <p style="font-size:15px;">Thank you for approving <strong>${escapeHtml(est.title)}</strong>.
    Your ${isOfficeAcceptance(est.signedChannel) ? "" : "signed "}${isChangeOrder ? "change order" : "invoice"} is attached.</p>
    ${note ? `<p style="font-size:15px;">${escapeHtml(note)}</p>` : ""}
    ${warrantyLine}
    <p style="font-size:15px;">${isChangeOrder
      /*
        THE HEADLINE FIGURE IS THE INVOICE'S, NOT THE DOCUMENT'S (2026-09-29). This used to lead
        with the change order's own amount, so the first number the customer read was the smaller
        one and the invoice total sat below it in the table. Now the invoice and its total lead,
        and what this change order added is stated after — which is the shape of the sentence Kyle
        wanted: the diagnostics amount plus the fix, as one figure.
      */
      ? `Invoice <strong>${escapeHtml(summary.number)}</strong> &middot; ${coverage ? "your total" : "updated total"} <strong>$${summary.billedTotal.toFixed(2)}</strong>` +
        `<br><span style="font-size:14px;color:#666;">This adds change order <strong>${escapeHtml(est.number)}</strong> (${coverage ? "your share" : ""} $${billed.toFixed(2)}) to that invoice — it is not a separate bill.</span>`
      : `Invoice <strong>${escapeHtml(est.number)}</strong>${
          est.revision > 1 ? ` (revision ${est.revision})` : ""
        } &middot; ${coverage ? "Your total" : "Total"} <strong>${`$${(invoiceAppendix ? summary.billedTotal : billed).toFixed(2)}`}</strong>`}</p>
    ${rolledUp}
    ${payUrl ? `
    <p style="margin:24px 0;">
      <a href="${escapeHtml(payUrl)}"
         style="background:#1a5c2e;color:#fff;text-decoration:none;padding:14px 28px;
                border-radius:6px;font-size:16px;font-weight:600;display:inline-block;">
        Pay online
      </a>
    </p>` : ""}
    <p style="font-size:14px;">Thank you,<br>Kyle Brown<br>Red Cedar Electric LLC</p>`;

  // Job photos the operator chose to include — before/after shots belong on
  // the invoice for completed work (photo gallery, Kyle 2026-08-28; any photo
  // on the account plus this estimate's draft photos, 2026-10-01 item J).
  const photos = opts.photoIds && opts.photoIds.length > 0
    ? await photoAttachments(prisma, opts.photoIds, { customerId: est.customerId })
    : { attachments: [], refused: [] };

  /*
    ── THE ENVELOPE NAMES THE INVOICE, NOT THE DOCUMENT (Kyle, 2026-09-29) ─────────────────────

    Kyle, after the Hoover job: "The invoices for Tony Hoover that were sent yesterday did not add
    into a single invoice to be sent with the total diagnostics amount plus resolutions (fix)."

    The MONEY had already added up — 2026-1093 (a diagnostic) and 2026-1097 (its resolutions
    change order) were one invoice group, one balance, one pay link, and the body and the PDF
    appendix below both printed the combined total. What did not add up was the ENVELOPE. Every
    signature door fires this email on the document just signed, and the subject, the headline and
    the attachment filename all carried THAT document's number. So two signatures on one job
    produced "Your invoice — 2026-1093" and "Your invoice — 2026-1097", and the customer (and
    Kyle, reading his sent folder) saw two invoices.

    Now:
      · the SUBJECT names the invoice — `summary.number`, the ROOT's. On an ordinary single
        document invoice that is `est.number` and nothing changes; on a change order it is the
        invoice the change order joined. Two emails on one job now read as ONE invoice, twice.
      · the HEADLINE says which of the two it is: a first bill or an updated one.
      · the ATTACHMENT is named for what it actually IS. A change order's PDF is the frozen
        change-order document, so calling it `invoice-2026-1097.pdf` was the same lie in a
        filename. It is `change-order-2026-1097.pdf`; the invoice it belongs to is in the subject
        and printed inside the PDF as "Invoice 2026-1093 — what it now includes".

    `estimateNumber` below is UNCHANGED and deliberately still this document's: it is the
    delivery-row attribution (Kyle, 2026-09-09) and the row must show the state of THIS email.
    Pointing it at the root would merge two sends into one row and lose a bounce.

    NOT CHANGED HERE: that a signature fires this email at all. Two signed documents still send
    two signed copies, which is correct — each is the customer's receipt for a signature. Whether
    a change order should auto-send is Kyle's open question, recorded in
    .claude/plans/2026-09-29-estimate-invoice-findability-audit.md.
  */
  const invoiceNumber = summary.number;
  const sent = await sendBrandedEmail({
    to,
    subject: `Your invoice from Red Cedar Electric — ${invoiceNumber}`,
    headline: isChangeOrder || invoiceAppendix ? "Your updated invoice" : "Your invoice",
    bodyHtml,
    // Delivery-row attribution (Kyle, 2026-09-09) — the invoice row shows THIS email's state.
    kind: "invoice",
    estimateNumber: est.number,
    issuedEstimateId: est.id,
    attachments: [
      {
        filename: `${isChangeOrder ? "change-order" : "invoice"}-${est.number}.pdf`,
        content: pdf,
        contentType: "application/pdf",
      },
      ...photos.attachments,
    ],
  });

  if (!sent) {
    logSystemEvent("error", "issued-estimate", `Invoice ${est.number} send FAILED to ${to}`, {
      estimateId: est.id,
      sentBy: opts.sentBy,
    });
    return { ok: false, reason: "The email could not be sent. Check the Gmail connection and try again." };
  }

  // The estimate's own sent* fields belong to the ESTIMATE send and are left alone — overwriting
  // them would erase when the offer went out. The invoice send is recorded as its own event.
  await prisma.issuedEstimateEvent.create({
    data: {
      estimateId: est.id,
      type: "invoice_sent",
      actor: opts.sentBy,
      detail: `Invoice emailed to ${to} (rev ${est.revision}, ${`$${billed.toFixed(2)}`})`,
    },
  });

  logSystemEvent("info", "issued-estimate", `Invoice ${est.number} emailed to ${to}`, {
    estimateId: est.id,
    sentBy: opts.sentBy,
  });
  // A resend to the SAME address leaves the flag until the poll says otherwise; a different
  // address clears it. Never lets a bookkeeping failure turn a sent email into a reported failure.
  await clearBounceIfDifferentAddress(prisma, est.id, to).catch((err) => {
    console.warn("[IssuedEstimate] bounce flag not cleared:", err);
  });
  return { ok: true, to };
}

export async function sendEstimateEmail(
  prisma: PrismaClient,
  estimateId: string,
  opts: {
    sentBy: string;
    toOverride?: string | null;
    message?: string | null;
    photoIds?: string[];
    /** Support documentation (Kyle, 2026-08-29: "I should be able to add the
     * reports here for the electrical assessment, generator report, and any
     * photos") — rendered fresh from the newest assessment at the estimate's
     * address, so the attachment is never a stale file. */
    attachHealthReport?: boolean;
    attachGeneratorReport?: boolean;
    /**
     * The Synchrony financing line in the email body (Kyle, 2026-10-02: "attach relavent
     * attachements (generator sizing, health report, photos, financing link, and custom message)
     * all checked or unchecked to designate what gets sent").
     *
     * DEFAULTS TO TRUE when the caller says nothing, and that default is the point. This line has
     * ridden every estimate email since the financing URL was added, on Kyle's 2026-09-16 word
     * that he wants it sent with estimates; turning it into an opt-IN tick-box would have quietly
     * stopped it going out on every send that predates the box — including the field app's, which
     * does not pass this flag at all. So the CRM's box starts ticked and this is an opt-OUT: the
     * choice Kyle gained is the ability to LEAVE IT OFF on a particular estimate (a warranty job,
     * a landlord, a quote he does not want to read as a finance pitch), not a new thing to
     * remember on every send.
     *
     * Unlike the two above this is not an attachment — nothing is rendered and nothing is
     * fetched. It is one paragraph of the body, which is why it cannot fail the send.
     */
    includeFinancingLink?: boolean;
  }
): Promise<SendResult> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    include: { supersededBy: { select: { id: true } } },
  });
  if (!est) return { ok: false, reason: "Estimate not found." };
  if (est.supersededBy) {
    return { ok: false, reason: "This estimate has been superseded by a newer revision. Send that one instead." };
  }
  if (est.status === "void") return { ok: false, reason: "This estimate is void." };
  // Sending IS re-opening the conversation (2026-09-20). Reopen first so the funnel reads the
  // truth — a quote out with the customer is not a lost one — and so a resend cannot quietly
  // put a lost estimate back on the Sent card with its lost record still attached.
  if (est.status === "lost") return { ok: false, reason: "This estimate is marked lost. Reopen it first, then send it again." };
  // Archived (2026-10-01) is put away, not sent: unarchiving is one click on the drawer and says
  // on the trail that a person chose to keep this one in play.
  if (est.archivedAt) return { ok: false, reason: "This estimate is archived. Unarchive it first, then send it again." };
  if (est.signedAt) return { ok: false, reason: "This estimate is already signed." };

  const to = (opts.toOverride ?? est.customerEmail ?? "").trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return {
      ok: false,
      reason:
        "No valid customer email address on this estimate. Add one to the customer record, or " +
        "supply an address when sending.",
    };
  }

  const link = estimateLink(est.token);
  const firstName = est.customerName.trim().split(/\s+/)[0] || est.customerName;
  const note = (opts.message ?? "").trim();
  // Opt-OUT, not opt-in: a caller that says nothing still gets the financing line, because the
  // field app is such a caller and this line has been on every estimate email since 2026-09-16.
  const includeFinancing = opts.includeFinancingLink !== false;
  const profile = await getCompanyProfile();

  // Flat total only. The email carries no line detail and — like the page — no hours.
  const bodyHtml = `
    <p style="font-size:15px;">Hi ${escapeHtml(firstName)},</p>
    <p style="font-size:15px;">Your estimate for <strong>${escapeHtml(est.title)}</strong> is ready.
    You can review it and accept it online using the private link below.</p>
    ${note ? `<p style="font-size:15px;">${escapeHtml(note)}</p>` : ""}
    <p style="margin:24px 0;">
      <a href="${escapeHtml(link)}"
         style="background:#1a5c2e;color:#fff;text-decoration:none;padding:14px 28px;
                border-radius:6px;font-size:16px;font-weight:600;display:inline-block;">
        View &amp; accept your estimate
      </a>
    </p>
    ${includeFinancing ? `<p style="font-size:15px;">Prefer to pay over time? Financing is available through Synchrony —
    <a href="${escapeHtml(profile.financingUrl)}">apply here</a>.</p>` : ""}
    <p style="font-size:13px;color:#666;">Estimate ${escapeHtml(est.number)}${est.revision > 1 ? ` (revision ${est.revision})` : ""}
    &middot; Total ${`$${est.total.toFixed(2)}`} &middot; Valid ${est.validDays} days.</p>
    <p style="font-size:13px;color:#666;">If the button does not work, copy this link into your browser:<br>
    <span style="word-break:break-all;">${escapeHtml(link)}</span></p>
    <p style="font-size:14px;">Thank you,<br>Kyle Brown<br>Red Cedar Electric LLC</p>`;

  // Job photos the operator chose to include (photo gallery, Kyle 2026-08-28) —
  // assessment shots that show the customer what the estimate is talking about.
  // Any photo on the account plus this estimate's draft photos (2026-10-01, item J).
  const photos = opts.photoIds && opts.photoIds.length > 0
    ? await photoAttachments(prisma, opts.photoIds, { customerId: est.customerId })
    : { attachments: [], refused: [] };

  // Support documentation, rendered fresh at send time (2026-08-29). Refuses
  // plainly when the record to render from doesn't exist — an email that
  // silently arrived thinner than the operator ticked would be worse.
  const docAttachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  if (opts.attachHealthReport || opts.attachGeneratorReport) {
    const inspection = await prisma.healthInspection.findFirst({
      where: { propertyId: est.serviceAddressId },
      orderBy: { inspectionDate: "desc" },
      select: { id: true, loadCalcJson: true },
    });
    if (!inspection) {
      return { ok: false, reason: "No electrical assessment is on file for this address — the report attachments can't be produced." };
    }
    if (opts.attachHealthReport) {
      const report = await generateHealthReport(inspection.id);
      docAttachments.push({
        filename: `electrical-health-record-${est.number}.pdf`,
        content: await fs.promises.readFile(report.pdfPath),
        contentType: "application/pdf",
      });
    }
    if (opts.attachGeneratorReport) {
      if (!inspection.loadCalcJson) {
        return { ok: false, reason: "This address's assessment has no load calculation — the generator sizing sheet can't be produced." };
      }
      const report = await generateGeneratorReport(inspection.id);
      docAttachments.push({
        filename: `generator-sizing-data-sheet-${est.number}.pdf`,
        content: await fs.promises.readFile(report.pdfPath),
        contentType: "application/pdf",
      });
    }
  }

  const allAttachments = [...docAttachments, ...photos.attachments];
  const sent = await sendBrandedEmail({
    to,
    subject: `Your estimate from Red Cedar Electric — ${est.number}`,
    headline: "Your estimate is ready",
    bodyHtml,
    // Delivery-row attribution (Kyle, 2026-09-09) — the Estimates row shows THIS email's state.
    kind: "estimate",
    estimateNumber: est.number,
    issuedEstimateId: est.id,
    ...(allAttachments.length > 0 ? { attachments: allAttachments } : {}),
  });

  if (!sent) {
    logSystemEvent("error", "issued-estimate", `Estimate ${est.number} send FAILED to ${to}`, {
      estimateId: est.id,
      sentBy: opts.sentBy,
    });
    return { ok: false, reason: "The email could not be sent. Check the Gmail connection and try again." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.issuedEstimate.update({
      where: { id: est.id },
      data: {
        sentAt: new Date(),
        sentBy: opts.sentBy,
        sentTo: to,
        // A re-send of an already-viewed estimate does not rewind it to "sent".
        status: est.status === "draft" ? "sent" : est.status,
      },
    });
    await tx.issuedEstimateEvent.create({
      data: {
        estimateId: est.id,
        type: "sent",
        actor: opts.sentBy,
        detail: `Emailed to ${to} (rev ${est.revision})`,
      },
    });
  });

  logSystemEvent("info", "issued-estimate", `Estimate ${est.number} emailed to ${to}`, {
    estimateId: est.id,
    revision: est.revision,
    sentBy: opts.sentBy,
  });

  // Bounce flag (Kyle, 2026-09-09): off when this went to a different address than the one
  // that bounced; left alone on a resend to the same address — the next poll decides.
  await clearBounceIfDifferentAddress(prisma, est.id, to).catch((err) => {
    console.warn("[IssuedEstimate] bounce flag not cleared:", err);
  });

  return { ok: true, to };
}

/**
 * Tell Kyle an estimate was signed. INTERNAL — this is not a customer send and the manual-first
 * ruling does not reach it; it is the same lane as the daily digest.
 */
/**
 * Tell Kyle the FIRST time a customer opens their estimate (2026-08-22).
 *
 * Kyle asked whether he can know if his emails were read. The honest answer: an email-open pixel
 * lies in both directions (Apple auto-loads images; other clients block them). What cannot lie is
 * the estimate link itself — the customer either opened the page with the price on it or they did
 * not. This fires on that moment, because it is the actionable one: they are holding his number
 * RIGHT NOW, and a call within the hour beats one three days later.
 *
 * Internal only, to SUMMARY_EMAIL — same rules as the signature notification above it, and like
 * it, deliberately NOT behind automationGate: nothing here emails a customer.
 *
 * ONE CAVEAT THE EMAIL STATES OUT LOUD: corporate mail scanners prefetch links. A "view" seconds
 * after the send is probably a machine, and the email says so rather than letting Kyle sprint for
 * the phone over a bot.
 */
export async function notifyOwnerViewed(prisma: PrismaClient, estimateId: string): Promise<boolean> {
  const est = await prisma.issuedEstimate.findUnique({ where: { id: estimateId } });
  if (!est || !est.firstViewedAt) return false;

  const to = (process.env.SUMMARY_EMAIL ?? process.env.GMAIL_USER ?? "").trim();
  if (!to) {
    console.warn("[IssuedEstimate] SUMMARY_EMAIL not set — view notification skipped.");
    return false;
  }

  const secondsAfterSend =
    est.sentAt ? Math.round((est.firstViewedAt.getTime() - est.sentAt.getTime()) / 1000) : null;
  const scannerNote =
    secondsAfterSend !== null && secondsAfterSend < 120
      ? `<p style="font-size:13px;color:#a15c00;">Opened ${secondsAfterSend}s after sending — this is
         often a mail scanner rather than the customer. Treat with salt.</p>`
      : "";

  const bodyHtml = `
    <p style="font-size:16px;"><strong>${escapeHtml(est.customerName)}</strong> just opened estimate
    <strong>${escapeHtml(est.number)}</strong> for the first time.</p>
    <table style="font-size:14px;border-collapse:collapse;">
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Job</td><td>${escapeHtml(est.title)}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Total</td><td><strong>$${est.total.toFixed(2)}</strong></td></tr>
      ${est.customerPhone ? `<tr><td style="padding:3px 12px 3px 0;color:#666;">Phone</td><td>${escapeHtml(est.customerPhone)}</td></tr>` : ""}
    </table>
    ${scannerNote}
    <p style="font-size:14px;margin-top:14px;">They are looking at your price right now — this is
    the moment a call lands best.</p>`;

  return sendBrandedEmail({
    to,
    subject: `VIEWED — ${est.number} — ${est.customerName} — $${est.total.toFixed(2)}`,
    headline: "Estimate opened",
    bodyHtml,
  });
}

export async function notifyOwnerSigned(
  prisma: PrismaClient,
  estimateId: string,
  /** An extra line for Kyle — e.g. that the deposit request was held for the technician's choice (2026-09-21). */
  opts: { note?: string | null } = {},
): Promise<boolean> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    include: { options: true },
  });
  if (!est) return false;
  // The SELL price (Kyle, 2026-09-02: "all options combined when I sold only
  // option A" — this email announced the whole menu). billedTotalOf returns
  // est.total when nothing was selected, so single-scope signs are unchanged.
  const { billedTotalOf } = await import("./stripePayments");
  const billed = billedTotalOf({
    total: est.total,
    tripCharge: est.tripCharge,
    selectedOptions: est.selectedOptions,
    comboCapJson: est.comboCapJson,
    discountJson: est.discountJson,
    warrantyJson: est.warrantyJson,
    optionsSubtotals: est.options.map((o) => ({ option: o.option, subtotal: o.subtotal })),
  });
  const optionRow = est.selectedOptions.length > 0
    ? `<tr><td style="padding:3px 12px 3px 0;color:#666;">Option${est.selectedOptions.length > 1 ? "s" : ""} taken</td><td>${escapeHtml(est.selectedOptions.join(", "))}</td></tr>`
    : "";

  const to = (process.env.SUMMARY_EMAIL ?? process.env.GMAIL_USER ?? "").trim();
  if (!to) {
    console.warn("[IssuedEstimate] SUMMARY_EMAIL not set — sign notification skipped.");
    return false;
  }

  const bodyHtml = `
    <p style="font-size:16px;"><strong>${escapeHtml(est.signerName ?? "The customer")}</strong>
    signed estimate <strong>${escapeHtml(est.number)}</strong>${est.revision > 1 ? ` (rev ${est.revision})` : ""}.</p>
    <table style="font-size:14px;border-collapse:collapse;">
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Customer</td><td>${escapeHtml(est.customerName)}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Job</td><td>${escapeHtml(est.title)}</td></tr>
      ${est.serviceAddress ? `<tr><td style="padding:3px 12px 3px 0;color:#666;">Address</td><td>${escapeHtml(est.serviceAddress)}</td></tr>` : ""}
      ${optionRow}
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Total</td><td><strong>$${billed.toFixed(2)}</strong></td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Signed at</td><td>${est.signedAt?.toLocaleString("en-US", { timeZone: "America/Chicago", timeZoneName: "short" }) ?? ""}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666;">IP</td><td>${escapeHtml(est.signerIp ?? "unknown")}</td></tr>
    </table>
    <p style="font-size:14px;margin-top:18px;">The estimate is now locked. Any change needs a new
    revision, which voids the customer's current link.</p>
    ${opts.note ? `<p style="font-size:14px;margin-top:12px;padding:10px 12px;background:#fff7e6;border:1px solid #f0d9a8;border-radius:6px;">${escapeHtml(opts.note)}</p>` : ""}`;

  return sendBrandedEmail({
    to,
    subject: `SIGNED — ${est.number} — ${est.customerName} — $${billed.toFixed(2)}`,
    headline: "Estimate signed",
    bodyHtml,
  });
}
