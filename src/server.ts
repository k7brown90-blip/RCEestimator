import { app } from "./app";
import cron from "node-cron";
import { sendDailySummaryEmail } from "./services/dailySummary";
import { getNextDaySchedule } from "./services/schedule";
import { sendSms, KYLE_PHONE } from "./services/twilio";
import { sendPendingSupplierEmails } from "./services/supplierEmail";

const port = Number(process.env.PORT ?? 4000);

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
  }, { timezone: "America/Chicago" });

  console.log("[Cron] Daily automation suite scheduled for 6:00 PM CT Mon-Fri");
}

startServer().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start Red Cedar Estimating API", error);
  process.exit(1);
});
