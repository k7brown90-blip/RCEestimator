/**
 * Drag-and-drop line moves — the pure part, shared by the CRM Review tab and the field Quote screen
 * (2026-10-08, one-estimating-system plan, Phase 1: one estimating system, two doors, one set of move rules).
 *
 * Kyle, 2026-10-08: "...if I made a mistake and added some to option 'B' that were supposed to be on
 * option 'C' then I can drag and drop them where they need to be rather than delete and rebuild
 * the line items ... and also allow me to organize the line items so the presentation can be set up
 * to explain the install start to finish."
 *
 * The screen keeps the confirmed lines as COLUMNS — one list of line ids per option — and these
 * functions move an id between and within columns. No money is touched here, and no arithmetic on
 * prices: per-option totals still come from the server after the drop (the page refetches review +
 * compute). Kept out of the component so the move rules can be tested without a pointer.
 */

import type { EstimateOptionLetter } from "./estimateOptions";

type PbOption = EstimateOptionLetter;

/** Line ids per option letter, in the order the lines are shown (and will be saved). */
export type LineColumns = Record<string, string[]>;

/** One entry of the list `PUT /price-book/drafts/:id/line-order` takes — the FULL ordered list. */
export interface LineOrderItem {
  lineId: string;
  option: PbOption;
  /**
   * The option this screen last SAW the line in. The server refuses the whole save (409) when the
   * draft holds a different one — the other app moved the line since, and writing `option` back
   * would undo that move without a word (2026-10-08 review).
   */
  was?: PbOption;
}

/**
 * Lay the draft's confirmed lines out as columns. `lines` arrive already in saved order
 * (sortOrder, createdAt — the server sorts them); each column keeps that relative order. Every
 * letter in `letters` gets a column even when empty, so an empty Option D can be dropped into.
 * A line whose option is not in `letters` (the server never does this) lands in the first column
 * rather than vanishing from the saved order.
 */
export function buildColumns(
  letters: readonly PbOption[],
  lines: ReadonlyArray<{ id: string }>,
  optionOf: (lineId: string) => PbOption | undefined,
): LineColumns {
  const cols: LineColumns = {};
  for (const l of letters) cols[l] = [];
  for (const line of lines) {
    const want = optionOf(line.id) ?? "A";
    const key = isColumn(cols, want) ? want : letters[0];
    cols[key].push(line.id);
  }
  return cols;
}

const isColumn = (cols: LineColumns, id: string) => Object.prototype.hasOwnProperty.call(cols, id);

/** Which column holds this id — or the id itself when it IS a column (an option letter). */
export function findColumn(cols: LineColumns, id: string): string | null {
  if (isColumn(cols, id)) return id;
  for (const key of Object.keys(cols)) if (cols[key].includes(id)) return key;
  return null;
}

/**
 * The columns flattened into the ordered list the server wants: option letters in order, each
 * column in order. `baseline` is the layout the SERVER last showed this screen (the one the drag
 * started from); each line carries the option it was in there as `was`, so the server can refuse a
 * save made from a screen the other app has since overtaken.
 */
export function flattenOrder(cols: LineColumns, letters: readonly PbOption[], baseline?: LineColumns): LineOrderItem[] {
  const out: LineOrderItem[] = [];
  for (const letter of letters) {
    for (const lineId of cols[letter] ?? []) {
      const was = baseline ? findColumn(baseline, lineId) : null;
      out.push(was ? { lineId, option: letter, was: was as PbOption } : { lineId, option: letter });
    }
  }
  return out;
}

/** True when two layouts put every line in the same option at the same place. */
export function sameColumns(a: LineColumns, b: LineColumns, letters: readonly PbOption[]): boolean {
  return letters.every((l) => {
    const x = a[l] ?? [];
    const y = b[l] ?? [];
    return x.length === y.length && x.every((id, i) => id === y[i]);
  });
}

/**
 * While a line is being dragged OVER a different option: lift it out of its column and put it in
 * the one under the pointer. Over a column itself (an empty option, or the gap under its last
 * line) it goes to the end; over another line it goes beside that line — after it when the pointer
 * is on its lower half. Returns the SAME object when nothing changes, so the caller can skip a
 * re-render.
 */
export function moveToColumn(cols: LineColumns, activeId: string, overId: string, below: boolean): LineColumns {
  const from = findColumn(cols, activeId);
  const to = findColumn(cols, overId);
  if (!from || !to || from === to || overId === activeId) return cols;
  const target = cols[to];
  let at: number;
  if (isColumn(cols, overId)) {
    at = target.length;
  } else {
    const i = target.indexOf(overId);
    at = i < 0 ? target.length : i + (below ? 1 : 0);
  }
  return {
    ...cols,
    [from]: cols[from].filter((id) => id !== activeId),
    [to]: [...target.slice(0, at), activeId, ...target.slice(at)],
  };
}

/**
 * On drop, inside one column: put the dragged line where the line it was dropped on is. (A drop
 * onto the column itself, or onto a line in another column, changes nothing here — that move was
 * already made while dragging.) Same object back when nothing changes.
 */
export function reorderWithin(cols: LineColumns, activeId: string, overId: string): LineColumns {
  const from = findColumn(cols, activeId);
  const to = findColumn(cols, overId);
  if (!from || from !== to || isColumn(cols, overId) || overId === activeId) return cols;
  const items = cols[from];
  const oldIndex = items.indexOf(activeId);
  const newIndex = items.indexOf(overId);
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return cols;
  const next = items.slice();
  next.splice(oldIndex, 1);
  next.splice(newIndex, 0, activeId);
  return { ...cols, [from]: next };
}
