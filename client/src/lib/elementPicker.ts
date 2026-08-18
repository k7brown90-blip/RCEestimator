/**
 * Point at a thing on screen and get back the code that drew it. (P032)
 *
 * Kyle, 2026-08-18: *"I need a way to show you specifically what needs changed."*
 *
 * The sidebar could already carry an error. This carries a POINT — he taps the control he means,
 * and what reaches me is `src/pages/PriceBookIntakePage.tsx:412` plus the element's own text.
 * That is the difference between "the button under the total does nothing", which I have to
 * translate by guessing which of a dozen buttons he means, and a file and a line I can open.
 *
 * The `data-rce-src` attribute comes from the build (see `vite.config.ts`). If it is missing —
 * an element from a library, or a stale cached bundle — the pick still works and simply reports
 * no source, because a description with a screenshot's worth of context is still better than a
 * round trip. It never invents a location.
 */

/** Marks our own UI so the picker cannot point at itself. */
export const DEBUG_UI_ATTR = "data-rce-debug";

export interface PickedElement {
  /** `src/pages/Foo.tsx:412`, or null when the element carries no stamp. */
  src: string | null;
  tag: string;
  /** The visible text, which is usually how Kyle would name the thing. */
  text: string;
  /** Accessible name, when the control is an icon with no text. */
  label: string | null;
  /** Tailwind classes say a great deal about intent — kept, but capped. */
  className: string;
  /** A short ancestor trail, for when the element itself is an anonymous wrapper. */
  path: string;
  /** Where it sat on screen, which disambiguates repeated rows. */
  rect: { x: number; y: number; w: number; h: number };
}

function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  return `${tag}${id}`;
}

function ancestorPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  for (let i = 0; node && i < 4; i++) {
    parts.unshift(describe(node));
    node = node.parentElement;
  }
  return parts.join(" > ");
}

export function describeElement(el: Element): PickedElement {
  // The stamp sits on the element that was WRITTEN; the tap often lands on a child (the text
  // node's span, an svg inside a button). Walking up finds the authored element.
  const stamped = el.closest("[data-rce-src]");
  const rect = el.getBoundingClientRect();
  const text = (el as HTMLElement).innerText ?? el.textContent ?? "";

  return {
    src: stamped?.getAttribute("data-rce-src") ?? null,
    tag: el.tagName.toLowerCase(),
    text: text.trim().replace(/\s+/g, " ").slice(0, 160),
    label:
      el.getAttribute("aria-label") ??
      el.getAttribute("title") ??
      el.getAttribute("placeholder") ??
      null,
    className: (typeof el.className === "string" ? el.className : "").slice(0, 300),
    path: ancestorPath(el),
    rect: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    },
  };
}

/**
 * Enter picking mode. Returns a function that cancels it.
 *
 * Every listener is registered in the CAPTURE phase and the selecting click is swallowed —
 * otherwise pointing at "Delete account" would point at it and then press it.
 */
export function startPicking(
  onPick: (picked: PickedElement) => void,
  onCancel: () => void,
): () => void {
  const highlight = document.createElement("div");
  highlight.setAttribute(DEBUG_UI_ATTR, "");
  highlight.style.cssText = [
    "position:fixed",
    "z-index:2147483646",
    "pointer-events:none",
    "border:2px solid #0ea5e9",
    "background:rgba(14,165,233,0.15)",
    "border-radius:4px",
    "transition:all 60ms linear",
    "display:none",
  ].join(";");
  document.body.appendChild(highlight);

  const target = (e: Event): Element | null => {
    const el = e.target as Element | null;
    if (!el || !(el instanceof Element)) return null;
    // Never point at the picker's own chrome.
    if (el.closest(`[${DEBUG_UI_ATTR}]`)) return null;
    return el;
  };

  const move = (e: Event) => {
    const el = target(e);
    if (!el) {
      highlight.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    highlight.style.display = "block";
    highlight.style.left = `${r.left}px`;
    highlight.style.top = `${r.top}px`;
    highlight.style.width = `${r.width}px`;
    highlight.style.height = `${r.height}px`;
  };

  const choose = (e: Event) => {
    const el = target(e);
    if (!el) return;
    // Swallow it entirely — the app must not act on the tap that selected it.
    e.preventDefault();
    e.stopPropagation();
    stop();
    onPick(describeElement(el));
  };

  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      stop();
      onCancel();
    }
  };

  const stop = () => {
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("touchstart", move, true);
    document.removeEventListener("click", choose, true);
    document.removeEventListener("keydown", key, true);
    highlight.remove();
    document.body.style.cursor = "";
  };

  document.addEventListener("pointermove", move, true);
  document.addEventListener("touchstart", move, true);
  document.addEventListener("click", choose, true);
  document.addEventListener("keydown", key, true);
  document.body.style.cursor = "crosshair";

  return stop;
}
