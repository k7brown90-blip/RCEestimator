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

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { CollapsibleCard } from "../components/CollapsibleCard";
import { UnsavedNote } from "../components/UnsavedNote";
import type { FinancingPlan, FinancingPlanType } from "../../../shared/financing";

/** The form holds numbers as text while they are typed; they are parsed on save. */
interface PlanForm {
  /** Client-only identity of a row (never sent): it keeps a plan's fold and "edited" flag with it when plans move or are removed. */
  uid: string;
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

let nextUid = 0;
const newUid = () => `plan-${++nextUid}`;

const toForm = (p: FinancingPlan, uid: string = newUid()): PlanForm => ({
  uid,
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

/**
 * The rows for a (re)loaded plan list, keeping each plan's uid when it was already on screen - matched by plan number first, then by
 * position - so a plan that was open stays open through "Save financing plans" and "Discard changes" (Kyle, 2026-11-26: "Fold each
 * financing plan"). A plan that was not on screen gets a new uid.
 */
const reseed = (plans: FinancingPlan[], prev: PlanForm[]): PlanForm[] => {
  const used = new Set<string>();
  return plans.map((p, i) => {
    const byNumber = prev.find((r) => !used.has(r.uid) && r.planNumber.trim() === p.planNumber);
    const byPosition = prev[i] && !used.has(prev[i].uid) ? prev[i] : undefined;
    const uid = (byNumber ?? byPosition)?.uid ?? newUid();
    used.add(uid);
    return toForm(p, uid);
  });
};

const EMPTY_PLAN: Omit<PlanForm, "uid"> = {
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

/** What a row holds, without its identity: two rows with the same text are the same plan. */
const textOf = (r: PlanForm): string => JSON.stringify({ ...r, uid: "" });

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
  // What each row (by uid) read when it was loaded: a row that differs, or is not here, is "edited - not saved".
  const [base, setBase] = useState<Record<string, string>>({});
  // Which plans are unfolded. Every plan starts folded (Kyle, 2026-11-26: "Fold each financing plan"); a plan just added opens.
  const [openPlans, setOpenPlans] = useState<Record<string, boolean>>({});
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The rows as last rendered, so a reload can hand each plan its uid back (declared before the reseed effect: effects run in order).
  const rowsRef = useRef(rows);
  useEffect(() => { rowsRef.current = rows; });

  useEffect(() => {
    // Never overwrite what is being typed with a refetch.
    if (!loaded || dirty) return;
    const next = reseed(loaded.plans, rowsRef.current);
    setRows(next);
    setBase(Object.fromEntries(next.map((r) => [r.uid, textOf(r)])));
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
    const row: PlanForm = { ...EMPTY_PLAN, uid: newUid() };
    setDirty(true);
    setRows((list) => [...list, row]);
    setOpenPlans((o) => ({ ...o, [row.uid]: true }));
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
    const next = reseed(loaded?.plans ?? [], rows);
    setRows(next);
    setBase(Object.fromEntries(next.map((r) => [r.uid, textOf(r)])));
  };

  const input = "field mt-1 w-full";

  const offered = rows.filter((r) => r.active).length;
  // The folded row: the count, and "Unsaved changes" so a folded card never hides work that is not saved. Unsaved edits also open the card.
  const summary = (
    <>
      {rows.length === 0 ? "No plans yet" : `${rows.length} plan${rows.length === 1 ? "" : "s"}, ${offered} offered`}
      <UnsavedNote show={dirty} />
    </>
  );

  return (
    <CollapsibleCard
      id="settings-financing-plans"
      title="Financing plans (Synchrony)"
      data-testid="financing-plans-section"
      attention={dirty}
      // Kyle, 2026-10-08: the plan list is editable "because Synchrony changes rates". The screens keep the order listed here (Move up /
      // Move down), they do not re-sort by payment; switching a plan off, removing it or changing it never changes an estimate already sent.
      subtitle="The Synchrony plans a customer is shown a monthly payment for, in this order; changing a plan never changes an estimate that was already sent."
      summary={summary}
    >
      <div className="mt-4 space-y-4">
        {rows.length === 0 && <p className="text-sm text-rce-muted">No plans yet. Use &ldquo;Add a plan&rdquo; below.</p>}
        {rows.map((r, index) => (
          <CollapsibleCard
            key={r.uid}
            id={`settings-financing-plan-${r.uid}`}
            inner
            open={openPlans[r.uid] === true}
            onOpenChange={(next) => setOpenPlans((o) => ({ ...o, [r.uid]: next }))}
            data-testid={`financing-plan-${index}`}
            title={
              <>
                {r.planNumber ? `Plan ${r.planNumber}` : "New plan"}
                {r.description ? ` — ${r.description}` : ""}
              </>
            }
            summary={
              <>
                {!r.active && <span className="mr-2 rounded bg-slate-100 px-2 py-0.5 text-slate-600">Off &mdash; customers do not see it</span>}
                {dirty && base[r.uid] !== textOf(r) && <span className="font-semibold text-amber-800">Edited &mdash; not saved</span>}
              </>
            }
          >
            <div className="flex flex-wrap items-center justify-end gap-2">
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
                  A percent: 6.1 means 6.1%. The fee on a job is half of this rate, taken on the balance after the deposit.
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
          </CollapsibleCard>
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
    </CollapsibleCard>
  );
}
