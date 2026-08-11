/**
 * Live-alert smoke test. Uses the Railway env, so it hits the real Twilio path
 * and lands on the number in OPERATOR_ALERT_NUMBER (falls back to KYLE_PHONE).
 *
 * Run from app/:
 *     railway run npx tsx scripts/sendTestAlert.ts
 *
 * Verify:
 *   1. Twilio returns a SID + initial status (queued/accepted).
 *   2. Kyle's phone receives the SMS.
 *   3. A follow-up SystemEvent lands via the status callback with "delivered".
 */

import { sendAlert, _resetDedupForTests } from "../src/services/alerting";

async function main(): Promise<void> {
  // The dedup window would swallow a rerun within 15 minutes — clear it so
  // repeated smoke tests actually send.
  _resetDedupForTests();

  const result = await sendAlert({
    severity: "warning",
    eventType: "smoke-test",
    service: process.env.RAILWAY_SERVICE_NAME ?? "RCEestimator",
    reason: "operator alerting smoke test — ignore if seen on phone",
    dedupeKey: `smoke-test-${Date.now()}`,
  });

  console.log(JSON.stringify(result, null, 2));
  if (!result.delivered) process.exit(1);
}

main().catch((err) => {
  console.error("smoke test failed:", err);
  process.exit(1);
});
