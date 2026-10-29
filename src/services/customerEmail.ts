/**
 * THE ONE SEND PATH for a customer email from the CRM (Kyle, 2026-10-27).
 *
 * Kyle: "I also need the email invoice or estimate buttons to prompt a selection of who to send it
 * to on each button." Then, shown the invoice drawer: "Multiple email buttons are created and in
 * use. This is confusing and difficult and causes user error. A rule of thumb is there is one tool
 * for one task. We do not create multiple tools that do the same thing."
 *
 * The drawers used to carry one button per email - "Email invoice $X due", "Email the signed
 * copy", "Send reminder", "Email deposit request", "Email the financing link", "Email a review
 * request", the estimate's "Email estimate" / "Resend" - each with its own route, its own body, and
 * only some of them with a way to pick who it went to. Now there is ONE panel ("Email the
 * customer", client SendEmailPanel) and ONE route that serves it: POST /customer-emails, which
 * parses the request below and hands it to the service that owns that email's CONTENT:
 *
 *   invoice   -> issuedEstimateSend.sendInvoiceEmail        (itemized PDF, balance, pay link, reminder voice)
 *   deposit   -> paymentReceipts.sendDepositRequestEmail
 *   financing -> financingEmail.sendFinancingEmail
 *   estimate  -> issuedEstimateSend.sendEstimateEmailFromBody (the same function the technician's door calls)
 *   receipt   -> paymentReceipts.sendReceiptEmail           (paid in full only: invoice PDF + the reports ticked + photos)
 *   review    -> reviewRequest.sendReviewRequestEmail        (job-keyed: a Visit.id)
 *   message   -> POST /communications/email                  (routes/communications.ts, which also passes
 *                                                             the one recipient rule; it has its own thread keys)
 *
 * WHO IT GOES TO is decided once, for every kind, by emailCc.resolveRecipients - the address chosen
 * on the panel or the customer on file, then the CC list. WHAT IT SAYS stays in each service.
 *
 * Every caller of this is an authenticated CRM route handler acting on a person's click, so none of
 * it sits behind the automation gate (same reasoning as issuedEstimateSend.ts's header). The
 * technician's own doors (routes/health-record.ts) keep their routes and call the same services.
 */

import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { customerEmailBaseSchema } from "./emailCc";
import { estimateEmailBodySchema, publicBaseUrl, sendEstimateEmailFromBody, sendInvoiceEmail } from "./issuedEstimateSend";
import { sendDepositRequestEmail, sendReceiptEmail } from "./paymentReceipts";
import { receiptReportIdsSchema } from "../../shared/jobCompletion";
import { sendFinancingEmail } from "./financingEmail";
import { sendReviewRequestEmail } from "./reviewRequest";

const estimateId = z.string().trim().min(1, "Which estimate or invoice?");

/** The request, one shape per kind: the shared base (to / cc / message / photoIds) plus what that kind needs. */
export const customerEmailRequestSchema = z.discriminatedUnion("kind", [
  customerEmailBaseSchema.extend({ kind: z.literal("invoice"), estimateId }),
  customerEmailBaseSchema.extend({ kind: z.literal("deposit"), estimateId }),
  customerEmailBaseSchema.extend({ kind: z.literal("financing"), estimateId }),
  estimateEmailBodySchema.extend({ kind: z.literal("estimate"), estimateId }),
  // The paid-in-full receipt (Kyle, 2026-10-29): `reports` are the ids in shared/jobCompletion.ts ("completion",
  // "health:<id>", "generator:<id>", "diagnostic:<id>") - the same ids the payment card's list offers.
  customerEmailBaseSchema.extend({ kind: z.literal("receipt"), estimateId, reports: receiptReportIdsSchema }),
  customerEmailBaseSchema.extend({ kind: z.literal("review"), visitId: z.string().trim().min(1, "Which job?") }),
]);
export type CustomerEmailRequest = z.infer<typeof customerEmailRequestSchema>;

export type CustomerEmailKind = CustomerEmailRequest["kind"];

export type CustomerEmailResult =
  | { ok: true; kind: CustomerEmailKind; to: string; cc: string[]; amount?: number; reminder?: boolean }
  | { ok: false; reason: string };

export async function sendCustomerEmailRequest(
  prisma: PrismaClient,
  rawBody: unknown,
  sentBy: string,
): Promise<CustomerEmailResult> {
  const body = customerEmailRequestSchema.parse(rawBody ?? {});

  // Photos ride only an invoice, an estimate or a receipt. A tick on any other kind is REFUSED, never
  // dropped: the email must not arrive thinner than the person ticked (the same rule as the field door).
  if (body.kind !== "invoice" && body.kind !== "estimate" && body.kind !== "receipt" && body.photoIds && body.photoIds.length > 0) {
    return { ok: false, reason: "Photos can only be sent with an invoice, an estimate or a receipt." };
  }

  switch (body.kind) {
    case "invoice": {
      const r = await sendInvoiceEmail(prisma, body.estimateId, {
        sentBy,
        toOverride: body.to ?? null,
        cc: body.cc,
        message: body.message ?? null,
        photoIds: body.photoIds,
      });
      return r.ok ? { ok: true, kind: "invoice", to: r.to, cc: r.cc, amount: r.amount, reminder: r.reminder } : r;
    }
    case "receipt": {
      const r = await sendReceiptEmail(prisma, body.estimateId, {
        sentBy,
        toOverride: body.to ?? null,
        cc: body.cc,
        message: body.message ?? null,
        photoIds: body.photoIds,
        reports: body.reports,
      });
      return r.ok ? { ok: true, kind: "receipt", to: r.to, cc: r.cc } : r;
    }
    case "deposit": {
      const r = await sendDepositRequestEmail(prisma, body.estimateId, publicBaseUrl(), {
        toOverride: body.to ?? null,
        cc: body.cc,
        message: body.message ?? null,
      });
      return r.ok ? { ok: true, kind: "deposit", to: r.to, cc: r.cc, amount: r.amount } : r;
    }
    case "financing": {
      const r = await sendFinancingEmail(prisma, body.estimateId, {
        toOverride: body.to ?? null,
        cc: body.cc,
        message: body.message ?? null,
      });
      return r.ok ? { ok: true, kind: "financing", to: r.to, cc: r.cc } : r;
    }
    case "estimate": {
      const { kind: _kind, estimateId: id, ...rest } = body;
      void _kind;
      const r = await sendEstimateEmailFromBody(prisma, id, rest, sentBy);
      return r.ok ? { ok: true, kind: "estimate", to: r.to, cc: r.cc } : r;
    }
    case "review": {
      const r = await sendReviewRequestEmail(prisma, body.visitId, {
        manual: true,
        toOverride: body.to ?? null,
        cc: body.cc,
        message: body.message ?? null,
      });
      return r.ok ? { ok: true, kind: "review", to: r.to, cc: r.cc } : r;
    }
  }
}
