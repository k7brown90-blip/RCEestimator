import express from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { prisma } from "./lib/prisma";

import { EstimateService } from "./services/estimateService";
import { resolveItemCable } from "./services/wiringMethodResolver";
import { generateSupportItems } from "./services/supportItemTriggers";
import { getAvailability, bookAppointment } from "./services/googleCalendar";
import { getDailySummary } from "./services/dailySummary";
import { getTodaySchedule, getWeekSchedule, createCalendarEvent, deleteCalendarEvent, moveCalendarEvent } from "./services/schedule";
import { sendSms, isFromKyle, KYLE_PHONE } from "./services/twilio";
import { generateContract, generateChangeOrder, generateWorkOrder, generateMaterialList, markDocumentSigned } from "./services/pdfGenerator";
import { sendConfirmationEmail } from "./services/confirmationEmail";
import { handleMcpPost, handleMcpGet, handleMcpDelete } from "./mcp/server";
import { pinAuthMiddleware, handlePinLogin } from "./middleware/pinAuth";
import { AGENT_INSTRUCTIONS } from "./agentInstructions";
import { agentRouter } from "./routes/agent";
import { savannahRouter } from "./routes/agent-savannah";
import { jerryRouter } from "./routes/agent-jerry";
import { sharedAgentRouter } from "./routes/agent-shared";

const service = new EstimateService(prisma);

export const app = express();

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

// ─── MCP ENDPOINT ────────────────────────────────────────────────────────────
const mcpBearerToken = process.env.MCP_BEARER_TOKEN;
const mcpAuth: express.RequestHandler = (req, res, next) => {
  if (mcpBearerToken) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${mcpBearerToken}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
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

// ─── VAPI DYNAMIC VARIABLES (no auth — called at start of each inbound call) ──
app.post("/vapi/assistant-config", (_req, res) => {
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
  res.json({ variableValues: { current_date, current_time, currentDateTime: `${current_date}, ${current_time} Central Time` } });
});

// ─── CALENDAR AVAILABILITY (no auth — called by Vapi AI assistant) ───────────
app.get("/calendar/availability", asyncHandler(async (_req, res) => {
  const data = await getAvailability();
  res.json(data);
}));

// ─── CALENDAR BOOKING (no auth — called by Vapi AI assistant) ────────────────
app.post("/calendar/book", asyncHandler(async (req, res) => {
  const { date, startTime, customerName, description, address } = req.body;
  if (!date || !startTime || !customerName || !description || !address) {
    return res.status(400).json({ error: "Required: date, startTime, customerName, description, address" });
  }
  const result = await bookAppointment({ date, startTime, customerName, description, address });
  res.json(result);
}));

// ─── CUSTOMER LOOKUP (no auth — called by Vapi AI assistant) ─────────────────
const KYLE_PHONE_10 = "9706661626";

app.get("/customer/lookup", asyncHandler(async (req, res) => {
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
  if (nameRaw) {
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

// ─── DAILY CALL SUMMARY (no auth — public endpoint) ─────────────────────────
app.get("/calls/daily-summary", asyncHandler(async (_req, res) => {
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

  const body = req.body as { name?: string; email?: string; phone?: string; source?: string; notes?: string; address?: string; jobType?: string; callType?: string; referredBy?: string; urgentFlag?: boolean; warrantyCall?: boolean; warrantyNote?: string; estimateId?: string; existingVisitId?: string; contactPreference?: string; leadStatus?: string; bestTimeToReach?: string };
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
    },
  });

  res.status(201).json(lead);

  // SMS Kyle for web leads (fire-and-forget)
  if ((body.source === "web") && lead.phone) {
    sendSms(KYLE_PHONE, `New web lead — ${lead.name}, ${lead.jobType ?? "general"}, ${lead.phone}`).catch(() => {});
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

// ─── INBOUND SMS WEBHOOK (Twilio → Make.com passes through, or direct) ──────

app.post("/sms/inbound", asyncHandler(async (req, res) => {
  // Twilio sends form-encoded data; Express needs urlencoded parser
  // Make.com will usually proxy as JSON, so handle both
  const from = (req.body?.From || req.body?.from || "") as string;
  const body = (req.body?.Body || req.body?.body || "") as string;

  if (!isFromKyle(from)) {
    // Reject SMS from non-Kyle numbers
    res.status(403).json({ error: "Unauthorized sender" });
    return;
  }

  // Log the inbound message — Make.com will handle routing via its scenario
  console.log(`[SMS] From Kyle: ${body}`);

  // Return 200 OK — Make.com or Twilio expects a quick response
  res.json({ received: true, from, body });
}));

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
  sendSms(KYLE_PHONE, `${body.name.trim()} signed the ${doc.type.replace(/_/g, " ")} for ${addr}`).catch(() => {});

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
  sendSms(KYLE_PHONE, `Email booking: ${lead.name} — ${lead.jobType ?? "service"} — ${dateStr} ${timeStr}`).catch(() => {});

  res.json({ booked: true, eventId: event.id, leadId });
}));

// ─── AGENT API (Jerry — voice/SMS field assistant) ────────────────────────────
app.use("/agent", agentRouter);
app.use("/agent/savannah", savannahRouter);
app.use("/agent/jerry", jerryRouter);
app.use("/agent/calendar", sharedAgentRouter);

// ─── PIN AUTH ────────────────────────────────────────────────────────────────
app.post("/auth/pin", asyncHandler(async (req, res) => { await handlePinLogin(req, res); }));
app.use(pinAuthMiddleware);

app.get("/jobs", asyncHandler(async (_req, res) => {
  const visits = await prisma.visit.findMany({
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
    },
    orderBy: { visitDate: "desc" },
  });

  const jobs = visits.map((visit: typeof visits[number]) => {
    const latestEstimate = visit.estimates[0] ?? null;
    const acceptedOption = latestEstimate?.options.find((o: typeof latestEstimate.options[number]) => o.accepted) ?? null;
    let highestOption: typeof latestEstimate.options[number] | null = null;
    for (const option of latestEstimate?.options ?? []) {
      if (!highestOption || option.totalCost > highestOption.totalCost) {
        highestOption = option;
      }
    }

    const revenue = visit.revenue ?? acceptedOption?.totalCost ?? null;
    const materialCost = visit.actualMaterialCost ?? 0;
    const laborCost = (visit.laborHours ?? 0) * 75; // $75/hr default labor rate
    const overhead = visit.overheadAllocation ?? 0;
    const totalCost = materialCost + laborCost + overhead;

    return {
      visitId: visit.id,
      visitDate: visit.visitDate,
      mode: visit.mode,
      purpose: visit.purpose,
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
          totalCost: acceptedOption?.totalCost ?? highestOption?.totalCost ?? null,
          hasAcceptance: Boolean(latestEstimate.acceptance),
        }
        : null,
      costs: {
        estimatedCost: visit.estimatedCost,
        materialCost,
        laborHours: visit.laborHours ?? 0,
        laborCost,
        overhead,
        totalCost,
        revenue,
        grossProfit: revenue != null ? revenue - totalCost : null,
        margin: revenue != null && revenue > 0 ? Math.round(((revenue - totalCost) / revenue) * 100) : null,
      },
    };
  });

  res.json(jobs);
}));

app.get("/customers", asyncHandler(async (_req, res) => {
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
}));

app.get("/customers/:customerId", asyncHandler(async (req, res) => {
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
}));

app.patch("/customers/:customerId", asyncHandler(async (req, res) => {
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
}));

app.delete("/customers/:customerId", asyncHandler(async (req, res) => {
  const customerId = readParam(req, "customerId");
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: { properties: { include: { visits: true } } },
  });
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const hasVisits = customer.properties.some((p) => p.visits.length > 0);
  if (hasVisits) {
    res.status(409).json({ error: "Cannot delete a customer with existing job history." });
    return;
  }
  await prisma.customer.delete({ where: { id: customerId } });
  res.status(204).send();
}));

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

app.post("/customers", asyncHandler(async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    email: z.string().email().optional(),
    phone: z.string().optional(),
  });
  const body = schema.parse(req.body);
  const created = await prisma.customer.create({ data: body });
  res.status(201).json(created);
}));

app.post("/properties", asyncHandler(async (req, res) => {
  const schema = z.object({
    customerId: z.string().min(1),
    name: z.string().min(1),
    addressLine1: z.string().min(1),
    addressLine2: z.string().optional(),
    city: z.string().min(1),
    state: z.string().min(1),
    postalCode: z.string().min(1),
    notes: z.string().optional(),
  });
  const body = schema.parse(req.body);
  const property = await prisma.property.create({ data: body });
  await prisma.systemSnapshot.create({
    data: {
      propertyId: property.id,
      deficienciesJson: JSON.stringify([]),
      changeLogJson: JSON.stringify([]),
    },
  });
  res.status(201).json(property);
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

app.get("/estimates/:estimateId", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const estimate = await service.getEstimateById(estimateId);
  if (!estimate) {
    res.status(404).json({ error: "Estimate not found" });
    return;
  }
  res.json(estimate);
}));

// ─── ATOMIC MODEL ROUTES (Phase M2) ─────────────────────────────────────────

// GET /atomic-units — list units, optionally filter by category and/or tier
app.get("/atomic-units", asyncHandler(async (req, res) => {
  const category = readQuery(req, "category");
  const tierStr = readQuery(req, "tier");
  const tier = tierStr ? parseInt(tierStr, 10) : undefined;

  const where: Record<string, unknown> = { isActive: true };
  if (category) where["category"] = category;
  if (tier !== undefined && !isNaN(tier)) where["visibilityTier"] = tier;

  const units = await prisma.atomicUnit.findMany({
    where,
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
  });

  res.json(units);
}));

// GET /atomic-units/:code — single unit detail
app.get("/atomic-units/:code", asyncHandler(async (req, res) => {
  const code = readParam(req, "code");
  const unit = await prisma.atomicUnit.findFirst({ where: { code, isActive: true } });
  if (!unit) {
    res.status(404).json({ error: "Atomic unit not found" });
    return;
  }
  res.json(unit);
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

// GET /nec-rules — all active NEC rules
app.get("/nec-rules", asyncHandler(async (_req, res) => {
  const rules = await prisma.nECRule.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  res.json(rules);
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

    // Fetch atomic unit
    const unit = await prisma.atomicUnit.findFirst({
      where: { code: body.atomicUnitCode, isActive: true },
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

// POST /estimates/:estimateId/nec-check — run NEC validation against estimate items
app.post(
  "/estimates/:estimateId/nec-check",
  asyncHandler(async (req, res) => {
    const estimateId = readParam(req, "estimateId");

    const estimate = await prisma.estimate.findUnique({
      where: { id: estimateId },
      include: {
        options: {
          include: {
            items: {
              include: { atomicUnit: true },
            },
          },
        },
      },
    });
    if (!estimate) {
      res.status(404).json({ error: "Estimate not found" });
      return;
    }

    // Collect all unit codes and locations across all options/items
    const allItems = estimate.options.flatMap((o) => o.items);
    const unitCodesPresent = [...new Set(allItems.map((i) => i.atomicUnit.code))];
    const locationsPresent = allItems.map((i) => (i.location ?? "").toLowerCase());

    const allRules = await prisma.nECRule.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });

    const prompts: Array<{
      ruleCode: string;
      necArticle: string;
      promptText: string;
      severity: string;
    }> = [];

    for (const rule of allRules) {
      let trigger: { units_present?: string[]; location_contains?: string[] };
      try {
        trigger = JSON.parse(rule.triggerCondition);
      } catch {
        continue;
      }

      let fired = false;

      if (trigger.units_present) {
        fired = trigger.units_present.some((code) => unitCodesPresent.includes(code));
      }
      if (!fired && trigger.location_contains) {
        fired = trigger.location_contains.some((kw) =>
          locationsPresent.some((loc) => loc.includes(kw))
        );
      }

      if (fired) {
        prompts.push({
          ruleCode: rule.ruleCode,
          necArticle: rule.necArticle,
          promptText: rule.promptText,
          severity: rule.severity,
        });
      }
    }

    res.json({ estimateId, prompts });
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
  const sessionId = readParam(req, "sessionId");
  const visitId = readParam(req, "visitId");
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

// ─── LEADS (authenticated) ─────────────────────────────────────────────────

app.get("/leads", asyncHandler(async (req, res) => {
  const status = readParam(req, "status");
  const where: Record<string, unknown> = {};
  if (status) where["status"] = status;

  const leads = await prisma.lead.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  res.json(leads);
}));

app.patch("/leads/:leadId", asyncHandler(async (req, res) => {
  const leadId = readParam(req, "leadId");
  const body = req.body as { status?: string; notes?: string; callType?: string; referredBy?: string; urgentFlag?: boolean; warrantyCall?: boolean; warrantyNote?: string; estimateId?: string; existingVisitId?: string };
  const validStatuses = ["new", "contacted", "converted", "lost"];
  if (body.status && !validStatuses.includes(body.status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
    return;
  }

  const data: Record<string, unknown> = {};
  if (body.status) data.status = body.status;
  if (body.notes !== undefined) data.notes = body.notes;
  if (body.callType !== undefined) data.callType = body.callType;
  if (body.referredBy !== undefined) data.referredBy = body.referredBy;
  if (body.urgentFlag !== undefined) data.urgentFlag = body.urgentFlag;
  if (body.warrantyCall !== undefined) data.warrantyCall = body.warrantyCall;
  if (body.warrantyNote !== undefined) data.warrantyNote = body.warrantyNote;
  if (body.estimateId !== undefined) data.estimateId = body.estimateId;
  if (body.existingVisitId !== undefined) data.existingVisitId = body.existingVisitId;

  const lead = await prisma.lead.update({
    where: { id: leadId },
    data,
  });
  res.json(lead);
}));

app.patch("/leads/:leadId/convert", asyncHandler(async (req, res) => {
  const leadId = readParam(req, "leadId");
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  if (lead.status === "converted") {
    res.status(400).json({ error: "Lead already converted" });
    return;
  }

  // Parse address into components if possible (basic "city, state zip" pattern)
  let addressLine1 = lead.address ?? "";
  let city = "";
  let state = "";
  let postalCode = "";
  if (lead.address) {
    const match = lead.address.match(/^(.+?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i);
    if (match) {
      addressLine1 = match[1].trim();
      city = match[2].trim();
      state = match[3].trim().toUpperCase();
      postalCode = match[4].trim();
    }
  }

  // Map jobType string to visit mode
  function deriveMode(jobType: string | null): string {
    if (!jobType) return "service_diagnostic";
    const jt = jobType.toLowerCase();
    if (jt.includes("remodel") || jt.includes("renovation") || jt.includes("addition")) return "remodel";
    if (jt.includes("new construction") || jt.includes("new build")) return "new_construction";
    return "service_diagnostic";
  }

  const result = await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: {
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
      },
    });

    let property: { id: string } | null = null;
    if (lead.address) {
      property = await tx.property.create({
        data: {
          customerId: customer.id,
          name: addressLine1,
          addressLine1,
          city,
          state,
          postalCode,
        },
      });
      // Create empty system snapshot (matches existing property creation pattern)
      await tx.systemSnapshot.create({ data: { propertyId: property.id } });
    }

    let visit: { id: string } | null = null;
    if (property) {
      visit = await tx.visit.create({
        data: {
          propertyId: property.id,
          customerId: customer.id,
          mode: deriveMode(lead.jobType),
          purpose: lead.notes ?? undefined,
        },
      });
    }

    const updatedLead = await tx.lead.update({
      where: { id: leadId },
      data: {
        status: "converted",
        customerId: customer.id,
        propertyId: property?.id ?? null,
        visitId: visit?.id ?? null,
      },
    });

    return { customer, property, visit, lead: updatedLead };
  });

  res.json(result);
}));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
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
  res.status(500).json({
    error: "Internal server error",
    details: includeDetails ? message : undefined,
  });
});
