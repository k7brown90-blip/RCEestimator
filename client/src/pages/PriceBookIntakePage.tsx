import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import type {
  PbAtomic,
  PbComputed,
  PbDifficulty,
  PbLine,
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
  const draftId = params.get("draft");
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
  const [newTitle, setNewTitle] = useState("");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["pb-review", draftId] });
    void queryClient.invalidateQueries({ queryKey: ["pb-compute", draftId] });
  };

  const { data: drafts } = useQuery({ queryKey: ["pb-drafts"], queryFn: api.pbDrafts });
  const { data: cats } = useQuery({ queryKey: ["pb-cats"], queryFn: api.pbNecCategories });

  const { data: atomics, isFetching: searching } = useQuery({
    queryKey: ["pb-atomics", search, article],
    queryFn: () => api.pbAtomics({ search: search || undefined, article: article ?? undefined, limit: 60 }),
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

  const createDraft = useMutation({
    mutationFn: () => api.pbCreateDraft({ title: newTitle.trim() }),
    onSuccess: (d) => {
      setDraftId(d.id);
      setNewTitle("");
      void queryClient.invalidateQueries({ queryKey: ["pb-drafts"] });
    },
  });

  const cards = useMemo(
    () => (cats?.categories ?? []).filter((c) => c.atomicCount > 0),
    [cats]
  );

  return (
    <div className="space-y-4 pb-24">
      <PageHeader title="Estimate intake" subtitle="Browse, search, and confirm — the engine prices" />

      {/* ── Draft selection. Every estimate starts blank (Kyle, 2026-08-12). ── */}
      <div className="card p-4">
        <label className="mb-1 block text-xs font-medium text-rce-soft">Draft</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            className="field flex-1"
            value={draftId ?? ""}
            onChange={(e) => setDraftId(e.target.value || null)}
          >
            <option value="">Select a draft…</option>
            {(drafts?.drafts ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.title} — {d._count?.lines ?? 0} line(s)
              </option>
            ))}
          </select>
        </div>
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
      </div>

      {draftId && (
        <>
          {/* ── Tabs ── */}
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

          {tab === "walkthrough" && <WalkthroughTab draftId={draftId} onChanged={invalidate} />}

          {tab === "review" && (
            <ReviewTab draftId={draftId} review={review} computed={computed?.computed} onChanged={invalidate} />
          )}

          {/* ── Running totals. Straight from the engine, always visible. ── */}
          <TotalsBar computed={computed?.computed} />
        </>
      )}

      {picked && draftId && (
        <AddLineSheet
          atomic={picked}
          draftId={draftId}
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
  cards: Array<{ article: string; title: string | null; atomicCount: number }>;
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
            ← All NEC categories
          </button>
        )}
      </div>

      {!showingResults && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {cards.map((c) => (
            <button
              key={c.article}
              className="card p-3 text-left active:opacity-70"
              onClick={() => setArticle(c.article)}
            >
              <div className="text-lg font-semibold">{c.article}</div>
              <div className="text-xs text-rce-muted">{c.title}</div>
              <div className="mt-1 text-xs text-rce-soft">{c.atomicCount} item(s)</div>
            </button>
          ))}
          {cards.length === 0 && (
            <p className="text-sm text-rce-muted">No NEC categories carry atomics yet.</p>
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
              {/* Gaps are shown BEFORE the line is added — cheaper here than at finalize. */}
              <div className="mt-2 flex flex-wrap gap-1">
                {!a.hasPriceAtActiveSupplier && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-900">no price at supplier</span>
                )}
                {!a.hasLabourUnitBasis && a.laborNormal !== null && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-900">no labour unit basis</span>
                )}
                {a.isContinuousLength && (
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-900">measured length</span>
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

function AddLineSheet(props: { atomic: PbAtomic; draftId: string; onClose: () => void; onAdded: () => void }) {
  const { atomic, draftId, onClose, onAdded } = props;
  // Continuous-length product is forced to MEASURED_LENGTH and cannot be changed — Kyle's rule
  // that length is a field measurement, enforced at the point of entry rather than as a warning
  // after the fact.
  const forced = atomic.isContinuousLength;
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
          Quantity {atomic.unit ? `(${atomic.unit})` : ""}
          <input
            className="field mt-1 w-full"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder={forced ? "Measured length" : "How many"}
            autoFocus
          />
        </label>

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
            {!atomic.hasLabourUnitBasis && atomic.laborNormal !== null && " · no unit basis — labour will not compute"}
          </p>
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

        <div className="mt-4 flex gap-2">
          <button className="btn btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary flex-1"
            disabled={!qtyValid || noteRequired || add.isPending}
            onClick={() => add.mutate()}
          >
            Add line
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Walkthrough material list ───────────────────────────────────────────────

function WalkthroughTab(props: { draftId: string; onChanged: () => void }) {
  const { draftId, onChanged } = props;
  const [text, setText] = useState("");
  const [rows, setRows] = useState<PbWalkthroughRow[] | null>(null);

  const resolve = useMutation({
    mutationFn: () =>
      api.pbResolveWalkthrough(
        text.split("\n").map((l) => l.trim()).filter(Boolean).map((raw) => ({ raw }))
      ),
    onSuccess: (r) => setRows(r.rows),
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
        <button className="btn btn-primary mt-2" disabled={!text.trim() || resolve.isPending} onClick={() => resolve.mutate()}>
          {resolve.isPending ? "Matching…" : "Match against the price book"}
        </button>
        <p className="mt-2 text-xs text-rce-muted">
          Nothing is added automatically. Every row comes back for you to commit — and anything the
          book can't match becomes a question rather than disappearing.
        </p>
      </div>

      {rows?.map((row, i) => (
        <WalkthroughRow key={`${row.raw}-${i}`} row={row} draftId={draftId} onChanged={onChanged} />
      ))}
    </div>
  );
}

function WalkthroughRow(props: { row: PbWalkthroughRow; draftId: string; onChanged: () => void }) {
  const { row, draftId, onChanged } = props;
  const [done, setDone] = useState<string | null>(null);

  const addLine = useMutation({
    mutationFn: (c: PbWalkthroughRow["candidates"][number]) =>
      api.pbAddLine(draftId, {
        itemId: c.itemId,
        quantity: row.parsedQuantity ?? 1,
        quantitySource: c.isContinuousLength ? "MEASURED_LENGTH" : "COUNT",
        difficulty: "NORMAL",
        note: `From walkthrough list: "${row.raw}"`,
      }),
    onSuccess: (_d, c) => {
      setDone(`Added ${c.itemId}`);
      onChanged();
    },
  });

  const addQuestion = useMutation({
    mutationFn: () =>
      api.pbAddQuestion(draftId, `Walkthrough item with no match in the price book: "${row.raw}"`, row.raw),
    onSuccess: () => {
      setDone("Logged as a question");
      onChanged();
    },
  });

  return (
    <div className="card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-sm">{row.raw}</div>
          <div className="text-xs text-rce-soft">
            qty {row.parsedQuantity ?? "—"} · matched on “{row.searchTerm}”
            {row.matchedOn === "single-word fallback" && " · loose match — check carefully"}
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

      {done ? (
        <p className="mt-2 text-sm text-emerald-700">{done}</p>
      ) : (
        <div className="mt-2 space-y-1">
          {row.candidates.map((c) => (
            <button
              key={c.itemId}
              className="btn btn-secondary w-full justify-start text-left"
              disabled={addLine.isPending}
              onClick={() => addLine.mutate(c)}
            >
              <span className="font-semibold">{c.itemId}</span>
              <span className="ml-2 truncate text-xs text-rce-muted">{c.description}</span>
            </button>
          ))}
          <button className="btn btn-secondary w-full" disabled={addQuestion.isPending} onClick={() => addQuestion.mutate()}>
            {row.status === "UNMATCHED" ? "Log as a question" : "None of these — log a question"}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Review: confirm / edit / reject ─────────────────────────────────────────

function ReviewTab(props: {
  draftId: string;
  review: { proposedLines: PbLine[]; confirmedLines: PbLine[]; openQuestions: Array<{ id: string; question: string; raisedBy: string }>; counts: { proposed: number; confirmed: number; openQuestions: number } } | undefined;
  computed: PbComputed | undefined;
  onChanged: () => void;
}) {
  const { draftId, review, computed, onChanged } = props;
  const [finalizeMsg, setFinalizeMsg] = useState<{ ok: boolean; reasons: string[]; warnings: string[] } | null>(null);

  const finalize = useMutation({
    mutationFn: (context: "customer" | "internal") => api.pbFinalize(draftId, context),
    onSuccess: (r) => setFinalizeMsg({ ok: r.finalized, reasons: r.reasons ?? [], warnings: r.warnings ?? [] }),
    onError: (err) => {
      // A 409 carries the engine's refusal reasons in the body. They are displayed VERBATIM —
      // the UI never re-words a refusal, because the wording is the part that tells the tech
      // what to actually do.
      const body = (err as unknown as { body?: { reasons?: string[]; warnings?: string[] } }).body;
      setFinalizeMsg({ ok: false, reasons: body?.reasons ?? [(err as Error).message], warnings: body?.warnings ?? [] });
    },
  });

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

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Confirmed lines — {review.counts.confirmed}</h3>
        {review.confirmedLines.length === 0 && <p className="text-sm text-rce-muted">Nothing confirmed yet.</p>}
        {review.confirmedLines.map((l) => {
          const c = computed?.lines.find((x) => x.itemId === l.itemId);
          return (
            <div key={l.id} className="card p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold">
                    {l.itemId} <span className="text-rce-soft">× {l.quantity}</span>
                  </div>
                  <div className="text-xs text-rce-muted line-clamp-2">{l.description}</div>
                  <div className="text-xs text-rce-soft">
                    {l.quantitySource} · {l.difficulty}
                    {l.proposedBy ? ` · from ${l.proposedBy}` : " · entered by hand"}
                    {l.editedBeforeConfirm ? " · edited before confirm" : ""}
                  </div>
                </div>
                <div className="shrink-0 text-right text-xs">
                  <div>{hours(c?.laborHours)} hr</div>
                  <div className="text-rce-soft">{money(c?.laborDollars)}</div>
                </div>
              </div>
              {c?.gaps.map((g, i) => (
                <p key={i} className="mt-1 rounded bg-amber-50 p-1.5 text-[11px] text-amber-900">
                  {g.message}
                </p>
              ))}
            </div>
          );
        })}
      </div>

      <div className="card p-3">
        <div className="flex gap-2">
          <button className="btn btn-secondary flex-1" disabled={finalize.isPending} onClick={() => finalize.mutate("internal")}>
            Check (internal)
          </button>
          <button className="btn btn-primary flex-1" disabled={finalize.isPending} onClick={() => finalize.mutate("customer")}>
            Finalize for customer
          </button>
        </div>
        {finalizeMsg && (
          <div className="mt-2 space-y-1">
            {finalizeMsg.ok && <p className="text-sm text-emerald-700">Finalized.</p>}
            {finalizeMsg.reasons.map((r, i) => (
              <p key={i} className="rounded bg-red-50 p-2 text-xs text-red-900">{r}</p>
            ))}
            {finalizeMsg.warnings.map((w, i) => (
              <p key={i} className="rounded bg-amber-50 p-2 text-xs text-amber-900">{w}</p>
            ))}
          </div>
        )}
      </div>

      <PhotoAttach draftId={draftId} />
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

// ─── Totals — displayed, never computed here ─────────────────────────────────

function TotalsBar(props: { computed: PbComputed | undefined }) {
  const c = props.computed;
  if (!c) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 p-3 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 text-sm">
        <div>
          <div className="text-xs text-rce-soft">
            {c.totalLineCount} line(s) · {hours(c.laborHours)} hr
          </div>
          <div className={c.incompleteLineCount > 0 ? "text-xs text-amber-800" : "text-xs text-emerald-700"}>
            {c.completenessSummary}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-rce-soft">
            labour {money(c.laborDollars)} · material {money(c.materialSell)}
          </div>
          <div className="text-lg font-semibold">{money(c.total)}</div>
        </div>
      </div>
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
function PhotoAttach(props: { draftId: string }) {
  return (
    <div className="card p-3">
      <h3 className="text-sm font-semibold">Photos</h3>
      <p className="mt-1 text-xs text-rce-muted">
        Walkthrough photos attach to the job record. They are <strong>not</strong> sent to the AI —
        sending customer photos to a third-party model is a separate decision Kyle has not made.
      </p>
      <p className="mt-2 text-xs text-rce-soft">
        Upload for draft {props.draftId.slice(-6)} is not wired yet (P012 seam — attach-only, no
        model egress).
      </p>
    </div>
  );
}
