/**
 * AI-suggested lines, open questions and the walkthrough list — what the field Quote screen shows
 * about them and the one sentence both doors use to say "these still need you"
 * (2026-10-08, one-estimating-system plan, Phase 2 unit D).
 *
 * Kyle, 2026-10-08: the office and the truck are ONE estimating system. The Walkthrough tab's
 * "Build the draft (AI)" writes PROPOSED lines and open questions onto a draft; they price nothing
 * and BLOCK ISSUE until a person confirms / rejects / resolves each one. The CRM did that from
 * Estimate Intake; the field could only show them, so a draft with one could not be issued from the
 * truck. Both apps now call the same services (confirmProposedLine, rejectProposedLine,
 * resolveQuestion) and read the same words.
 *
 * Customer-safe: no labour hours, no labour dollars, no rates, no Red Cedar cost, and no AI token
 * usage ride on anything here — the technician hands the phone to the customer (constants.md:
 * "Field app"). The AI's own reasoning for a line is words the technician reads; it is written from
 * the catalog's item names, which carry no costs.
 *
 * Plain interfaces and functions only — no TS enum, no constructor parameter properties — so the
 * client and field tsconfigs (erasableSyntaxOnly) accept this file as-is.
 */

/** One AI-suggested line, as the phone lists it under "AI proposals". Not priced, not in any total. */
export interface QuoteSuggestedLine {
  id: string;
  itemId: string;
  /** The price-book item's name (the office's words), or the item code when the book no longer has it. */
  description: string;
  quantity: number;
  difficulty: "NORMAL" | "DIFFICULT" | "VERY_DIFFICULT";
  /** The option the line will sit in once confirmed. */
  option: string;
  /** Why the model thinks this line belongs — the technician reads it next to the decision. */
  reasoning: string | null;
  /** "ai:gpt-5.1", or whoever proposed it. */
  proposedBy: string | null;
}

/** One open question on a draft: something the model (or the office) could not place. */
export interface FieldOpenQuestion {
  id: string;
  question: string;
  /** The words the walkthrough used, when the question came from one. */
  rawText: string | null;
  raisedBy: string;
}

/**
 * Why the draft cannot be issued while these exist — ONE wording, used by the server's issue refusal
 * (finalizeDraft) for both doors and by the field screen to grey its Issue button BEFORE the press.
 * It names the heading each list sits under and the button that clears it, in the words both apps
 * use ("AI proposals" / "Confirm" / "Reject", "Open questions" / "Resolve").
 */
export function unreviewedReasons(unconfirmedLines: number, openQuestions: number): string[] {
  const reasons: string[] = [];
  if (unconfirmedLines > 0) {
    reasons.push(
      `${unconfirmedLines} AI-suggested line${unconfirmedLines === 1 ? " is" : "s are"} still unconfirmed. ` +
        `A suggestion prices nothing — under "AI proposals" tap Confirm to keep each one or Reject to drop it, ` +
        `then issue the estimate.`,
    );
  }
  if (openQuestions > 0) {
    reasons.push(
      `${openQuestions} open question${openQuestions === 1 ? " is" : "s are"} still unresolved. ` +
        `An item that could not be matched is a question for you, not something to quote around — ` +
        `under "Open questions" write what you did or found out and tap Resolve.`,
    );
  }
  return reasons;
}

/** One candidate the basic matcher offers for a typed line — words and yes/no gap badges only. */
export interface FieldWalkthroughCandidate {
  itemId: string;
  description: string | null;
  unit: string | null;
  isContinuousLength: boolean;
  hasLabourUnitBasis: boolean;
  hasPriceAtActiveSupplier: boolean;
}

/** One typed walkthrough line and what the matcher found for it. NOTHING is added until the tech taps. */
export interface FieldWalkthroughRow {
  raw: string;
  /** What the tech appears to have written; display only — the real quantity is set on the line. */
  parsedQuantity: number | null;
  searchTerm: string;
  status: "MATCHED" | "AMBIGUOUS" | "UNMATCHED";
  matchedOn: "name";
  unknownWords: string[];
  candidates: FieldWalkthroughCandidate[];
}

/**
 * What "Build the draft (AI)" answers with — the same object on both doors. `path` says which brain
 * ran, always: "ai" wrote suggestions onto the draft; "basic" means the model was unavailable and
 * NOTHING was written (the screen then runs the basic match and says why).
 */
export interface WalkthroughProposal {
  path: "ai" | "basic";
  /** Present when the AI path could not run; shown beside the "Basic match" badge. */
  degradedReason?: string;
  proposed: Array<{ id: string; itemId: string; quantity: number; description: string | null }>;
  questions: Array<{ id: string; question: string }>;
  rejected: Array<{ itemId: string; reason: string }>;
}
