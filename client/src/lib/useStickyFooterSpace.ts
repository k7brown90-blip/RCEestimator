import { useEffect, useRef, useState } from "react";

/**
 * Reserve exactly as much room as a fixed bottom bar actually occupies.
 *
 * Kyle, 2026-08-21: *"I need the ui fixed. I can't see or present any options."*
 *
 * ── WHY THIS IS MEASURED AND NOT A PADDING CLASS ───────────────────────────────────────────────
 *
 * The presentation and intake screens both pin a summary bar to the bottom of the viewport, and
 * both used a hardcoded `pb-24` / `pb-28` to keep content clear of it. That number was wrong the
 * moment the bar grew — and it grows constantly: a second option adds a subtotal row, an unpriced
 * line adds a warning, a long selection wraps onto two lines. Every one of those hid the bottom of
 * the list behind the bar, which is the failure Kyle hit.
 *
 * A ResizeObserver on the bar itself cannot drift. The bar reports its own height and the page
 * reserves that much, whatever it happens to be this render.
 *
 * ── AND WHY THE BAR SITS ABOVE THE NAV, NOT ON IT ──────────────────────────────────────────────
 *
 * The mobile nav is its own fixed element at bottom-0. A summary bar also at bottom-0 lands
 * underneath it. Callers pair this hook with `bottom-20 md:bottom-0` — clear of the nav on a
 * phone, flush to the bottom on desktop where the nav is hidden.
 */
export function useStickyFooterSpace<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setHeight(el.offsetHeight);
    measure();
    // Observed rather than measured once: the bar's height changes with its contents, not with
    // navigation, so an effect that only runs on mount would be correct exactly once.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * `ref` goes on the fixed bar. `spacerHeight` goes on a plain div rendered NEXT TO it, in normal
   * flow — that is what actually holds the page open.
   *
   * Reserving the space next to the bar rather than as padding on the page means the bar owns its
   * own footprint. The two screens that use this keep their bar in a child component, and a page
   * that has to be told how much padding to leave is a page that will be told wrongly.
   *
   * The 16 is breathing room so the last row does not sit flush against the bar.
   */
  return { ref, spacerHeight: height + 16 };
}
