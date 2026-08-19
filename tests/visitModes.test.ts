/**
 * The client's visit modes must be the server's visit modes.
 *
 * ── THE BUG ────────────────────────────────────────────────────────────────────────────────────
 *
 * "Schedule a visit" on the account page sent a mode of `onsite`. The server accepts only
 * `new_construction | remodel | service_diagnostic | maintenance`, so every press answered
 * `400 {"error":"Validation failed"}`. It had never worked.
 *
 * Two things let it survive:
 *
 *   1. `api.createVisit` typed the mode as `string`, so the compiler had nothing to object to.
 *   2. The production error handler returns details only outside production, so the 400 said
 *      "Validation failed" and never named the field. Kyle reported it as an unexplained error
 *      and it took a round trip to identify.
 *
 * The union in `client/src/lib/api.ts` fixes (1) for anything written from now on. This fixes the
 * next step: the union and the server's zod enum are two lists of the same thing in two files, and
 * a list duplicated is a list that drifts.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP = path.resolve(__dirname, "..");

/** The enum in `app.post("/visits")`. Read from source so the test cannot drift from the route. */
function serverModes(): string[] {
  const src = fs.readFileSync(path.join(APP, "src/app.ts"), "utf8");
  const at = src.indexOf('app.post("/visits"');
  expect(at, "POST /visits route not found — this test is checking nothing").toBeGreaterThan(-1);
  const block = src.slice(at, at + 800);
  const m = /mode:\s*z\.enum\(\[([^\]]+)\]\)/.exec(block);
  expect(m, "mode enum not found on POST /visits").not.toBeNull();
  return [...(m as RegExpExecArray)[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function clientModes(): string[] {
  const src = fs.readFileSync(path.join(APP, "client/src/lib/api.ts"), "utf8");
  const m = /export const VISIT_MODES = \[([^\]]+)\]/.exec(src);
  expect(m, "VISIT_MODES not found in the client api module").not.toBeNull();
  return [...(m as RegExpExecArray)[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function clientFiles(dir: string): string[] {
  return fs.readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) return name === "node_modules" ? [] : clientFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

/**
 * Comment lines are skipped.
 *
 * The doc comment explaining this very bug has to quote the bad value to explain it, and the first
 * version of this test dutifully reported the explanation as the defect.
 */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

describe("visit modes", () => {
  it("the client offers exactly what the server accepts", () => {
    const server = serverModes();
    expect(server.length).toBeGreaterThan(0);
    expect([...clientModes()].sort()).toEqual([...server].sort());
  });

  it("every mode the UI sends is one the server accepts", () => {
    // Scans the pages rather than trusting the type, because the type WAS `string` when this
    // happened, and a future `as string` would slip past the compiler the same way.
    const server = new Set(serverModes());
    const bad: string[] = [];

    for (const file of clientFiles(path.join(APP, "client/src"))) {
      const rel = path.relative(APP, file).split(path.sep).join("/");
      fs.readFileSync(file, "utf8").split("\n").forEach((line, n) => {
        if (isComment(line)) return;
        for (const m of line.matchAll(/\bmode:\s*"([^"]+)"/g)) {
          if (!server.has(m[1])) bad.push(`${rel}:${n + 1}  mode: "${m[1]}"`);
        }
      });
    }

    expect(
      bad.join("\n"),
      `Visit mode must be one of: ${[...server].join(", ")}. An invalid one was sent for weeks and ` +
        "the button answered 400 every time it was pressed.",
    ).toBe("");
  });
});
