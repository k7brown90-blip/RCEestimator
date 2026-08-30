/**
 * Price Book — the full in-app editor.
 *
 * Kyle, 2026-08-30 (Option A ratified): "We can add a new tab that is labeled
 * 'Price Book' that will be the full in-app editor." The workbook is history;
 * this screen is where items are added, retired, repriced, and organized.
 *
 * Ground rules carried from the import:
 *  - Prices RECOMPUTE server-side with the workbook's exact math (tier markup
 *    on cost, hours × $150 + material). The sell columns here are display only.
 *  - Every change writes an audit row — the drawer shows the item's history.
 *  - Items RETIRE, never delete: estimate lines reference them forever.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { api, fetchProtectedObjectUrl } from "../lib/api";
import type { PbCatalogAtomic, PbCatalogCreate, PbCatalogPatch } from "../lib/api";

const money = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `$${v.toFixed(2)}`);
const hours = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(v));

const ROW_TYPES = ["MATERIAL + LABOR", "LABOR ONLY", "MATERIAL ONLY"] as const;

/** Empty string in a text input means "clear it" — the API wants null for that. */
const textOrNull = (s: string): string | null => (s.trim() === "" ? null : s.trim());
const numOrNull = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function PriceBookCatalogPage() {
  const qc = useQueryClient();
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
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

  // First load: land on the first category so the page is never blank.
  useEffect(() => {
    if (!selectedCategory && categories.length > 0) setSelectedCategory(categories[0].name);
  }, [selectedCategory, categories]);

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

  // Sub-categories group the table the way the workbook's sections did.
  const grouped = useMemo(() => {
    const map = new Map<string, PbCatalogAtomic[]>();
    for (const it of items) {
      const key = it.subCategory ?? "";
      const arr = map.get(key) ?? [];
      arr.push(it);
      map.set(key, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

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

      {/* Category cards with rename and reorder on the selected one. */}
      {!activeSearch && (
        <div className="flex flex-wrap items-center gap-1.5">
          {categories.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => { setSelectedCategory(c.name); setRenaming(false); }}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                selectedCategory === c.name
                  ? "bg-rce-accent text-white"
                  : "border border-rce-border bg-rce-surface text-rce-muted"
              }`}
            >
              {c.name} ({c.count})
            </button>
          ))}
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
      {!itemsLoading && (listCategory || activeSearch) && items.length === 0 && (
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
                    <td className="px-2 py-1.5 text-xs text-rce-muted">{it.rowType ?? "—"}</td>
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

  if (!atomic || !form) {
    return (
      <DrawerShell title={itemId} onClose={onClose}>
        <p className="text-sm text-rce-muted">Loading…</p>
      </DrawerShell>
    );
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  const buildPatch = (): PbCatalogPatch => {
    const patch: PbCatalogPatch = {};
    if (form.description.trim() && form.description.trim() !== (atomic.description ?? "")) patch.description = form.description.trim();
    if (form.category.trim() && form.category.trim() !== (atomic.category ?? "")) patch.category = form.category.trim();
    if (textOrNull(form.subCategory) !== (atomic.subCategory ?? null)) patch.subCategory = textOrNull(form.subCategory);
    if (textOrNull(form.unitLabel) !== (atomic.unitLabel ?? null)) patch.unitLabel = textOrNull(form.unitLabel);
    if (textOrNull(form.sector) !== (atomic.sector ?? null)) patch.sector = textOrNull(form.sector);
    if (textOrNull(form.notes) !== (atomic.notes ?? null)) patch.notes = textOrNull(form.notes);
    if (form.rowType && form.rowType !== (atomic.rowType ?? "")) patch.rowType = form.rowType;
    if (numOrNull(form.companyCost) !== (atomic.companyCost ?? null)) patch.companyCost = numOrNull(form.companyCost);
    if (numOrNull(form.laborNormal) !== (atomic.laborNormal ?? null)) patch.laborNormal = numOrNull(form.laborNormal);
    if (numOrNull(form.laborDifficult) !== (atomic.laborDifficult ?? null)) patch.laborDifficult = numOrNull(form.laborDifficult);
    if (numOrNull(form.laborVeryDifficult) !== (atomic.laborVeryDifficult ?? null)) patch.laborVeryDifficult = numOrNull(form.laborVeryDifficult);
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
            <select className={inputCls} value={form.rowType} onChange={set("rowType")}>
              {ROW_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Company cost ($)">
            <input className={inputCls} inputMode="decimal" value={form.companyCost} onChange={set("companyCost")} />
          </Field>
          <Field label="Sector">
            <input className={inputCls} value={form.sector} onChange={set("sector")} placeholder="optional" />
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
