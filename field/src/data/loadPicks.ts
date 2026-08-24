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
 *
 * ── THE CATALOG IS ROOM-BY-ROOM AND DELIBERATELY COMPREHENSIVE (2026-08-24) ──
 * Kyle: "a comprehensive one that I can do off of square footage and a quick
 * review of their appliances but needs to take into account anything that can be
 * found at a residence or home garage." So the picks walk the way the house is
 * walked — kitchen, laundry & bath, heating & cooling, water & pumps, garage &
 * shop, outdoor/pool, other — and each value is a trade-typical nameplate, not a
 * guess pulled from the air. What the code already covers without a line item is
 * deliberately ABSENT: washers ride the 1500 VA laundry circuit (220.52),
 * countertop plug-ins ride the small-appliance circuits, ordinary receptacles
 * and fans ride the 3 VA/ft² general lighting load (220.14(J)). Adding those
 * would double-count.
 */

export interface LoadPick {
  label: string
  item: Omit<LoadItem, 'id'>
}

export interface PickCategory {
  category: string
  picks: LoadPick[]
}

export const QUICK_PICK_CATEGORIES: PickCategory[] = [
  {
    category: 'Kitchen',
    picks: [
      { label: 'Range 12 kW', item: { type: 'range', label: 'Range', nameplateKW: 12, volts: 240 } },
      { label: 'Wall oven 4 kW', item: { type: 'oven', label: 'Wall oven', nameplateKW: 4, volts: 240 } },
      { label: 'Double wall oven 8 kW', item: { type: 'oven', label: 'Double wall oven', nameplateKW: 8, volts: 240 } },
      { label: 'Cooktop 5 kW', item: { type: 'cooktop', label: 'Cooktop', nameplateKW: 5, volts: 240 } },
      { label: 'Induction cooktop 7.2 kW', item: { type: 'cooktop', label: 'Induction cooktop', nameplateKW: 7.2, volts: 240 } },
      { label: 'Dishwasher 1.2 kW', item: { type: 'fixedAppliance', label: 'Dishwasher', nameplateKW: 1.2, volts: 120 } },
      { label: 'Disposal 0.9 kW', item: { type: 'fixedAppliance', label: 'Disposal', nameplateKW: 0.9, volts: 120 } },
      { label: 'Microwave 1.5 kW', item: { type: 'fixedAppliance', label: 'Built-in microwave', nameplateKW: 1.5, volts: 120 } },
      { label: 'Trash compactor 0.9 kW', item: { type: 'fixedAppliance', label: 'Trash compactor', nameplateKW: 0.9, volts: 120 } },
      { label: 'Instant-hot dispenser 0.75 kW', item: { type: 'fixedAppliance', label: 'Instant-hot water dispenser', nameplateKW: 0.75, volts: 120 } },
      { label: 'Warming drawer 0.5 kW', item: { type: 'fixedAppliance', label: 'Warming drawer', nameplateKW: 0.5, volts: 120 } },
    ],
  },
  {
    category: 'Laundry & bath',
    picks: [
      { label: 'Dryer 5 kW', item: { type: 'dryer', label: 'Dryer', nameplateKW: 5, volts: 240 } },
      { label: 'Sauna heater 6 kW', item: { type: 'fixedAppliance', label: 'Sauna heater', nameplateKW: 6, volts: 240 } },
      { label: 'Steam shower 9 kW', item: { type: 'fixedAppliance', label: 'Steam shower generator', nameplateKW: 9, volts: 240 } },
      { label: 'Jetted tub 1.4 kW', item: { type: 'motor', label: 'Jetted tub pump', nameplateKW: 1.4, volts: 120 } },
      { label: 'Bath wall heater 1.5 kW', item: { type: 'spaceHeat', label: 'Bathroom wall heater', nameplateKW: 1.5, volts: 240, separatelyControlledUnits: 1 } },
    ],
  },
  {
    category: 'Heating & cooling',
    picks: [
      { label: 'Electric furnace 15 kW', item: { type: 'spaceHeat', label: 'Electric furnace', nameplateKW: 15, volts: 240, separatelyControlledUnits: 1 } },
      { label: 'Electric heat 10 kW', item: { type: 'spaceHeat', label: 'Electric space heat', nameplateKW: 10, volts: 240, separatelyControlledUnits: 1 } },
      { label: 'Baseboard heat 2 kW/room', item: { type: 'spaceHeat', label: 'Baseboard heat (per room — set units)', nameplateKW: 2, volts: 240, separatelyControlledUnits: 1 } },
      { label: 'Radiant floor heat 3 kW', item: { type: 'spaceHeat', label: 'Radiant floor heat', nameplateKW: 3, volts: 240, separatelyControlledUnits: 1 } },
      { label: 'Central A/C 28 A', item: { type: 'cooling', label: 'Central A/C', amps: 28, volts: 240 } },
      { label: 'Central A/C 17 A (2-ton)', item: { type: 'cooling', label: 'Central A/C (2-ton)', amps: 17, volts: 240 } },
      { label: 'Window A/C 1.2 kW', item: { type: 'cooling', label: 'Window A/C unit', nameplateKW: 1.2, volts: 120 } },
      { label: 'Heat pump + supp.', item: { type: 'heatPump', label: 'Heat pump + supplemental', heatPump: { compressorVA: 7680, supplementalVA: 10000, lockout: false }, volts: 240 } },
      { label: 'Mini-split 3.6 kVA', item: { type: 'heatPump', label: 'Mini-split heat pump', heatPump: { compressorVA: 3600, supplementalVA: 0, lockout: false }, volts: 240 } },
      { label: 'Whole-house fan 0.6 kW', item: { type: 'motor', label: 'Whole-house fan', nameplateKW: 0.6, volts: 120 } },
      { label: 'Attic fan 0.3 kW', item: { type: 'motor', label: 'Attic fan', nameplateKW: 0.3, volts: 120 } },
      { label: 'Dehumidifier 0.7 kW', item: { type: 'fixedAppliance', label: 'Whole-home dehumidifier', nameplateKW: 0.7, volts: 120 } },
    ],
  },
  {
    category: 'Water & pumps',
    picks: [
      { label: 'Water heater 4.5 kW', item: { type: 'waterHeaterTank', label: 'Water heater (tank)', nameplateKW: 4.5, volts: 240 } },
      { label: 'Heat-pump WH 4.5 kW', item: { type: 'waterHeaterTank', label: 'Heat-pump (hybrid) water heater', nameplateKW: 4.5, volts: 240 } },
      { label: 'Tankless WH 24 kW', item: { type: 'waterHeaterTankless', label: 'Tankless water heater', nameplateKW: 24, volts: 240 } },
      { label: 'Well pump 1 kVA', item: { type: 'motor', label: 'Well pump', nameplateVA: 1000, volts: 240 } },
      { label: 'Well pump 2 HP 2.3 kVA', item: { type: 'motor', label: 'Well pump (2 HP)', nameplateVA: 2300, volts: 240 } },
      { label: 'Sump pump 0.8 kVA', item: { type: 'motor', label: 'Sump pump', nameplateVA: 800, volts: 120 } },
      { label: 'Sewage ejector 1.2 kVA', item: { type: 'motor', label: 'Sewage ejector pump', nameplateVA: 1200, volts: 120 } },
    ],
  },
  {
    category: 'Garage & shop',
    picks: [
      { label: 'EV charger 9.6 kW (40 A)', item: { type: 'evse', label: 'EV charger (40 A)', nameplateKW: 9.6, volts: 240 } },
      { label: 'EV charger 7.7 kW (32 A)', item: { type: 'evse', label: 'EV charger (32 A)', nameplateKW: 7.7, volts: 240 } },
      { label: 'Arc welder 11.5 kVA @ 20%', item: { type: 'arcWelder', label: 'Arc welder (230 V)', nameplateVA: 11500, volts: 240, dutyCyclePct: 20 } },
      { label: 'Wire-feed welder 5.5 kVA @ 20%', item: { type: 'arcWelder', label: 'Wire-feed (MIG) welder', nameplateVA: 5500, volts: 240, dutyCyclePct: 20 } },
      { label: 'Air compressor 3.6 kVA', item: { type: 'motor', label: 'Air compressor (60-gal)', nameplateVA: 3600, volts: 240 } },
      { label: 'Shop machine 1.8 kVA', item: { type: 'motor', label: 'Shop machine (saw/dust collector)', nameplateVA: 1800, volts: 240 } },
      { label: 'Car lift 2.2 kVA', item: { type: 'motor', label: 'Vehicle lift', nameplateVA: 2200, volts: 240 } },
      { label: 'Kiln 7.2 kW', item: { type: 'other', label: 'Kiln / pottery oven', nameplateKW: 7.2, volts: 240 } },
      { label: 'Garage heater 5 kW', item: { type: 'spaceHeat', label: 'Garage unit heater', nameplateKW: 5, volts: 240, separatelyControlledUnits: 1 } },
      { label: 'Garage door opener 0.5 kW', item: { type: 'motor', label: 'Garage door opener', nameplateKW: 0.5, volts: 120 } },
      { label: 'Garage fridge/freezer 0.8 kW', item: { type: 'fixedAppliance', label: 'Garage refrigerator/freezer', nameplateKW: 0.8, volts: 120 } },
      { label: 'RV outlet 9.6 kVA (50 A)', item: { type: 'exteriorCircuit', label: 'RV outlet (14-50)', nameplateVA: 9600, volts: 240 } },
    ],
  },
  {
    category: 'Outdoor, pool & spa',
    picks: [
      { label: 'Hot tub 8 kW', item: { type: 'spaSelfContained', label: 'Hot tub / spa', nameplateKW: 8, volts: 240 } },
      { label: 'Pool pump 2.9 kVA', item: { type: 'poolPump', label: 'Pool pump', nameplateVA: 2880, volts: 240 } },
      { label: 'Pool heater 11 kW', item: { type: 'poolHeater', label: 'Electric pool heater', nameplateKW: 11, volts: 240 } },
      { label: 'Pool blower 1 kVA', item: { type: 'poolBlower', label: 'Pool blower', nameplateVA: 1000, volts: 240 } },
      { label: 'Pond/fountain pump 0.5 kVA', item: { type: 'motor', label: 'Pond/fountain pump', nameplateVA: 500, volts: 120 } },
      { label: 'Landscape lighting 0.6 kVA', item: { type: 'exteriorCircuit', label: 'Landscape lighting', nameplateVA: 600, volts: 120 } },
      { label: 'Gate opener 0.5 kVA', item: { type: 'motor', label: 'Gate opener', nameplateVA: 500, volts: 120 } },
      { label: 'Snow melt 5 kW', item: { type: 'snowMeltDeice', label: 'Snow-melt / de-icing', nameplateKW: 5, volts: 240 } },
      { label: 'Detached building 1.5 kVA', item: { type: 'exteriorCircuit', label: 'Detached building circuit', nameplateVA: 1500, volts: 240 } },
    ],
  },
  {
    category: 'Other',
    picks: [
      { label: 'Stair lift 0.6 kVA', item: { type: 'elevatorLift', label: 'Stair lift', nameplateVA: 600, volts: 120 } },
      { label: 'Residential elevator 2.2 kVA', item: { type: 'elevatorLift', label: 'Residential elevator', nameplateVA: 2200, volts: 240 } },
    ],
  },
]

/** Flat view of the catalog — kept so existing call sites keep working. */
export const QUICK_PICKS: LoadPick[] = QUICK_PICK_CATEGORIES.flatMap((c) => c.picks)

/** The loads customers actually call about adding. */
export const FUTURE_PICKS: LoadPick[] = [
  { label: 'EV charger 9.6 kW', item: { type: 'evse', label: 'EV charger (40 A)', nameplateKW: 9.6, volts: 240 } },
  { label: 'EV charger 11.5 kW', item: { type: 'evse', label: 'EV charger (48 A)', nameplateKW: 11.5, volts: 240 } },
  { label: 'Tankless WH 18 kW', item: { type: 'waterHeaterTankless', label: 'Tankless water heater', nameplateKW: 18, volts: 240 } },
  { label: 'Hot tub 8 kW', item: { type: 'spaSelfContained', label: 'Hot tub', nameplateKW: 8, volts: 240, continuous: false } },
  { label: 'Sauna 6 kW', item: { type: 'fixedAppliance', label: 'Sauna heater', nameplateKW: 6, volts: 240 } },
  { label: 'Heat pump 7.7 kVA', item: { type: 'heatPump', label: 'Heat pump', heatPump: { compressorVA: 7680, supplementalVA: 0, lockout: false }, volts: 240 } },
  { label: 'Heat pump + 15 kW strips', item: { type: 'heatPump', label: 'Heat pump with supplemental heat', heatPump: { compressorVA: 7680, supplementalVA: 15000, lockout: false }, volts: 240 } },
  { label: 'Mini-split 3.6 kVA', item: { type: 'heatPump', label: 'Mini-split heat pump', heatPump: { compressorVA: 3600, supplementalVA: 0, lockout: false }, volts: 240 } },
  { label: 'Electric heat 10 kW', item: { type: 'spaceHeat', label: 'Electric space heat', nameplateKW: 10, volts: 240 } },
  { label: 'Central A/C 28 A', item: { type: 'cooling', label: 'Central A/C', amps: 28, volts: 240 } },
  { label: 'Welder 11.5 kVA @ 20%', item: { type: 'arcWelder', label: 'Arc welder (230 V)', nameplateVA: 11500, volts: 240, dutyCyclePct: 20 } },
  { label: 'RV outlet 9.6 kVA (50 A)', item: { type: 'exteriorCircuit', label: 'RV outlet (14-50)', nameplateVA: 9600, volts: 240 } },
  { label: 'Pool pump 2.9 kVA', item: { type: 'poolPump', label: 'Pool pump', nameplateVA: 2880, volts: 240 } },
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
