/**
 * ONE SCHEDULER, ONE HOME (2026-10-01, plan item E3).
 *
 * Kyle, 2026-10-01: "There are multiple scheduling points and that needs to all be done on the
 * calendar page." And: "the date picker would only come up in one scheduling page and not the
 * other. It all needs consolidated into a single scheduling system in one place."
 *
 * `JobScheduler` used to render on four surfaces — the Calendar page, the job drawer, the lead
 * drawer and the visit workspace — two opening straight into a picker and two showing a button
 * first. This test is the lock on the door: the Calendar page is the ONLY file allowed to import
 * it, and the three surfaces that gave theirs up show `ScheduleOnCalendar` instead. Restoring an
 * inline scheduler anywhere else fails here before it ships.
 *
 * Static, by design: a render test proves one screen; this proves the whole client.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

/** Files (relative to src/, forward slashes) that import `module` from a `components/` path. */
function importersOf(module: string): string[] {
  const pattern = new RegExp(`from\\s+["'][^"']*/${module}["']`);
  return sourceFiles(SRC)
    .filter((file) => pattern.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(SRC, file).replace(/\\/g, "/"))
    .sort();
}

describe("scheduling has one home", () => {
  it("the Calendar page is the only file that renders JobScheduler", () => {
    // Presence half first, so an import-pattern typo cannot pass as "nobody imports it".
    expect(fs.existsSync(path.join(SRC, "components/JobScheduler.tsx"))).toBe(true);
    expect(importersOf("JobScheduler")).toEqual(["pages/CalendarPage.tsx"]);
  });

  it("the job drawer, the visit workspace and the lead drawer show the door to the Calendar instead", () => {
    // The lead drawer navigates with `scheduleDoorPath` rather than rendering the card (it has
    // no visit until it converts), so it is pinned by LeadDrawer.test.tsx, not here.
    expect(importersOf("ScheduleOnCalendar")).toEqual([
      "components/drawers/JobDrawer.tsx",
      "pages/VisitWorkspacePage.tsx",
    ]);
    const leadDrawer = fs.readFileSync(path.join(SRC, "components/drawers/LeadDrawer.tsx"), "utf8");
    expect(leadDrawer).toMatch(/scheduleDoorPath\(/);
    // A render, not a mention — the file's own comment names what it gave up.
    expect(leadDrawer).not.toMatch(/<JobScheduler\b/);
  });

  it("every door lands on the same ?schedule= instruction the Calendar consumes", () => {
    // The four redirects that predate this change and the new door must all agree on the param,
    // or the Calendar's effect (CalendarPage.tsx `searchParams.get("schedule")`) misses one.
    const doors = [
      "pages/JobsPage.tsx",
      "pages/PriceBookIntakePage.tsx",
      "pages/PropertyDetailPage.tsx",
      "pages/SigningModePage.tsx",
    ];
    for (const rel of doors) {
      expect(fs.readFileSync(path.join(SRC, rel), "utf8"), rel).toMatch(/\/calendar\?schedule=\$\{/);
    }
    expect(fs.readFileSync(path.join(SRC, "lib/scheduleDoor.ts"), "utf8")).toMatch(/\/calendar\?schedule=\$\{/);
    expect(fs.readFileSync(path.join(SRC, "pages/CalendarPage.tsx"), "utf8")).toMatch(/searchParams\.get\("schedule"\)/);
  });
});
