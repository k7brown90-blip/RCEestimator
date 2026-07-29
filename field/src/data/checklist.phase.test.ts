import { describe, expect, it } from 'vitest'
import { checklist } from './checklist'
import type { ChecklistItemDef, InputFieldDef } from '../domain/types'

/**
 * The phase split is a field-procedure decision, not an implementation detail.
 *
 * Phase 1 is everything reachable in one pass at the service: the tech stands in
 * one place, opens one enclosure, and does not go inside. Moving an item across
 * that line changes what a technician can finish in a visit and what a Phase 1
 * record is allowed to claim — so the sets are asserted literally. A failure here
 * means someone changed the procedure, which is fine; it just has to be on purpose.
 */

const PHASE_1 = [
  'A1', 'A2', 'A3',
  'B1', 'B2',
  'C1', 'C4', 'C6', 'C7',
  'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7',
  'E3',
  'G2', 'G3',
  'H2',
]

const PHASE_2 = ['C5', 'E1', 'E2', 'F1', 'F2', 'F3', 'G1', 'H1', 'I1']

const idsInPhase = (phase: 1 | 2) =>
  checklist.filter((item) => item.phase === phase).map((item) => item.id).sort()

/** Every field an item can carry a reading in, table columns included. */
const allFields = (item: ChecklistItemDef): InputFieldDef[] =>
  item.inputFields.flatMap((field) => [field, ...(field.columns ?? [])])

describe('inspection phases', () => {
  it('assigns Phase 1 to exactly the service-and-exterior pass', () => {
    expect(idsInPhase(1)).toEqual([...PHASE_1].sort())
  })

  it('assigns Phase 2 to exactly the interior pass', () => {
    expect(idsInPhase(2)).toEqual([...PHASE_2].sort())
  })

  it('assigns every item to one phase or the other', () => {
    expect(PHASE_1.length + PHASE_2.length).toBe(checklist.length)
  })

  it('never lets a Phase 1 item apply only to interior locations', () => {
    for (const item of checklist.filter((i) => i.phase === 1)) {
      expect(
        item.appliesTo.some((kind) => kind === 'service_exterior' || kind === 'panel'),
        `${item.id} is Phase 1 but applies only to ${item.appliesTo.join(', ')}`,
      ).toBe(true)
    }
  })
})

describe('item dependencies', () => {
  it('depends only on items that exist', () => {
    const ids = new Set(checklist.map((item) => item.id))
    for (const item of checklist) {
      for (const dependency of item.dependsOn ?? []) {
        expect(ids.has(dependency), `${item.id} depends on unknown item ${dependency}`).toBe(true)
      }
    }
  })

  it('never depends on an item assessed in a later phase', () => {
    // ChecklistScreen locks an item until its dependencies are recorded. A
    // forward dependency would leave a Phase 1 item permanently unopenable.
    const phaseOf = new Map(checklist.map((item) => [item.id, item.phase]))
    for (const item of checklist) {
      for (const dependency of item.dependsOn ?? []) {
        expect(
          (phaseOf.get(dependency) ?? 1) <= item.phase,
          `${item.id} (phase ${item.phase}) depends on ${dependency} (phase ${phaseOf.get(dependency)})`,
        ).toBe(true)
      }
    }
  })

  it('resolves every cross-item formula reference to a real field', () => {
    const fieldIdsOf = (id: string) =>
      new Set(allFields(checklist.find((item) => item.id === id) ?? ({ inputFields: [] } as unknown as ChecklistItemDef)).map((f) => f.id))

    for (const item of checklist) {
      for (const field of allFields(item)) {
        for (const ref of field.formulaInputs ?? []) {
          if (!ref.includes('.')) {
            expect(
              fieldIdsOf(item.id).has(ref),
              `${item.id}.${field.id}: formula input ${ref} is not a field on this item`,
            ).toBe(true)
            continue
          }
          const [otherId, fieldId] = ref.split('.')
          expect(
            fieldIdsOf(otherId).has(fieldId),
            `${item.id}.${field.id}: formula input ${ref} does not exist`,
          ).toBe(true)
          expect(
            (item.dependsOn ?? []).includes(otherId),
            `${item.id} reads ${otherId} but does not list it in dependsOn`,
          ).toBe(true)
        }
      }
    }
  })
})

describe('measurement discipline', () => {
  it('backs every measurementRequired item with a required number the tech must record', () => {
    // "We want to always measure to collect data (amps, volts, ohms)." An item
    // that claims a measurement but offers nowhere to put one is a checkbox.
    for (const item of checklist.filter((i) => i.measurementRequired)) {
      const numeric = allFields(item).filter(
        (field) => field.type === 'number' && (field.required || field.requiredWhen),
      )
      expect(numeric.length, `${item.id} is measurementRequired with no required numeric field`)
        .toBeGreaterThan(0)
    }
  })

  it('gives every select and multiselect real options', () => {
    for (const item of checklist) {
      for (const field of allFields(item)) {
        if (field.type !== 'select' && field.type !== 'multiselect') continue
        expect(field.options?.length ?? 0, `${item.id}.${field.id} has no options`).toBeGreaterThan(0)
      }
    }
  })

  it('gives every option a report label, so no report prints a stored token', () => {
    // Table columns are exempt: their values render inside the table, never in prose.
    for (const item of checklist) {
      for (const field of item.inputFields) {
        if (field.type !== 'select' && field.type !== 'multiselect') continue
        for (const option of field.options ?? []) {
          expect(option.reportLabel, `${item.id}.${field.id}.${option.value} has no reportLabel`)
            .toBeTruthy()
        }
      }
    }
  })

  it('points every threshold at a value the field can actually hold', () => {
    for (const item of checklist) {
      for (const field of allFields(item)) {
        for (const threshold of field.thresholds ?? []) {
          if (threshold.when.eq === undefined) continue
          const values = (field.options ?? []).map((option) => option.value)
          expect(
            values.includes(String(threshold.when.eq)),
            `${item.id}.${field.id}: threshold on '${threshold.when.eq}', which is not an option`,
          ).toBe(true)
        }
      }
    }
  })

  it('keeps every repeatable item assessable at a panel', () => {
    for (const item of checklist.filter((i) => i.repeatable)) {
      expect(item.appliesTo, `${item.id} repeats but does not apply to a panel`).toContain('panel')
    }
  })
})
