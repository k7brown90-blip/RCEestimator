/**
 * The estimate drawer carries the account page's row actions — and, by design (drawers plan,
 * trap 6), NEVER Issue / Revise / Change order: issuing over a live estimate silently becomes a
 * revision and kills the customer's link. That absence is pinned here as hard as the presences.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../test/renderWithProviders";
import { DrawerHost } from "./DrawerHost";
import { api } from "../../lib/api";
import type { PbIssuedEstimate } from "../../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function estimate(overrides: Partial<PbIssuedEstimate>): PbIssuedEstimate {
  return {
    id: "est-1", draftId: "draft-1", customerId: "acct-1", serviceAddressId: "prop-1", number: "EST-2026-0001", revision: 1,
    status: "sent", title: "Panel upgrade", customerName: "Jane Homeowner", customerEmail: "jane@example.com",
    serviceAddress: "12 Main St, Smyrna", billedTotal: 4200, total: 4200, createdAt: "2026-09-10T12:00:00.000Z",
    sentAt: "2026-09-10T12:00:00.000Z", sentTo: "jane@example.com", firstViewedAt: null, signedAt: null, signerName: null,
    ...overrides,
  };
}

describe("EstimateDrawer", () => {
  it("offers View, Copy, Resend and Delete on a sent, unsigned estimate — and nothing that issues", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({ estimate: estimate({}) });
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);

    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });

    expect(await screen.findByRole("dialog", { name: "Panel upgrade" })).toBeInTheDocument();
    await waitFor(() => expect(api.estimateRecord).toHaveBeenCalledWith("est-1"));
    expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy to new" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resend…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.getByText("Not opened yet")).toBeInTheDocument();
    // Sent, so no builder edit; and never a one-tap issue / revise / change order.
    expect(screen.queryByRole("button", { name: /edit in builder/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^issue/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revise/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /change order/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /void/i })).not.toBeInTheDocument();
  });

  it("offers Edit in builder on a draft, linking out rather than issuing here", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({ estimate: estimate({ status: "draft", sentAt: null, sentTo: null }) });

    renderWithProviders(<DrawerHost />, { route: "/accounts/acct-1?estimate=est-1" });

    expect(await screen.findByRole("button", { name: "Edit in builder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resend…" })).not.toBeInTheDocument();
  });

  it("offers Void and the invoice door on a signed estimate, never Delete", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({
      estimate: estimate({ status: "signed", signedAt: "2026-09-12T12:00:00.000Z", signerName: "Jane", signedChannel: "email", jobVisitId: "visit-1" }),
    });

    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });

    expect(await screen.findByRole("button", { name: "Void" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invoice & payment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Job" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /change order/i })).not.toBeInTheDocument();
  });

  it("offers Mark lost beside the row actions on a sent estimate, and saves reason + notes (2026-09-20)", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({ estimate: estimate({ status: "viewed", firstViewedAt: "2026-09-11T12:00:00.000Z" }) });
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);
    const markLost = vi.spyOn(api, "markEstimateLost").mockResolvedValue({ lost: true, reason: "price", notes: "cheaper bid" });

    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });

    fireEvent.click(await screen.findByRole("button", { name: "Mark lost…" }));
    // A reason is required — the save button stays disabled until one is picked.
    const save = screen.getByRole("button", { name: "Save as lost" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "price" } });
    fireEvent.change(screen.getByLabelText(/What they said/), { target: { value: "cheaper bid" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(markLost).toHaveBeenCalledWith("est-1", { reason: "price", notes: "cheaper bid" }));
    // Not a void: the drawer never offered Void on this unsigned estimate.
    expect(screen.queryByRole("button", { name: "Void" })).not.toBeInTheDocument();
  });

  it("never offers Mark lost on a draft or a signed estimate — delete and void are those doors", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({ estimate: estimate({ status: "draft", sentAt: null, sentTo: null }) });
    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });
    expect(await screen.findByRole("button", { name: "Edit in builder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mark lost/i })).not.toBeInTheDocument();
  });

  it("shows a lost estimate as lost with its reason, offers Reopen, and withholds resend", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({
      estimate: estimate({ status: "lost", lostAt: "2026-09-15T12:00:00.000Z", lostReason: "timing", lostNotes: "next spring" }),
    });
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);
    const reopen = vi.spyOn(api, "reopenEstimate").mockResolvedValue({ reopened: true, status: "sent" });

    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });

    expect(await screen.findByText(/Lost .* — timing: "next spring"/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resend…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mark lost/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(reopen).toHaveBeenCalledWith("est-1"));
    expect(await screen.findByText("Reopened — back to sent.")).toBeInTheDocument();
  });

  it("deletes an unsigned estimate after a confirm and closes", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({ estimate: estimate({}) });
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);
    vi.spyOn(api, "deleteIssuedEstimate").mockResolvedValue({ deleted: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteIssuedEstimate).toHaveBeenCalledWith("est-1"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
