import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * The same 220.83 question, answered on the phone before anyone is dispatched.
 *
 * Runs against the server, which re-computes from the raw inputs — the field app
 * and this panel therefore cannot quote different numbers, and the 220.87 gate
 * has a verdict it can trust.
 *
 * On a failure the primary action is "quote the service upgrade". Ordering the
 * metered demand study is a secondary path behind an explicit acknowledgement
 * that the customer wants to try to avoid the upgrade, because that is the only
 * situation in which a thirty-day study is the right advice.
 */

const QUICK_PICKS = [
  { label: "Range 12 kW", item: { type: "range", label: "Range", nameplateKW: 12, volts: 240 } },
  { label: "Dryer 5 kW", item: { type: "dryer", label: "Dryer", nameplateKW: 5, volts: 240 } },
  { label: "Water heater 4.5 kW", item: { type: "waterHeaterTank", label: "Water heater", nameplateKW: 4.5, volts: 240 } },
  { label: "Central A/C 28 A", item: { type: "cooling", label: "Central A/C", amps: 28, volts: 240 } },
  { label: "Electric heat 10 kW", item: { type: "spaceHeat", label: "Electric space heat", nameplateKW: 10, volts: 240 } },
  { label: "Dishwasher 1.2 kW", item: { type: "fixedAppliance", label: "Dishwasher", nameplateKW: 1.2, volts: 120 } },
];

const NEW_PICKS = [
  { label: "EV charger 48 A", item: { type: "evse", label: "EV charger (48 A)", nameplateKW: 11.5, volts: 240 } },
  { label: "EV charger 40 A", item: { type: "evse", label: "EV charger (40 A)", nameplateKW: 9.6, volts: 240 } },
  { label: "Hot tub 8 kW", item: { type: "spaSelfContained", label: "Hot tub", nameplateKW: 8, volts: 240 } },
  { label: "Heat pump", item: { type: "heatPump", label: "Heat pump", heatPump: { compressorVA: 7680, supplementalVA: 15000, lockout: false }, volts: 240 } },
  { label: "Tankless WH 18 kW", item: { type: "waterHeaterTankless", label: "Tankless water heater", nameplateKW: 18, volts: 240 } },
];

type Pick = { label: string; item: Record<string, unknown> };
type Row = { id: string; label: string; item: Record<string, unknown> };

interface CheckResult {
  id: string;
  method: string;
  variant: "A" | "B";
  amps: number;
  serviceAmps: number;
  loadPct: number;
  spareAmps: number;
  fits: boolean;
  citation: string;
  assumedValues: string[];
  breakdown: { label: string; appliedVA: number; rule: string }[];
  nextStep: string;
}

export function CapacityCheckPanel({
  propertyId, visitId,
}: {
  propertyId?: string | null;
  visitId?: string | null;
}) {
  const queryClient = useQueryClient();
  const [serviceAmps, setServiceAmps] = useState(100);
  const [floorAreaSqFt, setFloorAreaSqFt] = useState(1500);
  const [existing, setExisting] = useState<Row[]>([]);
  const [added, setAdded] = useState<Row[]>([]);
  const [result, setResult] = useState<CheckResult | null>(null);

  const history = useQuery({
    queryKey: ["capacityChecks", propertyId],
    queryFn: () => api.capacityChecks({ propertyId: propertyId! }),
    enabled: Boolean(propertyId),
  });

  const run = useMutation({
    mutationFn: () =>
      api.runCapacityCheck({
        id: crypto.randomUUID(),
        visitId: visitId ?? null,
        propertyId: propertyId!,
        serviceAmps,
        floorAreaSqFt,
        loads: existing.map((r) => ({ id: r.id, ...r.item })),
        newLoads: added.map((r) => ({ id: r.id, ...r.item })),
      }),
    onSuccess: (data) => {
      setResult(data as CheckResult);
      void queryClient.invalidateQueries({ queryKey: ["capacityChecks", propertyId] });
    },
  });

  const canRun = Boolean(propertyId) && serviceAmps > 0 && added.length > 0;
  const failedChecks = useMemo(
    () => (history.data ?? []).filter((c) => c.method === "220.83" && !c.fits && !c.studyOrderedAt),
    [history.data],
  );

  if (!propertyId) return null;

  return (
    <article className="card rounded-2xl border border-rce-border/70 p-5">
      <h2 className="text-lg font-semibold">Can the service take it? (NEC 220.83)</h2>
      <p className="mt-1 text-sm text-rce-muted">
        Run this before quoting an addition — or an upgrade. It is the fast, defensible answer and it
        needs no return trip.
      </p>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-sm font-medium">
          Existing service (A)
          <input
            type="number"
            className="field mt-1"
            value={serviceAmps}
            onChange={(e) => setServiceAmps(Number(e.target.value) || 0)}
          />
        </label>
        <label className="text-sm font-medium">
          Floor area (ft²)
          <input
            type="number"
            className="field mt-1"
            value={floorAreaSqFt}
            onChange={(e) => setFloorAreaSqFt(Number(e.target.value) || 0)}
          />
        </label>
      </div>

      <PickRow
        heading="What's already there"
        picks={QUICK_PICKS}
        rows={existing}
        onAdd={(pick) => setExisting((r) => [...r, { id: crypto.randomUUID(), ...pick }])}
        onRemove={(id) => setExisting((r) => r.filter((row) => row.id !== id))}
      />
      <PickRow
        heading="What they want to add"
        picks={NEW_PICKS}
        rows={added}
        onAdd={(pick) => setAdded((r) => [...r, { id: crypto.randomUUID(), ...pick }])}
        onRemove={(id) => setAdded((r) => r.filter((row) => row.id !== id))}
      />

      <button
        className="btn btn-primary mt-4"
        disabled={!canRun || run.isPending}
        onClick={() => run.mutate()}
      >
        {run.isPending ? "Calculating…" : "Run 220.83"}
      </button>
      {run.error && <p className="mt-2 text-sm text-red-600">{(run.error as Error).message}</p>}

      {result && (
        <div
          className={`mt-4 rounded-lg border p-4 ${
            result.fits ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"
          }`}
        >
          <p className="text-xl font-semibold">
            {result.amps} A of {result.serviceAmps} A — {result.loadPct}% loaded
          </p>
          <p className={`text-sm font-medium ${result.fits ? "text-emerald-800" : "text-red-800"}`}>
            {result.fits
              ? `Calculates with ${result.spareAmps} A spare. Quote the addition.`
              : `Over by ${Math.abs(result.spareAmps)} A. Quote the service upgrade.`}
          </p>
          <p className="mt-2 text-xs text-rce-muted">{result.citation}</p>
          {result.assumedValues.length > 0 && (
            <p className="mt-2 text-xs text-amber-800">
              Built on assumed nameplates ({result.assumedValues.join(", ")}). Confirm on site before
              this goes to the customer as a written summary.
            </p>
          )}
          {!result.fits && <OrderStudy checkId={result.id} />}
        </div>
      )}

      {failedChecks.length > 0 && !result && (
        <p className="mt-3 text-xs text-amber-800">
          {failedChecks.length} earlier check at this address did not clear the service and has no
          study ordered.
        </p>
      )}

      {(history.data ?? []).length > 0 && (
        <div className="mt-5 border-t border-rce-border pt-4">
          <h3 className="text-sm font-semibold">Calculation history at this address</h3>
          <p className="text-xs text-rce-soft">
            Every calculation for this property, whether run here or taken during a Health Record.
          </p>
          <ul className="mt-2 space-y-1">
            {(history.data ?? []).map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                <span>
                  <span className="font-medium">
                    {row.method}
                    {row.variant ? `(${row.variant})` : ""}
                  </span>{" "}
                  — {row.calculatedAmps} A of {row.serviceAmps} A ({row.loadPct}%)
                  {row.newLoadLabel ? ` · adding ${row.newLoadLabel}` : ""}
                </span>
                <span className="text-rce-soft">
                  {new Date(row.createdAt).toLocaleDateString()}
                  {/* A calculation taken with the panel open and the plates read is
                      not the same document as one keyed in on the phone. */}
                  {row.sourceInspectionId ? " · from a Health Record" : " · quoted"}
                  {row.studyOrderedAt ? " · study ordered" : ""}
                  {!row.fits && " · did not clear"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function PickRow({
  heading, picks, rows, onAdd, onRemove,
}: {
  heading: string;
  picks: Pick[];
  rows: Row[];
  onAdd: (pick: Pick) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="mt-4">
      <p className="text-sm font-medium">{heading}</p>
      <div className="mt-1 flex flex-wrap gap-2">
        {picks.map((pick) => (
          <button key={pick.label} className="btn btn-secondary text-xs" onClick={() => onAdd(pick)}>
            + {pick.label}
          </button>
        ))}
      </div>
      {rows.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-2 rounded bg-rce-surface px-2 py-1 text-xs">
              {row.label}
              <button className="text-rce-soft" onClick={() => onRemove(row.id)}>×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The 220.87 path, behind the acknowledgement it requires.
 *
 * Deliberately not a button. The customer has to have said they want to avoid
 * the upgrade, in their own words, and the sunk-cost warning is on the screen
 * before anyone can order it — the server rejects the request without both.
 */
function OrderStudy({ checkId }: { checkId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState("");
  const [startDate, setStartDate] = useState("");

  const order = useMutation({
    mutationFn: () =>
      api.orderDemandStudy(checkId, {
        customerDeclinedUpgrade: true,
        customerStatement: statement,
        startDate,
      }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  if (order.data) {
    return (
      <p className="mt-3 rounded border border-rce-border bg-white p-3 text-xs">
        Study ordered. Recorder install and removal are on the calendar for{" "}
        {order.data.recordingWindow.start} and {order.data.recordingWindow.end}.
      </p>
    );
  }

  if (!open) {
    return (
      <button className="btn btn-secondary mt-3 text-xs" onClick={() => setOpen(true)}>
        Customer wants to avoid the upgrade — consider a 220.87 study
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-2 rounded border border-amber-300 bg-white p-3">
      <p className="text-xs text-amber-900">
        A metered demand study is a recorder, a return trip and thirty days before there is an
        answer. It measures the house <em>as it was used</em> — a change in occupancy changes the
        result. And if it comes back short, the upgrade is still required and the study fee is spent.
        Only order this if the customer has heard that and still wants to try.
      </p>
      <textarea
        className="field"
        rows={2}
        placeholder="What the customer said, in their words"
        value={statement}
        onChange={(e) => setStatement(e.target.value)}
      />
      <label className="block text-xs font-medium">
        Recorder install date
        <input
          type="date"
          className="field mt-1"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <button
          className="btn btn-primary text-xs"
          disabled={!statement.trim() || !startDate || order.isPending}
          onClick={() => order.mutate()}
        >
          {order.isPending ? "Scheduling…" : "Order the study (2 visits, 31 days apart)"}
        </button>
        <button className="btn btn-secondary text-xs" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {order.error && <p className="text-xs text-red-600">{(order.error as Error).message}</p>}
    </div>
  );
}
