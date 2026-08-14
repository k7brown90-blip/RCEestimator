/**
 * P011 — the propose-only contract, pinned.
 *
 * The live MCP demonstrations in the report are the verification bar. These tests exist for the
 * one invariant that must never silently regress: **a PROPOSED line prices nothing.** If someone
 * later changes the compute filter, or flips the schema default, or adds a code path that marks
 * an AI line CONFIRMED, this fails.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = (p: string) => readFileSync(path.join(__dirname, "..", p), "utf8");

/**
 * Strip `//` comments before asserting. The removals in this task are documented in comments
 * that necessarily NAME the thing removed ("this used to accept laborMultiplier…"), so a naive
 * substring search finds the explanation and reports the hole as still open. Assert on code.
 */
const codeOnly = (s: string) =>
  s
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");

describe("the model's tool surface", () => {
  const mcp = SRC("src/mcp/server.ts");

  const RETIRED = [
    "create_estimate",
    "add_estimate_items",
    "generate_support_items",
    "delete_estimate_item",
    "change_estimate_status",
    "update_estimate_markup",
    "add_option",
    "set_estimate_modifiers",
    "generate_proposal_pdf",
    "delete_estimate",
  ];

  it("registers every mutating tool on the dead server, never the live one", () => {
    for (const tool of RETIRED) {
      // The registration must be `retired.registerTool("<tool>"` — not `server.registerTool`.
      expect(mcp, `${tool} must not be registered on the live server`).not.toMatch(
        new RegExp(`server\\.registerTool\\(\\s*\\n?\\s*"${tool}"`)
      );
      expect(mcp, `${tool} should still exist on the retired server (move, never delete)`).toMatch(
        new RegExp(`retired\\.registerTool\\(\\s*\\n?\\s*"${tool}"`)
      );
    }
  });

  it("never connects the retired server to a transport", () => {
    expect(mcp).not.toMatch(/retired\.connect\(/);
    expect(mcp).not.toMatch(/return retired/);
  });

  it("exposes propose_estimate_lines as the only write tool", () => {
    expect(mcp).toMatch(/server\.registerTool\(\s*\n?\s*"propose_estimate_lines"/);
  });

  it("accepts no numeric multiplier anywhere in the live tool schemas", () => {
    // The live registrations are everything before the retired ones are re-targeted; the
    // simplest durable assertion is that these field names appear nowhere as an input schema
    // entry on a tool the model can reach. `set_estimate_modifiers` still declares them, but
    // it is retired — so we assert on the propose tool's own schema explicitly.
    const proposeBlock = mcp.slice(mcp.indexOf('"propose_estimate_lines"'));
    // Assert on the inputSchema only. The tool's DESCRIPTION deliberately contains the words
    // "price", "multiplier" and "markup" — it is telling the model it cannot set them — so
    // searching the whole registration would flag the safety copy as the hazard.
    const schemaStart = proposeBlock.indexOf("inputSchema:");
    const schemaEnd = proposeBlock.indexOf("async ({ draftId");
    const schema = codeOnly(proposeBlock.slice(schemaStart, schemaEnd));
    for (const field of ["laborMultiplier", "materialMult", "unitCost", "markup"]) {
      expect(schema, `${field} must not be an input field`).not.toContain(field);
    }
    // No money field of ANY name. Asserting on the declaration shape rather than the word,
    // because the word "price" legitimately appears inside the tool name
    // `query_price_book_atomics` — a substring ban would flag the catalog's own name.
    expect(schema, "no input field may be a raw money/rate number").not.toMatch(
      /(price|cost|rate|markup|multiplier|discount)[A-Za-z]*\s*:\s*z\s*\n?\s*\.number/i
    );
    // Difficulty must travel as the three published NECA columns, never as a number the
    // model picks. This is the field the old `laborMultiplier` became.
    expect(schema).toContain("difficulty");
    expect(schema).toContain('"NORMAL", "DIFFICULT", "VERY_DIFFICULT"');
    expect(schema).not.toMatch(/difficulty:\s*z\s*\n?\s*\.number/);
  });

  it("add_estimate_items no longer accepts a modifiers array even though it is retired", () => {
    const block = mcp.slice(mcp.indexOf('"add_estimate_items"'));
    const end = block.indexOf("async ({ estimateId, optionId, items }");
    expect(codeOnly(block.slice(0, end))).not.toContain("laborMultiplier");
  });
});

describe("proposed lines price nothing", () => {
  const service = SRC("src/services/atomicEstimateService.ts");

  it("computeDraft filters to CONFIRMED before pricing", () => {
    expect(service).toMatch(/filter\(\(l\) => l\.state === "CONFIRMED"\)/);
  });

  it("the human entry path marks lines CONFIRMED explicitly", () => {
    const addLine = service.slice(service.indexOf("export async function addLine"));
    expect(addLine.slice(0, addLine.indexOf("export async function editLine"))).toContain('state: "CONFIRMED"');
  });

  it("the model's proposal path marks lines PROPOSED", () => {
    const propose = service.slice(service.indexOf("export async function proposeLines"));
    expect(propose.slice(0, propose.indexOf("export async function confirmProposedLine"))).toContain('state: "PROPOSED"');
  });

  it("finalize refuses while any line is unconfirmed or any question is open", () => {
    const fin = service.slice(service.indexOf("export async function finalizeDraft"));
    expect(fin).toContain('state: "PROPOSED"');
    expect(fin).toContain("resolvedAt: null");
    expect(fin).toMatch(/finalized: false/);
  });
});

describe("schema defaults fail closed", () => {
  const schema = SRC("prisma/schema.prisma");

  it("PriceBookDraftLine.state defaults to PROPOSED, not CONFIRMED", () => {
    expect(schema).toMatch(/state\s+PriceBookLineState\s+@default\(PROPOSED\)/);
  });

  it("an unmatched item has somewhere to go that is not a line", () => {
    expect(schema).toContain("model PriceBookDraftQuestion");
  });
});

describe("the UI no longer states things that are untrue", () => {
  const ui = SRC("client/src/components/EstimateIntake.tsx");

  it("does not claim an 82-unit catalog", () => {
    // The phrase may only survive inside the comment recording its removal.
    const live = ui.split("\n").filter((l) => !l.trim().startsWith("//") && !l.includes("Was \""));
    expect(live.join("\n")).not.toContain("82-unit");
  });

  it("does not hard-code a model name Kyle has not chosen", () => {
    const live = ui.split("\n").filter((l) => !l.trim().startsWith("//") && !l.includes("Was \""));
    expect(live.join("\n")).not.toContain("powered by GPT-5.1");
  });
});
