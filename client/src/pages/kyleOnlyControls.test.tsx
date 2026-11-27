/**
 * Kyle-only controls are GREYED, with the shared reason on the screen, for a session without the
 * power (work order agent-team, HA5) - never hidden. The PIN and Kyle's principal login hold every
 * power, and a login Kyle has granted the power holds it too.
 *
 *   price_book_edit: the Price Book item editor (Description, Unit label, Row type, Company cost, the
 *     three hours boxes; Notes, Category, Sub-category and Sector stay open), a new item's cost and
 *     hours, the assembly components editor and labour override, Settings -> Billed labor rate, and
 *     the materials Promote cost and hours.
 *   treasury: Settings -> Treasury Save, Financials -> Month-end sweep "Sweep $X to Chase".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { openCards } from "../test/openCard";
import { PriceBookCatalogPage } from "./PriceBookCatalogPage";
import { BilledRateSection } from "./BilledRateSection";
import { TreasurySection } from "./SettingsPage";
import { PromoteForm } from "./PurchasingPage";
import { MonthEndSweepCard } from "../components/MonthEndSweepCard";
import { api } from "../lib/api";
import type { PbAssemblyDetail, PbCatalogAtomic } from "../lib/api";
import type { MaterialRow, SessionView, SweepView } from "../lib/types";
import { CRM_POWERS } from "../../../shared/crmPowers";
import { OWNER_NO_GRANT, PIN_SESSION, PRINCIPAL_SESSION, ownerWith } from "../test/sessions";

afterEach(() => vi.restoreAllMocks());
// The card starts folded (Kyle, 2026-11-26); these tests are about what is inside it, so open it the way a returning user left it.
beforeEach(() => openCards("settings-billed-rate", "settings-treasury"));

const PRICE_REASON = CRM_POWERS.price_book_edit.reason;
const TREASURY_REASON = CRM_POWERS.treasury.reason;

const atomic = (over: Partial<PbCatalogAtomic> = {}): PbCatalogAtomic => ({
  itemId: "A100", description: "Receptacle, 20A", category: "DEVICES", subCategory: null, unitLabel: "ea", sector: "Residential",
  rowType: "MATERIAL + LABOR", notes: "a note", companyCost: 5, companyPrice: 10, markupTier: "T2",
  laborNormal: 0.3, laborDifficult: 0.4, laborVeryDifficult: 0.5, sellNormal: 40, sellDifficult: 50, sellVeryDifficult: 60,
  source: "kyles-tab", retiredAt: null,
  ...over,
});

const HOLDERS: Array<[string, SessionView]> = [
  ["a login Kyle granted the power to", ownerWith("price_book_edit", "treasury")],
  ["Kyle at the owner PIN", PIN_SESSION],
  ["Kyle's own principal login", PRINCIPAL_SESSION],
];

// ─── Price Book: the item editor ─────────────────────────────────────────────────────────────

async function openItemDrawer(session: SessionView, item: PbCatalogAtomic = atomic(), detail?: PbAssemblyDetail) {
  vi.spyOn(api, "session").mockResolvedValue(session);
  vi.spyOn(api, "pbCatalogCategories").mockResolvedValue({ categories: [{ name: "DEVICES", count: 1, sortOrder: 0, subCategories: [{ name: null, count: 1 }] }] });
  vi.spyOn(api, "pbCatalogItems").mockResolvedValue({ atomics: [item] });
  vi.spyOn(api, "pbCatalogItem").mockResolvedValue({ atomic: item, edits: [] });
  if (detail) vi.spyOn(api, "pbCatalogAssemblyDetail").mockResolvedValue(detail);
  renderWithProviders(<PriceBookCatalogPage />);
  fireEvent.change(screen.getByPlaceholderText(/Search the whole book/), { target: { value: item.itemId } });
  fireEvent.click(await screen.findByText((item.description as string).trim()));
  await screen.findByText(`${item.itemId} — edit`);
}

/** The control inside the Field whose caption is exactly `label` (the table headers share some of the words). */
const field = (label: string): HTMLInputElement => {
  const caption = Array.from(document.querySelectorAll("label > span")).find((el) => el.textContent === label);
  if (!caption) throw new Error("no field captioned " + label);
  return caption.closest("label")!.querySelector("input,select,textarea") as HTMLInputElement;
};

describe("Price Book item editor", () => {
  it("for a session without price_book_edit: Description, Unit label, Row type, Company cost and the hours are greyed WITH the reason; Notes, Category, Sub-category and Sector stay open", async () => {
    await openItemDrawer(OWNER_NO_GRANT);
    await waitFor(() => expect(screen.getByTestId("power-lock-price_book_edit").textContent).toBe(PRICE_REASON));
    for (const label of ["Description", "Unit label", "Row type", "Company cost ($)", "Hrs normal", "Hrs difficult", "Hrs very diff."]) {
      const control = field(label);
      expect(control.disabled, label).toBe(true);
      expect(control.title, label).toBe(PRICE_REASON);
    }
    for (const label of ["Category", "Sub-category", "Sector", "Notes"]) {
      expect(field(label).disabled, label).toBe(false);
    }
  });

  for (const [who, session] of HOLDERS) {
    it(`${who}: the same controls are enabled and no reason is shown`, async () => {
      await openItemDrawer(session);
      await waitFor(() => expect(screen.getByDisplayValue("Receptacle, 20A")).toBeTruthy());
      for (const label of ["Description", "Unit label", "Row type", "Company cost ($)", "Hrs normal", "Hrs difficult", "Hrs very diff."]) {
        expect(field(label).disabled, label).toBe(false);
      }
      expect(screen.queryByTestId("power-lock-price_book_edit")).toBeNull();
    });
  }

  describe("the drawer's Save changes sends only what was changed", () => {
    const saveButton = () => screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    const spyUpdate = () => vi.spyOn(api, "pbCatalogUpdateItem").mockResolvedValue({ atomic: atomic() });

    for (const [who, session] of [["a session without the power", OWNER_NO_GRANT], ["Kyle at the PIN", PIN_SESSION]] as const) {
      it(`a row with no row type, untouched, is not dirty for ${who}`, async () => {
        await openItemDrawer(session, atomic({ rowType: null }));
        await waitFor(() => expect(screen.getByDisplayValue("Receptacle, 20A")).toBeTruthy());
        expect(field("Row type").value).toBe("MATERIAL + LABOR");
        expect(saveButton().disabled).toBe(true);
        expect(screen.queryByText(/Unsaved edits/)).toBeNull();
      });

      it(`a description with a trailing space, untouched, is not dirty for ${who}`, async () => {
        await openItemDrawer(session, atomic({ description: "Receptacle, 20A ", unitLabel: " ea" }));
        await waitFor(() => expect(field("Category")).toBeTruthy());
        expect(saveButton().disabled).toBe(true);
      });
    }

    it("a non-Kyle Notes-only edit sends only notes", async () => {
      await openItemDrawer(OWNER_NO_GRANT, atomic({ rowType: null, description: "Receptacle, 20A ", unitLabel: " ea" }));
      const update = spyUpdate();
      await waitFor(() => expect(field("Notes")).toBeTruthy());
      fireEvent.change(field("Notes"), { target: { value: "a better note" } });
      expect(saveButton().disabled).toBe(false);
      fireEvent.click(saveButton());
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      expect(update).toHaveBeenCalledWith("A100", { notes: "a better note" });
    });

    it("a non-Kyle Category edit sends only the category", async () => {
      await openItemDrawer(OWNER_NO_GRANT);
      const update = spyUpdate();
      await waitFor(() => expect(field("Category")).toBeTruthy());
      fireEvent.change(field("Category"), { target: { value: "LIGHTING" } });
      fireEvent.click(saveButton());
      await waitFor(() => expect(update).toHaveBeenCalledWith("A100", { category: "LIGHTING" }));
    });

    it("Kyle's edit to the description sends the description and nothing else", async () => {
      await openItemDrawer(PIN_SESSION, atomic({ rowType: null }));
      const update = spyUpdate();
      await waitFor(() => expect(screen.getByDisplayValue("Receptacle, 20A")).toBeTruthy());
      fireEvent.change(field("Description"), { target: { value: "Receptacle, 20A tamper-resistant" } });
      fireEvent.click(saveButton());
      await waitFor(() => expect(update).toHaveBeenCalledWith("A100", { description: "Receptacle, 20A tamper-resistant" }));
    });

    it("Kyle's change of cost still goes through", async () => {
      await openItemDrawer(PIN_SESSION);
      const update = spyUpdate();
      await waitFor(() => expect(screen.getByDisplayValue("Receptacle, 20A")).toBeTruthy());
      fireEvent.change(field("Company cost ($)"), { target: { value: "6.5" } });
      fireEvent.click(saveButton());
      await waitFor(() => expect(update).toHaveBeenCalledWith("A100", { companyCost: 6.5 }));
    });
  });

  it("an assembly's components editor and labour override are greyed together, with the reason", async () => {
    const child = { itemId: "C1", description: "Breaker", companyCost: 4, laborNormal: 0.1, laborDifficult: 0.1, laborVeryDifficult: 0.1, rowType: "MATERIAL ONLY", category: "X", laborUnitDivisor: 1 };
    const tier = { value: 1, complete: true, missingItemIds: [] };
    const detail = {
      atomic: atomic({ itemId: "ASM1", description: "EV charger", rowType: "ASSEMBLY" }),
      components: [{ id: "k1", parentItemId: "ASM1", childItemId: "C1", quantity: 2, child }],
      rollup: { companyCost: 8, costComplete: true, unpricedComponentItemIds: [], labor: { laborNormal: tier, laborDifficult: tier, laborVeryDifficult: tier } },
      labor: {
        laborNormal: { value: 1, overridden: false, driftFromComputed: null },
        laborDifficult: { value: 1, overridden: false, driftFromComputed: null },
        laborVeryDifficult: { value: 1, overridden: false, driftFromComputed: null },
      },
    } as unknown as PbAssemblyDetail;
    await openItemDrawer(OWNER_NO_GRANT, detail.atomic, detail);
    await screen.findByText("Components");
    const editor = screen.getByText("Components").closest("fieldset") as HTMLFieldSetElement;
    expect(editor.disabled).toBe(true);
    expect(within(editor).getByPlaceholderText("Search by ID or description to attach…")).toBeDisabled();
    expect(within(editor).getByRole("spinbutton")).toBeDisabled(); // the quantity
    expect(within(editor).getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(within(editor).getByRole("button", { name: "Save components" })).toBeDisabled();
    expect(within(editor).getAllByPlaceholderText("new override").length).toBe(3);
    for (const box of within(editor).getAllByPlaceholderText("new override")) expect(box).toBeDisabled();
    expect(screen.getByTestId("power-lock-price_book_edit").textContent).toBe(PRICE_REASON);
  });

  it("an assembly's components editor is live for a session with the power", async () => {
    const child = { itemId: "C1", description: "Breaker", companyCost: 4, laborNormal: 0.1, laborDifficult: 0.1, laborVeryDifficult: 0.1, rowType: "MATERIAL ONLY", category: "X", laborUnitDivisor: 1 };
    const tier = { value: 1, complete: true, missingItemIds: [] };
    const detail = {
      atomic: atomic({ itemId: "ASM1", description: "EV charger", rowType: "ASSEMBLY" }),
      components: [{ id: "k1", parentItemId: "ASM1", childItemId: "C1", quantity: 2, child }],
      rollup: { companyCost: 8, costComplete: true, unpricedComponentItemIds: [], labor: { laborNormal: tier, laborDifficult: tier, laborVeryDifficult: tier } },
      labor: {
        laborNormal: { value: 1, overridden: false, driftFromComputed: null },
        laborDifficult: { value: 1, overridden: false, driftFromComputed: null },
        laborVeryDifficult: { value: 1, overridden: false, driftFromComputed: null },
      },
    } as unknown as PbAssemblyDetail;
    await openItemDrawer(PIN_SESSION, detail.atomic, detail);
    await screen.findByText("Components");
    const editor = screen.getByText("Components").closest("fieldset") as HTMLFieldSetElement;
    expect(editor.disabled).toBe(false);
    expect(within(editor).getByRole("button", { name: "Remove" })).toBeEnabled();
    expect(within(editor).getByPlaceholderText("Search by ID or description to attach…")).toBeEnabled();
  });
});

describe("Price Book: new item", () => {
  async function openNew(session: SessionView) {
    vi.spyOn(api, "session").mockResolvedValue(session);
    vi.spyOn(api, "pbCatalogCategories").mockResolvedValue({ categories: [] });
    renderWithProviders(<PriceBookCatalogPage />);
    fireEvent.click(await screen.findByRole("button", { name: "+ New item" }));
    await screen.findByText("New price book item");
  }

  it("the cost and hours boxes are greyed with the reason without the power; description, row type and unit label stay open", async () => {
    await openNew(OWNER_NO_GRANT);
    await waitFor(() => expect(screen.getByTestId("power-lock-price_book_edit").textContent).toBe(PRICE_REASON));
    for (const label of ["Company cost ($)", "Hrs normal", "Hrs difficult", "Hrs very diff."]) expect(field(label).disabled, label).toBe(true);
    for (const label of ["Description", "Row type", "Unit label", "Notes"]) expect(field(label).disabled, label).toBe(false);
  });

  it("they are live for the PIN", async () => {
    await openNew(PIN_SESSION);
    await waitFor(() => expect(field("Company cost ($)")).toBeTruthy());
    for (const label of ["Company cost ($)", "Hrs normal", "Hrs difficult", "Hrs very diff."]) expect(field(label).disabled, label).toBe(false);
    expect(screen.queryByTestId("power-lock-price_book_edit")).toBeNull();
  });
});

describe("Price Book: new assembly", () => {
  it("its components and labour hours are greyed with the reason without the power, and live with it", async () => {
    for (const [session, locked] of [[OWNER_NO_GRANT, true], [ownerWith("price_book_edit"), false]] as const) {
      vi.restoreAllMocks();
      vi.spyOn(api, "session").mockResolvedValue(session);
      vi.spyOn(api, "pbCatalogCategories").mockResolvedValue({ categories: [] });
      const { unmount } = renderWithProviders(<PriceBookCatalogPage />);
      fireEvent.click(await screen.findByRole("button", { name: "+ Create assembly" }));
      await screen.findByText("New assembly");
      const search = screen.getByPlaceholderText("Search by ID or description to attach…");
      await waitFor(() => expect(search.matches(":disabled")).toBe(locked));
      expect(Boolean(screen.queryByTestId("power-lock-price_book_edit"))).toBe(locked);
      expect(field("Description").disabled).toBe(false);
      unmount();
    }
  });
});

// ─── Settings -> Billed labor rate ───────────────────────────────────────────────────────────

describe("Settings -> Billed labor rate", () => {
  function show(session: SessionView) {
    vi.spyOn(api, "session").mockResolvedValue(session);
    vi.spyOn(api, "billedRate").mockResolvedValue({ rate: 100 });
    renderWithProviders(<BilledRateSection />);
  }

  it("without the power the box and both buttons are greyed with the reason", async () => {
    show(OWNER_NO_GRANT);
    await waitFor(() => expect(screen.getByTestId("power-lock-price_book_edit").textContent).toBe(PRICE_REASON));
    expect((screen.getByLabelText("New hourly rate ($)") as HTMLInputElement).disabled).toBe(true);
    for (const name of [/Preview the change/, /Apply/]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(PRICE_REASON);
    }
  });

  it("with the power, and for the PIN, the box takes a rate and Preview wakes up", async () => {
    for (const session of [ownerWith("price_book_edit"), PIN_SESSION]) {
      vi.restoreAllMocks();
      show(session);
      await waitFor(() => expect(screen.getByTestId("billed-rate-current").textContent).toMatch(/100/));
      const box = screen.getByLabelText("New hourly rate ($)") as HTMLInputElement;
      expect(box.disabled).toBe(false);
      fireEvent.change(box, { target: { value: "112.5" } });
      expect((screen.getByRole("button", { name: /Preview the change/ }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByTestId("power-lock-price_book_edit")).toBeNull();
      document.body.innerHTML = "";
    }
  });
});

// ─── Materials -> Promote ────────────────────────────────────────────────────────────────────

describe("Purchasing & Stock -> Materials -> Promote", () => {
  const material: MaterialRow = {
    id: "m1", upc: null, sku: null, supplier: null, description: "Ten pack", packQty: 10, packUnit: "ea", lastCost: 50,
    lastSeenAt: "2026-11-01T00:00:00.000Z", firstSeenAt: "2026-11-01T00:00:00.000Z", symbology: null, itemId: null,
  };
  function show(session: SessionView) {
    vi.spyOn(api, "session").mockResolvedValue(session);
    vi.spyOn(api, "pbCatalogCategories").mockResolvedValue({ categories: [] });
    const promote = vi.spyOn(api, "promoteMaterial").mockResolvedValue({ material, atomic: atomic() });
    renderWithProviders(<PromoteForm material={material} onDone={() => {}} onCancel={() => {}} />);
    return promote;
  }
  const costBox = () => screen.getByText("Cost/ea $").nextElementSibling as HTMLInputElement;

  it("without the power the cost and hours boxes are greyed with the reason and empty, and Promote sends no cost and no hours", async () => {
    const promote = show(OWNER_NO_GRANT);
    await waitFor(() => expect(screen.getByTestId("power-lock-price_book_edit").textContent).toBe(PRICE_REASON));
    for (const label of ["Cost/ea $", "Hrs normal", "difficult", "very diff."]) {
      const box = screen.getByText(label).nextElementSibling as HTMLInputElement;
      expect(box.disabled, label).toBe(true);
      expect(box.title, label).toBe(PRICE_REASON);
      expect(box.value, label).toBe("");
    }
    // Description, category and unit stay open.
    expect((screen.getByPlaceholderText("Description") as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(screen.getByPlaceholderText("Category"), { target: { value: "DEVICES" } });
    fireEvent.click(screen.getByRole("button", { name: "Promote" }));
    await waitFor(() => expect(promote).toHaveBeenCalledTimes(1));
    expect(promote.mock.calls[0][1]).toMatchObject({ companyCost: null, laborNormal: null, laborDifficult: null, laborVeryDifficult: null });
  });

  it("with the power the cost is pre-filled from the pack and sent", async () => {
    const promote = show(PIN_SESSION);
    await waitFor(() => expect(costBox().value).toBe("5"));
    expect(costBox().disabled).toBe(false);
    fireEvent.change(screen.getByPlaceholderText("Category"), { target: { value: "DEVICES" } });
    fireEvent.click(screen.getByRole("button", { name: "Promote" }));
    await waitFor(() => expect(promote).toHaveBeenCalledTimes(1));
    expect(promote.mock.calls[0][1]).toMatchObject({ companyCost: 5 });
  });
});

// ─── Settings -> Treasury Save ───────────────────────────────────────────────────────────────

describe("Settings -> Treasury", () => {
  function show(session: SessionView) {
    vi.spyOn(api, "session").mockResolvedValue(session);
    vi.spyOn(api, "treasurySettings").mockResolvedValue({
      mainFinancialAccountId: null, mainFloat: 0, truckFloats: {}, chaseAccountLabel: null, chaseExternalAccountId: null,
    });
    vi.spyOn(api, "financialsBalances").mockResolvedValue({ available: false, reason: "not connected" } as never);
    vi.spyOn(api, "trucks").mockResolvedValue({ trucks: [] } as never);
    const save = vi.spyOn(api, "saveTreasurySettings").mockImplementation(async (v) => v);
    renderWithProviders(<TreasurySection />);
    return save;
  }

  it("Save treasury is greyed with the reason for a session without the treasury power, and does not save", async () => {
    const save = show(OWNER_NO_GRANT);
    await waitFor(() => expect(screen.getByTestId("power-lock-treasury").textContent).toBe(TREASURY_REASON));
    const button = screen.getByRole("button", { name: "Save treasury" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(TREASURY_REASON);
    fireEvent.click(button);
    expect(save).not.toHaveBeenCalled();
  });

  it("a price-book grant does not unlock Treasury", async () => {
    show(ownerWith("price_book_edit"));
    await waitFor(() => expect(screen.getByTestId("power-lock-treasury")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Save treasury" }) as HTMLButtonElement).disabled).toBe(true);
  });

  for (const [who, session] of [["a login granted treasury", ownerWith("treasury")], ["the PIN", PIN_SESSION], ["Kyle's principal login", PRINCIPAL_SESSION]] as const) {
    it(`Save treasury is live for ${who}`, async () => {
      const save = show(session);
      await waitFor(() => expect(screen.getByRole("button", { name: "Save treasury" })).toBeTruthy());
      await waitFor(() => expect((screen.getByRole("button", { name: "Save treasury" }) as HTMLButtonElement).disabled).toBe(false));
      expect(screen.queryByTestId("power-lock-treasury")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Save treasury" }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    });
  }
});

// ─── Financials -> Month-end sweep ───────────────────────────────────────────────────────────

describe("Financials -> Month-end sweep", () => {
  const view: SweepView = {
    asOf: "2026-11-30T12:00:00.000Z", stripeAvailable: true, stripeReason: null,
    main: { financialAccountId: "fa_1", balance: 1500, inboundPending: 0, outboundPending: 0, float: 1000, excess: 500 },
    trucks: [], destination: { label: "Chase savings", externalAccountId: "ba_1" }, canSweep: true, reason: null, recent: [],
  };
  function show(session: SessionView) {
    vi.spyOn(api, "session").mockResolvedValue(session);
    vi.spyOn(api, "financialsSweep").mockResolvedValue(view);
    localStorage.setItem("rce.card.month-end-sweep", "1"); // the card remembers open/closed per id
    renderWithProviders(<MonthEndSweepCard />);
  }
  const sweepButton = () => screen.getByRole("button", { name: /^Sweep \$500\.00 to Chase savings/ }) as HTMLButtonElement;

  it("'Sweep $X to Chase' is greyed with the reason for a session without treasury, and does not open the confirm", async () => {
    show(OWNER_NO_GRANT);
    await screen.findByRole("button", { name: /^Sweep \$500\.00 to Chase savings/ });
    await waitFor(() => expect(screen.getByTestId("power-lock-treasury").textContent).toBe(TREASURY_REASON));
    expect(sweepButton().disabled).toBe(true);
    expect(sweepButton().title).toBe(TREASURY_REASON);
    fireEvent.click(sweepButton());
    expect(screen.queryByText("Confirm the sweep")).toBeNull();
  });

  for (const [who, session] of [["a login granted treasury", ownerWith("treasury")], ["the PIN", PIN_SESSION], ["Kyle's principal login", PRINCIPAL_SESSION]] as const) {
    it(`it is live for ${who} and opens the confirm`, async () => {
      show(session);
      await screen.findByRole("button", { name: /^Sweep \$500\.00 to Chase savings/ });
      await waitFor(() => expect(sweepButton().disabled).toBe(false));
      expect(screen.queryByTestId("power-lock-treasury")).toBeNull();
      fireEvent.click(sweepButton());
      expect(await screen.findByText("Confirm the sweep")).toBeTruthy();
    });
  }
});
