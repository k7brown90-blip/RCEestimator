/**
 * The ONE response layer for agents (work order agent-team, K-U4). Every byte an agent receives, on
 * /mcp and on REST /api/hub/*, goes through agentRespond; nothing builds an agent answer by hand.
 *
 *   1. FIELD PROFILE. A tool declares, in priority order, which output schema each scope gets. The
 *      call is answered with the FIRST profile whose scope the key holds (so the shape follows the
 *      scope that authorised the call, not the key's name, and stays predictable when Kyle edits a
 *      key's scopes). The raw record is parsed with that schema: zod strips every key the schema
 *      does not name, which is what makes the schema the allowlist. Output schemas never use
 *      passthrough, looseObject, record, any or unknown (a source-scan test enforces it).
 *   2. SCRUB. scrub() then walks every remaining value: it drops secret-looking keys and replaces
 *      secret-looking text (Stripe ids, card numbers, EINs, routing numbers, JWTs, agent keys,
 *      technician tokens, webhook secrets, long random strings). A profile that withholds contact
 *      details (every restricted key, and every message read for EVERY key) also replaces phone
 *      numbers, email addresses and street addresses.
 *   3. MESSAGE TEXT (team answer 4). No key, Admin included, ever receives a customer's phone, email
 *      or street address in a message read. scrubMessageText does it in three passes: the linked
 *      record's own phone, email and address strings (exact), then phone and email patterns, then a
 *      US street-address pattern, each becoming "[withheld]". A first name is a ceiling, not a grant.
 *
 * Also here: toChicagoIso/dayOf re-exports for output times, and keyset pagination. Errors are
 * errors.ts. This module reads no request and writes nothing.
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma";
import { campaignFirstName } from "../services/emailCampaigns";
import { dayOf, toChicagoIso } from "../../shared/calendarDay";
import type { AgentScope } from "../../shared/agentScopes";
import { AgentApiError } from "./errors";

export { toChicagoIso };
/** A stored calendar day (noon-UTC typed day or a real moment) as YYYY-MM-DD, in Chicago. */
export const agentDay = dayOf;

/** Input for a time: ISO 8601 WITH an offset. A naive time is refused (toAgentError answers bad_time). */
export const agentDateTime = z.iso.datetime({ offset: true });

const REDACTED = "[redacted]";
export const WITHHELD = "[withheld]";

// ── scrub ─────────────────────────────────────────────────────────────────────────────────────

/** Words in a key that mark its VALUE as a secret or identifier the agent must never see. */
const SENSITIVE_KEY_WORDS = new Set([
  "token", "tokens", "secret", "secrets", "password", "passwd", "passcode", "hash", "pepper", "ein",
  "routing", "last4", "qr", "signature", "pin", "pins", "authorization", "cookie",
]);
const SENSITIVE_KEY_SUBSTRINGS = /token|secret|password|pepper|passwordhash|secrethash/i;

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** True for a key whose value must be dropped, whatever it holds. */
export function isSensitiveKey(key: string): boolean {
  const words = keyWords(key);
  if (words.some((w) => SENSITIVE_KEY_WORDS.has(w))) return true;
  const joined = words.join("");
  if (SENSITIVE_KEY_SUBSTRINGS.test(joined)) return true;
  if (/accountnumber/.test(joined)) return true;
  if (/^stripe.*id$/.test(joined)) return true;
  return false;
}

const STRIPE_PREFIXED = /\b(?:fa|acct|ba|card|pm|pi|ch|cus|ic|ipi|re|tr|po|cs|seti|src)_(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{8,}\b/g;
const STRIPE_KEYS = /\b(?:(?:sk|pk|rk)_(?:live|test)_|whsec_)[A-Za-z0-9]{8,}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const AGENT_KEY = /\brce_(?:live|test)_[A-Za-z0-9_-]{8,}/g;
const EIN = /(?<!\d)\d{2}-\d{7}(?!\d)/g;
const ENDING_DIGITS = /\b(?:ending(?:\s+in)?|last\s*(?:4|four)(?:\s+digits)?)\s*:?\s*\d{4}\b|(?:\*{2,}|x{2,}|•{2,})\s*\d{4}\b/gi;
/**
 * A customer capability link (/e/, /pay/, /confirm/, /unsubscribe/, /sign/, /documents/:id/pdf and
 * /documents/:id/sign): the path segment IS the credential, and a QR code encodes it. The
 * `generate-*` document routes are automation endpoints, not links, and are left alone.
 */
const CAPABILITY_URL = /(\/(?:e|pay|confirm|unsubscribe|sign|documents)\/)(?!generate-)[A-Za-z0-9_-]{16,}/g;
const BANK_NUMBER = /\b(?:account|acct|routing|checking|savings)\s*(?:number|num|no\.?|#)?\s*[:#]?\s*\d{6,17}\b/gi;
/** A run of digit groups separated by single spaces or dashes; redactCardIn looks for a card inside it. */
const CARD_RUN = /(?<!\d)\d+(?:[ -]\d+)*/g;
const NINE_DIGITS = /(?<!\d)\d{9}(?!\d)/g;
const HEX_LONG = /\b[0-9a-fA-F]{32,}\b/g;
const BASE64URL_LONG = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g;

/**
 * Find a card number INSIDE a run of digit groups: try a window starting at each group and adding
 * whole groups until it holds 13 to 19 digits, and redact the first window that passes Luhn. A card
 * typed with its expiry or CVV ("4242 4242 4242 4242 12", "qty 3 4242 4242 4242 4242") is caught
 * even though the whole run does not pass.
 */
function redactCardIn(run: string): string {
  const groups = [...run.matchAll(/\d+/g)];
  for (let i = 0; i < groups.length; i += 1) {
    let digits = "";
    for (let j = i; j < groups.length; j += 1) {
      digits += groups[j][0];
      if (digits.length > 19) break;
      if (digits.length >= 13 && luhnValid(digits)) {
        const start = groups[i].index as number;
        const end = (groups[j].index as number) + groups[j][0].length;
        return run.slice(0, start) + REDACTED + run.slice(end);
      }
    }
  }
  return run;
}

export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** ABA routing-number checksum: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) is a multiple of 10. */
export function abaValid(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const d = [...digits].map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

/** Between phone groups: spaces, dots, slashes, hyphens and the Unicode dashes Word and phone keyboards insert (U+2010 to U+2015), up to three of them (" - "). */
const PHONE_SEP = "[\\s./\\u2010-\\u2015-]{0,3}";
const PHONE = new RegExp(`(?<!\\d)(?:\\+?1${PHONE_SEP})?\\(?\\d{3}\\)?${PHONE_SEP}\\d{3}${PHONE_SEP}\\d{4}(?!\\d)`, "g");
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

const STREET_SUFFIX =
  "(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Ln|Lane|Ct|Court|Pike|Hwy|Highway|Blvd|Boulevard|Way|Cir|Circle|Pl|Place|Pkwy|Parkway|Trl|Trail|Ter|Terrace|Loop|Run|Pass|Sq|Square|Xing|Crossing" +
  "|Hollow|Holw|Cove|Cv|Ridge|Rdg|Trace|Trce|Bend|Chase|Point|Pt|Grove|Glen|Landing|Commons)";
const STREET_HOUSE = "\\d{1,6}(?:-?[A-Za-z])?";
const STREET_UNIT = "(?:\\s*,?\\s*(?:#|Apt\\.?|Unit|Ste\\.?|Suite)\\s*[\\w-]+)?";
/**
 * A US street address. House number (with an optional letter, "123-A"), then ONE of: a numbered
 * road ("1234 Highway 31", "12 Old Hwy 96", Route, Rte, US, SR, State Route), Broadway, West End, or
 * one to four name words and a street suffix ("123 Main St", "205 Fox Hollow", "6 Shady Cove",
 * "1200 Martin Luther King Jr Blvd"), with an optional unit. The numbered-road alternative comes
 * first so the route number goes with it.
 */
const STREET_ADDRESS = new RegExp(
  `(?<![\\w#])${STREET_HOUSE}\\s+(?:` +
    "(?:[A-Za-z]+\\s+)?(?:Hwy|Highway|Route|Rte|State\\s+Route)\\s*\\d{1,4}\\b" +
    "|Broadway\\b" +
    "|(?:West|East|North|South)\\s+End\\b" +
    `|(?:[A-Za-z0-9'.-]+\\s+){1,4}${STREET_SUFFIX}\\b\\.?` +
  `)${STREET_UNIT}`,
  "gi",
);
/**
 * "1234 US 31", "12 Old SR 96": a US or state route written in CAPITALS (no `i` flag, so "3 of us 2
 * hours" is left alone), with whitespace or a hyphen before the number, and only a house number or
 * "Old" in front of it.
 */
const US_SR_ROAD = new RegExp(
  `(?<![\\w#])${STREET_HOUSE}\\s+(?:Old\\s+)?(?:US|SR)(?:\\s+|-)\\d{1,4}\\b${STREET_UNIT}`,
  "g",
);
/** A post-office or rural-route box: "PO Box 123", "P.O. Box 9", "RR 2 Box 15". */
const BOX_ADDRESS = /\b(?:P\.?\s*O\.?\s*Box|RR\s*\d+\s*Box)\s*\d+\b/gi;

export interface LinkedContacts {
  phones?: readonly string[];
  emails?: readonly string[];
  addresses?: readonly string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A literal that matches case-insensitively and tolerates any run of whitespace where the literal has one. */
function literalRegex(text: string): RegExp | null {
  const clean = text.trim();
  if (clean.length < 3) return null;
  return new RegExp(clean.split(/\s+/).map(escapeRegExp).join("\\s+"), "gi");
}

/** A phone matches whatever punctuation sits between its digits. */
function phoneRegex(phone: string): RegExp | null {
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length < 7) return null;
  return new RegExp(`(?<!\\d)(?:\\+?1${PHONE_SEP})?\\(?${[...digits].join("[\\s.()+/\\u2010-\\u2015-]*")}(?!\\d)`, "g");
}

/**
 * The street LINE of a stored address as a pattern: the house number, then up to four street words
 * written as the record has them, each later word optional. "88 Cedar Hollow Court, Franklin, TN
 * 37064" also matches "88 Cedar Hollow" and "88 cedar hollow court" in a message.
 */
const DIRECTIONAL = /^(?:[NSEW]|NE|NW|SE|SW|North|South|East|West)\.?$/i;

function streetLineRegex(address: string): RegExp | null {
  const words = address.split(",")[0].trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || !/^\d/.test(words[0])) return null;
  const rest = words.slice(1, 5).map(escapeRegExp);
  // A directional first word ("100 W Main St") is not enough on its own: "100 W" is also a wattage.
  // Require the next street word too, so only "100 W Main" (and longer) is withheld.
  const required = DIRECTIONAL.test(words[1]) && rest.length >= 2 ? 2 : 1;
  let tail = "";
  for (let i = rest.length - 1; i >= required; i -= 1) tail = `(?:\\s+${rest[i]}${tail})?`;
  const head = rest.slice(0, required).join("\\s+");
  return new RegExp(`(?<!\\d)${escapeRegExp(words[0])}\\s+${head}${tail}(?![A-Za-z0-9])`, "gi");
}

/** Replace the linked record's own phone, email and address strings, wherever they appear. */
function removeLinked(text: string, linked: LinkedContacts | undefined, extraNames?: readonly string[]): string {
  if (!linked && !extraNames) return text;
  let out = text;
  // Longest first, so a full address goes before a fragment of it could be matched on its own.
  const literals = [...(linked?.addresses ?? []), ...(linked?.emails ?? []), ...(extraNames ?? [])]
    .map((l) => l.trim())
    .sort((a, b) => b.length - a.length);
  for (const lit of literals) {
    const re = literalRegex(lit);
    if (re) out = out.replace(re, WITHHELD);
  }
  for (const address of linked?.addresses ?? []) {
    const re = streetLineRegex(address);
    if (re) out = out.replace(re, WITHHELD);
  }
  for (const phone of linked?.phones ?? []) {
    const re = phoneRegex(phone);
    if (re) out = out.replace(re, WITHHELD);
  }
  return out;
}

/**
 * Message text for ANY key (team answer 4): three passes, each match becoming "[withheld]".
 *   1. the linked record's own phone, email and address strings (exact, case-insensitive);
 *   2. phone and email patterns;
 *   3. a US street-address pattern (house number + street name + suffix such as St, Rd, Ave, Dr, Ln,
 *      Ct, Pike, Hwy, Blvd, Way, Cir).
 * The exact pass runs first so a whole "123 Main St, Franklin, TN 37064" goes at once instead of
 * leaving its tail behind; the pattern passes catch an address or number the record does not know
 * (a team or unknown-sender thread). It over-withholds on purpose: "2 outlets on the way" loses a
 * phrase, and nobody's address leaves.
 */
export function scrubMessageText(text: string, linked?: LinkedContacts): string {
  let out = removeLinked(text, linked);
  out = out.replace(EMAIL, WITHHELD).replace(PHONE, WITHHELD);
  out = out.replace(STREET_ADDRESS, WITHHELD).replace(US_SR_ROAD, WITHHELD).replace(BOX_ADDRESS, WITHHELD);
  return out;
}

/**
 * The Scout training profile's text (team answer 16a): everything scrubMessageText removes, plus the
 * full names of customers on the records linked from the thread or the apprentice's visits. Never
 * weaker than the every-key message pass (ruling R2).
 */
export function scrubTrainingText(text: string, linked?: LinkedContacts & { names?: readonly string[] }): string {
  return scrubMessageText(removeLinked(text, undefined, linked?.names), linked);
}

/** The author's first name for a message read, or null: a first name is a ceiling, not a grant. */
export function authorFirstName(name: string | null | undefined, allowNames: boolean): string | null {
  if (!allowNames || !name || !name.trim()) return null;
  return campaignFirstName(name);
}

export interface ScrubOptions {
  /** Also replace phone numbers, email addresses and street addresses (restricted keys; every message read). */
  withholdContact?: boolean;
  /** The linked record's own contact strings, removed exactly (message reads). */
  linked?: LinkedContacts & { names?: readonly string[] };
  /** Exact secret values to remove: active technician tokens, webhook secrets. */
  secrets?: readonly string[];
}

function scrubString(input: string, opts: ScrubOptions, secretRegexes: RegExp[]): string {
  let s = input;
  for (const re of secretRegexes) s = s.replace(re, REDACTED);
  s = s.replace(JWT, REDACTED).replace(AGENT_KEY, REDACTED).replace(STRIPE_KEYS, REDACTED).replace(STRIPE_PREFIXED, REDACTED);
  s = s.replace(CAPABILITY_URL, `$1${REDACTED}`);
  s = s.replace(EIN, REDACTED).replace(ENDING_DIGITS, REDACTED).replace(BANK_NUMBER, REDACTED);
  s = s.replace(CARD_RUN, redactCardIn);
  s = s.replace(NINE_DIGITS, (m) => (abaValid(m) ? REDACTED : m));
  s = s.replace(HEX_LONG, REDACTED);
  s = s.replace(BASE64URL_LONG, (m) => (/[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m) ? REDACTED : m));
  if (opts.withholdContact) {
    s = removeLinked(s, opts.linked, opts.linked?.names);
    s = s.replace(EMAIL, WITHHELD).replace(PHONE, WITHHELD).replace(STREET_ADDRESS, WITHHELD).replace(US_SR_ROAD, WITHHELD).replace(BOX_ADDRESS, WITHHELD);
  }
  return s;
}

/**
 * Walk any value and make it safe for an agent: drop sensitive keys, replace secret-looking text,
 * and (withholdContact) contact details. Pure: returns a new value, never mutates. Dates pass
 * through. Run it on the PARSED profile output, after zod has stripped the undeclared keys.
 */
export function scrub<T>(value: T, opts: ScrubOptions = {}): T {
  const secretRegexes = (opts.secrets ?? [])
    .filter((v) => typeof v === "string" && v.length >= 8)
    .map((v) => new RegExp(escapeRegExp(v), "g"));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrubString(v, opts, secretRegexes);
    if (typeof v === "number") {
      return Number.isInteger(v) && luhnValid(String(Math.abs(v))) ? REDACTED : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Date) return v;
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (isSensitiveKey(k)) continue;
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** Exact secret values the walker removes wherever they appear: active technician tokens and env secrets. */
export async function loadSecretValues(): Promise<string[]> {
  const values: string[] = [];
  const techs = await prisma.technician.findMany({ where: { isActive: true }, select: { accessToken: true } });
  for (const t of techs) if (t.accessToken) values.push(t.accessToken);
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 12 && /WEBHOOK|SECRET|PEPPER|PASSWORD|API_KEY|TOKEN/i.test(name)) values.push(value);
  }
  return values;
}

// ── profiles and agentRespond ────────────────────────────────────────────────────────────────────

/** One field profile: the scope that selects it, its output schema (the allowlist) and whether it withholds contact details. */
export interface AgentOutputProfile {
  scope: AgentScope;
  schema: z.ZodType;
  /** True for every restricted profile and every message-read profile. False only for crm:read record reads. */
  withholdContact: boolean;
}

export interface AgentToolOutput {
  name: string;
  /** Fixed priority order: the first profile whose scope the key holds answers the call. */
  profiles: readonly AgentOutputProfile[];
}

export interface AgentRespondContext {
  linked?: LinkedContacts & { names?: readonly string[] };
  /** More exact secrets to remove (tests, or a caller that already loaded them). */
  secrets?: readonly string[];
}

/**
 * The ONE place an agent answer is made. Returns the scope that authorised it (for the audit's
 * scopeUsed) and the data. A key with none of the tool's scopes gets scope_denied. A record that does
 * not fit its own profile is OUR bug: it is thrown as a plain error (answered "internal", logged),
 * never shown.
 */
export async function agentRespond(
  principal: { scopes: readonly string[] },
  tool: AgentToolOutput,
  raw: unknown,
  ctx: AgentRespondContext = {},
): Promise<{ scopeUsed: AgentScope; data: unknown }> {
  const profile = tool.profiles.find((p) => principal.scopes.includes(p.scope));
  if (!profile) throw new AgentApiError("scope_denied");
  const parsed = profile.schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`agent output for ${tool.name} does not fit its ${profile.scope} profile: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const secrets = [...(await loadSecretValues()), ...(ctx.secrets ?? [])];
  const data = scrub(parsed.data, { withholdContact: profile.withholdContact, linked: ctx.linked, secrets });
  return { scopeUsed: profile.scope, data };
}

// ── pagination ───────────────────────────────────────────────────────────────────────────────────

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 200;

export const pageParamsSchema = z.object({
  limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  cursor: z.string().max(512).optional(),
});

/** Newest first, ties broken by id: the order every agent list uses. */
export const KEYSET_ORDER_BY = [{ createdAt: "desc" as const }, { id: "desc" as const }];

interface CursorPosition {
  t: string;
  i: string;
  f: string;
}

const filterFingerprint = (filters: unknown): string =>
  createHash("sha256").update(JSON.stringify(filters ?? null)).digest("hex").slice(0, 12);

export function encodeCursor(row: { createdAt: Date; id: string }, filters?: unknown): string {
  const pos: CursorPosition = { t: row.createdAt.toISOString(), i: row.id, f: filterFingerprint(filters) };
  return Buffer.from(JSON.stringify(pos)).toString("base64url");
}

export function decodeCursor(cursor: string, filters?: unknown): { createdAt: Date; id: string } {
  try {
    const pos = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPosition;
    const createdAt = new Date(pos.t);
    if (typeof pos.i !== "string" || Number.isNaN(createdAt.getTime())) throw new Error("bad cursor");
    if (pos.f !== filterFingerprint(filters)) throw new Error("filters changed");
    return { createdAt, id: pos.i };
  } catch {
    throw new AgentApiError("bad_cursor");
  }
}

/** The where-fragment that continues after a cursor position, to AND with the caller's own filters. */
export type KeysetWhere = { OR: [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lt: string } }] };

export function keysetWhere(after: { createdAt: Date; id: string }): KeysetWhere {
  return {
    OR: [
      { createdAt: { lt: after.createdAt } },
      { createdAt: after.createdAt, id: { lt: after.id } },
    ],
  };
}

/**
 * Keyset pagination on (createdAt desc, id desc). The caller's `fetch` applies ITS filters plus the
 * `after` fragment on every page and returns `take` rows in KEYSET_ORDER_BY. The cursor is opaque
 * and carries a fingerprint of `filters`, so a cursor from one query cannot continue another. Rows
 * inserted between pages never repeat a row. Returns `{ items, next_cursor }`.
 */
export async function paginate<Row extends { createdAt: Date; id: string }>(
  params: { limit?: number; cursor?: string },
  filters: unknown,
  fetch: (args: { after: KeysetWhere | null; take: number }) => Promise<Row[]>,
): Promise<{ items: Row[]; next_cursor: string | null }> {
  const { limit, cursor } = pageParamsSchema.parse(params);
  const after = cursor ? keysetWhere(decodeCursor(cursor, filters)) : null;
  const rows = await fetch({ after, take: limit + 1 });
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return { items, next_cursor: hasMore ? encodeCursor(items[items.length - 1], filters) : null };
}
