/**
 * Who owns Escape, and who holds the body still — shared by Modal and Drawer.
 *
 * ── WHY A STACK ─────────────────────────────────────────────────────────────────────────────
 *
 * Before drawers there was one overlay at a time, so `Modal` could listen on `window` for
 * Escape and be sure it was the thing being dismissed. A drawer holds a record's whole action
 * set, and some of those actions open a Modal (Mark Lost, the duplicate-account picker) or a
 * second drawer (a P.O. from the job it belongs to). Two window listeners would both fire on
 * one keypress and close the Modal AND the drawer beneath it — the operator asked to back out
 * one step and lost two. So every overlay registers here on mount, and only the one on top of
 * the stack answers Escape.
 *
 * ── WHY A COUNTER FOR THE SCROLL LOCK ───────────────────────────────────────────────────────
 *
 * `Modal` used to save `document.body.style.overflow` and restore it on unmount. With a Modal
 * inside a drawer that breaks on the way OUT: the Modal saved "hidden" (the drawer's lock), and
 * React runs a parent's effect cleanup before its children's, so the drawer restores "" and the
 * Modal then restores "hidden" — the page is stuck unscrollable with nothing open. A counter
 * has no order: the first lock remembers the original, the last unlock puts it back.
 */

import { useEffect, useRef, useState } from "react";

/**
 * "On top" = rendered later. The order is taken at FIRST RENDER (a `useState` initializer), not
 * in the effect that registers: React runs a child's effects before its parent's, so a Modal
 * mounting inside a Drawer in the same commit would register first and end up UNDER the drawer
 * that contains it. Render order is parent-then-child and sibling-in-order, which is exactly
 * the paint order for nested and stacked overlays alike.
 */
let nextOrder = 0;
const open = new Set<number>();

/** Registers this overlay while mounted; `onEscape` fires only when it is the topmost one. */
export function useDialogStack(onEscape: () => void): void {
  const [order] = useState(() => ++nextOrder);
  // The latest handler, read at keypress time — kept in a ref (written in an effect, never
  // during render) so the window listener below is registered once and never goes stale.
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    open.add(order);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (Math.max(...open) !== order) return;
      onEscapeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      open.delete(order);
    };
  }, [order]);
}

let locks = 0;
let originalOverflow: string | null = null;

function lockBody(): void {
  if (locks === 0) {
    originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  locks += 1;
}

function unlockBody(): void {
  locks = Math.max(0, locks - 1);
  if (locks === 0) {
    document.body.style.overflow = originalOverflow ?? "";
    originalOverflow = null;
  }
}

/** Stops the page behind an overlay from scrolling under the pointer, for as long as it is mounted. */
export function useBodyScrollLock(): void {
  useEffect(() => {
    lockBody();
    return unlockBody;
  }, []);
}

/** Test seam: how many overlays currently hold the body still. */
export function bodyScrollLockCount(): number {
  return locks;
}
