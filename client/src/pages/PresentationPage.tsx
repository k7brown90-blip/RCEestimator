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
import { useStickyFooterSpace } from "../lib/useStickyFooterSpace";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  buildOptions,
  companySummary,
  materialList,
  type Audience,
} from "../lib/presentation";
import { emailReason, presentDecision, presentFooter, signNowReason } from "../lib/presentIssue";
import type { PbOption } from "../lib/types";
import { defaultSelection, picksOne, selectionPrice, toggleSelection } from "../../../shared/quoteMoney";
import { FinancingLine } from "../components/FinancingSheet";

function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `$${v.toFixed(2)}`;
}

export function PresentationPage() {
  const { draftId = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [audience, setAudience] = useState<Audience>("customer");
  // null = Kyle has not touched a tick yet (the shared default applies); an empty array is a real
  // choice - everything unticked - exactly as on the phone's Show the customer screen.
  const [selected, setSelected] = useState<PbOption[] | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["pb-compute", draftId],
    queryFn: () => api.pbCompute(draftId),
    enabled: Boolean(draftId),
  });

  const options = useMemo(
    () => (data ? buildOptions(data.computed, data.options, audience) : []),
    [data, audience],
  );

  /*
    ── THE PRICE OF WHAT IS TICKED COMES FROM THE SERVER (Phase 3 unit A, 2026-10-08) ─────────────
    "One estimating system": this screen used to add the ticked options, the trip, the combined-
    options saving and the programme discount in the browser, beside a second copy in Estimate
    Intake and a third on the customer's page. There is one pricer now (shared/quoteMoney.ts, run
    by the server); the compute payload carries its finished table as `money.selections` and this
    screen LOOKS THE TICK UP. It adds nothing. The customer's page and the field's "Show the
    customer" screen read the same table, so the three cannot disagree.
  */
  const figures = data?.money ?? null;

  // One-or-the-other mode (Kyle, 2026-08-25): options are alternatives, not
  // add-ons — ticking one unticks the rest, and exactly one goes to signature.
  const exclusive = figures ? picksOne(figures) : false;

  // Everything with work in it starts ticked. Kyle presents the whole thing and un-ticks what the
  // customer declines, rather than building the sale up from nothing. In exclusive mode the
  // default is the FIRST option — presenting three alternatives as all-selected would be a lie.
  // (`defaultSelection` is the shared rule; the field's screen starts the same way.)
  const effectiveSelected: PbOption[] = !figures
    ? []
    : selected === null
      ? defaultSelection(figures)
      : (figures.pickable.filter((o) => selected.includes(o)) as PbOption[]);

  /*
    The third gate, live while Kyle sells (2026-08-22): "the savings add up and help push the sale
    of more work simply by lowing the cost of material." The engine priced every combination
    server-side; the saving for the current tick is in the same table row as the total, shown
    beside it, so "take both and the material gets cheaper" is a number on screen, not a promise.
    The programme discount (Kyle, 2026-08-22: 5% of what this selection pays, capped at $250) is in
    that row too, with the programme's own words in `money.discount.label`.
  */
  const priced = figures ? selectionPrice(figures, effectiveSelected) : null;
  const comboSaving = priced?.comboSaving ?? 0;
  const progAmount = priced?.discount ?? 0;
  const total = priced?.total ?? null;
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

    ISSUED ONCE, NOT ON EVERY PRESS (2026-10-08 audit §5). This used to call pbIssue on each press,
    and on a draft already issued and untouched since, every press made a NEW revision of an
    unchanged document and killed the customer's link. The server's `lifecycle` (shared/
    draftLifecycle.ts, the same lookup the issue door itself runs) now decides, in lib/presentIssue:
    nothing issued or the draft changed since → issue (a first estimate, or a revision carrying the
    edits); issued and unchanged → use the estimate that exists; lost → blocked, reopen it first.
  */
  const account = params.get("account");
  const address = params.get("address");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const decision = presentDecision(data?.lifecycle);
  // Nothing ticked is nothing to sign (the server refuses an explicit empty choice) - grey the
  // button WITH that reason before the press instead of issuing and then failing.
  const signBlocked =
    signNowReason(decision) ??
    (effectiveSelected.length === 0 && decision.kind !== "blocked" ? "Tick at least one option - there is nothing to sign yet." : null);
  const emailBlocked = emailReason(decision);

  const issueThen = useMutation({
    mutationFn: async (next: "send" | "sign") => {
      if (decision.kind === "blocked") throw new Error(decision.reason);
      let estimateId: string;
      let number: string;
      let unpriced: string[] | undefined;
      if (decision.kind === "reuse") {
        estimateId = decision.estimateId;
        number = decision.number;
      } else {
        if (!account || !address) {
          throw new Error("This estimate is not attached to an account and address yet.");
        }
        const issued = await api.pbIssue(draftId, { accountId: account, serviceAddressId: address });
        estimateId = issued.estimateId;
        number = issued.number;
        unpriced = issued.unpriced;
        // The lifecycle on this screen is now stale — the next press must see the estimate exists.
        void queryClient.invalidateQueries({ queryKey: ["pb-compute", draftId] });
      }
      if (next === "send") {
        const sent = await api.pbIssuedSend(estimateId, {});
        return { next, estimateId, number, to: sent.to, unpriced };
      }
      return { next, estimateId, number, to: null, unpriced };
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
      // The selection rides to the signing screen — on a one-or-the-other
      // estimate the server refuses anything but exactly one.
      if (r.next === "sign") navigate(`/sign-in-person/${r.estimateId}`, { state: { selectedOptions: effectiveSelected } });
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

  // The tap rule is the SHARED one (shared/quoteMoney.ts toggleSelection), the same function the
  // phone's Show the customer screen uses, so the same tap does the same thing in both apps
  // (review finding, 2026-10-08): one-or-the-other - picking one IS the act and a tap on the chosen
  // one does nothing (unticking it would present a $0 sale); otherwise a tap flips the option, and
  // unticking everything shows "Nothing selected" with no total, never a silent re-tick of all.
  const toggle = (option: PbOption) => {
    if (!figures) return;
    setSelected(toggleSelection(figures, effectiveSelected, option));
  };

  /*
    ABOVE the guards below, and it matters.

    Reserves exactly what the summary bar occupies — it grows with warnings and with the selection
    text, so the old fixed padding class was wrong the moment either changed.

    Placed here because the four early returns underneath mean a hook called after them would run
    on some renders and not others: none on the loading render, one once the estimate arrives.
    That is React error #310 and it would crash this screen every time an estimate finished
    loading. I wrote it below the guards first and the build was perfectly happy with it.
  */
  const bar = useStickyFooterSpace();

  if (!draftId) return <p className="p-4 text-sm text-rce-muted">No estimate specified.</p>;
  if (isLoading) return <p className="p-4 text-sm text-rce-muted">Loading the estimate…</p>;
  if (error) return <p className="p-4 text-sm text-red-600">{(error as Error).message}</p>;
  if (!data) return <p className="p-4 text-sm text-rce-muted">Estimate not found.</p>;

  return (
    <div>
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
                  ? "rounded-full bg-rce-accent px-4 py-2 text-sm font-semibold text-rce-text"
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

      {exclusive && (
        <p className="mb-2 rounded-lg bg-rce-accentBg p-2 text-sm font-medium text-rce-accentDark">
          One-or-the-other estimate — the customer picks exactly ONE option below.
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
                  type={exclusive ? "radio" : "checkbox"}
                  name={exclusive ? "present-optchoice" : undefined}
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
              {/* The option's price is the SERVER's figure (the same table as the total below), so a
                  frozen estimate shows the frozen price here too, not a live recompute. */}
              <div className="text-right text-lg font-semibold">
                {money(figures ? selectionPrice(figures, [o.option])?.subtotal ?? null : o.total)}
              </div>
            </header>

            {/*
              ── EACH OPTION SCROLLS ON ITS OWN (Kyle, 2026-08-21) ──────────────────────────────

              "The options menu needs to scroll individually."

              These lists grew unbounded, so one option with twenty lines pushed the other two off
              the bottom of the phone. Presenting three options means being able to see that there
              ARE three — the headers carry the name and the price, and those are what the customer
              is choosing between.

              Capped and scrollable, so the headers stay put and the detail moves inside its card.
              A short option is unaffected: max-height only bites when the content exceeds it.

              overscroll-contain stops a flick inside a list from scrolling the whole page once it
              hits the end — on a phone that is the difference between reading an option and losing
              your place in the estimate.
            */}
            <ul className="max-h-64 divide-y divide-rce-border/60 overflow-y-auto overscroll-contain">
              {o.lines.map((l, i) => (
                <li key={`${l.itemId}-${i}`} className="flex items-baseline justify-between gap-3 p-3">
                  <span className="min-w-0">
                    <span className="text-sm">{l.description}</span>
                    <span className="ml-2 text-xs text-rce-soft">
                      × {l.quantity}
                      {/* Unit is company-only — absent from a customer line by construction. */}
                      {audience === "company" && l.unit ? ` ${l.unit}` : ""}
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
              <p>
                Profit: <strong>{money(summary.profit)}</strong>
                {summary.charge > 0 && (
                  <> ({((summary.profit / summary.charge) * 100).toFixed(0)}% of charge)</>
                )}{" "}
                — before trip charge &amp; discounts
              </p>
            </div>
          )}
        </section>
      )}

      {/* Holds the page open by exactly the bar's height, whatever it is this render. */}
      <div aria-hidden style={{ height: bar.spacerHeight }} />

      {/* bottom-20 on a phone clears the mobile nav, which is its own fixed bar at bottom-0.
          md:bottom-0 because the nav is md:hidden. */}
      <div
        ref={bar.ref}
        className="fixed inset-x-0 bottom-20 z-30 border-t bg-white/95 p-3 backdrop-blur md:bottom-0"
      >
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div className="text-xs text-rce-soft">
            {effectiveSelected.length === 0
              ? "Nothing selected"
              : `Option${effectiveSelected.length > 1 ? "s" : ""} ${effectiveSelected.join(" + ")}`}
            {(priced?.trip ?? 0) > 0 ? ` · includes ${money(priced?.trip)} fixed` : ""}
          </div>
          <div className="text-right">
            {comboSaving > 0 && (
              <div className="text-xs font-semibold text-green-700">
                multi-option discount −{money(comboSaving)}
              </div>
            )}
            {progAmount > 0 && (
              <div className="text-xs font-semibold text-green-700">
                {figures?.discount?.label ?? "Discount"} −{money(progAmount)}
              </div>
            )}
            <div className="text-xs text-rce-soft">Total</div>
            <div className="text-2xl font-semibold">{money(total)}</div>
            {/*
              ── "or from $X/mo with financing" (Phase 5 unit B, 2026-10-08) ─────────────────────
              Under the total of what is ticked. The figures are the SERVER's (money.financing, the
              one shared calculator); pressing the line opens the four Synchrony plan cards, each
              with its own disclosure. Absent when no plan is on offer or nothing is ticked.
              Nothing here records a choice - the plan is picked when the balance is paid.
            */}
            <FinancingLine
              financing={figures?.financing}
              selected={effectiveSelected}
              label={`Option${effectiveSelected.length > 1 ? "s" : ""} ${effectiveSelected.join(" + ")}`}
              total={total}
            />
          </div>
        </div>
        {problem.length > 0 && (
          <div className="mx-auto mt-2 max-w-3xl space-y-1">
            {problem.map((r, i) => (
              <p key={i} className="rounded bg-amber-50 p-2 text-xs text-amber-900">{r}</p>
            ))}
          </div>
        )}

        {/* Greyed WITH the reason, never hidden (standing rule): the tooltip and the line below say why. */}
        <div className="mx-auto mt-2 flex max-w-3xl gap-2">
          <button
            className="btn btn-secondary flex-1"
            disabled={busy !== null || options.length === 0 || emailBlocked !== null}
            title={emailBlocked ?? undefined}
            onClick={() => issueThen.mutate("send")}
          >
            {busy === "send" ? "Sending…" : "Email to customer"}
          </button>
          <button
            className="btn btn-primary flex-1"
            disabled={busy !== null || options.length === 0 || signBlocked !== null}
            title={signBlocked ?? undefined}
            onClick={() => issueThen.mutate("sign")}
          >
            {busy === "sign" ? "Preparing…" : "Sign now"}
          </button>
        </div>
        <p className="mx-auto mt-1 max-w-3xl text-[11px] text-rce-soft">
          {presentFooter(decision)}
          {signBlocked && decision.kind !== "blocked" ? ` ${signBlocked}` : ""}
        </p>
      </div>
    </div>
  );
}
