/**
 * Generator system designer — the CRM-side interactive builder (Kyle,
 * 2026-08-31: "There should be a generator sizing built into the RCE app that
 * can bring up past reports to edit or review to design the generator
 * system."). Loads the inspection's stored A2 load calculation and runs the
 * SAME shared engine the field app uses, so the office can play the shed
 * scenarios live — fuel, soft start, altitude, per-load management picks —
 * with the customer on the phone, then save the design back to the record.
 * The data sheet and the estimate attachment render exactly what was saved
 * here; the server recomputes the recommendation on save (one engine, no
 * client-written numbers).
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { recommendGenerator, type GeneratorFuel } from "../../../shared/loadcalc/generator";
import { SHED_CANDIDATE_TYPES } from "../../../shared/loadcalc/generatorData";

export function GeneratorDesigner({ inspectionId, onClose }: { inspectionId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["inspectionLoadCalc", inspectionId],
    queryFn: () => api.inspectionLoadCalc(inspectionId),
  });

  const [fuel, setFuel] = useState<GeneratorFuel>("NG");
  const [softStart, setSoftStart] = useState(false);
  const [altitudeSteps, setAltitudeSteps] = useState(1);
  const [includeInEstimate, setIncludeInEstimate] = useState(false);
  const [shedSelection, setShedSelection] = useState<string[] | undefined>(undefined);
  // Seed the controls from the stored design exactly once per open.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!data || seeded) return;
    const g = data.generator;
    if (g) {
      setFuel(g.fuel);
      setSoftStart(g.softStart);
      setAltitudeSteps(g.altitudeSteps);
      setIncludeInEstimate(g.includeInEstimate);
      setShedSelection(g.shedSelection);
    }
    setSeeded(true);
  }, [data, seeded]);

  const rec = useMemo(
    () =>
      data
        ? recommendGenerator({
            calcInput: data.input,
            calcResult: data.result,
            fuel,
            softStart,
            site: { altitudeSteps },
            shedSelection,
          })
        : null,
    [data, fuel, softStart, altitudeSteps, shedSelection],
  );

  const shedCandidates = useMemo(
    () => (data ? data.input.loads.filter((l) => SHED_CANDIDATE_TYPES.includes(l.type)) : []),
    [data],
  );
  const shedActive = (id: string) => shedSelection === undefined || shedSelection.includes(id);
  const toggleShed = (id: string) => {
    const base = shedSelection ?? shedCandidates.map((l) => l.id);
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    setShedSelection(next.length === shedCandidates.length ? undefined : next);
  };

  const save = useMutation({
    mutationFn: () =>
      api.saveGeneratorDesign(inspectionId, { fuel, softStart, altitudeSteps, includeInEstimate, shedSelection }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["inspectionLoadCalc", inspectionId] }),
  });
  const renderSheet = useMutation({
    mutationFn: () => api.generateGeneratorReport(inspectionId),
    onSuccess: (r) => window.open(`/api/documents/${r.documentId}/pdf`, "_blank"),
  });
  const saveAndOpen = async () => {
    await save.mutateAsync();
    renderSheet.mutate();
  };

  if (isLoading) return <div className="mt-3 rounded-lg border border-rce-border p-3 text-xs text-rce-muted">Loading the stored load calculation…</div>;
  if (error || !data || !rec) {
    return (
      <div className="mt-3 rounded-lg border border-rce-border p-3 text-xs text-red-700">
        {(error as Error | null)?.message ?? "This inspection has no load calculation to design from."}
        <button className="btn ml-2 text-xs" onClick={onClose}>Close</button>
      </div>
    );
  }

  const [full, managed, interlock] = rec.wholeHome;

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-rce-border bg-white p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Generator system designer</h3>
        <button className="btn text-xs" onClick={onClose}>Close</button>
      </div>
      <p className="text-xs text-rce-muted">
        Article 220 basis: {data.result.governingAmps} A calculated on a {data.input.serviceAmps} A service
        ({data.result.methodUsed} method). Same engine as the field app — every number below updates live.
      </p>

      {/* ── Design controls ── */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          Fuel
          <select className="field" value={fuel} onChange={(e) => setFuel(e.target.value as GeneratorFuel)}>
            <option value="NG">Natural gas</option>
            <option value="LP">Propane (LP)</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          Altitude (×1,000 ft)
          <input
            type="number" min={0} step={1} className="field w-16"
            value={altitudeSteps}
            onChange={(e) => setAltitudeSteps(Math.max(0, Number(e.target.value)))}
          />
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={softStart} onChange={(e) => setSoftStart(e.target.checked)} />
          soft-start kit on largest compressor
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={includeInEstimate} onChange={(e) => setIncludeInEstimate(e.target.checked)} />
          offer with the estimate
        </label>
      </div>

      {/* ── Shed picks — the customer's control over the installation ── */}
      {shedCandidates.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-rce-muted">
            Load management — which loads may shed (Option 2)
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            {shedCandidates.map((l) => (
              <label key={l.id} className="flex items-center gap-1 rounded border border-rce-border px-2 py-1 text-xs">
                <input type="checkbox" checked={shedActive(l.id)} onChange={() => toggleShed(l.id)} />
                {l.label}
              </label>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-rce-soft">
            Unchecked loads stay in the base load Option 2 is sized for. A checked load leaves the
            calculation only when a valid management path exists — no phantom shedding.
          </p>
        </div>
      )}

      {/* ── The three connection options, live ── */}
      <div className="space-y-1.5">
        {[full, managed, interlock].map((s) => (
          <div key={s.scheme} className="rounded border border-rce-border p-2 text-xs">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{s.title}</span>
              <span className={s.liquidCooled ? "font-medium text-red-700" : "text-rce-muted"}>
                {s.liquidCooled
                  ? "exceeds air-cooled class"
                  : s.model
                    ? `Guardian ${s.model.classLabel} kW`
                    : "—"}
              </span>
            </div>
            <p className="text-rce-muted">
              {s.necBasis} · {s.requiredKW !== null ? `${s.requiredKW} kW required (${s.requiredAmps} A)` : "no code-minimum size"}
            </p>
            {s.shedLoads !== undefined && s.shedLoads.length > 0 && (
              <p className="text-rce-soft">Managed: {s.shedLoads.join(" · ")}</p>
            )}
            {/* Over the ceiling: a flag, never an automatic change to the selection (Kyle, 2026-08-31). */}
            {s.airCooled && !s.airCooled.fits && (
              <p className="font-medium text-red-700">
                Exceeds the air-cooled ceiling ({s.airCooled.ceilingKW} kW at this site) by {s.airCooled.overByKW} kW
                {s.scheme === "ats_load_management" ? " — add loads to management until it fits" : " — see load management"}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* ── The shed menu — a variety of options for the customer ── */}
      {rec.shedScenarios.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-rce-muted">
            Sizing by what is managed — the menu of alternatives
          </p>
          <p className="text-[11px] text-rce-soft">
            Independent of the checkboxes above: each row manages one load on its own, plus the
            everything-managed floor. A load with no row saves nothing alone — another load governs
            its Article 220 category. Option 2 reflects your current selection.
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-rce-muted">
            {rec.shedScenarios.map((s) => (
              <li key={s.label}>
                Manage {s.label === "Every manageable load" ? "every manageable load" : s.managedLabels.join(" + ")}:
                {" "}carries <b>{s.requiredKW} kW</b> ({s.requiredAmps} A) —
                {" "}{s.reductionKW} kW less than the full load
                {" "}
                <span className={s.fitsAirCooled ? "text-rce-success" : "text-red-700"}>
                  {s.fitsAirCooled ? "· within air-cooled" : "· exceeds air-cooled"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rec.flags.length > 0 && (
        <div className="space-y-0.5">
          {rec.flags.map((f) => (
            <p key={f.id} className={`text-xs ${f.severity === "hard" ? "text-red-700" : "text-amber-700"}`}>
              {f.severity === "hard" ? "Flag: " : "Check: "}{f.message}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary text-xs" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save design"}
        </button>
        <button
          className="btn btn-secondary text-xs"
          disabled={save.isPending || renderSheet.isPending}
          onClick={() => void saveAndOpen()}
        >
          {renderSheet.isPending ? "Rendering…" : "Save & open data sheet"}
        </button>
        {save.isSuccess && !save.isPending && (
          <span className="text-xs text-rce-success">Design saved to the record.</span>
        )}
        {(save.error || renderSheet.error) && (
          <span className="text-xs text-red-700">{((save.error ?? renderSheet.error) as Error).message}</span>
        )}
      </div>
    </div>
  );
}
