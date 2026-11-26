/**
 * REST /api/agent/price-book/* (Kyle, 2026-11-24, "Add price book access for agent keys"): the agents' door onto the price book. AGENT KEYS ONLY
 * (AGENT_KEY_ROUTES, agentOnly: every request, key or not, goes to the one agent gate in src/agentApi/gate.ts before this file runs, so a session
 * token, a technician token or no credential is a 401 here and nothing about these routes is in PUBLIC_ROUTES). The gate has already done the kill
 * switch, the key's scopes, the key's Allow writes switch for a write, the 60-a-minute limit and the audit row for a refusal.
 *
 * Thin wrappers: the work is the cores in src/agentApi/priceBookDoor.ts, which the /mcp tools call too. Every refusal is the agent error shape with
 * its audit row (agentRefusal); a read audits then answers (finishAgentCall); a write audited itself inside its own transaction (auditWritten).
 *
 * There is NO delete, retire, archive or edit route here and none may be added: Kyle, "No delete, retire, or archive for agents". A new item is
 * a POST; a change to an existing item is a PROPOSAL a person approves.
 */
import express from "express";
import { asyncHandler, readParam } from "../lib/routeHelpers";
import { agentRefusal, restCall } from "../agentApi/hubDoor";
import { finishAgentCall, sendAgentResult } from "../agentApi/gate";
import {
  createItemCore, getItemCore, listCategoriesCore, proposeChangeCore, searchItemsCore,
} from "../agentApi/priceBookDoor";
import type { DoorResult } from "../agentApi/hubDoor";

export const agentPriceBookRouter = express.Router();

const queryText = (req: express.Request, key: string): string | undefined => {
  const raw = req.query[key];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/** Run a core and answer: a read audits then sends; a fresh write already audited inside its transaction; a replay audits as a replay. */
const door = (run: (req: express.Request, res: express.Response) => Promise<DoorResult>): express.RequestHandler =>
  asyncHandler(async (req, res) => {
    try {
      const out = await run(req, res);
      if (out.replayed) {
        await finishAgentCall(req, res, { status: 200, body: out.body, resultCode: "replayed", idempotencyKey: out.idempotencyKey });
      } else if (out.auditWritten) {
        sendAgentResult(res, out.status, out.body);
      } else {
        await finishAgentCall(req, res, { status: out.status, body: out.body, recordIds: out.recordIds });
      }
    } catch (err) {
      await agentRefusal(req, res, err);
    }
  });

agentPriceBookRouter.get("/agent/price-book/categories", door((req, res) => listCategoriesCore(restCall(req, res))));

agentPriceBookRouter.get("/agent/price-book/items", door((req, res) => searchItemsCore(restCall(req, res), {
  search: queryText(req, "search"), category: queryText(req, "category"), limit: queryText(req, "limit"),
})));

agentPriceBookRouter.get("/agent/price-book/items/:id", door((req, res) => getItemCore(restCall(req, res), readParam(req, "id"))));

agentPriceBookRouter.post("/agent/price-book/items", door((req, res) => createItemCore(restCall(req, res), bodyOf(req))));

agentPriceBookRouter.post("/agent/price-book/items/:id/proposals", door((req, res) => proposeChangeCore(restCall(req, res), readParam(req, "id"), bodyOf(req))));

function bodyOf(req: express.Request): Record<string, unknown> {
  return req.body !== null && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
}
