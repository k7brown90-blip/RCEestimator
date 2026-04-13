import { app } from "./app";
import { ensureAssemblyCatalogReady } from "./bootstrap/ensureAssemblyCatalog";
import cron from "node-cron";
import { sendDailySummaryEmail } from "./services/dailySummary";

const port = Number(process.env.PORT ?? 4000);

async function startServer(): Promise<void> {
  await ensureAssemblyCatalogReady();

  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Red Cedar Estimating API listening on ${port}`);
  });

  // 6:00 PM Central Mon-Fri (cron runs in UTC; CT is UTC-5 in CDT / UTC-6 in CST)
  // Use a helper: schedule at both 23:00 and 00:00 UTC to cover CST/CDT, the job itself is idempotent
  // Simpler: node-cron supports timezone via options
  cron.schedule("0 18 * * 1-5", async () => {
    console.log("[Cron] Running daily summary email...");
    try {
      await sendDailySummaryEmail();
    } catch (err) {
      console.error("[Cron] Daily summary email failed:", err);
    }
  }, { timezone: "America/Chicago" });

  console.log("[Cron] Daily summary email scheduled for 6:00 PM CT Mon-Fri");
}

startServer().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start Red Cedar Estimating API", error);
  process.exit(1);
});
