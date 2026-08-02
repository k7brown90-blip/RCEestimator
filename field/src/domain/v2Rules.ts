/**
 * Client-side mirror of the protocol v2 hard rules — immediate feedback while
 * the panel is still open, instead of a 422 at sync time.
 *
 * The SERVER is the enforcement point (app/src/services/protocolV2Ingest.ts);
 * these functions must stay behaviorally identical to it. If they drift, the
 * failure mode is an inspection stuck in the sync queue — annoying, not
 * unsafe — because the server still refuses the bad row.
 */

import type { V2Capture, V2Enclosure, V2Item, V2Measurement } from './v2Types'

const THERMAL_TYPES = new Set(['thermal_delta_t', 'thermal_absolute', 'stab_thermal_delta_t'])
const COMPARATIVE_TYPES = new Set(['thermal_delta_t', 'stab_thermal_delta_t'])

export interface V2Violation {
  rule: string
  message: string
}

/** Validate one measurement in the context of its enclosure. */
export function checkMeasurement(
  m: V2Measurement,
  enclosure: V2Enclosure | undefined,
): V2Violation | null {
  if (m.measurementType === 'torque' && enclosure?.serviceSideEnergized) {
    return {
      rule: 'service_side_energized',
      message:
        'No torque on the service side — those lugs stay energized with the main open. Thermal scan and visual assessment only (settled policy §3.3).',
    }
  }
  if (THERMAL_TYPES.has(m.measurementType) && m.loadAmperageAtReading == null) {
    return {
      rule: 'companion_current_required',
      message: 'Record the circuit current with every thermal reading — without load the number is meaningless (rule 1).',
    }
  }
  if (COMPARATIVE_TYPES.has(m.measurementType) && !m.comparativeReferenceItemId) {
    return {
      rule: 'comparative_reference_required',
      message: 'Name what this ΔT was compared against (adjacent similarly-loaded component) — rule 2.',
    }
  }
  return null
}

/** All violations for one item. */
export function checkItem(item: V2Item, enclosures: V2Enclosure[]): V2Violation[] {
  const enclosure = enclosures.find((e) => e.locationKey === item.locationKey)
  const violations: V2Violation[] = []
  for (const m of item.measurements ?? []) {
    const violation = checkMeasurement(m, enclosure)
    if (violation) violations.push(violation)
  }
  // Bus components need the structured rubric — "corroded" without location
  // and plating status is not a finding (§8.5).
  const busComponents = new Set(['bus_stab', 'bus_joint', 'bus_bar_section'])
  if (busComponents.has(item.componentType) && !item.busVisual) {
    violations.push({
      rule: 'bus_visual_required',
      message: 'Bus components need the structured visual rubric (corrosion location, plating status…) — §8.5.',
    })
  }
  return violations
}

/**
 * Whole-capture check before completing the inspection. Includes the rule-6
 * sampling gate the server will enforce: a failed sample that never expanded
 * to 100% cannot close.
 */
export function checkCapture(capture: V2Capture): V2Violation[] {
  const violations: V2Violation[] = []
  for (const s of capture.samplingRecords) {
    if (s.expandedDueToFail && s.testedCount < s.totalCount) {
      violations.push({
        rule: 'sampling_expansion_incomplete',
        message: `${s.category}: a FAIL inside a sample expands it to 100% before close — ${s.testedCount}/${s.totalCount} tested (§6.3).`,
      })
    }
  }
  for (const item of capture.items) {
    for (const v of checkItem(item, capture.enclosures)) {
      violations.push({ ...v, message: `${item.componentType}${item.locationLabel ? ` (${item.locationLabel})` : ''}: ${v.message}` })
    }
  }
  return violations
}

/** Measurement types offered for a component, in field-kit terms (§3.1/§3.2). */
export function measurementTypesFor(componentType: string, enclosure: V2Enclosure | undefined): string[] {
  const base = ['voltage_unloaded', 'voltage_loaded', 'current', 'voltage_drop_pct']
  switch (componentType) {
    case 'lug':
    case 'breaker':
      return enclosure?.serviceSideEnergized
        ? ['thermal_delta_t', 'thermal_absolute', ...base] // §3.3: no torque here
        : ['torque', 'thermal_delta_t', 'thermal_absolute', ...base]
    case 'bus_stab':
    case 'bus_joint':
    case 'bus_bar_section':
      return ['stab_thermal_delta_t', 'thermal_absolute', 'current']
    case 'neutral_bar':
      return ['torque', 'thermal_delta_t', 'current', ...base]
    case 'ground_bar':
      return ['torque', 'grounding_resistance', 'thermal_delta_t']
    case 'receptacle':
      return ['voltage_unloaded', 'voltage_loaded', 'voltage_drop_pct', 'receptacle_tension', 'thermal_delta_t']
    default:
      return ['thermal_delta_t', ...base]
  }
}
