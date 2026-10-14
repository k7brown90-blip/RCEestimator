import { describe, expect, it } from "vitest";
import { emailReason, presentDecision, presentFooter, signNowReason } from "./presentIssue";
import type { DraftLifecycle } from "../../../shared/draftLifecycle";

/*
  The presentation screen's "Email to customer" / "Sign now" used to issue on EVERY press — a new
  revision each time on an unchanged draft (2026-10-08 audit §5). The decision now reads the
  server's lifecycle and is pinned here without a DOM.
*/

const base = (over: Partial<DraftLifecycle> = {}): DraftLifecycle => ({
  status: "finalized",
  issued: { estimateId: "est-1", number: "2026-1098", revision: 1, status: "sent", signedAt: null, issuedAt: "2026-10-01T12:00:00.000Z", validDays: 30, figuresKey: "k", archived: false, customerUrl: null },
  hasUnsavedChanges: false,
  reviseReason: null,
  deleteReason: "Estimate 2026-1098 was issued from this quote, so the quote is its record and stays.",
  copyReason: null,
  ...over,
});

describe("presentDecision", () => {
  it("no estimate yet: issue a first one; both buttons live; the footer says it freezes prices", () => {
    const d = presentDecision({ status: "draft", issued: null, hasUnsavedChanges: false, reviseReason: null, deleteReason: null, copyReason: null });
    expect(d).toEqual({ kind: "issue", revises: null });
    expect(signNowReason(d)).toBeNull();
    expect(emailReason(d)).toBeNull();
    expect(presentFooter(d)).toContain("records the estimate and freezes its prices");
  });

  it("nothing sent is also an issue (lifecycle missing — an older server)", () => {
    expect(presentDecision(undefined)).toEqual({ kind: "issue", revises: null });
  });

  it("issued and UNCHANGED: reuse the estimate that exists — no new revision", () => {
    const d = presentDecision(base());
    expect(d).toEqual({ kind: "reuse", estimateId: "est-1", number: "2026-1098", revision: 1, signed: false, archived: false, changedSince: false });
    expect(signNowReason(d)).toBeNull();
    expect(presentFooter(d)).toBe("Estimate 2026-1098 rev 1 is already recorded and nothing has changed since — these use it as it stands.");
  });

  it("issued and EDITED since: issue — the server revises; the footer names the revision it will make", () => {
    const d = presentDecision(base({ status: "draft", hasUnsavedChanges: true }));
    expect(d).toEqual({ kind: "issue", revises: { number: "2026-1098", revision: 1 } });
    expect(presentFooter(d)).toContain("as revision 2 (same number)");
  });

  it("SIGNED: reused as it stands; Sign now AND Email are greyed with why (the send refuses a signed estimate)", () => {
    const d = presentDecision(base({ issued: { ...base().issued!, status: "signed", signedAt: "2026-10-08T12:00:00.000Z" } }));
    expect(d.kind).toBe("reuse");
    expect(signNowReason(d)).toBe("Estimate 2026-1098 is already signed — there is nothing to sign.");
    expect(emailReason(d)).toBe("Estimate 2026-1098 is already signed — there is no estimate email left to send.");
  });

  it("SIGNED with draft edits: still reused, never re-issued from here (the office's Revise is the path) - and the footer does not say nothing changed", () => {
    const d = presentDecision(base({ status: "draft", hasUnsavedChanges: true, issued: { ...base().issued!, status: "signed", signedAt: "2026-10-08T12:00:00.000Z" } }));
    expect(d.kind).toBe("reuse");
    expect(presentFooter(d)).not.toContain("nothing has changed");
    expect(presentFooter(d)).toContain("edited since");
  });

  it("ARCHIVED and unchanged: reused; Email is greyed with the unarchive-first sentence", () => {
    const d = presentDecision(base({ issued: { ...base().issued!, archived: true } }));
    expect(d.kind).toBe("reuse");
    expect(emailReason(d)).toBe("Estimate 2026-1098 is archived — unarchive it (Estimates page) first, then it can be emailed.");
    expect(signNowReason(d)).toBeNull();
  });

  it("LOST: both buttons blocked with the server's reopen-first sentence", () => {
    const reason = "Estimate 2026-1098 is marked lost — reopen it before changing or issuing it again.";
    const d = presentDecision(base({ issued: { ...base().issued!, status: "lost" }, reviseReason: reason }));
    expect(d).toEqual({ kind: "blocked", reason });
    expect(signNowReason(d)).toBe(reason);
    expect(emailReason(d)).toBe(reason);
    expect(presentFooter(d)).toBe(reason);
  });
});
