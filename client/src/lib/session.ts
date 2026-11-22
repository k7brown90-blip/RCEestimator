/**
 * Who is signed in (work order agent-team, HA5). ONE source: GET /auth/session, fetched once and
 * shared by every component that asks - the header ("Signed in as ..."), the Team screen's "CRM
 * login" button, and every Kyle-only control that is greyed for a session without its power. React
 * Query de-duplicates the calls under one key, so a screen with ten greyed inputs makes one request.
 *
 * Kyle-only powers (shared/crmPowers.ts) are decided by the SERVER on every request; this only
 * decides what to grey out so nobody clicks a button that is going to be refused. While the session
 * is still loading, or if it could not be read, controls are left enabled - the server's 403 is the
 * authority, and a transient failure here must not lock Kyle out of his own price book.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { SessionView } from "./types";
import { CRM_POWERS, type CrmPower } from "../../../shared/crmPowers";

export const SESSION_QUERY_KEY = ["session"] as const;

export const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  office: "Office",
  tech: "Tech",
  "ai-admin": "AI admin",
};

export const roleLabel = (role: string): string => ROLE_LABELS[role] ?? role;

export function useSession(): SessionView | null {
  const { data } = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: api.session,
    staleTime: 30_000,
    retry: false,
  });
  return data ?? null;
}

/**
 * May this session use the power? `reason` is the shared sentence to show when it may not, and null
 * when it may. Unknown session (still loading, or unreadable): allowed.
 */
export function useCan(power: CrmPower): { allowed: boolean; reason: string | null } {
  const session = useSession();
  if (!session || session.powers.includes(power)) return { allowed: true, reason: null };
  return { allowed: false, reason: CRM_POWERS[power].reason };
}

/** Is this session Kyle himself (the PIN or his own login)? Unknown session: yes, the server decides. */
export function useIsKyle(): boolean {
  const session = useSession();
  return session ? session.isKyle : true;
}

/**
 * True once the session could not be read (the request failed). Cards that must not claim a state
 * while the session is unknown use it to tell "still loading" from "unreadable"; the server stays
 * the authority either way.
 */
export function useSessionFailed(): boolean {
  const { isError } = useQuery({ queryKey: SESSION_QUERY_KEY, queryFn: api.session, staleTime: 30_000, retry: false });
  return isError;
}
