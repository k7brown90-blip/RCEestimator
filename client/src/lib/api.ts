import type {
  Account,
  AccountSummary,
  AssemblyTemplate,
  AvailabilityResponse,
  CalendarSchedule,
  CampaignArticle,
  CampaignBlock,
  CampaignOverview,
  CompanionSuggestion,
  CrmFollowUpsMetrics,
  CrmFunnelMetrics,
  CrmOverview,
  CrmFunnelReport,
  Customer,
  CustomerMatch,
  EmailBouncePollResult,
  EmailBounceRow,
  EmailDeliveryRow,
  EmailStatus,
  Estimate,
  EstimateAssembly,
  FindingEvent,
  InvoiceSummary,
  JobSummary,
  Lead,
  LeadPipeline,
  LeadWriteInput,
  ModifierDef,
  MonthSchedule,
  PbAtomic,
  PbChainRow,
  PbComputeResponse,
  PbDifficulty,
  PbDraft,
  PbFinalizeResult,
  PbIssuedEstimate,
  WarrantyClaim,
  WarrantyClaimRef,
  PbNecCategory,
  PbOption,
  PbQuantitySource,
  PbQuestion,
  PbReview,
  PbWalkthroughRow,
  Property,
  PropertyFinding,
  PropertyWriteInput,
  PurchaseOrderDetail,
  PurchaseOrderLine,
  PurchaseOrderSummary,
  ReceiptRecord,
  SearchResponse,
  ReviewReceiptRow,
  Balances,
  BankAccountView,
  BankClassifyInput,
  BankConfirmations,
  BankImportResult,
  BankLineView,
  BankStatementView,
  TreasurySettings,
  TreasurySweepRow,
  SweepView,
  CardSpendKind,
  CardSpendRow,
  CardSpendSyncResult,
  IssuingCardsResponse,
  OffCardMethod,
  TruckDetail,
  TruckRecord,
  TrucksResponse,
  InventoryItem,
  InventoryOverview,
  LandingDefaults,
  StockLevelView,
  StockMovementView,
  StockRequestView,
  ToolCondition,
  ToolDetail,
  ToolMovementView,
  ToolView,
  ConsumeLineInput,
  JobMaterialsView,
  MaterialSource,
  MaterialsByMonth,
  MaterialRow,
  MaterialWithCompletion,
  OnHand,
  ScheduleJobResult,
  TechDayAvailability,
  Visit,
  WeekSchedule,
} from "./types";

const API_BASE = "/api";

// ─── Job photo gallery (2026-08-28) ───────────────────────────────────────────

export type PhotoTag = "before" | "after" | "assessment" | "reference";

export interface VisitPhotoMeta {
  id: string;
  mimeType: string;
  sizeBytes: number;
  caption: string | null;
  tag: PhotoTag | null;
  uploadedAt: string;
  technician?: { id: string; name: string } | null;
}

export interface PropertyPhotos {
  jobPhotos: Array<VisitPhotoMeta & {
    visitId: string;
    visitDate: string;
    purpose: string | null;
    jobType: string | null;
  }>;
  assessmentPhotos: Array<{
    id: string;
    mimeType: string;
    sizeBytes: number;
    uploadedAt: string;
    inspectionId: string;
    inspectionDate: string;
    visitId: string | null;
  }>;
}

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
  /** PO-YYYY-NNNN (Kyle, 2026-09-09). */
  number: string;
  purpose: "truck_stock" | "warehouse" | "tool";
  status: "open" | "purchased" | "verified" | "closed" | "cancelled";
  supplier: string;
  sentAt: string | null;
  createdAt: string;
  receiptCount: number;
  /**
   * The money (Kyle, 2026-09-20). Same rule as jobCosting.ts's poMaterialByJob
   * — material/other card spend, non-ignored, plus the typed not-on-card
   * amount (null for a tool PO) — NOT PurchaseOrderSummary.cardTotal, which
   * sums every live charge regardless of kind.
   */
  cardTotal: number;
  offCardAmount: number | null;
  moneyTotal: number;
  /** Receipts carrying a photo or PDF — the proof. */
  proofCount: number;
  items: { name: string; qty: number; unit?: string; partNumber?: string }[];
}

export type PurchaseOrderLineInput = {
  itemId?: string | null;
  name: string;
  qty: number;
  unit?: string | null;
  partNumber?: string | null;
  unitCost?: number | null;
};

export interface FinancialsSummary {
  year: number;
  stripeConfigured: boolean;
  /** Stripe fees (Build 5): false + reason when the key cannot read balance transactions. */
  feesAvailable?: boolean;
  feesReason?: string | null;
  /** Hours counted in payroll with no rate on file — they cost $0 and the P&L says so (rule 6). */
  payrollUnratedHours?: number;
  /** stripeFees is Stripe's processing fee for the month — its own column, and inside expenses. Collected stays gross. */
  /**
   * Expenses = card charges + typed not-on-card P.O. amounts + bills + Stripe fees (Kyle, 2026-09-19)
   * + payroll (Kyle, 2026-09-20: wages + commissions from the hours ledger, in the month worked). Net is the number.
   * payroll is its own column AND inside expenses, like stripeFees.
   */
  /**
   * bank (2026-09-21): statement lines Kyle classified as expenses — ACH, autopay, checks out of
   * Chase. Its own column AND inside expenses, like stripeFees and payroll. A transfer or an
   * already-counted line is not here.
   */
  months: { month: number; invoiced: number; collected: number; stripeFees: number; payroll: number; bank: number; expenses: number; net: number }[];
  totals: { invoiced: number; collected: number; stripeFees: number; payroll: number; bank: number; expenses: number; net: number };
  expensesByCategory: { category: string; monthly: number[]; total: number }[];
  /** The bank queue: lines nobody has classified are NOT in Expenses yet, and the P&L says so. */
  bank?: { accounts: number; unclassified: number; unclassifiedOut: number; lastImportAt: string | null };
  /** The Materials card (Kyle, 2026-09-09, Build 4): bought / used / inventory value per month. */
  materials?: Omit<MaterialsByMonth, "year">;
}

export interface JobProfitRow {
  visitId: string;
  customer: string;
  customerId: string;
  propertyId: string;
  address: string;
  jobType: string | null;
  status: string;
  completedAt: string | null;
  quoted: number | null;
  materialSpend: number;
  /** "po" when the job's P.O.s carry money, else "none" (Kyle, 2026-09-19). */
  materialSource?: MaterialSource;
  laborHours: number;
  laborCost: number;
  marginBeforeLabor: number | null;
  margin: number | null;
}

/** One receipt on a job (Kyle, 2026-09-07 — Financials job drill-down). Bytes are fetched separately. */
export interface JobReceiptRow {
  id: string;
  vendor: string | null;
  category: string;
  amount: number;
  status: string;
  source: string;
  receivedAt: string;
  hasImage: boolean;
  imageMime: string | null;
  lineItems: { name?: string; qty?: number; unit?: string; unitCost?: number }[];
}

export interface ReceiptInsights {
  year: number;
  receiptsParsed: number;
  topItems: { name: string; receipts: number; totalQty: number; avgUnitCost: number | null; vendors: string[] }[];
  priceDrift: { receiptItem: string; bookItem: string; supplier: string; bookCost: number; receiptAvgCost: number; driftPct: number }[];
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
  /** The ROOT invoice (2026-09-20) — a change order's money answers about the invoice it joined. */
  estimateId: string;
  number: string;
  billedTotal: number;
  depositDue: number;
  /** False = no deposit on this invoice; nothing gates scheduling (Kyle, 2026-09-20). */
  depositRequired: boolean;
  /** The root first, then its signed change orders — listed beneath the total. */
  documents: { id: string; number: string; revision: number; title: string; kind: "invoice" | "change_order"; signedAt: string | null; billedTotal: number; depositRequired: boolean }[];
  depositPaid: number;
  totalPaid: number;
  balance: number;
  depositSatisfied: boolean;
  /** The HOMEOWNER is paid up; the warranty share may still be open (Kyle, 2026-09-10). */
  paidInFull: boolean;
  /** Both payers paid up. */
  fullyPaid?: boolean;
  payUrl: string;
  depositPayUrl: string;
  stripeConfigured: boolean;
  payments: {
    id: string; amount: number; method: string; kind: string; status: string; paidAt: string | null;
    /** "customer" | "warranty" (Kyle, 2026-09-10). */
    payer?: string;
    checkNumber?: string | null;
  }[];
  /** Home-warranty coverage (Kyle, 2026-09-09): already off billedTotal, which is the homeowner share. */
  warrantyCovered?: number;
  warrantyClaim?: WarrantyClaimRef | null;
  /** The warranty company's side of the account (Kyle, 2026-09-10): covered, paid, balance, and the claim with its dates. */
  warranty?: { covered: number; paid: number; balance: number; claim: WarrantyClaim } | null;
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
  /** "customer" | "warranty" (Kyle, 2026-09-10). */
  payer?: string;
  checkNumber?: string | null;
}

/** One row of GET /warranty-receivables (Kyle, 2026-09-10): the warranty company's open money. */
export interface WarrantyReceivableRow {
  estimateId: string;
  number: string;
  title: string;
  account: { id: string; name: string };
  signedAt: string | null;
  company: string;
  claimNumber: string;
  authNumber: string | null;
  covered: number;
  paid: number;
  balance: number;
  lastPaidAt: string | null;
  submittedAt: string | null;
  expectedAt: string | null;
  approvedAt: string | null;
  receivedAt: string | null;
  depositedAt: string | null;
  checkNumber: string | null;
  daysOutstanding: number;
  status: "not submitted" | "submitted" | "overdue" | "paid";
}

export interface WarrantyReceivables {
  rows: WarrantyReceivableRow[];
  totals: { count: number; open: number; overdue: number; covered: number; paid: number; balance: number };
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

/**
 * "Email: Invalid email" out of a Zod `flatten()` body, or null when the refusal is not a
 * field-level one. `formErrors` (whole-body complaints) ride along after the fields.
 */
function fieldMessage(body: Record<string, unknown> | undefined): string | null {
  const details = body?.details as { fieldErrors?: Record<string, string[]>; formErrors?: string[] } | undefined;
  if (!details) return null;
  const label = (field: string) => field.charAt(0).toUpperCase() + field.slice(1).replace(/([A-Z])/g, " $1").toLowerCase();
  const parts = Object.entries(details.fieldErrors ?? {})
    .filter(([, messages]) => messages?.length)
    .map(([field, messages]) => `${label(field)}: ${messages[0]}`);
  for (const formError of details.formErrors ?? []) parts.push(formError);
  return parts.length > 0 ? parts.join(" · ") : null;
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
// ─── Price Book editor payloads (the app is the book — 2026-08-30) ───────────
export interface PbCatalogAtomic {
  itemId: string;
  description: string | null;
  category: string | null;
  subCategory: string | null;
  unitLabel: string | null;
  sector: string | null;
  rowType: string | null;
  notes: string | null;
  companyCost: number | null;
  companyPrice: number | null;
  markupTier: string | null;
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
  sellNormal: number | null;
  sellDifficult: number | null;
  sellVeryDifficult: number | null;
  source: string | null;
  retiredAt: string | null;
  /** "E" | "C" | "M" | null — per-unit/hundred/thousand. Needed client-side only for the
   * assembly component picker's live labour preview (mirrors laborHoursFor's own divisor use). */
  laborUnitDivisor?: number | null;
}

export interface PbCatalogEdit {
  id: string;
  itemId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  editedBy: string;
  note: string | null;
  createdAt: string;
}

export type PbCatalogPatch = Partial<{
  description: string;
  category: string;
  subCategory: string | null;
  unitLabel: string | null;
  notes: string | null;
  sector: string | null;
  rowType: string;
  companyCost: number | null;
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
}>;

export interface PbCatalogCreate {
  itemId?: string | null;
  idPrefix?: string | null;
  description: string;
  category: string;
  subCategory?: string | null;
  unitLabel?: string | null;
  sector?: string | null;
  rowType: string;
  companyCost?: number | null;
  laborNormal?: number | null;
  laborDifficult?: number | null;
  laborVeryDifficult?: number | null;
  notes?: string | null;
}

// ─── Assemblies (2026-09-12, barcode/materials plan Unit 1) ─────────────────
// An assembly IS a PriceBookAtomic row (rowType "ASSEMBLY") plus a component list — see
// src/services/priceBookAssembly.ts. Cost and (non-overridden) labour are server-derived from
// components; these types describe that contract, not a separate model.

export type PbLaborTier = "laborNormal" | "laborDifficult" | "laborVeryDifficult";

export interface PbAssemblyComponentInput {
  childItemId: string;
  quantity: number;
}

export interface PbAssemblyCreate {
  itemId?: string | null;
  idPrefix?: string | null;
  description: string;
  category: string;
  subCategory?: string | null;
  unitLabel?: string | null;
  notes?: string | null;
  components: PbAssemblyComponentInput[];
  /** Explicit tier overrides. Absent tiers default to the server's auto-sum. */
  laborOverrides?: Partial<Record<PbLaborTier, number>>;
}

// ─── Edit an assembly after it is created (2026-09-16, barcode/materials plan Unit 4) ───────
// GET .../assemblies/:itemId (getAssemblyDetail, priceBookAssembly.ts:453) returns these shapes.
// `components[].child` is a NARROWER select than PbCatalogAtomic — only the fields the rollup
// and the drawer's read-only preview need.

export interface PbAssemblyComponentChild {
  itemId: string;
  description: string | null;
  unitLabel: string | null;
  companyCost: number | null;
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
  laborUnitDivisor: number | null;
  rowType: string | null;
}

export interface PbAssemblyComponentRow {
  id: string;
  parentItemId: string;
  childItemId: string;
  quantity: number;
  child: PbAssemblyComponentChild;
}

export interface PbTierRollup {
  /** Null when incomplete — never a summed zero. */
  value: number | null;
  complete: boolean;
  missingItemIds: string[];
}

export interface PbComponentRollup {
  companyCost: number | null;
  costComplete: boolean;
  unpricedComponentItemIds: string[];
  labor: Record<PbLaborTier, PbTierRollup>;
}

export interface PbEffectiveLaborTier {
  value: number | null;
  overridden: boolean;
  /** Only present when overridden AND the live component total differs from the stored value. */
  driftFromComputed: number | null;
}

export interface PbAssemblyDetail {
  atomic: PbCatalogAtomic;
  components: PbAssemblyComponentRow[];
  rollup: PbComponentRollup;
  labor: Record<PbLaborTier, PbEffectiveLaborTier>;
}

// ─── The material database (2026-09-12, barcode/materials plan Unit 2/6) ────
// See src/services/materials.ts. `MaterialPromoteInput` mirrors PromoteMaterialInput there —
// creating a brand-new price book item for a material with no counterpart in the book.

export interface MaterialPromoteInput {
  description: string;
  category: string;
  subCategory?: string | null;
  unitLabel?: string | null;
  sector?: string | null;
  rowType: string;
  laborNormal?: number | null;
  laborDifficult?: number | null;
  laborVeryDifficult?: number | null;
  notes?: string | null;
  itemId?: string | null;
  idPrefix?: string | null;
  companyCost?: number | null;
}

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
      //
      // A validation refusal names the boxes that failed (2026-09-22): "Validation failed" on its
      // own is unactionable, so the fields ride in the message — "Email: Invalid email".
      throw Object.assign(new ApiError(fieldMessage(body) ?? parsedError ?? text), {
        status: response.status,
        body,
      });
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

  // The Invoices tab (Kyle, 2026-08-26) — every signed estimate with its money rolled up.
  invoices: () => request<InvoiceSummary[]>("/invoices"),

  // ── Bounced emails (Kyle, 2026-09-09: "My emails are not getting to the clients") ──
  emailBounces: (unresolvedOnly = true) =>
    request<EmailBounceRow[]>(`/email-bounces${unresolvedOnly ? "?unresolved=1" : ""}`),
  resolveEmailBounce: (id: string, note: string | null) =>
    request<EmailBounceRow>(`/email-bounces/${id}/resolve`, { method: "POST", body: JSON.stringify({ note }) }),
  /** "Check now" — runs the mailbox poll on demand and returns the counts. */
  pollEmailBounces: () => request<EmailBouncePollResult>("/email-bounces/poll", { method: "POST" }),

  // ── Transactional email delivery (Kyle, 2026-09-09: Resend first, Gmail fallback) ──
  /** Which pipe customer email leaves through, whether the webhook is verified, the last 24 h by status. */
  emailStatus: () => request<EmailStatus>("/email-status"),
  /** Every customer email about an estimate, a visit, a lead, or an account, newest first. */
  emailDeliveries: (q: { estimateId?: string; visitId?: string; leadId?: string; customerId?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.estimateId) p.set("estimateId", q.estimateId);
    if (q.visitId) p.set("visitId", q.visitId);
    if (q.leadId) p.set("leadId", q.leadId);
    if (q.customerId) p.set("customerId", q.customerId);
    if (q.limit) p.set("limit", String(q.limit));
    const qs = p.toString();
    return request<EmailDeliveryRow[]>(`/email-deliveries${qs ? `?${qs}` : ""}`);
  },
  /**
   * The single free-form send (2026-09-20 communications build): "Follow ups can be done by
   * sending an email straight from the CRM." `to: null` uses the record's own primary email.
   */
  sendRecordEmail: (input: { target: "lead" | "account" | "job"; id: string; to?: string | null; subject: string; body: string }) =>
    request<{ sent: true; to: string; suppressed: boolean }>("/communications/email", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // ─── Accounts ─────────────────────────────────────────────────────────────
  // The server exposes these under both /accounts and /customers (same handlers,
  // Prisma model is still Customer). The client speaks "account" throughout.
  accounts: () => request<Account[]>("/accounts"),
  account: (accountId: string) => request<Account>(`/accounts/${accountId}`),
  accountSummary: (accountId: string) => request<AccountSummary>(`/accounts/${accountId}/summary`),

  /** Take a stale estimate visit off the scheduling rail (Kyle, 2026-09-02). */
  archiveVisit: (visitId: string) =>
    request<{ archived: true }>(`/crm/visits/${visitId}/archive`, { method: "POST" }),
  createAccount: (input: { name: string; email?: string; phone?: string }) =>
    request<Account>("/accounts", { method: "POST", body: JSON.stringify(input) }),
  updateAccount: (
    accountId: string,
    input: { name?: string; email?: string | null; phone?: string | null; isTestAccount?: boolean },
  ) =>
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
  /** Close out a consultation (estimate-stage visit): completed + archived in one act (Kyle, 2026-08-29). */
  completeConsultation: (visitId: string) =>
    request<{ completed: true; completedAt: string }>(`/visits/${visitId}/complete-consultation`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
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
  /** One lead, for editing a single row instead of pulling the whole collection. */
  lead: (leadId: string) => request<Lead>(`/leads/${leadId}`),
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
  /**
   * The four-phase funnel on its own (2026-09-20) — the same payload as `crmOverview().phases`.
   * The path still reads "win-loss" because that is the route that existed; what it returns is
   * no longer won-leads-over-lost-leads. `/crm/analytics/cycle-time` is gone with the legacy
   * Estimate model it read.
   */
  crmPhases: (range?: { startDate?: string; endDate?: string }) =>
    request<CrmFunnelReport>(withDateRange("/crm/analytics/win-loss", range)),
  // ─── Job Scheduling ──────────────────────────────────────────────────────
  scheduleJob: (jobId: string, input: { startDate: string; startTime?: string; endDate?: string; endTime?: string; technicianId?: string }) =>
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
  rescheduleJob: (jobId: string, input: { newStartDate: string; newStartTime?: string; endDate?: string; endTime?: string; reason: string; technicianId?: string }) =>
    request<ScheduleJobResult>(`/crm/jobs/${jobId}/reschedule`, { method: "POST", body: JSON.stringify(input) }),
  /** Ride along on an already-scheduled visit at the same account (Kyle, 2026-09-06). */
  coScheduleJob: (jobId: string, withJobId: string) =>
    request<{ scheduled: true; scheduledStart: string; scheduledEnd: string }>(`/crm/jobs/${jobId}/schedule-with`, { method: "POST", body: JSON.stringify({ withJobId }) }),
  cancelJob: (jobId: string, input: { reason: string }) =>
    request<{ jobId: string; cancelled: boolean }>(`/crm/jobs/${jobId}/cancel`, { method: "POST", body: JSON.stringify(input) }),
  // ─── Health Record (field inspection PWA) ─────────────────────────────────
  technicians: () => request<Technician[]>("/health-record-admin/technicians"),
  createTechnician: (input: { name: string; email?: string; phone?: string; employeeNumber?: string; role?: string }) =>
    request<Technician>("/health-record-admin/technicians", { method: "POST", body: JSON.stringify(input) }),
  updateTechnician: (
    technicianId: string,
    input: {
      name?: string; isActive?: boolean; rotateToken?: boolean; employeeNumber?: string | null;
      // Rates are typed by Kyle, never defaulted (2026-09-11). null = "rate not set".
      hourlyRate?: number | null; commissionPercent?: number | null;
    },
  ) =>
    request<Technician>(`/health-record-admin/technicians/${technicianId}`, { method: "PATCH", body: JSON.stringify(input) }),
  verifyTechCalendar: (technicianId: string) =>
    request<{ accessible: boolean; email: string | null }>(`/health-record-admin/technicians/${technicianId}/verify-calendar`, { method: "POST" }),
  assignTechnician: (visitId: string, input: { technicianId: string; role?: "primary" | "helper" }) =>
    request<VisitAssignment>(`/health-record-admin/visits/${visitId}/assign`, { method: "POST", body: JSON.stringify(input) }),
  visitAssignments: (visitId: string) => request<VisitAssignment[]>(`/health-record-admin/visits/${visitId}/assignments`),
  removeAssignment: (assignmentId: string) =>
    request<void>(`/health-record-admin/assignments/${assignmentId}`, { method: "DELETE" }),
  // ─── Job photo gallery (2026-08-28) ───────────────────────────────────────
  visitPhotos: (visitId: string) =>
    request<VisitPhotoMeta[]>(`/health-record-admin/visits/${visitId}/photos`),
  uploadVisitPhoto: (visitId: string, input: { dataUrl: string; caption?: string | null; tag?: PhotoTag | null }) =>
    request<VisitPhotoMeta>(`/health-record-admin/visits/${visitId}/photos`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateVisitPhoto: (photoId: string, input: { caption?: string | null; tag?: PhotoTag | null }) =>
    request<{ id: string; caption: string | null; tag: PhotoTag | null }>(
      `/health-record-admin/visit-photos/${photoId}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  deleteVisitPhoto: (photoId: string) =>
    request<{ deleted: true }>(`/health-record-admin/visit-photos/${photoId}`, { method: "DELETE" }),
  propertyPhotos: (propertyId: string) =>
    request<PropertyPhotos>(`/health-record-admin/properties/${propertyId}/photos`),
  customerInspections: (customerId: string) =>
    request<HealthInspectionSummary[]>(`/health-record-admin/customers/${customerId}/inspections`),
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
  /** P031 generator sizing document — available once the inspection carries a load calc. */
  generateGeneratorReport: (inspectionId: string) =>
    request<{ documentId: string; pdfPath: string }>(
      `/health-record-admin/inspections/${inspectionId}/generator-report`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  /** The stored A2 load calculation + generator design — feeds the CRM's generator designer. */
  /** Correct the A2 inputs from the office (2026-09-01). Creates a REVISION and re-sends per Kyle's overwrite ruling. */
  updateInspectionLoadCalc: (inspectionId: string, body: {
    serviceAmps: number;
    floorAreaSqFt: number;
    loads: unknown[];
  }) =>
    request<{ inspectionId: string; resend: { sent: boolean; to?: string; reason?: string; skipped?: string } }>(
      `/health-record-admin/inspections/${inspectionId}/load-calc`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  inspectionLoadCalc: (inspectionId: string) =>
    request<{
      input: import("../../../shared/loadcalc/loadcalc").LoadCalcInput;
      result: import("../../../shared/loadcalc/loadcalc").LoadCalcResult;
      generator: {
        recommendation: import("../../../shared/loadcalc/generator").GeneratorRecommendation;
        fuel: "NG" | "LP";
        softStart: boolean;
        altitudeSteps: number;
        includeInEstimate: boolean;
        shedSelection?: string[];
      } | null;
    }>(`/health-record-admin/inspections/${inspectionId}/load-calc`),
  /** Save a generator design; the server recomputes the recommendation from the stored calc. */
  saveGeneratorDesign: (
    inspectionId: string,
    input: { fuel: "NG" | "LP"; softStart: boolean; altitudeSteps: number; includeInEstimate: boolean; shedSelection?: string[] },
  ) =>
    request<{ ok: true }>(`/health-record-admin/inspections/${inspectionId}/generator`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  /** Email the report to the customer — logged as a delivery; refuses an unreviewed critical report. */
  emailHealthReport: (inspectionId: string, to?: string, includeGenerator?: boolean) =>
    request<{ sent: true; sentTo: string; documentId: string }>(
      `/health-record-admin/inspections/${inspectionId}/email`,
      { method: "POST", body: JSON.stringify({ ...(to ? { to } : {}), includeGenerator: includeGenerator ?? false }) },
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
  /**
   * Pause JOB (Kyle, 2026-09-21): a job underway goes back to scheduling, keeping its estimate,
   * payments, P.O.s, time and materials. Not the job clock's pause.
   */
  pauseJobForLater: (jobId: string, reason?: string | null) =>
    request<{ paused: true; sessionsClosed: number; calendarEventDeleted: boolean; laborHours: number }>(`/jobs/${jobId}/pause-for-later`, {
      method: "POST", body: JSON.stringify({ reason: reason ?? null }),
    }),
  jobPurchaseOrders: (jobId: string) =>
    request<PurchaseOrderRow[]>(`/jobs/${jobId}/purchase-orders`),
  // ─── Materials used — the costing switch (Kyle, 2026-09-09, Build 4) ─────────
  // A job is charged ONLY when stock is consumed off a truck, at the truck's
  // moving average. The view carries the suggested lines off the signed
  // estimate (on-hand beside each), what has been consumed, and the receipts
  // (those on a PO flagged "inventory, not job cost").
  jobMaterials: (jobId: string, truckId?: string | null) =>
    request<JobMaterialsView>(`/jobs/${jobId}/materials${truckId ? `?truckId=${encodeURIComponent(truckId)}` : ""}`),
  /** Truck → job. 409 names the item and on-hand when short unless allowNegative + reason (recorded). */
  consumeForJob: (jobId: string, input: { truckId?: string | null; lines: ConsumeLineInput[]; reason?: string | null; allowNegative?: boolean }) =>
    request<StockMovementView[]>(`/jobs/${jobId}/consume`, { method: "POST", body: JSON.stringify(input) }),
  /** Job → truck (or, with warehouse: true, the warehouse), credited at the cost the job was charged. */
  returnForJob: (jobId: string, input: { truckId?: string | null; warehouse?: boolean; lines: ConsumeLineInput[]; reason?: string | null }) =>
    request<StockMovementView[]>(`/jobs/${jobId}/return`, { method: "POST", body: JSON.stringify(input) }),
  /** On-hand for a set of items on one truck (the default truck when none is named). Read-only. */
  inventoryOnHand: (itemIds: string[], truckId?: string | null) => {
    const qs = new URLSearchParams({ itemIds: itemIds.join(",") });
    if (truckId) qs.set("truckId", truckId);
    return request<Record<string, OnHand>>(`/inventory/on-hand?${qs.toString()}`);
  },
  financialsMaterials: (year: number) => request<MaterialsByMonth>(`/financials/materials?year=${year}`),
  /** Receipts on one job, no image bytes (Kyle, 2026-09-07 — Financials drill-down). */
  jobReceipts: (jobId: string) => request<JobReceiptRow[]>(`/jobs/${jobId}/receipts`),
  /**
   * Review a receipt from the account page (Kyle, 2026-09-08): confirm a field
   * capture so it counts toward the job's material, fix its amount/vendor, or
   * move it to another job. The server re-rolls the job total.
   */
  reviewReceipt: (
    receiptId: string,
    input: {
      status?: "confirmed" | "pending_review";
      amount?: number;
      vendor?: string | null;
      jobId?: string | null;
      category?: string;
      purchaseOrderId?: string | null;
      // Correction path for a Vision year mis-parse (2026-09-14, legacy purchase
      // close-out Unit 4) — YYYY-MM-DD, the receipt's actual purchase date.
      receivedAt?: string;
      // The reader's "could not reconcile" flag (2026-09-18) — null clears it once checked by hand.
      reconciliationNote?: string | null;
    },
  ) =>
    request<{ id: string; jobId: string | null; amount: number; status: string; purchaseOrderId: string | null }>(`/health-record-admin/receipts/${receiptId}`, { method: "PATCH", body: JSON.stringify(input) }),
  /** Every receipt waiting for review across accounts, with account and job labels (Kyle, 2026-09-08). */
  pendingReceipts: () => request<ReviewReceiptRow[]>("/receipt-review"),
  /**
   * Operator-triggered re-parse for a receipt stuck in pending_review with no
   * vendor/amount (Unit 2, Kyle 2026-09-12 — async Vision needs a retry path).
   * Safe to call repeatedly: it only fills fields still empty.
   */
  reparseReceipt: (receiptId: string) =>
    request<{ success: boolean; parsed: boolean; data: { id: string; amount: number; vendor: string | null; status: string } }>(
      `/health-record-admin/receipts/${receiptId}/reparse`,
      { method: "POST", body: "{}" },
    ),
  /** Confirmed materials receipts with no PO (Kyle, 2026-09-09: purchasing starts with a PO). */
  receiptsNeedingPo: () => request<ReviewReceiptRow[]>("/receipts-needing-po"),
  /** One receipt, for the receipt drawer (2026-09-20). */
  receipt: (receiptId: string) => request<ReceiptRecord>(`/health-record-admin/receipts/${receiptId}`),
  /** Remove a receipt (duplicate upload); the server re-rolls the job total. */
  deleteReceipt: (receiptId: string) => request<void>(`/health-record-admin/receipts/${receiptId}`, { method: "DELETE" }),
  // ─── Purchase orders — the document (Kyle, 2026-09-09) ─────────────────────
  purchaseOrders: (params: { status?: string; truckId?: string; jobId?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.truckId) q.set("truckId", params.truckId);
    if (params.jobId) q.set("jobId", params.jobId);
    const qs = q.toString();
    return request<PurchaseOrderSummary[]>(`/purchase-orders${qs ? `?${qs}` : ""}`);
  },
  purchaseOrder: (id: string) => request<PurchaseOrderDetail>(`/purchase-orders/${id}`),
  purchaseOrderTrucks: () => request<{ id: string; name: string; technicianId: string | null }[]>("/purchase-orders/trucks"),
  startPurchaseOrder: (input: {
    supplier: string; purpose?: "truck_stock" | "warehouse" | "tool"; truckId?: string | null; jobId?: string | null;
    notes?: string | null; lines?: PurchaseOrderLineInput[];
  }) => request<PurchaseOrderSummary>("/purchase-orders", { method: "POST", body: JSON.stringify(input) }),
  /** Header edits — a reason is required and lands in the trail. */
  updatePurchaseOrder: (id: string, input: {
    reason: string; supplier?: string; purpose?: "truck_stock" | "warehouse" | "tool"; truckId?: string | null;
    jobId?: string | null; notes?: string | null;
  }) => request<PurchaseOrderSummary>(`/purchase-orders/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  addPurchaseOrderLine: (id: string, line: PurchaseOrderLineInput & { reason?: string }) =>
    request<PurchaseOrderLine>(`/purchase-orders/${id}/lines`, { method: "POST", body: JSON.stringify(line) }),
  editPurchaseOrderLine: (id: string, lineId: string, patch: Partial<PurchaseOrderLineInput> & { qtyLanded?: number | null; reason: string }) =>
    request<PurchaseOrderLine>(`/purchase-orders/${id}/lines/${lineId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removePurchaseOrderLine: (id: string, lineId: string, reason: string) =>
    request<void>(`/purchase-orders/${id}/lines/${lineId}`, { method: "DELETE", body: JSON.stringify({ reason }) }),
  transitionPurchaseOrder: (id: string, to: "purchased" | "verified" | "closed" | "cancelled", reason?: string) =>
    request<{ id: string; number: string; status: string }>(`/purchase-orders/${id}/status`, { method: "POST", body: JSON.stringify({ to, reason }) }),
  /** THE MONEY typed by hand (Kyle, 2026-09-19): the not-on-card amount. Reason required; null = on the card after all. */
  setPurchaseOrderMoney: (id: string, input: { reason: string; offCardAmount?: number | null; offCardMethod?: OffCardMethod | null; offCardNote?: string | null; offCardAt?: string | null }) =>
    request<PurchaseOrderSummary>(`/purchase-orders/${id}/money`, { method: "PATCH", body: JSON.stringify(input) }),
  attachReceiptToPurchaseOrder: (poId: string, receiptId: string) =>
    request<{ receiptId: string; purchaseOrderId: string; jobId: string | null }>(`/purchase-orders/${poId}/receipts/${receiptId}`, { method: "POST", body: "{}" }),
  detachReceiptFromPurchaseOrder: (poId: string, receiptId: string) =>
    request<void>(`/purchase-orders/${poId}/receipts/${receiptId}`, { method: "DELETE" }),
  /**
   * "No PO — legacy" (2026-09-14, legacy purchase close-out Unit 2): a receipt
   * whose PO can never exist leaves "Receipts needing a PO" by being waived,
   * never attached — attaching would silently erase real job cost. Reason is
   * required and lands in SystemEvent.
   */
  waiveReceiptPo: (receiptId: string, reason: string) =>
    request<{ id: string; purchaseOrderId: string | null; poWaivedAt: string; poWaivedReason: string }>(`/receipts/${receiptId}/waive-po`, { method: "POST", body: JSON.stringify({ reason }) }),

  // ── Trucks, cards, card spend (Kyle, 2026-09-09) ──────────────────────────
  trucks: () => request<TrucksResponse>("/trucks"),
  truck: (id: string, year: number) => request<TruckDetail>(`/trucks/${id}?year=${year}`),
  /** Delete a truck that has no history; a truck with history is retired instead (Kyle, 2026-09-10). */
  deleteTruck: (id: string) => request<void>(`/trucks/${id}`, { method: "DELETE" }),
  createTruck: (input: { name: string; technicianId?: string | null }) =>
    request<TruckRecord>("/trucks", { method: "POST", body: JSON.stringify(input) }),
  updateTruck: (id: string, input: {
    name?: string; technicianId?: string | null; stripeCardId?: string | null; cardLast4?: string | null;
    stripeFinancialAccountId?: string | null; notes?: string | null; isActive?: boolean;
  }) => request<TruckRecord>(`/trucks/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  truckStripeCards: () => request<IssuingCardsResponse>("/trucks/stripe-cards"),
  cardSpend: (params: { status?: string; kind?: string; truckId?: string; year?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.kind) qs.set("kind", params.kind);
    if (params.truckId) qs.set("truckId", params.truckId);
    if (params.year) qs.set("year", String(params.year));
    const q = qs.toString();
    return request<CardSpendRow[]>(`/card-spend${q ? `?${q}` : ""}`);
  },
  /** Reason required — every edit leaves a trail. */
  updateCardSpend: (id: string, input: {
    reason: string; kind?: CardSpendKind; truckId?: string | null; purchaseOrderId?: string | null; status?: "ignored" | "unmatched";
  }) => request<CardSpendRow>(`/card-spend/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  syncCardSpend: (days: number) => request<CardSpendSyncResult>("/card-spend/sync", { method: "POST", body: JSON.stringify({ days }) }),
  financialsBalances: () => request<Balances>("/financials/balances"),
  // ── Treasury: floats + the month-end sweep (Kyle, 2026-09-09, Build 5). The POST is the click; nothing schedules it. ──
  treasurySettings: () => request<TreasurySettings>("/settings/treasury"),
  saveTreasurySettings: (input: TreasurySettings) =>
    request<TreasurySettings>("/settings/treasury", { method: "PUT", body: JSON.stringify(input) }),
  financialsSweep: (fresh = false) => request<SweepView>(`/financials/sweep${fresh ? "?fresh=1" : ""}`),
  runSweep: (input: { amount: number; confirm: string }) =>
    request<{ sweep: TreasurySweepRow; excessAtClick: number | null }>("/financials/sweep", { method: "POST", body: JSON.stringify(input) }),
  // ── Bank statements (Kyle, 2026-09-20): the registry, uploads, the queue, confirmations ──
  bankAccounts: () => request<BankAccountView[]>("/bank/accounts"),
  createBankAccount: (input: { name: string; institution?: string; last4?: string | null; kind: BankAccountView["kind"]; purpose: BankAccountView["purpose"] }) =>
    request<BankAccountView>("/bank/accounts", { method: "POST", body: JSON.stringify(input) }),
  updateBankAccount: (id: string, input: Partial<{ name: string; institution: string; last4: string | null; kind: BankAccountView["kind"]; purpose: BankAccountView["purpose"]; isActive: boolean }>) =>
    request<BankAccountView>(`/bank/accounts/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  /** Refused (409) while the account still has statements — deleting those is the explicit undo. */
  deleteBankAccount: (id: string) => request<void>(`/bank/accounts/${id}`, { method: "DELETE" }),
  bankStatements: (accountId?: string) => request<BankStatementView[]>(`/bank/statements${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`),
  /** The file as the raw body — the server sniffs CSV vs OFX from the bytes. Same bytes twice = duplicate, nothing imported. */
  importBankStatement: async (accountId: string, file: File): Promise<BankImportResult> => {
    const token = localStorage.getItem("rce_token");
    const response = await fetch(`/api/bank/accounts/${accountId}/statements?fileName=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: file,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error((body as { error?: string } | null)?.error ?? `Import failed (${response.status})`);
    }
    return (await response.json()) as BankImportResult;
  },
  /** Undoes the import: the statement, its lines, and every confirmation those lines made. */
  deleteBankStatement: (id: string) => request<void>(`/bank/statements/${id}`, { method: "DELETE" }),
  bankLines: (params: { classification?: BankLineView["classification"]; year?: number; accountId?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.classification) q.set("classification", params.classification);
    if (params.year) q.set("year", String(params.year));
    if (params.accountId) q.set("accountId", params.accountId);
    const qs = q.toString();
    return request<BankLineView[]>(`/bank/lines${qs ? `?${qs}` : ""}`);
  },
  classifyBankLine: (id: string, input: BankClassifyInput) =>
    request<BankLineView>(`/bank/lines/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteBankLine: (id: string, reason?: string) =>
    request<void>(`/bank/lines/${id}${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`, { method: "DELETE" }),
  /** Run the rules again over every line no human has touched. */
  autoClassifyBankLines: () => request<{ classified: number; unclassified: number }>("/bank/lines/auto", { method: "POST", body: "{}" }),
  bankConfirmations: (year: number) => request<BankConfirmations>(`/bank/confirmations?year=${year}`),
  // ── Inventory ledger, landing, tools, restock (Kyle, 2026-09-09, Build 3) ──
  inventory: () => request<InventoryOverview>("/inventory"),
  inventoryMovements: (params: { itemId?: string; locationKey?: string; purchaseOrderId?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.itemId) qs.set("itemId", params.itemId);
    if (params.locationKey) qs.set("locationKey", params.locationKey);
    if (params.purchaseOrderId) qs.set("purchaseOrderId", params.purchaseOrderId);
    if (params.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return request<StockMovementView[]>(`/inventory/movements${q ? `?${q}` : ""}`);
  },
  inventoryItems: (q: string) => request<InventoryItem[]>(`/inventory/items?q=${encodeURIComponent(q)}`),

  // ── The material database (2026-09-12, barcode/materials plan Unit 2/6) ────
  // Completion (assigned vs. unassigned) is derived server-side — never recompute it here.
  materials: () => request<MaterialWithCompletion[]>("/materials"),
  unassignedMaterials: () => request<MaterialWithCompletion[]>("/materials/unassigned"),
  /** Give the material a `lastCost` directly (e.g. clearing a "no cost" gap by hand). */
  updateMaterialCost: (id: string, lastCost: number) =>
    request<MaterialRow>(`/materials/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ lastCost }) }),
  /** LINK — join an existing price book item that already carries labour. */
  linkMaterial: (id: string, itemId: string) =>
    request<MaterialRow>(`/materials/${encodeURIComponent(id)}/link`, { method: "POST", body: JSON.stringify({ itemId }) }),
  /** PROMOTE — create a brand-new price book item for a material with no counterpart in the book. */
  promoteMaterial: (id: string, input: MaterialPromoteInput) =>
    request<{ material: MaterialRow; atomic: PbCatalogAtomic }>(`/materials/${encodeURIComponent(id)}/promote`, {
      method: "POST", body: JSON.stringify(input),
    }),

  /** Warehouse → truck. The from side is always the warehouse (Kyle's rule). */
  transferStock: (input: { itemId: string; qty: number; toTruckId: string; reason?: string | null }) =>
    request<StockMovementView>("/inventory/transfer", { method: "POST", body: JSON.stringify(input) }),
  /**
   * Material going back to the supplier — office side, any location (2026-09-22, supplier
   * returns Unit 3). Priced at that location's own moving average; reason required, PO optional.
   */
  supplierReturn: (input: { itemId: string; qty: number; fromLocationKey: string; purchaseOrderId?: string | null; reason: string }) =>
    request<StockMovementView>("/inventory/supplier-return", { method: "POST", body: JSON.stringify(input) }),
  countStock: (input: { locationKey: string; reason: string; lines: { itemId: string; name?: string | null; unit?: string | null; qty: number; unitCost?: number | null }[] }) =>
    request<StockMovementView[]>("/inventory/count", { method: "POST", body: JSON.stringify(input) }),
  correctMovement: (input: { correctsId: string; delta: number; unitCost?: number | null; reason: string }) =>
    request<StockMovementView>("/inventory/correction", { method: "POST", body: JSON.stringify(input) }),
  setParLevel: (levelId: string, parLevel: number | null) =>
    request<StockLevelView>(`/inventory/levels/${levelId}`, { method: "PATCH", body: JSON.stringify({ parLevel }) }),
  landingDefaults: (poId: string) => request<LandingDefaults>(`/purchase-orders/${poId}/landing`),
  /**
   * The receipt photo straight onto a PO (Kyle, 2026-09-11: "This should not
   * pull up existing job costs but be an upload as the receipts will be photos
   * added from the phone or computer"). No amount → the server reads the photo.
   */
  uploadPoReceipt: async (poId: string, input: { image: File; amount?: number | null; vendor?: string | null }) => {
    const receiptId = crypto.randomUUID().replaceAll("-", "");
    const query = new URLSearchParams();
    if (input.amount != null) query.set("amount", String(input.amount));
    if (input.vendor) query.set("vendor", input.vendor);
    const token = localStorage.getItem("rce_token");
    const response = await fetch(`/api/purchase-orders/${poId}/receipts/${receiptId}?${query.toString()}`, {
      method: "PUT",
      headers: {
        "Content-Type": input.image.type || "image/jpeg",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: input.image,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error((body as { error?: string } | null)?.error ?? `Receipt upload failed (${response.status})`);
    }
    return (await response.json()) as { id: string; amount: number; vendor: string | null; parsed: boolean; lineCount: number; note: string | null };
  },
  landPurchaseOrder: (poId: string, input: { lines: { lineId: string; qtyLanded: number; unitCost: number }[]; reason?: string | null }) =>
    request<{ id: string; number: string; status: string; landedAt: string; destination: string }>(`/purchase-orders/${poId}/land`, { method: "POST", body: JSON.stringify(input) }),
  tools: (locationKey?: string) => request<ToolView[]>(`/tools${locationKey ? `?locationKey=${encodeURIComponent(locationKey)}` : ""}`),
  tool: (id: string) => request<ToolDetail>(`/tools/${id}`),
  createTool: (input: { name: string; serial?: string | null; cost?: number | null; locationKey: string; notes?: string | null }) =>
    request<ToolView>("/tools", { method: "POST", body: JSON.stringify(input) }),
  updateTool: (id: string, input: { reason: string; name?: string; serial?: string | null; cost?: number | null; condition?: ToolCondition; notes?: string | null }) =>
    request<ToolView>(`/tools/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  moveTool: (id: string, input: { toLocationKey: string; reason?: string | null }) =>
    request<{ tool: ToolView; movement: ToolMovementView }>(`/tools/${id}/move`, { method: "POST", body: JSON.stringify(input) }),
  stockRequests: (status?: string) => request<StockRequestView[]>(`/inventory/requests${status ? `?status=${status}` : ""}`),
  fulfillStockRequest: (id: string, itemId?: string | null) =>
    request<{ request: StockRequestView; movement: StockMovementView }>(`/inventory/requests/${id}/fulfill`, { method: "POST", body: JSON.stringify({ itemId: itemId ?? null }) }),
  declineStockRequest: (id: string, reason: string) =>
    request<StockRequestView>(`/inventory/requests/${id}/decline`, { method: "POST", body: JSON.stringify({ reason }) }),
  // ─── The Needs-next-step queue (Phase 4) ───────────────────────────────────
  needsNextStep: () => request<NextStepJob[]>("/jobs/needs-next-step"),
  dispositionJob: (jobId: string, action: "archive" | "book-followup") =>
    request<{ done: true; followupVisitId: string | null }>(`/jobs/${jobId}/next-step`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),

  // ─── Payments & deposits (2026-08-25) ──────────────────────────────────────
  jobPaymentInfo: (jobId: string) => request<PaymentInfo | null>(`/jobs/${jobId}/payment-info`),

  // ─── Email campaigns (Kyle, 2026-09-02) ───────────────────────────────────
  campaignOverview: () => request<CampaignOverview>(`/email-campaigns/overview`),
  addLeadToCampaign: (leadId: string) =>
    request<{ added: true; listName: string }>(`/leads/${leadId}/add-to-campaign`, { method: "POST" }),
  /** The standing rule's exit for the button above: same drawer, removes what it added. */
  removeLeadFromCampaign: (leadId: string) =>
    request<{ removed: number }>(`/leads/${leadId}/campaign`, { method: "DELETE" }),
  campaignLeadMembership: () => request<{ leadIds: string[] }>(`/email-campaigns/lead-membership`),
  campaignArticles: () => request<{ articles: CampaignArticle[] }>(`/email-campaigns/articles`),
  createCampaign: (input: { name: string; subject: string; blocks: CampaignBlock[]; listId?: string }) =>
    request<{ id: string }>(`/email-campaigns`, { method: "POST", body: JSON.stringify(input) }),
  updateCampaign: (id: string, input: { name?: string; subject?: string; blocks?: CampaignBlock[]; listId?: string }) =>
    request<{ ok: true }>(`/email-campaigns/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  campaignPreview: (id: string) => request<{ html: string; subject: string }>(`/email-campaigns/${id}/preview`),
  campaignTestSend: (id: string) => request<{ sent: true; to: string }>(`/email-campaigns/${id}/test`, { method: "POST" }),
  campaignSend: (id: string) => request<{ started: true }>(`/email-campaigns/${id}/send`, { method: "POST" }),
  createEmailList: (input: { name: string; includeAllAccounts: boolean }) =>
    request<{ id: string }>(`/email-lists`, { method: "POST", body: JSON.stringify(input) }),
  addListMember: (listId: string, input: { email: string; name?: string }) =>
    request<{ added: true }>(`/email-lists/${listId}/members`, { method: "POST", body: JSON.stringify(input) }),
  removeListMember: (listId: string, memberId: string) =>
    request<{ removed: true }>(`/email-lists/${listId}/members/${memberId}`, { method: "DELETE" }),

  /** Bill in writing (Kyle, 2026-09-01): the deposit request / final bill lands in the customer's inbox. */
  emailDepositRequest: (estimateId: string) =>
    request<{ ok: true; to: string; amount: number }>(`/issued-estimates/${estimateId}/email-deposit-request`, { method: "POST" }),
  /** Manual unpaid-invoice nudge (Kyle, 2026-09-02) — reminder-voiced final bill; stamps the pacing clock. */
  sendPaymentReminder: (estimateId: string) =>
    request<{ ok: true; to: string; amount: number }>(`/issued-estimates/${estimateId}/payment-reminder`, { method: "POST" }),
  emailBalanceRequest: (estimateId: string) =>
    request<{ ok: true; to: string; amount: number }>(`/issued-estimates/${estimateId}/email-balance-request`, { method: "POST" }),
  estimatePaymentInfo: (estimateId: string) =>
    request<PaymentInfo | null>(`/issued-estimates/${estimateId}/payment-info`),

  // ─── Financials (2026-08-25) ───────────────────────────────────────────────
  financialsSummary: (year: number) => request<FinancialsSummary>(`/financials/summary?year=${year}`),
  receiptInsights: (year: number) => request<ReceiptInsights>(`/financials/receipt-insights?year=${year}`),
  jobProfitability: (year: number) => request<JobProfitRow[]>(`/financials/job-profitability?year=${year}`),
  companyBills: () => request<CompanyBillRow[]>("/financials/bills"),
  createCompanyBill: (input: Omit<CompanyBillRow, "id" | "createdAt">) =>
    request<CompanyBillRow>("/financials/bills", { method: "POST", body: JSON.stringify(input) }),
  deleteCompanyBill: (id: string) => request<void>(`/financials/bills/${id}`, { method: "DELETE" }),
  paymentsList: (year: number) => request<PaymentRow[]>(`/financials/payments?year=${year}`),
  recordPayment: (input: {
    amount: number;
    method: "cash" | "check" | "zelle" | "ach" | "other";
    kind?: "deposit" | "final" | "other";
    /** "warranty" records the warranty company's check against the claim (Kyle, 2026-09-10); default "customer". */
    payer?: "customer" | "warranty";
    checkNumber?: string | null;
    paidAt?: string;
    customerId?: string;
    estimateId?: string;
    note?: string;
  }) =>
    request<PaymentRow>("/financials/payments", { method: "POST", body: JSON.stringify(input) }),
  /** Every warranty receivable — signed estimates with a claim, with money and status (Kyle, 2026-09-10). */
  warrantyReceivables: () => request<WarrantyReceivables>("/warranty-receivables"),
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

  /** New estimate from a sent one (Kyle, 2026-08-31): duplicate the draft behind it, exactly. */
  pbDuplicateDraft: (draftId: string) =>
    request<{ id: string; title: string }>(`/price-book/drafts/${draftId}/duplicate`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  /**
   * Kyle's names for the three options (2026-08-20).
   *
   * "It would be nice to be able to rename the options at the review screen in order to specify
   *  the scope of work to the job being quoted."
   *
   * These are what the customer reads on the tick boxes of the issued estimate — "Exterior pathway
   * lights" instead of "Option B" — so they are frozen onto it at graduation.
   */
  /** The discount on a draft — "military" | "senior" | "custom" (with its percent) | null (2026-08-22; custom 2026-09-01). */
  pbSetDiscount: (draftId: string, type: "military" | "senior" | "custom" | null, percent?: number | null) =>
    request<{ discountType: string | null; discountPercent: number | null }>(`/price-book/drafts/${draftId}/discount`, {
      method: "PUT",
      body: JSON.stringify({ type, percent: percent ?? null }),
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
    input: {
      accountId: string;
      serviceAddressId: string;
      title?: string | null;
      waiveTrip?: boolean;
      /** P031: attach the generator sizing one-pager from this address's field assessment. */
      includeGenerator?: boolean;
      /** The deposit checkbox (Kyle, 2026-09-20). Absent = on for an estimate, off for a change order. */
      depositRequired?: boolean;
      /** Change orders only: attach to the parent's current job when signed. */
      addToCurrentJob?: boolean;
    }
  ) =>
    request<{ issued: true; estimateId: string; number: string; revision: number; unpriced?: string[] }>(
      `/price-book/drafts/${draftId}/issue`,
      { method: "POST", body: JSON.stringify(input) }
    ),

  /** The terms Kyle can change after issue (2026-09-20): the deposit flag, and — until it has a job — "add to current job". */
  pbSetTerms: (estimateId: string, input: { depositRequired?: boolean; addToCurrentJob?: boolean }) =>
    request<{ ok: true; depositRequired: boolean; addToCurrentJob: boolean }>(`/issued-estimates/${estimateId}/terms`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  // ─── Price Book editor (2026-08-30 — the app is the book) ─────────────────
  pbCatalogCategories: () =>
    request<{
      categories: Array<{
        name: string;
        count: number;
        sortOrder: number;
        subCategories: Array<{ name: string | null; count: number }>;
      }>;
    }>("/price-book/catalog/categories"),
  pbCatalogCategoryOrder: (names: string[]) =>
    request<{ ok: true }>("/price-book/catalog/categories/order", {
      method: "PUT",
      body: JSON.stringify({ names }),
    }),
  pbCatalogRenameCategory: (from: string, to: string) =>
    request<{ ok: true; renamed: number }>("/price-book/catalog/categories/rename", {
      method: "POST",
      body: JSON.stringify({ from, to }),
    }),
  pbCatalogItems: (params?: { category?: string; search?: string }) => {
    const qs = new URLSearchParams();
    if (params?.category) qs.set("category", params.category);
    if (params?.search) qs.set("search", params.search);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ atomics: PbCatalogAtomic[] }>(`/price-book/catalog/items${suffix}`);
  },
  pbCatalogItem: (itemId: string) =>
    request<{ atomic: PbCatalogAtomic; edits: PbCatalogEdit[] }>(
      `/price-book/catalog/items/${encodeURIComponent(itemId)}`,
    ),
  pbCatalogUpdateItem: (itemId: string, patch: PbCatalogPatch) =>
    request<{ atomic: PbCatalogAtomic }>(`/price-book/catalog/items/${encodeURIComponent(itemId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  pbCatalogCreateItem: (input: PbCatalogCreate) =>
    request<{ atomic: PbCatalogAtomic }>("/price-book/catalog/items", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  pbCatalogRetireItem: (itemId: string) =>
    request<{ atomic: PbCatalogAtomic }>(`/price-book/catalog/items/${encodeURIComponent(itemId)}/retire`, {
      method: "POST", body: JSON.stringify({}),
    }),
  pbCatalogRestoreItem: (itemId: string) =>
    request<{ atomic: PbCatalogAtomic }>(`/price-book/catalog/items/${encodeURIComponent(itemId)}/restore`, {
      method: "POST", body: JSON.stringify({}),
    }),
  pbCatalogRetired: () =>
    request<{ atomics: Array<{ itemId: string; description: string | null; category: string | null; retiredAt: string }> }>(
      "/price-book/catalog/retired",
    ),

  /** Create an assembly — a PriceBookAtomic (rowType "ASSEMBLY") plus its component list. Cost
   * and non-overridden labour come back server-computed; nothing here is client-authoritative. */
  pbCatalogCreateAssembly: (input: PbAssemblyCreate) =>
    request<{ atomic: PbCatalogAtomic }>("/price-book/catalog/assemblies", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** Full detail for the edit drawer — components (with each child's estimating facts), the
   * live rollup, and each tier's effective (overridden-or-auto) labour value. */
  pbCatalogAssemblyDetail: (itemId: string) =>
    request<PbAssemblyDetail>(`/price-book/catalog/assemblies/${encodeURIComponent(itemId)}`),

  /** Full REPLACE, not a delta (priceBookAssembly.ts:377-384) — the server deletes every existing
   * component and recreates the list from this payload. Always send the COMPLETE list. */
  pbCatalogSetAssemblyComponents: (itemId: string, components: PbAssemblyComponentInput[]) =>
    request<{ atomic: PbCatalogAtomic; rollup: PbComponentRollup }>(
      `/price-book/catalog/assemblies/${encodeURIComponent(itemId)}/components`,
      { method: "PUT", body: JSON.stringify({ components }) },
    ),

  /** Set (a number) or clear (null — reverts to the live component auto-sum) one tier's
   * override. Never inferred from equalling the sum — this is an explicit flag server-side. */
  pbCatalogSetLaborOverride: (itemId: string, tier: PbLaborTier, value: number | null) =>
    request<{ atomic: PbCatalogAtomic }>(
      `/price-book/catalog/assemblies/${encodeURIComponent(itemId)}/labor-override`,
      { method: "PUT", body: JSON.stringify({ tier, value }) },
    ),

  pbIssuedList: (draftId?: string) =>
    request<{ estimates: PbIssuedEstimate[] }>(
      draftId ? `/issued-estimates?draftId=${encodeURIComponent(draftId)}` : "/issued-estimates"
    ),

  pbIssuedDetail: (id: string) =>
    request<{ estimate: PbIssuedEstimate; customerLink: string }>(`/issued-estimates/${id}`),

  /** OPERATOR ACTION ONLY. Behind the PIN session and a confirm; never called automatically. */
  pbIssuedSend: (id: string, input: { to?: string | null; message?: string | null; photoIds?: string[]; attachHealthReport?: boolean; attachGeneratorReport?: boolean }) =>
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
    // jobJoined (2026-09-20): a change order attached to the parent's current job — nothing new to schedule.
    request<{ signed: true; estimateId: string; jobVisitId: string | null; jobJoined?: boolean }>(
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
  sendInvoice: (estimateId: string, input: { toOverride?: string | null; message?: string | null; photoIds?: string[] } = {}) =>
    request<{ sent: true; to: string }>(`/issued-estimates/${estimateId}/send-invoice`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** True delete of an ISSUED estimate, unsigned only — the server refuses a signed one outright
      (2026-08-22). Named apart from `deleteEstimate` above, which belongs to the legacy system. */
  deleteIssuedEstimate: (estimateId: string) =>
    request<{ deleted: true }>(`/issued-estimates/${estimateId}`, { method: "DELETE" }),

  /**
   * Void a SIGNED estimate (2026-09-17 — "There is no way to cancel... a signed estimate which
   * we need to be able to do"). Cancels the estimate's job too; deposit refunds and open P.O.s
   * are left for Kyle to handle by hand, which the response reports back.
   */
  voidIssuedEstimate: (estimateId: string, reason: string) =>
    request<{
      voided: true;
      jobId: string | null;
      jobAction: "none" | "already_cancelled" | "left_open_other_estimates" | "cancelled_unscheduled" | "cancelled";
      customerNotified: boolean;
      kyleNotified: boolean;
      payments: { id: string; amount: number; method: string; kind: string; paidAt: string | null }[];
      paymentsTotal: number;
      openPurchaseOrders: { number: string; status: string }[];
    }>(`/issued-estimates/${estimateId}/void`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  /**
   * Mark a sent/viewed/expired estimate LOST (Kyle, 2026-09-20) — the customer hired someone
   * else or is not moving forward. Not void: this is what the win rate reads. Reason from
   * LEAD_LOST_REASONS, the same list leads use.
   */
  markEstimateLost: (estimateId: string, input: { reason: string; notes?: string | null }) =>
    request<{ lost: true; reason: string; notes: string | null }>(`/issued-estimates/${estimateId}/lost`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** The way back: a lost estimate returns to sent / viewed / expired, whichever it really is. */
  reopenEstimate: (estimateId: string) =>
    request<{ reopened: true; status: "sent" | "viewed" | "expired" }>(`/issued-estimates/${estimateId}/reopen`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  estimateChain: () => request<{ estimates: PbChainRow[] }>("/issued-estimates/chain"),

  /**
   * One issued estimate in the account-row projection, for the estimate drawer (2026-09-20).
   * Not `pbIssuedDetail`: that route returns the customer's capability link, which must never
   * enter a drawer payload (PUNCHLIST B4).
   */
  estimateRecord: (estimateId: string) =>
    request<{ estimate: PbIssuedEstimate }>(`/issued-estimates/${estimateId}/record`),

  /**
   * Global search (2026-09-20): one call, six record kinds, ranked numbers-first and capped per
   * kind. A result carries the drawer to open (or `href` for an account). Never a capability
   * token (PUNCHLIST B4) — the server selects explicit fields.
   */
  search: (q: string, per?: number) =>
    request<SearchResponse>(`/search?q=${encodeURIComponent(q)}${per ? `&per=${per}` : ""}`),

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

  /**
   * Home-warranty coverage on an UNSIGNED issued estimate (Kyle, 2026-09-09). `null` clears.
   * The server answers 409 once the estimate is signed — revise it to change coverage then.
   */
  pbSetWarranty: (
    id: string,
    input: { company: string; claimNumber: string; authNumber?: string | null; coveredAmount: number; note?: string | null } | null,
  ) =>
    request<{
      ok: true;
      warranty: WarrantyClaim | null;
      warrantyCovered: number;
      preCoverageTotal: number;
      homeownerTotal: number;
      depositDue: number;
    }>(`/issued-estimates/${id}/warranty`, {
      method: "PATCH",
      // A bare `null` body is refused by the server's strict JSON parser; `{ clear: true }` clears.
      body: JSON.stringify(input ?? { clear: true }),
    }),

  /**
   * Claim tracking on a covered estimate (Kyle, 2026-09-10): submitted / expected / approved /
   * received / deposited / check #, note — bookkeeping, allowed after signing, every change with
   * a reason on the trail. expectedAt defaults to submitted + 45 days when omitted.
   */
  pbWarrantyTracking: (
    id: string,
    input: {
      submittedAt?: string | null; expectedAt?: string | null; approvedAt?: string | null;
      receivedAt?: string | null; depositedAt?: string | null; checkNumber?: string | null;
      note?: string | null; reason: string;
    },
  ) =>
    request<{ ok: true; warranty: WarrantyClaim; changed: boolean }>(`/issued-estimates/${id}/warranty/tracking`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  // ── Time and payroll (Kyle, 2026-09-11): two clocks, kept separate ─────────
  // Payroll hours are edited on the Team tab, job hours on the Jobs tab, and
  // every edit takes a reason that lands on the trail.

  payrollWeek: (technicianId: string, start: string) =>
    request<PayrollWeek>(`/time/technicians/${technicianId}/week?start=${encodeURIComponent(start)}`),

  createShiftEntry: (input: { technicianId: string; startedAt: string; endedAt?: string | null; note?: string | null }) =>
    request<{ id: string }>("/time/shifts", { method: "POST", body: JSON.stringify(input) }),
  updateShiftEntry: (id: string, input: { startedAt?: string; endedAt?: string | null; note?: string | null; reason: string }) =>
    request<{ id: string }>(`/time/shifts/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteShiftEntry: (id: string, reason: string) =>
    request<void>(`/time/shifts/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) }),

  jobTime: (visitId: string) => request<JobTimeView>(`/time/jobs/${visitId}`),
  createJobSession: (visitId: string, input: { technicianId: string; startedAt: string; endedAt?: string | null; note?: string | null }) =>
    request<{ id: string }>(`/time/jobs/${visitId}/sessions`, { method: "POST", body: JSON.stringify(input) }),
  updateJobSession: (id: string, input: { startedAt?: string; endedAt?: string | null; note?: string | null; reason: string }) =>
    request<{ id: string }>(`/time/sessions/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteJobSession: (id: string, reason: string) =>
    request<void>(`/time/sessions/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) }),

  /** Rule 5: close a flagged clock at the time it really ended. */
  confirmTimeEntry: (input: { kind: "shift" | "job"; id: string; endedAt: string; reason: string }) =>
    request<{ id: string }>("/time/confirm", { method: "POST", body: JSON.stringify(input) }),

  commissionQuote: (visitId: string, technicianId: string) =>
    request<CommissionQuote>(`/time/commissions/quote?visitId=${encodeURIComponent(visitId)}&technicianId=${encodeURIComponent(technicianId)}`),
  createCommission: (input: {
    technicianId: string; visitId?: string | null; basis: "job_profit" | "manual";
    percent?: number | null; amount?: number | null; note?: string | null; reason?: string | null;
  }) => request<{ id: string }>("/time/commissions", { method: "POST", body: JSON.stringify(input) }),
  deleteCommission: (id: string, reason: string) =>
    request<void>(`/time/commissions/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) }),

};

// ─── Time and payroll types (Kyle, 2026-09-11) ───────────────────────────────

export interface PayrollEntry {
  kind: "shift" | "job";
  id: string;
  startedAt: string;
  endedAt: string | null;
  minutes: number | null;
  /**
   * What this entry pays at: the rate frozen when it closed, or the tech's
   * CURRENT rate for entries that closed before a rate existed. Null only when
   * no rate has ever been set.
   */
  rateApplied: number | null;
  /** True when the rate came off the entry, false when it is the current rate. */
  rateFrozen?: boolean;
  regularMinutes: number;
  overtimeMinutes: number;
  pay: number | null;
  source?: string;
  note: string | null;
  visitId?: string;
  visitLabel?: string | null;
  endedReason?: string | null;
  flagged: boolean;
  confirmed: boolean;
  open: boolean;
}

export interface FlaggedClock {
  kind: "shift" | "job";
  id: string;
  technicianId: string | null;
  visitId: string | null;
  startedAt: string;
  hoursOpen: number;
  /** Whose job it was (Kyle, 2026-09-11: "it says job started but doesn't say which job"). */
  jobLabel: string | null;
}

export interface CommissionRow {
  id: string;
  technicianId: string;
  technicianName?: string;
  visitId: string | null;
  visitLabel: string | null;
  basis: string;
  percent: number | null;
  amount: number;
  note: string | null;
  reason: string | null;
  earnedAt: string;
  paidAt: string | null;
}

export interface PayrollWeek {
  technicianId: string;
  technicianName: string;
  weekStart: string;
  weekEnd: string;
  shiftMinutes: number;
  jobMinutes: number;
  /** Job time paid with no shift clocked — the payroll floor. Add to shiftMinutes for paid hours. */
  impliedMinutes: number;
  /** Paid − job: drive, shop, supply house. Company overhead, never job cost. */
  unbilledMinutes: number;
  regularMinutes: number;
  overtimeMinutes: number;
  rate: number | null;
  rateSet: boolean;
  regularPay: number;
  /** The extra 0.5× riding the hours that crossed 40, in the order worked. */
  overtimePremium: number;
  commissions: number;
  total: number;
  openEntries: number;
  flagged: FlaggedClock[];
  shifts: PayrollEntry[];
  sessions: PayrollEntry[];
  commissionRows: CommissionRow[];
}

export interface JobTimeView {
  visitId: string;
  technicians: Array<{
    technicianId: string;
    name: string;
    minutes: number;
    hours: number;
    rate: number | null;
    rateSet: boolean;
    cost: number | null;
    assigned: boolean;
  }>;
  sessions: PayrollEntry[];
  totalMinutes: number;
  totalHours: number;
  laborCost: number | null;
  anyRateMissing: boolean;
}

export interface CommissionQuote {
  visitId: string;
  technicianId: string;
  revenue: number | null;
  materialCost: number;
  materialSource: string;
  fees: number;
  feeRows: Array<{ kind: "receipt" | "card"; id: string; label: string; category: string; amount: number }>;
  profit: number | null;
  percent: number | null;
  percentSet: boolean;
  amount: number | null;
}

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
  /** Typed by Kyle, never defaulted. Null shows as "rate not set", never as $0. */
  hourlyRate?: number | null;
  /** Percentage of JOB PROFIT (revenue − material − fees), hand-entered. */
  commissionPercent?: number | null;
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
  financingUrl: string;
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
  schemaVersion: "v1" | "v2" | "v3";
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
  /** True when the A2 load calc is on the record — unlocks the generator sizing report. */
  hasLoadCalc?: boolean;
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
