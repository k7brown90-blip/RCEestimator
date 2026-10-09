/**
 * Kyle's four Synchrony plans and their disclosure text - the SEED for the Settings plan list
 * (2026-10-08, one-estimating-system plan, Detail B "Red Cedar's Synchrony plans" and Appendix).
 *
 * Used only while Settings holds no "financingPlans" row yet; once Kyle saves the list in
 * Settings -> "Financing plans (Synchrony)", his row is the truth and these are never read again.
 *
 * The disclosure text is Synchrony's, pasted by Kyle 2026-10-08, VERBATIM - do not paraphrase,
 * trim or "fix" it. The 965 text is 964's with 11.99% for 10.99% (both places) and 86 months for
 * 82 months; the 920 text is 924's with 6 for 18 everywhere (Appendix). They are written out in
 * full here, not derived at runtime, so a diff shows exactly what the customer will read. Each plan
 * carries dated terms ("New Accounts as of 08/29/25: Purchase APR 26.99%") that Synchrony updates:
 * replace them in Settings, not here.
 *
 * Plans in the order shown to the customer: Red Cedar's cheapest first (lowest Synchrony rate),
 * 965 (6.1%), 964 (7.25%), 920 (7.1%), 924 (10.6%). NOT lowest-monthly-first: 920 is about three times
 * 924's monthly (financed / 6 against financed / 18). The screens show Settings' order as it stands.
 *
 * discountRatePct is Red Cedar's cost (what Synchrony charges the company). It never reaches a
 * customer surface, the field payload or page source (constants.md "Financing fee").
 */

import type { FinancingPlan } from "../../shared/financing";

const REDUCED_EXPLANATION = "The estimated required monthly payment shown (which excludes taxes and delivery) equals the amount financed multiplied by 1.75%, rounded to the next highest whole dollar. During the last month(s) of the promo period the required monthly payment may be reduced due to this rounding. The sum of the required monthly payments will equal the cost of the amount financed. If you make the required payments by the due date each month, you should pay off the amount financed within the promo period, if it is the only balance you are paying off. If you have other balances on your account, this payment will be added to any other minimum monthly payments.";
const REDUCED_IMPORTANT = "IMPORTANT: The information about the Fixed Monthly Payment shown assumes this promotional financing offer is applied to the amount financed.";
const DEFERRED_18_EXPLANATION = "The Suggested Equal Monthly Payment shown which may exclude taxes and delivery may be greater than the required minimum monthly payment that will be on your billing statement when you use the 18 month promotional financing offer. This estimated payment: Equals the amount financed divided by 18 rounded to the next highest whole dollar. Would pay off the amount financed within 18 months, but only if there are no other balances on your account at any time during the 18 month promotional period and you make your payments on time. Your total payments will equal the amount of the amount financed. If the amount financed is not paid in full within 18 months, interest will be charged to your account from the purchase date and your total payments will be greater than the amount of the amount financed.";
const DEFERRED_18_IMPORTANT = "IMPORTANT: The information about the Suggested Equal Monthly Payment shown assumes this promotional financing offer is applied to the Promotional Purchase.";
const DEFERRED_6_EXPLANATION = "The Suggested Equal Monthly Payment shown which may exclude taxes and delivery may be greater than the required minimum monthly payment that will be on your billing statement when you use the 6 month promotional financing offer. This estimated payment: Equals the amount financed divided by 6 rounded to the next highest whole dollar. Would pay off the amount financed within 6 months, but only if there are no other balances on your account at any time during the 6 month promotional period and you make your payments on time. Your total payments will equal the amount of the amount financed. If the amount financed is not paid in full within 6 months, interest will be charged to your account from the purchase date and your total payments will be greater than the amount of the amount financed.";
const DEFERRED_6_IMPORTANT = "IMPORTANT: The information about the Suggested Equal Monthly Payment shown assumes this promotional financing offer is applied to the Promotional Purchase.";

export const DEFAULT_FINANCING_PLANS: readonly FinancingPlan[] = [
  {
    planNumber: "965",
    type: "reduced_apr",
    description: "11.99% APR until paid in full",
    months: 86,
    apr: 11.99,
    paymentFactorPct: 1.75,
    discountRatePct: 6.1,
    active: true,
    sortOrder: 1,
    disclosure: {
      explanation: REDUCED_EXPLANATION,
      important: REDUCED_IMPORTANT,
      terms: "11.99% APR Until Paid in Full — On qualifying purchases made with your Synchrony Bank Credit Card. $29 account activation fee may apply. Fixed monthly payments required for 86 months. Interest will be charged on the promo purchase from the purchase date at a reduced 11.99% APR, and fixed monthly payments are required until paid in full. These payments are equal to 1.75% of initial total promo purchase amount, rounded up to the next whole dollar. These payments may be higher than the payments that would be required if this purchase was a non-promo purchase. During the last month(s) of the promo period the required monthly payment may be reduced due to the prior months’ rounding. Regular account terms apply to non-promo purchases. New Accounts as of 08/29/25: Purchase APR 26.99%. Min Interest Charge $2. One-time Account Activation Fee of $29 charged at time first purchase posts to account. Existing cardholders: See your credit card agreement terms. Subject to credit approval.",
    },
  },
  {
    planNumber: "964",
    type: "reduced_apr",
    description: "10.99% APR until paid in full",
    months: 82,
    apr: 10.99,
    paymentFactorPct: 1.75,
    discountRatePct: 7.25,
    active: true,
    sortOrder: 2,
    disclosure: {
      explanation: REDUCED_EXPLANATION,
      important: REDUCED_IMPORTANT,
      terms: "10.99% APR Until Paid in Full — On qualifying purchases made with your Synchrony Bank Credit Card. $29 account activation fee may apply. Fixed monthly payments required for 82 months. Interest will be charged on the promo purchase from the purchase date at a reduced 10.99% APR, and fixed monthly payments are required until paid in full. These payments are equal to 1.75% of initial total promo purchase amount, rounded up to the next whole dollar. These payments may be higher than the payments that would be required if this purchase was a non-promo purchase. During the last month(s) of the promo period the required monthly payment may be reduced due to the prior months’ rounding. Regular account terms apply to non-promo purchases. New Accounts as of 08/29/25: Purchase APR 26.99%. Min Interest Charge $2. One-time Account Activation Fee of $29 charged at time first purchase posts to account. Existing cardholders: See your credit card agreement terms. Subject to credit approval.",
    },
  },
  {
    planNumber: "920",
    type: "deferred_interest",
    description: "No interest if paid in full within 6 months",
    months: 6,
    apr: null,
    paymentFactorPct: 2.5,
    discountRatePct: 7.1,
    active: true,
    sortOrder: 3,
    disclosure: {
      explanation: DEFERRED_6_EXPLANATION,
      important: DEFERRED_6_IMPORTANT,
      terms: "No Interest if Paid in Full within 6 Months — On qualifying purchases made with your Synchrony Bank Credit Card. Interest will be charged to your account from the purchase date if the promotional balance is not paid in full within 6 Months. $29 account activation fee may apply. Fixed Monthly Payments required equal to 2.5% of the highest balance applicable to this promo purchase. No interest will be charged on the promo balance if you pay it off, in full, within the promo period. If you do not, interest will be charged on the promo balance from the purchase date. Fixed monthly payments are required equal to 2.5% of the highest balance applicable to this promo purchase during the promotional period. The fixed monthly payment will be rounded to the next highest whole dollar and may be higher than the minimum payment that would be required if the purchase was a non-promotional purchase. During the last month(s) of the promo period the required monthly payment may be reduced due to the prior months’ rounding. The required minimum monthly payments may or may not pay off the promo balance before the end of the promo period, depending on purchase amount, promo length and payment allocation. Regular account terms apply to non-promo purchases, and after promo period ends, to promotional purchases. New Accounts as of 08/29/25: Purchase APR 26.99%. Min Interest Charge: $2. One-time Account Activation Fee of $29 charged at time first purchase posts to account. Existing cardholders: See your credit card agreement terms. Subject to credit approval.",
    },
  },
  {
    planNumber: "924",
    type: "deferred_interest",
    description: "No interest if paid in full within 18 months",
    months: 18,
    apr: null,
    paymentFactorPct: 2.5,
    discountRatePct: 10.6,
    active: true,
    sortOrder: 4,
    disclosure: {
      explanation: DEFERRED_18_EXPLANATION,
      important: DEFERRED_18_IMPORTANT,
      terms: "No Interest if Paid in Full within 18 Months — On qualifying purchases made with your Synchrony Bank Credit Card. Interest will be charged to your account from the purchase date if the promotional balance is not paid in full within 18 Months. $29 account activation fee may apply. Fixed Monthly Payments required equal to 2.5% of the highest balance applicable to this promo purchase. No interest will be charged on the promo balance if you pay it off, in full, within the promo period. If you do not, interest will be charged on the promo balance from the purchase date. Fixed monthly payments are required equal to 2.5% of the highest balance applicable to this promo purchase during the promotional period. The fixed monthly payment will be rounded to the next highest whole dollar and may be higher than the minimum payment that would be required if the purchase was a non-promotional purchase. During the last month(s) of the promo period the required monthly payment may be reduced due to the prior months’ rounding. The required minimum monthly payments may or may not pay off the promo balance before the end of the promo period, depending on purchase amount, promo length and payment allocation. Regular account terms apply to non-promo purchases, and after promo period ends, to promotional purchases. New Accounts as of 08/29/25: Purchase APR 26.99%. Min Interest Charge: $2. One-time Account Activation Fee of $29 charged at time first purchase posts to account. Existing cardholders: See your credit card agreement terms. Subject to credit approval.",
    },
  },
];
