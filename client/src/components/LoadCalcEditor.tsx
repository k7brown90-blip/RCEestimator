/**
 * Load-calc input editor — the office-side correction surface (Kyle,
 * 2026-09-01, closing the tracker's open item): fix an appliance, a nameplate
 * or the square footage without a truck roll. Saving follows Kyle's overwrite
 * ruling exactly: the server recomputes the Article 220 result AND the stored
 * generator design with the shared engine, writes a REVISION that supersedes
 * this record, and re-sends the corrected report to the customer — the outcome
 * (sent / held and why) is shown right here.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { LoadItem, LoadType } from "../../../shared/loadcalc/loadcalc";

const LOAD_TYPES: LoadType[] = [
  "generalLighting", "smallAppliance", "laundry", "fixedAppliance", "range", "oven", "cooktop",
  "dryer", "waterHeaterTank", "waterHeaterTankless", "spaceHeat", "cooling", "heatPump", "motor",
  "poolPump", "poolHeater", "poolBlower", "spaSelfContained", "evse", "arcWelder",
  "resistanceWelder", "elevatorLift", "snowMeltDeice", "exteriorCircuit", "bathroomCircuit", "other",
];

const num = (v: string): number | undefined => {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
};

export function LoadCalcEditor({ inspectionId, onClose, onRevised }: {
  inspectionId: string;
  onClose: () => void;
  /** The revision's id — the panel refreshes so the new record shows. */
  onRevised: (revisionId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["inspectionLoadCalc", inspectionId],
    queryFn: () => api.inspectionLoadCalc(inspectionId),
  });

  const [serviceAmps, setServiceAmps] = useState("");
  const [floorArea, setFloorArea] = useState("");
  const [loads, setLoads] = useState<LoadItem[]>([]);
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!data || seeded) return;
    setServiceAmps(String(data.input.serviceAmps));
    setFloorArea(String(data.input.floorAreaSqFt));
    setLoads(data.input.loads.map((l) => ({ ...l })));
    setSeeded(true);
  }, [data, seeded]);

  const [result, setResult] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api.updateInspectionLoadCalc(inspectionId, {
        serviceAmps: Number(serviceAmps),
        floorAreaSqFt: Number(floorArea),
        loads,
      }),
    onSuccess: (r) => {
      setResult(
        r.resend.sent
          ? `Corrected — revision saved and the corrected report was re-sent to ${r.resend.to}.`
          : `Corrected — revision saved. Report not re-sent: ${r.resend.skipped ?? r.resend.reason}`,
      );
      void queryClient.invalidateQueries({ queryKey: ["visitInspections"] });
      void queryClient.invalidateQueries({ queryKey: ["inspectionLoadCalc"] });
      onRevised(r.inspectionId);
    },
    onError: (err) => setResult((err as Error).message),
  });

  const patchLoad = (i: number, patch: Partial<LoadItem>) =>
    setLoads((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  if (isLoading) return <p className="mt-2 text-xs text-rce-muted">Loading the calculation…</p>;
  if (error || !data) return <p className="mt-2 text-xs text-red-700">{(error as Error)?.message ?? "No load calc."}</p>;

  const valid = Number(serviceAmps) > 0 && Number(floorArea) >= 0 && loads.every((l) => l.label.trim());

  return (
    <div className="mt-2 space-y-3 rounded-lg border border-rce-border p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">Edit load calculation</h4>
        <button type="button" className="text-xs underline" onClick={onClose}>close</button>
      </div>
      <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">
        Saving creates a <b>correction</b>: this record is superseded and the corrected report
        (with the load-calc &amp; generator sheet) is <b>re-sent to the customer automatically</b> —
        they are never left holding the old numbers.
      </p>
      <div className="flex flex-wrap gap-3 text-sm">
        <label className="flex items-center gap-1">Service (A)
          <input className="field w-20" type="number" value={serviceAmps} onChange={(e) => setServiceAmps(e.target.value)} />
        </label>
        <label className="flex items-center gap-1">Floor area (sq ft)
          <input className="field w-24" type="number" value={floorArea} onChange={(e) => setFloorArea(e.target.value)} />
        </label>
      </div>
      <div className="max-h-80 overflow-y-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-rce-soft">
            <th className="p-1">Load</th><th className="p-1">Type</th><th className="p-1">VA</th>
            <th className="p-1">kW</th><th className="p-1">A</th><th className="p-1">V</th>
            <th className="p-1" title="Read off the nameplate">plate</th><th></th>
          </tr></thead>
          <tbody>
            {loads.map((l, i) => (
              <tr key={l.id ?? i} className="border-t border-rce-border/60">
                <td className="p-1"><input className="field w-36" value={l.label} onChange={(e) => patchLoad(i, { label: e.target.value })} /></td>
                <td className="p-1">
                  <select className="field" value={l.type} onChange={(e) => patchLoad(i, { type: e.target.value as LoadType })}>
                    {LOAD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
                <td className="p-1"><input className="field w-20" type="number" value={l.nameplateVA ?? ""} onChange={(e) => patchLoad(i, { nameplateVA: num(e.target.value) })} /></td>
                <td className="p-1"><input className="field w-16" type="number" value={l.nameplateKW ?? ""} onChange={(e) => patchLoad(i, { nameplateKW: num(e.target.value) })} /></td>
                <td className="p-1"><input className="field w-16" type="number" value={l.amps ?? ""} onChange={(e) => patchLoad(i, { amps: num(e.target.value) })} /></td>
                <td className="p-1"><input className="field w-16" type="number" value={l.volts ?? ""} onChange={(e) => patchLoad(i, { volts: num(e.target.value) })} /></td>
                <td className="p-1 text-center"><input type="checkbox" checked={Boolean(l.nameplateRead)} onChange={(e) => patchLoad(i, { nameplateRead: e.target.checked })} /></td>
                <td className="p-1"><button type="button" className="text-red-700 underline" onClick={() => setLoads((ls) => ls.filter((_, idx) => idx !== i))}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="btn btn-secondary text-xs"
        onClick={() => setLoads((ls) => [...ls, { id: crypto.randomUUID(), type: "fixedAppliance", label: "" }])}
      >
        + Add a load
      </button>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-primary text-sm"
          disabled={!valid || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving & re-sending…" : "Save correction — supersedes & re-sends"}
        </button>
      </div>
      {result && <p className="text-xs">{result}</p>}
    </div>
  );
}
