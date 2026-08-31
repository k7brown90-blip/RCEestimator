/**
 * Full-screen photo viewer with real zoom (Kyle, 2026-08-31: "I need to be
 * able to select a photo and have it open into a big view on the screen so I
 * can accurately view and zoom into them. I am trying to look at the name
 * plate but can't see anything cause its too small.").
 *
 * Wheel zooms toward the cursor (so the nameplate under the pointer stays
 * under the pointer), drag pans when zoomed, double-click toggles 1× / 2.5×,
 * two-finger pinch works on touch screens, and +/− buttons cover the rest.
 * Esc, the × button, or clicking the backdrop closes it.
 *
 * Accepts either an authed `path` (fetched through the session, same as every
 * other protected image) or an already-resolved `src` object/data URL.
 */
import { useEffect, useRef, useState } from "react";
import { fetchProtectedObjectUrl } from "../lib/api";

const MIN_SCALE = 1;
const MAX_SCALE = 8;

export function PhotoLightbox({
  path,
  src,
  alt,
  caption,
  onClose,
}: {
  path?: string;
  src?: string;
  alt: string;
  caption?: string | null;
  onClose: () => void;
}) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(src ?? null);
  const [failed, setFailed] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  // Live pointer state — refs, not state: drag math must not re-render per move.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startDist: number; startScale: number } | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    if (src) return;
    let dead = false;
    let url: string | null = null;
    void fetchProtectedObjectUrl(path!)
      .then((u) => {
        url = u;
        if (!dead) setResolvedSrc(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => setFailed(true));
    return () => {
      dead = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, src]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Zoom keeping the container point (cx, cy) fixed under the cursor. */
  const zoomAt = (cx: number, cy: number, nextScale: number) => {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    setOffset((prev) => {
      const ratio = clamped / scale;
      const next = { x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio };
      return clamped === MIN_SCALE ? { x: 0, y: 0 } : next;
    });
    setScale(clamped);
  };

  const containerPoint = (e: { clientX: number; clientY: number }) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 };
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const p = containerPoint(e);
    zoomAt(p.x, p.y, scale * (e.deltaY < 0 ? 1.25 : 0.8));
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const p = containerPoint(e);
    zoomAt(p.x, p.y, scale > 1.01 ? 1 : 2.5);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { startDist: Math.hypot(a.x - b.x, a.y - b.y), startScale: scale };
    } else if (pointers.current.size === 1 && scale > 1) {
      dragging.current = true;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && gesture.current) {
      // Pinch: scale by the change in finger distance, centered between them.
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 };
      const p = containerPoint(mid);
      zoomAt(p.x, p.y, gesture.current.startScale * (dist / gesture.current.startDist));
    } else if (dragging.current) {
      setOffset((o) => ({ x: o.x + (e.clientX - prev.x), y: o.y + (e.clientY - prev.y) }));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    if (pointers.current.size === 0) dragging.current = false;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
      onClick={onClose}
      role="dialog"
      aria-label={`Photo viewer — ${alt}`}
    >
      {/* Controls row — stopPropagation so the buttons don't close the viewer. */}
      <div
        className="flex items-center justify-between gap-2 p-3 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="truncate text-sm text-white/80">{caption ?? alt}</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="rounded bg-white/15 px-3 py-1 text-lg leading-none hover:bg-white/25"
            onClick={() => zoomAt(0, 0, scale * 0.8)}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="w-12 text-center text-xs tabular-nums text-white/70">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className="rounded bg-white/15 px-3 py-1 text-lg leading-none hover:bg-white/25"
            onClick={() => zoomAt(0, 0, scale * 1.25)}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            className="rounded bg-white/15 px-2.5 py-1 text-xs hover:bg-white/25"
            onClick={() => {
              setScale(1);
              setOffset({ x: 0, y: 0 });
            }}
          >
            Fit
          </button>
          <button
            type="button"
            className="ml-2 rounded bg-white/15 px-3 py-1 text-lg leading-none hover:bg-white/25"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden"
        style={{ cursor: scale > 1 ? "grab" : "zoom-in" }}
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {failed && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
            Could not load this photo.
          </p>
        )}
        {!failed && !resolvedSrc && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
            Loading full-size photo…
          </p>
        )}
        {resolvedSrc && (
          <img
            src={resolvedSrc}
            alt={alt}
            draggable={false}
            className="absolute left-0 top-0 h-full w-full object-contain"
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transformOrigin: "center center",
            }}
          />
        )}
      </div>
      <p className="p-2 text-center text-[11px] text-white/50" onClick={(e) => e.stopPropagation()}>
        Scroll or pinch to zoom · drag to pan · double-click to toggle · Esc to close
      </p>
    </div>
  );
}
