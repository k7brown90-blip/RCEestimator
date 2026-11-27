/**
 * A form that starts from the saved value and stays what the person typed (Kyle, 2026-11-26: a folded Settings card must not hide
 * unsaved typing, and saving ONE card must not wipe typing in another).
 *
 * `seed` is the saved value, read from the query (pass a fresh object every render if that is easier: it is compared by content with
 * `same`). The returned `value` is what is on screen:
 *   - while the form is untouched it follows the seed (first load, a refetch, a save from elsewhere);
 *   - once the person has typed something different from the saved value (`dirty`) a new seed does NOT replace it, so a refetch
 *     caused by saving a different card never overwrites it;
 *   - when the new seed equals what was typed (the save landed) the form is clean again.
 * The seed is adopted while rendering (state adjusted during render, not in an effect), so there is never a render where the form
 * looks edited only because the saved value arrived a moment before it was copied in.
 */
import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";

export function useSeededForm<T>(seed: T, same: (a: T, b: T) => boolean = Object.is): [T, Dispatch<SetStateAction<T>>, boolean] {
  const [value, setValue] = useState<T>(seed);
  const [base, setBase] = useState<T>(seed);
  if (!same(seed, base)) {
    const wasDirty = !same(value, base);
    setBase(seed);
    if (!wasDirty || same(value, seed)) setValue(seed);
  }
  return [value, setValue, !same(value, base)];
}

/** Every field of two flat records is equal (a missing field counts as different from a present one). */
export function sameFields<T extends object>(a: T, b: T): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  }
  return true;
}

/** Two typed numbers are the same number ("9.50" and "9.5"), or both empty; anything else compares as text. */
export function sameNumberText(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (x === y) return true;
  if (x === "" || y === "") return false;
  return Number(x) === Number(y);
}
