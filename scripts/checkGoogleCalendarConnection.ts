/**
 * Diagnoses why the AI agent (Savannah) can't reach Google Calendar.
 *
 * Runs the exact same OAuth2 + Calendar API call the app uses
 * (services/googleCalendar.ts getCalendarClient()), but standalone and with
 * verbose, human-readable output — so the real failure reason (missing env
 * vars, expired/revoked refresh token, missing scope, wrong calendar ID) is
 * visible immediately instead of buried in a generic 500 in Railway logs.
 *
 * Usage:
 *   Against production env vars (recommended — this is where the real
 *   problem lives): `railway run npx tsx scripts/checkGoogleCalendarConnection.ts`
 *   Locally, if you have a .env with the same vars: `npx tsx scripts/checkGoogleCalendarConnection.ts`
 */

import { google } from "googleapis";

function section(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

async function main() {
  section("Environment variables");

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const extraCalendarIds = (process.env.EXTRA_CALENDAR_IDS ?? "").split(",").filter(Boolean);

  const mask = (v: string | undefined) => (v ? `${v.slice(0, 6)}...${v.slice(-4)} (${v.length} chars)` : "MISSING");
  console.log(`GOOGLE_CLIENT_ID:     ${mask(clientId)}`);
  console.log(`GOOGLE_CLIENT_SECRET: ${mask(clientSecret)}`);
  console.log(`GOOGLE_REFRESH_TOKEN: ${mask(refreshToken)}`);
  console.log(`EXTRA_CALENDAR_IDS:   ${extraCalendarIds.length > 0 ? extraCalendarIds.join(", ") : "(none)"}`);

  if (!clientId || !clientSecret || !refreshToken) {
    console.log("\n❌ FAIL: one or more required env vars are missing.");
    console.log("   Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN on Railway and redeploy.");
    process.exit(1);
  }

  section("OAuth2 token exchange");
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  try {
    const { credentials } = await auth.refreshAccessToken();
    console.log("✅ Refresh token exchanged for an access token successfully.");
    console.log(`   Scopes granted: ${credentials.scope ?? "(not reported by Google)"}`);
    if (credentials.scope && !credentials.scope.includes("calendar")) {
      console.log("⚠️  WARNING: granted scopes do not appear to include Calendar access.");
      console.log("   Re-authorize with scope https://www.googleapis.com/auth/calendar");
    }
  } catch (err: unknown) {
    const e = err as { message?: string; response?: { data?: unknown } };
    console.log("\n❌ FAIL: could not exchange the refresh token for an access token.");
    console.log(`   Error: ${e.message ?? String(err)}`);
    if (e.response?.data) console.log(`   Details: ${JSON.stringify(e.response.data)}`);
    console.log("\n   Most common causes, in order of likelihood:");
    console.log("   1. invalid_grant — the refresh token was revoked or expired. This happens");
    console.log("      automatically after 7 days if the Google Cloud OAuth consent screen is");
    console.log("      still in \"Testing\" publishing status (not \"In production\"). Check");
    console.log("      Google Cloud Console → APIs & Services → OAuth consent screen.");
    console.log("   2. invalid_client — GOOGLE_CLIENT_ID/SECRET don't match the OAuth client");
    console.log("      that issued this refresh token (e.g. project or client was recreated).");
    console.log("   3. The refresh token was manually revoked at");
    console.log("      https://myaccount.google.com/permissions");
    process.exit(1);
  }

  section("Calendar API — freebusy query (same call as availability checks)");
  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const weekOut = new Date(now.getTime() + 7 * 86_400_000);

  try {
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: weekOut.toISOString(),
        timeZone: "America/Chicago",
        items: [{ id: "primary" }, ...extraCalendarIds.map((id) => ({ id: id.trim() }))],
      },
    });
    const calendars = response.data.calendars ?? {};
    for (const [id, data] of Object.entries(calendars)) {
      const errors = (data as { errors?: Array<{ reason?: string }> }).errors;
      if (errors && errors.length > 0) {
        console.log(`❌ Calendar "${id}" returned an error: ${errors.map((e) => e.reason).join(", ")}`);
        if (errors.some((e) => e.reason === "notFound")) {
          console.log(`   The calendar ID "${id}" doesn't exist or isn't shared with this account.`);
        }
      } else {
        const busyCount = ((data as { busy?: unknown[] }).busy ?? []).length;
        console.log(`✅ Calendar "${id}" reachable — ${busyCount} busy period(s) in the next 7 days.`);
      }
    }
  } catch (err: unknown) {
    const e = err as { message?: string; code?: number; response?: { data?: unknown } };
    console.log("\n❌ FAIL: the Calendar API call itself failed (auth succeeded, so this is a");
    console.log("   different problem — permissions, API not enabled, or a bad calendar ID).");
    console.log(`   Error: ${e.message ?? String(err)}`);
    if (e.response?.data) console.log(`   Details: ${JSON.stringify(e.response.data)}`);
    process.exit(1);
  }

  console.log("\n✅ Google Calendar connection is healthy end to end.");
  console.log("   If Savannah still can't book, the problem is elsewhere (Vapi tool config,");
  console.log("   webhook_secret/Bearer auth on the endpoint, or the endpoint URL itself) —");
  console.log("   not Google Calendar.");
}

main().catch((err) => {
  console.error("Unexpected error running diagnostic:", err);
  process.exit(1);
});
