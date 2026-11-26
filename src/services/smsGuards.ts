/**
 * Two small questions every outbound customer text asks before it goes (work order agent-team, BA7,
 * addendum items 3 and 5). They live here, not inside the hub's send function, because the legacy
 * senders reach the same questions through sendSms (U9): one
 * place knows who an "internal" text may go to and what "this number may not be texted" means.
 */
import { prisma } from "../lib/prisma";
import { KYLE_PHONE } from "./kylePhone";
import { last10 } from "./hub";

/**
 * Who an "internal" text may go to (ruling A): Kyle's number, the operator alert number, or an active
 * technician's number. Anyone else - a customer - is refused as internal, because internal texts skip the
 * STOP check and the footer.
 */
export async function isInternalSmsNumber(phone: string): Promise<boolean> {
  const digits = last10(phone);
  if (!digits) return false;
  const fixed = [KYLE_PHONE, process.env.OPERATOR_ALERT_NUMBER].map((n) => last10(n));
  if (fixed.includes(digits)) return true;
  const techs = await prisma.technician.findMany({ where: { isActive: true, phone: { not: null } }, select: { phone: true } });
  return techs.some((t) => last10(t.phone) === digits);
}

/**
 * The ONE answer to "has this number opted out of texts" (addendum item 5: any opt-out blocks ALL
 * texts). A reason code (a key of shared/hub/sendBlocks.ts) when the number may not be texted, null when
 * it may. A STUB until P2B-1 (step 6) adds SmsSuppression and reads it here: until then nothing is
 * recorded anywhere, so nothing is blocked. Callers must treat any non-null answer as a refusal and must
 * not look at a suppression table themselves.
 */
export async function smsBlockReason(_phone: string): Promise<string | null> {
  return null;
}
