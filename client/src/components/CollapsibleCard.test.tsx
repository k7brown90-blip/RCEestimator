/**
 * The shared fold-up card, as Settings uses it (Kyle, 2026-11-26: "All cards should have be collapsable in the settings";
 * "All folded"; a card with a live warning "opens by itself"; "After that, each card keeps the way it was left").
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CollapsibleCard } from "./CollapsibleCard";

describe("CollapsibleCard", () => {
  it("starts folded, opens on a click on the header row, and folds again", () => {
    render(<CollapsibleCard id="t-basic" title="Things" summary="3 things"><p>the body</p></CollapsibleCard>);
    const header = screen.getByRole("button", { name: "Things" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("the body")).toBeNull();
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("the body")).toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.queryByText("the body")).toBeNull();
  });

  it("keeps the title as a real heading, with the status line as the row's description (not part of its name)", () => {
    render(<CollapsibleCard id="t-heading" title="Payroll" summary="9.5% employer cost"><p>x</p></CollapsibleCard>);
    expect(screen.getByRole("heading", { level: 2, name: "Payroll" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Payroll" })).toHaveAccessibleDescription("9.5% employer cost");
    // The status line is on the folded row.
    expect(screen.getByText("9.5% employer cost")).toBeInTheDocument();
  });

  it("shows the subtitle only while open", () => {
    render(<CollapsibleCard id="t-sub" title="Card" subtitle="One plain sentence."><p>x</p></CollapsibleCard>);
    expect(screen.queryByText("One plain sentence.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    expect(screen.getByText("One plain sentence.")).toBeInTheDocument();
  });

  it("remembers how it was left, per id", () => {
    const first = render(<CollapsibleCard id="t-remember" title="Card"><p>body</p></CollapsibleCard>);
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    first.unmount();
    render(<CollapsibleCard id="t-remember" title="Card"><p>body</p></CollapsibleCard>);
    expect(screen.getByRole("button", { name: "Card" })).toHaveAttribute("aria-expanded", "true");
  });

  it("passes aria-label and data-testid to the outer section", () => {
    render(<CollapsibleCard id="t-pass" title="Card" aria-label="Card region" data-testid="the-card"><p>x</p></CollapsibleCard>);
    expect(screen.getByTestId("the-card")).toHaveAttribute("aria-label", "Card region");
  });

  it("a live warning opens it by itself, even over a stored fold, and it can still be folded by hand", () => {
    localStorage.setItem("rce.card.t-warn", "0");
    const view = render(<CollapsibleCard id="t-warn" title="Card" attention><p>the body</p></CollapsibleCard>);
    expect(screen.getByRole("button", { name: "Card" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    expect(screen.queryByText("the body")).toBeNull();
    view.unmount();
  });

  it("opens the moment a warning appears while the page is open", () => {
    const view = render(<CollapsibleCard id="t-late" title="Card" attention={false}><p>the body</p></CollapsibleCard>);
    expect(screen.queryByText("the body")).toBeNull();
    view.rerender(<CollapsibleCard id="t-late" title="Card" attention><p>the body</p></CollapsibleCard>);
    expect(screen.getByText("the body")).toBeInTheDocument();
  });

  it("lockOpen keeps it open and refuses to fold, greyed, with the reason printed on the row (and as the tooltip)", () => {
    render(<CollapsibleCard id="t-lock" title="Card" lockOpen lockTitle="Save the secret first"><p>the body</p></CollapsibleCard>);
    const header = screen.getByRole("button", { name: "Card" });
    expect(screen.getByText("the body")).toBeInTheDocument();
    expect(header).toHaveAttribute("title", "Save the secret first");
    // CLAUDE.md click-through rule: a control that cannot be used is greyed WITH a reason you can read, not only a hover tooltip.
    expect(header.className).toContain("opacity-60");
    expect(header.className).toContain("cursor-not-allowed");
    expect(screen.getByTestId("collapsible-t-lock-lock-reason")).toHaveTextContent("Save the secret first");
    expect(header).toHaveAccessibleDescription("Save the secret first");
    fireEvent.click(header);
    expect(screen.getByText("the body")).toBeInTheDocument();
  });

  it("is controlled by the parent when `open` is passed, and stores nothing", () => {
    const onOpenChange = vi.fn();
    const view = render(<CollapsibleCard id="t-ctl" title="Card" inner open={false} onOpenChange={onOpenChange}><p>the body</p></CollapsibleCard>);
    expect(screen.getByRole("heading", { level: 3, name: "Card" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByText("the body")).toBeNull();
    view.rerender(<CollapsibleCard id="t-ctl" title="Card" inner open onOpenChange={onOpenChange}><p>the body</p></CollapsibleCard>);
    expect(screen.getByText("the body")).toBeInTheDocument();
    expect(localStorage.getItem("rce.card.t-ctl")).toBeNull();
  });
});
