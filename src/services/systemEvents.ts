/**
 * System event logging — the persistent counterpart to console.error.
 *
 * Every call writes a SystemEvent row (fire-and-forget; logging must never
 * fail the operation being logged) and mirrors to the console so Railway's
 * live log stream still shows everything.
 *
 * Read side: scripts/readSystemEvents.ts (run via `railway run` against
 * production). The CRM feedback box writes here too (source = "feedback").
 */

import { prisma } from "../lib/prisma";

export type SystemEventLevel = "error" | "warn" | "info";

export interface SystemEventDetails {
  /** HTTP "METHOD /path" when the event came from a request. */
  route?: string;
  /** Anything JSON-serializable: stack, params, response bodies, feedback context. */
  [key: string]: unknown;
}

export function logSystemEvent(
  level: SystemEventLevel,
  source: string,
  message: string,
  details?: SystemEventDetails,
): void {
  const { route, ...rest } = details ?? {};
  const detailsJson = Object.keys(rest).length > 0 ? safeStringify(rest) : null;

  const mirror = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  mirror(`[${source}] ${message}${route ? ` (${route})` : ""}`);

  prisma.systemEvent.create({
    data: { level, source, message, route: route ?? null, detailsJson },
  }).catch((err) => console.error("[SystemEvents] write failed:", err));
}

/** Errors and circular structures must not break logging. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => {
      if (v instanceof Error) {
        return { name: v.name, message: v.message, stack: v.stack };
      }
      return v;
    });
  } catch {
    return JSON.stringify({ unserializable: String(value) });
  }
}
