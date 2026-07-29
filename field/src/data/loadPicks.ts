import type { LoadItem, LoadType } from '../domain/loadcalc'

/**
 * Typical nameplates, all editable.
 *
 * Extracted so the standalone capacity check, the A2 panel inside an assessment,
 * and the CRM's phone-quoting panel can't drift on what a "typical" water heater
 * is. Three lists that disagree would produce three different answers to the same
 * question, and the customer would be shown whichever one the technician
 * happened to open.
 *
 * `nameplateRead` starts false — these are assumptions until someone reads the
 * plate, and the calculation says which of its inputs were guessed.
 */

export interface LoadPick {
  label: string
  item: Omit<LoadItem, 'id'>
}

export const QUICK_PICKS: LoadPick[] = [
  { label: 'Range 12 kW', item: { type: 'range', label: 'Range', nameplateKW: 12, volts: 240 } },
  { label: 'Wall oven 4 kW', item: { type: 'oven', label: 'Wall oven', nameplateKW: 4, volts: 240 } },
  { label: 'Cooktop 5 kW', item: { type: 'cooktop', label: 'Cooktop', nameplateKW: 5, volts: 240 } },
  { label: 'Dryer 5 kW', item: { type: 'dryer', label: 'Dryer', nameplateKW: 5, volts: 240 } },
  { label: 'Water heater 4.5 kW', item: { type: 'waterHeaterTank', label: 'Water heater (tank)', nameplateKW: 4.5, volts: 240 } },
  { label: 'Tankless WH 24 kW', item: { type: 'waterHeaterTankless', label: 'Tankless water heater', nameplateKW: 24, volts: 240 } },
  { label: 'Dishwasher 1.2 kW', item: { type: 'fixedAppliance', label: 'Dishwasher', nameplateKW: 1.2, volts: 120 } },
  { label: 'Disposal 0.9 kW', item: { type: 'fixedAppliance', label: 'Disposal', nameplateKW: 0.9, volts: 120 } },
  { label: 'Microwave 1.5 kW', item: { type: 'fixedAppliance', label: 'Built-in microwave', nameplateKW: 1.5, volts: 120 } },
  { label: 'Electric heat 10 kW', item: { type: 'spaceHeat', label: 'Electric space heat', nameplateKW: 10, volts: 240, separatelyControlledUnits: 1 } },
  { label: 'A/C 28 A', item: { type: 'cooling', label: 'Central A/C', amps: 28, volts: 240 } },
  { label: 'Heat pump + supp.', item: { type: 'heatPump', label: 'Heat pump + supplemental', heatPump: { compressorVA: 7680, supplementalVA: 10000, lockout: false }, volts: 240 } },
  { label: 'Well pump 1 kVA', item: { type: 'motor', label: 'Well pump', nameplateVA: 1000, volts: 240 } },
  { label: 'Pool pump 2.9 kVA', item: { type: 'poolPump', label: 'Pool pump', nameplateVA: 2880, volts: 240 } },
  { label: 'EV charger 9.6 kW', item: { type: 'evse', label: 'EV charger', nameplateKW: 9.6, volts: 240 } },
]

/** The loads customers actually call about adding. */
export const FUTURE_PICKS: LoadPick[] = [
  { label: 'EV charger 9.6 kW', item: { type: 'evse', label: 'EV charger (40 A)', nameplateKW: 9.6, volts: 240 } },
  { label: 'EV charger 11.5 kW', item: { type: 'evse', label: 'EV charger (48 A)', nameplateKW: 11.5, volts: 240 } },
  { label: 'Tankless WH 18 kW', item: { type: 'waterHeaterTankless', label: 'Tankless water heater', nameplateKW: 18, volts: 240 } },
  { label: 'Hot tub 8 kW', item: { type: 'spaSelfContained', label: 'Hot tub', nameplateKW: 8, volts: 240, continuous: false } },
  { label: 'Heat pump 7.7 kVA', item: { type: 'heatPump', label: 'Heat pump', heatPump: { compressorVA: 7680, supplementalVA: 0, lockout: false }, volts: 240 } },
  { label: 'Heat pump + 15 kW strips', item: { type: 'heatPump', label: 'Heat pump with supplemental heat', heatPump: { compressorVA: 7680, supplementalVA: 15000, lockout: false }, volts: 240 } },
  { label: 'Electric heat 10 kW', item: { type: 'spaceHeat', label: 'Electric space heat', nameplateKW: 10, volts: 240 } },
  { label: 'Central A/C 28 A', item: { type: 'cooling', label: 'Central A/C', amps: 28, volts: 240 } },
  { label: 'Addition lighting 1.8 kVA', item: { type: 'generalLighting', label: 'Addition — general lighting', nameplateVA: 1800, volts: 120 } },
]

/** Full taxonomy, for unusual homes. */
export const ALL_TYPES: LoadType[] = [
  'fixedAppliance', 'range', 'oven', 'cooktop', 'dryer',
  'waterHeaterTank', 'waterHeaterTankless', 'spaceHeat', 'cooling', 'heatPump',
  'motor', 'poolPump', 'poolHeater', 'poolBlower', 'spaSelfContained',
  'evse', 'arcWelder', 'resistanceWelder', 'elevatorLift', 'snowMeltDeice',
  'exteriorCircuit', 'generalLighting', 'other',
]

/** Load types that select 220.83(B) — new A/C or space heat, at 100%. */
export const HVAC_PICK_TYPES: ReadonlySet<LoadType> = new Set([
  'spaceHeat', 'cooling', 'heatPump',
])

export function newLoadItem(partial: Omit<LoadItem, 'id'>): LoadItem {
  return { id: crypto.randomUUID(), nameplateRead: false, ...partial }
}
