/**
 * Estimate Intake — options past C and drag-and-drop on the Review tab (2026-10-08, one-estimating-
 * system plan, Phase 1).
 *
 * Kyle, 2026-10-08: "I want to be able to add more than 3 options ... a create additional option
 * button here which will continue the options past 'C'." / "Capping it at eight is good." / "I would
 * like to be able to drag and drop line items on the review screen."
 *
 * These are render tests of the controls a person with a mouse has to find: the "+ Add Option D"
 * button (and why it is greyed at H or on a signed estimate), "Remove Option D" with its confirm,
 * the drag handle on every CONFIRMED line and none on an AI proposal, and the order the screen sends
 * when a line is dropped.
 *
 * jsdom has no layout, so a real pointer drag cannot run. DndContext is wrapped to hand the test its
 * own handlers, and the test calls them with the events dnd-kit would send. That exercises everything
 * the page does with a drop (the move rules, the full-list save, the revert on failure) except the
 * library's own pointer tracking.
 */

import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { PriceBookIntakePage } from "./PriceBookIntakePage";
import { api } from "../lib/api";
import type { PbDraft, PbIssuedEstimate, PbReview } from "../lib/types";
import type { DraftOptionEntry, DraftOptionSet, EstimateOptionLetter } from "../../../shared/estimateOptions";
import { ALL_OPTIONS, nextFreeOption } from "../../../shared/estimateOptions";

// The handlers the page gave DndContext on its latest render.
const dnd = vi.hoisted(() => ({ props: null as null | Record<string, (e: unknown) => void> }));
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: Record<string, unknown>) => {
      dnd.props = props as never;
      return createElement(actual.DndContext, props as never);
    },
  };
});

vi.mock("../lib/images", () => ({
  downscale: vi.fn(async () => "data:image/jpeg;base64,ZmFrZQ=="),
}));

afterEach(() => {
  vi.restoreAllMocks();
  dnd.props = null;
});

const HANDLE = "Drag to reorder or move to another option";

const DRAFT: PbDraft = {
  id: "draft-1", title: "Whole-house rewire", supplierId: "HD", status: "open",
  customerId: "acct-1", customer: { id: "acct-1", name: "Tony Hoover" },
  rateProvisional: false, provisionalReason: null, billedLaborRate: 100,
};

/** An option list the way the server builds it: A-C always, plus whatever is in `extra`. */
function optionSetOf(
  extra: Array<{ option: EstimateOptionLetter; lineCount?: number }> = [],
  lineCounts: Record<string, number> = {},
  lockedReason: string | null = null,
): DraftOptionSet {
  const letters = ["A", "B", "C", ...extra.map((e) => e.option)] as EstimateOptionLetter[];
  const options: DraftOptionEntry[] = letters.map((option) => ({
    option,
    label: null,
    note: null,
    lineCount: extra.find((e) => e.option === option)?.lineCount ?? lineCounts[option] ?? 0,
    removable: !["A", "B", "C"].includes(option),
  }));
  return { options, nextOption: nextFreeOption(letters), lockedReason };
}

/** The server's own sentence for a signed draft (atomicEstimateService.draftLockedReason). */
const SIGNED_REASON =
  "Estimate 2026-1098 from this draft is SIGNED. A signed agreement is never edited — raise a change order instead.";

/** A review line. `option` is the draft's own — the board groups by it (not by the compute result). */
function line(id: string, itemId: string, option: EstimateOptionLetter = "A") {
  return {
    id, itemId, option, description: `Description of ${itemId}`, quantity: 1, quantitySource: "COUNT",
    difficulty: "NORMAL", location: null, note: null, unit: "ea", proposedBy: null,
  };
}

function reviewWith(optionSet: DraftOptionSet, opts: { confirmed?: ReturnType<typeof line>[]; proposed?: ReturnType<typeof line>[] } = {}): PbReview {
  const confirmed = opts.confirmed ?? [];
  return {
    draft: DRAFT,
    optionSet,
    proposedLines: (opts.proposed ?? []) as never,
    confirmedLines: confirmed as never,
    openQuestions: [],
    counts: { proposed: (opts.proposed ?? []).length, confirmed: confirmed.length, openQuestions: 0 },
  };
}

function computedLine(id: string, itemId: string, option: EstimateOptionLetter) {
  return {
    id, option, itemId, description: `Description of ${itemId}`, quantity: 1, quantitySource: "COUNT",
    difficulty: "NORMAL", unit: "ea", laborUnitBasis: null, laborHours: 1, laborDollars: 100,
    costBasis: null, materialCost: 0, materialSell: 0, gaps: [], complete: true,
  };
}

/**
 * Every query the page fires. `review` is read through a getter so a test can change what the
 * server "now" says after a mutation, the way a real refetch would see it.
 */
function mockPage(getReview: () => PbReview, computedLines: ReturnType<typeof computedLine>[] = [], issued: PbIssuedEstimate[] = []) {
  vi.spyOn(api, "pbDrafts").mockResolvedValue({ drafts: [DRAFT] });
  vi.spyOn(api, "pbSections").mockResolvedValue({ sections: [] });
  const review = vi.spyOn(api, "pbReview").mockImplementation(async () => getReview());
  const compute = vi.spyOn(api, "pbCompute").mockImplementation(async () => ({
    discount: null,
    computed: { lines: computedLines, laborHours: 0, laborDollars: 0, materialSell: 0, subtotal: 0 } as never,
    options: [],
    money: { exclusiveOptions: false, range: null, discount: null, discountedTotal: null, discountedRange: null, pickable: [], selections: {} },
  }));
  vi.spyOn(api, "pbDraftOptions").mockResolvedValue([]);
  vi.spyOn(api, "pbOptionsMode").mockResolvedValue({ exclusiveOptions: false });
  vi.spyOn(api, "pbIssuedList").mockResolvedValue({ estimates: issued });
  vi.spyOn(api, "pbIssuedDetail").mockResolvedValue(null as never);
  vi.spyOn(api, "accountSummary").mockResolvedValue({
    account: { id: "acct-1", name: "Tony Hoover", email: "tony@example.com", phone: "615-555-0100", createdAt: "2026-09-01T12:00:00.000Z", isTestAccount: false },
    properties: [], jobs: [],
    totals: { lifetimeRevenue: 0, lifetimeCost: 0, lifetimeProfit: 0, lifetimeMargin: null, activeJobCount: 0, completedJobCount: 0, propertyCount: 0, lifetimeCollected: 0, lifetimeCustomerPaid: 0, lifetimeWarrantyPaid: 0, lifetimePaymentCount: 0, lastPaidAt: null },
    documents: [],
  } as never);
  return { review, compute };
}

const ROUTE = "/estimate-intake?draft=draft-1&account=acct-1&address=prop-1&tab=review";

describe("Estimate Intake — '+ Add Option D' on the Adding-into bar", () => {
  it("shows '+ Add Option D' and, on click, calls the API and puts Option D in the bar", async () => {
    let current = reviewWith(optionSetOf());
    mockPage(() => current);
    const add = vi.spyOn(api, "pbAddOption").mockImplementation(async () => {
      current = reviewWith(optionSetOf([{ option: "D" }]));
      return { option: "D", optionSet: current.optionSet };
    });

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    const button = await screen.findByRole("button", { name: "+ Add Option D" });
    expect(button).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Option D" })).toBeNull();

    fireEvent.click(button);

    await waitFor(() => expect(add).toHaveBeenCalledWith("draft-1"));
    // Option D is in the bar, selected (it names itself in the hint), and the button moved on to E.
    expect(await screen.findByRole("button", { name: "Option D" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "+ Add Option E" })).toBeInTheDocument();
    expect(screen.getByText("name this option in Review")).toBeInTheDocument();
  });

  it("is greyed at Option H with the reason on screen", async () => {
    const full = optionSetOf(["D", "E", "F", "G", "H"].map((option) => ({ option: option as EstimateOptionLetter })));
    expect(full.options).toHaveLength(ALL_OPTIONS.length);
    expect(full.nextOption).toBeNull();
    mockPage(() => reviewWith(full));
    const add = vi.spyOn(api, "pbAddOption");

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    const button = await screen.findByRole("button", { name: "+ Add Option" });
    expect(button).toBeDisabled();
    // Said on the page, not only in a tooltip.
    expect(await screen.findByText("Eight options is the limit.")).toBeInTheDocument();
    fireEvent.click(button);
    expect(add).not.toHaveBeenCalled();
  });

  it("is greyed on a signed estimate, with the SERVER's reason and the way out on screen", async () => {
    // No pb-issued data at all: the lock comes from the draft's own option set (lockedReason), the
    // same rule the server refuses with — so it also holds after a signed estimate was revised and
    // the signed row is superseded, which the old client-side test missed.
    mockPage(() => reviewWith(optionSetOf([{ option: "D" }], {}, SIGNED_REASON)), [], []);

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    const button = await screen.findByRole("button", { name: "+ Add Option E" });
    await waitFor(() => expect(button).toBeDisabled());
    expect((await screen.findAllByText(new RegExp(SIGNED_REASON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).length).toBeGreaterThan(0);
  });
});

describe("Estimate Intake — 'Remove Option D'", () => {
  const withD = (lineCount: number) => reviewWith(optionSetOf([{ option: "D", lineCount }]));

  it("asks 'Option D has N lines — remove them too?' and calls the API when confirmed", async () => {
    let current = withD(2);
    mockPage(() => current);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const remove = vi.spyOn(api, "pbRemoveOption").mockImplementation(async () => {
      current = reviewWith(optionSetOf());
      return { option: "D", linesRemoved: 2, optionSet: current.optionSet };
    });

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    // A, B and C are permanent: no Remove button while one of them is selected.
    await screen.findByRole("button", { name: "Option D" });
    expect(screen.queryByRole("button", { name: /^Remove Option/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Option D" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Option D" }));

    expect(confirm).toHaveBeenCalledWith("Option D has 2 lines — remove them too?");
    // The count the confirm showed goes with the press, so lines the office added since are not
    // deleted under a smaller number.
    await waitFor(() => expect(remove).toHaveBeenCalledWith("draft-1", "D", 2));
    // Gone from the bar, and the selection fell back to a letter the draft still has.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Option D" })).toBeNull());
  });

  it("does nothing when the confirm is declined", async () => {
    mockPage(() => withD(3));
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const remove = vi.spyOn(api, "pbRemoveOption");

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    fireEvent.click(await screen.findByRole("button", { name: "Option D" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Option D" }));

    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Option D" })).toBeInTheDocument();
  });

  it("removes an empty option without a confirm", async () => {
    mockPage(() => withD(0));
    const confirm = vi.spyOn(window, "confirm");
    const remove = vi.spyOn(api, "pbRemoveOption").mockResolvedValue({ option: "D", linesRemoved: 0, optionSet: optionSetOf() });

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    fireEvent.click(await screen.findByRole("button", { name: "Option D" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Option D" }));

    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(remove).toHaveBeenCalledWith("draft-1", "D", 0));
  });
});

describe("Review tab — drag handles", () => {
  it("puts a handle on every CONFIRMED line and none on an AI proposal", async () => {
    mockPage(
      () => reviewWith(optionSetOf([], { A: 2 }), {
        confirmed: [line("line-1", "ITEM-1"), line("line-2", "ITEM-2")],
        proposed: [line("line-p", "ITEM-P")],
      }),
      [computedLine("line-1", "ITEM-1", "A"), computedLine("line-2", "ITEM-2", "A")],
    );

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    await screen.findByText("Confirmed lines — 2");
    expect(screen.getAllByTitle(HANDLE)).toHaveLength(2);
    // The proposal is on screen, and it has no handle.
    expect(screen.getByText(/AI proposals — 1 waiting on you/)).toBeInTheDocument();
    const proposal = screen.getByText("ITEM-P").closest(".card") as HTMLElement;
    expect(within(proposal).queryByTitle(HANDLE)).toBeNull();
  });

  it("greys the handles on a signed estimate and prints why", async () => {
    mockPage(
      () => reviewWith(optionSetOf([], { A: 1 }, SIGNED_REASON), { confirmed: [line("line-1", "ITEM-1")] }),
      [computedLine("line-1", "ITEM-1", "A")],
    );

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    const reason = /Lines can't be moved or reordered\. Estimate 2026-1098 from this draft is SIGNED/;
    expect(await screen.findByText(reason)).toBeInTheDocument();
    const handle = await screen.findByLabelText(reason);
    expect(handle).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByTitle(HANDLE)).toBeNull();
  });

  it("shows an added option that has no lines yet, so a line can be dropped into it", async () => {
    mockPage(
      () => reviewWith(optionSetOf([{ option: "D" }], { A: 1 }), { confirmed: [line("line-1", "ITEM-1")] }),
      [computedLine("line-1", "ITEM-1", "A")],
    );

    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });

    const sectionD = await screen.findByRole("region", { name: "Option D lines" });
    expect(within(sectionD).getByLabelText("Name for option D")).toBeInTheDocument();
    expect(within(sectionD).getByText(/Nothing in this option yet/)).toBeInTheDocument();
  });
});

describe("Review tab — dropping a line saves the FULL order", () => {
  const lines = [line("line-1", "ITEM-1", "A"), line("line-2", "ITEM-2", "A"), line("line-3", "ITEM-3", "B")];
  const computed = [
    computedLine("line-1", "ITEM-1", "A"),
    computedLine("line-2", "ITEM-2", "A"),
    computedLine("line-3", "ITEM-3", "B"),
  ];
  const setup = () => {
    const mocks = mockPage(() => reviewWith(optionSetOf([{ option: "D" }], { A: 2, B: 1 }), { confirmed: lines }), computed);
    renderWithProviders(<PriceBookIntakePage />, { route: ROUTE });
    return mocks;
  };
  const dragEvent = (id: string) => ({ active: { id, rect: { current: { translated: null, initial: null } } } });
  // `endOver`: what dnd-kit reports at the drop. After a line has crossed into another option it has
  // taken its place, so the thing under the pointer is the line itself.
  const drag = async (id: string, overId: string, endOver = overId) => {
    await act(async () => {
      dnd.props!.onDragStart(dragEvent(id));
    });
    await act(async () => {
      dnd.props!.onDragOver({ ...dragEvent(id), over: { id: overId, rect: { top: 0, height: 40 } } });
    });
    await act(async () => {
      dnd.props!.onDragEnd({ ...dragEvent(id), over: { id: endOver } });
    });
  };

  it("moves a line into another option and sends every confirmed line with its option, in order", async () => {
    const { review, compute } = setup();
    const save = vi.spyOn(api, "pbSaveLineOrder").mockResolvedValue({ ok: true, saved: 3, changed: 2 });
    await screen.findByText("Confirmed lines — 3");
    const reviewCalls = review.mock.calls.length;
    const computeCalls = compute.mock.calls.length;

    // line-1 (Option A) dropped onto line-3 (Option B): joins B at line-3's place.
    await drag("line-1", "line-3", "line-1");

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // `was` is the option each line had on the layout the drag started from.
    expect(save).toHaveBeenCalledWith("draft-1", [
      { lineId: "line-2", option: "A", was: "A" },
      { lineId: "line-1", option: "B", was: "A" },
      { lineId: "line-3", option: "B", was: "B" },
    ]);
    // Per-option totals come from the server: the review and the compute were asked for again.
    await waitFor(() => expect(review.mock.calls.length).toBeGreaterThan(reviewCalls));
    await waitFor(() => expect(compute.mock.calls.length).toBeGreaterThan(computeCalls));
  });

  it("drops a line into an EMPTY option", async () => {
    setup();
    const save = vi.spyOn(api, "pbSaveLineOrder").mockResolvedValue({ ok: true, saved: 3, changed: 1 });
    await screen.findByText("Confirmed lines — 3");

    await drag("line-3", "D", "line-3");

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith("draft-1", [
      { lineId: "line-1", option: "A", was: "A" },
      { lineId: "line-2", option: "A", was: "A" },
      { lineId: "line-3", option: "D", was: "B" },
    ]);
  });

  it("reorders within an option", async () => {
    setup();
    const save = vi.spyOn(api, "pbSaveLineOrder").mockResolvedValue({ ok: true, saved: 3, changed: 2 });
    await screen.findByText("Confirmed lines — 3");

    await drag("line-2", "line-1");

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith("draft-1", [
      { lineId: "line-2", option: "A", was: "A" },
      { lineId: "line-1", option: "A", was: "A" },
      { lineId: "line-3", option: "B", was: "B" },
    ]);
  });

  it("a drag made while the totals have not loaded (or failed) keeps every line in its own option", async () => {
    // The old board read each line's option from the compute result and filed a line it did not
    // find under Option A — so one drag here saved every Option B line as Option A. The option is
    // now the review payload's own, so the missing totals change nothing about the layout.
    const { compute } = setup();
    compute.mockImplementation(() => new Promise(() => undefined)); // never arrives
    const save = vi.spyOn(api, "pbSaveLineOrder").mockResolvedValue({ ok: true, saved: 3, changed: 1 });
    await screen.findByText("Confirmed lines — 3");

    await drag("line-2", "line-1");

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith("draft-1", [
      { lineId: "line-2", option: "A", was: "A" },
      { lineId: "line-1", option: "A", was: "A" },
      { lineId: "line-3", option: "B", was: "B" },
    ]);
  });

  it("saves nothing when a line is dropped where it started or on nothing", async () => {
    setup();
    const save = vi.spyOn(api, "pbSaveLineOrder").mockResolvedValue({ ok: true, saved: 3, changed: 0 });
    await screen.findByText("Confirmed lines — 3");

    await drag("line-1", "line-1");
    await act(async () => {
      dnd.props!.onDragStart(dragEvent("line-2"));
    });
    await act(async () => {
      dnd.props!.onDragEnd({ ...dragEvent("line-2"), over: null });
    });

    expect(save).not.toHaveBeenCalled();
  });

  it("puts the lines back and shows the server's reason when the save is refused", async () => {
    const { review } = setup();
    vi.spyOn(api, "pbSaveLineOrder").mockRejectedValue(new Error("The order leaves out 1 line(s) on this estimate — reload it and try again."));
    await screen.findByText("Confirmed lines — 3");

    const reviewCalls = review.mock.calls.length;
    await drag("line-3", "D");

    expect(await screen.findByText(/The order leaves out 1 line\(s\) on this estimate/)).toBeInTheDocument();
    // A refusal can mean the other app changed the estimate: the screen asks for the real layout.
    await waitFor(() => expect(review.mock.calls.length).toBeGreaterThan(reviewCalls));
    // Back in Option B: that section still holds ITEM-3, and Option D is still empty.
    const sectionB = screen.getByRole("region", { name: "Option B lines" });
    const sectionD = screen.getByRole("region", { name: "Option D lines" });
    expect(within(sectionB).getByText("ITEM-3")).toBeInTheDocument();
    expect(within(sectionD).queryByText("ITEM-3")).toBeNull();
  });
});
