/**
 * P022 — no surface reports success it hasn't earned, or hides a refusal it has.
 *
 * One theme, three defects from P019: the vacuous COMPLETE, the invisible finalize refusal, and
 * feedback landing in a table nobody reads.
 *
 * The finalize-refusal fix is presentational (render above the buttons, scroll into view) and is
 * verified by transcript and viewport rather than here — what IS tested here is that the refusal
 * still carries its reasons, since that is the part a regression would silently remove.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma";
import { computeEstimate } from "../src/services/atomicEstimateEngine";
import { getFeedbackForDigest } from "../src/services/dailySummary";
import { createDraft, addLine, finalizeDraft } from "../src/services/atomicEstimateService";

// ─── COMPLETE requires substance (Scope — do 2) ──────────────────────────────────────────────

describe("an empty draft is EMPTY, never COMPLETE", () => {
  it("reports EMPTY for zero lines rather than a vacuous COMPLETE", () => {
    const out = computeEstimate(
      [],
      new Map(),
      { billedLaborRate: 150, jobFixedCost: 200 } as unknown as Parameters<typeof computeEstimate>[2],
      "HD",
    );
    expect(out.totalLineCount).toBe(0);
    expect(out.incompleteLineCount).toBe(0);
    // The old rule said COMPLETE here, because zero lines carry zero gaps. That is the exact
    // string Kyle photographed beside "0 lines · $200.00".
    expect(out.completenessSummary).toBe("EMPTY - no lines yet");
    expect(out.completenessSummary).not.toContain("COMPLETE");
  });
});

// ─── The finalize refusal still carries its reasons (Scope — do 1) ───────────────────────────

describe("a blocked finalize still explains itself", () => {
  const SUPPLIER = "HD";
  let draftId: string | null = null;

  beforeAll(async () => {
    const catalog = await prisma.priceBookAtomic.count({ where: { retiredAt: null } });
    expect(catalog, "needs the imported catalog").toBeGreaterThan(100);
  });

  afterAll(async () => {
    if (draftId) {
      await prisma.priceBookDraftLine.deleteMany({ where: { draftId } });
      await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId } });
      await prisma.priceBookDraftEstimate.deleteMany({ where: { id: draftId } });
    }
  });

  it("names the gap-carrying item verbatim, as a warning rather than a refusal", async () => {
    /*
      CF001 has neither a supplier price nor a labour unit basis — the exact shape of Kyle's
      sunroom draft, which once produced five 409s.

      The finding is unchanged and so is the thing this test was written to protect: the ITEM IS
      NAMED. A generic "cannot finalize" is what P022 found had made the refusal useless, and that
      is still true of a warning — the wording is what tells the tech what to do.

      What changed on 2026-08-20 is that it no longer blocks. Kyle: "Nothing should block me from
      completing the estimate."
    */
    const draft = await createDraft(prisma, { title: "P022 refusal fixture", supplierId: SUPPLIER });
    draftId = draft.id;
    await addLine(prisma, draft.id, { itemId: "CF001", quantity: 1, quantitySource: "COUNT" });

    const result = await finalizeDraft(prisma, draft.id, "customer");
    expect(result.finalized, "a gap no longer blocks").toBe(true);
    expect(result.warnings?.length ?? 0).toBeGreaterThan(0);
    expect((result.warnings ?? []).join(" ")).toContain("CF001");
  });
});

// ─── Feedback reaches a reader (Scope — do 3) ────────────────────────────────────────────────

describe("feedback is collected for the operator digest", () => {
  const MARK = "P022 digest fixture";

  afterAll(async () => {
    await prisma.systemEvent.deleteMany({ where: { source: "feedback", message: { contains: MARK } } });
  });

  it("splits recent from backlog on a 24-hour boundary", async () => {
    const fresh = await prisma.systemEvent.create({
      data: {
        level: "info", source: "feedback",
        message: `${MARK} — fresh`,
        detailsJson: JSON.stringify({ page: "/estimate-intake", userAgent: "test" }),
      },
    });
    const stale = await prisma.systemEvent.create({
      data: {
        level: "info", source: "feedback",
        message: `${MARK} — stale`,
        detailsJson: JSON.stringify({ page: "/leads", userAgent: "test" }),
        createdAt: new Date(Date.now() - 10 * 86400_000),
      },
    });

    const digest = await getFeedbackForDigest();
    expect(digest.recent.map((f) => f.message)).toContain(fresh.message);
    expect(digest.backlog.map((f) => f.message)).toContain(stale.message);
    // Nothing already filed is lost — the stale one appears somewhere.
    expect([...digest.recent, ...digest.backlog].map((f) => f.message)).toContain(stale.message);
  });

  it("carries the page but never the user agent or the raw details blob", async () => {
    await prisma.systemEvent.create({
      data: {
        level: "info", source: "feedback",
        message: `${MARK} — page check`,
        detailsJson: JSON.stringify({ page: "/estimate-intake", userAgent: "Mozilla/5.0 SECRETUA" }),
      },
    });
    const digest = await getFeedbackForDigest();
    const row = digest.recent.find((f) => f.message.includes("page check"));
    expect(row?.page).toBe("/estimate-intake");
    expect(JSON.stringify(digest)).not.toContain("SECRETUA");
  });

  it("survives a malformed details blob rather than throwing the whole digest", async () => {
    await prisma.systemEvent.create({
      data: { level: "info", source: "feedback", message: `${MARK} — bad json`, detailsJson: "{not json" },
    });
    const digest = await getFeedbackForDigest();
    expect(digest.recent.find((f) => f.message.includes("bad json"))?.page).toBeNull();
  });
});

// ─── The digest must actually send (the gate that would have made §3 a fix in name only) ─────

describe("the digest send gate", () => {
  it("no longer skips the email just because there were no calls", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(path.join(__dirname, "..", "src", "services", "dailySummary.ts"), "utf8");
    // The old gate was `if (data.totalCalls === 0) return;` — with the phone agent deferred that
    // is most days, so feedback attached to this digest would never have been sent.
    expect(src).toContain("data.totalCalls === 0 && !hasFeedback");
    expect(src).not.toMatch(/if \(data\.totalCalls === 0\) \{/);
  });
});

// ─── The refusal renders above the buttons (Scope — do 1) ────────────────────────────────────

/**
 * This used to assert against `finalizeMsg` and the "Finalize for customer" button on the intake
 * page. Both were removed on 2026-08-19 — Kyle: *"I have no idea what these buttons do but they
 * are unnecessary. Nothing should freeze the prices."*
 *
 * The PROPERTY they existed to protect did not go away with them. P019 and P022 both landed on
 * the same finding: a refusal rendered below the button that caused it reads as nothing having
 * happened, and the operator taps again. The act that can now be refused is sending or signing
 * from the presentation screen, so the assertion moves there rather than being deleted with the
 * feature it happened to be pointing at.
 */
describe("the presentation screen puts the refusal where the tap happened", () => {
  it("renders the refusal above the send and sign buttons", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.join(__dirname, "..", "client", "src", "pages", "PresentationPage.tsx"),
      "utf8",
    );
    const msgAt = src.indexOf("{problem.length > 0 && (");
    const buttonsAt = src.indexOf('Email to customer');
    expect(msgAt, "the refusal block was not found").toBeGreaterThan(0);
    expect(buttonsAt, "the send button was not found").toBeGreaterThan(0);
    expect(msgAt, "the refusal must render ABOVE the buttons").toBeLessThan(buttonsAt);
  });

  it("shows the engine's reasons verbatim rather than one summary line", async () => {
    // The wording is the part that tells the tech which line is not ready. Collapsing several
    // refusals into "could not finalize" is what P019 found had trained the operator to ignore it.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.join(__dirname, "..", "client", "src", "pages", "PresentationPage.tsx"),
      "utf8",
    );
    expect(src).toContain("body?.reasons");
    expect(src).toContain("problem.map(");
  });
});
