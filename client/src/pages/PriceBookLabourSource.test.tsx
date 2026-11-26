/**
 * Price Book -> an item's drawer shows "Labour source" (Kyle, 2026-11-25: the agents type the NECA hours themselves and send where they came from).
 * Click path: Price Book -> search or pick the item -> its drawer -> under Hrs normal / Hrs difficult / Hrs very diff.: "Labour source: <the agent's NECA reference>".
 * An item with no reference (the in-app editor, an imported row, an assembly) shows no such line.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { PriceBookCatalogPage } from "./PriceBookCatalogPage";
import { api } from "../lib/api";
import type { PbCatalogAtomic } from "../lib/api";
import { PIN_SESSION } from "../test/sessions";
import { IN_APP_LABOR_BASIS_RAW, laborBasisRawFor, laborSourceText } from "../../../shared/priceBookLaborSource";

afterEach(() => vi.restoreAllMocks());

const atomic = (over: Partial<PbCatalogAtomic> = {}): PbCatalogAtomic => ({
  itemId: "APP001", description: "Agent receptacle", category: "DEVICES", subCategory: null, unitLabel: "ea", sector: null,
  rowType: "MATERIAL + LABOR", notes: null, companyCost: 5, companyPrice: 6.5, markupTier: "T2",
  laborNormal: 0.3, laborDifficult: 0.4, laborVeryDifficult: null, sellNormal: 36.5, sellDifficult: 46.5, sellVeryDifficult: null,
  source: "in-app", retiredAt: null, laborUnitDivisor: 1,
  ...over,
});

async function openDrawer(item: PbCatalogAtomic) {
  vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
  vi.spyOn(api, "pbCatalogCategories").mockResolvedValue({ categories: [{ name: "DEVICES", count: 1, sortOrder: 0, subCategories: [{ name: null, count: 1 }] }] });
  vi.spyOn(api, "pbCatalogItems").mockResolvedValue({ atomics: [item] });
  vi.spyOn(api, "pbCatalogItem").mockResolvedValue({ atomic: item, edits: [] });
  renderWithProviders(<PriceBookCatalogPage />);
  fireEvent.change(screen.getByPlaceholderText(/Search the whole book/), { target: { value: item.itemId } });
  fireEvent.click(await screen.findByText((item.description as string).trim()));
  await screen.findByText(`${item.itemId} — edit`);
}

describe("History on the item drawer names who made each change", () => {
  it("shows the agent key's name, the CRM for a person's edit, and the note, so a proposal and its decision read as a trail", async () => {
    const item = atomic();
    vi.spyOn(api, "session").mockResolvedValue(PIN_SESSION);
    vi.spyOn(api, "pbCatalogCategories").mockResolvedValue({ categories: [{ name: "DEVICES", count: 1, sortOrder: 0, subCategories: [{ name: null, count: 1 }] }] });
    vi.spyOn(api, "pbCatalogItems").mockResolvedValue({ atomics: [item] });
    const row = (id: string, field: string, editedBy: string, note: string | null, oldValue: string | null = null, newValue: string | null = null) =>
      ({ id, itemId: item.itemId, field, oldValue, newValue, editedBy, note, createdAt: "2026-11-25T12:00:00.000Z" });
    vi.spyOn(api, "pbCatalogItem").mockResolvedValue({
      atomic: item,
      edits: [
        row("3", "priceChangeRejected", "agent:Inventory", "Rejected by Kyle: too high (card c1); proposed by agent key \"Inventory\". The price book was not changed.", null, "companyCost"),
        row("2", "proposed:companyCost", "agent:Inventory", "Proposed by agent key \"Inventory\" (card c1).", "5", "6"),
        row("1", "companyCost", "human:crm-session", null, "4", "5"),
      ],
    });
    renderWithProviders(<PriceBookCatalogPage />);
    fireEvent.change(screen.getByPlaceholderText(/Search the whole book/), { target: { value: item.itemId } });
    fireEvent.click(await screen.findByText((item.description as string).trim()));
    await screen.findByText(`${item.itemId} — edit`);
    const rows = await screen.findAllByTestId("item-history-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("priceChangeRejected");
    expect(rows[0]).toHaveTextContent("agent key Inventory");
    expect(rows[0]).toHaveTextContent("Rejected by Kyle: too high");
    expect(rows[1]).toHaveTextContent("proposed:companyCost: 5 → 6");
    expect(rows[1]).toHaveTextContent("agent key Inventory");
    expect(rows[1]).not.toHaveTextContent("waiting");
    expect(rows[2]).toHaveTextContent("companyCost: 4 → 5");
    expect(rows[2]).toHaveTextContent("CRM");
  });
});

describe("Labour source on the item drawer", () => {
  it("shows the agent's NECA reference", async () => {
    await openDrawer(atomic({ laborUnitBasisRaw: laborBasisRawFor("NECA MLU 2019-20, p.179, Table 3-4, row 12") }));
    const line = await screen.findByTestId("labour-source");
    expect(line.textContent).toBe("Labour source: NECA MLU 2019-20, p.179, Table 3-4, row 12");
  });

  it("shows nothing for an item that carries no reference (the in-app text, an imported basis, or none)", async () => {
    await openDrawer(atomic({ laborUnitBasisRaw: IN_APP_LABOR_BASIS_RAW }));
    expect(screen.queryByTestId("labour-source")).toBeNull();
  });

  it("the stored text round-trips: a reference is kept between E [ and ], brackets and line breaks flattened, and an empty one is the plain in-app text", () => {
    expect(laborSourceText(laborBasisRawFor("p.12 [row 3]\nTable 2"))).toBe("p.12 row 3 Table 2");
    expect(laborBasisRawFor("")).toBe(IN_APP_LABOR_BASIS_RAW);
    expect(laborBasisRawFor(undefined)).toBe(IN_APP_LABOR_BASIS_RAW);
    expect(laborSourceText("C")).toBeNull();
    expect(laborSourceText(null)).toBeNull();
    expect(laborSourceText(laborBasisRawFor("x".repeat(500)))!.length).toBe(300);
  });
});
