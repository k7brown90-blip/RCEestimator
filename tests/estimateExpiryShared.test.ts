/**
 * PUNCHLIST A10/H4 (2026-09-22): `isPastValidity` now lives in shared/estimateExpiry.ts so the
 * CRM client (EstimatesPage.tsx) and the server (estimateExpiry.ts's sweep, the signature
 * refusal, reopen) read the exact same arithmetic instead of the client keeping its own
 * `sentAt`-based copy. This pins the shared function directly, and that the server module
 * re-exports the identical function rather than a second implementation.
 */

import { describe, expect, it } from "vitest";
import { isPastValidity as sharedIsPastValidity } from "../shared/estimateExpiry";
import { isPastValidity as serverIsPastValidity } from "../src/services/estimateExpiry";

const DAY = 86_400_000;

describe("shared/estimateExpiry isPastValidity", () => {
  it("is anchored on createdAt, never sentAt — it has no sentAt field to read", () => {
    const now = Date.now();
    const est = { createdAt: new Date(now - 31 * DAY), validDays: 30 };
    expect(sharedIsPastValidity(est, now)).toBe(true);
    expect(sharedIsPastValidity({ ...est, createdAt: new Date(now - 29 * DAY) }, now)).toBe(false);
  });

  it("accepts a serialized (string) createdAt the same as a Date — the shape the client's JSON payload carries", () => {
    const now = Date.now();
    const isoOld = new Date(now - 31 * DAY).toISOString();
    const isoRecent = new Date(now - 5 * DAY).toISOString();
    expect(sharedIsPastValidity({ createdAt: isoOld, validDays: 30 }, now)).toBe(true);
    expect(sharedIsPastValidity({ createdAt: isoRecent, validDays: 30 }, now)).toBe(false);
  });

  it("the server module re-exports the SAME function, not a second implementation", () => {
    expect(serverIsPastValidity).toBe(sharedIsPastValidity);
  });
});
