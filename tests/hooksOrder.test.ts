/**
 * Rules-of-hooks, as a test — because React #310 has now shipped three times.
 *
 * The pattern is always the same and always compiles: a hook placed after an early return runs on
 * some renders and not others, React sees the hook count change, and the screen unmounts. It took
 * down /visits/:id and /jobs on 2026-08-22 (buildOptionMutation below the loading guard), nearly
 * shipped in PresentationPage on 2026-08-21 (the sticky-footer hook below four guards — written,
 * built green, caught on re-read), and TotalsBar carries a comment for the same trap.
 *
 * TypeScript is happy with all three. This is the check that is not.
 *
 * Run through eslint's own API rather than a spawned CLI, so a missing binary fails loudly as a
 * module error instead of silently passing an empty result.
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

describe("no hook is ever called conditionally", () => {
  // 60s: this lints ~80 files through eslint's API, and under the full suite's parallel load it
  // can exceed the 5s default — which failed it as a timeout, not as a finding (2026-08-22).
  it("rules-of-hooks is clean across the whole client", { timeout: 60_000 }, async () => {
    const clientDir = path.resolve(__dirname, "../client");
    const req = createRequire(path.join(clientDir, "package.json"));
    const { ESLint } = req("eslint");
    const parser = req("@typescript-eslint/parser");
    const reactHooks = req("eslint-plugin-react-hooks");

    const eslint = new ESLint({
      cwd: clientDir,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ["src/**/*.tsx", "src/**/*.ts"],
          languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true } } },
          plugins: { "react-hooks": reactHooks },
          rules: { "react-hooks/rules-of-hooks": "error" },
        },
      ],
    });

    const results = await eslint.lintFiles(["src/**/*.tsx", "src/**/*.ts"]);

    // The presence half: an empty file list would make the absence assertion below vacuous.
    expect(results.length).toBeGreaterThan(50);

    const problems = results
      .flatMap((r) =>
        r.messages.map((m) => `${path.relative(clientDir, r.filePath)}:${m.line} ${m.message}`),
      )
      .join("\n");
    expect(problems, `conditional hook(s) found:\n${problems}`).toBe("");
  });
});
