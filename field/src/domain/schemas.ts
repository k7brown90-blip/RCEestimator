import { z } from 'zod'
import { normalizeResultState } from './compat'

// z.preprocess so a stored 'ACTION' from before the rename still parses.
export const resultStateSchema = z.preprocess(
  normalizeResultState,
  z.enum(['PASS', 'MONITOR', 'FAIL', 'NA', 'BELOW_STANDARD']),
)

export const gradedStateSchema = z.enum(['severe', 'moderate', 'minor'])

export const fieldOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  reportLabel: z.string().optional(),
})

export const fieldThresholdSchema = z.object({
  when: z.object({
    lt: z.number().optional(),
    lte: z.number().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    eq: z.union([z.string(), z.number()]).optional(),
  }),
  verdict: resultStateSchema,
  message: z.string().optional(),
})

export const formulaIdSchema = z.enum([
  'neutral_current', 'leg_imbalance_pct', 'branch_drop_delta', 'age_from_install_year',
])

export const inputFieldTypeSchema = z.enum([
  'text', 'number', 'select', 'multiselect', 'boolean', 'computed', 'table',
])

const inputFieldBaseShape = {
  id: z.string().min(1),
  label: z.string().min(1),
  type: inputFieldTypeSchema,
  unit: z.enum(['V', 'A', 'Ω', 'in', 'ft', '%', 'yr', 'AWG', 'kA', '°C']).optional(),
  placeholder: z.string().optional(),
  helpText: z.string().optional(),
  options: z.array(fieldOptionSchema).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  required: z.boolean().optional(),
  requiredWhen: z.object({
    fieldId: z.string().min(1),
    equals: z.string().optional(),
    includes: z.string().optional(),
  }).optional(),
  formula: formulaIdSchema.optional(),
  formulaInputs: z.array(z.string()).optional(),
  thresholds: z.array(fieldThresholdSchema).optional(),
  minRows: z.number().int().nonnegative().optional(),
  maxRows: z.number().int().positive().optional(),
}

/** Table columns are plain fields — one level, deliberately not recursive. */
const inputFieldColumnSchema = z.object(inputFieldBaseShape)

export const inputFieldDefSchema = z
  .object({ ...inputFieldBaseShape, columns: z.array(inputFieldColumnSchema).optional() })
  .superRefine((field, ctx) => {
    // These pairings are what the renderer relies on; a mismatch would render an
    // empty control the technician can't fill.
    const needsOptions = field.type === 'select' || field.type === 'multiselect'
    if (needsOptions && (!field.options || field.options.length === 0)) {
      ctx.addIssue({ code: 'custom', message: `${field.id}: ${field.type} needs options` })
    }
    if (!needsOptions && field.options) {
      ctx.addIssue({ code: 'custom', message: `${field.id}: options only apply to select fields` })
    }
    if (field.type === 'computed' && !field.formula) {
      ctx.addIssue({ code: 'custom', message: `${field.id}: computed field needs a formula` })
    }
    if (field.type !== 'computed' && field.formula) {
      ctx.addIssue({ code: 'custom', message: `${field.id}: only computed fields take a formula` })
    }
    if (field.type === 'table' && (!field.columns || field.columns.length === 0)) {
      ctx.addIssue({ code: 'custom', message: `${field.id}: table field needs columns` })
    }
    if (field.type !== 'table' && field.columns) {
      ctx.addIssue({ code: 'custom', message: `${field.id}: columns only apply to table fields` })
    }
  })

export const locationKindSchema = z.enum(['service_exterior', 'panel', 'interior_general'])
export const inspectionPhaseSchema = z.union([z.literal(1), z.literal(2)])

export const inspectionLocationSchema = z.object({
  id: z.string().min(1),
  kind: locationKindSchema,
  label: z.string().min(1),
  panelRole: z.enum(['meter_main', 'main', 'sub', 'disconnect_only']).optional(),
  feeds: z.string().optional(),
  phase: inspectionPhaseSchema,
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
  phase: inspectionPhaseSchema,
  group: z.string().min(1),
  appliesTo: z.array(locationKindSchema).min(1),
  repeatable: z.boolean(),
  measurementRequired: z.boolean().optional(),
  dependsOn: z.array(z.string()).optional(),
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

export const jurisdictionSourceSchema = z.enum(['property', 'territory', 'city', 'default'])

const crmLinkSchema = z.object({
  visitId: z.string().min(1),
  propertyId: z.string().min(1),
  customerId: z.string().min(1),
  customerName: z.string().optional(),
})

export const propertySchema = z.object({
  id: z.string().min(1),
  address: z.string().min(1),
  jurisdictionId: z.string().min(1),
  jurisdictionSource: jurisdictionSourceSchema,
  createdAt: z.string().min(1),
  // Required: an inspection with no CRM job has nowhere to be filed.
  crm: crmLinkSchema,
  legacy: z.literal(true).optional(),
})

/**
 * Pre-v4 rows: no CRM link, no jurisdiction source. Parsed only by the Dexie
 * upgrade, which marks them legacy so they stay readable without being
 * selectable for new work.
 */
export const legacyPropertySchema = z.object({
  id: z.string().min(1),
  address: z.string().min(1),
  jurisdictionId: z.string().min(1),
  jurisdictionSource: jurisdictionSourceSchema.optional(),
  createdAt: z.string().min(1),
  crm: crmLinkSchema.optional(),
  legacy: z.literal(true).optional(),
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

const measuredScalarSchema = z.union([z.string(), z.number(), z.boolean()])
export const measuredValueSchema = z.union([
  measuredScalarSchema,
  z.array(z.string()),
  z.array(z.record(z.string(), measuredScalarSchema)),
])

export const itemResultSchema = z.object({
  itemId: z.string().min(1),
  locationId: z.string().optional(),
  result: resultStateSchema,
  gradedState: gradedStateSchema.optional(),
  measured: z.record(z.string(), measuredValueSchema),
  computed: z.record(z.string(), z.number()).optional(),
  autoVerdicts: z.record(z.string(), resultStateSchema).optional(),
  rowVerdicts: z.record(z.string(), z.array(resultStateSchema)).optional(),
  photoIds: z.array(z.string()),
  note: z.string().optional(),
  resolutionNote: z.string().optional(),
  overrideReason: z.string().optional(),
})

export const inspectionScopeSchema = z.enum(['full', 'phase1'])

export const inspectionSchema = z.object({
  id: z.string().min(1),
  propertyId: z.string().min(1),
  jurisdictionId: z.string().min(1),
  technician: z.string().min(1),
  date: z.string().min(1),
  items: z.array(itemResultSchema),
  // `scope` defaults so pre-v5 drafts, which predate the phased inspection,
  // still parse as the full pass they were.
  scope: inspectionScopeSchema.default('full'),
  itemsAssessed: z.number().int().nonnegative(),
  criticalFindings: z.array(z.string()),
  contractorReviewed: z.boolean(),
  status: z.enum(['draft', 'complete']),
  loadCalc: inspectionLoadCalcSchema.optional(),
})
