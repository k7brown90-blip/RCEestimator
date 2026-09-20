/**
 * Unit 1 + Unit 2 (2026-09-18, "receipts read and cost accurately").
 *
 * Kyle: "The reader MUST read the lines from PDF's and photos alike... When I
 * asked to be able to upload pdf's I expected it to read the information same
 * as with the photo receipts. Do not take short cuts." And: "The material
 * needs to be accurate according to what it is not deduced into a total $
 * devided by number of line items."
 *
 * This file pins two things about src/services/receiptVision.ts:
 *
 *   1. A PDF rides the SAME OpenAI chat/completions call as a photo, as a
 *      `file` content part (not `image_url`) — never refused, never asked to
 *      have its amount typed instead.
 *   2. A parse is checked against its own printed arithmetic
 *      (reconcileParsedReceipt): every line needs a lineTotal, and
 *      Σ(line totals) + tax must equal the total to the cent — THAT is the
 *      whole check. The printed subtotal is deliberately NOT compared
 *      against the line sum: a promotional order (the real order this Unit
 *      was built around, Home Depot #WH45461428) prints a PRE-discount
 *      subtotal alongside a "You Saved $X" line, and the line totals use the
 *      discounted prices — subtotal - discount = Σ(lines) there, not
 *      subtotal = Σ(lines). Requiring the latter would flag a correctly
 *      reconciling discounted receipt as broken, which is the mistake this
 *      file's first draft made and this revision corrects.
 *
 * No network call is made: fetch is stubbed and every assertion is either on
 * the shape of the stubbed REQUEST or on parsing/reconciling a canned
 * RESPONSE. See the file header of receiptVision.ts for how the `file`
 * content-part shape was verified (OpenAI's own documentation — this
 * checkout has no OPENAI_API_KEY to make a live call with).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

import { parseReceiptImage, reconcileParsedReceipt, type ParsedReceipt } from "../src/services/receiptVision";
import {
  STAND_IN_LINES,
  STAND_IN_SUBTOTAL,
  STAND_IN_TAX,
  STAND_IN_TOTAL,
  STAND_IN_VENDOR,
} from "./fixtures/generateStandInReceipt";

process.env.OPENAI_API_KEY = "test-key-never-sent-to-openai";
delete process.env.RECEIPT_VISION_MODEL; // pin the default model for these assertions

const STAND_IN_PDF_PATH = path.join(__dirname, "fixtures", "home-depot-order-standin.pdf");
// The real order Kyle supplied in conversation — PO-2026-0021.pdf, Home Depot
// order #WH45461428. Committing it is approved but it may not have landed on
// disk yet (a permission rule blocked the copy). This test runs for real the
// moment the file appears at this path — it is not silently skipped in CI,
// it is conditionally REGISTERED, so its absence is visible in the test list
// rather than invisible.
const REAL_PDF_PATH = path.join(__dirname, "fixtures", "home-depot-order-WH45461428.pdf");
const hasRealFixture = (() => {
  try {
    readFileSync(REAL_PDF_PATH);
    return true;
  } catch {
    return false;
  }
})();

function openAiChatResponse(content: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function lastRequestBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("Unit 1 — a PDF is read through the same parser as a photo", () => {
  it("sends a PDF as a `file` content part, never `image_url`", async () => {
    const pdfBytes = readFileSync(STAND_IN_PDF_PATH);
    fetchMock.mockResolvedValueOnce(
      openAiChatResponse({
        vendor: STAND_IN_VENDOR,
        total: STAND_IN_TOTAL,
        subtotal: STAND_IN_SUBTOTAL,
        tax: STAND_IN_TAX,
        purchaseDate: null,
        category: "materials",
        lineItems: STAND_IN_LINES.map((l) => ({
          name: l.name,
          qty: l.qty,
          unit: "each",
          unitCost: l.unitCost,
          lineTotal: l.lineTotal,
          sku: null,
          partNumber: /\(([A-Z0-9]+)\)/.exec(l.name)?.[1] ?? null,
        })),
      }),
    );

    const result = await parseReceiptImage(pdfBytes, "application/pdf");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.openai.com/v1/chat/completions");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key-never-sent-to-openai");

    const body = lastRequestBody();
    expect(body.model).toBe("gpt-4o-mini");
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const parts = messages[0].content;
    const filePart = parts.find((p) => p.type === "file") as { file: { filename: string; file_data: string } } | undefined;
    expect(filePart, "expected a `file` content part for a PDF").toBeTruthy();
    expect(filePart!.file.filename).toMatch(/\.pdf$/);
    expect(filePart!.file.file_data).toBe(`data:application/pdf;base64,${pdfBytes.toString("base64")}`);
    // Never sent as an image_url — that field cannot carry a PDF.
    expect(parts.some((p) => p.type === "image_url")).toBe(false);

    // And the identical ParsedReceipt shape a photo produces:
    expect(result).not.toBeNull();
    expect(result!.vendor).toBe(STAND_IN_VENDOR);
    expect(result!.lineItems).toHaveLength(STAND_IN_LINES.length);
    expect(result!.lineItems[0].partNumber).toBe("HOM115CAFIC");
    expect(result!.lineItems[0].lineTotal).toBe(STAND_IN_LINES[0].lineTotal);
    expect(result!.subtotal).toBe(STAND_IN_SUBTOTAL);
    expect(result!.tax).toBe(STAND_IN_TAX);
    // Self-consistent stand-in numbers — this parse's own arithmetic checks out.
    expect(result!.reconciled).toBe(true);
    expect(result!.reconciliationNote).toBeNull();
  });

  it("still sends a photo as `image_url`, unchanged (Unit 1 must not regress the working path)", async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // minimal JPEG magic bytes
    fetchMock.mockResolvedValueOnce(
      openAiChatResponse({ vendor: null, total: null, subtotal: null, tax: null, purchaseDate: null, category: "overhead", lineItems: [] }),
    );

    await parseReceiptImage(jpegBytes, "image/jpeg");

    const body = lastRequestBody();
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const parts = messages[0].content;
    expect(parts.some((p) => p.type === "file")).toBe(false);
    const imagePart = parts.find((p) => p.type === "image_url") as { image_url: { url: string } } | undefined;
    expect(imagePart).toBeTruthy();
    expect(imagePart!.image_url.url).toBe(`data:image/jpeg;base64,${jpegBytes.toString("base64")}`);
  });
});

describe("Unit 2 — reconcileParsedReceipt (pure, no network)", () => {
  it("reconciles when line totals + tax equal the total to the cent", () => {
    const r = reconcileParsedReceipt({
      total: 33.0,
      tax: 3.0,
      lineItems: [{ lineTotal: 10.0 }, { lineTotal: 20.0 }],
    });
    expect(r).toEqual({ reconciled: true, reconciliationNote: null });
  });

  it("flags a mismatch and names the exact shortfall — the $579.24-lines-under-$495.24-total defect this Unit fixes", () => {
    const r = reconcileParsedReceipt({
      total: 495.24,
      tax: null,
      lineItems: [{ lineTotal: 200.0 }, { lineTotal: 379.24 }], // sums to 579.24
    });
    expect(r.reconciled).toBe(false);
    expect(r.reconciliationNote).toContain("579.24");
    expect(r.reconciliationNote).toContain("495.24");
    expect(r.reconciliationNote).toContain("84.00"); // the $ shortfall, so a reviewer isn't left doing the subtraction
  });

  it("says it could not reconcile when the total was never read — never assumes a total of 0", () => {
    const r = reconcileParsedReceipt({ total: null, tax: null, lineItems: [{ lineTotal: 10 }] });
    expect(r.reconciled).toBe(false);
    expect(r.reconciliationNote).toMatch(/no total/i);
  });

  it("says it could not reconcile when there are no line items", () => {
    const r = reconcileParsedReceipt({ total: 10, tax: null, lineItems: [] });
    expect(r.reconciled).toBe(false);
    expect(r.reconciliationNote).toMatch(/no line items/i);
  });

  it("says it could not reconcile when a line has no lineTotal — never fills it in with a guess", () => {
    const r = reconcileParsedReceipt({
      total: 30,
      tax: null,
      lineItems: [{ lineTotal: 10 }, { lineTotal: null }, { lineTotal: undefined }],
    });
    expect(r.reconciled).toBe(false);
    expect(r.reconciliationNote).toContain("2 of 3");
  });

  it("treats an unread tax as $0 and says so when that's why it doesn't reconcile", () => {
    const r = reconcileParsedReceipt({
      total: 35.0, // there WAS tax on the real receipt, but Vision didn't read it
      tax: null,
      lineItems: [{ lineTotal: 30.0 }],
    });
    expect(r.reconciled).toBe(false);
    expect(r.reconciliationNote).toMatch(/tax was not read, assumed \$0/i);
  });

  it("rounds away binary-float artifacts instead of flagging a false mismatch", () => {
    // 0.1 + 0.2 !== 0.3 in raw floating point — this must not misfire.
    const r = reconcileParsedReceipt({ total: 0.3, tax: 0, lineItems: [{ lineTotal: 0.1 }, { lineTotal: 0.2 }] });
    expect(r.reconciled).toBe(true);
  });

  it("correction (coordinator, 2026-09-18): a discounted receipt whose lines sum BELOW the printed subtotal by exactly a printed savings amount still reconciles true — subtotal is never part of the check", () => {
    // Shape of the real Home Depot order this Unit was built around: subtotal
    // is the PRE-discount sum, "You Saved $95.16" is printed separately, and
    // the line totals already reflect the discounted price actually charged.
    const r = reconcileParsedReceipt({
      total: 765.74,
      tax: 68.03,
      // Lines sum to 697.71 — well under the $792.87 subtotal — because the
      // subtotal is pre-discount. reconcileParsedReceipt doesn't even take a
      // subtotal parameter any more: it cannot be fooled by it.
      lineItems: [
        { lineTotal: 143.31 }, { lineTotal: 58.0 }, { lineTotal: 58.0 }, { lineTotal: 91.34 },
        { lineTotal: 214.0 }, { lineTotal: 14.59 }, { lineTotal: 14.59 }, { lineTotal: 103.88 },
      ],
    });
    expect(r).toEqual({ reconciled: true, reconciliationNote: null });
  });
});

describe("Unit 2 — parseReceiptImage wires reconciliation into a PDF parse end-to-end", () => {
  it("a PDF whose lines don't add up to the total comes back reconciled: false with a note (canned response)", async () => {
    fetchMock.mockResolvedValueOnce(
      openAiChatResponse({
        vendor: "Home Depot",
        total: 495.24,
        subtotal: 579.24,
        discount: null,
        tax: 0,
        purchaseDate: null,
        category: "materials",
        lineItems: [
          { name: "Item A (HOM111)", qty: 1, unit: "each", unitCost: 200, lineTotal: 200, sku: null, partNumber: "HOM111" },
          { name: "Item B (HOM222)", qty: 1, unit: "each", unitCost: 379.24, lineTotal: 379.24, sku: null, partNumber: "HOM222" },
        ],
      }),
    );

    const result = await parseReceiptImage(Buffer.from("%PDF-1.4 fake"), "application/pdf");

    expect(result).not.toBeNull();
    expect(result!.reconciled).toBe(false);
    expect(result!.reconciliationNote).toContain("579.24");
    expect(result!.reconciliationNote).toContain("495.24");
  });

  it("a discounted PDF (pre-discount subtotal + a printed 'You Saved' discount) reconciles true end-to-end, and `discount` is captured", async () => {
    fetchMock.mockResolvedValueOnce(
      openAiChatResponse({
        vendor: "The Home Depot",
        total: 765.74,
        subtotal: 792.87,
        discount: 95.16,
        tax: 68.03,
        purchaseDate: null,
        category: "materials",
        lineItems: [
          { name: "Item (HOM1)", qty: 1, unit: "each", unitCost: 143.31, lineTotal: 143.31, sku: null, partNumber: "HOM1" },
          { name: "Item (HOM2)", qty: 1, unit: "each", unitCost: 58.0, lineTotal: 58.0, sku: null, partNumber: "HOM2" },
          { name: "Item (HOM3)", qty: 1, unit: "each", unitCost: 58.0, lineTotal: 58.0, sku: null, partNumber: "HOM3" },
          { name: "Item (HOM4)", qty: 1, unit: "each", unitCost: 91.34, lineTotal: 91.34, sku: null, partNumber: "HOM4" },
          { name: "Item (HOM5)", qty: 1, unit: "each", unitCost: 214.0, lineTotal: 214.0, sku: null, partNumber: "HOM5" },
          { name: "Item (HOM6)", qty: 1, unit: "each", unitCost: 14.59, lineTotal: 14.59, sku: null, partNumber: "HOM6" },
          { name: "Item (HOM7)", qty: 1, unit: "each", unitCost: 14.59, lineTotal: 14.59, sku: null, partNumber: "HOM7" },
          { name: "Item (HOM8)", qty: 1, unit: "each", unitCost: 103.88, lineTotal: 103.88, sku: null, partNumber: "HOM8" },
        ],
      }),
    );

    const result = await parseReceiptImage(Buffer.from("%PDF-1.4 fake"), "application/pdf");

    expect(result).not.toBeNull();
    expect(result!.subtotal).toBe(792.87);
    expect(result!.discount).toBe(95.16);
    expect(result!.tax).toBe(68.03);
    expect(result!.total).toBe(765.74);
    // The subtotal ($792.87) does NOT equal the line sum ($697.71) — that is
    // expected on a discounted order and must not block reconciliation.
    expect(result!.reconciled).toBe(true);
    expect(result!.reconciliationNote).toBeNull();
  });
});

// The real order's 8 lines, in the order Kyle read them off the receipt, paired
// with their manufacturer part numbers. Sum verified by hand (and by the test
// below): 143.31 + 58.00 + 58.00 + 91.34 + 214.00 + 14.59 + 14.59 + 103.88 =
// 697.71; 697.71 + 68.03 tax = 765.74, the printed total, to the cent. The
// $792.87 "Subtotal" is PRE-discount (the receipt also prints "You Saved
// $95.16"; 792.87 - 95.16 = 697.71) — never compared against the line sum.
const REAL_ORDER_LINES = [
  { lineTotal: 143.31, partNumber: "HOM115CAFIC" },
  { lineTotal: 58.0, partNumber: "HOM115CP" },
  { lineTotal: 58.0, partNumber: "HOM120CP" },
  { lineTotal: 91.34, partNumber: "HOM120GFICP" },
  { lineTotal: 214.0, partNumber: "HOM3060M200PCVP" },
  { lineTotal: 14.59, partNumber: "HOM240CP" },
  { lineTotal: 14.59, partNumber: "HOM250CP" },
  { lineTotal: 103.88, partNumber: "HOM2175SB" },
];
const REAL_ORDER_SUBTOTAL = 792.87;
const REAL_ORDER_DISCOUNT = 95.16;
const REAL_ORDER_TAX = 68.03;
const REAL_ORDER_TOTAL = 765.74;

describe.runIf(hasRealFixture)("Unit 1 — the REAL PO-2026-0021.pdf (order #WH45461428)", () => {
  it("sums to 697.71 — sanity check on the figures this test cans", () => {
    const sum = REAL_ORDER_LINES.reduce((acc, l) => acc + l.lineTotal, 0);
    expect(Math.round(sum * 100) / 100).toBe(697.71);
    expect(Math.round((REAL_ORDER_SUBTOTAL - REAL_ORDER_DISCOUNT) * 100) / 100).toBe(697.71);
  });

  it("sends the real PDF bytes as a `file` part and reconciles true against Kyle's own reported figures", async () => {
    const realBytes = readFileSync(REAL_PDF_PATH);
    // Canned to the real order's actual figures (corrected 2026-09-18 — the
    // discount was missed on the first pass, see the describe-block header
    // comment). 8 lines, discounted line prices summing to $697.71, tax
    // $68.03, total $765.74: 697.71 + 68.03 = 765.74 to the cent. This MUST
    // reconcile true — a discounted Home Depot order is not a data-quality
    // problem.
    fetchMock.mockResolvedValueOnce(
      openAiChatResponse({
        vendor: "The Home Depot",
        total: REAL_ORDER_TOTAL,
        subtotal: REAL_ORDER_SUBTOTAL,
        discount: REAL_ORDER_DISCOUNT,
        tax: REAL_ORDER_TAX,
        purchaseDate: null,
        category: "materials",
        lineItems: REAL_ORDER_LINES.map((l, i) => ({
          name: `Order WH45461428 item ${i + 1} (${l.partNumber})`,
          qty: 1,
          unit: "each",
          unitCost: l.lineTotal,
          lineTotal: l.lineTotal,
          sku: null,
          partNumber: l.partNumber,
        })),
      }),
    );

    const result = await parseReceiptImage(realBytes, "application/pdf");
    const body = lastRequestBody();
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const filePart = messages[0].content.find((p) => p.type === "file") as { file: { file_data: string } };
    expect(filePart.file.file_data).toBe(`data:application/pdf;base64,${realBytes.toString("base64")}`);

    expect(result).not.toBeNull();
    expect(result!.lineItems).toHaveLength(8);
    expect(result!.lineItems.map((l) => l.partNumber).sort()).toEqual(
      [...REAL_ORDER_LINES.map((l) => l.partNumber)].sort(),
    );
    expect(result!.total).toBe(REAL_ORDER_TOTAL);
    expect(result!.subtotal).toBe(REAL_ORDER_SUBTOTAL);
    expect(result!.discount).toBe(REAL_ORDER_DISCOUNT);
    expect(result!.tax).toBe(REAL_ORDER_TAX);
    expect(result!.reconciled).toBe(true);
    expect(result!.reconciliationNote).toBeNull();
  });
});

if (!hasRealFixture) {
  // Not a skip — a visible marker in the test list that the real fixture is
  // still absent, per the dispatch: "clearly marked, not silently skipped."
  it.todo(`real fixture not present at tests/fixtures/home-depot-order-WH45461428.pdf — the test above (guarded by describe.runIf) will run automatically once it is added`);
}
