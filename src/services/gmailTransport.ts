/**
 * The Gmail SMTP transport (nodemailer, XOAUTH2) — one construction, shared.
 *
 * Kyle, 2026-09-09: "I need the emails working, very few are actually getting through, this is
 * priority number one." Customer email now goes Resend-first (services/transactionalEmail.ts)
 * and Gmail is the automatic FALLBACK, so the transporter had to live somewhere both the
 * fallback and the Kyle-only senders (daily digest, owner notifications) can reach without a
 * circular import. This is that somewhere. Nothing about the transport itself changed.
 */

import nodemailer from "nodemailer";
import { logSystemEvent } from "./systemEvents";

export const GMAIL_ENV_VARS = ["GMAIL_USER", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"] as const;

export function gmailTransportConfigured(): boolean {
  return GMAIL_ENV_VARS.every((k) => Boolean(process.env[k]));
}

/** Names of the absent variables — never their values. */
export function missingGmailEnvVars(): string[] {
  return GMAIL_ENV_VARS.filter((k) => !process.env[k]);
}

export function getGmailTransporter() {
  const gmailUser = process.env.GMAIL_USER;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!gmailUser || !clientId || !clientSecret || !refreshToken) {
    return null;
  }

  return {
    transporter: nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2" as const,
        user: gmailUser,
        clientId,
        clientSecret,
        refreshToken,
      },
    }),
    from: `"Red Cedar Electric" <${gmailUser}>`,
  };
}

/**
 * Write the TRANSPORT error down, not just the fact of failure.
 *
 * Kyle, 2026-08-18: *"I connot email it either."* Production held exactly two rows about it —
 * `Estimate 2026-1013 send FAILED to …` and the same for 2026-1011 — with `estimateId` and
 * `sentBy` and nothing else. The nodemailer error was caught, printed to a console nobody
 * was watching, and dropped, so the log could say a send failed but never why. Diagnosing it
 * meant reproducing it, which meant sending a real customer another email.
 *
 * The distinction that matters is between a REVOKED CREDENTIAL and a rejected message, and it is
 * carried in fields nodemailer already provides:
 *
 *   `invalid_grant`  the Google refresh token is expired or revoked — re-mint it with
 *                    scripts/mintGoogleRefreshToken.ts. Nothing about the message is wrong.
 *   `EAUTH` / 535    the OAuth client is wrong or the account lost access.
 *   `EENVELOPE`      the recipient address was rejected. That one IS about the message.
 *
 * The recipient is recorded because "did it fail for everyone or for this address" is the first
 * question; the message body never is.
 */
export function describeGmailFailure(err: unknown): { message: string; code?: string; responseCode?: number; response?: string; likelyCause: string | null } {
  const e = err as { message?: string; code?: string; responseCode?: number; response?: string };
  const raw = `${e?.code ?? ""} ${e?.message ?? String(err)}`;
  const likelyCause = /invalid_grant/i.test(raw)
    ? "Google refresh token expired or revoked — re-mint GOOGLE_REFRESH_TOKEN (scripts/mintGoogleRefreshToken.ts)."
    : e?.code === "EAUTH" || e?.responseCode === 535
      ? "Gmail rejected the credentials (EAUTH) — the OAuth client or the account changed."
      : e?.code === "EENVELOPE"
        ? "Gmail rejected the recipient address."
        : null;
  return {
    message: e?.message ?? String(err),
    code: e?.code,
    responseCode: e?.responseCode,
    // The SMTP response often names the reason verbatim; it is capped because it can be long.
    response: typeof e?.response === "string" ? e.response.slice(0, 1000) : undefined,
    likelyCause,
  };
}

export function logGmailFailure(to: string, subject: string, err: unknown): void {
  const d = describeGmailFailure(err);
  logSystemEvent("error", "email", `Send failed to ${to}: ${d.message}`, {
    subject,
    code: d.code,
    responseCode: d.responseCode,
    response: d.response,
    likelyCause: d.likelyCause,
  });
}
