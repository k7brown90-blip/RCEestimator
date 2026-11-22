/**
 * The Kyle-only power gate (work order agent-team, unit HA3). ONE definition of "is this request
 * Kyle, or someone Kyle has given this power to", used by every gated route today (price-book
 * prices, Treasury, the Sweep) and by every later one (van clearance, license verify, level gates,
 * training publish, agent keys, draft approval) - they call `requireKylePower` / `hasKylePower` and
 * add no gate code of their own.
 *
 * Who passes:
 *   * Kyle's PIN session (`_authActor === "owner"`): Kyle by definition.
 *   * The gate-disabled dev/test convenience (`_authOutcome === "gate-disabled"`), exactly as
 *     routes/adminLogin.ts's requireOwner (now lib/routeHelpers.ts) passes it, so unrelated suites
 *     that run with the gate off keep working. The gate tests themselves run with PIN_HASH set.
 *   * A person's CRM login marked `isPrincipal` (Kyle's own), which holds every power.
 *   * A person's CRM login whose `powers` list includes the power. Kyle grants these.
 * Who never passes: the AI admin ("ai-admin" session), whatever it was granted - it is refused like
 * any other non-Kyle session. The login's ROLE (owner, admin, office, tech) is never consulted:
 * Michael's "owner" login has no Kyle-only power unless Kyle grants it.
 *
 * The CRM login is read from the database by the session gate on every request (pinAuth.ts), so a
 * grant or revoke takes effect on the person's very next request.
 */
import type { Request, RequestHandler } from "express";
import type { RequestAuthState } from "./accessLog";
import { CRM_POWERS, type CrmPower } from "../../shared/crmPowers";
import { AGENT_KEYS_AI_ADMIN_REASON } from "../../shared/agentScopes";

function stateOf(req: Request): RequestAuthState {
  return req as Request & RequestAuthState;
}

/** True for Kyle himself: the PIN session, gate-disabled, or his principal CRM login. Never ai-admin. */
export function isKyle(req: Request): boolean {
  const state = stateOf(req);
  if (state._authActor === "owner" || state._authOutcome === "gate-disabled") return true;
  return state._crmLogin?.isPrincipal === true;
}

/** True when this request may use the power: Kyle (see isKyle), or a login Kyle granted it to. */
export function hasKylePower(req: Request, power: CrmPower): boolean {
  if (isKyle(req)) return true;
  return stateOf(req)._crmLogin?.powers.includes(power) === true;
}

/**
 * Whether this request may approve what the agents draft - the ONE approver mechanism (work order,
 * "Overlap rulings"). Kyle only at launch; Kyle adds others by granting `approve_drafts`. No caller
 * yet: the approval units use it, they do not write their own check.
 */
export function canApprove(req: Request): boolean {
  return hasKylePower(req, "approve_drafts");
}

/**
 * Route middleware: 403 with `message` unless the request is Kyle himself (isKyle: the PIN, his
 * principal CRM login, or gate-disabled). For a surface that is Kyle's alone and is NOT a grantable
 * power - the key admin for CRM logins, the owner settings.
 */
export function requireKyle(message = "Only Kyle can do this."): RequestHandler {
  return (req, res, next) => {
    if (isKyle(req)) {
      next();
      return;
    }
    res.status(403).json({ error: message });
  };
}

/**
 * Price-book helpers for the `when` argument below. A new price-book item is Kyle-only when the
 * caller GIVES it a cost or hours; null and absent both mean "not given". Used by POST
 * /price-book/catalog/items and POST /materials/:id/promote, which creates a price-book item.
 */
export function givesCostOrHours(req: Request): boolean {
  const body = req.body !== null && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>) : {};
  return ["companyCost", "laborNormal", "laborDifficult", "laborVeryDifficult"]
    .some((k) => body[k] !== undefined && body[k] !== null);
}

/**
 * Route middleware: 403 with the power's reason sentence unless the request holds the power.
 *
 * `when` makes the gate conditional on the request itself (for a route where only some edits are
 * Kyle-only, such as a price-book PATCH that carries a cost but not a note): when it returns false
 * the request passes through. It must read only `req.body`/`req.params`/`req.query` and decide
 * without a database read.
 */
export function requireKylePower(power: CrmPower, when?: (req: Request) => boolean): RequestHandler {
  return (req, res, next) => {
    if ((when && !when(req)) || hasKylePower(req, power)) {
      next();
      return;
    }
    res.status(403).json({ error: CRM_POWERS[power].reason });
  };
}

/**
 * The ONE gate for agent keys and the agent kill switch (work order agent-team, K-U2): the
 * `bot_keys` power, which Kyle always holds and others only if he grants it. The AI admin can never
 * pass, and is told so in the card's own words (AGENT_KEYS_AI_ADMIN_REASON); everyone else without the
 * power gets the shared sentence for `bot_keys`.
 */
export function requireBotKeys(): RequestHandler {
  const power = requireKylePower("bot_keys");
  return (req, res, next) => {
    if (stateOf(req)._authActor === "ai-admin") {
      res.status(403).json({ error: AGENT_KEYS_AI_ADMIN_REASON });
      return;
    }
    power(req, res, next);
  };
}
