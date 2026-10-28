import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStickyFooterSpace } from "../lib/useStickyFooterSpace";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import { AccountPhotoGallery } from "../components/PhotoGalleryPanel";
import { SendEmailPanel } from "../components/SendEmailPanel";
import { WarrantyCoveragePanel } from "../components/WarrantyCoveragePanel";
import { RaiseChangeOrderButton } from "../components/RaiseChangeOrderButton";
import { FinancingLine } from "../components/FinancingSheet";
import { cheapestSelection } from "../../../shared/financingDisplay";
import { picksOne, selectionPrice, type QuoteMoney } from "../../../shared/quoteMoney";
import { acceptanceWording, isOfficeAcceptance } from "../../../shared/acceptance";
import {
  BASE_OPTIONS,
  OPTION_HINTS,
  OPTION_LIMIT_REASON,
  optionHint,
  type DraftOptionEntry,
  type DraftOptionSet,
} from "../../../shared/estimateOptions";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  buildColumns,
  findColumn,
  flattenOrder,
  moveToColumn,
  reorderWithin,
  sameColumns,
  type LineColumns,
} from "../lib/lineOrder";
import type {
  PbAtomic,
  PbComputed,
  PbOptionSummary,
  PbComputedLine,
  PbDifficulty,
  PbDraft,
  PbLine,
  PbOption,
  PbReview,
  PbWalkthroughRow,
  OnHand,
} from "../lib/types";

/**
 * Tech intake + confirmation — the estimating front end (P012).
 *
 * Kyle's requirements (projects/red-cedar-crm.md § TECH INTAKE): the tech describes the scope,
 * enters the material list built during the walkthrough, and browses parts as cards organised by
 * NEC chapter and section, with a direct search always available. The AI applies atomics off
 * those inputs — as PROPOSALS the tech confirms.
 *
 * TWO RULES THIS SCREEN EXISTS TO HOLD:
 *
 *  1. THE UI NEVER COMPUTES A DOLLAR. Every figure rendered here came from
 *     GET /price-book/drafts/:id/compute, which runs the verified pricing engine. There is no
 *     arithmetic in this file — not a multiply, not a sum. If a number is on screen, the server
 *     produced it. That is what keeps the screen and the workbook agreeing to the cent.
 *
 *  2. EXACT INPUTS PER ITEM. Quantity and difficulty are required per line and neither is
 *     silently defaulted into something that looks like data. Quantity is JUST A NUMBER (Kyle,
 *     2026-10-08: "We just need a number not type") — how it was counted (a length that was
 *     measured, an item that was counted) is worked out by the server from the item, so there is
 *     nothing here to pick and nothing to get wrong.
 */

type Tab = "browse" | "walkthrough" | "review";

const DIFFICULTIES: Array<{ value: PbDifficulty; label: string }> = [
  { value: "NORMAL", label: "Normal" },
  { value: "DIFFICULT", label: "Difficult" },
  { value: "VERY_DIFFICULT", label: "Very difficult" },
];

/**
 * Why a typed quantity cannot be saved, or null when it can.
 *
 * Mirrors the server's rule (lineQuantitySchema + assertQuantityAllowed in
 * atomicEstimateService.ts) and the field's Quote screen, so the desk refuses what the server
 * would, with the reason on screen: non-zero, and negative ONLY on a change order (a credit for
 * work removed). The server stays the decision; this just saves a round trip and a mystery.
 */
function quantityProblem(raw: string, isChangeOrder: boolean, what = "a quantity"): string | null {
  const n = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return `Enter ${what}.`;
  if (n === 0) return "A quantity of zero changes nothing — enter a number above zero" + (isChangeOrder ? " (or a minus number to take work off)." : ".");
  if (n < 0 && !isChangeOrder) return "Only a change order can take work off — enter a quantity above zero.";
  return null;
}

/** Money display only. Formatting, never arithmetic. */
function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `$${v.toFixed(2)}`;
}
function hours(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toFixed(2);
}

export function PriceBookIntakePage() {
  const queryClient = useQueryClient();
  // Draft and tab live in the URL so a draft is deep-linkable: a tech can leave the page and
  // come back to the same estimate, and the office can be sent a link to one job rather than
  // "open the estimate screen and find it".
  const [params, setParams] = useSearchParams();
  // "Raise a change order" arrives here with state when it REOPENED one already in progress
  // (RaiseChangeOrderButton) - said on arrival, because the press looks the same either way.
  const arrival = useLocation().state as { changeOrderResumed?: string } | null;
  const [resumedNoteDismissed, setResumedNoteDismissed] = useState(false);
  /** Which option new lines land in. Defaults to A — the direct quote for the call-out. */
  const [activeOption, setActiveOption] = useState<PbOption>("A");
  const draftId = params.get("draft");
  /*
    THE SPINE, CARRIED IN THE URL (P029).

    An estimate belongs to an account, at an address. The account page opens this screen with
    both already chosen; a draft that predates the ruling arrives with neither and gets the
    attach picker below instead of a Create button. Keeping them in the URL means the screen is
    still deep-linkable and a reload does not lose which job is being quoted.
  */
  const accountId = params.get("account");
  const serviceAddressId = params.get("address");
  const tab = (params.get("tab") as Tab | null) ?? "browse";
  const setDraftId = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("draft", id); else next.delete("draft");
    setParams(next, { replace: true });
  };
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set("tab", t);
    setParams(next, { replace: true });
  };
  const [search, setSearch] = useState("");
  const [article, setArticle] = useState<string | null>(null);
  const [picked, setPicked] = useState<PbAtomic | null>(null);
  // Unresolved walkthrough rows, reported up from WalkthroughTab so the totals bar cannot
  // read COMPLETE while any item is still UNMATCHED or AMBIGUOUS (P022).
  const [openItems, setOpenItems] = useState(0);
  const [newTitle, setNewTitle] = useState("");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["pb-review", draftId] });
    void queryClient.invalidateQueries({ queryKey: ["pb-compute", draftId] });
  };

  const { data: drafts } = useQuery({ queryKey: ["pb-drafts"], queryFn: api.pbDrafts });
  // The draft list carries the attachment (customer/visit/lead names) — the review payload does
  // not, so the header line reads it from here.
  const activeDraft = drafts?.drafts.find((d) => d.id === draftId);
  // Browse by KYLE'S SECTIONS (P030). His book is organised the way his walkthroughs talk —
  // NM CABLE, OLD WORK BOXES, SERVICE & FEES — so the cards follow the book rather than asking
  // him to think in NEC article numbers.
  const { data: cats } = useQuery({ queryKey: ["pb-sections"], queryFn: api.pbSections });

  const { data: atomics, isFetching: searching } = useQuery({
    queryKey: ["pb-atomics", search, article],
    // `article` now holds a SECTION name (P030), so it filters the category column — the NEC
    // article filter it used to drive belonged to the retired machine catalog.
    queryFn: () => api.pbAtomics({ search: search || undefined, category: article ?? undefined, limit: 60 }),
    enabled: Boolean(search.trim()) || Boolean(article),
  });

  const { data: review } = useQuery({
    queryKey: ["pb-review", draftId],
    queryFn: () => api.pbReview(draftId as string),
    enabled: Boolean(draftId),
  });

  // The draft's OWN options — A, B, C plus any that were added (2026-10-08). Every option list on
  // this screen reads this, never a fixed three. Until the review arrives the three every draft
  // has stand in, so the bar draws at once.
  const optionSet = review?.optionSet;
  const letters: PbOption[] = optionSet ? optionSet.options.map((o) => o.option) : [...BASE_OPTIONS];
  // An option that is gone (removed here, or from the field) must not stay selected: new lines
  // would be filed under a letter the draft no longer has.
  const activeOpt: PbOption = letters.includes(activeOption) ? activeOption : "A";

  // A signed estimate shuts the draft's lines, options and order, and the server refuses each
  // (atomicEstimateService: addOption / removeOption / saveLineOrder) — so the buttons grey with the
  // reason instead of letting the click fail. The reason is the SERVER's (`optionSet.lockedReason`,
  // the same rule that does the refusing); this screen no longer decides "signed" for itself, which
  // is how it went wrong after a signed estimate was revised.
  const lockedReason = optionSet?.lockedReason ?? null;

  const { data: computed } = useQuery({
    queryKey: ["pb-compute", draftId],
    queryFn: () => api.pbCompute(draftId as string),
    enabled: Boolean(draftId),
  });

  /**
   * Kyle's names for the options, edited right here on the review screen (2026-08-20).
   *
   * "This is the perfect spot to make the title of each option reflect the itemized list that it
   *  represents."
   *
   * Its own query key rather than a field on pb-review: renaming an option must not invalidate the
   * confirmed-line list and make the whole review flicker while he is typing into it.
   */
  const { data: optionMeta } = useQuery({
    queryKey: ["pb-draft-options", draftId],
    queryFn: () => api.pbDraftOptions(draftId as string),
    enabled: Boolean(draftId),
  });

  const createDraft = useMutation({
    // The visit id arrives as a query param from the legacy estimate page's link (P024,
    // Option A). Absent = the nav entry = an unattached draft, which is the working default.
    mutationFn: () =>
      api.pbCreateDraft({
        title: newTitle.trim(),
        visitId: params.get("visitId"),
        customerId: accountId,
      }),
    onSuccess: (d) => {
      setDraftId(d.id);
      setNewTitle("");
      void queryClient.invalidateQueries({ queryKey: ["pb-drafts"] });
    },
  });

  const cards = useMemo(
    () => (cats?.sections ?? []).filter((c) => c.itemCount > 0),
    [cats]
  );

  return (
    <div className="space-y-4">
      <PageHeader title="Estimate intake" subtitle="Browse, search, and confirm — the engine prices" />

      {arrival?.changeOrderResumed && !resumedNoteDismissed && (
        <div role="status" className="flex items-start justify-between gap-3 rounded-lg bg-rce-accentBg p-3 text-sm text-rce-accentDark">
          <span>
            <strong>Opened the change order already in progress</strong> on estimate {arrival.changeOrderResumed}. No
            second change order was started - its lines are below.
          </span>
          <button type="button" className="shrink-0 text-xs underline" onClick={() => setResumedNoteDismissed(true)}>
            Dismiss
          </button>
        </div>
      )}

      {/* ── Draft selection. Every estimate starts blank (Kyle, 2026-08-12). ── */}
      <div className="card p-4">
        {/* The draft PICKER is gone (Kyle, 2026-08-19): "There should be no select a draft and
            we should not be saving estimates as drafts at all. Each one will be different."

            A list of half-finished estimates invites reusing yesterday's on today's customer.
            An estimate is now reached only through the account and address it belongs to —
            never chosen from a list. Starting a new one stays exactly where it was. */}
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            className="field flex-1"
            placeholder="New draft title (e.g. 'Panel change — 605 Green Farm Way')"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <button
            className="btn btn-secondary"
            disabled={!newTitle.trim() || createDraft.isPending}
            onClick={() => createDraft.mutate()}
          >
            Start draft
          </button>
        </div>
        {review?.draft.rateProvisional && (
          <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
            <strong>PROVISIONAL RATE.</strong> {review.draft.provisionalReason}
          </p>
        )}

        {/*
          WHICH JOB IS THIS? (P024, Option A / Scope — do 4.)

          Before this a draft referenced nothing in the lead -> visit -> account chain, so a
          priced draft had no owner and its title was the only record of what it was for.
          "Unattached" is a legitimate state, not a warning — Kyle prices speculatively and
          tests daily — so it is stated plainly rather than styled as an error.
        */}
        {draftId && review && (
          <p className="mt-2 text-xs text-rce-soft">
            {attachmentLabel(activeDraft) ?? "Unattached — not linked to a job or lead"}
          </p>
        )}
        {/* The title and scope the customer reads, and the way OUT of a draft nothing was issued
            from — in the same card that shows the draft (2026-10-08, Phase 2 unit B). */}
        {draftId && review && (
          <DraftDetailsCard
            draftId={draftId}
            review={review}
            onChanged={invalidate}
            onDeleted={() => {
              setDraftId(null);
              void queryClient.invalidateQueries({ queryKey: ["pb-drafts"] });
            }}
          />
        )}
      </div>

      {draftId && (
        <>
          {/* ── Tabs ── */}
          {/* ── Which option is being built (Kyle, 2026-08-19) ──────────────────────────────
              Page-level rather than a field inside each add sheet. He builds A, then B, then C,
              and asking on every single line would be a tap per item to answer a question whose
              answer almost never changes between them. Everything added — browse, search, or
              walkthrough — lands in whichever option is selected here. */}
          <OptionBar
            draftId={draftId}
            optionSet={optionSet}
            active={activeOpt}
            onSelect={setActiveOption}
            lockedReason={lockedReason}
          />

          <OptionModeAndCopy draftId={draftId} letters={letters} lockedReason={lockedReason} />

          {draftId && (
            <Link
              className="btn btn-primary w-full"
              to={`/present/${draftId}?from=intake${accountId ? `&account=${accountId}` : ""}${serviceAddressId ? `&address=${serviceAddressId}` : ""}`}
            >
              Present to the customer
            </Link>
          )}

          <div className="flex gap-1 overflow-x-auto">
            {([
              ["browse", "Browse & search"],
              ["walkthrough", "Walkthrough list"],
              ["review", `Review${review?.counts.proposed ? ` (${review.counts.proposed})` : ""}`],
            ] as Array<[Tab, string]>).map(([key, label]) => (
              <button
                key={key}
                className={tab === key ? "btn btn-primary whitespace-nowrap" : "btn btn-secondary whitespace-nowrap"}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "browse" && (
            <BrowseTab
              search={search}
              setSearch={setSearch}
              article={article}
              setArticle={setArticle}
              cards={cards}
              atomics={atomics?.atomics ?? []}
              searching={searching}
              onPick={setPicked}
            />
          )}

          {tab === "walkthrough" && (
            <WalkthroughTab
              draftId={draftId}
              option={activeOpt}
              onChanged={invalidate}
              onOpenItemsChange={setOpenItems}
            />
          )}

          {tab === "review" && (
            <ReviewTab
              draftId={draftId}
              review={review}
              isChangeOrder={Boolean(review?.draft.changeOrderForId)}
              computed={computed?.computed}
              options={computed?.options}
              optionMeta={optionMeta}
              onChanged={invalidate}
              accountId={accountId}
              serviceAddressId={serviceAddressId}
              draftVisitId={review?.draft.visitId ?? null}
              draftCustomerId={review?.draft.customerId ?? null}
              onAttached={(acc, addr) => {
                const next = new URLSearchParams(params);
                next.set("account", acc);
                next.set("address", addr);
                setParams(next, { replace: true });
              }}
            />
          )}

          {/* ── Running totals. Straight from the engine, always visible. ── */}
          <TotalsBar
            computed={computed?.computed}
            quoteMoney={computed?.money}
            options={computed?.options}
            openQuestions={review?.counts.openQuestions ?? 0}
            openItems={openItems}
            draftId={draftId}
          />
        </>
      )}

      {picked && draftId && (
        <AddLineSheet
          atomic={picked}
          draftId={draftId}
          option={activeOpt}
          isChangeOrder={Boolean(review?.draft.changeOrderForId)}
          onClose={() => setPicked(null)}
          onAdded={() => {
            setPicked(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

// ─── Which option is being built: select / add / remove ─────────────────────

/**
 * The "Adding into" bar — the draft's own options, then "+ Add Option D" (Kyle, 2026-10-08).
 *
 * Kyle, debug-console request 2026-10-08 7:55 AM CT: "I want to be able to add more than 3 options
 * for projects that are more expansive. I want to have a create additional option button here which
 * will continue the options past 'C'." and "Capping it at eight is good."
 *
 *   - The button always NAMES the letter it will create ("+ Add Option D"). Which letter is the
 *     server's call (the lowest free letter after C, atomicEstimateService.addOption); the screen
 *     shows `optionSet.nextOption` and never works it out itself.
 *   - At H it is greyed and the reason is on screen: "Eight options is the limit."
 *   - Standing rule — nothing created is permanent: while an ADDED option (D to H) is selected,
 *     "Remove Option D" sits in the same bar. A, B and C are permanent and show no such button.
 *     If the option has lines, a confirm says how many go with it.
 *   - D to H have no fixed meaning, so the hint beside the bar says to name it in Review.
 *   - A signed estimate refuses both (the server's rule), so both grey with the reason shown.
 */
function OptionBar(props: {
  draftId: string;
  /** Undefined until the review arrives. */
  optionSet: DraftOptionSet | undefined;
  active: PbOption;
  onSelect: (o: PbOption) => void;
  /** Why options cannot be added or removed right now (a signed estimate), or null. */
  lockedReason: string | null;
}) {
  const { draftId, optionSet, active, onSelect, lockedReason } = props;
  const queryClient = useQueryClient();
  const [err, setErr] = useState<string | null>(null);

  const entries: DraftOptionEntry[] =
    optionSet?.options ??
    BASE_OPTIONS.map((option) => ({ option, label: null, note: null, lineCount: 0, removable: false }));
  const activeEntry = entries.find((e) => e.option === active);
  const next = optionSet?.nextOption ?? null;

  // The response carries the draft's new option list: put it straight into the review cache so the
  // bar, the Review sections and every select agree at once, then refetch the rest.
  const adopt = (set: DraftOptionSet) => {
    queryClient.setQueryData<PbReview>(["pb-review", draftId], (old) => (old ? { ...old, optionSet: set } : old));
    void queryClient.invalidateQueries({ queryKey: ["pb-review", draftId] });
    void queryClient.invalidateQueries({ queryKey: ["pb-compute", draftId] });
    void queryClient.invalidateQueries({ queryKey: ["pb-draft-options", draftId] });
    void queryClient.invalidateQueries({ queryKey: ["pb-issued", draftId] });
  };

  const add = useMutation({
    mutationFn: () => api.pbAddOption(draftId),
    onSuccess: (r) => {
      setErr(null);
      adopt(r.optionSet);
      onSelect(r.option);
    },
    onError: (e) => setErr((e as Error).message),
  });
  const remove = useMutation({
    // The count goes with the press: if the other app has put lines in the option since this screen
    // loaded, the server deletes nothing and says so (409) instead of removing more than was agreed.
    mutationFn: (v: { option: PbOption; expectedLines: number }) => api.pbRemoveOption(draftId, v.option, v.expectedLines),
    onSuccess: (r) => {
      setErr(null);
      adopt(r.optionSet);
      if (active === r.option) onSelect("A");
    },
    onError: (e) => {
      setErr((e as Error).message);
      // The count on this screen is out of date — refetch so the next press shows the real one.
      void queryClient.invalidateQueries({ queryKey: ["pb-review", draftId] });
    },
  });

  const addReason = !optionSet ? "Loading the estimate…" : lockedReason ?? (next ? null : `${OPTION_LIMIT_REASON}.`);
  const removeReason = lockedReason;

  return (
    <div className="card flex flex-wrap items-center gap-2 p-3">
      <span className="text-xs font-medium text-rce-soft">Adding into</span>
      {entries.map((e) => (
        <button
          key={e.option}
          onClick={() => onSelect(e.option)}
          className={
            active === e.option
              ? "rounded-full bg-rce-accent px-3 py-1.5 text-sm font-semibold text-rce-text"
              : "rounded-full border border-rce-border px-3 py-1.5 text-sm text-rce-soft"
          }
        >
          Option {e.option}
        </button>
      ))}
      <button
        className="rounded-full border border-dashed border-rce-soft px-3 py-1.5 text-sm font-medium text-rce-text disabled:cursor-not-allowed disabled:opacity-50"
        disabled={Boolean(addReason) || add.isPending}
        title={addReason ?? `Start Option ${next} — everything you add next lands in it`}
        onClick={() => add.mutate()}
      >
        {add.isPending ? "Adding…" : next ? `+ Add Option ${next}` : "+ Add Option"}
      </button>
      {activeEntry?.removable && (
        <button
          className="rounded-full border border-rce-border px-3 py-1.5 text-sm text-rce-soft disabled:cursor-not-allowed disabled:opacity-50"
          disabled={Boolean(removeReason) || remove.isPending}
          title={removeReason ?? `Take Option ${active} off this estimate`}
          onClick={() => {
            const n = activeEntry.lineCount;
            if (n > 0 && !window.confirm(`Option ${active} has ${n} ${n === 1 ? "line" : "lines"} — remove them too?`)) return;
            remove.mutate({ option: active, expectedLines: n });
          }}
        >
          {remove.isPending ? "Removing…" : `Remove Option ${active}`}
        </button>
      )}
      <span className="text-xs text-rce-soft">{optionHint(active)}</span>
      {addReason && optionSet && <p className="w-full text-xs text-amber-800">{addReason}</p>}
      {!addReason && activeEntry?.removable && removeReason && <p className="w-full text-xs text-amber-800">{removeReason}</p>}
      {err && <p className="w-full rounded bg-red-50 p-2 text-xs text-red-900">{err}</p>}
    </div>
  );
}

// ─── Browse + search ─────────────────────────────────────────────────────────

/**
 * Option mode + copy (Kyle, 2026-08-25).
 *
 * MODE — "I want to be able to choose either or options or the all that apply
 * options." The checkbox flips this draft between additive (default: A+B+C
 * sum) and one-or-the-other (the EV-charger-length case: three runs, one
 * charger — the customer picks exactly one, radio buttons on their page,
 * enforced again at signature).
 *
 * COPY — "copy an option to another so I could build on it": duplicates every
 * line from one option into another (appends, never replaces), so the 10-ft
 * run is built once and B/C start as copies to tweak.
 */
function OptionModeAndCopy({ draftId, letters, lockedReason }: { draftId: string; letters: PbOption[]; lockedReason: string | null }) {
  const queryClient = useQueryClient();
  const { data: mode } = useQuery({
    queryKey: ["pbOptionsMode", draftId],
    queryFn: () => api.pbOptionsMode(draftId),
  });
  const [copyFromPick, setCopyFrom] = useState<PbOption>("A");
  const [copyToPick, setCopyTo] = useState<PbOption>("B");
  // A pick that has since been removed falls back to the first/second option the draft has.
  const copyFrom: PbOption = letters.includes(copyFromPick) ? copyFromPick : letters[0];
  const copyTo: PbOption = letters.includes(copyToPick) ? copyToPick : (letters[1] ?? letters[0]);
  const [notice, setNotice] = useState<string | null>(null);
  // A signed estimate shuts the draft's lines, and copying an option adds lines, so the server
  // refuses it (2026-10-08). Grey the button and say why (the server's own sentence) instead of
  // letting the click fail. Mode and names stay open on a signed estimate — they take effect
  // through "Save changes to the estimate" (Kyle, 2026-09-29).

  const setMode = useMutation({
    mutationFn: (exclusive: boolean) => api.pbSetOptionsMode(draftId, exclusive),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["pbOptionsMode", draftId] }),
    onError: (err) => setNotice((err as Error).message),
  });
  const copy = useMutation({
    mutationFn: () => api.pbCopyOption(draftId, copyFrom, copyTo),
    onSuccess: (r) => {
      setNotice(`Copied ${r.copied} line(s) from Option ${r.from} into Option ${r.to}.`);
      void queryClient.invalidateQueries();
    },
    onError: (err) => setNotice((err as Error).message),
  });

  return (
    <div className="card flex flex-wrap items-center gap-3 p-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={mode?.exclusiveOptions ?? false}
          disabled={setMode.isPending}
          onChange={(e) => setMode.mutate(e.target.checked)}
        />
        <span>
          <span className="font-medium">One-or-the-other options</span>
          <span className="ml-1 text-xs text-rce-soft">
            — customer picks exactly ONE (e.g. three lengths, one charger). Unchecked: options add together.
          </span>
        </span>
      </label>
      <span className="ml-auto flex items-center gap-1 text-xs text-rce-soft">
        Copy
        <select className="field text-xs" aria-label="Copy from option" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value as PbOption)}>
          {letters.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        →
        <select className="field text-xs" aria-label="Copy into option" value={copyTo} onChange={(e) => setCopyTo(e.target.value as PbOption)}>
          {letters.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <button
          className="btn btn-secondary text-xs"
          disabled={copy.isPending || copyFrom === copyTo || Boolean(lockedReason)}
          title={lockedReason ?? undefined}
          onClick={() => copy.mutate()}
        >
          {copy.isPending ? "Copying…" : "Copy lines"}
        </button>
      </span>
      {lockedReason && (
        <p className="w-full text-xs text-amber-800">Lines can't be copied into this estimate. {lockedReason}</p>
      )}
      {notice && <p className="w-full text-xs text-rce-muted">{notice}</p>}
    </div>
  );
}

function BrowseTab(props: {
  search: string;
  setSearch: (v: string) => void;
  article: string | null;
  setArticle: (v: string | null) => void;
  cards: Array<{ section: string; itemCount: number }>;
  atomics: PbAtomic[];
  searching: boolean;
  onPick: (a: PbAtomic) => void;
}) {
  const { search, setSearch, article, setArticle, cards, atomics, searching, onPick } = props;
  const showingResults = Boolean(search.trim()) || Boolean(article);

  return (
    <div className="space-y-3">
      {/* Search is ALWAYS visible — field-app requirement: search-first, cards as the browse
          path, minimal taps to an accurate answer. */}
      <div className="card p-3">
        <input
          className="field w-full"
          placeholder="Search the price book — code or description"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
        />
        {article && (
          <button className="btn btn-secondary mt-2" onClick={() => setArticle(null)}>
            ← All sections
          </button>
        )}
      </div>

      {!showingResults && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {cards.map((c) => (
            <button
              key={c.section}
              className="card p-3 text-left active:opacity-70"
              onClick={() => setArticle(c.section)}
            >
              <div className="text-sm font-semibold leading-tight">{c.section}</div>
              <div className="mt-1 text-xs text-rce-soft">{c.itemCount} item(s)</div>
            </button>
          ))}
          {cards.length === 0 && (
            <p className="text-sm text-rce-muted">The catalog is empty.</p>
          )}
        </div>
      )}

      {showingResults && (
        <div className="space-y-2">
          {searching && <p className="text-sm text-rce-muted">Searching…</p>}
          {!searching && atomics.length === 0 && (
            <p className="text-sm text-rce-muted">
              Nothing matched. If the item exists on the job but not in the book, add it as a
              question on the Walkthrough tab so it is not lost.
            </p>
          )}
          {atomics.map((a) => (
            <button key={a.itemId} className="card w-full p-3 text-left active:opacity-70" onClick={() => onPick(a)}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold">{a.itemId}</div>
                  <div className="text-xs text-rce-muted line-clamp-2">{a.description}</div>
                </div>
                <div className="shrink-0 text-right text-xs">
                  <div className="text-rce-soft">{a.unit}</div>
                </div>
              </div>
              {/* Gaps are shown BEFORE the line is added — cheaper here than at finalize.
                  A LABOR PRODUCT buys nothing, so "no price at supplier" is not a gap on it and
                  is not badged — the engine stopped raising it as one on 2026-08-17. */}
              <div className="mt-2 flex flex-wrap gap-1">
                {/* Not on a flat-priced row: the permit fee buys nothing from a supplier and
                    prices at Kyle's own $200 — the badge told him it would not price (2026-08-22). */}
                {a.sellsMaterial && !a.hasPriceAtActiveSupplier && !a.isFlatPriced && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-900">no price at supplier</span>
                )}
                {!a.hasPublishedLabour && (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] text-red-900">no labour hours</span>
                )}
                {!a.hasLabourUnitBasis && a.hasPublishedLabour && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-900">no labour unit basis</span>
                )}
                {a.isContinuousLength && (
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-900">measured length</span>
                )}
                {a.isHourlyProduct && (
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-900">by the hour</span>
                )}
                {/* A hand-built product — one line here, the parts kept underneath. The field app's
                    picker badges it the same way (2026-10-08, one estimating system). */}
                {a.isAssembly && (
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-900">assembly</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Add a line — the exact-inputs sheet ─────────────────────────────────────

function AddLineSheet(props: {
  atomic: PbAtomic;
  draftId: string;
  option: PbOption;
  /**
   * A change-order draft may take a NEGATIVE quantity — a credit for work removed. Same rule the
   * field's Quote screen applies (QuoteScreen `allowNegative`); the server's assertQuantityAllowed
   * is the actual decision and refuses a negative anywhere else.
   */
  isChangeOrder: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { atomic, draftId, option, isChangeOrder, onClose, onAdded } = props;
  // Sold by the foot: the number is a length measured on site (Kyle's rule R3). It is still just
  // a number here — the server records it as a measured length on its own.
  const byLength = atomic.isContinuousLength;
  /*
    HOURLY PRODUCT — the third input shape (Kyle, 2026-08-17, verbatim):

      "The diagnostics menu is dictated by hours not quantity and measured, terminations,
       counted does not apply. We will put diagnostic hours and difficulty only here...
       The location and note is okay to stay here."

    So for a row sold by the hour the quantity field IS hours. (The source picker that used to
    sit under it was removed for every item on 2026-10-08 — "We just need a number not type" —
    after having been hidden for hourly rows since this ruling: offering "Manual" against an
    hour is what pushed Kyle's DG001 line onto `qty 2 MANUAL` and its justification note.)

    SEAM — what is stored. The line records `COUNT`, because `PriceBookQuantitySource` has no
    HOURS member and adding one touches the Prisma enum, the MCP tool contract and the AI
    proposer's function schema. The display is unit-aware instead, so no screen shows a count
    against an hour. If the stored record itself ever has to carry the distinction, HOURS as a
    real enum member is the fuller fix.
  */
  const hourly = atomic.isHourlyProduct;
  const [quantity, setQuantity] = useState("");
  const [difficulty, setDifficulty] = useState<PbDifficulty>("NORMAL");
  const [location, setLocation] = useState("");
  const [note, setNote] = useState("");

  const add = useMutation({
    mutationFn: () =>
      api.pbAddLine(draftId, {
        itemId: atomic.itemId,
        quantity: Number(quantity),
        difficulty,
        option,
        location: location.trim() || null,
        note: note.trim() || null,
      }),
    onSuccess: onAdded,
  });

  const qtyProblem = quantityProblem(quantity, isChangeOrder, hourly ? "the hours" : "a quantity");
  const qtyValid = qtyProblem === null;

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/40 sm:items-center sm:justify-center" onClick={onClose}>
      <div className="max-h-[88vh] w-full overflow-y-auto rounded-t-2xl bg-white p-4 sm:max-w-lg sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3">
          <div className="text-lg font-semibold">{atomic.itemId}</div>
          <div className="text-sm text-rce-muted">{atomic.description}</div>
        </div>

        <label className="text-sm font-medium">
          {hourly ? "Hours" : `Quantity ${atomic.unit ? `(${atomic.unit})` : ""}`}
          <input
            className="field mt-1 w-full"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder={hourly ? "How many hours" : byLength ? "Measured length" : isChangeOrder ? "How many (minus to remove)" : "How many"}
            autoFocus
          />
        </label>

        {hourly && (
          <p className="mt-1 text-xs text-rce-muted">
            Sold by the hour — hours and difficulty are the only inputs this needs.
          </p>
        )}
        {isChangeOrder && (
          <p className="mt-1 text-xs text-rce-muted">
            This is a change order — type a minus sign (for example -2) to take work off it.
          </p>
        )}

        <div className="mt-3">
          <span className="mb-1 block text-xs font-medium text-rce-soft">
            Difficulty — what you actually saw on site
          </span>
          <div className="flex flex-wrap gap-1">
            {DIFFICULTIES.map((d) => (
              <button
                key={d.value}
                className={difficulty === d.value ? "btn btn-primary" : "btn btn-secondary"}
                onClick={() => setDifficulty(d.value)}
              >
                {d.label}
              </button>
            ))}
          </div>
          {/* The three published NECA columns — not a multiplier. Shown so the tech can see the
              figure their selection picks, and see when one is missing. */}
          <p className="mt-1 text-xs text-rce-soft">
            Published hours: N {atomic.laborNormal ?? "—"} · D {atomic.laborDifficult ?? "—"} · VD{" "}
            {atomic.laborVeryDifficult ?? "—"}
            {!atomic.hasLabourUnitBasis && atomic.hasPublishedLabour && " · no unit basis — labour will not compute"}
          </p>
          {/*
            THE ROW WITH NO HOURS AT ALL — said out loud, in red, before the line is added.

            Every labour warning on this screen used to be guarded on `laborNormal !== null`, so a
            row whose three columns are ALL blank produced no warning anywhere: not on the browse
            card, not here. Kyle added DG001 on 2026-08-17, saw three clean dashes, and found out
            at finalize. "N — · D — · VD —" is only obvious once you already know it matters.
          */}
          {!atomic.hasPublishedLabour && (
            <p className="mt-1 rounded bg-red-50 p-2 text-xs text-red-900">
              <strong>No labour hours published for this item — at any difficulty.</strong> It will
              add, but it will carry 0 hr and finalize will refuse it until the hours are set in the
              workbook.
            </p>
          )}
        </div>

        <label className="mt-3 block text-sm font-medium">
          Location (optional)
          <input className="field mt-1 w-full" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="kitchen, garage…" />
        </label>

        <label className="mt-3 block text-sm font-medium">
          Note (optional)
          <input className="field mt-1 w-full" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        {add.isError && <p className="mt-2 text-sm text-red-700">{(add.error as Error).message}</p>}

        {/* ── SAY WHY THE BUTTON IS OFF ──────────────────────────────────────────────────
            Kyle, 2026-08-20: "The add line button here is not working." It was working — it was
            DISABLED, because no quantity had been typed, and a greyed-out button that explains
            nothing is indistinguishable from one that is broken. He reported a bug, then entered
            a quantity and added two lines successfully a minute later.

            A disabled control has to say what would enable it. */}
        {qtyProblem && (
          <p className="mt-3 rounded bg-amber-50 p-2 text-xs text-amber-900">{qtyProblem} The line cannot be added until then.</p>
        )}

        <div className="mt-4 flex gap-2">
          <button className="btn btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary flex-1"
            disabled={!qtyValid || add.isPending}
            onClick={() => add.mutate()}
          >
            {add.isPending ? "Adding…" : "Add line"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Walkthrough material list ───────────────────────────────────────────────

function WalkthroughTab(props: {
  draftId: string;
  /** The option every line added from this screen lands in. */
  option: PbOption;
  onChanged: () => void;
  /**
   * Reports how many resolved rows are still UNMATCHED or AMBIGUOUS, so the totals bar can
   * refuse to say COMPLETE while they are open (P022).
   *
   * LIMITATION, stated where it bites: this is session state. The resolver's verdicts are never
   * persisted (P019 §3 / F8), so a page reload drops the count to zero and the bar reads
   * COMPLETE again on a draft with unresolved items. Closing that needs the schema change F8
   * calls for, which is not this task.
   */
  onOpenItemsChange: (n: number) => void;
}) {
  const { draftId, onChanged, onOpenItemsChange } = props;
  const [text, setText] = useState("");
  const [rows, setRows] = useState<PbWalkthroughRow[] | null>(null);

  const [lastPath, setLastPath] = useState<"ai" | "basic" | null>(null);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [aiSummary, setAiSummary] = useState<{ proposed: number; questions: number; rejected: number } | null>(null);

  /** The primary path: the model composes the draft, proposeLines() enforces the contract. */
  const propose = useMutation({
    mutationFn: () => api.pbProposeFromWalkthrough(draftId, text),
    onSuccess: (r) => {
      setLastPath(r.path);
      setDegraded(r.degradedReason ?? null);
      if (r.path === "ai") {
        setRows(null);
        setAiSummary({
          proposed: r.proposed.length,
          questions: r.questions.length,
          rejected: r.rejected.length,
        });
        // Proposed lines and questions now exist on the draft — the review tab and the totals
        // bar both need to see them.
        onOpenItemsChange(r.questions.length);
        onChanged();
      } else {
        // Degraded: fall through to the token matcher so the tech still gets candidates.
        setAiSummary(null);
        resolve.mutate();
      }
    },
    onError: (err) => {
      setLastPath("basic");
      setDegraded((err as Error).message);
      setAiSummary(null);
      resolve.mutate();
    },
  });

  const resolve = useMutation({
    mutationFn: () =>
      api.pbResolveWalkthrough(
        text.split("\n").map((l) => l.trim()).filter(Boolean).map((raw) => ({ raw }))
      ),
    onSuccess: (r) => {
      setRows(r.rows);
      setLastPath((p) => p ?? "basic");
      onOpenItemsChange(r.rows.filter((row) => row.status !== "MATCHED").length);
    },
  });

  return (
    <div className="space-y-3">
      <div className="card p-3">
        <label className="mb-1 block text-xs font-medium text-rce-soft">
          Material list from the walkthrough — one item per line
        </label>
        <textarea
          className="field h-40 w-full font-mono text-sm"
          placeholder={"4 20A receptacle\n50 ft 1-1/4 EMT\n2 4-square box\nthat weird outdoor plug by the pool"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            className="btn btn-primary"
            disabled={!text.trim() || propose.isPending || resolve.isPending}
            onClick={() => propose.mutate()}
          >
            {propose.isPending ? "Building the draft…" : "Build the draft (AI)"}
          </button>
          <button
            className="btn btn-secondary"
            disabled={!text.trim() || propose.isPending || resolve.isPending}
            onClick={() => resolve.mutate()}
          >
            {resolve.isPending ? "Matching…" : "Basic match only"}
          </button>
        </div>

        {/*
          WHICH BRAIN PRODUCED THIS (P023 / Scope — do 2).

          P019 found Kyle had been using the token matcher believing it was the intelligent one.
          A silent fallback would recreate exactly that, so the path is always named — and when
          the AI path degraded, the reason is shown rather than swallowed.
        */}
        {lastPath && (
          <div className="mt-2 text-xs">
            {lastPath === "ai" ? (
              <span className="rounded bg-emerald-50 px-2 py-1 text-emerald-800">
                AI proposal — lines are proposed for your review, nothing is priced or confirmed
              </span>
            ) : (
              <span className="rounded bg-amber-50 px-2 py-1 text-amber-900">
                Basic match{degraded ? ` — AI unavailable: ${degraded}` : ""}
              </span>
            )}
          </div>
        )}

        <p className="mt-2 text-xs text-rce-muted">
          Nothing is added automatically. Every row comes back with the matches from your book —
          tap <strong>Add to quote</strong> on the one you meant. Quantities are set on the Review
          tab.
        </p>
      </div>

      {aiSummary && (
        <div className="card p-3 text-sm">
          <p className="font-medium">
            {aiSummary.proposed} line(s) proposed · {aiSummary.questions} question(s)
            {aiSummary.rejected > 0 ? ` · ${aiSummary.rejected} refused` : ""}
          </p>
          <p className="mt-1 text-xs text-rce-muted">
            Open the Review tab to accept, edit or drop each one. Nothing counts until you confirm it.
          </p>
        </div>
      )}

      {rows?.map((row, i) => (
        <WalkthroughRow
          key={`${row.raw}-${i}`}
          row={row}
          draftId={draftId}
          option={props.option}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

/**
 * One line from the walkthrough, and the candidates it matched. (P031)
 *
 * Kyle, 2026-08-18, looking at a row that had matched his catalog and then offered him nothing
 * but a question box:
 *
 *   *"You built this wrong. It shows a potential match then logs as a question. This makes no
 *    sense. Instead of logging as a question it needs to be add to quote."*
 *
 * He was right, and the shape of the mistake matters: the screen displayed a correct match and
 * then made the only available ACTION the one that throws it away. So:
 *
 *   * every candidate is an **Add to quote** button — one tap puts the line on the draft;
 *   * the "log as a question" path is **gone from this screen entirely**;
 *   * lines land at **quantity 1**, because quantity is Review's job now ("The quantity will be
 *     handled during the review step"). Adding is about WHICH item; Review is about HOW MANY.
 */
function WalkthroughRow(props: {
  row: PbWalkthroughRow;
  draftId: string;
  option: PbOption;
  onChanged: () => void;
}) {
  const { row, draftId, option, onChanged } = props;
  const [added, setAdded] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const addLine = useMutation({
    mutationFn: (c: PbWalkthroughRow["candidates"][number]) =>
      api.pbAddLine(draftId, {
        itemId: c.itemId,
        // Quantity 1 on purpose — Kyle adjusts it in Review, where he can see the price move.
        quantity: 1,
        difficulty: "NORMAL",
        option,
        note: `From walkthrough: "${row.raw}"`,
      }),
    onSuccess: (_d, c) => {
      setAdded((prev) => [...prev, c.itemId]);
      setError(null);
      onChanged();
    },
    onError: (err) => setError((err as Error).message),
  });

  return (
    <div className="card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-sm">{row.raw}</div>
          <div className="text-xs text-rce-soft">
            matched on “{row.searchTerm}”
            {row.parsedQuantity !== null && row.parsedQuantity !== undefined
              ? ` · you wrote ${row.parsedQuantity} — set the quantity in Review`
              : ""}
          </div>
        </div>
        <span
          className={
            row.status === "MATCHED"
              ? "rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-900"
              : row.status === "AMBIGUOUS"
              ? "rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-900"
              : "rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-900"
          }
        >
          {row.status}
        </span>
      </div>

      {error && <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-900">{error}</p>}

      <div className="mt-2 space-y-1">
        {row.candidates.map((c) => {
          const isAdded = added.includes(c.itemId);
          return (
            <button
              key={c.itemId}
              className={isAdded ? "btn btn-secondary w-full justify-start text-left opacity-60" : "btn btn-primary w-full justify-start text-left"}
              disabled={isAdded || addLine.isPending}
              onClick={() => addLine.mutate(c)}
            >
              {/* Kyle's own item name is the label — his catalog, his words. */}
              <span className="truncate">{c.description ?? c.itemId}</span>
              <span className="ml-2 shrink-0 text-xs">{isAdded ? "✓ added" : "+ Add to quote"}</span>
            </button>
          );
        })}

        {row.candidates.length === 0 && (
          <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">
            {row.unknownWords && row.unknownWords.length > 0 ? (
              <>
                Nothing matched —{" "}
                <strong>{row.unknownWords.map((w) => `“${w}”`).join(", ")}</strong>{" "}
                {row.unknownWords.length === 1 ? "is not" : "are not"} in your price book. Add the
                item to your book, or search the <strong>Browse &amp; search</strong> tab for what
                you do carry.
              </>
            ) : (
              <>
                Nothing in the price book matched this. Search for it on the{" "}
                <strong>Browse &amp; search</strong> tab and add it from there.
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Review: confirm / edit / reject ─────────────────────────────────────────

/** Kyle's names for the options, as the API returns them (2026-08-20). */
type PbOptionMeta = { option: PbOption; label: string | null; note: string | null };

function ReviewTab(props: {
  draftId: string;
  /** The spine (P029). Null until the draft is attached to an account + address. */
  accountId: string | null;
  serviceAddressId: string | null;
  onAttached: (accountId: string, serviceAddressId: string) => void;
  review: { optionSet: DraftOptionSet; proposedLines: PbLine[]; confirmedLines: PbLine[]; openQuestions: Array<{ id: string; question: string; raisedBy: string }>; counts: { proposed: number; confirmed: number; openQuestions: number } } | undefined;
  computed: PbComputed | undefined;
  options: PbOptionSummary[] | undefined;
  /**
   * Named options, from the parent's query.
   *
   * A PROP rather than its own query in here: the review screen already re-renders on every line
   * change, and a second component owning the same query key would refetch the names on each one.
   */
  optionMeta: PbOptionMeta[] | undefined;
  onChanged: () => void;
  /** A change-order draft (2026-09-20): the deposit defaults off and "add to current job" is offered. */
  isChangeOrder?: boolean;
  /** The consultation this draft was created from, when it has one — the job its photos default to. */
  draftVisitId: string | null;
  /** The draft's own account, for the photo panel when the URL carries no `?account=`. */
  draftCustomerId: string | null;
}) {
  const { draftId, review, computed, options, optionMeta, onChanged, accountId, serviceAddressId, onAttached } = props;
  // finalizeMsg went with the Check / Finalize buttons — nothing sets it now, and a
  // message box that can never fill is a place for a future reader to look for state
  // that does not exist.


  // The `finalize` mutation was removed with the Check / Finalize buttons (2026-08-19).
  // The readiness check it called still exists on the server and still refuses an estimate
  // with gaps — it now runs at the moment of issuing, where the refusal is about something
  // the operator is actually trying to do rather than a button they were guessing at.

  // Cache-shared with IssueAndSendPanel — no second fetch on line edits.
  const { data: issuedList } = useQuery({
    queryKey: ["pb-issued", draftId],
    queryFn: () => api.pbIssuedList(draftId),
  });
  const liveIssued = (issuedList?.estimates ?? []).find((e) => !e.supersededBy);
  // Whether the draft's lines are shut comes from the server's own rule (optionSet.lockedReason).
  // The default truck's on-hand beside each material line (Kyle, 2026-09-09,
  // Build 4): "on truck: 190 ft" and a shortfall hint. One read for every
  // confirmed line that carries material; read-only, nothing here moves stock.
  const materialItemIds = useMemo(() => {
    const ids = (review?.confirmedLines ?? [])
      .filter((l) => {
        const c = computed?.lines.find((x) => x.id === l.id);
        return (c?.materialCost ?? 0) > 0 || (c?.materialSell ?? 0) > 0;
      })
      .map((l) => l.itemId);
    return [...new Set(ids)].sort();
  }, [review?.confirmedLines, computed]);
  // Its own key: the close-out step reads the same endpoint for a named truck,
  // and the collision test wants one fetch expression per key.
  const { data: truckOnHand } = useQuery({
    queryKey: ["draft-truck-on-hand", { itemIds: materialItemIds.join(",") }],
    queryFn: () => api.inventoryOnHand(materialItemIds),
    enabled: materialItemIds.length > 0,
  });

  if (!review) return <p className="text-sm text-rce-muted">Loading…</p>;

  return (
    <div className="space-y-3">
      {/* Kyle, 2026-08-29: he edited an option name here and found "no way to
          save changes made to the estimate." The banner says where the save
          lives, right where the editing happens. */}
      {liveIssued && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          Estimate <strong>{liveIssued.number}</strong> was issued from this draft. Edits here don't
          change it until you press <strong>"Save changes to the estimate"</strong> in the Estimate
          &amp; Send section below.
        </p>
      )}
      {review.proposedLines.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">
            AI proposals — {review.counts.proposed} waiting on you
          </h3>
          {review.proposedLines.map((l) => (
            <ProposedLineRow key={l.id} line={l} isChangeOrder={Boolean(props.isChangeOrder)} onChanged={onChanged} />
          ))}
        </div>
      )}

      {review.openQuestions.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Open questions — {review.counts.openQuestions}</h3>
          {review.openQuestions.map((q) => (
            <QuestionRow key={q.id} question={q} onChanged={onChanged} />
          ))}
        </div>
      )}

      {/* ── THREE SECTIONS, NOT ONE LIST (Kyle, 2026-08-19) ────────────────────────────────
          "Options are not separated. They are all added as one list instead of 3 were the totals
          get added together."

          The option column, the subtotals and the picker all shipped before this did, so the
          work was being FILED correctly and still reading as a single undifferentiated list —
          which is the only part he could see. Each option is now its own section with its own
          lines and its own subtotal.

          An option with no lines still shows, so it is obvious there is somewhere else to put
          work; it just says so rather than pretending to be a heading over nothing. */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold">Confirmed lines — {review.counts.confirmed}</h3>
        {review.confirmedLines.length === 0 && <p className="text-sm text-rce-muted">Nothing confirmed yet.</p>}

        <ConfirmedLinesBoard
          draftId={draftId}
          optionSet={review.optionSet}
          confirmedLines={review.confirmedLines}
          computed={computed}
          options={options}
          optionMeta={optionMeta}
          isChangeOrder={Boolean(props.isChangeOrder)}
          onChanged={onChanged}
          truckOnHand={truckOnHand}
          lockedReason={review.optionSet.lockedReason ? `Lines can't be moved or reordered. ${review.optionSet.lockedReason}` : null}
        />

        {/* A fixed job cost, when there is one, sits outside every option because it is charged
            once for the visit — so the sections above would not add up to this.

            There is no longer an automatic one. Kyle, 2026-08-19: "The $200 should not be
            automatic. We can get rid of that and I will apply a trip charge when necessary." So
            it is named only when it is non-zero; a permanent "+ fixed $0.00" would be noise
            describing a charge that no longer exists. */}
        {computed && (
          <div className="flex items-baseline justify-between rounded-lg bg-rce-bg px-3 py-2 text-sm">
            <span className="text-rce-soft">
              Options combined
              {(computed.jobFixedCost ?? 0) > 0 ? ` + fixed ${money(computed.jobFixedCost)}` : ""}
            </span>
            <span className="text-base font-semibold">{money(computed.total)}</span>
          </div>
        )}
      </div>

      <div className="card p-3">
        {/*
          ABOVE the buttons, and scrolled to on arrival (P022 / P019 §5).

          The engine's refusal messages were always correct and always rendered — underneath the
          buttons, at the bottom of a long single-column page. On 2026-08-16 Kyle pressed Finalize
          five times in fifty seconds, got five 409s each carrying two precise reasons, and filed
          "I click finalize for the customer and nothing happens". A refusal the operator cannot
          see is a refusal that did not happen.

          Messages are rendered VERBATIM. P019 confirmed the wording is good, and the wording is
          the part that tells the tech what to do.
        */}
        {/* Check (internal) and Finalize for customer were here until 2026-08-19. Kyle:
            "I have no idea what these buttons do but they are unnecessary. Nothing should freeze
            the prices, once the estimate is emailed or signed... at that time only will that
            estimate get recorded and froze."

            Freezing is now a CONSEQUENCE of sending or signing rather than a button of its own,
            so there is nothing to press here. The engine's readiness check still runs — it runs
            at the moment of sending, where a refusal is about something the operator is actually
            trying to do. */}

      </div>

      {!(accountId && serviceAddressId) && (
        <AttachDraftPanel draftId={draftId} onAttached={onAttached} />
      )}

      <IssueAndSendPanel draftId={draftId} accountId={accountId} serviceAddressId={serviceAddressId} isChangeOrder={Boolean(props.isChangeOrder)} />

      <EstimatePhotos accountId={accountId ?? props.draftCustomerId} defaultVisitId={props.draftVisitId} />
    </div>
  );
}

/**
 * THE CONFIRMED LINES, ONE SECTION PER OPTION — AND THEY DRAG (Kyle, 2026-10-08).
 *
 * "I would like to be able to drag and drop line items on the review screen ... If I add all the line
 *  items and then go to review and see that I made a mistake and added some to option 'B' that were
 *  supposed to be on option 'C' then I can drag and drop them where they need to be rather than
 *  delete and rebuild the line items that were incorrect. This will save time and also allow me to
 *  organize the line items so the presentation can be set up to explain the install start to finish."
 *
 * Two jobs with one gesture: move a line to another option, and put the lines of an option in install
 * order. The order IS what the customer sees — presentation, issued estimate and PDF all read lines by
 * sortOrder and none re-sorts — so a drop is saved through `PUT /price-book/drafts/:id/line-order`,
 * which takes the FULL ordered list and replaces the whole order or nothing.
 *
 *   - Handle: "⋮⋮" at the left of every CONFIRMED line ("Drag to reorder or move to another option").
 *     AI-proposed lines are a separate list above and are not draggable — they are confirmed first.
 *   - Every option section accepts a drop, an EMPTY one included, so a new Option D can be filled by
 *     dragging. The section lights up while a line is over it, and the line's old place shows as a
 *     dashed marker where it will land.
 *   - Mouse, finger (the handle takes the touch, so scrolling the list does not start a drag) and
 *     keyboard: Tab to a handle, Space to pick the line up, arrows to move it, Space to drop.
 *   - The screen updates the moment the line is dropped. If the save fails the lines go back where
 *     they were and the server's reason is shown here — nothing is left looking saved when it is not.
 *     When it succeeds the review and the computed totals are refetched, so each option's subtotal
 *     follows the line. The screen does no money arithmetic of its own.
 *   - A signed estimate shuts its lines (the server refuses). The handles grey and the reason is
 *     printed above the sections — "raise a change order" — rather than the handles disappearing.
 *   - The Edit → "Option" buttons on each row stay: they are the one-click way to move a line.
 */
function ConfirmedLinesBoard(props: {
  draftId: string;
  optionSet: DraftOptionSet;
  confirmedLines: PbLine[];
  computed: PbComputed | undefined;
  options: PbOptionSummary[] | undefined;
  optionMeta: PbOptionMeta[] | undefined;
  isChangeOrder: boolean;
  onChanged: () => void;
  truckOnHand: Record<string, OnHand> | undefined;
  /** Why lines cannot be moved right now (a signed estimate), or null when they can. */
  lockedReason: string | null;
}) {
  const { draftId, optionSet, confirmedLines, computed, options, optionMeta, isChangeOrder, onChanged, truckOnHand, lockedReason } = props;
  const queryClient = useQueryClient();
  const letters = useMemo(() => optionSet.options.map((o) => o.option), [optionSet]);

  const computedById = useMemo(() => {
    const m = new Map<string, PbComputedLine>();
    for (const c of computed?.lines ?? []) if (c.id) m.set(c.id, c);
    return m;
  }, [computed]);
  const lineById = useMemo(() => new Map(confirmedLines.map((l) => [l.id, l])), [confirmedLines]);

  // What the server says: each confirmed line under the option IT IS IN (the review payload's own
  // `option`, not the compute result's), in saved order. Reading the option from the compute result
  // meant a drag made before that query arrived, or after it failed, filed every line under
  // Option A and saved it (2026-10-08 review). The compute result still supplies the PRICES.
  const serverCols = useMemo(
    () => buildColumns(letters, confirmedLines, (id) => lineById.get(id)?.option),
    [letters, confirmedLines, lineById],
  );

  // The layout while a line is being dragged, and from the drop until the save has come back and
  // the review has been refetched. Null the rest of the time (the server's layout is shown).
  const [local, setLocalState] = useState<LineColumns | null>(null);
  const localRef = useRef<LineColumns | null>(null);
  const setLocal = (next: LineColumns | null) => {
    localRef.current = next;
    setLocalState(next);
  };
  const shown = local ?? serverCols;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const locked = Boolean(lockedReason);
  const dragDisabled = locked || saving;

  const sensors = useSensors(
    // A few pixels before a drag starts, so a click on the handle is not a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const save = async (next: LineColumns) => {
    setSaving(true);
    setErr(null);
    try {
      // `was`: the option each line had on the layout this drag started from, so a save from a
      // screen the other app has since overtaken is refused (409) instead of undoing its move.
      await api.pbSaveLineOrder(draftId, flattenOrder(next, letters, serverCols));
      // Hold the dropped layout on screen until BOTH refetches are in, so the lines do not flick
      // back (or into Option A) between the review arriving and the compute arriving.
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["pb-review", draftId] }),
        queryClient.refetchQueries({ queryKey: ["pb-compute", draftId] }),
      ]);
      setLocal(null);
    } catch (e) {
      setLocal(null);
      setErr((e as Error).message);
      // A refusal because someone else changed the estimate: show the real layout, not the stale one.
      void queryClient.invalidateQueries({ queryKey: ["pb-review", draftId] });
      void queryClient.invalidateQueries({ queryKey: ["pb-compute", draftId] });
    } finally {
      setSaving(false);
    }
  };

  const onDragStart = (e: DragStartEvent) => {
    setErr(null);
    setLocal(localRef.current ?? serverCols);
    setActiveId(String(e.active.id));
  };

  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;
    const cur = localRef.current ?? serverCols;
    const translated = active.rect.current.translated;
    const below = Boolean(translated && translated.top > over.rect.top + over.rect.height / 2);
    const next = moveToColumn(cur, String(active.id), String(over.id), below);
    if (next !== cur) setLocal(next);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    setActiveId(null);
    // Dropped on nothing: put it back.
    if (!over) {
      setLocal(null);
      return;
    }
    const next = reorderWithin(localRef.current ?? serverCols, String(active.id), String(over.id));
    if (sameColumns(next, serverCols, letters)) {
      setLocal(null); // dropped where it started
      return;
    }
    setLocal(next);
    void save(next);
  };

  const onDragCancel = () => {
    setActiveId(null);
    setLocal(null);
  };

  const dragging = activeId ? lineById.get(activeId) : undefined;
  const overColumn = activeId ? findColumn(shown, activeId) : null;

  return (
    <div className="space-y-4">
      {confirmedLines.length > 0 && !locked && (
        <p className="text-xs text-rce-soft">
          Drag a line by its <span aria-hidden="true">⋮⋮</span> handle to put it in order, or into another option.
        </p>
      )}
      {lockedReason && confirmedLines.length > 0 && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{lockedReason}</p>
      )}
      {err && <p className="rounded bg-red-50 p-2 text-xs text-red-900">{err} The lines are back where they were.</p>}
      {saving && <p className="text-xs text-rce-soft">Saving the new order…</p>}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        {optionSet.options.map((entry) => {
          const opt = entry.option;
          const ids = (shown[opt] ?? []).filter((id) => lineById.has(id));
          const summary = options?.find((o) => o.option === opt);
          // Nothing confirmed anywhere: A, B and C stay out of the way (as they always have). An
          // ADDED option still shows, so it can be named and dropped into.
          if (ids.length === 0 && confirmedLines.length === 0 && !entry.removable) return null;

          return (
            <OptionSection
              key={opt}
              option={opt}
              highlighted={overColumn === opt}
              header={
                <>
                  <OptionNaming
                    draftId={draftId}
                    option={opt}
                    meta={optionMeta?.find((m) => m.option === opt) ?? null}
                  />
                  <div className="text-right">
                    <div className="text-sm font-semibold">{money(summary?.subtotal)}</div>
                    <div className="text-[11px] text-rce-soft">{ids.length} line(s)</div>
                  </div>
                </>
              }
            >
              <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={dragDisabled}>
                {ids.length === 0 ? (
                  <p className="text-xs text-rce-muted">
                    Nothing in this option yet. Pick "Option {opt}" above to add into it, or drag a line here.
                  </p>
                ) : (
                  ids.map((id) => {
                    const line = lineById.get(id) as PbLine;
                    return (
                      <SortableLine key={id} id={id} locked={dragDisabled} lockedReason={lockedReason ?? "Saving the new order…"}>
                        <ConfirmedLineRow
                          isChangeOrder={isChangeOrder}
                          line={line}
                          computed={computedById.get(id)}
                          onChanged={onChanged}
                          onHand={truckOnHand?.[line.itemId]}
                          optionLetters={letters}
                          lockedReason={optionSet.lockedReason ?? null}
                        />
                      </SortableLine>
                    );
                  })
                )}
              </SortableContext>
            </OptionSection>
          );
        })}
        <DragOverlay>
          {dragging ? (
            <div className="card flex items-center gap-2 p-3 shadow-lg">
              <span aria-hidden="true" className="text-rce-soft">⋮⋮</span>
              <div className="min-w-0">
                <div className="font-semibold">
                  {dragging.itemId} <span className="text-rce-soft">× {dragging.quantity}{dragging.unit ? ` ${dragging.unit}` : ""}</span>
                </div>
                <div className="text-xs text-rce-muted line-clamp-1">{dragging.description}</div>
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

/** One option's section. The body is a drop target on its own, so an EMPTY option can take a line. */
function OptionSection(props: { option: PbOption; highlighted: boolean; header: ReactNode; children: ReactNode }) {
  const { setNodeRef } = useDroppable({ id: props.option });
  return (
    <section
      aria-label={`Option ${props.option} lines`}
      className={`rounded-lg border ${props.highlighted ? "border-rce-accent ring-2 ring-rce-accent" : "border-rce-border"}`}
    >
      <header className="flex items-baseline justify-between gap-2 border-b border-rce-border bg-rce-bg px-3 py-2">
        {props.header}
      </header>
      <div ref={setNodeRef} className="min-h-[3rem] space-y-2 p-2">
        {props.children}
      </div>
    </section>
  );
}

/** A confirmed line with its drag handle. The handle greys, with the reason in its tooltip, when dragging is off. */
function SortableLine(props: { id: string; locked: boolean; lockedReason: string; children: ReactNode }) {
  const { id, locked, lockedReason, children } = props;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: locked,
  });
  const title = locked ? lockedReason : "Drag to reorder or move to another option";
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      // The line's old place stays as a dashed marker while its copy travels with the pointer.
      className={`flex items-stretch gap-1 rounded-lg ${isDragging ? "opacity-40 outline-2 outline-dashed outline-rce-accent" : ""}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...(locked ? {} : listeners)}
        aria-label={title}
        title={title}
        className={`flex w-7 shrink-0 touch-none select-none items-center justify-center rounded text-base leading-none ${
          locked ? "cursor-not-allowed text-rce-border" : "cursor-grab text-rce-soft hover:bg-rce-bg active:cursor-grabbing"
        }`}
      >
        <span aria-hidden="true">⋮⋮</span>
      </button>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * A line the tech has committed — now editable and removable (Kyle, 2026-08-17: "I also have no
 * way to edit or delete an entry already submitted").
 *
 * Both actions refuse server-side on a finalized draft, and the refusal is surfaced verbatim
 * rather than swallowed: a button that silently does nothing is the defect this whole screen has
 * been paying for.
 */
function ConfirmedLineRow(props: { line: PbLine; computed: PbComputedLine | undefined; isChangeOrder: boolean; onChanged: () => void; onHand?: OnHand; optionLetters: PbOption[]; lockedReason?: string | null }) {
  const { line: l, computed: c, isChangeOrder, onChanged, onHand, optionLetters, lockedReason = null } = props;
  // On-hand on the default truck beside a material line (Kyle, 2026-09-09, Build 4).
  // Read-only: "on truck: 190 ft", and "short 60 ft" when the line needs more than
  // the truck holds. Only lines that carry material. Not a PO prompt — Kyle,
  // 2026-09-16: a per-line "add to a PO" here risked creating single-item POs
  // instead of one complete material order; a P.O. is built from the job's whole
  // shortage list instead (jobMaterials.ts, "shortages").
  const carriesMaterial = (c?.materialCost ?? 0) > 0 || (c?.materialSell ?? 0) > 0;
  const shortBy = onHand ? Math.round((l.quantity - onHand.qty) * 10000) / 10000 : 0;
  const [editing, setEditing] = useState(false);
  const [qty, setQty] = useState(String(l.quantity));
  const [difficulty, setDifficulty] = useState<PbDifficulty>(l.difficulty);
  const [option, setOption] = useState<PbOption>(c?.option ?? "A");
  const [location, setLocation] = useState(l.location ?? "");
  const [note, setNote] = useState(l.note ?? "");
  // The name the customer reads for this line (Kyle, 2026-10-27: "I want to be able to edit the
  // name of the line item so I can customize the line item name to the specific job."). The box
  // opens on what the line is called now - the price-book name until it is reworded. Typing the
  // price-book name back, or emptying the box, is "no custom name": the server stores null.
  const catalogName = l.description ?? "";
  const [name, setName] = useState(l.customName ?? catalogName);
  const [err, setErr] = useState<string | null>(null);

  const hourly = (l.unit ?? "").trim().toLowerCase() === "hr";
  const qtyProblem = quantityProblem(qty, isChangeOrder, hourly ? "the hours" : "a quantity");
  const typedName = name.trim();
  const wantedName = typedName === "" || typedName === catalogName ? null : typedName;

  const save = useMutation({
    mutationFn: () =>
      api.pbEditLine(l.id, {
        quantity: Number(qty),
        difficulty,
        // A line put in the wrong option is fixed here rather than by deleting and re-adding it.
        option,
        location: location.trim() || null,
        note: note.trim() || null,
        // Sent only when the name actually changed, so saving a quantity never rewrites the name.
        ...(wantedName !== (l.customName ?? null) ? { customName: wantedName } : {}),
      }),
    onSuccess: () => {
      setEditing(false);
      setErr(null);
      onChanged();
    },
    onError: (e) => setErr((e as Error).message),
  });

  // "Use the price-book name": the exit from a custom name. Acts at once - it is its own save, so
  // it works whatever else in the form is half-typed - and never touches the other fields.
  const clearName = useMutation({
    mutationFn: () => api.pbEditLine(l.id, { customName: null }),
    onSuccess: () => {
      setName(catalogName);
      setErr(null);
      onChanged();
    },
    onError: (e) => setErr((e as Error).message),
  });

  const remove = useMutation({
    mutationFn: () => api.pbDeleteLine(l.id),
    onSuccess: onChanged,
    onError: (e) => setErr((e as Error).message),
  });

  return (
    <div className="card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold">
            {l.itemId}{" "}
            <span className="text-rce-soft">
              × {l.quantity}
              {l.unit ? ` ${l.unit}` : ""}
            </span>
          </div>
          {/* Where the line shows a name, it shows the custom one when there is one (Kyle,
              2026-10-27) - with the price-book item beside it so the office still knows what to
              order. */}
          <div className="text-xs text-rce-muted line-clamp-2">{l.customName || l.description}</div>
          {l.customName && l.description && (
            <div className="text-xs text-rce-soft">price book: {l.description}</div>
          )}
          <div className="text-xs text-rce-soft">
            {/* Quantity is just a number (Kyle, 2026-10-08) — how it was counted is no longer shown
                or asked. An hourly line says so, because its number is hours, not a count. */}
            Option {c?.option ?? "A"} · {hourly ? "by the hour · " : ""}{l.difficulty}
            {l.proposedBy ? ` · from ${l.proposedBy}` : " · entered by hand"}
            {l.editedBeforeConfirm ? " · edited before confirm" : ""}
          </div>
          {l.location && <div className="text-xs text-rce-soft">{l.location}</div>}
          {l.note && <div className="text-xs text-rce-soft italic">{l.note}</div>}
          {carriesMaterial && onHand && (
            <div className="text-xs">
              <span className="text-rce-soft">on truck: {onHand.qty} {onHand.unit ?? l.unit ?? ""}</span>
              {shortBy > 0 && <span className="ml-1 text-amber-800">· short {shortBy} {onHand.unit ?? l.unit ?? ""}</span>}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right text-xs">
          <div>{hours(c?.laborHours)} hr</div>
          {/* The LINE total, not labour alone (Kyle, 2026-08-22: "no price calculated at all" —
              on a $200 material-only permit line that showed $0.00 because only labour printed). */}
          <div className="font-semibold">
            {money(c ? (c.laborDollars ?? 0) + (c.materialSell ?? 0) : null)}
          </div>
        </div>
      </div>

      {c?.gaps.map((g, i) => (
        <p key={i} className="mt-1 rounded bg-amber-50 p-1.5 text-[11px] text-amber-900">
          {g.message}
        </p>
      ))}

      {editing && (
        <div className="mt-2 space-y-2 rounded-lg border border-rce-border p-2">
          <label className="block text-xs">
            {hourly ? "Hours" : "Quantity"}
            <input
              className="field mt-1 w-24"
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </label>
          {qtyProblem && <p className="text-xs text-amber-900">{qtyProblem}</p>}
          {/* Move a line to another option. Without this, putting one in the wrong option
              could only be undone by deleting it and adding it again. */}
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs text-rce-soft">Option</span>
            {optionLetters.map((o) => (
              <button
                key={o}
                className={option === o ? "btn btn-primary" : "btn btn-secondary"}
                onClick={() => setOption(o)}
              >
                {o}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            {DIFFICULTIES.map((d) => (
              <button
                key={d.value}
                className={difficulty === d.value ? "btn btn-primary" : "btn btn-secondary"}
                onClick={() => setDifficulty(d.value)}
              >
                {d.label}
              </button>
            ))}
          </div>
          {/* The customer reads this name on the estimate, the invoice and the PDF - without the
              quantity (Kyle, 2026-10-27). A signed estimate is changed by a change order, so the
              box is greyed with the server's own reason. */}
          <label className="block text-xs">
            Name on the estimate
            <input
              className="field mt-1 w-full"
              value={name}
              maxLength={200}
              disabled={Boolean(lockedReason)}
              title={lockedReason ?? undefined}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={Boolean(lockedReason) || !l.customName || clearName.isPending}
              title={lockedReason ?? (l.customName ? undefined : "This line already uses the price-book name.")}
              onClick={() => clearName.mutate()}
            >
              {clearName.isPending ? "Putting it back…" : "Use the price-book name"}
            </button>
            {lockedReason && <span className="text-xs text-amber-800">{lockedReason}</span>}
          </div>
          <label className="block text-xs">
            Location
            <input className="field mt-1 w-full" value={location} onChange={(e) => setLocation(e.target.value)} />
          </label>
          <label className="block text-xs">
            Note
            <input className="field mt-1 w-full" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
      )}

      {err && <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-900">{err}</p>}

      <div className="mt-2 flex gap-2">
        {editing ? (
          <>
            <button
              className="btn btn-primary flex-1"
              disabled={qtyProblem !== null || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setEditing(false);
                setErr(null);
                setQty(String(l.quantity));
                setDifficulty(l.difficulty);
                setLocation(l.location ?? "");
                setNote(l.note ?? "");
                setName(l.customName ?? catalogName);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              className="btn btn-secondary"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Remove ${l.itemId} from this estimate?`)) remove.mutate();
              }}
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ProposedLineRow(props: { line: PbLine; isChangeOrder: boolean; onChanged: () => void }) {
  const { line, isChangeOrder, onChanged } = props;
  const [qty, setQty] = useState(String(line.quantity));
  // The model can never PROPOSE a negative, but the person confirming a change order's line may
  // edit it into a credit — the same rule as every other quantity box on this screen.
  const qtyProblem = quantityProblem(qty, isChangeOrder);
  const [difficulty, setDifficulty] = useState<PbDifficulty>(line.difficulty);

  const confirm = useMutation({
    mutationFn: () => {
      const edits: { quantity?: number; difficulty?: PbDifficulty } = {};
      if (Number(qty) !== line.quantity) edits.quantity = Number(qty);
      if (difficulty !== line.difficulty) edits.difficulty = difficulty;
      return api.pbConfirmLine(line.id, edits);
    },
    onSuccess: onChanged,
  });
  const reject = useMutation({ mutationFn: () => api.pbRejectLine(line.id), onSuccess: onChanged });

  return (
    <div className="card border-l-4 border-sky-400 p-3">
      <div className="font-semibold">
        {line.itemId} <span className="text-xs font-normal text-rce-soft">proposed by {line.proposedBy}</span>
      </div>
      <div className="text-xs text-rce-muted line-clamp-2">{line.description}</div>
      {/* The model's reasoning sits next to the decision. Confirming without seeing why it was
          suggested is rubber-stamping, which is the failure this screen exists to avoid. */}
      {line.reasoning && <p className="mt-1 rounded bg-sky-50 p-2 text-xs text-sky-900">“{line.reasoning}”</p>}

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-xs">
          Qty
          <input className="field mt-1 w-20" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        {qtyProblem && <p className="basis-full text-xs text-amber-900">{qtyProblem}</p>}
        <div className="flex gap-1">
          {DIFFICULTIES.map((d) => (
            <button
              key={d.value}
              className={difficulty === d.value ? "btn btn-primary" : "btn btn-secondary"}
              onClick={() => setDifficulty(d.value)}
            >
              {d.label[0]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2 flex gap-2">
        <button className="btn btn-primary flex-1" disabled={qtyProblem !== null || confirm.isPending} onClick={() => confirm.mutate()}>
          {Number(qty) !== line.quantity || difficulty !== line.difficulty ? "Edit & confirm" : "Confirm"}
        </button>
        <button className="btn btn-secondary" disabled={reject.isPending} onClick={() => reject.mutate()}>
          Reject
        </button>
      </div>
    </div>
  );
}

function QuestionRow(props: { question: { id: string; question: string; raisedBy: string }; onChanged: () => void }) {
  const { question, onChanged } = props;
  const [note, setNote] = useState("");
  const resolve = useMutation({
    mutationFn: () => api.pbResolveQuestion(question.id, note.trim()),
    onSuccess: onChanged,
  });
  return (
    <div className="card border-l-4 border-amber-400 p-3">
      <p className="text-sm">{question.question}</p>
      <p className="text-xs text-rce-soft">raised by {question.raisedBy}</p>
      <div className="mt-2 flex gap-2">
        <input className="field flex-1" placeholder="Answer / what you did" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn btn-secondary" disabled={!note.trim() || resolve.isPending} onClick={() => resolve.mutate()}>
          Resolve
        </button>
      </div>
    </div>
  );
}


/**
 * One line naming what a draft belongs to, or null when it belongs to nothing.
 * Names, never ids — this is read by a person deciding whether they are in the right draft.
 */
/**
 * "Title & scope" and "Delete this draft" — ONE service each, shared with the field Quote screen
 * (2026-10-08, one-estimating-system plan, Phase 2 unit B).
 *
 * TITLE AND SCOPE. The audit found no route could rename a draft or edit its scope of work after
 * creation, and the issue panel never sent either — so the customer read whatever the draft was
 * born with ("customer — address" from the field). The draft's values ARE the estimate's: a first
 * issue reads them, and "Save changes to the estimate" re-reads them into the revision, exactly
 * like the discount (Kyle, 2026-09-29). That is why the editor stays live after issue, with the
 * same amber hint the discount block carries.
 *
 * DELETE. Standing rule — nothing the app creates is permanent, and the exit lives where the thing
 * is shown. Greyed WITH the reason once anything has been issued from the draft: the way out is
 * then on the estimate (Estimates page: delete while unsigned, void, or mark lost).
 */
function DraftDetailsCard(props: { draftId: string; review: PbReview; onChanged: () => void; onDeleted: () => void }) {
  const { draftId, review, onChanged, onDeleted } = props;
  const savedTitle = review.draft.title;
  const savedScope = review.draft.jobDescription ?? "";
  const [title, setTitle] = useState(savedTitle);
  const [scope, setScope] = useState(savedScope);
  // A draft switched under the editor (the URL changed) or saved from the other app: show what is saved.
  useEffect(() => {
    setTitle(savedTitle);
    setScope(savedScope);
  }, [review.draft.id, savedTitle, savedScope]);
  const dirty = title.trim() !== savedTitle || scope.trim() !== savedScope;
  const [said, setSaid] = useState<string | null>(null);
  const issued = review.lifecycle?.issued ?? null;
  const deleteReason = review.lifecycle?.deleteReason ?? null;

  const save = useMutation({
    mutationFn: () => api.pbSetDraftDetails(draftId, { title: title.trim(), jobDescription: scope.trim() || null }),
    onSuccess: () => {
      setSaid(issued ? `Saved on the draft. Press "Save changes to the estimate" in Review to put it on ${issued.number}.` : "Saved.");
      onChanged();
    },
    onError: (err) => setSaid((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.pbDeleteDraft(draftId),
    onSuccess: onDeleted,
    onError: (err) => setSaid((err as Error).message),
  });

  return (
    <div className="mt-3 space-y-2 border-t border-rce-border pt-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <label className="flex-1 text-xs text-rce-soft">
          Estimate title
          <input
            className="field mt-1 w-full"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What this estimate is for"
          />
        </label>
        <label className="flex-[2] text-xs text-rce-soft">
          Scope of work — what the customer reads under the title (optional)
          <textarea
            className="field mt-1 w-full"
            rows={2}
            value={scope}
            maxLength={4000}
            onChange={(e) => setScope(e.target.value)}
            placeholder="e.g. Replace the 100A panel with a 200A panel and bring the service up to code."
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-secondary text-sm"
          disabled={!dirty || !title.trim() || save.isPending}
          title={!title.trim() ? "The estimate needs a title." : !dirty ? "Nothing changed" : undefined}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save title & scope"}
        </button>
        <button
          type="button"
          className="btn btn-danger text-sm"
          disabled={deleteReason !== null || remove.isPending}
          title={deleteReason ?? "Deletes this draft and its lines. Nothing has been issued from it."}
          onClick={() => {
            if (window.confirm(`Delete the draft "${savedTitle}" and its ${review.counts.confirmed + review.counts.proposed} line(s)? This cannot be undone.`)) remove.mutate();
          }}
        >
          {remove.isPending ? "Deleting…" : "Delete this draft"}
        </button>
        {issued && (
          <span className="text-[11px] text-amber-800">
            Issued as {issued.number} — a new title or scope reaches the customer when you press "Save changes to the estimate" in Review.
          </span>
        )}
      </div>
      {deleteReason && <p className="text-[11px] text-rce-soft">{deleteReason}</p>}
      {said && <p className="rounded bg-rce-accentBg/40 p-2 text-xs text-rce-text">{said}</p>}
    </div>
  );
}

function attachmentLabel(d: PbDraft | undefined): string | null {
  if (!d) return null;
  const who = d.customer?.name ?? d.lead?.name ?? null;
  const what = d.visit?.purpose ?? d.visit?.jobType ?? null;
  if (who && what) return `${who} — ${what}`;
  if (who) return who;
  if (what) return what;
  return null;
}

// ─── Totals — displayed, never computed here ─────────────────────────────────

/**
 * The status line may not claim more than the draft has earned (P022 / P019 §3).
 *
 * The engine now refuses to call an empty draft COMPLETE, but the engine cannot see the two
 * other kinds of open work: questions raised against the draft, and walkthrough rows the matcher
 * left UNMATCHED or AMBIGUOUS. Those live on this page. So the bar takes them as props and
 * reports the strictest true statement, rather than the engine's line alone.
 */
function TotalsBar(props: {
  computed: PbComputed | undefined;
  /** The server's finished prices and financing figures (shared/quoteMoney.ts). Optional: older payloads lack it. */
  quoteMoney?: QuoteMoney;
  options?: PbOptionSummary[];
  openQuestions: number;
  openItems: number;
  draftId?: string | null;
}) {
  // One-or-the-other mode (Kyle, 2026-08-29: "it is still totaling all
  // options together") — under exclusive options a grand sum is a lie; the
  // bar shows the per-option range instead. Cache-shared with OptionsModeBar.
  const draftId = props.draftId ?? "";
  const { data: optionsMode } = useQuery({
    queryKey: ["pbOptionsMode", draftId],
    queryFn: () => api.pbOptionsMode(draftId),
    enabled: Boolean(props.draftId),
  });
  const exclusive = optionsMode?.exclusiveOptions ?? false;
  /*
    Declared BEFORE the early return below, deliberately.

    TotalsBar returns null while there is nothing computed yet, so a hook placed after that line
    would run on some renders and not others — which is React error #310, the same crash this app
    already carries on /visits/:id. Hooks first, then the bail-out.
  */
  const bar = useStickyFooterSpace();
  /*
    Collapsed by default (Kyle, 2026-08-22): "The bottom total price bar is blocking the screen
    and I can't see options that I need to pick. I need the screen to adjust to the margins so the
    white options bar and the line item picker are not competing for space."

    The bar had grown to four stacked rows — option subtotals, line counts, labour/material, caps —
    and every row it gained was a row the picker lost. Collapsed it is ONE line: count, status,
    total, and a chevron. The full breakdown is one tap away, and the spacer already resizes to
    whichever state it is in.
  */
  const [expanded, setExpanded] = useState(false);

  const c = props.computed;
  if (!c) return null;

  const open = props.openQuestions + props.openItems;
  const earnedComplete = c.totalLineCount > 0 && c.incompleteLineCount === 0 && open === 0;

  const openBits: string[] = [];
  if (props.openItems > 0) openBits.push(`${props.openItems} item(s) unresolved`);
  if (props.openQuestions > 0) openBits.push(`${props.openQuestions} question(s) open`);

  const status = earnedComplete
    ? "COMPLETE"
    : [c.completenessSummary, ...openBits].join(" · ");

  // A total assembled only from the fixed job fee, while work is still open, is a number a
  // reader will take for a quote. Say what it is instead of letting it stand alone.
  const feeOnly = c.totalLineCount === 0 && (c.total ?? 0) > 0;

  // Only options that actually carry work. An empty option has no subtotal worth showing.
  const usedOptions = (props.options ?? []).filter((o) => o.lineCount > 0);

  /*
    "or from $X/mo with financing" under the total (Phase 5 unit B, 2026-10-08) - the OFFICE's view
    of what the customer will be shown. The figures are the server's (quoteMoney.financing); this
    only picks WHICH selection to look up. Ordinary mode: everything with work in it. One-or-the-
    other: the customer picks exactly one, so the honest headline is the cheapest alternative, and
    the line says so.

    The bar's headline (c.total) is the engine total BEFORE any military / senior / custom programme
    discount, but the sheet is worked on the total AFTER it (money.selections - what the customer
    pays; review finding, 2026-10-08). So when a programme discount applies the sheet's label says
    "after $X discount" instead of letting two different totals sit side by side unexplained.
  */
  const qm = props.quoteMoney ?? null;
  let financingSelected: string[] = [];
  let financingLabel = "";
  if (qm) {
    if (picksOne(qm)) {
      const best = cheapestSelection(qm.financing, qm.pickable.map((o) => [o]));
      if (best) {
        financingSelected = best.key.split("+");
        financingLabel = `Option ${best.key} (the cheapest of the alternatives)`;
      }
    } else {
      financingSelected = [...qm.pickable];
      financingLabel = `Option${financingSelected.length > 1 ? "s" : ""} ${financingSelected.join(" + ")}`;
    }
    const discounted = selectionPrice(qm, financingSelected)?.discount ?? 0;
    if (financingLabel && discounted > 0) financingLabel += ` (after $${discounted.toFixed(2)} discount)`;
  }

  return (
    <>
    {/* Holds the page open by exactly the bar's height, whatever it is this render. */}
    <div aria-hidden style={{ height: bar.spacerHeight }} />
    {/* bottom-20 clears the mobile nav, which is its own fixed bar at bottom-0. md:bottom-0
        because that nav is md:hidden. */}
    <div
      ref={bar.ref}
      className="fixed inset-x-0 bottom-20 z-30 border-t bg-white/95 p-3 backdrop-blur md:bottom-0"
    >
      {/* Per-option subtotals (Kyle, 2026-08-19). Shown only once a second option has lines in
          it — a single row reading "Option A $x" beside a total of the same $x is noise. The trip
          charge is not in these figures; it is charged once for the visit, which is why they do
          not add up to the total below. */}
      {expanded && usedOptions.length > 1 && (
        <div className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-x-4 gap-y-1 text-xs">
          {usedOptions.map((o) => (
            <span key={o.option} className="text-rce-soft">
              <span className="font-semibold text-rce-text">Option {o.option}</span>{" "}
              {o.lineCount} line(s) · {money(o.subtotal)}
              {!o.complete && <span className="text-amber-800"> (incomplete)</span>}
            </span>
          ))}
        </div>
      )}

      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 text-sm">
        <div>
          <div className="text-xs text-rce-soft">
            {c.totalLineCount} line(s) · {hours(c.laborHours)} hr
          </div>
          <div className={earnedComplete ? "text-xs text-emerald-700" : "text-xs text-amber-800"}>
            {status}
          </div>
        </div>
        <div className="text-right">
          {expanded && (
          <>
          {/* ── "material" MEANS THE CHARGE, AND HAD TO SAY SO ─────────────────────────────
              Kyle, 2026-08-20, on seeing "labour $591.00 · material $1071.14":

                "How is this getting added up because this is most definitely wrong. Material here
                 is not this much."

              The arithmetic was right. The LABEL was not. That figure is column F — what the
              customer is charged after his own tiered markup — and he was reading it as what he
              spends. On the draft he was looking at, the two were $349 and $138: the charge is
              two and a half times the cost, exactly as his tier table says it should be.

              Both are shown now, named. A number that invites the wrong reading is a defect even
              when it is correct. */}
          <div className="text-xs text-rce-soft">
            labour {money(c.laborDollars)} · material charged {money(c.materialSell)}
            {c.materialCost > 0 ? ` (cost ${money(c.materialCost)})` : ""}
          </div>
          {/*
            ── THE JOB-LEVEL MATERIAL CHECK, SHOWN (Kyle, 2026-08-21) ──────────────────────────

            He asked for a second check on material markup keyed to the size of the job, and it
            reduces what a customer is charged. A reduction he cannot see is one he cannot explain
            when a customer asks why this job's material is priced differently to the last one — so
            it reports what the tiers wanted, the ceiling that governed, and what it cost him.

            Only rendered when it actually bit. Most jobs sit under their ceiling and this is silent
            because there is nothing to say.
          */}
          {Object.entries(c.materialCaps ?? {})
            .filter(([, cap]) => cap.applied)
            .map(([option, cap]) => (
              <div key={option} className="text-xs text-amber-800">
                Option {option}: material capped at {cap.ceiling}× ({cap.bandLabel}) —{" "}
                {money(cap.uncappedSell)} → {money(cap.cappedSell)}, {money(cap.reduction)} off
              </div>
            ))}
          </>
          )}
          <div className="flex items-center justify-end gap-2">
            {/* Exclusive mode: the customer picks ONE, so a grand sum of all
                options is the wrong number to headline (Kyle, 2026-08-29). */}
            {exclusive && usedOptions.length > 1 ? (
              <div className="text-right">
                <div className="text-lg font-semibold">
                  {money(Math.min(...usedOptions.map((o) => o.subtotal ?? 0)))}
                  {"–"}
                  {money(Math.max(...usedOptions.map((o) => o.subtotal ?? 0)))}
                </div>
                <div className="text-[10px] text-rce-soft">
                  one of: {usedOptions.map((o) => `${o.option} ${money(o.subtotal ?? 0)}`).join(" · ")}
                </div>
              </div>
            ) : (
              <div className="text-lg font-semibold">{money(c.total)}</div>
            )}
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse totals detail" : "Expand totals detail"}
              className="rounded border border-rce-border px-2 py-0.5 text-xs text-rce-soft"
            >
              {expanded ? "▾ less" : "▴ detail"}
            </button>
          </div>
          {qm && (
            <div>
              <FinancingLine
                financing={qm.financing}
                selected={financingSelected}
                label={financingLabel}
                total={selectionPrice(qm, financingSelected)?.total ?? null}
              />
            </div>
          )}
          {feeOnly && (
            <div className="text-xs text-amber-800">fixed fee only — no lines priced</div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}

/**
 * ATTACH-AND-CONTINUE (P029).
 *
 * The full move made an account and an address mandatory. Drafts created before that ruling have
 * neither, and the prompt is explicit that they are "migrated, not stranded" — so opening one
 * asks which account and which address it belongs to, writes the link, and carries on. It never
 * invents a placeholder account to satisfy the requirement.
 */
function AttachDraftPanel(props: {
  draftId: string;
  onAttached: (accountId: string, serviceAddressId: string) => void;
}) {
  const { draftId, onAttached } = props;
  const [accountId, setAccountId] = useState("");
  const [addressId, setAddressId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: accounts } = useQuery({ queryKey: ["accounts"], queryFn: api.accounts });
  const { data: account } = useQuery({
    queryKey: ["account", accountId],
    queryFn: () => api.account(accountId),
    enabled: Boolean(accountId),
  });
  const addresses = account?.properties ?? [];

  const attach = useMutation({
    mutationFn: () => api.pbAttachDraft(draftId, { accountId, serviceAddressId: addressId }),
    onSuccess: () => onAttached(accountId, addressId),
    onError: (err) => setError((err as Error).message),
  });

  return (
    <div className="card border-l-4 border-amber-400 p-3">
      <h3 className="text-sm font-semibold">Which job is this?</h3>
      <p className="mt-1 text-xs text-rce-muted">
        Estimates belong to an account, at the address being worked. This draft was started before
        that was required — pick where it belongs and carry on.
      </p>

      <select
        className="field mt-2 w-full"
        value={accountId}
        onChange={(e) => {
          setAccountId(e.target.value);
          setAddressId("");
          setError(null);
        }}
      >
        <option value="">Pick an account…</option>
        {(accounts ?? []).map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>

      {accountId && (
        <select
          className="field mt-2 w-full"
          value={addressId}
          onChange={(e) => {
            setAddressId(e.target.value);
            setError(null);
          }}
        >
          <option value="">Pick the address being worked…</option>
          {addresses.map((p) => (
            <option key={p.id} value={p.id}>{p.name} — {p.addressLine1}, {p.city}</option>
          ))}
        </select>
      )}

      {accountId && addresses.length === 0 && (
        <p className="mt-2 text-xs text-amber-900">
          That account has no addresses on file. Add one on the account page first.
        </p>
      )}

      {error && <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-900">{error}</p>}

      <button
        className="btn btn-primary mt-2 w-full"
        disabled={!accountId || !addressId || attach.isPending}
        onClick={() => attach.mutate()}
      >
        {attach.isPending ? "Attaching…" : "Attach and continue"}
      </button>
    </div>
  );
}

/**
 * Issue the estimate to the customer — the last step of the intake screen (P027).
 *
 * This is where a priced draft stops being internal. Two explicit operator actions, never
 * automatic: **Create customer estimate** freezes a snapshot, and **Send** emails it. Both
 * refuse loudly rather than doing something approximate.
 *
 * The send is behind a confirm because it is the one control on this screen that reaches a
 * customer. Nothing else in the app may call that endpoint — no cron, no trigger, no retry
 * queue — and `AUTOMATED_CUSTOMER_SENDS` is untouched by this lane.
 */
function IssueAndSendPanel(props: { draftId: string; accountId: string | null; serviceAddressId: string | null; isChangeOrder: boolean }) {
  const { draftId, accountId, serviceAddressId, isChangeOrder } = props;
  const queryClient = useQueryClient();
  const [reasons, setReasons] = useState<string[]>([]);
  // No setter: the waive-trip control was removed 2026-08-22 (no trip charge is configured).
  // The state survives so the issue call keeps its explicit false rather than an implicit one.
  const [waiveTrip] = useState(false);
  // P031: attach the generator sizing one-pager from this address's field
  // assessment. Off by default — attaching is the operator's explicit act (the
  // human approval on the field tech's proposal), and the issue call refuses
  // with a plain reason when nothing is on file.
  const [includeGenerator, setIncludeGenerator] = useState(false);
  // The deposit checkbox (Kyle, 2026-09-20: "deposit optional with a deposit required check box
  // for a manual override") — on for an estimate, OFF for a change order. And "add to current
  // job" for a change order, so signing it does not schedule a second visit.
  const [depositRequired, setDepositRequired] = useState(!isChangeOrder);
  const [addToCurrentJob, setAddToCurrentJob] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /*
    The discount programme (Kyle, 2026-08-22): "military discount at 5%, senior citizen discount
    at 5%" — "Off of the whole job but gets capped at $250." Set here because this is where the
    estimate becomes a document; one programme per estimate, tap again to clear. The AMOUNT is
    5% of whatever the customer selects, so it appears on their page and freezes at signature —
    there is no number to show here yet, only the programme.
  */
  const { data: computeData } = useQuery({
    queryKey: ["pb-compute", draftId],
    queryFn: () => api.pbCompute(draftId),
    enabled: Boolean(draftId),
  });
  const programme = computeData?.discount?.type ?? null;
  const activePercent = computeData?.discount?.percent ?? null;
  /*
    SHOW THE MONEY (Kyle, 2026-09-01: "The discounts are not showing up. I can't tell if it is
    applying them."). The amount is per selection: the whole job (every option together) and, under
    exclusive options, each option on its own. The figures are the SERVER's (one-estimating-system
    plan, Phase 3 unit A, 2026-10-08): `computeData.money.discount.rows` is built by the one pricer
    (shared/quoteMoney.ts) — options + trip - combination discount, then the percentage, then the
    programme cap — the same arithmetic the customer's page, the PDF and the field's Quote screen
    use. This panel used to redo that sum in the browser; it now only words what the server sent.
  */
  const fmtMoney = (n: number) => "$" + n.toFixed(2);
  const discountPreview = (() => {
    const d = computeData?.money?.discount ?? null;
    if (!d) return null;
    const rows = d.rows.map((r) => ({
      label: r.label,
      text: "-" + fmtMoney(r.amount) + (r.capped ? " (capped)" : "") + " -> " + fmtMoney(r.after),
    }));
    // A selection still holding an unpriced line has no row from the server: say so, never $0.
    if (d.pricedOnceComplete) rows.push({ label: "unpriced lines", text: "prices once every line is confirmed" });
    return { rows, incomplete: d.pricedOnceComplete };
  })();
  const setDiscount = useMutation({
    mutationFn: (next: { type: "military" | "senior" | "custom" | null; percent?: number | null }) =>
      api.pbSetDiscount(draftId, next.type, next.percent ?? null),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["pb-compute", draftId] }),
  });
  /*
    The custom percentage (Kyle, 2026-09-01): "I want to be able to add a custom discount here.
    This will allow me to stay competitive and I can follow through with a price match system. I
    want a simple enter a percentage and apply button next to the other discounts." Uncapped —
    a ceiling would undercut the match he just promised; bounded at 50% because more than half
    off is a typo. The box shows the applied figure when the draft already carries one.
  */
  const [customPct, setCustomPct] = useState<string>("");
  useEffect(() => {
    if (programme === "custom" && activePercent !== null) setCustomPct(String(activePercent));
  }, [programme, activePercent]);
  const customPctNumber = Number(customPct);
  const customPctValid = customPct.trim() !== "" && Number.isFinite(customPctNumber) && customPctNumber > 0 && customPctNumber <= 50;

  const { data: list } = useQuery({
    queryKey: ["pb-issued", draftId],
    queryFn: () => api.pbIssuedList(draftId),
  });
  // Newest first from the server, and a superseded revision is never the one to act on.
  const mine = (list?.estimates ?? []).filter((e) => !e.supersededBy);

  const activeId = selectedId ?? mine[0]?.id ?? null;
  const { data: detail } = useQuery({
    queryKey: ["pb-issued-detail", activeId],
    queryFn: () => api.pbIssuedDetail(activeId as string),
    enabled: Boolean(activeId),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["pb-issued", draftId] });
    void queryClient.invalidateQueries({ queryKey: ["pb-issued-detail", activeId] });
  };

  const issue = useMutation({
    mutationFn: () =>
      api.pbIssue(draftId, {
        // Non-null by the time this button renders — the panel shows the attach picker instead
        // when either is missing, so an unattached estimate cannot be issued from here.
        accountId: accountId as string,
        serviceAddressId: serviceAddressId as string,
        waiveTrip,
        includeGenerator,
        depositRequired,
        addToCurrentJob: isChangeOrder ? addToCurrentJob : undefined,
      }),
    onSuccess: (r) => {
      setReasons([]);
      setNotice(`Created estimate ${r.number}. Nothing has been sent yet.`);
      setSelectedId(r.estimateId);
      refresh();
    },
    onError: (err) => {
      // The 409 carries the engine's refusal reasons. Shown VERBATIM — the wording is what
      // tells Kyle what to fix, and this screen never re-words a refusal.
      const body = (err as unknown as { body?: { reasons?: string[] } }).body;
      setNotice(null);
      setReasons(body?.reasons ?? [(err as Error).message]);
    },
  });

  /*
    THE EMAIL IS THE ONE PANEL NOW (Kyle, 2026-10-27: "one tool for one task"). "Email estimate" (a
    typed address box, a note, the two report tick-boxes, the financing-line tick-box, photos) and
    "Email the financing link" were two buttons here; both are the "Email the customer" panel in the
    Send to the customer card below - Estimate / Financing link / Message, to a chosen contact + CC,
    one Send button that names both. The body it sends is still built by shared/estimateEmail.ts,
    the same builder the field app uses (Kyle 2026-10-08: one estimating system).
  */

    /**
   * Hand the device to the customer. No lock, no token swap — Kyle removed that on 2026-08-18.
   */
  const enterSigning = {
    isPending: false,
    mutate: () => {
      window.location.assign(`/sign-in-person/${activeId}`);
    },
  };

  /**
   * Signed quote -> job. P029 built the service and the route; this is the button that was
   * missing, which is why Kyle's signed Basement Remodel had nowhere to go and could not be
   * scheduled.
   */
  const createJob = useMutation({
    mutationFn: () => api.pbCreateJob(activeId as string),
    onSuccess: (r) => {
      setNotice(null);
      refresh();
      // Straight to the calendar with the scheduler open — the same landing the in-person
      // signing flow uses (Kyle, 2026-08-24), so scheduling has one home, not two.
      window.location.assign(`/calendar?schedule=${r.visitId}`);
    },
    onError: (err) => setReasons([(err as Error).message]),
  });

  const revise = useMutation({
    mutationFn: () => api.pbIssuedRevise(activeId as string),
    onSuccess: (r) => {
      setNotice(`Changes saved to ${r.number} (revision ${r.revision}). The customer's old link no longer opens — send the new one.`);
      setSelectedId(r.estimateId);
      refresh();
    },
    onError: (err) => {
      const body = (err as unknown as { body?: { reasons?: string[] } }).body;
      setReasons(body?.reasons ?? [(err as Error).message]);
    },
  });

  const est = detail?.estimate;

  // The terms after issue (2026-09-20) — editable from where the document is shown.
  const setTerms = useMutation({
    mutationFn: (input: { depositRequired?: boolean; addToCurrentJob?: boolean }) => api.pbSetTerms(activeId as string, input),
    onSuccess: () => { setReasons([]); refresh(); },
    onError: (err) => setReasons([(err as Error).message]),
  });

  return (
    <div className="card p-3">
      <h3 className="text-sm font-semibold">Send to the customer</h3>

      {reasons.length > 0 && (
        <div className="mt-2 space-y-1">
          {reasons.map((r, i) => (
            <p key={i} className="rounded bg-red-50 p-2 text-xs text-red-900">{r}</p>
          ))}
        </div>
      )}
      {notice && <p className="mt-2 rounded bg-emerald-50 p-2 text-xs text-emerald-800">{notice}</p>}

      {!est && !(accountId && serviceAddressId) && (
        <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
          This draft is not attached to an account yet. Attach it above — an estimate has to name
          the customer and the address the work is at before it can be issued.
        </p>
      )}

      {/*
        ── THE DISCOUNT STAYS EDITABLE AFTER THE ESTIMATE IS ISSUED (Kyle, 2026-09-29) ───────────

        Kyle, from the debug console on /estimate-intake, standing on a draft that had already
        issued 2026-1098: "There is no place to adjust the discount. The discount needs to be
        editable as well."

        He was right, and it was this line: the whole discount block sat inside
        `{!est && ...}` — the "not issued yet" branch — so the moment an estimate came off the
        draft the controls VANISHED. Every other edit in this builder stays available and the
        amber banner at the top of the Review tab (the one he was reading) tells him they reach
        the estimate when he presses "Save changes to the estimate". The discount was the one
        thing that did not follow its own instructions, which also broke the standing rule that
        nothing the app creates may be un-editable.

        Nothing on the server needed changing: `graduateDraft` reads `draft.discountType` /
        `draft.discountPercent` on EVERY graduation (issuedEstimateService.ts:441), and
        `reviseEstimate` graduates the same draft — so a discount changed here rides into the
        revision exactly like a changed line or option name. `PUT /price-book/drafts/:id/discount`
        never had an issued-estimate guard either. It was only ever hidden.

        Signed is the one case that needs saying out loud: the AMOUNT is frozen onto the signed
        row as `discountJson` at signature, so changing it here moves nothing until a new revision
        is saved — and that revision needs signing again. Same rule, same wording, as
        WarrantyCoveragePanel's signed branch.
      */}
      {accountId && serviceAddressId && (
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs text-rce-soft">Discount</span>
            {([["military", "Military 5%"], ["senior", "Senior 5%"]] as const).map(([val, label]) => (
              <button
                key={val}
                type="button"
                disabled={setDiscount.isPending}
                onClick={() => setDiscount.mutate({ type: programme === val ? null : val })}
                className={programme === val ? "btn btn-primary" : "btn btn-secondary"}
              >
                {label}
              </button>
            ))}
            <span className="ml-1 inline-flex items-center gap-1">
              <input
                type="number"
                inputMode="decimal"
                min={0.01}
                max={50}
                step={0.5}
                value={customPct}
                onChange={(e) => setCustomPct(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customPctValid && !setDiscount.isPending) {
                    e.preventDefault();
                    setDiscount.mutate({ type: "custom", percent: customPctNumber });
                  }
                }}
                placeholder="Custom %"
                aria-label="Custom discount percentage"
                className="field w-24 text-sm"
              />
              <button
                type="button"
                disabled={setDiscount.isPending || !customPctValid}
                onClick={() => setDiscount.mutate({ type: "custom", percent: customPctNumber })}
                className={programme === "custom" ? "btn btn-primary" : "btn btn-secondary"}
              >
                {programme === "custom" && activePercent === customPctNumber ? `Custom ${activePercent}%` : "Apply"}
              </button>
              {programme === "custom" && (
                <button
                  type="button"
                  disabled={setDiscount.isPending}
                  onClick={() => { setDiscount.mutate({ type: null }); setCustomPct(""); }}
                  className="btn btn-secondary px-2 py-0.5 text-xs min-h-0"
                >
                  clear
                </button>
              )}
            </span>
            {programme && (
              <span className="text-xs text-green-700">
                {programme === "custom" ? `${activePercent}% off, no cap` : "5% off, capped at $250"}
                {discountPreview && discountPreview.rows.length > 0 && (
                  <>
                    {" · "}
                    {discountPreview.rows.map((r, i) => (
                      <span key={r.label}>
                        {i > 0 ? " · " : ""}
                        <b>{r.label}</b> {r.text}
                      </span>
                    ))}
                  </>
                )}
                {" · shows on the customer's page and the PDF"}
              </span>
            )}
            {setDiscount.isError && (
              <span className="text-xs text-red-700">{(setDiscount.error as Error)?.message ?? "Could not set the discount."}</span>
            )}
          </div>
          {/* Where the change has to go to count. The banner at the top of the Review tab says
              this for the draft as a whole; said again here because the discount is money and
              Kyle went looking for it specifically. */}
          {est && (
            <p className={`mt-1 text-xs ${est.signedAt ? "text-amber-800" : "text-rce-muted"}`}>
              {est.signedAt
                ? `Estimate ${est.number} is signed, so its discount is frozen at the figure the customer agreed to. Changing it here takes effect only when you press "Save changes to the estimate" below — that makes a new revision the customer has to sign again.`
                : `Changed here on the draft. Press "Save changes to the estimate" below to put it on ${est.number}.`}
            </p>
          )}
        </div>
      )}

      {!est && accountId && serviceAddressId && (
        <>
          {/* The waive-trip checkbox is GONE (Kyle, 2026-08-22): "this is not doing anything
              there is no trip charge that is even applied. we can get rid of it." He is right:
              production Rate Config carries jobFixedCost = 0, so the checkbox waived a charge
              that was never levied. The engine still honours the config cell if he ever sets it —
              what is removed is a control that did nothing. waiveTrip stays false. */}
          {/* P031: the generator one-pager rides the estimate only on this explicit tick. */}
          <label className="mt-2 flex items-center gap-2 text-xs text-rce-soft">
            <input
              type="checkbox"
              checked={includeGenerator}
              onChange={(e) => setIncludeGenerator(e.target.checked)}
            />
            Attach generator sizing recommendation (from this address's field assessment)
          </label>
          {/* The deposit is optional (Kyle, 2026-09-20). On: the ⅓ is asked and gates the
              schedule — today's rule. Off: nothing gates it; the balance is due upon receipt of the final invoice
              (2026-10-08). A financed job needs this ON — the Synchrony fee is refused without it. */}
          <label className="mt-1 flex items-center gap-2 text-xs text-rce-soft">
            <input type="checkbox" checked={depositRequired} onChange={(e) => setDepositRequired(e.target.checked)} />
            Deposit required (⅓ before scheduling){isChangeOrder ? " — off by default for a change order" : ""}
          </label>
          {isChangeOrder && (
            <label className="mt-1 flex items-center gap-2 text-xs text-rce-soft">
              <input type="checkbox" checked={addToCurrentJob} onChange={(e) => setAddToCurrentJob(e.target.checked)} />
              Add to the current job when signed (no separate scheduling)
            </label>
          )}
          <button
            className="btn btn-primary mt-2 w-full"
            disabled={issue.isPending}
            onClick={() => issue.mutate()}
          >
            {issue.isPending ? "Creating…" : isChangeOrder ? "Create change order" : "Create customer estimate"}
          </button>
          <p className="mt-1 text-xs text-rce-muted">
            Freezes the prices as they are now. Nothing goes to the customer until you tap Send.
          </p>
        </>
      )}

      {est && (
        <div className="mt-3 space-y-2">
          <div className="rounded-lg border border-rce-border p-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">
                  {est.number}{est.revision > 1 ? ` rev ${est.revision}` : ""}
                </div>
                <div className="text-xs text-rce-muted">{est.customerName}</div>
              </div>
              <div className="text-right">
                <div className="font-semibold">${est.total.toFixed(2)}</div>
                <div className="text-xs uppercase tracking-wide text-rce-soft">{est.status}</div>
              </div>
            </div>

            {detail?.customerLink && (
              <>
                <p className="mt-2 break-all text-[11px] text-rce-soft">
                  Customer link: <a className="underline" href={detail.customerLink} target="_blank" rel="noreferrer">{detail.customerLink}</a>
                </p>
                {/* The fallback for when email will not go. Opens the customer's own page, which
                    carries a Print / Save as PDF button. */}
                <a
                  className="btn btn-secondary mt-2 w-full"
                  href={detail.customerLink}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open / print the estimate
                </a>
              </>
            )}
          </div>

          {/* The terms (2026-09-20): the deposit override, and — on an unsigned change order —
              whether signing adds it to the current job. */}
          <div className="rounded-lg border border-rce-border/70 p-2 text-xs text-rce-soft">
            {est.changeOrderForNumber || est.changeOrderForId ? (
              <p className="mb-1 font-medium text-rce-muted">Change order{est.changeOrderForNumber ? ` to invoice ${est.changeOrderForNumber}` : ""} — its total joins that invoice when signed.</p>
            ) : null}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={Boolean(est.depositRequired)}
                disabled={setTerms.isPending}
                onChange={(e) => setTerms.mutate({ depositRequired: e.target.checked })}
              />
              Deposit required (⅓ before scheduling)
            </label>
            {est.changeOrderForId && !est.signedAt && (
              <label className="mt-1 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={Boolean(est.addToCurrentJob)}
                  disabled={setTerms.isPending}
                  onChange={(e) => setTerms.mutate({ addToCurrentJob: e.target.checked })}
                />
                Add to the current job when signed
              </label>
            )}
          </div>

          {/* Home-warranty coverage (Kyle, 2026-09-09): the warranty company's share as a
              credit line with the claim number; the homeowner signs for the remainder. */}
          <WarrantyCoveragePanel
            estimateId={est.id}
            estimateNumber={est.number}
            warrantyJson={est.warrantyJson ?? null}
            signed={Boolean(est.signedAt)}
            onChanged={refresh}
          />

          {est.signedAt ? (
            <>
              <p className="rounded bg-emerald-50 p-2 text-xs text-emerald-900">
                {/* An office acceptance (2026-09-24) reads "Accepted by … by phone, recorded by the
                    office", never "Signed" — shared/acceptance.ts is the one vocabulary. */}
                <strong>{isOfficeAcceptance(est.signedChannel) ? "Accepted" : "Signed"} by {est.signerName}</strong> on {new Date(est.signedAt).toLocaleString()}
                {acceptanceWording(est.signedChannel, est.acceptedVia).how ? ` — ${acceptanceWording(est.signedChannel, est.acceptedVia).verb} ${acceptanceWording(est.signedChannel, est.acceptedVia).how}` : ""}
                {isOfficeAcceptance(est.signedChannel) ? " (no signature on file)" : ""}.
                This estimate is locked; "Save changes to the estimate" creates a new revision and replaces the customer's link.
              </p>
              <button
                className="btn btn-primary w-full py-3 text-base"
                disabled={createJob.isPending}
                onClick={() => createJob.mutate()}
              >
                {createJob.isPending ? "Creating job…" : "Create job & schedule"}
              </button>
              {/*
                D3 (2026-09-29): this was a bare `void api.pbChangeOrder(...).then()` — no catch,
                no pending state, no error surface. A refusal from the server did nothing at all
                and looked identical to a dead button. It is now the SHARED control, the same one
                the job, estimate and invoice drawers carry, so a change to the action lands on
                every surface at once instead of on whichever copy someone remembered.
              */}
              <div className="flex flex-wrap items-center gap-2">
                <RaiseChangeOrderButton
                  target={{
                    estimateId: detail.estimate.id,
                    status: est.status,
                    signed: Boolean(est.signedAt),
                  }}
                  className="btn btn-secondary w-full"
                />
              </div>
              <p className="text-xs text-rce-muted">
                Makes the job at this account and address, then opens it so you can schedule it.
              </p>
            </>
          ) : (
            <>
              {/*
                ORDER IS THE RULING (P028). Kyle: "I want them to be able to view the quote in app
                and sign there as the first option email is the second." In-person is the close;
                email is for the customer who wants to think about it tonight.
              */}
              <button
                className="btn btn-primary w-full py-3 text-base"
                disabled={enterSigning.isPending}
                onClick={() => {
                  enterSigning.mutate();
                }}
              >
                Review &amp; sign now
              </button>
              <p className="text-xs text-rce-muted">
                Opens the estimate for the customer to read and sign on this device.
              </p>

              <div className="pt-1">
                <p className="mb-1 text-xs font-medium text-rce-soft">Or email it instead</p>
                {/* Click path: this estimate -> "Email the customer" -> Estimate / Financing link / Message -> To and CC -> "Send estimate NNNN to …". */}
                <SendEmailPanel
                  target="account"
                  id={est.customerId}
                  primaryEmail={est.customerEmail ?? null}
                  accountIdForContacts={est.customerId}
                  record={{
                    estimateId: est.id,
                    number: est.number,
                    kinds: [
                      {
                        kind: "estimate",
                        label: `Estimate ${est.number}${est.sentAt ? " (send it again)" : ""}`,
                        blocked: est.status === "void" ? "This estimate is void."
                          : est.status === "lost" ? "This estimate is marked lost. Reopen it from the Estimates page first, then send it."
                          : null,
                      },
                      {
                        kind: "financing",
                        label: "Financing link",
                        blocked: est.status === "void" ? "This estimate is void."
                          : est.status === "lost" ? "This estimate is marked lost. Reopen it from the Estimates page first, then send the financing link."
                          : null,
                      },
                      { kind: "message", label: "Message" },
                    ],
                    onSent: refresh,
                  }}
                />
              </div>
            </>
          )}

          {/* Kyle, 2026-08-29: "I just made an edit to the name and there is
              no way to save changes... It should overwrite the existing one."
              This IS that save — a revision keeps the estimate number, bumps
              the revision, and replaces the customer's copy. The old label
              ("New revision from this draft") never read as saving. */}
          <button
            className="btn btn-primary w-full"
            disabled={revise.isPending || est.status === "lost"}
            onClick={() => {
              if (window.confirm(`Save your draft changes to estimate ${est.number}? The customer's copy is replaced (same estimate number, new revision); their old link stops working.`)) {
                revise.mutate();
              }
            }}
          >
            {revise.isPending ? "Saving…" : "Save changes to the estimate"}
          </button>
          <p className="text-xs text-rce-muted">
            Edits made in this builder don't reach the issued estimate until saved to it.
          </p>
          {/* 2026-10-08: the server refuses to revise a lost estimate (Reopen is the way back), so
              the button says why it is greyed instead of failing after the click. */}
          {est.status === "lost" && (
            <p className="text-xs text-amber-800">
              This estimate is marked lost. Open it from the Estimates page and press Reopen, then come back and save changes to it.
            </p>
          )}

          {(est.events ?? []).length > 0 && (
            <div className="rounded-lg bg-rce-accentBg/30 p-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-rce-soft">Audit</p>
              {(est.events ?? []).map((e) => (
                <p key={e.id} className="text-[11px] text-rce-soft">
                  {new Date(e.at).toLocaleString()} · <strong>{e.type}</strong> · {e.actor}
                  {e.detail ? ` — ${e.detail}` : ""}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Photos — attach only. NO MODEL EGRESS. ──────────────────────────────────

/**
 * SEAM: photo → AI egress is deliberately NOT built.
 *
 * P012 scope: "Photos: attach-only. Do NOT send photo bytes to the AI model — that egress is a
 * separate Kyle decision (decisions/2026-08-04-customer-data-handling.md); leave a clearly-named
 * seam." This is that seam.
 *
 * Today the CRM has no photo-upload endpoint bound to a price-book draft, so this renders the
 * boundary rather than a broken control — saying what is not built is better than a button that
 * fails. When Kyle rules on the egress question, the upload lands here and the model still does
 * not receive the bytes unless he separately says so.
 */
/**
 * Photos while building the estimate — filed on the JOB, not on the draft (plan A, Kyle
 * 2026-10-02).
 *
 *   "Draft photos don't make sense to me. Using basic logic here we would obviously want the
 *    photos added to the estimates that are from an applied job, consultation, or diagnostics.
 *    This is why they are labeled with what job they came from or assigned to a job once
 *    uploaded."
 *
 * This used to be `PhotoAttach`, which wrote a `DraftPhoto` row nothing else could reach — the
 * exact dead end of 2026-10-01, when the photos justifying a quote were the only ones that could
 * not be emailed with it. A consultation IS a job, created when it is scheduled, so there is
 * always a job to put the photo on; and because the photo lives on the job it OUTLIVES the
 * estimate — when the 30 days pass and the estimate is rebuilt, the photos are still there to
 * attach to the new one.
 *
 * So this renders the account's own gallery, the one on the account page: every photo on the
 * account newest first (Kyle: "When building an estimate we want to access all photos"), upload
 * asks WHICH JOB (no question when there is exactly one, greyed with the reason when there is
 * none), and the job the draft was created from is preselected. Same `api.uploadVisitPhoto`,
 * same `["property-photos", …]` cache — one upload path, not two. Every photo added here has
 * its × here.
 *
 * The account comes from the URL (`?account=`) or, failing that, the draft's own `customerId`.
 * With neither there is no job to file a photo on, and the panel says so rather than hiding.
 *
 * STILL NO AI EGRESS. Photos go to the job and nowhere else (P012 seam).
 */
function EstimatePhotos(props: { accountId: string | null; defaultVisitId: string | null }) {
  const accountId = props.accountId ?? "";
  // Same key, same call and same shape as AccountDetailPage's read (tests/queryKeyCollisions).
  const { data: summary, isError } = useQuery({
    queryKey: ["account-summary", accountId],
    queryFn: () => api.accountSummary(accountId),
    enabled: Boolean(accountId),
  });

  if (!accountId) {
    return (
      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Photos</h2>
          <label className="btn btn-primary cursor-not-allowed text-sm opacity-50">
            + Add photos
            <input type="file" accept="image/*" multiple hidden disabled />
          </label>
        </div>
        <p className="mt-2 text-sm text-rce-soft">
          Attach this estimate to an account first — photos are filed on a job, and the jobs live on the account.
        </p>
      </section>
    );
  }
  if (isError) {
    return (
      <section className="card p-4">
        <h2 className="text-lg font-semibold">Photos</h2>
        <p className="mt-2 text-sm text-rce-danger">Could not load this account's jobs and photos. Reload to try again.</p>
      </section>
    );
  }
  if (!summary) {
    return (
      <section className="card p-4">
        <h2 className="text-lg font-semibold">Photos</h2>
        <p className="mt-2 text-sm text-rce-soft">Loading this account's photos…</p>
      </section>
    );
  }
  return (
    <AccountPhotoGallery
      properties={summary.properties.map((p) => ({ id: p.id, name: p.name, addressLine1: p.addressLine1, city: p.city }))}
      jobs={summary.jobs}
      defaultVisitId={props.defaultVisitId}
    />
  );
}

/** Shrink on the phone before upload: longest edge 1600px, JPEG. */
// downscale moved to lib/images.ts (2026-08-28) — the photo gallery uses the
// same resize, and two copies would drift.

/**
 * Naming an option, on the review screen, where Kyle is standing when he knows what it is.
 *
 * Kyle, 2026-08-20, picked on this very header:
 *
 *   *"It would be nice to be able to rename the options at the review screen in order to specify
 *    the scope of work to the job being quoted. This is the perfect spot to make the title of each
 *    option reflect the itemized list that it represents. A Short description to add text in would
 *    be nice too."*
 *
 * ── WHY IT SAVES ON BLUR AND NOT ON EVERY KEYSTROKE ────────────────────────────────────────────
 *
 * A PUT per character would put a write on the wire for every letter of "Exterior pathway lights"
 * and race its own responses into the field he is still typing in. Blur is the moment he is
 * finished with the field, and it is also what a Tab or a click elsewhere already means.
 *
 * ── AND WHY THE DEFAULT TEXT IS A PLACEHOLDER, NOT A VALUE ─────────────────────────────────────
 *
 * "what the client called for" and the other two are what these options have always meant, so they
 * still guide him. But they are placeholders: prefilling them as real values would freeze that
 * wording onto the customer's estimate for every option he never got round to renaming, and
 * "code violations & hazards found" is not a heading to put in front of a customer.
 */
function OptionNaming(props: {
  draftId: string;
  option: PbOption;
  meta: PbOptionMeta | null;
}) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState(props.meta?.label ?? "");
  const [note, setNote] = useState(props.meta?.note ?? "");

  // The server is the truth when it arrives — but never while the field has focus, or a slow
  // response would overwrite what he is in the middle of typing.
  useEffect(() => {
    if (document.activeElement?.tagName === "INPUT") return;
    setLabel(props.meta?.label ?? "");
    setNote(props.meta?.note ?? "");
  }, [props.meta?.label, props.meta?.note]);

  const save = useMutation({
    mutationFn: (input: { label: string; note: string }) =>
      api.pbSaveDraftOption(props.draftId, props.option, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["pb-draft-options", props.draftId] });
    },
  });

  const commit = () => {
    const nextLabel = label.trim();
    const nextNote = note.trim();
    if (nextLabel === (props.meta?.label ?? "") && nextNote === (props.meta?.note ?? "")) return;
    save.mutate({ label: nextLabel, note: nextNote });
  };

  // A/B/C keep Kyle's meanings; D and later are named by the user right here, so the empty box
  // just says so (shared/estimateOptions.ts).
  const hint = OPTION_HINTS[props.option] ?? "name this option";

  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold text-rce-soft">Option {props.option}</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commit}
          maxLength={120}
          placeholder={hint}
          aria-label={`Name for option ${props.option}`}
          className="min-w-0 flex-1 rounded border border-rce-soft bg-white px-1.5 py-0.5
                     text-sm font-semibold outline-none hover:border-rce-border
                     focus:border-rce-accent"
        />
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={commit}
        maxLength={400}
        placeholder="Short description for the customer (optional)"
        aria-label={`Description for option ${props.option}`}
        className="mt-0.5 w-full rounded border border-rce-soft bg-white px-1.5 py-0.5
                   text-[11px] text-rce-muted outline-none hover:border-rce-border
                   focus:border-rce-accent"
      />
      {save.isError && (
        <p className="mt-0.5 text-[11px] text-red-600">Could not save that name. It is still here — try again.</p>
      )}
    </div>
  );
}
