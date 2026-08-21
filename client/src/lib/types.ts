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
  };
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

export type AccountPurchaseOrder = {
  id: string;
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
};

export type AccountJob = {
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

export type AccountInspectionSummary = {
  id: string;
  visitId: string;
  propertyId: string;
  inspectionDate: string;
  /** v1 only — the retired 0-100 headline. Null on findings-led v2 records. */
  score: number | null;
  schemaVersion: "v1" | "v2";
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
  materialSell: number;
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
}

/** One row of the Estimates chain view (P029): account + address + status + job. */
export interface PbChainRow {
  id: string;
  number: string;
  revision: number;
  status: "draft" | "sent" | "viewed" | "signed" | "void";
  title: string;
  total: number;
  createdAt: string;
  sentAt: string | null;
  signedAt: string | null;
  signedChannel: "in_person" | "email" | null;
  account: { id: string; name: string; isTestAccount: boolean };
  serviceAddress: { id: string; name: string; addressLine1: string; city: string; state: string } | null;
  supersededBy: { id: string; revision: number } | null;
  job: { id: string; status: string; scheduledStart: string | null } | null;
}
