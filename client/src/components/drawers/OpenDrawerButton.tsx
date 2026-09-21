import type { MouseEvent, ReactNode } from "react";
import type { DrawerKind } from "../../lib/drawers";

/**
 * The one way a list row opens a record's drawer (2026-09-20).
 *
 * A button, never an anchor: several of the rows this sits in are already a `<Link>` (the
 * Jobs cards, the Estimates rows) and an anchor inside an anchor is invalid HTML that browsers
 * resolve by dropping one. It stops the click from reaching that surrounding link, so opening
 * the drawer never also navigates — the whole point of a drawer.
 */
export function OpenDrawerButton({
  kind, id, onOpen, label, className, children, title,
}: {
  kind: DrawerKind;
  id: string;
  onOpen: (kind: DrawerKind, id: string) => void;
  /** Short label for the default chip style; `children` renders a custom body instead. */
  label?: string;
  className?: string;
  children?: ReactNode;
  title?: string;
}) {
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen(kind, id);
  };
  return (
    <button
      type="button"
      data-open-drawer={kind}
      onClick={onClick}
      title={title}
      className={className ?? "btn btn-secondary px-2 py-0.5 text-xs min-h-0"}
    >
      {children ?? label ?? "Open"}
    </button>
  );
}
