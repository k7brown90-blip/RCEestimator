/**
 * WITHDRAWN 2026-08-14 (P014 / transition map T1). Kept on disk, no longer rendered.
 *
 * This modal browses the catalog and hands a code to `POST /estimates/:id/options/:optionId/items`
 * — the LEGACY write path, which looks the code up in the legacy `AtomicUnit` table and prices it
 * with `ModifierDef` multipliers. P014 re-pointed every catalog READ to the imported price book,
 * whose code space is disjoint (`A016`, not `LINE-002`). Its write leg belongs to T5, which is
 * explicitly out of P014's scope and waits on Kyle's line-row-target ruling.
 *
 * The map's rule for exactly this situation is "Every consumer moves together or none." A
 * consumer that cannot move is withdrawn rather than left pointing at a stale catalog or wired to
 * an endpoint that would 404 on every selection. The working replacement is `/estimate-intake`
 * (P012), which browses the same catalog and writes through the engine.
 *
 * The reads below are moved to the new shape so this file stays honest and type-checked, and the
 * live dollar preview it used to draw is gone — the UI does not compute a dollar
 * (decisions/2026-08-04-who-sets-numbers.md). To bring it back, T5 must first give it a write
 * path; then re-import it in AtomicItemsSection.tsx where the pointer to /estimate-intake is.
 */

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { PbAtomic, ModifierDef } from "../lib/types";

const MODIFIER_TYPE_LABELS: Record<string, string> = {
  ACCESS: "Access",
  HEIGHT: "Height",
  CONDITION: "Condition",
};

type PendingModifier = {
  modifierType: string;
  modifierValue: string;
  laborMultiplier: number;
  materialMult: number;
};

type Props = {
  onClose: () => void;
  onAdd: (input: {
    atomicUnitCode: string;
    quantity: number;
    location?: string;
    circuitVoltage?: number;
    circuitAmperage?: number;
    environment?: string;
    exposure?: string;
    cableLength?: number;
    modifiers: PendingModifier[];
  }) => void;
  isAdding: boolean;
};

export function AddAtomicItemModal({ onClose, onAdd, isAdding }: Props) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [selectedUnit, setSelectedUnit] = useState<PbAtomic | null>(null);

  // Configure step
  const [quantity, setQuantity] = useState(1);
  const [location, setLocation] = useState("");
  const [circuitVoltage, setCircuitVoltage] = useState<120 | 240>(120);
  const [circuitAmperage, setCircuitAmperage] = useState(20);
  const [environment, setEnvironment] = useState<"interior" | "exterior" | "underground">("interior");
  const [exposure, setExposure] = useState<"concealed" | "exposed">("concealed");
  const [cableLength, setCableLength] = useState(0);
  const [selectedModifiers, setSelectedModifiers] = useState<PendingModifier[]>([]);
  const [error, setError] = useState("");

  const { data: units = [] } = useQuery({
    queryKey: ["atomic-units", "price-book"],
    queryFn: () => api.atomicUnits({ limit: 200 }).then((r) => r.atomics),
  });

  const { data: modifierDefs = [] } = useQuery({
    queryKey: ["modifiers", "ITEM"],
    queryFn: () => api.modifiers("ITEM"),
  });

  // Group modifier defs by type
  const modifiersByType = useMemo(() => {
    const grouped: Record<string, ModifierDef[]> = {};
    for (const def of modifierDefs) {
      if (!grouped[def.modifierType]) grouped[def.modifierType] = [];
      grouped[def.modifierType].push(def);
    }
    return grouped;
  }, [modifierDefs]);

  // Filter units by search + category
  const filteredUnits = useMemo(() => {
    let list = units;
    if (activeCategory) {
      list = list.filter((u) => u.category === activeCategory);
    }
    if (search.trim()) {
      const term = search.toLowerCase();
      list = list.filter(
        (u) =>
          (u.description ?? "").toLowerCase().includes(term) ||
          u.itemId.toLowerCase().includes(term)
      );
    }
    return list;
  }, [units, activeCategory, search]);

  // Group filtered units by the workbook's own Category column. The legacy fixed list
  // (DEVICES / LUMINAIRES / …) does not exist in the price book, so the categories come from
  // the data rather than from a constant that would silently hide anything unlisted.
  const grouped = useMemo(() => {
    const map = new Map<string, PbAtomic[]>();
    for (const u of filteredUnits) {
      const key = u.category ?? "Uncategorised";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(u);
    }
    return map;
  }, [filteredUnits]);

  const categoriesPresent = [...grouped.keys()].sort();

  /** Every category the catalog actually contains — the tab strip, built from the data. */
  const allCategories = useMemo(
    () => [...new Set(units.map((u) => u.category ?? "Uncategorised"))].sort(),
    [units]
  );

  function selectUnit(unit: PbAtomic) {
    setSelectedUnit(unit);
    setQuantity(1);
    setLocation("");
    setError("");
    // Set default modifiers from defs
    const defaults: PendingModifier[] = [];
    for (const [, defs] of Object.entries(modifiersByType)) {
      const defaultDef = defs.find((d) => d.isDefault);
      if (defaultDef) {
        defaults.push({
          modifierType: defaultDef.modifierType,
          modifierValue: defaultDef.value,
          laborMultiplier: defaultDef.laborMultiplier,
          materialMult: defaultDef.materialMult,
        });
      }
    }
    setSelectedModifiers(defaults);
  }

  function setModifier(modifierType: string, value: string) {
    const def = modifiersByType[modifierType]?.find((d) => d.value === value);
    if (!def) return;
    setSelectedModifiers((prev) => {
      const filtered = prev.filter((m) => m.modifierType !== modifierType);
      return [
        ...filtered,
        {
          modifierType: def.modifierType,
          modifierValue: def.value,
          laborMultiplier: def.laborMultiplier,
          materialMult: def.materialMult,
        },
      ];
    });
  }

  function handleSubmit() {
    if (!selectedUnit) return;
    setError("");

    if (selectedUnit.isContinuousLength && (!cableLength || cableLength <= 0)) {
      setError("A measured length is required for continuous-length product.");
      return;
    }

    onAdd({
      atomicUnitCode: selectedUnit.itemId,
      quantity,
      location: location || undefined,
      ...(selectedUnit.isContinuousLength
        ? {
            circuitVoltage,
            circuitAmperage,
            environment,
            exposure,
            cableLength,
          }
        : {}),
      modifiers: selectedModifiers,
    });
  }

  // ── Step 1: Browse units ─────────────────────────────────────────────────
  if (!selectedUnit) {
    return (
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-16">
        <div className="w-full max-w-2xl rounded-2xl border border-rce-border bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-rce-border px-5 py-4">
            <h2 className="text-lg font-semibold">Add Item</h2>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
          </div>

          {/* Search */}
          <div className="border-b border-rce-border px-5 py-3">
            <input
              className="field w-full"
              placeholder="Search items…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setActiveCategory(null); }}
              autoFocus
            />
          </div>

          {/* Category tabs */}
          <div className="flex flex-wrap gap-2 border-b border-rce-border px-5 py-3">
            <button
              type="button"
              className={`rounded-full px-3 py-1 text-xs font-medium ${!activeCategory && !search ? "bg-rce-primary text-white" : "bg-rce-border/60 text-rce-soft hover:bg-rce-border"}`}
              onClick={() => { setActiveCategory(null); setSearch(""); }}
            >
              All
            </button>
            {allCategories.map((cat) => (
              <button
                key={cat}
                type="button"
                className={`rounded-full px-3 py-1 text-xs font-medium ${activeCategory === cat ? "bg-rce-primary text-white" : "bg-rce-border/60 text-rce-soft hover:bg-rce-border"}`}
                onClick={() => { setActiveCategory(cat); setSearch(""); }}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Unit list */}
          <div className="max-h-96 overflow-y-auto p-5 space-y-4">
            {categoriesPresent.length === 0 && (
              <p className="text-sm text-rce-soft">No items match your search.</p>
            )}
            {categoriesPresent.map((cat) => (
              <div key={cat}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-rce-soft">
                  {cat}
                </p>
                <div className="space-y-1">
                  {grouped.get(cat)!.map((unit) => (
                    <button
                      key={unit.itemId}
                      type="button"
                      className="flex w-full items-center justify-between rounded-lg border border-rce-border/60 bg-white p-3 text-left hover:border-rce-primary/50 hover:bg-rce-accentBg"
                      onClick={() => selectUnit(unit)}
                    >
                      <div>
                        <p className="text-sm font-medium">{unit.description ?? unit.itemId}</p>
                        <p className="text-xs text-rce-soft">
                          {unit.itemId} · {unit.unit ?? "—"}
                          {unit.laborNormal !== null ? ` · ${unit.laborNormal} labour (normal)` : " · no published labour"}
                          {!unit.hasLabourUnitBasis && " · NO LABOUR BASIS"}
                          {!unit.hasPriceAtActiveSupplier && " · NO SUPPLIER PRICE"}
                        </p>
                      </div>
                      <span className="ml-3 shrink-0 text-xs text-rce-primary">Select →</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Step 2: Configure ────────────────────────────────────────────────────
  const isCircuit = selectedUnit.isContinuousLength;
  const currentModifierMap: Record<string, string> = {};
  for (const m of selectedModifiers) currentModifierMap[m.modifierType] = m.modifierValue;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-16">
      <div className="w-full max-w-lg rounded-2xl border border-rce-border bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-rce-border px-5 py-4">
          <div>
            <p className="text-xs text-rce-soft">{selectedUnit.itemId}</p>
            <h2 className="text-lg font-semibold">{selectedUnit.description ?? selectedUnit.itemId}</h2>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => setSelectedUnit(null)}>
              ← Back
            </button>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>

        <div className="space-y-4 p-5">
          {/* Quantity + Location */}
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm font-medium">
              Quantity
              <input
                type="number"
                min={1}
                className="field mt-1"
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            <label className="text-sm font-medium">
              Location <span className="font-normal text-rce-soft">(optional)</span>
              <input
                className="field mt-1"
                placeholder="e.g. Kitchen"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </label>
          </div>

          {/* Circuit fields */}
          {isCircuit && (
            <div className="rounded-lg border border-rce-border/70 bg-rce-accentBg/30 p-4 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-rce-soft">Circuit Configuration</p>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm font-medium">
                  Voltage
                  <select
                    className="field mt-1"
                    value={circuitVoltage}
                    onChange={(e) => setCircuitVoltage(Number(e.target.value) as 120 | 240)}
                  >
                    <option value={120}>120V</option>
                    <option value={240}>240V</option>
                  </select>
                </label>
                <label className="text-sm font-medium">
                  Amperage
                  <select
                    className="field mt-1"
                    value={circuitAmperage}
                    onChange={(e) => setCircuitAmperage(Number(e.target.value))}
                  >
                    {circuitVoltage === 120
                      ? [15, 20].map((a) => <option key={a} value={a}>{a}A</option>)
                      : [20, 30, 40, 50].map((a) => <option key={a} value={a}>{a}A</option>)
                    }
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm font-medium">
                  Environment
                  <select
                    className="field mt-1"
                    value={environment}
                    onChange={(e) => setEnvironment(e.target.value as "interior" | "exterior" | "underground")}
                  >
                    <option value="interior">Interior</option>
                    <option value="exterior">Exterior</option>
                    <option value="underground">Underground</option>
                  </select>
                </label>
                <label className="text-sm font-medium">
                  Exposure
                  <select
                    className="field mt-1"
                    value={exposure}
                    onChange={(e) => setExposure(e.target.value as "concealed" | "exposed")}
                  >
                    <option value="concealed">Concealed</option>
                    <option value="exposed">Exposed</option>
                  </select>
                </label>
              </div>
              <label className="text-sm font-medium">
                Cable Length (ft)
                <input
                  type="number"
                  min={1}
                  className="field mt-1"
                  value={cableLength || ""}
                  onChange={(e) => setCableLength(Math.max(0, Number(e.target.value) || 0))}
                  placeholder="Enter cable run length"
                />
              </label>
            </div>
          )}

          {/* Modifiers */}
          {Object.keys(modifiersByType).length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-rce-soft">Conditions</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {Object.entries(modifiersByType).map(([type, defs]) => (
                  <label key={type} className="text-sm font-medium">
                    {MODIFIER_TYPE_LABELS[type] ?? type}
                    <select
                      className="field mt-1"
                      value={currentModifierMap[type] ?? ""}
                      onChange={(e) => setModifier(type, e.target.value)}
                    >
                      {defs.map((def) => (
                        <option key={def.value} value={def.value}>
                          {def.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Published labour, as published. No dollar is computed here — the engine prices. */}
          <div className="rounded-lg border border-rce-border/60 bg-rce-accentBg/20 px-4 py-3 text-sm">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-rce-soft">
              Published labour {selectedUnit.laborUnitBasis ? `(per ${selectedUnit.laborUnitBasis})` : ""}
            </p>
            <div className="flex justify-between"><span className="text-rce-soft">Normal</span><span className="font-medium">{selectedUnit.laborNormal ?? "—"}</span></div>
            <div className="flex justify-between"><span className="text-rce-soft">Difficult</span><span className="font-medium">{selectedUnit.laborDifficult ?? "—"}</span></div>
            <div className="flex justify-between"><span className="text-rce-soft">Very difficult</span><span className="font-medium">{selectedUnit.laborVeryDifficult ?? "—"}</span></div>
            {!selectedUnit.hasLabourUnitBasis && (
              <p className="mt-1 text-xs text-rce-danger">
                No labour unit basis established for this item — the line will be incomplete until the workbook sets one.
              </p>
            )}
          </div>

          {error && <p className="text-sm text-rce-danger">{error}</p>}

          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={isAdding}
            onClick={handleSubmit}
          >
            {isAdding ? "Adding…" : `Add ${selectedUnit.description ?? selectedUnit.itemId}`}
          </button>
        </div>
      </div>
    </div>
  );
}
