/**
 * Draw-to-sign pad for the on-site customer acknowledgment (2026-08-24).
 *
 * Ported from the CRM's SignaturePad (client/src/components/SignaturePad.tsx),
 * which carries the three phone-canvas fixes this one keeps: device-pixel-ratio
 * scaling so the stroke is sharp in the PDF, touch-action:none so a finger drag
 * draws instead of scrolling, and pointer capture so a stroke that leaves the
 * canvas mid-signature stays connected.
 *
 * The one deliberate difference: the stroke is drawn on a WHITE canvas even
 * though the field app is dark-themed, because the PNG lands on a white report
 * page — a dark-background signature would print as a black box.
 */

import { useEffect, useRef, useState } from 'react'

export function SignaturePad(props: {
  /** Called with a PNG data URL, or null when the pad is cleared. */
  onChange: (dataUrl: string | null) => void
  disabled?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const [hasMark, setHasMark] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = Math.round(rect.width * ratio)
    canvas.height = Math.round(rect.height * ratio)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(ratio, ratio)
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#111'
  }, [])

  const pointAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (props.disabled) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const { x, y } = pointAt(e)
    ctx.beginPath()
    ctx.moveTo(x, y)
    drawing.current = true
  }

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    e.preventDefault()
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const { x, y } = pointAt(e)
    ctx.lineTo(x, y)
    ctx.stroke()
    if (!hasMark) setHasMark(true)
  }

  const end = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    drawing.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    const canvas = canvasRef.current
    if (canvas) props.onChange(canvas.toDataURL('image/png'))
  }

  const clear = () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    setHasMark(false)
    props.onChange(null)
  }

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label className="text-sm font-medium text-slate-200">Customer signs here</label>
        <button type="button" className="text-xs text-sky-300 underline" onClick={clear}>
          Clear
        </button>
      </div>
      <canvas
        ref={canvasRef}
        style={{ touchAction: 'none' }}
        className="mt-1 h-36 w-full rounded-lg border-2 border-dashed border-slate-500 bg-white"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={end}
      />
      <p className="mt-1 text-xs text-slate-400">
        {hasMark ? 'Signed above. Tap Clear to start again.' : 'Drawn with a finger or stylus.'}
      </p>
    </div>
  )
}
