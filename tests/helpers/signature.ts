/**
 * A valid drawn signature, for tests that need to sign something.
 *
 * From 2026-08-20 a signature must be DRAWN (Kyle: *"I want the signiture to be drawn not
 * typed"*), so every test that signs an estimate has to supply one. Fifteen tests failed the
 * moment that rule landed — correctly: they were signing without a mark, which is exactly what
 * the rule forbids.
 *
 * This is a real PNG, not a stub. `services/signatureImage.ts` checks the magic bytes rather than
 * the declared media type, so a fake would be refused here just as it would in production — which
 * is the point of checking the bytes.
 */

/** The 8-byte PNG signature, followed by enough body to clear the blank-canvas floor. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(1200, 0x42),
]);

export const TEST_SIGNATURE = `data:image/png;base64,${PNG.toString("base64")}`;

/** Sign input with a valid drawing already attached. */
export function signedBy(name: string) {
  return { signerName: name, signatureImage: TEST_SIGNATURE };
}
