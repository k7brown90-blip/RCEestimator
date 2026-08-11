/**
 * One-time helper: mint a new Google OAuth refresh token and store it on
 * Railway — without ever printing a secret.
 *
 * Needed when the OAuth client that issued the old refresh token has been
 * deleted (refresh tokens die with their client).
 *
 * Before running, in Google Cloud Console → APIs & Services → Credentials →
 * your OAuth client ("AI Scheduling Agent") → Authorized redirect URIs, add:
 *
 *     http://localhost:53682/callback
 *
 * Then run (from app/, with the Railway CLI linked to the service):
 *     npx tsx scripts/mintGoogleRefreshToken.ts
 *
 * You'll be prompted for the client ID (echoed — it's public) and the client
 * secret (input hidden). A browser opens for consent — sign in as the
 * calendar/Gmail account (service@redcedarelectricllc.com) and approve. The script then
 * pushes GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN
 * straight to Railway via `railway variables --set`. Nothing sensitive is
 * written to the terminal, so the run can be supervised by anyone.
 *
 * Scopes requested:
 *   - https://www.googleapis.com/auth/calendar  (availability, booking, events)
 *   - https://mail.google.com/                  (Gmail SMTP XOAUTH2 — daily
 *     summary, confirmations, supplier emails)
 *
 * Verify afterwards with:
 *     railway run npx tsx scripts/checkGoogleCalendarConnection.ts
 */

import http from "node:http";
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import { google } from "googleapis";

const execFileAsync = promisify(execFile);

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://mail.google.com/",
];

/** Prompt without echoing the typed characters (for secrets). */
async function questionHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const muted = new Writable({ write: (_c, _e, cb) => cb() });
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  const answer = await rl.question("");
  rl.close();
  process.stdout.write("\n");
  return answer;
}

async function setRailwayVariables(vars: Record<string, string>): Promise<void> {
  const args = ["variables", ...Object.entries(vars).flatMap(([k, v]) => ["--set", `${k}=${v}`]), "--skip-deploys"];
  await execFileAsync("railway", args, { shell: process.platform === "win32" });
  // One redeploy at the end rather than three (one per variable).
  await execFileAsync("railway", ["redeploy", "--yes"], { shell: process.platform === "win32" });
}

async function main() {
  // When run via `railway run`, the (already-updated) client credentials come
  // from the Railway environment and nothing needs to be typed at all.
  let clientId = (process.env.GOOGLE_CLIENT_ID ?? "").trim();
  let clientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? "").trim();

  if (clientId && clientSecret) {
    console.log(`Using GOOGLE_CLIENT_ID (${clientId.slice(0, 12)}...) and GOOGLE_CLIENT_SECRET from the environment.`);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    clientId = (await rl.question("Client ID (from the AI Scheduling Agent credentials page): ")).trim();
    rl.close();
    clientSecret = (await questionHidden("Client secret (input hidden): ")).trim();
  }

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
      if (!tokens.refresh_token) {
        res.writeHead(500, { "Content-Type": "text/plain" }).end("No refresh token returned — see terminal.");
        console.error("\n❌ Google returned no refresh token. Remove prior access at");
        console.error("   https://myaccount.google.com/permissions and re-run.");
        server.close();
        process.exitCode = 1;
        return;
      }

      console.log("\n✅ Token minted. Pushing the GOOGLE_* variables and GMAIL_USER to Railway...");
      await setRailwayVariables({
        GOOGLE_CLIENT_ID: clientId,
        GOOGLE_CLIENT_SECRET: clientSecret,
        GOOGLE_REFRESH_TOKEN: tokens.refresh_token,
        // Sender identity must match the account that authorized the token.
        GMAIL_USER: "service@redcedarelectricllc.com",
      });

      res.writeHead(200, { "Content-Type": "text/html" })
        .end("<h2>Done — you can close this tab.</h2><p>Credentials were pushed to Railway.</p>");
      console.log("✅ Railway variables set and service redeploying.");
      console.log("   Verify with: railway run npx tsx scripts/checkGoogleCalendarConnection.ts");
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" }).end("Failed — see terminal.");
      console.error("\n❌ Failed:", e instanceof Error ? e.message : e);
      process.exitCode = 1;
    } finally {
      server.close();
    }
  });

  server.listen(PORT, () => {
    console.log("\nOpening Google consent screen (sign in as service@redcedarelectricllc.com)...");
    console.log("If the browser doesn't open, visit this URL manually:\n");
    console.log(url + "\n");
    // Quoted URL needs no caret-escaping; escaping corrupts the query string.
    exec(`start "" "${url}"`);
  });
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
