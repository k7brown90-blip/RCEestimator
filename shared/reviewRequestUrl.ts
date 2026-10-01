/**
 * Kyle's Google review link, for the two FRONTENDS only (2026-10-01, plan
 * 2026-10-01-manual-sends-archiving-and-one-calendar.md, item B: "a google review request to
 * email on its own ... with a QR code").
 *
 * Kyle asks for the review in person — the tech or Kyle shows a QR on their OWN screen and the
 * customer scans it off it. The URL is the same for every customer (not token-scoped like the
 * pay QR), so the QR is generated CLIENT-SIDE, right here in the CRM and the field app, with the
 * `qrcode` package. It must NOT become a server route: `/pay/:token/qr.svg` (src/app.ts:1390) is
 * a deliberate public endpoint because it is customer-specific and the customer's own phone has
 * to load it; this URL is neither, and CLAUDE.md is explicit — "never add an unauthenticated
 * document/image endpoint outside the one deliberate exception the doc describes."
 *
 * THIS DUPLICATES src/services/reviewRequest.ts's own `GOOGLE_REVIEW_URL`, on purpose, not by
 * oversight. That file is the one that actually emails the ask and is server code — out of
 * scope for this UI-only build (the brief: "the server is already built and security-reviewed,
 * do not add or change any route or service"). Re-pointing it at this file would be a one-line
 * change but it IS a change to a reviewed service, so it's left alone here. The plan already
 * flagged the resulting asymmetry — `financingUrl` is Settings-editable, GOOGLE_REVIEW_URL is
 * not — as "noted, not fixed here"; this is the same category of known gap, now with two
 * hardcoded copies (server, and this file) instead of three (server, client, field) had each
 * frontend carried its own literal. If Kyle ever changes the review link, BOTH this file and
 * src/services/reviewRequest.ts need the edit.
 */
export const GOOGLE_REVIEW_URL = "https://g.page/r/CdXY7dazs17QEBM/review";
