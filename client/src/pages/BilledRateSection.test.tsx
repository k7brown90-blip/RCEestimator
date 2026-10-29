/**
 * Settings -> "Billed labor rate" (Kyle, 2026-10-27: "I want to be able to edit the chosen hourly
 * rate in the app").
 *
 * Pinned: the card shows the current rate; Preview is greyed WITH its reason until the box holds a
 * usable rate that differs from the current one; Preview lists what reprices and what is left alone;
 * Apply needs a preview of that exact rate, asks for a confirmation that sent estimates keep their
 * prices, and sends the number; a typed change throws the old preview away.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { BilledRateSection } from "./BilledRateSection";
import { api } from "../lib/api";
import type { BilledRateApplied, BilledRatePreview } from "../lib/api";

afterEach(() => vi.restoreAllMocks());

const preview = (over: Partial<BilledRatePreview> = {}): BilledRatePreview => ({
  currentRate: 100,
  newRate: 112.5,
  rowsInBook: 40,
  repriceCount: 31,
  unchangedCount: 6,
  assemblyCount: 2,
  convertedRows: [{ itemId: "GENLAB", description: "General labor", kind: "PER-DOLLAR" }],
  samples: [
    { itemId: "A100", description: "Receptacle, 20A", normal: { from: 70, to: 72.5 }, difficult: { from: 80, to: 83.75 }, veryDifficult: null },
  ],
  untouched: [{ itemId: "HAND1", description: "Hand-priced thing", why: "stored sells do not match hours × $100 + material; it looks hand-set" }],
  untouchedCount: 1,
  openDrafts: 3,
  ...over,
});

const applied = (): BilledRateApplied => ({
  previousRate: 100, newRate: 112.5, rowsUpdated: 31, editsWritten: 62, untouched: [], untouchedCount: 0, draftsResnapshotted: 3,
});

function show(current: number | null = 100) {
  vi.spyOn(api, "billedRate").mockResolvedValue({ rate: current });
  const previewSpy = vi.spyOn(api, "billedRatePreview").mockResolvedValue(preview());
  const applySpy = vi.spyOn(api, "billedRateApply").mockResolvedValue(applied());
  renderWithProviders(<BilledRateSection />);
  return { previewSpy, applySpy };
}

const box = () => screen.getByLabelText("New hourly rate ($)") as HTMLInputElement;
const previewBtn = () => screen.getByRole("button", { name: "Preview the change" }) as HTMLButtonElement;
const type = (v: string) => fireEvent.change(box(), { target: { value: v } });

describe("BilledRateSection", () => {
  it("shows the current rate", async () => {
    show(100);
    await waitFor(() => expect(screen.getByTestId("billed-rate-current").textContent).toBe("$100.00 / hr"));
    expect(screen.getByRole("heading", { name: "Billed labor rate" })).toBeTruthy();
  });

  it("Preview and Apply are greyed WITH a reason when the box is empty, invalid, or the current rate", async () => {
    show(100);
    await screen.findByText("$100.00 / hr");
    expect(previewBtn().disabled).toBe(true);
    expect(previewBtn().title).toBe("Type the new hourly rate first.");

    type("-5");
    expect(previewBtn().disabled).toBe(true);
    expect(previewBtn().title).toBe("The billed rate must be more than $0.");

    type("100.555");
    expect(previewBtn().title).toBe("Use dollars and cents only (two decimal places at most).");

    type("1001");
    expect(previewBtn().title).toMatch(/cannot be more than \$1,000/);

    type("100");
    expect(previewBtn().disabled).toBe(true);
    expect(previewBtn().title).toMatch(/already the billed rate/);
    expect((screen.getByRole("button", { name: /Apply/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Preview lists what reprices, examples, and the rows it will leave alone and why", async () => {
    const { previewSpy } = show(100);
    await screen.findByText("$100.00 / hr");
    type("112.50");
    expect(previewBtn().disabled).toBe(false);
    fireEvent.click(previewBtn());
    const panel = await screen.findByTestId("billed-rate-preview");
    expect(previewSpy).toHaveBeenCalledWith(112.5);
    expect(panel.textContent).toMatch(/31 price-book items will reprice/);
    expect(panel.textContent).toMatch(/2 of them assemblies/);
    expect(panel.textContent).toMatch(/A100/);
    expect(panel.textContent).toMatch(/\$70\.00 → \$72\.50/);
    expect(panel.textContent).toMatch(/3 estimates still being built/);
    expect(panel.textContent).toMatch(/Sent and signed estimates are not touched/);
    const untouched = screen.getByTestId("billed-rate-untouched");
    expect(untouched.textContent).toMatch(/1 item will NOT be changed/);
    expect(untouched.textContent).toMatch(/HAND1/);
    expect(untouched.textContent).toMatch(/looks hand-set/);
  });

  it("Apply needs a preview of that exact rate, then confirms and sends the number", async () => {
    const { applySpy } = show(100);
    await screen.findByText("$100.00 / hr");
    type("112.5");
    const applyBtn = () => screen.getByRole("button", { name: "Apply $112.50/hr to the price book" }) as HTMLButtonElement;
    expect(applyBtn().disabled).toBe(true);
    expect(applyBtn().title).toMatch(/Preview the change.* first/);

    fireEvent.click(previewBtn());
    await screen.findByTestId("billed-rate-preview");
    expect(applyBtn().disabled).toBe(false);

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(applyBtn());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(confirm.mock.calls[0][0])).toMatch(/Estimates already sent or signed keep the prices they were sent at/);
    expect(applySpy).not.toHaveBeenCalled(); // "Cancel" writes nothing

    confirm.mockReturnValue(true);
    fireEvent.click(applyBtn());
    await waitFor(() => expect(applySpy).toHaveBeenCalledWith(112.5));
    const done = await screen.findByTestId("billed-rate-applied");
    expect(done.textContent).toMatch(/billed labor rate is now \$112\.50\/hr \(was \$100\.00\)/);
    expect(done.textContent).toMatch(/31 price-book items re-priced/);
  });

  it("changing the number throws the old preview away", async () => {
    show(100);
    await screen.findByText("$100.00 / hr");
    type("112.5");
    fireEvent.click(previewBtn());
    await screen.findByTestId("billed-rate-preview");
    type("115");
    expect(screen.queryByTestId("billed-rate-preview")).toBeNull();
    expect((screen.getByRole("button", { name: "Apply $115.00/hr to the price book" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a server refusal is shown where the office is looking", async () => {
    vi.spyOn(api, "billedRate").mockResolvedValue({ rate: 100 });
    vi.spyOn(api, "billedRatePreview").mockRejectedValue(new Error("The billed rate must be more than $0."));
    renderWithProviders(<BilledRateSection />);
    await screen.findByText("$100.00 / hr");
    type("110");
    fireEvent.click(previewBtn());
    expect(await screen.findByText("The billed rate must be more than $0.")).toBeTruthy();
  });

  it("says 'not set' when the price book has no rate", async () => {
    show(null);
    await waitFor(() => expect(screen.getByTestId("billed-rate-current").textContent).toBe("not set"));
  });
});
