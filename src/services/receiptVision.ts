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
  category: "materials" | "gas" | "maintenance" | "overhead";
  lineItems: Array<{ name: string; qty: number | null; unit: string | null; unitCost: number | null }>;
}

const VISION_PROMPT = `You are a receipt-processing assistant for an electrical contractor.
Extract the following from the receipt image and reply with ONLY a JSON object (no markdown):
{
  "vendor": string | null,          // store/supplier name
  "total": number | null,           // grand total incl. tax
  "purchaseDate": string | null,    // YYYY-MM-DD if visible
  "category": "materials" | "gas" | "maintenance" | "overhead",
  "lineItems": [{ "name": string, "qty": number | null, "unit": string | null, "unitCost": number | null }]
}
Category guidance: electrical supply houses / hardware stores => "materials"; fuel stations => "gas";
vehicle or tool service => "maintenance"; anything else => "overhead".
If the image is not a receipt, reply with {"vendor":null,"total":null,"purchaseDate":null,"category":"overhead","lineItems":[]}.`;

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
    const category = ["materials", "gas", "maintenance", "overhead"].includes(parsed.category ?? "")
      ? (parsed.category as ParsedReceipt["category"])
      : "overhead";

    return {
      vendor: typeof parsed.vendor === "string" ? parsed.vendor : null,
      total: typeof parsed.total === "number" ? parsed.total : null,
      purchaseDate: typeof parsed.purchaseDate === "string" ? parsed.purchaseDate : null,
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
