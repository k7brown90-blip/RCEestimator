import type { PropsWithChildren, ReactNode } from "react";
import { Link } from "react-router-dom";

type Props = PropsWithChildren<{
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** Where "back" goes (Kyle, 2026-09-02: every deep page returns to its account, not the tab). */
  backTo?: string;
  backLabel?: string;
}>;

export function PageHeader({ title, subtitle, actions, children, backTo, backLabel }: Props) {
  return (
    <header className="mb-6 space-y-3">
      {backTo && (
        <Link to={backTo} className="inline-block text-sm text-rce-accent hover:underline">
          ← {backLabel ?? "Back"}
        </Link>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-rce-text">{title}</h1>
          {subtitle ? <p className="text-sm text-rce-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
