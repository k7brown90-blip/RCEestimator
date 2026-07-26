import { z } from 'zod'

export const resultStateSchema = z.enum(['PASS', 'MONITOR', 'ACTION', 'NA', 'BELOW_STANDARD'])

export const gradedStateSchema = z.enum(['severe', 'moderate', 'minor'])

export const inputFieldDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['text', 'number', 'select']),
  placeholder: z.string().optional(),
})

export const checklistItemDefSchema = z.object({
  id: z.string().min(1),
  section: z.string().min(1),
  title: z.string().min(1),
  citations: z.array(z.string()),
  jurisdictionDependent: z.boolean(),
  bannerListed: z.boolean(),
  lifeSafetyClass: z.boolean(),
  graded: z.array(gradedStateSchema).optional(),
  naAllowed: z.boolean(),
  inputFields: z.array(inputFieldDefSchema),
  reasoning: z.object({
    whatWeCheck: z.string().min(1),
    whyCodeCares: z.string().min(1),
    whatWeFound: z.string().min(1),
    whyItMatters: z.string().min(1),
  }),
})

export const jurisdictionProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  necEdition: z.enum(['2017', '2023']),
  surgeRequired: z.boolean(),
  metroAmendments: z.boolean(),
  citationOverrides: z.record(z.string(), z.array(z.string())),
  requiredOverrides: z.record(z.string(), z.enum(['required', 'optional'])),
})

export const propertySchema = z.object({
  id: z.string().min(1),
  address: z.string().min(1),
  jurisdictionId: z.string().min(1),
  createdAt: z.string().min(1),
  crm: z
    .object({
      visitId: z.string().min(1),
      propertyId: z.string().min(1),
      customerId: z.string().min(1),
      customerName: z.string().optional(),
    })
    .optional(),
})

// ── Load calculation schemas (mirror src/domain/loadcalc.ts) ────────────────

export const loadTypeSchema = z.enum([
  'generalLighting', 'smallAppliance', 'laundry',
  'fixedAppliance', 'range', 'oven', 'cooktop', 'dryer',
  'waterHeaterTank', 'waterHeaterTankless',
  'spaceHeat', 'cooling', 'heatPump',
  'motor', 'poolPump', 'poolHeater', 'poolBlower', 'spaSelfContained',
  'evse', 'arcWelder', 'resistanceWelder',
  'elevatorLift', 'snowMeltDeice', 'exteriorCircuit', 'other',
  'bathroomCircuit',
])

export const loadItemSchema = z.object({
  id: z.string().min(1),
  type: loadTypeSchema,
  label: z.string().min(1),
  nameplateVA: z.number().nonnegative().optional(),
  nameplateKW: z.number().nonnegative().optional(),
  amps: z.number().nonnegative().optional(),
  volts: z.number().positive().optional(),
  continuous: z.boolean().optional(),
  separatelyControlledUnits: z.number().int().positive().optional(),
  heatPump: z
    .object({
      compressorVA: z.number().nonnegative(),
      supplementalVA: z.number().nonnegative(),
      lockout: z.boolean(),
    })
    .optional(),
  dutyCyclePct: z.number().positive().max(100).optional(),
  welderClass: z.enum(['arc', 'resistance']).optional(),
  motorGenerator: z.boolean().optional(),
  onLaundryCircuit: z.boolean().optional(),
  nameplateRead: z.boolean().optional(),
})

export const calcMethodSchema = z.enum([
  'optional', 'standard', 'existingDwelling',
  'multifamily220_84', 'twoDwelling220_85', 'nonDwelling',
])

export const occupancyProfileSchema = z.enum([
  'dwellingSingleFamily', 'dwellingMultifamily', 'hotelMotel', 'commercialGeneral',
])

export const loadCalcInputSchema = z.object({
  mode: z.enum(['tech', 'engineer']),
  occupancy: occupancyProfileSchema,
  methodOverride: calcMethodSchema.optional(),
  serviceAmps: z.number().positive(),
  serviceVoltage: z.literal(240),
  floorAreaSqFt: z.number().nonnegative(),
  loads: z.array(loadItemSchema),
  futureLoads: z.array(loadItemSchema).optional(),
})

export const loadCalcResultSchema = z.object({
  optionalVA: z.number(),
  optionalAmps: z.number(),
  standardVA: z.number(),
  standardAmps: z.number(),
  governingAmps: z.number(),
  neutralVA: z.number(),
  neutralAmps: z.number(),
  methodUsed: calcMethodSchema,
  serviceAmps: z.number(),
  spareAmps: z.number(),
  loadPct: z.number(),
  usableAmps80: z.number(),
  futureLoadFindings: z.array(
    z.object({
      label: z.string(),
      nameplateAmps: z.number(),
      continuous: z.boolean(),
      addedAmps: z.number(),
      fitsCode: z.boolean(),
      fitsConservative: z.boolean(),
      verdict: z.string(),
      mitigation: z.string().optional(),
    }),
  ),
  breakdown: z.array(
    z.object({
      label: z.string(),
      type: loadTypeSchema,
      rawVA: z.number(),
      appliedVA: z.number(),
      rule: z.string(),
    }),
  ),
  assumedValues: z.array(z.string()),
})

export const inspectionLoadCalcSchema = z.object({
  input: loadCalcInputSchema,
  result: loadCalcResultSchema,
})

export const itemResultSchema = z.object({
  itemId: z.string().min(1),
  result: resultStateSchema,
  gradedState: gradedStateSchema.optional(),
  measured: z.record(z.string(), z.union([z.string(), z.number()])),
  photoIds: z.array(z.string()),
  note: z.string().optional(),
  overrideReason: z.string().optional(),
})

export const inspectionSchema = z.object({
  id: z.string().min(1),
  propertyId: z.string().min(1),
  jurisdictionId: z.string().min(1),
  technician: z.string().min(1),
  date: z.string().min(1),
  items: z.array(itemResultSchema),
  score: z.number(),
  itemsAssessed: z.number().int().nonnegative(),
  criticalFindings: z.array(z.string()),
  contractorReviewed: z.boolean(),
  status: z.enum(['draft', 'complete']),
  loadCalc: inspectionLoadCalcSchema.optional(),
})
