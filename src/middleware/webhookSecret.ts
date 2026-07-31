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
 * The one switch that closes the phone agent's endpoints.
 *
 * Three routes — caller lookup, availability, booking — are called by Savannah,
 * whose tool definitions live in the Vapi dashboard rather than in this
 * repository. So an endpoint cannot be locked and its caller updated in the same
 * commit, and enforcing blind would answer "did the dashboard change land?" by
 * failing during a customer's call.
 *
 * One flag rather than three because they're updated in one sitting, and the log
 * already says which endpoint is still calling bare — that's where the
 * granularity is needed, not in the number of switches to remember.
 */
export const AGENT_SECRET_FLAG = "AGENT_ENDPOINTS_REQUIRE_SECRET";

export function agentEndpointsEnforcing(): boolean {
  return process.env[AGENT_SECRET_FLAG] === "true";
}

/**
 * Log every unauthenticated call; refuse it only once the flag is on.
 *
 * Deploy with the flag off and watch the log. Silence means every caller is
 * already sending the header and the flag is safe to turn on. Entries name the
 * endpoint still being called bare, so nothing has to be guessed.
 */
export function requireWebhookSecretWhenEnabled(label: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authorized = hasValidWebhookSecret(req);
    const enforcing = agentEndpointsEnforcing();

    if (!authorized) {
      console.warn(
        `[webhookSecret] ${label} called without a valid secret ` +
        `(enforcing=${enforcing}, ua="${req.headers["user-agent"] ?? "none"}"). ` +
        (enforcing
          ? "Refused."
          : `Allowed — set ${AGENT_SECRET_FLAG}=true once every agent tool sends the header.`),
      );
    }

    if (enforcing && !authorized) {
      res.status(401).json({ error: "Invalid or missing webhook secret" });
      return;
    }
    next();
  };
}
