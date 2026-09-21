/**
 * GET /search?q=<term>&per=<1..10> — global search (2026-09-20, drawers plan Phase 5). The
 * ranking, the caps and what may never be in the payload are in services/globalSearch.ts.
 *
 * Operator session only: mounted after `app.use(pinAuthMiddleware)` like every CRM router and
 * deliberately absent from middleware/publicRoutes.ts — this returns names, addresses, emails
 * and phone numbers across the whole customer base. tests/globalSearch.test.ts pins that it is
 * not public.
 */

import express from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "./agent-helpers";
import { globalSearch, MAX_QUERY_LENGTH, MIN_QUERY_LENGTH, PER_KIND_MAX } from "../services/globalSearch";

export const searchRouter = express.Router();

const querySchema = z.object({
  q: z.string().trim().min(MIN_QUERY_LENGTH).max(MAX_QUERY_LENGTH),
  per: z.coerce.number().int().min(1).max(PER_KIND_MAX).optional(),
});

searchRouter.get("/search", asyncHandler(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const per = typeof req.query.per === "string" && req.query.per !== "" ? req.query.per : undefined;
  const parsed = querySchema.safeParse({ q, per });
  if (!parsed.success) {
    const trimmed = q.trim();
    res.status(400).json({
      error: trimmed.length < MIN_QUERY_LENGTH
        ? `Type at least ${MIN_QUERY_LENGTH} characters.`
        : trimmed.length > MAX_QUERY_LENGTH
          ? `Search terms are limited to ${MAX_QUERY_LENGTH} characters.`
          : `per must be a whole number from 1 to ${PER_KIND_MAX}.`,
    });
    return;
  }
  res.json(await globalSearch(prisma, parsed.data.q, parsed.data.per));
}));
