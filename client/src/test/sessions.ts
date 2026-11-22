/**
 * Session and CRM-login fixtures for the tests of "who is signed in" (work order agent-team, HA4/HA5).
 */
import type { CrmLoginView, SessionView } from "../lib/types";
import { CRM_POWER_KEYS } from "../../../shared/crmPowers";

/** Kyle at the owner PIN: every power. */
export const PIN_SESSION: SessionView = { kind: "kyle-pin", name: "Kyle", role: "owner", isKyle: true, powers: [...CRM_POWER_KEYS] };

/** Michael: an owner-ROLE login with no Kyle-only power. The role must not matter. */
export const OWNER_NO_GRANT: SessionView = { kind: "user", name: "Michael Schramm", role: "owner", isKyle: false, powers: [] };

export const ownerWith = (...powers: string[]): SessionView => ({ ...OWNER_NO_GRANT, powers });

/** Kyle signed in with his own principal login. */
export const PRINCIPAL_SESSION: SessionView = { kind: "user", name: "Kyle Rowe", role: "owner", isKyle: true, powers: [...CRM_POWER_KEYS] };

export const AI_ADMIN_SESSION: SessionView = { kind: "ai-admin", name: "grok-admin", role: "ai-admin", isKyle: false, powers: [] };

export const loginFor = (technicianId: string, name: string, over: Partial<CrmLoginView> = {}): CrmLoginView => ({
  id: `login-${technicianId}`,
  technicianId,
  name,
  username: name.split(" ")[0].toLowerCase(),
  role: "owner",
  isPrincipal: false,
  powers: [],
  enabled: true,
  hasPassword: true,
  personActive: true,
  updatedAt: "2026-11-21T12:00:00.000Z",
  ...over,
});
