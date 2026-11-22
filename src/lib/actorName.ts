/**
 * The name to stamp on a change ("paused by Michael"): the signed-in person's name. A person's CRM
 * login carries it; the AI admin is "AI admin"; Kyle's PIN session is the principal login's person
 * when he has marked one, else "Kyle". Never a token, never a username that is not a name.
 */
import type { Request } from "express";
import type { RequestAuthState } from "../middleware/accessLog";
import { getPrincipalLogin } from "../services/crmLogin";

export async function actorNameOf(req: Request): Promise<string> {
  const state = req as Request & RequestAuthState;
  if (state._crmLogin) return state._crmLogin.name;
  if (state._authActor === "ai-admin") return "AI admin";
  try {
    return (await getPrincipalLogin())?.technician.name ?? "Kyle";
  } catch {
    return "Kyle";
  }
}
