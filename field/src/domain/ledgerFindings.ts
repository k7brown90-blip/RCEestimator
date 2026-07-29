import { expectedEolYear } from '../data/endOfLife'
import { isCriticalFinding } from './findings'
import type { ReportModel } from './report'
import type { GradedState, ResultState } from './types'

/**
 * The self-describing findings a completed record pushes to the office.
 *
 * The server has no copy of the checklist — `checklist.ts` ships only in the PWA
 * bundle, and the stored `itemsJson` carries item ids with no titles and no
 * citations. A cure certificate is a code-cited legal document, so the record has
 * to carry its own text: the title, the citations *as they applied in this
 * jurisdiction on this date*, and the finding sentence the customer was shown.
 *
 * Snapshotting rather than re-deriving is the whole point. A 2017-NEC finding
 * must never be recited under the 2023 code because the county adopted it two
 * years later — that would rewrite the notice the customer was given.
 */

/**
 * Two tracks, two purposes.
 *
 * `defect` is a code violation or a hazard, and it ends in *corrected*. `upgrade`
 * is wear against a published service life, or an installation that meets code
 * but not our standard, and it ends in *replaced/upgraded*. Both are documented
 * whether or not the work is ever done; only the defect track produces cure
 * certificates.
 */
export type FindingTrack = 'defect' | 'upgrade'

export type LedgeredResult = Extract<ResultState, 'FAIL' | 'MONITOR' | 'BELOW_STANDARD'>

export const LEDGERED_RESULTS: LedgeredResult[] = ['FAIL', 'MONITOR', 'BELOW_STANDARD']

export function trackFor(result: LedgeredResult): FindingTrack {
  return result === 'FAIL' ? 'defect' : 'upgrade'
}

export interface PushFinding {
  itemId: string
  /**
   * Which enclosure this was found at. Absent for the single Phase 1 location;
   * `_default` is the server-side key, chosen because Postgres treats NULLs as
   * distinct in a unique index and would happily duplicate every row.
   */
  locationId?: string
  locationKey: string
  result: LedgeredResult
  track: FindingTrack
  gradedState?: GradedState
  title: string
  section: string
  citations: string[]
  critical: boolean
  /** The sentence the customer was shown, with the readings already merged in. */
  findingText: string
  note?: string
  resolutionNote?: string
  photoIds: string[]
  /** Upgrade track only — the year this equipment reaches its published life. */
  expectedEolYear?: number
}

/**
 * Everything on a finished record that opens or re-observes a ledger row.
 *
 * PASS and NA are deliberately absent: a later PASS is *evidence* the office
 * weighs when closing a finding out, not a finding of its own, and the server
 * reconciles it from `itemsJson`. Sending it as a finding would invite something
 * downstream to treat it as a cure.
 */
export function buildLedgerFindings(report: ReportModel): PushFinding[] {
  const ledgered = new Set<string>(LEDGERED_RESULTS)

  return report.items
    .filter((entry) => ledgered.has(entry.result.result))
    .map((entry) => {
      const result = entry.result.result as LedgeredResult
      const track = trackFor(result)
      const eol = track === 'upgrade' ? expectedEolYear(entry.def.id, entry.result.measured) : undefined

      return {
        itemId: entry.def.id,
        ...(entry.result.locationId ? { locationId: entry.result.locationId } : {}),
        locationKey: entry.result.locationId ?? '_default',
        result,
        track,
        ...(entry.result.gradedState ? { gradedState: entry.result.gradedState } : {}),
        title: entry.def.title,
        section: entry.def.section,
        // From the report, not the def: a jurisdiction can override citations,
        // and the override is part of what was said.
        citations: entry.citations,
        critical: isCriticalFinding(entry.result),
        findingText: entry.whatWeFound,
        ...(entry.result.note ? { note: entry.result.note } : {}),
        ...(entry.result.resolutionNote ? { resolutionNote: entry.result.resolutionNote } : {}),
        photoIds: entry.result.photoIds,
        ...(eol !== undefined ? { expectedEolYear: eol } : {}),
      }
    })
}
