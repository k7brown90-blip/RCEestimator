import { app } from "./app";
import cron from "node-cron";
import { sendDailySummaryEmail } from "./services/dailySummary";
import { getNextDaySchedule } from "./services/schedule";
import { sendSms, KYLE_PHONE } from "./services/twilio";
import { sendPendingSupplierEmails } from "./services/supplierEmail";
import { generateInspectionRenewalLeads, generateUpgradeFollowUpLeads } from "./services/inspectionRetention";
import { deleteExpiredObservations } from "./services/materialPriceObservations";
import { runMonthlyPriceRefresh } from "./services/priceBookRefresh";
import { sendVisitReminders } from "./services/visitConfirmations";
import { prisma } from "./lib/prisma";
import { logSystemEvent } from "./services/systemEvents";
import { sendKyleNotificationEmail } from "./services/confirmationEmail";
import { sendAlert } from "./services/alerting";
import { gmailConfigured, pollBounces } from "./services/bounceWatcher";
import { syncCardSpend } from "./services/cardSpend";
import { flagRunaways } from "./services/timeTracking";
import {
  customerSendsEnabled,
  logAutomationGateState,
  logCustomerSendSkipped,
  logTwilioSendSkipped,
  twilioSendEnabled,
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
    //
    // GATED (no-Twilio-texts ruling 2026-08-13). The Google Calendar read still happens and
    // the daily summary email above still goes out; only the text is suppressed.
    if (!twilioSendEnabled("operatorNotifications")) {
      logTwilioSendSkipped("operatorNotifications", "6 PM schedule digest not texted; the daily summary email still sent.");
    } else {
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
        // The leads are created either way — only the heads-up text is gated (2026-08-13).
        // The rows land in the follow-up queue, which is where Kyle works them from anyway.
        console.log(`[Cron] Created ${result.created} inspection renewal lead(s).`);
        if (twilioSendEnabled("operatorNotifications")) {
          await sendSms(KYLE_PHONE, `Retention: ${result.created} annual inspection renewal lead(s) created — check the follow-up queue.\n\nRed Cedar Electric`).catch((err) => console.error("[Cron] Retention SMS failed:", err));
        } else {
          logTwilioSendSkipped("operatorNotifications", `${result.created} renewal lead(s) created and waiting in the follow-up queue.`);
        }
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
        if (twilioSendEnabled("operatorNotifications")) {
          await sendSms(KYLE_PHONE, `Upgrade track: ${result.created} planned replacement lead(s) created from documented end-of-life equipment.\n\nRed Cedar Electric`).catch((err) => console.error("[Cron] EOL SMS failed:", err));
        } else {
          logTwilioSendSkipped("operatorNotifications", `${result.created} planned-replacement lead(s) created and waiting in the follow-up queue.`);
        }
      }
    } catch (err) {
      console.error("[Cron] Equipment end-of-life sweep failed:", err);
    }

    // 6. Unpaid-invoice reminder sweep (Kyle, 2026-09-02) - gentle weekly
    // nudges, three max per invoice; gated like every customer send.
    console.log("[Cron] Running unpaid-invoice reminder sweep...");
    try {
      const { sweepInvoiceReminders } = await import("./services/invoiceReminders");
      const { prisma } = await import("./lib/prisma");
      const r = await sweepInvoiceReminders(prisma);
      if (r.reminded > 0) console.log(`[Cron] Sent ${r.reminded} payment reminder(s).`);
    } catch (err) {
      console.error("[Cron] Invoice reminder sweep failed:", err);
    }

    // 7. Blog auto-draft (Kyle, 2026-09-02): a new published article becomes a
    // DRAFT campaign on the Storm Preparedness list. Never auto-sends.
    console.log("[Cron] Running blog auto-draft check...");
    try {
      const { autoDraftFromNewArticles } = await import("./services/emailCampaigns");
      const { prisma } = await import("./lib/prisma");
      const d = await autoDraftFromNewArticles(prisma);
      if (d.drafted > 0) console.log(`[Cron] Drafted ${d.drafted} campaign(s) from new blog posts.`);
    } catch (err) {
      console.error("[Cron] Blog auto-draft failed:", err);
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

  // 8:30 AM CT daily — housekeeping (2026-09-06 review). Separate schedule on
  // purpose: the 8:00 reminder job returns early when customer sends are
  // gated, and housekeeping must never ride that gate.
  cron.schedule("30 8 * * *", async () => {
    // ── Stale estimate visits self-archive (review: "lifecycle debris") ──
    // An estimate visit whose scheduled date passed 7+ days ago and was never
    // completed archives itself into history — same completedAt + archived
    // shape as the manual complete-consultation door. Unscheduled visits are
    // untouched: those are pipeline, and the rail's archive button owns them.
    try {
      const cutoff = new Date(Date.now() - 7 * 86_400_000);
      const stale = await prisma.visit.findMany({
        where: {
          status: "estimate",
          completedAt: null,
          scheduledStart: { not: null, lt: cutoff },
        },
        select: { id: true, scheduledStart: true, scheduledEnd: true },
      });
      for (const v of stale) {
        await prisma.visit.update({
          where: { id: v.id },
          data: {
            completedAt: v.scheduledEnd ?? v.scheduledStart ?? new Date(),
            nextStep: "archived",
            nextStepAt: new Date(),
          },
        });
      }
      if (stale.length > 0) {
        logSystemEvent("info", "jobs", `Auto-archived ${stale.length} stale estimate visit(s) (scheduled 7+ days ago, never completed)`, {
          visitIds: stale.map((v) => v.id),
        });
      }
    } catch (err) {
      console.error("[Cron] Stale-visit sweep failed:", err);
    }

    // ── Expired estimates get labeled (Kyle, 2026-09-06: estimates are good
    //    for 30 days). The rule and the reasons live in services/estimateExpiry.ts
    //    (moved 2026-09-20 so tests can run it — a LOST estimate is never swept).
    try {
      const { sweepExpiredEstimates } = await import("./services/estimateExpiry");
      await sweepExpiredEstimates(prisma);
    } catch (err) {
      console.error("[Cron] Estimate expiry sweep failed:", err);
    }

    // ── Observed-price retention, hard 90-day delete (2026-09-12 barcode/materials plan Unit
    //    4) — "90 days is enough to keep tabs on items that are high use." No rollup: the PO
    //    lines, receipts and issued estimates a row was derived from already keep that record,
    //    so this is a cache eviction, not data loss.
    try {
      const r = await deleteExpiredObservations(prisma);
      if (r.deleted > 0) console.log(`[Cron] Deleted ${r.deleted} price observation(s) past the 90-day retention window.`);
    } catch (err) {
      console.error("[Cron] Price observation retention sweep failed:", err);
    }

    // ── Quarterly credential drill (review: "single-credential lifelines") ──
    // First morning of each quarter: exercise the Google Calendar token and
    // the Gmail token, and tell Kyle the result. Both fail silently otherwise.
    const now = new Date();
    if (now.getDate() === 1 && now.getMonth() % 3 === 0) {
      let calendarOk = false;
      let calendarErr = "";
      try {
        await getNextDaySchedule();
        calendarOk = true;
      } catch (err) {
        calendarErr = err instanceof Error ? err.message : String(err);
      }
      const emailed = await sendKyleNotificationEmail(
        "Quarterly credential drill",
        [
          `Google Calendar token: ${calendarOk ? "healthy" : `FAILED — ${calendarErr}`}`,
          "Gmail token: healthy (this email is the proof).",
          "",
          calendarOk
            ? "Nothing to do."
            : "Fix: railway ssh \"node dist/scripts/checkGoogleCalendarConnection.js\" for the full diagnosis.",
        ].join("\n"),
      ).then(() => true).catch(() => false);
      logSystemEvent(calendarOk && emailed ? "info" : "error", "ops",
        `Credential drill — calendar ${calendarOk ? "ok" : "FAILED"}, gmail ${emailed ? "ok" : "FAILED"}`,
        { calendarOk, emailed, calendarErr });
    }
  }, { timezone: "America/Chicago" });
  console.log("[Cron] Housekeeping scheduled for 8:30 AM CT daily (stale-visit sweep; price observation retention; credential drill on quarter days).");

  // 9:00 AM CT on the 1st of each month — the observed-price refresh (2026-09-12 barcode/materials
  // plan Unit 5). Kyle: "Automatic as in it will review and give me a monthly proposal that I
  // review." THIS JOB NEVER WRITES A PRICE — runMonthlyPriceRefresh only ingests confirmed
  // receipts into MaterialPriceObservation (the table is not warm on its own) and reads back a
  // proposal; PriceBookAtomic.companyCost is written ONLY when Kyle accepts a line in the CRM
  // (POST /price-book/refresh/accept, which also cascades into any assembly using that item).
  // This cron's entire job is to make sure a proposal is ready and to tell Kyle it's waiting —
  // never to act on it.
  cron.schedule("0 9 1 * *", async () => {
    console.log("[Cron] Running monthly observed-price refresh...");
    try {
      const { ingest, proposal } = await runMonthlyPriceRefresh(prisma);
      const changedLines = proposal.lines.filter((l) => l.changed);
      console.log(
        `[Cron] Price refresh: ingested ${ingest.receiptsIngested} receipt(s) (${ingest.observationsCreated} observation(s)); ` +
          `${proposal.lines.length} item/supplier candidate(s), ${changedLines.length} with a proposed change, ` +
          `${proposal.skippedAssemblyItemIds.length} assembly itemId(s) skipped.`,
      );
      if (changedLines.length > 0) {
        const windowDaysUsed = Math.round((proposal.windowEnd.getTime() - proposal.windowStart.getTime()) / 86_400_000);
        const body = [
          `The monthly price-observation refresh found ${changedLines.length} candidate price change(s) from the last ${windowDaysUsed} days of receipts.`,
          "Nothing has been changed — review and accept each one in the CRM's price book.",
          "",
          ...changedLines.slice(0, 25).map((l) => {
            const assemblyNote = l.affectedAssemblies.length > 0
              ? ` — moves ${l.affectedAssemblies.length} assembly(ies)`
              : "";
            return `${l.itemId} (${l.supplierName}): ${l.currentCompanyCost ?? "no price yet"} -> ${l.candidateUnitCost} ` +
              `[${l.observationCount} obs, ${l.matchMethod}]${assemblyNote}`;
          }),
        ].join("\n");
        await sendKyleNotificationEmail("Monthly price-book proposal ready", body).catch((err) => {
          console.error("[Cron] Price refresh notification email failed:", err);
        });
      }
    } catch (err) {
      console.error("[Cron] Monthly price refresh failed:", err);
    }
  }, { timezone: "America/Chicago" });
  console.log("[Cron] Monthly observed-price refresh scheduled for 9:00 AM CT on the 1st (proposes only — never writes a price).");

  // Every 10 minutes — email bounce watcher (Kyle, 2026-09-09: "My emails are not getting to
  // the clients" / "very few are actually getting through, this is priority number one").
  //
  // INBOUND, so NOT behind automationGate: it reads Gmail's Delivery Status Notifications and
  // files them; it sends nothing. Runs whenever Gmail is configured. pollBounces never throws
  // — auth trouble comes back as {available:false} and is logged once per process. Also runs
  // once 60 s after boot so a deploy does not wait ten minutes to notice a bounce.
  const runBouncePoll = async (trigger: "boot" | "cron") => {
    if (!gmailConfigured()) return;
    try {
      const r = await pollBounces({ sinceDays: 3 });
      if (!r.available) {
        console.warn(`[BounceWatcher:${trigger}] unavailable — ${r.reason}`);
      } else if (r.new > 0 || r.errors > 0) {
        console.log(`[BounceWatcher:${trigger}] scanned ${r.scanned}, new ${r.new}, errors ${r.errors}`);
      }
    } catch (err) {
      console.error(`[BounceWatcher:${trigger}] failed:`, err);
    }
  };
  cron.schedule("*/10 * * * *", () => { void runBouncePoll("cron"); }, { timezone: "America/Chicago" });
  setTimeout(() => { void runBouncePoll("boot"); }, 60_000).unref();
  console.log(`[Cron] Email bounce watcher every 10 minutes — ${gmailConfigured() ? "ENABLED" : "DISABLED (Gmail not configured)"}`);

  // Every 10 minutes — card spend (Kyle, 2026-09-10). The ••••3805 card is issued by the
  // Financial Account, not classic Issuing, and the v2 money-management feed has no webhook on
  // the classic endpoint, so the feed is polled. INBOUND, so not behind automationGate: it reads
  // transactions and files them; a materials swipe may draft a PO after the fact, which is the
  // ruling, not an outbound action. syncCardSpend never throws — a key without scope comes back
  // {available:false} and is logged once. Also runs 90 s after boot.
  const runCardSpendSync = async (trigger: "boot" | "cron") => {
    if (!process.env.STRIPE_SECRET_KEY) return;
    try {
      const r = await syncCardSpend(30);
      if (!r.available) {
        if (trigger === "boot") console.warn(`[CardSpend:${trigger}] unavailable — ${r.reason}`);
      } else if (r.created > 0 || r.voided > 0) {
        console.log(`[CardSpend:${trigger}] seen ${r.seen}, new ${r.created}, refreshed ${r.updated}, voided ${r.voided}`);
      }
    } catch (err) {
      console.error(`[CardSpend:${trigger}] failed:`, err);
    }
  };
  cron.schedule("*/10 * * * *", () => { void runCardSpendSync("cron"); }, { timezone: "America/Chicago" });
  setTimeout(() => { void runCardSpendSync("boot"); }, 90_000).unref();
  console.log(`[Cron] Card spend sync every 10 minutes — ${process.env.STRIPE_SECRET_KEY ? "ENABLED" : "DISABLED (no Stripe key)"}`);

  // Every 30 minutes — runaway clocks (Kyle, 2026-09-11): "a clock still running
  // after 12 hours is FLAGGED, STOPS ACCRUING, and the technician gets a notice
  // on the field app's main screen asking them to confirm the real end time. It
  // cannot count again until someone answers." The sweep only stamps flaggedAt;
  // every hours total already excludes a flagged, unconfirmed entry, so a
  // forgotten punch can never inflate payroll or a job's labor line. Also runs
  // 2 minutes after boot so a deploy does not wait half an hour to notice one.
  const runRunawaySweep = async (trigger: "boot" | "cron") => {
    try {
      const r = await flagRunaways({ hours: 12 });
      if (r.shifts > 0 || r.sessions > 0) {
        console.warn(`[TimeClock:${trigger}] flagged ${r.shifts} shift(s), ${r.sessions} job session(s) past 12 hours`);
      }
    } catch (err) {
      console.error(`[TimeClock:${trigger}] runaway sweep failed:`, err);
    }
  };
  cron.schedule("*/30 * * * *", () => { void runRunawaySweep("cron"); }, { timezone: "America/Chicago" });
  setTimeout(() => { void runRunawaySweep("boot"); }, 120_000).unref();
  console.log("[Cron] Runaway clock sweep every 30 minutes (12-hour cutoff).");

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
