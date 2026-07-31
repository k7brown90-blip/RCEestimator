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

/**
 * Require the secret only once `flagName` is switched on, and log every
 * unauthenticated call either way.
 *
 * The problem this solves: the phone agent's tool definitions live in the Vapi
 * dashboard, not in this repository, so an endpoint cannot be locked and its
 * caller updated in the same commit. Turning enforcement on blind would answer
 * "did the dashboard change land?" by breaking the phone during a customer call.
 *
 * So: deploy with the flag off and watch the log. Silence means every caller is
 * already sending the header and the flag is safe to turn on. Entries name who
 * is still calling unauthenticated, so nothing is guessed.
 */
export function requireWebhookSecretWhenEnabled(flagName: string, label: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authorized = hasValidWebhookSecret(req);
    const enforcing = process.env[flagName] === "true";

    if (!authorized) {
      console.warn(
        `[webhookSecret] ${label} called without a valid secret ` +
        `(enforcing=${enforcing}, ua="${req.headers["user-agent"] ?? "none"}"). ` +
        (enforcing
          ? "Refused."
          : `Allowed — set ${flagName}=true once the caller sends the header.`),
      );
    }

    if (enforcing && !authorized) {
      res.status(401).json({ error: "Invalid or missing webhook secret" });
      return;
    }
    next();
  };
}
