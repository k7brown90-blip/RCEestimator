import { useEffect, useState } from 'react'
import type { FindingRecord } from '../../db/database'
import { fetchPropertyFindings, submitCureClaim, submitDeclination } from '../../lib/crmSync'

interface Props {
  propertyId: string
  addressLabel: string
  visitId?: string
  onBack: () => void
}

/**
 * What we already know about this house.
 *
 * Openable before starting anything, because the most expensive mistake a
 * technician can make at a repeat address is not knowing what's already been
 * said. The declined list leads for exactly that reason: re-pitching work the
 * customer already refused is worse than saying nothing.
 */

const TRACK_LABEL: Record<string, string> = {
  defect: 'Needs correction',
  upgrade: 'Recommended upgrade',
}

const SEVERITY_STYLE: Record<string, string> = {
  FAIL: 'border-red-700 bg-red-950/40',
  MONITOR: 'border-amber-700 bg-amber-950/30',
  BELOW_STANDARD: 'border-sky-800 bg-sky-950/30',
}

export function OpenFindingsScreen({ propertyId, addressLabel, visitId, onBack }: Props) {
  const [findings, setFindings] = useState<FindingRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [stale, setStale] = useState(false)
  const [cachedAt, setCachedAt] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchPropertyFindings(propertyId).then((result) => {
      if (cancelled) return
      setFindings(result.findings)
      setStale(result.stale)
      setCachedAt(result.cachedAt)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [propertyId])

  const declined = findings.filter((f) => f.status === 'declined')
  const live = findings.filter((f) => f.status !== 'declined')
  const defects = live.filter((f) => f.track === 'defect')
  const upgrades = live.filter((f) => f.track === 'upgrade')

  async function claimCure(finding: FindingRecord, workPerformed: string) {
    await submitCureClaim(finding.id, {
      workPerformed,
      performedAt: new Date().toISOString(),
      visitId,
    })
    setExpanded(null)
    const refreshed = await fetchPropertyFindings(propertyId)
    setFindings(refreshed.findings)
  }

  async function decline(finding: FindingRecord, name: string, relation: string, verbatim: string) {
    await submitDeclination(finding.id, {
      declinedByName: name,
      declinedByRelation: relation as 'owner' | 'tenant' | 'property_manager',
      declinedVerbatim: verbatim,
    })
    setExpanded(null)
    setFindings(await fetchPropertyFindings(propertyId).then((r) => r.findings))
  }

  return (
    <div className="mx-auto max-w-xl space-y-5 p-6">
      <button type="button" onClick={onBack} className="text-sm text-sky-300">
        ← Back
      </button>

      <header className="space-y-1">
        <h1 className="text-lg font-semibold text-white">What we already know</h1>
        <p className="text-xs text-slate-400">{addressLabel}</p>
        {stale && (
          <p className="rounded bg-amber-950/50 px-2 py-1 text-xs text-amber-200">
            Offline — showing the list cached
            {cachedAt ? ` ${new Date(cachedAt).toLocaleString()}` : ' earlier'}. It may have moved on.
          </p>
        )}
      </header>

      {loading && <p className="text-sm text-slate-400">Loading…</p>}

      {!loading && findings.length === 0 && (
        <p className="rounded-lg border border-slate-700 bg-slate-800/60 p-4 text-sm text-slate-300">
          Nothing on record at this address yet.
        </p>
      )}

      {declined.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">
            Already declined — do not re-pitch ({declined.length})
          </h2>
          {declined.map((finding) => (
            <div key={finding.id} className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
              <p className="text-sm font-medium text-slate-200">
                {finding.itemId}. {finding.title}
              </p>
              {finding.declinedVerbatim && (
                <p className="mt-1 text-xs italic text-slate-400">
                  “{finding.declinedVerbatim}” — {finding.declinedByName}
                  {finding.declinedByRelation ? ` (${finding.declinedByRelation.replace(/_/g, ' ')})` : ''}
                </p>
              )}
            </div>
          ))}
        </section>
      )}

      {[
        { key: 'defect', label: TRACK_LABEL.defect, list: defects },
        { key: 'upgrade', label: TRACK_LABEL.upgrade, list: upgrades },
      ].filter((group) => group.list.length > 0).map((group) => (
        <section key={group.key} className="space-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">
            {group.label} ({group.list.length})
          </h2>
          {group.list.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              open={expanded === finding.id}
              onToggle={() => setExpanded(expanded === finding.id ? null : finding.id)}
              onClaimCure={(work) => void claimCure(finding, work)}
              onDecline={(name, relation, verbatim) => void decline(finding, name, relation, verbatim)}
            />
          ))}
        </section>
      ))}
    </div>
  )
}

function FindingCard({
  finding, open, onToggle, onClaimCure, onDecline,
}: {
  finding: FindingRecord
  open: boolean
  onToggle: () => void
  onClaimCure: (workPerformed: string) => void
  onDecline: (name: string, relation: string, verbatim: string) => void
}) {
  const [mode, setMode] = useState<'none' | 'cure' | 'decline'>('none')
  const [work, setWork] = useState('')
  const [name, setName] = useState('')
  const [relation, setRelation] = useState('owner')
  const [verbatim, setVerbatim] = useState('')

  return (
    <div className={`rounded-lg border p-3 ${SEVERITY_STYLE[finding.severity] ?? 'border-slate-700 bg-slate-800/60'}`}>
      <button type="button" onClick={onToggle} className="w-full text-left">
        <span className="block text-sm font-medium text-white">
          {finding.itemId}. {finding.title}
        </span>
        <span className="block text-xs text-slate-400">
          Documented {new Date(finding.openedAt).toLocaleDateString()}
          {finding.observedCount > 1 ? ` · seen ${finding.observedCount}×` : ''}
          {finding.status === 'scheduled' ? ' · already scheduled' : ''}
          {finding.expectedEolYear ? ` · end of life ${finding.expectedEolYear}` : ''}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-3 text-xs">
          <p className="text-slate-300">{finding.findingText}</p>
          {finding.resolutionNote && (
            <p className="text-slate-400">Recommended: {finding.resolutionNote}</p>
          )}
          <p className="text-slate-500">
            {finding.citationsAvailable
              ? finding.citations.join(' · ')
              : 'Citations unavailable — this finding predates the citation record.'}
          </p>

          {mode === 'none' && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode('cure')}
                className="rounded border border-emerald-700 px-2 py-1 text-emerald-300"
              >
                I fixed this
              </button>
              <button
                type="button"
                onClick={() => setMode('decline')}
                className="rounded border border-slate-600 px-2 py-1 text-slate-300"
              >
                Customer declined
              </button>
            </div>
          )}

          {mode === 'cure' && (
            <div className="space-y-2">
              <textarea
                className="w-full rounded border border-slate-600 bg-slate-800 p-2 text-white"
                rows={3}
                placeholder="What did you do? e.g. Installed #6 Cu bar-to-bar bonding conductor."
                value={work}
                onChange={(e) => setWork(e.target.value)}
              />
              <p className="text-slate-400">
                This drafts the close-out for the licence holder to countersign. It does not close
                the finding by itself.
              </p>
              <button
                type="button"
                disabled={!work.trim()}
                onClick={() => onClaimCure(work.trim())}
                className="rounded bg-emerald-700 px-3 py-1.5 font-medium text-white disabled:bg-slate-700"
              >
                Submit claim
              </button>
            </div>
          )}

          {mode === 'decline' && (
            <div className="space-y-2">
              <input
                className="w-full rounded border border-slate-600 bg-slate-800 p-2 text-white"
                placeholder="Who declined?"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <div className="flex gap-2">
                {['owner', 'tenant', 'property_manager'].map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setRelation(option)}
                    className={`rounded border px-2 py-1 ${
                      relation === option ? 'border-sky-500 bg-sky-900/40 text-white' : 'border-slate-600 text-slate-300'
                    }`}
                  >
                    {option.replace(/_/g, ' ')}
                  </button>
                ))}
              </div>
              <textarea
                className="w-full rounded border border-slate-600 bg-slate-800 p-2 text-white"
                rows={2}
                placeholder="In their words, as close as you can get it."
                value={verbatim}
                onChange={(e) => setVerbatim(e.target.value)}
              />
              <p className="text-slate-400">
                Their words, not a summary — that is the whole value of this record.
              </p>
              <button
                type="button"
                disabled={!name.trim() || !verbatim.trim()}
                onClick={() => onDecline(name.trim(), relation, verbatim.trim())}
                className="rounded bg-slate-600 px-3 py-1.5 font-medium text-white disabled:bg-slate-700"
              >
                Record declination
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
