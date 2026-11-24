/**
 * The face of an AI agent in a thread (W2-D, Kyle 2026-11-23 item 6: "agent replies show ... with the agent's name/avatar").
 *
 * ONE table for the role's initials and colour, and the name comes from the ONE handle table (mentions.ts MENTION_HANDLES: Admin,
 * Inventory, ..., Coding), so a name on an avatar is the word Kyle types to wake that agent. The field app draws it today; the CRM can
 * import the same helper later. Colours are solid fills with white initials (each is at least 4.5:1 against white, pinned in
 * tests/hubAgentAvatar.test.ts) and no two roles share a colour or initials, so an agent is told apart by sight and by letters.
 *
 * Nothing here decides WHO an author is. The server names the role (TechMessage.agentRole), from the key that wrote the post; a role it
 * does not know (`other`, or a role added later) draws the neutral "AI" avatar.
 */
import type { AgentRole } from "../agentScopes";
import { MENTION_HANDLES } from "./mentions";

export interface AgentAvatar {
  /** The role the avatar stands for, or null for the neutral fallback. */
  role: AgentRole | null;
  /** One or two letters on the circle. */
  initials: string;
  /** The agent's name as Kyle types it after "@": "Admin", "NEC Coach", "Coding". */
  label: string;
  /** Circle fill (hex) and the letters on it (white). */
  background: string;
  foreground: string;
  /** What a screen reader says: "Admin (AI)". */
  ariaLabel: string;
}

const FOREGROUND = "#ffffff";

/** Initials and fill per role. `other` is the neutral fallback. */
const LOOK: Record<AgentRole, { initials: string; background: string }> = {
  admin: { initials: "A", background: "#1d4ed8" },
  inventory: { initials: "I", background: "#b45309" },
  facebook: { initials: "F", background: "#4338ca" },
  outreach: { initials: "O", background: "#be185d" },
  scout: { initials: "S", background: "#4d7c0f" },
  research: { initials: "R", background: "#7e22ce" },
  cfo: { initials: "CF", background: "#0f766e" },
  nec_coach: { initials: "NC", background: "#b91c1c" },
  claude_code: { initials: "CC", background: "#0e7490" },
  other: { initials: "AI", background: "#475569" },
};

/** Every role that has its own look, for the tests (all nine named agents; `other` is the fallback and is not in it). */
export const AVATAR_ROLES: readonly AgentRole[] = MENTION_HANDLES.map((h) => h.role);

/** The avatar for a role string off the wire; null, undefined or an unknown role is the neutral "AI" one. */
export function agentAvatar(role: string | null | undefined): AgentAvatar {
  const handle = MENTION_HANDLES.find((h) => h.role === role);
  const look = handle ? LOOK[handle.role] : LOOK.other;
  const label = handle ? handle.handle : "AI agent";
  return {
    role: handle ? handle.role : null, initials: look.initials, label,
    background: look.background, foreground: FOREGROUND, ariaLabel: `${label} (AI)`,
  };
}

/** The authorTypes an AI wrote as. */
const AI_AUTHOR_TYPES: readonly string[] = ["ai_agent", "claude"];

/** True when a message was written by an AI: the server's author type, or a role it resolved. */
export function isAiAuthor(authorType: string, agentRole?: string | null): boolean {
  return AI_AUTHOR_TYPES.includes(authorType) || (agentRole !== null && agentRole !== undefined);
}

/**
 * The name without the "(AI)" the server adds (hubTech.techAuthorLabel). The avatar's "AI" chip already says it, so a bubble that
 * drew "Admin (AI)" next to an "AI" chip would say it twice. The wire label keeps its "(AI)" for every other reader.
 */
export function plainAuthorName(label: string): string {
  return label.replace(/\s*\(AI\)\s*$/, "");
}
