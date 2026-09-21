/**
 * RUN DIAGNOSTICS — one circuit, breaker to last outlet.
 *
 * Kyle, 2026-09-20: "he pulls up the diagnostics or run diagnostics, and can
 * click and add outlet button. This adds an outlet systematically as he is doing
 * the diagnostics, does the measurements at the outlet, takes the pictures,
 * notes if anything was fixed, and moves onto the next one."
 *
 * The screen is built around that sentence. There is no pre-built list of N
 * empty rows to fill in: there is one button, and it adds the box he is standing
 * at. Everything is saved locally the instant it is typed and pushed when there
 * is signal, so the basement is not a special case — see lib/diagnosticSync.ts.
 *
 * The coverage banner sits at the top the whole time, showing the exact sentence
 * that will print on the homeowner's report. That is the warranty defence, and a
 * technician should see it being earned rather than discover it afterwards.
 */

import { useEffect, useState } from 'react'
import {
  DEVICE_LABEL,
  DEVICE_TYPES,
  DIFFICULTY_LABEL,
  DIFFICULTY_TIERS,
  type DiagnosticDeviceType,
} from '../../../../shared/diagnostics'
import type { DiagnosticRecord } from '../../db/database'
import {
  buildResolutions,
  captureOutletPhoto,
  deleteDiagnostic,
  emailDiagnosticToCustomer,
  emptyOutlet,
  fetchDiagnosticContext,
  flushDiagnosticQueue,
  getDiagnostic,
  localCoverageStatement,
  localDiagnosticsForVisit,
  localMoneySummary,
  pendingDiagnosticCount,
  readyToComplete,
  removeOutletPhoto,
  saveDiagnostic,
  startDiagnostic,
  voidDiagnostic,
  type DiagnosticOutletPayload,
} from '../../lib/diagnosticSync'

const box = 'w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white placeholder:text-slate-500'
const label = 'text-[11px] uppercase tracking-wide text-slate-400'

export function DiagnosticScreen({
  visitId,
  customerName,
  jobPurpose,
  onBack,
  onOpenDraft,
}: {
  visitId: string
  customerName: string
  /** What the office booked this visit for — the default complaint, typed once. */
  jobPurpose?: string | null
  onBack: () => void
  /** Hand the resolutions draft to the quote screen. */
  onOpenDraft?: (draftId: string) => void
}) {
  const [record, setRecord] = useState<DiagnosticRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ reports: number; photos: number }>({ reports: 0, photos: 0 })

  // ── Starting one ──
  const [complaint, setComplaint] = useState(jobPurpose ?? '')
  const [circuitLabel, setCircuitLabel] = useState('')
  const [circuitNumber, setCircuitNumber] = useState('')
  const [panelLocation, setPanelLocation] = useState('')
  const [breakerRating, setBreakerRating] = useState('')
  const [quoted, setQuoted] = useState({ NORMAL: 0, DIFFICULT: 0, VERY_DIFFICULT: 0 })
  const [itemId, setItemId] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<{ itemId: string; description: string; quantity: number }[]>([])
  const [contextNote, setContextNote] = useState<string | null>(null)

  const refreshPending = () => { void pendingDiagnosticCount().then(setPending) }

  // Resume an unfinished walk on this visit before offering to start a new one —
  // a second report for the same circuit is the one mistake this screen can make.
  useEffect(() => {
    let cancelled = false
    void localDiagnosticsForVisit(visitId).then((rows) => {
      if (cancelled) return
      const live = rows.find((r) => r.status === 'in_progress') ?? rows[0]
      if (live) setRecord(live)
    })
    refreshPending()
    return () => { cancelled = true }
  }, [visitId])

  // The quoted counts, pre-filled from the signed estimate. A PRE-FILL, never
  // the authority: the issued document does not carry the access tier, so these
  // are derived from the draft behind it and the tech confirms them here.
  useEffect(() => {
    if (record) return
    let cancelled = false
    void fetchDiagnosticContext(visitId)
      .then((ctx) => {
        if (cancelled) return
        setQuoted(ctx.quoted)
        setItemId(ctx.diagnosticItemId)
        setCandidates(ctx.candidates)
        setContextNote(
          ctx.source === 'none'
            ? ctx.candidates.length > 0
              ? 'No diagnostic line was recognised on the signed estimate — pick the item it was quoted under, or leave it blank.'
              : 'Nothing signed on this job yet. The report still stands; there is just no quoted count to compare against.'
            : `Quoted on ${ctx.estimateNumber}.`,
        )
      })
      .catch(() => { if (!cancelled) setContextNote('No signal — type the quoted counts from the signed estimate.') })
    return () => { cancelled = true }
  }, [visitId, record])

  const update = async (patch: Partial<DiagnosticRecord>) => {
    if (!record) return
    const next = { ...record, ...patch }
    setRecord(next)
    await saveDiagnostic(next)
    refreshPending()
  }

  const updateOutlet = async (outletId: string, patch: Partial<DiagnosticOutletPayload>) => {
    if (!record) return
    await update({ outlets: record.outlets.map((o) => (o.id === outletId ? { ...o, ...patch } : o)) })
  }

  const addOutlet = async () => {
    if (!record) return
    await update({ outlets: [...record.outlets, emptyOutlet(record.outlets.length + 1)] })
  }

  const removeOutlet = async (outletId: string) => {
    if (!record) return
    if (!window.confirm('Remove this outlet from the report?')) return
    await update({
      outlets: record.outlets
        .filter((o) => o.id !== outletId)
        .map((o, i) => ({ ...o, sequence: i + 1 })),
    })
  }

  // ── No report yet: the start form ──
  if (!record) {
    return (
      <div className="mx-auto max-w-xl space-y-4 p-6 pb-16">
        <button type="button" onClick={onBack} className="text-sm text-sky-300">← Job</button>
        <header>
          <h1 className="text-xl font-semibold text-white">Run diagnostics</h1>
          <p className="text-sm text-slate-300">{customerName}</p>
        </header>

        <section className="space-y-3 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
          <div>
            <p className={label}>What they called about</p>
            <textarea className={box} rows={2} value={complaint} onChange={(e) => setComplaint(e.target.value)}
              placeholder="Half the kitchen and the dining room are dead" />
          </div>
          <div>
            <p className={label}>The circuit</p>
            <input className={box} value={circuitLabel} onChange={(e) => setCircuitLabel(e.target.value)}
              placeholder="Kitchen / dining small-appliance circuit" />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <p className={label}>Breaker #</p>
              <input className={box} value={circuitNumber} onChange={(e) => setCircuitNumber(e.target.value)} placeholder="2" />
            </div>
            <div className="flex-1">
              <p className={label}>Rating</p>
              <input className={box} value={breakerRating} onChange={(e) => setBreakerRating(e.target.value)} placeholder="20A" />
            </div>
          </div>
          <div>
            <p className={label}>Panel location</p>
            <input className={box} value={panelLocation} onChange={(e) => setPanelLocation(e.target.value)} placeholder="Garage, north wall" />
          </div>
        </section>

        <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
          <h2 className="text-sm font-semibold text-white">Outlets quoted, by access</h2>
          <p className="text-[11px] text-slate-500">
            The quote sizes the circuit. What the circuit actually holds is what you find — anything
            past these counts is added at its own tier on the change order.
          </p>
          {contextNote && <p className="rounded bg-slate-900 p-2 text-[11px] text-slate-300">{contextNote}</p>}
          <div className="flex gap-2">
            {DIFFICULTY_TIERS.map((tier) => (
              <div key={tier} className="flex-1">
                <p className={label}>{DIFFICULTY_LABEL[tier]}</p>
                <input
                  type="number" min={0} className={box} value={quoted[tier]}
                  onChange={(e) => setQuoted({ ...quoted, [tier]: Math.max(0, Number(e.target.value) || 0) })}
                />
              </div>
            ))}
          </div>
          {candidates.length > 0 && (
            <div>
              <p className={label}>Quoted under</p>
              <select className={box} value={itemId ?? ''} onChange={(e) => setItemId(e.target.value || null)}>
                <option value="">— not quoted per outlet —</option>
                {candidates.map((c) => (
                  <option key={c.itemId} value={c.itemId}>{c.description} ({c.itemId})</option>
                ))}
              </select>
            </div>
          )}
        </section>

        {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
        <button
          type="button"
          disabled={busy || !complaint.trim() || !circuitLabel.trim()}
          onClick={() => {
            setBusy(true); setError(null)
            startDiagnostic({
              visitId,
              complaint: complaint.trim(),
              circuitLabel: circuitLabel.trim(),
              circuitNumber: circuitNumber.trim() || null,
              panelLocation: panelLocation.trim() || null,
              breakerRating: breakerRating.trim() || null,
              diagnosticItemId: itemId,
              quoted,
            })
              .then(setRecord)
              .catch((err) => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(false))
          }}
          className="w-full rounded-lg bg-sky-600 p-3 text-sm font-semibold text-white disabled:opacity-40"
        >
          {busy ? 'Starting…' : 'Start the diagnostic'}
        </button>
        <p className="text-[11px] text-slate-500">
          Nothing here needs signal. The report is saved on this phone as you go and files itself when
          you have bars.
        </p>
      </div>
    )
  }

  // ── The walk ──
  const money = localMoneySummary(record)
  const blockers = readyToComplete(record)
  const isComplete = record.status === 'complete'

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6 pb-16">
      <button type="button" onClick={onBack} className="text-sm text-sky-300">← Job</button>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-white">{record.circuitLabel}</h1>
        <p className="text-sm text-slate-300">{customerName} · {record.complaint}</p>
      </header>

      {/* ── THE COVERAGE BANNER. The sentence that prints on the homeowner's
          report, visible the whole time it is being earned. ── */}
      <section className={`space-y-2 rounded-xl border p-3 ${
        record.coverage === 'whole_circuit' ? 'border-emerald-700 bg-emerald-950/40' : 'border-amber-700 bg-amber-950/30'
      }`}>
        <p className="text-xs text-slate-100">{localCoverageStatement(record)}</p>
        <label className="flex items-center gap-2 text-xs text-slate-200">
          <input type="checkbox" checked={record.breakerInspected}
            onChange={(e) => void update({ breakerInspected: e.target.checked })} />
          Breaker inspected
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-200">
          <input
            type="checkbox"
            checked={record.coverage === 'partial'}
            onChange={(e) => void update({ coverage: e.target.checked ? 'partial' : 'whole_circuit' })}
          />
          I could not walk the whole circuit
        </label>
        {record.coverage === 'partial' && (
          <textarea
            className={box} rows={2} value={record.coverageNote ?? ''}
            onChange={(e) => void update({ coverageNote: e.target.value || null })}
            placeholder="Where it stopped and why — finished wall, customer stopped us, no access to the crawlspace"
          />
        )}
      </section>

      <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-3 text-xs text-slate-300">
        <p>
          <strong className="text-white">{money.examinedTotal}</strong> examined
          {money.quotedTotal > 0 && <> · {money.quotedTotal} quoted</>}
          {money.overageTotal > 0 && (
            <span className="text-amber-200"> · {money.overageTotal} beyond the quote</span>
          )}
        </p>
        {money.overageTotal > 0 && (
          <p className="pt-1 text-[11px] text-slate-400">
            {DIFFICULTY_TIERS.filter((t) => money.overage[t] > 0)
              .map((t) => `${money.overage[t]}× ${DIFFICULTY_LABEL[t]}`)
              .join(' · ')} — these go on the change order at their own tier.
          </p>
        )}
        <p className="pt-1 text-[11px] text-slate-500">
          {pending.reports + pending.photos === 0
            ? record.syncedAt ? '✓ Filed with the office.' : 'Saved on this phone.'
            : `Saved on this phone · ${pending.reports} report${pending.reports === 1 ? '' : 's'} and ${pending.photos} photo${pending.photos === 1 ? '' : 's'} waiting for signal.`}
        </p>
      </section>

      {/* ── The outlets, one at a time ── */}
      {record.outlets.map((outlet) => (
        <OutletCard
          key={outlet.id}
          outlet={outlet}
          onChange={(patch) => void updateOutlet(outlet.id, patch)}
          onPhoto={(file) => {
            setError(null)
            void captureOutletPhoto(record.reportId, outlet.id, file)
              .then(() => getDiagnostic(record.reportId).then((r) => { if (r) setRecord(r) }))
              .then(refreshPending)
              .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          }}
          onRemovePhoto={(photoId) => {
            void removeOutletPhoto(record.reportId, outlet.id, photoId)
              .then(() => getDiagnostic(record.reportId).then((r) => { if (r) setRecord(r) }))
              .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          }}
          onRemove={() => void removeOutlet(outlet.id)}
        />
      ))}

      {!isComplete && (
        <button type="button" onClick={() => void addOutlet()}
          className="w-full rounded-lg bg-sky-600 p-3 text-sm font-semibold text-white">
          + Add outlet
        </button>
      )}

      <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <p className={label}>What was wrong, and what you did</p>
        <textarea className={box} rows={3} value={record.summary ?? ''}
          onChange={(e) => void update({ summary: e.target.value || null })}
          placeholder="Loose neutral at the third receptacle; re-terminated and re-tested the run." />
      </section>

      {said && <p className="rounded bg-slate-800 p-2 text-xs text-emerald-200">{said}</p>}
      {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}

      {/* ── Finish, send, quote the resolutions ── */}
      <section className="space-y-2 rounded-xl border border-amber-800 bg-amber-950/20 p-4">
        <h2 className="text-sm font-semibold text-amber-200">Finish up</h2>
        {blockers.length > 0 && !isComplete && (
          <ul className="space-y-1 text-[11px] text-amber-200">
            {blockers.map((b) => <li key={b}>⚠ {b}</li>)}
          </ul>
        )}
        {!isComplete ? (
          <button
            type="button"
            disabled={busy || blockers.length > 0}
            onClick={() => {
              setBusy(true); setError(null)
              void update({ status: 'complete' })
                .then(() => flushDiagnosticQueue())
                .then(() => { setSaid('Diagnostic marked complete. It files with the office as soon as you have signal.'); refreshPending() })
                .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                .finally(() => setBusy(false))
            }}
            className="w-full rounded-lg bg-emerald-700 p-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            Mark the circuit finished
          </button>
        ) : (
          <>
            <p className="rounded bg-emerald-900/50 p-2 text-xs text-emerald-200">
              ✓ Circuit finished — {money.examinedTotal} outlets on the record.
            </p>
            <button
              type="button" disabled={busy}
              onClick={() => {
                setBusy(true); setError(null); setSaid(null)
                emailDiagnosticToCustomer(record.reportId)
                  .then((r) => setSaid(`Report emailed to ${r.sentTo}.`))
                  .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setBusy(false))
              }}
              className="w-full rounded-lg bg-sky-700 p-3 text-sm font-medium text-white disabled:opacity-40"
            >
              📧 Send the report to the homeowner
            </button>
            <button
              type="button" disabled={busy}
              onClick={() => {
                setBusy(true); setError(null); setSaid(null)
                buildResolutions(record.reportId)
                  .then((r) => {
                    setSaid(
                      [
                        r.isChangeOrder ? `Change order on ${r.changeOrderFor} ${r.resumed ? 'reopened' : 'raised'}.` : 'Estimate raised.',
                        r.seeded.length > 0 ? `${r.seeded.reduce((n, s) => n + s.quantity, 0)} overage outlet(s) priced.` : null,
                        r.defects.length > 0 ? `${r.defects.length} defective item(s) written into the scope — price them on the quote.` : null,
                        r.note,
                      ].filter(Boolean).join(' '),
                    )
                    onOpenDraft?.(r.draftId)
                  })
                  .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setBusy(false))
              }}
              className="w-full rounded-lg bg-emerald-800 p-3 text-sm font-medium text-white disabled:opacity-40"
            >
              🧾 Build the resolutions change order
            </button>
            <p className="text-[11px] text-slate-400">
              Wiring you fixed during the diagnostic is already paid for and never goes on this. Damaged
              or defective equipment does.
            </p>
          </>
        )}

        {/* Kyle's standing rule: nothing the app creates is permanent. */}
        <div className="flex gap-2 pt-2">
          <button
            type="button" disabled={busy}
            onClick={() => {
              const reason = window.prompt('Void this diagnostic — why?')
              if (!reason?.trim()) return
              setBusy(true); setError(null)
              voidDiagnostic(record.reportId, reason.trim())
                .then(() => { setRecord(null); setSaid('Diagnostic voided. The record is kept as it was.') })
                .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                .finally(() => setBusy(false))
            }}
            className="flex-1 rounded-lg border border-slate-600 p-2 text-xs text-slate-300 disabled:opacity-40"
          >
            Void with a reason
          </button>
          <button
            type="button" disabled={busy}
            onClick={() => {
              if (!window.confirm('Delete this diagnostic entirely? Only possible while the homeowner has not been sent it.')) return
              setBusy(true); setError(null)
              deleteDiagnostic(record.reportId)
                .then(() => { setRecord(null); setSaid('Diagnostic deleted.') })
                .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                .finally(() => setBusy(false))
            }}
            className="flex-1 rounded-lg border border-red-900 p-2 text-xs text-red-300 disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </section>
    </div>
  )
}

/** One box: what is in it, what it read, what was found, what was fixed, and a photo. */
function OutletCard({
  outlet,
  onChange,
  onPhoto,
  onRemovePhoto,
  onRemove,
}: {
  outlet: DiagnosticOutletPayload
  onChange: (patch: Partial<DiagnosticOutletPayload>) => void
  onPhoto: (file: File) => void
  onRemovePhoto: (photoId: string) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(!outlet.locationLabel)
  return (
    <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
      <div className="flex items-start justify-between gap-2">
        <button type="button" className="flex-1 text-left" onClick={() => setOpen((o) => !o)}>
          <p className="text-sm font-semibold text-white">
            {outlet.sequence}. {outlet.locationLabel || 'New outlet'}
          </p>
          <p className="text-[11px] text-slate-400">
            {outlet.deviceType === 'other' ? (outlet.deviceLabel || 'Other') : DEVICE_LABEL[outlet.deviceType]}
            {' · '}{DIFFICULTY_LABEL[outlet.difficulty]}
            {' · '}{outlet.photoIds.length === 0 ? '⚠ no photo' : `${outlet.photoIds.length} photo${outlet.photoIds.length === 1 ? '' : 's'}`}
            {outlet.equipmentDefective && ' · defective equipment'}
          </p>
        </button>
        <button type="button" onClick={onRemove} className="text-xs text-red-300">remove</button>
      </div>

      {open && (
        <div className="space-y-3 border-t border-slate-700 pt-3">
          <div>
            <p className={label}>Where</p>
            <input className={box} value={outlet.locationLabel}
              onChange={(e) => onChange({ locationLabel: e.target.value })}
              placeholder="Kitchen, east wall by the fridge" />
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <p className={label}>What is installed</p>
              <select className={box} value={outlet.deviceType}
                onChange={(e) => onChange({ deviceType: e.target.value as DiagnosticDeviceType })}>
                {DEVICE_TYPES.map((t) => <option key={t} value={t}>{DEVICE_LABEL[t]}</option>)}
              </select>
            </div>
            <div className="flex-1">
              <p className={label}>Access</p>
              <select className={box} value={outlet.difficulty}
                onChange={(e) => onChange({ difficulty: e.target.value as DiagnosticOutletPayload['difficulty'] })}>
                {DIFFICULTY_TIERS.map((t) => <option key={t} value={t}>{DIFFICULTY_LABEL[t]}</option>)}
              </select>
            </div>
          </div>
          {outlet.deviceType === 'other' && (
            <input className={box} value={outlet.deviceLabel ?? ''}
              onChange={(e) => onChange({ deviceLabel: e.target.value || null })}
              placeholder="What is it? Doorbell transformer, range hood…" />
          )}

          <div className="flex gap-2">
            <div className="flex-1">
              <p className={label}>Enclosure</p>
              <input className={box} value={outlet.enclosure ?? ''}
                onChange={(e) => onChange({ enclosure: e.target.value || null })} placeholder="4-square metal" />
            </div>
            <div className="w-20">
              <p className={label}>Gangs</p>
              <input type="number" min={0} className={box} value={outlet.gangs ?? ''}
                onChange={(e) => onChange({ gangs: e.target.value === '' ? null : Number(e.target.value) })} />
            </div>
            <div className="w-24">
              <p className={label}>Circuit #</p>
              <input className={box} value={outlet.circuitNumber ?? ''}
                onChange={(e) => onChange({ circuitNumber: e.target.value || null })} placeholder="2" />
            </div>
          </div>

          <div>
            <p className={label}>Voltage</p>
            <div className="flex gap-2">
              <input type="number" className={box} value={outlet.vPhaseGround ?? ''} placeholder="Ø–G"
                onChange={(e) => onChange({ vPhaseGround: e.target.value === '' ? null : Number(e.target.value) })} />
              <input type="number" className={box} value={outlet.vPhaseNeutral ?? ''} placeholder="Ø–N"
                onChange={(e) => onChange({ vPhaseNeutral: e.target.value === '' ? null : Number(e.target.value) })} />
              <input type="number" className={box} value={outlet.vPhasePhase ?? ''} placeholder="Ø–Ø (240 V)"
                onChange={(e) => onChange({ vPhasePhase: e.target.value === '' ? null : Number(e.target.value) })} />
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-200">
            <input type="checkbox" checked={outlet.terminationsTightened}
              onChange={(e) => onChange({ terminationsTightened: e.target.checked })} />
            Terminations tightened
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-200">
            <input type="checkbox" checked={outlet.corrosion}
              onChange={(e) => onChange({ corrosion: e.target.checked })} />
            Corrosion or rust
          </label>
          {outlet.corrosion && (
            <input className={box} value={outlet.corrosionNote ?? ''}
              onChange={(e) => onChange({ corrosionNote: e.target.value || null })}
              placeholder="Where, and how bad" />
          )}

          <div>
            <p className={label}>What you found</p>
            <textarea className={box} rows={2} value={outlet.findings ?? ''}
              onChange={(e) => onChange({ findings: e.target.value || null })} />
          </div>
          <div>
            <p className={label}>What you fixed here — included in the diagnostic</p>
            <textarea className={box} rows={2} value={outlet.fixed ?? ''}
              onChange={(e) => onChange({ fixed: e.target.value || null })}
              placeholder="Re-terminated the neutral on the line side" />
          </div>

          <label className="flex items-center gap-2 text-xs text-amber-200">
            <input type="checkbox" checked={outlet.equipmentDefective}
              onChange={(e) => onChange({ equipmentDefective: e.target.checked })} />
            Device / fixture / equipment is damaged or defective
          </label>
          {outlet.equipmentDefective && (
            <>
              <textarea className={box} rows={2} value={outlet.defectDescription ?? ''}
                onChange={(e) => onChange({ defectDescription: e.target.value || null })}
                placeholder="Receptacle body cracked, contacts burned — will not hold a plug" />
              <p className="text-[11px] text-amber-300">
                This is not part of the diagnostic price. It goes on the resolutions change order.
              </p>
            </>
          )}

          <div className="space-y-1">
            <p className={label}>Photo — required</p>
            <input
              type="file" accept="image/*" capture="environment"
              className="w-full text-xs text-slate-300"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) onPhoto(file)
                e.target.value = ''
              }}
            />
            {outlet.photoIds.length === 0 ? (
              <p className="text-[11px] text-amber-300">An outlet with no photo is a claim, not a record.</p>
            ) : (
              <ul className="space-y-0.5">
                {outlet.photoIds.map((id, i) => (
                  <li key={id} className="flex items-center justify-between text-[11px] text-slate-300">
                    <span>Photo {i + 1}</span>
                    <button type="button" className="text-red-300" onClick={() => onRemovePhoto(id)}>remove</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
