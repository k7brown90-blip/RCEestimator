/**
 * Building the presentation — one estimate, two audiences. (Step 3)
 *
 * Kyle, 2026-08-19:
 *
 *   *"Remember that the labor units and line item pricing will have to show for the company copy.
 *    The goal is to have a material list and labor unit assesment for the puprose of ordering and
 *    scheduling the job. The customer only needs the final price of each option or combination of
 *    options."*
 *
 *   *"The presentation screen effectively replaces the review button as it is the 'review' with
 *    the customer."*
 *
 * ── WHY THE AUDIENCE DECIDES THE DATA, NOT THE RENDER ──────────────────────────────────────────
 *
 * The customer's view could have been the company's view with some columns hidden by CSS or a
 * conditional. It is not, deliberately: a hidden column is still IN the page, and this is a screen
 * Kyle turns around and holds in front of a customer. A `display:none` price is one long-press or
 * one "view source" from being read, and more practically, one careless edit from being visible.
 *
 * So a customer line carries **no money and no hours at all** — the fields are absent from the
 * object, not merely unrendered. That is a property a test can assert absolutely, and it cannot
 * be undone by a styling change.
 *
 * There is still ONE builder and one data source. The audience picks what it emits; it never
 * re-derives a number, so the two views cannot disagree about what the work costs.
 */

import type { PbComputed, PbComputedLine, PbOption, PbOptionSummary } from "./types";

export type Audience = "customer" | "company";

/**
 * One line as presented.
 *
 * The money and labour fields are OPTIONAL on the type and ABSENT on a customer line. Optional
 * rather than nullable on purpose: `null` would mean "no price", which is a claim; absent means
 * "not part of this document", which is the truth.
 */
export interface PresentationLine {
  itemId: string;
  description: string;
  quantity: number;
  /**
   * COMPANY ONLY, like the money and the hours.
   *
   * Kyle, 2026-08-20: *"I do not want 'per foot' or 'each' in the customer facing pdf."* The unit
   * is his — for ordering, for the entry screen, for scheduling. Absent from a customer line
   * rather than merely unrendered, for the same reason the prices are: a field that is not in the
   * object cannot be printed by a later edit that forgets the rule.
   */
  unit?: string | null;
  /** Company only. */
  laborHours?: number | null;
  /** Company only. */
  laborDollars?: number | null;
  /** Company only — column F, what the customer is charged. */
  materialSell?: number | null;
  /** Company only — column E, what it costs Red Cedar. What Kyle tracks spending against. */
  materialCost?: number | null;
}

export interface PresentationOption {
  option: PbOption;
  lines: PresentationLine[];
  /** The option's own subtotal. Excludes any fixed job cost — that is charged once, not per option. */
  total: number | null;
  complete: boolean;
}

/** A row of the company's ordering list. Aggregated across every selected option. */
export interface MaterialRow {
  itemId: string;
  description: string;
  quantity: number;
  unit: string | null;
}

export function buildOptions(
  computed: PbComputed,
  summaries: PbOptionSummary[],
  audience: Audience,
): PresentationOption[] {
  return summaries
    .filter((s) => s.lineCount > 0)
    .map((s) => ({
      option: s.option,
      complete: s.complete,
      total: s.subtotal,
      lines: computed.lines
        .filter((l) => l.option === s.option)
        .map((l) => presentLine(l, audience)),
    }));
}

function presentLine(line: PbComputedLine, audience: Audience): PresentationLine {
  const base: PresentationLine = {
    itemId: line.itemId,
    description: line.description ?? line.itemId,
    quantity: line.quantity,
  };
  if (audience === "customer") return base;
  return {
    ...base,
    unit: line.unit,
    laborHours: line.laborHours,
    laborDollars: line.laborDollars,
    materialSell: line.materialSell,
    materialCost: line.materialCost,
  };
}

/**
 * What the selected options come to.
 *
 * The fixed job cost is added ONCE, after the selection is known — the visit happens once, and any
 * combination signed together is a single job (Kyle, R4). Selecting nothing returns null rather
 * than zero: an empty selection has no price, and a $0 total invites signing it.
 */
export function combinedTotal(
  options: PresentationOption[],
  selected: PbOption[],
  jobFixedCost: number | null,
): number | null {
  const chosen = options.filter((o) => selected.includes(o.option));
  if (chosen.length === 0) return null;
  if (chosen.some((o) => o.total === null)) return null;
  const subtotal = chosen.reduce((n, o) => n + (o.total ?? 0), 0);
  return subtotal + (jobFixedCost ?? 0);
}

/**
 * The material list for what has been selected — the company's ordering sheet.
 *
 * Quantities are summed per item across options, because the supply house cares how many of a
 * thing to put on the truck, not which option asked for it. Items carrying no material sell price
 * are excluded: a labour-only row like a ceiling fan install has nothing to order, and listing it
 * would send Kyle looking for a part the customer is supplying.
 */
export function materialList(
  computed: PbComputed,
  selected: PbOption[],
): MaterialRow[] {
  const rows = new Map<string, MaterialRow>();
  for (const line of computed.lines) {
    if (!selected.includes(line.option)) continue;
    if (!line.materialSell) continue;
    const existing = rows.get(line.itemId);
    if (existing) {
      existing.quantity += line.quantity;
    } else {
      rows.set(line.itemId, {
        itemId: line.itemId,
        description: line.description ?? line.itemId,
        quantity: line.quantity,
        unit: line.unit,
      });
    }
  }
  return [...rows.values()].sort((a, b) => a.description.localeCompare(b.description));
}

/** Total labour hours for the selected options — what scheduling is planned against. */
export function labourHours(computed: PbComputed, selected: PbOption[]): number {
  return computed.lines
    .filter((l) => selected.includes(l.option))
    .reduce((n, l) => n + (l.laborHours ?? 0), 0);
}

/**
 * What the selected work costs Red Cedar, and how long it takes.
 *
 * Kyle, 2026-08-20: *"Column E = company cost… In the estimate column E is what we see to track
 * spending"* and *"the total labor hours calculated into total job length"*.
 *
 * Company view only. `materialCost` is absent from a customer line by construction, so calling
 * this on customer data would silently total zero — which is why it takes the computed estimate
 * rather than the presentation options.
 */
export function companySummary(computed: PbComputed, selected: PbOption[]) {
  const lines = computed.lines.filter((l) => selected.includes(l.option));
  const hours = lines.reduce((n, l) => n + (l.laborHours ?? 0), 0);
  const materialCost = lines.reduce((n, l) => n + (l.materialCost ?? 0), 0);
  const materialCharged = lines.reduce((n, l) => n + (l.materialSell ?? 0), 0);
  const labourCost = lines.reduce((n, l) => n + (l.laborDollars ?? 0), 0);
  return {
    hours,
    /** At an eight-hour day — the unit scheduling actually happens in. */
    days: hours / 8,
    materialCost,
    materialCharged,
    labourCost,
  };
}
