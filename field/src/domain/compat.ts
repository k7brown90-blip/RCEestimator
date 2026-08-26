import type { ItemResult, ResultState } from './types'

/**
 * Reading records written by earlier versions of the app.
 *
 * Two things changed shape: the `ACTION` result state was renamed `FAIL`, and
 * the three separate grounding checks (C1 electrodes, C2 rod resistance, C3 GEC)
 * were merged into a single C1 because they shared most of their fields.
 *
 * Applied at every read boundary — the Dexie upgrade, zod parsing, and report
 * assembly — so nothing downstream has to know two shapes exist.
 */

const RESULT_ALIASES: Record<string, ResultState> = {
  ACTION: 'FAIL',
}

export function normalizeResultState(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  return RESULT_ALIASES[raw] ?? raw
}

/** Worst-first, so a merged item inherits the most serious of its parts. */
const SEVERITY_ORDER: ResultState[] = ['NA', 'PASS', 'BELOW_STANDARD', 'MONITOR', 'FAIL']

export function worstResult(results: ResultState[]): ResultState {
  let worst: ResultState = 'NA'
  for (const result of results) {
    if (SEVERITY_ORDER.indexOf(result) > SEVERITY_ORDER.indexOf(worst)) worst = result
  }
  return worst
}

/** Retired items and what they were folded into. */
export const MERGED_ITEM_IDS: Record<string, string> = {
  C2: 'C1', // ground-rod resistance
  C3: 'C1', // grounding electrode conductor
}

/**
 * Human-readable titles for items that no longer exist in the checklist, so an
 * old report can still name what was assessed instead of showing a bare id.
 */
export const RETIRED_ITEM_TITLES: Record<string, string> = {
  C2: 'Ground-rod resistance (measured)',
  C3: 'Grounding electrode conductor (GEC) — size & connection',
  // 2026-08-26 consolidation (Kyle: "I want this consolidated… a lot of
  // duplicate information that is disorganized"): the entire A1…I1 walk was
  // folded into nine rows. These titles keep pre-consolidation records legible.
  A1: 'Service drop / lateral clearances & condition',
  A2: 'Service rating vs. calculated load',
  A3: 'Meter base (external condition) & main disconnect',
  B1: 'Service disconnect — location, marking, rating',
  B2: 'Panel working space & dedicated space',
  C1: 'Grounding electrode system — electrodes, resistance & GEC',
  C4: 'Main bonding jumper & EGC-bar bonding at the service',
  C5: 'Neutral-ground separation at subpanels',
  C6: 'Metal water pipe & gas pipe bonding',
  C7: 'Intersystem bonding termination (ISBT)',
  D1: 'Connection integrity (torque + thermal)',
  D2: 'Breaker-to-conductor sizing',
  D3: 'Breaker compatibility & panel condition',
  D4: 'Panel circuit directory (verified schedule)',
  D5: 'Aluminum branch-circuit wiring',
  D6: 'Service / main termination voltages (control reading)',
  D7: 'Branch-circuit voltage at the OCPD',
  E1: 'GFCI protection (shock)',
  E2: 'AFCI protection (arc-fault fire)',
  E3: 'Surge protection (SPD)',
  F1: 'Receptacle placement & condition',
  F2: 'Egress / Security lighting',
  F3: 'Box fill, cable support & protection',
  G1: 'Water heater disconnect',
  G2: 'HVAC / heating disconnect',
  G3: 'Load balance (measured, fixed/dedicated circuits)',
  H1: 'Smoke & CO alarms',
  H2: 'Panel condition & remaining life',
  I1: 'Metro-specific amendments (Nashville only)',
}

/**
 * Fold stored C2/C3 results into C1.
 *
 * Takes the worst result of the three (a failing GEC must not be softened by a
 * passing electrode check) and unions their measurements and photos, so nothing
 * the technician recorded is lost.
 *
 * `liveItemIds` guards against merging too early: while the checklist still
 * defines C2 and C3 as their own checks, a stored C2 is current data, not a
 * legacy artifact, and folding it would destroy a reading the technician just
 * took. Only ids the checklist has actually retired get merged.
 */
export function mergeLegacyGroundingItems(
  items: ItemResult[],
  liveItemIds?: ReadonlySet<string>,
): ItemResult[] {
  const isRetired = (itemId: string) =>
    itemId in MERGED_ITEM_IDS && (liveItemIds ? !liveItemIds.has(itemId) : true)

  const hasLegacy = items.some((item) => isRetired(item.itemId))
  if (!hasLegacy) return items

  const groups = new Map<string, ItemResult[]>()
  const passthrough: ItemResult[] = []

  const mergeTargets = new Set(Object.values(MERGED_ITEM_IDS))
  for (const item of items) {
    const target = isRetired(item.itemId) ? MERGED_ITEM_IDS[item.itemId] : undefined
    if (target || mergeTargets.has(item.itemId)) {
      const key = target ?? item.itemId
      groups.set(key, [...(groups.get(key) ?? []), item])
    } else {
      passthrough.push(item)
    }
  }

  const merged: ItemResult[] = []
  for (const [itemId, group] of groups) {
    if (group.length === 1 && group[0].itemId === itemId) {
      merged.push(group[0])
      continue
    }
    merged.push({
      itemId,
      result: worstResult(group.map((item) => item.result)),
      // A graded state from a retired item wouldn't mean anything on the merged one.
      gradedState: group.find((item) => item.itemId === itemId)?.gradedState,
      measured: Object.assign({}, ...group.map((item) => item.measured)) as ItemResult['measured'],
      photoIds: [...new Set(group.flatMap((item) => item.photoIds))],
      note: group.map((item) => item.note).filter(Boolean).join(' · ') || undefined,
      resolutionNote:
        group.map((item) => item.resolutionNote).filter(Boolean).join(' · ') || undefined,
      overrideReason: group.find((item) => item.overrideReason)?.overrideReason,
    })
  }

  // Preserve original ordering as far as possible: merged grounding items sit
  // where C1 was, everything else stays put.
  return [...passthrough, ...merged].sort((a, b) => a.itemId.localeCompare(b.itemId))
}

/** Normalise a stored ItemResult from any prior version. */
export function normalizeItemResult(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...raw, result: normalizeResultState(raw.result) }
}
