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
function mockPage(
  issuedEstimate: PbIssuedEstimate | null,
  // Every address on the account (2026-10-01, item J) — rides `pbIssuedDetail` now, and the
  // photo picker below needs at least one to have anything to ask `propertyPhotos` about.
  accountProperties: Array<{ id: string; name: string; addressLine1: string; city: string }> = [
    { id: "prop-1", name: "Tony Hoover House", addressLine1: "1 Main St", city: "Smyrna" },
  ],
) {
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
    issuedEstimate ? { estimate: issuedEstimate, customerLink: "https://example.test/e/tok", accountProperties } : (null as never),
  );
}

const ROUTE = "/estimate-intake?draft=draft-1&account=acct-1&address=prop-1&tab=review";

/** The discount controls, by the words on them. */
async function expectDiscountControls() {
  expect(await screen.findByRole("button", { name: "Military 5%" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Senior 5%" })).toBeInTheDocument();
  expect(screen.getByLabelText("Custom discount percentage")).toBeInTheDocument();
}

/*
  THE PHOTO PICKER DOES NOT DEPEND ON HOW YOU GOT HERE (Kyle, 2026-10-01).

  "I want to be able to attach photos to the email now." — filed from the estimate builder's
  "Or email it instead" block, which showed the two report checkboxes and the Email button but no
  photo picker. Cause: the picker was gated on the `?address=` URL PARAMETER while the rest of the
  panel was not, so any route into the builder without it dropped the control silently. An issued
  estimate carries its own `serviceAddressId`, so that is what it reads now.

  The route WITHOUT `&address=` is the regression test — it is the one that used to fail.
*/
describe("PriceBookIntakePage — photos can ride the estimate email", () => {
  const ROUTE_NO_ADDRESS = "/estimate-intake?draft=draft-1&tab=review";

  /**
   * `PhotoAttachPicker` shows an explanatory empty-state message when the account has no photos
   * at all, so the fixture must carry one — mocking an empty list proves nothing about whether
   * the picker was reachable. It asks for the photos of every property `mockPage` put on the
   * account, which is the whole point here: the assertion is that `prop-1` came from the
   * ESTIMATE's account (via `pbIssuedDetail`'s `accountProperties`), not from the URL.
   */
  function mockPhotosFor(propertyId: string) {
    return vi.spyOn(api, "propertyPhotos").mockImplementation(async (id) =>
      (id === propertyId
        ? { jobPhotos: [{ id: "photo-1", visitDate: "2026-09-20T12:00:00.000Z", caption: "Panel before" }] }
        : { jobPhotos: [] }) as never,
    );
  }

  it("offers the photo picker even when the URL carries no address", async () => {
    mockPage(issued());
    const photos = mockPhotosFor("prop-1");

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE_NO_ADDRESS });

    // It asked for the ESTIMATE's account's address, not the URL's (which has none), and drew
    // the picker.
    await waitFor(() => expect(photos).toHaveBeenCalledWith("prop-1"));
    expect(await screen.findByText(/Attach photos/)).toBeInTheDocument();
  });

  it("still offers it on the ordinary route that does carry the address", async () => {
    mockPage(issued());
    mockPhotosFor("prop-1");

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    expect(await screen.findByText(/Attach photos/)).toBeInTheDocument();
  });

  /*
    ANY PHOTO ON THE ACCOUNT, PLUS THE DRAFT'S (Kyle, 2026-10-01, item J): "Having the photos
    linked to the job is necessary but that should not eleminate them from being selected…
    sending the photos as evidence is our standard." The picker must reach a SECOND property on
    the same account (not just the estimate's own `serviceAddressId`) and this estimate's
    `DraftPhoto`s — each option labelled with which property/job or that it's a draft photo, and
    when, so two similar photos can be told apart.
  */
  it("offers photos from a second property on the account and this estimate's draft photos, each labelled", async () => {
    mockPage(issued(), [
      { id: "prop-1", name: "Tony Hoover House", addressLine1: "1 Main St", city: "Smyrna" },
      { id: "prop-2", name: "Rental", addressLine1: "2 Second St", city: "Smyrna" },
    ]);
    vi.spyOn(api, "propertyPhotos").mockImplementation(async (id) =>
      (id === "prop-1"
        ? { jobPhotos: [{ id: "photo-1", visitDate: "2026-09-20T12:00:00.000Z", caption: "Panel before", jobType: "Panel upgrade" }] }
        : { jobPhotos: [{ id: "photo-2", visitDate: "2026-09-18T12:00:00.000Z", caption: null, jobType: "Rewire" }] }) as never,
    );
    vi.spyOn(api, "pbPhotos").mockResolvedValue({
      photos: [{ id: "draft-photo-1", mime: "image/png", size: 10, note: "Breaker panel", createdAt: "2026-09-25T10:00:00.000Z" }],
    });

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    await screen.findByText(/Attach photos/);
    // The second property's photo is offered, labelled with that property — not just prop-1's.
    // Both property queries and the draft-photo query resolve asynchronously, so these wait
    // rather than asserting on whatever happened to be rendered first.
    expect(await screen.findByTitle(/Rental/)).toBeInTheDocument();
    // The draft photo is offered too, labelled as added while building the estimate.
    expect(await screen.findByTitle(/Added while building this estimate/)).toBeInTheDocument();
  });
});

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
