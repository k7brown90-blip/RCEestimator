import { app } from "./app";
import cron from "node-cron";
import { sendDailySummaryEmail } from "./services/dailySummary";
import { getNextDaySchedule } from "./services/schedule";
import { sendSms, KYLE_PHONE } from "./services/twilio";
import { sendPendingSupplierEmails } from "./services/supplierEmail";
import { generateInspectionRenewalLeads, generateUpgradeFollowUpLeads } from "./services/inspectionRetention";
import { sendVisitReminders } from "./services/visitConfirmations";
import { sendAlert } from "./services/alerting";
import {
  customerSendsEnabled,
  logAutomationGateState,
  logCustomerSendSkipped,
} from "./services/automationGate";

const port = Number(process.env.PORT ?? 4000);

// Fail fast on missing security-critical configuration in production.
// Without PIN_HASH the entire CRM is public; without WEBHOOK_SECRET the lead
// and scheduling webhooks reject everything; the default JWT secret is public;
// without AGENT_API_TOKEN the voice-agent scheduling tools reject everything.
if (process.env.NODE_ENV === "production") {
  const required = ["PIN_HASH", "JWT_SECRET", "WEBHOOK_SECRET", "AGENT_API_TOKEN"] as const;
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Refusing to start in production without: ${missing.join(", ")}`);
  }
  if (!process.env.RAILWAY_PUBLIC_DOMAIN) {
    // eslint-disable-next-line no-console
    console.warn(
      "[startup] RAILWAY_PUBLIC_DOMAIN is not set — the OpenAI agent MCP URL will fall back to localhost and be unreachable.",
    );
  }
}

async function startServer(): Promise<void> {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Red Cedar Estimating API listening on ${port}`);
  });

  // 6:00 PM Central Mon-Fri — daily automation suite
  cron.schedule("0 18 * * 1-5", async () => {
    // 1. Daily summary email (existing)
    console.log("[Cron] Running daily summary email...");
    try {
      await sendDailySummaryEmail();
    } catch (err) {
      console.error("[Cron] Daily summary email failed:", err);
    }

    // 2. Kyle's SMS digest — tomorrow's schedule
    console.log("[Cron] Sending Kyle tomorrow's schedule via SMS...");
    try {
      const tomorrow = await getNextDaySchedule();
      if (tomorrow.events.length === 0) {
        await sendSms(KYLE_PHONE, `Tomorrow — No jobs scheduled.\n\nRed Cedar Electric`);
      } else {
        const lines = tomorrow.events.map((e) => {
          const loc = e.location ? ` — ${e.location}` : "";
          return `${e.startLocal}–${e.endLocal}: ${e.summary}${loc}`;
        });
        const msg = `Tomorrow — Red Cedar Schedule:\n${lines.join("\n")}\n\n${tomorrow.events.length} job${tomorrow.events.length === 1 ? "" : "s"} total`;
        await sendSms(KYLE_PHONE, msg);
      }
    } catch (err) {
      console.error("[Cron] Kyle SMS digest failed:", err);
    }

    // 3. Supplier material order emails
    console.log("[Cron] Sending pending supplier emails...");
    try {
      const sent = await sendPendingSupplierEmails();
      if (sent > 0) console.log(`[Cron] Sent ${sent} supplier order(s).`);
    } catch (err) {
      console.error("[Cron] Supplier emails failed:", err);
    }

    // 4. Annual-inspection retention sweep — renewal leads ~11 months after
    // each property's most recent health inspection (idempotent).
    console.log("[Cron] Running inspection retention sweep...");
    try {
      const result = await generateInspectionRenewalLeads();
      if (result.created > 0) {
        console.log(`[Cron] Created ${result.created} inspection renewal lead(s).`);
        await sendSms(KYLE_PHONE, `Retention: ${result.created} annual inspection renewal lead(s) created — check the follow-up queue.\n\nRed Cedar Electric`).catch((err) => console.error("[Cron] Retention SMS failed:", err));
      }
    } catch (err) {
      console.error("[Cron] Inspection retention sweep failed:", err);
    }

    // 5. Upgrade-track follow-up — equipment documented as MONITOR that is
    // approaching its published end of service life. This is the "call back for
    // other work" loop: a planned replacement, six months ahead of the failure.
    console.log("[Cron] Running equipment end-of-life sweep...");
    try {
      const result = await generateUpgradeFollowUpLeads();
      if (result.created > 0) {
        console.log(`[Cron] Created ${result.created} planned-replacement lead(s).`);
        await sendSms(KYLE_PHONE, `Upgrade track: ${result.created} planned replacement lead(s) created from documented end-of-life equipment.\n\nRed Cedar Electric`).catch((err) => console.error("[Cron] EOL SMS failed:", err));
      }
    } catch (err) {
      console.error("[Cron] Equipment end-of-life sweep failed:", err);
    }
  }, { timezone: "America/Chicago" });

  console.log("[Cron] Daily automation suite scheduled for 6:00 PM CT Mon-Fri");

  // 8:00 AM Central daily — 24-hour appointment reminders (email + SMS).
  // The 18–30h window inside sendVisitReminders catches next-day visits.
  //
  // The cron stays REGISTERED while the sends are gated, deliberately. An unregistered job
  // is indistinguishable in the logs from a job that crashed on boot; a registered job that
  // logs its own suppression every morning proves the gate is working and that the schedule
  // survives re-enabling. "Disabled" has to be visible, not absent.
  cron.schedule("0 8 * * *", async () => {
    if (!customerSendsEnabled("visitReminders")) {
      logCustomerSendSkipped("visitReminders", "Sweep did not run; zero customers contacted.");
      return;
    }
    console.log("[Cron] Running visit reminder sweep...");
    try {
      const sent = await sendVisitReminders();
      if (sent > 0) console.log(`[Cron] Sent ${sent} appointment reminder(s).`);
    } catch (err) {
      console.error("[Cron] Visit reminders failed:", err);
    }
  }, { timezone: "America/Chicago" });

  console.log(
    `[Cron] Appointment reminder sweep scheduled for 8:00 AM CT daily — sends ${
      customerSendsEnabled("visitReminders") ? "ENABLED" : "DISABLED (registered, will skip)"
    }`,
  );

  logAutomationGateState();
}

// Best-effort fatal handler: get a shout out the door before the process dies.
// Railway's platform webhook is the primary crash channel; this is the fallback
// for the case where the process is dying too fast for Railway to notice or
// Railway's webhook is not yet configured. Hard 5-second deadline so a stuck
// SMS call cannot hold the exit forever.
function fatalHandler(kind: "uncaughtException" | "unhandledRejection", err: unknown): void {
  const summary = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // eslint-disable-next-line no-console
  console.error(`[fatal:${kind}]`, err);
  const deadline = setTimeout(() => process.exit(1), 5000);
  deadline.unref();
  sendAlert({
    severity: "critical",
    eventType: `process.${kind}`,
    service: process.env.RAILWAY_SERVICE_NAME ?? "RCEestimator",
    reason: summary.slice(0, 240),
    dedupeKey: `process.${kind}`,
  })
    .catch(() => undefined)
    .finally(() => process.exit(1));
}
process.on("uncaughtException", (err) => fatalHandler("uncaughtException", err));
process.on("unhandledRejection", (reason) => fatalHandler("unhandledRejection", reason));

startServer().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start Red Cedar Estimating API", error);
  process.exit(1);
});
