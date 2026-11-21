/**
 * The shared secret that guards the machine-to-machine endpoints.
 *
 * This check used to be four lines copy-pasted into about twenty handlers, which
 * is precisely how `GET /leads` ended up publicly readable: with no single place
 * that states which routes are public, a route added later simply didn't get the
 * paragraph, and nothing noticed.
 *
 * Fail-closed: with no `WEBHOOK_SECRET` configured, everything using this is
 * refused rather than opened.
 */

import type { NextFunction, Request, Response } from "express";

export function hasValidWebhookSecret(req: Request): boolean {
  const configured = process.env.WEBHOOK_SECRET;
  if (!configured) return false;
  return req.headers["webhook_secret"] === configured;
}

export const requireWebhookSecret = (req: Request, res: Response, next: NextFunction): void => {
  if (!hasValidWebhookSecret(req)) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }
  next();
};
