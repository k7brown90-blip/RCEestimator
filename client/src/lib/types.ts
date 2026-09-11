export type EstimateStatus = "draft" | "review" | "sent" | "accepted" | "declined" | "expired" | "revised";

/** Visit.status — the job's own lifecycle, distinct from its estimate's status. */
export type JobStatus =
  | "estimate"
  | "contracted"
  | "scheduled"
  | "in_progress"
  | "completed"
  | "cancelled";

/** Jobs in these states belong to the Archived tab. */
export const ARCHIVED_JOB_STATUSES: JobStatus[] = ["completed", "cancelled"];

export const isArchivedJob = (status: string): boolean =>
  ARCHIVED_JOB_STATUSES.includes(status as JobStatus);

/**
 * Kyle, 2026-08-29: "Signed estimates turn into active jobs. Consultations
 * just get marked completed and archived." Estimate-stage visits are
 * consultations — never counted as active jobs anywhere in the UI.
 */
export const ACTIVE_JOB_STATUSES: JobStatus[] = ["contracted", "scheduled", "in_progress"];

export const isActiveJob = (status: string): boolean =>
  ACTIVE_JOB_STATUSES.includes(status as JobStatus);

export type JobCosts = {
  estimatedCost: number | null;
  materialCost: number;
  laborHours: number;
  laborRate: number;
  laborCost: number;
  overhead: number;
  totalCost: number;
  revenue: number | null;
  grossProfit: number | null;
  margin: number | null;
  /**
   * Where materialCost came from (Kyle, 2026-09-09, Build 4 — THE MATERIAL RULE):
   * stock consumed off a truck, confirmed receipts not on a PO, the signed
   * estimate's frozen material, or nothing.
   */
  materialSource?: MaterialSource;
};

export type MaterialSource = "stock" | "receipts" | "estimate" | "none";

/** The label every money surface prints beside a material figure. */
export const MATERIAL_SOURCE_LABEL: Record<MaterialSource, string> = {
  stock: "from truck stock",
  receipts: "from receipts",
  estimate: "from the signed estimate",
  none: "nothing recorded",
};

// ─── Materials used on a job (Kyle, 2026-09-09, Build 4) ─────────────────────

export type OnHand = { qty: number; unit: string | null; avgUnitCost: number | null };

export type SuggestedMaterialLine = {
  itemId: string;
  name: string;
  qty: number;
  unit: string | null;
  onHand: number;
  avgUnitCost: number | null;
  /** Already consumed for this job, so a second close-out pass does not double up. */
  consumedQty: number;
};

export type JobMaterialLine = {
  movementId: string;
  kind: "consume" | "return" | "correction";
  itemId: string;
  name: string;
  unit: string | null;
  qty: number;
  unitCost: number | null;
  /** Signed: a consume charges, a return credits. */
  cost: number;
  reason: string | null;
  actor: string;
  at: string;
  onVisitId: string | null;
};

export type JobMaterialsView = {
  jobId: string;
  truck: { id: string; name: string };
  estimate: { id: string; number: string; title: string } | null;
  suggested: SuggestedMaterialLine[];
  lines: JobMaterialLine[];
  stock: { consumed: number; returned: number; net: number; movementCount: number } | null;
  receipts: Array<{
    id: string; vendor: string | null; amount: number; category: string; status: string; receivedAt: string;
    purchaseOrderId: string | null; purchaseOrderNumber: string | null;
    countsTowardJob: boolean;
    note: string | null;
  }>;
  materialCost: number;
  materialSource: MaterialSource;
  estimateMaterial: number | null;
  receiptMaterial: number | null;
};

export type ConsumeLineInput = { itemId?: string; name?: string | null; qty: number; unit?: string | null };

export type MaterialsByMonth = {
  year: number;
  months: { month: number; bought: number; used: number; inventoryValue: number }[];
  totals: { bought: number; used: number };
};

export type AssignedTechnician = {
  id: string;
  name: string;
  role: string;
  assignmentStatus?: string;
};

export type JobSummary = {
  visitId: string;
  visitDate: string;
  mode: string;
  purpose?: string | null;
  status: JobStatus;
  jobType?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  estimatedDurationDays?: number | null;
  estimatedDurationHours?: number | null;
  contractedAt?: string | null;
  confirmationStatus?: string | null;
  technicians: AssignedTechnician[];
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
    phone?: string | null;
  };
  completedAt?: string | null;
  estimate: {
    id: string;
    title: string;
    status: EstimateStatus;
    revision: number;
    totalCost: number | null;
    hasAcceptance: boolean;
  } | null;
  costs: JobCosts;
};

export type Customer = {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  /** The price-book practice account — kept out of every money report. */
  isTestAccount?: boolean;
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
  occupancyType?: string | null;
  /**
   * Explicit office override for the code jurisdiction at this address. Null means
   * "derive it from the ZIP" — see services/jurisdictionResolver.ts. The Health
   * Record reads this to decide which NEC edition an address is assessed under.
   */
  jurisdictionId?: string | null;
  customer?: Customer;
  systemSnapshot?: SystemSnapshot | null;
  visits?: Visit[];
  estimates?: Estimate[];
};

/**
 * One shape for creating and editing an address.
 *
 * `null` clears a field; omitting it leaves it alone. `jurisdictionId: null` hands
 * the decision back to the ZIP-based resolver, which is the right default — a
 * value here is an override the office made deliberately.
 */
export type PropertyWriteInput = {
  name?: string;
  addressLine1?: string;
  addressLine2?: string | null;
  city?: string;
  state?: string;
  postalCode?: string;
  notes?: string | null;
  occupancyType?: string;
  jurisdictionId?: string | null;
  /** Moves the address to another account. Refused once it has job history. */
  customerId?: string;
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
  status?: string | null;
  visitDate: string;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  estimatedDurationDays?: number | null;
  estimatedDurationHours?: number | null;
  googleEventId?: string | null;
  confirmationStatus?: string | null;
  contractedAt?: string | null;
  /** Set when the visit (a consultation, or later a job) was closed out. */
  completedAt?: string | null;
  estimatedCost?: number | null;
  actualMaterialCost?: number | null;
  laborHours?: number | null;
  overheadAllocation?: number | null;
  revenue?: number | null;
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

// ─── Calendar / Schedule Types ───────────────────────────────────────────────

export type CalendarEvent = {
  id: string;
  summary: string;
  description: string | null;
  start: string;
  end: string;
  startLocal: string;
  endLocal: string;
  location: string | null;
};

export type MonthSchedule = {
  year: number;
  month: number;
  days: Array<{ date: string; dayOfMonth: number; weekday: number; events: CalendarEvent[] }>;
};

export type WeekSchedule = {
  weekOf: string;
  days: Array<{ date: string; events: CalendarEvent[] }>;
};

export type AvailabilitySlot = { start: string; end: string };
export type DayAvailability = { date: string; slots: AvailabilitySlot[]; timezone: string };
export type AvailabilityResponse = {
  available_slots: DayAvailability[];
  current_time_central: string;
  current_date_central: string;
};

/**
 * Estimates book a 2-hour slot with an hour of travel leeway; production work
 * claims whole business days. Derived server-side from Visit.status.
 */
export type AppointmentKind = "estimate" | "production";

export type ScheduleJobResult = {
  jobId: string;
  scheduledStart: string;
  scheduledEnd: string;
  durationDays: number;
  appointmentKind: AppointmentKind;
  travelBufferMinutes: number;
  customerNotified: boolean;
  kyleNotified: boolean;
  googleEventId: string;
};

export type CalendarAppointment = {
  visitId: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  propertyId: string;
  address: string;
  status: JobStatus;
  jobType: string | null;
  purpose: string | null;
  appointmentKind: AppointmentKind;
  scheduledStart: string;
  scheduledEnd: string | null;
  travelBufferMinutes: number;
  estimatedDurationDays: number | null;
  estimatedDurationHours: number | null;
  confirmationStatus: string | null;
  googleEventId: string | null;
  technicians: AssignedTechnician[];
  revenue: number | null;
  estimateTotal: number | null;
};

export type UnscheduledJob = {
  visitId: string;
  customerId: string;
  customerName: string;
  propertyId: string;
  address: string;
  status: JobStatus;
  jobType: string | null;
  purpose: string | null;
  appointmentKind: AppointmentKind;
  estimatedDurationDays: number | null;
  createdAt: string;
  /** Contracted rows: is the deposit in (Kyle's rail ruling, 2026-09-02)? Null for estimate visits. */
  depositSatisfied: boolean | null;
};

/**
 * The CRM calendar. Appointments come from Visit rows (authoritative — they carry
 * the job link, costs and tech assignments); googleOnlyEvents are calendar entries
 * with no matching job, kept visible so manual bookings don't disappear.
 */
export type CalendarSchedule = {
  start: string;
  end: string;
  appointments: CalendarAppointment[];
  unscheduled: UnscheduledJob[];
  googleOnlyEvents: CalendarEvent[];
};

export type LeadStatus = "new" | "contacted" | "converted" | "lost";
/**
 * Every value that actually reaches this column. `savannah_text` is written by
 * the SMS agent and `retention` by the annual-renewal sweep — both were missing,
 * so the source badge rendered unstyled for them. `manual` is the CRM's own form.
 */
export type LeadSource =
  | "manual"
  | "phone"
  | "email"
  | "web"
  | "referral"
  | "savannah_text"
  | "retention";

export const LEAD_SOURCES: LeadSource[] = [
  "manual", "phone", "email", "web", "referral", "savannah_text", "retention",
];

/**
 * Where a lead sits in the funnel.
 * - open — not yet scheduled and not written off. This is the Leads tab.
 *   A converted lead still counts as open until it has an appointment;
 *   conversion creates a job, not a booking.
 * - scheduled — has an appointment, so it lives on the Calendar.
 * - closed — lost, or its job is completed/cancelled.
 */
export type LeadPipeline = "open" | "scheduled" | "closed";

/** The Visit a lead was converted into, resolved server-side. */
export type LeadLinkedVisit = {
  id: string;
  status: JobStatus;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  estimatedDurationDays: number | null;
  jobType: string | null;
  purpose: string | null;
};

export type Lead = {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  source: LeadSource;
  status: LeadStatus;
  leadStatus?: LeadPipelineStatus;
  notes?: string | null;
  /** Free text from the intake webhook. Manual entry fills the structured fields. */
  address?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  jobType?: string | null;
  callType?: string | null;
  referredBy?: string | null;
  urgentFlag?: boolean;
  warrantyCall?: boolean;
  warrantyNote?: string | null;
  contactPreference?: string | null;
  bestTimeToReach?: string | null;
  followUpDate?: string | null;
  followUpReason?: string | null;
  followUpCount?: number;
  lostReason?: string | null;
  /** Internal only — verbatim customer feedback, never shown to the customer. */
  lostNotes?: string | null;
  customerId?: string | null;
  propertyId?: string | null;
  visitId?: string | null;
  existingVisitId?: string | null;
  linkedVisit?: LeadLinkedVisit | null;
  createdAt: string;
  updatedAt: string;
};

/** One shape for create and edit, so the two can't drift apart. */
export type LeadWriteInput = {
  name?: string;
  email?: string | null;
  phone?: string | null;
  source?: LeadSource;
  status?: LeadStatus;
  leadStatus?: LeadPipelineStatus;
  notes?: string | null;
  address?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  jobType?: string | null;
  callType?: string | null;
  referredBy?: string | null;
  urgentFlag?: boolean;
  warrantyCall?: boolean;
  warrantyNote?: string | null;
  contactPreference?: string | null;
  bestTimeToReach?: string | null;
  followUpDate?: string | null;
  followUpReason?: string | null;
  lostReason?: string | null;
  lostNotes?: string | null;
  customerId?: string | null;
  propertyId?: string | null;
};

/** An account that might already be this caller. See services/customerMatch.ts. */
export type CustomerMatch = {
  customerId: string;
  name: string;
  email: string | null;
  phone: string | null;
  score: number;
  /** Why it surfaced — rendered in words, never as a bare score. */
  matchedOn: ("phone" | "email" | "name")[];
  properties: {
    id: string;
    name: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    state: string;
    postalCode: string;
  }[];
  visitCount: number;
  lastVisitAt: string | null;
};

export const LEAD_LOST_REASONS = ["price", "timing", "referral", "trust", "scope", "other"] as const;
export const LEAD_FOLLOW_UP_REASONS = [
  "comparing_estimates", "still_planning", "consulting_partner", "no_answer",
] as const;
export const LEAD_CONTACT_PREFERENCES = ["phone", "email", "either"] as const;
export const LEAD_CALL_TYPES = [
  "new_job", "warranty", "reschedule", "cancellation", "estimate_followup", "callback",
  "vendor", "referral", "invoice", "dispute", "wrong_number", "solicitation", "other",
] as const;

export type LeadPipelineStatus =
  | "new"
  | "booked"
  | "unresolved"
  | "planning"
  | "no_answer"
  | "won"
  | "lost";

// ─── ACCOUNTS ────────────────────────────────────────────────────────────────
//
// "Account" is the CRM-facing name for a client: one account, many properties.
// The server model is still Customer, so Account aliases it rather than
// duplicating the shape.

export type Account = Customer;

export type AccountProperty = Property & {
  activeJobCount: number;
  completedJobCount: number;
  lastInspectionDate: string | null;
  openFindingCount: number;
  openDefectCount: number;
};

/**
 * A row in the finding ledger — what was documented at an address and whether it
 * was ever resolved.
 *
 * `track` is the whole design in one field. `defect` is a code violation or
 * hazard and ends *corrected*; `upgrade` is wear or an installation below our
 * standard and ends *upgraded*. Only the defect track produces cure certificates.
 */
export type PropertyFinding = {
  id: string;
  propertyId: string;
  itemId: string;
  locationKey: string;
  cycle: number;
  track: "defect" | "upgrade";
  title: string;
  citations: string[];
  /** False for pre-ledger records. The UI says so rather than showing nothing. */
  citationsAvailable: boolean;
  jurisdictionId: string;
  severity: "FAIL" | "MONITOR" | "BELOW_STANDARD";
  critical: boolean;
  findingText: string;
  resolutionNote: string | null;
  expectedEolYear: number | null;
  status: string;
  openedAt: string;
  observedCount: number;
  /** Set when a later assessment passed this item. Evidence, never a cure. */
  verifiedPassAt: string | null;
  scheduledVisitId: string | null;
  resolvedAt: string | null;
  resolutionMethod: string | null;
  resolvedByParty: string | null;
  certificateDocId: string | null;
  declinedAt: string | null;
  declinedByName: string | null;
  declinedByRelation: string | null;
};

/** A stored Article 220 capacity check. */
export type CapacityCheckRecord = {
  id: string;
  visitId: string | null;
  propertyId: string;
  method: string;
  serviceAmps: number;
  variant: string | null;
  newLoadLabel: string | null;
  calculatedAmps: number;
  loadPct: number;
  fits: boolean;
  qualifies: boolean;
  supersedesId: string | null;
  /** Set when the calculation was taken during a Health Record, not run standalone. */
  sourceInspectionId: string | null;
  studyOrderedAt: string | null;
  studyInstallVisitId: string | null;
  studyRemovalVisitId: string | null;
  createdAt: string;
};

export type CapacityCheckResult = {
  id: string;
  method: string;
  variant: "A" | "B";
  totalVA: number;
  amps: number;
  serviceAmps: number;
  loadPct: number;
  spareAmps: number;
  fits: boolean;
  citation: string;
  assumedValues: string[];
  breakdown: { label: string; appliedVA: number; rule: string }[];
  /** What to do next, decided by the calculation rather than by the salesperson. */
  nextStep: "quote_addition" | "quote_service_upgrade" | "data_insufficient";
};

export type DemandStudyOrder = {
  capacityCheckId: string;
  installVisitId: string;
  removalVisitId: string;
  recordingWindow: { start: string; end: string; days: number };
  scheduled: { visitId: string; date: string; error?: string }[];
};

/**
 * One technician's calendar picture for a single day — the scheduler's tech
 * picker. `calendarAccessible: false` means Google omitted their calendar from
 * the freebusy response (not shared with the app's account); the UI must show
 * that as a warning, never as "free all day".
 */
export type TechDayAvailability = {
  technicianId: string;
  name: string;
  email: string;
  calendarAccessible: boolean;
  busy: { start: string; end: string; startLocal: string; endLocal: string }[];
  /** Server-computed: free at the requested start+duration. Null when no slot was requested or calendar unreadable. */
  freeAtRequested: boolean | null;
};

/** Append-only history for one finding — the sequence is what defends anybody. */
export type FindingEvent = {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  actorType: string;
  actorName: string;
  visitId: string | null;
  inspectionId: string | null;
  note: string | null;
  createdAt: string;
};

// ─── Purchase orders (Kyle, 2026-09-09) ───────────────────────────────────────
// "Purchasing needs to start with a P.O. number then the purchase and photo
// verification of the receipt." Purpose is chosen ("Truck Stock, Warehouse, or
// Tool purchase"; default truck stock); material lands on a truck or in the
// warehouse, never on a job.

export type PoPurpose = "truck_stock" | "warehouse" | "tool";
export type PoStatus = "open" | "purchased" | "verified" | "closed" | "cancelled";

export type PurchaseOrderLine = {
  id: string;
  itemId: string | null;
  name: string;
  qty: number;
  unit: string | null;
  partNumber: string | null;
  unitCost: number | null;
  qtyLanded: number | null;
  /** When the line landed on its truck / in the warehouse (Build 3). */
  landedAt: string | null;
  sortOrder: number;
};

export type PurchaseOrderSummary = {
  id: string;
  number: string;
  purpose: PoPurpose;
  destinationType: "truck" | "warehouse";
  truckId: string | null;
  truckName: string | null;
  jobId: string | null;
  jobLabel: string | null;
  accountId: string | null;
  accountName: string | null;
  supplier: string;
  status: PoStatus;
  notes: string | null;
  /** "system" = drafted from a card transaction (Kyle, 2026-09-09: "PO after the fact"). */
  openedBy: "owner" | "tech" | "system";
  openedByTechnicianId: string | null;
  openedAt: string;
  purchasedAt: string | null;
  verifiedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  sentAt: string | null;
  /** Kyle, 2026-09-09 (Build 3): when the material landed. Null until it does. */
  landedAt: string | null;
  createdAt: string;
  receiptCount: number;
  /** Kyle, 2026-09-09: "card proves" — a linked Issuing transaction is the money behind this PO. */
  cardSpendCount: number;
  cardMatched: boolean;
  /** Drafted from a card transaction with no PO behind it; cannot close without a receipt photo. */
  afterTheFact: boolean;
  lines: PurchaseOrderLine[];
};

export type PurchaseOrderEvent = {
  id: string;
  at: string;
  actor: string;
  kind: "created" | "edited" | "status" | "receipt_attached" | "receipt_detached" | "line_added" | "line_edited" | "line_removed" | "card_matched" | "card_detached" | "landed";
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export type PurchaseOrderReceipt = {
  id: string;
  jobId: string | null;
  vendor: string | null;
  category: string;
  amount: number;
  status: string;
  source: string;
  receivedAt: string;
  hasImage: boolean;
};

export type PurchaseOrderDetail = PurchaseOrderSummary & {
  events: PurchaseOrderEvent[];
  receipts: PurchaseOrderReceipt[];
  /** The card transactions behind this PO (Kyle, 2026-09-09). */
  cardSpends: { id: string; merchantName: string; amount: number; kind: string; status: string; occurredAt: string; receiptId: string | null }[];
};

/** A receipt row from /receipt-review or /receipts-needing-po. */
export type ReviewReceiptRow = {
  id: string;
  jobId: string | null;
  vendor: string | null;
  category: string;
  amount: number;
  source: string;
  receivedAt: string;
  accountId: string | null;
  accountName: string | null;
  jobLabel: string;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  needsPo: boolean;
  /** Kyle, 2026-09-09: "card proves" — the card transaction this receipt itemizes, if matched. */
  cardSpendId?: string | null;
  cardMatched?: boolean;
};

// ── Trucks, cards, card spend (Kyle, 2026-09-09) ─────────────────────────────
// "Each tech will have their own card for material and gas through stripe and
// I will have to set up a financial account for each." Spend routes to a truck
// by the card; gas and maintenance belong to the truck, never a job.

export type CardSpendKind = "materials" | "fuel" | "maintenance" | "tool" | "other";
export type CardSpendStatus = "unmatched" | "matched" | "ignored";

export type CardSpendRow = {
  id: string;
  stripeTransactionId: string;
  stripeCardId: string;
  truckId: string | null;
  truckName: string | null;
  kind: CardSpendKind;
  /** Dollars — positive for a purchase, negative for a refund. */
  amount: number;
  currency: string;
  merchantName: string;
  merchantCategory: string | null;
  merchantCity: string | null;
  merchantState: string | null;
  /** Stripe's own state for the swipe: pending until it posts (Kyle, 2026-09-10). */
  settlement?: "pending" | "posted" | "void";
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  purchaseOrderStatus: string | null;
  purchaseOrderAfterTheFact: boolean;
  receiptId: string | null;
  receipt: { id: string; vendor: string | null; amount: number; category: string; status: string; receivedAt: string; jobId: string | null; hasImage: boolean } | null;
  status: CardSpendStatus;
  ignoredReason: string | null;
  note: string | null;
  occurredAt: string;
  createdAt: string;
};

export type TruckBalance = { cashUsd: number; inboundPending: number; outboundPending: number; status: string };
export type TruckMtd = { fuel: number; maintenance: number; materials: number; tool: number; other: number };

export type TruckRow = {
  id: string;
  name: string;
  technicianId: string | null;
  technicianName: string | null;
  isActive: boolean;
  stripeCardId: string | null;
  cardLast4: string | null;
  stripeFinancialAccountId: string | null;
  notes: string | null;
  balance: TruckBalance | null;
  mtd: TruckMtd;
  unmatchedMaterials: number;
  /** Build 3: stock on the truck at moving-average cost, and the tools on it. */
  stockValue: number;
  toolCount: number;
};

export type TrucksResponse = {
  balancesAvailable: boolean;
  balancesReason: string | null;
  trucks: TruckRow[];
  unassigned: (TruckMtd & { unmatched: number }) | null;
};

export type TruckRecord = {
  id: string;
  name: string;
  technicianId: string | null;
  isActive: boolean;
  createdAt: string;
  stripeCardId: string | null;
  cardLast4: string | null;
  stripeFinancialAccountId: string | null;
  notes: string | null;
  technician: { id: string; name: string } | null;
};

export type TruckDetail = {
  truck: TruckRecord;
  year: number;
  ledger: { kind: CardSpendKind; total: number; rows: CardSpendRow[] }[];
  needingReceipt: CardSpendRow[];
  purchaseOrders: PurchaseOrderSummary[];
  balance: TruckBalance | null;
  balancesAvailable: boolean;
  balancesReason: string | null;
  stockValue: number;
  toolCount: number;
};

export type IssuingCardsResponse =
  | { available: true; cards: { id: string; last4: string; cardholderName: string | null; status: string; financialAccountId: string | null }[] }
  | { available: false; reason: string };

export type Balances = {
  payments: { available: number; pending: number } | null;
  financialAccounts: { id: string; cashUsd: number; inboundPending: number; outboundPending: number; status: string; truckId: string | null; truckName: string | null }[];
  available: boolean;
  reason?: string;
  readAt: string;
};

// ─── Treasury: floats + the month-end sweep (Kyle, 2026-09-09, Build 5) ──────
// "At the end of each month I will take whatever money is over that value and
// deposit it into the Chase savings accounts." Floats are set in Settings; the
// sweep runs on a click from the number Financials shows — never on a schedule.

export type TreasurySettings = {
  mainFinancialAccountId: string | null;
  mainFloat: number;
  truckFloats: Record<string, number>;
  chaseAccountLabel: string | null;
  /** Stripe's payout-method id for the Chase account — the outbound transfer destination. */
  chaseExternalAccountId: string | null;
};

export type TreasurySweepRow = {
  id: string;
  financialAccountId: string;
  amount: number;
  destinationLabel: string;
  stripeTransferId: string | null;
  /** created | failed | posted | returned | canceled */
  status: string;
  error: string | null;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type SweepView = {
  asOf: string;
  stripeAvailable: boolean;
  stripeReason: string | null;
  main: { financialAccountId: string; balance: number; inboundPending: number; outboundPending: number; float: number; excess: number } | null;
  trucks: { truckId: string; truckName: string; financialAccountId: string | null; balance: number | null; float: number; excessOrShortfall: number | null }[];
  destination: { label: string; externalAccountId: string } | null;
  canSweep: boolean;
  reason: string | null;
  recent: TreasurySweepRow[];
};

export type ReceiptCandidate = {
  id: string;
  vendor: string | null;
  amount: number;
  category: string;
  status: string;
  receivedAt: string;
  jobId: string | null;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  hasImage: boolean;
  exact: boolean;
};

// ─── Inventory ledger and tool register (Kyle, 2026-09-09, Build 3) ──────────
// "tracks what is on the truck and what is at the warehouse so on future jobs
// I can label some stock as truckstock and it won't double count the cost."
// Locations are string keys: "warehouse" | "truck:<truckId>".

export type MovementKind = "purchase_in" | "transfer" | "consume" | "return" | "count" | "correction";

export type StockLevelView = {
  id: string;
  locationKey: string;
  itemId: string;
  name: string;
  unit: string | null;
  qtyOnHand: number;
  avgUnitCost: number;
  value: number;
  parLevel: number | null;
  low: boolean;
  updatedAt: string;
};

export type StockMovementView = {
  id: string;
  kind: MovementKind;
  itemId: string;
  name: string;
  unit: string | null;
  qty: number;
  delta: number | null;
  unitCost: number | null;
  fromLocationKey: string | null;
  toLocationKey: string | null;
  purchaseOrderId: string | null;
  purchaseOrderLineId: string | null;
  jobId: string | null;
  correctsId: string | null;
  reason: string | null;
  actor: string;
  at: string;
};

export type StockRequestView = {
  id: string;
  truckId: string;
  truckName: string;
  itemId: string | null;
  name: string;
  qty: number;
  unit: string | null;
  note: string | null;
  status: "open" | "fulfilled" | "declined";
  requestedByTechnicianId: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type UnlandedPo = {
  id: string;
  number: string;
  supplier: string;
  status: PoStatus;
  purpose: PoPurpose;
  truckId: string | null;
  truckName: string | null;
  purchasedAt: string | null;
  receiptCount: number;
  lineCount: number;
};

export type InventoryTruck = {
  truck: { id: string; name: string; technicianId: string | null; technicianName: string | null };
  locationKey: string;
  levels: StockLevelView[];
  value: number;
  lowStock: StockLevelView[];
};

export type InventoryOverview = {
  warehouse: { locationKey: string; levels: StockLevelView[]; value: number };
  trucks: InventoryTruck[];
  openRequests: StockRequestView[];
  unlandedPos: UnlandedPo[];
};

// Kyle, 2026-09-11: the receipt total is the truth; the receipt's line prices are only the weights
// that split it. The source rides beside the number and says which weight decided the line.
export type LandingCostSource = "receipt-line" | "po-line" | "book" | "even" | "none";

export type LandingReceiptLine = {
  receiptId: string;
  index: number;
  name: string;
  qty: number;
  unit: string | null;
  unitCost: number | null;
  lineTotal: number | null;
  itemId: string | null;
  matchedLineId: string | null;
};

export type LandingReceiptView = {
  receiptId: string;
  vendor: string | null;
  amount: number;
  parseError: string | null;
  lines: LandingReceiptLine[];
  unmatched: LandingReceiptLine[];
};

export type LandingLineDefault = {
  lineId: string;
  itemId: string | null;
  name: string;
  unit: string | null;
  qtyExpected: number;
  qtyLandedDefault: number;
  unitCostDefault: number;
  costSource: LandingCostSource;
  weight: number;
  weightBasis: string;
  /** This line's share of the tax the receipt carries past its printed lines. */
  taxShare: number;
  bookPurchasePrice: number | null;
  matchedReceiptLine: { receiptId: string; name: string; qty: number; unit: string | null; unitCost: number | null } | null;
  matchedReceiptLines: Array<{ receiptId: string; index: number; name: string; qty: number; unit: string | null; unitCost: number | null; lineTotal: number | null }>;
};

/** A line the panel offers to add in one click when the PO has none (Kyle, 2026-09-11). */
export type LandingSuggestedLine = {
  receiptId: string;
  name: string;
  qty: number;
  unit: string | null;
  unitCost: number | null;
};

export type LandingDefaults = {
  purchaseOrder: PurchaseOrderSummary;
  destinationKey: string | null;
  destinationLabel: string;
  receiptTotal: number;
  matchedTotal: number;
  parsedTotal: number;
  taxTotal: number;
  linesTotal: number;
  balanced: boolean;
  suggestedLines: LandingSuggestedLine[];
  receiptCount: number;
  receiptLines: LandingReceiptView[];
  hasReceiptPhoto: boolean;
  blocker: string | null;
  lines: LandingLineDefault[];
};

export type ToolCondition = "good" | "needs_repair" | "retired";

export type ToolView = {
  id: string;
  name: string;
  serial: string | null;
  cost: number | null;
  purchasedAt: string | null;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  condition: ToolCondition;
  locationKey: string;
  notes: string | null;
  createdAt: string;
};

export type ToolMovementView = { id: string; toolId: string; fromLocationKey: string; toLocationKey: string; actor: string; reason: string | null; at: string };
export type ToolDetail = ToolView & { movements: ToolMovementView[] };

/** The book, picker-shaped (from /inventory/items). */
export type InventoryItem = {
  itemId: string;
  description: string | null;
  unit: string | null;
  category: string | null;
  purchasePrice: number | null;
  costBasisUsed: number | null;
  lastCost: number | null;
};

export type CardSpendSyncResult =
  | { available: true; seen: number; created: number; updated: number; dry: boolean }
  | { available: false; reason: string };

export type AccountPurchaseOrder = {
  id: string;
  number: string;
  purpose: PoPurpose;
  status: PoStatus;
  supplier: string;
  itemCount: number;
  sentAt: string | null;
  createdAt: string;
};

export type AccountReceipt = {
  id: string;
  jobId: string | null;
  vendor: string | null;
  category: string;
  amount: number;
  status: string;
  source: string;
  receivedAt: string;
  /** The PO this receipt verifies (Kyle, 2026-09-09) — null reads "needs PO" on a materials receipt. */
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
};

export type AccountJob = {
  /** Set when this visit's costs are counted under its sold job's card (the P&L chain). */
  costsRolledUpTo?: string | null;
  visitId: string;
  propertyId: string;
  propertyLabel: string;
  status: JobStatus;
  archived: boolean;
  jobType: string | null;
  purpose: string | null;
  mode: string;
  visitDate: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  costs: JobCosts;
  purchaseOrders: AccountPurchaseOrder[];
  receipts: AccountReceipt[];
  documents: { id: string; type: string; signedAt: string | null; sentAt: string | null }[];
  latestEstimate: {
    id: string;
    title: string;
    status: EstimateStatus;
    revision: number;
    totalCost: number | null;
    hasAcceptance: boolean;
  } | null;
};

/**
 * One row of the Invoices tab (Kyle, 2026-08-26: "tracks the invoices sent and
 * what ones are paid"). An invoice is a signed issued estimate; the money
 * mirrors paymentSummary — totalPaid includes any legacy "discount" rows from
 * the retired 3% non-card programme, `collected` is real money only.
 */
export type InvoiceSummary = {
  remindersSent: number;
  lastReminderAt: string | null;
  id: string;
  number: string;
  revision: number;
  title: string;
  customer: { id: string; name: string };
  // Kyle, 2026-09-07 (invoices merged into Financials): contact info for the expanded
  // panel, and the property/job the invoice belongs to for the account → property → job
  // drill-down.
  customerPhone: string | null;
  customerEmail: string | null;
  propertyId: string;
  job: { id: string; jobType: string | null; purpose: string | null; status: string; scheduledStart: string | null } | null;
  serviceAddress: string;
  signedAt: string;
  signedChannel: "in_person" | "email" | null;
  sentAt: string | null;
  sentTo: string | null;
  billedTotal: number;
  depositDue: number;
  totalPaid: number;
  discountTotal: number;
  collected: number;
  balance: number;
  lastPaidAt: string | null;
  paymentStatus: "unpaid" | "partial" | "deposit_paid" | "paid";
  payToken: string;
  /** Home-warranty coverage (Kyle, 2026-09-09) — already off billedTotal; shown beside it. */
  warrantyCovered?: number;
  warrantyClaim?: WarrantyClaimRef | null;
  /** The warranty receivable (Kyle, 2026-09-10): what the company has paid and still owes. */
  warrantyPaid?: number;
  warrantyBalance?: number;
  warrantyStatus?: "not submitted" | "submitted" | "overdue" | "paid" | null;
  /** Gmail reported the last email about this row undeliverable (Kyle, 2026-09-09). Additive. */
  lastBounceAt?: string | null;
  lastBounceReason?: string | null;
  /** The last email's real delivery state — Resend's report, or "sent via Gmail" (Kyle, 2026-09-09). Additive. */
  lastDelivery?: EmailLastDelivery | null;
};

/**
 * A home-warranty claim on an issued estimate (Kyle, 2026-09-09: "The warranty
 * company is covering $370 of this bill... show on the invoice sent to her that
 * the warranty is covering what ever their chosen amount is with the claim
 * number."). The homeowner signs; the warranty company is a second payer.
 */
export type WarrantyClaim = {
  company: string;
  claimNumber: string;
  authNumber: string | null;
  coveredAmount: number;
  note: string | null;
  setAt: string;
  /** Receivable tracking (Kyle, 2026-09-10) — absent on claims recorded before it existed. */
  submittedAt?: string | null;
  expectedAt?: string | null;
  approvedAt?: string | null;
  receivedAt?: string | null;
  depositedAt?: string | null;
  checkNumber?: string | null;
  events?: { at: string; actor: string; kind: string; reason?: string; detail?: string }[];
};
export type WarrantyClaimRef = Pick<WarrantyClaim, "company" | "claimNumber" | "authNumber">;

export type AccountInspectionSummary = {
  id: string;
  visitId: string;
  propertyId: string;
  inspectionDate: string;
  /** v1 only — the retired 0-100 headline. Null on findings-led v2 records. */
  score: number | null;
  schemaVersion: "v1" | "v2" | "v3";
  scope: "full" | "phase1";
  itemsAssessed: number;
  failCount: number;
  monitorCount: number;
  passCount: number;
  belowStandardCount: number;
  naCount: number;
  criticalFindings: string[];
  contractorReviewed: boolean;
};

export type AccountSummary = {
  account: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    createdAt: string;
  };
  properties: AccountProperty[];
  jobs: AccountJob[];
  totals: {
    lifetimeRevenue: number;
    lifetimeCost: number;
    lifetimeProfit: number;
    lifetimeMargin: number | null;
    activeJobCount: number;
    completedJobCount: number;
    propertyCount: number;
  };
  /** Signed agreements filed against any of this account's addresses (2026-08-20). */
  documents: Array<{
    id: string;
    type: string;
    audience: "customer" | "company";
    estimateNumber: string | null;
    /** The estimate this renders. Emailing an invoice targets it, not this row. */
    estimateId: string | null;
    customerEmail: string | null;
    signedByName: string | null;
    signedAt: string | null;
    createdAt: string;
    propertyId: string | null;
  }>;
  inspections: AccountInspectionSummary[];
  findings: PropertyFinding[];
};

export type AnalyticsRange = {
  startDate: string;
  endDate: string;
  start: string;
  end: string;
};

export type FunnelStage = {
  status: LeadPipelineStatus;
  count: number;
  percent: number;
};

export type CrmFunnelMetrics = {
  range: AnalyticsRange;
  total: number;
  openCount: number;
  wonCount: number;
  lostCount: number;
  stages: FunnelStage[];
};

export type OverdueLead = {
  id: string;
  name: string;
  phone?: string | null;
  source: string;
  jobType?: string | null;
  leadStatus: string;
  status: LeadStatus;
  followUpDate?: string | null;
};

export type CrmFollowUpsMetrics = {
  asOf: string;
  openLeadCount: number;
  overdueCount: number;
  dueTodayCount: number;
  dueNext7DaysCount: number;
  noFollowUpCount: number;
  overdueLeads: OverdueLead[];
  callType?: string | null;
  leadStatus?: LeadPipelineStatus;
  followUpDate?: string | null;
  followUpReason?: string | null;
  followUpCount?: number;
  lostReason?: string | null;
  lostNotes?: string | null;
  bestTimeToReach?: string | null;
  contactPreference?: string | null;
};

export type CrmWinLossMetrics = {
  range: AnalyticsRange;
  totalClosed: number;
  won: number;
  lost: number;
  winRate: number;
  lossReasons: Record<string, number>;
  sourceSummary: Record<string, { won: number; lost: number }>;
};

export type CrmCycleTimeMetrics = {
  range: AnalyticsRange;
  wonLeadCount: number;
  averageDaysToClose: number | null;
  medianDaysToClose: number | null;
  cycleTimes: Array<{
    id: string;
    name: string;
    source: string;
    daysToClose: number;
  }>;
  estimateCounts: Record<string, number>;
  estimateAcceptanceRateFromSent: number;
};

export type CrmOverview = {
  generatedAt: string;
  funnel: CrmFunnelMetrics;
  followUps: CrmFollowUpsMetrics;
  winLoss: CrmWinLossMetrics;
  cycleTime: CrmCycleTimeMetrics;
};

// ─── PRICE BOOK INTAKE (P012) ────────────────────────────────────────────────
// Shapes returned by the /price-book endpoints. Every money field on ComputedEstimate is
// produced by the pricing engine on the server; the UI displays them and never computes one.

export type PbQuantitySource = "COUNT" | "MEASURED_LENGTH" | "TERMINATION_COUNT" | "MANUAL";
export type PbDifficulty = "NORMAL" | "DIFFICULT" | "VERY_DIFFICULT";

export interface PbNecCategory {
  article: string;
  title: string | null;
  scopeRule: string | null;
  atomicCount: number;
}

export interface PbAtomic {
  itemId: string;
  description: string | null;
  category: string | null;
  unit: string | null;
  rowType: string | null;
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
  laborUnitBasis: string | null;
  costBasisUsed: number | null;
  sellPricePerUnit: number | null;
  necArticle: string | null;
  hasLabourUnitBasis: boolean;
  hasPriceAtActiveSupplier: boolean;
  /** Priced from Kyle's own sell columns — no supplier price needed (2026-08-22). */
  isFlatPriced?: boolean;
  isContinuousLength: boolean;
  /** False when all three published labour columns are blank — no hour at any difficulty. */
  hasPublishedLabour: boolean;
  /** False for a LABOR PRODUCT — "no price at supplier" is not a gap on one. */
  sellsMaterial: boolean;
  /** Sold by the hour: quantity IS hours (DG001 diagnostics). */
  isHourlyProduct: boolean;
}

export interface PbDraft {
  id: string;
  title: string;
  supplierId: string;
  status: string;
  /** Context (P024, Option A). All nullable — an unattached draft is the working default. */
  leadId?: string | null;
  customerId?: string | null;
  visitId?: string | null;
  customer?: { id: string; name: string } | null;
  visit?: { id: string; purpose: string | null; jobType: string | null } | null;
  lead?: { id: string; name: string } | null;
  rateProvisional: boolean;
  provisionalReason: string | null;
  billedLaborRate: number | null;
  updatedAt?: string;
  _count?: { lines: number; questions: number };
}

export interface PbLine {
  id: string;
  itemId: string;
  description: string | null;
  quantity: number;
  quantitySource: PbQuantitySource;
  difficulty: PbDifficulty;
  location: string | null;
  note: string | null;
  /** The atomic's unit — "hr" means quantity IS hours and the edit sheet says so. */
  unit: string | null;
  proposedBy?: string | null;
  reasoning?: string | null;
  proposedAt?: string | null;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
  editedBeforeConfirm?: boolean;
}

export interface PbQuestion {
  id: string;
  question: string;
  rawText: string | null;
  raisedBy: string;
  createdAt: string;
}

export interface PbReview {
  draft: PbDraft;
  proposedLines: PbLine[];
  confirmedLines: PbLine[];
  openQuestions: PbQuestion[];
  counts: { proposed: number; confirmed: number; openQuestions: number };
}

export interface PbLineGap {
  kind: string;
  itemId: string;
  message: string;
  routesTo: string;
}

export interface PbComputedLine {
  /** Passed through by the engine so rows can be grouped without a second lookup. */
  option: PbOption;
  /** The draft line id. Join on this, never on itemId — a draft may carry an atomic twice. */
  id?: string;
  itemId: string;
  description: string | null;
  quantity: number;
  quantitySource: PbQuantitySource;
  difficulty: PbDifficulty;
  unit: string | null;
  laborUnitBasis: string | null;
  laborHours: number | null;
  laborDollars: number | null;
  costBasis: number | null;
  materialCost: number | null;
  materialSell: number | null;
  gaps: PbLineGap[];
  complete: boolean;
}

export interface PbComputed {
  supplierId: string;
  billedLaborRate: number | null;
  lines: PbComputedLine[];
  laborHours: number;
  laborDollars: number;
  materialCost: number;
  /** AFTER the job-level material check. What the customer is charged. */
  materialSell: number;
  /**
   * What the job-level material check did, per option (2026-08-21).
   *
   * Shown on the totals bar so an adjustment Kyle can be asked about by a customer is never one he
   * has to discover from the arithmetic.
   */
  materialCaps?: Record<string, {
    materialCost: number;
    uncappedSell: number;
    blended: number;
    ceiling: number;
    bandLabel: string;
    cappedSell: number;
    reduction: number;
    applied: boolean;
  }>;
  /**
   * The third gate (2026-08-22): every combination the customer could tick, priced as one job.
   * Keyed "A", "A+B", "A+B+C". `reduction` is the multi-option saving for that selection —
   * the sales lever the presentation screen shows while Kyle is standing in front of them.
   */
  combinationDiscounts?: Record<string, {
    reduction: number;
    ceiling: number;
    bandLabel: string;
    applied: boolean;
  }>;
  subtotal: number | null;
  jobFixedCost: number | null;
  total: number | null;
  gaps: PbLineGap[];
  incompleteLineCount: number;
  totalLineCount: number;
  completenessSummary: string;
}

/** What `GET /price-book/drafts/:id/compute` returns. */
export interface PbComputeResponse {
  /** The discount programme on the draft, with its terms (2026-08-22; custom 2026-09-01). Amount is per-selection; cap null = uncapped. */
  discount?: { type: "military" | "senior" | "custom"; rate: number; cap: number | null; percent: number } | null;
  computed: PbComputed;
  options: PbOptionSummary[];
  rateProvisional?: boolean;
  provisionalReason?: string | null;
}

/** Which of the three options a line belongs to (Kyle, 2026-08-19). */
export type PbOption = "A" | "B" | "C";

export interface PbOptionSummary {
  option: PbOption;
  lineCount: number;
  laborHours: number;
  laborDollars: number;
  materialSell: number;
  /**
   * Labour + material for this option only.
   *
   * The trip charge is NOT in here. It is charged once for the visit, and any combination of
   * options signed together is a single job — so adding it per option would charge a customer
   * who takes all three three times over.
   */
  subtotal: number | null;
  complete: boolean;
}

export interface PbFinalizeResult {
  finalized: boolean;
  reasons?: string[];
  warnings?: string[];
  computed: PbComputed;
}

export interface PbWalkthroughRow {
  /** Words the tech wrote that appear nowhere in the catalog (P031). */
  unknownWords?: string[];
  raw: string;
  parsedQuantity: number | null;
  searchTerm: string;
  status: "MATCHED" | "AMBIGUOUS" | "UNMATCHED";
  /** "all words" | "single-word fallback" — a fallback hit is never auto-trusted. */
  matchedOn?: string;
  candidates: Array<{
    itemId: string;
    description: string | null;
    unit: string | null;
    isContinuousLength: boolean;
    hasLabourUnitBasis: boolean;
    hasPriceAtActiveSupplier: boolean;
  }>;
}

// ─── Issued estimates — the customer-facing artifact (P027) ──────────────────
// NOTE: there is no hours field anywhere in these types, and that is deliberate.
// Kyle 2026-08-17: "Never show labor hour estimate to the customer."

export interface PbIssuedLine {
  id: string;
  itemId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  sortOrder: number;
}

export interface PbIssuedEvent {
  id: string;
  type: string;
  at: string;
  actor: string;
  detail: string | null;
}

export interface PbIssuedEstimate {
  id: string;
  /**
   * The draft this was issued FROM — how the Edit button gets back into the builder.
   *
   * Kyle, 2026-08-20: "There should be a view button that does exactly what clicking on the
   * estimate does now and an edit button that loads this into the estimate builder to finalize
   * and send to the customer."
   *
   * The account endpoint has always returned it; only the type never named it.
   */
  draftId: string;
  /** The spine (P029). Both are needed to reopen the builder in the right account context. */
  customerId: string;
  serviceAddressId: string;
  number: string;
  revision: number;
  status: "draft" | "sent" | "viewed" | "signed" | "void";
  title: string;
  customerName: string;
  customerEmail: string | null;
  serviceAddress?: string | null;
  /** What the signed document actually bills — taken options + trip − combo discount (2026-08-22).
      Equals `total` until signing narrows the selection. */
  billedTotal?: number;
  workSubtotal?: number;
  tripCharge?: number;
  tripWaived?: boolean;
  total: number;
  createdAt: string;
  sentAt: string | null;
  sentTo: string | null;
  firstViewedAt: string | null;
  signedAt: string | null;
  signerName: string | null;
  /** "in_person" (P028) or "email" (P027); null on estimates issued before P028. */
  signedChannel?: "in_person" | "email" | null;
  supersededBy?: { id: string; revision: number } | null;
  lines?: PbIssuedLine[];
  events?: PbIssuedEvent[];
  /** Home-warranty coverage (Kyle, 2026-09-09) — the raw record; null when none. */
  warrantyJson?: string | null;
  /** The claim as applied, from the account-estimates route; already off billedTotal. */
  warranty?: WarrantyClaim | null;
  warrantyCovered?: number;
  /** What the warranty company has paid on it so far (Kyle, 2026-09-10). */
  warrantyPaid?: number;
  /** Gmail reported the last email about this row undeliverable (Kyle, 2026-09-09). Additive. */
  lastBounceAt?: string | null;
  lastBounceReason?: string | null;
  /** The last email's real delivery state — Resend's report, or "sent via Gmail" (Kyle, 2026-09-09). Additive. */
  lastDelivery?: EmailLastDelivery | null;
}

/**
 * One Gmail Delivery Status Notification, parsed (Kyle, 2026-09-09: "very few are actually
 * getting through, this is priority number one"). From GET /email-bounces.
 */
export type EmailBounceRow = {
  id: string;
  /** "gmail" = a DSN the watcher read; "resend" = the delivery webhook (Kyle, 2026-09-09). */
  provider?: "gmail" | "resend";
  providerMessageId?: string | null;
  recipient: string;
  /** Enhanced status code, e.g. "5.1.1" (no such address) or "5.7.0" (receiver refused). */
  status: string | null;
  /** The Diagnostic-Code line, e.g. "smtp; 554 ... ESMTP server not available". */
  diagnostic: string | null;
  action: string | null;
  remoteMta: string | null;
  originalSubject: string | null;
  kind: EmailKind;
  estimateNumber: string | null;
  issuedEstimateId: string | null;
  visitId: string | null;
  bouncedAt: string;
  resolvedAt: string | null;
  resolvedNote: string | null;
  account: { id: string; name: string } | null;
  estimate: { id: string; number: string; revision: number; title: string } | null;
  visit: { id: string; purpose: string | null; jobType: string | null; scheduledStart: string | null } | null;
};

export type EmailBouncePollResult =
  | { available: true; scanned: number; new: number; errors: number }
  | { available: false; reason: string };

// ─── Transactional email delivery (Kyle, 2026-09-09: "I need the emails working") ───────────

export type EmailKind =
  | "estimate" | "invoice" | "appointment" | "deposit" | "balance" | "receipt"
  | "health_record" | "document" | "campaign" | "other";

export type EmailDeliveryStatus = "sent" | "delivered" | "delayed" | "bounced" | "complained" | "failed";

/**
 * The newest customer email about a row and what became of it. Resend reports delivered /
 * delayed / bounced / complained by webhook; a Gmail send stays "sent" (Gmail reports nothing —
 * the DSN watcher covers its bounces); "failed" means neither pipe took it.
 */
export type EmailLastDelivery = {
  provider: "resend" | "gmail";
  status: EmailDeliveryStatus;
  statusAt: string | null;
  to: string;
  error: string | null;
  createdAt: string;
};

/** One row of GET /email-deliveries. */
export type EmailDeliveryRow = EmailLastDelivery & {
  id: string;
  providerMessageId: string | null;
  subject: string;
  kind: EmailKind;
  estimateNumber: string | null;
  issuedEstimateId: string | null;
  visitId: string | null;
  estimate: { id: string; number: string; revision: number; title: string } | null;
};

/** GET /email-status — the transport's health for the Financials strip. */
export type EmailStatus = {
  provider: "resend" | "gmail";
  from: string;
  replyTo: string;
  bccSelf: boolean;
  resendConfigured: boolean;
  gmailConfigured: boolean;
  webhookSecretSet: boolean;
  lastWebhookEventAt: string | null;
  last24h: Record<EmailDeliveryStatus | "total", number>;
};

/** One row of the Estimates chain view (P029): account + address + status + job. */
export interface PbChainRow {
  id: string;
  number: string;
  revision: number;
  status: "draft" | "sent" | "viewed" | "signed" | "void";
  title: string;
  total: number;
  /** Sell price (taken options + trip − caps − discount); equals `total` when nothing is selected. */
  billedTotal?: number;
  createdAt: string;
  sentAt: string | null;
  signedAt: string | null;
  signedChannel: "in_person" | "email" | null;
  /** Days the quote stays open after sending (Kyle, 2026-09-07 — "expired" is derived from this). */
  validDays?: number;
  account: { id: string; name: string; isTestAccount: boolean };
  serviceAddress: { id: string; name: string; addressLine1: string; city: string; state: string } | null;
  supersededBy: { id: string; revision: number } | null;
  job: { id: string; status: string; scheduledStart: string | null } | null;
  /** Home-warranty credit (Kyle, 2026-09-09), already off billedTotal. */
  warrantyCovered?: number;
  /** Gmail reported the last email about this row undeliverable (Kyle, 2026-09-09). Additive. */
  lastBounceAt?: string | null;
  lastBounceReason?: string | null;
  /** The last email's real delivery state — Resend's report, or "sent via Gmail" (Kyle, 2026-09-09). Additive. */
  lastDelivery?: EmailLastDelivery | null;
}

// ─── Email campaigns (Kyle, 2026-09-02) ───────────────────────────────────────
export type CampaignBlock =
  | { kind: "text"; text: string }
  | { kind: "article"; articleId: string; title: string; excerpt: string; url: string; imageUrl?: string | null }
  | { kind: "promo"; headline: string; text: string; ctaLabel: string; ctaUrl: string };

export type CampaignArticle = {
  id: string; title: string; slug: string; excerpt: string; tag: string | null;
  publishedAt: string | null; url: string;
};

export type CampaignOverview = {
  lists: Array<{ id: string; name: string; includeAllAccounts: boolean; manualMembers: number; reach: number; members: Array<{ id: string; email: string; name: string | null; fromLead: boolean }> }>;
  campaigns: Array<{
    id: string; name: string; subject: string; status: "draft" | "sending" | "sent";
    listName: string; listId: string; blocks: CampaignBlock[];
    createdAt: string; sentAt: string | null;
    sentCount: number; failedCount: number; suppressedCount: number; fromArticle: boolean;
  }>;
  suppressedCount: number;
};

