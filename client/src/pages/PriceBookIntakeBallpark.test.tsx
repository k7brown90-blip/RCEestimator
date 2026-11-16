/**
 * Estimate Intake, standing on a lead's ballpark (Kyle, 2026-11-15, plan lead-intake-fixes F4).
 *
 *   - Arriving from the lead (`?lead=<id>`) starts a draft TIED TO THE LEAD (leadId on the create
 *     call), titled with the lead's name; a lead that already has one is offered "Open ballpark
 *     estimate" instead of a second Start.
 *   - While the draft sits on a lead (no visit) the send controls are GREYED with the reason on
 *     screen — "Present to the customer" and "Create customer estimate" — and the attach-to-an-
 *     account picker is gone (the lead's conversion is the way onto an account).
 *   - Once the draft has a visit (the lead was converted) none of that applies.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { PriceBookIntakePage } from "./PriceBookIntakePage";
import { api } from "../lib/api";
import type { Lead, PbDraft, PbReview } from "../lib/types";
import { BALLPARK_ON_LEAD_REASON } from "../../../shared/leadBallpark";

afterEach(() => {
  vi.restoreAllMocks();
});

const LEAD_DRAFT: PbDraft = {
  id: "draft-9", title: "Ballpark — Steve U.", supplierId: "HD", status: "draft",
  leadId: "lead-1", customerId: null, visitId: null, lead: { id: "lead-1", name: "Steve U." },
  rateProvisional: false, provisionalReason: null, billedLaborRate: 100,
  ballparkLockReason: BALLPARK_ON_LEAD_REASON,
};

function review(draft: PbDraft): PbReview {
  return {
    draft,
    optionSet: {
      options: (["A", "B", "C"] as const).map((option) => ({ option, label: null, note: null, lineCount: 0, removable: false })),
      nextOption: "D",
      lockedReason: null,
    },
    proposedLines: [],
    confirmedLines: [],
    openQuestions: [],
    counts: { proposed: 0, confirmed: 0, openQuestions: 0 },
  };
}

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1", name: "Steve U.", source: "web", status: "new", createdAt: "2026-11-15T12:00:00.000Z",
    receivedAt: "2026-11-15T12:00:00.000Z", updatedAt: "2026-11-15T12:00:00.000Z", ballparks: [],
    ...overrides,
  };
}

function mockPage(draft: PbDraft | null, leadRow: Lead = lead()) {
  vi.spyOn(api, "lead").mockResolvedValue(leadRow);
  vi.spyOn(api, "pbDrafts").mockResolvedValue({ drafts: draft ? [draft] : [] });
  vi.spyOn(api, "pbSections").mockResolvedValue({ sections: [] });
  vi.spyOn(api, "pbDraftOptions").mockResolvedValue([]);
  vi.spyOn(api, "pbOptionsMode").mockResolvedValue({ exclusiveOptions: false });
  vi.spyOn(api, "pbIssuedList").mockResolvedValue({ estimates: [] });
  vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
  vi.spyOn(api, "accountContacts").mockResolvedValue([]);
  if (draft) {
    vi.spyOn(api, "pbReview").mockResolvedValue(review(draft));
    vi.spyOn(api, "pbCompute").mockResolvedValue({
      discount: null,
      computed: { lines: [], laborHours: 0, laborDollars: 0, materialSell: 0, subtotal: 0 } as never,
      options: [],
      money: { exclusiveOptions: false, range: null, discount: null, discountedTotal: null, discountedRange: null, pickable: [], selections: {} },
    });
  }
}

describe("Estimate Intake — starting a ballpark from a lead", () => {
  it("creates the draft tied to the lead, titled with the lead's name", async () => {
    mockPage(null);
    const create = vi.spyOn(api, "pbCreateDraft").mockResolvedValue(LEAD_DRAFT);
    renderWithProviders(<PriceBookIntakePage />, { route: "/estimate-intake?lead=lead-1" });

    const title = await screen.findByPlaceholderText(/New draft title/);
    await waitFor(() => expect(title).toHaveValue("Ballpark — Steve U."));
    fireEvent.click(screen.getByRole("button", { name: "Start draft" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: "Ballpark — Steve U.", leadId: "lead-1", customerId: null })),
    );
  });

  it("a lead that already has a ballpark is offered 'Open ballpark estimate', not a second Start", async () => {
    mockPage(null, lead({
      ballparks: [{ id: "draft-9", title: "Ballpark — Steve U.", status: "draft", updatedAt: "2026-11-15T18:00:00.000Z", visitId: null, total: null, lineCount: 0 }],
    }));
    renderWithProviders(<PriceBookIntakePage />, { route: "/estimate-intake?lead=lead-1" });
    expect(await screen.findByRole("button", { name: "Open ballpark estimate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start draft" })).not.toBeInTheDocument();
  });
});

describe("Estimate Intake — a ballpark that still sits on the lead cannot be sent", () => {
  const ROUTE = "/estimate-intake?lead=lead-1&draft=draft-9&tab=review";

  it("says it is a ballpark for the lead, and greys both send controls with the reason", async () => {
    mockPage(LEAD_DRAFT);
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    expect(await screen.findByText(/Ballpark for lead Steve U\. — it moves onto the job when the lead is converted/)).toBeInTheDocument();

    const create = await screen.findByRole("button", { name: "Create customer estimate" });
    expect(create).toBeDisabled();
    expect(screen.getByRole("button", { name: "Present to the customer" })).toBeDisabled();
    // The reason is ON SCREEN, beside the greyed buttons — not a tooltip and not hidden.
    expect(screen.getAllByText(BALLPARK_ON_LEAD_REASON).length).toBeGreaterThanOrEqual(2);
    // No way to attach it to an account from here: converting the lead is the way.
    expect(screen.queryByText(/not attached to an account yet/)).not.toBeInTheDocument();
  });

  it("once the lead is converted (the draft has a visit) the lock is gone", async () => {
    const converted: PbDraft = { ...LEAD_DRAFT, visitId: "visit-1", customerId: "acct-1", ballparkLockReason: null };
    mockPage(converted);
    renderWithProviders(<PriceBookIntakePage />, { route: `${ROUTE}&account=acct-1&address=prop-1` });

    const create = await screen.findByRole("button", { name: "Create customer estimate" });
    expect(create).toBeEnabled();
    expect(screen.queryByText(BALLPARK_ON_LEAD_REASON)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Present to the customer" })).toBeInTheDocument();
  });
});
