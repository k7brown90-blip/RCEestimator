/**
 * A price change an AI agent proposed (Kyle, 2026-11-24/25) is drawn by the ONE approval card: Messages -> "Waiting for approval" -> the card says
 * what changes and which assemblies move, its button is "Approve change", Edit is greyed with its reason, and Approve is greyed with the price book
 * power's sentence for an approver who lacks price_book_edit (the server puts that sentence in approve.blockedReason for that reader). After a decision the
 * banner says the price book was or was not changed (never "Posted.").
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { approvalCard } from "../test/hubFixtures";
import { ApprovalCard } from "./ApprovalCard";
import { decisionBanner } from "./ApprovalQueue";
import { CRM_POWERS } from "../../../shared/crmPowers";

afterEach(() => vi.restoreAllMocks());

const priceCard = (over: Record<string, unknown> = {}) => approvalCard({
  kind: "price_change", kindLabel: "Price book change", channel: "in_app", headerLine: "Price book change · APP001", recipient: null, recipientAddress: null, subject: null,
  body: "Price book change proposed for APP001: cost, normal hours.",
  chip: { tone: "internal", text: "Changes the price book — never reaches a customer" },
  effectLines: [
    "APP001 — Receptacle (as it stands now)",
    "Cost (before tax): $10.00 → $12.00",
    "Normal hours: 0.5 → 0.6",
    "Moves assembly ASM001 — EV charger: cost $20.00 → $24.00 (+$4.00); sell normal $200.00 → $206.00",
  ],
  approve: { label: "Approve change", confirm: "Change the price book as shown on this card?", blockedReason: null, editBlockedReason: "A price change cannot be edited. Reject it and ask the agent to propose it again." },
  ...over,
} as never);

describe("the price change card", () => {
  it("says what changes and which assemblies move, and offers Approve change, a greyed Edit with its reason, and Reject", () => {
    renderWithProviders(<ApprovalCard card={priceCard()} canApprove approveReason={null} />);
    expect(screen.getByTestId("approval-card")).toHaveTextContent("Draft by RCE Admin (AI) · Price book change · APP001");
    expect(screen.getByTestId("approval-chip")).toHaveTextContent("never reaches a customer");
    const effect = screen.getByTestId("when-you-approve");
    expect(effect).toHaveTextContent("Cost (before tax): $10.00 → $12.00");
    expect(effect).toHaveTextContent("Moves assembly ASM001 — EV charger: cost $20.00 → $24.00 (+$4.00)");
    expect((screen.getByRole("button", { name: "Approve change" }) as HTMLButtonElement).disabled).toBe(false);
    const edit = screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(edit.title).toContain("cannot be edited");
    expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("an approver without the price book power sees Approve change greyed with that power's sentence on the card", () => {
    const reason = CRM_POWERS.price_book_edit.reason;
    renderWithProviders(<ApprovalCard card={priceCard({ approve: { label: "Approve change", confirm: "x", blockedReason: reason, editBlockedReason: reason } })} canApprove approveReason={null} />);
    expect((screen.getByRole("button", { name: "Approve change" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("approval-lock")).toHaveTextContent(reason);
  });

  it("Reject is greyed with the power's sentence for someone who may not decide price changes, and live for someone who may", () => {
    const reason = CRM_POWERS.price_book_edit.reason;
    const { unmount } = renderWithProviders(<ApprovalCard card={priceCard({ approve: { label: "Approve change", confirm: "x", blockedReason: reason, editBlockedReason: reason, rejectBlockedReason: reason } })} canApprove approveReason={null} />);
    const reject = screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    expect(reject.title).toBe(reason);
    unmount();
    renderWithProviders(<ApprovalCard card={priceCard()} canApprove approveReason={null} />);
    expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a price change that failed to apply says the price book was not changed, and offers \"Try the change again\" (never \"Could not be sent\" or \"Try sending again\")", () => {
    const failed = priceCard({
      status: "failed",
      outcome: { text: "Price book not changed: APP001 has been retired, so its price cannot be changed.", error: "APP001 has been retired, so its price cannot be changed.", decidedBy: "Kyle", decidedAt: null, rejectedReason: null, sentAt: null, emailDelivery: null },
    });
    renderWithProviders(<ApprovalCard card={failed} canApprove approveReason={null} />);
    expect(screen.getByRole("button", { name: "Try the change again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try sending again" })).toBeNull();
    expect(screen.getByTestId("approval-card")).toHaveTextContent("Price book not changed: APP001 has been retired");
    expect(screen.getByTestId("approval-card")).not.toHaveTextContent("Could not be sent");
  });

  it("the banner after a decision speaks of the price book, not of a send", () => {
    const card = priceCard();
    expect(decisionBanner({ card, send: { status: "posted", error: null } } as never, card)).toBe("The price book was changed.");
    expect(decisionBanner({ card, send: null } as never, card)).toBe("Rejected. The price book was not changed.");
    expect(decisionBanner({ card, send: { status: "failed", error: "APP001 has been retired, so its price cannot be changed." } } as never, card))
      .toContain("The price book was not changed: APP001 has been retired");
  });
});
