/**
 * Barcode decoding (barcode/materials plan Unit 3, 2026-09-12).
 *
 * Prefers the browser-native `BarcodeDetector` API — zero dependency, hardware-accelerated
 * where it exists (Chrome/Edge on Android and desktop as of this writing). Support is not
 * universal — no Firefox, no Safari — so a bundled fallback is required.
 *
 * FALLBACK CHOICE: @zxing/browser (wrapping @zxing/library). Chosen over html5-qrcode and
 * Quagga2 because it's pure JS/TS with no WASM or worker setup to wire into the Vite/PWA
 * build, it decodes straight from a <video> element (matching the native-detector code path
 * one-for-one so the calling UI never has to know which is running), and it covers every
 * symbology this unit needs out of the box — UPC-A, UPC-E, EAN-13, EAN-8, Code128, Code39 —
 * which is what actually appears on a supply-house package barcode (Kyle: "the same barcode
 * that gets scanned to purchase the item"). It is actively maintained and is the most-used
 * pure-JS barcode reader in the npm ecosystem, so it is unlikely to bit-rot under a PWA that
 * gets updated far less often than the CRM.
 */

export interface BarcodeDetection {
  code: string
  format: string
}

/** True when this browser exposes a native, usable BarcodeDetector. */
export function hasNativeBarcodeDetector(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window
}

/** The package-barcode symbologies this app cares about — not QR/Aztec/PDF417 etc. */
export const PACKAGE_BARCODE_FORMATS = [
  'upc_a', 'upc_e', 'ean_13', 'ean_8', 'code_128', 'code_39', 'code_93', 'itf', 'codabar',
] as const

export interface NativeDetector {
  detect: (source: CanvasImageSource) => Promise<BarcodeDetection[]>
}

/**
 * Build a native BarcodeDetector scoped to PACKAGE_BARCODE_FORMATS. Falls back to the full
 * list if `getSupportedFormats` throws or reports none of them supported — better to ask for
 * a format the device doesn't have than to construct a detector with an empty list, which
 * throws.
 */
export async function createNativeDetector(): Promise<NativeDetector> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Detector = (window as any).BarcodeDetector
  let formats: readonly string[] = PACKAGE_BARCODE_FORMATS
  try {
    const supported: string[] = await Detector.getSupportedFormats()
    const narrowed = PACKAGE_BARCODE_FORMATS.filter((f) => supported.includes(f))
    if (narrowed.length > 0) formats = narrowed
  } catch {
    // getSupportedFormats is optional per spec — the unfiltered list is still a valid try.
  }
  const detector = new Detector({ formats: [...formats] })
  return {
    detect: async (source) => {
      const results: { rawValue: string; format: string }[] = await detector.detect(source)
      return results.map((r) => ({ code: r.rawValue, format: r.format }))
    },
  }
}
