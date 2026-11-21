/**
 * Small route helpers shared by the Express route files. Moved out of the retired
 * routes/agent-helpers.ts (Savannah/Jerry removal, 2026-11-21); only the ones that
 * non-agent code still used survived.
 */

import express from "express";

export const asyncHandler = (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Express 5 param reader: a path param may arrive as a string or a string array. */
export const readParam = (req: express.Request, key: string): string => {
  const raw = req.params[key];
  return Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
};
