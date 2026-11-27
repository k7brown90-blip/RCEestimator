/**
 * The property page's Estimates card shows ONE card per estimate number.
 *
 * Kyle, 2026-11-27, with a screenshot of one number listed five times ("rev 1" to "rev 5", all
 * DRAFT): "This is getting on my nerves, see how each draft creates a new document. I am tired of
 * it." The server still sends every revision; the card is the newest one, and the ones it replaced
 * fold under it as "Earlier revisions (n)" - each still with its Open (the drawer, where Delete
 * lives) and its View, because nothing the app creates is left without a way out.
 * Plan: .claude/plans/2026-11-27-one-estimate-one-link.md, Part 3.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { PropertyEstimates, groupByEstimateNumber } from "./PropertyEstimates";
import { api } from "../lib/api";
import type { PbIssuedEstimate } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function row(overrides: Partial<PbIssuedEstimate>): PbIssuedEstimate {
  return {
    id: "est-x", draftId: "draft-1", customerId: "acct-1", serviceAddressId: "prop-1",
    number: "2026-9001", revision: 1, status: "draft", title: "Panel change",
    customerName: "Test Account", customerEmail: null, serviceAddress: "1 Example St",
    total: 100, createdAt: "2026-11-27T12:00:00.000Z", sentAt: null, sentTo: null,
    firstViewedAt: null, signedAt: null, signerName: null,
    ...overrides,
  };
}

/** One number revised twice (three rows), and a second number with a single row. Newest first, as the server sends. */
const ROWS: PbIssuedEstimate[] = [
  row({ id: "est-b1", number: "2026-9002", title: "Garage subpanel", total: 800 }),
  row({ id: "est-a3", revision: 3, status: "sent", total: 300, sentAt: "2026-11-27T13:00:00.000Z" }),
  row({ id: "est-a2", revision: 2, total: 200, supersededBy: { id: "est-a3", revision: 3 } }),
  row({ id: "est-a1", revision: 1, total: 100, supersededBy: { id: "est-a2", revision: 2 } }),
];

describe("groupByEstimateNumber", () => {
  it("makes one group per number, the highest revision on top and the rest under it, newest first", () => {
    const groups = groupByEstimateNumber(ROWS);
    expect(groups.map((g) => g.live.id)).toEqual(["est-b1", "est-a3"]);
    expect(groups[0].earlier).toEqual([]);
    expect(groups[1].earlier.map((r) => r.id)).toEqual(["est-a2", "est-a1"]);
  });

  it("still picks the highest revision when the server's order is oldest first", () => {
    const groups = groupByEstimateNumber([...ROWS].reverse());
    expect(groups.find((g) => g.live.number === "2026-9001")!.live.id).toBe("est-a3");
  });

  it("nothing in, nothing out", () => {
    expect(groupByEstimateNumber([])).toEqual([]);
  });
});

describe("PropertyEstimates - one card per estimate number", () => {
  it("shows two cards for two numbers, and counts cards, not revisions", async () => {
    vi.spyOn(api, "accountEstimates").mockResolvedValue({ estimates: ROWS });
    renderWithProviders(<PropertyEstimates accountId="acct-1" propertyId="prop-1" />);

    // The live revision of the revised estimate is the card.
    expect(await screen.findByText(/2026-9001 rev 3/)).toBeInTheDocument();
    expect(screen.getByText(/2026-9002/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Estimates/ })).toHaveTextContent("(2)");
    // One "Open" and one "View" per CARD - the earlier revisions carry their own, named by revision.
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "View" })).toHaveLength(2);
    // Only the one unsent card offers Edit (the sent one does not, as before).
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
  });

  it("folds the replaced revisions under their card, each with its own Open and View", async () => {
    vi.spyOn(api, "accountEstimates").mockResolvedValue({ estimates: ROWS });
    renderWithProviders(<PropertyEstimates accountId="acct-1" propertyId="prop-1" />);

    const summary = await screen.findByText("Earlier revisions (2)");
    const fold = summary.closest("details")!;
    // Folded until asked for.
    expect(fold).not.toHaveAttribute("open");
    fireEvent.click(summary);
    for (const rev of [1, 2]) {
      expect(within(fold).getByRole("button", { name: `Open rev ${rev}` })).toBeInTheDocument();
      expect(within(fold).getByRole("button", { name: `View rev ${rev}` })).toBeInTheDocument();
    }
    // The estimate that was never revised has nothing to fold.
    expect(screen.getAllByText(/^Earlier revisions/)).toHaveLength(1);
  });

  it("an estimate with a single revision shows no fold at all", async () => {
    vi.spyOn(api, "accountEstimates").mockResolvedValue({ estimates: [ROWS[0]] });
    renderWithProviders(<PropertyEstimates accountId="acct-1" propertyId="prop-1" />);
    expect(await screen.findByText(/2026-9002/)).toBeInTheDocument();
    expect(screen.queryByText(/^Earlier revisions/)).not.toBeInTheDocument();
  });
});
