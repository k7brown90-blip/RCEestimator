/**
 * Renders whichever drawers the URL says are open (2026-09-20, drawers plan Phase 1).
 *
 * Mounted once in AppShell. Reads `?po=`, `?job=`, `?estimate=`, `?invoice=`, `?lead=` and
 * `?receipt=` off the current route (lib/drawers.ts explains why the URL), renders one drawer
 * per param in the order they were opened, and closes each by deleting only its own key — the
 * host page's own query state (`?archived`, `?address`, the builder's `draft`/`tab`) is never
 * touched.
 *
 * Every drawer is a component that takes an id and manages its own queries — the same panels
 * the pages already render, re-hosted, not rewritten.
 */

import { useDrawerParams } from "../../lib/drawers";
import type { DrawerKind } from "../../lib/drawers";
import { EstimateDrawer } from "./EstimateDrawer";
import { InvoiceDrawer } from "./InvoiceDrawer";
import { JobDrawer } from "./JobDrawer";
import { LeadDrawer } from "./LeadDrawer";
import { PoDrawer } from "./PoDrawer";
import { ReceiptDrawer } from "./ReceiptDrawer";

const DRAWER_FOR: Record<DrawerKind, (props: { id: string; onClose: () => void }) => React.ReactElement> = {
  po: PoDrawer,
  job: JobDrawer,
  estimate: EstimateDrawer,
  invoice: InvoiceDrawer,
  lead: LeadDrawer,
  receipt: ReceiptDrawer,
};

export function DrawerHost() {
  const { openDrawers, close } = useDrawerParams();
  if (openDrawers.length === 0) return null;
  return (
    <>
      {openDrawers.map(({ kind, id }) => {
        const Component = DRAWER_FOR[kind];
        // Keyed by kind AND id: re-pointing `?po=` at another record remounts the drawer with
        // fresh local state (edit forms, reason rows) instead of carrying the old one's over.
        return <Component key={`${kind}:${id}`} id={id} onClose={() => close(kind)} />;
      })}
    </>
  );
}
