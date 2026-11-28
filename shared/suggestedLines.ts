/**
 * AI-suggested lines and the walkthrough list — what the field Quote screen shows about them and
 * the one sentence both doors use to say "these still need you"
 * (2026-10-08, one-estimating-system plan, Phase 2 unit D).
 *
 * Kyle, 2026-10-08: the office and the truck are ONE estimating system. The Walkthrough tab's
 * "Build the draft (AI)" writes PROPOSED lines onto a draft; they price nothing and BLOCK ISSUE
 * until a person confirms / rejects each one. Both apps call the same services
 * (confirmProposedLine, rejectProposedLine) and read the same words.
 *
 * Kyle, 2026-11-28: no more AI "Open questions". What the model cannot place is a note under the
 * result ("Couldn't place: ..."), never a row and never a gate.
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

/**
 * Scope "Build the draft (AI)" could not place on a catalog item. A NOTE for the person to read —
 * it is not stored, not a database row, and nothing waits on it (Kyle, 2026-11-28: "I dont want
 * these questions as I already confirmed the line item once. this is a redundant and repetative
 * process that wastes time."). The model still never guesses an itemId (P011); what it cannot place
 * comes back here instead of becoming a question.
 */
export interface NotPlacedScope {
  /** What the walkthrough asked for, in the model's words. */
  text: string;
  /** Why it could not be placed — short. */
  reason: string;
}

/**
 * The one sentence both apps print under the AI result when something could not be placed, or null
 * when everything was. A note, nothing to answer.
 */
export function notPlacedNote(notPlaced: NotPlacedScope[]): string | null {
  if (notPlaced.length === 0) return null;
  const items = notPlaced.map((n) => (n.reason.trim() ? `${n.text} (${n.reason.trim()})` : n.text)).join("; ");
  return `Couldn't place: ${items} - add them by hand if needed.`;
}

/**
 * Why the draft cannot be issued while AI-suggested lines are unconfirmed — ONE wording, used by the
 * server's issue refusal (finalizeDraft) for both doors and by the field screen to grey its Issue
 * button BEFORE the press. It names the heading the list sits under and the buttons that clear it,
 * in the words both apps use ("AI proposals" / "Confirm" / "Reject").
 *
 * Open questions no longer block issue (Kyle, 2026-11-28) and are not a parameter any more.
 */
export function unreviewedReasons(unconfirmedLines: number): string[] {
  const reasons: string[] = [];
  if (unconfirmedLines > 0) {
    reasons.push(
      `${unconfirmedLines} AI-suggested line${unconfirmedLines === 1 ? " is" : "s are"} still unconfirmed. ` +
        `A suggestion prices nothing — under "AI proposals" tap Confirm to keep each one or Reject to drop it, ` +
        `then issue the estimate.`,
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
  /** Scope the model could not place — a note to read, nothing stored and nothing to answer (2026-11-28). */
  notPlaced: NotPlacedScope[];
  /** Deprecated and always empty (Kyle, 2026-11-28). Sent only so a pre-deploy app bundle that reads `.questions.length` does not throw. */
  questions?: never[];
  rejected: Array<{ itemId: string; reason: string }>;
}
