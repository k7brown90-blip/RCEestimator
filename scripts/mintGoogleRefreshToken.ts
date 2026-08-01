/**
 * One-time helper: mint a new Google OAuth refresh token.
 *
 * Needed when the OAuth client that issued the old refresh token has been
 * deleted (refresh tokens die with their client). Run this LOCALLY in your own
 * terminal — the refresh token it prints is a live credential; don't paste it
 * into chats or commit it anywhere. It goes into Railway env vars only.
 *
 * Before running, in Google Cloud Console → APIs & Services → Credentials →
 * your OAuth client ("AI Scheduling Agent") → Authorized redirect URIs, add:
 *
 *     http://localhost:53682/callback
 *
 * Then run:
 *     npx tsx scripts/mintGoogleRefreshToken.ts
 *
 * It will prompt for the client ID and client secret (from that same
 * Credentials page), open the Google consent screen, and print the refresh
 * token when you approve. Sign in as the calendar/Gmail account
 * (k7brown90@gmail.com).
 *
 * Scopes requested:
 *   - https://www.googleapis.com/auth/calendar  (availability, booking, events)
 *   - https://mail.google.com/                  (Gmail SMTP XOAUTH2 — daily
 *     summary, confirmations, supplier emails)
 *
 * Afterwards, update Railway → RCEestimator → Variables:
 *   GOOGLE_CLIENT_ID     = the client ID you entered
 *   GOOGLE_CLIENT_SECRET = the client secret you entered
 *   GOOGLE_REFRESH_TOKEN = the token this script prints
 * Then verify with: railway run npx tsx scripts/checkGoogleCalendarConnection.ts
 */

import http from "node:http";
import readline from "node:readline/promises";
import { exec } from "node:child_process";
import { google } from "googleapis";

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://mail.google.com/",
];

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const clientId = (process.env.GOOGLE_CLIENT_ID ?? (await rl.question("Client ID: "))).trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? (await rl.question("Client secret: "))).trim();
  rl.close();

  if (!clientId || !clientSecret) {
    console.error("Both client ID and client secret are required.");
    process.exit(1);
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  const url = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force a NEW refresh token even if previously authorized
    scope: SCOPES,
  });

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", REDIRECT_URI);
    if (reqUrl.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const code = reqUrl.searchParams.get("code");
    const err = reqUrl.searchParams.get("error");
    if (err || !code) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end(`Authorization failed: ${err ?? "no code"}`);
      console.error(`\n❌ Authorization failed: ${err ?? "no code returned"}`);
      server.close();
      process.exit(1);
    }

    try {
      const { tokens } = await auth.getToken(code);
      res.writeHead(200, { "Content-Type": "text/html" })
        .end("<h2>Done — you can close this tab.</h2><p>The refresh token was printed in your terminal.</p>");
      console.log("\n✅ Success. Set these on Railway (Variables tab):\n");
      console.log(`GOOGLE_CLIENT_ID=${clientId}`);
      console.log("GOOGLE_CLIENT_SECRET=<the secret you entered>");
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token ?? "(none returned — remove prior access at myaccount.google.com/permissions and re-run)"}`);
      console.log("\nThen verify with:");
      console.log("  railway run npx tsx scripts/checkGoogleCalendarConnection.ts");
      if (!tokens.refresh_token) process.exitCode = 1;
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" }).end("Token exchange failed — see terminal.");
      console.error("\n❌ Token exchange failed:", e instanceof Error ? e.message : e);
      process.exitCode = 1;
    } finally {
      server.close();
    }
  });

  server.listen(PORT, () => {
    console.log("\nOpening Google consent screen (sign in as k7brown90@gmail.com)...");
    console.log("If the browser doesn't open, visit this URL manually:\n");
    console.log(url + "\n");
    exec(`start "" "${url.replace(/&/g, "^&")}"`); // Windows default-browser open
  });
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
