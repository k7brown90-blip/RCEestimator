import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { EstimateItem, SupportItem } from "../lib/types";
import { money } from "../lib/utils";
// AddAtomicItemModal is WITHDRAWN (P014 / transition map T1) and no longer imported. The file is
// kept on disk; re-importing it here is the revert, and it is only correct once T5 gives the
// legacy EstimateItem write path a home in the new catalog. See the note on the button below.

const SUPPORT_TYPE_LABELS: Record<string, string> = {
  MOBILIZATION: "Mobilization / Travel",
  PERMIT: "Permit Allowance",
  LOAD_CALC: "Load Calculation Review",
  UTILITY_COORD: "Utility Coordination",
  CIRCUIT_TESTING: "Circuit Testing / Checkout",
  CLEANUP: "Cleanup / Debris Removal",
  PANEL_DEMO: "Panel Demo / Removal",
};

type Props = {
  estimateId: string;
  optionId: string;
  locked: boolean;
};

export function AtomicItemsSection({ estimateId, optionId, locked }: Props) {
  const queryClient = useQueryClient();
  const [overridingItemId, setOverridingItemId] = useState<string | null>(null);
  const [overrideNote, setOverrideNote] = useState("");

  const { data: items = [], isLoading: itemsLoading } = useQuery({
    queryKey: ["items", estimateId, optionId],
    queryFn: () => api.items(estimateId, optionId),
    enabled: Boolean(estimateId) && Boolean(optionId),
  });

  const { data: supportItems = [], isLoading: supportLoading } = useQuery({
    queryKey: ["support-items", estimateId],
    queryFn: () => api.supportItems(estimateId),
    enabled: Boolean(estimateId),
  });

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ["items", estimateId, optionId] });
    queryClient.invalidateQueries({ queryKey: ["support-items", estimateId] });
    queryClient.invalidateQueries({ queryKey: ["estimate", estimateId] });
  };

  // The add-item mutation and the endpoint-suggestion prompt it triggered are withdrawn with the
  // modal (P014 / T1) — nothing in this component creates an EstimateItem any more. `api.createItem`
  // and the endpoint on the other end of it are untouched and still work; they simply have no
  // caller here until T5 settles where a line row lives.

  const deleteItemMutation = useMutation({
    mutationFn: (itemId: string) => api.deleteItem(estimateId, optionId, itemId),
    onSuccess: refreshAll,
  });

  const generateSupportMutation = useMutation({
    mutationFn: () => api.generateSupportItems(estimateId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["support-items", estimateId] }),
  });

  const patchSupportMutation = useMutation({
    mutationFn: ({ itemId, ...input }: { itemId: string; isOverridden?: boolean; overrideNote?: string; laborHrs?: number; otherCost?: number }) =>
      api.patchSupportItem(estimateId, itemId, input),
    onSuccess: () => {
      setOverridingItemId(null);
      setOverrideNote("");
      queryClient.invalidateQueries({ queryKey: ["support-items", estimateId] });
    },
  });

  const deleteSupportMutation = useMutation({
    mutationFn: (itemId: string) => api.deleteSupportItem(estimateId, itemId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["support-items", estimateId] }),
  });

  // Totals from items
  const itemTotals = items.reduce(
    (acc, item) => ({
      labor: acc.labor + item.laborCost,
      material: acc.material + item.materialCost,
      total: acc.total + item.totalCost,
    }),
    { labor: 0, material: 0, total: 0 }
  );

  const supportTotal = supportItems.reduce((acc, s) => acc + s.totalCost, 0);

  return (
    <>
      {/* ── Item List ──────────────────────────────────────────────────────── */}
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-lg font-semibold">Scope Items</h3>
        <div className="flex gap-2">
          {/*
            "+ Add Item" is WITHDRAWN as of P014 (transition map T1). It opened
            AddAtomicItemModal, which browsed the catalog and posted a code to the legacy
            EstimateItem write path. Every catalog read now serves the imported price book,
            whose code space is disjoint, and moving that write path is T5 — out of scope and
            waiting on Kyle's line-row-target ruling. Rather than leave a button that would
            404 on every selection, it points at the screen that works.
            Existing items below still render: EstimateItem and AtomicUnit are untouched.
          */}
          {!locked && (
            <a href="/estimate-intake" className="btn btn-primary">
              + Add Item (new estimator)
            </a>
          )}
          {items.length > 0 && !locked && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={generateSupportMutation.isPending}
              onClick={() => generateSupportMutation.mutate()}
            >
              {generateSupportMutation.isPending ? "Refreshing…" : "Refresh Support"}
            </button>
          )}
        </div>
      </div>

      {itemsLoading && <p className="text-sm text-rce-soft">Loading items…</p>}

      {!itemsLoading && items.length === 0 && (
        <p className="rounded-lg border border-dashed border-rce-border/60 p-6 text-center text-sm text-rce-soft">
          No items added yet. Click <strong>+ Add Item</strong> to begin building scope.
        </p>
      )}

      {items.length > 0 && (
        <>
          <div className="space-y-2">
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                locked={locked}
                onDelete={() => {
                  if (window.confirm("Remove this item?")) deleteItemMutation.mutate(item.id);
                }}
              />
            ))}
          </div>

          {/* Subtotals */}
          <div className="mt-3 rounded-lg border border-rce-border/60 bg-rce-accentBg/20 px-4 py-3 text-sm">
            <div className="flex justify-between text-rce-soft">
              <span>Labor</span><span>{money(itemTotals.labor)}</span>
            </div>
            <div className="flex justify-between text-rce-soft">
              <span>Material (incl. markup)</span><span>{money(itemTotals.material)}</span>
            </div>
            <div className="mt-1 flex justify-between border-t border-rce-border/60 pt-1 font-semibold">
              <span>Items Subtotal</span><span>{money(itemTotals.total)}</span>
            </div>
          </div>
        </>
      )}

      {/* ── Support Items ──────────────────────────────────────────────────── */}
      {(supportItems.length > 0 || items.length > 0) && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-rce-soft">
              Auto-Applied Support Scope
            </p>
            {items.length > 0 && supportItems.length === 0 && !locked && (
              <button
                type="button"
                className="text-xs text-rce-primary underline"
                disabled={generateSupportMutation.isPending}
                onClick={() => generateSupportMutation.mutate()}
              >
                Generate
              </button>
            )}
          </div>

          {supportLoading && <p className="text-sm text-rce-soft">Loading…</p>}

          <div className="space-y-1">
            {supportItems.map((s) => (
              <SupportItemRow
                key={s.id}
                item={s}
                locked={locked}
                isOverriding={overridingItemId === s.id}
                overrideNote={overrideNote}
                onOverrideNoteChange={setOverrideNote}
                onStartOverride={() => { setOverridingItemId(s.id); setOverrideNote(s.overrideNote ?? ""); }}
                onCancelOverride={() => { setOverridingItemId(null); setOverrideNote(""); }}
                onSaveOverride={() => patchSupportMutation.mutate({ itemId: s.id, isOverridden: true, overrideNote })}
                onRestore={() => patchSupportMutation.mutate({ itemId: s.id, isOverridden: false, overrideNote: "" })}
                onDelete={() => {
                  if (window.confirm("Remove this support item?")) deleteSupportMutation.mutate(s.id);
                }}
              />
            ))}
          </div>

          {supportItems.length > 0 && (
            <div className="mt-2 flex justify-between text-sm font-semibold">
              <span>Support Subtotal</span>
              <span>{money(supportTotal)}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Add Item Modal — WITHDRAWN (P014 / T1); see the note on the button above ──
          AddAtomicItemModal.tsx is kept on disk, not deleted. Re-rendering it here is the
          one-line revert, and it only becomes correct once T5 gives it a write path. ── */}

      {/* ── Endpoint Suggestion Modal — WITHDRAWN with the add-item flow (P014 / T1) ──
          It was raised only by the add-item mutation's response (`suggestEndpoint`), so with
          that mutation gone it could never open again. A prompt that cannot fire is worse than
          one that is absent. The server-side suggestion itself is untouched and still returned
          by POST /estimates/:id/options/:optionId/items. ── */}
    </>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ItemRow({ item, locked, onDelete }: { item: EstimateItem; locked: boolean; onDelete: () => void }) {
  const hasWiring = Boolean(item.resolvedWiringMethod);
  const unitName = item.atomicUnit?.name ?? item.atomicUnitId;
  const unitType = item.atomicUnit?.unitType ?? "EA";

  return (
    <div className="rounded-xl border border-rce-border/80 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{unitName}</p>
            <span className="rounded bg-rce-border/50 px-1.5 py-0.5 text-xs text-rce-soft">
              × {item.quantity} {unitType}
            </span>
            {item.atomicUnit?.code && (
              <span className="text-xs text-rce-soft">{item.atomicUnit.code}</span>
            )}
          </div>
          {hasWiring && (
            <p className="mt-0.5 text-xs text-rce-soft">
              {item.resolvedWiringMethod} · {item.cableLength} ft
              {item.resolvedCableLaborHrs !== null && item.resolvedCableLaborHrs !== undefined
                ? ` · ${item.resolvedCableLaborHrs.toFixed(2)} cable hrs`
                : ""}
            </p>
          )}
          {item.location && (
            <p className="mt-0.5 text-xs text-rce-soft">{item.location}</p>
          )}
          {(item.modifiers ?? []).filter((m) => m.laborMultiplier !== 1 || m.materialMult !== 1).map((mod) => (
            <span key={`${mod.modifierType}-${mod.modifierValue}`} className="mr-1 mt-0.5 inline-block rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
              {mod.modifierType}: {mod.modifierValue}
            </span>
          ))}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold">{money(item.totalCost)}</p>
          <p className="text-xs text-rce-soft">L {money(item.laborCost)} / M {money(item.materialCost)}</p>
          {!locked && (
            <button
              type="button"
              className="mt-1 text-xs text-rce-danger hover:underline"
              onClick={onDelete}
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

type SupportRowProps = {
  item: SupportItem;
  locked: boolean;
  isOverriding: boolean;
  overrideNote: string;
  onOverrideNoteChange: (v: string) => void;
  onStartOverride: () => void;
  onCancelOverride: () => void;
  onSaveOverride: () => void;
  onRestore: () => void;
  onDelete: () => void;
};

function SupportItemRow({
  item, locked, isOverriding, overrideNote, onOverrideNoteChange,
  onStartOverride, onCancelOverride, onSaveOverride, onRestore, onDelete,
}: SupportRowProps) {
  const label = SUPPORT_TYPE_LABELS[item.supportType] ?? item.supportType;

  return (
    <div className={`flex flex-wrap items-start justify-between gap-2 rounded-lg border px-3 py-2 text-sm ${item.isOverridden ? "border-rce-border/40 opacity-60" : "border-rce-border/60 bg-white"}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <input type="checkbox" readOnly checked={!item.isOverridden} className="accent-rce-primary" />
          <span className={item.isOverridden ? "line-through text-rce-soft" : "font-medium"}>{label}</span>
        </div>
        <p className="mt-0.5 pl-5 text-xs text-rce-soft">{item.description}</p>
        {item.isOverridden && item.overrideNote && (
          <p className="pl-5 text-xs text-rce-soft italic">{item.overrideNote}</p>
        )}
        {isOverriding && (
          <div className="mt-2 pl-5 flex gap-2">
            <input
              className="field flex-1 text-xs"
              placeholder="Reason for removing…"
              value={overrideNote}
              onChange={(e) => onOverrideNoteChange(e.target.value)}
            />
            <button type="button" className="btn btn-secondary text-xs" onClick={onSaveOverride}>Remove</button>
            <button type="button" className="btn btn-secondary text-xs" onClick={onCancelOverride}>Cancel</button>
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className={`font-medium ${item.isOverridden ? "text-rce-soft line-through" : ""}`}>
          {money(item.totalCost)}
        </span>
        {!locked && (
          <>
            {item.isOverridden
              ? <button type="button" className="text-xs text-rce-primary hover:underline" onClick={onRestore}>Restore</button>
              : !isOverriding && <button type="button" className="text-xs text-rce-soft hover:underline" onClick={onStartOverride}>Remove</button>
            }
            <button type="button" className="text-xs text-rce-danger hover:underline" onClick={onDelete}>Delete</button>
          </>
        )}
      </div>
    </div>
  );
}
