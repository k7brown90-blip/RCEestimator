/**
 * Kyle's phone number, on its own so the text guards (services/smsGuards.ts) and the one send function
 * (services/twilio.ts) can both name it without importing each other. twilio.ts re-exports it, so every
 * existing `import { KYLE_PHONE } from "./twilio"` keeps working.
 */

/** Kyle's phone number: the only number that can dispatch via SMS. */
export const KYLE_PHONE = "+19706661626";

/** True when `phone`, in any format, is Kyle's number (compared on the last ten digits). */
export function isKylePhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 && digits.slice(-10) === KYLE_PHONE.slice(-10);
}
