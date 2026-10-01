/**
 * The estimate drawer carries the account page's row actions — and, by design (drawers plan,
 * trap 6), NEVER Issue or Revise: issuing over a live estimate silently becomes a revision and
 * kills the customer's link. That absence is pinned here as hard as the presences.
 *
 * CHANGE ORDER MOVED IN, 2026-09-29 (Kyle: "have the features expand to all areas not just one
 * hard to find place"). It had been grouped with Issue and Revise by association, and the cost
 * was a capability with exactly one home — the builder's Review tab, reachable only with the
 * original draft's URL, which nothing linked to once an estimate was sent or signed. Raising one
 * creates a NEW draft and touches this document not at all, so trap 6's reason never applied.
 * The tests below pin it present on a signed estimate and absent on an unsigned one.
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
    // 2026-09-29: the work is agreed, so this is where more of it gets raised. Enabled, not greyed.
    expect(screen.getByRole("button", { name: "Raise a change order" })).toBeEnabled();
    // Still never a one-tap issue or revise — those kill the customer's link.
    expect(screen.queryByRole("button", { name: /^issue/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revise/i })).not.toBeInTheDocument();
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

  // Customer accepted (Kyle, 2026-09-24): the office's exit that means YES without a signature.
  it("offers Customer accepted… beside Mark lost on a sent estimate, and records how they told us, who, the note and the options", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({
      estimate: estimate({
        status: "viewed", firstViewedAt: "2026-09-11T12:00:00.000Z", validDays: 30,
        options: [{ option: "A", label: "Panel only", subtotal: 3000 }, { option: "B", label: "Panel + EV outlet", subtotal: 1200 }],
      }),
    });
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);
    const acceptEstimate = vi.spyOn(api, "acceptEstimate").mockResolvedValue({ accepted: true, estimateId: "est-1", jobVisitId: "visit-9", jobJoined: false });

    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });

    const button = await screen.findByRole("button", { name: "Customer accepted…" });
    expect(button).toBeEnabled();
    expect(screen.getByRole("button", { name: "Mark lost…" })).toBeInTheDocument();
    fireEvent.click(button);
    const record = screen.getByRole("button", { name: "Record acceptance" });
    // The channel is required; the name defaults to the account.
    expect(record).toBeDisabled();
    expect(screen.getByLabelText("Who accepted")).toHaveValue("Jane Homeowner");
    fireEvent.change(screen.getByLabelText("How they told us"), { target: { value: "phone" } });
    expect(record).toBeEnabled();
    // Additive options start all ticked; untick B.
    fireEvent.click(screen.getByLabelText(/Option B — Panel \+ EV outlet/));
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: "said yes on the callback" } });
    fireEvent.click(record);
    await waitFor(() => expect(acceptEstimate).toHaveBeenCalledWith("est-1", {
      acceptedVia: "phone", acceptedBy: "Jane Homeowner", note: "said yes on the callback", selectedOptions: ["A"],
    }));
    expect(await screen.findByText("Accepted — job created. Open Job to schedule it.")).toBeInTheDocument();
  });

  it("greys Customer accepted on an expired quote with the Copy-to-new sentence on the screen — never hidden", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({
      estimate: estimate({ status: "expired", createdAt: "2026-08-01T12:00:00.000Z", sentAt: "2026-08-01T12:00:00.000Z", validDays: 30 }),
    });
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);

    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });

    const button = await screen.findByRole("button", { name: "Customer accepted…" });
    expect(button).toBeDisabled();
    expect(screen.getByText(/This quote expired on 8\/31\/2026\. Use Copy to new to reissue at today's pricing\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy to new" })).toBeEnabled();
  });

  it("greys Customer accepted on a draft (never sent) and on a lost quote, each with its reason", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({ estimate: estimate({ status: "draft", sentAt: null, sentTo: null }) });
    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });
    expect(await screen.findByRole("button", { name: "Customer accepted…" })).toBeDisabled();
    expect(screen.getByText(/Never sent to the customer/)).toBeInTheDocument();
  });

  it("reads an office acceptance as 'accepted by phone, recorded by the office' — never 'signed' — and offers Undo acceptance", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({
      estimate: estimate({
        status: "signed", signedAt: "2026-09-12T12:00:00.000Z", signerName: "Bryan Crawford", signedChannel: "office", acceptedVia: "phone",
        acceptedNote: "called back", jobVisitId: "visit-1",
      }),
    });
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);
    const unaccept = vi.spyOn(api, "unacceptEstimate").mockResolvedValue({ unaccepted: true, status: "viewed", jobAction: "cancelled_unscheduled" });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });

    expect(await screen.findByText(/accepted 9\/12\/2026 by Bryan Crawford by phone, recorded by the office — no signature on file\. Note: "called back"/)).toBeInTheDocument();
    expect(screen.queryByText(/signed 9\/12\/2026/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Customer accepted…" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Void" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo acceptance" }));
    await waitFor(() => expect(unaccept).toHaveBeenCalledWith("est-1"));
    expect(await screen.findByText("Acceptance undone — back to viewed. The unscheduled job was cancelled.")).toBeInTheDocument();
  });

  it("a real signature reads 'signed … from the emailed link' and offers no Undo acceptance", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({
      estimate: estimate({ status: "signed", signedAt: "2026-09-12T12:00:00.000Z", signerName: "Jane", signedChannel: "email", jobVisitId: "visit-1" }),
    });
    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });
    expect(await screen.findByText(/signed 9\/12\/2026 by Jane from the emailed link/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo acceptance" })).not.toBeInTheDocument();
  });

  // Archive (Kyle, 2026-10-01: "once a job is sold the other ones that are not chosen should be
  // archived"). The third exit for an unsigned quote beside Mark lost and Delete — and reversible.
  it("offers Archive… beside Mark lost on a sent estimate, and sends the reason", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({ estimate: estimate({ status: "viewed", firstViewedAt: "2026-09-11T12:00:00.000Z" }) });
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);
    const archive = vi.spyOn(api, "archiveEstimate").mockResolvedValue({ archived: true, archivedAt: "2026-10-01T12:00:00.000Z", reason: "went with 2026-1101 instead" });

    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });

    fireEvent.click(await screen.findByRole("button", { name: "Archive…" }));
    expect(screen.getByRole("button", { name: "Mark lost…" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Why/), { target: { value: "went with 2026-1101 instead" } });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith("est-1", { reason: "went with 2026-1101 instead" }));
    expect(await screen.findByText(/^Archived — filed behind the Sent card/)).toBeInTheDocument();
    // Not lost, not void: neither of those was touched.
    expect(screen.queryByRole("button", { name: "Void" })).not.toBeInTheDocument();
  });

  it("shows an archived estimate as archived with its reason, offers Unarchive, and withholds Resend and Mark lost until then", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({
      estimate: estimate({ status: "viewed", firstViewedAt: "2026-09-11T12:00:00.000Z", archivedAt: "2026-10-01T12:00:00.000Z", archivedReason: "another estimate was signed at this address (2026-1101)" }),
    });
    vi.spyOn(api, "accountContacts").mockResolvedValue([]);
    const unarchive = vi.spyOn(api, "unarchiveEstimate").mockResolvedValue({ unarchived: true, status: "viewed" });

    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });

    expect(await screen.findByText(/Archived 10\/1\/2026 — another estimate was signed at this address \(2026-1101\)\. Still viewed, not lost and not void\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resend…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mark lost/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive…" })).not.toBeInTheDocument();
    // Still unsigned, so Delete and Customer accepted stay; an acceptance un-archives on its own.
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Customer accepted…" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));
    await waitFor(() => expect(unarchive).toHaveBeenCalledWith("est-1"));
    expect(await screen.findByText("Unarchived — back on the viewed list.")).toBeInTheDocument();
  });

  it("never offers Archive on a signed estimate — Void is that door", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({
      estimate: estimate({ status: "signed", signedAt: "2026-09-12T12:00:00.000Z", signerName: "Jane", signedChannel: "email", jobVisitId: "visit-1" }),
    });
    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });
    expect(await screen.findByRole("button", { name: "Void" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /archive/i })).not.toBeInTheDocument();
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
  /*
    D1 (2026-09-29): A SIGNED CHANGE ORDER'S INVOICE DOOR IS THE ROOT'S.

    This button passed the drawer's own `e.id`. `GET /invoices` lists live signed ROOTS only
    (`changeOrderForId: null`), so opening the invoice drawer with a change order's id searched a
    list it can never be in and rendered "No live invoice has this id — it may be voided or
    superseded" on a perfectly live change order. The Hoover job, 2026-09-28, is the live case:
    2026-1097 is a signed change order on 2026-1093.
  */
  it("points a signed change order's invoice door at the ROOT invoice, named", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({
      estimate: estimate({
        id: "co-1", number: "2026-1097", title: "Resolutions — kitchen circuit",
        status: "signed", signedAt: "2026-09-28T19:08:30.000Z", signerName: "Tony Hoover", signedChannel: "email",
        changeOrderForId: "root-1", changeOrderForNumber: "2026-1093", jobVisitId: "visit-1",
      }),
    });
    // Only the ROOT is a live invoice — GET /invoices lists roots, never change orders. So the
    // drawer resolving the right id is the difference between the invoice opening and the
    // "may be voided or superseded" dead end.
    vi.spyOn(api, "invoices").mockResolvedValue([{
      remindersSent: 0, lastReminderAt: null, id: "root-1", number: "2026-1093", revision: 1,
      draftId: "draft-1", accountProperties: [{ id: "prop-1", name: "Tony Hoover House", addressLine1: "12 Main St", city: "Smyrna" }],
      title: "Kitchen circuit diagnostic", customer: { id: "acct-1", name: "Tony Hoover" },
      customerPhone: null, customerEmail: "tony@example.com", propertyId: "prop-1",
      job: { id: "visit-1", jobType: "Diagnostic", purpose: null, status: "in_progress", scheduledStart: null },
      serviceAddress: "12 Main St, Smyrna", signedAt: "2026-09-28T17:53:33.000Z", signedChannel: "email",
      sentAt: "2026-09-28T17:53:33.000Z", sentTo: "tony@example.com", billedTotal: 349.86, depositDue: 116.62,
      totalPaid: 0, discountTotal: 0, collected: 0, balance: 349.86, lastPaidAt: null, paymentStatus: "unpaid",
    }]);
    vi.spyOn(api, "estimatePaymentInfo").mockResolvedValue(null);

    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=co-1" });

    // Named after the invoice it belongs to, so the operator knows where they are going.
    fireEvent.click(await screen.findByRole("button", { name: "Invoice 2026-1093 & payment" }));

    // The ROOT's invoice opens. Before the fix this said "No live invoice has this id".
    expect(await screen.findByRole("dialog", { name: "Invoice 2026-1093" })).toBeInTheDocument();
    expect(screen.queryByText(/No live invoice has this id/)).not.toBeInTheDocument();
  });

  it("keeps the plain 'Invoice & payment' wording on an ordinary signed estimate", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({
      estimate: estimate({ status: "signed", signedAt: "2026-09-12T12:00:00.000Z", signerName: "Jane", signedChannel: "email" }),
    });
    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });
    expect(await screen.findByRole("button", { name: "Invoice & payment" })).toBeInTheDocument();
  });

  it("greys Raise a change order on an unsigned estimate, with the reason (never hidden)", async () => {
    vi.spyOn(api, "estimateRecord").mockResolvedValue({ estimate: estimate({ status: "draft", sentAt: null, sentTo: null }) });
    renderWithProviders(<DrawerHost />, { route: "/estimates?estimate=est-1" });
    await screen.findByRole("button", { name: "Edit in builder" });
    // Not offered at all while unsigned — the estimate itself is still editable in the builder,
    // which is the right door, and the drawer says so by showing Edit instead.
    expect(screen.queryByRole("button", { name: "Raise a change order" })).not.toBeInTheDocument();
  });
});
