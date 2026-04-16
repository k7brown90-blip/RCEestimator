export type EstimateStatus = "draft" | "review" | "sent" | "accepted" | "declined" | "expired" | "revised";

export type JobSummary = {
  visitId: string;
  visitDate: string;
  mode: string;
  purpose?: string | null;
  property: {
    id: string;
    name: string;
    addressLine1: string;
    city: string;
    state: string;
  };
  customer: {
    id: string;
    name: string;
  };
  estimate: {
    id: string;
    title: string;
    status: EstimateStatus;
    revision: number;
    totalCost: number | null;
    hasAcceptance: boolean;
  } | null;
  costs: {
    estimatedCost: number | null;
    materialCost: number;
    laborHours: number;
    laborCost: number;
    overhead: number;
    totalCost: number;
    revenue: number | null;
    grossProfit: number | null;
    margin: number | null;
  };
};

export type Customer = {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  properties?: Property[];
};

export type Property = {
  id: string;
  customerId: string;
  name: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  notes?: string | null;
  customer?: Customer;
  systemSnapshot?: SystemSnapshot | null;
  visits?: Visit[];
  estimates?: Estimate[];
};

export type SystemSnapshot = {
  id: string;
  propertyId: string;
  serviceSummary?: string | null;
  panelSummary?: string | null;
  groundingSummary?: string | null;
  wiringMethodSummary?: string | null;
  deficienciesJson?: string | null;
  changeLogJson?: string | null;
  updatedAt: string;
};

export type Visit = {
  id: string;
  propertyId: string;
  customerId: string;
  mode: string;
  purpose?: string | null;
  jobType?: string | null;
  notes?: string | null;
  visitDate: string;
  property?: Property;
  customer?: Customer;
  customerRequest?: {
    id: string;
    requestText: string;
    urgency?: string | null;
  } | null;
  observations?: Array<{ id: string; observationText: string; location?: string | null; createdAt: string }>;
  findings?: Array<{ id: string; findingText: string; confidence?: string | null; createdAt: string }>;
  limitations?: Array<{ id: string; limitationText: string; createdAt: string }>;
  recommendations?: Array<{ id: string; recommendationText: string; priority?: string | null; createdAt: string }>;
  estimates?: Estimate[];
};

export type EstimateOption = {
  id: string;
  estimateId: string;
  optionLabel: string;
  description?: string | null;
  sortOrder: number;
  accepted: boolean;
  subtotalLabor: number;
  subtotalMaterial: number;
  subtotalOther: number;
  totalCost: number;
  assemblies?: EstimateAssembly[];
};

export type EstimateAssembly = {
  id: string;
  optionId: string;
  assemblyTemplateId: string;
  location?: string | null;
  quantity: number;
  parameters?: Record<string, unknown>;
  totalCost: number;
  laborCost: number;
  materialCost: number;
  otherCost: number;
  assemblyNotes?: string | null;
  assemblyTemplate?: AssemblyTemplate;
  companionSuggestions?: CompanionSuggestion[];
  components?: Array<{
    id: string;
    componentType: string;
    code: string;
    description: string;
    quantity: number;
    unit?: string | null;
    unitCost: number;
    laborHours: number;
    laborRate: number;
    extendedCost: number;
  }>;
};

export type CompanionSuggestion = {
  assemblyNumber: number;
  templateId: string;
  name: string;
  reason: string;
  required: boolean;
};

export type Estimate = {
  id: string;
  visitId: string;
  propertyId: string;
  status: EstimateStatus;
  revision: number;
  title: string;
  notes?: string | null;
  materialMarkupPct: number;
  laborMarkupPct: number;
  options: EstimateOption[];
  permitStatus?: {
    required: boolean;
    permitType?: string | null;
    status: string;
    permitNumber?: string | null;
    cost: number;
  } | null;
  inspections: Array<{ id: string; inspectionType: string; status: string; notes?: string | null; correctionsJson?: string | null }>;
  proposalDeliveries: Array<{ id: string; deliveredAt: string; pdfPath: string; method: string }>;
  signatures: Array<{ id: string; signerName: string; signerEmail?: string | null; signedAt: string }>;
  acceptance?: { id: string; optionId: string; status: string; acceptedAt: string; signatureId?: string | null } | null;
  changeOrders: Array<{ id: string; sequenceNumber: number; title: string; reasonType?: string | null; deltaTotal: number; createdAt: string }>;
};

export type AssemblyTemplate = {
  id: string;
  assemblyNumber: number;
  name: string;
  description?: string | null;
  category?: string | null;
  tier: string;
  parameterDefinitions?: AssemblyParameterDefinition[];
  variants?: AssemblyTemplateVariant[];
  components: Array<{
    id: string;
    componentType: string;
    description: string;
    quantity: number;
    unitCost: number;
    laborHours: number;
    laborRate: number;
  }>;
};

export type AssemblyParameterDefinition = {
  id: string;
  templateId: string;
  key: string;
  label: string;
  valueType: "string" | "integer" | "number" | "boolean" | "enum";
  required: boolean;
  defaultValueJson?: string | null;
  enumOptionsJson?: string | null;
  unit?: string | null;
  helpText?: string | null;
  estimatorFacing: boolean;
  sortOrder: number;
  minValue?: number | null;
  maxValue?: number | null;
};

export type AssemblyTemplateVariant = {
  id: string;
  templateId: string;
  variantKey: string;
  variantValue?: string | null;
  notes?: string | null;
};

// ─── Atomic Model Types ───────────────────────────────────────────────────────

export type AtomicUnit = {
  id: string;
  code: string;
  category: string;
  name: string;
  unitType: string;
  visibilityTier: number;
  baseLaborHrs: number;
  baseLaborRate: number;
  baseMaterialCost: number;
  necRefsJson?: string | null;
  requiresCableLength: boolean;
  requiresEndpoint: boolean;
  resolverGroupId?: string | null;
  isActive: boolean;
  sortOrder: number;
};

export type ModifierDef = {
  id: string;
  modifierType: string;
  value: string;
  label: string;
  laborMultiplier: number;
  materialMult: number;
  appliesTo: "ITEM" | "ESTIMATE";
  isDefault: boolean;
};

export type ItemModifier = {
  id: string;
  modifierType: string;
  modifierValue: string;
  laborMultiplier: number;
  materialMult: number;
};

export type EstimateItem = {
  id: string;
  estimateOptionId: string;
  atomicUnitId: string;
  location?: string | null;
  quantity: number;
  snapshotLaborHrs: number;
  snapshotLaborRate: number;
  snapshotMaterialCost: number;
  // Circuit-specific
  circuitVoltage?: number | null;
  circuitAmperage?: number | null;
  environment?: string | null;
  exposure?: string | null;
  cableLength?: number | null;
  resolvedWiringMethod?: string | null;
  resolvedCableCode?: string | null;
  resolvedCableLaborHrs?: number | null;
  resolvedCableLaborCost?: number | null;
  resolvedCableMaterialCost?: number | null;
  // Costs
  laborCost: number;
  materialCost: number;
  totalCost: number;
  modifiers?: ItemModifier[];
  atomicUnit?: Pick<AtomicUnit, "code" | "name" | "category" | "unitType" | "requiresCableLength">;
};

export type SupportItem = {
  id: string;
  estimateId: string;
  supportType: string;
  description: string;
  laborHrs?: number | null;
  laborRate?: number | null;
  laborCost: number;
  otherCost: number;
  totalCost: number;
  isOverridden: boolean;
  overrideNote?: string | null;
  sourceRule?: string | null;
};

export type NECAlert = {
  ruleCode: string;
  necArticle: string;
  promptText: string;
  severity: "REQUIRED" | "RECOMMENDED" | "ADVISORY";
};

export type LeadStatus = "new" | "contacted" | "converted" | "lost";
export type LeadSource = "email" | "phone" | "web";

export type Lead = {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  source: LeadSource;
  status: LeadStatus;
  notes?: string | null;
  address?: string | null;
  jobType?: string | null;
  callType?: string | null;
  customerId?: string | null;
  propertyId?: string | null;
  visitId?: string | null;
  createdAt: string;
  updatedAt: string;
};
