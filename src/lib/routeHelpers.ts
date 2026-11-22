/**
 * Small route helpers shared by the Express route files. Moved out of the retired
 * routes/agent-helpers.ts (Savannah/Jerry removal, 2026-11-21); only the ones that
 * non-agent code still used survived.
 */

import express from "express";
import type { RequestAuthState } from "../middleware/accessLog";

export const asyncHandler = (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Express 5 param reader: a path param may arrive as a string or a string array. */
export const readParam = (req: express.Request, key: string): string => {
  const raw = req.params[key];
  return Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
};

/**
 * Only Kyle's own (owner) session may pass. `gate-disabled` is the dev/test convenience where the
 * whole gate is off and everything is open anyway. Lifted from routes/adminLogin.ts (work order
 * agent-team, step 0) so there is one definition. Behaviour is unchanged: it passes ONLY the PIN
 * session ("owner") — a CRM login holding Kyle-only powers is a different question, answered by
 * middleware/kylePowers.ts. The caller supplies the 403 sentence.
 */
export const requireOwner = (message = "Only Kyle can change this."): express.RequestHandler =>
  (req, res, next) => {
    const state = req as express.Request & RequestAuthState;
    if (state._authActor === "owner" || state._authOutcome === "gate-disabled") {
      next();
      return;
    }
    res.status(403).json({ error: message });
  };
