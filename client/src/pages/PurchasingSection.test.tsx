/**
 * Settings -> Purchasing -> "Sales tax rate (%)" -> "Save purchasing" (Kyle, 2026-11-24 "Tax in sell, all items"; 2026-11-25 "Automatically on deploy").
 *
 * Saving a different rate reprices the whole price book on the server, with no preview and no Apply button, so the screen has to say
 * what it did: how many items were repriced and how many hand-priced items were left alone (and which). A session without the price book
 * power is greyed WITH the reason (never hidden). The price book list and the item drawer carry Cost, Cost + tax and Sell.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { openCards } from "../test/openCard";
import { PurchasingSection } from "./SettingsPage";
import { PriceBookCatalogPage } from "./PriceBookCatalogPage";
import { api } from "../lib/api";
import type { PbCatalogAtomic, TaxRepriceOutcome } from "../lib/api";
import { CRM_POWERS } from "../../../shared/crmPowers";
import { OWNER_NO_GRANT, PIN_SESSION } from "../test/sessions";

afterEach(() => vi.restoreAllMocks());
// The card starts folded (Kyle, 2026-11-26); these tests are about what is inside it, so open it the way a returning user left it.
beforeEach(() => openCards("settings-purchasing"));

const repriced: TaxRepriceOutcome = {
  status: "repriced", previousRate: 0.0975, newRate: 0.11, itemsRepriced: 412, assembliesRepriced: 9, editsWritten: 1900,
  handPriced: [{ itemId: "APP010", description: "Hand set breaker", why: "its marked-up price $20.00 is not its cost x the book's markup ($13.00)" }],
  handPricedCount: 1, openDrafts: 2,
};

/** Mounts the card and waits until the saved settings have loaded (the box fills from them), so a typed value is not overwritten by the load. */
async function mountPurchasing(session = PIN_SESSION) {
  vi.spyOn(api, "session").mockResolvedValue(session);
  const settings = vi.spyOn(api, "companySettings").mockResolvedValue({ purchasing: { salesTaxRate: 0.0975 } } as never);
  const view = renderWithProviders(<PurchasingSection />);
  await waitFor(() => expect(settings).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 20));
  return view;
}

describe("Settings -> Purchasing: saving the sales tax rate reprices the book and says what it did", () => {
  it("names the effect on the card, in Kyle's words", async () => {
    await mountPurchasing();
    // Kyle, 2026-11-26 ("Yes, one line each"): the card says it in ONE plain sentence and no longer quotes the dated rulings on screen
    // ("Tax in sell, all items", "apply TN tax rate" stay in the code comments and the rules file).
    expect(await screen.findByText(/sales tax rate that is built into every sell price; saving a different rate re-prices the price book right away/)).toBeInTheDocument();
    expect(screen.queryByText(/Tax in sell, all items/)).not.toBeInTheDocument();
    expect(screen.queryByText(/apply TN tax rate/)).not.toBeInTheDocument();
  });

  it("sends the fraction and then reports items repriced, hand-priced items left alone, and which", async () => {
    const save = vi.spyOn(api, "saveCompanySetting").mockResolvedValue({ key: "purchasing", value: {}, updatedAt: "now", reprice: repriced });
    await mountPurchasing();
    const box = await screen.findByDisplayValue("9.75");
    fireEvent.change(box, { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "Save purchasing" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("purchasing", { salesTaxRate: 0.11 }));
    const result = await screen.findByTestId("tax-reprice-result");
    expect(result).toHaveTextContent("Price book repriced at 11% (was 9.75%): 412 items repriced (9 of them assemblies), 1 hand-priced item left alone.");
    expect(result).toHaveTextContent("2 open draft estimates now read the new prices.");
    expect(result).toHaveTextContent("APP010");
    expect(result).toHaveTextContent("Hand set breaker");
  });

  it("says so when the book is already priced at that rate", async () => {
    vi.spyOn(api, "saveCompanySetting").mockResolvedValue({
      key: "purchasing", value: {}, updatedAt: "now",
      reprice: { ...repriced, status: "current", previousRate: 0.0975, newRate: 0.0975, itemsRepriced: 0, assembliesRepriced: 0, handPriced: [], handPricedCount: 0, openDrafts: 0 },
    });
    await mountPurchasing();
    fireEvent.click(await screen.findByRole("button", { name: "Save purchasing" }));
    expect(await screen.findByText("The price book is already priced at 9.75%. Nothing changed.")).toBeInTheDocument();
  });

  it("says plainly when the book could not be repriced and so the rate was NOT saved", async () => {
    // The server saves the rate INSIDE the reprice transaction: a failed reprice answers an error and nothing is saved.
    vi.spyOn(api, "saveCompanySetting").mockRejectedValue(
      new Error("The price book could not be repriced just now, so the new sales tax rate was NOT saved and nothing changed. Save again in a moment."),
    );
    await mountPurchasing();
    fireEvent.click(await screen.findByRole("button", { name: "Save purchasing" }));
    expect(await screen.findByText(/could not be repriced just now, so the new sales tax rate was NOT saved/)).toBeInTheDocument();
  });

  it("refuses a rate that is not a percent before it reaches the server", async () => {
    const save = vi.spyOn(api, "saveCompanySetting");
    await mountPurchasing();
    fireEvent.change(await screen.findByDisplayValue("9.75"), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "Save purchasing" }));
    expect(await screen.findByText(/Enter a percent, 0 or more and under 100/)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it("is greyed WITH the reason for a session without the price book power", async () => {
    const save = vi.spyOn(api, "saveCompanySetting");
    await mountPurchasing(OWNER_NO_GRANT);
    expect(await screen.findByTestId("power-lock-price_book_edit")).toHaveTextContent(CRM_POWERS.price_book_edit.reason);
    // The box is greyed too (with the reason), not just the button.
    const box = screen.getByLabelText(/Sales tax rate/);
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute("title", CRM_POWERS.price_book_edit.reason);
    const button = screen.getByRole("button", { name: "Save purchasing" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", CRM_POWERS.price_book_edit.reason);
    fireEvent.click(button);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("Price Book shows Cost, Cost + tax and Sell", () => {
  const item = (over: Partial<PbCatalogAtomic> = {}): PbCatalogAtomic => ({
    itemId: "APP001", description: "Tax receptacle", category: "DEVICES", subCategory: null, unitLabel: "ea", sector: null,
    rowType: "MATERIAL + LABOR", notes: null, companyCost: 10, companyCostWithTax: 10.98, companyPrice: 14.27, markupTier: "T3",
    laborNormal: 0.5, laborDifficult: null, laborVeryDifficult: null, sellNormal: 64.27, sellDifficult: null, sellVeryDifficult: null,
    source: "in-app", retiredAt: null, laborUnitDivisor: 1,
    ...over,
  });

  async function openList(items: PbCatalogAtomic[]) {
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "pbCatalogCategories").mockResolvedValue({ categories: [{ name: "DEVICES", count: items.length, sortOrder: 0, subCategories: [{ name: null, count: items.length }] }] });
    vi.spyOn(api, "pbCatalogItems").mockResolvedValue({ atomics: items });
    vi.spyOn(api, "pbCatalogItem").mockImplementation(async (id: string) => ({ atomic: items.find((i) => i.itemId === id)!, edits: [] }));
    renderWithProviders(<PriceBookCatalogPage />);
    fireEvent.change(screen.getByPlaceholderText(/Search the whole book/), { target: { value: "APP" } });
  }

  it("the list has a 'Cost + tax' column beside Cost and the Sell columns, and the drawer shows the same three", async () => {
    await openList([item()]);
    const row = (await screen.findByText("Tax receptacle")).closest("tr")!;
    expect(screen.getByRole("columnheader", { name: "Cost" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Cost + tax" })).toBeInTheDocument();
    expect(row).toHaveTextContent("$10.00");
    expect(row).toHaveTextContent("$10.98");
    expect(row).toHaveTextContent("$64.27");
    fireEvent.click(await screen.findByText("Tax receptacle"));
    await screen.findByText("APP001 — edit");
    expect(screen.getByText("Cost (before tax)")).toBeInTheDocument();
    expect(screen.getAllByText("Cost + tax")).toHaveLength(2); // the list's column header and the drawer's row
    expect(screen.getByText("Material w/ markup (tax in)")).toBeInTheDocument();
    expect(screen.getByText("Sell — normal")).toBeInTheDocument();
  });

  it("a hand-priced item shows a dash in Cost + tax, with the reason on hover", async () => {
    await openList([item({ itemId: "APP002", description: "Hand priced thing", companyCostWithTax: null })]);
    const row = (await screen.findByText("Hand priced thing")).closest("tr")!;
    const cell = Array.from(row.querySelectorAll("td")).find((td) => td.getAttribute("title")?.includes("set by hand"));
    expect(cell).toBeTruthy();
    expect(cell).toHaveTextContent("—");
    // The tooltip names BOTH causes - an empty cell is also what an un-repriced book shows, so it must not claim "set by hand" alone.
    expect(cell!.getAttribute("title")).toMatch(/has not been repriced for sales tax/);
    expect(cell!.getAttribute("title")).toMatch(/set by hand/);
    // A price with no tax-in cost is not labelled "(tax in)" in the drawer.
    fireEvent.click(await screen.findByText("Hand priced thing"));
    await screen.findByText("APP002 — edit");
    expect(screen.getByText("Material w/ markup")).toBeInTheDocument();
    expect(screen.queryByText("Material w/ markup (tax in)")).toBeNull();
  });
});
