/**
 * Signing mode — a SESSION SCOPE, not a screen. (P028)
 *
 * Kyle's ruling: *"I want them to be able to view the quote in app and sign there as the first
 * option."* The customer is handed the operator's unlocked phone, which is logged into the CRM
 * with a full 8-hour owner session. Every account, every price, every job is one tap away.
 *
 * **Hiding the navigation is not a lock.** A hidden button is still a reachable URL, and the
 * device in the customer's hand has a browser address bar. So signing mode is enforced HERE, on
 * the server, by narrowing the session itself:
 *
 *   1. The operator (holding a full `sub: "owner"` session) asks to enter signing mode for ONE
 *      estimate. The server mints a SECOND, restricted token — `sub: "signing"`, `est: <id>` —
 *      with a short life, and the client swaps it in.
 *   2. While that token is the session, this middleware permits exactly three things: reading
 *      that one estimate's customer view, signing that one estimate, and the PIN login that
 *      ends signing mode. **Everything else is 403, including the same routes for a DIFFERENT
 *      estimate.**
 *   3. Exit is `POST /auth/pin` — the operator's PIN mints a fresh full session. There is no
 *      other way back, because there is no other way to turn `sub: "signing"` into `sub: "owner"`.
 *
 * The customer can therefore type any URL they like. The token in that browser cannot answer for
 * it. Idle timeout is belt-and-braces on the same property: the restricted token expires on its
 * own, so an abandoned phone degrades to an expired session — never into the CRM.
 *
 * WHY A SECOND TOKEN RATHER THAN A FLAG ON THE FIRST. A server-side "signing mode is on" flag
 * would have to be stored somewhere and cleared reliably, and a stale flag locks Kyle out of his
 * own CRM. A capability that is simply *narrower* needs no cleanup: worst case it expires.
 */

import jwt from "jsonwebtoken";
import type { Request } from "express";

const JWT_SECRET = process.env.JWT_SECRET ?? "rce-dev-secret-change-me";

/**
 * How long a signing session lives without the operator coming back.
 *
 * Long enough for a customer to read an estimate properly and ask questions; short enough that a
 * phone left on a tailgate is not a standing key. The client also runs its own idle timer and
 * drops to the PIN lock earlier; this is the floor under it.
 */
export const SIGNING_SESSION_MINUTES = 20;

export interface SigningClaims {
  sub: "signing";
  est: string;
}

/** Mint the restricted session for one estimate. Callable only from an authenticated route. */
export function mintSigningToken(estimateId: string): { token: string; expiresIn: number } {
  const expiresIn = SIGNING_SESSION_MINUTES * 60;
  const token = jwt.sign({ sub: "signing", est: estimateId }, JWT_SECRET, { expiresIn });
  return { token, expiresIn };
}

/** The signing claims on this request's token, or null when it is not a signing session. */
export function signingClaims(req: Request): SigningClaims | null {
  const raw = req.headers.authorization?.replace("Bearer ", "");
  if (!raw) return null;
  try {
    const claims = jwt.verify(raw, JWT_SECRET);
    if (
      typeof claims === "object" &&
      claims !== null &&
      (claims as { sub?: unknown }).sub === "signing" &&
      typeof (claims as { est?: unknown }).est === "string"
    ) {
      return { sub: "signing", est: (claims as { est: string }).est };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The complete list of what a signing session may reach. Two routes, one estimate.
 *
 * Written as explicit path equality against the estimate id from the TOKEN — never from the URL —
 * so a customer editing the id in the address bar is comparing their typed value against their
 * own capability and losing.
 */
export function signingSessionAllows(method: string, path: string, estimateId: string): boolean {
  const p = path.replace(/\/+$/, "") || "/";
  const bare = p.startsWith("/api/") ? p.slice(4) : p;

  if (method === "GET" && bare === `/issued-estimates/${estimateId}/customer-view`) return true;
  if (method === "POST" && bare === `/issued-estimates/${estimateId}/sign-in-person`) return true;
  return false;
}
