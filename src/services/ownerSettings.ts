/**
 * Owner-guarded settings (work order agent-team, step 0): CompanySetting rows that only Kyle may
 * change, reached through routes/ownerSettings.ts. This is NOT the open `PUT /crm/settings/:key`,
 * which has its own allowlist of office-editable keys; a key added here is never added there.
 *
 * Each key has ONE zod schema, its default, and (where the rest of the server needs the value) one
 * reader. Later units read a setting only through its reader (`getQuietWindow()` below), never by
 * touching CompanySetting themselves, so there is one place that knows the shape and the fallback.
 */
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { logSystemEvent } from "./systemEvents";
import { DEFAULT_QUIET_WINDOW, isValidQuietWindow, parseClock, type QuietWindow } from "../../shared/sms/quietHours";
import { HUB_EVENT_TYPES, HUB_WEBHOOK_TARGET_IDS, isHubEventType } from "../../shared/hub/events";
import {
  AUTO_SEND_CATEGORIES, DEFAULT_HUB_AUTO_SEND, isAutoSendCategory, type HubAutoSendStatus, type HubAutoSendValue,
} from "../../shared/hub/autoSendCategories";
import { customerSendsEnabled, workflowEnvVar } from "./automationGate";
import { SMS_PURPOSES, isSmsPurposeKey, smsPurposeLabel, type SmsPurposeKey } from "../../shared/sms/purposes";
import { WEBHOOK_HEADERS_MAX, webhookHeaderNameProblem, webhookHeaderNameShapeProblem, webhookHeaderValueProblem } from "../../shared/hub/webhookHeaders";
import { PEPPER_UNSET_MESSAGE, encryptSecret, generateSigningSecret, maskSecret, settingSecretsAvailable } from "./settingSecrets";

const clock = z.string().refine((v) => parseClock(v) !== null, 'Use a 24-hour time written HH:MM, like "08:00"');

/**
 * Customer SMS quiet hours, in the recipient's local time (Chicago for every Middle Tennessee
 * number). The team's approved answers bind customer texts to 8:00 AM-8:00 PM, so a saved window may
 * only NARROW that range: start no earlier than 08:00, end no later than 20:00, start before end.
 */
export const QUIET_HOURS_OUTSIDE_ERROR = "Quiet hours can't go earlier than 8:00 AM or later than 8:00 PM.";

export const quietHoursSchema = z
  .object({ start: clock, end: clock })
  .strict()
  .superRefine((window, ctx) => {
    const start = parseClock(window.start);
    const end = parseClock(window.end);
    if (start === null || end === null) return; // the field messages above already say what is wrong
    if (start < (parseClock(DEFAULT_QUIET_WINDOW.start) as number) || end > (parseClock(DEFAULT_QUIET_WINDOW.end) as number)) {
      ctx.addIssue({ code: "custom", message: QUIET_HOURS_OUTSIDE_ERROR });
    } else if (!isValidQuietWindow(window)) {
      ctx.addIssue({ code: "custom", message: "The start time must be earlier than the end time" });
    }
  });

/**
 * The agent kill switch (work order agent-team, K-U1): one of three modes for EVERY agent key at
 * once. `on` serves everything a key's scopes allow; `read_only` refuses every write and draft;
 * `off` answers every agent call 503. The agent gate reads it, uncached, on every request
 * (getAgentAccess below). `changedAt` and `changedBy` say who flipped it last; the Settings card
 * and its write route come with K-U2.
 */
export const AGENT_ACCESS_MODES = ["on", "read_only", "off"] as const;
export type AgentAccessMode = (typeof AGENT_ACCESS_MODES)[number];

export const agentAccessSchema = z
  .object({
    mode: z.enum(AGENT_ACCESS_MODES),
    changedAt: z.string().nullable().default(null),
    changedBy: z.string().nullable().default(null),
  })
  .strict();

export type AgentAccess = z.infer<typeof agentAccessSchema>;

export const DEFAULT_AGENT_ACCESS: AgentAccess = { mode: "on", changedAt: null, changedBy: null };

/**
 * Where the signed agent events go (work order agent-team, TC4): the receiving address and On/Off for
 * each agent that listens (Admin, Inventory), and which agent gets which event type. Work order C6b
 * adds, per agent, up to five custom headers and an own HMAC signing secret, both stored ENCRYPTED
 * (services/settingSecrets.ts) and never returned: GET and PUT answer a masked view (agentWebhooksView).
 * Admin with no own secret signs with HUB_WEBHOOK_SECRET (services/hubEvents.ts signingSecretFor). An empty address means "no
 * address - the agent will poll": the event is recorded and kept. The Admin target with no address
 * falls back to the HUB_AGENT_WEBHOOK_URL environment variable (services/hubEvents.ts
 * resolveTargetUrl). `routes` holds ONLY the event types Kyle re-pointed; every other type goes where
 * shared/hub/events.ts DEFAULT_EVENT_ROUTES says. Kyle only (guard "kyle"); the AI admin is refused.
 *
 * The address is where signed event summaries are POSTed, so it must be https:// (http:// only
 * outside production, for a local receiver), carry no credentials and name a host.
 */
export const WEBHOOK_URL_ERROR = "A receiving address must start with https:// and name a host (no user name or password).";

export function isAllowedWebhookUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username || url.password || !url.hostname) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && process.env.NODE_ENV !== "production";
}

/**
 * A custom header or signing secret as STORED (work order C6b): the value is AES-256-GCM ciphertext
 * (services/settingSecrets.ts), `masked` is the "••••" + last four the screen shows. Nothing in this
 * shape can be turned back into the value without AGENT_KEY_PEPPER, and the GET answer never carries
 * `enc` at all (agentWebhooksView below).
 */
const storedHeaderSchema = z
  .object({
    name: z.string().superRefine((v, ctx) => {
      // Shape only: a row saved before a name became reserved must still read (the sender skips it).
      const problem = webhookHeaderNameShapeProblem(v);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
    enc: z.string().min(1).max(8000),
    masked: z.string().max(20),
  })
  .strict();
const storedSigningSecretSchema = z
  .object({ enc: z.string().min(1).max(500), masked: z.string().max(20), createdAt: z.string() })
  .strict();

export const agentWebhooksSchema = z
  .object({
    targets: z
      .array(
        z.object({
          id: z.enum(HUB_WEBHOOK_TARGET_IDS),
          url: z.string().trim().max(500).nullable().transform((v) => (v === "" ? null : v))
            .refine((v) => v === null || isAllowedWebhookUrl(v), WEBHOOK_URL_ERROR),
          enabled: z.boolean(),
          headers: z
            .array(storedHeaderSchema)
            .max(WEBHOOK_HEADERS_MAX, `At most ${WEBHOOK_HEADERS_MAX} custom headers per agent.`)
            .refine((list) => new Set(list.map((h) => h.name.toLowerCase())).size === list.length, "Each header name can be used once.")
            .default([]),
          signingSecret: storedSigningSecretSchema.nullable().default(null),
        }).strict(),
      )
      .max(HUB_WEBHOOK_TARGET_IDS.length)
      .refine((list) => new Set(list.map((t) => t.id)).size === list.length, "Each agent is listed once"),
    routes: z
      .record(z.string(), z.enum(HUB_WEBHOOK_TARGET_IDS))
      .refine((r) => Object.keys(r).every(isHubEventType), `Unknown event type. Valid types: ${HUB_EVENT_TYPES.join(", ")}`),
  })
  .strict();

export type AgentWebhooks = z.infer<typeof agentWebhooksSchema>;
export type AgentWebhookTarget = AgentWebhooks["targets"][number];
type WebhookTargetId = (typeof HUB_WEBHOOK_TARGET_IDS)[number];

export const DEFAULT_AGENT_WEBHOOKS: AgentWebhooks = {
  targets: HUB_WEBHOOK_TARGET_IDS.map((id) => ({ id, url: null, enabled: true, headers: [], signingSecret: null })),
  routes: {},
};

/** A refusal the owner-settings route answers in words (not a schema error): the status and the sentence. */
export class OwnerSettingInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "OwnerSettingInputError";
    this.status = status;
  }
}

/**
 * What the screen SENDS for agentWebhooks (the PUT body): the address, On/Off and, per agent, the custom
 * headers as {name, value?}. A header with a `value` is new or re-entered; one with no value is kept as
 * stored (matched by name). A target that sends no `headers` at all keeps its stored headers. The
 * signing secret is never taken from the client: only the generate / remove actions below change it.
 */
const webhooksInputSchema = z
  .object({
    targets: z.array(
      z.object({
        id: z.enum(HUB_WEBHOOK_TARGET_IDS),
        url: z.string().trim().max(500).nullable(),
        enabled: z.boolean(),
        headers: z.array(z.object({ name: z.string().trim(), value: z.string().optional() }).strict()).optional(),
      }).strict(),
    ),
    routes: z.record(z.string(), z.string()),
  })
  .strict();

/** The PUT body -> the value to store: encrypts new header values, keeps the rest as stored. Fails closed without the pepper. */
export function prepareAgentWebhooks(body: unknown, previous: unknown): unknown {
  const input = webhooksInputSchema.parse(body);
  const before = (previous as AgentWebhooks | null)?.targets ?? [];
  return {
    ...input,
    targets: input.targets.map((t) => {
      const prior = before.find((x) => x.id === t.id);
      const priorHeaders = prior?.headers ?? [];
      let headers = priorHeaders;
      if (t.headers !== undefined) {
        headers = t.headers.map((h) => {
          if (h.value === undefined) {
            // A header already stored is kept as it is (it may predate a newly reserved name; the sender skips it and Remove header still works).
            const kept = priorHeaders.find((x) => x.name.toLowerCase() === h.name.toLowerCase());
            if (!kept) throw new OwnerSettingInputError(`Enter a value for the "${h.name}" header.`);
            return kept;
          }
          const nameProblem = webhookHeaderNameProblem(h.name);
          if (nameProblem) throw new OwnerSettingInputError(nameProblem);
          const value = h.value.trim();
          const valueProblem = webhookHeaderValueProblem(value);
          if (valueProblem) throw new OwnerSettingInputError(`${h.name}: ${valueProblem}`);
          if (!settingSecretsAvailable()) throw new OwnerSettingInputError(PEPPER_UNSET_MESSAGE, 409);
          return { name: h.name, enc: encryptSecret(value), masked: maskSecret(value) };
        });
      }
      return { id: t.id, url: t.url, enabled: t.enabled, headers, signingSecret: prior?.signingSecret ?? null };
    }),
  };
}

export type SecretSource = "own" | "env" | "none";

/** Which signing secret a target signs with: its own; for Admin with none, the HUB_WEBHOOK_SECRET variable; else none. */
export function signingSecretSource(target: Pick<AgentWebhookTarget, "id" | "signingSecret">): SecretSource {
  if (target.signingSecret) return "own";
  if (target.id === "admin" && process.env.HUB_WEBHOOK_SECRET) return "env";
  return "none";
}

/**
 * The stored value as ANY reader gets it (GET and PUT /owner-settings/agentWebhooks): both agents, the
 * header names with "••••" + last four, the signing secret as "••••" + last four, and which secret is
 * in use. Never `enc`, so nothing in an answer can be decrypted.
 */
export function agentWebhooksView(value: unknown) {
  const v = value as AgentWebhooks;
  return {
    targets: HUB_WEBHOOK_TARGET_IDS.map((id) => {
      const t: AgentWebhookTarget = v.targets.find((x) => x.id === id) ?? { id, url: null, enabled: true, headers: [], signingSecret: null };
      return {
        id,
        url: t.url,
        enabled: t.enabled,
        headers: t.headers.map((h) => ({ name: h.name, masked: h.masked })),
        signingSecret: t.signingSecret ? { masked: t.signingSecret.masked, createdAt: t.signingSecret.createdAt } : null,
        secretSource: signingSecretSource(t),
      };
    }),
    routes: v.routes,
  };
}

/** Read-only facts beside the value: can secrets be stored at all (AGENT_KEY_PEPPER set)? A boolean, never the pepper. */
export function agentWebhooksStatus(): { pepperSet: boolean } {
  return { pepperSet: settingSecretsAvailable() };
}

async function changeTarget(id: WebhookTargetId, change: (t: AgentWebhookTarget) => AgentWebhookTarget, db: PrismaClient): Promise<void> {
  const current = await getAgentWebhooks(db);
  const all: AgentWebhookTarget[] = HUB_WEBHOOK_TARGET_IDS.map((tid) => current.targets.find((x) => x.id === tid)
    ?? { id: tid, url: null, enabled: true, headers: [], signingSecret: null });
  await saveOwnerSetting("agentWebhooks", { ...current, targets: all.map((t) => (t.id === id ? change(t) : t)) }, db);
}

/**
 * Make (or replace) one agent's own signing secret. Returns the plaintext ONCE, for the answer that
 * created it; only the ciphertext and the masked tail are kept. Fails closed with no pepper.
 */
export async function generateWebhookSigningSecret(
  id: WebhookTargetId, db: PrismaClient = defaultPrisma,
): Promise<{ secret: string; masked: string; replaced: boolean }> {
  if (!settingSecretsAvailable()) throw new OwnerSettingInputError(PEPPER_UNSET_MESSAGE, 409);
  const secret = generateSigningSecret();
  const masked = maskSecret(secret);
  let replaced = false;
  await changeTarget(id, (t) => {
    replaced = t.signingSecret !== null;
    return { ...t, signingSecret: { enc: encryptSecret(secret), masked, createdAt: new Date().toISOString() } };
  }, db);
  return { secret, masked, replaced };
}

/** Remove one agent's own signing secret (Admin then signs with HUB_WEBHOOK_SECRET again, Inventory has none). */
export async function removeWebhookSigningSecret(id: WebhookTargetId, db: PrismaClient = defaultPrisma): Promise<boolean> {
  let had = false;
  await changeTarget(id, (t) => {
    had = t.signingSecret !== null;
    return { ...t, signingSecret: null };
  }, db);
  return had;
}

/**
 * Which AI message categories go out WITHOUT a person pressing Approve (work order agent-team, BA8).
 * Every category is OFF until Kyle turns it on in Settings -> "AI auto-send rules"; a missing row means
 * all OFF, so no seed is needed. The categories are the ones the send-type registry marks
 * autoSendEligible (shared/hub/autoSendCategories.ts is a filtered view of it), so a key that is not
 * eligible there is refused here. Only `categories` comes from the client: who changed it, and when, are
 * stamped by the server. A switch alone sends nothing: the hubAutoSend gate (Railway env) must be ON too
 * (services/hubAutoSend.ts). Kyle only.
 */
export const hubAutoSendSchema = z
  .object({
    categories: z
      .record(z.string(), z.boolean())
      .refine(
        (c) => Object.keys(c).every(isAutoSendCategory),
        `Unknown category. Categories that can be switched on: ${AUTO_SEND_CATEGORIES.map((c) => c.key).join(", ") || "none"}`,
      ),
    changedAt: z.string().nullable().default(null),
    changedBy: z.string().nullable().default(null),
  })
  .strict();

/**
 * When the waiting-approval reminder may go out (work order agent-team, U8, team answer 8): the hours of
 * the day, America/Chicago. The days are NOT a setting: a reminder goes out Monday to Friday only (the same
 * fixed weekday rule of shared/sms/quietHours.ts isReminderSendableNow; customer texts are open all seven days since 2026-11-22 and use a different helper), and the card says so
 * in plain text. Default 8:00 AM to 8:00 PM. Unlike the customer quiet-hours window this one may be set
 * wider or narrower: it is Kyle's own reminder, not a message to a customer. Kyle only.
 */
export const hubNotifySchema = z
  .object({ start: clock, end: clock })
  .strict()
  .superRefine((window, ctx) => {
    if (parseClock(window.start) !== null && parseClock(window.end) !== null && !isValidQuietWindow(window)) {
      ctx.addIssue({ code: "custom", message: "The start time must be earlier than the end time" });
    }
  });

export type HubNotifyWindow = z.infer<typeof hubNotifySchema>;

export const DEFAULT_HUB_NOTIFY: HubNotifyWindow = { start: "08:00", end: "20:00" };

/**
 * The words after "Red Cedar Electric:" in the header of a customer text (work order agent-team, addendum 4a):
 * "Appointment Confirmation", "Reschedule", ... The built-in wording is shared/sms/purposes.ts; this setting
 * holds only the labels Kyle RENAMED, keyed by reason (purposeKey), so there is no seed row and a reason
 * he never touched keeps its default. A key that is not one of the registered reasons is refused: the
 * composer prints a label only for a reason the send-type registry knows. A label is a few plain words:
 * no line break, no company name (the header already starts with it) and no STOP wording (the footer
 * carries that). Kyle only. The "Text reason labels" section that edits it is part of Settings -> Texting
 * (step 6); until then the defaults print.
 */
export const SMS_LABEL_MAX = 40;
export const smsPurposeLabelsSchema = z
  .record(
    z.string(),
    z.string().trim().min(1, "A label cannot be empty. Remove the row to go back to the default.").max(SMS_LABEL_MAX, `Keep a label to ${SMS_LABEL_MAX} characters.`)
      .refine((v) => !/[\r\n]/.test(v), "A label is one line.")
      .refine((v) => !/red\s+cedar/i.test(v), "Leave the company name out; the header already starts with it.")
      .refine((v) => !/\bstop\b/i.test(v), "Leave STOP wording out; the footer carries it."),
  )
  .refine(
    (labels) => Object.keys(labels).every(isSmsPurposeKey),
    `Unknown reason. Reasons that have a label: ${Object.keys(SMS_PURPOSES).join(", ")}`,
  );

export type SmsPurposeLabels = z.infer<typeof smsPurposeLabelsSchema>;

export type OwnerSettingKey = "quietHours" | "agentAccess" | "agentWebhooks" | "hubAutoSend" | "hubNotify" | "smsPurposeLabels";

/**
 * One entry per key. `guard` says who may read and write it through the route family: "kyle" is
 * Kyle himself (isKyle), "bot_keys" is the `bot_keys` power (Kyle always passes it; the AI admin
 * never does). `stamp` lets the SERVER build the stored value from the request body, so a field the
 * client must not choose (who changed it, and when) is never taken from the client.
 */
export interface OwnerSettingDef {
  schema: z.ZodType;
  default: unknown;
  guard: "kyle" | "bot_keys";
  /** Read-only facts the screen needs beside the value (not stored, not writable), sent with GET and PUT. */
  status?: () => unknown;
  stamp?: (body: unknown, actorName: string, now: Date) => unknown;
  /** Turns the request body into the value to store, given the value before it (encrypts what must be encrypted). May throw OwnerSettingInputError. */
  prepare?: (body: unknown, previous: unknown) => unknown;
  /** The value as GET and PUT answer it, when that must differ from the stored one (secrets masked). */
  view?: (stored: unknown) => unknown;
  /** Called after a save, with the value before it, the value saved and the actor's name. For the key's own audit. */
  onSaved?: (previous: unknown, next: unknown, actorName: string) => void;
}

/** The explicit allowlist: key -> its schema, default and guard. A key not in this table is a 400. */
export const OWNER_SETTINGS: Record<OwnerSettingKey, OwnerSettingDef> = {
  quietHours: { schema: quietHoursSchema, default: DEFAULT_QUIET_WINDOW as unknown, guard: "kyle" },
  agentWebhooks: {
    schema: agentWebhooksSchema,
    default: DEFAULT_AGENT_WEBHOOKS as unknown,
    guard: "kyle",
    status: agentWebhooksStatus,
    prepare: prepareAgentWebhooks,
    view: agentWebhooksView,
    // The address itself is never logged (it is the place the events go), and no header or secret VALUE
    // ever is: only that an address is set, how many headers there are and whether there is an own secret.
    onSaved: (_previous, next, actorName) => {
      const v = next as AgentWebhooks;
      logSystemEvent("info", "agent_events", "Agent webhook addresses changed", {
        route: "PUT /owner-settings/agentWebhooks",
        actor: actorName,
        targets: v.targets.map((t) => ({ id: t.id, set: t.url !== null, enabled: t.enabled, headers: t.headers.length, ownSecret: t.signingSecret !== null })),
        routes: v.routes,
      });
    },
  },
  hubAutoSend: {
    schema: hubAutoSendSchema,
    default: DEFAULT_HUB_AUTO_SEND as unknown,
    guard: "kyle",
    status: (): HubAutoSendStatus => ({ gateOn: customerSendsEnabled("hubAutoSend"), gateEnv: workflowEnvVar("hubAutoSend") }),
    stamp: (body, actorName, now) => ({
      categories: body !== null && typeof body === "object" ? (body as { categories?: unknown }).categories : undefined,
      changedAt: now.toISOString(),
      changedBy: actorName,
    }),
    // Turning an AI category on or off is a decision about what reaches customers: log who and what.
    onSaved: (previous, next, actorName) => {
      const was = (previous as HubAutoSendValue | null)?.categories ?? {};
      const now = (next as HubAutoSendValue).categories;
      const changed = Object.keys({ ...was, ...now }).filter((k) => (was[k] === true) !== (now[k] === true));
      logSystemEvent("info", "hub", "AI auto-send rules changed", {
        route: "PUT /owner-settings/hubAutoSend",
        actor: actorName,
        changed: changed.map((k) => ({ category: k, on: now[k] === true })),
      });
    },
  },
  smsPurposeLabels: {
    schema: smsPurposeLabelsSchema,
    default: {} as unknown,
    guard: "kyle",
    onSaved: (_previous, next, actorName) => {
      logSystemEvent("info", "hub", "Text reason labels changed", {
        route: "PUT /owner-settings/smsPurposeLabels", actor: actorName, renamed: Object.keys(next as SmsPurposeLabels),
      });
    },
  },
  hubNotify: {
    schema: hubNotifySchema,
    default: DEFAULT_HUB_NOTIFY as unknown,
    guard: "kyle",
    onSaved: (_previous, next, actorName) => {
      const v = next as HubNotifyWindow;
      logSystemEvent("info", "hub", `Message reminder hours set to ${v.start}-${v.end}`, {
        route: "PUT /owner-settings/hubNotify", actor: actorName, start: v.start, end: v.end,
      });
    },
  },
  agentAccess: {
    schema: agentAccessSchema,
    default: DEFAULT_AGENT_ACCESS as unknown,
    guard: "bot_keys",
    // Only `mode` comes from the client. changedAt and changedBy are the server's: the actor's name
    // from the session, and now.
    stamp: (body, actorName, now) => ({
      mode: body !== null && typeof body === "object" ? (body as { mode?: unknown }).mode : undefined,
      changedAt: now.toISOString(),
      changedBy: actorName,
    }),
    // Every change of the kill switch is logged with who, from what and to what: the stamp on the
    // setting itself is overwritten by the next change.
    onSaved: (previous, next, actorName) => {
      logSystemEvent("info", "agent_keys", `Agent access set to ${(next as AgentAccess).mode}`, {
        route: "PUT /owner-settings/agentAccess",
        actor: actorName,
        from: (previous as AgentAccess | null)?.mode ?? null,
        to: (next as AgentAccess).mode,
      });
    },
  },
};

export function isOwnerSettingKey(key: string): key is OwnerSettingKey {
  return Object.prototype.hasOwnProperty.call(OWNER_SETTINGS, key);
}

/**
 * The stored value for a key, validated against its schema; the default when there is no row or the
 * stored text is not valid any more (a hand-edited row must never put a bad window in front of a
 * send).
 */
export async function getOwnerSetting(key: OwnerSettingKey, db: PrismaClient = defaultPrisma): Promise<unknown> {
  // The kill switch has its own fail-CLOSED reader (an unreadable row is "off"); every door that
  // reads it must give the gate's answer, not this function's default of "on".
  if (key === "agentAccess") return getAgentAccess(db);
  const row = await db.companySetting.findUnique({ where: { key } });
  if (!row) return OWNER_SETTINGS[key].default;
  try {
    const parsed = OWNER_SETTINGS[key].schema.safeParse(JSON.parse(row.valueJson));
    return parsed.success ? parsed.data : OWNER_SETTINGS[key].default;
  } catch {
    return OWNER_SETTINGS[key].default;
  }
}

/** Validate and store. Throws a ZodError (the app answers it 400) on a bad value. Returns what was stored. */
export async function saveOwnerSetting(key: OwnerSettingKey, value: unknown, db: PrismaClient = defaultPrisma): Promise<unknown> {
  const parsed = OWNER_SETTINGS[key].schema.parse(value);
  const valueJson = JSON.stringify(parsed);
  await db.companySetting.upsert({ where: { key }, create: { key, valueJson }, update: { valueJson } });
  return parsed;
}

/** The hours the waiting-approval reminder may go out. Default 8:00 AM-8:00 PM when Kyle has set none. */
export async function getNotifyWindow(db: PrismaClient = defaultPrisma): Promise<HubNotifyWindow> {
  return (await getOwnerSetting("hubNotify", db)) as HubNotifyWindow;
}

/**
 * The header label of EVERY reason, Kyle's rename where he made one and the built-in wording otherwise. The
 * ONE reader: the composer's two callers (the card's "Sends as:" preview in services/hubSend.ts prepareSms
 * and sendSms in services/twilio.ts) both pass this, so a rename shows on the preview and on the text.
 */
export async function getSmsPurposeLabels(db: PrismaClient = defaultPrisma): Promise<Record<SmsPurposeKey, string>> {
  const renamed = (await getOwnerSetting("smsPurposeLabels", db)) as SmsPurposeLabels;
  const out = {} as Record<SmsPurposeKey, string>;
  for (const key of Object.keys(SMS_PURPOSES) as SmsPurposeKey[]) out[key] = smsPurposeLabel(key, renamed);
  return out;
}

/** The agent webhook targets and routes every event dispatch reads. The default when none is saved. */
export async function getAgentWebhooks(db: PrismaClient = defaultPrisma): Promise<AgentWebhooks> {
  return (await getOwnerSetting("agentWebhooks", db)) as AgentWebhooks;
}

/** The quiet-hours window every SMS send path reads. Default 8:00 AM-8:00 PM when Kyle has set none. */
export async function getQuietWindow(db: PrismaClient = defaultPrisma): Promise<QuietWindow> {
  return (await getOwnerSetting("quietHours", db)) as QuietWindow;
}

/**
 * The agent kill switch as the gate reads it: straight from the row, every call, no cache. No row
 * means `on`. A row that is there but no longer valid (a hand edit) counts as `off`: unlike a bad
 * quiet-hours window, a kill switch that cannot be read must not fail open. A database error is
 * thrown, and the gate turns it into a refusal.
 */
export async function getAgentAccess(db: PrismaClient = defaultPrisma): Promise<AgentAccess> {
  const row = await db.companySetting.findUnique({ where: { key: "agentAccess" } });
  if (!row) return DEFAULT_AGENT_ACCESS;
  try {
    const parsed = agentAccessSchema.safeParse(JSON.parse(row.valueJson));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through to off
  }
  return { mode: "off", changedAt: null, changedBy: null };
}
