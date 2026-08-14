/**
 * P012 — `/mcp` must fail CLOSED when its bearer token is unset.
 *
 * P011 left the endpoint protected by configuration rather than by code: `mcpAuth` called
 * `next()` when MCP_BEARER_TOKEN was missing, so clearing one Railway variable would have
 * silently exposed the AI's tool surface to anyone who could reach the public domain.
 *
 * This asserts the code shape rather than booting the app, because the middleware closes over
 * `process.env.MCP_BEARER_TOKEN` at module load — a runtime test would need a separate module
 * registry per case, which tests the harness more than the guard.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const appSrc = readFileSync(path.join(__dirname, "..", "src", "app.ts"), "utf8");

/** The mcpAuth middleware body. */
const mcpAuthBlock = (() => {
  const start = appSrc.indexOf("const mcpAuth: express.RequestHandler");
  const end = appSrc.indexOf('app.post("/mcp"', start);
  expect(start, "mcpAuth middleware not found").toBeGreaterThan(-1);
  return appSrc.slice(start, end);
})();

const codeOnly = mcpAuthBlock
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
  .join("\n");

describe("/mcp fails closed", () => {
  it("refuses with 503 when the token is unset — never calls next()", () => {
    expect(codeOnly).toMatch(/if\s*\(\s*!mcpBearerToken\s*\)/);
    expect(codeOnly).toContain("503");
    // The refusal must return before reaching next(). Assert the unset branch has no next().
    const unsetBranch = codeOnly.slice(
      codeOnly.indexOf("if (!mcpBearerToken)"),
      codeOnly.indexOf("const auth")
    );
    expect(unsetBranch).not.toContain("next()");
    expect(unsetBranch).toContain("return");
  });

  it("logs the refusal so an unconfigured endpoint is visible, not silent", () => {
    expect(codeOnly).toMatch(/console\.(error|warn)\(/);
    expect(mcpAuthBlock).toContain("MCP_BEARER_TOKEN");
  });

  it("still 401s a wrong token when configured", () => {
    expect(codeOnly).toMatch(/auth\s*!==\s*`Bearer \$\{mcpBearerToken\}`/);
    expect(codeOnly).toContain("401");
  });

  it("only reaches next() after both checks pass", () => {
    const idxUnset = codeOnly.indexOf("!mcpBearerToken");
    const idx401 = codeOnly.indexOf("401");
    const idxNext = codeOnly.lastIndexOf("next()");
    expect(idxUnset).toBeGreaterThan(-1);
    expect(idxNext).toBeGreaterThan(idx401);
    expect(idxNext).toBeGreaterThan(idxUnset);
  });
});
