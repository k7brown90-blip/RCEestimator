import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import ts from "typescript";

/**
 * Stamp every rendered element with the file and line it was written on. (P032)
 *
 * Kyle, 2026-08-18: *"I need a way to show you specifically what needs changed."*
 *
 * The debug sidebar could already carry an ERROR back to me. It could not carry a POINT — "this
 * button", "that heading", "this row is in the wrong place" — and those are most of what he
 * actually wants changed. Describing a control in words costs a round trip every time, and the
 * ambiguity is real: `PriceBookIntakePage` alone renders a dozen buttons that could each be
 * called "the finalize button".
 *
 * So each host element (`div`, `button`, `input` — the things you can point at, never a React
 * component) gets `data-rce-src="src/pages/Foo.tsx:412"`. The picker in the sidebar reads it off
 * whatever Kyle taps, which turns "the button under the total does nothing" into a file and a
 * line I can open directly.
 *
 * ── WHY THE TYPESCRIPT PARSER AND NOT A REGEX ──────────────────────────────────────────────────
 *
 * `@vitejs/plugin-react` v6 transforms JSX with oxc and exposes no plugin hook, so this has to run
 * as a `pre` transform over the original source. The obvious implementation — regex for `<tag` —
 * is quietly dangerous: `if (a <b && c)` matches `<b`, which is also a real HTML tag, and the
 * "fix" would insert an attribute into an arithmetic comparison and produce code that does not
 * compile. Rather than guess where JSX starts, this parses the file and asks. TypeScript is
 * already a dependency, so the accurate option is also the cheap one.
 *
 * WHY IT RUNS IN PRODUCTION TOO. Vite's built-in JSX source transform is development-only, and
 * development is the one environment Kyle never uses — he tests on the deployed Railway app from
 * his phone. A diagnostic that switches itself off in the only place it is needed is not a
 * diagnostic.
 *
 * WHAT IT COSTS. One short attribute per element, and the file names become readable in the DOM.
 * Both are acceptable here: the CRM sits behind the operator session, and the same file names are
 * already recoverable from the shipped JS.
 */
function stampElementSource(): Plugin {
  return {
    name: "rce-stamp-element-source",
    // Ahead of plugin-react, so this still sees real JSX rather than compiled output.
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0];
      if (!file.endsWith(".tsx") || file.includes("/node_modules/")) return null;

      const source = ts.createSourceFile(file, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
      const rel = (() => {
        const norm = file.replace(/\\/g, "/");
        const i = norm.indexOf("/client/");
        return i >= 0 ? norm.slice(i + 8) : norm;
      })();

      // { position, text } — collected first, applied last-to-first so earlier offsets stay valid.
      const inserts: Array<{ at: number; text: string }> = [];

      const visit = (node: ts.Node): void => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName;
          // Host elements only. A stamp on `<PriceBookIntakePage>` would point at the call site
          // rather than at the markup, which is the opposite of useful.
          if (ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            inserts.push({ at: tag.getEnd(), text: ` data-rce-src="${rel}:${line}"` });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);

      if (inserts.length === 0) return null;

      let out = code;
      for (const ins of inserts.sort((a, b) => b.at - a.at)) {
        out = out.slice(0, ins.at) + ins.text + out.slice(ins.at);
      }
      // No source map: this only inserts attributes, and production builds emit no maps anyway.
      return { code: out, map: null };
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [stampElementSource(), react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
