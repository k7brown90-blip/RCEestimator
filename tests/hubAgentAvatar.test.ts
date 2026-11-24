/**
 * The agent's avatar (W2-D, shared/hub/agentAvatar.ts): one look per role, built on the ONE handle table (mentions.ts). Pinned: every
 * named agent has its own initials and colour (so two agents are never confused by sight or by letters), each colour carries white
 * letters at WCAG AA (4.5:1) for reading on a phone in sunlight, every handle Kyle can type has an avatar, an unknown or missing role is
 * the neutral "AI" one, the screen-reader label says "(AI)", and "(AI)" is stripped from a name only at its end.
 */
import { describe, expect, it } from "vitest";
import { AVATAR_ROLES, agentAvatar, isAiAuthor, plainAuthorName } from "../shared/hub/agentAvatar";
import { MENTION_HANDLES } from "../shared/hub/mentions";
import { AGENT_ROLES } from "../shared/agentScopes";

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("agentAvatar", () => {
  it("covers all nine roles Kyle can @mention, each with its own initials and colour", () => {
    expect(AVATAR_ROLES).toEqual(MENTION_HANDLES.map((h) => h.role));
    expect(AVATAR_ROLES).toHaveLength(9);
    for (const role of ["admin", "inventory", "facebook", "outreach", "scout", "research", "cfo", "nec_coach", "claude_code"]) expect(AVATAR_ROLES).toContain(role);
    const looks = AVATAR_ROLES.map((r) => agentAvatar(r));
    expect(new Set(looks.map((l) => l.initials)).size).toBe(9);
    expect(new Set(looks.map((l) => l.background)).size).toBe(9);
    // The neutral one is not any of them.
    const neutral = agentAvatar("other");
    expect(looks.map((l) => l.background)).not.toContain(neutral.background);
    expect(looks.map((l) => l.initials)).not.toContain(neutral.initials);
  });

  it("is readable: white letters on every fill at 4.5:1 or better", () => {
    for (const role of [...AVATAR_ROLES, "other", null, "made_up"]) {
      const a = agentAvatar(role);
      expect(a.foreground).toBe("#ffffff");
      expect(contrast(a.background, a.foreground), String(role)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("names each agent by the handle Kyle types, and says (AI) to a screen reader", () => {
    expect(agentAvatar("nec_coach")).toMatchObject({ label: "NEC Coach", initials: "NC", ariaLabel: "NEC Coach (AI)" });
    expect(agentAvatar("claude_code")).toMatchObject({ label: "Coding", ariaLabel: "Coding (AI)" });
    expect(agentAvatar("cfo")).toMatchObject({ label: "CFO", ariaLabel: "CFO (AI)" });
    expect(agentAvatar("admin").role).toBe("admin");
  });

  it("an unknown, empty or 'other' role is the neutral AI avatar", () => {
    for (const role of ["other", "something_new", "", null, undefined]) {
      expect(agentAvatar(role)).toMatchObject({ role: null, initials: "AI", label: "AI agent", ariaLabel: "AI agent (AI)" });
    }
    // Every stored role string is either an avatar role or the fallback; none throws.
    for (const role of AGENT_ROLES) expect(agentAvatar(role).initials.length).toBeGreaterThan(0);
  });

  it("isAiAuthor: the AI author types, or a resolved role; people are not", () => {
    expect(isAiAuthor("ai_agent")).toBe(true);
    expect(isAiAuthor("claude")).toBe(true);
    expect(isAiAuthor("tech", "admin")).toBe(true);
    expect(isAiAuthor("tech")).toBe(false);
    expect(isAiAuthor("office", null)).toBe(false);
    expect(isAiAuthor("system")).toBe(false);
  });

  it("plainAuthorName drops a trailing (AI) and nothing else", () => {
    expect(plainAuthorName("RCE Admin (AI)")).toBe("RCE Admin");
    expect(plainAuthorName("RCE Admin")).toBe("RCE Admin");
    expect(plainAuthorName("(AI) Helper")).toBe("(AI) Helper");
    expect(plainAuthorName("Kyle")).toBe("Kyle");
  });
});
