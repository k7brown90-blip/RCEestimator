/**
 * Receipt vision parsing — extracts structured data from a receipt photo OR a
 * receipt PDF via the OpenAI API. Used by both the tech-PWA receipt upload
 * and the Twilio MMS webhook. Degrades gracefully: when OPENAI_API_KEY is
 * missing or parsing fails, returns null and the caller stores the receipt
 * for manual review instead.
 *
 * Unit 1 (2026-09-18, "receipts must be read, not guessed"): Kyle — "The
 * reader MUST read the lines from PDF's and photos alike... When I asked to
 * be able to upload pdf's I expected it to read the information same as with
 * the photo receipts." PDFs ride the SAME chat/completions call as photos —
 * OpenAI's Chat Completions API accepts a PDF as a `file` content part
 * (`file_data` as a base64 data URL) alongside `image_url`, and gpt-4o-mini
 * supports it (OpenAI's PDF-input launch explicitly lists o1, gpt-4o and
 * gpt-4o-mini: https://community.openai.com/t/direct-pdf-file-input-now-supported-in-the-api/1146647,
 * confirmed current at https://platform.openai.com/docs/guides/pdf-files —
 * "Chat Completions accepts only PDF files as `file` content parts"). This
 * was verified against OpenAI's own documentation, NOT a live call: this
 * checkout's app/.env carries no OPENAI_API_KEY, so no request could actually
 * be sent from this environment. Whoever runs this against a real key first
 * should smoke-test one PDF before trusting it in production.
 */

export interface ParsedReceiptLine {
  name: string;
  qty: number | null;
  unit: string | null;
  unitCost: number | null;
  sku?: string | null;
  // `lineTotal` and `partNumber` added 2026-09-18 (Unit 1, "receipts must be
  // read, not guessed"). `lineTotal` is the line's own printed total (qty ×
  // unitCost on the receipt, not recomputed) — Unit 2's reconciliation sums
  // these, never unitCost × qty, because a recomputed number can silently
  // paper over a misread unitCost or qty. `partNumber` is the manufacturer
  // model/part number Home Depot prints in parentheses after the item name
  // (HOM115CAFIC, HOM3060M200PCVP...) — distinct from `sku`, which is the
  // store's own catalog number printed separately. Named to match
  // PurchaseOrderLine.partNumber (schema.prisma) — the same manufacturer
  // part/model number, captured on the P.O. side — so matching a receipt
  // line to a P.O. line can compare the two directly instead of a fuzzy
  // name guess. Both nullable and additive: a receipt parsed before this
  // change, or a line where Vision can't read one, still works.
  lineTotal?: number | null;
  partNumber?: string | null;
}

export interface ParsedReceipt {
  vendor: string | null;
  total: number | null;
  purchaseDate: string | null; // YYYY-MM-DD when readable
  // permit and inspection added 2026-09-11 — job FEES, the third term in the
  // commission math (job profit = revenue − material − fees).
  category: "materials" | "gas" | "maintenance" | "overhead" | "permit" | "inspection";
  // `sku` added 2026-09-12 (barcode/materials plan Unit 4). Home Depot prints the SKU beside
  // every line, and it's exactly what Kyle scans or types to buy — capturing it turns
  // receipt-to-material matching from a name substring guess into an exact key lookup, scoped
  // by the receipt's vendor (services/materialPriceObservations.ts). Nullable and additive: a
  // receipt parsed before this change, or one where Vision can't read the SKU, still produces a
  // usable line through the existing name-matching path.
  lineItems: Array<ParsedReceiptLine>;
  // `purchaseDateRejected` added 2026-09-14 (legacy purchase close-out, Unit 4). True only when
  // Vision returned a purchaseDate string that plausiblePurchaseDate() then rejected as
  // implausible (see PLAUSIBLE_PURCHASE_DATE_WINDOW below) — distinct from Vision simply not
  // reading a date at all. Nullable and additive, same shape as `sku`: a caller that ignores it
  // gets the pre-2026-09-14 behavior unchanged. Callers use it to keep a receipt in
  // "pending_review" instead of auto-confirming one whose date could not be trusted.
  purchaseDateRejected?: boolean;
  // `subtotal` / `tax` added 2026-09-18 (Unit 2). Captured straight off the
  // receipt when it prints them (most itemized receipts do) so reconciliation
  // can check the receipt's own arithmetic instead of recomputing one from
  // the other. Null when the receipt doesn't print one or Vision can't read
  // it. Optional and additive, same convention as `sku`/`purchaseDateRejected`
  // above — a hand-built ParsedReceipt (e.g. in a test) need not set these.
  subtotal?: number | null;
  tax?: number | null;
  // `reconciled` / `reconciliationNote` added 2026-09-18 (Unit 2, "the reader
  // must reconcile, or say it could not"). `reconciled` is true only when
  // every line has a lineTotal, the lines' sum (plus tax) matches the
  // printed total to the cent, and (when a subtotal was printed) the lines
  // also sum to the subtotal to the cent. Anything short of that — a missing
  // line total, a missing total, or numbers that don't add up — is false,
  // with `reconciliationNote` saying WHAT didn't add up. Optional so existing
  // callers/tests that predate this Unit are unaffected; parseReceiptImage
  // itself always sets both.
  reconciled?: boolean;
  reconciliationNote?: string | null;
  // `discount` added 2026-09-18 (Unit 2 correction — see reconcileParsedReceipt).
  // The receipt's own printed savings/discount total (Home Depot prints "You
  // Saved $95.16" on a promo order). Captured because it's a real number on
  // the receipt, not because reconciliation depends on it — the reconciliation
  // check is Σ(line totals) + tax == total ONLY; subtotal is pre-discount on a
  // promo order and is never compared against the line sum. Null when the
  // receipt prints no discount.
  discount?: number | null;
}

const VISION_PROMPT = `You are a receipt-processing assistant for an electrical contractor.
Extract the following from the receipt (image or PDF) and reply with ONLY a JSON object (no markdown):
{
  "vendor": string | null,          // store/supplier name
  "total": number | null,           // grand total incl. tax, as printed
  "subtotal": number | null,        // subtotal as printed (null if not printed) — see note below
  "discount": number | null,        // a printed savings/discount total, e.g. "You Saved $95.16"
                                     // (null if the receipt prints none)
  "tax": number | null,             // sales tax amount, as printed (null if not printed)
  "purchaseDate": string | null,    // YYYY-MM-DD if visible
  "category": "materials" | "gas" | "maintenance" | "overhead" | "permit" | "inspection",
  "lineItems": [{
    "name": string,
    "qty": number | null,
    "unit": string | null,
    "unitCost": number | null,      // the price per unit ACTUALLY CHARGED — see note below
    "lineTotal": number | null,     // this line's own total, as printed — do not compute qty * unitCost
    "sku": string | null,           // the store's own SKU/item number, printed beside the line
    "partNumber": string | null      // the MANUFACTURER model/part number, often printed in
                                     // parentheses after the item name, e.g. "(HOM115CAFIC)" —
                                     // different from the store SKU; capture exactly as printed
  }]
}
Read EVERY line item printed on the receipt, in order — do not summarize, merge, or skip any.
Most box-store receipts (Home Depot, Lowe's) print a SKU beside each line and a manufacturer model
number in parentheses after the item name — capture each in its own field exactly as printed
(digits, may include letters); use null when one is absent or cannot be read reliably. Do not guess.
IMPORTANT — promotional/discounted pricing: some receipts print a struck-through (crossed-out)
ORIGINAL price next to a lower price actually charged (e.g. "Save 20%"). Always use the price
ACTUALLY CHARGED — the one the line's own total is computed from — for "unitCost" and "lineTotal",
never the struck-through original price. When the receipt's "Subtotal" is the sum of the
struck-through original prices (a PRE-discount subtotal) rather than the discounted line totals,
that is normal — capture it as printed in "subtotal" anyway, and separately capture the printed
savings/discount total in "discount". Do not adjust "subtotal" to try to make it match the lines.
Category guidance: electrical supply houses / hardware stores => "materials"; fuel stations => "gas";
vehicle or tool service => "maintenance"; a city/county permit fee => "permit"; an electrical
inspection fee => "inspection"; anything else => "overhead".
If this is not a receipt, reply with {"vendor":null,"total":null,"subtotal":null,"discount":null,"tax":null,"purchaseDate":null,"category":"overhead","lineItems":[]}.`;

/**
 * Vision reads receipt dates loosely — Kyle's 2026-09-08 captures came back
 * dated 2022-09-08 (the year misread). Confirmed again 2026-09-14: receipt
 * 9f7901d9f3c840318d08688fa0bb5170 ($324.33, Home Depot, Robert Tran Garage
 * Expansion) was captured at 2026-09-08 12:06:34 PM CT — 30 minutes before this
 * guard first shipped — and landed with receivedAt=2022-09-08. That one bad
 * year hid $324.33 from the 2026 P&L (financials.ts's receiptRows/spendRows are
 * both date-windowed) and kept the card matcher's ±3-day window from ever
 * reaching the real transaction. Kyle's ruling 2026-09-14: the business is
 * three weeks old, so nothing dated before it opened is a real purchase date.
 *
 * A purchase date is only trusted when it falls inside this window; otherwise
 * the receipt keeps its upload time (createdAt / now), which is at worst days
 * off rather than years off, and the caller is expected to flag the receipt
 * for human review rather than silently trust the fallback.
 */
const PLAUSIBLE_PURCHASE_DATE_WINDOW = {
  // Nothing meaningfully in the future — a photo taken today of a purchase
  // dated tomorrow is still a misread, not a pre-order.
  maxFutureDays: 1,
  // Nothing older than this before "now" — generous enough to cover a receipt
  // photographed well after the purchase (a shoebox of receipts), but nowhere
  // near old enough to admit a mis-OCR'd year like 2022 on a 2026 business.
  maxPastDays: 400,
} as const;

export function plausiblePurchaseDate(value: unknown, now: Date = new Date()): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T12:00:00Z`).getTime();
  if (Number.isNaN(at)) return null;
  const ageDays = (now.getTime() - at) / 86_400_000;
  if (ageDays < -PLAUSIBLE_PURCHASE_DATE_WINDOW.maxFutureDays || ageDays > PLAUSIBLE_PURCHASE_DATE_WINDOW.maxPastDays) return null;
  return value;
}

/**
 * Wraps plausiblePurchaseDate() with the "was something rejected" signal a caller
 * needs to flag a receipt for review, distinct from Vision simply not reading a date
 * at all. Split out from parseReceiptImage (2026-09-14, Unit 4) so the parse-time
 * guard is unit-testable without a network call.
 */
export function resolvePurchaseDate(rawValue: unknown, now: Date = new Date()): { purchaseDate: string | null; purchaseDateRejected: boolean } {
  const purchaseDate = plausiblePurchaseDate(rawValue, now);
  const purchaseDateRejected = typeof rawValue === "string" && rawValue.length > 0 && purchaseDate === null;
  return { purchaseDate, purchaseDateRejected };
}

/** Round to the cent, avoiding binary-float artifacts like 792.8700000001. */
function centRound(value: number): number {
  return Math.round(value * 100) / 100;
}

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Unit 2 (2026-09-18, "the reader must reconcile, or say it could not"). Kyle:
 * "The material needs to be accurate according to what it is not deduced into
 * a total $ devided by number of line items." Nothing previously checked a
 * parse against the receipt's own printed arithmetic — that is how $579.24 of
 * parsed lines ended up sitting under a $495.24 total in production.
 *
 * Split out from parseReceiptImage so it is unit-testable without a network
 * call, same pattern as resolvePurchaseDate/plausiblePurchaseDate above.
 *
 * THE reconciliation check, and the only thing that decides `reconciled`:
 * every line has a lineTotal, a total was read, and (lines summed) + tax
 * equals that total to the cent. Anything short of that is NOT reconciled,
 * with a note recording exactly what didn't add up (or that there wasn't
 * enough on the receipt to check at all). Tax absent from the receipt is
 * treated as $0 for the check — the note says so when that assumption is
 * the reason for a mismatch, so a reviewer can tell "the math is wrong"
 * apart from "the tax line just wasn't read."
 *
 * Deliberately NOT part of this check: the printed subtotal. Correction,
 * 2026-09-18 — the real Home Depot order this Unit was built to catch
 * (#WH45461428) prints a PRE-discount subtotal ($792.87) alongside a
 * "You Saved $95.16" line; the line totals use the DISCOUNTED prices
 * ($792.87 − $95.16 = $697.71), and $697.71 + $68.03 tax = $765.74, the
 * printed total, to the cent. A subtotal that exceeds the line sum by a
 * printed discount is normal on a promotional order, not a data-quality
 * problem — requiring Σ(lines) == subtotal would have flagged this correct,
 * fully-reconciling receipt as broken. `discount` is still captured (see
 * ParsedReceipt) because it's a real number on the receipt, but nothing
 * here compares it against subtotal — that comparison would tell us
 * whether Vision transcribed the discount correctly, not whether the
 * receipt's OWN math (lines + tax = total) checks out, which is the only
 * question this function answers.
 */
export function reconcileParsedReceipt(parsed: {
  total: number | null;
  tax?: number | null;
  lineItems: Array<{ lineTotal?: number | null }>;
}): { reconciled: boolean; reconciliationNote: string | null } {
  if (parsed.total == null) {
    return { reconciled: false, reconciliationNote: "No total was read from the receipt — could not reconcile." };
  }
  if (parsed.lineItems.length === 0) {
    return { reconciled: false, reconciliationNote: "No line items were read from the receipt — could not reconcile against the total." };
  }
  const missingCount = parsed.lineItems.filter((li) => li.lineTotal == null).length;
  if (missingCount > 0) {
    return {
      reconciled: false,
      reconciliationNote: `${missingCount} of ${parsed.lineItems.length} line item(s) have no line total — could not reconcile against the receipt total.`,
    };
  }

  const sumLines = centRound(parsed.lineItems.reduce((acc, li) => acc + (li.lineTotal as number), 0));
  const taxKnown = parsed.tax != null;
  const effectiveTax = parsed.tax ?? 0;
  const computedTotal = centRound(sumLines + effectiveTax);
  const totalDiff = centRound(computedTotal - parsed.total);
  if (Math.abs(totalDiff) >= 0.01) {
    return {
      reconciled: false,
      reconciliationNote: `line items ($${money(sumLines)})${taxKnown ? ` + tax ($${money(effectiveTax)})` : " (tax was not read, assumed $0)"} = $${money(computedTotal)}, but the receipt total is $${money(parsed.total)} (off by $${money(Math.abs(totalDiff))})`,
    };
  }
  return { reconciled: true, reconciliationNote: null };
}

export async function parseReceiptImage(fileBuffer: Buffer, mimeType: string): Promise<ParsedReceipt | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[ReceiptVision] OPENAI_API_KEY not set — skipping vision parse.");
    return null;
  }

  const isPdf = mimeType === "application/pdf";
  const dataUrl = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
  // Unit 1 (2026-09-18): a PDF rides the SAME chat/completions call as a photo,
  // as a `file` content part instead of `image_url` — see the file-header
  // comment for the evidence this call shape is what the account's model
  // (gpt-4o-mini by default) actually accepts.
  const filePart = isPdf
    ? { type: "file" as const, file: { filename: "receipt.pdf", file_data: dataUrl } }
    : { type: "image_url" as const, image_url: { url: dataUrl, detail: "high" as const } };

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.RECEIPT_VISION_MODEL ?? "gpt-4o-mini",
        max_tokens: 1200,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: VISION_PROMPT }, filePart],
          },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      console.error("[ReceiptVision] OpenAI error:", res.status, await res.text());
      return null;
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<ParsedReceipt>;
    const category = ["materials", "gas", "maintenance", "overhead", "permit", "inspection"].includes(parsed.category ?? "")
      ? (parsed.category as ParsedReceipt["category"])
      : "overhead";
    const { purchaseDate, purchaseDateRejected } = resolvePurchaseDate(parsed.purchaseDate);

    const lineItems: ParsedReceiptLine[] = Array.isArray(parsed.lineItems)
      ? parsed.lineItems
          .filter((li): li is ParsedReceiptLine => typeof li === "object" && li !== null && typeof (li as { name?: unknown }).name === "string")
          .map((li) => ({
            name: li.name,
            qty: typeof li.qty === "number" ? li.qty : null,
            unit: typeof li.unit === "string" ? li.unit : null,
            unitCost: typeof li.unitCost === "number" ? li.unitCost : null,
            sku: typeof (li as { sku?: unknown }).sku === "string" ? (li as { sku: string }).sku : null,
            lineTotal: typeof (li as { lineTotal?: unknown }).lineTotal === "number" ? (li as { lineTotal: number }).lineTotal : null,
            partNumber: typeof (li as { partNumber?: unknown }).partNumber === "string" ? (li as { partNumber: string }).partNumber : null,
          }))
      : [];

    const total = typeof parsed.total === "number" ? parsed.total : null;
    // subtotal/discount are captured for display and are NOT passed into
    // reconcileParsedReceipt — see that function's header comment for why a
    // pre-discount subtotal must never gate `reconciled`.
    const subtotal = typeof parsed.subtotal === "number" ? parsed.subtotal : null;
    const discount = typeof parsed.discount === "number" ? parsed.discount : null;
    const tax = typeof parsed.tax === "number" ? parsed.tax : null;
    const { reconciled, reconciliationNote } = reconcileParsedReceipt({ total, tax, lineItems });

    return {
      vendor: typeof parsed.vendor === "string" ? parsed.vendor : null,
      total,
      purchaseDate,
      purchaseDateRejected,
      category,
      lineItems,
      subtotal,
      discount,
      tax,
      reconciled,
      reconciliationNote,
    };
  } catch (err) {
    console.error("[ReceiptVision] Parse failed:", err);
    return null;
  }
}
