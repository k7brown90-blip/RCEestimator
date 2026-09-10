/**
 * Treasury settings (Kyle, 2026-09-09): the floats, the main financial
 * account, and the Chase destination the month-end sweep goes to.
 *
 * "At the end of each month I will take whatever money is over that value and
 * deposit it into the Chase savings accounts for taxes and owner
 * distributions." The floats are set here once, when the accounts are opened;
 * the sweep itself lives on Financials (routes/financials.ts, /financials/sweep)
 * and only ever runs on Kyle's click.
 *
 * Same store as companyProfile (CompanySetting, key "treasury"), but its own
 * validated PUT — every float must be ≥ 0 — rather than the free-form
 * /crm/settings/:key upsert. Mounted behind the operator session.
 */

import express from "express";
import { asyncHandler } from "./agent-helpers";
import { getTreasurySettings, saveTreasurySettings } from "../services/treasury";

export const treasuryRouter = express.Router();

treasuryRouter.get("/settings/treasury", asyncHandler(async (_req, res) => {
  res.json(await getTreasurySettings());
}));

/** Numbers ≥ 0 or a 400 (ZodError → the app's validation handler). */
treasuryRouter.put("/settings/treasury", asyncHandler(async (req, res) => {
  res.json(await saveTreasurySettings(req.body ?? {}));
}));
