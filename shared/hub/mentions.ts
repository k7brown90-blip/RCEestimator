/**
 * @mentions in a Team, group or crew chat (W2, Kyle 2026-11-23 item 5): "@Admin", "@Inventory", "@Research", "@CFO", "@NEC Coach",
 * "@Coding" mark WHO SHOULD ANSWER. Everyone whose key can read the thread still gets the event (services/hubEvents.ts); the event
 * says who is expected to reply (`mentions[]`, and `reply_expected` per receiver). With no mention, Admin answers and routes.
 *
 * ONE handle table, here, read by the server (the fan-out) and, later, by the field composer. The handles are the words Kyle types,
 * NOT the labels on Settings -> Agent keys ("Inventory Manager", "Claude Code (Coding)"): `@Coding` is the role claude_code.
 *
 * parseMentions reads the RAW body (before any scrub). Rules, all pinned in tests/hubMentions.test.ts:
 *   - case-insensitive ("@inventory" = "@Inventory");
 *   - the "@" is at the start of the text or right after a character that is not a letter, digit or underscore, so an email address
 *     ("kyle@admin.com") is never a mention;
 *   - the handle must END at a non-word character or the end of the text ("@Adminx" is not "@Admin");
 *   - longest handle first, and "@NEC Coach" is ONE handle (two words, one space);
 *   - an unknown "@handle" is ignored; repeats count once; the result is in order of first appearance.
 */
import type { AgentRole } from "../agentScopes";

/** What Kyle types, in the order the card lists the agents. The value is the agent role string (the webhook target id for all but Coding). */
export const MENTION_HANDLES: ReadonlyArray<{ handle: string; role: AgentRole }> = [
  { handle: "Admin", role: "admin" },
  { handle: "Inventory", role: "inventory" },
  { handle: "Facebook", role: "facebook" },
  { handle: "Outreach", role: "outreach" },
  { handle: "Scout", role: "scout" },
  { handle: "Research", role: "research" },
  { handle: "CFO", role: "cfo" },
  { handle: "NEC Coach", role: "nec_coach" },
  { handle: "Coding", role: "claude_code" },
];

const BY_LENGTH = [...MENTION_HANDLES].sort((a, b) => b.handle.length - a.handle.length);
const WORD = /[A-Za-z0-9_]/;

/** The roles a message mentions, deduplicated, in order of first appearance. */
export function parseMentions(rawBody: string): AgentRole[] {
  const text = rawBody ?? "";
  const lower = text.toLowerCase();
  const found: AgentRole[] = [];
  for (let at = lower.indexOf("@"); at !== -1; at = lower.indexOf("@", at + 1)) {
    if (at > 0 && WORD.test(text[at - 1])) continue; // "kyle@admin.com": an email, not a mention
    const hit = BY_LENGTH.find((h) => {
      const end = at + 1 + h.handle.length;
      return lower.startsWith(h.handle.toLowerCase(), at + 1) && (end >= text.length || !WORD.test(text[end]));
    });
    if (hit && !found.includes(hit.role)) found.push(hit.role);
  }
  return found;
}

/**
 * Whether this receiver is expected to REPLY (R-i). A person's message: the agents it mentions, or Admin when it mentions nobody (a
 * message that mentions only @Coding counts as mentioned, so Admin is not expected). An agent's message: only the agents it mentions,
 * never an Admin fallback, so the team cannot start answering itself.
 */
export function replyExpectedFor(role: string, mentions: readonly string[], authorIsPerson: boolean): boolean {
  if (mentions.includes(role)) return true;
  return authorIsPerson && mentions.length === 0 && role === "admin";
}
