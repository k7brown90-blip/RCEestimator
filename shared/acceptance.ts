/**
 * How an estimate was accepted — ONE vocabulary for the server, the CRM client and the PDF
 * (2026-09-24, closing-out-an-estimate plan, Unit 1).
 *
 * Kyle, 2026-09-24: "The customer accepted button would be good on the estimate drawer, no need
 * to do sign in person on the CRM because that is being developed for an admin/dispatcher."
 *
 * CLAUDE.md, two apps, two people, two places: the tech takes a SIGNATURE; the office records an
 * ACCEPTANCE it was told about. Both land on `status: "signed"` — every money and reporting
 * filter is an allow-list on that exact string — but they are different records and every
 * surface must keep them visibly different. `signedChannel` tells them apart:
 *
 *   "in_person"  the customer signed on the operator's device (P028)
 *   "email"      the customer signed from the tokenized link (P027)
 *   "office"     the office recorded an acceptance it was told about — NO signature image,
 *                `acceptedVia` says how they told us
 *
 * Every consumer of `signedChannel` used to render "" for an unknown value, so a new channel
 * printed as a bare "signed 9/24 by Bryan Crawford" — indistinguishable from a real e-signature.
 * `acceptanceWording` below is the one place the words come from; the word "signed" never
 * appears in an office acceptance's wording.
 */

/** How the customer told the office. The select on the drawer, and the column `IssuedEstimate.acceptedVia`. */
export const ACCEPTED_VIA = ["phone", "email", "text", "writing", "in_person"] as const;
export type AcceptedVia = (typeof ACCEPTED_VIA)[number];

/** The select's labels — what Kyle would say out loud. */
export const ACCEPTED_VIA_CHOICES: ReadonlyArray<{ value: AcceptedVia; label: string }> = [
  { value: "phone", label: "Phone call" },
  { value: "email", label: "Email reply" },
  { value: "text", label: "Text message" },
  { value: "writing", label: "In writing (letter, form, P.O.)" },
  { value: "in_person", label: "In person — told us, nothing signed" },
];

/** "by phone", "by email reply", … — the phrase that follows "accepted". */
export function acceptedViaPhrase(via: string | null | undefined): string {
  switch (via) {
    case "phone": return "by phone";
    case "email": return "by email reply";
    case "text": return "by text";
    case "writing": return "in writing";
    case "in_person": return "in person";
    default: return "by the customer";
  }
}

export type SignedChannel = "in_person" | "email" | "office";

/**
 * The verb and the "how" every surface prints after a signed row's date and name.
 *
 *   in_person → signed … in person
 *   email     → signed … from the emailed link
 *   office    → accepted … by phone, recorded by the office
 *   null      → signed … (an estimate signed before the channel was recorded)
 */
export function acceptanceWording(
  channel: string | null | undefined,
  acceptedVia?: string | null,
): { verb: "signed" | "accepted"; how: string } {
  if (channel === "office") {
    return { verb: "accepted", how: `${acceptedViaPhrase(acceptedVia)}, recorded by the office` };
  }
  if (channel === "in_person") return { verb: "signed", how: "in person" };
  if (channel === "email") return { verb: "signed", how: "from the emailed link" };
  return { verb: "signed", how: "" };
}

/** True when the row is an office-recorded acceptance rather than a customer's signature. */
export function isOfficeAcceptance(channel: string | null | undefined): boolean {
  return channel === "office";
}
