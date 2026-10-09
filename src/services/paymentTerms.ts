/**
 * Payment terms — the ONE place the words live (Kyle, 2026-10-08; Phase 6 Unit 6C).
 *
 * "I would say it is due upon receipt. This way I can send the final invoice out and then it is
 * due. Regardless of the result of an inspection ... it doesn't need to be explained here."
 * And: "due upon receipt applies to everyone" — financed or not. It replaces "The balance is due
 * at completion" on every customer document. The "final invoice" is the "Your final bill" email
 * (paymentReceipts.sendBalanceRequestEmail), the document that carries the balance and says so.
 *
 * Do NOT mention inspections, failed inspections or the fix obligation in this wording — Kyle:
 * "it doesn't need to be explained here." Pinned, word for word, by tests/paymentTerms.test.ts.
 */

/** Pre-bill documents (deposit request, the customer's estimate page, a receipt that leaves a balance). */
export const BALANCE_DUE_TERMS = "The balance is due upon receipt of your final invoice.";

/** The final bill itself: this document IS the final invoice. */
export const FINAL_BILL_TERMS = "This balance is due upon receipt of this invoice.";

/** The contract PDF's default "Payment Terms:" line (an explicit caller-supplied term still wins). */
export const CONTRACT_PAYMENT_TERMS = "Due upon receipt of the final invoice";
