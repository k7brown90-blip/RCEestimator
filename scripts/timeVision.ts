/**
 * Times the OpenAI Vision call that sits on the receipt-upload request path.
 *
 * Why this exists: PUT /health-record/receipts/:receiptId awaits
 * parseReceiptImage inline whenever amount or vendor is absent
 * (src/routes/health-record.ts:1835), and the field app's PO receipt panel
 * sends neither. So this number IS the floor on that request's duration, on
 * top of however long the phone took to upload the bytes.
 *
 * Usage (from app/, so .env resolves):
 *   npx tsx --env-file=.env scripts/timeVision.ts <path-to-receipt.jpg> [runs]
 *
 * --env-file is Node's own loader: the key reaches the process without this
 * script reading or printing app/.env.
 */

import { readFileSync } from "node:fs";
import { parseReceiptImage } from "../src/services/receiptVision";

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.error("Usage: npx tsx --env-file=.env scripts/timeVision.ts <image> [runs]");
    process.exit(1);
  }
  const runs = Math.max(1, Math.min(Number(process.argv[3] ?? 3), 10));

  const img = readFileSync(imagePath);
  const mb = img.length / 1_048_576;
  const b64mb = img.toString("base64").length / 1_048_576;

  console.log(`image:  ${imagePath}`);
  console.log(`bytes:  ${mb.toFixed(2)} MB on disk -> ${b64mb.toFixed(2)} MB as the base64 data URL sent to OpenAI`);
  console.log(`model:  ${process.env.RECEIPT_VISION_MODEL ?? "gpt-4o-mini"} (detail: high)`);
  console.log(`key:    ${process.env.OPENAI_API_KEY ? "present" : "MISSING — parseReceiptImage will return null instantly"}`);
  console.log();

  const times: number[] = [];
  for (let i = 1; i <= runs; i++) {
    const t0 = performance.now();
    const parsed = await parseReceiptImage(img, "image/jpeg");
    const ms = performance.now() - t0;
    times.push(ms);
    console.log(
      `run ${i}: ${(ms / 1000).toFixed(2)} s   vendor=${parsed?.vendor ?? "null"}  total=${parsed?.total ?? "null"}  lines=${parsed?.lineItems.length ?? 0}`,
    );
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(
    `\nmin ${(Math.min(...times) / 1000).toFixed(2)}s   avg ${(avg / 1000).toFixed(2)}s   max ${(Math.max(...times) / 1000).toFixed(2)}s`,
  );
  console.log(
    `\nDecision rule (plan 2026-09-12): under ~2s average means the inline call is not the`,
  );
  console.log(`trigger and Unit 2 is dropped. Over means Unit 2 stays.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
