/**
 * @mentions (W2-C, Kyle 2026-11-23 item 5): the ONE handle table and its parser (shared/hub/mentions.ts), and who is expected to reply.
 * "@Admin", "@Inventory", "@Facebook", "@Outreach", "@Scout", "@Research", "@CFO", "@NEC Coach" and "@Coding" mark who should answer;
 * an email address is never a mention; "@Adminx" is not "@Admin"; "@NEC Coach" is one two-word handle; an unknown handle is ignored.
 */
import { describe, expect, it } from "vitest";
import { MENTION_HANDLES, parseMentions, replyExpectedFor } from "../shared/hub/mentions";
import { AGENT_ROLES, isAgentRole } from "../shared/agentScopes";
import { HUB_WEBHOOK_TARGET_IDS } from "../shared/hub/events";

describe("the handle table", () => {
  it("names the nine agents Kyle types, each as a real agent role", () => {
    expect(MENTION_HANDLES.map((h) => h.handle)).toEqual(["Admin", "Inventory", "Facebook", "Outreach", "Scout", "Research", "CFO", "NEC Coach", "Coding"]);
    for (const h of MENTION_HANDLES) expect(isAgentRole(h.role), h.handle).toBe(true);
    expect(MENTION_HANDLES.find((h) => h.handle === "Coding")?.role).toBe("claude_code");
    expect(MENTION_HANDLES.find((h) => h.handle === "NEC Coach")?.role).toBe("nec_coach");
  });

  it("has a webhook target for every handle except Coding (Claude Code is woken by the GitHub dispatch, not a webhook)", () => {
    const targets = new Set<string>(HUB_WEBHOOK_TARGET_IDS);
    expect(MENTION_HANDLES.filter((h) => !targets.has(h.role)).map((h) => h.handle)).toEqual(["Coding"]);
    // And the webhook targets are agent roles, so a key's role maps straight to its target.
    for (const id of HUB_WEBHOOK_TARGET_IDS) expect((AGENT_ROLES as readonly string[]).includes(id), id).toBe(true);
  });
});

describe("parseMentions", () => {
  it("finds a handle anywhere, case-insensitively", () => {
    expect(parseMentions("@Inventory test")).toEqual(["inventory"]);
    expect(parseMentions("@inventory test")).toEqual(["inventory"]);
    expect(parseMentions("hey @INVENTORY, can you check the truck")).toEqual(["inventory"]);
    expect(parseMentions("Please ask @cfo")).toEqual(["cfo"]);
  });

  it("reads every one of the nine handles", () => {
    expect(parseMentions("@Admin @Inventory @Facebook @Outreach @Scout @Research @CFO @NEC Coach @Coding")).toEqual([
      "admin", "inventory", "facebook", "outreach", "scout", "research", "cfo", "nec_coach", "claude_code",
    ]);
  });

  it("treats @NEC Coach as ONE handle, case-insensitively, and does not read it as anything shorter", () => {
    expect(parseMentions("@NEC Coach what does 210.8 say?")).toEqual(["nec_coach"]);
    expect(parseMentions("@nec coach what does 210.8 say?")).toEqual(["nec_coach"]);
    expect(parseMentions("@NEC what does 210.8 say?")).toEqual([]);
    expect(parseMentions("@Coach hello")).toEqual([]);
  });

  it("never reads an email address as a mention", () => {
    expect(parseMentions("send it to kyle@admin.com")).toEqual([]);
    expect(parseMentions("scout@redcedar.example and cfo@x.co")).toEqual([]);
    expect(parseMentions("mail me: kyle@admin.com, then @Admin")).toEqual(["admin"]);
  });

  it("needs the @ at the start or after a character that is not a letter, digit or underscore", () => {
    expect(parseMentions("@Admin")).toEqual(["admin"]);
    expect(parseMentions("(@Admin)")).toEqual(["admin"]);
    expect(parseMentions("ok,@Admin")).toEqual(["admin"]);
    expect(parseMentions("hi\n@Admin")).toEqual(["admin"]);
    expect(parseMentions("a@Admin")).toEqual([]);
    expect(parseMentions("_@Admin")).toEqual([]);
    expect(parseMentions("9@Admin")).toEqual([]);
    expect(parseMentions("@@Admin")).toEqual(["admin"]);
  });

  it("needs the handle to end at a non-word character or the end of the text", () => {
    expect(parseMentions("@Adminx")).toEqual([]);
    expect(parseMentions("@Admin_bot")).toEqual([]);
    expect(parseMentions("@Admin2")).toEqual([]);
    expect(parseMentions("@Admin.")).toEqual(["admin"]);
    expect(parseMentions("@Admin, @Inventory!")).toEqual(["admin", "inventory"]);
    expect(parseMentions("@Admin's call")).toEqual(["admin"]);
    expect(parseMentions("@CFO?")).toEqual(["cfo"]);
    expect(parseMentions("@NEC Coach.")).toEqual(["nec_coach"]);
    expect(parseMentions("@NEC Coachx")).toEqual([]);
  });

  it("ignores an unknown @handle and keeps the known ones", () => {
    expect(parseMentions("@Everyone and @Inventory please")).toEqual(["inventory"]);
    expect(parseMentions("@Kyle @Michael")).toEqual([]);
    expect(parseMentions("@")).toEqual([]);
    expect(parseMentions("")).toEqual([]);
    expect(parseMentions("no mentions here")).toEqual([]);
  });

  it("counts a repeated mention once and keeps the order of first appearance", () => {
    expect(parseMentions("@CFO then @Admin then @cfo again and @ADMIN")).toEqual(["cfo", "admin"]);
    expect(parseMentions("@Scout @Scout @Scout")).toEqual(["scout"]);
  });

  it("reads @Coding as claude_code", () => {
    expect(parseMentions("@Coding add a comment to README saying hub test")).toEqual(["claude_code"]);
  });
});

describe("replyExpectedFor", () => {
  it("a person's message: the mentioned agents answer", () => {
    expect(replyExpectedFor("inventory", ["inventory"], true)).toBe(true);
    expect(replyExpectedFor("admin", ["inventory"], true)).toBe(false);
    expect(replyExpectedFor("cfo", ["inventory"], true)).toBe(false);
  });

  it("a person's message that mentions nobody: Admin answers and routes", () => {
    expect(replyExpectedFor("admin", [], true)).toBe(true);
    expect(replyExpectedFor("inventory", [], true)).toBe(false);
  });

  it("a person's message that mentions only @Coding counts as mentioned, so Admin is not expected", () => {
    expect(replyExpectedFor("admin", ["claude_code"], true)).toBe(false);
  });

  it("an agent's message: only the agents it mentions, never an Admin fallback", () => {
    expect(replyExpectedFor("admin", [], false)).toBe(false);
    expect(replyExpectedFor("admin", ["admin"], false)).toBe(true);
    expect(replyExpectedFor("inventory", ["admin"], false)).toBe(false);
  });
});
