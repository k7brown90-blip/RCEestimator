import express from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { prisma } from "./lib/prisma";

import { EstimateService } from "./services/estimateService";
import { resolveItemCable } from "./services/wiringMethodResolver";
import { generateSupportItems } from "./services/supportItemTriggers";
import { getAvailability, bookAppointment, BookingConflictError, BookingInputError } from "./services/googleCalendar";
import { getDailySummary } from "./services/dailySummary";
import { getTodaySchedule, getWeekSchedule, getMonthSchedule, getEventsInRange, createCalendarEvent, deleteCalendarEvent, moveCalendarEvent } from "./services/schedule";
import { techAvailabilityForDate, ctToUtc } from "./services/techCalendars";
import { sendSms, KYLE_PHONE } from "./services/twilio";
import { webOptInConfirmation } from "./services/notifications";
import { logSystemEvent } from "./services/systemEvents";
import { applyCallDisposition } from "./services/callDisposition";
import { truncate } from "./routes/agent-helpers";
import { generateContract, generateChangeOrder, generateWorkOrder, generateMaterialList, markDocumentSigned } from "./services/pdfGenerator";
import { sendConfirmationEmail, sendProposalEmail, sendKyleNotificationEmail } from "./services/confirmationEmail";
import {
  getCrmOverview,
  getCycleTimeMetrics,
  getLeadFollowUpMetrics,
  getLeadFunnelMetrics,
  getWinLossMetrics,
  resolveAnalyticsRange,
} from "./services/crmAnalytics";
import { handleMcpPost, handleMcpGet, handleMcpDelete } from "./mcp/server";
import { pinAuthMiddleware, handlePinLogin } from "./middleware/pinAuth";
import {
  addLine,
  browseAtomics,
  createDraft,
  removeLine,
  computeDraft,
  confirmProposedLine,
  finalizeDraft,
  findAtomicByCode,
  getDraftReview,
  looksLikeLegacyCode,
  rejectProposedLine,
  resolveQuestion,
} from "./services/atomicEstimateService";
import { AGENT_INSTRUCTIONS } from "./agentInstructions";
import { agentRouter } from "./routes/agent";
import { healthRecordTechRouter, healthRecordAdminRouter } from "./routes/health-record";
import { capacityCheckTechRouter, capacityCheckAdminRouter } from "./routes/capacityCheck";
import {
  scheduleJob, rescheduleJob, cancelJob, ConflictError,
  appointmentKindFor, ESTIMATE_TRAVEL_BUFFER_MINUTES,
} from "./services/scheduling";
import { rollupJobCosts, getLaborRate, sumJobCosts, estimateOptionTotal } from "./services/jobCosting";
import { parseJsonArrayLength, parseJsonStringArray } from "./lib/json";
import { findCustomerMatches } from "./services/customerMatch";
import { KNOWN_JURISDICTION_IDS } from "./services/jurisdictionResolver";
import { requireWebhookSecret, requireWebhookSecretWhenEnabled } from "./middleware/webhookSecret";
import { savannahRouter } from "./routes/agent-savannah";
import { jerryRouter } from "./routes/agent-jerry";
import { sharedAgentRouter } from "./routes/agent-shared";
import { inboundSmsRouter } from "./routes/inboundSms";
import { confirmPageRouter } from "./routes/confirmPage";
import { internalRouter, healthzHandler } from "./routes/internal-alerts";
import { sendWebLeadAutoReply } from "./services/visitConfirmations";
import {
  customerSendsEnabled,
  logCustomerSendSkipped,
  logTwilioSendSkipped,
  twilioSendEnabled,
} from "./services/automationGate";

const service = new EstimateService(prisma);

export const app = express();

// Railway (and most hosts) put a single reverse proxy in front of the app.
// Without this, express-rate-limit can't tell real callers apart by IP — every
// request behind the proxy looks the same, so a shared budget meant to be
// per-caller instead becomes one global bucket every caller draws from.
app.set("trust proxy", 1);

// ─── SERVE THE HEALTH RECORD FIELD PWA (/field) ──────────────────────────────
// Mounted BEFORE the CRM's SPA fallback below, which would otherwise swallow
// every HTML navigation and hand back the CRM shell instead. The PWA is built
// with base '/field/' (field/vite.config.ts) — the two must stay in step.
//
// Not behind pinAuthMiddleware by design: it's an offline-first PWA, so a
// session-gated shell would break installation and service-worker updates. The
// shell holds no data — everything comes from /health-record/*, which requires a
// technician bearer token. noindex keeps it out of search results.
const fieldDist = path.join(__dirname, "..", "..", "field", "dist");
if (fs.existsSync(fieldDist)) {
  app.use(
    "/field",
    (_req, res, next) => {
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      next();
    },
    express.static(fieldDist, {
      setHeaders: (res, filePath) => {
        // The shell and the worker gate every update an installed phone sees;
        // a stale cached copy of either strands the device on an old build.
        if (/index\.html$|service-worker\.js$/.test(filePath)) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        }
      },
    }),
  );

  // SPA fallback scoped to /field, so deep links land in the PWA, not the CRM.
  app.use("/field", (req, res, next) => {
    const accepts = req.headers.accept || "";
    if (req.method === "GET" && accepts.includes("text/html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.sendFile(path.join(fieldDist, "index.html"));
      return;
    }
    next();
  });
}

// ─── SERVE CLIENT STATIC FILES (before auth, so login page loads) ────────────
// At runtime __dirname is dist/src/, so go up two levels to reach app root
const clientDist = path.join(__dirname, "..", "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));

  // SPA fallback: serve index.html for browser navigation requests (not API/file)
  app.use((req, res, next) => {
    const accepts = req.headers.accept || "";
    if (req.method === "GET" && accepts.includes("text/html") && !req.path.startsWith("/api")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.sendFile(path.join(clientDist, "index.html"));
      return;
    }
    next();
  });
}

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// CORS headers for public endpoints
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, webhook_secret");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Strip /api prefix and mark as API request
app.use((req: express.Request & { _isApi?: boolean }, _res, next) => {
  if (req.path.startsWith("/api/") || req.path === "/api") {
    req._isApi = true;
    req.url = req.url.replace(/^\/api/, "") || "/";
  }
  next();
});

// ─── RATE LIMITING ───────────────────────────────────────────────────────────
// Public, unauthenticated endpoints get a tight per-IP budget; everything else
// under the API gets a generous safety net. Disabled under test.
const skipLimiter = () => process.env.NODE_ENV === "test";
// /vapi/end-of-call-report carries its own query-string secret (unlike its
// /vapi siblings, which have no auth and rely on this limiter as their only
// spam protection), so it gets its own generous budget below instead — skip
// it here rather than let both limiters draw from the same request.
const publicLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => skipLimiter() || req.originalUrl.startsWith("/vapi/end-of-call-report"),
});
const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipLimiter,
});
/**
 * Booking is its own budget, and a small one.
 *
 * `POST /calendar/book` writes a real event to the calendar, consumes the slot,
 * and sends a confirmation SMS and email to whatever phone number and address
 * the request supplies — from Red Cedar's Twilio number and Gmail account. That
 * makes an unauthenticated 30/min into a way to spend money and get the number
 * flagged as spam, which would take real customer confirmations down with it.
 *
 * The agent books one appointment per call, so five a minute costs nothing
 * legitimate. This is a stopgap: the real fix is the shared secret below, which
 * has to wait for the Vapi dashboard.
 */
const bookingLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipLimiter,
});
/**
 * end-of-call-report is authenticated by its own query-string secret (see the
 * route below), unlike its /vapi siblings (assistant-config, and everything
 * else on the public prefixes) which have no auth and rely on IP rate limiting
 * as their only spam protection. It doesn't need to share that tight 30/min
 * budget — it needs to never block a legitimate Vapi retry after a call ends.
 */
const vapiWebhookLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipLimiter,
});
app.use(["/leads", "/customer/lookup", "/calendar/availability", "/vapi", "/auth/pin", "/confirm", "/sms/inbound"], publicLimiter);
app.use("/vapi/end-of-call-report", vapiWebhookLimiter);
app.use("/calendar/book", bookingLimiter);
app.use((req: express.Request & { _isApi?: boolean }, res, next) => {
  if (req._isApi) {
    apiLimiter(req, res, next);
    return;
  }
  next();
});

// ─── MCP ENDPOINT ────────────────────────────────────────────────────────────
const mcpBearerToken = process.env.MCP_BEARER_TOKEN;

/**
 * FAIL-CLOSED (P012, closing P011 review follow-up 1).
 *
 * This used to call `next()` when MCP_BEARER_TOKEN was unset — an unauthenticated endpoint
 * exposing the model's tool surface to anyone who could reach the public domain. Production was
 * safe only because the variable happened to be set, which makes the protection a configuration
 * fact rather than a code fact: clearing one Railway variable would have silently opened it.
 *
 * Now an unset token refuses everything with 503. The endpoint is *unconfigured*, not *open* —
 * and 503 says exactly that, where 401 would imply "your credentials were wrong."
 */
const mcpAuth: express.RequestHandler = (req, res, next) => {
  if (!mcpBearerToken) {
    // eslint-disable-next-line no-console
    console.error(
      "[mcp] REFUSED — MCP_BEARER_TOKEN is not set. The MCP endpoint exposes the AI's tool " +
        "surface and will not serve unauthenticated traffic. Set the variable to enable it.",
    );
    res.status(503).json({
      error: "MCP endpoint is not configured",
      detail: "MCP_BEARER_TOKEN is unset; the endpoint refuses rather than serving unauthenticated.",
    });
    return;
  }
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${mcpBearerToken}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};
app.post("/mcp", mcpAuth, (req, res) => { handleMcpPost(req, res); });
app.get("/mcp", mcpAuth, (req, res) => { handleMcpGet(req, res); });
app.delete("/mcp", mcpAuth, (req, res) => { handleMcpDelete(req, res); });

const asyncHandler = (fn: express.RequestHandler): express.RequestHandler => {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};

const readParam = (req: express.Request, key: string): string => {
  const raw = req.params[key];
  if (Array.isArray(raw)) {
    return raw[0] ?? "";
  }
  return raw ?? "";
};

const readQuery = (req: express.Request, key: string): string | undefined => {
  const raw = req.query[key];
  if (Array.isArray(raw)) {
    const first = raw[0];
    return typeof first === "string" ? first : undefined;
  }
  return typeof raw === "string" ? raw : undefined;
};

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// /healthz is the deep check Railway targets in railway.json's healthcheckPath.
// It answers 200 only when the DB is reachable; 503 with a reason otherwise.
app.get("/healthz", healthzHandler);

// Internal ops: Railway crash webhook + Twilio delivery-status callback.
// Auth lives in the router (URL-path token, constant-time compare).
app.use("/internal", internalRouter);

// ─── VAPI DYNAMIC VARIABLES (no auth — called at start of each inbound call) ──
// Vapi hits this on every inbound call when the phone number's `server.url` is
// pointed here. On `assistant-request` we reply with the existing assistantId
// and per-call variableValues; on any other message type we ack with 200 so
// Vapi treats the request as handled without changing the assistant.
app.post("/vapi/assistant-config", (req, res) => {
  const now = new Date();
  const current_date = now.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const current_time = now.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
  });
  const variableValues = {
    current_date,
    current_time,
    currentDateTime: `${current_date}, ${current_time} Central Time`,
  };

  const messageType = (req.body?.message?.type ?? req.body?.type) as string | undefined;
  const savannahAssistantId = process.env.VAPI_ASSISTANT_ID ?? "91c88bcc-098e-4816-b374-06688208c0a3";

  if (messageType === "assistant-request") {
    res.json({
      assistantId: savannahAssistantId,
      assistantOverrides: { variableValues },
    });
    return;
  }

  // Legacy / manual test callers still get the raw variableValues.
  res.json({ variableValues, assistantId: savannahAssistantId });
});

// ─── VAPI END-OF-CALL SAFETY NET (query-string secret — see below) ──────────
//
// Prompt rules can tell Savannah to call log_call_disposition, but a model
// under multi-step pressure (apologize, re-check availability, re-offer slots)
// can skip a tool call it was told to make. This is the backend backstop:
// point the assistant's Server URL at this address with a `key` query param,
// and when Vapi reports a call ended, check whether that call.id already got
// a disposition logged. If not, log a generic fallback so a dropped call never
// produces zero record — this cannot be skipped by model drift, since it runs
// after the call regardless of what happened during it.
//
// Fail-closed like every other secret in this file: with VAPI_SERVER_SECRET
// unset, the endpoint refuses everything rather than accepting unauthenticated
// call data.
app.post("/vapi/end-of-call-report", asyncHandler(async (req, res) => {
  const configured = process.env.VAPI_SERVER_SECRET;
  if (!configured || readQuery(req, "key") !== configured) {
    res.status(401).json({ error: "Invalid or missing key" });
    return;
  }

  const message = req.body?.message ?? req.body;
  const messageType = message?.type as string | undefined;
  if (messageType !== "end-of-call-report") {
    res.status(200).json({ ok: true });
    return;
  }

  const callId = message?.call?.id as string | undefined;
  if (!callId) {
    logSystemEvent("warn", "vapi-eocr", "end-of-call-report with no call.id — cannot check for a logged disposition");
    res.status(200).json({ ok: true });
    return;
  }

  const alreadyLogged = await prisma.agentAuditLog.findFirst({
    where: { action: "call_disposition", callId },
    select: { id: true },
  });
  if (alreadyLogged) {
    res.status(200).json({ ok: true, alreadyLogged: true });
    return;
  }

  const phone = (message?.call?.customer?.number ?? message?.customer?.number) as string | undefined;
  const transcript = (message?.transcript ?? message?.artifact?.transcript) as string | undefined;
  const summary = (message?.summary ?? message?.analysis?.summary) as string | undefined;
  const notes = [
    "Auto-logged: no disposition was recorded for this call.",
    summary ? `Summary: ${summary}` : null,
    transcript ? `Transcript: ${truncate(transcript, 4000)}` : null,
  ].filter(Boolean).join("\n");

  const { lead, created } = await applyCallDisposition({
    phone,
    callType: "auto_fallback",
    leadStatus: "unresolved",
    notes,
  });

  logSystemEvent("warn", "vapi-eocr", "Call ended with no disposition logged — auto-fallback applied", {
    route: "POST /vapi/end-of-call-report",
    callId,
    leadId: lead.id,
    leadCreated: created,
  });
  // Awaited, not fire-and-forget: a near-simultaneous retry of this same
  // webhook must see this row before it decides whether to log again.
  await prisma.agentAuditLog.create({
    data: {
      action: "call_disposition",
      endpoint: "/vapi/end-of-call-report",
      entityType: "lead",
      entityId: lead.id,
      payloadJson: JSON.stringify({ leadStatus: "unresolved", callType: "auto_fallback", created, auto: true }),
      responseStatus: 200,
      callId,
    },
  });

  res.status(200).json({ ok: true, leadId: lead.id, leadCreated: created });
}));

// ─── CALENDAR AVAILABILITY (agent endpoint — see middleware/webhookSecret) ───
// Free/busy windows only: when Kyle is working and how full he is. No names, no
// addresses, no contact details — roughly what a customer learns by calling and
// asking. Behind the flag with its neighbours for consistency, not urgency.
const availability = asyncHandler(async (_req: express.Request, res: express.Response) => {
  const data = await getAvailability();
  res.json(data);
});
app.get("/calendar/availability", requireWebhookSecretWhenEnabled("GET /calendar/availability"), availability);
app.post("/calendar/availability", requireWebhookSecretWhenEnabled("POST /calendar/availability"), availability);

/**
 * CALENDAR BOOKING — the endpoint with real teeth.
 *
 * A successful call writes an event to the live Google Calendar, takes the slot
 * so no one else can have it, and sends a confirmation SMS and email to whatever
 * phone number and address the request supplied — from Red Cedar's Twilio number
 * and Gmail account.
 *
 * Unauthenticated, that is an open relay: a way to spend money sending branded
 * messages to arbitrary recipients, and to get the number flagged as spam, which
 * would take real customer confirmations down with it. It is also a way to book
 * out the calendar so no genuine customer can get a slot.
 *
 * Rate-limited to 5/min above as a stopgap. The actual fix is the shared secret,
 * waiting on the Vapi dashboard.
 */
app.post("/calendar/book", requireWebhookSecretWhenEnabled("POST /calendar/book"), asyncHandler(async (req, res) => {
  const { date, startTime, customerName, description, address, email, phone } = req.body;
  if (!date || !startTime || !customerName || !description || !address) {
    res.status(400).json({
      error: "Required: date, startTime, customerName, description, address",
      spoken_fallback: "I'm missing some details to book that — can you give me the customer's name, the address, and what the visit is for?",
    });
    return;
  }
  try {
    const result = await bookAppointment({ date, startTime, customerName, description, address, email, phone });
    res.json(result);
  } catch (err) {
    if (err instanceof BookingConflictError) {
      res.status(409).json({
        error: err.message,
        spoken_fallback: "That time just became unavailable. Let me check the openings again and offer you another slot.",
      });
      return;
    }
    if (err instanceof BookingInputError) {
      res.status(400).json({
        error: err.message,
        spoken_fallback: "I want to make sure I book this correctly — could you confirm the exact day and time once more?",
      });
      return;
    }
    // Every failure path from here on must still carry a spoken_fallback —
    // the tool-use rule is "error key present -> speak spoken_fallback", and
    // an unhandled error falling through to the generic 500 handler doesn't
    // have one, which leaves the caller with dead air instead of an apology.
    logSystemEvent("error", "calendar-book", err instanceof Error ? err.message : "Unknown booking error", {
      route: "POST /calendar/book",
      stack: err instanceof Error ? err.stack : undefined,
    });
    res.status(500).json({
      error: "Booking failed unexpectedly",
      spoken_fallback: "Something went wrong on my end booking that. Let me have Kyle's team confirm this appointment directly and call you back.",
    });
  }
}));

// ─── CUSTOMER LOOKUP (no auth — called by Vapi AI assistant) ─────────────────
const KYLE_PHONE_10 = "9706661626";

/**
 * Caller lookup for the phone agent.
 *
 * Returns a complete customer record — name, phone, email, every property
 * address, every visit with its purpose and estimate total, warranty status and
 * open leads. It has never required authentication.
 *
 * It cannot simply be locked: the tool definitions that call it live in the Vapi
 * dashboard, outside this repository, so the caller and the endpoint cannot be
 * changed in one commit. Locking it blind would find out whether the dashboard
 * was updated by failing during a customer's call.
 *
 * So enforcement sits behind AGENT_ENDPOINTS_REQUIRE_SECRET, and every
 * unauthenticated call is logged either way. Add the `webhook_secret` header to
 * the Vapi tools, watch the log go quiet, then set the flag.
 * See docs/SECURING_THE_AGENT.md.
 */
app.get("/customer/lookup", requireWebhookSecretWhenEnabled("GET /customer/lookup"), asyncHandler(async (req, res) => {
  const phoneRaw = (readQuery(req, "phone") ?? "").replace(/\D/g, "").slice(-10);
  const nameRaw = (readQuery(req, "name") ?? "").trim();

  // Must provide phone or name
  if ((!phoneRaw || phoneRaw.length < 10) && !nameRaw) {
    res.json({ found: false });
    return;
  }

  // Kyle's cell → transfer signal (phone lookup only)
  if (phoneRaw === KYLE_PHONE_10) {
    res.json({ found: true, type: "kyle_transfer", name: "Kyle" });
    return;
  }

  // ── Helper: build full customer response ──
  const buildCustomerResponse = async (customer: Awaited<ReturnType<typeof prisma.customer.findMany>>[0] & { properties: Array<{ id: string; addressLine1: string; city: string | null; state: string | null; postalCode: string | null; occupancyType: string | null; visits: Array<{ id: string; visitDate: Date; mode: string; purpose: string | null; estimates: Array<{ status: string; options: Array<{ accepted: boolean; totalPrice?: number }> }> }> }> }) => {
    const now = new Date();
    const oneYearAgo = new Date(now.getTime() - 365 * 86_400_000);
    let warrantyEligible = false;
    let warrantyNote: string | null = null;

    const properties = customer.properties.map((prop) => ({
      propertyId: prop.id,
      address: [prop.addressLine1, prop.city, prop.state, prop.postalCode].filter(Boolean).join(", "),
      occupancyType: prop.occupancyType || "residential",
      visits: prop.visits.map((visit) => {
        const acceptedOpt = visit.estimates[0]?.options.find((o) => o.accepted);
        const total = acceptedOpt ? (acceptedOpt as unknown as { totalPrice?: number }).totalPrice ?? 0 : 0;
        if (visit.estimates.length > 0 && visit.visitDate >= oneYearAgo) {
          warrantyEligible = true;
          warrantyNote = `${visit.purpose || "Work"} completed ${visit.visitDate.toISOString().slice(0, 10)} — within 12 month warranty window`;
        }
        return {
          visitId: visit.id,
          date: visit.visitDate.toISOString().slice(0, 10),
          mode: visit.mode,
          purpose: visit.purpose,
          estimateStatus: visit.estimates[0]?.status ?? null,
          estimateTotal: total,
        };
      }),
    }));

    const allVisits = properties.flatMap((p) => p.visits);
    const mostRecent = allVisits[0] ?? null;
    const openLeads = await prisma.lead.findMany({
      where: { customerId: customer.id, status: { in: ["new", "contacted"] } },
      orderBy: { createdAt: "desc" },
    });

    return {
      found: true,
      type: "customer",
      name: customer.name,
      customerId: customer.id,
      phone: customer.phone,
      email: customer.email,
      properties,
      totalVisits: allVisits.length,
      mostRecentVisit: mostRecent ? {
        date: mostRecent.date,
        mode: mostRecent.mode,
        purpose: mostRecent.purpose,
        propertyAddress: properties.find((p) => p.visits.some((v) => v.visitId === mostRecent.visitId))?.address ?? "",
      } : null,
      warrantyEligible,
      warrantyNote,
      openLeads: openLeads.map((l) => ({
        leadId: l.id,
        status: l.status,
        jobType: l.jobType,
        createdAt: l.createdAt.toISOString().slice(0, 10),
      })),
    };
  };

  const customerInclude = {
    properties: {
      include: {
        visits: {
          orderBy: { visitDate: "desc" as const },
          include: {
            estimates: {
              where: { status: "accepted" },
              include: { options: { where: { accepted: true } } },
            },
          },
        },
      },
    },
  };

  const buildLeadResponse = (lead: { id: string; name: string; phone: string | null; email: string | null; address: string | null; jobType: string | null; status: string; callType: string | null; notes: string | null; createdAt: Date }) => ({
    found: true,
    type: "lead",
    name: lead.name,
    leadId: lead.id,
    phone: lead.phone,
    email: lead.email,
    address: lead.address,
    jobType: lead.jobType,
    status: lead.status,
    callType: lead.callType,
    notes: lead.notes,
    createdAt: lead.createdAt.toISOString().slice(0, 10),
  });

  // ── Phone-based lookup ──
  // TODO: switch to services/customerMatch.findCustomerMatches. `contains phoneRaw`
  // finds "+16155550101" but misses "(615) 555-0101", so the shared matcher would
  // find strictly more accounts — but this is the live voice-agent path, and what
  // it returns changes what a caller hears. Pin the current behaviour with a test
  // before swapping it.
  if (phoneRaw && phoneRaw.length === 10) {
    const customers = await prisma.customer.findMany({
      where: { phone: { contains: phoneRaw } },
      include: customerInclude,
    });
    if (customers.length > 0) {
      res.json(await buildCustomerResponse(customers[0] as Parameters<typeof buildCustomerResponse>[0]));
      return;
    }

    const leads = await prisma.lead.findMany({
      where: { phone: { contains: phoneRaw }, status: { in: ["new", "contacted"] } },
      orderBy: { createdAt: "desc" },
    });
    if (leads.length > 0) {
      res.json(buildLeadResponse(leads[0]));
      return;
    }
  }

  // ── Name-based lookup (for Kyle transfer scenario) ──
  //
  // Minimum length is a guard, not a nicety. This endpoint is unauthenticated
  // (see the block comment above the route) and returns a full customer record,
  // so `?name=a` was a substring match that would walk the customer base one
  // letter at a time. Three characters is long enough that a caller's actual name
  // still matches and short enough not to break any real lookup.
  if (nameRaw.length >= 3) {
    const customers = await prisma.customer.findMany({
      where: { name: { contains: nameRaw } },
      include: customerInclude,
    });
    if (customers.length > 0) {
      res.json(await buildCustomerResponse(customers[0] as Parameters<typeof buildCustomerResponse>[0]));
      return;
    }

    const leads = await prisma.lead.findMany({
      where: { name: { contains: nameRaw }, status: { in: ["new", "contacted"] } },
      orderBy: { createdAt: "desc" },
    });
    if (leads.length > 0) {
      res.json(buildLeadResponse(leads[0]));
      return;
    }
  }

  res.json({ found: false });
}));

// ─── DAILY CALL SUMMARY ─────────────────────────────────────────────────────
// Returns today's leads with names, phone numbers, addresses and notes, so it
// takes the shared secret like every other machine-to-machine endpoint.
//
// The 6pm digest is unaffected: it calls getDailySummary() directly as a
// function (services/dailySummary.ts:133), never over HTTP.
app.get("/calls/daily-summary", requireWebhookSecret, asyncHandler(async (_req, res) => {
  const data = await getDailySummary();
  res.json(data);
}));

// ─── LEAD WEBHOOK (no JWT — uses shared secret) ────────────────────────────
app.post("/leads", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }

  const body = req.body as { name?: string; email?: string; phone?: string; source?: string; notes?: string; address?: string; jobType?: string; callType?: string; referredBy?: string; urgentFlag?: boolean; warrantyCall?: boolean; warrantyNote?: string; estimateId?: string; existingVisitId?: string; contactPreference?: string; leadStatus?: string; bestTimeToReach?: string; customerId?: string; propertyId?: string; smsConsent?: boolean };
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const lead = await prisma.lead.create({
    data: {
      name: body.name.trim(),
      email: body.email?.trim() || null,
      phone: body.phone?.trim() || null,
      source: body.source || "email",
      notes: body.notes?.trim() || null,
      address: body.address?.trim() || null,
      jobType: body.jobType?.trim() || null,
      callType: body.callType?.trim() || null,
      referredBy: body.referredBy?.trim() || null,
      urgentFlag: body.urgentFlag ?? false,
      warrantyCall: body.warrantyCall ?? false,
      warrantyNote: body.warrantyNote?.trim() || null,
      estimateId: body.estimateId?.trim() || null,
      existingVisitId: body.existingVisitId?.trim() || null,
      contactPreference: body.contactPreference?.trim() || null,
      leadStatus: body.leadStatus?.trim() || "new",
      bestTimeToReach: body.bestTimeToReach?.trim() || null,
      // Only an explicit boolean is recorded — anything else stays null. Null
      // is NOT the same as consent: the send gate in services/twilio.ts only
      // allows sends to a known Lead/Customer when this is exactly `true`.
      smsConsent: typeof body.smsConsent === "boolean" ? body.smsConsent : null,
      customerId: body.customerId?.trim() || null,
      propertyId: body.propertyId?.trim() || null,
    },
  });

  res.status(201).json(lead);

  // SMS Kyle for web leads (fire-and-forget)
  //
  // GATED (no-Twilio-texts ruling 2026-08-13). P004 deliberately left this one running so Kyle
  // would still know a lead landed; the 2026-08-13 clarification withdrew that exception. The
  // Lead row is created regardless and shows up in the CRM lead queue — that is the channel now.
  if ((body.source === "web") && lead.phone) {
    if (twilioSendEnabled("operatorNotifications")) {
      sendSms(KYLE_PHONE, `New web lead — ${lead.name}, ${lead.jobType ?? "general"}, ${lead.phone}`).catch(() => {});
    } else {
      logTwilioSendSkipped("operatorNotifications", `New web lead ${lead.id} is in the CRM lead queue.`);
    }
  }

  // One-time opt-in confirmation SMS — sent exactly once, the moment consent
  // is granted, before any other customer-facing text. Wording is locked and
  // must match what's declared to Twilio's A2P campaign; see
  // services/notifications.ts webOptInConfirmation(). Goes through the normal
  // sendSms() gate (not bypassed) since smsConsent is already true here.
  //
  // GATED (manual-first, 2026-08-11): both of these fire on the customer's own form
  // submission with no RCE human in the loop, which makes them unattended customer sends.
  // Kyle answers web leads himself while the company runs manual-first. The SMS-to-Kyle
  // above is NOT gated — he still needs to know a lead landed.
  //
  // DOUBLE-GATED since 2026-08-13: the class-1 flag coming back on must not resurrect a Twilio
  // text on its own. Both gates have to pass for this to send.
  if (body.source === "web" && lead.phone && lead.smsConsent === true) {
    if (!customerSendsEnabled("webLeadAutoReply")) {
      logCustomerSendSkipped("webLeadAutoReply", `Opt-in confirmation SMS to lead ${lead.id} suppressed.`);
    } else if (!twilioSendEnabled("customerLifecycleSms")) {
      logTwilioSendSkipped("customerLifecycleSms", `Opt-in confirmation SMS to lead ${lead.id} suppressed.`);
    } else {
      sendSms(lead.phone, webOptInConfirmation()).catch((err) => console.error("[leads] Opt-in confirmation SMS failed:", err));
    }
  }

  // Instant auto-reply email for web-form leads (fire-and-forget)
  if (body.source === "web" && lead.email) {
    if (customerSendsEnabled("webLeadAutoReply")) {
      sendWebLeadAutoReply({ name: lead.name, email: lead.email, jobType: lead.jobType }).catch((err) => console.error("[leads] Auto-reply email failed:", err));
    } else {
      logCustomerSendSkipped("webLeadAutoReply", `Auto-reply email to lead ${lead.id} suppressed.`);
    }
  }
}));

// ─── SPAM CLASSIFICATION (webhook secret) ──────────────────────────────────
app.post("/leads/classify", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }

  const subject = (req.body.subject || req.query.subject || "") as string;
  const from = (req.body.from || req.query.from || "") as string;
  const emailBody = (req.body.body || req.query.body || "") as string;
  const fromName = (req.body.name || req.query.name || "") as string;

  const fallback = {
    classification: "real_customer", reason: "OpenAI not available",
    name: fromName, phone: "", email: from, address: "",
    jobType: "", summary: subject || "", source: "email",
  };

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    res.json({ ...fallback, reason: "OpenAI not configured" });
    return;
  }

  const prompt = `You are an email classifier and data extractor for Red Cedar Electric LLC, a residential electrical contractor in Middle Tennessee.

Given an inbound email, do TWO things:
1. Classify it into ONE category:
   - real_customer_high — clearly a real person with a legitimate electrical need
   - real_customer_low — probably real but vague or incomplete
   - likely_spam — SEO pitches, marketing offers, automated notifications, nonsensical text
   - scammer — phishing, fake urgency, suspicious links
   - vendor — supplier or vendor solicitation
2. Extract any contact/job details you can find in the email

Respond with JSON only:
{"classification":"...","reason":"one sentence","name":"extracted name or empty string","phone":"extracted phone or empty string","email":"extracted email or empty string","address":"extracted address or empty string","jobType":"short description of electrical work needed or empty string","summary":"one sentence summary of the request"}

Email subject: ${subject}
Email from: ${fromName ? `${fromName} <${from}>` : from}
Email body:
${emailBody}`;

  try {
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 300,
      }),
    });

    if (!aiRes.ok) {
      res.json({ ...fallback, reason: "OpenAI API error" });
      return;
    }

    const aiData = await aiRes.json() as { choices: Array<{ message: { content: string } }> };
    const raw = aiData.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as {
      classification: string; reason: string;
      name: string; phone: string; email: string;
      address: string; jobType: string; summary: string;
    };
    res.json({
      classification: parsed.classification,
      reason: parsed.reason,
      name: parsed.name || fromName,
      phone: parsed.phone || "",
      email: parsed.email || from,
      address: parsed.address || "",
      jobType: parsed.jobType || "",
      summary: parsed.summary || subject,
      source: "email",
    });
  } catch {
    res.json({ ...fallback, reason: "Classification failed" });
  }
}));

// ─── UPDATE LEAD (no JWT — webhook secret, called by Vapi) ──────────────────
app.patch("/vapi/update-lead", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }

  const body = req.body as {
    leadId?: string; notes?: string; callType?: string; address?: string;
    jobType?: string; warrantyCall?: boolean; warrantyNote?: string;
    urgentFlag?: boolean; referredBy?: string; email?: string;
    estimateId?: string; existingVisitId?: string; status?: string;
    contactPreference?: string; leadStatus?: string;
    followUpDate?: string; followUpReason?: string; followUpCount?: number;
    lostReason?: string; lostNotes?: string; bestTimeToReach?: string;
  };

  if (!body.leadId) {
    res.status(400).json({ error: "leadId is required" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (body.notes !== undefined) data.notes = body.notes;
  if (body.callType !== undefined) data.callType = body.callType;
  if (body.address !== undefined) data.address = body.address;
  if (body.jobType !== undefined) data.jobType = body.jobType;
  if (body.warrantyCall !== undefined) data.warrantyCall = body.warrantyCall;
  if (body.warrantyNote !== undefined) data.warrantyNote = body.warrantyNote;
  if (body.urgentFlag !== undefined) data.urgentFlag = body.urgentFlag;
  if (body.referredBy !== undefined) data.referredBy = body.referredBy;
  if (body.email !== undefined) data.email = body.email;
  if (body.estimateId !== undefined) data.estimateId = body.estimateId;
  if (body.existingVisitId !== undefined) data.existingVisitId = body.existingVisitId;
  if (body.status !== undefined) data.status = body.status;
  if (body.contactPreference !== undefined) data.contactPreference = body.contactPreference;
  if (body.leadStatus !== undefined) data.leadStatus = body.leadStatus;
  if (body.followUpDate !== undefined) data.followUpDate = body.followUpDate ? new Date(body.followUpDate) : null;
  if (body.followUpReason !== undefined) data.followUpReason = body.followUpReason;
  if (body.followUpCount !== undefined) data.followUpCount = body.followUpCount;
  if (body.lostReason !== undefined) data.lostReason = body.lostReason;
  if (body.lostNotes !== undefined) data.lostNotes = body.lostNotes;
  if (body.bestTimeToReach !== undefined) data.bestTimeToReach = body.bestTimeToReach;

  const lead = await prisma.lead.update({
    where: { id: body.leadId },
    data,
  });

  // Fire confirmation email when lead is booked and has an email
  if (body.leadStatus === "booked" && lead.email) {
    const apptDate = lead.followUpDate
      ? lead.followUpDate.toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric" })
      : "TBD";
    const apptWindow = lead.followUpDate
      ? `${lead.followUpDate.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })} — 2hr window`
      : "To be confirmed";

    sendConfirmationEmail({
      customerName: lead.name,
      customerEmail: lead.email,
      appointmentDate: apptDate,
      appointmentWindow: apptWindow,
      serviceAddress: lead.address ?? "See appointment details",
      jobType: lead.jobType ?? undefined,
    }).catch((err) => console.error("[update-lead] Confirmation email error:", err));
  }

  res.json(lead);
}));

// ─── SCHEDULE ENDPOINTS (webhook-secret auth — called by Make.com SMS dispatch) ──

app.get("/schedule/today", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }
  const schedule = await getTodaySchedule();
  res.json(schedule);
}));

app.get("/schedule/week", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }
  const schedule = await getWeekSchedule();
  res.json(schedule);
}));

app.post("/schedule/block-time", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }
  const body = z.object({
    summary: z.string().default("Blocked"),
    startTime: z.string(),
    endTime: z.string(),
    description: z.string().optional(),
  }).parse(req.body);

  const event = await createCalendarEvent({
    summary: body.summary,
    description: body.description,
    startTime: new Date(body.startTime),
    endTime: new Date(body.endTime),
  });

  res.status(201).json(event);
}));

app.post("/schedule/move-job", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }
  const body = z.object({
    eventId: z.string(),
    newStartTime: z.string(),
    newEndTime: z.string(),
  }).parse(req.body);

  const event = await moveCalendarEvent(body.eventId, new Date(body.newStartTime), new Date(body.newEndTime));
  res.json(event);
}));

app.delete("/schedule/cancel-job", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }
  const body = z.object({ eventId: z.string() }).parse(req.body);
  await deleteCalendarEvent(body.eventId);
  res.json({ deleted: true, eventId: body.eventId });
}));

app.post("/schedule/update-job", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }
  const body = z.object({
    visitId: z.string(),
    notes: z.string().optional(),
    status: z.string().optional(),
    estimatedJobLength: z.number().optional(),
  }).parse(req.body);

  const data: Record<string, unknown> = {};
  if (body.notes !== undefined) data.notes = body.notes;
  if (body.estimatedJobLength !== undefined) data.estimatedJobLength = body.estimatedJobLength;

  const visit = await prisma.visit.update({
    where: { id: body.visitId },
    data,
  });

  res.json(visit);
}));

// ─── RECEIPT ENDPOINTS (webhook-secret auth — called by Make.com receipt OCR) ──

app.post("/receipts", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }
  const body = z.object({
    jobId: z.string().optional(),
    category: z.enum(["materials", "gas", "maintenance", "overhead"]),
    vendor: z.string().optional(),
    amount: z.number(),
    lineItems: z.unknown().optional(),
    imageUrl: z.string().optional(),
  }).parse(req.body);

  const receipt = await prisma.receipt.create({
    data: {
      jobId: body.jobId || null,
      category: body.category,
      vendor: body.vendor || null,
      amount: body.amount,
      lineItems: body.lineItems ? JSON.stringify(body.lineItems) : null,
      imageUrl: body.imageUrl || null,
    },
  });

  // If tied to a job, update the job's actualMaterialCost
  if (body.jobId && body.category === "materials") {
    const jobReceipts = await prisma.receipt.findMany({
      where: { jobId: body.jobId, category: "materials" },
    });
    const totalMaterials = jobReceipts.reduce((sum, r) => sum + r.amount, 0);
    await prisma.visit.update({
      where: { id: body.jobId },
      data: { actualMaterialCost: totalMaterials },
    });
  }

  res.status(201).json(receipt);
}));

app.get("/receipts", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }
  const jobId = req.query["jobId"] as string | undefined;

  const receipts = await prisma.receipt.findMany({
    where: jobId ? { jobId } : undefined,
    orderBy: { createdAt: "desc" },
  });

  res.json(receipts);
}));

// ─── INBOUND SMS/MMS WEBHOOK (Twilio) ───────────────────────────────────────
// Routes every inbound message: Kyle dispatch, tech notes/receipts, customer
// confirmation replies, unknown-sender forwarding. See routes/inboundSms.ts.
app.use(inboundSmsRouter);

// Public appointment confirmation page (token-authenticated).
app.use(confirmPageRouter);

// ─── LEAD FOLLOW-UP & LOSS TRACKING ─────────────────────────────────────────

app.get("/leads/follow-ups-due", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }

  const now = new Date();
  const leads = await prisma.lead.findMany({
    where: {
      followUpDate: { lte: now },
      followUpCount: { lt: 2 },
      leadStatus: { in: ["unresolved", "planning", "no_answer"] },
    },
    orderBy: { followUpDate: "asc" },
  });

  res.json({ count: leads.length, leads });
}));

app.patch("/leads/:id/lost", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }

  const body = z.object({
    lostReason: z.enum(["price", "timing", "referral", "trust", "scope", "other"]),
    lostNotes: z.string().optional(),
  }).parse(req.body);

  const lead = await prisma.lead.update({
    where: { id: readParam(req, "id") },
    data: {
      leadStatus: "lost",
      status: "lost",
      lostReason: body.lostReason,
      lostNotes: body.lostNotes || null,
    },
  });

  res.json(lead);
}));

app.patch("/leads/:id/won", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }

  const lead = await prisma.lead.update({
    where: { id: readParam(req, "id") },
    data: {
      leadStatus: "won",
      status: "converted",
    },
  });

  res.json(lead);
}));

app.get("/leads/loss-report", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }

  const allLeads = await prisma.lead.findMany({
    where: {
      leadStatus: { in: ["lost", "won"] },
    },
    select: {
      leadStatus: true,
      lostReason: true,
      lostNotes: true,
      createdAt: true,
    },
  });

  const won = allLeads.filter((l) => l.leadStatus === "won").length;
  const lost = allLeads.filter((l) => l.leadStatus === "lost").length;
  const total = won + lost;

  // Group lost reasons
  const reasonCounts: Record<string, number> = {};
  for (const l of allLeads) {
    if (l.leadStatus === "lost" && l.lostReason) {
      reasonCounts[l.lostReason] = (reasonCounts[l.lostReason] || 0) + 1;
    }
  }

  res.json({
    total,
    won,
    lost,
    winRate: total > 0 ? Math.round((won / total) * 100) : 0,
    lossReasons: reasonCounts,
  });
}));

// ─── E-SIGNATURE FLOW (no auth — public signing page) ──────────────────────

app.get("/sign/:documentId", asyncHandler(async (req, res) => {
  const docId = readParam(req, "documentId");
  const doc = await prisma.document.findUnique({ where: { id: docId } });

  if (!doc) {
    res.status(404).send("<h1>Document not found</h1>");
    return;
  }

  if (doc.signedAt) {
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Already Signed</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="font-family:sans-serif;max-width:560px;margin:40px auto;padding:0 20px;color:#333;">
        <h1 style="color:#1a5c2e;">Document Already Signed</h1>
        <p>This document was signed by <strong>${doc.signedByName}</strong> on ${doc.signedAt.toLocaleDateString("en-US", { timeZone: "America/Chicago" })}.</p>
        <p>If you need a copy, please contact Red Cedar Electric at (615) 857-6389.</p>
      </body></html>
    `);
    return;
  }

  res.send(`
    <!DOCTYPE html>
    <html><head><title>Sign Document — Red Cedar Electric</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="font-family:sans-serif;max-width:560px;margin:40px auto;padding:0 20px;color:#333;">
      <div style="background:#1a5c2e;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:20px;">Red Cedar Electric LLC</h1>
        <p style="margin:4px 0 0;font-size:14px;opacity:0.9;">${doc.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}</p>
      </div>
      <div style="padding:20px 24px;background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
        <p>Please review the document and sign below to confirm your agreement.</p>
        <p><a href="/api/documents/${docId}/pdf" target="_blank" style="color:#1a5c2e;">View Full Document (PDF)</a></p>
        <form method="POST" action="/api/documents/${docId}/sign" style="margin-top:24px;">
          <label style="display:block;margin-bottom:12px;">
            <span style="font-weight:600;">Full Name (as signature)</span><br>
            <input name="name" type="text" required style="width:100%;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:4px;margin-top:4px;" placeholder="Your full name">
          </label>
          <label style="display:block;margin-bottom:20px;">
            <input type="checkbox" name="agree" value="yes" required>
            I have read and agree to the terms of this document.
          </label>
          <button type="submit" style="background:#1a5c2e;color:#fff;border:none;padding:12px 32px;font-size:16px;border-radius:6px;cursor:pointer;">I Agree &amp; Sign</button>
        </form>
      </div>
    </body></html>
  `);
}));

app.post("/documents/:id/sign", asyncHandler(async (req, res) => {
  const docId = readParam(req, "id");
  const body = req.body as { name?: string; agree?: string };

  if (!body.name?.trim()) {
    res.status(400).send("<h1>Name is required</h1>");
    return;
  }

  const doc = await prisma.document.findUnique({
    where: { id: docId },
    include: { job: { include: { property: true, customer: true } } },
  });

  if (!doc) {
    res.status(404).send("<h1>Document not found</h1>");
    return;
  }

  if (doc.signedAt) {
    res.send("<h1>This document has already been signed.</h1>");
    return;
  }

  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "unknown";

  await markDocumentSigned(docId, body.name.trim(), ip);

  // Notify Kyle via SMS
  const addr = doc.job?.property
    ? [doc.job.property.addressLine1, doc.job.property.city].filter(Boolean).join(", ")
    : "";
  // GATED (no-Twilio-texts ruling 2026-08-13) — the signature itself is recorded on the Document
  // row by markDocumentSigned() above, which is the durable record; only the text is suppressed.
  if (twilioSendEnabled("operatorNotifications")) {
    sendSms(KYLE_PHONE, `${body.name.trim()} signed the ${doc.type.replace(/_/g, " ")} for ${addr}`).catch(() => {});
  } else {
    logTwilioSendSkipped("operatorNotifications", `Document ${docId} signed and recorded; Kyle not texted.`);
  }

  res.send(`
    <!DOCTYPE html>
    <html><head><title>Signed — Red Cedar Electric</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="font-family:sans-serif;max-width:560px;margin:40px auto;padding:0 20px;color:#333;">
      <div style="background:#1a5c2e;color:#fff;padding:20px 24px;border-radius:8px;text-align:center;">
        <h1 style="margin:0;font-size:22px;">Document Signed Successfully</h1>
      </div>
      <div style="padding:20px;text-align:center;">
        <p>Thank you, <strong>${body.name.trim()}</strong>. Your signature has been recorded.</p>
        <p style="font-size:14px;color:#666;">A confirmation will be sent to your email. If you have any questions, call (615) 857-6389.</p>
      </div>
    </body></html>
  `);
}));

app.get("/documents/:id/pdf", asyncHandler(async (req, res) => {
  const docId = readParam(req, "id");
  const doc = await prisma.document.findUnique({ where: { id: docId } });

  if (!doc || !doc.pdfUrl) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const fs = await import("node:fs");
  if (!fs.existsSync(doc.pdfUrl)) {
    res.status(404).json({ error: "PDF file not found" });
    return;
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${doc.type}-${docId}.pdf"`);
  fs.createReadStream(doc.pdfUrl).pipe(res);
}));

// ─── PDF GENERATION ENDPOINTS (webhook_secret auth) ────────────────────────

app.post("/documents/generate-contract", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }

  const { jobId, customerName, serviceAddress, scopeOfWork, totalPrice, estimatedHours, paymentTerms } = req.body as {
    jobId: string; customerName: string; serviceAddress: string; scopeOfWork: string;
    totalPrice: number; estimatedHours?: number; paymentTerms?: string;
  };

  if (!jobId || !customerName || !serviceAddress || !scopeOfWork || totalPrice == null) {
    res.status(400).json({ error: "Missing required fields: jobId, customerName, serviceAddress, scopeOfWork, totalPrice" });
    return;
  }

  const result = await generateContract({ jobId, customerName, serviceAddress, scopeOfWork, totalPrice, estimatedHours, paymentTerms });
  res.json({ ...result, signUrl: `/sign/${result.documentId}` });
}));

app.post("/documents/generate-change-order", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }

  const { jobId, customerName, serviceAddress, originalScope, changes, priceAdjustment, newTotal } = req.body as {
    jobId: string; customerName: string; serviceAddress: string; originalScope: string;
    changes: string; priceAdjustment: number; newTotal: number;
  };

  if (!jobId || !customerName || !changes || priceAdjustment == null || newTotal == null) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const result = await generateChangeOrder({ jobId, customerName, serviceAddress: serviceAddress ?? "", originalScope: originalScope ?? "", changes, priceAdjustment, newTotal });
  res.json({ ...result, signUrl: `/sign/${result.documentId}` });
}));

app.post("/documents/generate-work-order", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }

  const { jobId, customerName, serviceAddress, scheduledDate, scopeOfWork, materialsNeeded } = req.body as {
    jobId: string; customerName: string; serviceAddress: string; scheduledDate: string;
    scopeOfWork: string; materialsNeeded: string;
  };

  const result = await generateWorkOrder({ jobId, customerName: customerName ?? "", serviceAddress: serviceAddress ?? "", scheduledDate: scheduledDate ?? "", scopeOfWork: scopeOfWork ?? "", materialsNeeded: materialsNeeded ?? "" });
  res.json(result);
}));

app.post("/documents/generate-material-list", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }

  const { jobId, serviceAddress, items } = req.body as {
    jobId: string; serviceAddress: string;
    items: Array<{ name: string; quantity: number; unit?: string; supplier?: string }>;
  };

  const result = await generateMaterialList({ jobId, serviceAddress: serviceAddress ?? "", items: items ?? [] });
  res.json(result);
}));

// ─── EMAIL BOOKING FLOW (webhook_secret auth — called by Make.com) ─────────

app.post("/bookings/from-email", asyncHandler(async (req, res) => {
  const secret = req.headers["webhook_secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }

  const { leadId, slotStart, durationHours, customerEmail } = req.body as {
    leadId: string; slotStart: string; durationHours?: number; customerEmail?: string;
  };

  if (!leadId || !slotStart) {
    res.status(400).json({ error: "leadId and slotStart are required" });
    return;
  }

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }

  const startTime = new Date(slotStart);
  const hours = durationHours ?? 2;
  const endTime = new Date(startTime.getTime() + hours * 3_600_000);

  // Book Google Calendar
  const event = await createCalendarEvent({
    summary: `${lead.jobType ?? "Service"} — ${lead.name}`,
    description: lead.notes ?? undefined,
    location: lead.address ?? undefined,
    startTime,
    endTime,
  });

  // Update lead to booked
  await prisma.lead.update({
    where: { id: leadId },
    data: { leadStatus: "booked", status: "contacted" },
  });

  // Send confirmation email
  const email = customerEmail ?? lead.email;
  if (email) {
    const apptDate = startTime.toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric" });
    const apptWindow = `${startTime.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })} — ${hours}hr window`;

    sendConfirmationEmail({
      customerName: lead.name,
      customerEmail: email,
      appointmentDate: apptDate,
      appointmentWindow: apptWindow,
      serviceAddress: lead.address ?? "See appointment details",
      jobType: lead.jobType ?? undefined,
    }).catch((err) => console.error("[booking] Confirmation email error:", err));
  }

  // Notify Kyle
  const dateStr = startTime.toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric" });
  const timeStr = startTime.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
  // GATED (no-Twilio-texts ruling 2026-08-13). The Google Calendar event is the booking record
  // and it is already created above; the text was only a heads-up.
  if (twilioSendEnabled("operatorNotifications")) {
    sendSms(KYLE_PHONE, `Email booking: ${lead.name} — ${lead.jobType ?? "service"} — ${dateStr} ${timeStr}`).catch(() => {});
  } else {
    logTwilioSendSkipped("operatorNotifications", `Email booking for lead ${leadId} is on the calendar (event ${event.id}).`);
  }

  res.json({ booked: true, eventId: event.id, leadId });
}));

// ─── AGENT API (Jerry — voice/SMS field assistant) ────────────────────────────
app.use("/agent", agentRouter);
app.use("/agent/savannah", savannahRouter);
app.use("/agent/jerry", jerryRouter);
app.use("/agent/calendar", sharedAgentRouter);

// ─── HEALTH RECORD PWA (per-technician bearer auth — before PIN middleware) ───
app.use("/health-record", healthRecordTechRouter);
// Capacity checks run on ordinary service calls with no assessment in progress,
// so this is its own router rather than a branch of the health record.
app.use("/health-record/capacity-checks", capacityCheckTechRouter);

// ─── PIN AUTH ────────────────────────────────────────────────────────────────
app.post("/auth/pin", asyncHandler(async (req, res) => { await handlePinLogin(req, res); }));
app.use(pinAuthMiddleware);

// ─── AI PROPOSAL REVIEW (P011) — the human confirmation gate ─────────────────
//
// Registered AFTER pinAuthMiddleware, deliberately: these are the endpoints that turn an AI
// suggestion into a number the engine will price, so they must be reachable only by an
// authenticated human. The model reaches the MCP surface, which has no path to any of them.
//
// Kyle's architecture (projects/red-cedar-crm.md § TECH INTAKE): "The AI proposes, the tech
// confirms, the engine prices." This file holds the middle third.

// ─── PRICE BOOK CATALOG BROWSE + SEARCH (P012) ───────────────────────────────
//
// The intake screen's data source. Reads PriceBookAtomic — the live workbook catalog — and
// never the legacy AtomicUnit table, which stays where it is for historical estimates only.

// NEC card taxonomy. `PriceBookNecCategory` is the imported NEC Category Map; the counts tell
// the UI which cards are worth showing, so an empty category renders as empty rather than as a
// card that leads nowhere.
app.get("/price-book/nec-categories", asyncHandler(async (_req, res) => {
  const cats = await prisma.priceBookNecCategory.findMany({ orderBy: { article: "asc" } });
  const grouped = await prisma.priceBookAtomic.groupBy({
    by: ["necArticle"],
    where: { retiredAt: null },
    _count: { _all: true },
  });
  const counts = new Map<string, number>();
  for (const g of grouped) {
    // An atomic's NEC Article cell can carry several articles ("408, 240"), so one row feeds
    // several cards. Splitting here keeps that knowledge in one place.
    for (const part of String(g.necArticle ?? "").split(/[,;/]/)) {
      const key = part.trim().split(/\s+/)[0];
      if (key) counts.set(key, (counts.get(key) ?? 0) + g._count._all);
    }
  }
  res.json({
    categories: cats.map((c) => ({
      article: c.article,
      title: c.title,
      scopeRule: c.scopeRule,
      atomicCount: counts.get(c.article) ?? 0,
    })),
  });
}));

// Search + browse. `search` matches code or description; `article` filters to a NEC card.
//
// The query itself lives in atomicEstimateService.browseAtomics() as of P014, so this route and
// `GET /atomic-units` cannot drift apart into two answers to the same question.
app.get("/price-book/atomics", asyncHandler(async (req, res) => {
  res.json(await browseAtomics(prisma, {
    search: readQuery(req, "search")?.trim(),
    article: readQuery(req, "article")?.trim(),
    category: readQuery(req, "category")?.trim(),
    limit: Number(readQuery(req, "limit") ?? 50) || 50,
  }));
}));

// ─── DRAFTS (human path) ─────────────────────────────────────────────────────

app.get("/price-book/drafts", asyncHandler(async (_req, res) => {
  const drafts = await prisma.priceBookDraftEstimate.findMany({
    orderBy: { updatedAt: "desc" }, take: 50,
    include: { _count: { select: { lines: true, questions: true } } },
  });
  res.json({ drafts });
}));

app.post("/price-book/drafts", asyncHandler(async (req, res) => {
  const body = z.object({
    title: z.string().trim().min(1),
    supplierId: z.string().trim().min(1).optional(),
    jobDescription: z.string().nullable().optional(),
  }).parse(req.body ?? {});
  try {
    // Supplier defaults to the workbook's ACTIVE SUPPLIER so the tech is not asked a question
    // the book already answers; a picker can override it later.
    const active = await prisma.priceBookRateConfig.findUnique({ where: { key: "activeSupplier" } });
    const draft = await createDraft(prisma, {
      title: body.title,
      supplierId: body.supplierId ?? active?.textValue ?? "HD",
      jobDescription: body.jobDescription ?? null,
    });
    res.status(201).json(draft);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

// Add a line the HUMAN chose — lands CONFIRMED, unlike an AI proposal.
app.post("/price-book/drafts/:draftId/lines", asyncHandler(async (req, res) => {
  const body = z.object({
    itemId: z.string().trim().min(1),
    quantity: z.number().positive(),
    quantitySource: z.enum(["COUNT", "MEASURED_LENGTH", "TERMINATION_COUNT", "MANUAL"]),
    difficulty: z.enum(["NORMAL", "DIFFICULT", "VERY_DIFFICULT"]).optional(),
    location: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  }).parse(req.body ?? {});
  try {
    const line = await addLine(prisma, String(req.params.draftId), {
      ...body,
      location: body.location ?? null,
      note: body.note ?? null,
      confirmedBy: "human:crm-session",
    });
    res.status(201).json(line);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

app.delete("/price-book/lines/:lineId", asyncHandler(async (req, res) => {
  try {
    await removeLine(prisma, String(req.params.lineId));
    res.status(204).send();
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

// Raise a question by hand — where an unresolved walkthrough row lands. A line the system
// cannot match must become a visible question, never dropped text.
app.post("/price-book/drafts/:draftId/questions", asyncHandler(async (req, res) => {
  const body = z.object({
    question: z.string().trim().min(1),
    rawText: z.string().nullable().optional(),
  }).parse(req.body ?? {});
  const q = await prisma.priceBookDraftQuestion.create({
    data: {
      draftId: String(req.params.draftId),
      question: body.question,
      rawText: body.rawText ?? null,
      raisedBy: "human:walkthrough-entry",
    },
  });
  res.status(201).json(q);
}));

// ─── WALKTHROUGH MATERIAL LIST — resolve typed rows against the catalog ──────
//
// The tech types the list they built on the walkthrough. Resolution happens here, not in the
// browser, so the matching rule lives in one place. NOTHING is auto-added: this returns
// candidates and the tech commits them. An ambiguous row comes back ambiguous — silently
// picking the top hit is the assumption the atomic-first ruling exists to remove.
app.post("/price-book/resolve-walkthrough", asyncHandler(async (req, res) => {
  const body = z.object({
    rows: z.array(z.object({
      raw: z.string().trim().min(1),
      quantity: z.number().positive().optional(),
    })).max(100),
  }).parse(req.body ?? {});

  const out = [];
  for (const row of body.rows) {
    const leadingQty = /^\s*(\d+(?:\.\d+)?)/.exec(row.raw);
    const term = row.raw.replace(/^\s*\d+(\.\d+)?\s*(x|ea|each|ft|lf)?\s*/i, "").trim() || row.raw.trim();

    // TOKEN-AND matching, not phrase matching.
    //
    // A tech writes "20A receptacle"; the catalog says "Duplex Receptacle, 20A 125V, NEMA
    // 5-20R". A single `contains` on the whole phrase finds nothing, and reporting UNMATCHED
    // for an item that is plainly in the book trains the operator to ignore the feature.
    // So: every word must appear somewhere in the code or description, in any order.
    //
    // This WIDENS what matches; it does not guess. Multiple hits still come back AMBIGUOUS for
    // the tech to choose between — the engine never picks one for them.
    const tokens = term
      .split(/[\s,]+/)
      .map((t) => t.replace(/[^A-Za-z0-9/.-]/g, "").trim())
      .filter((t) => t.length >= 2)
      .slice(0, 6);

    const SELECT = { itemId: true, description: true, unit: true, laborUnitBasis: true, costBasisUsed: true };
    const byTokens = (tks: string[]) =>
      prisma.priceBookAtomic.findMany({
        where: {
          retiredAt: null,
          AND: tks.map((tk) => ({
            OR: [
              { itemId: { contains: tk, mode: "insensitive" as const } },
              { description: { contains: tk, mode: "insensitive" as const } },
            ],
          })),
        },
        take: 6, orderBy: { itemId: "asc" },
        select: SELECT,
      });

    let matches = tokens.length === 0 ? [] : await byTokens(tokens);

    // FALLBACK on the most distinctive word.
    //
    // Field phrasing and catalog phrasing disagree in ways no token rule fixes: a tech writes
    // "1-1/4 EMT", the book says "EMT Conduit, 1 1/4-inch". Requiring every token then finds
    // nothing, and a bare UNMATCHED gives the tech nothing to work with.
    //
    // So when the full set misses, retry on the longest token alone — usually the noun that
    // actually names the thing ("EMT", "receptacle", "box"). This produces CANDIDATES TO CHOOSE
    // FROM, never an auto-selection: the result is still AMBIGUOUS and the tech still picks.
    // Widening what is offered is safe; picking for them is not.
    let usedFallback = false;
    if (matches.length === 0 && tokens.length > 1) {
      const longest = [...tokens].sort((a, b) => b.length - a.length)[0];
      matches = await byTokens([longest]);
      usedFallback = matches.length > 0;
    }
    out.push({
      raw: row.raw,
      parsedQuantity: row.quantity ?? (leadingQty ? Number(leadingQty[1]) : null),
      searchTerm: term,
      // A fallback hit is never reported as MATCHED even when it returns exactly one row —
      // it matched on a single word, so the tech should look at it, not accept it.
      status: matches.length === 0 ? "UNMATCHED" : (matches.length === 1 && !usedFallback) ? "MATCHED" : "AMBIGUOUS",
      matchedOn: usedFallback ? "single-word fallback" : "all words",
      candidates: matches.map((m) => ({
        itemId: m.itemId,
        description: m.description,
        unit: m.unit,
        isContinuousLength: (m.unit ?? "").toLowerCase() === "ft",
        hasLabourUnitBasis: m.laborUnitBasis !== null,
        hasPriceAtActiveSupplier: m.costBasisUsed !== null,
      })),
    });
  }
  res.json({ rows: out });
}));

app.get("/price-book/drafts/:draftId/review", asyncHandler(async (req, res) => {
  const review = await getDraftReview(prisma, String(req.params.draftId));
  res.json({
    draft: {
      id: review.draft.id,
      title: review.draft.title,
      supplierId: review.draft.supplierId,
      status: review.draft.status,
      rateProvisional: review.draft.rateProvisional,
      provisionalReason: review.draft.provisionalReason,
    },
    proposedLines: review.proposedLines.map((l) => ({
      id: l.id, itemId: l.itemId, description: l.atomic?.description ?? null,
      quantity: l.quantity, quantitySource: l.quantitySource, difficulty: l.difficulty,
      location: l.location, proposedBy: l.proposedBy, reasoning: l.proposalReasoning,
      proposedAt: l.proposedAt,
    })),
    confirmedLines: review.confirmedLines.map((l) => ({
      id: l.id, itemId: l.itemId, description: l.atomic?.description ?? null,
      quantity: l.quantity, quantitySource: l.quantitySource, difficulty: l.difficulty,
      confirmedBy: l.confirmedBy, confirmedAt: l.confirmedAt,
      editedBeforeConfirm: l.editedBeforeConfirm, proposedBy: l.proposedBy,
    })),
    openQuestions: review.openQuestions.map((q) => ({
      id: q.id, question: q.question, rawText: q.rawText, raisedBy: q.raisedBy, createdAt: q.createdAt,
    })),
    counts: {
      proposed: review.proposedLines.length,
      confirmed: review.confirmedLines.length,
      openQuestions: review.openQuestions.length,
    },
  });
}));

// Confirm one proposed line — edit-then-confirm supported. This is the act that makes a
// model suggestion real.
app.post("/price-book/lines/:lineId/confirm", asyncHandler(async (req, res) => {
  const body = z.object({
    quantity: z.number().positive().optional(),
    quantitySource: z.enum(["COUNT", "MEASURED_LENGTH", "TERMINATION_COUNT", "MANUAL"]).optional(),
    difficulty: z.enum(["NORMAL", "DIFFICULT", "VERY_DIFFICULT"]).optional(),
    location: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  }).parse(req.body ?? {});

  try {
    const line = await confirmProposedLine(prisma, String(req.params.lineId), "human:crm-session", body);
    res.json({ ok: true, line });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

app.post("/price-book/lines/:lineId/reject", asyncHandler(async (req, res) => {
  try {
    await rejectProposedLine(prisma, String(req.params.lineId));
    res.status(204).send();
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

app.post("/price-book/questions/:questionId/resolve", asyncHandler(async (req, res) => {
  const body = z.object({ resolutionNote: z.string().trim().min(1) }).parse(req.body ?? {});
  try {
    const q = await resolveQuestion(prisma, String(req.params.questionId), "human:crm-session", body.resolutionNote);
    res.json({ ok: true, question: q });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

// Compute / finalize. Both human-only; finalize refuses while anything is unconfirmed.
app.get("/price-book/drafts/:draftId/compute", asyncHandler(async (req, res) => {
  const { computed, rate } = await computeDraft(prisma, String(req.params.draftId));
  res.json({ computed, rateProvisional: rate.provisional, provisionalReason: rate.provisionalReason });
}));

app.post("/price-book/drafts/:draftId/finalize", asyncHandler(async (req, res) => {
  const context = (req.body?.context === "internal" ? "internal" : "customer") as "customer" | "internal";
  const result = await finalizeDraft(prisma, String(req.params.draftId), context);
  res.status(result.finalized ? 200 : 409).json(result);
}));

// ─── HEALTH RECORD ADMIN (CRM client — rides the PIN/JWT session) ─────────────
app.use("/health-record-admin", healthRecordAdminRouter);
// Load calculation is Health Report product surface, not CRM. The old
// top-level /capacity-checks mount (and the CRM visit-page panel that called
// it) was removed 2026-08-02; the endpoints live on under the product's own
// namespace for the demand-study flow and future Health Report office UI.
app.use("/health-record-admin/capacity-checks", capacityCheckAdminRouter);

// ─── COMPANY SETTINGS (key-value config store — PIN/JWT protected) ────────────
const SETTING_KEYS = ["companyProfile", "operatingHours", "territories", "legal"] as const;

app.get("/crm/settings", asyncHandler(async (_req, res) => {
  const rows = await prisma.companySetting.findMany();
  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.valueJson);
    } catch {
      settings[row.key] = null;
    }
  }
  res.json(settings);
}));

app.put("/crm/settings/:key", asyncHandler(async (req, res) => {
  const key = readParam(req, "key");
  if (!SETTING_KEYS.includes(key as (typeof SETTING_KEYS)[number])) {
    res.status(400).json({ error: `Unknown settings key. Valid keys: ${SETTING_KEYS.join(", ")}` });
    return;
  }
  const valueJson = JSON.stringify(req.body ?? {});
  const row = await prisma.companySetting.upsert({
    where: { key },
    update: { valueJson },
    create: { key, valueJson },
  });
  res.json({ key: row.key, value: JSON.parse(row.valueJson), updatedAt: row.updatedAt });
}));

const analyticsRangeQuerySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const readAnalyticsRange = (req: express.Request) => {
  const parsed = analyticsRangeQuerySchema.parse({
    startDate: readQuery(req, "startDate"),
    endDate: readQuery(req, "endDate"),
  });

  return resolveAnalyticsRange(parsed);
};

// ─── CRM ANALYTICS ENDPOINTS (JWT-protected) ───────────────────────────────
app.get("/crm/analytics/overview", asyncHandler(async (req, res) => {
  const range = readAnalyticsRange(req);
  const data = await getCrmOverview(range);
  res.json(data);
}));

app.get("/crm/analytics/funnel", asyncHandler(async (req, res) => {
  const range = readAnalyticsRange(req);
  const data = await getLeadFunnelMetrics(range);
  res.json(data);
}));

app.get("/crm/analytics/follow-ups", asyncHandler(async (_req, res) => {
  const data = await getLeadFollowUpMetrics();
  res.json(data);
}));

app.get("/crm/analytics/win-loss", asyncHandler(async (req, res) => {
  const range = readAnalyticsRange(req);
  const data = await getWinLossMetrics(range);
  res.json(data);
}));

app.get("/crm/analytics/cycle-time", asyncHandler(async (req, res) => {
  const range = readAnalyticsRange(req);
  const data = await getCycleTimeMetrics(range);
  res.json(data);
}));

// ─── CRM SCHEDULE ENDPOINTS (JWT-protected) ──────────────────────────────────
app.get("/crm/schedule/week", asyncHandler(async (_req, res) => {
  const data = await getWeekSchedule();
  res.json(data);
}));

app.get("/crm/schedule/availability", asyncHandler(async (_req, res) => {
  const data = await getAvailability();
  res.json(data);
}));

app.get("/crm/schedule/month", asyncHandler(async (req, res) => {
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const month = parseInt(req.query.month as string) || (new Date().getMonth() + 1);
  const data = await getMonthSchedule(year, month);
  res.json(data);
}));

/**
 * The CRM calendar. The DB is authoritative — Visit.scheduledStart/End carries
 * the job link, the P&L, the technician assignment and the confirmation status,
 * none of which a Google event knows about. Google events are folded in only
 * when they have no matching Visit, so manual entries don't silently vanish.
 */
app.get("/crm/schedule/calendar", asyncHandler(async (req, res) => {
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const today = new Date();
  const startStr = dateSchema.optional().parse(readQuery(req, "start"))
    ?? new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const endStr = dateSchema.optional().parse(readQuery(req, "end"))
    ?? new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10);

  const rangeStart = new Date(`${startStr}T00:00:00.000Z`);
  // Inclusive end date — push to the end of that day.
  const rangeEnd = new Date(new Date(`${endStr}T00:00:00.000Z`).getTime() + 86_400_000);

  const visitInclude = {
    property: { select: { id: true, addressLine1: true, city: true, state: true, postalCode: true } },
    customer: { select: { id: true, name: true, phone: true } },
    assignments: {
      where: { status: { not: "completed" } },
      include: { technician: { select: { id: true, name: true } } },
    },
    estimates: {
      orderBy: { createdAt: "desc" as const },
      take: 1,
      include: { options: true },
    },
  };

  const [scheduled, unscheduledVisits] = await Promise.all([
    prisma.visit.findMany({
      where: {
        scheduledStart: { gte: rangeStart, lt: rangeEnd },
        status: { not: "cancelled" },
      },
      include: visitInclude,
      orderBy: { scheduledStart: "asc" },
    }),
    prisma.visit.findMany({
      where: { scheduledStart: null, status: { in: ["estimate", "contracted"] } },
      include: visitInclude,
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  const formatAddress = (p: { addressLine1: string; city: string; state: string }) =>
    `${p.addressLine1}, ${p.city}, ${p.state}`;

  const appointments = scheduled.map((visit) => {
    const { displayTotal } = estimateOptionTotal(visit.estimates[0]?.options ?? []);
    const kind = appointmentKindFor(visit.status);
    return {
      visitId: visit.id,
      customerId: visit.customer.id,
      customerName: visit.customer.name,
      customerPhone: visit.customer.phone,
      propertyId: visit.property.id,
      address: formatAddress(visit.property),
      status: visit.status,
      jobType: visit.jobType,
      purpose: visit.purpose,
      appointmentKind: kind,
      scheduledStart: visit.scheduledStart,
      scheduledEnd: visit.scheduledEnd,
      travelBufferMinutes: kind === "estimate" ? ESTIMATE_TRAVEL_BUFFER_MINUTES : 0,
      estimatedDurationDays: visit.estimatedDurationDays,
      estimatedDurationHours: visit.estimatedDurationHours,
      confirmationStatus: visit.confirmationStatus,
      googleEventId: visit.googleEventId,
      technicians: visit.assignments.map((a) => ({ id: a.technician.id, name: a.technician.name, role: a.role })),
      revenue: visit.revenue,
      estimateTotal: displayTotal,
    };
  });

  // Google is an overlay: keep only what the CRM doesn't already know about.
  const linkedEventIds = new Set(scheduled.map((v) => v.googleEventId).filter(Boolean));
  let googleOnlyEvents: Awaited<ReturnType<typeof getEventsInRange>> = [];
  try {
    const events = await getEventsInRange(rangeStart, rangeEnd);
    googleOnlyEvents = events.filter((e) => !linkedEventIds.has(e.id));
  } catch (err) {
    // A calendar outage must not blank out the schedule the CRM owns.
    console.error("[crm/schedule/calendar] Google overlay unavailable:", err);
  }

  res.json({
    start: startStr,
    end: endStr,
    appointments,
    unscheduled: unscheduledVisits.map((visit) => ({
      visitId: visit.id,
      customerId: visit.customer.id,
      customerName: visit.customer.name,
      propertyId: visit.property.id,
      address: formatAddress(visit.property),
      status: visit.status,
      jobType: visit.jobType,
      purpose: visit.purpose,
      appointmentKind: appointmentKindFor(visit.status),
      estimatedDurationDays: visit.estimatedDurationDays,
      createdAt: visit.createdAt,
    })),
    googleOnlyEvents,
  });
}));

// ─── CRM JOB SCHEDULING (JWT-protected) ──────────────────────────────────────
app.post("/crm/jobs/:jobId/schedule", asyncHandler(async (req, res) => {
  const jobId = (req as any).params.jobId;
  const body = z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
    startTime: z.string().optional(),
    technicianId: z.string().optional(),
  }).parse(req.body);

  try {
    const result = await scheduleJob(jobId, body.startDate, body.startTime, body.technicianId);
    res.json(result);
  } catch (err) {
    if (err instanceof ConflictError) {
      res.status(409).json({ error: err.message, conflicts: err.conflicts });
      return;
    }
    throw err;
  }
}));

// ─── TECH AVAILABILITY (JWT-protected — the CRM scheduler's tech picker) ──────
// Per-tech busy blocks for one CT day. A calendar Google omits from the
// freebusy response is reported calendarAccessible=false — never as "free".
// Optional start (HH:MM CT) + durationMinutes compute freeAtRequested per
// tech server-side, because the browser can't be trusted to do CT/DST math.
app.get("/crm/schedule/tech-availability", asyncHandler(async (req, res) => {
  const date = String(req.query.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }
  const startRaw = typeof req.query.start === "string" ? req.query.start : null;
  const durationMinutes = Number(req.query.durationMinutes ?? 180);

  const techs = await techAvailabilityForDate(date);

  let slot: { start: Date; end: Date } | null = null;
  if (startRaw && /^\d{2}:\d{2}$/.test(startRaw)) {
    const [h, m] = startRaw.split(":").map(Number);
    const start = ctToUtc(date, h, m);
    slot = { start, end: new Date(start.getTime() + durationMinutes * 60_000) };
  }

  res.json({
    date,
    techs: techs.map((t) => ({
      ...t,
      freeAtRequested: slot && t.calendarAccessible
        ? !t.busy.some((b) => new Date(b.start).getTime() < slot!.end.getTime() && new Date(b.end).getTime() > slot!.start.getTime())
        : null,
    })),
  });
}));

app.post("/crm/jobs/:jobId/reschedule", asyncHandler(async (req, res) => {
  const jobId = (req as any).params.jobId;
  const body = z.object({
    newStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
    // The client always sends this and rescheduleJob() supports it; leaving it
    // out of the schema (as it originally was) silently dropped the picked time
    // and fell back to DEFAULT_JOB_START_TIME, so an estimate rescheduled to
    // 10:00 AM came out at 7:00 AM and looked like it "didn't take".
    newStartTime: z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:MM").optional(),
    reason: z.string().min(1),
  }).parse(req.body);

  try {
    const result = await rescheduleJob(jobId, body.newStartDate, body.newStartTime ?? null, body.reason);
    res.json(result);
  } catch (err) {
    if (err instanceof ConflictError) {
      res.status(409).json({ error: err.message, conflicts: err.conflicts });
      return;
    }
    throw err;
  }
}));

app.post("/crm/jobs/:jobId/cancel", asyncHandler(async (req, res) => {
  const jobId = (req as any).params.jobId;
  const body = z.object({
    reason: z.string().min(1),
  }).parse(req.body);

  const result = await cancelJob(jobId, body.reason);
  res.json(result);
}));

/** A job is archived once it's finished or called off; everything else is active. */
export const ARCHIVED_JOB_STATUSES = ["completed", "cancelled"] as const;

app.get("/jobs", asyncHandler(async (req, res) => {
  // Absent ?archived returns every job, so existing callers are unaffected.
  const archivedParam = readQuery(req, "archived");
  const statusFilter =
    archivedParam === "true"
      ? { status: { in: [...ARCHIVED_JOB_STATUSES] } }
      : archivedParam === "false"
        ? { status: { notIn: [...ARCHIVED_JOB_STATUSES] } }
        : {};

  const [visits, laborRate] = await Promise.all([
    prisma.visit.findMany({
      where: statusFilter,
      include: {
        property: true,
        customer: true,
        estimates: {
          orderBy: { createdAt: "desc" },
          include: {
            options: true,
            acceptance: true,
          },
        },
        assignments: {
          where: { status: { not: "completed" } },
          include: { technician: { select: { id: true, name: true, role: true } } },
        },
      },
      orderBy: { visitDate: "desc" },
    }),
    getLaborRate(),
  ]);

  const jobs = visits.map((visit: typeof visits[number]) => {
    const latestEstimate = visit.estimates[0] ?? null;
    const { acceptedTotal, displayTotal } = estimateOptionTotal(latestEstimate?.options ?? []);

    return {
      visitId: visit.id,
      visitDate: visit.visitDate,
      mode: visit.mode,
      purpose: visit.purpose,
      // ── Job lifecycle & schedule (drives the Jobs Active/Archived split
      //    and the DB-authoritative calendar) ──
      status: visit.status,
      jobType: visit.jobType,
      scheduledStart: visit.scheduledStart,
      scheduledEnd: visit.scheduledEnd,
      estimatedDurationDays: visit.estimatedDurationDays,
      estimatedDurationHours: visit.estimatedDurationHours,
      contractedAt: visit.contractedAt,
      confirmationStatus: visit.confirmationStatus,
      technicians: visit.assignments.map((a) => ({
        id: a.technician.id,
        name: a.technician.name,
        role: a.role,
        assignmentStatus: a.status,
      })),
      property: {
        id: visit.property.id,
        name: visit.property.name,
        addressLine1: visit.property.addressLine1,
        city: visit.property.city,
        state: visit.property.state,
      },
      customer: {
        id: visit.customer.id,
        name: visit.customer.name,
      },
      estimate: latestEstimate
        ? {
          id: latestEstimate.id,
          title: latestEstimate.title,
          status: latestEstimate.status,
          revision: latestEstimate.revision,
          totalCost: displayTotal,
          hasAcceptance: Boolean(latestEstimate.acceptance),
        }
        : null,
      costs: rollupJobCosts(visit, acceptedTotal, laborRate),
    };
  });

  res.json(jobs);
}));

// ─── ACCOUNTS (a.k.a. customers) ─────────────────────────────────────────────
//
// "Account" is the CRM-facing name: one account, many properties. The Prisma
// model stays `Customer` so the voice agents, webhooks and PDF services keep
// working untouched — these handlers are registered under both paths.
const listCustomers = asyncHandler(async (_req: express.Request, res: express.Response) => {
  const customers = await prisma.customer.findMany({
    include: {
      properties: {
        include: {
          visits: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(customers);
});
app.get("/customers", listCustomers);
app.get("/accounts", listCustomers);

const getCustomer = asyncHandler(async (req: express.Request, res: express.Response) => {
  const customerId = readParam(req, "customerId");
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      properties: {
        include: {
          systemSnapshot: true,
          visits: {
            include: {
              estimates: {
                include: { options: true, acceptance: true },
                orderBy: { createdAt: "desc" },
              },
            },
            orderBy: { visitDate: "desc" },
          },
        },
      },
      visits: {
        include: {
          estimates: {
            include: { options: true, acceptance: true },
          },
        },
        orderBy: { visitDate: "desc" },
      },
    },
  });

  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  res.json(customer);
});
app.get("/customers/:customerId", getCustomer);
app.get("/accounts/:customerId", getCustomer);

const patchCustomer = asyncHandler(async (req: express.Request, res: express.Response) => {
  const customerId = readParam(req, "customerId");
  const body = z.object({
    name: z.string().min(1).optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().nullable().optional(),
  }).parse(req.body);
  const existing = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!existing) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const updated = await prisma.customer.update({ where: { id: customerId }, data: body });
  res.json(updated);
});
app.patch("/customers/:customerId", patchCustomer);
app.patch("/accounts/:customerId", patchCustomer);

const deleteCustomer = asyncHandler(async (req: express.Request, res: express.Response) => {
  const customerId = readParam(req, "customerId");
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      properties: {
        include: {
          visits: {
            select: {
              id: true, status: true, scheduledStart: true, revenue: true,
              _count: {
                select: {
                  estimates: true, materialOrders: true, visitPhotos: true,
                  healthInspections: true, observations: true, findings: true,
                  documents: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  // A stub visit from lead conversion is status="estimate", no scheduled time,
  // no revenue, and no attached work records. Any of the below means real work
  // did happen and the delete refusal is correct.
  const visits = customer.properties.flatMap((p) => p.visits);
  const realHistory: string[] = [];
  for (const v of visits) {
    if (v.status !== "estimate") realHistory.push(`a ${v.status} job`);
    if (v.scheduledStart) realHistory.push("a scheduled appointment");
    if (v.revenue && v.revenue > 0) realHistory.push("recorded revenue");
    if (v._count.estimates > 0) realHistory.push(`${v._count.estimates} estimate(s)`);
    if (v._count.materialOrders > 0) realHistory.push(`${v._count.materialOrders} material order(s)`);
    if (v._count.visitPhotos > 0) realHistory.push("job-site photos");
    if (v._count.healthInspections > 0) realHistory.push("a health inspection");
    if (v._count.observations > 0 || v._count.findings > 0) realHistory.push("technician observations");
    if (v._count.documents > 0) realHistory.push("job documents");
  }
  if (realHistory.length > 0) {
    // De-dup + human-friendly summary so the user knows what to clear first
    // instead of "there's job history" for an account that had one photo.
    const unique = Array.from(new Set(realHistory)).slice(0, 4);
    res.status(409).json({
      error: "Cannot delete a customer with existing job history.",
      message: `This account has ${unique.join(", ")}. Delete or archive that work first, then delete the account.`,
      hasRealHistory: true,
    });
    return;
  }

  // Truly empty: only lead-conversion stub visits (or nothing). Cascade delete
  // in a transaction. Lead pointers get nulled so historical leads don't hold
  // orphan references.
  const visitIds = visits.map((v) => v.id);
  const propertyIds = customer.properties.map((p) => p.id);
  await prisma.$transaction(async (tx) => {
    if (visitIds.length > 0) {
      await tx.lead.updateMany({
        where: { OR: [{ customerId }, { visitId: { in: visitIds } }] },
        data: { customerId: null, propertyId: null, visitId: null, status: "new" },
      });
      await tx.visit.deleteMany({ where: { id: { in: visitIds } } });
    } else {
      await tx.lead.updateMany({
        where: { customerId },
        data: { customerId: null, propertyId: null, visitId: null, status: "new" },
      });
    }
    if (propertyIds.length > 0) {
      await tx.property.deleteMany({ where: { id: { in: propertyIds } } });
    }
    await tx.customer.delete({ where: { id: customerId } });
  });
  res.status(204).send();
});
app.delete("/customers/:customerId", deleteCustomer);
app.delete("/accounts/:customerId", deleteCustomer);

app.get("/properties", asyncHandler(async (_req, res) => {
  const properties = await prisma.property.findMany({
    include: {
      customer: true,
      systemSnapshot: true,
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(properties);
}));

app.get("/properties/:propertyId", asyncHandler(async (req, res) => {
  const propertyId = readParam(req, "propertyId");
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: {
      customer: true,
      systemSnapshot: true,
      visits: {
        include: {
          estimates: {
            include: {
              options: true,
              acceptance: true,
            },
            orderBy: { createdAt: "desc" },
          },
        },
        orderBy: { visitDate: "desc" },
      },
      estimates: {
        include: {
          options: true,
          acceptance: true,
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!property) {
    res.status(404).json({ error: "Property not found" });
    return;
  }

  res.json(property);
}));

app.get("/visits", asyncHandler(async (_req, res) => {
  const visits = await prisma.visit.findMany({
    include: {
      property: true,
      customer: true,
      customerRequest: true,
      estimates: {
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { visitDate: "desc" },
  });

  res.json(visits);
}));

app.get("/visits/:visitId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: {
      property: {
        include: {
          systemSnapshot: true,
          customer: true,
        },
      },
      customer: true,
      customerRequest: true,
      observations: { orderBy: { createdAt: "desc" } },
      findings: { orderBy: { createdAt: "desc" } },
      limitations: { orderBy: { createdAt: "desc" } },
      recommendations: { orderBy: { createdAt: "desc" } },
      estimates: {
        include: {
          options: true,
          acceptance: true,
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!visit) {
    res.status(404).json({ error: "Visit not found" });
    return;
  }

  res.json(visit);
}));


app.get("/proposals/:deliveryId/download", asyncHandler(async (req, res) => {
  const deliveryId = readParam(req, "deliveryId");
  const delivery = await prisma.proposalDelivery.findUnique({
    where: { id: deliveryId },
  });

  if (!delivery) {
    res.status(404).json({ error: "Proposal delivery not found" });
    return;
  }

  const resolvedPath = path.isAbsolute(delivery.pdfPath)
    ? delivery.pdfPath
    : path.resolve(process.cwd(), delivery.pdfPath);

  if (!fs.existsSync(resolvedPath)) {
    res.status(404).json({ error: "Proposal file not found" });
    return;
  }

  const safeName = path.basename(resolvedPath).replace(/"/g, "");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName || `proposal-${delivery.id}.pdf`}"`);

  const stream = fs.createReadStream(resolvedPath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to read proposal file" });
      return;
    }
    res.end();
  });
  stream.pipe(res);
}));

const createCustomer = asyncHandler(async (req: express.Request, res: express.Response) => {
  const schema = z.object({
    name: z.string().min(1),
    email: z.string().email().optional(),
    phone: z.string().optional(),
  });
  const body = schema.parse(req.body);
  const created = await prisma.customer.create({ data: body });
  res.status(201).json(created);
});
app.post("/customers", createCustomer);
app.post("/accounts", createCustomer);

/**
 * Everything the Accounts detail page needs in one round trip: contact info,
 * every property on the account, per-job costs with their POs and receipts, and
 * lifetime totals.
 *
 * Assembled server-side rather than composed on the client because there's no
 * ?customerId= filter on /jobs — the client would have to pull every job in the
 * business and then fan out per-job for receipts. It also keeps rollupJobCosts
 * as the single source of truth for money, so the Jobs tab and this page can
 * never quote different numbers for the same job.
 */
app.get("/accounts/:customerId/summary", asyncHandler(async (req, res) => {
  const customerId = readParam(req, "customerId");

  const account = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      properties: { orderBy: { createdAt: "asc" } },
      visits: {
        include: {
          property: { select: { id: true, name: true, addressLine1: true, city: true, state: true } },
          estimates: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: { options: true, acceptance: true },
          },
          documents: { orderBy: { createdAt: "desc" } },
          materialOrders: { orderBy: { createdAt: "desc" } },
        },
        orderBy: { visitDate: "desc" },
      },
      healthInspections: {
        orderBy: { inspectionDate: "desc" },
        select: {
          id: true, visitId: true, propertyId: true, inspectionDate: true,
          score: true, schemaVersion: true, scope: true, itemsAssessed: true,
          failCount: true, monitorCount: true, passCount: true,
          belowStandardCount: true, naCount: true,
          criticalFindingsJson: true, contractorReviewed: true,
        },
      },
    },
  });

  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  const visitIds = account.visits.map((v) => v.id);
  const [receipts, laborRate, findings] = await Promise.all([
    visitIds.length
      ? prisma.receipt.findMany({
        where: { jobId: { in: visitIds } },
        orderBy: { receivedAt: "desc" },
        // Never select imageData here — the blobs would dwarf the payload.
        select: {
          id: true, jobId: true, vendor: true, category: true, amount: true,
          status: true, source: true, receivedAt: true,
        },
      })
      : Promise.resolve([]),
    getLaborRate(),
    // The finding ledger for every address on the account. Served from here for
    // the same reason the rest of this endpoint exists: one round trip, and the
    // account page never has to fan out per property.
    prisma.propertyFinding.findMany({
      where: { customerId },
      orderBy: [{ status: "asc" }, { critical: "desc" }, { openedAt: "desc" }],
      take: 500,
    }),
  ]);
  const receiptsByJob = new Map<string, typeof receipts>();
  for (const receipt of receipts) {
    if (!receipt.jobId) continue;
    const list = receiptsByJob.get(receipt.jobId) ?? [];
    list.push(receipt);
    receiptsByJob.set(receipt.jobId, list);
  }

  const jobs = account.visits.map((visit) => {
    const latestEstimate = visit.estimates[0] ?? null;
    const { acceptedTotal, displayTotal } = estimateOptionTotal(latestEstimate?.options ?? []);
    return {
      visitId: visit.id,
      propertyId: visit.property.id,
      propertyLabel: `${visit.property.name} — ${visit.property.addressLine1}, ${visit.property.city}`,
      status: visit.status,
      archived: ARCHIVED_JOB_STATUSES.includes(visit.status as (typeof ARCHIVED_JOB_STATUSES)[number]),
      jobType: visit.jobType,
      purpose: visit.purpose,
      mode: visit.mode,
      visitDate: visit.visitDate,
      scheduledStart: visit.scheduledStart,
      scheduledEnd: visit.scheduledEnd,
      costs: rollupJobCosts(visit, acceptedTotal, laborRate),
      purchaseOrders: visit.materialOrders.map((order) => ({
        id: order.id,
        supplier: order.supplier,
        itemCount: parseJsonArrayLength(order.items),
        sentAt: order.sentAt,
        createdAt: order.createdAt,
      })),
      receipts: receiptsByJob.get(visit.id) ?? [],
      documents: visit.documents.map((doc) => ({
        id: doc.id, type: doc.type, signedAt: doc.signedAt, sentAt: doc.sentAt,
      })),
      latestEstimate: latestEstimate
        ? {
          id: latestEstimate.id,
          title: latestEstimate.title,
          status: latestEstimate.status,
          revision: latestEstimate.revision,
          totalCost: displayTotal,
          hasAcceptance: Boolean(latestEstimate.acceptance),
        }
        : null,
    };
  });

  const jobsByProperty = new Map<string, typeof jobs>();
  for (const job of jobs) {
    const list = jobsByProperty.get(job.propertyId) ?? [];
    list.push(job);
    jobsByProperty.set(job.propertyId, list);
  }
  const lastInspectionByProperty = new Map<string, Date>();
  for (const inspection of account.healthInspections) {
    if (!lastInspectionByProperty.has(inspection.propertyId)) {
      lastInspectionByProperty.set(inspection.propertyId, inspection.inspectionDate);
    }
  }

  res.json({
    account: {
      id: account.id,
      name: account.name,
      email: account.email,
      phone: account.phone,
      createdAt: account.createdAt,
    },
    properties: account.properties.map((property) => {
      const propertyJobs = jobsByProperty.get(property.id) ?? [];
      const propertyFindings = findings.filter((f) => f.propertyId === property.id);
      return {
        ...property,
        activeJobCount: propertyJobs.filter((j) => !j.archived).length,
        completedJobCount: propertyJobs.filter((j) => j.archived).length,
        lastInspectionDate: lastInspectionByProperty.get(property.id) ?? null,
        openFindingCount: propertyFindings.filter((f) => f.status === "open" || f.status === "scheduled").length,
        openDefectCount: propertyFindings.filter(
          (f) => f.track === "defect" && (f.status === "open" || f.status === "scheduled"),
        ).length,
      };
    }),
    findings: findings.map((finding) => ({
      id: finding.id,
      propertyId: finding.propertyId,
      itemId: finding.itemId,
      locationKey: finding.locationKey,
      cycle: finding.cycle,
      track: finding.track,
      title: finding.title,
      citations: parseJsonStringArray(finding.citationsJson),
      // Rendered as "citations unavailable — pre-ledger record" rather than an
      // empty block that reads as though there were nothing to cite.
      citationsAvailable: parseJsonStringArray(finding.citationsJson).length > 0,
      jurisdictionId: finding.jurisdictionId,
      severity: finding.severity,
      critical: finding.critical,
      findingText: finding.findingText,
      resolutionNote: finding.resolutionNote,
      expectedEolYear: finding.expectedEolYear,
      status: finding.status,
      openedAt: finding.openedAt,
      observedCount: finding.observedCount,
      verifiedPassAt: finding.verifiedPassAt,
      scheduledVisitId: finding.scheduledVisitId,
      resolvedAt: finding.resolvedAt,
      resolutionMethod: finding.resolutionMethod,
      resolvedByParty: finding.resolvedByParty,
      certificateDocId: finding.certificateDocId,
      declinedAt: finding.declinedAt,
      declinedByName: finding.declinedByName,
      declinedByRelation: finding.declinedByRelation,
    })),
    jobs,
    totals: {
      ...sumJobCosts(jobs.map((j) => j.costs)),
      activeJobCount: jobs.filter((j) => !j.archived).length,
      completedJobCount: jobs.filter((j) => j.archived).length,
      propertyCount: account.properties.length,
    },
    inspections: account.healthInspections.map((inspection) => ({
      id: inspection.id,
      visitId: inspection.visitId,
      propertyId: inspection.propertyId,
      inspectionDate: inspection.inspectionDate,
      score: inspection.score,
      schemaVersion: inspection.schemaVersion,
      scope: inspection.scope,
      itemsAssessed: inspection.itemsAssessed,
      failCount: inspection.failCount,
      monitorCount: inspection.monitorCount,
      passCount: inspection.passCount,
      belowStandardCount: inspection.belowStandardCount,
      naCount: inspection.naCount,
      criticalFindings: parseJsonStringArray(inspection.criticalFindingsJson),
      contractorReviewed: inspection.contractorReviewed,
    })),
  });
}));

app.post("/properties", asyncHandler(async (req, res) => {
  const schema = z.object({
    customerId: z.string().min(1),
    name: z.string().min(1),
    addressLine1: z.string().min(1),
    addressLine2: z.string().nullable().optional(),
    city: z.string().min(1),
    state: z.string().min(1),
    postalCode: z.string().min(1),
    notes: z.string().nullable().optional(),
    occupancyType: z.enum(["residential", "commercial"]).default("residential"),
    // The explicit per-address override documented as step 1 of
    // services/jurisdictionResolver.ts. It had no write path at all, so that step
    // was dead code and the Health Record could only ever derive it from the ZIP.
    // The enum is imported from the resolver so it can't drift from the field
    // app's profile list.
    jurisdictionId: z.enum(KNOWN_JURISDICTION_IDS).nullable().optional(),
  });
  const body = schema.parse(req.body);
  const property = await createPropertyWithSnapshot(prisma, body);
  res.status(201).json(property);
}));

app.patch("/properties/:propertyId", asyncHandler(async (req, res) => {
  const propertyId = readParam(req, "propertyId");
  const prop = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { visits: { select: { id: true }, take: 1 } },
  });
  if (!prop) { res.status(404).json({ error: "Property not found" }); return; }

  const body = req.body as {
    name?: string; addressLine1?: string; addressLine2?: string | null; city?: string;
    state?: string; postalCode?: string; notes?: string | null;
    occupancyType?: string; jurisdictionId?: string | null; customerId?: string;
  };

  // Moving an address between accounts — a duplicate will get filed under the
  // wrong one eventually. Blocked once there's history, because Visit.customerId
  // is denormalized alongside Visit.propertyId and moving the property alone
  // would leave every past job pointing at the old account.
  if (body.customerId !== undefined && body.customerId !== prop.customerId) {
    if (prop.visits.length > 0) {
      res.status(409).json({
        error: "Cannot move an address that already has job history",
        message:
          "Past jobs at this address are recorded against the current account. Moving the " +
          "address would leave that history pointing at the wrong one.",
      });
      return;
    }
    const target = await prisma.customer.findUnique({ where: { id: body.customerId }, select: { id: true } });
    if (!target) { res.status(400).json({ error: "Target account not found" }); return; }
  }

  if (body.jurisdictionId != null && !KNOWN_JURISDICTION_IDS.includes(body.jurisdictionId as never)) {
    res.status(400).json({ error: `Invalid jurisdictionId. Must be one of: ${KNOWN_JURISDICTION_IDS.join(", ")}` });
    return;
  }
  if (body.occupancyType !== undefined && !["residential", "commercial"].includes(body.occupancyType)) {
    res.status(400).json({ error: "occupancyType must be residential or commercial" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name.trim();
  if (body.addressLine1 !== undefined) data.addressLine1 = body.addressLine1.trim();
  if (body.addressLine2 !== undefined) data.addressLine2 = body.addressLine2?.trim() || null;
  if (body.city !== undefined) data.city = body.city.trim();
  if (body.state !== undefined) data.state = body.state.trim();
  if (body.postalCode !== undefined) data.postalCode = body.postalCode.trim();
  if (body.notes !== undefined) data.notes = body.notes?.trim() || null;
  if (body.occupancyType !== undefined) data.occupancyType = body.occupancyType;
  if (body.jurisdictionId !== undefined) data.jurisdictionId = body.jurisdictionId;
  if (body.customerId !== undefined) data.customerId = body.customerId;

  const updated = await prisma.property.update({ where: { id: propertyId }, data });
  res.json(updated);
}));

app.delete("/properties/:propertyId", asyncHandler(async (req, res) => {
  const propertyId = readParam(req, "propertyId");
  const prop = await prisma.property.findUnique({
    where: { id: propertyId },
    include: {
      visits: { select: { id: true }, take: 1 },
      // Findings and Documents cascade — deleting the address would silently
      // destroy the defect ledger and any cure certificates issued against it,
      // which are the legal record. Inspections and Estimates are Restrict, so
      // they'd surface as a raw FK error and a 500. CapacityCheck has no relation
      // at all and would orphan. All five are checked here instead.
      findings: { select: { id: true } },
      documents: { select: { id: true } },
      healthInspections: { select: { id: true }, take: 1 },
      estimates: { select: { id: true }, take: 1 },
    },
  });
  if (!prop) { res.status(404).json({ error: "Property not found" }); return; }

  const capacityChecks = await prisma.capacityCheck.count({ where: { propertyId } });
  const blockers = [
    prop.visits.length > 0 && "job history",
    prop.findings.length > 0 && `${prop.findings.length} finding${prop.findings.length === 1 ? "" : "s"} on record`,
    prop.documents.length > 0 && `${prop.documents.length} document${prop.documents.length === 1 ? "" : "s"}`,
    prop.healthInspections.length > 0 && "a Health Record",
    prop.estimates.length > 0 && "an estimate",
    capacityChecks > 0 && "a capacity calculation",
  ].filter((b): b is string => typeof b === "string");

  if (blockers.length > 0) {
    res.status(409).json({
      error: `Cannot delete this address — it has ${blockers.join(", ")}.`,
      message: "Remove or move that history first, or keep the address and stop using it.",
      blockers,
    });
    return;
  }

  await prisma.$transaction([
    prisma.systemSnapshot.deleteMany({ where: { propertyId } }),
    prisma.property.delete({ where: { id: propertyId } }),
  ]);
  res.status(204).end();
}));

app.patch("/properties/:propertyId/snapshot", asyncHandler(async (req, res) => {
  const propertyId = readParam(req, "propertyId");
  const schema = z.object({
    serviceSummary: z.string().optional(),
    panelSummary: z.string().optional(),
    groundingSummary: z.string().optional(),
    wiringMethodSummary: z.string().optional(),
    deficiencies: z.array(z.string()).optional(),
  });
  const body = schema.parse(req.body);

  const updated = await prisma.systemSnapshot.update({
    where: { propertyId },
    data: {
      serviceSummary: body.serviceSummary,
      panelSummary: body.panelSummary,
      groundingSummary: body.groundingSummary,
      wiringMethodSummary: body.wiringMethodSummary,
      deficienciesJson: body.deficiencies ? JSON.stringify(body.deficiencies) : undefined,
    },
  });

  res.json(updated);
}));

app.post("/visits", asyncHandler(async (req, res) => {
  const schema = z.object({
    propertyId: z.string().min(1),
    customerId: z.string().min(1),
    mode: z.enum(["new_construction", "remodel", "service_diagnostic", "maintenance"]),
    purpose: z.string().optional(),
    notes: z.string().optional(),
  });
  const body = schema.parse(req.body);
  const visit = await prisma.visit.create({ data: body });
  res.status(201).json(visit);
}));

app.patch("/visits/:visitId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const visit = await prisma.visit.findUnique({ where: { id: visitId } });
  if (!visit) { res.status(404).json({ error: "Visit not found" }); return; }

  // Block edits on accepted/completed visits
  if (visit.status === "accepted" || visit.status === "completed") {
    res.status(409).json({ error: "Cannot edit a finalized visit" });
    return;
  }

  const body = req.body as { mode?: string; purpose?: string; jobType?: string; notes?: string };
  const validModes = ["new_construction", "remodel", "service_diagnostic", "maintenance"];
  if (body.mode && !validModes.includes(body.mode)) {
    res.status(400).json({ error: `Invalid mode. Must be one of: ${validModes.join(", ")}` });
    return;
  }

  const data: Record<string, unknown> = {};
  if (body.mode !== undefined) data.mode = body.mode;
  if (body.purpose !== undefined) data.purpose = body.purpose?.trim() || null;
  if (body.jobType !== undefined) data.jobType = body.jobType?.trim() || null;
  if (body.notes !== undefined) data.notes = body.notes?.trim() || null;

  const updated = await prisma.visit.update({ where: { id: visitId }, data });
  res.json(updated);
}));

app.delete("/visits/:visitId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: { estimates: { select: { id: true, status: true } } },
  });
  if (!visit) { res.status(404).json({ error: "Visit not found" }); return; }

  // Block delete if any accepted estimate exists
  if (visit.estimates.some(e => e.status === "accepted")) {
    res.status(409).json({ error: "Cannot delete a visit with an accepted estimate" });
    return;
  }

  // Cascade delete related records
  await prisma.$transaction([
    prisma.observation.deleteMany({ where: { visitId } }),
    prisma.finding.deleteMany({ where: { visitId } }),
    prisma.limitation.deleteMany({ where: { visitId } }),
    prisma.recommendation.deleteMany({ where: { visitId } }),
    prisma.customerRequest.deleteMany({ where: { visitId } }),
    prisma.visit.delete({ where: { id: visitId } }),
  ]);
  res.status(204).end();
}));

app.post("/visits/:visitId/customer-request", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const body = z.object({ requestText: z.string().min(1), urgency: z.string().optional() }).parse(req.body);
  const request = await prisma.customerRequest.upsert({
    where: { visitId },
    update: body,
    create: {
      visitId,
      ...body,
    },
  });
  res.status(201).json(request);
}));

app.patch("/visits/:visitId/customer-request", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const body = z.object({ requestText: z.string().min(1), urgency: z.string().optional() }).parse(req.body);

  const existing = await prisma.customerRequest.findUnique({ where: { visitId } });
  if (!existing) {
    res.status(404).json({ error: "Customer request not found" });
    return;
  }

  const updated = await prisma.customerRequest.update({
    where: { visitId },
    data: body,
  });
  res.json(updated);
}));

app.post("/visits/:visitId/observations", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const body = z.object({ observationText: z.string().min(1), location: z.string().optional() }).parse(req.body);
  const created = await prisma.observation.create({ data: { visitId, ...body } });
  res.status(201).json(created);
}));

app.patch("/visits/:visitId/observations/:observationId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const observationId = readParam(req, "observationId");
  const body = z.object({ observationText: z.string().min(1), location: z.string().optional() }).parse(req.body);

  const updated = await prisma.observation.updateMany({
    where: { id: observationId, visitId },
    data: body,
  });
  if (updated.count === 0) {
    res.status(404).json({ error: "Observation not found" });
    return;
  }

  const item = await prisma.observation.findUnique({ where: { id: observationId } });
  res.json(item);
}));

app.delete("/visits/:visitId/observations/:observationId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const observationId = readParam(req, "observationId");
  const deleted = await prisma.observation.deleteMany({ where: { id: observationId, visitId } });
  if (deleted.count === 0) {
    res.status(404).json({ error: "Observation not found" });
    return;
  }
  res.status(204).send();
}));

app.post("/visits/:visitId/findings", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const body = z.object({ findingText: z.string().min(1), confidence: z.string().optional() }).parse(req.body);
  const created = await prisma.finding.create({ data: { visitId, ...body } });
  res.status(201).json(created);
}));

app.patch("/visits/:visitId/findings/:findingId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const findingId = readParam(req, "findingId");
  const body = z.object({ findingText: z.string().min(1), confidence: z.string().optional() }).parse(req.body);

  const updated = await prisma.finding.updateMany({
    where: { id: findingId, visitId },
    data: body,
  });
  if (updated.count === 0) {
    res.status(404).json({ error: "Finding not found" });
    return;
  }

  const item = await prisma.finding.findUnique({ where: { id: findingId } });
  res.json(item);
}));

app.delete("/visits/:visitId/findings/:findingId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const findingId = readParam(req, "findingId");
  const deleted = await prisma.finding.deleteMany({ where: { id: findingId, visitId } });
  if (deleted.count === 0) {
    res.status(404).json({ error: "Finding not found" });
    return;
  }
  res.status(204).send();
}));

app.post("/visits/:visitId/limitations", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const body = z.object({ limitationText: z.string().min(1) }).parse(req.body);
  const created = await prisma.limitation.create({ data: { visitId, ...body } });
  res.status(201).json(created);
}));

app.patch("/visits/:visitId/limitations/:limitationId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const limitationId = readParam(req, "limitationId");
  const body = z.object({ limitationText: z.string().min(1) }).parse(req.body);

  const updated = await prisma.limitation.updateMany({
    where: { id: limitationId, visitId },
    data: body,
  });
  if (updated.count === 0) {
    res.status(404).json({ error: "Limitation not found" });
    return;
  }

  const item = await prisma.limitation.findUnique({ where: { id: limitationId } });
  res.json(item);
}));

app.delete("/visits/:visitId/limitations/:limitationId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const limitationId = readParam(req, "limitationId");
  const deleted = await prisma.limitation.deleteMany({ where: { id: limitationId, visitId } });
  if (deleted.count === 0) {
    res.status(404).json({ error: "Limitation not found" });
    return;
  }
  res.status(204).send();
}));

app.post("/visits/:visitId/recommendations", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const body = z.object({ recommendationText: z.string().min(1), priority: z.string().optional() }).parse(req.body);
  const created = await prisma.recommendation.create({ data: { visitId, ...body } });
  res.status(201).json(created);
}));

app.patch("/visits/:visitId/recommendations/:recommendationId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const recommendationId = readParam(req, "recommendationId");
  const body = z.object({ recommendationText: z.string().min(1), priority: z.string().optional() }).parse(req.body);

  const updated = await prisma.recommendation.updateMany({
    where: { id: recommendationId, visitId },
    data: body,
  });
  if (updated.count === 0) {
    res.status(404).json({ error: "Recommendation not found" });
    return;
  }

  const item = await prisma.recommendation.findUnique({ where: { id: recommendationId } });
  res.json(item);
}));

app.delete("/visits/:visitId/recommendations/:recommendationId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const recommendationId = readParam(req, "recommendationId");
  const deleted = await prisma.recommendation.deleteMany({ where: { id: recommendationId, visitId } });
  if (deleted.count === 0) {
    res.status(404).json({ error: "Recommendation not found" });
    return;
  }
  res.status(204).send();
}));

app.post("/estimates", asyncHandler(async (req, res) => {
  const body = z.object({ visitId: z.string(), propertyId: z.string(), title: z.string(), notes: z.string().optional() }).parse(req.body);
  const estimate = await service.createEstimate(body);
  res.status(201).json(estimate);
}));

app.delete("/estimates/:estimateId", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  await service.deleteEstimate(estimateId);
  res.status(204).send();
}));

app.post("/estimates/:estimateId/options", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({ optionLabel: z.string(), description: z.string().optional() }).parse(req.body);
  const option = await service.addOption(estimateId, body.optionLabel, body.description);
  res.status(201).json(option);
}));

app.patch("/options/:optionId", asyncHandler(async (req, res) => {
  const optionId = readParam(req, "optionId");
  const body = z.object({
    optionLabel: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
  }).parse(req.body);

  const updated = await service.updateOption({
    optionId,
    optionLabel: body.optionLabel,
    description: body.description,
  });
  res.json(updated);
}));

app.delete("/options/:optionId", asyncHandler(async (req, res) => {
  const optionId = readParam(req, "optionId");
  await service.deleteOption(optionId);
  res.status(204).send();
}));


app.get("/options/:optionId/materials", asyncHandler(async (req, res) => {
  const optionId = readParam(req, "optionId");
  const result = await service.getMaterialList(optionId);
  res.json(result);
}));

app.patch("/estimates/:estimateId/markup", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({
    materialMarkupPct: z.number().min(0).max(200).optional(),
    laborMarkupPct: z.number().min(0).max(200).optional(),
  }).parse(req.body);
  const updated = await service.updateEstimateMarkup(estimateId, body);
  res.json(updated);
}));

app.post("/estimates/:estimateId/status", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({ status: z.enum(["draft", "review", "sent", "accepted", "declined", "expired", "revised"]) }).parse(req.body);
  const estimate = await service.changeEstimateStatus(estimateId, body.status);
  res.json(estimate);
}));

app.put("/estimates/:estimateId/permit-status", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({
    required: z.boolean(),
    permitType: z.string().optional(),
    status: z.enum(["not_required", "not_filed", "filed", "issued", "expired"]),
    permitNumber: z.string().optional(),
    cost: z.number().nonnegative().optional(),
  }).parse(req.body);
  const updated = await service.upsertPermitStatus(estimateId, body);
  res.json(updated);
}));

app.put("/estimates/:estimateId/inspection-status", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({
    inspectionType: z.enum(["rough_in", "underground", "final", "re_inspection", "service_release", "temporary_power"]),
    status: z.enum(["not_scheduled", "scheduled", "passed", "failed", "corrections_required"]),
    notes: z.string().optional(),
    corrections: z.array(z.string()).optional(),
  }).parse(req.body);
  const updated = await service.upsertInspectionStatus(estimateId, body);
  res.json(updated);
}));

app.post("/estimates/:estimateId/proposals", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const generated = await service.generateProposalPdf(estimateId);
  res.status(201).json(generated);
}));

app.post("/estimates/:estimateId/send-proposal", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");

  // Load estimate with visit, customer, property data
  const est = await prisma.estimate.findUnique({
    where: { id: estimateId },
    include: {
      visit: {
        include: {
          customer: { select: { name: true, email: true } },
          property: { select: { addressLine1: true, city: true, state: true } },
        },
      },
      options: { select: { id: true, optionLabel: true, totalCost: true } },
    },
  });

  if (!est) { res.status(404).json({ error: "Estimate not found" }); return; }
  if (!est.visit?.customer?.email) { res.status(400).json({ error: "Customer has no email address on file" }); return; }

  const customerName = est.visit.customer.name;
  const customerEmail = est.visit.customer.email;
  const serviceAddress = `${est.visit.property?.addressLine1 ?? ""}, ${est.visit.property?.city ?? ""}, ${est.visit.property?.state ?? ""}`;
  const scopeOfWork = est.options.map(o => `${o.optionLabel} — $${Number(o.totalCost).toFixed(2)}`).join("; ");
  const totalPrice = est.options.reduce((sum, o) => sum + Number(o.totalCost), 0);

  // Generate contract document with sign URL
  const contract = await generateContract({
    jobId: est.visitId,
    customerName,
    serviceAddress,
    scopeOfWork,
    totalPrice,
  });

  const signUrl = `${req.protocol}://${req.get("host")}/sign/${contract.documentId}`;

  // Send proposal email to customer
  await sendProposalEmail({
    customerName,
    customerEmail,
    serviceAddress,
    jobDescription: est.title ?? scopeOfWork,
    signUrl,
  });

  // Notify Kyle
  sendKyleNotificationEmail(
    `Proposal Sent: ${customerName}`,
    `Proposal "${est.title}" sent to ${customerEmail}.\nAddress: ${serviceAddress}\nSign URL: ${signUrl}`,
  ).catch(() => {});

  // Change status to "sent"
  await service.changeEstimateStatus(estimateId, "sent");

  res.json({ signUrl, documentId: contract.documentId, emailSent: true });
}));

app.post("/estimates/:estimateId/signatures", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({
    signerName: z.string(),
    signerEmail: z.string().email().optional(),
    signatureData: z.string().min(1),
    consentText: z.string().min(1),
    ipAddress: z.string().optional(),
    userAgent: z.string().optional(),
  }).parse(req.body);

  const signature = await service.recordSignature({
    estimateId,
    ...body,
  });

  res.status(201).json(signature);
}));

app.post("/estimates/:estimateId/acceptance", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({
    optionId: z.string(),
    signatureId: z.string().optional(),
    notes: z.string().optional(),
    status: z.enum(["accepted", "declined"]).optional(),
  }).parse(req.body);

  const result = await service.acceptProposal({
    estimateId,
    ...body,
  });

  res.status(201).json(result);
}));

app.post("/estimates/:estimateId/change-orders", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({
    parentOptionId: z.string().min(1),
    title: z.string(),
    reason: z.string().optional(),
    reasonType: z.enum([
      "customer_request",
      "hidden_condition",
      "utility_requirement",
      "ahj_requirement",
      "damage_discovered",
      "scope_revision",
    ]).optional(),
    assembliesAdded: z.array(z.unknown()).optional(),
    assembliesRemoved: z.array(z.unknown()).optional(),
    assembliesModified: z.array(z.unknown()).optional(),
    deltaLabor: z.number().optional(),
    deltaMaterial: z.number().optional(),
    deltaOther: z.number().optional(),
  }).parse(req.body);

  const changeOrder = await service.createChangeOrder({
    estimateId,
    ...body,
  });

  res.status(201).json(changeOrder);
}));

// ─── CRM Work Order + Material List (JWT auth, auto-populated from estimate) ──

app.post("/estimates/:estimateId/work-order", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const est = await prisma.estimate.findUnique({
    where: { id: estimateId },
    include: {
      visit: {
        include: {
          customer: { select: { name: true } },
          property: { select: { addressLine1: true, city: true, state: true } },
        },
      },
      options: { where: { accepted: true }, include: { assemblies: { include: { assemblyTemplate: true } } }, take: 1 },
    },
  });

  if (!est) { res.status(404).json({ error: "Estimate not found" }); return; }

  const acceptedOption = est.options[0];
  const scopeOfWork = acceptedOption
    ? acceptedOption.assemblies.map(a => `${a.assemblyTemplate?.name ?? a.assemblyTemplateId} x${a.quantity}`).join("; ")
    : est.title ?? "";

  const result = await generateWorkOrder({
    jobId: est.visitId,
    customerName: est.visit?.customer?.name ?? "",
    serviceAddress: `${est.visit?.property?.addressLine1 ?? ""}, ${est.visit?.property?.city ?? ""}`,
    scheduledDate: est.visit?.scheduledStart?.toISOString() ?? "",
    scopeOfWork,
    materialsNeeded: "",
  });
  res.json(result);
}));

app.post("/estimates/:estimateId/material-list", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const est = await prisma.estimate.findUnique({
    where: { id: estimateId },
    include: {
      options: {
        where: { accepted: true },
        include: {
          assemblies: {
            include: {
              components: { where: { componentType: "material" } },
              assemblyTemplate: true,
            },
          },
        },
        take: 1,
      },
      visit: { include: { property: { select: { addressLine1: true, city: true } } } },
    },
  });

  if (!est) { res.status(404).json({ error: "Estimate not found" }); return; }

  const acceptedOption = est.options[0];
  const items = acceptedOption
    ? acceptedOption.assemblies.flatMap(a =>
        (a.components ?? []).map(c => ({
          name: c.description ?? c.code ?? "Material",
          quantity: c.quantity * a.quantity,
          unit: c.unit ?? "ea",
        }))
      )
    : [];

  const result = await generateMaterialList({
    jobId: est.visitId,
    serviceAddress: `${est.visit?.property?.addressLine1 ?? ""}, ${est.visit?.property?.city ?? ""}`,
    items,
  });
  res.json(result);
}));

app.get("/estimates/:estimateId", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const estimate = await service.getEstimateById(estimateId);
  if (!estimate) {
    res.status(404).json({ error: "Estimate not found" });
    return;
  }
  res.json(estimate);
}));

// ─── ATOMIC MODEL ROUTES (Phase M2 — re-pointed to the price book by P014) ──────
//
// T1 of the transition map. These two routes read `PriceBookAtomic` — the catalog the workbook
// feeds and the engine prices from — and no longer read the legacy `AtomicUnit` table.
//
// WHY THE SHAPE CHANGED, rather than being preserved: the legacy row carried ONE labour number
// (`baseLaborHrs` × a modifier multiplier). The published catalog carries THREE — Normal,
// Difficult, Very Difficult — plus the unit basis (E/C/M) that says what those numbers are per.
// There is no honest way to project three published values and a divisor onto one field, and
// picking one silently is exactly the 100x labour error `laborUnitBasis` exists to prevent. So
// the shape moved and every consumer moved with it, in one commit — the map's own instruction:
// "Every consumer moves together or none."
//
// `AtomicUnit` itself is untouched: table, model, rows and the `EstimateItem` relation all stay
// exactly as they were (move, never delete). Historical estimate lines still read it.

// GET /atomic-units — browse/search the live catalog. Same payload as /price-book/atomics.
app.get("/atomic-units", asyncHandler(async (req, res) => {
  // `tier` was the legacy `visibilityTier` (1=user-facing, 2=conditional, 3=system-only). The
  // workbook publishes no such column, so there is nothing to filter on. Refusing beats
  // answering: a caller that asked for tier 1 and silently got all 300+ rows would believe it
  // had filtered.
  const tier = readQuery(req, "tier");
  if (tier !== undefined && tier !== "") {
    res.status(400).json({
      error: "The `tier` filter no longer exists",
      detail:
        "`tier` filtered the legacy AtomicUnit table's visibilityTier column. This route now " +
        "reads the imported price book, which publishes no visibility tier. Filter by " +
        "`category` or `article`, or drop the parameter.",
    });
    return;
  }

  res.json(await browseAtomics(prisma, {
    search: readQuery(req, "search")?.trim(),
    article: readQuery(req, "article")?.trim(),
    category: readQuery(req, "category")?.trim(),
    limit: Number(readQuery(req, "limit") ?? 50) || 50,
  }));
}));

// GET /atomic-units/:code — single atomic by the workbook's own item ID (A016, SD002…)
app.get("/atomic-units/:code", asyncHandler(async (req, res) => {
  const code = readParam(req, "code");
  const atomic = await findAtomicByCode(prisma, code);
  if (!atomic) {
    // A legacy-shaped code gets a sentence that names the cause. "Not found" would send the
    // caller looking for a missing row when the real answer is that the code space moved.
    res.status(404).json({
      error: `Atomic '${code}' is not in the price book`,
      ...(looksLikeLegacyCode(code)
        ? {
            detail:
              `'${code}' is shaped like a legacy AtomicUnit code. This route reads the imported ` +
              `price book, whose codes look like A016 / SD002. The legacy catalog is retained for ` +
              `historical estimates and is no longer browsable here.`,
          }
        : {}),
    });
    return;
  }
  res.json(atomic);
}));

// GET /modifiers — all modifier definitions, optionally filter by appliesTo
app.get("/modifiers", asyncHandler(async (req, res) => {
  const appliesTo = readQuery(req, "appliesTo");
  const where: Record<string, unknown> = {};
  if (appliesTo) where["appliesTo"] = appliesTo;

  const mods = await prisma.modifierDef.findMany({
    where,
    orderBy: [{ modifierType: "asc" }, { sortOrder: "asc" }],
  });
  res.json(mods);
}));

// GET /presets — all active presets
app.get("/presets", asyncHandler(async (_req, res) => {
  const presets = await prisma.preset.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  res.json(presets);
}));

// GET /job-types — all active job types
app.get("/job-types", asyncHandler(async (_req, res) => {
  const jobTypes = await prisma.jobType.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  res.json(jobTypes);
}));

// ─── ESTIMATE ITEMS (atomic) ─────────────────────────────────────────────────

const itemModifierSchema = z.object({
  modifierType: z.enum(["ACCESS", "HEIGHT", "CONDITION"]),
  modifierValue: z.string().min(1),
  laborMultiplier: z.number().min(0.1).max(5),
  materialMult: z.number().min(0.1).max(5),
});

const createItemSchema = z.object({
  atomicUnitCode: z.string().min(1),
  // Some codes exist in multiple catalogs at different prices (e.g. RI-001 in
  // new_work vs old_work). Callers should pass the catalog; without it the
  // lookup falls back to a deterministic order (new_work first).
  catalog: z.enum(["shared", "new_work", "old_work", "service"]).optional(),
  quantity: z.number().positive(),
  location: z.string().optional(),
  notes: z.string().optional(),
  sortOrder: z.number().int().optional(),
  // Circuit-specific
  circuitVoltage: z.union([z.literal(120), z.literal(240)]).optional(),
  circuitAmperage: z.number().int().positive().optional(),
  environment: z.enum(["interior", "exterior", "underground"]).optional(),
  exposure: z.enum(["concealed", "exposed"]).optional(),
  cableLength: z.number().positive().optional(),
  needsThreeWire: z.boolean().optional(),
  // Modifiers (0–3 per item)
  modifiers: z.array(itemModifierSchema).max(3).optional(),
});

// POST /estimates/:estimateId/options/:optionId/items — create an EstimateItem
app.post(
  "/estimates/:estimateId/options/:optionId/items",
  asyncHandler(async (req, res) => {
    const optionId = readParam(req, "optionId");
    const estimateId = readParam(req, "estimateId");

    const body = createItemSchema.parse(req.body);

    // Verify option belongs to estimate
    const option = await prisma.estimateOption.findFirst({
      where: { id: optionId, estimateId },
      include: {
        estimate: {
          include: {
            property: { select: { occupancyType: true } },
          },
        },
      },
    });
    if (!option) {
      res.status(404).json({ error: "Estimate option not found" });
      return;
    }

    // Fetch atomic unit. Catalog narrows duplicate codes; ordering keeps the
    // fallback deterministic instead of insertion-order-dependent pricing.
    const unit = await prisma.atomicUnit.findFirst({
      where: {
        code: body.atomicUnitCode,
        isActive: true,
        ...(body.catalog ? { catalog: body.catalog } : {}),
      },
      orderBy: { catalog: "asc" },
    });
    if (!unit) {
      res.status(404).json({ error: `Atomic unit '${body.atomicUnitCode}' not found` });
      return;
    }

    // Validate cable length required for circuit units
    if (unit.requiresCableLength && !body.cableLength) {
      res.status(400).json({
        error: "Cable length is required for circuit/feeder units",
        field: "cableLength",
      });
      return;
    }

    // Resolve wiring method for circuit units
    const occupancyType =
      (option.estimate.property.occupancyType === "commercial" ? "commercial" : "residential") as
        | "residential"
        | "commercial";

    let resolvedCableCode: string | null = null;
    let resolvedWiringMethod: string | null = null;
    let resolvedCableLaborHrs: number | null = null;
    let resolvedCableLaborCost: number | null = null;
    let resolvedCableMaterialCost: number | null = null;
    let breakerMaterialCost = unit.baseMaterialCost; // default; overridden for circuits

    if (unit.requiresCableLength && body.cableLength) {
      const cableResult = resolveItemCable({
        occupancyType,
        environment: body.environment ?? null,
        exposure: body.exposure ?? null,
        circuitVoltage: body.circuitVoltage ?? null,
        circuitAmperage: body.circuitAmperage ?? null,
        cableLength: body.cableLength,
        resolverGroupId: unit.resolverGroupId ?? null,
        needsThreeWire: body.needsThreeWire ?? null,
      });

      if (cableResult) {
        resolvedCableCode = cableResult.cableCode;
        resolvedWiringMethod = cableResult.wiringMethod;
        resolvedCableLaborHrs = cableResult.cableLaborHrs;
        resolvedCableLaborCost = cableResult.cableLaborCost;
        resolvedCableMaterialCost = cableResult.cableMaterialCost;
        breakerMaterialCost = cableResult.breakerMaterialCost;
      }
    }

    // Compute modifier multipliers
    const modifiers = body.modifiers ?? [];
    let laborMult = 1.0;
    let materialMult = 1.0;
    for (const mod of modifiers) {
      laborMult *= mod.laborMultiplier;
      materialMult *= mod.materialMult;
    }

    // Compute costs (snapshot from catalog)
    const snapshotLaborHrs = unit.baseLaborHrs;
    const snapshotLaborRate = unit.baseLaborRate;
    const snapshotMaterialCost = breakerMaterialCost;

    const laborCost = parseFloat(
      (snapshotLaborHrs * body.quantity * laborMult * snapshotLaborRate +
        (resolvedCableLaborCost ?? 0)).toFixed(2)
    );
    const materialCost = parseFloat(
      (snapshotMaterialCost * body.quantity * materialMult +
        (resolvedCableMaterialCost ?? 0)).toFixed(2)
    );
    const totalCost = parseFloat((laborCost + materialCost).toFixed(2));

    // Insert EstimateItem + ItemModifiers
    const item = await prisma.estimateItem.create({
      data: {
        estimateOptionId: optionId,
        atomicUnitId: unit.id,
        location: body.location ?? null,
        quantity: body.quantity,
        sortOrder: body.sortOrder ?? 0,
        notes: body.notes ?? null,
        snapshotLaborHrs,
        snapshotLaborRate,
        snapshotMaterialCost,
        circuitVoltage: body.circuitVoltage ?? null,
        circuitAmperage: body.circuitAmperage ?? null,
        environment: body.environment ?? null,
        exposure: body.exposure ?? null,
        cableLength: body.cableLength ?? null,
        needsThreeWire: body.needsThreeWire ?? null,
        resolvedWiringMethod,
        resolvedCableCode,
        resolvedCableLaborHrs,
        resolvedCableLaborCost,
        resolvedCableMaterialCost,
        laborCost,
        materialCost,
        totalCost,
        modifiers: modifiers.length
          ? {
              create: modifiers.map((m) => ({
                modifierType: m.modifierType,
                modifierValue: m.modifierValue,
                laborMultiplier: m.laborMultiplier,
                materialMult: m.materialMult,
              })),
            }
          : undefined,
      },
      include: { atomicUnit: true, modifiers: true },
    });

    // Recalculate option totals after adding item
    await service.recalculateOption(optionId);

    // Suggest endpoint if unit requires it
    const suggestEndpoint = unit.requiresEndpoint;

    res.status(201).json({
      item,
      suggestEndpoint,
      resolvedWiringMethod: resolvedWiringMethod
        ? { method: resolvedWiringMethod, code: resolvedCableCode }
        : null,
    });
  })
);

// GET /estimates/:estimateId/options/:optionId/items — list items for an option
app.get(
  "/estimates/:estimateId/options/:optionId/items",
  asyncHandler(async (req, res) => {
    const optionId = readParam(req, "optionId");
    const estimateId = readParam(req, "estimateId");

    const option = await prisma.estimateOption.findFirst({
      where: { id: optionId, estimateId },
    });
    if (!option) {
      res.status(404).json({ error: "Estimate option not found" });
      return;
    }

    const items = await prisma.estimateItem.findMany({
      where: { estimateOptionId: optionId },
      include: { atomicUnit: true, modifiers: true },
      orderBy: { sortOrder: "asc" },
    });

    res.json(items);
  })
);

// DELETE /estimates/:estimateId/options/:optionId/items/:itemId
app.delete(
  "/estimates/:estimateId/options/:optionId/items/:itemId",
  asyncHandler(async (req, res) => {
    const itemId = readParam(req, "itemId");
    const optionId = readParam(req, "optionId");

    const item = await prisma.estimateItem.findFirst({
      where: { id: itemId, estimateOptionId: optionId },
    });
    if (!item) {
      res.status(404).json({ error: "Item not found" });
      return;
    }

    await prisma.estimateItem.delete({ where: { id: itemId } });
    await service.recalculateOption(optionId);
    res.status(204).send();
  })
);

// POST /estimates/:estimateId/support-items — auto-generate support scope
app.post(
  "/estimates/:estimateId/support-items/generate",
  asyncHandler(async (req, res) => {
    const estimateId = readParam(req, "estimateId");

    const estimate = await prisma.estimate.findUnique({
      where: { id: estimateId },
      include: {
        supportItems: true,
        options: {
          include: {
            items: { include: { atomicUnit: true } },
          },
        },
      },
    });
    if (!estimate) {
      res.status(404).json({ error: "Estimate not found" });
      return;
    }

    const allItems = estimate.options.flatMap((o) => o.items);
    const itemInfos = allItems.map((i) => ({
      code: i.atomicUnit.code,
      category: i.atomicUnit.category,
      name: i.atomicUnit.name,
    }));

    const laborRate = 115;
    const generated = generateSupportItems(itemInfos, laborRate);

    // Delete non-overridden auto items and replace
    await prisma.supportItem.deleteMany({
      where: { estimateId, isOverridden: false },
    });

    const created = await Promise.all(
      generated.map((g) =>
        prisma.supportItem.create({
          data: {
            estimateId,
            supportType: g.supportType,
            description: g.description,
            laborHrs: g.laborHrs,
            laborRate,
            laborCost: parseFloat((g.laborHrs * laborRate).toFixed(2)),
            otherCost: g.otherCost,
            totalCost: parseFloat((g.laborHrs * laborRate + g.otherCost).toFixed(2)),
            sourceRule: g.sourceRule,
            isOverridden: false,
          },
        })
      )
    );

    res.json({ generated: created.length, supportItems: created });
  })
);

// GET /estimates/:estimateId/support-items — list support items
app.get(
  "/estimates/:estimateId/support-items",
  asyncHandler(async (req, res) => {
    const estimateId = readParam(req, "estimateId");
    const items = await prisma.supportItem.findMany({
      where: { estimateId },
      orderBy: { sortOrder: "asc" },
    });
    res.json(items);
  })
);

// PATCH /estimates/:estimateId/support-items/:itemId — override a support item
app.patch(
  "/estimates/:estimateId/support-items/:itemId",
  asyncHandler(async (req, res) => {
    const itemId = readParam(req, "itemId");
    const body = z
      .object({
        laborHrs: z.number().min(0).optional(),
        otherCost: z.number().min(0).optional(),
        description: z.string().optional(),
        isOverridden: z.boolean().optional(),
        overrideNote: z.string().optional(),
      })
      .parse(req.body);

    const existing = await prisma.supportItem.findUnique({ where: { id: itemId } });
    if (!existing) {
      res.status(404).json({ error: "Support item not found" });
      return;
    }

    const laborHrs = body.laborHrs ?? existing.laborHrs;
    const otherCost = body.otherCost ?? existing.otherCost;
    const updated = await prisma.supportItem.update({
      where: { id: itemId },
      data: {
        ...body,
        laborHrs,
        laborCost: parseFloat((laborHrs * existing.laborRate).toFixed(2)),
        totalCost: parseFloat((laborHrs * existing.laborRate + otherCost).toFixed(2)),
        isOverridden: body.isOverridden ?? true,
      },
    });

    res.json(updated);
  })
);

// DELETE /estimates/:estimateId/support-items/:itemId
app.delete(
  "/estimates/:estimateId/support-items/:itemId",
  asyncHandler(async (req, res) => {
    const itemId = readParam(req, "itemId");
    const existing = await prisma.supportItem.findUnique({ where: { id: itemId } });
    if (!existing) {
      res.status(404).json({ error: "Support item not found" });
      return;
    }
    await prisma.supportItem.delete({ where: { id: itemId } });
    res.status(204).send();
  })
);

// ─── CHATKIT SESSION ENDPOINT ────────────────────────────────────────────────
app.post("/chatkit/session", asyncHandler(async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    res.status(500).json({ error: "Agent not configured: OPENAI_API_KEY missing" });
    return;
  }

  const { visitId, propertyId } = req.body as { visitId?: string; propertyId?: string };
  const sessionId = `ses_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // Store visit/property context for this session
  sessionContext[sessionId] = { visitId: visitId ?? null, propertyId: propertyId ?? null };

  res.json({
    sessionId,
    agentId: "gpt-5.1",
  });
}));

// In-memory map of session -> last response ID for multi-turn conversation
const sessionResponseIds: Record<string, string> = {};
// In-memory map of session -> visit/property context
const sessionContext: Record<string, { visitId: string | null; propertyId: string | null }> = {};

// ─── CHATKIT MESSAGE ENDPOINT ────────────────────────────────────────────────
app.post("/chatkit/message", asyncHandler(async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    res.status(500).json({ error: "Agent not configured: OPENAI_API_KEY missing" });
    return;
  }

  const { sessionId, message } = req.body as { sessionId: string; message: string; visitId?: string };
  if (!sessionId || !message) {
    res.status(400).json({ error: "sessionId and message required" });
    return;
  }

  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey, timeout: 120_000 });

  const previousResponseId = sessionResponseIds[sessionId] ?? undefined;
  const ctx = sessionContext[sessionId];

  // Build instructions with visit/property context so the agent knows which record to use
  let instructions = AGENT_INSTRUCTIONS;
  if (ctx?.visitId || ctx?.propertyId) {
    instructions += `\n\nCURRENT SESSION CONTEXT — USE THESE IDs FOR ALL TOOL CALLS:\n`;
    if (ctx.visitId) instructions += `Visit ID: ${ctx.visitId}\n`;
    if (ctx.propertyId) instructions += `Property ID: ${ctx.propertyId}\n`;
    instructions += `Do NOT ask the user for visit ID or property ID — you already have them above. Use them directly when calling create_estimate, add_estimate_items, get_visit_context, etc.`;
  }

  // Build MCP tool config if the app's own MCP endpoint is available
  const mcpToken = process.env.MCP_BEARER_TOKEN;
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : "http://localhost:3000";
  const tools: Array<Record<string, unknown>> = [];
  if (mcpToken) {
    tools.push({
      type: "mcp",
      server_label: "rce_estimator",
      server_url: `${baseUrl}/mcp`,
      headers: { Authorization: `Bearer ${mcpToken}` },
      require_approval: "never",
    });
  }

  // Add NEC 2017 file search if vector store is configured
  const vectorStoreId = process.env.NEC_VECTOR_STORE_ID;
  if (vectorStoreId) {
    tools.push({
      type: "file_search",
      vector_store_ids: [vectorStoreId],
    });
  }

  try {
    const response = await openai.responses.create({
      model: "gpt-5.1",
      instructions,
      input: message,
      tools: tools.length > 0 ? tools : undefined,
      stream: false,
      max_output_tokens: 16000,
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    } as Parameters<typeof openai.responses.create>[0]);

    // Cast to non-streaming response type
    const resp = response as { id: string; output: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> };

    // Store response ID for conversation continuity
    sessionResponseIds[sessionId] = resp.id;

    // Extract text from response output
    const reply = resp.output
      ?.filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "")
      .join("\n") ?? "No response";

    res.json({ reply, sessionId });

    // Persist conversation history (non-blocking, don't break chat on failure)
    const chatVisitId = sessionContext[sessionId]?.visitId ?? null;
    prisma.chatMessage.createMany({
      data: [
        { sessionId, visitId: chatVisitId, role: "user", content: message },
        { sessionId, visitId: chatVisitId, role: "assistant", content: reply, openaiResponseId: resp.id },
      ],
    }).catch((e: unknown) => console.error("Failed to persist chat messages:", e));
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("OpenAI Responses API error:", errMsg);
    res.status(502).json({ error: `AI agent error: ${errMsg}` });
  }
}));

// ─── CHATKIT HISTORY ──────────────────────────────────────────────────────

app.get("/chatkit/history", asyncHandler(async (req, res) => {
  const sessionId = readQuery(req, "sessionId");
  const visitId = readQuery(req, "visitId");
  if (!sessionId && !visitId) {
    return res.status(400).json({ error: "Provide sessionId or visitId" });
  }
  const where: Record<string, string> = {};
  if (sessionId) where.sessionId = sessionId;
  if (visitId) where.visitId = visitId;
  const messages = await prisma.chatMessage.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });
  res.json({ messages });
}));

// ─── CHATKIT SESSIONS (list distinct sessions for a visit) ────────────────

app.get("/chatkit/sessions", asyncHandler(async (req, res) => {
  const visitId = readQuery(req, "visitId");
  if (!visitId) {
    return res.status(400).json({ error: "visitId is required" });
  }
  // Group by sessionId to surface one row per conversation
  const grouped = await prisma.chatMessage.groupBy({
    by: ["sessionId"],
    where: { visitId },
    _count: { _all: true },
    _min: { createdAt: true },
    _max: { createdAt: true },
  });
  const sessions = grouped
    .map((g) => ({
      sessionId: g.sessionId,
      messageCount: g._count._all,
      firstMessageAt: g._min.createdAt,
      lastMessageAt: g._max.createdAt,
    }))
    .sort((a, b) => {
      const aT = a.lastMessageAt?.getTime() ?? 0;
      const bT = b.lastMessageAt?.getTime() ?? 0;
      return bT - aT;
    });
  res.json({ sessions });
}));

// ─── CHATKIT EXPORT (JSON / Markdown / TXT) ───────────────────────────────

app.get("/chatkit/export", asyncHandler(async (req, res) => {
  const sessionId = readQuery(req, "sessionId");
  const visitId = readQuery(req, "visitId");
  const format = (readQuery(req, "format") ?? "json").toLowerCase();
  if (!sessionId && !visitId) {
    return res.status(400).json({ error: "Provide sessionId or visitId" });
  }

  const where: Record<string, string> = {};
  if (sessionId) where.sessionId = sessionId;
  if (visitId) where.visitId = visitId;

  const messages = await prisma.chatMessage.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });

  // Pull a little visit context for the header
  let visitHeader: { id: string; visitDate: Date; mode: string; purpose: string | null; customer: string; address: string } | null = null;
  const headerVisitId = visitId ?? messages.find((m) => m.visitId)?.visitId ?? null;
  if (headerVisitId) {
    const visit = await prisma.visit.findUnique({
      where: { id: headerVisitId },
      include: { customer: true, property: true },
    });
    if (visit) {
      visitHeader = {
        id: visit.id,
        visitDate: visit.visitDate,
        mode: visit.mode,
        purpose: visit.purpose,
        customer: visit.customer.name,
        address: [visit.property.addressLine1, visit.property.city, visit.property.state, visit.property.postalCode]
          .filter(Boolean).join(", "),
      };
    }
  }

  const slug = (visitHeader?.address ?? sessionId ?? visitId ?? "chat")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const dateStamp = new Date().toISOString().slice(0, 10);

  if (format === "json") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="rce-chat-${slug}-${dateStamp}.json"`);
    res.json({ visit: visitHeader, sessionId: sessionId ?? null, visitId: visitId ?? null, messages });
    return;
  }

  if (format === "md" || format === "markdown" || format === "txt") {
    const lines: string[] = [];
    lines.push(`# RCE AI Estimator Conversation`);
    lines.push("");
    if (visitHeader) {
      lines.push(`- **Customer:** ${visitHeader.customer}`);
      lines.push(`- **Address:** ${visitHeader.address}`);
      lines.push(`- **Visit:** ${visitHeader.id} (${visitHeader.mode}) — ${visitHeader.visitDate.toISOString().slice(0, 10)}`);
      if (visitHeader.purpose) lines.push(`- **Purpose:** ${visitHeader.purpose}`);
    }
    if (sessionId) lines.push(`- **Session:** ${sessionId}`);
    lines.push(`- **Exported:** ${new Date().toISOString()}`);
    lines.push(`- **Messages:** ${messages.length}`);
    lines.push("");
    lines.push("---");
    lines.push("");
    for (const m of messages) {
      const ts = m.createdAt.toISOString();
      const who = m.role === "user" ? "User" : "Assistant";
      lines.push(`## ${who} — ${ts}`);
      if (m.openaiResponseId) lines.push(`*OpenAI response: ${m.openaiResponseId}*`);
      lines.push("");
      lines.push(m.content);
      lines.push("");
    }
    const body = lines.join("\n");
    const ext = format === "txt" ? "txt" : "md";
    const ctype = format === "txt" ? "text/plain" : "text/markdown";
    res.setHeader("Content-Type", `${ctype}; charset=utf-8`);
    res.setHeader("Content-Disposition", `attachment; filename="rce-chat-${slug}-${dateStamp}.${ext}"`);
    res.send(body);
    return;
  }

  res.status(400).json({ error: `Unsupported format: ${format}. Use json, md, or txt.` });
}));

// ─── LEADS (authenticated) ─────────────────────────────────────────────────

/**
 * The Lead → Visit link is a bare String column with no Prisma relation, so the
 * join has to be done by hand. Every lead gets a `linkedVisit` regardless of the
 * requested pipeline, so the client can render funnel state without a second call.
 */
type LinkedVisit = {
  id: string;
  status: string;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  estimatedDurationDays: number | null;
  jobType: string | null;
  purpose: string | null;
};

async function attachLinkedVisits<T extends { visitId: string | null; existingVisitId: string | null }>(
  leads: T[],
): Promise<(T & { linkedVisit: LinkedVisit | null })[]> {
  const visitIds = [
    ...new Set(
      leads.flatMap((l) => [l.visitId, l.existingVisitId]).filter((id): id is string => Boolean(id)),
    ),
  ];
  const visits = visitIds.length
    ? await prisma.visit.findMany({
      where: { id: { in: visitIds } },
      select: {
        id: true, status: true, scheduledStart: true, scheduledEnd: true,
        estimatedDurationDays: true, jobType: true, purpose: true,
      },
    })
    : [];
  const byId = new Map(visits.map((v) => [v.id, v]));
  return leads.map((lead) => ({
    ...lead,
    linkedVisit: byId.get(lead.visitId ?? "") ?? byId.get(lead.existingVisitId ?? "") ?? null,
  }));
}

const isLostLead = (lead: { status: string; leadStatus: string }) =>
  lead.status === "lost" || lead.leadStatus === "lost";

const isFinishedVisit = (visit: LinkedVisit | null) =>
  visit != null && ARCHIVED_JOB_STATUSES.includes(visit.status as (typeof ARCHIVED_JOB_STATUSES)[number]);

// ─── Lead vocabularies ──────────────────────────────────────────────────────
// Shared by every lead write path. `PATCH /leads/:id/lost` (line 829) validated
// lostReason against an enum while `PATCH /leads/:leadId` stored anything, so one
// typo from any caller permanently skewed GET /leads/loss-report. One definition
// each, used everywhere, so they cannot drift again.

export const LEAD_STATUSES = ["new", "contacted", "converted", "lost"] as const;
export const LEAD_PIPELINE_STATUSES = [
  "new", "booked", "unresolved", "planning", "no_answer", "lost", "won",
] as const;
export const LOST_REASONS = ["price", "timing", "referral", "trust", "scope", "other"] as const;
export const FOLLOW_UP_REASONS = [
  "comparing_estimates", "still_planning", "consulting_partner", "no_answer",
] as const;
export const CONTACT_PREFERENCES = ["phone", "email", "either"] as const;
export const CALL_TYPES = [
  "new_job", "warranty", "reschedule", "cancellation", "estimate_followup", "callback",
  "vendor", "referral", "invoice", "dispute", "wrong_number", "solicitation", "other",
] as const;
/** `manual` is what the CRM's own form uses; the rest are what writes them today. */
export const LEAD_SOURCES = [
  "manual", "phone", "email", "web", "referral", "savannah_text", "retention",
] as const;

/**
 * A lead's address, resolved once into something that cannot be half-formed.
 *
 * The old convert path kept four mutable strings and a regex that silently left
 * three of them empty. Making the empty case its own variant means a Property can
 * never be created from a partial address — the type won't let you.
 */
type LeadAddress =
  | { kind: "structured" | "parsed"; parts: { addressLine1: string; addressLine2: string | null; city: string; state: string; postalCode: string } }
  | { kind: "none" };

/** Exactly `line1, city, ST 12345`. Webhook and voice-agent leads only. */
const FREE_TEXT_ADDRESS = /^(.+?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i;

function resolveLeadAddress(lead: {
  address: string | null; addressLine1: string | null; addressLine2: string | null;
  city: string | null; state: string | null; postalCode: string | null;
}): LeadAddress {
  // Structured wins outright when present — it was typed by a person into
  // labelled fields, which beats anything a regex can infer.
  const line1 = lead.addressLine1?.trim();
  const city = lead.city?.trim();
  const state = lead.state?.trim();
  const zip = lead.postalCode?.trim();
  if (line1 && city && state && zip) {
    return {
      kind: "structured",
      parts: {
        addressLine1: line1, addressLine2: lead.addressLine2?.trim() || null,
        city, state: state.toUpperCase(), postalCode: zip,
      },
    };
  }

  const match = lead.address?.trim().match(FREE_TEXT_ADDRESS);
  if (match) {
    return {
      kind: "parsed",
      parts: {
        addressLine1: match[1].trim(), addressLine2: null, city: match[2].trim(),
        state: match[3].trim().toUpperCase(), postalCode: match[4].trim(),
      },
    };
  }

  // Present but unparseable counts as none. Writing "somewhere off Rutherford
  // Blvd" into addressLine1 with a blank city is worse than refusing.
  return { kind: "none" };
}

/** jobType → Visit mode. Module scope; it was being rebuilt per request. */
function deriveVisitMode(jobType: string | null): string {
  if (!jobType) return "service_diagnostic";
  const jt = jobType.toLowerCase();
  if (jt.includes("remodel") || jt.includes("renovation") || jt.includes("addition")) return "remodel";
  if (jt.includes("new construction") || jt.includes("new build")) return "new_construction";
  return "service_diagnostic";
}

/**
 * One way to birth a Property.
 *
 * `POST /properties` seeded `deficienciesJson: "[]"` and convert seeded neither,
 * so anything parsing that column had to handle null on converted properties
 * only. Both paths come through here now.
 */
async function createPropertyWithSnapshot(
  tx: Pick<typeof prisma, "property" | "systemSnapshot">,
  data: {
    customerId: string; name: string; addressLine1: string; addressLine2?: string | null;
    city: string; state: string; postalCode: string; notes?: string | null;
    occupancyType?: string; jurisdictionId?: string | null;
  },
) {
  const property = await tx.property.create({ data });
  await tx.systemSnapshot.create({
    data: { propertyId: property.id, deficienciesJson: "[]", changeLogJson: "[]" },
  });
  return property;
}

/** Structured address is all-or-nothing — the guarantee convert relies on. */
const leadAddressSchema = z.object({
  addressLine1: z.string().trim().min(1).optional(),
  addressLine2: z.string().trim().nullable().optional(),
  city: z.string().trim().min(1).optional(),
  state: z.string().trim().length(2).optional(),
  postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "ZIP must be 12345 or 12345-6789").optional(),
});

/**
 * Whether a merged address is complete, empty, or a fragment.
 *
 * Evaluated against the row as it will END UP, not the patch alone — otherwise
 * clearing just `city` would sneak a fragment past the check.
 */
function addressCompleteness(a: {
  addressLine1?: string | null; city?: string | null; state?: string | null; postalCode?: string | null;
}): "complete" | "empty" | "partial" {
  const present = [a.addressLine1, a.city, a.state, a.postalCode].filter((v) => Boolean(v?.trim())).length;
  if (present === 4) return "complete";
  if (present === 0) return "empty";
  return "partial";
}

const PARTIAL_ADDRESS_ERROR =
  "An address needs street, city, state and ZIP together — or leave all four blank. " +
  "A partial address would create a property with no city, which is what this replaced.";

/**
 * POST /crm/leads — manual lead entry.
 *
 * Not `POST /leads`: that route lives at line 434, ~750 lines before
 * `pinAuthMiddleware` is installed, so a browser request can never reach a JWT
 * check there — it's gated on a `webhook_secret` header the browser has no way to
 * hold. Line 148 also mounts `publicLimiter` on the `/leads` PREFIX at 30 req/min,
 * already shared by every list refetch, PATCH and convert the SPA makes.
 *
 * `/crm/*` is the established CRM-only prefix: after pin auth, not rate-limited.
 */
app.post("/crm/leads", asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(1),
    email: z.string().trim().email().nullable().optional(),
    phone: z.string().trim().nullable().optional(),
    source: z.enum(LEAD_SOURCES).default("manual"),
    // A lead being entered by hand is by definition not yet converted —
    // conversion is a transition that creates records, not an initial state.
    status: z.enum(["new", "contacted", "lost"]).default("new"),
    leadStatus: z.enum(LEAD_PIPELINE_STATUSES).default("new"),
    notes: z.string().trim().nullable().optional(),
    jobType: z.string().trim().nullable().optional(),
    callType: z.enum(CALL_TYPES).nullable().optional(),
    referredBy: z.string().trim().nullable().optional(),
    urgentFlag: z.boolean().default(false),
    warrantyCall: z.boolean().default(false),
    warrantyNote: z.string().trim().nullable().optional(),
    contactPreference: z.enum(CONTACT_PREFERENCES).nullable().optional(),
    bestTimeToReach: z.string().trim().nullable().optional(),
    followUpDate: z.coerce.date().nullable().optional(),
    followUpReason: z.enum(FOLLOW_UP_REASONS).nullable().optional(),
    lostReason: z.enum(LOST_REASONS).nullable().optional(),
    lostNotes: z.string().trim().nullable().optional(),
    address: z.string().trim().nullable().optional(),
    customerId: z.string().min(1).nullable().optional(),
    propertyId: z.string().min(1).nullable().optional(),
  }).merge(leadAddressSchema).parse(req.body);

  if (addressCompleteness(body) === "partial") {
    res.status(400).json({ error: PARTIAL_ADDRESS_ERROR });
    return;
  }

  if (body.customerId) {
    const customer = await prisma.customer.findUnique({ where: { id: body.customerId }, select: { id: true } });
    if (!customer) { res.status(400).json({ error: "Linked account not found" }); return; }
  }
  if (body.propertyId) {
    const property = await prisma.property.findUnique({
      where: { id: body.propertyId },
      select: { id: true, customerId: true },
    });
    if (!property) { res.status(400).json({ error: "Linked address not found" }); return; }
    // Without this a lead could point at another account's address, and convert
    // would then attach a Visit across two accounts.
    if (body.customerId && property.customerId !== body.customerId) {
      res.status(400).json({ error: "That address belongs to a different account" });
      return;
    }
  }

  const lead = await prisma.lead.create({
    data: {
      ...body,
      state: body.state ? body.state.toUpperCase() : undefined,
    },
  });

  // Returned even though the client normally looks matches up first: a second
  // tab or a fast typist can submit without ever having called the lookup, and
  // the owner asked to be shown duplicates rather than stopped by them.
  const matches = await findCustomerMatches({
    phone: lead.phone, email: lead.email, name: lead.name,
  });
  res.status(201).json({ lead, matches });
}));

/**
 * GET /crm/customer-matches — accounts that might already be this caller.
 *
 * Each match carries its addresses, so the picker can offer "link to this
 * account → and which address" without a second round trip.
 */
app.get("/crm/customer-matches", asyncHandler(async (req, res) => {
  const phone = readQuery(req, "phone");
  const email = readQuery(req, "email");
  const name = readQuery(req, "name");
  if (!phone && !email && !name) {
    res.status(400).json({ error: "Provide at least one of phone, email or name" });
    return;
  }
  const matches = await findCustomerMatches({ phone, email, name, limit: 10 });
  res.json({ matches });
}));

app.get("/leads", asyncHandler(async (req, res) => {
  const status = readQuery(req, "status");
  const leadStatus = readQuery(req, "leadStatus");
  const pipeline = readQuery(req, "pipeline");
  const where: Record<string, unknown> = {};
  if (status) where["status"] = status;
  if (leadStatus) where["leadStatus"] = leadStatus;

  const rows = await prisma.lead.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  const leads = await attachLinkedVisits(rows);

  if (!pipeline) {
    res.json(leads);
    return;
  }

  // "open" is the Leads tab: anyone not yet scheduled and not written off.
  // A converted lead whose visit has no appointment yet is still open — conversion
  // creates a job, not an appointment, and the rule is "yet to be contacted/scheduled".
  const filtered = leads.filter((lead) => {
    const scheduled = lead.linkedVisit?.scheduledStart != null;
    switch (pipeline) {
      case "open":
        return !isLostLead(lead) && !scheduled && !isFinishedVisit(lead.linkedVisit);
      case "scheduled":
        return scheduled && !isFinishedVisit(lead.linkedVisit);
      case "closed":
        return isLostLead(lead) || isFinishedVisit(lead.linkedVisit);
      default:
        return true;
    }
  });

  res.json(filtered);
}));

app.patch("/leads/:leadId", asyncHandler(async (req, res) => {
  const leadId = readParam(req, "leadId");
  const body = req.body as {
    name?: string;
    email?: string;
    phone?: string;
    address?: string;
    jobType?: string;
    status?: string;
    notes?: string;
    callType?: string;
    referredBy?: string;
    urgentFlag?: boolean;
    warrantyCall?: boolean;
    warrantyNote?: string;
    estimateId?: string;
    existingVisitId?: string;
    leadStatus?: string;
    followUpDate?: string | null;
    followUpReason?: string | null;
    followUpCount?: number;
    lostReason?: string | null;
    lostNotes?: string | null;
    bestTimeToReach?: string | null;
    contactPreference?: string | null;
    // ── Added for manual editing ──
    source?: string;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    // Re-pointing a lead at a known account is the common case: a webhook lead
    // arrives, the owner recognizes the customer, and links it before converting.
    // `visitId` is deliberately NOT accepted — that's conversion's output and the
    // scheduler's business, and writing it here could point a lead at someone
    // else's job.
    customerId?: string | null;
    propertyId?: string | null;
  };

  // Existing row first: PATCH was the only lead route with no 404 guard, so a bad
  // id surfaced as a Prisma error and a 500. It's also needed to evaluate the
  // address against the MERGED result rather than the patch alone.
  const existing = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!existing) { res.status(404).json({ error: "Lead not found" }); return; }

  const oneOf = (value: string | null | undefined, allowed: readonly string[], field: string) => {
    if (value === undefined || value === null) return null;
    return allowed.includes(value) ? null : `Invalid ${field}. Must be one of: ${allowed.join(", ")}`;
  };
  const invalid =
    oneOf(body.status, LEAD_STATUSES, "status") ??
    oneOf(body.leadStatus, LEAD_PIPELINE_STATUSES, "leadStatus") ??
    oneOf(body.source, LEAD_SOURCES, "source") ??
    oneOf(body.lostReason, LOST_REASONS, "lostReason") ??
    oneOf(body.followUpReason, FOLLOW_UP_REASONS, "followUpReason") ??
    oneOf(body.contactPreference, CONTACT_PREFERENCES, "contactPreference") ??
    oneOf(body.callType, CALL_TYPES, "callType");
  if (invalid) { res.status(400).json({ error: invalid }); return; }

  const pick = <T,>(patched: T | undefined, current: T): T => (patched === undefined ? current : patched);
  const merged = {
    addressLine1: pick(body.addressLine1, existing.addressLine1),
    city: pick(body.city, existing.city),
    state: pick(body.state, existing.state),
    postalCode: pick(body.postalCode, existing.postalCode),
  };
  if (addressCompleteness(merged) === "partial") {
    res.status(400).json({ error: PARTIAL_ADDRESS_ERROR });
    return;
  }
  if (body.postalCode && !/^\d{5}(-\d{4})?$/.test(body.postalCode.trim())) {
    res.status(400).json({ error: "ZIP must be 12345 or 12345-6789" });
    return;
  }

  // An address must belong to the account the lead will end up on.
  const effectiveCustomerId = pick(body.customerId, existing.customerId);
  if (body.propertyId) {
    const property = await prisma.property.findUnique({
      where: { id: body.propertyId }, select: { id: true, customerId: true },
    });
    if (!property) { res.status(400).json({ error: "Linked address not found" }); return; }
    if (effectiveCustomerId && property.customerId !== effectiveCustomerId) {
      res.status(400).json({ error: "That address belongs to a different account" });
      return;
    }
  }
  if (body.customerId) {
    const customer = await prisma.customer.findUnique({ where: { id: body.customerId }, select: { id: true } });
    if (!customer) { res.status(400).json({ error: "Linked account not found" }); return; }
  }

  const data: Record<string, unknown> = {};
  if (body.source !== undefined) data.source = body.source;
  if (body.addressLine1 !== undefined) data.addressLine1 = body.addressLine1?.trim() || null;
  if (body.addressLine2 !== undefined) data.addressLine2 = body.addressLine2?.trim() || null;
  if (body.city !== undefined) data.city = body.city?.trim() || null;
  if (body.state !== undefined) data.state = body.state?.trim().toUpperCase() || null;
  if (body.postalCode !== undefined) data.postalCode = body.postalCode?.trim() || null;
  if (body.customerId !== undefined) data.customerId = body.customerId;
  if (body.propertyId !== undefined) data.propertyId = body.propertyId;
  if (body.name !== undefined) data.name = body.name.trim();
  if (body.email !== undefined) data.email = body.email?.trim() || null;
  if (body.phone !== undefined) data.phone = body.phone?.trim() || null;
  if (body.address !== undefined) data.address = body.address?.trim() || null;
  if (body.jobType !== undefined) data.jobType = body.jobType?.trim() || null;
  if (body.status) data.status = body.status;
  if (body.notes !== undefined) data.notes = body.notes;
  if (body.callType !== undefined) data.callType = body.callType;
  if (body.referredBy !== undefined) data.referredBy = body.referredBy;
  if (body.urgentFlag !== undefined) data.urgentFlag = body.urgentFlag;
  if (body.warrantyCall !== undefined) data.warrantyCall = body.warrantyCall;
  if (body.warrantyNote !== undefined) data.warrantyNote = body.warrantyNote;
  if (body.estimateId !== undefined) data.estimateId = body.estimateId;
  if (body.existingVisitId !== undefined) data.existingVisitId = body.existingVisitId;
  if (body.leadStatus !== undefined) data.leadStatus = body.leadStatus;
  if (body.followUpReason !== undefined) data.followUpReason = body.followUpReason;
  if (body.followUpCount !== undefined) data.followUpCount = body.followUpCount;
  if (body.lostReason !== undefined) data.lostReason = body.lostReason;
  if (body.lostNotes !== undefined) data.lostNotes = body.lostNotes;
  if (body.bestTimeToReach !== undefined) data.bestTimeToReach = body.bestTimeToReach;
  if (body.contactPreference !== undefined) data.contactPreference = body.contactPreference;

  if (body.followUpDate !== undefined) {
    if (body.followUpDate === null || body.followUpDate === "") {
      data.followUpDate = null;
    } else {
      const parsed = new Date(body.followUpDate);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: "Invalid followUpDate" });
        return;
      }
      data.followUpDate = parsed;
    }
  }

  const lead = await prisma.lead.update({
    where: { id: leadId },
    data,
  });
  res.json(lead);
}));

app.delete("/leads/:leadId", asyncHandler(async (req, res) => {
  const leadId = readParam(req, "leadId");
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  if (lead.status === "converted") {
    res.status(409).json({ error: "Cannot delete a converted lead" });
    return;
  }
  await prisma.lead.delete({ where: { id: leadId } });
  res.status(204).end();
}));

/**
 * PATCH /leads/:leadId/convert — lead becomes account + address + job.
 *
 * Three things changed here, all of them about not writing records nobody asked
 * for:
 *
 * 1. **The duplicate guard rail.** This used to create a brand-new Customer every
 *    time, with no phone or email matching anywhere — so a repeat customer asking
 *    about a second property got a duplicate account instead of a second address.
 *    Now, if it's about to mint an account and a match exists, it refuses with 409
 *    and the matches, having written nothing. It never adopts a match on its own,
 *    even a perfect one: that's a merge decision, and merges are hard to undo.
 *    One flag (`createNewAccount`) says "yes, genuinely new".
 * 2. **No half-conversions.** An unparseable or missing address used to produce a
 *    Customer, no Property, no Visit — and because the lead was then marked
 *    converted, `DELETE` 409'd on it forever. Now that's a 400 with nothing
 *    written, so the lead stays fixable and deletable.
 * 3. **No empty-string addresses.** `resolveLeadAddress` returns a complete
 *    address or none at all.
 */
app.patch("/leads/:leadId/convert", asyncHandler(async (req, res) => {
  const leadId = readParam(req, "leadId");
  const body = z.object({
    customerId: z.string().min(1).optional(),
    propertyId: z.string().min(1).optional(),
    propertyName: z.string().trim().min(1).optional(),
    jurisdictionId: z.enum(KNOWN_JURISDICTION_IDS).optional(),
    /** Explicit acknowledgement that a duplicate-looking account is intended. */
    createNewAccount: z.boolean().optional(),
  }).merge(leadAddressSchema).parse(req.body ?? {});

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  if (lead.status === "converted") {
    // 409, matching DELETE's vocabulary for the same state conflict.
    res.status(409).json({ error: "Lead already converted" });
    return;
  }

  // An address supplied on the request beats the lead's own — this is the picker
  // saying "actually, put it here".
  const address = addressCompleteness(body) === "complete"
    ? resolveLeadAddress({
      address: null, addressLine1: body.addressLine1!, addressLine2: body.addressLine2 ?? null,
      city: body.city!, state: body.state!, postalCode: body.postalCode!,
    })
    : resolveLeadAddress(lead);

  const customerId = body.customerId ?? lead.customerId;
  const propertyId = body.propertyId ?? lead.propertyId;

  if (customerId) {
    const exists = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!exists) { res.status(400).json({ error: "Linked account not found" }); return; }
  } else if (!body.createNewAccount) {
    // About to mint an account. Check first — this is the whole point.
    const matches = await findCustomerMatches({ phone: lead.phone, email: lead.email, name: lead.name });
    if (matches.length > 0) {
      res.status(409).json({
        error: "Possible duplicate account",
        message:
          "This lead's contact details match an account you already have. Link it to that " +
          "account and choose an address, or confirm you want a new account.",
        matches,
      });
      return;
    }
  }

  if (propertyId) {
    const property = await prisma.property.findUnique({
      where: { id: propertyId }, select: { id: true, customerId: true },
    });
    if (!property) { res.status(400).json({ error: "Linked address not found" }); return; }
    if (customerId && property.customerId !== customerId) {
      res.status(400).json({ error: "That address belongs to a different account" });
      return;
    }
  } else if (address.kind === "none") {
    // Nothing is written. The lead stays unconverted, so it remains editable and
    // deletable rather than becoming a permanent orphan.
    res.status(400).json({
      error: "This lead has no usable address",
      message:
        "Add a street address, city, state and ZIP before converting — a job has to belong " +
        "to somewhere. Nothing was created.",
      needs: "address",
    });
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const customer = customerId
      ? (await tx.customer.findUniqueOrThrow({ where: { id: customerId } }))
      : await tx.customer.create({ data: { name: lead.name, email: lead.email, phone: lead.phone, smsConsent: lead.smsConsent } });

    let property: { id: string } | null = propertyId
      ? await tx.property.findUnique({ where: { id: propertyId }, select: { id: true } })
      : null;

    if (!property && address.kind !== "none") {
      property = await createPropertyWithSnapshot(tx, {
        customerId: customer.id,
        name: body.propertyName ?? address.parts.addressLine1,
        ...address.parts,
        // Left null unless the office said otherwise, so jurisdictionResolver
        // derives it from the ZIP — which now actually exists.
        jurisdictionId: body.jurisdictionId ?? null,
      });
    }

    const visit = property
      ? await tx.visit.create({
        data: {
          propertyId: property.id,
          customerId: customer.id,
          mode: deriveVisitMode(lead.jobType),
          // Convert used to drop jobType, so a hand-typed "Panel upgrade"
          // vanished at exactly the moment it became a job — and both the Jobs
          // page and the funnel badge read visit.jobType.
          jobType: lead.jobType,
          purpose: lead.notes ?? undefined,
        },
      })
      : null;

    const updatedLead = await tx.lead.update({
      where: { id: leadId },
      data: {
        status: "converted",
        leadStatus: "won",
        followUpDate: null,
        customerId: customer.id,
        propertyId: property?.id ?? null,
        visitId: visit?.id ?? null,
      },
    });

    return { customer, property, visit, lead: updatedLead };
  });

  res.json(result);
}));

// ─── FEEDBACK (authenticated CRM UI) ───────────────────────────────────────
// The feedback box in the client. Reports land in SystemEvent (source =
// "feedback") next to the correlated errors, where scripts/readSystemEvents.ts
// — the coding agent's audit path — reads them. Registered after pinAuth, so a
// session is required; the page/context fields come from the widget, not the
// user.
app.post("/feedback", asyncHandler(async (req, res) => {
  const body = z.object({
    message: z.string().trim().min(1).max(4000),
    page: z.string().trim().max(300).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  }).parse(req.body);

  logSystemEvent("info", "feedback", body.message, {
    page: body.page,
    ...body.context,
    userAgent: req.headers["user-agent"],
  });

  res.status(201).json({ ok: true });
}));

app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const includeDetails = process.env.NODE_ENV !== "production";

  if (err instanceof z.ZodError) {
    res.status(400).json({
      error: "Validation failed",
      details: includeDetails ? err.flatten() : undefined,
    });
    return;
  }

  if (
    typeof err === "object"
    && err !== null
    && "statusCode" in err
    && typeof (err as { statusCode?: unknown }).statusCode === "number"
  ) {
    const statusCode = (err as { statusCode: number }).statusCode;
    const message = err instanceof Error ? err.message : "Request failed";
    res.status(statusCode).json({ error: message });
    return;
  }

  const message = err instanceof Error ? err.message : "Unknown error";
  console.error("Unhandled error", err);
  // Persist it — console.error scrolls away in Railway; SystemEvent rows are
  // what scripts/readSystemEvents.ts audits when something "just doesn't work".
  logSystemEvent("error", "express", message, {
    route: `${req.method} ${req.path}`,
    stack: err instanceof Error ? err.stack : undefined,
  });
  res.status(500).json({
    error: "Internal server error",
    details: includeDetails ? message : undefined,
  });
});
