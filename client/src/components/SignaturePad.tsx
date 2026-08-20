/**
 * Draw your signature. (2026-08-20)
 *
 * Kyle: *"I want the signiture to be drawn not typed."*
 *
 * ── WHAT MAKES THIS FIDDLY, AND WHY IT IS WORTH GETTING RIGHT ──────────────────────────────────
 *
 * This runs on a phone held out to a customer at their kitchen table. Three things break a naive
 * canvas there, and all three are handled:
 *
 *   * **Device pixel ratio.** A canvas sized in CSS pixels renders blurry on any modern phone.
 *     The backing store is scaled by `devicePixelRatio` and the context scaled to match, so the
 *     stroke is sharp on the screen and in the PDF it ends up inside.
 *   * **Scrolling.** A finger dragged across a canvas scrolls the page unless the browser is told
 *     otherwise. `touch-action: none` on the element, plus `preventDefault`, keeps the stroke on
 *     the canvas instead of moving the page under it.
 *   * **Pointer capture.** A signature that leaves the canvas mid-stroke — which happens
 *     constantly on a small screen — would otherwise stop dead. Capturing the pointer keeps the
 *     stroke connected until the finger lifts.
 *
 * The canvas is exported as a PNG data URL. It is validated server-side by
 * `services/signatureImage.ts`; nothing here is trusted.
 */

import { useEffect, useRef, useState } from "react";

export function SignaturePad(props: {
  /** Called with a PNG data URL, or null when the pad is cleared. */
  onChange: (dataUrl: string | null) => void;
  disabled?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasMark, setHasMark] = useState(false);

  // Size the backing store to the device, once the element has a layout width.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111";
  }, []);

  const pointAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (props.disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = pointAt(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    drawing.current = true;
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = pointAt(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!hasMark) setHasMark(true);
  };

  const end = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const canvas = canvasRef.current;
    if (canvas) props.onChange(canvas.toDataURL("image/png"));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasMark(false);
    props.onChange(null);
  };

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label className="text-sm font-semibold text-rce-text">Sign here</label>
        <button type="button" className="text-xs text-rce-soft underline" onClick={clear}>
          Clear
        </button>
      </div>
      <canvas
        ref={canvasRef}
        // touch-action:none is what stops a finger-drag scrolling the page instead of drawing.
        style={{ touchAction: "none" }}
        className="mt-1 h-40 w-full rounded-lg border-2 border-dashed border-rce-border bg-white"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={end}
      />
      <p className="mt-1 text-xs text-rce-soft">
        {hasMark ? "Signed above. Tap Clear to start again." : "Draw your signature with a finger or stylus."}
      </p>
    </div>
  );
}
