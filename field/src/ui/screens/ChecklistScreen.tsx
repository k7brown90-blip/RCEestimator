import type { ChecklistItemDef, ItemResult, ResultState } from '../../domain/types'

interface Props {
  items: ChecklistItemDef[]
  results: Record<string, ItemResult>
  onOpenItem: (itemId: string) => void
  onReview: () => void
}

const resultBadge: Record<ResultState, string> = {
  PASS: 'bg-emerald-700 text-emerald-100',
  MONITOR: 'bg-amber-600 text-amber-50',
  ACTION: 'bg-red-700 text-red-100',
  BELOW_STANDARD: 'bg-sky-800 text-sky-100',
  NA: 'bg-slate-600 text-slate-200',
}

export function ChecklistScreen({ items, results, onOpenItem, onReview }: Props) {
  const sections = [...new Set(items.map((item) => item.section))]
  const done = items.filter((item) => results[item.id]).length
  const allDone = done === items.length

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6 pb-24">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold text-white">Inspection checklist</h1>
        <div className="h-2 overflow-hidden rounded bg-slate-700">
          <div
            className="h-full bg-sky-500 transition-all"
            style={{ width: `${items.length === 0 ? 0 : (done / items.length) * 100}%` }}
          />
        </div>
        <p className="text-sm text-slate-400">
          {done} of {items.length} items assessed
        </p>
      </header>

      {sections.map((section) => (
        <section key={section} className="space-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">{section}</h2>
          {items
            .filter((item) => item.section === section)
            .map((item) => {
              const result = results[item.id]
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onOpenItem(item.id)}
                  className="flex w-full items-center justify-between rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-left"
                >
                  <span>
                    <span className="font-medium text-white">
                      {item.id}. {item.title}
                    </span>
                  </span>
                  {result ? (
                    <span className={`rounded px-2 py-1 text-xs font-semibold ${resultBadge[result.result]}`}>
                      {result.result === 'BELOW_STANDARD' ? 'BELOW STD' : result.result}
                    </span>
                  ) : (
                    <span className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-400">
                      open
                    </span>
                  )}
                </button>
              )
            })}
        </section>
      ))}

      <button
        type="button"
        disabled={!allDone}
        onClick={onReview}
        className="fixed inset-x-0 bottom-0 mx-auto w-full max-w-xl bg-sky-600 p-4 font-medium text-white disabled:bg-slate-700 disabled:text-slate-400"
      >
        {allDone ? 'Review findings' : `Assess all items to continue (${done}/${items.length})`}
      </button>
    </div>
  )
}
