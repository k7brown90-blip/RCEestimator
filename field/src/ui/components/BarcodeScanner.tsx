/**
 * Live camera barcode scanning (barcode/materials plan Unit 3, 2026-09-12).
 *
 * Native BarcodeDetector when the browser has one; @zxing/browser (bundled fallback,
 * lib/barcodeScan.ts explains the choice) otherwise. Both paths read the same <video>
 * element and report through the same `onDetected` callback, so this component is the only
 * place that needs to know which is running.
 *
 * Speed budget (Kyle, 2026-09-12: "I am in the middle of projects... that needs done same
 * day"): the FIRST detected code fires `onDetected` immediately — no confirm step, no "is
 * this right?" dialog. The caller decides what happens next; a bad read is fixed by
 * scanning again or typing the code, not by a modal that has to be dismissed first.
 */

import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { NotFoundException } from '@zxing/library'
import { createNativeDetector, hasNativeBarcodeDetector, type BarcodeDetection } from '../../lib/barcodeScan'

export function BarcodeScanner({
  onDetected,
  onCancel,
}: {
  onDetected: (detection: BarcodeDetection) => void
  onCancel: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  // Guards against a second onDetected firing while the caller is still handling the first
  // (e.g. adding the line and closing the scanner) — the stream is torn down on unmount, but
  // that's asynchronous, and a frame already in flight can still resolve in the meantime.
  const firedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let rafId: number | null = null
    let zxingControls: { stop: () => void } | null = null

    const report = (detection: BarcodeDetection) => {
      if (cancelled || firedRef.current) return
      firedRef.current = true
      onDetected(detection)
    }

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()

        if (hasNativeBarcodeDetector()) {
          const detector = await createNativeDetector()
          const loop = async () => {
            if (cancelled || firedRef.current) return
            try {
              const results = await detector.detect(video)
              if (results[0]) {
                report(results[0])
                return
              }
            } catch {
              // A decode miss on one frame (motion blur, out of frame, bad angle) is the
              // normal case while scanning — keep trying rather than surfacing an error.
            }
            rafId = requestAnimationFrame(() => void loop())
          }
          void loop()
        } else {
          const reader = new BrowserMultiFormatReader()
          const controls = await reader.decodeFromVideoElement(video, (result, err) => {
            if (result) {
              report({ code: result.getText(), format: String(result.getBarcodeFormat()) })
            } else if (err && !(err instanceof NotFoundException)) {
              // NotFoundException is zxing's "nothing in frame this tick" — not an error.
              // Anything else (a real decode fault) is surfaced but never thrown; the tech
              // can still type the code, so this never blocks the purchase.
              setError(err.message)
            }
          })
          zxingControls = controls
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Camera unavailable — type the code instead.')
      }
    }
    void start()

    return () => {
      cancelled = true
      if (rafId != null) cancelAnimationFrame(rafId)
      zxingControls?.stop()
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [onDetected])

  return (
    <div className="space-y-2 rounded-lg border border-slate-600 bg-black p-2">
      <video ref={videoRef} className="w-full rounded" muted playsInline />
      {error && <p className="text-xs text-red-300">{error}</p>}
      <button
        type="button"
        onClick={onCancel}
        className="w-full rounded-lg border border-slate-600 p-2 text-xs text-slate-200"
      >
        Cancel scan
      </button>
    </div>
  )
}
