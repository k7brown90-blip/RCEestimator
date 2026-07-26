import type {
  AssemblyTemplate,
  AvailabilityResponse,
  CompanionSuggestion,
  CrmCycleTimeMetrics,
  CrmFollowUpsMetrics,
  CrmFunnelMetrics,
  CrmOverview,
  CrmWinLossMetrics,
  Customer,
  Estimate,
  EstimateAssembly,
  JobSummary,
  MonthSchedule,
  Property,
  ScheduleJobResult,
  Visit,
  AtomicUnit,
  ModifierDef,
  EstimateItem,
  SupportItem,
  Lead,
  WeekSchedule,
} from "./types";

const API_BASE = "/api";

function withDateRange(path: string, range?: { startDate?: string; endDate?: string }) {
  const search = new URLSearchParams();
  if (range?.startDate) search.set("startDate", range.startDate);
  if (range?.endDate) search.set("endDate", range.endDate);
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = typeof localStorage !== "undefined" ? localStorage.getItem("rce_token") : null;
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem("rce_token");
      window.location.href = "/login";
      throw new Error("Session expired");
    }
    const text = await response.text();
    if (text) {
      let parsedError: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: string; details?: unknown };
        if (parsed.error) {
          parsedError = parsed.error;
        }
      } catch {
        // Non-JSON error body; fall back to plain text
      }

      throw new Error(parsedError || text);
    }
    throw new Error(`Request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const successText = await response.text();
  if (!successText) {
    return undefined as T;
  }

  return JSON.parse(successText) as T;
}

export const api = {
  jobs: () => request<JobSummary[]>("/jobs"),
  customers: () => request<Customer[]>("/customers"),
  customer: (customerId: string) => request<Customer>(`/customers/${customerId}`),
  createCustomer: (input: { name: string; email?: string; phone?: string }) => request<Customer>("/customers", { method: "POST", body: JSON.stringify(input) }),
  updateCustomer: (customerId: string, input: { name?: string; email?: string | null; phone?: string | null }) => request<Customer>(`/customers/${customerId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteCustomer: (customerId: string) => request<void>(`/customers/${customerId}`, { method: "DELETE" }),
  properties: () => request<Property[]>("/properties"),
  property: (propertyId: string) => request<Property>(`/properties/${propertyId}`),
  createProperty: (input: {
    customerId: string;
    name: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    state: string;
    postalCode: string;
    notes?: string;
  }) => request<Property>("/properties", { method: "POST", body: JSON.stringify(input) }),
  updateProperty: (propertyId: string, input: { name?: string; addressLine1?: string; city?: string; state?: string; postalCode?: string; notes?: string }) =>
    request<Property>(`/properties/${propertyId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteProperty: (propertyId: string) => request<void>(`/properties/${propertyId}`, { method: "DELETE" }),
  updateSnapshot: (propertyId: string, input: {
    serviceSummary?: string;
    panelSummary?: string;
    groundingSummary?: string;
    wiringMethodSummary?: string;
    deficiencies?: string[];
  }) => request(`/properties/${propertyId}/snapshot`, { method: "PATCH", body: JSON.stringify(input) }),
  visits: () => request<Visit[]>("/visits"),
  visit: (visitId: string) => request<Visit>(`/visits/${visitId}`),
  createVisit: (input: { propertyId: string; customerId: string; mode: string; purpose?: string; notes?: string }) => request<Visit>("/visits", { method: "POST", body: JSON.stringify(input) }),
  updateVisit: (visitId: string, input: { mode?: string; purpose?: string; jobType?: string; notes?: string }) =>
    request<Visit>(`/visits/${visitId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteVisit: (visitId: string) => request<void>(`/visits/${visitId}`, { method: "DELETE" }),
  upsertCustomerRequest: (visitId: string, input: { requestText: string; urgency?: string }) => request(`/visits/${visitId}/customer-request`, { method: "POST", body: JSON.stringify(input) }),
  updateCustomerRequest: (visitId: string, input: { requestText: string; urgency?: string }) => request(`/visits/${visitId}/customer-request`, { method: "PATCH", body: JSON.stringify(input) }),
  addObservation: (visitId: string, input: { observationText: string; location?: string }) => request(`/visits/${visitId}/observations`, { method: "POST", body: JSON.stringify(input) }),
  updateObservation: (visitId: string, observationId: string, input: { observationText: string; location?: string }) => request(`/visits/${visitId}/observations/${observationId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteObservation: (visitId: string, observationId: string) => request(`/visits/${visitId}/observations/${observationId}`, { method: "DELETE" }),
  addFinding: (visitId: string, input: { findingText: string; confidence?: string }) => request(`/visits/${visitId}/findings`, { method: "POST", body: JSON.stringify(input) }),
  updateFinding: (visitId: string, findingId: string, input: { findingText: string; confidence?: string }) => request(`/visits/${visitId}/findings/${findingId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteFinding: (visitId: string, findingId: string) => request(`/visits/${visitId}/findings/${findingId}`, { method: "DELETE" }),
  addLimitation: (visitId: string, input: { limitationText: string }) => request(`/visits/${visitId}/limitations`, { method: "POST", body: JSON.stringify(input) }),
  updateLimitation: (visitId: string, limitationId: string, input: { limitationText: string }) => request(`/visits/${visitId}/limitations/${limitationId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteLimitation: (visitId: string, limitationId: string) => request(`/visits/${visitId}/limitations/${limitationId}`, { method: "DELETE" }),
  addRecommendation: (visitId: string, input: { recommendationText: string; priority?: string }) => request(`/visits/${visitId}/recommendations`, { method: "POST", body: JSON.stringify(input) }),
  updateRecommendation: (visitId: string, recommendationId: string, input: { recommendationText: string; priority?: string }) => request(`/visits/${visitId}/recommendations/${recommendationId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteRecommendation: (visitId: string, recommendationId: string) => request(`/visits/${visitId}/recommendations/${recommendationId}`, { method: "DELETE" }),
  createEstimate: (input: { visitId: string; propertyId: string; title: string; notes?: string }) => request<{ id: string }>("/estimates", { method: "POST", body: JSON.stringify(input) }),
  estimate: (estimateId: string) => request<Estimate>(`/estimates/${estimateId}`),
  deleteEstimate: (estimateId: string) => request(`/estimates/${estimateId}`, { method: "DELETE" }),
  createOption: (estimateId: string, input: { optionLabel: string; description?: string }) => request(`/estimates/${estimateId}/options`, { method: "POST", body: JSON.stringify(input) }),
  updateOption: (optionId: string, input: { optionLabel?: string; description?: string | null }) => request(`/options/${optionId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteOption: (optionId: string) => request(`/options/${optionId}`, { method: "DELETE" }),
  addAssembly: (optionId: string, input: { assemblyTemplateId: string; location?: string; quantity?: number; parameters?: Record<string, unknown>; assemblyNotes?: string }) =>
    request<EstimateAssembly>(`/options/${optionId}/assemblies`, { method: "POST", body: JSON.stringify(input) }),
  updateAssembly: (assemblyId: string, input: { location?: string | null; quantity?: number; parameters?: Record<string, unknown> }) =>
    request<EstimateAssembly>(`/assemblies/${assemblyId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteAssembly: (assemblyId: string) => request(`/assemblies/${assemblyId}`, { method: "DELETE" }),
  assemblySuggestions: (optionId: string, params: { assemblyTemplateId?: string; assemblyNumber?: number }) => {
    const search = new URLSearchParams();
    if (params.assemblyTemplateId) {
      search.set("assemblyTemplateId", params.assemblyTemplateId);
    }
    if (params.assemblyNumber !== undefined) {
      search.set("assemblyNumber", String(params.assemblyNumber));
    }
    const suffix = search.toString();
    return request<{ suggestions: CompanionSuggestion[] }>(`/options/${optionId}/assembly-suggestions${suffix ? `?${suffix}` : ""}`);
  },
  changeEstimateStatus: (estimateId: string, status: string) => request(`/estimates/${estimateId}/status`, { method: "POST", body: JSON.stringify({ status }) }),
  updateEstimateMarkup: (estimateId: string, input: { materialMarkupPct?: number; laborMarkupPct?: number }) => request(`/estimates/${estimateId}/markup`, { method: "PATCH", body: JSON.stringify(input) }),
  upsertPermitStatus: (estimateId: string, input: { required: boolean; permitType?: string; status: string; permitNumber?: string; cost?: number }) => request(`/estimates/${estimateId}/permit-status`, { method: "PUT", body: JSON.stringify(input) }),
  upsertInspectionStatus: (estimateId: string, input: { inspectionType: string; status: string; notes?: string; corrections?: string[] }) => request(`/estimates/${estimateId}/inspection-status`, { method: "PUT", body: JSON.stringify(input) }),
  generateProposal: (estimateId: string) => request<{ filePath: string; deliveryId: string }>(`/estimates/${estimateId}/proposals`, { method: "POST" }),
  sendProposal: (estimateId: string) => request<{ signUrl: string; documentId: string; emailSent: boolean }>(`/estimates/${estimateId}/send-proposal`, { method: "POST" }),
  generateWorkOrder: (estimateId: string) => request<{ filePath: string; documentId: string }>(`/estimates/${estimateId}/work-order`, { method: "POST" }),
  generateMaterialListDoc: (estimateId: string) => request<{ filePath: string; documentId: string }>(`/estimates/${estimateId}/material-list`, { method: "POST" }),
  materialList: (optionId: string) => request<{ optionLabel: string; items: Array<{ code: string; description: string; quantity: number; unit: string; unitCost: number }> }>(`/options/${optionId}/materials`),
  recordSignature: (estimateId: string, input: { signerName: string; signerEmail?: string; signatureData: string; consentText: string }) => request<{ id: string }>(`/estimates/${estimateId}/signatures`, { method: "POST", body: JSON.stringify(input) }),
  acceptProposal: (estimateId: string, input: { optionId: string; signatureId?: string; notes?: string; status?: "accepted" | "declined" }) => request(`/estimates/${estimateId}/acceptance`, { method: "POST", body: JSON.stringify(input) }),
  createChangeOrder: (estimateId: string, input: {
    parentOptionId: string;
    title: string;
    reason?: string;
    reasonType?: string;
    deltaLabor?: number;
    deltaMaterial?: number;
    deltaOther?: number;
    assembliesAdded?: unknown[];
  }) => request(`/estimates/${estimateId}/change-orders`, { method: "POST", body: JSON.stringify(input) }),
  assemblies: (params?: { query?: string; category?: string; tier?: string }) => {
    const search = new URLSearchParams();
    if (params?.query) search.set("query", params.query);
    if (params?.category) search.set("category", params.category);
    if (params?.tier) search.set("tier", params.tier);
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<AssemblyTemplate[]>(`/assemblies${suffix}`);
  },
  // ─── Atomic Model ────────────────────────────────────────────────────────
  atomicUnits: (params?: { category?: string; tier?: number }) => {
    const search = new URLSearchParams();
    if (params?.category) search.set("category", params.category);
    if (params?.tier !== undefined) search.set("tier", String(params.tier));
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<AtomicUnit[]>(`/atomic-units${suffix}`);
  },
  atomicUnit: (code: string) => request<AtomicUnit>(`/atomic-units/${code}`),
  modifiers: (appliesTo?: "ITEM" | "ESTIMATE") => {
    const suffix = appliesTo ? `?appliesTo=${appliesTo}` : "";
    return request<ModifierDef[]>(`/modifiers${suffix}`);
  },
  presets: () => request<Array<{ id: string; name: string; description?: string | null; category?: string | null; itemsJson: string }>>("/presets"),
  jobTypes: () => request<Array<{ id: string; name: string; description?: string | null }>>("/job-types"),
  createItem: (
    estimateId: string,
    optionId: string,
    input: {
      atomicUnitCode: string;
      quantity: number;
      location?: string;
      circuitVoltage?: number;
      circuitAmperage?: number;
      environment?: string;
      exposure?: string;
      cableLength?: number;
      modifiers?: Array<{ modifierType: string; modifierValue: string; laborMultiplier: number; materialMult: number }>;
    }
  ) => request<{ item: EstimateItem; suggestEndpoint: boolean; resolvedWiringMethod: { method: string; code: string } | null }>(
    `/estimates/${estimateId}/options/${optionId}/items`,
    { method: "POST", body: JSON.stringify(input) }
  ),
  items: (estimateId: string, optionId: string) =>
    request<EstimateItem[]>(`/estimates/${estimateId}/options/${optionId}/items`),
  deleteItem: (estimateId: string, optionId: string, itemId: string) =>
    request<void>(`/estimates/${estimateId}/options/${optionId}/items/${itemId}`, { method: "DELETE" }),
  generateSupportItems: (estimateId: string) =>
    request<{ supportItems: SupportItem[] }>(`/estimates/${estimateId}/support-items/generate`, { method: "POST", body: JSON.stringify({}) }),
  supportItems: (estimateId: string) =>
    request<SupportItem[]>(`/estimates/${estimateId}/support-items`),
  patchSupportItem: (estimateId: string, itemId: string, input: { laborHrs?: number; laborRate?: number; otherCost?: number; isOverridden?: boolean; overrideNote?: string }) =>
    request<SupportItem>(`/estimates/${estimateId}/support-items/${itemId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteSupportItem: (estimateId: string, itemId: string) =>
    request<void>(`/estimates/${estimateId}/support-items/${itemId}`, { method: "DELETE" }),
  // ─── Leads ────────────────────────────────────────────────────────────────
  leads: (status?: string) => {
    const suffix = status ? `?status=${status}` : "";
    return request<Lead[]>(`/leads${suffix}`);
  },
  updateLead: (
    leadId: string,
    input: {
      name?: string;
      email?: string;
      phone?: string;
      address?: string;
      jobType?: string;
      status?: string;
      notes?: string;
      leadStatus?: string;
      followUpDate?: string | null;
      followUpReason?: string | null;
      followUpCount?: number;
      lostReason?: string | null;
      lostNotes?: string | null;
      bestTimeToReach?: string | null;
      contactPreference?: string | null;
    },
  ) =>
    request<Lead>(`/leads/${leadId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteLead: (leadId: string) =>
    request<void>(`/leads/${leadId}`, { method: "DELETE" }),
  convertLead: (leadId: string) =>
    request<{ customer: Customer; property: Property | null; visit: Visit | null; lead: Lead }>(`/leads/${leadId}/convert`, { method: "PATCH" }),
  // ─── Calendar / Schedule ────────────────────────────────────────────────────
  weekSchedule: () => request<WeekSchedule>("/crm/schedule/week"),
  monthSchedule: (year: number, month: number) => request<MonthSchedule>(`/crm/schedule/month?year=${year}&month=${month}`),
  calendarAvailability: () => request<AvailabilityResponse>("/crm/schedule/availability"),
  // ─── CRM Analytics ────────────────────────────────────────────────────────
  crmOverview: (range?: { startDate?: string; endDate?: string }) =>
    request<CrmOverview>(withDateRange("/crm/analytics/overview", range)),
  crmFunnel: (range?: { startDate?: string; endDate?: string }) =>
    request<CrmFunnelMetrics>(withDateRange("/crm/analytics/funnel", range)),
  crmFollowUps: () => request<CrmFollowUpsMetrics>("/crm/analytics/follow-ups"),
  crmWinLoss: (range?: { startDate?: string; endDate?: string }) =>
    request<CrmWinLossMetrics>(withDateRange("/crm/analytics/win-loss", range)),
  crmCycleTime: (range?: { startDate?: string; endDate?: string }) =>
    request<CrmCycleTimeMetrics>(withDateRange("/crm/analytics/cycle-time", range)),
  // ─── Job Scheduling ──────────────────────────────────────────────────────
  scheduleJob: (jobId: string, input: { startDate: string; startTime?: string }) =>
    request<ScheduleJobResult>(`/crm/jobs/${jobId}/schedule`, { method: "POST", body: JSON.stringify(input) }),
  rescheduleJob: (jobId: string, input: { newStartDate: string; reason: string }) =>
    request<ScheduleJobResult>(`/crm/jobs/${jobId}/reschedule`, { method: "POST", body: JSON.stringify(input) }),
  cancelJob: (jobId: string, input: { reason: string }) =>
    request<{ jobId: string; cancelled: boolean }>(`/crm/jobs/${jobId}/cancel`, { method: "POST", body: JSON.stringify(input) }),
  // ─── Health Record (field inspection PWA) ─────────────────────────────────
  technicians: () => request<Technician[]>("/health-record-admin/technicians"),
  createTechnician: (input: { name: string; email?: string; phone?: string; employeeNumber?: string; role?: string }) =>
    request<Technician>("/health-record-admin/technicians", { method: "POST", body: JSON.stringify(input) }),
  updateTechnician: (technicianId: string, input: { name?: string; isActive?: boolean; rotateToken?: boolean; employeeNumber?: string | null }) =>
    request<Technician>(`/health-record-admin/technicians/${technicianId}`, { method: "PATCH", body: JSON.stringify(input) }),
  assignTechnician: (visitId: string, input: { technicianId: string; role?: "primary" | "helper" }) =>
    request<VisitAssignment>(`/health-record-admin/visits/${visitId}/assign`, { method: "POST", body: JSON.stringify(input) }),
  visitAssignments: (visitId: string) => request<VisitAssignment[]>(`/health-record-admin/visits/${visitId}/assignments`),
  removeAssignment: (assignmentId: string) =>
    request<void>(`/health-record-admin/assignments/${assignmentId}`, { method: "DELETE" }),
  customerInspections: (customerId: string) =>
    request<HealthInspectionSummary[]>(`/health-record-admin/customers/${customerId}/inspections`),
  propertyInspections: (propertyId: string) =>
    request<HealthInspectionSummary[]>(`/health-record-admin/properties/${propertyId}/inspections`),
  visitInspections: (visitId: string) =>
    request<HealthInspectionSummary[]>(`/health-record-admin/visits/${visitId}/inspections`),
  healthInspection: (inspectionId: string) =>
    request<HealthInspectionDetail>(`/health-record-admin/inspections/${inspectionId}`),
  reviewInspection: (inspectionId: string, input: { reviewedBy: string }) =>
    request<{ id: string; contractorReviewed: boolean; reviewedAt: string; reviewedBy: string }>(
      `/health-record-admin/inspections/${inspectionId}/review`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  runInspectionRetention: () =>
    request<{ checked: number; created: number }>("/health-record-admin/retention/run", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  generateHealthReport: (inspectionId: string) =>
    request<{ documentId: string; pdfPath: string }>(
      `/health-record-admin/inspections/${inspectionId}/report`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  // ─── Company settings ───────────────────────────────────────────────────
  companySettings: () => request<CompanySettings>("/crm/settings"),
  saveCompanySetting: (key: string, value: unknown) =>
    request<{ key: string; value: unknown; updatedAt: string }>(`/crm/settings/${key}`, {
      method: "PUT",
      body: JSON.stringify(value),
    }),
};

// ─── Health Record types ─────────────────────────────────────────────────────

export interface Technician {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  employeeNumber?: string | null;
  role: string;
  accessToken: string;
  isActive: boolean;
  createdAt: string;
  _count?: { assignments: number; healthInspections: number };
}

// ─── Company settings types ─────────────────────────────────────────────

export interface CompanyProfile {
  companyName: string;
  address: string;
  phone: string;
  email: string;
  licenseNumber: string;
  licenseState: string;
  licenseExpiration: string;
  insuranceCarrier: string;
  insurancePolicyNumber: string;
  insuranceExpiration: string;
}

export interface OperatingHours {
  weekdays: string;
  saturday: string;
  sunday: string;
  afterHoursPolicy: string;
}

export interface Territory {
  zip: string;
  area: string;
  codeCycle: string;
  utilityProvider: string;
  utilityPhone: string;
  utilityEmail: string;
  utilityNotes: string;
  inspectorName: string;
  inspectorPhone: string;
  inspectorEmail: string;
  inspectorNotes: string;
}

export interface LegalInfo {
  warrantyText: string;
  policiesText: string;
  insuranceNotes: string;
}

export interface CompanySettings {
  companyProfile?: CompanyProfile | null;
  operatingHours?: OperatingHours | null;
  territories?: Territory[] | null;
  legal?: LegalInfo | null;
}

export interface VisitAssignment {
  id: string;
  visitId: string;
  technicianId: string;
  role: string;
  status: string;
  assignedAt: string;
  completedAt?: string | null;
  technician: { id: string; name: string; role?: string; isActive?: boolean; employeeNumber?: string | null };
}

export interface HealthInspectionSummary {
  id: string;
  visitId: string;
  propertyId: string;
  customerId: string;
  jurisdictionId: string;
  inspectionDate: string;
  score: number;
  itemsAssessed: number;
  criticalFindingsJson: string;
  contractorReviewed: boolean;
  syncedAt: string;
  technician?: { id: string; name: string; employeeNumber?: string | null } | null;
}

export interface HealthInspectionDetail extends HealthInspectionSummary {
  itemsJson: string;
  loadCalcJson?: string | null;
  appVersion?: string | null;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  photos?: Array<{ id: string; mimeType: string; sizeBytes: number; uploadedAt: string }>;
}
