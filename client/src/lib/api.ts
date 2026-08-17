import type {
  Account,
  AccountSummary,
  AssemblyTemplate,
  AvailabilityResponse,
  CalendarSchedule,
  LeadPipeline,
  CompanionSuggestion,
  CrmCycleTimeMetrics,
  CrmFollowUpsMetrics,
  CrmFunnelMetrics,
  CrmOverview,
  CrmWinLossMetrics,
  Customer,
  CustomerMatch,
  Estimate,
  EstimateAssembly,
  JobSummary,
  MonthSchedule,
  Property,
  PropertyWriteInput,
  ScheduleJobResult,
  Visit,
  ModifierDef,
  EstimateItem,
  SupportItem,
  TechDayAvailability,
  FindingEvent,
  Lead,
  LeadWriteInput,
  PropertyFinding,
  WeekSchedule,
  PbAtomic,
  PbComputed,
  PbDifficulty,
  PbDraft,
  PbFinalizeResult,
  PbNecCategory,
  PbQuantitySource,
  PbQuestion,
  PbReview,
  PbWalkthroughRow,
} from "./types";

const API_BASE = "/api";

function withDateRange(path: string, range?: { startDate?: string; endDate?: string }) {
  const search = new URLSearchParams();
  if (range?.startDate) search.set("startDate", range.startDate);
  if (range?.endDate) search.set("endDate", range.endDate);
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * An error that kept the response body.
 *
 * Most failures only need their message rendered, but some are a question rather
 * than a fault — the duplicate-account 409 hands back the accounts it matched so
 * the caller can offer them.
 */
export class ApiError extends Error {
  status?: number;
  body?: Record<string, unknown>;
}

const sessionToken = () =>
  (typeof localStorage !== "undefined" ? localStorage.getItem("rce_token") : null);

/**
 * Fetch a binary resource that sits behind the session, as an object URL.
 *
 * A browser will not attach an Authorization header to `<img src>` or a plain
 * link, so anything protected has to be fetched properly and handed to the DOM
 * as a blob. Doing it any other way means putting the session token in the URL,
 * where it ends up in server logs and browser history.
 *
 * The caller owns the returned URL and must revokeObjectURL it.
 */
export async function fetchProtectedObjectUrl(path: string): Promise<string> {
  const token = sessionToken();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new ApiError(`Could not load ${path} (${response.status})`);
  }
  return URL.createObjectURL(await response.blob());
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = sessionToken();
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
      let body: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: string; details?: unknown };
        body = parsed as Record<string, unknown>;
        if (parsed.error) {
          parsedError = parsed.error;
        }
      } catch {
        // Non-JSON error body; fall back to plain text
      }

      // Some refusals carry data the UI needs to act on rather than just
      // display — the duplicate-account 409 returns the matching accounts so the
      // picker can open. The message alone would throw that away.
      throw Object.assign(new ApiError(parsedError || text), { status: response.status, body });
    }
    throw Object.assign(new ApiError(`Request failed: ${response.status}`), { status: response.status });
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
  // ─── Feedback ────────────────────────────────────────────────────────
  sendFeedback: (input: { message: string; page?: string }) =>
    request<{ ok: boolean }>("/feedback", { method: "POST", body: JSON.stringify(input) }),

  jobs: (params?: { archived?: boolean }) => {
    const suffix = params?.archived === undefined ? "" : `?archived=${params.archived}`;
    return request<JobSummary[]>(`/jobs${suffix}`);
  },

  // ─── Accounts ─────────────────────────────────────────────────────────────
  // The server exposes these under both /accounts and /customers (same handlers,
  // Prisma model is still Customer). The client speaks "account" throughout.
  accounts: () => request<Account[]>("/accounts"),
  account: (accountId: string) => request<Account>(`/accounts/${accountId}`),
  accountSummary: (accountId: string) => request<AccountSummary>(`/accounts/${accountId}/summary`),
  createAccount: (input: { name: string; email?: string; phone?: string }) =>
    request<Account>("/accounts", { method: "POST", body: JSON.stringify(input) }),
  updateAccount: (accountId: string, input: { name?: string; email?: string | null; phone?: string | null }) =>
    request<Account>(`/accounts/${accountId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteAccount: (accountId: string) => request<void>(`/accounts/${accountId}`, { method: "DELETE" }),

  // The server still serves /customers for the voice agents and webhooks; the
  // CRM client speaks only "account".
  properties: () => request<Property[]>("/properties"),
  property: (propertyId: string) => request<Property>(`/properties/${propertyId}`),
  createProperty: (input: PropertyWriteInput & { customerId: string; name: string; addressLine1: string; city: string; state: string; postalCode: string }) =>
    request<Property>("/properties", { method: "POST", body: JSON.stringify(input) }),
  /** `customerId` moves an address between accounts — 409s once it has job history. */
  updateProperty: (propertyId: string, input: PropertyWriteInput) =>
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
  //
  // Re-pointed by P014 (T1): `/atomic-units` now reads the imported price book, so these return
  // `PbAtomic` — three published labour columns and a unit basis — not the legacy one-labour-
  // number `AtomicUnit`. The `tier` filter is gone: the workbook publishes no visibility tier
  // and the route now rejects the parameter rather than ignoring it.
  atomicUnits: (params?: { category?: string; search?: string; article?: string; limit?: number }) => {
    const search = new URLSearchParams();
    if (params?.category) search.set("category", params.category);
    if (params?.search) search.set("search", params.search);
    if (params?.article) search.set("article", params.article);
    if (params?.limit) search.set("limit", String(params.limit));
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<{ atomics: PbAtomic[]; count: number; total: number; truncated: boolean }>(
      `/atomic-units${suffix}`
    );
  },
  atomicUnit: (code: string) => request<PbAtomic>(`/atomic-units/${code}`),
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
  // `pipeline` is the funnel filter behind the Leads tab; `status` is the older
  // per-lead state, kept because several callers still filter on it directly.
  leads: (params?: string | { status?: string; leadStatus?: string; pipeline?: LeadPipeline }) => {
    const normalized = typeof params === "string" ? { status: params } : params ?? {};
    const search = new URLSearchParams();
    if (normalized.status) search.set("status", normalized.status);
    if (normalized.leadStatus) search.set("leadStatus", normalized.leadStatus);
    if (normalized.pipeline) search.set("pipeline", normalized.pipeline);
    const query = search.toString();
    return request<Lead[]>(`/leads${query ? `?${query}` : ""}`);
  },
  /**
   * Manual lead entry. `POST /crm/leads`, not `POST /leads` — the latter is the
   * intake webhook and is gated on a shared secret the browser cannot hold.
   */
  createLead: (input: LeadWriteInput) =>
    request<{ lead: Lead; matches: CustomerMatch[] }>("/crm/leads", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateLead: (leadId: string, input: LeadWriteInput) =>
    request<Lead>(`/leads/${leadId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteLead: (leadId: string) =>
    request<void>(`/leads/${leadId}`, { method: "DELETE" }),
  /**
   * Convert. The optional body is how the duplicate picker answers the server's
   * 409: link to a chosen account and address, or confirm a genuinely new one.
   */
  convertLead: (
    leadId: string,
    input?: {
      customerId?: string;
      propertyId?: string;
      propertyName?: string;
      addressLine1?: string;
      addressLine2?: string | null;
      city?: string;
      state?: string;
      postalCode?: string;
      jurisdictionId?: string;
      createNewAccount?: boolean;
    },
  ) =>
    request<{ customer: Customer; property: Property | null; visit: Visit | null; lead: Lead }>(
      `/leads/${leadId}/convert`,
      { method: "PATCH", body: JSON.stringify(input ?? {}) },
    ),
  /** Accounts that might already be this caller — drives the duplicate picker. */
  customerMatches: (params: { phone?: string; email?: string; name?: string }) => {
    const search = new URLSearchParams();
    if (params.phone?.trim()) search.set("phone", params.phone.trim());
    if (params.email?.trim()) search.set("email", params.email.trim());
    if (params.name?.trim()) search.set("name", params.name.trim());
    return request<{ matches: CustomerMatch[] }>(`/crm/customer-matches?${search.toString()}`);
  },
  // ─── Calendar / Schedule ────────────────────────────────────────────────────
  weekSchedule: () => request<WeekSchedule>("/crm/schedule/week"),
  monthSchedule: (year: number, month: number) => request<MonthSchedule>(`/crm/schedule/month?year=${year}&month=${month}`),
  calendarAvailability: () => request<AvailabilityResponse>("/crm/schedule/availability"),
  /** Appointments from the DB plus unlinked Google events. `start`/`end` are YYYY-MM-DD, end inclusive. */
  calendarSchedule: (start: string, end: string) =>
    request<CalendarSchedule>(`/crm/schedule/calendar?start=${start}&end=${end}`),
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
  scheduleJob: (jobId: string, input: { startDate: string; startTime?: string; technicianId?: string }) =>
    request<ScheduleJobResult>(`/crm/jobs/${jobId}/schedule`, { method: "POST", body: JSON.stringify(input) }),
  // Per-tech busy blocks for one day — drives the scheduler's tech picker.
  // calendarAccessible=false means Google can't read that tech's calendar
  // (not shared), which the UI must show as a warning, never as "free".
  techAvailability: (date: string, opts?: { start?: string; durationMinutes?: number }) => {
    const query = new URLSearchParams({ date });
    if (opts?.start) query.set("start", opts.start);
    if (opts?.durationMinutes) query.set("durationMinutes", String(opts.durationMinutes));
    return request<{ date: string; techs: TechDayAvailability[] }>(`/crm/schedule/tech-availability?${query.toString()}`);
  },
  rescheduleJob: (jobId: string, input: { newStartDate: string; newStartTime?: string; reason: string }) =>
    request<ScheduleJobResult>(`/crm/jobs/${jobId}/reschedule`, { method: "POST", body: JSON.stringify(input) }),
  cancelJob: (jobId: string, input: { reason: string }) =>
    request<{ jobId: string; cancelled: boolean }>(`/crm/jobs/${jobId}/cancel`, { method: "POST", body: JSON.stringify(input) }),
  // ─── Health Record (field inspection PWA) ─────────────────────────────────
  technicians: () => request<Technician[]>("/health-record-admin/technicians"),
  createTechnician: (input: { name: string; email?: string; phone?: string; employeeNumber?: string; role?: string }) =>
    request<Technician>("/health-record-admin/technicians", { method: "POST", body: JSON.stringify(input) }),
  updateTechnician: (technicianId: string, input: { name?: string; isActive?: boolean; rotateToken?: boolean; employeeNumber?: string | null }) =>
    request<Technician>(`/health-record-admin/technicians/${technicianId}`, { method: "PATCH", body: JSON.stringify(input) }),
  verifyTechCalendar: (technicianId: string) =>
    request<{ accessible: boolean; email: string | null }>(`/health-record-admin/technicians/${technicianId}/verify-calendar`, { method: "POST" }),
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
  // Article 220 capacity checks were removed from the CRM 2026-08-02 — load
  // calculation is Health Report product surface (field PWA + demand-study
  // endpoints under /health-record-admin/capacity-checks), not CRM.
  // ─── Finding ledger ───────────────────────────────────────────────────────
  ledgerFindings: (params: { propertyId?: string; customerId?: string; track?: string; status?: string; needsCloseout?: boolean }) => {
    const query = new URLSearchParams();
    if (params.propertyId) query.set("propertyId", params.propertyId);
    if (params.customerId) query.set("customerId", params.customerId);
    if (params.track) query.set("track", params.track);
    if (params.status) query.set("status", params.status);
    if (params.needsCloseout) query.set("needsCloseout", "true");
    return request<PropertyFinding[]>(`/health-record-admin/findings?${query.toString()}`);
  },
  // Named `ledger*` throughout: `Finding` is also a visit-scoped observation on
  // the older estimate flow, and confusing the two would be expensive.
  ledgerFinding: (findingId: string) =>
    request<PropertyFinding & { events: FindingEvent[] }>(`/health-record-admin/findings/${findingId}`),
  /**
   * The owner's transitions. Resolving lives here and nowhere else — a
   * technician can claim a cure, but only the licence holder signs one.
   */
  updateLedgerFinding: (findingId: string, input: Record<string, unknown>) =>
    request<PropertyFinding>(`/health-record-admin/findings/${findingId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  issueFindingCertificate: (input: {
    propertyId: string;
    findingIds: string[];
    track: "defect" | "upgrade";
    attestedBy: string;
    visitId?: string | null;
  }) =>
    request<{ documentId: string; pdfPath: string; findingIds: string[] }>(
      "/health-record-admin/findings/certificate",
      { method: "POST", body: JSON.stringify(input) },
    ),
  issueFindingDeclination: (input: { propertyId: string; findingIds: string[]; preparedBy: string }) =>
    request<{ documentId: string; pdfPath: string }>(
      "/health-record-admin/findings/declination-letter",
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

  // ─── PRICE BOOK INTAKE (P012) ──────────────────────────────────────────────
  // Every one of these hits the PIN-protected surface. The AI reaches none of them.

  pbNecCategories: () => request<{ categories: PbNecCategory[] }>("/price-book/nec-categories"),

  pbAtomics: (opts?: { search?: string; article?: string; category?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (opts?.search) q.set("search", opts.search);
    if (opts?.article) q.set("article", opts.article);
    if (opts?.category) q.set("category", opts.category);
    if (opts?.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return request<{ atomics: PbAtomic[]; count: number; total: number; truncated: boolean }>(
      `/price-book/atomics${qs ? `?${qs}` : ""}`
    );
  },

  /**
   * The primary intake path (P023): the model composes proposed lines against the real catalog.
   * `path` is always present — "ai" or "basic" — because a tech must never wonder which brain
   * produced what they are reading.
   */
  pbProposeFromWalkthrough: (draftId: string, text: string) =>
    request<{
      path: "ai" | "basic";
      degradedReason?: string;
      proposed: Array<{ id: string; itemId: string; quantity: number; description: string | null }>;
      questions: Array<{ id: string; question: string }>;
      rejected: Array<{ itemId: string; reason: string }>;
      usage: { model: string; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; elapsedMs: number } | null;
    }>(`/price-book/drafts/${draftId}/propose`, { method: "POST", body: JSON.stringify({ text }) }),

  pbDrafts: () => request<{ drafts: PbDraft[] }>("/price-book/drafts"),

  pbCreateDraft: (input: { title: string; jobDescription?: string | null }) =>
    request<PbDraft>("/price-book/drafts", { method: "POST", body: JSON.stringify(input) }),

  pbReview: (draftId: string) => request<PbReview>(`/price-book/drafts/${draftId}/review`),

  pbCompute: (draftId: string) =>
    request<{ computed: PbComputed; rateProvisional: boolean; provisionalReason: string | null }>(
      `/price-book/drafts/${draftId}/compute`
    ),

  // Human-added line. Lands CONFIRMED — this is the path an AI proposal can never take.
  pbAddLine: (
    draftId: string,
    input: {
      itemId: string;
      quantity: number;
      quantitySource: PbQuantitySource;
      difficulty?: PbDifficulty;
      location?: string | null;
      note?: string | null;
    }
  ) => request(`/price-book/drafts/${draftId}/lines`, { method: "POST", body: JSON.stringify(input) }),

  pbDeleteLine: (lineId: string) =>
    request<void>(`/price-book/lines/${lineId}`, { method: "DELETE" }),

  pbConfirmLine: (
    lineId: string,
    edits?: { quantity?: number; quantitySource?: PbQuantitySource; difficulty?: PbDifficulty; location?: string | null; note?: string | null }
  ) => request(`/price-book/lines/${lineId}/confirm`, { method: "POST", body: JSON.stringify(edits ?? {}) }),

  pbRejectLine: (lineId: string) =>
    request<void>(`/price-book/lines/${lineId}/reject`, { method: "POST" }),

  pbResolveQuestion: (questionId: string, resolutionNote: string) =>
    request<{ ok: boolean; question: PbQuestion }>(`/price-book/questions/${questionId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolutionNote }),
    }),

  pbAddQuestion: (draftId: string, question: string, rawText?: string | null) =>
    request<PbQuestion>(`/price-book/drafts/${draftId}/questions`, {
      method: "POST",
      body: JSON.stringify({ question, rawText: rawText ?? null }),
    }),

  pbResolveWalkthrough: (rows: Array<{ raw: string; quantity?: number }>) =>
    request<{ rows: PbWalkthroughRow[] }>("/price-book/resolve-walkthrough", {
      method: "POST",
      body: JSON.stringify({ rows }),
    }),

  // Finalize returns 409 with reasons when the engine refuses. `request` throws on non-2xx,
  // so the caller catches and surfaces the reasons verbatim — the UI never re-words a refusal.
  pbFinalize: (draftId: string, context: "customer" | "internal") =>
    request<PbFinalizeResult>(`/price-book/drafts/${draftId}/finalize`, {
      method: "POST",
      body: JSON.stringify({ context }),
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
  /** Set by the Team page's "verify calendar" probe — Google can read their calendar. */
  calendarShared: boolean;
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
