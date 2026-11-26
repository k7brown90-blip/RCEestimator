/**
 * The tools on /mcp (W2-B). One list, `AGENT_TOOLS`, run by the one registry (registry.ts). Every tool here either IS a hub door core
 * (hubDoor.ts: list_threads, read_thread, post_message call the very functions REST /api/hub/* calls, so the scrub, the idempotency table, the
 * draft slot, the agent-loop limit and the Team publish rule are shared and cannot drift) or reads through the ONE answer layer (respond.ts
 * agentRespond, with a named de-identified profile from profiles.ts).
 *
 * Write tools: post_message, and (Kyle 2026-11-24) create_price_book_item and propose_price_book_change, which add a NEW price-book item and
 * propose a change to an existing one (a card a person approves). There is NO delete, retire or archive tool, and no tool that edits an existing
 * item directly. Research (reports:read) and CFO (finance:read) have READ tools and nothing else; "financial changes stay proposals" means the CFO
 * proposes by posting in a thread.
 */
import { z } from "zod";
import {
  AGENT_MESSAGE_SCOPE_LABELS, AGENT_ROLE_LABELS, AGENT_SCOPES, hubKindsFor, hubRouteScopes, isAgentRole, type AgentScope,
} from "../../shared/agentScopes";
import { toChicagoIso } from "../../shared/calendarDay";
import { AGENT_DAILY_DRAFT_LIMIT, countDraftsToday } from "./audit";
import { createMessageCore, listThreadsCore, postMessageInputSchema, threadDetailCore } from "./hubDoor";
import {
  PRICEBOOK_READ_SCOPES, PRICEBOOK_WRITE_SCOPES, createItemCore, createItemInputSchema, getItemCore, listCategoriesCore, proposeChangeCore,
  proposeChangeInputSchema, searchInputSchema, searchItemsCore, MAX_HOURS_PER_UNIT,
} from "./priceBookDoor";
import { scrub, agentRespond, type AgentToolOutput } from "./respond";
import type { AgentRequest } from "./gate";
import {
  reportInvoiceListSchema, reportInvoiceSchema, reportJobListSchema, reportJobSchema, reportLeadSourcesSchema, reportPaymentListSchema, reportVisitListSchema,
} from "./profiles";
import { defineTool, type AgentTool, type ToolContext, type ToolOutcome } from "./registry";
import { getInvoice, getJob, leadSourceCounts, listInvoices, listJobs, listPayments, listVisits } from "../services/agentReports";

// ── whoami ───────────────────────────────────────────────────────────────────────────────────────

const whoami = defineTool({
  name: "whoami",
  description: "Who this key is and what it may do right now: its name and agent, its scopes (with the names Settings shows), whether writes are on, "
    + "the Agent access mode, the environment, requests left this minute, customer drafts left today, which thread kinds it can read and post in, and the time in Chicago. "
    + "Any key may call it, whatever its scopes. It never shows the key.",
  input: z.object({}),
  scopes: "any",
  write: false,
  async handler(ctx: ToolContext): Promise<ToolOutcome> {
    const { principal, req } = ctx;
    const call = (req as AgentRequest).agentCall;
    // The gate's per-key limiter (express-rate-limit) leaves its count on the request; the key limiter runs last, so this is the key's.
    const limit = (req as { rateLimit?: { limit?: number; remaining?: number } }).rateLimit;
    const made = await countDraftsToday(principal.keyId);
    const draftLimit = call?.dailyDraftLimit ?? AGENT_DAILY_DRAFT_LIMIT;
    const labelFor = (scope: string): string =>
      (AGENT_MESSAGE_SCOPE_LABELS as Record<string, string>)[scope] ?? (AGENT_SCOPES as Record<string, string>)[scope] ?? scope;
    const data = scrub({
      key_name: principal.name,
      agent: principal.role,
      agent_label: isAgentRole(principal.role) ? AGENT_ROLE_LABELS[principal.role] : principal.role,
      scopes: principal.scopes.map((scope) => ({ scope, label: labelFor(scope) })),
      writes_enabled: principal.writesEnabled,
      team_posts_publish: principal.teamPostsPublish,
      agent_access: principal.mode,
      environment: process.env.NODE_ENV === "production" ? "production" : "test",
      key_environment: principal.env,
      requests_left_this_minute: typeof limit?.remaining === "number" ? limit.remaining : null,
      requests_per_minute: typeof limit?.limit === "number" ? limit.limit : null,
      customer_drafts_left_today: Math.max(0, draftLimit - made),
      thread_kinds: {
        read: hubKindsFor(principal.scopes, "read", principal.hubThreadKinds),
        post: hubKindsFor(principal.scopes, "post", principal.hubThreadKinds),
      },
      time_chicago: toChicagoIso(new Date()),
    });
    return { data };
  },
});

// ── the hub tools (the SAME cores as REST /api/hub/*) ────────────────────────────────────────────

const listThreads = defineTool({
  name: "list_threads",
  description: "List the Messages threads this key may read (the same answer as GET /api/hub/threads): filter by kind (customer, job, team, group, training, dev), "
    + "status (open, closed, all) and since (ISO time with an offset). There is no search.",
  input: z.object({
    kind: z.string().max(20).optional(),
    status: z.string().max(10).optional(),
    since: z.string().max(40).optional(),
  }),
  scopes: hubRouteScopes("read"),
  write: false,
  async handler(ctx, args, raw): Promise<ToolOutcome> {
    // `q` is not a tool argument, but it is passed to the core when a caller sends it, so the core refuses it in REST's own words.
    const out = await listThreadsCore(ctx.door, ctx.reader(), { ...args, q: typeof raw.q === "string" ? raw.q : undefined });
    return { data: out.body, status: out.status, recordIds: out.recordIds };
  },
});

const readThread = defineTool({
  name: "read_thread",
  description: "Read one thread and its messages (the same answer as GET /api/hub/threads/:id/messages). A thread of a kind this key's scopes do not open is refused with the scope to tick.",
  input: z.object({ thread_id: z.string().trim().min(1).max(64) }),
  scopes: hubRouteScopes("read"),
  write: false,
  async handler(ctx, args): Promise<ToolOutcome> {
    const out = await threadDetailCore(ctx.door, ctx.reader(), args.thread_id);
    return { data: out.body, status: out.status, recordIds: out.recordIds };
  },
});

const postMessage = defineTool({
  name: "post_message",
  description: "Post in a thread (the same as POST /api/hub/messages). In a Team, group or crew chat it publishes at once when this key's Team posts publish immediately box is on; "
    + "an email or text to a customer is SENT when you post it (nobody approves it first; it is still refused for a customer who replied STOP, an address that unsubscribed, or while texting or Agent access is off - the answer's status says sent or blocked and not_sent_reason says why), and a post in a Training thread is published. Say where it goes with thread_id (or one of customerId, leadId, jobId, estimateId for a customer message). "
    + "idempotency_key is required (8 to 128 characters): a retry with the same key and request returns the first result and posts nothing twice.",
  input: postMessageInputSchema,
  scopes: hubRouteScopes("post"),
  write: true,
  async handler(ctx, _args, raw): Promise<ToolOutcome> {
    // The REST door reads the RAW body (it refuses a recipient or cc before parsing), so the tool hands the core the same raw arguments.
    const out = await createMessageCore(ctx.door, ctx.reader(), raw);
    return {
      data: out.body, status: out.status, recordIds: out.recordIds, resultCode: out.replayed ? "replayed" : "ok",
      auditWritten: out.auditWritten === true, idempotencyKey: out.idempotencyKey,
    };
  },
});

// ── the price book (Kyle 2026-11-24: pricebook:read / pricebook:write; the SAME cores as REST /api/agent/price-book/*) ─────────

const PRICE_NOTE = "material_cost is the PRE-TAX shelf price per unit: never add sales tax yourself, the book adds it (sell = hours x the shop rate + cost x (1 + sales tax) x markup). hours are PER UNIT for the three "
  + `difficulties (normal, difficult, very_difficult), typed from your own NECA labor-unit library (convert a per-100 or per-1000 value to one unit; at most ${MAX_HOURS_PER_UNIT} per unit). `
  + "A difficulty NECA gives no time for is left out and stays blank. ";

const listPriceBookCategories = defineTool({
  name: "list_price_book_categories",
  description: "List the price book's categories with their item counts and sub-categories (brands), in the order the CRM shows them. Costs everywhere in the price book are PRE-TAX.",
  input: z.object({}),
  scopes: PRICEBOOK_READ_SCOPES,
  write: false,
  async handler(ctx): Promise<ToolOutcome> {
    const out = await listCategoriesCore(ctx.door);
    return { data: out.body, status: out.status, recordIds: out.recordIds };
  },
});

const searchPriceBook = defineTool({
  name: "search_price_book",
  description: "Search the live price book (retired items are not shown): search matches an item id or its name, category narrows to one category, limit is up to 200 (default 50). "
    + "Each item has its type (labor, material or assembly), cost (PRE-TAX), cost_with_tax (that cost with the sales tax in it), hours per unit for the three difficulties, sell prices (the tax is already inside them), and where its hours came from.",
  input: searchInputSchema,
  scopes: PRICEBOOK_READ_SCOPES,
  write: false,
  async handler(ctx, args): Promise<ToolOutcome> {
    const out = await searchItemsCore(ctx.door, args);
    return { data: out.body, status: out.status, recordIds: out.recordIds };
  },
});

const getPriceBookItem = defineTool({
  name: "get_price_book_item",
  description: "One price book item by its id (A016, ASM001...), with its cost (PRE-TAX), cost_with_tax, hours per unit, sell prices (tax inside) and, for an assembly, its parts.",
  input: z.object({ item_id: z.string().trim().min(1).max(64) }),
  scopes: PRICEBOOK_READ_SCOPES,
  write: false,
  async handler(ctx, args): Promise<ToolOutcome> {
    const out = await getItemCore(ctx.door, args.item_id);
    return { data: out.body, status: out.status, recordIds: out.recordIds };
  },
});

const createPriceBookItem = defineTool({
  name: "create_price_book_item",
  description: "Add a NEW item to the price book (it can never change or delete an existing one). unit is REQUIRED: what ONE unit of the item is, 1 to 24 characters, e.g. \"each\", \"ft\", \"box of 25\"; "
    + "material_cost and hours are PER THAT UNIT. Send \"ft\" (or lf, foot, feet, per foot, per ft, linear feet) for wire, cable and conduit sold by the foot: the estimate multiplies material_cost and hours by the quantity in that unit, and a per-foot unit groups the item with the continuous-length material the job-level material cap works on (wire, cable and conduit are also recognised by name). "
    + "A proposal cannot change an item's unit. type labor: hours only. type material: material_cost, plus hours if it takes labor to install. "
    + "type assembly: components [{item_id, quantity}] of live, priced items; its cost and hours roll up from them. " + PRICE_NOTE
    + "neca_reference (edition, page, table, row) is kept as the item's labour source. A name that is nearly the same as an item already in that category is refused with that item (409 duplicate_item). "
    + "idempotency_key is required (8 to 128 characters): a retry with the same key and request returns the first result and adds nothing twice.",
  input: createItemInputSchema,
  scopes: PRICEBOOK_WRITE_SCOPES,
  write: true,
  async handler(ctx, _args, raw): Promise<ToolOutcome> {
    const out = await createItemCore(ctx.door, raw);
    return {
      data: out.body, status: out.status, recordIds: out.recordIds, resultCode: out.replayed ? "replayed" : "ok",
      auditWritten: out.auditWritten === true, idempotencyKey: out.idempotencyKey,
    };
  },
});

const proposePriceBookChange = defineTool({
  name: "propose_price_book_change",
  description: "Propose a change to the name, cost or hours of an EXISTING price book item. Nothing changes until a person with the price book power approves it in the CRM (Messages, Waiting for approval); "
    + "the approval card shows the before and after and every assembly the change moves. Send only what changes. " + PRICE_NOTE
    + "idempotency_key is required (8 to 128 characters).",
  input: proposeChangeInputSchema,
  scopes: PRICEBOOK_WRITE_SCOPES,
  write: true,
  async handler(ctx, _args, raw): Promise<ToolOutcome> {
    const out = await proposeChangeCore(ctx.door, null, raw);
    return {
      data: out.body, status: out.status, recordIds: out.recordIds, resultCode: out.replayed ? "replayed" : "ok",
      auditWritten: out.auditWritten === true, idempotencyKey: out.idempotencyKey,
    };
  },
});

// ── the Research and CFO read tools (R-f: reports:read and finance:read) ─────────────────────────

/** Every profile answers with the SAME de-identified shape; the scope only decides who may call. Order = the audit's scopeUsed priority. */
const outputFor = (name: string, schema: z.ZodType, scopes: readonly AgentScope[]): AgentToolOutput => ({
  name, profiles: scopes.map((scope) => ({ scope, schema, withholdContact: true })),
});

const BOTH: readonly AgentScope[] = ["reports:read", "finance:read"];
const RESEARCH: readonly AgentScope[] = ["reports:read"];
const CFO: readonly AgentScope[] = ["finance:read"];

const day = z.string().trim().max(10).optional();
const range = { from: day, to: day };
const limit = z.number().int().min(1).max(200).optional();
const id = z.string().trim().min(1).max(64);
const RANGE_NOTE = "from and to are calendar days like 2026-11-23 (Chicago time, both included).";
const PRIVACY = "De-identified: ids, status fields, dates, amounts, job and invoice numbers and a customer's first name only. Test-account records are left out.";

/** Answer through the one answer layer with this profile, and record the scope that allowed it. */
async function answer(ctx: ToolContext, output: AgentToolOutput, raw: unknown, recordIds: readonly string[]): Promise<ToolOutcome> {
  const { scopeUsed, data } = await agentRespond(ctx.principal, output, raw);
  ctx.scopeUsed = scopeUsed;
  return { data, recordIds };
}
const idsOf = (rows: ReadonlyArray<{ id: string }>): string[] => rows.map((r) => r.id);

const JOBS_OUT = outputFor("reports.jobs.list", reportJobListSchema, BOTH);
const JOB_OUT = outputFor("reports.jobs.get", reportJobSchema, BOTH);
const INVOICES_OUT = outputFor("reports.invoices.list", reportInvoiceListSchema, BOTH);
const INVOICE_OUT = outputFor("reports.invoices.get", reportInvoiceSchema, BOTH);
const VISITS_OUT = outputFor("reports.visits.list", reportVisitListSchema, RESEARCH);
const LEADS_OUT = outputFor("reports.lead_sources", reportLeadSourcesSchema, RESEARCH);
const PAYMENTS_OUT = outputFor("finance.payments.list", reportPaymentListSchema, CFO);

const listJobsTool = defineTool({
  name: "list_jobs",
  description: `List jobs, newest first. Filter by status (estimate, contracted, scheduled, in_progress, completed, cancelled), from and to (the job's date), limit (up to 200). ${RANGE_NOTE} ${PRIVACY}`,
  input: z.object({ status: z.string().trim().max(40).optional(), ...range, limit }),
  scopes: BOTH, write: false,
  async handler(ctx, args) {
    const out = await listJobs(args);
    return answer(ctx, JOBS_OUT, out, idsOf(out.items));
  },
});
const getJobTool = defineTool({
  name: "get_job",
  description: `One job by its id. ${PRIVACY}`,
  input: z.object({ job_id: id }),
  scopes: BOTH, write: false,
  async handler(ctx, args) {
    const out = await getJob(args.job_id);
    return answer(ctx, JOB_OUT, out, [out.id]);
  },
});
const listInvoicesTool = defineTool({
  name: "list_invoices",
  description: `List invoices (signed estimates with their change orders), newest first. Filter by status (paid, deposit_paid, partial, unpaid), from and to (the signed date), limit (up to 200). ${RANGE_NOTE} ${PRIVACY}`,
  input: z.object({ status: z.enum(["paid", "deposit_paid", "partial", "unpaid"]).optional(), ...range, limit }),
  scopes: BOTH, write: false,
  async handler(ctx, args) {
    const out = await listInvoices(args);
    return answer(ctx, INVOICES_OUT, out, idsOf(out.items));
  },
});
const getInvoiceTool = defineTool({
  name: "get_invoice",
  description: `One invoice by its id (a change order's id answers about the invoice it joined), with its balance and payment status. ${PRIVACY}`,
  input: z.object({ invoice_id: id }),
  scopes: BOTH, write: false,
  async handler(ctx, args) {
    const out = await getInvoice(args.invoice_id);
    return answer(ctx, INVOICE_OUT, out, [out.id]);
  },
});
const listVisitsTool = defineTool({
  name: "list_visits",
  description: `List calendar visits whose scheduled start is in the range, soonest first: id (the job's id), date and time, status, job type, the customer's first name and the technicians' first names. ${RANGE_NOTE} ${PRIVACY}`,
  input: z.object({ ...range, limit }),
  scopes: RESEARCH, write: false,
  async handler(ctx, args) {
    const out = await listVisits(args);
    return answer(ctx, VISITS_OUT, out, idsOf(out.items));
  },
});
const leadSourceCountsTool = defineTool({
  name: "lead_source_counts",
  description: `Counts of leads received in the range, by how they arrived (source) and by who sent them (platform). Counts only: no lead's name, contact or note. ${RANGE_NOTE}`,
  input: z.object({ ...range }),
  scopes: RESEARCH, write: false,
  async handler(ctx, args) {
    return answer(ctx, LEADS_OUT, await leadSourceCounts(args), []);
  },
});
const listPaymentsTool = defineTool({
  name: "list_payments",
  description: `List payments received in the range, newest first: id, invoice id, job id, amount, method, kind, status, payer, received date. No card, bank or check details. ${RANGE_NOTE} Test-account records are left out.`,
  input: z.object({ ...range, limit }),
  scopes: CFO, write: false,
  async handler(ctx, args) {
    const out = await listPayments(args);
    return answer(ctx, PAYMENTS_OUT, out, idsOf(out.items));
  },
});

/** The one list. tools/list shows the ones a key's scopes open; tools/call checks again. */
export const AGENT_TOOLS: readonly AgentTool[] = [
  whoami, listThreads, readThread, postMessage,
  listPriceBookCategories, searchPriceBook, getPriceBookItem, createPriceBookItem, proposePriceBookChange,
  listJobsTool, getJobTool, listInvoicesTool, getInvoiceTool, listVisitsTool, leadSourceCountsTool, listPaymentsTool,
];
