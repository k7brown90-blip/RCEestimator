import { describe, expect, it } from 'vitest'
import {
  branchDropDiagnostic,
  branchDropVerdict,
  serviceVoltageFindings,
} from './diagnostics'

describe('branchDropVerdict boundaries', () => {
  // These exact numbers came from the owner: "if all voltages are good it's a
  // pass, if there is intermittent jumps or sags by 1 volt it's monitor, if it
  // drops 1.5 volts or more it's fail."
  it('passes below 1.0 V', () => {
    expect(branchDropVerdict(0)).toBe('PASS')
    expect(branchDropVerdict(0.5)).toBe('PASS')
    expect(branchDropVerdict(0.99)).toBe('PASS')
  })

  it('monitors from 1.0 V up to but not including 1.5 V', () => {
    expect(branchDropVerdict(1.0)).toBe('MONITOR')
    expect(branchDropVerdict(1.2)).toBe('MONITOR')
    expect(branchDropVerdict(1.49)).toBe('MONITOR')
  })

  it('fails at 1.5 V and above', () => {
    expect(branchDropVerdict(1.5)).toBe('FAIL')
    expect(branchDropVerdict(2.0)).toBe('FAIL')
    expect(branchDropVerdict(6)).toBe('FAIL')
  })

  it('escalates a passing reading to MONITOR when it will not hold steady', () => {
    // An intermittent drop is a loose connection still making contact.
    expect(branchDropVerdict(0.3, true)).toBe('MONITOR')
  })

  it('does not let instability downgrade an already-failing reading', () => {
    expect(branchDropVerdict(2.0, true)).toBe('FAIL')
  })

  it('treats a negative delta as passing rather than failing backwards', () => {
    expect(branchDropVerdict(-1.5)).toBe('PASS')
  })

  it('does not fail on a missing reading', () => {
    expect(branchDropVerdict(NaN)).toBe('PASS')
  })
})

describe('branchDropDiagnostic', () => {
  it('names the circuit, the numbers, and the suspect chain nearest-first', () => {
    const text = branchDropDiagnostic(
      { circuit_no: '14', description: 'kitchen recept', leg: 'L1', measured_v: 118.2, delta_v: 1.8 },
      120,
    )
    expect(text).toContain('Circuit 14 (kitchen recept)')
    expect(text).toContain('118.2 V')
    expect(text).toContain('120 V L1–N control')
    expect(text).toContain('1.8 V drop')
    // Nearest-first: check the termination before pulling the circuit.
    const collapsed = text.replace(/\s+/g, ' ')
    expect(collapsed.indexOf('branch-breaker termination'))
      .toBeLessThan(collapsed.indexOf('branch conductor itself'))
    expect(collapsed.indexOf('bus stab')).toBeLessThan(collapsed.indexOf('main-breaker termination'))
  })

  it('reads sensibly with no circuit description', () => {
    const text = branchDropDiagnostic({ circuit_no: '7', measured_v: 118, delta_v: 2 }, 120)
    expect(text).toContain('Circuit 7 reads')
    expect(text).not.toContain('()')
  })
})

describe('serviceVoltageFindings', () => {
  it('says nothing about a healthy, consistent service', () => {
    expect(serviceVoltageFindings({
      v_l1_l2: 241, v_l1_n: 120.4, v_l2_n: 120.6, v_n_g: 0.3,
    })).toEqual([])
  })

  it('does not grade the absolute voltage — it is the control, not a score', () => {
    // A house delivered 122 V simply has a 122 V baseline.
    const findings = serviceVoltageFindings({ v_l1_l2: 244, v_l1_n: 122, v_l2_n: 122, v_n_g: 0.2 })
    expect(findings).toEqual([])
  })

  it('fails a leg split wide enough to mean an open neutral', () => {
    const findings = serviceVoltageFindings({ v_l1_n: 132, v_l2_n: 108 })
    expect(findings).toHaveLength(1)
    expect(findings[0].verdict).toBe('FAIL')
    expect(findings[0].message).toContain('open or high-resistance neutral')
  })

  it('tolerates a normal volt of difference between the legs', () => {
    expect(serviceVoltageFindings({ v_l1_n: 120.8, v_l2_n: 119.9 })).toEqual([])
  })

  it('monitors elevated neutral-to-ground', () => {
    const findings = serviceVoltageFindings({ v_l1_n: 120, v_l2_n: 120, v_n_g: 2.4 })
    expect(findings).toHaveLength(1)
    expect(findings[0].verdict).toBe('MONITOR')
    expect(findings[0].message).toContain('downstream')
  })

  it('flags an out-of-range service as a utility matter, not a wiring defect', () => {
    const findings = serviceVoltageFindings({ v_l1_l2: 210, v_l1_n: 105, v_l2_n: 105 })
    const utility = findings.find((f) => f.message.includes('utility'))
    expect(utility).toBeDefined()
    expect(utility!.verdict).toBe('MONITOR') // never FAIL — it isn't ours to fix
    expect(utility!.message).toContain('Not a defect in the premises wiring')
  })

  it('says nothing when no readings have been taken yet', () => {
    expect(serviceVoltageFindings({})).toEqual([])
  })
})
