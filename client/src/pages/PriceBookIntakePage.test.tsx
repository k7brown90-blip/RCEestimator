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
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { PriceBookIntakePage } from "./PriceBookIntakePage";
import { api } from "../lib/api";
import type { AccountSummary, PbDraft, PbIssuedEstimate, PbReview } from "../lib/types";

// "+ Add photos" downscales in-browser before upload (lib/images.ts, shared with every other
// photo-upload path). createImageBitmap/canvas don't exist in jsdom — a fixed data URL in, the
// real upload call out, exactly as AccountDetailPage.test.tsx mocks it.
vi.mock("../lib/images", () => ({
  downscale: vi.fn(async () => "data:image/jpeg;base64,ZmFrZQ=="),
}));

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
  // The builder's photo panel is the ACCOUNT's gallery now (plan A, 2026-10-02) and reads the
  // account summary for its jobs and addresses. Empty by default; the photo tests fill it in.
  vi.spyOn(api, "accountSummary").mockResolvedValue(accountSummaryWith({ properties: [], jobs: [] }));
  vi.spyOn(api, "pbIssuedList").mockResolvedValue({ estimates: issuedEstimate ? [issuedEstimate] : [] });
  vi.spyOn(api, "pbIssuedDetail").mockResolvedValue(
    issuedEstimate ? { estimate: issuedEstimate, customerLink: "https://example.test/e/tok", accountProperties } : (null as never),
  );
}

const ROUTE = "/estimate-intake?draft=draft-1&account=acct-1&address=prop-1&tab=review";

/** The account summary the photo panel reads — only the parts the gallery looks at. */
function accountSummaryWith(overrides: { properties: unknown[]; jobs: unknown[] }): AccountSummary {
  return {
    account: { id: "acct-1", name: "Tony Hoover", email: "tony@example.com", phone: "615-555-0100", createdAt: "2026-09-01T12:00:00.000Z", isTestAccount: false },
    properties: overrides.properties,
    jobs: overrides.jobs,
    totals: {
      lifetimeRevenue: 0, lifetimeCost: 0, lifetimeProfit: 0, lifetimeMargin: null, activeJobCount: 0, completedJobCount: 0,
      propertyCount: overrides.properties.length, lifetimeCollected: 0, lifetimeCustomerPaid: 0, lifetimeWarrantyPaid: 0, lifetimePaymentCount: 0, lastPaidAt: null,
    },
    documents: [],
  } as unknown as AccountSummary;
}

const PROP_1 = { id: "prop-1", name: "Tony Hoover House", addressLine1: "1 Main St", addressLine2: null, city: "Smyrna", state: "TN", postalCode: "37167", occupancyType: "residential", jurisdictionId: "rutherford", notes: null, activeJobCount: 0, completedJobCount: 0, lastInspectionDate: null, openFindingCount: 0, openDefectCount: 0 };
const zeroCosts = () => ({ estimatedCost: null, materialCost: 0, laborHours: 0, laborRate: 0, laborCost: 0, overhead: 0, totalCost: 0, revenue: 0, grossProfit: 0, margin: null });
const JOB_1 = {
  visitId: "visit-1", propertyId: "prop-1", propertyLabel: "Tony Hoover House — 1 Main St", status: "completed", archived: true,
  jobType: "Panel upgrade", purpose: null, mode: "remodel", visitDate: "2026-09-01T12:00:00.000Z",
  scheduledStart: null, scheduledEnd: null, costs: zeroCosts(), purchaseOrders: [], receipts: [], documents: [], latestEstimate: null,
};
const JOB_2 = {
  visitId: "visit-2", propertyId: "prop-1", propertyLabel: "Tony Hoover House — 1 Main St", status: "scheduled", archived: false,
  jobType: null, purpose: "Consultation — estimate visit", mode: "service_diagnostic", visitDate: "2026-09-25T12:00:00.000Z",
  scheduledStart: null, scheduledEnd: null, costs: zeroCosts(), purchaseOrders: [], receipts: [], documents: [], latestEstimate: null,
};

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
    ANY PHOTO ON THE ACCOUNT (Kyle, 2026-10-01, item J): "Having the photos linked to the job is
    necessary but that should not eleminate them from being selected… sending the photos as
    evidence is our standard." The picker must reach a SECOND property on the same account (not
    just the estimate's own `serviceAddressId`) — each option labelled with which property/job
    and when, so two similar photos can be told apart. Photos added while building the estimate
    are job photos since plan A (2026-10-02), so the same list carries them; there is no second
    "draft photo" source any more.
  */
  it("offers photos from a second property on the account, each labelled", async () => {
    mockPage(issued(), [
      { id: "prop-1", name: "Tony Hoover House", addressLine1: "1 Main St", city: "Smyrna" },
      { id: "prop-2", name: "Rental", addressLine1: "2 Second St", city: "Smyrna" },
    ]);
    vi.spyOn(api, "propertyPhotos").mockImplementation(async (id) =>
      (id === "prop-1"
        ? { jobPhotos: [{ id: "photo-1", visitDate: "2026-09-20T12:00:00.000Z", caption: "Panel before", jobType: "Panel upgrade" }] }
        : { jobPhotos: [{ id: "photo-2", visitDate: "2026-09-18T12:00:00.000Z", caption: null, jobType: "Rewire" }] }) as never,
    );

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    await screen.findByText(/Attach photos/);
    // The second property's photo is offered, labelled with that property — not just prop-1's.
    // Both property queries resolve asynchronously, so this waits rather than asserting on
    // whatever happened to be rendered first.
    expect(await screen.findByTitle(/Rental/)).toBeInTheDocument();
  });
});

/*
  PHOTOS ARE FILED ON A JOB WHILE BUILDING (plan A, Kyle 2026-10-02): "Draft photos don't make
  sense to me. Using basic logic here we would obviously want the photos added to the estimates
  that are from an applied job, consultation, or diagnostics. This is why they are labeled with
  what job they came from or assigned to a job once uploaded."

  The builder's "+ Add photos" used to write a DraftPhoto nothing else could reach. Now it is the
  account's own gallery: it asks WHICH JOB, preselects the consultation the draft came from, and
  writes through the one visit-photo upload. With no account there is no job to file on, and the
  control says so instead of hiding.
*/
describe("PriceBookIntakePage — photos added while building are filed on a job", () => {
  const PHOTO_META = { id: "photo-new", mimeType: "image/jpeg", sizeBytes: 100, caption: null, tag: null, uploadedAt: "2026-10-02T00:00:00.000Z" };

  it("asks which job, and uploads through the visit-photo endpoint against that job", async () => {
    mockPage(null);
    vi.spyOn(api, "accountSummary").mockResolvedValue(accountSummaryWith({ properties: [PROP_1], jobs: [JOB_1, JOB_2] }));
    vi.spyOn(api, "propertyPhotos").mockResolvedValue({ jobPhotos: [], assessmentPhotos: [] });
    const upload = vi.spyOn(api, "uploadVisitPhoto").mockResolvedValue(PHOTO_META);

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    const select = (await screen.findByLabelText("Which job are these photos for?")) as HTMLSelectElement;
    // Nothing preselected: this draft was not created from a visit, so the person chooses.
    expect(select.value).toBe("");
    expect(screen.getByLabelText("+ Add photos")).toBeDisabled();

    fireEvent.change(select, { target: { value: "visit-2" } });
    const fileInput = screen.getByLabelText("+ Add photos");
    expect(fileInput).not.toBeDisabled();
    fireEvent.change(fileInput, { target: { files: [new File(["fake"], "panel.jpg", { type: "image/jpeg" })] } });

    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith("visit-2", { dataUrl: "data:image/jpeg;base64,ZmFrZQ==", tag: null }),
    );
  });

  it("preselects the consultation the draft was created from", async () => {
    mockPage(null);
    vi.spyOn(api, "pbReview").mockResolvedValue({ ...REVIEW, draft: { ...DRAFT, visitId: "visit-2" } });
    vi.spyOn(api, "accountSummary").mockResolvedValue(accountSummaryWith({ properties: [PROP_1], jobs: [JOB_1, JOB_2] }));
    vi.spyOn(api, "propertyPhotos").mockResolvedValue({ jobPhotos: [], assessmentPhotos: [] });

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    const select = (await screen.findByLabelText("Which job are these photos for?")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("visit-2"));
    expect(screen.getByLabelText("+ Add photos")).not.toBeDisabled();
  });

  it("with no account to file on, the control is greyed and says why — not hidden", async () => {
    mockPage(null);
    vi.spyOn(api, "pbReview").mockResolvedValue({ ...REVIEW, draft: { ...DRAFT, customerId: null, customer: null } });

    renderWithProviders(<PriceBookIntakePage />, { route: "/estimate-intake?draft=draft-1&tab=review" });

    expect(
      await screen.findByText("Attach this estimate to an account first — photos are filed on a job, and the jobs live on the account."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("+ Add photos")).toBeDisabled();
  });

  it("a photo on the account can be deleted from the builder, behind a confirm", async () => {
    mockPage(null);
    vi.spyOn(api, "accountSummary").mockResolvedValue(accountSummaryWith({ properties: [PROP_1], jobs: [JOB_2] }));
    vi.spyOn(api, "propertyPhotos").mockResolvedValue({
      jobPhotos: [{ ...PHOTO_META, id: "photo-1", caption: "Old panel", visitId: "visit-2", visitDate: "2026-09-25T12:00:00.000Z", purpose: "Consultation — estimate visit", jobType: null }],
      assessmentPhotos: [],
    } as never);
    const del = vi.spyOn(api, "deleteVisitPhoto").mockResolvedValue({ deleted: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    fireEvent.click(await screen.findByLabelText("Delete photo"));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(del).toHaveBeenCalledWith("photo-1"));
  });
});

/*
  THE SEND IS A CHECKLIST (Kyle, 2026-10-02): "Build the estimate, attach relavent attachements
  (generator sizing, health report, photos, financing link, and custom message) all checked or
  unchecked to designate what gets sent."

  The financing link was the one item on that list with no box — it went on every estimate email
  unconditionally. It now has one, and it is the only box that starts TICKED, because the line has
  been going out since 2026-09-16 on Kyle's word and a box starting empty would have silently
  stopped it. So the two assertions that matter are: ticked by default, and unticking it actually
  reaches the server.
*/
describe("PriceBookIntakePage — the financing link is a tick-box on the send", () => {
  it("starts ticked, beside the other two attachments", async () => {
    mockPage(issued());
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    const box = await screen.findByLabelText(/Include the Synchrony financing link/);
    expect(box).toBeChecked();
    // The reports it sits with are opt-IN; this one is opt-OUT. If this ever flips, the financing
    // line stops going out on every send and nobody finds out until a customer asks.
    expect(screen.getByLabelText(/Attach Electrical Health Record report/)).not.toBeChecked();
    expect(screen.getByLabelText(/Attach Generator Sizing data sheet/)).not.toBeChecked();
  });

  it("sends nothing about financing while it stays ticked, so the default body is unchanged", async () => {
    mockPage(issued());
    const send = vi.spyOn(api, "pbIssuedSend").mockResolvedValue({ sent: true, to: "t@example.com" } as never);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    fireEvent.click(await screen.findByRole("button", { name: /Email estimate|Email again/ }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][1].includeFinancingLink).toBeUndefined();
  });

  it("unticking it sends includeFinancingLink: false and says so in the confirm", async () => {
    mockPage(issued());
    const send = vi.spyOn(api, "pbIssuedSend").mockResolvedValue({ sent: true, to: "t@example.com" } as never);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    fireEvent.click(await screen.findByLabelText(/Include the Synchrony financing link/));
    fireEvent.click(await screen.findByRole("button", { name: /Email estimate|Email again/ }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][1].includeFinancingLink).toBe(false);
    // Leaving it off is the unusual choice, so the confirm has to name it — otherwise the only
    // way to notice is to read the email after it has gone.
    expect(String(confirm.mock.calls[0][0])).toContain("no financing link");
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
