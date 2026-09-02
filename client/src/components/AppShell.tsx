import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { api } from "../lib/api";
import { DebugSidebar } from "./DebugSidebar";

// Ordered to follow the funnel: a lead becomes an appointment on the calendar,
// then a job, and the account is the ledger all of it rolls up into.
const nav = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/leads", label: "Leads", badgeQuery: true },
  { to: "/calendar", label: "Calendar" },
  { to: "/jobs", label: "Jobs" },
  // The Estimates CHAIN VIEW (P029) — a record, not a workshop. `/estimate-intake` was here
  // and is deliberately gone: Kyle, 2026-08-18, "The estimate flow needs to start from within
  // the customers account not as a stand alone feature." Quoting begins on an account (or a
  // visit); this entry is where you see what has been quoted and where it got to.
  { to: "/estimates", label: "Estimates" },
  // Signed work and where its money stands (Kyle, 2026-08-26: "an invoices tab
  // that tracks the invoices sent and what ones are paid").
  { to: "/invoices", label: "Invoices" },
  { to: "/accounts", label: "Accounts" },
  // Money — bills, revenue, and the accounting reports (Kyle, 2026-08-25).
  { to: "/financials", label: "Financials" },
  { to: "/team", label: "Team" },
  // The book itself — every item, price, and category, edited in place
  // (Kyle, 2026-08-30: "a new tab that is labeled 'Price Book' that will be
  // the full in-app editor"). The workbook is history; this is the source.
  { to: "/price-book", label: "Price Book" },
  // Marketing email — lists, the composer, and what each send did
  // (Kyle, 2026-09-02: "set up an email campaigns tab").
  { to: "/campaigns", label: "Campaigns" },
  { to: "/settings", label: "Settings" },
];

/** Tailwind needs literal class names, so the derived count maps through this. */
const MOBILE_NAV_COLS: Record<number, string> = {
  4: "grid-cols-4",
  5: "grid-cols-5",
  6: "grid-cols-6",
  7: "grid-cols-7",
  8: "grid-cols-8",
  9: "grid-cols-9",
  // Ten entries in one phone row would leave ~36px per label; five columns
  // wrap into two even rows instead, so every label stays readable.
  10: "grid-cols-5",
  11: "grid-cols-6",
};

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
  // Badge counts the open pipeline, so it always matches what the tab shows —
  // a lead that's been contacted but not booked still needs attention.
  const { data: openLeads = [] } = useQuery({
    queryKey: ["leads", { pipeline: "open" }],
    queryFn: () => api.leads({ pipeline: "open" }),
    refetchInterval: 60_000,
  });
  const newLeadCount = openLeads.length;

  return (
    <div className="min-h-screen bg-rce-bg text-rce-text md:grid md:grid-cols-[236px_1fr]">
      <aside className="hidden bg-rce-navBg bg-[radial-gradient(circle_at_top_right,rgba(196,152,24,0.15),transparent_45%)] p-4 md:flex md:flex-col md:gap-3">
        <div className="mb-4 flex flex-col items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-3 shadow-card">
          <img src="/logo.png" alt="Red Cedar Electric LLC" className="h-16 w-16 rounded-lg object-contain" />
          <span className="font-heading text-sm font-semibold tracking-wide text-rce-navText">RCE ESTIMATING</span>
        </div>
        {nav.map((item) => (
          <NavItem key={item.to} to={item.to} label={item.label} badge={item.badgeQuery ? newLeadCount : undefined} />
        ))}
      </aside>

      <main className="pb-20 md:pb-0">
        <div className="mx-auto w-full max-w-7xl p-4 md:p-6">
          {/*
            NO backdrop-blur HERE. Kyle, 2026-08-21: "I need the ui fixed. I can't see or present
            any options."

            This card wraps EVERY page, and it used to carry `backdrop-blur-sm`. An element with a
            backdrop-filter becomes the containing block for its `position: fixed` descendants — so
            the sticky summary bars on the presentation and intake screens anchored to the bottom of
            THIS CARD instead of the viewport. On a phone that put the total bar directly over the
            option list with the rest of the screen left empty, which is exactly what he screenshotted.

            The blur was invisible anyway: the card sits at 90% opacity over a flat background, so
            there was nothing behind it to blur. It cost him the ability to present options.
          */}
          <div className="rounded-2xl border border-rce-border/80 bg-rce-surface/90 p-4 shadow-card md:p-5">{children}</div>
        </div>
      </main>

      {/*
        COLUMN COUNT IS DERIVED, NOT TYPED.

        This was hard-coded `grid-cols-7` while `nav` held EIGHT entries, so the eighth wrapped
        onto a second row and the labels crowded into each other. Kyle reported it on 2026-08-16
        ("The words on the menu down at the bottom are overlapping too") and it survived because a
        literal in the class string has no relationship to the array it is laying out.

        Tailwind cannot see a computed class name, so the count maps through an explicit lookup —
        which also means adding a ninth nav entry fails loudly here rather than silently
        overlapping again.
      */}
      <nav
        className={`fixed inset-x-0 bottom-0 z-30 grid ${
          MOBILE_NAV_COLS[nav.length] ?? "grid-cols-4"
        } gap-0.5 border-t border-rce-border bg-rce-surface p-2 md:hidden`}
      >
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `relative truncate rounded-md px-1 py-2 text-center text-[11px] font-medium leading-tight ${
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

      <DebugSidebar />
    </div>
  );
}
