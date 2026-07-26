export interface WeightTableEntry {
  itemId: string
  S: number
  L: number
  C: number | null
  W: number
  lifeSafetyClass?: boolean
  gradedState?: 'severe' | 'moderate' | 'minor'
}

export const weights: WeightTableEntry[] = [
  { itemId: 'D1', S: 5, L: 3, C: 3, W: 45, gradedState: 'severe' },
  { itemId: 'D1', S: 5, L: 2, C: 3, W: 30, gradedState: 'moderate' },
  { itemId: 'D1', S: 3, L: 2, C: 2, W: 12, gradedState: 'minor' },
  { itemId: 'C4', S: 5, L: 2, C: 3, W: 30 },
  { itemId: 'C5', S: 5, L: 2, C: 3, W: 30 },
  { itemId: 'C2', S: 5, L: 2, C: 3, W: 30 },
  { itemId: 'C3', S: 5, L: 2, C: 3, W: 30 },
  { itemId: 'C6', S: 5, L: 2, C: 3, W: 30 },
  { itemId: 'D3', S: 5, L: 3, C: 2, W: 30 },
  { itemId: 'D2', S: 5, L: 2, C: 3, W: 30 },
  { itemId: 'H1', S: 4, L: 3, C: null, W: 24, lifeSafetyClass: true },
  { itemId: 'E1', S: 5, L: 2, C: null, W: 24, lifeSafetyClass: true },
  { itemId: 'E2', S: 5, L: 2, C: null, W: 24, lifeSafetyClass: true },
  { itemId: 'F3', S: 4, L: 2, C: 2, W: 16 },
  { itemId: 'D5', S: 4, L: 2, C: 2, W: 16 },
  { itemId: 'F1', S: 4, L: 2, C: 2, W: 16 },
  { itemId: 'E3', S: 3, L: 2, C: null, W: 14, lifeSafetyClass: true },
  { itemId: 'A2', S: 3, L: 2, C: 2, W: 12 },
  { itemId: 'H2', S: 3, L: 2, C: 2, W: 12 },
  { itemId: 'A1', S: 4, L: 2, C: 1, W: 8 },
  { itemId: 'C7', S: 2, L: 2, C: 2, W: 8 },
  { itemId: 'G3', S: 2, L: 2, C: 2, W: 8 },
  { itemId: 'B2', S: 3, L: 2, C: 1, W: 6 },
  { itemId: 'B1', S: 4, L: 1, C: 1, W: 4 },
  { itemId: 'D4', S: 2, L: 2, C: 1, W: 4 },
  { itemId: 'G1', S: 3, L: 1, C: 1, W: 3 },
  { itemId: 'G2', S: 3, L: 1, C: 1, W: 3 },
  { itemId: 'F2', S: 3, L: 1, C: 1, W: 3 },
  { itemId: 'A3', S: 4, L: 1, C: 1, W: 4 },
]

export const lifeSafetyFactor = 2.4

// Open config point (Pressure Test / spec §12): optional cap on aggregate MONITOR
// deduction. Default off (null = no cap) until decided.
export const monitorCap: number | null = null

// Floor-flag banner list — Scoring Design §3 Step 4. Maintained as an EXPLICIT list
// (never derived from severity integers) so a weight change can never silently drop
// a life-safety item out of the banner. An ACTION on any of these forces the red
// "Critical finding" banner and caps the headline score at ≤69.
// D1 is banner-listed ONLY when gradedState === 'severe' (handled in the engine).
// D5 banner condition (unmitigated aluminum WITH heat damage) // VERIFY — encoded
// when checklist.ts defines D5's graded states in Step 4.
export const bannerListedItemIds: readonly string[] = [
  'C2', // grounding electrode (fault path)
  'C3', // GEC (fault path)
  'C4', // MBJ / EGC-bar bonding error
  'C5', // neutral-ground bond error at subpanel
  'C6', // water/gas pipe bonding
  'D2', // oversized breaker / defeated overcurrent protection
  'D3', // hazard/delisted panel
  'H1', // no working smoke/CO alarms
  'E1', // GFCI absent in required wet location
  'A3', // supply-side damage
]
