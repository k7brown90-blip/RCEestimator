import type { MeasuredRow, ResultState } from './types'

/**
 * Turning readings into a diagnosis.
 *
 * The service reading is the control: whatever the utility delivers is that
 * property's baseline. What's diagnostic is the variance from it as you move
 * downstream — and inside a panel, where there's no run length to speak of,
 * there should be essentially none.
 */

/** Δ at or above this, measured at the branch breaker, is a defect. */
export const BRANCH_DROP_FAIL_V = 1.5
/** Δ at or above this — or an unstable reading — is worth watching. */
export const BRANCH_DROP_MONITOR_V = 1.0

/**
 * Verdict for one branch-circuit reading taken at its OCPD.
 *
 * From a metre of busbar and a breaker stab there is no legitimate drop, so
 * 1.5 V means something in the path is degraded: a loose termination, a tired
 * bus stab, or a damaged conductor. Intermittent jumps or sags of a volt are
 * the early form of the same fault, hence MONITOR.
 */
export function branchDropVerdict(deltaVolts: number, unstable = false): ResultState {
  if (!Number.isFinite(deltaVolts)) return 'PASS'
  if (deltaVolts >= BRANCH_DROP_FAIL_V) return 'FAIL'
  if (unstable || deltaVolts >= BRANCH_DROP_MONITOR_V) return 'MONITOR'
  return 'PASS'
}

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value) || 0)
const str = (value: unknown): string => (value == null ? '' : String(value))

/**
 * Plain-language diagnosis for a failing branch reading, ordered nearest-first
 * so the electrician checks the cheap thing before pulling the circuit.
 */
export function branchDropDiagnostic(row: MeasuredRow, referenceVolts: number): string {
  const circuit = str(row.circuit_no) || '?'
  const description = str(row.description)
  const measured = num(row.measured_v)
  const leg = str(row.leg) || 'L1'
  const delta = num(row.delta_v)
  const label = description ? `Circuit ${circuit} (${description})` : `Circuit ${circuit}`

  return (
    `${label} reads ${measured} V against a ${referenceVolts} V ${leg}–N control — ` +
    `a ${delta} V drop measured at the breaker. There is no run length inside the panel to ` +
    `account for it. Suspect chain, nearest-first: the branch-breaker termination, that ` +
    `breaker's bus stab, the panel bus, the main-breaker termination, then the branch ` +
    `conductor itself.`
  )
}

/** Advisory for a reading that jumps or sags rather than sitting still. */
export function unstableReadingNote(row: MeasuredRow): string {
  const circuit = str(row.circuit_no) || '?'
  return (
    `Circuit ${circuit} would not hold a steady reading. An intermittent drop is usually a ` +
    `connection that is loose but still making contact — worth re-checking under load before ` +
    `it becomes a failure.`
  )
}

// ─── SERVICE VOLTAGES (D6) ─────────────────────────────────────────────────────
//
// No pass/fail band is applied to the absolute service voltage: it is the
// control, not a graded value. What IS diagnostic is internal inconsistency,
// which indicates a fault regardless of what the utility delivers.

/** Leg-to-leg imbalance above this points at a compromised neutral. */
export const LEG_IMBALANCE_FAIL_V = 3
/** Neutral-to-ground above this under load points at a loaded neutral. */
export const NEUTRAL_GROUND_MONITOR_V = 1

/** ANSI C84.1 Range A, used only for an informational utility-referral note. */
export const ANSI_RANGE_A = {
  lineToLine: { min: 228, max: 252 },
  lineToNeutral: { min: 114, max: 126 },
}

export interface ServiceVoltageReadings {
  v_l1_l2?: number
  v_l1_n?: number
  v_l2_n?: number
  v_n_g?: number
}

export interface ServiceVoltageFinding {
  verdict: ResultState
  message: string
}

/**
 * Internal-consistency checks on the service readings. These are faults on their
 * own terms — an open neutral is an open neutral whether the utility is
 * delivering 118 V or 124 V.
 */
export function serviceVoltageFindings(readings: ServiceVoltageReadings): ServiceVoltageFinding[] {
  const findings: ServiceVoltageFinding[] = []
  const { v_l1_l2, v_l1_n, v_l2_n, v_n_g } = readings

  if (Number.isFinite(v_l1_n) && Number.isFinite(v_l2_n)) {
    const split = Math.abs((v_l1_n as number) - (v_l2_n as number))
    if (split > LEG_IMBALANCE_FAIL_V) {
      findings.push({
        verdict: 'FAIL',
        message:
          `L1–N and L2–N differ by ${Math.round(split * 10) / 10} V. On a balanced service the ` +
          `two legs should read within a volt of each other; a spread this wide indicates an ` +
          `open or high-resistance neutral, which lets voltage swing on lightly loaded circuits.`,
      })
    }
  }

  if (Number.isFinite(v_n_g) && (v_n_g as number) > NEUTRAL_GROUND_MONITOR_V) {
    findings.push({
      verdict: 'MONITOR',
      message:
        `Neutral-to-ground reads ${v_n_g} V. Some N–G voltage under load is normal, but a ` +
        `persistent reading suggests a loaded or high-resistance neutral, or a neutral bonded ` +
        `to ground somewhere downstream of the service.`,
    })
  }

  // Informational only: an out-of-range service is the utility's to answer for,
  // not a Red Cedar defect.
  if (Number.isFinite(v_l1_l2)) {
    const value = v_l1_l2 as number
    if (value < ANSI_RANGE_A.lineToLine.min || value > ANSI_RANGE_A.lineToLine.max) {
      findings.push({
        verdict: 'MONITOR',
        message:
          `Service reads ${value} V line-to-line, outside the ${ANSI_RANGE_A.lineToLine.min}–` +
          `${ANSI_RANGE_A.lineToLine.max} V the utility is expected to deliver (ANSI C84.1 ` +
          `Range A). Not a defect in the premises wiring — worth a call to the utility.`,
      })
    }
  }

  return findings
}
