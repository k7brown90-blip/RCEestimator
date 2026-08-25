/**
 * The public allowlist — the single, explicit answer to "what may be reached without a session?"
 *
 * P015, 2026-08-15. Before this, that question had TWO implicit answers and neither was written
 * down:
 *
 *   1. `pinAuthMiddleware` skipped any request whose path did not begin `/api`, and every data
 *      route is mounted at its BARE path. So `GET /api/accounts` returned 401 while
 *      `GET /accounts` returned the full customer list to anyone on the internet. Demonstrated
 *      live in production — P014 report, STOP §1.
 *   2. The middleware was installed most of the way down `app.ts`, so "is this route public?"
 *      was also answered by *where in a 4000-line file the route happened to be written*. A
 *      route added above the mount was public; the same route added below was not.
 *
 * Both are the same failure: public was the DEFAULT and had to be revoked, rather than private
 * being the default and having to be granted. `webhookSecret.ts` already records where that
 * leads — "with no single place that states which routes are public, a route added later simply
 * didn't get the paragraph, and nothing noticed."
 *
 * So: the middleware now runs BEFORE every route, and nothing is public unless it is in this
 * file. A new route is protected by default. Making one public is a visible diff here, with a
 * reason, which is the point.
 *
 * WHAT "PUBLIC" MEANS HERE. It means "exempt from the PIN/JWT session", NOT "unauthenticated".
 * Most entries below carry a DIFFERENT credential — a webhook secret, a bearer token, a
 * URL-path token, an unguessable id — and that credential is checked by the route itself. The
 * `credential` field on each entry names it, so an entry claiming "public, no credential" stands
 * out from one that is simply authenticated another way. Entries whose credential is `none` are
 * the ones worth re-reading periodically.
 *
 * PATHS ARE MATCHED AFTER THE `/api` PREFIX IS STRIPPED (app.ts). That is deliberate and it is
 * what makes the two spellings identical: `/api/accounts` and `/accounts` arrive here as the
 * same path and get the same answer.
 */

import { twilioInboundEnabled } from "../services/automationGate";

/** HTTP methods an entry covers. `"*"` means every method. */
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "*";

export interface PublicRoute {
  methods: Method[];
  /** Exact bare path, or a prefix when `prefix` is true. */
  path: string;
  /** Match `path` and anything beneath it. Boundary-aware: `/health-record` never matches `/health-record-admin`. */
  prefix?: boolean;
  /** What actually authorizes the caller. `none` = genuinely open. */
  credential:
    | "none"
    | "webhook_secret header"
    | "webhook_secret header (flag-gated)"
    | "bearer token"
    | "URL-path token"
    | "query-string secret"
    | "unguessable id in path";
  /** Why this is not behind the session. One line, for the next person deciding whether it still should be. */
  reason: string;
  /**
   * Optional predicate: the entry only grants public access while this returns true.
   *
   * Used for a surface that is *conditionally* in operation. A conditional entry is strictly
   * safer than a permanent one — when the condition is false the route falls through to
   * default-deny — but it does cost the static-table property, so it earns its place only when
   * the alternative is a permanently-public route that is usually switched off.
   */
  when?: () => boolean;
}

export const PUBLIC_ROUTES: PublicRoute[] = [
  // ── Genuinely open ────────────────────────────────────────────────────────────────────────
  {
    methods: ["GET"], path: "/health", credential: "none",
    reason: "Liveness probe. Returns {ok:true} and reads nothing.",
  },
  {
    methods: ["GET"], path: "/healthz", credential: "none",
    reason: "Railway's configured healthcheckPath (railway.json). Gating it fails every deploy.",
  },
  {
    methods: ["POST"], path: "/auth/pin", credential: "none",
    reason: "The login itself. Cannot require the session it issues.",
  },

  // ── Self-authenticating with a different credential ───────────────────────────────────────
  {
    methods: ["*"], path: "/mcp", prefix: true, credential: "bearer token",
    reason: "MCP_BEARER_TOKEN, checked by mcpAuth in app.ts, fail-closed 503 when unset (P012).",
  },
  {
    methods: ["*"], path: "/internal", prefix: true, credential: "URL-path token",
    reason: "Railway crash + Twilio status webhooks. INTERNAL_WEBHOOK_TOKEN in the path, constant-time compare; neither sender can set an Authorization header.",
  },
  {
    methods: ["*"], path: "/agent", prefix: true, credential: "bearer token",
    reason: "Voice-agent tool surface (Savannah/Jerry). AGENT_API_TOKEN; server.ts refuses to boot in production without it.",
  },
  {
    methods: ["*"], path: "/health-record", prefix: true, credential: "bearer token",
    reason: "Field PWA's data surface. Per-technician bearer token. NOTE: /health-record-admin is a DIFFERENT mount and stays session-gated — the boundary check below is what keeps them apart.",
  },

  // ── Vapi / phone agent ────────────────────────────────────────────────────────────────────
  {
    methods: ["POST"], path: "/vapi/assistant-config", credential: "none",
    reason: "Vapi calls this at the start of every inbound call and cannot send a header. Returns assistant id + per-call variables, no customer data. IP rate-limited (publicLimiter) as its only protection — pre-existing, unchanged by P015.",
  },
  {
    methods: ["POST"], path: "/vapi/end-of-call-report", credential: "query-string secret",
    reason: "Vapi post-call webhook; carries its own query-string secret and its own limiter.",
  },
  {
    methods: ["PATCH"], path: "/vapi/update-lead", credential: "webhook_secret header",
    reason: "Agent lead update. Checks WEBHOOK_SECRET in the handler.",
  },
  {
    methods: ["GET", "POST"], path: "/calendar/availability", credential: "webhook_secret header (flag-gated)",
    reason: "Savannah availability lookup. requireWebhookSecretWhenEnabled — enforced only when AGENT_ENDPOINTS_REQUIRE_SECRET=true, because the caller's tool definitions live in the Vapi dashboard, not this repo. See the report's §4.",
  },
  {
    methods: ["POST"], path: "/calendar/book", credential: "webhook_secret header (flag-gated)",
    reason: "Savannah booking. Same flag; additionally on the 5/min bookingLimiter because a call writes a calendar event.",
  },
  {
    methods: ["GET"], path: "/customer/lookup", credential: "webhook_secret header (flag-gated)",
    reason: "Savannah caller lookup. Same flag. RETURNS CUSTOMER DATA when the flag is off — flagged in the report, not changed here (turning the flag on is a Vapi-dashboard-coupled action, not a code action).",
  },
  {
    methods: ["GET"], path: "/calls/daily-summary", credential: "webhook_secret header",
    reason: "requireWebhookSecret (hard, fail-closed). Not flag-gated.",
  },

  // ── Machine-to-machine, webhook_secret in the handler ─────────────────────────────────────
  {
    methods: ["POST"], path: "/leads", credential: "webhook_secret header",
    reason: "The website's lead-capture form. POST ONLY — GET /leads is the full lead list and is deliberately absent from this file; a path exemption for it was removed once before for exactly that reason (see pinAuth.ts).",
  },
  {
    methods: ["POST"], path: "/leads/classify", credential: "webhook_secret header",
    reason: "Email-classifier intake. Checks WEBHOOK_SECRET in the handler.",
  },
  {
    methods: ["GET"], path: "/leads/follow-ups-due", credential: "webhook_secret header",
    reason: "Automation pull for the follow-up queue. Checks WEBHOOK_SECRET in the handler.",
  },
  {
    methods: ["GET"], path: "/leads/loss-report", credential: "webhook_secret header",
    reason: "Automation pull. Checks WEBHOOK_SECRET in the handler.",
  },
  {
    methods: ["PATCH"], path: "/leads/:id/lost", credential: "webhook_secret header",
    reason: "Automation write. Checks WEBHOOK_SECRET in the handler.",
  },
  {
    methods: ["PATCH"], path: "/leads/:id/won", credential: "webhook_secret header",
    reason: "Automation write. Checks WEBHOOK_SECRET in the handler.",
  },
  {
    methods: ["*"], path: "/schedule", prefix: true, credential: "webhook_secret header",
    reason: "Agent/automation schedule reads and writes (today, week, block-time, move-job, cancel-job, update-job). Every handler checks WEBHOOK_SECRET. The CRM's own schedule screens use /crm/schedule/*, which is NOT here and stays session-gated.",
  },
  {
    methods: ["GET", "POST"], path: "/receipts", credential: "webhook_secret header",
    reason: "Receipt capture/read for the automation path. Both handlers check WEBHOOK_SECRET.",
  },
  {
    methods: ["POST"], path: "/documents/generate-contract", credential: "webhook_secret header",
    reason: "Document generation from automation. Checks WEBHOOK_SECRET.",
  },
  {
    methods: ["POST"], path: "/documents/generate-change-order", credential: "webhook_secret header",
    reason: "Change-order generation from automation. Checks WEBHOOK_SECRET.",
  },
  {
    methods: ["POST"], path: "/documents/generate-work-order", credential: "webhook_secret header",
    reason: "Work-order generation from automation. Checks WEBHOOK_SECRET.",
  },
  {
    methods: ["POST"], path: "/documents/generate-material-list", credential: "webhook_secret header",
    reason: "Material-list generation from automation. Checks WEBHOOK_SECRET.",
  },
  {
    methods: ["POST"], path: "/bookings/from-email", credential: "webhook_secret header",
    reason: "Email-booking intake. Checks WEBHOOK_SECRET.",
  },

  // ── Customer-facing surfaces reached from a link we sent them ─────────────────────────────
  {
    methods: ["POST"], path: "/sms/inbound", credential: "none",
    // CLOSED by default as of P017 rev 2 (Kyle's 2026-08-16 ruling). While the channel is shut
    // this entry does not apply, so the route is not public at all — and the closure middleware
    // ahead of the gate answers 410 before default-deny gets to answer 401. The entry survives so
    // that re-opening the channel is one env var and not a code change.
    when: () => twilioInboundEnabled("smsWebhook"),
    reason: "Twilio's inbound-message webhook — public ONLY while TWILIO_INBOUND_SMS_WEBHOOK is on, which it is not. Twilio cannot send a session header, so the channel needs this entry when it is in use; when it is closed the route is refused with 410 and this entry is inert.",
  },
  {
    methods: ["GET", "POST"], path: "/confirm", prefix: true, credential: "unguessable id in path",
    reason: "Appointment confirm/reschedule/cancel page. The customer arrives from an emailed link carrying a random confirmationToken; requiring a login would make the link useless.",
  },
  {
    methods: ["GET"], path: "/sign", prefix: true, credential: "unguessable id in path",
    reason: "Contract signing page. The document cuid in the URL is the capability. Customers are not CRM users and cannot log in.",
  },
  {
    methods: ["POST"], path: "/documents/:id/sign", credential: "unguessable id in path",
    reason: "The signature submission from that page. Same capability model.",
  },
  {
    methods: ["GET"], path: "/documents/:id/pdf", credential: "unguessable id in path",
    reason: "Signed-document retrieval by cuid, linked from the signing flow and from emails. Same capability model — worth revisiting when documents carry per-recipient tokens.",
  },

  // ── Issued estimates: the customer reads and signs (P027) ─────────────────────────────────
  // The ONLY two routes P027 adds to this file. The token is 32 random bytes (256 bits), not a
  // cuid — a cuid embeds a timestamp and a counter, so one issued link would narrow the search
  // space for the next. It scopes to exactly one estimate (`findUnique({ where: { token } })`),
  // and every failure — wrong, malformed, superseded, voided — renders the same 404 page, so a
  // prober cannot tell them apart.
  {
    methods: ["GET"], path: "/e/:token", credential: "URL-path token",
    reason: "The customer's estimate page. They arrive from an email we sent; they are not CRM users and cannot log in. Read-only.",
  },
  {
    methods: ["POST"], path: "/e/:token/sign", credential: "URL-path token",
    reason: "The signature submission from that page — the only write on this surface. Same token, same one-estimate scope; sign-once is enforced by a conditional update in issuedEstimateService.",
  },
  {
    methods: ["GET"], path: "/pay/:token", credential: "URL-path token",
    reason: "The customer's pay-online link from the invoice email. Same estimate token as /e; mints a fresh Stripe Checkout session and redirects — signed, unpaid estimates only, enforced in stripePayments.",
  },
  {
    methods: ["GET"], path: "/pay/:token/qr.svg", credential: "URL-path token",
    reason: "QR image of the pay link, scanned off the tech's or office's screen. Same token; encodes nothing the link itself doesn't.",
  },
  {
    methods: ["GET"], path: "/pay/:token/checkout", credential: "URL-path token",
    reason: "The chooser's second leg — mints the Stripe session for the chosen rail (card at the invoice price, bank with the 3% non-card discount) and redirects. Same token, same guards in stripePayments.",
  },
  {
    methods: ["POST"], path: "/stripe/webhook", credential: "query-string secret",
    reason: "Stripe event delivery. Authenticated by the Stripe-Signature header verified against STRIPE_WEBHOOK_SECRET over the raw body — mounted before the JSON parser in app.ts for exactly that reason.",
  },
];

/** Path-segment-aware prefix test: `/health-record` matches `/health-record/x`, never `/health-record-admin`. */
function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Match a concrete request path against an entry whose declared path may contain `:params`.
 * `/documents/:id/sign` matches `/documents/abc123/sign` and nothing shorter or longer.
 */
function matchesParamPath(path: string, declared: string): boolean {
  const a = path.split("/");
  const b = declared.split("/");
  if (a.length !== b.length) return false;
  return b.every((seg, i) => (seg.startsWith(":") ? a[i].length > 0 : seg === a[i]));
}

/**
 * The allowlist entry covering this request, or null when the request needs a session.
 *
 * Trailing slashes are normalized so `/accounts/` cannot slip past an exact-match entry — the
 * whole class of bug this file exists to close is "the same resource under a different spelling".
 */
/**
 * Does this entry's METHOD and PATH cover the request? Pure — ignores `when` entirely.
 *
 * Separated from `publicRouteFor` so a test can verify every entry's own declared path matches
 * its own matcher (catching a typo that would silently grant nothing) without that check being
 * defeated by a conditional entry that happens to be switched off.
 */
export function entryCovers(entry: PublicRoute, method: string, rawPath: string): boolean {
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
  const m = method.toUpperCase();
  if (!entry.methods.includes("*") && !entry.methods.includes(m as Method)) return false;
  return entry.prefix
    ? matchesPrefix(path, entry.path)
    : entry.path.includes(":")
      ? matchesParamPath(path, entry.path)
      : path === entry.path;
}

export function publicRouteFor(method: string, rawPath: string): PublicRoute | null {
  for (const entry of PUBLIC_ROUTES) {
    if (!entryCovers(entry, method, rawPath)) continue;
    // A conditional entry that is currently false grants nothing. Continue rather than return,
    // so a later entry could still cover the path — and if none does, default-deny.
    if (entry.when && !entry.when()) continue;
    return entry;
  }
  return null;
}

/** True when this request may proceed without a PIN/JWT session. */
export function isPublicRoute(method: string, path: string): boolean {
  return publicRouteFor(method, path) !== null;
}
