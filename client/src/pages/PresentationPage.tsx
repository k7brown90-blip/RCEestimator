/**
 * The presentation screen — reviewing the estimate WITH the customer. (Step 3)
 *
 * Kyle, 2026-08-19:
 *
 *   *"This screen will be where the estimates are built and the next screen will be where we
 *    present the options."*
 *
 *   *"The presentation screen effectively replaces the review button as it is the 'review' with
 *    the customer."*
 *
 *   *"On the presentation screen all options will be presented, each with a check box. Once
 *    checked it will add the total for all options selected and count as a single job."*
 *
 * ── TWO VIEWS OF ONE ESTIMATE ──────────────────────────────────────────────────────────────────
 *
 * The **Customer** view is what Kyle turns the phone around and shows: what the work is, how much
 * of it, and a price per option. No line pricing and no labour units — his ruling, and the
 * numbers are absent from the data rather than hidden by CSS (see lib/presentation.ts).
 *
 * The **Company** view is his: line pricing, labour hours, and the material list he orders from.
 * It starts on Customer, because the cost of accidentally showing the wrong one is asymmetric —
 * a customer seeing Kyle's labour hours is a conversation he did not choose to have, while Kyle
 * seeing the customer view is a tap away from the one he wants.
 *
 * Nothing here freezes or sends anything. That is step 4.
 */

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  buildOptions,
  combinedTotal,
  companySummary,
  materialList,
  type Audience,
} from "../lib/presentation";
import type { PbOption } from "../lib/types";

function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `$${v.toFixed(2)}`;
}

export function PresentationPage() {
  const { draftId = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [audience, setAudience] = useState<Audience>("customer");
  const [selected, setSelected] = useState<PbOption[]>([]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["pb-compute", draftId],
    queryFn: () => api.pbCompute(draftId),
    enabled: Boolean(draftId),
  });

  const options = useMemo(
    () => (data ? buildOptions(data.computed, data.options, audience) : []),
    [data, audience],
  );

  // Everything with work in it starts ticked. Kyle presents the whole thing and un-ticks what the
  // customer declines, rather than building the sale up from nothing.
  const effectiveSelected = selected.length > 0 ? selected : options.map((o) => o.option);

  const total = data ? combinedTotal(options, effectiveSelected, data.computed.jobFixedCost) : null;
  const materials = data ? materialList(data.computed, effectiveSelected) : [];
  const summary = data ? companySummary(data.computed, effectiveSelected) : null;

  /*
    ── FREEZING IS A CONSEQUENCE, NOT A BUTTON (Kyle, 2026-08-19) ─────────────────────────────

    "Nothing should freeze the prices, once the estimate is emailed or signed we each should get
     a PDF copy of the estimate and at that time only will that estimate get recorded and froze."

    So there is no "finalize" action. Emailing issues the frozen estimate and then sends it;
    signing issues it and then opens the signature screen. The freeze happens because something
    happened, never because someone pressed a button whose purpose they had to guess.

    ORDER MATTERS AND THE FAILURE IS ASYMMETRIC. The estimate is issued FIRST and sent second. If
    the send then fails — an expired Gmail token, a bad address — the frozen record exists and can
    be re-sent, which is recoverable. Sending first and freezing second would mean a customer
    holding a quote that was never recorded, which is not.
  */
  const account = params.get("account");
  const address = params.get("address");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string[]>([]);

  const issueThen = useMutation({
    mutationFn: async (next: "send" | "sign") => {
      if (!account || !address) {
        throw new Error("This estimate is not attached to an account and address yet.");
      }
      const issued = await api.pbIssue(draftId, { accountId: account, serviceAddressId: address });
      if (next === "send") {
        const sent = await api.pbIssuedSend(issued.estimateId, {});
        return { next, estimateId: issued.estimateId, number: issued.number, to: sent.to, unpriced: issued.unpriced };
      }
      return { next, estimateId: issued.estimateId, number: issued.number, to: null, unpriced: issued.unpriced };
    },
    onMutate: (next) => {
      setBusy(next);
      setProblem([]);
    },
    onSuccess: (r) => {
      setBusy(null);
      // An unpriced line means the total is LOWER THAN THE WORK. Nothing blocks any more
      // (Kyle, 2026-08-20), so this is the last place it can be said before a customer signs.
      if (r.unpriced?.length) {
        setProblem([
          `⚠ ${r.unpriced.length} line(s) had no price and were counted as $0, so this estimate ` +
            `is CHEAPER THAN THE WORK: ${r.unpriced.join("; ")}.`,
        ]);
      }
      if (r.next === "sign") navigate(`/sign-in-person/${r.estimateId}`);
      else if (!r.unpriced?.length) setProblem([`Estimate ${r.number} sent to ${r.to}.`]);
    },
    onError: (err) => {
      setBusy(null);
      // The engine's refusal reasons arrive on a 409 and are shown VERBATIM — the wording is
      // what tells the operator which line is not ready.
      const body = (err as { body?: { reasons?: string[] } }).body;
      setProblem(body?.reasons?.length ? body.reasons : [(err as Error).message]);
    },
  });

  const toggle = (option: PbOption) => {
    const current = effectiveSelected;
    setSelected(
      current.includes(option) ? current.filter((o) => o !== option) : [...current, option],
    );
  };

  if (!draftId) return <p className="p-4 text-sm text-rce-muted">No estimate specified.</p>;
  if (isLoading) return <p className="p-4 text-sm text-rce-muted">Loading the estimate…</p>;
  if (error) return <p className="p-4 text-sm text-red-600">{(error as Error).message}</p>;
  if (!data) return <p className="p-4 text-sm text-rce-muted">Estimate not found.</p>;

  return (
    <div className="pb-28">
      <div className="mb-4 flex items-center justify-between gap-2">
        <button className="btn btn-secondary" onClick={() => navigate(-1)}>
          Back
        </button>
        <div className="flex gap-1">
          {(["customer", "company"] as Audience[]).map((a) => (
            <button
              key={a}
              onClick={() => setAudience(a)}
              className={
                audience === a
                  ? "rounded-full bg-rce-accent px-4 py-2 text-sm font-semibold text-white"
                  : "rounded-full border border-rce-border px-4 py-2 text-sm text-rce-soft"
              }
            >
              {a === "customer" ? "Customer view" : "Company view"}
            </button>
          ))}
        </div>
      </div>

      {audience === "company" && (
        <p className="mb-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
          Company view — line pricing, labour hours and the material list. Not for the customer.
        </p>
      )}

      {options.length === 0 && (
        <p className="card p-4 text-sm text-rce-muted">
          Nothing to present yet. Add work to an option first.
        </p>
      )}

      {options.map((o) => {
        const ticked = effectiveSelected.includes(o.option);
        return (
          <section
            key={o.option}
            className={`card mb-3 p-0 ${ticked ? "" : "opacity-60"}`}
          >
            <header className="flex items-start justify-between gap-3 border-b border-rce-border p-3">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5"
                  checked={ticked}
                  onChange={() => toggle(o.option)}
                />
                <span>
                  <span className="text-base font-semibold">Option {o.option}</span>
                  {!o.complete && (
                    <span className="ml-2 text-xs text-amber-800">not fully priced</span>
                  )}
                </span>
              </label>
              <div className="text-right text-lg font-semibold">{money(o.total)}</div>
            </header>

            <ul className="divide-y divide-rce-border/60">
              {o.lines.map((l, i) => (
                <li key={`${l.itemId}-${i}`} className="flex items-baseline justify-between gap-3 p-3">
                  <span className="min-w-0">
                    <span className="text-sm">{l.description}</span>
                    <span className="ml-2 text-xs text-rce-soft">
                      × {l.quantity}
                      {l.unit ? ` ${l.unit}` : ""}
                    </span>
                  </span>
                  {/* Present only in the company view — absent from the customer's data entirely. */}
                  {/* Kyle's breakdown, 2026-08-20: what it COSTS us, what we CHARGE, the
                      labour, and the total. Cost and charge are different numbers doing
                      different jobs and collapsing them made this unreadable. */}
                  {audience === "company" && (
                    <span className="shrink-0 text-right text-xs text-rce-soft">
                      <span className="block">
                        {l.laborHours != null ? `${l.laborHours.toFixed(2)} hr` : "hr —"} ·{" "}
                        {money(l.laborDollars)} labour
                      </span>
                      <span className="block">
                        {l.materialCost ? `cost ${money(l.materialCost)} · ` : ""}
                        {l.materialSell ? `charge ${money(l.materialSell)}` : "customer-supplied"}
                      </span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {audience === "company" && materials.length > 0 && (
        <section className="card mb-3 p-3">
          <h2 className="mb-2 text-sm font-semibold">Material list — selected options</h2>
          <p className="mb-2 text-xs text-rce-soft">
            What to order. Labour-only lines are not here — a customer-supplied fan has nothing to
            buy.
          </p>
          <ul className="divide-y divide-rce-border/60 text-sm">
            {materials.map((m) => (
              <li key={m.itemId} className="flex justify-between gap-3 py-1.5">
                <span>{m.description}</span>
                <span className="shrink-0 text-rce-soft">
                  × {m.quantity}
                  {m.unit ? ` ${m.unit}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {summary && (
            <div className="mt-2 space-y-0.5 border-t border-rce-border pt-2 text-xs text-rce-soft">
              <p>
                Material cost (what we spend): <strong>{money(summary.materialCost)}</strong>
              </p>
              <p>
                Material charged: <strong>{money(summary.materialCharged)}</strong>
              </p>
              <p>
                Labour: <strong>{summary.hours.toFixed(2)} hr</strong> ={" "}
                <strong>{money(summary.labourCost)}</strong>
              </p>
              <p>
                Job length: <strong>{summary.days.toFixed(2)} day(s)</strong> at 8 hr/day
              </p>
            </div>
          )}
        </section>
      )}

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 p-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div className="text-xs text-rce-soft">
            {effectiveSelected.length === 0
              ? "Nothing selected"
              : `Option${effectiveSelected.length > 1 ? "s" : ""} ${effectiveSelected.join(" + ")}`}
            {(data.computed.jobFixedCost ?? 0) > 0
              ? ` · includes ${money(data.computed.jobFixedCost)} fixed`
              : ""}
          </div>
          <div className="text-right">
            <div className="text-xs text-rce-soft">Total</div>
            <div className="text-2xl font-semibold">{money(total)}</div>
          </div>
        </div>
        {problem.length > 0 && (
          <div className="mx-auto mt-2 max-w-3xl space-y-1">
            {problem.map((r, i) => (
              <p key={i} className="rounded bg-amber-50 p-2 text-xs text-amber-900">{r}</p>
            ))}
          </div>
        )}

        <div className="mx-auto mt-2 flex max-w-3xl gap-2">
          <button
            className="btn btn-secondary flex-1"
            disabled={busy !== null || options.length === 0}
            onClick={() => issueThen.mutate("send")}
          >
            {busy === "send" ? "Sending…" : "Email to customer"}
          </button>
          <button
            className="btn btn-primary flex-1"
            disabled={busy !== null || options.length === 0}
            onClick={() => issueThen.mutate("sign")}
          >
            {busy === "sign" ? "Preparing…" : "Sign now"}
          </button>
        </div>
        <p className="mx-auto mt-1 max-w-3xl text-[11px] text-rce-soft">
          Either action records the estimate and freezes its prices. Nothing is frozen before then.
        </p>
      </div>
    </div>
  );
}
