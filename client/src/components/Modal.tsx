import type { PropsWithChildren } from "react";
import { useBodyScrollLock, useDialogStack } from "../lib/dialogStack";

interface Props {
  title: string;
  subtitle?: string;
  onClose: () => void;
}

/**
 * Minimal overlay dialog. Used where an action belongs to a row rather than to a
 * page — scheduling a lead, rescheduling from the calendar — so the operator
 * doesn't lose their place in the list.
 *
 * Escape and the body-scroll lock go through lib/dialogStack (2026-09-20): a
 * Modal now also opens from inside a Drawer, and two overlays each owning
 * `window` keydown and `body.style.overflow` closed both on one keypress and
 * left the page unscrollable on the way out. See that file for the order bug.
 */
export function Modal({ title, subtitle, onClose, children }: PropsWithChildren<Props>) {
  useDialogStack(onClose);
  // Stop the list behind the overlay from scrolling under the pointer.
  useBodyScrollLock();

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-rce-border bg-rce-surface p-5 shadow-card"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            {subtitle && <p className="text-sm text-rce-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="rounded px-2 text-xl leading-none text-rce-muted hover:text-rce-text"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
