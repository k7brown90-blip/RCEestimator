/**
 * The drawn signature is the first image this app accepts from outside.
 *
 * Kyle, 2026-08-20: *"I want the signiture to be drawn not typed."*
 *
 * These bytes arrive from a customer's browser on a token-authenticated public route, are stored,
 * and are then embedded into a PDF filed as the record of acceptance. So the checks matter more
 * than their size suggests, and each of these tests is a specific way it could go wrong.
 */

import { describe, expect, it } from "vitest";
import { checkSignatureImage, MAX_SIGNATURE_BYTES } from "../src/services/signatureImage";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG-shaped payload of a given size. Real enough for every check this module makes. */
function pngDataUrl(bytes = 1200): string {
  const body = Buffer.concat([PNG_HEADER, Buffer.alloc(Math.max(0, bytes - 8), 0x42)]);
  return `data:image/png;base64,${body.toString("base64")}`;
}

describe("a real signature is accepted", () => {
  it("takes a PNG data URL and returns it unchanged", () => {
    // Unchanged matters: re-encoding would mean the stored bytes are not the bytes the customer
    // made, and being exactly that is the entire value of the record.
    const url = pngDataUrl();
    const result = checkSignatureImage(url);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dataUrl).toBe(url);
    expect(result.bytes).toBe(1200);
  });
});

describe("what is refused", () => {
  it("refuses nothing at all", () => {
    for (const empty of [undefined, null, "", 0]) {
      const r = checkSignatureImage(empty);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/draw your signature/i);
    }
  });

  it("refuses an SVG wearing a PNG label", () => {
    // The declared media type is a claim; the magic bytes are the fact. An SVG is a document that
    // can carry script, and this one would be embedded in a PDF and served back to whoever opens
    // the signed record.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const r = checkSignatureImage(`data:image/png;base64,${svg.toString("base64")}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/must be a PNG/i);
  });

  it("refuses a JPEG, even a genuine one", () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1000)]);
    expect(checkSignatureImage(`data:image/png;base64,${jpeg.toString("base64")}`).ok).toBe(false);
  });

  it("refuses another scheme entirely", () => {
    expect(checkSignatureImage("https://example.com/signature.png").ok).toBe(false);
    expect(checkSignatureImage("data:text/html;base64,PGgxPmhp").ok).toBe(false);
  });

  it("refuses base64 that does not decode cleanly", () => {
    // Buffer.from is forgiving — it drops characters it does not recognise instead of throwing —
    // so a pattern check would pass rubbish straight through. Round-tripping is what catches it.
    const r = checkSignatureImage("data:image/png;base64,!!!!not really base64!!!!");
    expect(r.ok).toBe(false);
  });

  it("refuses an image too large to be a signature", () => {
    // A megabyte is a photograph or an attempt to fill the disk one estimate at a time.
    const huge = pngDataUrl(MAX_SIGNATURE_BYTES + 1024);
    const r = checkSignatureImage(huge);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too large/i);
  });

  it("refuses a blank canvas", () => {
    // Someone who tapped Accept without drawing has not signed, and a record saying they did
    // would be worse than no record at all.
    const r = checkSignatureImage(pngDataUrl(40));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/draw your signature/i);
  });
});

describe("what is deliberately NOT judged", () => {
  it("accepts a mark that looks nothing like a name", () => {
    // It is a mark made by a person agreeing to something. The app has no business deciding
    // whether it is a good one, and a rejection here would block a real customer mid-signature.
    expect(checkSignatureImage(pngDataUrl(300)).ok).toBe(true);
  });
});
