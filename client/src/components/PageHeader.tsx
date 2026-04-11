import type { PropsWithChildren, ReactNode } from "react";

type Props = PropsWithChildren<{
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}>;

export function PageHeader({ title, subtitle, actions, children }: Props) {
  return (
    <header className="mb-6 space-y-3">
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
