import { NavLink, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { PropsWithChildren } from "react";
import { api } from "../lib/api";
import { DebugSidebar } from "./DebugSidebar";

// Ordered to follow the funnel: a lead becomes an appointment on the calendar,
// then a job, and the account is the ledger all of it rolls up into.
const nav = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/leads", label: "Leads", badgeQuery: true },
  { to: "/calendar", label: "Calendar", primary: true },
  { to: "/jobs", label: "Jobs", primary: true },
  // The Estimates CHAIN VIEW (P029) — a record, not a workshop. `/estimate-intake` was here
  // and is deliberately gone: Kyle, 2026-08-18, "The estimate flow needs to start from within
  // the customers account not as a stand alone feature." Quoting begins on an account (or a
  // visit); this entry is where you see what has been quoted and where it got to.
  { to: "/estimates", label: "Estimates", primary: true },
  // "Invoices" used to sit here (Kyle, 2026-08-26). Kyle, 2026-09-07: "We should look at
  // merging invoices into the financials tab ... isolate each tab's purpose while getting
  // rid of the repeated features." Signed work and its money now live in the Financials
  // tab's Payments received card; /invoices redirects there so old links keep working.
  { to: "/accounts", label: "Accounts", primary: true },
  // Money — bills, revenue, and the accounting reports (Kyle, 2026-08-25).
  { to: "/financials", label: "Financials", primary: true },
  // Each truck's tech, card, balance and this month's fuel / maintenance /
  // materials on the card (Kyle, 2026-09-09: "Each tech will have their own
  // card for material and gas through stripe").
  { to: "/trucks", label: "Trucks" },
  // What is on each truck and in the warehouse, the tool register, and POs
  // waiting to land (Kyle, 2026-09-09: "We need an inventory tab that tracks
  // what is on the truck and what is at the warehouse").
  { to: "/inventory", label: "Inventory" },
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

/**
 * THE PHONE BAR IS FIVE TABS AND "MORE" — IT NEVER GROWS (Kyle, 2026-09-10).
 *
 * It used to lay every nav entry across the bar, with the column count derived
 * from the array length. At thirteen entries that is ~42 px per label on a
 * phone and eight of them truncate to "Financ…", so Kyle chose the More tab.
 * The five below are the daily ones; everything else lives in the sheet, and
 * the desktop sidebar still shows all of them. Adding a nav entry now changes
 * the sheet, never the bar — which is the point.
 */
const MOBILE_PRIMARY = nav.filter((item) => item.primary);
const MOBILE_MORE = nav.filter((item) => !item.primary);

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

  // The More sheet (Kyle, 2026-09-10). It closes when the route changes — so a
  // tap inside it navigates and gets out of the way — and on Escape. The tab
  // stays lit while the page you are on lives inside the sheet, so you can see
  // where you are without opening it, and carries the badge of anything hidden.
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => { setMoreOpen(false); }, [pathname]);
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMoreOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);
  const moreHoldsCurrentRoute = MOBILE_MORE.some((item) => pathname.startsWith(item.to));
  const moreBadge = MOBILE_MORE.some((item) => item.badgeQuery) ? newLeadCount : 0;

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
        The phone bar: five daily tabs and More. The bar is always six columns —
        the count no longer follows the nav array, so a new tab cannot crowd the
        labels again (Kyle, 2026-08-16: "The words on the menu down at the bottom
        are overlapping too"; 2026-09-10: "the more tab").
      */}
      {moreOpen && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-30 bg-black/30 md:hidden"
            onClick={() => setMoreOpen(false)}
          />
          <div
            role="dialog"
            aria-label="More"
            className="fixed inset-x-0 bottom-[68px] z-40 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-rce-border bg-rce-surface p-3 shadow-card md:hidden"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">More</span>
              <button type="button" className="text-xs text-rce-muted" onClick={() => setMoreOpen(false)}>Close</button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {MOBILE_MORE.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `flex items-center justify-between gap-2 rounded-lg border border-rce-border px-3 py-3 text-sm font-medium ${
                      isActive ? "bg-rce-accentBg text-rce-accentDark" : "text-rce-text"
                    }`
                  }
                >
                  <span className="min-w-0 truncate">{item.label}</span>
                  {item.badgeQuery && newLeadCount > 0 ? (
                    <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-rce-warning px-1.5 text-[11px] font-bold text-white">
                      {newLeadCount}
                    </span>
                  ) : null}
                </NavLink>
              ))}
            </div>
          </div>
        </>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-6 gap-0.5 border-t border-rce-border bg-rce-surface p-2 md:hidden">
        {MOBILE_PRIMARY.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={() => setMoreOpen(false)}
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
        <button
          type="button"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
          className={`relative truncate rounded-md px-1 py-2 text-center text-[11px] font-medium leading-tight ${
            moreOpen || moreHoldsCurrentRoute ? "bg-rce-accentBg text-rce-accentDark" : "text-rce-muted"
          }`}
        >
          More
          {moreBadge > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rce-warning px-1 text-[10px] font-bold text-white">
              {moreBadge}
            </span>
          ) : null}
        </button>
      </nav>

      <DebugSidebar />
    </div>
  );
}
