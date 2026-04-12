import type { AssemblyTemplate, CompanionSuggestion, Customer, Estimate, EstimateAssembly, JobSummary, Property, Visit, AtomicUnit, ModifierDef, EstimateItem, SupportItem, NECAlert } from "./types";

const API_BASE = "/api";

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
  necCheck: (estimateId: string) =>
    request<{ alerts: NECAlert[] }>(`/estimates/${estimateId}/nec-check`, { method: "POST", body: JSON.stringify({}) }),
  generateSupportItems: (estimateId: string) =>
    request<{ supportItems: SupportItem[] }>(`/estimates/${estimateId}/support-items/generate`, { method: "POST", body: JSON.stringify({}) }),
  supportItems: (estimateId: string) =>
    request<SupportItem[]>(`/estimates/${estimateId}/support-items`),
  patchSupportItem: (estimateId: string, itemId: string, input: { laborHrs?: number; laborRate?: number; otherCost?: number; isOverridden?: boolean; overrideNote?: string }) =>
    request<SupportItem>(`/estimates/${estimateId}/support-items/${itemId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteSupportItem: (estimateId: string, itemId: string) =>
    request<void>(`/estimates/${estimateId}/support-items/${itemId}`, { method: "DELETE" }),
};
