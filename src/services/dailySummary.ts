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


/**
 * Operator feedback filed through the app, for the daily digest (P022 / P019 §6).
 *
 * `POST /feedback` writes a `SystemEvent` and returns 201. Nothing read that table. Three items
 * sat unseen for two weeks — including "I click finalize for the customer and nothing happens",
 * which was a real, diagnosable defect. Email is the operator channel by Kyle's 08-11/08-13/08-16
 * rulings, so it rides the digest that already exists rather than growing a new mechanism.
 *
 * RECENT vs BACKLOG. "Recent" is the last 24 h — the digest's own cadence. "Backlog" is
 * everything older, and it repeats every day **because there is no way to mark an item handled**:
 * `SystemEvent` has no resolved flag and adding one is a schema change this task does not carry.
 * That repetition is deliberate and visible rather than quietly dropped, and the email says so —
 * but it is exactly the kind of thing that trains an operator to ignore a section, so a triage
 * mechanism is flagged as the follow-up rather than left implicit.
 */
export interface DigestFeedback {
  recent: Array<{ at: Date; message: string; page: string | null }>;
  backlog: Array<{ at: Date; message: string; page: string | null }>;
}

export async function getFeedbackForDigest(now = new Date()): Promise<DigestFeedback> {
  const cutoff = new Date(now.getTime() - 24 * 3600_000);
  /*
    TWO sources, because the debug sidebar (P032) replaced the feedback widget and Kyle's typed
    words now arrive on a `client` row alongside the console that explains them. Reading only
    `feedback` would have quietly emptied this section the day the sidebar shipped — the same
    silent-drop failure this digest was built to fix.

    A `client` row only counts as feedback when it carries a NOTE. Most of them do not: an error
    that shipped on its own is a diagnostic for me, not a message from Kyle, and putting those in
    his morning email would bury the three lines he actually wrote.
  */
  const rows = await prisma.systemEvent.findMany({
    where: { source: { in: ["feedback", "client"] } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const shape = (r: { createdAt: Date; source: string; message: string; detailsJson: string | null }) => {
    let page: string | null = null;
    let note: string | null = null;
    try {
      // Only the page and the note are read out of the details blob. It also holds a user agent
      // and the whole console buffer, and none of that belongs in an email.
      const d = JSON.parse(r.detailsJson ?? "{}") as { page?: string; note?: string };
      page = d.page ?? null;
      note = d.note ?? null;
    } catch {
      page = null;
    }
    return { at: r.createdAt, message: note ?? r.message, page, isFeedback: r.source === "feedback" || Boolean(note) };
  };

  const shaped = rows.map(shape).filter((r) => r.isFeedback);

  return {
    recent: shaped.filter((r) => r.at >= cutoff).map(({ isFeedback: _i, ...rest }) => rest),
    backlog: shaped.filter((r) => r.at < cutoff).map(({ isFeedback: _i, ...rest }) => rest),
  };
}

export async function sendDailySummaryEmail(): Promise<void> {
  const toEmail = process.env.SUMMARY_EMAIL;
  const gmailUser = process.env.GMAIL_USER;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!toEmail || !gmailUser || !clientId || !clientSecret || !refreshToken) {
    console.log("[DailySummary] Missing SUMMARY_EMAIL, GMAIL_USER, or Google OAuth credentials — skipping email.");
    return;
  }

  const data = await getDailySummary();
  const feedback = await getFeedbackForDigest();

  // The old gate skipped the whole email whenever there were no calls — which is most days while
  // the phone agent is deferred. Attaching feedback to a digest that never sends would have been
  // a fix in name only, so the gate now asks whether there is anything worth sending at all.
  const hasFeedback = feedback.recent.length + feedback.backlog.length > 0;
  if (data.totalCalls === 0 && !hasFeedback) {
    console.log("[DailySummary] No calls and no feedback today — skipping email.");
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      type: "OAuth2",
      user: gmailUser,
      clientId,
      clientSecret,
      refreshToken,
    },
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

  /** Feedback rows, rendered in the same visual language as the call sections. */
  const feedbackSection = (
    title: string,
    items: DigestFeedback["recent"],
    color: string,
    note: string | null,
  ) => {
    if (items.length === 0) return "";
    const esc = (t: string) =>
      t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `
      <h2 style="color:${color};font-size:16px;margin:24px 0 8px;border-bottom:2px solid ${color};padding-bottom:4px;">${title} (${items.length})</h2>
      ${note ? `<p style="margin:0 0 8px;font-size:12px;color:#777;">${note}</p>` : ""}
      ${items
        .map(
          (f) => `
        <div style="border-left:3px solid ${color};padding:8px 12px;margin-bottom:8px;background:#fafafa;">
          <div style="font-size:13px;">${esc(f.message)}</div>
          <div style="font-size:11px;color:#777;margin-top:4px;">
            ${f.at.toLocaleString("en-US", { timeZone: "America/Chicago" })}${f.page ? ` · ${esc(f.page)}` : ""}
          </div>
        </div>`,
        )
        .join("")}`;
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

        ${feedbackSection("FEEDBACK FILED IN THE APP", feedback.recent, "#00695c", null)}
        ${feedbackSection(
          "OLDER FEEDBACK — STILL OPEN",
          feedback.backlog,
          "#8d6e63",
          "Repeats daily: there is no way to mark an item handled yet.",
        )}

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
