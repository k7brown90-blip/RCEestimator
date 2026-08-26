import { describe, expect, it } from 'vitest'
import { checklist } from './checklist'
import type { ChecklistItemDef, InputFieldDef } from '../domain/types'

/**
 * The walk is a field-procedure decision, not an implementation detail.
 *
 * Since the 2026-08-26 consolidation (Kyle: "I need the check to be organized
 * like this exactly") the whole assessment is one pass in his stated order —
 * so the row set AND the order are asserted literally. A failure here means
 * someone changed the procedure, which is fine; it just has to be on purpose.
 */

const WALK_ORDER = ['LOAD', 'METER', 'MAIN', 'SUB', 'GES', 'SPD', 'HVAC', 'WH', 'WIRE']

/** Every field an item can carry a reading in, table columns included. */
const allFields = (item: ChecklistItemDef): InputFieldDef[] =>
  item.inputFields.flatMap((field) => [field, ...(field.columns ?? [])])

describe('the consolidated walk', () => {
  it("is exactly Kyle's nine rows, in his order", () => {
    expect(checklist.map((item) => item.id)).toEqual(WALK_ORDER)
  })

  it('starts with the calculated load — "The start with every customer"', () => {
    expect(checklist[0].id).toBe('LOAD')
  })

  it('puts every row in the single pass', () => {
    for (const item of checklist) {
      expect(item.phase, `${item.id} is not phase 1`).toBe(1)
    }
  })

  it('keeps only the sub-panel row repeatable', () => {
    expect(checklist.filter((item) => item.repeatable).map((item) => item.id)).toEqual(['SUB'])
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
