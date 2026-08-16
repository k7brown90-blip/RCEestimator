/**
 * Closes the inbound Twilio surfaces — the number stops listening.
 *
 * P017 rev 2, implementing Kyle's 2026-08-16 ruling. The reasoning, the reversibility promise and
 * the choice of 410 all live in `services/automationGate.ts` class 3; this file is only the
 * plumbing that enforces it.
 *
 * ── WHY THIS RUNS BEFORE THE SESSION GATE ────────────────────────────────────────────────────
 *
 * `/sms/inbound` is on P015's public allowlist **conditionally** — public only while the channel
 * is open. With the channel closed it drops off the allowlist, so the default-deny gate would
 * answer 401. That is safe but it is the wrong answer: 401 tells a caller their credentials were
 * wrong and invites a retry with better ones, when the truth is that the endpoint was withdrawn.
 *
 * Mounting the closure ahead of the gate means the honest status wins while default-deny stays
 * underneath it as the backstop — if this middleware were ever removed or mis-scoped, a closed
 * surface still refuses rather than opening. Two independent reasons for a closed channel to say
 * no, which is the property worth having.
 *
 * Nothing here parses a body, touches the database, or reads a message. A refused hit is refused
 * unread.
 */

import type { NextFunction, Request, Response } from "express";
import type { AuthOutcome, RequestAuthState } from "./accessLog";
import {
  logTwilioInboundClosed,
  twilioInboundEnabled,
  twilioInboundSurfaceFor,
} from "../services/automationGate";

function mark(req: Request, outcome: AuthOutcome): void {
  (req as Request & RequestAuthState)._authOutcome = outcome;
}

export function twilioInboundClosureMiddleware(req: Request, res: Response, next: NextFunction): void {
  const surface = twilioInboundSurfaceFor(req.path);
  if (surface === null || twilioInboundEnabled(surface)) {
    next();
    return;
  }

  mark(req, "channel-disabled");
  logTwilioInboundClosed(surface, `${req.method} ${req.path} refused.`);
  res.status(410).json({
    error: "This channel is closed",
    detail:
      "The Twilio number is not in operation. Red Cedar Electric's automated communications are " +
      "email only; scheduling and intake go through the voice line. Nothing sent here is read.",
  });
}
