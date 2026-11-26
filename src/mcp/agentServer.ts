/**
 * The agents' MCP door (work order agent-team K-U5, W2-B): POST /mcp, STATELESS (team answer 12). Every POST builds its own MCP Server and
 * Streamable HTTP transport (no session id, JSON answers, no event stream) and throws them away when the answer is sent: there is no session
 * map, nothing to expire, and a revoke, a scope edit or the kill switch applies to the very next request because the gate re-reads the key row
 * on every one. GET and DELETE are answered 405 in plain JSON (there is no stream to open and no session to close).
 *
 * Authentication is NOT here. pinAuth hands every /mcp request (AGENT_KEY_ROUTES, agentOnly) to the ONE agent gate (src/agentApi/gate.ts)
 * before this file runs; a request that reaches a handler below has a key, its principal and its place in the per-key limiter. This file adds
 * no second auth check and nothing to PUBLIC_ROUTES. The tools, their scopes, the writes switch and the audit row for every tools/call are
 * the registry's (src/agentApi/registry.ts, tools.ts).
 *
 * One HTTP request = one JSON-RPC message = one pass through the per-key limiter. A JSON-RPC batch (an array body) is refused 400 before the
 * transport sees it (W2-B review): the limiter counts the POST, so a batch of thousands of tool calls would otherwise ride on one slot. The
 * MCP spec dropped batching in 2025-06-18; the SDK clients send one message per POST.
 *
 * Audit choice: every tools/call writes its own row (registry). `initialize` and `tools/list` each write one small row too (tool
 * `mcp.initialize` / `mcp.tools_list`), because that is one insert each and it shows when an agent connected. Those rows, and the row for a
 * request the transport refused before any tool ran (406 wrong Accept, 415 wrong Content-Type, 400 bad protocol version, a tools/call whose
 * params fail validation), are written AFTER the transport has answered, with the status it really sent, so Settings -> Agent keys -> Activity
 * never shows a handshake as "ok" that the agent was refused. Notifications and ping are not rows.
 */
import type { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { agentErrorBody, toAgentError } from "../agentApi/errors";
import { agentAuditRecord, finishAgentCall, type AgentRequest } from "../agentApi/gate";
import { recordAgentCall } from "../agentApi/audit";
import { runAgentTool, toolOpenTo } from "../agentApi/registry";
import { AGENT_TOOLS } from "../agentApi/tools";

const SERVER_INFO = { name: "rce-agent-door", version: "1.0.0" } as const;
const INSTRUCTIONS = "Red Cedar Electric's agent door. Call whoami first: it says what this key may do. "
  + "Errors come back as a tool error whose text is JSON {code, reason, retryable}; the reason names the scope to tick on Settings -> Agent keys. "
  + "The price book tools take PRE-TAX costs and per-unit hours; an agent can add a NEW item, and a change to an existing one is a proposal that a person approves in the CRM.";

/** The JSON schema tools/list shows for a tool's input (the defaults made optional, the $schema line left off). */
function jsonSchemaOf(input: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(input, { io: "input" }) as Record<string, unknown>;
  return schema;
}

/** The method name of a single JSON-RPC message. A body that is not JSON-RPC has none. */
function methodOf(body: unknown): string | null {
  return body !== null && typeof body === "object" && !Array.isArray(body) && typeof (body as { method?: unknown }).method === "string"
    ? (body as { method: string }).method
    : null;
}

/** The result code the audit shows for a request the transport refused, by the status it sent. */
function refusedCode(status: number): string {
  if (status === 406) return "not_acceptable";
  if (status === 415) return "unsupported_media_type";
  return status >= 400 ? "bad_request" : "invalid_request";
}

function buildServer(req: Request, res: Response, ran: { tool: boolean }): Server {
  const principal = (req as AgentRequest).agentPrincipal!;
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: AGENT_TOOLS.filter((t) => toolOpenTo(t, principal.scopes)).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: jsonSchemaOf(t.input) as { type: "object"; properties?: Record<string, unknown> },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    ran.tool = true; // the registry writes this call's own audit row
    const reply = await runAgentTool(AGENT_TOOLS, req, res, request.params.name, request.params.arguments);
    const body = reply.body;
    const isObject = body !== null && typeof body === "object" && !Array.isArray(body);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(body) }],
      ...(isObject ? { structuredContent: body as Record<string, unknown> } : {}),
      isError: reply.isError,
    };
  });
  return server;
}

/** POST /mcp: one JSON-RPC request in, one answer out. */
export async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const state = req as AgentRequest;
  if (!state.agentPrincipal || !state.agentCall) {
    // Unreachable behind pinAuth (every /mcp request goes through the gate); fail closed if the mount is ever moved.
    res.status(401).json(agentErrorBody("unauthenticated"));
    return;
  }
  try {
    if (Array.isArray(req.body)) {
      // A batch rides on ONE limiter slot, so it is refused whole (nothing in it runs). One audit row, no bodies.
      await recordAgentCall(agentAuditRecord(req, { status: 400, body: undefined, tool: "mcp.batch_refused", resultCode: "bad_request" }));
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32600, message: "Send one JSON-RPC message per request; batches are not accepted." }, id: null });
      return;
    }
    const ran = { tool: false };
    const server = buildServer(req, res, ran);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    // The audit rows the registry does not write, with the status the transport REALLY sent.
    if (!ran.tool) {
      const method = methodOf(req.body);
      const status = res.statusCode;
      if (method === "initialize" || method === "tools/list") {
        await recordAgentCall(agentAuditRecord(req, {
          status, body: undefined, tool: `mcp.${method.replace("/", "_")}`, resultCode: status < 400 ? "ok" : refusedCode(status),
        }));
      } else if (method === "tools/call" || status >= 400) {
        // A tools/call that never reached its tool (refused by the transport, or its params failed validation), or any other refused request.
        await recordAgentCall(agentAuditRecord(req, { status, body: undefined, tool: "mcp.transport_refused", resultCode: refusedCode(status) }));
      }
    }
  } catch (err) {
    // Log the real error (SystemEvent, source agent_api); the caller gets a JSON-RPC internal error with no detail.
    toAgentError(err, "POST /mcp");
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error." }, id: null });
  }
}

/** GET and DELETE /mcp: 405 in plain JSON, audited (the gate already authenticated the key). */
export async function handleMcpNotPost(req: Request, res: Response): Promise<void> {
  res.setHeader("Allow", "POST");
  await finishAgentCall(req, res, {
    status: 405, body: agentErrorBody("method_not_allowed"), tool: "mcp.method_not_allowed", resultCode: "method_not_allowed",
  });
}
