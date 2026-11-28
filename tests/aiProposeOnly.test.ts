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

  // Kyle, 2026-11-28: this used to also pin "or any question is open" (`resolvedAt: null` in
  // finalizeDraft). Questions no longer block issue; an unconfirmed line still does.
  it("finalize refuses while any line is unconfirmed, and no longer reads questions", () => {
    const fin = service.slice(service.indexOf("export async function finalizeDraft"));
    expect(fin).toContain('state: "PROPOSED"');
    expect(fin).not.toContain("resolvedAt: null");
    expect(fin).not.toContain("priceBookDraftQuestion");
    expect(fin).toMatch(/finalized: false/);
  });
});

describe("schema defaults fail closed", () => {
  const schema = SRC("prisma/schema.prisma");

  it("PriceBookDraftLine.state defaults to PROPOSED, not CONFIRMED", () => {
    expect(schema).toMatch(/state\s+PriceBookLineState\s+@default\(PROPOSED\)/);
  });

  // The AI no longer writes questions (Kyle, 2026-11-28), but the table stays: rows already on drafts are
  // kept (nothing is deleted) and the hand-raise route still writes to it.
  it("the question table is kept for rows already on drafts", () => {
    expect(schema).toContain("model PriceBookDraftQuestion");
  });
});

describe("the UI no longer states things that are untrue", () => {
  // Pinned on the estimate builder — the surface Kyle actually quotes from. It was pinned on
  // `components/EstimateIntake.tsx` until 2026-09-21; that file had no importer left (the
  // retired chatkit intake) and was deleted, so the invariant moved to the live page rather
  // than going with it.
  const ui = SRC("client/src/pages/PriceBookIntakePage.tsx");

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
