/**
 * Receipt vision parsing — extracts structured data from a receipt photo via
 * the OpenAI Vision API. Used by both the tech-PWA receipt upload and the
 * Twilio MMS webhook. Degrades gracefully: when OPENAI_API_KEY is missing or
 * parsing fails, returns null and the caller stores the receipt for manual
 * review instead.
 */

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
  lineItems: Array<{ name: string; qty: number | null; unit: string | null; unitCost: number | null; sku?: string | null }>;
  // `purchaseDateRejected` added 2026-09-14 (legacy purchase close-out, Unit 4). True only when
  // Vision returned a purchaseDate string that plausiblePurchaseDate() then rejected as
  // implausible (see PLAUSIBLE_PURCHASE_DATE_WINDOW below) — distinct from Vision simply not
  // reading a date at all. Nullable and additive, same shape as `sku`: a caller that ignores it
  // gets the pre-2026-09-14 behavior unchanged. Callers use it to keep a receipt in
  // "pending_review" instead of auto-confirming one whose date could not be trusted.
  purchaseDateRejected?: boolean;
}

const VISION_PROMPT = `You are a receipt-processing assistant for an electrical contractor.
Extract the following from the receipt image and reply with ONLY a JSON object (no markdown):
{
  "vendor": string | null,          // store/supplier name
  "total": number | null,           // grand total incl. tax
  "purchaseDate": string | null,    // YYYY-MM-DD if visible
  "category": "materials" | "gas" | "maintenance" | "overhead" | "permit" | "inspection",
  "lineItems": [{ "name": string, "qty": number | null, "unit": string | null, "unitCost": number | null, "sku": string | null }]
}
Most box-store receipts (Home Depot, Lowe's) print a SKU or item/model number beside each line —
capture it in "sku" exactly as printed (digits, may include letters) when visible; use null when
there is none or it cannot be read reliably. Do not guess a SKU.
Category guidance: electrical supply houses / hardware stores => "materials"; fuel stations => "gas";
vehicle or tool service => "maintenance"; a city/county permit fee => "permit"; an electrical
inspection fee => "inspection"; anything else => "overhead".
If the image is not a receipt, reply with {"vendor":null,"total":null,"purchaseDate":null,"category":"overhead","lineItems":[]}.`;

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

export async function parseReceiptImage(imageBuffer: Buffer, mimeType: string): Promise<ParsedReceipt | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[ReceiptVision] OPENAI_API_KEY not set — skipping vision parse.");
    return null;
  }

  const dataUrl = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.RECEIPT_VISION_MODEL ?? "gpt-4o-mini",
        max_tokens: 800,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: VISION_PROMPT },
              { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
            ],
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

    return {
      vendor: typeof parsed.vendor === "string" ? parsed.vendor : null,
      total: typeof parsed.total === "number" ? parsed.total : null,
      purchaseDate,
      purchaseDateRejected,
      category,
      lineItems: Array.isArray(parsed.lineItems)
        ? parsed.lineItems
            .filter((li): li is ParsedReceipt["lineItems"][0] => typeof li === "object" && li !== null && typeof (li as { name?: unknown }).name === "string")
            .map((li) => ({
              name: li.name,
              qty: typeof li.qty === "number" ? li.qty : null,
              unit: typeof li.unit === "string" ? li.unit : null,
              unitCost: typeof li.unitCost === "number" ? li.unitCost : null,
              sku: typeof (li as { sku?: unknown }).sku === "string" ? (li as { sku: string }).sku : null,
            }))
        : [],
    };
  } catch (err) {
    console.error("[ReceiptVision] Parse failed:", err);
    return null;
  }
}
