/**
 * Validating a drawn signature. (2026-08-20)
 *
 * Kyle: *"I want the signiture to be drawn not typed."*
 *
 * ── WHY THIS IS ITS OWN FILE WITH ITS OWN TESTS ────────────────────────────────────────────────
 *
 * This is the first time the app accepts an IMAGE from outside and puts it somewhere durable. The
 * bytes arrive from a customer's browser on a public, token-authenticated route, are written to
 * the database, and are later embedded in a PDF that gets filed as a legal record of acceptance.
 * Three places to get it wrong, so the checking happens once, here, before any of them.
 *
 * What is enforced:
 *
 *   * **PNG only, declared and actual.** The data URL must say PNG *and* the decoded bytes must
 *     begin with the PNG signature. A caller could otherwise send `data:image/png` with an SVG
 *     body — and an SVG is a document that can carry script, not a picture.
 *   * **A size ceiling.** A signature is a few kilobytes of strokes. A megabyte is not a
 *     signature, it is either a photograph or an attempt to fill the disk one estimate at a time.
 *   * **Base64 that actually decodes**, checked by round-tripping rather than by pattern.
 *
 * What is deliberately NOT enforced: that the drawing looks like a name. It is a mark made by a
 * person agreeing to something, and the app has no business judging whether it is a good one.
 */

/** A signature is strokes, not a photo. 256 KB is generous for the former and far below the latter. */
export const MAX_SIGNATURE_BYTES = 256 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PREFIX = "data:image/png;base64,";

export type SignatureCheck =
  | { ok: true; dataUrl: string; bytes: number }
  | { ok: false; reason: string };

/**
 * Check a drawn signature and hand back the value to store.
 *
 * Returns the ORIGINAL data URL on success rather than a re-encoded one: re-encoding would mean
 * the stored bytes are not the bytes that were signed, and the whole value of this record is that
 * it is what the customer made.
 */
export function checkSignatureImage(raw: unknown): SignatureCheck {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "Please draw your signature before accepting." };
  }
  if (!raw.startsWith(PREFIX)) {
    return { ok: false, reason: "The signature must be a PNG image." };
  }

  const base64 = raw.slice(PREFIX.length);
  // Cheap length gate first: base64 is 4/3 of the byte count, so this rejects an oversized
  // payload without decoding it into memory.
  if ((base64.length * 3) / 4 > MAX_SIGNATURE_BYTES) {
    return { ok: false, reason: "That signature image is too large." };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return { ok: false, reason: "The signature could not be read." };
  }

  // Buffer.from is famously forgiving — it ignores characters it does not recognise rather than
  // throwing. Round-tripping is what actually establishes that the input was valid base64.
  if (bytes.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) {
    return { ok: false, reason: "The signature could not be read." };
  }

  if (bytes.length > MAX_SIGNATURE_BYTES) {
    return { ok: false, reason: "That signature image is too large." };
  }

  // The declared type is a claim; this is the fact. An SVG body behind a PNG label is a script
  // vector, and it would be embedded into a PDF and served back to whoever opens the record.
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    return { ok: false, reason: "The signature must be a PNG image." };
  }

  // A blank canvas encodes to a very small PNG. Someone who tapped Accept without drawing has not
  // signed, and a record saying they did would be worse than no record.
  if (bytes.length < 200) {
    return { ok: false, reason: "Please draw your signature before accepting." };
  }

  return { ok: true, dataUrl: raw, bytes: bytes.length };
}

/** The decoded PNG, for embedding. Callers must have validated first. */
export function signatureBuffer(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(PREFIX.length), "base64");
}
