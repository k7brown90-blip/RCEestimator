import { useEffect, useMemo, useState } from "react";
import { useStickyFooterSpace } from "../lib/useStickyFooterSpace";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { api, fetchProtectedObjectUrl } from "../lib/api";
import type {
  PbAtomic,
  PbComputed,
  PbOptionSummary,
  PbComputedLine,
  PbDifficulty,
  PbDraft,
  PbLine,
  PbOption,
  PbQuantitySource,
  PbWalkthroughRow,
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
 *  2. EXACT INPUTS PER ITEM. Quantity, quantity-source and difficulty are required per line and
 *     none of them is silently defaulted into something that looks like data. Continuous-length
 *     product forces MEASURED_LENGTH, because length is a field measurement (Kyle, rule R3).
 */

type Tab = "browse" | "walkthrough" | "review";

const QUANTITY_SOURCES: Array<{ value: PbQuantitySource; label: string; hint: string }> = [
  { value: "COUNT", label: "Counted", hint: "Discrete items you counted" },
  { value: "MEASURED_LENGTH", label: "Measured", hint: "Length you measured on site" },
  { value: "TERMINATION_COUNT", label: "Terminations", hint: "Driven by termination count" },
  { value: "MANUAL", label: "Manual", hint: "Hand-set — say why in the note" },
];

const DIFFICULTIES: Array<{ value: PbDifficulty; label: string }> = [
  { value: "NORMAL", label: "Normal" },
  { value: "DIFFICULT", label: "Difficult" },
  { value: "VERY_DIFFICULT", label: "Very difficult" },
];

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
      </div>

      {draftId && (
        <>
          {/* ── Tabs ── */}
          {/* ── Which option is being built (Kyle, 2026-08-19) ──────────────────────────────
              Page-level rather than a field inside each add sheet. He builds A, then B, then C,
              and asking on every single line would be a tap per item to answer a question whose
              answer almost never changes between them. Everything added — browse, search, or
              walkthrough — lands in whichever option is selected here. */}
          <div className="card flex flex-wrap items-center gap-2 p-3">
            <span className="text-xs font-medium text-rce-soft">Adding into</span>
            {(["A", "B", "C"] as PbOption[]).map((o) => (
              <button
                key={o}
                onClick={() => setActiveOption(o)}
                className={
                  activeOption === o
                    ? "rounded-full bg-rce-accent px-3 py-1.5 text-sm font-semibold text-white"
                    : "rounded-full border border-rce-border px-3 py-1.5 text-sm text-rce-soft"
                }
              >
                Option {o}
              </button>
            ))}
            <span className="text-xs text-rce-soft">
              {activeOption === "A" && "what the client called for"}
              {activeOption === "B" && "code violations & hazards found"}
              {activeOption === "C" && "recommended beyond A and B"}
            </span>
          </div>

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
              option={activeOption}
              onChanged={invalidate}
              onOpenItemsChange={setOpenItems}
            />
          )}

          {tab === "review" && (
            <ReviewTab
              draftId={draftId}
              review={review}
              computed={computed?.computed}
              options={computed?.options}
              optionMeta={optionMeta}
              onChanged={invalidate}
              accountId={accountId}
              serviceAddressId={serviceAddressId}
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
            options={computed?.options}
            openQuestions={review?.counts.openQuestions ?? 0}
            openItems={openItems}
          />
        </>
      )}

      {picked && draftId && (
        <AddLineSheet
          atomic={picked}
          draftId={draftId}
          option={activeOption}
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

// ─── Browse + search ─────────────────────────────────────────────────────────

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
  onClose: () => void;
  onAdded: () => void;
}) {
  const { atomic, draftId, option, onClose, onAdded } = props;
  // Continuous-length product is forced to MEASURED_LENGTH and cannot be changed — Kyle's rule
  // that length is a field measurement, enforced at the point of entry rather than as a warning
  // after the fact.
  const forced = atomic.isContinuousLength;
  /*
    HOURLY PRODUCT — the third input shape (Kyle, 2026-08-17, verbatim):

      "The diagnostics menu is dictated by hours not quantity and measured, terminations,
       counted does not apply. We will put diagnostic hours and difficulty only here...
       The location and note is okay to stay here."

    So for a row sold by the hour the quantity field IS hours and the source picker is GONE —
    not relabelled, not disabled-but-visible. Three of its four options are meaningless against
    an hour, and offering them is what pushed Kyle onto MANUAL (which then demanded a
    justification note for the crime of billing one hour). His DG001 line landed
    `qty 2 MANUAL` on 2026-08-17 for exactly that reason.

    SEAM — what is stored. The line still records `COUNT`, because `PriceBookQuantitySource`
    has no HOURS member and adding one touches the Prisma enum, four zod schemas, the MCP tool
    contract and the AI proposer's function schema. Nothing branches on it here: the engine
    reads quantitySource in exactly two places (the MANUAL-needs-a-note guard and the
    continuous-length guard) and an hourly line trips neither. The display is unit-aware
    instead, so no screen shows the word "Counted" against an hour. If the stored record itself
    ever has to carry the distinction, HOURS as a real enum member is the fuller fix.
  */
  const hourly = atomic.isHourlyProduct;
  const [quantity, setQuantity] = useState("");
  const [source, setSource] = useState<PbQuantitySource>(forced ? "MEASURED_LENGTH" : "COUNT");
  const [difficulty, setDifficulty] = useState<PbDifficulty>("NORMAL");
  const [location, setLocation] = useState("");
  const [note, setNote] = useState("");

  const add = useMutation({
    mutationFn: () =>
      api.pbAddLine(draftId, {
        itemId: atomic.itemId,
        quantity: Number(quantity),
        quantitySource: source,
        difficulty,
        option,
        location: location.trim() || null,
        note: note.trim() || null,
      }),
    onSuccess: onAdded,
  });

  const qtyValid = Number(quantity) > 0;
  const noteRequired = source === "MANUAL" && !note.trim();

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
            placeholder={hourly ? "How many hours" : forced ? "Measured length" : "How many"}
            autoFocus
          />
        </label>

        {hourly ? (
          <p className="mt-1 text-xs text-rce-muted">
            Sold by the hour — hours and difficulty are the only inputs this needs.
          </p>
        ) : (
          <div className="mt-3">
            <span className="mb-1 block text-xs font-medium text-rce-soft">Quantity source</span>
            <div className="flex flex-wrap gap-1">
              {QUANTITY_SOURCES.map((s) => (
                <button
                  key={s.value}
                  disabled={forced && s.value !== "MEASURED_LENGTH"}
                  className={source === s.value ? "btn btn-primary" : "btn btn-secondary"}
                  onClick={() => setSource(s.value)}
                  title={s.hint}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {forced && (
              <p className="mt-1 text-xs text-rce-muted">
                Sold by the {atomic.unit} — length is a field measurement, so this is locked to Measured.
              </p>
            )}
          </div>
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
          Note {source === "MANUAL" && <span className="text-rce-muted">— required for a manual quantity</span>}
          <input className="field mt-1 w-full" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        {add.isError && <p className="mt-2 text-sm text-red-700">{(add.error as Error).message}</p>}

        {/* ── SAY WHY THE BUTTON IS OFF ──────────────────────────────────────────────────
            Kyle, 2026-08-20: "The add line button here is not working." It was working — it was
            DISABLED, because no quantity had been typed, and a greyed-out button that explains
            nothing is indistinguishable from one that is broken. He reported a bug, then entered
            a quantity and added two lines successfully a minute later.

            A disabled control has to say what would enable it. */}
        {(!qtyValid || noteRequired) && (
          <p className="mt-3 rounded bg-amber-50 p-2 text-xs text-amber-900">
            {!qtyValid
              ? `Enter ${hourly ? "the hours" : "a quantity"} above to add this line.`
              : "A manual quantity needs a note saying why."}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <button className="btn btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary flex-1"
            disabled={!qtyValid || noteRequired || add.isPending}
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
        quantitySource: c.isContinuousLength ? "MEASURED_LENGTH" : "COUNT",
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
  review: { proposedLines: PbLine[]; confirmedLines: PbLine[]; openQuestions: Array<{ id: string; question: string; raisedBy: string }>; counts: { proposed: number; confirmed: number; openQuestions: number } } | undefined;
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
}) {
  const { draftId, review, computed, options, optionMeta, onChanged, accountId, serviceAddressId, onAttached } = props;
  // finalizeMsg went with the Check / Finalize buttons — nothing sets it now, and a
  // message box that can never fill is a place for a future reader to look for state
  // that does not exist.


  // The `finalize` mutation was removed with the Check / Finalize buttons (2026-08-19).
  // The readiness check it called still exists on the server and still refuses an estimate
  // with gaps — it now runs at the moment of issuing, where the refusal is about something
  // the operator is actually trying to do rather than a button they were guessing at.

  if (!review) return <p className="text-sm text-rce-muted">Loading…</p>;

  return (
    <div className="space-y-3">
      {review.proposedLines.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">
            AI proposals — {review.counts.proposed} waiting on you
          </h3>
          {review.proposedLines.map((l) => (
            <ProposedLineRow key={l.id} line={l} onChanged={onChanged} />
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

        {(["A", "B", "C"] as PbOption[]).map((opt) => {
          // Joined on the LINE id, not the itemId. A draft may legitimately carry the same atomic
          // twice — Kyle's 2026-08-16 draft has two N001 lines of 100 ft — and an itemId join
          // rendered the first row's hours and dollars against both of them.
          const withComputed = review.confirmedLines.map((l) => ({
            line: l,
            computed: computed?.lines.find((x) => x.id === l.id),
          }));
          const mine = withComputed.filter((x) => (x.computed?.option ?? "A") === opt);
          const summary = options?.find((o) => o.option === opt);
          if (mine.length === 0 && review.confirmedLines.length === 0) return null;

          return (
            <section key={opt} className="rounded-lg border border-rce-border">
              <header className="flex items-baseline justify-between gap-2 border-b border-rce-border bg-rce-bg px-3 py-2">
                <OptionNaming
                  draftId={draftId as string}
                  option={opt}
                  meta={optionMeta?.find((m) => m.option === opt) ?? null}
                />
                <div className="text-right">
                  <div className="text-sm font-semibold">{money(summary?.subtotal)}</div>
                  <div className="text-[11px] text-rce-soft">{mine.length} line(s)</div>
                </div>
              </header>
              <div className="space-y-2 p-2">
                {mine.length === 0 ? (
                  <p className="text-xs text-rce-muted">
                    Nothing in this option yet. Pick "Option {opt}" above to add into it.
                  </p>
                ) : (
                  mine.map((x) => (
                    <ConfirmedLineRow
                      key={x.line.id}
                      line={x.line}
                      computed={x.computed}
                      onChanged={onChanged}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}

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

      <IssueAndSendPanel draftId={draftId} accountId={accountId} serviceAddressId={serviceAddressId} />

      <PhotoAttach draftId={draftId} />
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
function ConfirmedLineRow(props: { line: PbLine; computed: PbComputedLine | undefined; onChanged: () => void }) {
  const { line: l, computed: c, onChanged } = props;
  const [editing, setEditing] = useState(false);
  const [qty, setQty] = useState(String(l.quantity));
  const [difficulty, setDifficulty] = useState<PbDifficulty>(l.difficulty);
  const [option, setOption] = useState<PbOption>(c?.option ?? "A");
  const [location, setLocation] = useState(l.location ?? "");
  const [note, setNote] = useState(l.note ?? "");
  const [err, setErr] = useState<string | null>(null);

  const hourly = (l.unit ?? "").trim().toLowerCase() === "hr";

  const save = useMutation({
    mutationFn: () =>
      api.pbEditLine(l.id, {
        quantity: Number(qty),
        difficulty,
        // A line put in the wrong option is fixed here rather than by deleting and re-adding it.
        option,
        location: location.trim() || null,
        note: note.trim() || null,
      }),
    onSuccess: () => {
      setEditing(false);
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
          <div className="text-xs text-rce-muted line-clamp-2">{l.description}</div>
          <div className="text-xs text-rce-soft">
            {/* An hourly line's quantity source carries no information — the quantity IS hours —
                so it is not shown rather than displaying "COUNT" against an hour. */}
            Option {c?.option ?? "A"} · {hourly ? "by the hour" : l.quantitySource} · {l.difficulty}
            {l.proposedBy ? ` · from ${l.proposedBy}` : " · entered by hand"}
            {l.editedBeforeConfirm ? " · edited before confirm" : ""}
          </div>
          {l.location && <div className="text-xs text-rce-soft">{l.location}</div>}
          {l.note && <div className="text-xs text-rce-soft italic">{l.note}</div>}
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
          {/* Move a line to another option. Without this, putting one in the wrong option
              could only be undone by deleting it and adding it again. */}
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs text-rce-soft">Option</span>
            {(["A", "B", "C"] as PbOption[]).map((o) => (
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
              disabled={!(Number(qty) > 0) || save.isPending}
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

function ProposedLineRow(props: { line: PbLine; onChanged: () => void }) {
  const { line, onChanged } = props;
  const [qty, setQty] = useState(String(line.quantity));
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
        <button className="btn btn-primary flex-1" disabled={!(Number(qty) > 0) || confirm.isPending} onClick={() => confirm.mutate()}>
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
  options?: PbOptionSummary[];
  openQuestions: number;
  openItems: number;
}) {
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
            <div className="text-lg font-semibold">{money(c.total)}</div>
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
function IssueAndSendPanel(props: { draftId: string; accountId: string | null; serviceAddressId: string | null }) {
  const { draftId, accountId, serviceAddressId } = props;
  const queryClient = useQueryClient();
  const [reasons, setReasons] = useState<string[]>([]);
  // No setter: the waive-trip control was removed 2026-08-22 (no trip charge is configured).
  // The state survives so the issue call keeps its explicit false rather than an implicit one.
  const [waiveTrip] = useState(false);
  const [sendTo, setSendTo] = useState("");
  const [sendMsg, setSendMsg] = useState("");
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
  const setDiscount = useMutation({
    mutationFn: (type: "military" | "senior" | null) => api.pbSetDiscount(draftId, type),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["pb-compute", draftId] }),
  });

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

  const send = useMutation({
    mutationFn: () =>
      api.pbIssuedSend(activeId as string, {
        to: sendTo.trim() || null,
        message: sendMsg.trim() || null,
      }),
    onSuccess: (r) => {
      setNotice(`Sent to ${r.to}.`);
      setReasons([]);
      setSendMsg("");
      refresh();
    },
    onError: (err) => {
      setNotice(null);
      setReasons([(err as Error).message]);
    },
  });

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
      // Straight to the job, because the next thing he wants is to schedule it.
      window.location.assign(`/visits/${r.visitId}`);
    },
    onError: (err) => setReasons([(err as Error).message]),
  });

  const revise = useMutation({
    mutationFn: () => api.pbIssuedRevise(activeId as string),
    onSuccess: (r) => {
      setNotice(`Created revision ${r.revision} of ${r.number}. The customer's old link no longer opens — send the new one.`);
      setSelectedId(r.estimateId);
      refresh();
    },
    onError: (err) => {
      const body = (err as unknown as { body?: { reasons?: string[] } }).body;
      setReasons(body?.reasons ?? [(err as Error).message]);
    },
  });

  const est = detail?.estimate;

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

      {!est && accountId && serviceAddressId && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs text-rce-soft">Discount</span>
            {([["military", "Military 5%"], ["senior", "Senior 5%"]] as const).map(([val, label]) => (
              <button
                key={val}
                type="button"
                disabled={setDiscount.isPending}
                onClick={() => setDiscount.mutate(programme === val ? null : val)}
                className={programme === val ? "btn btn-primary" : "btn btn-secondary"}
              >
                {label}
              </button>
            ))}
            {programme && <span className="text-xs text-green-700">capped at $250 · shows on the customer's page</span>}
          </div>
          {/* The waive-trip checkbox is GONE (Kyle, 2026-08-22): "this is not doing anything
              there is no trip charge that is even applied. we can get rid of it." He is right:
              production Rate Config carries jobFixedCost = 0, so the checkbox waived a charge
              that was never levied. The engine still honours the config cell if he ever sets it —
              what is removed is a control that did nothing. waiveTrip stays false. */}
          <button
            className="btn btn-primary mt-2 w-full"
            disabled={issue.isPending}
            onClick={() => issue.mutate()}
          >
            {issue.isPending ? "Creating…" : "Create customer estimate"}
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

          {est.signedAt ? (
            <>
              <p className="rounded bg-emerald-50 p-2 text-xs text-emerald-900">
                <strong>Signed by {est.signerName}</strong> on {new Date(est.signedAt).toLocaleString()}
                {est.signedChannel === "in_person" ? " — signed in person" : est.signedChannel === "email" ? " — signed from the emailed link" : ""}.
                This estimate is locked; a change needs a new revision, which voids the customer's link.
              </p>
              <button
                className="btn btn-primary w-full py-3 text-base"
                disabled={createJob.isPending}
                onClick={() => createJob.mutate()}
              >
                {createJob.isPending ? "Creating job…" : "Create job & schedule"}
              </button>
                <button
                  className="btn btn-secondary w-full"
                  onClick={() => {
                    void api.pbChangeOrder(detail.estimate.id).then((r) => {
                      // Straight into the empty change-order draft. Negative counts are accepted
                      // there and nowhere else.
                      window.location.href = `/estimate-intake?draft=${r.draftId}`;
                    });
                  }}
                >
                  Raise a change order
                </button>
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
                <input
                  className="field w-full"
                  placeholder={est.customerEmail ?? "Customer email"}
                  value={sendTo}
                  onChange={(e) => setSendTo(e.target.value)}
                />
                <input
                  className="field mt-2 w-full"
                  placeholder="Optional note to include in the email"
                  value={sendMsg}
                  onChange={(e) => setSendMsg(e.target.value)}
                />
                <button
                  className="btn btn-secondary mt-2 w-full"
                  disabled={send.isPending}
                  onClick={() => {
                    const to = sendTo.trim() || est.customerEmail || "";
                    if (!to) {
                      setReasons(["No customer email address. Type one above, or add it to the account."]);
                      return;
                    }
                    if (window.confirm(`Email estimate ${est.number} to ${to}?`)) send.mutate();
                  }}
                >
                  {send.isPending ? "Sending…" : est.sentAt ? "Email again" : "Email estimate"}
                </button>
              </div>
            </>
          )}

          <button
            className="btn btn-secondary w-full"
            disabled={revise.isPending}
            onClick={() => {
              if (window.confirm("Create a new revision? The customer's current link will stop working.")) {
                revise.mutate();
              }
            }}
          >
            {revise.isPending ? "Revising…" : "New revision from this draft"}
          </button>

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
 * Walkthrough photos — real now (Kyle, 2026-08-22: "there is no capability to take photos
 * right now").
 *
 * The <input capture="environment"> opens the phone's rear camera directly; the gallery still
 * works through the same control. Every image is DOWNSCALED ON THE PHONE (max 1600px, JPEG .82)
 * before upload — a 12MP photo is ~6MB of bytes the database does not need for "which breaker
 * fed the disposal", and the server's 4MB cap is the backstop, not the plan.
 *
 * Thumbnails fetch through the authed blob path — a bare <img src> carries no Authorization
 * header, the same lesson the PDF buttons paid for.
 *
 * STILL NO AI EGRESS. Photos attach to the draft and go nowhere else (P012 seam).
 */
function PhotoAttach(props: { draftId: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  const { data } = useQuery({
    queryKey: ["pb-photos", props.draftId],
    queryFn: () => api.pbPhotos(props.draftId),
  });
  const photos = data?.photos ?? [];
  const photoIds = photos.map((p) => p.id).join(",");

  useEffect(() => {
    let dead = false;
    for (const ph of photos) {
      if (thumbs[ph.id]) continue;
      void fetchProtectedObjectUrl(`/draft-photos/${ph.id}`)
        .then((url) => { if (!dead) setThumbs((t) => ({ ...t, [ph.id]: url })); })
        .catch(() => {});
    }
    return () => { dead = true; };
    // Keyed on the id list: re-running on `thumbs` itself would loop forever.
  }, [photoIds]);

  const remove = useMutation({
    mutationFn: (id: string) => api.pbDeletePhoto(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["pb-photos", props.draftId] }),
  });

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setBusy(true); setErr("");
    try {
      for (const file of files) {
        const dataUrl = await downscale(file);
        await api.pbUploadPhoto(props.draftId, dataUrl);
      }
      await queryClient.invalidateQueries({ queryKey: ["pb-photos", props.draftId] });
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Photos {photos.length > 0 ? `(${photos.length})` : ""}</h3>
        <label className="btn btn-secondary cursor-pointer text-sm">
          {busy ? "Uploading…" : "+ Add photo"}
          <input
            type="file" accept="image/*" capture="environment" multiple hidden
            onChange={(e) => void onPick(e)} disabled={busy}
          />
        </label>
      </div>
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
      {photos.length === 0 && !busy && (
        <p className="mt-1 text-xs text-rce-muted">
          Walkthrough photos attach to this draft. They are never sent to the AI.
        </p>
      )}
      {photos.length > 0 && (
        <div className="mt-2 grid grid-cols-3 gap-2">
          {photos.map((ph) => (
            <div key={ph.id} className="relative">
              {thumbs[ph.id]
                ? <img src={thumbs[ph.id]} alt="walkthrough" className="h-24 w-full rounded object-cover" />
                : <div className="h-24 w-full animate-pulse rounded bg-rce-border/40" />}
              <button
                type="button"
                onClick={() => remove.mutate(ph.id)}
                className="absolute right-1 top-1 rounded bg-black/60 px-1.5 text-xs text-white"
                aria-label="Delete photo"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shrink on the phone before upload: longest edge 1600px, JPEG. */
async function downscale(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

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

  const hint =
    props.option === "A"
      ? "what the client called for"
      : props.option === "B"
        ? "code violations & hazards found"
        : "recommended beyond A and B";

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
          className="min-w-0 flex-1 border-0 border-b border-transparent bg-transparent px-0 py-0
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
        className="mt-0.5 w-full border-0 border-b border-transparent bg-transparent px-0 py-0
                   text-[11px] text-rce-muted outline-none hover:border-rce-border
                   focus:border-rce-accent"
      />
      {save.isError && (
        <p className="mt-0.5 text-[11px] text-red-600">Could not save that name. It is still here — try again.</p>
      )}
    </div>
  );
}
