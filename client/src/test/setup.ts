/**
 * Vitest setup for the client's render-test project (Phase A, 2026-09-20 "drawers
 * and tab purpose" plan — the safety net before any page gets rewritten).
 *
 * Runs once per test FILE (vitest's setupFiles semantics), so registering
 * `afterEach` here reaches every test in every file without each one having to
 * import `cleanup` itself.
 */

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

afterEach(() => {
  cleanup();
  // CollapsibleCard remembers open/closed per card id in localStorage
  // (rce.card.<id>) — a leftover key from one test would silently change
  // whether the next test's card starts open or folded.
  try {
    localStorage.clear();
  } catch {
    // Not available (or blocked) in this environment — nothing to clear.
  }
});
