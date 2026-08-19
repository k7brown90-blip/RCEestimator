/**
 * No two queries may cache different response shapes under the same key.
 *
 * ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────────────────────────
 *
 * 2026-08-19, from Kyle's own testing: *"I expected to go back to the test account but am now
 * getting at error."* The account page went blank with
 * `TypeError: Cannot read properties of undefined (reading 'filter')`.
 *
 * Two pages cached under `["account", accountId]` while calling different endpoints:
 *
 *   AccountDetailPage    -> /accounts/:id/summary  -> { account, properties, jobs, totals, ... }
 *   PriceBookIntakePage  -> /accounts/:id          -> { id, name, properties, ... }   (no `jobs`)
 *
 * Attaching a draft to an account stored the second shape. Opening that account's page then read
 * it straight back out of the cache — `summary` was truthy, so the `if (!summary)` guard passed,
 * and `summary.jobs.filter(...)` threw. No request was made, so there was nothing in the network
 * trace to look at either.
 *
 * WHY A TEST AND NOT JUST THE FIX. Neither file was wrong on its own. `["account", accountId]` is
 * the obvious key in both, and the collision was invisible unless you happened to have both files
 * open. That is exactly the sort of defect that reappears the next time someone adds a page about
 * accounts — so the invariant gets checked mechanically instead of remembered.
 *
 * The rule: **a query key names an ENDPOINT, not a subject.** Two different responses never share
 * one, however much they are "about" the same thing.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const CLIENT_SRC = path.resolve(__dirname, "../client/src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * A comparable shape for a whole key array — not just its first element.
 *
 * The first version of this test compared `["leads", …]` to `["leads", …]` and reported a
 * collision. It was wrong: the real keys are `["leads", { pipeline: "open" }]`,
 * `["leads", { leadId }]` and `["leads", { pipeline, statusFilter }]`, which react-query hashes
 * structurally and keeps apart. **The test was wrong, not the code** — and a guard that cries
 * wolf on correct code gets deleted, taking the real check with it.
 *
 * So: string and numeric literals compare by value, object literals by their property NAMES
 * (which is what separates the three leads queries), and anything else collapses to `<expr>`.
 * That last choice is deliberately conservative — `["account", accountId]` in two files must
 * still read as the same key, because it is.
 */
function keySignature(arr: ts.ArrayLiteralExpression, src: ts.SourceFile): string {
  return arr.elements
    .map((el) => {
      if (ts.isStringLiteral(el)) return JSON.stringify(el.text);
      if (ts.isNumericLiteral(el)) return el.text;
      if (ts.isObjectLiteralExpression(el)) {
        const names = el.properties
          .map((p) => (p.name ? p.name.getText(src) : "…"))
          .sort()
          .join(",");
        return `{${names}}`;
      }
      return "<expr>";
    })
    .join("|");
}

interface Usage {
  key: string;
  queryFn: string;
  where: string;
}

/** Every `useQuery({ queryKey: [...], queryFn: ... })` in the client, as (key, fn) pairs. */
function collectUsages(): Usage[] {
  const found: Usage[] = [];

  for (const file of sourceFiles(CLIENT_SRC)) {
    const text = fs.readFileSync(file, "utf8");
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    const rel = path.relative(CLIENT_SRC, file).replace(/\\/g, "/");

    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const prop = (name: string) =>
          node.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name.getText(src) === name,
          );

        const keyProp = prop("queryKey");
        const fnProp = prop("queryFn");

        if (keyProp && fnProp && ts.isArrayLiteralExpression(keyProp.initializer)) {
          const first = keyProp.initializer.elements[0];
          if (first && ts.isStringLiteral(first)) {
            found.push({
              key: keySignature(keyProp.initializer, src),
              // Normalised so formatting differences don't read as different functions.
              queryFn: fnProp.initializer.getText(src).replace(/\s+/g, " "),
              where: `${rel}:${src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1}`,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
  }

  return found;
}

describe("react-query cache keys", () => {
  it("finds the queries (guard against the scan silently matching nothing)", () => {
    // A scanner that matches zero call sites would pass every assertion below while checking
    // nothing at all — the failure mode that makes a green test worse than no test.
    const usages = collectUsages();
    expect(usages.length).toBeGreaterThan(10);
    expect(usages.map((u) => u.key)).toContain('"accounts"');
  });

  it("never caches two different responses under one key", () => {
    const byKey = new Map<string, Usage[]>();
    for (const u of collectUsages()) {
      byKey.set(u.key, [...(byKey.get(u.key) ?? []), u]);
    }

    const collisions: string[] = [];
    for (const [key, usages] of byKey) {
      const distinct = new Set(usages.map((u) => u.queryFn));
      if (distinct.size > 1) {
        collisions.push(
          `["${key}", …] is fetched ${distinct.size} different ways:\n` +
            usages.map((u) => `      ${u.where}  ${u.queryFn}`).join("\n"),
        );
      }
    }

    expect(
      collisions.join("\n\n"),
      "Two queries share a cache key but return different shapes. Whichever runs last wins the " +
        "cache, and the other page reads a response it was not written for. Give the key the name " +
        "of the endpoint.",
    ).toBe("");
  });

  it("keeps the account summary on its own key", () => {
    // The specific collision that crashed the account page. Pinned by name so a future edit that
    // "tidies" the key back to ["account", id] fails loudly rather than blanking the screen.
    const usages = collectUsages();
    const summary = usages.find((u) => u.queryFn.includes("accountSummary"));
    const plain = usages.find((u) => u.queryFn.includes("api.account(") );

    expect(summary?.key).toBe('"account-summary"|<expr>');
    expect(plain?.key).toBe('"account"|<expr>');
  });
});
