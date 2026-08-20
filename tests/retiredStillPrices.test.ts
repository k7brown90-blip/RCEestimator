/**
 * Retire means "do not offer it". It has never meant "do not price it".
 *
 * ── WHAT HAPPENED ──────────────────────────────────────────────────────────────────────────────
 *
 * On 2026-08-20 Kyle renamed 39 rows in his book — `THHN/THWN-2 Building Wire, #14 AWG` became
 * `THHN, #14 AWG`, and so on. Keys are slugified from names, so the old keys retired and new ones
 * took their place. That part worked exactly as designed.
 *
 * `loadCatalogAtSupplier` then filtered `retiredAt: null` for every caller, including the one that
 * prices a draft. His live EV Charger draft referenced two of the old keys, so after the import
 * those lines reported ATOMIC_NOT_FOUND and priced at ZERO — and the draft fell from $1662.14 to
 * $811.19 while both lines were still sitting on the screen.
 *
 * That is the worst shape a pricing bug can take: the work is visibly there and contributes
 * nothing. Nobody re-reads a total they have already seen.
 *
 * "Retire, never delete" existed to prevent precisely this. Retirement takes an item out of
 * browse, out of search and out of what the AI may propose — all different queries, all still
 * filtered. It must not take the price off a line somebody already added.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(
  path.resolve(__dirname, "..", "src/services/atomicEstimateService.ts"),
  "utf8",
);

function loaderBody(): string {
  const at = service.indexOf("export async function loadCatalogAtSupplier");
  expect(at, "loadCatalogAtSupplier not found — this test is checking nothing").toBeGreaterThan(-1);
  return service.slice(at, at + 2200);
}

describe("pricing a draft", () => {
  it("includes the items the draft already references, retired or not", () => {
    const body = loaderBody();
    expect(body).toContain("referencedItemIds");
    expect(body).toMatch(/OR: \[\{ retiredAt: null \}, \{ itemId: \{ in: referencedItemIds \} \}\]/);
  });

  it("still filters retired items when nothing is referenced", () => {
    // The default is unchanged, so browse and search — which pass no ids — behave as before.
    // A loader that returned everything to everyone would put retired rows back on the cards.
    const body = loaderBody();
    expect(body).toContain("{ retiredAt: null }");
    expect(body).toMatch(/referencedItemIds\.length > 0/);
  });

  it("computeDraft passes the draft's own item ids", () => {
    // The fix is worthless if the one caller that matters does not opt in.
    const at = service.indexOf("export async function computeDraft");
    const body = service.slice(at, at + 1400);
    expect(body).toContain("draft.lines.map((l) => l.itemId)");
  });
});
