/**
 * Scope and limitations — on every Record and every certificate.
 *
 * A written, code-cited defect report is legal notice. Delivered without a
 * limitations block, it reads as a whole-house clearance for everything it
 * doesn't mention, which converts a document meant to protect Red Cedar into a
 * new liability. This is not boilerplate; it is the sentence a plaintiff's expert
 * would otherwise write for us.
 *
 * Kept as data, next to the checklist, so the wording can be reviewed and
 * corrected without touching a component.
 *
 * // VERIFY: reviewed by counsel before the first customer-facing delivery.
 * Nothing here is a substitute for that review — it is the honest engineering
 * description of what the assessment does and does not cover.
 */

export interface LimitationSection {
  heading: string
  body: string[]
}

export const REPORT_LIMITATIONS: LimitationSection[] = [
  {
    heading: 'What this record is',
    body: [
      'An Electrical Health Record is a documented condition assessment of the electrical system at this address, on the date stated, performed by a licensed electrician. It records what was observed and measured, cites the code provision each finding is assessed against, and states what it would take to correct anything found.',
      'It is not a municipal inspection, and it does not substitute for one. A permit inspection is performed by the authority having jurisdiction and results in an approval; this record results in information.',
    ],
  },
  {
    heading: 'What was not assessed',
    body: [
      'Only the items listed in this record were assessed. Anything not listed was not examined and no statement is made about it either way.',
      'The assessment is non-destructive. Conditions concealed behind finished walls, ceilings and floors, inside sealed equipment, underground, or otherwise inaccessible on the day were not evaluated.',
      "Equipment on the utility's side of the meter is the utility's. Where something there warranted attention, this record says so and refers it to them; we do not open sealed equipment.",
      'Energized components were assessed with the covers that could be safely removed. Anything requiring an outage, specialised access, or work outside the agreed scope was not opened.',
    ],
  },
  {
    heading: 'What it means about the future',
    body: [
      'This record describes the system as it was on the date of the assessment. Electrical systems change with use, alteration, weather and age. It is not a warranty, a guarantee against future failure, or a prediction of remaining service life beyond the manufacturer figures cited.',
      'An item recorded as meeting requirements met the cited requirement at the time it was observed. It is not certified for any period afterward.',
    ],
  },
  {
    heading: 'Codes and jurisdiction',
    body: [
      'Findings are assessed against the code edition adopted in this jurisdiction as of the assessment date, stated on the record. The National Electrical Code is not retroactive: work that was compliant when installed is not a violation because a later edition changed the requirement. Where that distinction applies, this record says so.',
      "Items recorded as below Red Cedar's enhanced standard are not violations of anything. They are installations that meet code and that we would nonetheless do differently.",
    ],
  },
  {
    heading: 'Limitation of liability',
    body: [
      'Red Cedar Electric\'s liability arising from this record is limited to the fee paid for it. This record is provided to the party who commissioned it, for their use.',
      'Every version of this record is retained permanently and can be reproduced on request, including by a future owner of this property.',
    ],
  },
]

/** One-line version, for a footer or a summary card. */
export const LIMITATIONS_SUMMARY =
  'Covers only the items listed, as observed on the date stated. Non-destructive: concealed and inaccessible conditions were not evaluated. Not a municipal inspection, not a warranty, and not a statement about anything not listed.'
