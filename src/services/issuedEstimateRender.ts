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
 * know how to pay; the account credentials are not, because this is a long-lived URL
 * whose only protection is a token that will be forwarded around in email. Payment processing is
 * explicitly out of scope for P027, so nothing on this page needs them. Flagged for Kyle.
 */

import type { IssuedEstimateWithLines } from "./issuedEstimateService";
import { allSelectionCaps, comboKey } from "./materialMarkupCap";
import { asDiscountType, discountFor, discountLabel } from "./discounts";
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
  .saving{color:#1a5c2e;font-weight:600;}
  /* Option cards. Kyle, 2026-08-20: the customer has to be able to pick and choose. */
  .opt{border:1px solid #d9d9d9;border-radius:6px;margin:0 0 14px;overflow:hidden;}
  .opthead{display:flex;align-items:center;justify-content:space-between;gap:10px;
           background:#f4f7f4;border-bottom:1px solid #d9d9d9;padding:9px 11px;}
  .optlabel{display:flex;align-items:center;gap:9px;font-size:15px;cursor:pointer;margin:0;}
  .optlabel input{width:18px;height:18px;accent-color:#1a5c2e;cursor:pointer;flex:none;}
  .optprice{font-weight:700;font-size:15px;white-space:nowrap;}
  .opt table{margin:0;}
  .opt p{padding:0 11px;}
  .pickhint{font-size:13px;color:#1a5c2e;margin:0 0 10px;font-weight:600;}
  /* An option the customer has unticked stays readable but visibly not counted. */
  .opt.off{opacity:.5;}
  .opt.off .optprice{text-decoration:line-through;}
  /* Print: the tick boxes mean nothing on paper, and a declined option should not print at all. */
  @media print{ .optlabel input{display:none;} .opt.off{display:none;} .pickhint{display:none;} }
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

/**
 * The letterhead on the page a customer opens from their estimate link — and prints.
 *
 * ── NO LICENCE DESCRIPTOR HERE, DELIBERATELY (2026-08-20) ──────────────────────────────────────
 *
 * Kyle: *"The pdf should not say the word 'contractor'. Contactor should not appear in any
 * advertisement anywhere."*
 *
 * This line read "... &middot; Licensed Electrical Contractor", which is what he was looking at
 * when he flagged it — the customer estimate page is the PDF, via the browser's own print.
 *
 * In Tennessee "contractor" is a licence classification rather than a synonym for tradesman, and
 * advertising as one is regulated. So this is a compliance line, not a wording preference.
 *
 * It read "... &middot; Licensed Electrical Contractor". Kyle gave the replacement himself on
 * 2026-08-20: *"Licensed Electrician #61828 can take it's place."* — his wording and his licence
 * number, which is the only way a credential should ever get onto a customer document. It was left
 * blank in between rather than guessed at.
 *
 * Note the explanation lives out here in TypeScript and NOT in an HTML comment inside the markup
 * below. An HTML comment ships to the customer and is one "view source" from being read, so a note
 * explaining why the word was removed would have put the word straight back on the page.
 */
/** Money arithmetic, to the cent. The signed total is re-summed from the options taken. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function letterhead(subtitle: string): string {
  return `<div class="head">
    <h1>RED CEDAR ELECTRIC LLC</h1>
    <p>La Vergne, Tennessee &middot; ${BUSINESS_EMAIL} &middot; Licensed Electrician #61828</p>
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
  /**
   * The deposit ask on the signed page (Kyle, 2026-08-25: ⅓ deposit required
   * before scheduling). Null/absent = not signed yet, or nothing due. The page
   * a customer revisits after signing is the natural place the deposit lives.
   */
  deposit?: { due: number; satisfied: boolean; paidInFull: boolean; payUrl: string } | null;
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
  /*
    ── THE OPTIONS, AS SOMETHING THE CUSTOMER CAN ACTUALLY CHOOSE BETWEEN ───────────────────────

    Kyle, 2026-08-20: "the options are not persisting into the pdf or allowing to pick and choose
    between them. Only adding them all together."

    This used to be one flat `est.lines` table under one ESTIMATE TOTAL. Every line already knew
    its option letter, so the grouping was always possible — it simply was not done, and the
    customer was handed a single take-it-or-leave-it number for three separate pieces of work.

    Now each option is its own card with its own price and its own tick box, and the total is the
    sum of what is ticked.

    ── WHY EVERYTHING STARTS TICKED ─────────────────────────────────────────────────────────────

    The estimate quotes the full scope, so the first thing the customer sees is the full price —
    the same number Kyle sent them and the same number he sees on his copy. Starting with nothing
    ticked would show $0.00 on open, which reads as an error.

    Unticking is the choice. What they leave ticked at the moment they sign is what gets recorded,
    so declining Option B is a positive act by the customer rather than an assumption by us.

    ── AND WHY A SINGLE-OPTION ESTIMATE HAS NO TICK BOXES ───────────────────────────────────────

    Offering a choice of one is not a choice; it is a way to accidentally sign for nothing.
  */
  const estOptions = est.options ?? [];

  /*
    ── THE THIRD GATE, ON THE PAGE THAT SELLS IT (Kyle, 2026-08-22) ────────────────────────────

    "If the customer chooses one, two, or three options the savings add up and help push the sale
     of more work simply by lowing the cost of material."

    Every combination the customer could tick is priced HERE, server-side, from the frozen lines —
    and the page is handed only the finished totals and the saving for each combination. The
    material costs that produce those numbers never leave the server: this is a customer-facing
    page, and cost is company data.

    Unsigned, the live figure comes from this table as they tick. Signed, the stored comboCapJson
    is the only authority — the bands live in code, and a signed price must not move with them.
  */
  const comboTable: Record<string, { total: number; saving: number; discount: number }> = {};
  const programme = asDiscountType(est.discountType);
  if (estOptions.length > 0) {
    /*
      Priced with the schedule frozen at issue (jobBandsJson), not whatever Rate Config holds now.
      Kyle tunes these bands in his workbook; without this, retuning them would change the combo
      prices on a page a customer may already have open, after he had quoted them.
    */
    const frozenBands = est.jobBandsJson
      ? (JSON.parse(est.jobBandsJson) as Parameters<typeof allSelectionCaps>[1])
      : undefined;
    const caps = allSelectionCaps(
      // Kyle's flat book prices sit outside the combination gate (2026-08-31) — the frozen flag
      // mirrors the engine's live exemption, so the page and the issue agree.
      est.lines.map((l) => ({
        option: l.option,
        materialCost: l.flatPriced ? null : l.materialCost,
        materialSell: l.flatPriced ? null : l.materialSell,
      })),
      frozenBands,
    );
    for (const [key, cap] of Object.entries(caps)) {
      const subtotals = estOptions
        .filter((o) => key.split("+").includes(o.option))
        .reduce((n, o) => n + o.subtotal, 0);
      // The programme discount rides every combination: 5% of what THIS selection pays, capped.
      const base = subtotals + est.tripCharge - cap.reduction;
      const disc = discountFor(programme, base);
      comboTable[key] = {
        total: round2(base - (disc?.amount ?? 0)),
        saving: cap.reduction,
        discount: disc?.amount ?? 0,
      };
    }
  }
  const signedCombo: { reduction: number } | null = est.comboCapJson
    ? (JSON.parse(est.comboCapJson) as { reduction: number })
    : null;
  // Signed, the STORED amount is the only truth — the rate and cap live in code, and a signed
  // price does not move with them.
  const signedDiscount: { amount: number } | null = est.discountJson
    ? (JSON.parse(est.discountJson) as { amount: number })
    : null;
  const liveAllKey = comboKey(estOptions.map((o) => o.option));
  const chosen = new Set((est.selectedOptions ?? []) as string[]);
  const signedOff = Boolean(est.signedAt);
  const discountShown = signedOff ? signedDiscount?.amount ?? 0 : comboTable[liveAllKey]?.discount ?? 0;

  // Once signed, the document shows what was BOUGHT, not what was offered. An option the customer
  // declined has no business appearing on their agreement.
  const shownOptions = signedOff && chosen.size > 0 ? estOptions.filter((o) => chosen.has(o.option)) : estOptions;
  const selectable = !signedOff && estOptions.length > 1;
  // One-or-the-other (Kyle, 2026-08-25): radio buttons, exactly one choice,
  // Option A pre-selected so the page opens showing a real price.
  const exclusive = Boolean(est.exclusiveOptions) && selectable;
  const firstOption = shownOptions[0]?.option ?? null;

  const optionName = (o: { option: string; label: string | null }) =>
    o.label ? `${escapeHtml(o.label)}` : `Option ${escapeHtml(o.option)}`;

  const optionCards = shownOptions
    .map((o) => {
      const lines = est.lines
        .filter((l) => l.option === o.option)
        .map(
          (l) => `<tr>
        <td>${escapeHtml(l.description)}</td>
        <td class="r">${qty(l.quantity)}</td>
      </tr>`
        )
        .join("");
      const box = selectable
        ? exclusive
          ? `<input type="radio" name="optchoice" class="optpick" data-option="${escapeHtml(o.option)}"
               data-subtotal="${o.subtotal}" ${o.option === firstOption ? "checked" : ""}
               aria-label="Choose ${optionName(o)}">`
          : `<input type="checkbox" class="optpick" data-option="${escapeHtml(o.option)}"
               data-subtotal="${o.subtotal}" checked aria-label="Include ${optionName(o)}">`
        : "";
      const note = o.note
        ? `<p style="margin:2px 0 0;font-size:13px;color:#555;">${escapeHtml(o.note)}</p>`
        : "";
      return `<section class="opt" data-optcard="${escapeHtml(o.option)}">
        <header class="opthead">
          <label class="optlabel">${box}
            <span><strong>${optionName(o)}</strong>
              ${o.label ? `<span style="color:#777;font-size:12px;"> &middot; Option ${escapeHtml(o.option)}</span>` : ""}
            </span>
          </label>
          <span class="optprice">${money(o.subtotal)}</span>
        </header>
        ${note}
        <table>
          <thead><tr><th>Description</th><th class="r">Qty</th></tr></thead>
          <tbody>${lines}</tbody>
        </table>
      </section>`;
    })
    .join("");

  // The fallback matters: an estimate issued before options existed has no option rows, and must
  // still render as the flat list it was issued as rather than as an empty page.
  const detail =
    estOptions.length > 0
      ? optionCards
      : `<table>
         <thead><tr><th>Description</th><th class="r">Qty</th></tr></thead>
         <tbody>${est.lines
           .map(
             (l) => `<tr><td>${escapeHtml(l.description)}</td><td class="r">${qty(l.quantity)}</td></tr>`
           )
           .join("")}</tbody>
       </table>`;

  const scope = est.scopeText
    ? `<h2>Scope of Work</h2><p style="font-size:14px;">${escapeHtml(est.scopeText)}</p>`
    : "";

  const included = est.includedText
    ? `<div class="box"><strong>Included / Not Included.</strong> ${escapeHtml(est.includedText)}</div>`
    : "";

  /*
    ── P031: the generator sizing one-pager ─────────────────────────────────────
    Renders ONLY when a human attached the recommendation at issuance
    (generatorJson set) — propose-only end to end. Plain language, two tiers,
    explicit Covered / Not covered lists, and the preliminary disclaimer on the
    page. No prices and no internal package refs here: the price book resolves
    those on the company side, and this is a customer document.
  */
  const generatorSection = (() => {
    if (!est.generatorJson) return "";
    try {
      interface StoredModel { classLabel: string; generatorModel: string }
      const stored = JSON.parse(est.generatorJson) as {
        recommendation: {
          wholeHome: Array<{
            scheme: string; title: string; necBasis: string; requiredKW: number | null;
            model: StoredModel | null; liquidCooled: boolean; shedLoads?: string[]; notes: string[];
            autoShed?: { ceilingKW: number; added: string[]; fits: boolean };
          }>;
          airCooledCeilingKW?: number;
          partial: {
            requiredKW: number; model: StoredModel | null; liquidCooled: boolean;
            covered: Array<{ label: string; va: number }>;
            notCovered: string[];
            excludedWithReason: string[];
          } | null;
          disclaimer: string;
        };
        fuel: "NG" | "LP";
      };
      const rec = stored.recommendation;
      // ELECTRICAL SCOPE ONLY (Kyle, 2026-08-29): no fuel, no brands, no model
      // numbers on customer documents — the required output is the electrical
      // fact the customer shops with. Product detail stays internal.
      const requirementText = (s: { requiredKW: number | null }) =>
        s.requiredKW !== null
          ? `${s.requiredKW} kW continuous output`
          : "sized by the loads you select — no code minimum";
      // The air-cooled ceiling (Kyle, 2026-08-31): an option above it is stated as such and the
      // reader is pointed at load management — never at a bigger class of equipment.
      const ceiling = typeof rec.airCooledCeilingKW === "number" ? rec.airCooledCeilingKW : null;
      const wholeRows = rec.wholeHome
        .map((s) => `<tr>
            <td><strong>${escapeHtml(s.title)}</strong>
              ${s.shedLoads && s.shedLoads.length > 0
                ? `<br><span style="font-size:12px;color:#555;">Managed loads (run as generator capacity allows): ${escapeHtml(s.shedLoads.join("; "))}</span>`
                : ""}
              ${s.autoShed && s.autoShed.added.length > 0
                ? `<br><span style="font-size:12px;color:#555;">Management extended to stay within air-cooled equipment${ceiling !== null ? ` (${ceiling} kW at this site)` : ""}: ${escapeHtml(s.autoShed.added.join("; "))}</span>`
                : ""}
              ${s.liquidCooled && s.requiredKW !== null
                ? `<br><span style="font-size:12px;color:#8a1c1c;">Exceeds air-cooled standby equipment${ceiling !== null ? ` (${ceiling} kW at this site)` : ""} — see the load-management option</span>`
                : ""}
            </td>
            <td class="r">${escapeHtml(requirementText(s))}</td>
          </tr>`)
        .join("");
      const partialBlock = rec.partial
        ? `<h3 style="margin:14px 0 4px;font-size:15px;">Essential-loads option</h3>
           <p style="font-size:13px;margin:0 0 6px;">Requires ${rec.partial.requiredKW} kW of continuous generator output.</p>
           <p style="font-size:13px;margin:0;"><strong>Covered:</strong> ${rec.partial.covered.map((c) => escapeHtml(c.label)).join("; ")}.</p>
           <p style="font-size:13px;margin:4px 0 0;"><strong>Not covered:</strong> ${rec.partial.notCovered.map(escapeHtml).join("; ")}.</p>
           ${rec.partial.excludedWithReason.length > 0
             ? `<p style="font-size:12px;color:#555;margin:4px 0 0;">${rec.partial.excludedWithReason.map(escapeHtml).join(" ")}</p>`
             : ""}`
        : "";
      return `<div class="box" style="page-break-inside:avoid;">
          <h2 style="margin-top:0;">Backup generator options for this home</h2>
          <p style="font-size:13px;margin:0 0 8px;">
            Electrical requirements from the load calculation we performed at your home. Generator
            selection and fuel supply are yours to choose with these numbers.
          </p>
          <table>
            <thead><tr><th>Connection option</th><th class="r">Required generator output</th></tr></thead>
            <tbody>${wholeRows}</tbody>
          </table>
          ${partialBlock}
        </div>`;
    } catch {
      // A malformed snapshot must not take down the estimate page — the
      // document renders without the section rather than not at all.
      return "";
    }
  })();

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
         ${
           opts.deposit && !opts.deposit.satisfied
             ? `<div style="margin-top:16px;padding:14px;border:2px solid #1a5c2e;border-radius:8px;background:#f4f8f4;">
                  <p style="font-size:15px;margin:0 0 8px;"><strong>Next step — your deposit:</strong>
                  $${opts.deposit.due.toFixed(2)} (one third of the total) reserves your spot on the
                  schedule. We can't book the work until it's in.</p>
                  <a href="${escapeHtml(opts.deposit.payUrl)}"
                     style="display:inline-block;background:#1a5c2e;color:#fff;text-decoration:none;
                            padding:12px 24px;border-radius:6px;font-size:16px;font-weight:600;">
                    Pay your deposit — $${opts.deposit.due.toFixed(2)}
                  </a>
                  <p style="font-size:12px;color:#555;margin:8px 0 0;">Card or bank transfer online, or cash, check, or Zelle — same amount either way. Deposits are non-refundable up to $300 if the job is cancelled.</p>
                </div>
                <p style="font-size:13px;color:#555;margin:10px 0 0;">Questions? Call ${BUSINESS_PHONE}.</p>`
             : opts.deposit?.paidInFull
             ? `<p style="font-size:14px;color:#1a5c2e;font-weight:600;margin:10px 0 0;">✓ Paid in full — thank you.</p>
                <p style="font-size:13px;color:#555;margin:6px 0 0;">Questions? Call ${BUSINESS_PHONE}.</p>`
             : opts.deposit
             ? `<p style="font-size:14px;color:#1a5c2e;font-weight:600;margin:10px 0 0;">✓ Deposit received — we'll be in touch to schedule the work.</p>
                <p style="font-size:13px;color:#555;margin:6px 0 0;">The balance is due at completion.
                Questions? Call ${BUSINESS_PHONE}.</p>`
             : `<p style="font-size:13px;color:#555;margin:10px 0 0;">Thank you. We will be in touch to
                schedule the work. Questions? Call ${BUSINESS_PHONE}.</p>`
         }
       </div>`
    : `<div class="sign">
         <h2 style="margin-top:0;">Accept this estimate</h2>
         ${opts.error ? `<div class="err">${escapeHtml(opts.error)}</div>` : ""}
         <form method="POST" action="/e/${escapeHtml(est.token)}/sign" id="signForm">
           <!-- What they ticked, at the moment they signed. Filled by the script below and
                re-validated on the server, which is what makes it true. -->
           <input type="hidden" name="selectedOptions" id="selectedOptions"
                  value="${exclusive ? escapeHtml(firstOption ?? "") : estOptions.map((o) => escapeHtml(o.option)).join(",")}">
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

  /*
    Live total. Progressive enhancement: with JS off, every option stays ticked and the estimate
    reads exactly as it did before options existed — the full scope at the full price. The customer
    can still sign, and the hidden field still carries every option, so nothing is lost, only the
    ability to decline one on screen.
  */
  const pickerScript = selectable
    ? `<script>
         (function () {
           var boxes = [].slice.call(document.querySelectorAll(".optpick"));
           var out   = document.getElementById("selectedOptions");
           var total = document.getElementById("grandTotal");
           var savingRow = document.getElementById("comboSaving");
           var savingAmt = document.getElementById("comboSavingAmt");
           // Finished prices per combination, priced on the server. No cost figures live in this
           // page — combining options can only ever lower the number, and the table is the proof.
           var combos = ${JSON.stringify(comboTable)};
           var trip  = ${est.tripCharge};
           // Formats EXACTLY as the server's money() does — no thousands separator. They have to
           // agree: the server paints the first total and this repaints it on the first tick, and
           // a customer watching "$1610.69" become "$1,610.69" has been shown a glitch.
           function money(n){ return "$" + n.toFixed(2); }
           function sync() {
             var sum = 0, picked = [];
             boxes.forEach(function (b) {
               var card = document.querySelector('[data-optcard="' + b.dataset.option + '"]');
               if (b.checked) { sum += parseFloat(b.dataset.subtotal); picked.push(b.dataset.option);
                                if (card) card.classList.remove("off"); }
               else if (card) card.classList.add("off");
             });
             out.value = picked.join(",");
             var combo = combos[picked.slice().sort().join("+")];
             // The trip charge applies once, to the visit — and not at all if nothing is taken.
             // The combination table already carries the trip and the multi-option discount; the
             // summed fallback covers only a combination the server somehow did not price.
             total.textContent = picked.length ? money(combo ? combo.total : sum + trip) : money(0);
             var saving = combo ? combo.saving : 0;
             if (savingRow) {
               savingRow.style.display = saving > 0 ? "" : "none";
               if (savingAmt) savingAmt.innerHTML = "&minus;" + money(saving);
             }
             var disc = combo ? combo.discount : 0;
             var discRow = document.getElementById("progDiscount");
             var discAmt = document.getElementById("progDiscountAmt");
             if (discRow) {
               discRow.style.display = disc > 0 ? "" : "none";
               if (discAmt) discAmt.innerHTML = "&minus;" + money(disc);
             }
           }
           boxes.forEach(function (b) { b.addEventListener("change", sync); });
           sync();
         })();
       </script>`
    : "";

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
       ${selectable
         ? exclusive
           ? `<p class="pickhint"><strong>Choose ONE</strong> of the options below — they are alternatives, not add-ons. The total updates as you choose.</p>`
           : `<p class="pickhint">Tick the options you want. The total updates as you choose.</p>`
         : ""}
       ${detail}

       <div class="totals">
         ${est.tripCharge > 0 || est.tripWaived
           ? `<div><span>${tripLabel}</span><span>${money(est.tripCharge)}</span></div>`
           : ""}
         <div id="comboSaving" class="saving" ${
           (signedOff ? (signedCombo?.reduction ?? 0) : comboTable[comboKey(estOptions.map((o) => o.option))]?.saving ?? 0) > 0
             ? "" : 'style="display:none;"'
         }><span>Multi-option material discount</span><span id="comboSavingAmt">&minus;${money(
           signedOff ? signedCombo?.reduction ?? 0 : comboTable[comboKey(estOptions.map((o) => o.option))]?.saving ?? 0
         )}</span></div>
         <div id="progDiscount" class="saving" ${discountShown > 0 ? "" : 'style="display:none;"'}>
           <span>${programme ? escapeHtml(discountLabel(programme)) : "Discount"}</span>
           <span id="progDiscountAmt">&minus;${money(discountShown)}</span>
         </div>
         <div class="grand"><span>ESTIMATE TOTAL</span><span id="grandTotal">${money(
           signedOff && chosen.size > 0
             ? round2(
                 shownOptions.reduce((n, o) => n + o.subtotal, 0) + est.tripCharge -
                   (signedCombo?.reduction ?? 0) - (signedDiscount?.amount ?? 0),
               )
             : estOptions.length > 0
               ? comboTable[liveAllKey]?.total ?? est.total
               : round2(est.total - (discountShown ?? 0))
         )}</span></div>
       </div>
       <p style="font-size:12px;color:#777;margin:8px 4px 0;">
         Furnished and installed, flat rate. The scope above is what the price covers.
       </p>

       ${included}

       ${generatorSection}

       ${signBlock}
       ${pickerScript}
     </div>
     <div class="foot">
       This estimate is valid for ${est.validDays} days. Work performed to the 2017 National
       Electrical Code as adopted by the Tennessee State Fire Marshal Office.<br>
       Red Cedar Electric LLC &middot; Licensed &amp; Insured &middot; Serving Middle Tennessee
       &middot; ${BUSINESS_PHONE}
     </div>`
  );
}
