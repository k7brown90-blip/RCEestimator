/**
 * The ONE tool registry for the agents' MCP door (work order agent-team K-U5, W2-B). A tool is {name, description, input (zod), scopes
 * (any-of), write, handler}; the tools themselves are listed in src/agentApi/tools.ts, and nothing else answers a /mcp tools/call.
 *
 * What `runAgentTool` does for EVERY call, so no tool can skip it:
 *   1. an unknown name is refused (`unknown_tool`) - and audited;
 *   2. the tool's scopes are checked, any-of, against the key as the gate loaded it on THIS request, with the same sentence the REST gate uses
 *      (naming each scope and the label Settings -> Agent keys shows);
 *   3. a WRITE tool is refused while the kill switch is read_only and for a key whose Allow writes box is off - the route-level flags cannot see
 *      the tool, so the tool wrapper checks them exactly as the REST gate does for POST /hub/messages;
 *   4. the arguments are parsed with the tool's zod schema (a ZodError names the failing FIELDS, never the values);
 *   5. the handler runs, and ONE AgentAuditLog row is written for the call (door "mcp", action = the tool name, endpoint "POST /mcp <tool>",
 *      the scope that actually allowed it, the key's name, the result code, the status and the duration; never a body). A write's row is inserted
 *      by the handler's own transaction (`auditWritten`), so it commits or rolls back with the write; every other row is written here, BEFORE
 *      the answer goes out, and if that insert fails the caller gets `internal` and no data;
 *   6. every failure is a tool error `{code, reason, retryable}` (toAgentError): never a stack, never an exception message, never a key.
 *
 * Time and rate: one HTTP request is one pass through the gate (its per-key limiter counted it); the gate also read the key row, the kill
 * switch and the scopes fresh, so a revoke, a scope edit or the kill switch applies to the very next request (stateless, team answer 12).
 */
import type { Request, Response } from "express";
import type { z } from "zod";
import { AgentApiError, agentErrorBody, toAgentError, type AgentErrorBody } from "./errors";
import { recordAgentCall, type AgentCallRecord } from "./audit";
import { scopeDeniedReason, type AgentPrincipal, type AgentRequest, type FinishAgentCall, reserveAgentDraftSlot } from "./gate";
import { agentErrorFrom, type DoorCall } from "./hubDoor";
import { readerFor, type HubReader } from "../services/hub";
import type { AgentScope } from "../../shared/agentScopes";

/** Everything a tool handler may use of the call it is part of. */
export interface ToolContext {
  principal: AgentPrincipal;
  req: Request;
  res: Response;
  /** The tool's name, as audited. */
  tool: string;
  /** The scope that allowed the call, for the audit row. The registry sets the first held; a handler may narrow it (the hub tools, the field profiles). */
  scopeUsed: string | null;
  /** The hub cores' view of this call (src/agentApi/hubDoor.ts DoorCall): the same code runs for REST and for /mcp. */
  door: DoorCall;
  /** The hub reader for this key (readerFor: ONE resolver). */
  reader(): HubReader;
}

export interface ToolOutcome {
  data: unknown;
  /** The HTTP-equivalent status the audit records (201 for a created post). Default 200. */
  status?: number;
  recordIds?: readonly string[];
  /** "ok" by default; "replayed" for an idempotent replay. */
  resultCode?: string;
  /** True when the handler already inserted this call's audit row inside its own transaction. */
  auditWritten?: boolean;
  idempotencyKey?: string;
}

export interface AgentTool<I extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  /** The tool's input as zod; the JSON schema tools/list shows is made from it. */
  input: I;
  /** Any ONE of these scopes opens the tool; "any" for a tool every key may call (whoami). */
  scopes: readonly AgentScope[] | "any";
  /** A write (or a draft): the key's writes switch and the kill switch are checked before the handler runs. */
  write: boolean;
  /** `args` is the parsed input; `raw` is what the caller sent (a tool whose REST twin validates the raw body itself uses it). */
  handler(ctx: ToolContext, args: z.infer<I>, raw: Record<string, unknown>): Promise<ToolOutcome>;
}

/** Declare a tool with its input type inferred for the handler, and hold it in the one list as a plain AgentTool. */
export function defineTool<I extends z.ZodType>(tool: AgentTool<I>): AgentTool {
  return tool as unknown as AgentTool;
}

/** Whether this key may call this tool (its scopes, any-of). tools/list shows only these. */
export const toolOpenTo = (tool: Pick<AgentTool, "scopes">, scopes: readonly string[]): boolean =>
  tool.scopes === "any" || tool.scopes.some((s) => scopes.includes(s));

export interface ToolReply {
  isError: boolean;
  body: unknown;
}

const INTERNAL_BODY = (): AgentErrorBody => agentErrorBody("internal");

/** Run one tools/call. Never throws: every outcome is a ToolReply, and every outcome has its audit row. */
export async function runAgentTool(
  tools: readonly AgentTool[], req: Request, res: Response, name: string, rawArgs: unknown,
): Promise<ToolReply> {
  const principal = (req as AgentRequest).agentPrincipal!;
  const startedAt = Date.now();
  const tool = tools.find((t) => t.name === name);
  // The audit never stores a name a caller chose: an unknown tool is audited as `unknown_tool`.
  const auditName = tool ? tool.name : "unknown_tool";

  const ctx: ToolContext = {
    principal, req, res, tool: auditName, scopeUsed: null,
    reader: () => {
      const reader = readerFor(req);
      if (!reader) throw new AgentApiError("unauthenticated");
      return reader;
    },
    door: {
      principal,
      markScope: (scope) => { ctx.scopeUsed = scope; },
      reserveDraft: () => reserveAgentDraftSlot(req, res),
      auditRecord: (result) => recordOf(result),
    },
  };

  const recordOf = (r: FinishAgentCall): AgentCallRecord => ({
    agentKeyId: principal.keyId,
    agentRole: principal.role,
    agentKeyName: principal.name,
    tool: auditName,
    route: `POST /mcp ${auditName}`,
    door: "mcp",
    scopeUsed: ctx.scopeUsed,
    recordIds: r.recordIds,
    resultCode: r.resultCode ?? (r.status < 400 ? "ok" : "error"),
    status: r.status,
    durationMs: Date.now() - startedAt,
    idempotencyKey: r.idempotencyKey,
    madeDraft: r.madeDraft,
  });

  try {
    if (!tool) throw new AgentApiError("unknown_tool");
    if (tool.scopes !== "any") {
      const held = tool.scopes.find((s) => principal.scopes.includes(s));
      if (!held) throw new AgentApiError("scope_denied", { reason: scopeDeniedReason(tool.scopes) });
      ctx.scopeUsed = held;
    }
    if (tool.write) {
      if (principal.mode === "read_only") throw new AgentApiError("agents_read_only");
      if (!principal.writesEnabled) throw new AgentApiError("writes_disabled");
    }
    const raw = rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
    const args = tool.input.parse(raw);
    const out = await tool.handler(ctx, args, raw);
    if (!out.auditWritten) {
      await recordAgentCall(recordOf({
        status: out.status ?? 200, body: undefined, recordIds: out.recordIds, resultCode: out.resultCode ?? "ok", idempotencyKey: out.idempotencyKey,
      }));
    }
    return { isError: false, body: out.data };
  } catch (err) {
    const { status, body } = toAgentError(agentErrorFrom(err), `POST /mcp ${auditName}`);
    try {
      await recordAgentCall(recordOf({ status, body, resultCode: body.code }));
    } catch (auditErr) {
      // The refusal could not be recorded: say internal, never the refusal's own details (the audit is the only record of them).
      toAgentError(auditErr, `POST /mcp ${auditName}`);
      return { isError: true, body: INTERNAL_BODY() };
    }
    return { isError: true, body };
  }
}
