/**
 * The words a payment row is described in on customer-facing documents - the receipt email
 * (paymentReceipts.ts) and the Job Completion Report's "Payments received" (pdfGenerator.ts) say
 * "paid by check" and "Deposit (1/3)" the same way because they read these two tables. Lifted out of
 * paymentReceipts.ts unchanged (2026-10-29) so the PDF generator can import them without pulling
 * the email service's imports along.
 */
export const PAYMENT_KIND_LABEL: Record<string, string> = {
  deposit: "Deposit (1/3)",
  final: "Payment",
  other: "Payment",
};

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  stripe: "paid online",
  cash: "paid in cash",
  check: "paid by check",
  zelle: "paid via Zelle",
  ach: "paid by bank transfer",
  // The financed balance (2026-10-09, services/financingFee.ts) - the gross the customer authorized.
  synchrony: "financed through Synchrony",
  other: "paid",
};
