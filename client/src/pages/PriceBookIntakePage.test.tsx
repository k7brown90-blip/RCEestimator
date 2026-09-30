/**
 * The estimate builder's Review tab — the first render test this page has had.
 *
 * Written for one regression, reported by Kyle from the in-app debug console on 2026-09-29 while
 * standing on a draft that had already issued estimate 2026-1098:
 *
 *   "There is no place to adjust the discount. The discount needs to be editable as well."
 *
 * The whole discount block sat inside the panel's `{!est && ...}` branch, so the controls vanished
 * the moment an estimate came off the draft — while the amber banner at the top of the same tab
 * told him edits reach the estimate through "Save changes to the estimate". A render test is the
 * only thing that catches a control being CONDITIONALLY ABSENT; a build and a type-check both pass
 * happily.
 *
 * These assert the discount is reachable in all three states the draft can be in: never issued,
 * issued and unsigned, and issued and signed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { PriceBookIntakePage } from "./PriceBookIntakePage";
import { api } from "../lib/api";
import type { PbDraft, PbIssuedEstimate, PbReview } from "../lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const DRAFT: PbDraft = {
  id: "draft-1", title: "Kitchen circuit diagnostic", supplierId: "HD", status: "open",
  customerId: "acct-1", customer: { id: "acct-1", name: "Tony Hoover" },
  rateProvisional: false, provisionalReason: null, billedLaborRate: 100,
};

const REVIEW: PbReview = {
  draft: DRAFT,
  proposedLines: [],
  // One confirmed line with no material, so the on-hand lookup stays disabled.
  confirmedLines: [{
    id: "line-1", itemId: "ITEM-1", description: "Diagnostic per outlet", quantity: 6,
    quantitySource: "COUNT", difficulty: "normal", option: "A", status: "CONFIRMED",
  } as unknown as PbReview["confirmedLines"][number]],
  openQuestions: [],
  counts: { proposed: 0, confirmed: 1, openQuestions: 0 },
};

function issued(overrides: Partial<PbIssuedEstimate> = {}): PbIssuedEstimate {
  return {
    id: "est-1", draftId: "draft-1", customerId: "acct-1", serviceAddressId: "prop-1",
    number: "2026-1098", revision: 1, status: "sent", title: "Kitchen circuit diagnostic",
    customerName: "Tony Hoover", customerEmail: "tony@example.com", total: 349.86,
    createdAt: "2026-09-29T12:00:00.000Z", sentAt: null, sentTo: null, firstViewedAt: null,
    signedAt: null, signerName: null,
    ...overrides,
  };
}

/** Every query the page fires. `issuedEstimate: null` = nothing has been issued from the draft. */
function mockPage(issuedEstimate: PbIssuedEstimate | null) {
  vi.spyOn(api, "pbDrafts").mockResolvedValue({ drafts: [DRAFT] });
  vi.spyOn(api, "pbSections").mockResolvedValue({ sections: [] });
  vi.spyOn(api, "pbReview").mockResolvedValue(REVIEW);
  vi.spyOn(api, "pbCompute").mockResolvedValue({
    // No programme set yet — the buttons must still be there to set one.
    discount: null,
    computed: { lines: [], laborHours: 0, laborDollars: 0, materialSell: 0, subtotal: 0 } as never,
    options: [],
  });
  vi.spyOn(api, "pbDraftOptions").mockResolvedValue([]);
  vi.spyOn(api, "pbOptionsMode").mockResolvedValue({ exclusiveOptions: false });
  vi.spyOn(api, "pbPhotos").mockResolvedValue({ photos: [] });
  vi.spyOn(api, "pbIssuedList").mockResolvedValue({ estimates: issuedEstimate ? [issuedEstimate] : [] });
  vi.spyOn(api, "pbIssuedDetail").mockResolvedValue(
    issuedEstimate ? { estimate: issuedEstimate, customerLink: "https://example.test/e/tok" } : (null as never),
  );
}

const ROUTE = "/estimate-intake?draft=draft-1&account=acct-1&address=prop-1&tab=review";

/** The discount controls, by the words on them. */
async function expectDiscountControls() {
  expect(await screen.findByRole("button", { name: "Military 5%" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Senior 5%" })).toBeInTheDocument();
  expect(screen.getByLabelText("Custom discount percentage")).toBeInTheDocument();
}

describe("PriceBookIntakePage — the discount is always adjustable", () => {
  it("offers the discount before anything has been issued", async () => {
    mockPage(null);
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    await expectDiscountControls();
  });

  /*
    THE REGRESSION KYLE REPORTED. Before the fix this rendered no discount control at all,
    because the block was inside `{!est && ...}`.
  */
  it("still offers the discount once an estimate has been issued, and says where to save it", async () => {
    const est = issued();
    mockPage(est);
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    await expectDiscountControls();
    // The banner that sent him looking for the save, and the discount's own pointer to it.
    await waitFor(() =>
      expect(screen.getByText(/Press "Save changes to the estimate" below to put it on 2026-1098\./)).toBeInTheDocument(),
    );
  });

  it("offers it on a SIGNED estimate too, warning that it needs a new signature", async () => {
    mockPage(issued({ status: "signed", signedAt: "2026-09-29T14:00:00.000Z", signerName: "Tony Hoover" }));
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    await expectDiscountControls();
    await waitFor(() =>
      expect(
        screen.getByText(/is signed, so its discount is frozen at the figure the customer agreed to/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/the customer has to sign again/)).toBeInTheDocument();
  });
});
