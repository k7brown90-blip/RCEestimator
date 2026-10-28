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
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { PriceBookIntakePage } from "./PriceBookIntakePage";
import { api } from "../lib/api";
import type { AccountSummary, PbDraft, PbIssuedEstimate, PbReview } from "../lib/types";
import { buildQuoteFinancing, type FinancingPlan } from "../../../shared/financing";
import { DEFAULT_FINANCING_PLANS } from "../../../src/services/financingPlanDefaults";

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
  // What the server sends: A, B, C always (none removable), and "Add option" offers D.
  optionSet: {
    options: (["A", "B", "C"] as const).map((option) => ({ option, label: null, note: null, lineCount: option === "A" ? 1 : 0, removable: false })),
    nextOption: "D",
    lockedReason: null,
  },
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
    money: { exclusiveOptions: false, range: null, discount: null, discountedTotal: null, discountedRange: null, pickable: [], selections: {} },
  });
  vi.spyOn(api, "pbDraftOptions").mockResolvedValue([]);
  vi.spyOn(api, "pbOptionsMode").mockResolvedValue({ exclusiveOptions: false });
  // The builder's photo panel is the ACCOUNT's gallery now (plan A, 2026-10-02) and reads the
  // account summary for its jobs and addresses. Empty by default; the photo tests fill it in.
  vi.spyOn(api, "accountSummary").mockResolvedValue(accountSummaryWith({ properties: [], jobs: [] }));
  // The one email panel (2026-10-27) reads the record's sent thread, the account's contacts and addresses.
  vi.spyOn(api, "emailDeliveries").mockResolvedValue([]);
  vi.spyOn(api, "accountContacts").mockResolvedValue([]);
  vi.spyOn(api, "account").mockResolvedValue({ id: "acct-1", name: "Tony Hoover", properties: accountProperties } as never);
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
    // 2026-10-27: the picker is part of the ONE "Email the customer" panel - open it.
    fireEvent.click(await screen.findByRole("button", { name: "Email the customer" }));

    // It asked for the ESTIMATE's account's address, not the URL's (which has none), and drew
    // the picker.
    await waitFor(() => expect(photos).toHaveBeenCalledWith("prop-1"));
    expect(await screen.findByText(/Attach photos/)).toBeInTheDocument();
  });

  it("still offers it on the ordinary route that does carry the address", async () => {
    mockPage(issued());
    mockPhotosFor("prop-1");

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    fireEvent.click(await screen.findByRole("button", { name: "Email the customer" }));

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
    fireEvent.click(await screen.findByRole("button", { name: "Email the customer" }));

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

  UPDATED 2026-10-27 (one email tool): the checklist lives in the "Email the customer" panel (the
  Estimate kind) now - "Email estimate" / "Email again" and the typed address box are gone - so each
  case opens the panel first and sends with the one Send button that names the estimate and the
  address. The assertions are the same.
*/
/** Open the one panel on the Intake send card and pick a kind. */
async function openEmailPanel(kindName?: RegExp | string) {
  fireEvent.click(await screen.findByRole("button", { name: "Email the customer" }));
  if (kindName) fireEvent.click(await screen.findByRole("radio", { name: kindName }));
}

describe("PriceBookIntakePage — the financing link is a tick-box on the send", () => {
  it("starts ticked, beside the other two attachments", async () => {
    mockPage(issued());
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    await openEmailPanel();
    const box = await screen.findByLabelText(/Include the Synchrony financing link/);
    expect(box).toBeChecked();
    // The reports it sits with are opt-IN; this one is opt-OUT. If this ever flips, the financing
    // line stops going out on every send and nobody finds out until a customer asks.
    expect(screen.getByLabelText(/Attach Electrical Health Record report/)).not.toBeChecked();
    expect(screen.getByLabelText(/Attach Generator Sizing data sheet/)).not.toBeChecked();
  });

  it("sends nothing about financing while it stays ticked, so the default body is unchanged", async () => {
    mockPage(issued());
    const send = vi.spyOn(api, "sendCustomerEmail").mockResolvedValue({ sent: true, kind: "estimate", to: "tony@example.com", cc: [] });

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    await openEmailPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Send estimate 2026-1098 to tony@example.com" }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][0].includeFinancingLink).toBeUndefined();
    expect(send.mock.calls[0][0]).toMatchObject({ kind: "estimate", estimateId: "est-1" });
  });

  it("unticking it sends includeFinancingLink: false", async () => {
    mockPage(issued());
    const send = vi.spyOn(api, "sendCustomerEmail").mockResolvedValue({ sent: true, kind: "estimate", to: "tony@example.com", cc: [] });

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    await openEmailPanel();
    fireEvent.click(await screen.findByLabelText(/Include the Synchrony financing link/));
    fireEvent.click(await screen.findByRole("button", { name: "Send estimate 2026-1098 to tony@example.com" }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][0].includeFinancingLink).toBe(false);
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

describe("PriceBookIntakePage — the discount block prints the SERVER's figures (one presentation math)", () => {
  // 2026-10-08, one-estimating-system plan, Phase 3 unit A. The block used to redo the discount
  // sum in the browser (discountPreview). It now words `compute.money.discount.rows` — the amounts
  // below are deliberately not what any browser arithmetic on the page's other numbers would give.
  const withDiscount = (rows: Array<{ label: string; base: number; comboSaving: number; amount: number; capped: boolean; after: number }>, pricedOnceComplete = false) => {
    mockPage(null);
    vi.mocked(api.pbCompute).mockResolvedValue({
      discount: { type: "military", rate: 0.05, cap: 250, percent: 5 },
      computed: { lines: [], laborHours: 0, laborDollars: 0, materialSell: 0, subtotal: 0, jobFixedCost: 200, combinationDiscounts: {} } as never,
      options: [],
      money: {
        exclusiveOptions: false, range: null, discountedTotal: null, discountedRange: null, pickable: ["A"], selections: {},
        discount: { type: "military", percent: 5, label: "Military discount (5%)", terms: "5% off, capped at $250", rows, pricedOnceComplete },
      },
    });
  };

  it("shows the whole-job amount and the after-discount figure the server sent", async () => {
    withDiscount([{ label: "whole job", base: 4000, comboSaving: 0, amount: 250, capped: true, after: 3750.01 }]);
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    await expectDiscountControls();
    await waitFor(() => expect(screen.getByText(/whole job/)).toBeInTheDocument());
    const text = document.body.textContent ?? "";
    expect(text).toContain("-$250.00 (capped) -> $3750.01");
    expect(text).toContain("5% off, capped at $250");
  });

  it("a selection the server could not price yet says so instead of showing $0", async () => {
    withDiscount([], true);
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    await expectDiscountControls();
    await waitFor(() => expect(document.body.textContent).toContain("prices once every line is confirmed"));
  });
});

/*
  Phase 4 (2026-10-08): "Email the financing link" on the after-issue panel, BEFORE signing. Kyle:
  "the financing link should be able to be sent before signing." The estimate email's own body is
  the one shared/estimateEmail.ts builds (the phone sends the same).

  UPDATED 2026-10-27 (one email tool): the financing link is the "Financing link" kind of the ONE
  "Email the customer" panel - there is no separate button under "Email estimate" any more. Greyed
  with the reason when the server would refuse - never hidden.
*/
describe("PriceBookIntakePage — the one email control (Estimate · Financing link · Message)", () => {
  it("is ONE control on an issued, unsigned estimate: the old Email estimate / Email again / Email the financing link buttons are gone", async () => {
    mockPage(issued());
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    expect(await screen.findAllByRole("button", { name: "Email the customer" })).toHaveLength(1);
    for (const gone of [/^Email estimate$/, /^Email again$/, /^Email the financing link$/, /^Send the financing link again$/]) {
      expect(screen.queryByRole("button", { name: gone })).not.toBeInTheDocument();
    }
    expect(screen.queryByPlaceholderText("Customer email")).not.toBeInTheDocument(); // the typed-address box is the picker now
  });

  it("sends the financing link through the one send, to the customer on file, with no confirm and no signature in the way", async () => {
    mockPage(issued());
    const send = vi.spyOn(api, "sendCustomerEmail").mockResolvedValue({ sent: true, kind: "financing", to: "tony@example.com", cc: [] });

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    await openEmailPanel("Financing link");
    fireEvent.click(await screen.findByRole("button", { name: "Send financing link to tony@example.com" }));

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "financing", estimateId: "est-1", to: null })));
    expect(await screen.findByText("Financing link emailed to tony@example.com.")).toBeInTheDocument();
  });

  it("is available on an estimate that has never been emailed (status draft)", async () => {
    mockPage(issued({ status: "draft" }));
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    await openEmailPanel();
    expect(await screen.findByRole("radio", { name: "Financing link" })).toBeEnabled();
  });

  it("greys with the reason for a lost or void estimate", async () => {
    mockPage(issued({ status: "lost" }));
    const { unmount } = renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    await openEmailPanel();
    expect(await screen.findByRole("radio", { name: "Financing link" })).toBeDisabled();
    expect(screen.getByText(/Reopen it from the Estimates page first, then send the financing link/)).toBeInTheDocument();
    unmount();
    vi.restoreAllMocks();

    mockPage(issued({ status: "void" }));
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    await openEmailPanel();
    expect(await screen.findByRole("radio", { name: "Financing link" })).toBeDisabled();
    expect(screen.getAllByText("This estimate is void.").length).toBeGreaterThan(0);
  });

  it("when the account has no email, says so and waits for an address - it does not guess", async () => {
    mockPage(issued({ customerEmail: null }));
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    await openEmailPanel();
    expect(await screen.findByText(/No email on file — pick a contact or type an address above/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Send estimate 2026-1098/ })).toBeDisabled();
  });

  it("shows the server's refusal in the panel", async () => {
    mockPage(issued());
    vi.spyOn(api, "sendCustomerEmail").mockRejectedValue(new Error("This estimate is void."));
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    await openEmailPanel("Financing link");
    fireEvent.click(await screen.findByRole("button", { name: "Send financing link to tony@example.com" }));
    const refusal = await screen.findByText("This estimate is void.");
    expect(refusal).toBeInTheDocument();
    expect(refusal).toHaveAttribute("role", "alert");
  });

  it("the estimate email body is the shared one: address, note, reports and financing box in the same names", async () => {
    mockPage(issued());
    const send = vi.spyOn(api, "sendCustomerEmail").mockResolvedValue({ sent: true, kind: "estimate", to: "x@example.com", cc: [] });

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    await openEmailPanel();
    fireEvent.change(await screen.findByLabelText("Send to"), { target: { value: "custom" } });
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), { target: { value: "x@example.com" } });
    fireEvent.change(screen.getByPlaceholderText("Optional note to include in the email"), { target: { value: "Call me" } });
    fireEvent.click(screen.getByLabelText(/Attach Electrical Health Record report/));
    fireEvent.click(screen.getByLabelText(/Attach Generator Sizing data sheet/));
    fireEvent.click(screen.getByRole("button", { name: "Send estimate 2026-1098 to x@example.com" }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][0]).toEqual({
      kind: "estimate", estimateId: "est-1",
      to: "x@example.com", message: "Call me", photoIds: undefined,
      attachHealthReport: true, attachGeneratorReport: true, includeFinancingLink: undefined,
    });
  });
});

/*
  Phase 5 unit B (2026-10-08): the totals bar at the bottom of Estimate Intake is the office's view of
  what the customer will be shown, so it carries the same "or from $X/mo with financing" line under
  the total, read from the server's `money.financing` (the plan cards, with the fee, open from it).
*/
describe("PriceBookIntakePage - financing under the totals bar", () => {
  const FIN = buildQuoteFinancing(DEFAULT_FINANCING_PLANS as FinancingPlan[], { A: 900, B: 300, "A+B": 1200 })!;
  const sel = (key: string, total: number) => ({
    key, options: key.split("+"), subtotal: total, trip: 0, comboSaving: 0, base: total, discount: 0, discountCapped: false, total,
  });
  const withFinancing = (exclusiveOptions: boolean) => {
    mockPage(null);
    vi.mocked(api.pbCompute).mockResolvedValue({
      discount: null,
      computed: { lines: [], laborHours: 0, laborDollars: 0, materialSell: 0, subtotal: 0, total: 1200, totalLineCount: 2, incompleteLineCount: 0, completenessSummary: "ok", combinationDiscounts: {} } as never,
      options: [],
      money: {
        exclusiveOptions, range: null, discountedTotal: null, discountedRange: null, pickable: ["A", "B"], discount: null,
        selections: { A: sel("A", 900), B: sel("B", 300), "A+B": sel("A+B", 1200) } as never,
        financing: FIN,
      },
    });
  };

  it("shows the headline for everything with work in it, and the card sheet opens from it with the fee line", async () => {
    withFinancing(false);
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    const headline = `or from $${FIN.bySelection["A+B"].fromMonthly}/mo with financing`;
    fireEvent.click(await screen.findByRole("button", { name: headline }));
    const dialog = await screen.findByRole("dialog", { name: "Financing options" });
    expect(within(dialog).getByText("Financing fee — Plan 965")).toBeInTheDocument();
    expect(within(dialog).getByText(/Options A \+ B · total \$1200\.00/)).toBeInTheDocument();
  });

  it("one-or-the-other: the headline is the cheapest alternative, and says which option", async () => {
    withFinancing(true);
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    const headline = `or from $${FIN.bySelection["B"].fromMonthly}/mo with financing`;
    fireEvent.click(await screen.findByRole("button", { name: headline }));
    expect(await screen.findByText(/Option B \(the cheapest of the alternatives\) · total \$300\.00/)).toBeInTheDocument();
  });

  it("no plan on offer: no line at all", async () => {
    mockPage(null);
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    await screen.findByText(/Estimate intake/);
    expect(screen.queryByRole("button", { name: /with financing/ })).toBeNull();
  });
});

/*
  Carry item (2026-10-08): "Raise a change order" on an invoice that already has an open change
  order REOPENS it (the API answers resumed:true). The press looked the same either way, so the
  arrival now says so.
*/
describe("PriceBookIntakePage - arriving on a change order that was already in progress", () => {
  it("says 'Opened the change order already in progress' when the button reopened one, and Dismiss clears it", async () => {
    mockPage(null);
    renderWithProviders(<PriceBookIntakePage />, {
      route: { pathname: "/estimate-intake", search: "?draft=draft-1&account=acct-1&address=prop-1&tab=review", state: { changeOrderResumed: "2026-1093" } },
    });
    expect(await screen.findByText("Opened the change order already in progress")).toBeInTheDocument();
    expect(screen.getByText(/on estimate 2026-1093/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Opened the change order already in progress")).toBeNull();
  });

  it("says nothing on an ordinary arrival", async () => {
    mockPage(null);
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    await screen.findByText(/Estimate intake/);
    expect(screen.queryByText("Opened the change order already in progress")).toBeNull();
  });
});

/*
  Kyle, 2026-10-27: "I also want to get rid of the quantity showing on the estimates and invoices.
  Instead I want to be able to edit the name of the line item so I can customize the line item name
  to the specific job."

  The box lives where the line is shown: Review tab -> the line's "Edit" form -> "Name on the
  estimate". The exit is "Use the price-book name". On a SIGNED estimate both are greyed WITH the
  server's own reason (optionSet.lockedReason), never hidden.
*/
describe("PriceBookIntakePage - Name on the estimate", () => {
  const SIGNED = "Estimate 2026-1098 from this draft is SIGNED. A signed agreement is never edited — raise a change order instead.";

  function reviewWith(line: Record<string, unknown>, lockedReason: string | null = null): PbReview {
    return {
      ...REVIEW,
      optionSet: { ...REVIEW.optionSet, lockedReason },
      confirmedLines: [{ ...REVIEW.confirmedLines[0], ...line } as unknown as PbReview["confirmedLines"][number]],
    };
  }

  async function openEdit(review: PbReview) {
    mockPage(null);
    vi.mocked(api.pbReview).mockResolvedValue(review);
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  }

  it("opens pre-filled with the price-book name; saving a new name sends it, saving without touching it sends none", async () => {
    const edit = vi.spyOn(api, "pbEditLine").mockResolvedValue({} as never);
    await openEdit(reviewWith({}));
    const box = (await screen.findByLabelText("Name on the estimate")) as HTMLInputElement;
    expect(box.value).toBe("Diagnostic per outlet");
    expect(box.disabled).toBe(false);

    // Untouched: a quantity save never rewrites the name.
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
    expect(edit.mock.calls[0][1]).not.toHaveProperty("customName");
    expect(edit.mock.calls[0][1]).toMatchObject({ quantity: 7 });
  });

  it("a reworded name is sent trimmed on Save", async () => {
    const edit = vi.spyOn(api, "pbEditLine").mockResolvedValue({} as never);
    await openEdit(reviewWith({}));
    fireEvent.change(await screen.findByLabelText("Name on the estimate"), { target: { value: "  Kitchen island outlets - Hoover  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
    expect(edit.mock.calls[0][1]).toMatchObject({ customName: "Kitchen island outlets - Hoover" });
  });

  it("typing the price-book name back, or emptying the box, saves 'no custom name'", async () => {
    const edit = vi.spyOn(api, "pbEditLine").mockResolvedValue({} as never);
    await openEdit(reviewWith({ customName: "Kitchen island outlets - Hoover" }));
    const box = await screen.findByLabelText("Name on the estimate");
    expect((box as HTMLInputElement).value).toBe("Kitchen island outlets - Hoover");
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
    expect(edit.mock.calls[0][1]).toMatchObject({ customName: null });
  });

  it("the line shows the custom name with the price-book item beside it, and 'Use the price-book name' puts it back at once", async () => {
    const edit = vi.spyOn(api, "pbEditLine").mockResolvedValue({} as never);
    await openEdit(reviewWith({ customName: "Kitchen island outlets - Hoover" }));
    expect(screen.getAllByText("Kitchen island outlets - Hoover").length).toBeGreaterThan(0);
    expect(screen.getByText("price book: Diagnostic per outlet")).toBeInTheDocument();
    const clear = screen.getByRole("button", { name: "Use the price-book name" }) as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    fireEvent.click(clear);
    await waitFor(() => expect(edit).toHaveBeenCalledWith("line-1", { customName: null }));
  });

  it("with no custom name there is nothing to put back - the button is greyed and says so", async () => {
    await openEdit(reviewWith({}));
    const clear = (await screen.findByRole("button", { name: "Use the price-book name" })) as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    expect(clear.title).toBe("This line already uses the price-book name.");
  });

  it("a SIGNED estimate greys the box and the button WITH the server's reason, printed on the screen", async () => {
    await openEdit(reviewWith({ customName: "Kitchen island outlets - Hoover" }, SIGNED));
    const box = (await screen.findByLabelText("Name on the estimate")) as HTMLInputElement;
    const clear = screen.getByRole("button", { name: "Use the price-book name" }) as HTMLButtonElement;
    expect(box.disabled).toBe(true);
    expect(box.title).toBe(SIGNED);
    expect(clear.disabled).toBe(true);
    expect(clear.title).toBe(SIGNED);
    expect(screen.getAllByText(SIGNED).length).toBeGreaterThan(0);
  });
});
