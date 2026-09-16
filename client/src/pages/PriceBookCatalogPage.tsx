/**
 * Price Book — the full in-app editor.
 *
 * Kyle, 2026-08-30 (Option A ratified): "We can add a new tab that is labeled
 * 'Price Book' that will be the full in-app editor." The workbook is history;
 * this screen is where items are added, retired, repriced, and organized.
 *
 * Ground rules carried from the import:
 *  - Prices RECOMPUTE server-side with the workbook's exact math (tier markup
 *    on cost, hours × the billed rate + material). The sell columns here are display only.
 *  - Every change writes an audit row — the drawer shows the item's history.
 *  - Items RETIRE, never delete: estimate lines reference them forever.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { api, fetchProtectedObjectUrl } from "../lib/api";
import type {
  PbCatalogAtomic,
  PbCatalogCreate,
  PbCatalogPatch,
  PbAssemblyCreate,
  PbAssemblyComponentInput,
  PbLaborTier,
} from "../lib/api";

const money = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `$${v.toFixed(2)}`);
const hours = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(v));

const ROW_TYPES = ["MATERIAL + LABOR", "LABOR ONLY", "MATERIAL ONLY"] as const;

/** The one rowType that isn't a purchasable item — see src/services/priceBookAssembly.ts. */
const isAssemblyRowType = (rowType: string | null | undefined) => (rowType ?? "").toUpperCase() === "ASSEMBLY";

/** Empty string in a text input means "clear it" — the API wants null for that. */
const textOrNull = (s: string): string | null => (s.trim() === "" ? null : s.trim());
const numOrNull = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// ─── Assembly component picker + live rollup preview — shared by CreateAssemblyDrawer (new
// assembly) and ItemDrawer's assembly-editing surface (Unit 4, 2026-09-16). Lifted here so there
// is exactly one copy of the search-and-attach picker and one copy of the client-side rollup
// preview math (which mirrors computeComponentRollup in priceBookAssembly.ts for display only —
// the server always recomputes authoritatively on save).

const MIN_PICKER_SEARCH_LEN = 2;

const LABOR_TIER_LIST: Array<{ key: PbLaborTier; label: string }> = [
  { key: "laborNormal", label: "Normal" },
  { key: "laborDifficult", label: "Difficult" },
  { key: "laborVeryDifficult", label: "Very difficult" },
];

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** The subset of an item's fields the picker/preview need — both a full search result
 * (PbCatalogAtomic) and an assembly's fetched component child (PbAssemblyComponentChild)
 * structurally satisfy this, so the same PickedComponent/previewRollup works for both drawers. */
type PbComponentFacts = Pick<
  PbCatalogAtomic,
  "itemId" | "description" | "companyCost" | "laborNormal" | "laborDifficult" | "laborVeryDifficult" | "laborUnitDivisor" | "rowType"
>;

interface PickedComponent {
  atomic: PbComponentFacts;
  quantity: number;
}

interface PreviewTier {
  value: number | null;
  complete: boolean;
  missing: PickedComponent[];
}

interface PreviewRollup {
  companyCost: number | null;
  costComplete: boolean;
  unpriced: PickedComponent[];
  labor: Record<PbLaborTier, PreviewTier>;
}

/** Mirrors computeComponentRollup (priceBookAssembly.ts) for a live, client-only preview. A
 * component missing a cost or a tier's labour (or its unit divisor) makes that figure INCOMPLETE
 * rather than summed around — never a confident partial number. */
function previewRollup(picked: PickedComponent[]): PreviewRollup {
  let costSum = 0;
  let costComplete = true;
  const unpriced: PickedComponent[] = [];
  for (const p of picked) {
    if (p.atomic.companyCost === null || p.atomic.companyCost === undefined) {
      costComplete = false;
      unpriced.push(p);
    } else {
      costSum += p.atomic.companyCost * p.quantity;
    }
  }

  const labor = {} as Record<PbLaborTier, PreviewTier>;
  for (const { key: tier } of LABOR_TIER_LIST) {
    let sum = 0;
    let complete = true;
    const missing: PickedComponent[] = [];
    for (const p of picked) {
      const value = p.atomic[tier];
      const divisor = p.atomic.laborUnitDivisor;
      if (value === null || value === undefined || divisor === null || divisor === undefined || divisor <= 0) {
        complete = false;
        missing.push(p);
      } else {
        sum += (p.quantity * value) / divisor;
      }
    }
    labor[tier] = { value: complete ? round4(sum) : null, complete, missing };
  }

  return { companyCost: costComplete ? round2(costSum) : null, costComplete, unpriced, labor };
}

/** The search-and-attach control itself — type to search the whole book, click a result to
 * attach it. Excludes whatever the caller has already filtered out of `results` (assemblies,
 * already-picked items, self-reference). */
function ComponentPicker({
  search, onSearchChange, results, loading, onAdd,
}: {
  search: string;
  onSearchChange: (v: string) => void;
  results: PbCatalogAtomic[];
  loading: boolean;
  onAdd: (atomic: PbCatalogAtomic) => void;
}) {
  const active = search.trim().length >= MIN_PICKER_SEARCH_LEN;
  return (
    <>
      <input
        type="search"
        className={inputCls}
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search by ID or description to attach…"
      />
      {active ? (
        <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-rce-border/60">
          {loading ? (
            <p className="p-2 text-xs text-rce-muted">Searching…</p>
          ) : results.length === 0 ? (
            <p className="p-2 text-xs text-rce-soft">No matching, non-assembly items.</p>
          ) : (
            results.map((a) => (
              <button
                key={a.itemId}
                type="button"
                className="flex w-full items-center justify-between gap-2 border-t border-rce-border/40 px-2 py-1.5 text-left text-xs first:border-t-0 hover:bg-rce-accentBg/40"
                onClick={() => onAdd(a)}
              >
                <span className="min-w-0 truncate">
                  <span className="font-mono text-rce-muted">{a.itemId}</span> {a.description}
                </span>
                <span className="shrink-0 text-rce-muted">{money(a.companyCost)}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </>
  );
}

export function PriceBookCatalogPage() {
  const qc = useQueryClient();
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  // null = "not yet chosen, browsing the sub-category grid"; once chosen this holds the picked
  // sub-category, where `name: null` is the real "no sub-category" bucket (most items have none).
  const [selectedSubCategory, setSelectedSubCategory] = useState<{ name: string | null } | null>(null);
  const [search, setSearch] = useState("");
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingAssembly, setCreatingAssembly] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState("");

  const { data: catData } = useQuery({
    queryKey: ["pbCatalogCategories"],
    queryFn: () => api.pbCatalogCategories(),
  });
  const categories = catData?.categories ?? [];

  // A live search sweeps the whole book; otherwise the table shows one category.
  const activeSearch = search.trim().length >= 2 ? search.trim() : "";
  const listCategory = activeSearch ? "" : (selectedCategory ?? "");
  const { data: itemData, isLoading: itemsLoading } = useQuery({
    queryKey: ["pbCatalogItems", listCategory, activeSearch],
    queryFn: () => api.pbCatalogItems({ category: listCategory || undefined, search: activeSearch || undefined }),
    enabled: Boolean(listCategory || activeSearch),
  });
  const items = itemData?.atomics ?? [];

  const { data: retiredData } = useQuery({
    queryKey: ["pbCatalogRetired"],
    queryFn: () => api.pbCatalogRetired(),
    enabled: showRetired,
  });

  const invalidateBook = () => {
    void qc.invalidateQueries({ queryKey: ["pbCatalogCategories"] });
    void qc.invalidateQueries({ queryKey: ["pbCatalogItems"] });
    void qc.invalidateQueries({ queryKey: ["pbCatalogRetired"] });
  };

  const renameMutation = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) => api.pbCatalogRenameCategory(from, to),
    onSuccess: (_d, vars) => {
      setSelectedCategory(vars.to);
      setRenaming(false);
      invalidateBook();
    },
  });

  const orderMutation = useMutation({
    mutationFn: (names: string[]) => api.pbCatalogCategoryOrder(names),
    onSuccess: invalidateBook,
  });

  const moveCategory = (name: string, dir: -1 | 1) => {
    const names = categories.map((c) => c.name);
    const i = names.indexOf(name);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= names.length) return;
    [names[i], names[j]] = [names[j], names[i]];
    orderMutation.mutate(names);
  };

  const restoreMutation = useMutation({
    mutationFn: (itemId: string) => api.pbCatalogRestoreItem(itemId),
    onSuccess: invalidateBook,
  });

  // Card-grid browse state for the selected category (server-provided counts — never derived
  // from `items`, which only holds whatever category/search is currently fetched).
  const selectedCategoryMeta = categories.find((c) => c.name === selectedCategory) ?? null;
  const subCategoriesForSelected = selectedCategoryMeta?.subCategories ?? [];
  // A category whose items are ALL sub-category-less has exactly one bucket, name null — that's
  // real data, not a browsable choice, so it must not strand the user on an empty picker screen.
  const onlyNullSubCategory =
    subCategoriesForSelected.length === 1 && subCategoriesForSelected[0].name === null;

  // With a sub-category explicitly picked, filter the fetched category's items down to it.
  const visibleItems = selectedSubCategory
    ? items.filter((it) => (it.subCategory ?? null) === selectedSubCategory.name)
    : items;

  // Sub-categories group the table the way the workbook's sections did.
  const grouped = useMemo(() => {
    const map = new Map<string, PbCatalogAtomic[]>();
    for (const it of visibleItems) {
      const key = it.subCategory ?? "";
      const arr = map.get(key) ?? [];
      arr.push(it);
      map.set(key, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visibleItems]);

  return (
    <div className="space-y-4 pb-24">
      <PageHeader
        title="Price Book"
        subtitle="Every item and price in the book — edited here, recomputed with the book's own math"
      />

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search the whole book — ID or description"
          className="w-full max-w-sm rounded-lg border border-rce-border bg-rce-surface px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-lg bg-rce-accent px-3 py-2 text-sm font-medium text-white"
        >
          + New item
        </button>
        <button
          type="button"
          onClick={() => setCreatingAssembly(true)}
          className="rounded-lg border border-rce-accent px-3 py-2 text-sm font-medium text-rce-accentDark"
        >
          + Create assembly
        </button>
        <button
          type="button"
          onClick={() => setShowRetired((v) => !v)}
          className={`rounded-lg border px-3 py-2 text-sm ${
            showRetired ? "border-rce-accent text-rce-accentDark" : "border-rce-border text-rce-muted"
          }`}
        >
          Retired items
        </button>
        <button
          type="button"
          disabled={exporting}
          onClick={() => {
            // A snapshot of the book as a spreadsheet — a report, not an input.
            setExporting(true);
            void fetchProtectedObjectUrl("/price-book/catalog/export")
              .then((url) => {
                const a = document.createElement("a");
                a.href = url;
                a.download = `RCE-price-book-${new Date().toISOString().slice(0, 10)}.xlsx`;
                a.click();
                URL.revokeObjectURL(url);
              })
              .finally(() => setExporting(false));
          }}
          className="rounded-lg border border-rce-border px-3 py-2 text-sm text-rce-muted disabled:opacity-50"
        >
          {exporting ? "Building…" : "Download .xlsx"}
        </button>
      </div>

      {/* Category / sub-category card grid — request 1, 2026-09-16 ("I would like this to be a
          grid with clickable cards. Still following the Category -> sub-category design."). */}
      {!activeSearch && (
        <div className="space-y-3">
          <nav className="flex flex-wrap items-center gap-1 text-xs">
            <button
              type="button"
              onClick={() => { setSelectedCategory(null); setSelectedSubCategory(null); setRenaming(false); }}
              className={!selectedCategory ? "font-semibold text-rce-text" : "text-rce-muted hover:text-rce-text"}
            >
              All categories
            </button>
            {selectedCategory && (
              <>
                <span className="text-rce-soft">/</span>
                <button
                  type="button"
                  onClick={() => setSelectedSubCategory(null)}
                  className={
                    !selectedSubCategory ? "font-semibold text-rce-text" : "text-rce-muted hover:text-rce-text"
                  }
                >
                  {selectedCategory}
                </button>
              </>
            )}
            {selectedSubCategory && (
              <>
                <span className="text-rce-soft">/</span>
                <span className="font-semibold text-rce-text">{selectedSubCategory.name ?? "Uncategorized"}</span>
              </>
            )}
          </nav>

          {!selectedCategory && (
            <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {categories.map((c) => {
                const subCount = c.subCategories.length > 1 || (c.subCategories.length === 1 && c.subCategories[0].name !== null)
                  ? c.subCategories.length
                  : 0;
                return (
                  <button
                    key={c.name}
                    type="button"
                    onClick={() => { setSelectedCategory(c.name); setSelectedSubCategory(null); setRenaming(false); }}
                    className="card space-y-1 p-3 text-left transition hover:border-rce-accent"
                  >
                    <div className="font-medium text-rce-text">{c.name}</div>
                    <div className="text-xs text-rce-muted">
                      {c.count} item{c.count === 1 ? "" : "s"}
                      {subCount > 0 ? ` · ${subCount} sub-categor${subCount === 1 ? "y" : "ies"}` : ""}
                    </div>
                  </button>
                );
              })}
              {categories.length === 0 && (
                <p className="text-sm text-rce-soft">No categories yet — create an item to start one.</p>
              )}
            </div>
          )}

          {selectedCategory && !selectedSubCategory && !onlyNullSubCategory && (
            <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {subCategoriesForSelected.map((s) => (
                <button
                  key={s.name ?? "(none)"}
                  type="button"
                  onClick={() => setSelectedSubCategory({ name: s.name })}
                  className="card space-y-1 p-3 text-left transition hover:border-rce-accent"
                >
                  <div className="font-medium text-rce-text">{s.name ?? "Uncategorized"}</div>
                  <div className="text-xs text-rce-muted">{s.count} item{s.count === 1 ? "" : "s"}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {!activeSearch && selectedCategory && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-rce-muted">
          {renaming ? (
            <>
              <input
                value={renameText}
                onChange={(e) => setRenameText(e.target.value)}
                className="rounded border border-rce-border bg-rce-surface px-2 py-1 text-sm"
                placeholder="New category name"
              />
              <button
                type="button"
                className="rounded bg-rce-accent px-2 py-1 font-medium text-white"
                disabled={renameMutation.isPending || renameText.trim().length === 0}
                onClick={() => renameMutation.mutate({ from: selectedCategory, to: renameText.trim() })}
              >
                Save name
              </button>
              <button type="button" className="px-1" onClick={() => setRenaming(false)}>Cancel</button>
              {renameMutation.isError ? (
                <span className="text-red-600">{(renameMutation.error as Error).message}</span>
              ) : null}
            </>
          ) : (
            <>
              <button
                type="button"
                className="rounded border border-rce-border px-2 py-1"
                onClick={() => { setRenameText(selectedCategory); setRenaming(true); }}
              >
                Rename category
              </button>
              <button type="button" className="rounded border border-rce-border px-2 py-1" onClick={() => moveCategory(selectedCategory, -1)}>
                ← Move earlier
              </button>
              <button type="button" className="rounded border border-rce-border px-2 py-1" onClick={() => moveCategory(selectedCategory, 1)}>
                Move later →
              </button>
            </>
          )}
        </div>
      )}

      {showRetired && (
        <div className="card space-y-2 p-3">
          <div className="text-sm font-semibold">Retired items</div>
          {(retiredData?.atomics ?? []).length === 0 ? (
            <p className="text-sm text-rce-soft">Nothing has been retired.</p>
          ) : (
            (retiredData?.atomics ?? []).map((r) => (
              <div key={r.itemId} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-mono text-xs text-rce-muted">{r.itemId}</span> {r.description}
                  <span className="ml-2 text-xs text-rce-soft">{r.category}</span>
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded border border-rce-border px-2 py-1 text-xs"
                  onClick={() => restoreMutation.mutate(r.itemId)}
                >
                  Restore
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {itemsLoading && <p className="text-sm text-rce-muted">Loading items…</p>}
      {!itemsLoading && (listCategory || activeSearch) && visibleItems.length === 0 && (
        <p className="rounded-lg border border-dashed border-rce-border/60 p-6 text-center text-sm text-rce-soft">
          {activeSearch ? "Nothing matches that search." : "No items in this category yet."}
        </p>
      )}

      {grouped.map(([sub, rows]) => (
        <div key={sub || "(none)"} className="space-y-1">
          {sub ? <div className="text-xs font-semibold uppercase tracking-wide text-rce-muted">{sub}</div> : null}
          <div className="overflow-x-auto rounded-lg border border-rce-border/70">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="bg-rce-surface text-left text-xs uppercase tracking-wide text-rce-muted">
                  <th className="px-2 py-1.5">ID</th>
                  <th className="px-2 py-1.5">Description</th>
                  <th className="px-2 py-1.5">Unit</th>
                  <th className="px-2 py-1.5">Type</th>
                  <th className="px-2 py-1.5 text-right">Cost</th>
                  <th className="px-2 py-1.5 text-right">Hrs N/D/VD</th>
                  <th className="px-2 py-1.5 text-right">Sell N</th>
                  <th className="px-2 py-1.5 text-right">Sell D</th>
                  <th className="px-2 py-1.5 text-right">Sell VD</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((it) => (
                  <tr
                    key={it.itemId}
                    onClick={() => setOpenItemId(it.itemId)}
                    className="cursor-pointer border-t border-rce-border/50 hover:bg-rce-accentBg/40"
                  >
                    <td className="px-2 py-1.5 font-mono text-xs">{it.itemId}</td>
                    <td className="px-2 py-1.5">{it.description}</td>
                    <td className="px-2 py-1.5 text-xs text-rce-muted">{it.unitLabel ?? "—"}</td>
                    <td className="px-2 py-1.5 text-xs">
                      {isAssemblyRowType(it.rowType) ? (
                        <span className="rounded-full bg-rce-accent/15 px-2 py-0.5 font-medium text-rce-accentDark">
                          ASSEMBLY
                        </span>
                      ) : (
                        <span className="text-rce-muted">{it.rowType ?? "—"}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right">{money(it.companyCost)}</td>
                    <td className="px-2 py-1.5 text-right text-xs text-rce-muted">
                      {hours(it.laborNormal)} / {hours(it.laborDifficult)} / {hours(it.laborVeryDifficult)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-medium">{money(it.sellNormal)}</td>
                    <td className="px-2 py-1.5 text-right">{money(it.sellDifficult)}</td>
                    <td className="px-2 py-1.5 text-right">{money(it.sellVeryDifficult)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {openItemId && (
        <ItemDrawer
          itemId={openItemId}
          categories={categories.map((c) => c.name)}
          onClose={() => setOpenItemId(null)}
          onChanged={invalidateBook}
        />
      )}
      {creating && (
        <NewItemDrawer
          defaultCategory={selectedCategory ?? ""}
          categories={categories.map((c) => c.name)}
          onClose={() => setCreating(false)}
          onCreated={(atomic) => {
            setCreating(false);
            setSelectedCategory(atomic.category ?? selectedCategory);
            invalidateBook();
          }}
        />
      )}
      {creatingAssembly && (
        <CreateAssemblyDrawer
          defaultCategory={selectedCategory ?? ""}
          categories={categories.map((c) => c.name)}
          onClose={() => setCreatingAssembly(false)}
          onCreated={(atomic) => {
            setCreatingAssembly(false);
            setSelectedCategory(atomic.category ?? selectedCategory);
            invalidateBook();
          }}
        />
      )}
    </div>
  );
}

/** Shared drawer chrome: full-screen scrim, panel pinned right (bottom on phones). */
function DrawerShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 md:items-stretch md:justify-end" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-rce-surface p-4 md:max-h-none md:w-[480px] md:rounded-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-heading text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded px-2 py-1 text-sm text-rce-muted">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-0.5 block text-xs font-medium uppercase tracking-wide text-rce-muted">{label}</span>
      {children}
    </label>
  );
}

const inputCls = "w-full rounded-lg border border-rce-border bg-white px-2.5 py-1.5 text-sm";

function ItemDrawer({
  itemId, categories, onClose, onChanged,
}: {
  itemId: string;
  categories: string[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["pbCatalogItem", itemId],
    queryFn: () => api.pbCatalogItem(itemId),
  });
  const atomic = data?.atomic;

  // Form state mirrors the editable fields as strings; seeded once per fetch.
  const [form, setForm] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!atomic) return;
    setForm({
      description: atomic.description ?? "",
      category: atomic.category ?? "",
      subCategory: atomic.subCategory ?? "",
      unitLabel: atomic.unitLabel ?? "",
      sector: atomic.sector ?? "",
      rowType: atomic.rowType ?? "MATERIAL + LABOR",
      notes: atomic.notes ?? "",
      companyCost: atomic.companyCost === null ? "" : String(atomic.companyCost),
      laborNormal: atomic.laborNormal === null ? "" : String(atomic.laborNormal),
      laborDifficult: atomic.laborDifficult === null ? "" : String(atomic.laborDifficult),
      laborVeryDifficult: atomic.laborVeryDifficult === null ? "" : String(atomic.laborVeryDifficult),
    });
  }, [atomic]);

  const saveMutation = useMutation({
    mutationFn: (patch: PbCatalogPatch) => api.pbCatalogUpdateItem(itemId, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pbCatalogItem", itemId] });
      onChanged();
    },
  });

  const retireMutation = useMutation({
    mutationFn: () => api.pbCatalogRetireItem(itemId),
    onSuccess: () => { onChanged(); onClose(); },
  });

  // ─── Assembly editing (2026-09-16, Unit 4) ───────────────────────────────────────────────
  // "I need edit capability for each assembly created." — the component list, per-tier labour
  // override, and read-only derived cost/hours, all re-rendered from the server's response after
  // every save (never client-typed). Only fetched once we know this row IS an assembly, below.
  const isAssemblyAtomic = isAssemblyRowType(atomic?.rowType);
  const { data: assemblyDetail } = useQuery({
    queryKey: ["pbCatalogAssemblyDetail", itemId],
    queryFn: () => api.pbCatalogAssemblyDetail(itemId),
    enabled: isAssemblyAtomic,
  });

  // The editable component list — a full local copy, reset to the server's truth on every fetch
  // (including right after a save), never merged with unsaved edits from a prior fetch.
  const [assemblyComponents, setAssemblyComponents] = useState<PickedComponent[] | null>(null);
  useEffect(() => {
    if (!assemblyDetail) return;
    setAssemblyComponents(
      assemblyDetail.components.map((c) => ({ atomic: c.child, quantity: c.quantity }))
    );
  }, [assemblyDetail]);

  const [componentPickerSearch, setComponentPickerSearch] = useState("");
  const activeComponentPickerSearch =
    componentPickerSearch.trim().length >= MIN_PICKER_SEARCH_LEN ? componentPickerSearch.trim() : "";
  const { data: componentPickerData, isFetching: componentPickerLoading } = useQuery({
    queryKey: ["pbCatalogAssemblyEditPicker", itemId, activeComponentPickerSearch],
    queryFn: () => api.pbCatalogItems({ search: activeComponentPickerSearch }),
    enabled: Boolean(activeComponentPickerSearch),
  });
  const pickedComponentIds = useMemo(
    () => new Set((assemblyComponents ?? []).map((c) => c.atomic.itemId)),
    [assemblyComponents]
  );
  // No nesting, never re-offer an already-attached item, and never offer the assembly itself.
  const componentPickerResults = (componentPickerData?.atomics ?? [])
    .filter((a) => !isAssemblyRowType(a.rowType) && !pickedComponentIds.has(a.itemId) && a.itemId !== itemId)
    .slice(0, 20);

  const addAssemblyComponent = (picked: PbCatalogAtomic) => {
    setAssemblyComponents((cs) => [...(cs ?? []), { atomic: picked, quantity: 1 }]);
    setComponentPickerSearch("");
  };
  const updateAssemblyQuantity = (childItemId: string, quantity: number) => {
    setAssemblyComponents((cs) => (cs ?? []).map((c) => (c.atomic.itemId === childItemId ? { ...c, quantity } : c)));
  };
  const removeAssemblyComponent = (childItemId: string) => {
    setAssemblyComponents((cs) => (cs ?? []).filter((c) => c.atomic.itemId !== childItemId));
  };

  const componentsPreview = useMemo(
    () => (assemblyComponents ? previewRollup(assemblyComponents) : null),
    [assemblyComponents]
  );

  // Dirty relative to the server's last-saved component list, not the local preview.
  const componentsDirty = useMemo(() => {
    if (!assemblyDetail || !assemblyComponents) return false;
    const saved = assemblyDetail.components.map((c) => ({ childItemId: c.childItemId, quantity: c.quantity }));
    if (saved.length !== assemblyComponents.length) return true;
    const savedMap = new Map(saved.map((s) => [s.childItemId, s.quantity]));
    return assemblyComponents.some((c) => savedMap.get(c.atomic.itemId) !== c.quantity);
  }, [assemblyDetail, assemblyComponents]);

  const validAssemblyQuantities = (assemblyComponents ?? []).every((c) => Number.isFinite(c.quantity) && c.quantity > 0);
  // Open question answered (2026-09-16): computeComponentRollup over an EMPTY list returns
  // companyCost 0 / costComplete TRUE server-side — the UI refuses to save an empty list rather
  // than let a save quietly zero-price a still-live assembly. See report to the architect.
  const canSaveComponents = componentsDirty && validAssemblyQuantities && (assemblyComponents?.length ?? 0) > 0;

  const saveComponentsMutation = useMutation({
    mutationFn: (components: PbAssemblyComponentInput[]) => api.pbCatalogSetAssemblyComponents(itemId, components),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pbCatalogAssemblyDetail", itemId] });
      void qc.invalidateQueries({ queryKey: ["pbCatalogItem", itemId] });
      onChanged();
    },
  });

  const [laborOverrideInputs, setLaborOverrideInputs] = useState<Partial<Record<PbLaborTier, string>>>({});
  const laborOverrideMutation = useMutation({
    mutationFn: ({ tier, value }: { tier: PbLaborTier; value: number | null }) =>
      api.pbCatalogSetLaborOverride(itemId, tier, value),
    onSuccess: (_d, vars) => {
      setLaborOverrideInputs((o) => {
        const next = { ...o };
        delete next[vars.tier];
        return next;
      });
      void qc.invalidateQueries({ queryKey: ["pbCatalogAssemblyDetail", itemId] });
      void qc.invalidateQueries({ queryKey: ["pbCatalogItem", itemId] });
      onChanged();
    },
  });

  if (!atomic || !form) {
    return (
      <DrawerShell title={itemId} onClose={onClose}>
        <p className="text-sm text-rce-muted">Loading…</p>
      </DrawerShell>
    );
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  // An assembly's cost and labour are derived from its components (server: priceBookAssembly.ts)
  // and must never be typed through this generic drawer — see priceBookCatalog.ts's updateAtomic
  // guard, which refuses exactly these fields on an ASSEMBLY row.
  const isAssembly = isAssemblyRowType(atomic.rowType);

  const buildPatch = (): PbCatalogPatch => {
    const patch: PbCatalogPatch = {};
    if (form.description.trim() && form.description.trim() !== (atomic.description ?? "")) patch.description = form.description.trim();
    if (form.category.trim() && form.category.trim() !== (atomic.category ?? "")) patch.category = form.category.trim();
    if (textOrNull(form.subCategory) !== (atomic.subCategory ?? null)) patch.subCategory = textOrNull(form.subCategory);
    if (textOrNull(form.unitLabel) !== (atomic.unitLabel ?? null)) patch.unitLabel = textOrNull(form.unitLabel);
    if (textOrNull(form.sector) !== (atomic.sector ?? null)) patch.sector = textOrNull(form.sector);
    if (textOrNull(form.notes) !== (atomic.notes ?? null)) patch.notes = textOrNull(form.notes);
    // rowType is read-only for assemblies (server: updateAtomic refuses the change outright —
    // it would orphan the component list and freeze the derived cost as a stale typed value).
    if (!isAssembly && form.rowType && form.rowType !== (atomic.rowType ?? "")) patch.rowType = form.rowType;
    if (!isAssembly) {
      if (numOrNull(form.companyCost) !== (atomic.companyCost ?? null)) patch.companyCost = numOrNull(form.companyCost);
      if (numOrNull(form.laborNormal) !== (atomic.laborNormal ?? null)) patch.laborNormal = numOrNull(form.laborNormal);
      if (numOrNull(form.laborDifficult) !== (atomic.laborDifficult ?? null)) patch.laborDifficult = numOrNull(form.laborDifficult);
      if (numOrNull(form.laborVeryDifficult) !== (atomic.laborVeryDifficult ?? null)) patch.laborVeryDifficult = numOrNull(form.laborVeryDifficult);
    }
    return patch;
  };

  const patch = buildPatch();
  const dirty = Object.keys(patch).length > 0;

  return (
    <DrawerShell title={`${atomic.itemId} — edit`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Description">
          <input className={inputCls} value={form.description} onChange={set("description")} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Category">
            <input className={inputCls} list="pb-cat-list" value={form.category} onChange={set("category")} />
          </Field>
          <Field label="Sub-category">
            <input className={inputCls} value={form.subCategory} onChange={set("subCategory")} placeholder="optional" />
          </Field>
        </div>
        <datalist id="pb-cat-list">
          {categories.map((c) => <option key={c} value={c} />)}
        </datalist>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Unit label">
            <input className={inputCls} value={form.unitLabel} onChange={set("unitLabel")} placeholder="e.g. per opening" />
          </Field>
          <Field label="Row type">
            {isAssembly ? (
              <div className={`${inputCls} bg-rce-accentBg/30 text-rce-muted`}>{atomic.rowType ?? "ASSEMBLY"}</div>
            ) : (
              <select className={inputCls} value={form.rowType} onChange={set("rowType")}>
                {ROW_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Company cost ($)">
            {isAssembly ? (
              assemblyDetail && !assemblyDetail.rollup.costComplete ? (
                <div className={`${inputCls} bg-amber-50 font-medium text-amber-700`}>INCOMPLETE</div>
              ) : (
                <div className={`${inputCls} bg-rce-accentBg/30 text-rce-muted`}>{money(atomic.companyCost)}</div>
              )
            ) : (
              <input className={inputCls} inputMode="decimal" value={form.companyCost} onChange={set("companyCost")} />
            )}
          </Field>
          <Field label="Sector">
            <input className={inputCls} value={form.sector} onChange={set("sector")} placeholder="optional" />
          </Field>
        </div>
        {isAssembly ? (
          assemblyDetail && !assemblyDetail.rollup.costComplete ? (
            <p className="-mt-1 text-xs text-amber-700">
              No cost on: {assemblyDetail.rollup.unpricedComponentItemIds.join(", ") || "—"}
            </p>
          ) : (
            <p className="-mt-1 text-xs text-rce-muted">
              Derived from this assembly's components (below) — never typed directly.
            </p>
          )
        ) : null}
        <div className="grid grid-cols-3 gap-2">
          <Field label="Hrs normal">
            {isAssembly ? (
              <div className={`${inputCls} bg-rce-accentBg/30 text-rce-muted`}>{form.laborNormal || "0"}</div>
            ) : (
              <input className={inputCls} inputMode="decimal" value={form.laborNormal} onChange={set("laborNormal")} />
            )}
          </Field>
          <Field label="Hrs difficult">
            {isAssembly ? (
              <div className={`${inputCls} bg-rce-accentBg/30 text-rce-muted`}>{form.laborDifficult || "0"}</div>
            ) : (
              <input className={inputCls} inputMode="decimal" value={form.laborDifficult} onChange={set("laborDifficult")} />
            )}
          </Field>
          <Field label="Hrs very diff.">
            {isAssembly ? (
              <div className={`${inputCls} bg-rce-accentBg/30 text-rce-muted`}>{form.laborVeryDifficult || "0"}</div>
            ) : (
              <input className={inputCls} inputMode="decimal" value={form.laborVeryDifficult} onChange={set("laborVeryDifficult")} />
            )}
          </Field>
        </div>
        {isAssembly ? (
          <p className="-mt-1 text-xs text-rce-muted">
            Auto-summed from this assembly's components, per tier — set an override below instead
            of typing an hours value here.
          </p>
        ) : null}
        <Field label="Notes">
          <textarea className={inputCls} rows={2} value={form.notes} onChange={set("notes")} />
        </Field>

        {isAssembly ? (
          <div className="space-y-3 rounded-lg border border-rce-border/70 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-rce-muted">Components</div>
            <ComponentPicker
              search={componentPickerSearch}
              onSearchChange={setComponentPickerSearch}
              results={componentPickerResults}
              loading={componentPickerLoading}
              onAdd={addAssemblyComponent}
            />

            {!assemblyComponents ? (
              <p className="mt-2 text-xs text-rce-muted">Loading components…</p>
            ) : assemblyComponents.length === 0 ? (
              <p className="mt-2 text-xs text-rce-soft">No components attached.</p>
            ) : (
              <table className="mt-2 w-full text-xs">
                <thead>
                  <tr className="text-left text-rce-muted">
                    <th className="py-1">Item</th>
                    <th className="py-1 text-right">Qty</th>
                    <th className="py-1 text-right">Cost ea</th>
                    <th className="py-1 text-right">Hrs N/D/VD</th>
                    <th className="py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {assemblyComponents.map((c) => (
                    <tr key={c.atomic.itemId} className="border-t border-rce-border/40">
                      <td className="py-1">
                        <span className="font-mono text-rce-muted">{c.atomic.itemId}</span> {c.atomic.description}
                      </td>
                      <td className="py-1 text-right">
                        <input
                          type="number"
                          min="0.0001"
                          step="any"
                          value={c.quantity}
                          onChange={(e) => {
                            const q = Number(e.target.value);
                            updateAssemblyQuantity(c.atomic.itemId, Number.isFinite(q) ? q : 0);
                          }}
                          className="w-16 rounded border border-rce-border px-1 py-0.5 text-right"
                        />
                      </td>
                      <td className="py-1 text-right">{money(c.atomic.companyCost)}</td>
                      <td className="py-1 text-right text-rce-muted">
                        {hours(c.atomic.laborNormal)} / {hours(c.atomic.laborDifficult)} / {hours(c.atomic.laborVeryDifficult)}
                      </td>
                      <td className="py-1 text-right">
                        <button type="button" className="text-red-600" onClick={() => removeAssemblyComponent(c.atomic.itemId)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {assemblyComponents && !validAssemblyQuantities ? (
              <p className="text-xs text-red-600">Every component needs a quantity greater than zero.</p>
            ) : null}
            {assemblyComponents && assemblyComponents.length === 0 && componentsDirty ? (
              <p className="text-xs text-red-600">
                An assembly needs at least one component — the book treats an empty list as
                $0.00 and complete, not INCOMPLETE. Retire the assembly instead if it's no longer
                sellable.
              </p>
            ) : null}
            {componentsPreview && componentsDirty && assemblyComponents && assemblyComponents.length > 0 ? (
              <p className="text-xs text-rce-muted">
                If saved: cost {componentsPreview.costComplete ? money(componentsPreview.companyCost) : "INCOMPLETE"}
              </p>
            ) : null}
            {saveComponentsMutation.isError ? (
              <p className="text-xs text-red-600">{(saveComponentsMutation.error as Error).message}</p>
            ) : null}
            <div className="flex justify-end">
              <button
                type="button"
                className="rounded-lg bg-rce-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                disabled={!canSaveComponents || saveComponentsMutation.isPending}
                onClick={() =>
                  assemblyComponents &&
                  saveComponentsMutation.mutate(
                    assemblyComponents.map((c) => ({ childItemId: c.atomic.itemId, quantity: c.quantity }))
                  )
                }
              >
                {saveComponentsMutation.isPending ? "Saving…" : "Save components"}
              </button>
            </div>

            <div className="space-y-3 border-t border-rce-border/60 pt-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-rce-muted">Labour override per tier</div>
              {componentsDirty ? (
                <p className="text-xs text-amber-700">
                  Save the component list first — an override is computed against the saved
                  components, not unsaved edits.
                </p>
              ) : null}
              {LABOR_TIER_LIST.map(({ key, label }) => {
                const autoSum = assemblyDetail?.rollup.labor[key];
                const eff = assemblyDetail?.labor[key];
                const rawInput = laborOverrideInputs[key] ?? "";
                return (
                  <div key={key}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-rce-muted">{label}</span>
                      <span className="text-sm font-medium">
                        {eff ? hours(eff.value) : "—"} {eff?.overridden ? "(override)" : "(auto)"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-right text-xs">
                      {autoSum && !autoSum.complete ? (
                        <span className="text-amber-700">
                          INCOMPLETE auto-sum — no labour on: {autoSum.missingItemIds.join(", ")}
                        </span>
                      ) : eff?.overridden ? (
                        <span className="text-rce-muted">
                          components auto-sum to {autoSum?.value?.toFixed(4) ?? "—"}
                          {eff.driftFromComputed !== null
                            ? ` (drift ${eff.driftFromComputed > 0 ? "+" : ""}${eff.driftFromComputed.toFixed(4)})`
                            : ""}
                        </span>
                      ) : (
                        <span className="text-rce-soft">auto-summed from components</span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        className="w-24 rounded border border-rce-border px-2 py-1 text-right text-sm"
                        inputMode="decimal"
                        placeholder="new override"
                        disabled={componentsDirty}
                        value={rawInput}
                        onChange={(e) => setLaborOverrideInputs((o) => ({ ...o, [key]: e.target.value }))}
                      />
                      <button
                        type="button"
                        className="rounded border border-rce-border px-2 py-1 text-xs disabled:opacity-50"
                        disabled={
                          componentsDirty ||
                          laborOverrideMutation.isPending ||
                          rawInput.trim() === "" ||
                          !Number.isFinite(Number(rawInput))
                        }
                        onClick={() => laborOverrideMutation.mutate({ tier: key, value: Number(rawInput) })}
                      >
                        Set override
                      </button>
                      {eff?.overridden ? (
                        <button
                          type="button"
                          className="rounded border border-rce-border px-2 py-1 text-xs disabled:opacity-50"
                          disabled={componentsDirty || laborOverrideMutation.isPending}
                          onClick={() => laborOverrideMutation.mutate({ tier: key, value: null })}
                        >
                          Clear (use auto-sum)
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {laborOverrideMutation.isError ? (
                <p className="text-xs text-red-600">{(laborOverrideMutation.error as Error).message}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Computed by the server on save — shown so the effect of an edit is visible. */}
        <div className="rounded-lg border border-rce-border/70 bg-rce-accentBg/30 p-3 text-sm">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-rce-muted">
            Computed pricing (tier {atomic.markupTier ?? "—"})
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            <span className="text-rce-muted">Material w/ markup</span><span className="text-right">{money(atomic.companyPrice)}</span>
            <span className="text-rce-muted">Sell — normal</span><span className="text-right font-medium">{money(atomic.sellNormal)}</span>
            <span className="text-rce-muted">Sell — difficult</span><span className="text-right">{money(atomic.sellDifficult)}</span>
            <span className="text-rce-muted">Sell — very difficult</span><span className="text-right">{money(atomic.sellVeryDifficult)}</span>
          </div>
          {dirty ? <p className="mt-1.5 text-xs text-amber-700">Unsaved edits — prices recompute when you save.</p> : null}
        </div>

        {saveMutation.isError ? <p className="text-sm text-red-600">{(saveMutation.error as Error).message}</p> : null}
        {retireMutation.isError ? <p className="text-sm text-red-600">{(retireMutation.error as Error).message}</p> : null}

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700"
            disabled={retireMutation.isPending}
            onClick={() => {
              if (window.confirm(`Retire ${atomic.itemId}? It leaves the pickers but stays on every past estimate.`)) {
                retireMutation.mutate();
              }
            }}
          >
            Retire item
          </button>
          <button
            type="button"
            className="rounded-lg bg-rce-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            disabled={!dirty || saveMutation.isPending}
            onClick={() => saveMutation.mutate(patch)}
          >
            {saveMutation.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>

        {/* The audit trail — every change, newest first. */}
        <div className="border-t border-rce-border/60 pt-2">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-rce-muted">History</div>
          {(data?.edits ?? []).length === 0 ? (
            <p className="text-xs text-rce-soft">No edits recorded — imported as-is.</p>
          ) : (
            <ul className="space-y-1 text-xs text-rce-muted">
              {(data?.edits ?? []).map((e) => (
                <li key={e.id}>
                  <span className="text-rce-soft">{new Date(e.createdAt).toLocaleDateString()}</span>{" "}
                  <span className="font-medium">{e.field}</span>
                  {e.oldValue !== null || e.newValue !== null ? (
                    <>: {e.oldValue ?? "—"} → {e.newValue ?? "—"}</>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </DrawerShell>
  );
}

function NewItemDrawer({
  defaultCategory, categories, onClose, onCreated,
}: {
  defaultCategory: string;
  categories: string[];
  onClose: () => void;
  onCreated: (atomic: PbCatalogAtomic) => void;
}) {
  const [form, setForm] = useState({
    itemId: "",
    description: "",
    category: defaultCategory,
    subCategory: "",
    unitLabel: "",
    rowType: "MATERIAL + LABOR" as string,
    companyCost: "",
    laborNormal: "",
    laborDifficult: "",
    laborVeryDifficult: "",
    notes: "",
  });

  const createMutation = useMutation({
    mutationFn: (input: PbCatalogCreate) => api.pbCatalogCreateItem(input),
    onSuccess: (d) => onCreated(d.atomic),
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const canSave = form.description.trim().length > 0 && form.category.trim().length > 0;

  return (
    <DrawerShell title="New price book item" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Description">
          <input className={inputCls} value={form.description} onChange={set("description")} autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Category">
            <input className={inputCls} list="pb-new-cat-list" value={form.category} onChange={set("category")} />
          </Field>
          <Field label="Sub-category">
            <input className={inputCls} value={form.subCategory} onChange={set("subCategory")} placeholder="optional" />
          </Field>
        </div>
        <datalist id="pb-new-cat-list">
          {categories.map((c) => <option key={c} value={c} />)}
        </datalist>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Item ID (blank = auto)">
            <input className={inputCls} value={form.itemId} onChange={set("itemId")} placeholder="e.g. A090" />
          </Field>
          <Field label="Row type">
            <select className={inputCls} value={form.rowType} onChange={set("rowType")}>
              {ROW_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Company cost ($)">
            <input className={inputCls} inputMode="decimal" value={form.companyCost} onChange={set("companyCost")} />
          </Field>
          <Field label="Unit label">
            <input className={inputCls} value={form.unitLabel} onChange={set("unitLabel")} placeholder="e.g. per opening" />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Hrs normal">
            <input className={inputCls} inputMode="decimal" value={form.laborNormal} onChange={set("laborNormal")} />
          </Field>
          <Field label="Hrs difficult">
            <input className={inputCls} inputMode="decimal" value={form.laborDifficult} onChange={set("laborDifficult")} />
          </Field>
          <Field label="Hrs very diff.">
            <input className={inputCls} inputMode="decimal" value={form.laborVeryDifficult} onChange={set("laborVeryDifficult")} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea className={inputCls} rows={2} value={form.notes} onChange={set("notes")} />
        </Field>

        {createMutation.isError ? <p className="text-sm text-red-600">{(createMutation.error as Error).message}</p> : null}

        <div className="flex justify-end">
          <button
            type="button"
            className="rounded-lg bg-rce-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            disabled={!canSave || createMutation.isPending}
            onClick={() =>
              createMutation.mutate({
                itemId: textOrNull(form.itemId),
                description: form.description.trim(),
                category: form.category.trim(),
                subCategory: textOrNull(form.subCategory),
                unitLabel: textOrNull(form.unitLabel),
                rowType: form.rowType,
                companyCost: numOrNull(form.companyCost),
                laborNormal: numOrNull(form.laborNormal),
                laborDifficult: numOrNull(form.laborDifficult),
                laborVeryDifficult: numOrNull(form.laborVeryDifficult),
                notes: textOrNull(form.notes),
              })
            }
          >
            {createMutation.isPending ? "Creating…" : "Create item"}
          </button>
        </div>
      </div>
    </DrawerShell>
  );
}

// ─── Create assembly (2026-09-12, barcode/materials plan Unit 1) ───────────────────────────
//
// An assembly is a PriceBookAtomic row (rowType "ASSEMBLY") plus a PriceBookItemComponent list —
// see src/services/priceBookAssembly.ts. Cost and non-overridden labour are NOT typed here; they
// are derived from the attached components and recomputed authoritatively by the server on
// create. previewRollup() (defined near the top of this file, shared with ItemDrawer's
// assembly-editing surface) duplicates computeComponentRollup() only so Kyle sees a live preview
// as he builds the list — it is display-only and never sent to the server as a number, only the
// component list and quantities are (plus any explicit override).

function CreateAssemblyDrawer({
  defaultCategory, categories, onClose, onCreated,
}: {
  defaultCategory: string;
  categories: string[];
  onClose: () => void;
  onCreated: (atomic: PbCatalogAtomic) => void;
}) {
  const [form, setForm] = useState({
    itemId: "",
    description: "",
    category: defaultCategory,
    subCategory: "",
    unitLabel: "",
    notes: "",
  });
  const [components, setComponents] = useState<PickedComponent[]>([]);
  const [overrides, setOverrides] = useState<Partial<Record<PbLaborTier, string>>>({});
  const [pickerSearch, setPickerSearch] = useState("");

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const activePickerSearch = pickerSearch.trim().length >= MIN_PICKER_SEARCH_LEN ? pickerSearch.trim() : "";
  const { data: pickerData, isFetching: pickerLoading } = useQuery({
    queryKey: ["pbCatalogAssemblyPicker", activePickerSearch],
    queryFn: () => api.pbCatalogItems({ search: activePickerSearch }),
    enabled: Boolean(activePickerSearch),
  });
  const pickedIds = useMemo(() => new Set(components.map((c) => c.atomic.itemId)), [components]);
  // No nesting (server-enforced too — see validateComponents in priceBookAssembly.ts) and never
  // offer an item already attached.
  const pickerResults = (pickerData?.atomics ?? [])
    .filter((a) => !isAssemblyRowType(a.rowType) && !pickedIds.has(a.itemId))
    .slice(0, 20);

  const addComponent = (atomic: PbCatalogAtomic) => {
    setComponents((cs) => [...cs, { atomic, quantity: 1 }]);
    setPickerSearch("");
  };
  const updateQuantity = (itemId: string, quantity: number) => {
    setComponents((cs) => cs.map((c) => (c.atomic.itemId === itemId ? { ...c, quantity } : c)));
  };
  const removeComponent = (itemId: string) => {
    setComponents((cs) => cs.filter((c) => c.atomic.itemId !== itemId));
  };

  const preview = useMemo(() => previewRollup(components), [components]);

  const createMutation = useMutation({
    mutationFn: (input: PbAssemblyCreate) => api.pbCatalogCreateAssembly(input),
    onSuccess: (d) => onCreated(d.atomic),
  });

  const validQuantities = components.every((c) => Number.isFinite(c.quantity) && c.quantity > 0);
  const canSave = form.description.trim().length > 0 && form.category.trim().length > 0 && validQuantities;

  const buildLaborOverrides = (): Partial<Record<PbLaborTier, number>> => {
    const out: Partial<Record<PbLaborTier, number>> = {};
    for (const { key: tier } of LABOR_TIER_LIST) {
      const raw = overrides[tier];
      if (raw !== undefined && raw.trim() !== "") {
        const n = Number(raw);
        if (Number.isFinite(n)) out[tier] = n;
      }
    }
    return out;
  };

  return (
    <DrawerShell title="New assembly" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Description">
          <input className={inputCls} value={form.description} onChange={set("description")} placeholder="e.g. Hardwired EV Charger" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Category">
            <input className={inputCls} list="pb-asm-cat-list" value={form.category} onChange={set("category")} />
          </Field>
          <Field label="Sub-category">
            <input className={inputCls} value={form.subCategory} onChange={set("subCategory")} placeholder="optional" />
          </Field>
        </div>
        <datalist id="pb-asm-cat-list">
          {categories.map((c) => <option key={c} value={c} />)}
        </datalist>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Item ID (blank = auto)">
            <input className={inputCls} value={form.itemId} onChange={set("itemId")} placeholder="e.g. ASM007" />
          </Field>
          <Field label="Unit label">
            <input className={inputCls} value={form.unitLabel} onChange={set("unitLabel")} placeholder="e.g. each" />
          </Field>
        </div>
        <Field label="Notes">
          <textarea className={inputCls} rows={2} value={form.notes} onChange={set("notes")} />
        </Field>

        {/* Component picker — the heart of an assembly. Search, attach with a quantity, edit,
            remove. Kyle builds "Hardwired EV Charger" from a breaker, raceway, wire, and so on. */}
        <div className="rounded-lg border border-rce-border/70 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-rce-muted">Components</div>
          <ComponentPicker
            search={pickerSearch}
            onSearchChange={setPickerSearch}
            results={pickerResults}
            loading={pickerLoading}
            onAdd={addComponent}
          />

          {components.length === 0 ? (
            <p className="mt-2 text-xs text-rce-soft">No components attached yet.</p>
          ) : (
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr className="text-left text-rce-muted">
                  <th className="py-1">Item</th>
                  <th className="py-1 text-right">Qty</th>
                  <th className="py-1 text-right">Cost ea</th>
                  <th className="py-1 text-right">Hrs N/D/VD</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {components.map((c) => (
                  <tr key={c.atomic.itemId} className="border-t border-rce-border/40">
                    <td className="py-1">
                      <span className="font-mono text-rce-muted">{c.atomic.itemId}</span> {c.atomic.description}
                    </td>
                    <td className="py-1 text-right">
                      <input
                        type="number"
                        min="0.0001"
                        step="any"
                        value={c.quantity}
                        onChange={(e) => {
                          const q = Number(e.target.value);
                          updateQuantity(c.atomic.itemId, Number.isFinite(q) ? q : 0);
                        }}
                        className="w-16 rounded border border-rce-border px-1 py-0.5 text-right"
                      />
                    </td>
                    <td className="py-1 text-right">{money(c.atomic.companyCost)}</td>
                    <td className="py-1 text-right text-rce-muted">
                      {hours(c.atomic.laborNormal)} / {hours(c.atomic.laborDifficult)} / {hours(c.atomic.laborVeryDifficult)}
                    </td>
                    <td className="py-1 text-right">
                      <button type="button" className="text-red-600" onClick={() => removeComponent(c.atomic.itemId)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!validQuantities ? (
            <p className="mt-1 text-xs text-red-600">Every component needs a quantity greater than zero.</p>
          ) : null}
        </div>

        {/* Live derived cost — NOT typed. An assembly's cost is Σ(component companyCost × qty);
            never companyPrice, and never summed around a gap (see file header). */}
        <div className="rounded-lg border border-rce-border/70 bg-rce-accentBg/30 p-3 text-sm">
          <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-rce-muted">
            <span>Company cost (derived from components)</span>
          </div>
          {preview.costComplete ? (
            <div className="text-right font-medium">{money(preview.companyCost)}</div>
          ) : (
            <div>
              <div className="text-right font-medium text-amber-700">INCOMPLETE</div>
              <p className="mt-1 text-xs text-amber-700">
                No cost on: {preview.unpriced.map((p) => `${p.atomic.itemId} (${p.atomic.description ?? "—"})`).join(", ")}
              </p>
            </div>
          )}
        </div>

        {/* Labour per tier — auto-summed from components, each overridable. An override is stored
            explicitly (never inferred from equalling the sum) and its drift from the live
            component total is shown so a stale override is visible, not silent. */}
        <div className="space-y-3 rounded-lg border border-rce-border/70 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-rce-muted">Labour hours per tier</div>
          {LABOR_TIER_LIST.map(({ key, label }) => {
            const autoSum = preview.labor[key];
            const overrideRaw = overrides[key];
            const isOverridden = overrideRaw !== undefined && overrideRaw.trim() !== "";
            const overrideNum = isOverridden ? Number(overrideRaw) : null;
            const drift =
              isOverridden && overrideNum !== null && Number.isFinite(overrideNum) && autoSum.complete && autoSum.value !== null
                ? round4(overrideNum - autoSum.value)
                : null;
            return (
              <div key={key}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-rce-muted">{label}</span>
                  <input
                    className="w-24 rounded border border-rce-border px-2 py-1 text-right text-sm"
                    inputMode="decimal"
                    placeholder={autoSum.complete ? String(autoSum.value) : "INCOMPLETE"}
                    value={overrideRaw ?? ""}
                    onChange={(e) => setOverrides((o) => ({ ...o, [key]: e.target.value }))}
                  />
                </div>
                <div className="mt-0.5 text-right text-xs">
                  {!autoSum.complete ? (
                    <span className="text-amber-700">
                      INCOMPLETE — no labour on: {autoSum.missing.map((p) => p.atomic.itemId).join(", ")}
                    </span>
                  ) : isOverridden ? (
                    <span className="text-rce-muted">
                      overridden — components auto-sum to {autoSum.value?.toFixed(4)}
                      {drift !== null && Math.abs(drift) > 1e-6
                        ? ` (you set ${overrideNum?.toFixed(2)}; components now total ${autoSum.value?.toFixed(2)})`
                        : ""}
                    </span>
                  ) : (
                    <span className="text-rce-soft">auto-summed from components</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {createMutation.isError ? <p className="text-sm text-red-600">{(createMutation.error as Error).message}</p> : null}

        <div className="flex justify-end">
          <button
            type="button"
            className="rounded-lg bg-rce-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            disabled={!canSave || createMutation.isPending}
            onClick={() =>
              createMutation.mutate({
                itemId: textOrNull(form.itemId),
                description: form.description.trim(),
                category: form.category.trim(),
                subCategory: textOrNull(form.subCategory),
                unitLabel: textOrNull(form.unitLabel),
                notes: textOrNull(form.notes),
                components: components.map((c) => ({ childItemId: c.atomic.itemId, quantity: c.quantity })),
                laborOverrides: buildLaborOverrides(),
              })
            }
          >
            {createMutation.isPending ? "Creating…" : "Create assembly"}
          </button>
        </div>
      </div>
    </DrawerShell>
  );
}
