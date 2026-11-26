-- The SMS consent gate is gone (Kyle, 2026-11-26: "REMOVE THE SMS CONSENT GATE COMPLETELY ... Keep STOP handling only").
-- DATA ONLY. No column is added, dropped or altered; the schema is untouched.
--
-- "smsConsent" now has ONE meaning on a Customer or a Lead: false = the person replied STOP. null and true both mean the person may be texted.
-- Until today false also meant "declined the website box" (a web lead who left the box unticked was stored as false), and that is the only
-- thing the old gate ever read it for. Those rows were never a STOP, so they go back to null and become textable.
--
-- A row stays false when it really is a STOP: the latest opt keyword the CRM logged for that phone number is 'opt_out'
-- (InboundMessage.handledAs is 'opt_out' or 'opt_in'; the most recent one decides, so a STOP that was followed by a START is not a STOP).
-- Phones are stored in mixed formats ("+16155550101", "(615) 555-0101", "615-555-0101"), so both sides are reduced to digits and the
-- last 10 are compared. A row with fewer than 10 digits cannot be matched to a STOP and goes to null.
--
-- Only UPDATE ... SET "smsConsent" = NULL WHERE "smsConsent" = false. Nothing is dropped, altered or truncated.

UPDATE "Customer"
SET "smsConsent" = NULL
WHERE "smsConsent" = false
  AND NOT (
    length(regexp_replace(coalesce("phone", ''), '\D', '', 'g')) >= 10
    AND right(regexp_replace("phone", '\D', '', 'g'), 10) IN (
      SELECT phone10 FROM (
        SELECT DISTINCT ON (right(regexp_replace("fromPhone", '\D', '', 'g'), 10))
               right(regexp_replace("fromPhone", '\D', '', 'g'), 10) AS phone10,
               "handledAs"
        FROM "InboundMessage"
        WHERE "handledAs" IN ('opt_out', 'opt_in')
          AND length(regexp_replace("fromPhone", '\D', '', 'g')) >= 10
        ORDER BY right(regexp_replace("fromPhone", '\D', '', 'g'), 10), "createdAt" DESC, "id" DESC
      ) latest
      WHERE latest."handledAs" = 'opt_out'
    )
  );

UPDATE "Lead"
SET "smsConsent" = NULL
WHERE "smsConsent" = false
  AND NOT (
    length(regexp_replace(coalesce("phone", ''), '\D', '', 'g')) >= 10
    AND right(regexp_replace("phone", '\D', '', 'g'), 10) IN (
      SELECT phone10 FROM (
        SELECT DISTINCT ON (right(regexp_replace("fromPhone", '\D', '', 'g'), 10))
               right(regexp_replace("fromPhone", '\D', '', 'g'), 10) AS phone10,
               "handledAs"
        FROM "InboundMessage"
        WHERE "handledAs" IN ('opt_out', 'opt_in')
          AND length(regexp_replace("fromPhone", '\D', '', 'g')) >= 10
        ORDER BY right(regexp_replace("fromPhone", '\D', '', 'g'), 10), "createdAt" DESC, "id" DESC
      ) latest
      WHERE latest."handledAs" = 'opt_out'
    )
  );
