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
  PbComputeResponse,
  PbOption,
  PbDifficulty,
  PbDraft,
  PbFinalizeResult,
  PbNecCategory,
  PbQuantitySource,
  PbQuestion,
  PbReview,
  PbWalkthroughRow,
  PbIssuedEstimate,
  PbChainRow,
} from "./types";

const API_BASE = "/api";

// ─── Contacts, job lifecycle & financials (2026-08-25) ────────────────────────

export interface CustomerContact {
  id: string;
  customerId: string;
  label: string;
  email: string | null;
  phone: string | null;
  createdAt: string;
}

export interface PurchaseOrderRow {
  id: string;
  supplier: string;
  sentAt: string | null;
  createdAt: string;
  items: { name: string; qty: number; unit?: string; partNumber?: string }[];
}

export interface FinancialsSummary {
  year: number;
  stripeConfigured: boolean;
  months: { month: number; invoiced: number; collected: number; expenses: number; net: number }[];
  totals: { invoiced: number; collected: number; expenses: number; net: number };
  expensesByCategory: { category: string; monthly: number[]; total: number }[];
}

export interface JobProfitRow {
  visitId: string;
  customer: string;
  customerId: string;
  address: string;
  jobType: string | null;
  completedAt: string | null;
  quoted: number | null;
  materialSpend: number;
  laborHours: number;
  laborCost: number;
  marginBeforeLabor: number | null;
  margin: number | null;
}

export interface ReceiptInsights {
  year: number;
  receiptsParsed: number;
  topItems: { name: string; receipts: number; totalQty: number; avgUnitCost: number | null; vendors: string[] }[];
  priceDrift: { receiptItem: string; bookItem: string; supplier: string; bookCost: number; receiptAvgCost: number; driftPct: number }[];
}

export interface StripeStatus {
  configured: boolean;
  keyMode: "live" | "test" | "none";
  restrictedKey: boolean;
  webhookSecretSet: boolean;
}

export interface CompanyBillRow {
  id: string;
  name: string;
  category: string;
  amount: number;
  cadence: "one_time" | "weekly" | "monthly" | "quarterly" | "annual";
  billDate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  notes?: string | null;
  createdAt: string;
}

export interface NextStepJob {
  visitId: string;
  customerId: string;
  customerName: string;
  propertyId: string;
  address: string;
  jobType: string | null;
  purpose: string | null;
  completedAt: string | null;
}

export interface PaymentInfo {
  estimateId: string;
  number: string;
  billedTotal: number;
  depositDue: number;
  depositPaid: number;
  totalPaid: number;
  balance: number;
  depositSatisfied: boolean;
  paidInFull: boolean;
  payUrl: string;
  depositPayUrl: string;
  stripeConfigured: boolean;
  payments: { id: string; amount: number; method: string; kind: string; status: string; paidAt: string | null }[];
}

export interface PaymentRow {
  id: string;
  amount: number;
  method: string;
  status: string;
  note: string | null;
  paidAt: string | null;
  createdAt: string;
  customer?: { id: string; name: string } | null;
}

/**
 * The visit modes the server will accept (`POST /visits`, zod enum in app.ts).
 *
 * Typed as a union rather than `string` because it was `string`: AccountDetailPage sent
 * `mode: "onsite"`, the compiler was satisfied, and "Schedule a visit" answered 400 every
 * time anyone pressed it. `tests/visitModes.test.ts` keeps this list equal to the server's.
 */
export const VISIT_MODES = ["new_construction", "remodel", "service_diagnostic", "maintenance"] as const;
export type VisitMode = (typeof VISIT_MODES)[number];

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

/**
 * Fetch a server-rendered HTML document that sits behind the session. (P028)
 *
 * `request<T>` assumes JSON; the customer view is HTML on purpose — it is the SAME document the
 * emailed link serves, and re-rendering it in React would create a second place for hours to
 * leak into. So this returns the text as-is for the signing screen to display in a sandboxed
 * iframe.
 */
async function requestHtml(path: string): Promise<string> {
  const token = sessionToken();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw Object.assign(new ApiError(`Could not load the estimate (${response.status})`), {
      status: response.status,
    });
  }
  return response.text();
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
  createVisit: (input: { propertyId: string; customerId: string; mode: VisitMode; purpose?: string; notes?: string }) => request<Visit>("/visits", { method: "POST", body: JSON.stringify(input) }),
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
  /** Email the report to the customer — logged as a delivery; refuses an unreviewed critical report. */
  emailHealthReport: (inspectionId: string, to?: string) =>
    request<{ sent: true; sentTo: string; documentId: string }>(
      `/health-record-admin/inspections/${inspectionId}/email`,
      { method: "POST", body: JSON.stringify(to ? { to } : {}) },
    ),

  // ─── Account contacts (2026-08-25) ─────────────────────────────────────────
  accountContacts: (accountId: string) =>
    request<CustomerContact[]>(`/accounts/${accountId}/contacts`),
  addAccountContact: (accountId: string, input: { label: string; email?: string | null; phone?: string | null }) =>
    request<CustomerContact>(`/accounts/${accountId}/contacts`, { method: "POST", body: JSON.stringify(input) }),
  deleteAccountContact: (accountId: string, contactId: string) =>
    request<void>(`/accounts/${accountId}/contacts/${contactId}`, { method: "DELETE" }),

  // ─── Job lifecycle (2026-08-25) ────────────────────────────────────────────
  completeJob: (jobId: string) =>
    request<{ completed: true; completedAt: string; warnings: string[] }>(`/jobs/${jobId}/complete`, {
      method: "POST", body: JSON.stringify({}),
    }),
  reopenJob: (jobId: string) =>
    request<{ reopened: true }>(`/jobs/${jobId}/reopen`, { method: "POST", body: JSON.stringify({}) }),
  jobPurchaseOrders: (jobId: string) =>
    request<PurchaseOrderRow[]>(`/jobs/${jobId}/purchase-orders`),
  createPurchaseOrder: (jobId: string, input: { supplier: string; items: { name: string; qty: number; unit?: string; partNumber?: string }[] }) =>
    request<{ id: string }>(`/jobs/${jobId}/purchase-orders`, { method: "POST", body: JSON.stringify(input) }),
  deletePurchaseOrder: (jobId: string, orderId: string) =>
    request<void>(`/jobs/${jobId}/purchase-orders/${orderId}`, { method: "DELETE" }),
  /** Receipt from the office — typed values, optional photo. */
  uploadJobReceipt: async (jobId: string, input: { amount: number; vendor?: string; category?: string; image?: File | null }) => {
    const receiptId = crypto.randomUUID().replaceAll("-", "");
    const query = new URLSearchParams({ amount: String(input.amount) });
    if (input.vendor) query.set("vendor", input.vendor);
    if (input.category) query.set("category", input.category);
    const token = localStorage.getItem("rce_token");
    const response = await fetch(`/api/jobs/${jobId}/receipts/${receiptId}?${query.toString()}`, {
      method: "PUT",
      headers: {
        "Content-Type": input.image?.type || "image/jpeg",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: input.image ?? new Blob([]),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error((body as { error?: string } | null)?.error ?? `Receipt upload failed (${response.status})`);
    }
    return (await response.json()) as { id: string; amount: number };
  },

  // ─── The Needs-next-step queue (Phase 4) ───────────────────────────────────
  needsNextStep: () => request<NextStepJob[]>("/jobs/needs-next-step"),
  dispositionJob: (jobId: string, action: "archive" | "book-followup") =>
    request<{ done: true; followupVisitId: string | null }>(`/jobs/${jobId}/next-step`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),

  // ─── Payments & deposits (2026-08-25) ──────────────────────────────────────
  jobPaymentInfo: (jobId: string) => request<PaymentInfo | null>(`/jobs/${jobId}/payment-info`),
  estimatePaymentInfo: (estimateId: string) =>
    request<PaymentInfo | null>(`/issued-estimates/${estimateId}/payment-info`),

  // ─── Financials (2026-08-25) ───────────────────────────────────────────────
  financialsSummary: (year: number) => request<FinancialsSummary>(`/financials/summary?year=${year}`),
  receiptInsights: (year: number) => request<ReceiptInsights>(`/financials/receipt-insights?year=${year}`),
  stripeStatus: () => request<StripeStatus>("/financials/stripe-status"),
  jobProfitability: (year: number) => request<JobProfitRow[]>(`/financials/job-profitability?year=${year}`),
  companyBills: () => request<CompanyBillRow[]>("/financials/bills"),
  createCompanyBill: (input: Omit<CompanyBillRow, "id" | "createdAt">) =>
    request<CompanyBillRow>("/financials/bills", { method: "POST", body: JSON.stringify(input) }),
  deleteCompanyBill: (id: string) => request<void>(`/financials/bills/${id}`, { method: "DELETE" }),
  paymentsList: (year: number) => request<PaymentRow[]>(`/financials/payments?year=${year}`),
  recordPayment: (input: { amount: number; method: "cash" | "check" | "zelle" | "other"; kind?: "deposit" | "final" | "other"; nonCardDiscount?: number; customerId?: string; estimateId?: string; note?: string }) =>
    request<PaymentRow>("/financials/payments", { method: "POST", body: JSON.stringify(input) }),
  // ─── Company settings ───────────────────────────────────────────────────
  companySettings: () => request<CompanySettings>("/crm/settings"),
  saveCompanySetting: (key: string, value: unknown) =>
    request<{ key: string; value: unknown; updatedAt: string }>(`/crm/settings/${key}`, {
      method: "PUT",
      body: JSON.stringify(value),
    }),

  // ─── PRICE BOOK INTAKE (P012) ──────────────────────────────────────────────
  // Every one of these hits the PIN-protected surface. The AI reaches none of them.

  pbSections: () =>
    request<{ sections: Array<{ section: string; itemCount: number }> }>("/price-book/sections"),

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

  pbCreateDraft: (input: {
    title: string;
    jobDescription?: string | null;
    /** Context (P024). Optional everywhere — an unattached draft is the working default. */
    leadId?: string | null;
    customerId?: string | null;
    visitId?: string | null;
  }) =>
    request<PbDraft>("/price-book/drafts", { method: "POST", body: JSON.stringify(input) }),

  pbReview: (draftId: string) => request<PbReview>(`/price-book/drafts/${draftId}/review`),

  /**
   * Kyle's names for the three options (2026-08-20).
   *
   * "It would be nice to be able to rename the options at the review screen in order to specify
   *  the scope of work to the job being quoted."
   *
   * These are what the customer reads on the tick boxes of the issued estimate — "Exterior pathway
   * lights" instead of "Option B" — so they are frozen onto it at graduation.
   */
  /** The discount programme on a draft — "military" | "senior" | null (2026-08-22). */
  pbSetDiscount: (draftId: string, type: "military" | "senior" | null) =>
    request<{ discountType: string | null }>(`/price-book/drafts/${draftId}/discount`, {
      method: "PUT",
      body: JSON.stringify({ type }),
    }),

  /** Walkthrough photos (2026-08-22). Bytes live in the DB; nothing goes to any AI. */
  pbUploadPhoto: (draftId: string, dataUrl: string, note?: string | null) =>
    request<{ id: string; mime: string; size: number }>(`/price-book/drafts/${draftId}/photos`, {
      method: "POST",
      body: JSON.stringify({ dataUrl, note: note ?? null }),
    }),
  pbPhotos: (draftId: string) =>
    request<{ photos: Array<{ id: string; mime: string; size: number; note: string | null; createdAt: string }> }>(
      `/price-book/drafts/${draftId}/photos`,
    ),
  pbDeletePhoto: (photoId: string) =>
    request<{ deleted: true }>(`/draft-photos/${photoId}`, { method: "DELETE" }),

  pbDraftOptions: (draftId: string) =>
    request<Array<{ option: PbOption; label: string | null; note: string | null }>>(
      `/price-book/drafts/${draftId}/options`,
    ),

  pbSaveDraftOption: (
    draftId: string,
    option: PbOption,
    input: { label?: string | null; note?: string | null },
  ) =>
    request<{ option: PbOption; label: string | null; note: string | null }>(
      `/price-book/drafts/${draftId}/options/${option}`,
      { method: "PUT", body: JSON.stringify(input) },
    ),

  pbCompute: (draftId: string) =>
    request<PbComputeResponse>(`/price-book/drafts/${draftId}/compute`),

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
      /** Which option the line goes in. Absent means A. */
      option?: PbOption;
    }
  ) => request(`/price-book/drafts/${draftId}/lines`, { method: "POST", body: JSON.stringify(input) }),

  // Edit / remove a line already on the draft (Kyle, 2026-08-17). Both refuse on a finalized
  // draft server-side — a line on an issued estimate is a record, not a working document.
  pbEditLine: (
    lineId: string,
    patch: { quantity?: number; quantitySource?: PbQuantitySource; difficulty?: PbDifficulty; location?: string | null; note?: string | null; option?: PbOption }
  ) => request(`/price-book/lines/${lineId}`, { method: "PATCH", body: JSON.stringify(patch) }),

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

  /**
   * Raise a question by hand.
   *
   * NO LONGER CALLED FROM THE WALKTHROUGH (P031). Kyle, 2026-08-18: "Get rid of the log as
   * question completely" — a screen that showed a correct match and then offered only to file it
   * as a question was making the wrong action the easy one. Walkthrough rows now add to the quote.
   *
   * Kept because the AI proposer still raises questions for scope it genuinely cannot place, and
   * `QuestionRow` still resolves those. That is a different mechanism with its own ruling (P011:
   * an item the model cannot place becomes a question, never a guessed atomic).
   */
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

  // ── Issued estimates (P027) ──
  // `pbIssue` returns 409 with the engine's verbatim refusal reasons when the draft is not
  // gap-free — the same contract as finalize, and the UI shows those reasons unedited.
  pbIssue: (
    draftId: string,
    // accountId + serviceAddressId are REQUIRED (P029). An estimate cannot be issued unattached,
    // and the address is not optional when an account has several — the operator picks.
    input: { accountId: string; serviceAddressId: string; title?: string | null; waiveTrip?: boolean }
  ) =>
    request<{ issued: true; estimateId: string; number: string; revision: number; unpriced?: string[] }>(
      `/price-book/drafts/${draftId}/issue`,
      { method: "POST", body: JSON.stringify(input) }
    ),

  pbIssuedList: (draftId?: string) =>
    request<{ estimates: PbIssuedEstimate[] }>(
      draftId ? `/issued-estimates?draftId=${encodeURIComponent(draftId)}` : "/issued-estimates"
    ),

  pbIssuedDetail: (id: string) =>
    request<{ estimate: PbIssuedEstimate; customerLink: string }>(`/issued-estimates/${id}`),

  /** OPERATOR ACTION ONLY. Behind the PIN session and a confirm; never called automatically. */
  pbIssuedSend: (id: string, input: { to?: string | null; message?: string | null }) =>
    request<{ sent: true; to: string }>(`/issued-estimates/${id}/send`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // ── In-person signing (P028; device lock removed 2026-08-18 on Kyle's instruction) ──
  pbCustomerView: (id: string) => requestHtml(`/issued-estimates/${id}/customer-view`),

  /**
   * Raise a change order against a SIGNED estimate (Kyle, 2026-08-19).
   *
   * Creates an EMPTY draft pointing at it — a change order describes the CHANGE, so pre-filling
   * it with the original lines would invite signing the whole job twice.
   */
  pbChangeOrder: (estimateId: string) =>
    request<{ draftId: string; changeOrderFor: string }>(
      `/issued-estimates/${estimateId}/change-order`,
      { method: "POST" },
    ),

  pbSignInPerson: (id: string, signerName: string, signatureImage: string, selectedOptions?: string[]) =>
    // jobVisitId: the job auto-created from the signed quote, so the signed screen can go
    // straight to the calendar to schedule it. Null when creation was refused or failed —
    // the signature itself is already durable either way.
    // selectedOptions: what was ticked on the presentation screen — required to be exactly
    // one on a one-or-the-other estimate (server-enforced).
    request<{ signed: true; estimateId: string; jobVisitId: string | null }>(
      `/issued-estimates/${id}/sign-in-person`,
      {
        method: "POST",
        body: JSON.stringify({ signerName, signatureImage, ...(selectedOptions ? { selectedOptions } : {}) }),
      },
    ),

  // ── Option mode + copy (Kyle, 2026-08-25) ──
  pbOptionsMode: (draftId: string) =>
    request<{ exclusiveOptions: boolean }>(`/price-book/drafts/${draftId}/options-mode`),
  pbSetOptionsMode: (draftId: string, exclusive: boolean) =>
    request<{ exclusiveOptions: boolean }>(`/price-book/drafts/${draftId}/options-mode`, {
      method: "PUT",
      body: JSON.stringify({ exclusive }),
    }),
  pbCopyOption: (draftId: string, from: "A" | "B" | "C", to: "A" | "B" | "C") =>
    request<{ copied: number; from: string; to: string }>(`/price-book/drafts/${draftId}/options/copy`, {
      method: "POST",
      body: JSON.stringify({ from, to }),
    }),

  // ── The account spine (P029) ──
  accountEstimates: (accountId: string, serviceAddressId?: string) =>
    request<{ estimates: PbIssuedEstimate[] }>(
      `/accounts/${accountId}/estimates${serviceAddressId ? `?serviceAddressId=${encodeURIComponent(serviceAddressId)}` : ""}`
    ),

  /**
   * Email the SIGNED invoice, PDF attached (2026-08-21).
   *
   * Kyle: "I cannot email the invoice to the client." Distinct from pbSendEstimate — that one
   * refuses a signed estimate, this one refuses an unsigned one.
   */
  sendInvoice: (estimateId: string, input: { toOverride?: string | null; message?: string | null } = {}) =>
    request<{ sent: true; to: string }>(`/issued-estimates/${estimateId}/send-invoice`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** True delete of an ISSUED estimate, unsigned only — the server refuses a signed one outright
      (2026-08-22). Named apart from `deleteEstimate` above, which belongs to the legacy system. */
  deleteIssuedEstimate: (estimateId: string) =>
    request<{ deleted: true }>(`/issued-estimates/${estimateId}`, { method: "DELETE" }),

  estimateChain: () => request<{ estimates: PbChainRow[] }>("/issued-estimates/chain"),

  pbCreateJob: (id: string) =>
    request<{ created: boolean; visitId: string }>(`/issued-estimates/${id}/create-job`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  pbAttachDraft: (draftId: string, input: { accountId: string; serviceAddressId: string }) =>
    request<{ ok: true }>(`/price-book/drafts/${draftId}/attach`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  testAccount: () => request<{ exists: boolean; account?: { id: string; name: string }; properties?: Array<{ id: string; name: string; addressLine1: string }>; counts?: { estimates: number; drafts: number } }>("/test-account"),
  testAccountCreate: () => request<{ account: { id: string }; property: { id: string } }>("/test-account", { method: "POST", body: JSON.stringify({}) }),
  testAccountDelete: () => request<{ deleted: boolean; counts: { estimates: number; drafts: number; visits: number; properties: number } }>("/test-account", { method: "DELETE" }),

  pbIssuedRevise: (id: string) =>
    request<{ revised: true; estimateId: string; number: string; revision: number }>(
      `/issued-estimates/${id}/revise`,
      { method: "POST", body: JSON.stringify({}) }
    ),

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
  reviewedBy?: string | null;
  syncedAt: string;
  technician?: { id: string; name: string; employeeNumber?: string | null } | null;
  // ── Account Health Records section (2026-08-24) ──
  acknowledgedAt?: string | null;
  customerSignerName?: string | null;
  ackSkippedReason?: string | null;
  property?: { id: string; addressLine1: string; city: string; state: string } | null;
  deliveries?: Array<{ id: string; sentTo: string; sentBy: string; sentAt: string }>;
}

export interface HealthInspectionDetail extends HealthInspectionSummary {
  itemsJson: string;
  loadCalcJson?: string | null;
  appVersion?: string | null;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  photos?: Array<{ id: string; mimeType: string; sizeBytes: number; uploadedAt: string }>;
}

/**
 * Open a session-protected PDF in a new tab.
 *
 * ── WHY A PLAIN LINK DOES NOT WORK ─────────────────────────────────────────────────────────────
 *
 * Every PDF on this app sits behind the operator session, and the session is a Bearer token in
 * localStorage — a browser will not attach it to an `<a href>`. I shipped the signed-agreement
 * links on the account page as plain anchors on 2026-08-20 and every one of them would have
 * answered 401. It looks like a working link right up until it is pressed.
 *
 * So the bytes are fetched properly and handed to the tab as a blob. The tab is opened
 * SYNCHRONOUSLY, before the await, because a `window.open` that happens after an async hop has
 * lost the user gesture and gets blocked as a popup.
 */
export async function openProtectedPdf(path: string): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const url = await fetchProtectedObjectUrl(path);
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (err) {
    tab?.close();
    // Surfaced rather than swallowed — a button that silently does nothing is the defect this
    // whole screen has been paying for.
    alert(`Could not open the document: ${(err as Error).message}`);
  }
}
