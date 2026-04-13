import { prisma } from "../lib/prisma";
import nodemailer from "nodemailer";

const TZ = "America/Chicago";

interface LeadSummary {
  name: string;
  phone: string | null;
  callType: string | null;
  jobType: string | null;
  address: string | null;
  warrantyCall: boolean;
  urgentFlag: boolean;
  notes: string | null;
  createdAt: string;
}

interface DailySummaryResponse {
  date: string;
  totalCalls: number;
  booked: number;
  warrantyFlags: number;
  callbacksNeeded: number;
  summary: Record<string, LeadSummary[]>;
  leads: LeadSummary[];
}

function formatTimeCentral(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDateCentral(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** Get midnight CT today as a UTC Date */
function getMidnightCentralToday(): Date {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (t: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === t)!.value);

  const year = get("year");
  const month = get("month");
  const day = get("day");

  // Guess CST (UTC-6), then self-correct
  const guess = new Date(Date.UTC(year, month - 1, day, 6, 0));
  const actualParts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(guess);
  const actualHour = Number(actualParts.find((p) => p.type === "hour")!.value);
  return new Date(guess.getTime() - actualHour * 3_600_000);
}

export async function getDailySummary(): Promise<DailySummaryResponse> {
  const midnightCt = getMidnightCentralToday();
  const now = new Date();

  const leads = await prisma.lead.findMany({
    where: { createdAt: { gte: midnightCt, lte: now } },
    orderBy: { createdAt: "asc" },
  });

  const mapped: LeadSummary[] = leads.map((l) => ({
    name: l.name,
    phone: l.phone,
    callType: l.callType,
    jobType: l.jobType,
    address: l.address,
    warrantyCall: l.warrantyCall,
    urgentFlag: l.urgentFlag,
    notes: l.notes,
    createdAt: `${formatTimeCentral(l.createdAt)} Central`,
  }));

  const summary: Record<string, LeadSummary[]> = {};
  const callTypes = ["new_job", "warranty", "callback", "reschedule", "cancellation", "estimate_followup", "other"];
  for (const ct of callTypes) summary[ct] = [];

  for (const lead of mapped) {
    const key = lead.callType && callTypes.includes(lead.callType) ? lead.callType : "other";
    summary[key].push(lead);
  }

  // Remove empty categories
  for (const key of Object.keys(summary)) {
    if (summary[key].length === 0) delete summary[key];
  }

  return {
    date: formatDateCentral(now),
    totalCalls: mapped.length,
    booked: summary["new_job"]?.length ?? 0,
    warrantyFlags: mapped.filter((l) => l.warrantyCall).length,
    callbacksNeeded: summary["callback"]?.length ?? 0,
    summary,
    leads: mapped,
  };
}

export async function sendDailySummaryEmail(): Promise<void> {
  const toEmail = process.env.SUMMARY_EMAIL;
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!toEmail || !gmailUser || !gmailPass) {
    console.log("[DailySummary] Missing SUMMARY_EMAIL, GMAIL_USER, or GMAIL_APP_PASSWORD — skipping email.");
    return;
  }

  const data = await getDailySummary();
  if (data.totalCalls === 0) {
    console.log("[DailySummary] No calls today — skipping email.");
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailPass },
  });

  const renderLead = (l: LeadSummary) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;">${l.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;">${l.phone ?? "—"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;">${l.jobType ?? "—"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;">${l.notes ?? "—"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;">${l.createdAt}</td>
    </tr>`;

  const section = (title: string, leads: LeadSummary[], color: string) => {
    if (leads.length === 0) return "";
    return `
      <h2 style="color:${color};font-size:16px;margin:24px 0 8px;border-bottom:2px solid ${color};padding-bottom:4px;">${title} (${leads.length})</h2>
      <table style="width:100%;border-collapse:collapse;">
        <tr style="background:#f5f5f5;">
          <th style="padding:8px 12px;text-align:left;font-size:13px;">Name</th>
          <th style="padding:8px 12px;text-align:left;font-size:13px;">Phone</th>
          <th style="padding:8px 12px;text-align:left;font-size:13px;">Job</th>
          <th style="padding:8px 12px;text-align:left;font-size:13px;">Notes</th>
          <th style="padding:8px 12px;text-align:left;font-size:13px;">Time</th>
        </tr>
        ${leads.map(renderLead).join("")}
      </table>`;
  };

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;color:#333;">
      <div style="background:#1a5c2e;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:20px;">Red Cedar Electric — Daily Summary</h1>
        <p style="margin:4px 0 0;font-size:14px;opacity:0.9;">${data.date} · ${data.totalCalls} call${data.totalCalls === 1 ? "" : "s"}</p>
      </div>
      <div style="padding:16px 24px;background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
        <div style="display:flex;gap:16px;margin-bottom:16px;">
          <div style="background:#e8f5e9;padding:12px 16px;border-radius:6px;flex:1;text-align:center;">
            <div style="font-size:24px;font-weight:700;color:#1a5c2e;">${data.booked}</div>
            <div style="font-size:12px;color:#555;">Booked</div>
          </div>
          <div style="background:${data.warrantyFlags > 0 ? "#fff3e0" : "#f5f5f5"};padding:12px 16px;border-radius:6px;flex:1;text-align:center;">
            <div style="font-size:24px;font-weight:700;color:${data.warrantyFlags > 0 ? "#e65100" : "#555"};">${data.warrantyFlags}</div>
            <div style="font-size:12px;color:#555;">Warranty</div>
          </div>
          <div style="background:${data.callbacksNeeded > 0 ? "#e3f2fd" : "#f5f5f5"};padding:12px 16px;border-radius:6px;flex:1;text-align:center;">
            <div style="font-size:24px;font-weight:700;color:${data.callbacksNeeded > 0 ? "#1565c0" : "#555"};">${data.callbacksNeeded}</div>
            <div style="font-size:12px;color:#555;">Callbacks</div>
          </div>
        </div>

        ${section("BOOKED TODAY", data.summary["new_job"] ?? [], "#1a5c2e")}
        ${section("WARRANTY FLAGS", data.summary["warranty"] ?? [], "#e65100")}
        ${section("CALLBACKS NEEDED", data.summary["callback"] ?? [], "#1565c0")}
        ${section("RESCHEDULES", data.summary["reschedule"] ?? [], "#6a1b9a")}
        ${section("CANCELLATIONS", data.summary["cancellation"] ?? [], "#c62828")}
        ${section("ESTIMATE FOLLOWUPS", data.summary["estimate_followup"] ?? [], "#00695c")}
        ${section("OTHER CALLS", data.summary["other"] ?? [], "#555")}

        <div style="margin-top:24px;padding:12px 16px;background:#f5f5f5;border-radius:6px;font-size:13px;color:#666;">
          <p style="margin:0 0 4px;">Review Gmail drafts for pending customer replies.</p>
          <p style="margin:0;">Full details: <a href="https://rceestimator-production.up.railway.app/leads" style="color:#1a5c2e;">rceestimator-production.up.railway.app/leads</a></p>
        </div>
      </div>
    </div>`;

  await transporter.sendMail({
    from: `"Red Cedar Electric" <${gmailUser}>`,
    to: toEmail,
    subject: `RCE Daily Summary — ${data.date}`,
    html,
  });

  console.log(`[DailySummary] Email sent to ${toEmail}`);
}
