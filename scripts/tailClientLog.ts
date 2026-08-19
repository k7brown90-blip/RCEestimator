/**
 * Read the browser console off Kyle's device. (P032)
 *
 * This is the coding agent's end of the sidebar. `readSystemEvents.ts` can already show these
 * rows, but it prints them as generic log lines with the interesting part buried in a single
 * JSON blob. What is actually wanted is a TRANSCRIPT: one sitting at a time, oldest line first,
 * the way a console reads, with the failing request's status and body opened out.
 *
 * Usage (against production, which is where Kyle tests):
 *   railway run npx tsx scripts/tailClientLog.ts
 *   railway run npx tsx scripts/tailClientLog.ts --since 30m --problems
 *   railway run npx tsx scripts/tailClientLog.ts --session a1b2c3d4
 *   railway run npx tsx scripts/tailClientLog.ts --follow          # poll every 5s
 *
 * Options:
 *   --since 30m|24h|7d   how far back (default 2h)
 *   --limit 20           how many REPORTS (not lines) to show, newest kept (default 10)
 *   --session <id>       only this page-load
 *   --problems           only errors/warnings within each report
 *   --follow             keep polling and print new reports as they arrive
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseSince(raw: string): Date {
  const m = /^(\d+)(m|h|d)$/.exec(raw);
  if (!m) {
    console.error(`Invalid --since "${raw}" — use forms like 30m, 2h, 7d.`);
    process.exit(1);
  }
  const unitMs = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000;
  return new Date(Date.now() - Number(m[1]) * unitMs);
}

interface Entry {
  at: string;
  kind: string;
  text: string;
  data?: Record<string, unknown>;
}

const COLOR: Record<string, string> = {
  pick: "\x1b[95m",
  error: "\x1b[31m",
  warn: "\x1b[33m",
  network: "\x1b[36m",
  note: "\x1b[32m",
  nav: "\x1b[35m",
  log: "\x1b[90m",
};
const RESET = "\x1b[0m";

function printReport(row: {
  id: string;
  createdAt: Date;
  message: string;
  route: string | null;
  detailsJson: string | null;
}, problemsOnly: boolean): void {
  let details: {
    sessionId?: string;
    auto?: boolean;
    note?: string;
    userAgent?: string;
    droppedContextLines?: number;
    entries?: Entry[];
  } = {};
  try {
    details = row.detailsJson ? JSON.parse(row.detailsJson) : {};
  } catch {
    console.log(`  [detailsJson unparseable: ${row.detailsJson?.slice(0, 200)}]`);
  }

  const kind = details.auto ? "AUTO (error fired on its own)" : "SENT BY KYLE";
  console.log("");
  console.log("─".repeat(96));
  console.log(
    `${row.createdAt.toISOString()}  ${kind}  session=${details.sessionId ?? "?"}  ${row.route ?? ""}`,
  );
  console.log(`  ${row.message}`);
  if (details.note) console.log(`\x1b[32m  NOTE: ${details.note}${RESET}`);
  if (details.userAgent) console.log(`\x1b[90m  ${details.userAgent}${RESET}`);
  if (details.droppedContextLines) {
    console.log(
      `[90m  (${details.droppedContextLines} context line(s) trimmed; picks and notes are never trimmed)${RESET}`,
    );
  }
  console.log("─".repeat(96));

  /*
    CHANGE REQUESTS FIRST. When Kyle points at something, the file and line he pointed at is the
    single most useful line in the whole report and it would otherwise sit buried among fifty
    navigation and network lines. They are listed up front AND left in place in the transcript,
    because where a request falls in the sequence is sometimes the point ("I pressed this, then
    that happened").
  */
  const picks = (details.entries ?? []).filter((e) => e.kind === "pick");
  if (picks.length > 0) {
    console.log(`\x1b[95m  ${picks.length} CHANGE REQUEST(S):${RESET}`);
    for (const p of picks) {
      const d = (p.data ?? {}) as Record<string, unknown>;
      console.log(`\x1b[95m    ${d.source ?? "(no source stamp)"}${RESET}`);
      console.log(`      wants : ${d.changeRequested ?? "(no instruction given)"}`);
      console.log(`      on    : ${d.element ?? "?"} "${d.text ?? ""}"`);
      if (d.classes) console.log(`\x1b[90m      classes: ${d.classes}${RESET}`);
    }
    console.log("");
  }

  const entries = (details.entries ?? []).filter(
    (e) => !problemsOnly || e.kind === "error" || e.kind === "warn" || e.kind === "note" || e.kind === "pick",
  );
  if (entries.length === 0) {
    console.log("  (no console lines in this report)");
    return;
  }

  for (const e of entries) {
    const color = COLOR[e.kind] ?? "";
    const time = typeof e.at === "string" ? e.at.slice(11, 23) : "?";
    console.log(`  ${time} ${color}${e.kind.padEnd(7)} ${e.text}${RESET}`);
    if (e.data && Object.keys(e.data).length > 0) {
      for (const [k, v] of Object.entries(e.data)) {
        const rendered = typeof v === "string" ? v : JSON.stringify(v);
        // Multi-line values (stacks, response bodies) are the whole reason to read this at all,
        // so they are indented and kept rather than truncated to one line.
        const indented = String(rendered).split("\n").join("\n              ");
        console.log(`\x1b[90m      ${k}: ${indented}${RESET}`);
      }
    }
  }
}

async function fetchReports(since: Date, sessionId: string | undefined, limit: number) {
  const rows = await prisma.systemEvent.findMany({
    where: {
      source: "client",
      createdAt: { gte: since },
      ...(sessionId ? { detailsJson: { contains: `"sessionId":"${sessionId}"` } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  // Newest-first from the database so `take` keeps the RECENT ones; reversed for display so the
  // transcript reads forwards in time like a console.
  return rows.reverse();
}

async function main() {
  const since = parseSince(arg("since") ?? "2h");
  const sessionId = arg("session");
  const limit = Math.min(Number(arg("limit") ?? 10), 100);
  const problemsOnly = flag("problems");
  const follow = flag("follow");

  const reports = await fetchReports(since, sessionId, limit);
  if (reports.length === 0) {
    console.log(`No client reports since ${since.toISOString()}.`);
    console.log("Kyle opens the ⚡ sidebar in the app and presses Send to Claude; errors ship on their own.");
  }
  for (const r of reports) printReport(r, problemsOnly);

  if (!follow) {
    await prisma.$disconnect();
    return;
  }

  let lastSeen = reports.length > 0 ? reports[reports.length - 1].createdAt : since;
  console.log(`\n\x1b[90m…following. New reports appear below. Ctrl-C to stop.${RESET}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, 5000));
    const fresh = await prisma.systemEvent.findMany({
      where: { source: "client", createdAt: { gt: lastSeen } },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    for (const r of fresh) {
      printReport(r, problemsOnly);
      lastSeen = r.createdAt;
    }
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
