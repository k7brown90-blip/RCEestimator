import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { api } from "../lib/api";

const nav = [
  { to: "/jobs", label: "Jobs" },
  { to: "/leads", label: "Leads", badgeQuery: true },
  { to: "/customers", label: "Customers" },
  { to: "/settings", label: "Settings" },
];

function NavItem({ to, label, badge }: { to: string; label: string; badge?: number }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition ${
          isActive ? "bg-rce-accent text-white" : "text-rce-navText hover:bg-white/10"
        }`
      }
    >
      {label}
      {badge && badge > 0 ? (
        <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rce-warning px-1.5 text-xs font-bold text-white">
          {badge}
        </span>
      ) : null}
    </NavLink>
  );
}

export function AppShell({ children }: PropsWithChildren) {
  const { data: newLeads = [] } = useQuery({
    queryKey: ["leads", "new"],
    queryFn: () => api.leads("new"),
    refetchInterval: 60_000,
  });
  const newLeadCount = newLeads.length;

  return (
    <div className="min-h-screen bg-rce-bg text-rce-text md:grid md:grid-cols-[236px_1fr]">
      <aside className="hidden bg-rce-navBg bg-[radial-gradient(circle_at_top_right,rgba(245,158,11,0.22),transparent_45%)] p-4 md:flex md:flex-col md:gap-3">
        <div className="mb-4 rounded-xl border border-white/10 bg-black/25 px-3 py-3 text-sm font-semibold tracking-[0.08em] text-rce-navText shadow-card">
          RCE ESTIMATING
        </div>
        {nav.map((item) => (
          <NavItem key={item.to} to={item.to} label={item.label} badge={item.badgeQuery ? newLeadCount : undefined} />
        ))}
      </aside>

      <main className="pb-20 md:pb-0">
        <div className="mx-auto w-full max-w-7xl p-4 md:p-6">
          <div className="rounded-2xl border border-rce-border/80 bg-rce-surface/90 p-4 shadow-card backdrop-blur-sm md:p-5">{children}</div>
        </div>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-rce-border bg-white p-2 md:hidden">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `relative rounded-md px-2 py-2 text-center text-xs font-medium ${
                isActive ? "bg-rce-accentBg text-rce-accentDark" : "text-rce-muted"
              }`
            }
          >
            {item.label}
            {item.badgeQuery && newLeadCount > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rce-warning px-1 text-[10px] font-bold text-white">
                {newLeadCount}
              </span>
            ) : null}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
