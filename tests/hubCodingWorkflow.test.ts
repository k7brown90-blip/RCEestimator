/**
 * W2-E: .github/workflows/hub-coding.yml is a PUBLIC repository's workflow that runs Claude Code on a request typed in the CRM.
 * Its safety does not live in the CRM, it lives in this file, so it is pinned here as a test:
 *
 *   - the request text and the payload never reach env:, with:, run: or the log (GitHub prints env and `uses:` inputs publicly) - the ONE
 *     expression that reads client_payload is the concurrency group key;
 *   - the Claude step is the subscription token only (no Anthropic API key, no ANTHROPIC_ variable), has no env of its own, a FIXED prompt, a pinned
 *     action, and tools that cannot push, call the network or touch .github/;
 *   - fixed post-steps (not Claude) that do not trust the .git Claude left: they restore the git config saved before Claude ran, drop hooks, run git
 *     with hooks / fsmonitor / credential helpers off, refuse a branch that is not hub/coding-*, a diff that touches .github/ or .env, and a secret in the
 *     commits or the reply; the step that holds the secrets runs no git, the step that runs git and gh holds only GITHUB_TOKEN;
 *   - Claude's tools cannot write or read through git (no git log/diff/show: --output and --no-index) and cannot write .git;
 *   - the reply names its run on its first line (the CRM closes only that run), and reply.md is posted only when the scan cleared it;
 *   - the reply is built by jq from files, never by string-joining JSON.
 *
 * The YAML parser is the client's js-yaml (the root suite already reads client/node_modules for eslint, tests/hooksOrder.test.ts; CI installs the client first).
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { GITHUB_DISPATCH_EVENT_TYPE } from "../src/services/hubCoding";

const FILE = path.resolve(__dirname, "../.github/workflows/hub-coding.yml");
const raw = fs.readFileSync(FILE, "utf8");
const yaml = createRequire(path.resolve(__dirname, "../client/package.json"))("js-yaml") as { load: (text: string) => unknown };

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, string> };
const doc = yaml.load(raw) as {
  on: { repository_dispatch: { types: string[] } };
  concurrency: { group: string; "cancel-in-progress": boolean; queue?: string };
  permissions: Record<string, string>;
  jobs: { code: { "runs-on": string; "timeout-minutes": number; env?: unknown; steps: Step[] } };
};
const steps = doc.jobs.code.steps;
const stepNamed = (fragment: string): Step => {
  const s = steps.find((x) => (x.name ?? "").includes(fragment));
  if (!s) throw new Error(`no step named like "${fragment}"`);
  return s;
};
const claude = steps.find((s) => (s.uses ?? "").startsWith("anthropics/claude-code-action@"))!;

/** Every [path, string] leaf of the parsed workflow. */
function leaves(value: unknown, at: string[] = []): Array<[string, string]> {
  if (typeof value === "string") return [[at.join("."), value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, [...at, String(i)]));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => leaves(v, [...at, k]));
  return [];
}

describe("hub-coding.yml: when it runs", () => {
  it("runs only on the repository_dispatch event the CRM sends, one at a time per conversation, with a hard time limit", () => {
    expect(doc.on).toEqual({ repository_dispatch: { types: [GITHUB_DISPATCH_EVENT_TYPE] } });
    expect(doc.concurrency.group).toBe("hub-coding-${{ github.event.client_payload.thread_id }}");
    expect(doc.concurrency["cancel-in-progress"]).toBe(false);
    expect(doc.concurrency.queue).toBe("max"); // valid only with cancel-in-progress false (GitHub changelog 2026-05-07)
    expect(doc.jobs.code["timeout-minutes"]).toBe(55);
    expect(doc.jobs.code["runs-on"]).toBe("ubuntu-latest");
    expect(doc.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    expect(doc.jobs.code.env).toBeUndefined(); // no job-level env: a secret there would reach Claude's Bash
  });
});

describe("hub-coding.yml: nothing from the request reaches the public log", () => {
  it("client_payload is read by the concurrency group key and nowhere else (never in env:, with:, run: or a name)", () => {
    const readers = leaves(doc).filter(([, v]) => v.includes("client_payload")).map(([p]) => p);
    expect(readers.filter((p) => p !== "concurrency.group")).toEqual(
      // The jq programs read the event FILE ("$GITHUB_EVENT_PATH"), which is not an expression; they sit in run: scripts and are the only other mention.
      readers.filter((p) => /^jobs\.code\.steps\.\d+\.run$/.test(p)),
    );
    for (const s of steps) {
      for (const [k, v] of Object.entries(s.env ?? {})) expect(`${k}=${v}`, `${s.name} env`).not.toContain("client_payload");
      for (const [k, v] of Object.entries(s.with ?? {})) expect(`${k}=${v}`, `${s.name} with`).not.toContain("client_payload");
    }
  });

  it("no run: script contains a ${{ expression at all (no script injection), and quotes the ids it uses", () => {
    for (const s of steps.filter((x) => x.run)) {
      expect(s.run, s.name).not.toContain("${{");
      expect(s.run, s.name).not.toMatch(/set -x|curl\s+(-\w*v|--verbose)|\bcat\b[^\n]*\.hub-context|echo[^\n]*(request|thread|reply)\.(txt|json|md)|echo[^\n]*\$RCE_CRM_CODING_KEY|echo[^\n]*\$GH_TOKEN/);
    }
  });

  it("the ids are checked against ^[A-Za-z0-9_-]{1,64}$ BEFORE anything is written to GITHUB_ENV, and the request text goes event file -> file", () => {
    const validate = stepNamed("Check the request ids");
    expect(validate.run).toContain("^[A-Za-z0-9_-]{1,64}$");
    expect(validate.run).toContain("exit 1");
    const firstEnvWrite = steps.findIndex((s) => (s.run ?? "").includes("GITHUB_ENV"));
    expect(steps[firstEnvWrite]).toBe(validate);
    expect(validate.run!.indexOf("exit 1")).toBeLessThan(validate.run!.indexOf("GITHUB_ENV"));
    expect(stepNamed("Write the request").run).toContain('"$GITHUB_EVENT_PATH" > .hub-context/request.txt');
    expect(stepNamed("Write the request").run).toContain("-o .hub-context/thread.json");
    expect(stepNamed("Make the work branch").run).toContain('git checkout -b "hub/coding-$RUN_ID"');
    expect(stepNamed("Make the work branch").run).toContain(".hub-context/");
  });
});

describe("hub-coding.yml: the Claude step", () => {
  it("is the subscription token only: no Anthropic API key and no ANTHROPIC_ variable anywhere in the file", () => {
    expect(raw).not.toMatch(/anthropic_api_key/i);
    expect(raw).not.toMatch(/ANTHROPIC_/);
    expect(claude.with!.claude_code_oauth_token).toBe("${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(raw).not.toMatch(/--bare/);
  });

  it("pins the action to a commit, keeps the full output off, and its env is ONE fixed scrub switch (so no secret, no payload)", () => {
    expect(claude.uses).toMatch(/^anthropics\/claude-code-action@[0-9a-f]{40}$/);
    expect(claude.with!.show_full_output).toBe("false");
    expect(claude.with!.github_token).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(claude.env).toEqual({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
    for (const [k, v] of Object.entries(claude.with!)) {
      if (k === "claude_code_oauth_token" || k === "github_token") continue;
      expect(`${k}: ${v}`, k).not.toContain("${{");
    }
  });

  it("the prompt is FIXED text: no expression, and it says the repository is public, never to push, never to touch .github/, how to commit and where to write the reply", () => {
    const prompt = claude.with!.prompt;
    expect(prompt).not.toContain("${{");
    expect(prompt).not.toMatch(/\$\w+|\$\{/);
    for (const needle of [
      "THIS REPOSITORY IS PUBLIC", ".hub-context/request.txt", ".hub-context/thread.json", ".hub-context/reply.md",
      "Do not push", ".github/", "Co-Authored-By: Claude <noreply@anthropic.com>", "sentence case", "One tool for one task",
    ]) expect(prompt, needle).toContain(needle);
  });

  it("claude_args: default permission mode, a turn cap, only local file and read-only git tools allowed, and push / gh / network / .github disallowed", () => {
    const args = claude.with!.claude_args;
    expect(args).toContain("--permission-mode default");
    expect(args).toMatch(/--max-turns \d+/);
    const allowed = /--allowedTools "([^"]+)"/.exec(args)![1].split(",");
    expect(allowed).toEqual(expect.arrayContaining(["Read", "Edit", "Write", "Glob", "Grep", "Bash(git add:*)", "Bash(git commit:*)"]));
    // Exactly the local-edit tools and read-only git, plus add and commit. Not npm or node (a script would run with the step's environment,
    // which holds the subscription token), not a bare Bash, not push, gh or the network.
    // git log / diff / show are NOT here: --output= writes any file and --no-index reads any file, and a prefix rule cannot exclude a flag.
    const OK = new Set(["Read", "Edit", "Write", "Glob", "Grep", "Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)"]);
    for (const tool of allowed) expect(OK.has(tool), tool).toBe(true);
    const disallowed = /--disallowedTools "([^"]+)"/.exec(args)![1].split(",");
    for (const must of ["Bash(git push:*)", "Bash(gh:*)", "Bash(curl:*)", "Bash(wget:*)", "WebFetch", "WebSearch", "Edit(.github/**)", "Write(.github/**)", "Read(.git/**)",
      "Edit(.git/**)", "Write(.git/**)", "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)", "Bash(git config:*)"]) {
      expect(disallowed, must).toContain(must);
    }
  });
});

describe("hub-coding.yml: the fixed steps Claude cannot influence", () => {
  const check = stepNamed("Check what Claude left");
  const scan = stepNamed("Scan for leaked secrets");
  const push = stepNamed("Push the branch");
  const reply = stepNamed("Reply in the conversation");
  const GIT_OFF = "-c core.hooksPath=/dev/null -c core.fsmonitor=false -c credential.helper= -c diff.external=";

  /** Lines of a script that run git without going through the g() wrapper (comments, echo and the wrapper's own definition excluded). */
  const bareGit = (script: string): string[] =>
    script.split("\n").filter((l) => /\bgit\b/.test(l) && !/^\s*#/.test(l) && !/^\s*g\(\) \{/.test(l) && !/echo|printf|Refusing|grep -qE|x-access-token/.test(l)
      && !l.includes("git-config.pre") && !l.includes(".git/hooks") && !l.includes(".git/config"));

  it("the config is saved before Claude runs, and the fixed steps restore it and drop hooks BEFORE any git command", () => {
    const branch = stepNamed("Make the work branch");
    expect(branch.run).toContain('cp .git/config "$RUNNER_TEMP/git-config.pre"');
    expect(steps.indexOf(branch)).toBeLessThan(steps.indexOf(claude));
    const run = check.run!;
    expect(run).toContain('cp "$RUNNER_TEMP/git-config.pre" .git/config');
    expect(run).toContain("find .git/hooks -type f ! -name '*.sample' -delete");
    expect(run.indexOf("git-config.pre")).toBeLessThan(run.indexOf("git -c"));
    expect(run.indexOf("find .git/hooks")).toBeLessThan(run.indexOf("g()"));
    for (const s of [check, push]) {
      expect(s.run, s.name).toContain(GIT_OFF);
      expect(bareGit(s.run!).filter((l) => !l.includes("git -c")), s.name).toEqual([]);
    }
    expect(check.run).toContain("g log -p --no-textconv --no-ext-diff origin/main..HEAD");
  });

  it("the check step always runs, refuses a branch that is not hub/coding-<id>, and refuses .github/, .gitattributes and .env changes", () => {
    expect(check.if).toBe("always()");
    expect(check.run).toContain('BRANCH="hub/coding-$RUN_ID"');
    expect(check.run).toContain("Refusing: the checkout is not on $BRANCH.");
    expect(check.run).toContain("g diff --name-only origin/main...HEAD");
    expect(check.run).toMatch(/\\\.github\//);
    expect(check.run).toMatch(/\\\.gitattributes/);
    expect(check.run).toMatch(/\\\.env/);
    expect(check.env).toBeUndefined();
  });

  it("the secret scan holds the secrets and runs NO git and NO gh; the push step holds only GITHUB_TOKEN", () => {
    expect(scan.if).toBe("always()");
    expect(scan.run).not.toMatch(/\bgit\b|\bgh\b/);
    expect(scan.run).toContain("grep -qF --");
    expect(Object.keys(scan.env!).sort()).toEqual(["CHECK_OUTCOME", "CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN", "RCE_CRM_CODING_KEY"]);
    expect(push.env).toEqual({ GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" });
    expect(push.run).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN|RCE_CRM_CODING_KEY/);
    // The reply is cleared BEFORE the commit checks and before any no-commit exit, so it is scanned even when Claude made no commit.
    const run = scan.run!;
    expect(run.indexOf("hit .hub-context/reply.md")).toBeGreaterThan(-1);
    expect(run.indexOf("hit .hub-context/reply.md")).toBeLessThan(run.indexOf('echo "REPLY_SAFE=1"'));
    expect(run.indexOf('echo "REPLY_SAFE=1"')).toBeLessThan(run.indexOf('hit "$RUNNER_TEMP/branch.patch"'));
    expect(run.indexOf('hit "$RUNNER_TEMP/branch.patch"')).toBeLessThan(run.indexOf('echo "SCAN_OK=1"'));
  });

  it("the push step runs only after a clean check and scan, only ever pushes hub/coding-<id>, never main, never forced, with a FIXED pull request body", () => {
    expect(push.if).toBe("${{ always() && steps.check.outcome == 'success' && steps.scan.outcome == 'success' }}");
    expect(push.run).toContain('BRANCH="hub/coding-$RUN_ID"');
    expect(push.run).toContain("Refusing: the checkout is not on $BRANCH.");
    const pushes = push.run!.split("\n").filter((l) => /\bg push\b|\bgit push\b/.test(l));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('"HEAD:refs/heads/$BRANCH"');
    expect(pushes[0]).toContain("--no-verify");
    expect(raw).not.toMatch(/\b(g|git) push[^\n]*\bmain\b/);
    expect(raw).not.toMatch(/--force|-f\b.*git push|git push.*--force/);
    expect(push.run).toContain('gh pr create --repo "$GITHUB_REPOSITORY" --base main --head "$BRANCH"');
    expect(push.run).toContain('--body "Claude Code run $RUN_ID. Requested from the RCE CRM."'); // FIXED body: no request text
    expect(push.run).not.toContain("remote set-url"); // the token is never written into .git/config
  });

  it("the reply step always runs, builds its JSON with jq from files and variables (never by joining strings), posts through the Coding key, and prints nothing", () => {
    expect(reply.if).toBe("always()");
    expect(reply.run).toContain("jq -n --rawfile body");
    expect(reply.run).toContain("--arg thread \"$THREAD_ID\"");
    expect(reply.run).toContain('"coding-$RUN_ID-$GITHUB_RUN_ATTEMPT"');
    expect(reply.run).toContain("--fail-with-body");
    expect(reply.run).toContain("-o /dev/null");
    expect(reply.run).toContain("/api/hub/messages");
    expect(reply.run).not.toMatch(/-d\s+['"]\{/); // no hand-written JSON body
    expect(reply.env!.RCE_CRM_CODING_KEY).toBe("${{ secrets.RCE_CRM_CODING_KEY }}");
  });

  it("the reply's FIRST line names its run, the success reply names the branch, and reply.md is posted only when the scan cleared it", () => {
    const run = reply.run!;
    expect(run).toContain("printf 'Claude Code run %s\\n\\n' \"$RUN_ID\"");
    expect(run.indexOf("Claude Code run %s")).toBeLessThan(run.indexOf("Pull request: %s"));
    expect(run).toContain("printf 'Pull request: %s\\nBranch: %s\\n\\n' \"$PR_URL\" \"${BRANCH_PUSHED:-}\"");
    expect(run).toContain('if [ "${REPLY_SAFE:-0}" = "1" ] && [ -f .hub-context/reply.md ]; then');
    expect(run).toContain("was withheld because it could not be cleared for posting");
    // reply.md is mentioned three times: the guarded read, the withheld branch's test and the no-reply test. Never read outside the guard.
    expect(run.match(/head -c \d+ \.hub-context\/reply\.md/g)).toHaveLength(1);
    expect(reply.env!.SCAN_OUTCOME).toBe("${{ steps.scan.outcome }}");
  });


  it("the Coding key and the CRM address reach only the steps that talk to the CRM or scan for leaks, never the Claude step", () => {
    const withKey = steps.filter((s) => JSON.stringify(s).includes("RCE_CRM_CODING_KEY")).map((s) => s.name);
    expect(withKey).toEqual([
      "Write the request and fetch the conversation", "Scan for leaked secrets", "Reply in the conversation",
    ]);
    expect(JSON.stringify(claude)).not.toContain("RCE_CRM_CODING_KEY");
    expect(JSON.stringify(claude)).not.toContain("vars.");
    expect(raw).toContain("vars.RCE_CRM_BASE_URL");
    expect(stepNamed("Write the request").run).toContain("https://");
  });
});
