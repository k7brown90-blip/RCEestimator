/**
 * The drawer primitive (2026-09-20, drawers plan Phase 1).
 *
 * What these pin, each against a defect that is live in the old `DrawerShell` or the More sheet:
 *  - PORTALLED: the drawer's DOM parent is <body>, never AppShell's content card (the
 *    containing-block bug of 2026-08-21, guarded by a 13-line comment there).
 *  - ABOVE THE PHONE BAR (PUNCHLIST C2): its z-index is numerically higher than the bar's, so
 *    the bar cannot paint over its buttons. Read off the real classes of both, not asserted as
 *    a constant.
 *  - MOBILE (PUNCHLIST C3): sized in dvh, padded by the safe-area inset.
 *  - Dialog semantics: role, aria-modal, Escape, scrim click, body scroll lock, focus in/out.
 *  - A Modal opened INSIDE a drawer owns Escape first (lib/dialogStack), and the scroll lock
 *    survives the two unmounting in either order.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { AppShell } from "./AppShell";
import { Drawer, DRAWER_Z_CLASS } from "./Drawer";
import { Modal } from "./Modal";
import { api } from "../lib/api";
import { bodyScrollLockCount } from "../lib/dialogStack";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The z layer a Tailwind class names — `z-40` and `z-[45]` both read as a number. */
function zLayer(className: string): number {
  const m = /(?:^|\s)z-\[?(\d+)\]?(?:\s|$)/.exec(className);
  if (!m) throw new Error(`no z class in "${className}"`);
  return Number(m[1]);
}

function Host({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  if (!open) return <p>closed</p>;
  return (
    <Drawer title="PO-2026-0001" subtitle="Home Depot" onClose={() => { setOpen(false); onClose(); }}>
      <button type="button">First action</button>
      <button type="button">Second action</button>
    </Drawer>
  );
}

describe("Drawer", () => {
  it("is portalled to document.body, not rendered inside the page tree", () => {
    const { container } = renderWithProviders(<Host />);
    const drawer = document.querySelector("[data-drawer]");
    expect(drawer).not.toBeNull();
    expect(drawer!.parentElement).toBe(document.body);
    expect(container.contains(drawer)).toBe(false);
  });

  it("sits above the phone tab bar (PUNCHLIST C2) and above the More sheet's layer", async () => {
    vi.spyOn(api, "leads").mockResolvedValue([]);
    const { container } = renderWithProviders(
      <AppShell>
        <Host />
      </AppShell>,
    );
    await waitFor(() => expect(api.leads).toHaveBeenCalled());
    const phoneBar = container.querySelector("nav");
    expect(phoneBar).not.toBeNull();
    const drawer = document.querySelector("[data-drawer]") as HTMLElement;
    expect(zLayer(drawer.className)).toBeGreaterThan(zLayer(phoneBar!.className));
    expect(drawer.className).toContain(DRAWER_Z_CLASS);
    // ... and below Modal / the debug panel (both z-50) so a Modal raised from inside a drawer
    // paints over it and Kyle's element picker can still reach the drawer's controls.
    expect(zLayer(drawer.className)).toBeLessThan(50);
  });

  it("is sized in dvh and honours the safe-area inset (PUNCHLIST C3)", () => {
    renderWithProviders(<Host />);
    const panel = screen.getByRole("dialog");
    expect(panel.className).toMatch(/dvh/);
    expect(panel.className).not.toMatch(/\d+vh\b/);
    expect(panel.className).toContain("safe-area-inset-bottom");
    // No transform on the panel: it would become the containing block for fixed children.
    expect(panel.className).not.toMatch(/translate|transform|transition-transform/);
  });

  it("is a labelled modal dialog that closes on Escape, on the scrim, and on Close", () => {
    const onClose = vi.fn();
    renderWithProviders(<Host onClose={onClose} />);
    const panel = screen.getByRole("dialog");
    expect(panel).toHaveAttribute("aria-modal", "true");
    expect(panel).toHaveAccessibleName("PO-2026-0001");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByText("closed")).toBeInTheDocument();
  });

  it("closes on the scrim click and on the Close button", () => {
    const first = vi.fn();
    const { unmount } = renderWithProviders(<Host onClose={first} />);
    fireEvent.click(document.querySelector("[data-drawer-scrim]")!);
    expect(first).toHaveBeenCalledTimes(1);
    unmount();

    const second = vi.fn();
    renderWithProviders(<Host onClose={second} />);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("locks body scroll while open and releases it on close", () => {
    expect(bodyScrollLockCount()).toBe(0);
    renderWithProviders(<Host />);
    expect(document.body.style.overflow).toBe("hidden");
    expect(bodyScrollLockCount()).toBe(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(bodyScrollLockCount()).toBe(0);
    expect(document.body.style.overflow).toBe("");
  });

  it("moves focus into the drawer on open and back to the opener on close", () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open it</button>
          {open && (
            <Drawer title="Lead" onClose={() => setOpen(false)}>
              <button type="button">Inside</button>
            </Drawer>
          )}
        </>
      );
    }
    renderWithProviders(<Opener />);
    const opener = screen.getByRole("button", { name: "Open it" });
    opener.focus();
    fireEvent.click(opener);
    const panel = screen.getByRole("dialog");
    expect(panel.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(opener);
  });

  it("lets a Modal raised inside it take Escape first, then closes itself on the next", () => {
    const drawerClosed = vi.fn();
    const modalClosed = vi.fn();
    function Nested() {
      const [modal, setModal] = useState(true);
      return (
        <Drawer title="Lead" onClose={drawerClosed}>
          {modal && (
            <Modal title="Mark lost" onClose={() => { setModal(false); modalClosed(); }}>
              <p>reason</p>
            </Modal>
          )}
        </Drawer>
      );
    }
    renderWithProviders(<Nested />);
    expect(bodyScrollLockCount()).toBe(2);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(modalClosed).toHaveBeenCalledTimes(1);
    expect(drawerClosed).not.toHaveBeenCalled();
    // The Modal's lock released, the drawer's still held — the page stays still.
    expect(bodyScrollLockCount()).toBe(1);
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(drawerClosed).toHaveBeenCalledTimes(1);
  });
});
