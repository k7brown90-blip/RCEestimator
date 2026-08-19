/**
 * One business phone number, everywhere a customer can see it.
 *
 * ── WHY THIS IS A TEST AND NOT A NOTE ──────────────────────────────────────────────────────────
 *
 * `services/companyProfile.ts` exists because two phone numbers had already drifted apart — its
 * own header says so: *"the PDF footer printed one phone number and the email that delivered the
 * PDF printed another. On a contract that's embarrassing."*
 *
 * It drifted again anyway. On 2026-08-18 Kyle asked for "all instances of the phone number"
 * changed; six files were updated and **seven more were missed**, because the search was for the
 * number I already knew about rather than for anything shaped like a phone number. A third,
 * older number — `(615) 857-6389` — survived in the appointment emails, the estimate PDF footer,
 * the document-request page and the company-profile default, and kept going out to customers for
 * another day.
 *
 * The lesson is specific: **"change all the X" cannot be verified by searching for the X you
 * already have in mind.** This searches for the SHAPE, so a number nobody remembered still fails.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The Google Voice line for the business (Kyle, 2026-08-19). The only number that belongs on
 * anything a customer reads.
 */
const BUSINESS_PHONE_DIGITS = "6156252163";

/**
 * Kyle's personal number. Internal only — the destination for alert texts and the identity check
 * for inbound SMS from him (`isFromKyle`). Allowed by explicit exception rather than by a loose
 * pattern, so that it stays visible: if it ever turns up on something customer-facing, this test
 * should be what notices.
 */
const KYLE_PERSONAL_DIGITS = "9706661626";

const ROOTS = ["src", "client/src", "shared"].map((d) => path.resolve(__dirname, "..", d));

/**
 * Anything shaped like a US phone number, however it is punctuated.
 *
 * A FUNCTION, not a constant. A `/g` regex carries a mutable `lastIndex`, and sharing one object
 * across every line of every file made an earlier version of this scan skip most of what it
 * should have caught.
 *
 * Punctuation (or a `+1`) is required. A bare run of ten digits also describes `2147483647`, the
 * maximum 32-bit integer, which this repo uses as a z-index — the first version reported both
 * z-indexes as stray phone numbers.
 */
const phoneShape = () => /\+1\d{10}|\(\d{3}\)[ .-]?\d{3}[ .-]?\d{4}|\d{3}[ .-]\d{3}[ .-]\d{4}/g;

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) return name === "node_modules" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

interface Found {
  file: string;
  line: number;
  text: string;
  digits: string;
}

function findPhoneNumbers(): Found[] {
  const out: Found[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      const rel = path.relative(path.resolve(__dirname, ".."), file).replace(/\\/g, "/");
      fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        for (const m of line.matchAll(phoneShape())) {
          const digits = m[0].replace(/\D/g, "").replace(/^1/, "");
          if (digits.length !== 10) continue;
          out.push({ file: rel, line: i + 1, text: m[0], digits });
        }
      });
    }
  }
  return out;
}

describe("the business phone number", () => {
  it("scans the real source tree (a scan matching nothing would pass everything)", () => {
    // Both halves matter. An empty file list, or a list that never contains the number the app
    // actually ships, means the assertion below is checking nothing and reporting success.
    expect(ROOTS.every((r) => fs.existsSync(r))).toBe(true);
    expect(sourceFiles(ROOTS[0]).length).toBeGreaterThan(20);

    const all = findPhoneNumbers();
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((f) => f.digits === BUSINESS_PHONE_DIGITS)).toBe(true);
  });

  it("is the only real number anywhere a customer could read it", () => {
    const wrong = findPhoneNumbers().filter(
      (f) =>
        f.digits !== BUSINESS_PHONE_DIGITS &&
        f.digits !== KYLE_PERSONAL_DIGITS &&
        // 555-01xx is the reserved fictional range, used in comments explaining phone matching.
        !/^\d{3}555\d{4}$/.test(f.digits),
    );

    expect(
      wrong.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n"),
      `Every customer-facing phone number must be ${BUSINESS_PHONE_DIGITS}. These are not — and ` +
        "the last time this drifted, an old number went out on appointment emails and the estimate " +
        "PDF footer for a day before anyone noticed.",
    ).toBe("");
  });
});
