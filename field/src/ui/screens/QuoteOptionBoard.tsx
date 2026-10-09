/**
 * The field Quote screen's lines, grouped by option, with Add / Remove option and drag-and-drop
 * (2026-10-08, one-estimating-system plan, Phase 1 unit 1c).
 *
 * Kyle, 2026-10-08: "If I add all the line items and then go to review and see that I made a
 * mistake and added some to option 'B' that were supposed to be on option 'C' then I can drag and
 * drop them where they need to be rather than delete and rebuild" — and the hard rule that the
 * office and the truck are ONE estimating system: whatever Estimate Intake can do to a draft's
 * options, the Quote screen can do too, through the same server functions.
 *
 *   - Lines sit under a heading per option the draft has (A, B, C plus any added). The option list
 *     comes from the payload's `optionSet`, built by the same server function as the CRM's, so this
 *     screen never works out which letters exist or which letter "Add" creates next.
 *   - Each heading shows the option's subtotal from the payload (`options[]`, server-computed).
 *     There is no money arithmetic on this screen.
 *   - An added option (D to H) with no lines still shows a heading, so it can be dropped into, and
 *     carries "Remove Option D" (the exit — nothing the app creates is permanent). A, B and C are
 *     permanent and show no such button.
 *   - "+ Add Option D" names the next letter; at H it is greyed and the reason is printed on the
 *     page (a hidden button teaches the user the feature does not exist).
 *   - Drag handle on every line. A thumb scrolling the list must never start a drag, so touch needs
 *     a press-and-hold (250 ms, small tolerance) before the line lifts; a mouse needs a few pixels;
 *     the keyboard works too (Space to lift, arrows to move, Space to drop). The per-line Option
 *     dropdown stays — it is the one-thumb way to move a line.
 *   - On drop the lines move at once and the FULL order is sent (PUT .../line-order). If the save
 *     fails the lines go back and the server's reason is printed. Nothing is left looking saved
 *     when it is not.
 *   - A refusal is printed NEXT TO the button that was pressed (under "+ Add Option", under "Remove
 *     Option D") and scrolled into view — on a phone with a long list the top of the board is
 *     off-screen, and a reason nobody can see reads as "nothing happened".
 *   - A SIGNED quote shuts all of it: Add, Remove, every handle and the naming buttons grey. The
 *     server's own sentence (optionSet.lockedReason) is printed ONCE, near the top of the Quote
 *     screen (QuoteScreen), not repeated here; each greyed control carries it as its tooltip.
 *   - Naming (Phase 2, 2026-10-08): tap an option's name on its heading to give it a name and a short
 *     description — what the customer reads on the tick boxes ("Exterior pathway lights" instead of
 *     "Option B"). Same service as the office's Review naming; an empty box clears the name.
 *   - AI-suggested lines (state PROPOSED) are not part of the order and have no handle. They are
 *     decided under "AI proposals" at the top of the Quote screen (QuoteSuggestions: Confirm / Edit &
 *     confirm / Reject, Phase 2 unit D); here each option only points at them, exactly as the CRM keeps
 *     them out of its drag list.
 *   - Like every quote call this needs signal by design (the screen's own header says so): there is
 *     no offline queue for add / remove / reorder, the same as editQuoteLine / removeQuoteLine.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { QuoteLine, QuoteState } from '../../lib/crmSync'
import { EMPTY_OPTION_TEXT, namePlaceholder, removeOptionConfirm, TOUCH_HOLD_MS, TOUCH_HOLD_TOLERANCE_PX } from '../../lib/quoteOptions'
import { suggestedPointer } from '../../lib/quoteSuggestions'
import { OPTION_HINTS, OPTION_LIMIT_REASON, optionHint, type EstimateOptionLetter } from '../../../../shared/estimateOptions'
import {
  buildColumns,
  findColumn,
  flattenOrder,
  moveToColumn,
  reorderWithin,
  sameColumns,
  type LineColumns,
  type LineOrderItem,
} from '../../../../shared/lineOrder'

const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`)

interface Props {
  quote: Pick<QuoteState, 'lines' | 'optionSet' | 'options'>
  /** Another quote call is in flight: every control here greys until it lands. */
  busy: boolean
  /** The row for one line (the screen's LineRow); the board wraps it with the drag handle. */
  renderLine: (line: QuoteLine) => ReactNode
  /** Each of these refreshes the quote itself and THROWS on refusal, so the board can print why. */
  onAddOption: () => Promise<void>
  onRemoveOption: (option: EstimateOptionLetter, expectedLines: number) => Promise<void>
  onSaveOrder: (order: LineOrderItem[]) => Promise<void>
  /** Name / describe an option. Empty strings clear it. Refreshes the quote and THROWS on refusal. */
  onSaveMeta: (option: EstimateOptionLetter, meta: { label: string; note: string }) => Promise<void>
}

export function QuoteOptionBoard({ quote, busy, renderLine, onAddOption, onRemoveOption, onSaveOrder, onSaveMeta }: Props) {
  const entries = quote.optionSet.options
  const letters = useMemo(() => entries.map((e) => e.option), [entries])
  const lineById = useMemo(() => new Map(quote.lines.map((l) => [l.id, l])), [quote.lines])
  // Only CONFIRMED lines are dragged and ordered; an AI-suggested one waits for the office.
  const confirmedLines = useMemo(() => quote.lines.filter((l) => l.state !== 'PROPOSED'), [quote.lines])
  const proposedLines = useMemo(() => quote.lines.filter((l) => l.state === 'PROPOSED'), [quote.lines])
  // What the server says: each line under its own option, in saved order (the payload is sorted).
  const serverCols = useMemo(
    () => buildColumns(letters, confirmedLines, (id) => lineById.get(id)?.option),
    [letters, confirmedLines, lineById],
  )

  // The layout while a line is being dragged, and from the drop until the save is back and the
  // quote has been refetched. Null the rest of the time (the server's layout is shown).
  const [local, setLocalState] = useState<LineColumns | null>(null)
  const localRef = useRef<LineColumns | null>(null)
  const setLocal = (next: LineColumns | null) => {
    localRef.current = next
    setLocalState(next)
  }
  const shown = local ?? serverCols
  const [activeId, setActiveId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // A refusal, and WHICH control it belongs to, so it prints beside that control.
  const [err, setErrState] = useState<{ where: string; message: string } | null>(null)
  const setErr = (where: string, e: unknown) =>
    setErrState({ where, message: e instanceof Error ? e.message : String(e) })
  const [working, setWorking] = useState(false)

  // A signed quote is shut: the server's own sentence, shown before anyone presses (nullable).
  const lockedReason = quote.optionSet.lockedReason ?? null
  const dragDisabled = busy || saving || working || Boolean(lockedReason)
  const disabledReason = lockedReason ?? 'Wait for the current change to finish'
  // The naming buttons grey while another call is in flight or the quote is signed (the tooltip says why).
  const nameDisabled = busy || saving || working || Boolean(lockedReason)

  const sensors = useSensors(
    // Mouse: a few pixels before a drag starts, so a click on the handle is not a drag.
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    // Finger: press and hold, so scrolling the list never starts a drag.
    useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_HOLD_MS, tolerance: TOUCH_HOLD_TOLERANCE_PX } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const save = async (next: LineColumns) => {
    setSaving(true)
    setErrState(null)
    try {
      // Resolves after the quote has been refetched, so the dropped layout is held on screen until
      // the server's own layout (and subtotals) are in. `serverCols` is the layout this drag
      // started from: each line carries the option it was in there (`was`), so a save from a screen
      // the office has since overtaken is refused rather than undoing the office's move.
      await onSaveOrder(flattenOrder(next, letters, serverCols))
      setLocal(null)
    } catch (e) {
      setLocal(null)
      setErr('order', e)
    } finally {
      setSaving(false)
    }
  }

  const onDragStart = (e: DragStartEvent) => {
    setErrState(null)
    setLocal(localRef.current ?? serverCols)
    setActiveId(String(e.active.id))
  }

  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e
    if (!over) return
    const cur = localRef.current ?? serverCols
    const translated = active.rect.current.translated
    const below = Boolean(translated && translated.top > over.rect.top + over.rect.height / 2)
    const next = moveToColumn(cur, String(active.id), String(over.id), below)
    if (next !== cur) setLocal(next)
  }

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    setActiveId(null)
    // Dropped on nothing: put it back.
    if (!over) {
      setLocal(null)
      return
    }
    const next = reorderWithin(localRef.current ?? serverCols, String(active.id), String(over.id))
    if (sameColumns(next, serverCols, letters)) {
      setLocal(null) // dropped where it started
      return
    }
    setLocal(next)
    void save(next)
  }

  const onDragCancel = () => {
    setActiveId(null)
    setLocal(null)
  }

  const run = async (where: string, fn: () => Promise<void>): Promise<boolean> => {
    setWorking(true)
    setErrState(null)
    try { await fn(); return true }
    catch (e) { setErr(where, e); return false }
    finally { setWorking(false) }
  }

  // Naming: which option's editor is open, and what is typed in it.
  const [naming, setNaming] = useState<{ option: EstimateOptionLetter; label: string; note: string } | null>(null)

  const next = quote.optionSet.nextOption
  const addReason = lockedReason ?? (next ? null : `${OPTION_LIMIT_REASON}.`)
  const dragging = activeId ? lineById.get(activeId) : undefined
  const overColumn = activeId ? findColumn(shown, activeId) : null

  return (
    <div className="space-y-3">
      {quote.lines.length > 0 && !lockedReason && (
        <p className="text-[11px] text-slate-400">
          Press and hold a line&apos;s <span aria-hidden="true">⋮⋮</span> handle, then drag it into order or into another option.
          Or pick its option in the line&apos;s own box.
        </p>
      )}
      {err?.where === 'order' && <ErrorNote message={err.message} />}
      {saving && <p className="text-[11px] text-slate-400">Saving the new order…</p>}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        {entries.map((entry) => {
          const opt = entry.option
          const ids = (shown[opt] ?? []).filter((id) => lineById.has(id))
          const summary = quote.options.find((o) => o.option === opt)
          return (
            <OptionSection
              key={opt}
              option={opt}
              highlighted={overColumn === opt}
              header={
                <>
                  <div className="min-w-0">
                    {/* Tap the name to name / describe the option (Phase 2). A real button: a thumb target. */}
                    <button
                      type="button"
                      disabled={nameDisabled}
                      title={nameDisabled ? disabledReason : `Name Option ${opt} and describe it for the customer`}
                      aria-label={entry.label ? `Rename Option ${opt}` : `Name Option ${opt}`}
                      onClick={() => {
                        setErrState(null)
                        setNaming(naming?.option === opt ? null : { option: opt, label: entry.label ?? '', note: entry.note ?? '' })
                      }}
                      className="min-h-[2.25rem] text-left text-sm font-semibold text-white disabled:opacity-50"
                    >
                      Option {opt}{entry.label ? <span className="font-normal text-slate-300"> — {entry.label}</span> : null}
                      <span aria-hidden="true" className="ml-1 text-xs text-sky-300">✎</span>
                    </button>
                    <div className="text-[11px] text-slate-400">{optionHint(opt, 'field')}</div>
                    {entry.note && <div className="text-[11px] text-slate-300">{entry.note}</div>}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-semibold text-emerald-300">
                      {summary && !summary.complete ? <span className="text-amber-300">incomplete</span> : money(summary?.subtotal)}
                    </div>
                    <div className="text-[11px] text-slate-400">{ids.length} line{ids.length === 1 ? '' : 's'}</div>
                  </div>
                </>
              }
              editor={
                naming?.option === opt ? (
                  <div className="space-y-2 border-b border-slate-700 bg-slate-900/40 p-3">
                    <label className="block text-[11px] text-slate-300">
                      Name for Option {opt}
                      <input
                        className="mt-1 w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
                        value={naming.label}
                        maxLength={120}
                        placeholder={namePlaceholder(opt, OPTION_HINTS[opt])}
                        onChange={(e) => setNaming({ ...naming, label: e.target.value })}
                      />
                    </label>
                    <label className="block text-[11px] text-slate-300">
                      Short description for the customer (optional)
                      <input
                        className="mt-1 w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
                        value={naming.note}
                        maxLength={400}
                        onChange={(e) => setNaming({ ...naming, note: e.target.value })}
                      />
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={nameDisabled}
                        title={nameDisabled ? disabledReason : undefined}
                        onClick={() => {
                          void run(`meta:${opt}`, () => onSaveMeta(opt, { label: naming.label.trim(), note: naming.note.trim() })).then((ok) => {
                            if (ok) setNaming(null)
                          })
                        }}
                        className="rounded-lg bg-sky-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                      >
                        Save name
                      </button>
                      <button
                        type="button"
                        onClick={() => { setNaming(null); setErrState(null) }}
                        className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200"
                      >
                        Cancel
                      </button>
                    </div>
                    <p className="text-[11px] text-slate-400">Leave both boxes empty and save to take the name off.</p>
                    {err?.where === `meta:${opt}` && <ErrorNote message={err.message} />}
                  </div>
                ) : null
              }
              footer={
                entry.removable ? (
                  <div className="space-y-1">
                    <button
                      type="button"
                      disabled={dragDisabled}
                      title={dragDisabled ? disabledReason : `Take Option ${opt} off this quote`}
                      onClick={() => {
                        if (entry.lineCount > 0 && !window.confirm(removeOptionConfirm(opt, entry.lineCount))) return
                        void run(`remove:${opt}`, () => onRemoveOption(opt, entry.lineCount))
                      }}
                      className="text-xs text-red-300 underline disabled:opacity-40"
                    >
                      Remove Option {opt}
                    </button>
                    {err?.where === `remove:${opt}` && <ErrorNote message={err.message} />}
                  </div>
                ) : null
              }
            >
              <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={dragDisabled}>
                {ids.length === 0 ? (
                  <p className="p-2 text-xs text-slate-500">{EMPTY_OPTION_TEXT}</p>
                ) : (
                  ids.map((id) => (
                    <SortableLine key={id} id={id} locked={dragDisabled} lockedReason={disabledReason}>
                      {renderLine(lineById.get(id) as QuoteLine)}
                    </SortableLine>
                  ))
                )}
              </SortableContext>
              {/* AI-suggested, not yet confirmed: no handle, not in the saved order, not priced. They are
                  decided under "AI proposals" at the top of the screen; this only says they are here. */}
              {proposedLines.filter((l) => l.option === opt).length > 0 && (
                <p className="text-[11px] text-amber-300">
                  {suggestedPointer(proposedLines.filter((l) => l.option === opt).length)}
                </p>
              )}
            </OptionSection>
          )
        })}
        <DragOverlay>
          {dragging ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-sky-500 bg-slate-800 p-3 shadow-lg">
              <span className="text-sm font-medium text-white">{dragging.description}</span>
              <span className="shrink-0 text-sm font-semibold text-emerald-300">{money(dragging.lineTotal)}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <div className="space-y-1">
        <button
          type="button"
          disabled={Boolean(addReason) || dragDisabled}
          title={addReason ?? (next ? `Start Option ${next}` : undefined)}
          onClick={() => void run('add', onAddOption)}
          className="w-full rounded-lg border border-dashed border-slate-500 p-3 text-sm font-medium text-slate-100 disabled:opacity-50"
        >
          {working ? 'Working…' : next ? `+ Add Option ${next}` : '+ Add Option'}
        </button>
        {/* The cap's reason prints here; a signed quote's reason is already printed once, at the top of the screen. */}
        {addReason && !lockedReason && <p className="text-xs text-amber-200">{addReason}</p>}
        {err?.where === 'add' && <ErrorNote message={err.message} />}
      </div>
    </div>
  )
}

/** A refusal, printed beside the control that was pressed and scrolled into view (see the header). */
function ErrorNote({ message }: { message: string }) {
  const ref = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    // jsdom has no scrollIntoView; a browser does.
    ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [message])
  return (
    <p ref={ref} role="alert" className="rounded bg-red-950/60 p-2 text-xs text-red-200">{message}</p>
  )
}

/** One option's section. The body is a drop target on its own, so an EMPTY option can take a line. */
function OptionSection(props: { option: EstimateOptionLetter; highlighted: boolean; header: ReactNode; editor: ReactNode; footer: ReactNode; children: ReactNode }) {
  const { setNodeRef } = useDroppable({ id: props.option })
  return (
    <section
      aria-label={`Option ${props.option} lines`}
      className={`rounded-lg border ${props.highlighted ? 'border-sky-400 ring-2 ring-sky-400' : 'border-slate-700'}`}
    >
      <header className="flex items-baseline justify-between gap-2 border-b border-slate-700 bg-slate-900/60 px-3 py-2">
        {props.header}
      </header>
      {props.editor}
      <div ref={setNodeRef} className="min-h-[3rem] space-y-2 p-2">
        {props.children}
      </div>
      {props.footer && <div className="border-t border-slate-700 px-3 py-2">{props.footer}</div>}
    </section>
  )
}

/** A line with its drag handle. The handle greys, with the reason in its tooltip, while dragging is off. */
function SortableLine(props: { id: string; locked: boolean; lockedReason: string; children: ReactNode }) {
  const { id, locked, lockedReason, children } = props
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: locked,
  })
  const title = locked ? lockedReason : 'Press and hold, then drag to reorder or move to another option'
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      // The line's old place stays as a dashed marker while its copy travels with the finger.
      className={`flex items-stretch gap-1 rounded-lg ${isDragging ? 'opacity-40 outline-2 outline-dashed outline-sky-400' : ''}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...(locked ? {} : listeners)}
        aria-label={title}
        title={title}
        // touch-manipulation, NOT touch-none: until the hold completes the finger must still be
        // able to scroll the page. Once the line has lifted, dnd-kit stops the scroll itself.
        className={`flex w-9 shrink-0 touch-manipulation select-none items-center justify-center rounded text-lg leading-none ${
          locked ? 'cursor-not-allowed text-slate-600' : 'cursor-grab text-slate-300 active:cursor-grabbing'
        }`}
      >
        <span aria-hidden="true">⋮⋮</span>
      </button>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
