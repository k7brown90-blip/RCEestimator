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
  lineItems: Array<{ name: string; qty: number | null; unit: string | null; unitCost: number | null }>;
}

const VISION_PROMPT = `You are a receipt-processing assistant for an electrical contractor.
Extract the following from the receipt image and reply with ONLY a JSON object (no markdown):
{
  "vendor": string | null,          // store/supplier name
  "total": number | null,           // grand total incl. tax
  "purchaseDate": string | null,    // YYYY-MM-DD if visible
  "category": "materials" | "gas" | "maintenance" | "overhead" | "permit" | "inspection",
  "lineItems": [{ "name": string, "qty": number | null, "unit": string | null, "unitCost": number | null }]
}
Category guidance: electrical supply houses / hardware stores => "materials"; fuel stations => "gas";
vehicle or tool service => "maintenance"; a city/county permit fee => "permit"; an electrical
inspection fee => "inspection"; anything else => "overhead".
If the image is not a receipt, reply with {"vendor":null,"total":null,"purchaseDate":null,"category":"overhead","lineItems":[]}.`;

/**
 * Vision reads receipt dates loosely — Kyle's 2026-09-08 captures came back
 * dated 2022-09-08 (the year misread). A purchase date is only trusted when it
 * is a real YYYY-MM-DD within the last 400 days and not in the future;
 * otherwise the receipt keeps its upload time, which is at worst days off.
 */
export function plausiblePurchaseDate(value: unknown, now: Date = new Date()): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T12:00:00Z`).getTime();
  if (Number.isNaN(at)) return null;
  const ageDays = (now.getTime() - at) / 86_400_000;
  return ageDays < -1 || ageDays > 400 ? null : value;
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

    return {
      vendor: typeof parsed.vendor === "string" ? parsed.vendor : null,
      total: typeof parsed.total === "number" ? parsed.total : null,
      purchaseDate: plausiblePurchaseDate(parsed.purchaseDate),
      category,
      lineItems: Array.isArray(parsed.lineItems)
        ? parsed.lineItems
            .filter((li): li is ParsedReceipt["lineItems"][0] => typeof li === "object" && li !== null && typeof (li as { name?: unknown }).name === "string")
            .map((li) => ({
              name: li.name,
              qty: typeof li.qty === "number" ? li.qty : null,
              unit: typeof li.unit === "string" ? li.unit : null,
              unitCost: typeof li.unitCost === "number" ? li.unitCost : null,
            }))
        : [],
    };
  } catch (err) {
    console.error("[ReceiptVision] Parse failed:", err);
    return null;
  }
}
