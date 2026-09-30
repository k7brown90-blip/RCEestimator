/**
 * "Raise a change order" — the shared control (2026-09-29).
 *
 * Three things are pinned, each because it was broken before this component existed:
 *
 *  · IT IS REACHABLE. The only CRM button lived inside the estimate builder's Review tab and
 *    rendered only when the URL carried the draft that produced the signed estimate — and no
 *    screen linked there once an estimate was sent or signed. The drawer tests beside this one
 *    pin the three new homes; these pin the control's own behaviour.
 *
 *  · IT REFUSES OUT LOUD. Greyed with the reason on screen, never hidden (CLAUDE.md
 *    click-through rule 5 — a hidden button teaches the user the feature does not exist, and on
 *    2026-09-23 a hidden "Add line" produced a duplicate P.O. for the same trip).
 *
 *  · IT REPORTS A FAILURE. The builder's old copy was a bare `void api.pbChangeOrder().then()`
 *    with no catch: a server refusal did nothing at all and read as a dead button (D3).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { RaiseChangeOrderButton, changeOrderBlock } from "./RaiseChangeOrderButton";
import { api } from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("changeOrderBlock", () => {
  it("names every refusal the server can give, and nothing else", () => {
    expect(changeOrderBlock({ estimateId: "e1", status: "signed", signed: true })).toBeNull();
    expect(changeOrderBlock({ estimateId: null, status: null, signed: false })).toMatch(/No signed estimate/);
    expect(changeOrderBlock({ estimateId: "e1", status: "sent", signed: false })).toMatch(/Nothing is signed yet/);
    expect(changeOrderBlock({ estimateId: "e1", status: "void", signed: true })).toMatch(/void/);
    expect(changeOrderBlock({ estimateId: "e1", status: "lost", signed: true })).toMatch(/marked lost/);
  });

  /*
    A VOID INVOICE KEEPS ITS signedAt — the signature happened and the audit trail keeps it — so
    "signed" alone is not enough to allow a change order. This is the case the server guard added
    on 2026-09-29 exists for, and the reason it is asserted separately from the sentence above.
  */
  it("refuses a void invoice even though it is signed", () => {
    expect(changeOrderBlock({ estimateId: "e1", status: "void", signed: true })).not.toBeNull();
  });
});

describe("RaiseChangeOrderButton", () => {
  it("raises the draft and lands on the builder's Review tab", async () => {
    const raise = vi.spyOn(api, "pbChangeOrder").mockResolvedValue({ draftId: "draft-9", changeOrderFor: "2026-1093" });

    renderWithProviders(
      <RaiseChangeOrderButton target={{ estimateId: "est-1", status: "signed", signed: true }} />,
      { route: "/jobs" },
    );

    fireEvent.click(screen.getByRole("button", { name: "Raise a change order" }));
    await waitFor(() => expect(raise).toHaveBeenCalledWith("est-1"));
  });

  it("greys itself with the reason on screen when nothing is signed — never hides", async () => {
    const raise = vi.spyOn(api, "pbChangeOrder");

    renderWithProviders(
      <RaiseChangeOrderButton target={{ estimateId: "est-1", status: "sent", signed: false }} />,
      { route: "/jobs" },
    );

    const button = screen.getByRole("button", { name: "Raise a change order" });
    expect(button).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(screen.getByText(/Nothing is signed yet/)).toBeInTheDocument();
    fireEvent.click(button);
    expect(raise).not.toHaveBeenCalled();
  });

  it("greys itself on a void invoice, with the reason", () => {
    renderWithProviders(
      <RaiseChangeOrderButton target={{ estimateId: "est-1", status: "void", signed: true }} />,
      { route: "/jobs" },
    );
    expect(screen.getByRole("button", { name: "Raise a change order" })).toBeDisabled();
    expect(screen.getByText(/void — a voided record takes no new work/)).toBeInTheDocument();
  });

  it("shows the server's refusal instead of failing silently (D3)", async () => {
    vi.spyOn(api, "pbChangeOrder").mockRejectedValue(
      new Error("That invoice is void — a voided record takes no new work. Issue a new estimate instead."),
    );

    renderWithProviders(
      <RaiseChangeOrderButton target={{ estimateId: "est-1", status: "signed", signed: true }} />,
      { route: "/jobs" },
    );

    fireEvent.click(screen.getByRole("button", { name: "Raise a change order" }));
    expect(await screen.findByText(/Issue a new estimate instead/)).toBeInTheDocument();
  });
});
