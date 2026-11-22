/**
 * Rehearsal (work order agent-team, TC10): an approval on a TEST ACCOUNT never calls real email or SMS.
 *
 * A Customer flagged isTestAccount is the office's own practice account (Kyle booking, rescheduling and
 * cancelling to see what the card does). When something is approved for one, the work still happens (the
 * visit is written, the acceptance is recorded) but nothing leaves the building. That is ONE
 * AsyncLocalStorage context, entered by the code that runs an approval (services/hubSend.ts for a message,
 * and any later card that runs a scheduling action), and read by exactly the two choke points every
 * customer message leaves through:
 *
 *   * sendCustomerEmail  (services/transactionalEmail.ts), which every customer email passes, the record
 *     email behind hubSend's email branch included;
 *   * sendSms            (services/twilio.ts), which every text passes.
 *
 * Because the check is at the choke points, no scheduling function takes a new parameter: scheduleJob,
 * rescheduleJob, cancelJob and visitConfirmations are called exactly as before and their emails and
 * texts are skipped from underneath them. A skip is a SystemEvent (source "rehearsal"), never silent.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { logSystemEvent } from "./systemEvents";

/** What a skipped send answers with, and what the result line is built from. */
export const REHEARSAL_SKIPPED = "skipped (test account)";

/** The words on an approval card for a test account, before and after it is approved. */
export const REHEARSAL_CARD_LINE = "Test account — nothing is emailed or texted";
export const REHEARSAL_RESULT_LINE = "Rehearsal: email and text skipped";

const store = new AsyncLocalStorage<{ account: string | null }>();

/** Run `fn` as a rehearsal: every email and text it (or anything it awaits or starts) tries to send is skipped. */
export function runAsRehearsal<T>(fn: () => Promise<T>, account: string | null = null): Promise<T> {
  return store.run({ account }, fn);
}

/** True while inside runAsRehearsal. */
export function inRehearsal(): boolean {
  return store.getStore() !== undefined;
}

/** Record that a send was skipped for a test account. `what` names the channel and the kind, never an address or a number. */
export function noteRehearsalSkip(channel: "email" | "sms", what: string): typeof REHEARSAL_SKIPPED {
  logSystemEvent("info", "rehearsal", `${channel} skipped (test account): ${what}`, { channel, what, account: store.getStore()?.account ?? null });
  return REHEARSAL_SKIPPED;
}
