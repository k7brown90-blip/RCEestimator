/**
 * Settings cards start FOLDED (Kyle, 2026-11-26: "All folded") and remember how they were left in
 * localStorage (`rce.card.<id>`, CollapsibleCard). A test that exercises a card's controls opens it first
 * the way a returning user has left it: call this in beforeEach, before the render. (setup.ts clears
 * localStorage after every test, so nothing leaks.) A test about the fold itself does not call it.
 */
export function openCards(...ids: string[]): void {
  try {
    for (const id of ids) localStorage.setItem(`rce.card.${id}`, "1");
  } catch {
    // Storage blocked: the card simply starts folded.
  }
}
