-- SMS consent, recorded and enforced.
--
-- The website's contact form has always sent `smsConsent` with the lead, and
-- the backend silently dropped it. That gap is exactly what A2P registration
-- attests does not happen: once the campaign is approved, every customer send
-- path would have texted people who explicitly declined.
--
-- Tri-state by design: TRUE = opted in (web checkbox), FALSE = explicitly
-- declined or texted STOP, NULL = never asked (phone/email/manual leads).
-- The website checkbox is the only opt-in channel there is -- there is no
-- verbal consent flow anywhere in the call system -- so NULL does NOT clear
-- the send gate either; only TRUE does. Enforcement lives in one place,
-- services/twilio.ts sendSms(), so every customer-facing path is covered
-- without per-call-site checks.
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "smsConsent" BOOLEAN;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "smsConsent" BOOLEAN;

-- Both columns are expressible in Prisma's schema language, so `prisma db push`
-- creates them for tests and tests/globalSetup.ts needs no companion edit.
