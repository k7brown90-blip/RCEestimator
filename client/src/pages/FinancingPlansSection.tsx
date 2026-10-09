/**
 * Settings -> "Financing plans (Synchrony)" (2026-10-08, one-estimating-system plan, Phase 5 / Detail B).
 *
 * Kyle, 2026-10-08: the plan list is editable "because Synchrony changes rates. Nothing hardcoded."
 * Each plan carries Synchrony's own disclosure text, which the customer sees VERBATIM beside that
 * plan's figures - so it is pasted here, per plan, and kept exactly as pasted.
 *
 * THE ONE SCREEN WHERE SYNCHRONY'S DISCOUNT RATE IS SHOWN. It is Red Cedar's cost - what Synchrony
 * charges the company - and is labelled so beside the box. No customer view, field screen, page or
 * email carries it; the server never sends it anywhere but this office Settings screen.
 *
 * Modelled on "Service territories" in SettingsPage: add / edit / remove, held in the page until
 * "Save financing plans". Removing a plan, or switching one off, changes nothing a customer sees
 * until it is saved - and an estimate already sent keeps the plans it was sent with.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { FinancingPlan, FinancingPlanType } from "../../../shared/financing";

/** The form holds numbers as text while they are typed; they are parsed on save. */
interface PlanForm {
  planNumber: string;
  type: FinancingPlanType;
  description: string;
  months: string;
  apr: string;
  paymentFactorPct: string;
  discountRatePct: string;
  active: boolean;
  explanation: string;
  important: string;
  terms: string;
}

const toForm = (p: FinancingPlan): PlanForm => ({
  planNumber: p.planNumber,
  type: p.type,
  description: p.description,
  months: String(p.months),
  apr: p.apr === null ? "" : String(p.apr),
  paymentFactorPct: String(p.paymentFactorPct),
  discountRatePct: String(p.discountRatePct),
  active: p.active,
  explanation: p.disclosure.explanation,
  important: p.disclosure.important,
  terms: p.disclosure.terms,
});

const EMPTY_PLAN: PlanForm = {
  planNumber: "",
  type: "reduced_apr",
  description: "",
  months: "",
  apr: "",
  paymentFactorPct: "1.75",
  discountRatePct: "",
  active: false,
  explanation: "",
  important: "",
  terms: "",
};

/** "" and anything non-numeric become NaN so the server's validation names the box, never a silent 0. */
const num = (s: string): number => (s.trim() === "" ? Number.NaN : Number(s));

const toPlans = (rows: PlanForm[]): FinancingPlan[] =>
  rows.map((r, i) => ({
    planNumber: r.planNumber.trim(),
    type: r.type,
    description: r.description.trim(),
    months: num(r.months),
    apr: r.type === "reduced_apr" ? num(r.apr) : null,
    paymentFactorPct: num(r.paymentFactorPct),
    discountRatePct: num(r.discountRatePct),
    active: r.active,
    sortOrder: i + 1,
    // Stored exactly as pasted - "never paraphrased, never trimmed".
    disclosure: { explanation: r.explanation, important: r.important, terms: r.terms },
  }));

export function FinancingPlansSection() {
  const queryClient = useQueryClient();
  const { data: loaded } = useQuery({ queryKey: ["financingPlans"], queryFn: api.financingPlans });
  const [rows, setRows] = useState<PlanForm[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Never overwrite what is being typed with a refetch.
    if (!loaded || dirty) return;
    setRows(loaded.plans.map(toForm));
  }, [loaded, dirty]);

  const save = useMutation({
    mutationFn: (plans: FinancingPlan[]) => api.saveCompanySetting("financingPlans", plans),
    onSuccess: () => {
      setDirty(false);
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      void queryClient.invalidateQueries({ queryKey: ["financingPlans"] });
      void queryClient.invalidateQueries({ queryKey: ["companySettings"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const edit = (index: number, patch: Partial<PlanForm>) => {
    setDirty(true);
    setRows((list) => list.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };
  const add = () => {
    setDirty(true);
    setRows((list) => [...list, { ...EMPTY_PLAN }]);
  };
  const remove = (index: number) => {
    setDirty(true);
    setRows((list) => list.filter((_, i) => i !== index));
  };
  const move = (index: number, by: -1 | 1) => {
    setDirty(true);
    setRows((list) => {
      const to = index + by;
      if (to < 0 || to >= list.length) return list;
      const next = [...list];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
  };
  const discard = () => {
    setDirty(false);
    setError(null);
    setRows((loaded?.plans ?? []).map(toForm));
  };

  const input = "field mt-1 w-full";

  return (
    <section className="card mt-5 p-6" data-testid="financing-plans-section">
      <h2 className="text-lg font-semibold">Financing plans (Synchrony)</h2>
      <p className="mt-1 text-sm text-rce-muted">
        The plans a customer is shown a monthly payment for, in the order listed here (change it with Move up / Move down; the screens keep this order, they do not re-sort by payment). Edit these when
        Synchrony changes a rate or its wording. Switching a plan off, removing it, or changing it never changes an
        estimate that was already sent &mdash; each sent estimate keeps the plans it went out with.
      </p>

      <div className="mt-4 space-y-4">
        {rows.length === 0 && <p className="text-sm text-rce-muted">No plans yet. Use &ldquo;Add a plan&rdquo; below.</p>}
        {rows.map((r, index) => (
          <div key={index} className="rounded-lg border border-rce-border bg-white p-4" data-testid={`financing-plan-${index}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold">
                {r.planNumber ? `Plan ${r.planNumber}` : "New plan"}
                {r.description ? ` — ${r.description}` : ""}
                {!r.active && <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-600">Off &mdash; customers do not see it</span>}
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={r.active} onChange={(e) => edit(index, { active: e.target.checked })} />
                  Offer to customers
                </label>
                <button type="button" className="btn px-2 py-0.5 text-xs min-h-0" disabled={index === 0} title={index === 0 ? "Already first" : "Show this plan earlier"} onClick={() => move(index, -1)}>
                  Move up
                </button>
                <button type="button" className="btn px-2 py-0.5 text-xs min-h-0" disabled={index === rows.length - 1} title={index === rows.length - 1 ? "Already last" : "Show this plan later"} onClick={() => move(index, 1)}>
                  Move down
                </button>
                <button type="button" className="btn btn-danger px-2 py-0.5 text-xs min-h-0" onClick={() => remove(index)}>
                  Remove
                </button>
              </span>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <label className="text-sm font-medium">
                Plan number
                <input className={input} value={r.planNumber} placeholder="965" onChange={(e) => edit(index, { planNumber: e.target.value })} />
              </label>
              <label className="text-sm font-medium">
                Plan type
                <select className={input} value={r.type} onChange={(e) => edit(index, { type: e.target.value as FinancingPlanType })}>
                  <option value="reduced_apr">Fixed payment / reduced APR</option>
                  <option value="deferred_interest">No interest if paid in full (deferred interest)</option>
                </select>
              </label>
              <label className="text-sm font-medium">
                What the customer reads
                <input className={input} value={r.description} placeholder="11.99% APR until paid in full" onChange={(e) => edit(index, { description: e.target.value })} />
              </label>
              <label className="text-sm font-medium">
                {r.type === "reduced_apr" ? "Fixed-payment term (months)" : "Promo length (months)"}
                <input className={input} type="number" value={r.months} placeholder={r.type === "reduced_apr" ? "86" : "18"} onChange={(e) => edit(index, { months: e.target.value })} />
              </label>
              {r.type === "reduced_apr" && (
                <label className="text-sm font-medium">
                  Customer&rsquo;s APR (%)
                  <input className={input} type="number" step="0.01" value={r.apr} placeholder="11.99" onChange={(e) => edit(index, { apr: e.target.value })} />
                </label>
              )}
              <label className="text-sm font-medium">
                Payment factor (% of amount financed)
                <input className={input} type="number" step="0.01" value={r.paymentFactorPct} placeholder="1.75" onChange={(e) => edit(index, { paymentFactorPct: e.target.value })} />
              </label>
              <label className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm font-medium md:col-span-3">
                Discount rate (%) &mdash; Synchrony&rsquo;s charge to Red Cedar &mdash; never shown to customers
                <input className={input} type="number" step="0.01" value={r.discountRatePct} placeholder="6.1" onChange={(e) => edit(index, { discountRatePct: e.target.value })} />
                <span className="mt-1 block text-xs font-normal text-amber-900">
                  Type it as a percent: 6.1 means 6.1%. The financing fee on a job is half of this rate, taken on the balance after the deposit.
                </span>
              </label>
            </div>

            <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-rce-muted">Synchrony disclosure &mdash; shown to the customer exactly as pasted</p>
            <div className="mt-1 grid gap-3">
              <label className="text-sm font-medium">
                Explanation
                <textarea className={input} rows={4} value={r.explanation} onChange={(e) => edit(index, { explanation: e.target.value })} />
              </label>
              <label className="text-sm font-medium">
                IMPORTANT line
                <textarea className={input} rows={2} value={r.important} onChange={(e) => edit(index, { important: e.target.value })} />
              </label>
              <label className="text-sm font-medium">
                Terms
                <textarea className={input} rows={6} value={r.terms} onChange={(e) => edit(index, { terms: e.target.value })} />
              </label>
            </div>
          </div>
        ))}
      </div>

      {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800" role="alert">{error}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button className="btn" type="button" onClick={add}>
          Add a plan
        </button>
        <button className="btn btn-primary" type="button" disabled={save.isPending || !dirty} title={dirty ? undefined : "Nothing changed yet"} onClick={() => save.mutate(toPlans(rows))}>
          {saved ? "Saved ✓" : "Save financing plans"}
        </button>
        <button className="btn" type="button" disabled={!dirty} title={dirty ? undefined : "Nothing changed yet"} onClick={discard}>
          Discard changes
        </button>
        {dirty && <span className="text-xs text-rce-muted">Unsaved changes &mdash; nothing above takes effect until you save.</span>}
      </div>
    </section>
  );
}
