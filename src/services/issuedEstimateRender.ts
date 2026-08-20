/**
 * The customer-facing estimate page. (P027)
 *
 * THE PAGE **IS** THE ESTIMATE. There is no PDF in this flow — the prompt's "no PDF attachment
 * generation if the tokenized page covers the need" — so this render is the artifact the customer
 * reads and signs, and it is built from the frozen snapshot on the row. It reads no catalog, no
 * rate config and no customer record, which is what lets a signed estimate be reproduced
 * byte-for-byte long after those move.
 *
 * FORMAT is the house format, lifted from the issued PDFs (2026-1002 Rev C lineage, most
 * recently 2026-1007): letterhead, estimate number and date, "Prepared for", scope prose, a
 * Description / Qty / Price table, work subtotal described as flat rate, the trip line shown even
 * when it is waived at $0.00, the total, then payment terms and the acceptance block.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NOT ONE HOUR FIGURE APPEARS HERE, AND NONE CAN.
 *
 * Kyle, verbatim, 2026-08-17: "Never show labor hour estimate to the customer."
 *
 * This function's entire input is `IssuedEstimateWithLines`, and that model HAS NO HOURS COLUMN —
 * graduation collapsed labour dollars and material sell into one flat price and dropped the
 * hours. So the guarantee does not rest on this template being written carefully; it rests on
 * there being nothing to render. `tests/issuedEstimate.test.ts` greps the output of this function
 * for hour patterns as the second line of defence.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IS DELIBERATELY NOT ON THIS PAGE: the ACH account and routing numbers that the emailed
 * PDFs carry. Payment TERMS are here because the prompt asks for them and the customer needs to
 * know a card costs 3% more; the account credentials are not, because this is a long-lived URL
 * whose only protection is a token that will be forwarded around in email. Payment processing is
 * explicitly out of scope for P027, so nothing on this page needs them. Flagged for Kyle.
 */

import type { IssuedEstimateWithLines } from "./issuedEstimateService";
import { CONSENT_TEXT } from "./issuedEstimateService";

const TZ = "America/Chicago";
const BUSINESS_EMAIL = "service@redcedarelectricllc.com";
const BUSINESS_PHONE = "615-625-2163";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function qty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

function longDate(d: Date): string {
  return d.toLocaleDateString("en-US", { timeZone: TZ, month: "long", day: "numeric", year: "numeric" });
}

function shell(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${escapeHtml(title)} — Red Cedar Electric</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
       margin:0;padding:0 0 48px;background:#f4f5f4;color:#222;line-height:1.5;}
  .wrap{max-width:680px;margin:0 auto;background:#fff;}
  .head{background:#1a5c2e;color:#fff;padding:20px 24px;}
  .head h1{margin:0;font-size:19px;letter-spacing:.02em;}
  .head p{margin:4px 0 0;font-size:13px;opacity:.9;}
  .pad{padding:20px 24px;}
  .meta{display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:#555;
        border-bottom:1px solid #e3e3e3;padding-bottom:14px;margin-bottom:16px;}
  .meta div strong{display:block;color:#222;font-size:14px;}
  h2{font-size:16px;margin:22px 0 8px;color:#1a5c2e;}
  table{width:100%;border-collapse:collapse;font-size:14px;}
  th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#666;
     border-bottom:2px solid #e3e3e3;padding:6px 4px;}
  th.r,td.r{text-align:right;}
  td{padding:9px 4px;border-bottom:1px solid #eee;vertical-align:top;}
  .totals{margin-top:14px;font-size:14px;}
  .totals div{display:flex;justify-content:space-between;padding:5px 4px;}
  .totals .grand{border-top:2px solid #1a5c2e;margin-top:6px;padding-top:10px;
                 font-size:18px;font-weight:700;color:#1a5c2e;}
  .box{background:#f7f9f7;border:1px solid #e0e6e0;border-radius:6px;padding:14px 16px;
       margin-top:18px;font-size:13px;}
  .sign{border:2px solid #1a5c2e;border-radius:8px;padding:18px 16px;margin-top:24px;}
  .sign label{display:block;font-weight:600;font-size:14px;margin-bottom:6px;}
  .sign input[type=text]{width:100%;box-sizing:border-box;padding:12px;font-size:16px;
       border:1px solid #bbb;border-radius:5px;}
  .sign button{margin-top:14px;width:100%;background:#1a5c2e;color:#fff;border:0;padding:15px;
       font-size:17px;font-weight:600;border-radius:6px;cursor:pointer;}
  .consent{font-size:12px;color:#555;margin:12px 0 0;}
  .signed{background:#eaf5ec;border:2px solid #1a5c2e;border-radius:8px;padding:18px 16px;
          margin-top:24px;text-align:center;}
  .foot{font-size:12px;color:#777;padding:18px 24px;border-top:1px solid #eee;}
  .err{background:#fdecea;border:1px solid #f5c6c2;color:#8c1d18;border-radius:6px;
       padding:12px 14px;margin-bottom:14px;font-size:14px;}
  .printbar{padding:10px 24px;background:#f0f2f0;border-bottom:1px solid #e3e3e3;text-align:right;}
  .printbar button{background:#1a5c2e;color:#fff;border:0;padding:9px 18px;border-radius:5px;
       font-size:14px;cursor:pointer;}
  /* PRINT / SAVE AS PDF. Kyle, 2026-08-18: "I need a print option just in case this keeps
     failing." Email delivery has been unreliable; a quote he can print or save as a PDF and
     hand over is the fallback that does not depend on it. Screen-only furniture is dropped so
     the sheet prints as the estimate and nothing else. */
  @media print {
    body{background:#fff;}
    .wrap{max-width:none;}
    .printbar,.sign{display:none !important;}
    .head{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  }
</style></head>
<body><div class="wrap">${inner}</div>
<script>
  // Progressive enhancement only: without JS the page still reads and still prints from the
  // browser's own menu.
  document.querySelectorAll("[data-print]").forEach(function (b) {
    b.addEventListener("click", function () { window.print(); });
  });
</script>
</body></html>`;
}

function letterhead(subtitle: string): string {
  return `<div class="head">
    <h1>RED CEDAR ELECTRIC LLC</h1>
    <p>La Vergne, Tennessee &middot; ${BUSINESS_EMAIL} &middot; Licensed Electrical Contractor</p>
    <p style="margin-top:8px;font-size:15px;font-weight:600;opacity:1;">${escapeHtml(subtitle)}</p>
  </div>`;
}

/** The page a customer sees when a link is dead, wrong, or replaced. One page for every reason. */
export function renderUnavailable(): string {
  return shell(
    "Estimate unavailable",
    `${letterhead("Estimate")}
     <div class="pad">
       <h2>This estimate link is not available</h2>
       <p style="font-size:15px;">The link may have expired, or a newer version of this estimate
       may have been sent to you. Please check your email for the most recent one, or call us at
       ${BUSINESS_PHONE} and we will resend it.</p>
     </div>
     <div class="foot">Red Cedar Electric LLC &middot; Licensed &amp; Insured &middot; Serving Middle Tennessee</div>`
  );
}

/**
 * The estimate itself.
 *
 * `error` renders a refusal (a failed signature attempt) above the signing block without losing
 * the page — the customer must never be dropped onto a bare error and made to find the link again.
 */
export interface RenderOpts {
  error?: string | null;
  /**
   * Which door this render is being served through. (P028)
   *
   * The ESTIMATE is byte-identical either way — same letterhead, same lines, same flat prices,
   * same totals, same payment block, same absence of hours. That is the whole point of there
   * being one render function: the no-hours grep covers both paths by covering this one.
   *
   * All that changes is the sign affordance, and it changes because the two channels carry
   * different credentials and cannot share a submit:
   *   "email"     — a plain HTML form POSTing to the public /e/:token/sign route.
   *   "in_person" — no form. The operator's React app is holding a signing-scoped session token
   *                 that an HTML form cannot attach, so it renders the signature panel itself
   *                 and calls the API. The document below it is this same document.
   */
  channel?: "email" | "in_person";
}

export function renderEstimatePage(
  est: IssuedEstimateWithLines,
  opts: RenderOpts = {}
): string {
  const issued = longDate(est.createdAt);
  const preparedFor = [
    `<strong>${escapeHtml(est.customerName)}</strong>`,
    est.customerPhone ? escapeHtml(est.customerPhone) : null,
    est.customerEmail ? escapeHtml(est.customerEmail) : null,
    est.serviceAddress ? escapeHtml(est.serviceAddress) : null,
  ]
    .filter(Boolean)
    .join("<br>");

  /*
    NO PER-LINE PRICES. Kyle, 2026-08-18:

      "the estimates are still giving line items pricing which it should not. The customers
       should get a line item quote with only the total price."

    The customer sees WHAT is included and HOW MANY — the scope, itemised — and one price for the
    job. A per-line price invites a line-by-line negotiation of a lump-sum quote, and it exposes
    the shape of the build-up on a flat-rate estimate.

    The line totals still exist on the row and still sum to the total; they are simply not
    rendered here. Nothing about the arithmetic changed.
  */
  const rows = est.lines
    .map(
      (l) => `<tr>
        <td>${escapeHtml(l.description)}</td>
        <td class="r">${qty(l.quantity)}</td>
      </tr>`
    )
    .join("");

  const scope = est.scopeText
    ? `<h2>Scope of Work</h2><p style="font-size:14px;">${escapeHtml(est.scopeText)}</p>`
    : "";

  const included = est.includedText
    ? `<div class="box"><strong>Included / Not Included.</strong> ${escapeHtml(est.includedText)}</div>`
    : "";

  // The trip line is SHOWN even at zero. Kyle's PDFs present a waived trip as an explicit $0.00
  // rather than omitting it, so the customer can see the concession was made.
  const tripLabel = est.tripWaived ? "Trip and job setup &mdash; waived" : "Trip and job setup";

  // In-person: the document ends at the totals; the React shell renders the signature panel.
  const inPerson = opts.channel === "in_person";

  const signBlock = inPerson && !est.signedAt
    ? ""
    : est.signedAt
    ? `<div class="signed">
         <h2 style="margin-top:0;">Accepted &amp; signed</h2>
         <p style="font-size:15px;margin:0;">Signed by <strong>${escapeHtml(est.signerName ?? "")}</strong>
         on ${longDate(est.signedAt)}.</p>
         ${
           // The mark itself. Rendered from the stored data URL, which was validated as a PNG
           // before it was ever written — see services/signatureImage.ts.
           est.signatureImage
             ? `<img src="${escapeHtml(est.signatureImage)}" alt="Signature"
                     style="display:block;margin:10px 0 0;max-width:280px;height:auto;border-bottom:1px solid #999;padding-bottom:4px;">`
             : ""
         }
         <p style="font-size:13px;color:#555;margin:10px 0 0;">Thank you. We will be in touch to
         schedule the work. Questions? Call ${BUSINESS_PHONE}.</p>
       </div>`
    : `<div class="sign">
         <h2 style="margin-top:0;">Accept this estimate</h2>
         ${opts.error ? `<div class="err">${escapeHtml(opts.error)}</div>` : ""}
         <form method="POST" action="/e/${escapeHtml(est.token)}/sign" id="signForm">
           <label for="signerName">Your full name</label>
           <input id="signerName" name="signerName" type="text" required autocomplete="name"
                  placeholder="Your full name">

           <!-- The DRAWN signature (Kyle, 2026-08-20). The typed name identifies the signer; the
                drawing is the mark they actually made. Vanilla because this page is served as
                plain HTML to a customer's browser with no bundle behind it. -->
           <div style="display:flex;align-items:baseline;justify-content:space-between;margin-top:14px;">
             <label for="sigPad" style="margin:0;">Sign here</label>
             <button type="button" id="sigClear"
                     style="background:none;border:0;color:#555;text-decoration:underline;font-size:13px;cursor:pointer;padding:0;">Clear</button>
           </div>
           <canvas id="sigPad" height="160"
                   style="touch-action:none;width:100%;height:160px;border:2px dashed #bbb;border-radius:8px;background:#fff;margin-top:4px;"></canvas>
           <p style="font-size:12px;color:#666;margin:4px 0 0;" id="sigHint">Draw your signature with a finger or stylus.</p>
           <input type="hidden" name="signatureImage" id="signatureImage">

           <p class="consent">${escapeHtml(CONSENT_TEXT)}</p>
           <button type="submit">Accept &amp; Sign</button>
         </form>
         <script>
           (function () {
             var canvas = document.getElementById("sigPad");
             var field = document.getElementById("signatureImage");
             var hint = document.getElementById("sigHint");
             var form = document.getElementById("signForm");
             if (!canvas || !field || !form) return;
             var ctx = canvas.getContext("2d");
             var drawing = false, marked = false;

             // Match the backing store to the device or the stroke renders blurry on any phone.
             function size() {
               var ratio = window.devicePixelRatio || 1;
               var rect = canvas.getBoundingClientRect();
               canvas.width = Math.round(rect.width * ratio);
               canvas.height = Math.round(rect.height * ratio);
               ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
               ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#111";
             }
             size();

             function at(e) {
               var r = canvas.getBoundingClientRect();
               return { x: e.clientX - r.left, y: e.clientY - r.top };
             }
             canvas.addEventListener("pointerdown", function (e) {
               e.preventDefault();
               canvas.setPointerCapture(e.pointerId);
               var p = at(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); drawing = true;
             });
             canvas.addEventListener("pointermove", function (e) {
               if (!drawing) return;
               e.preventDefault();
               var p = at(e); ctx.lineTo(p.x, p.y); ctx.stroke();
               if (!marked) { marked = true; hint.textContent = "Signed above. Tap Clear to start again."; }
             });
             function end(e) {
               if (!drawing) return;
               drawing = false;
               if (canvas.releasePointerCapture) { try { canvas.releasePointerCapture(e.pointerId); } catch (err) {} }
               field.value = canvas.toDataURL("image/png");
             }
             canvas.addEventListener("pointerup", end);
             canvas.addEventListener("pointercancel", end);
             canvas.addEventListener("pointerleave", end);

             document.getElementById("sigClear").addEventListener("click", function () {
               ctx.clearRect(0, 0, canvas.width, canvas.height);
               field.value = ""; marked = false;
               hint.textContent = "Draw your signature with a finger or stylus.";
             });

             // Refuse an unsigned submit here as well as on the server. The server is what makes
             // it true; this is what stops the customer losing the page to a refused POST.
             form.addEventListener("submit", function (e) {
               if (!field.value) {
                 e.preventDefault();
                 hint.textContent = "Please draw your signature before accepting.";
                 hint.style.color = "#a00";
               }
             });
           })();
         </script>
       </div>`;

  return shell(
    `Estimate ${est.number}`,
    `${letterhead("ESTIMATE")}
     <div class="printbar"><button type="button" data-print>Print / Save as PDF</button></div>
     <div class="pad">
       <div class="meta">
         <div><strong>Estimate No.</strong>${escapeHtml(est.number)}${est.revision > 1 ? ` rev ${est.revision}` : ""}</div>
         <div><strong>Date</strong>${issued}</div>
         <div><strong>Valid</strong>${est.validDays} days</div>
       </div>

       <h2 style="margin-top:0;">${escapeHtml(est.title)}</h2>
       <p style="font-size:14px;margin:0 0 4px;color:#555;">Prepared for:</p>
       <p style="font-size:14px;margin:0;">${preparedFor}</p>

       ${scope}

       <h2>Estimate detail</h2>
       <table>
         <thead><tr><th>Description</th><th class="r">Qty</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>

       <div class="totals">
         ${est.tripCharge > 0 || est.tripWaived
           ? `<div><span>${tripLabel}</span><span>${money(est.tripCharge)}</span></div>`
           : ""}
         <div class="grand"><span>ESTIMATE TOTAL</span><span>${money(est.total)}</span></div>
       </div>
       <p style="font-size:12px;color:#777;margin:8px 4px 0;">
         Furnished and installed, flat rate. The scope above is what the price covers.
       </p>

       ${included}

       <div class="box">
         <strong>Payment.</strong> We accept ACH bank transfer (no fee) or credit / debit card
         (a 3% processing fee is added to card payments). Payment details are provided with your
         invoice when the work is complete.
       </div>

       ${signBlock}
     </div>
     <div class="foot">
       This estimate is valid for ${est.validDays} days. Work performed to the 2017 National
       Electrical Code as adopted by the Tennessee State Fire Marshal Office.<br>
       Red Cedar Electric LLC &middot; Licensed &amp; Insured &middot; Serving Middle Tennessee
       &middot; ${BUSINESS_PHONE}
     </div>`
  );
}
