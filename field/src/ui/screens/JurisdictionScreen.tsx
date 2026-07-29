import { useState } from 'react'
import type { JurisdictionProfile, JurisdictionSource } from '../../domain/types'

interface Props {
  profile: JurisdictionProfile
  /** How the office arrived at this jurisdiction — 'default' means it didn't. */
  source: JurisdictionSource
  address: string
  onConfirm: () => void
  onBack: () => void
}

const SOURCE_NOTE: Record<Exclude<JurisdictionSource, 'default'>, string> = {
  property: 'Set by the office for this specific address.',
  territory: 'Matched from the office territory list by ZIP code.',
  city: 'Matched from the city on file.',
}

export function JurisdictionScreen({ profile, source, address, onConfirm, onBack }: Props) {
  const overrides = Object.entries(profile.requiredOverrides)
  const unconfirmed = source === 'default'
  const [acknowledged, setAcknowledged] = useState(false)

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-white">Confirm jurisdiction</h1>
        <p className="text-sm text-slate-400">{address}</p>
      </div>

      {unconfirmed && (
        <section className="space-y-3 rounded-xl border-2 border-amber-500 bg-amber-950/60 p-4">
          <h2 className="font-semibold text-amber-200">Jurisdiction not confirmed by the office</h2>
          <p className="text-sm text-amber-100">
            Nobody has set the code jurisdiction for this address, so the app is falling back
            to {profile.label} ({`NEC ${profile.necEdition}`}). Code requirements — GFCI scope,
            AFCI, surge protection — differ between editions, so findings recorded now may cite
            the wrong rules.
          </p>
          <p className="text-sm text-amber-100">
            Ask the office to set the jurisdiction for this property, or continue and flag it
            on the report.
          </p>
          <label className="flex items-start gap-3 text-sm text-amber-100">
            <input
              type="checkbox"
              className="mt-1"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>I understand the jurisdiction is unconfirmed and will verify before delivery.</span>
          </label>
        </section>
      )}

      <section className="space-y-3 rounded-xl border border-slate-700 bg-slate-800/60 p-4 text-slate-200">
        <div className="flex items-baseline justify-between">
          <span className="text-lg font-medium text-white">{profile.label}</span>
          <span className="rounded bg-sky-900 px-2 py-1 text-sm text-sky-200">
            NEC {profile.necEdition}
          </span>
        </div>
        {!unconfirmed && (
          <p className="text-xs text-slate-400">{SOURCE_NOTE[source]}</p>
        )}
        <ul className="space-y-1 text-sm">
          <li>Surge protection (230.67): {profile.surgeRequired ? 'required' : 'not required'}</li>
          <li>Metro amendments (Section I): {profile.metroAmendments ? 'apply' : 'do not apply'}</li>
          {overrides.map(([itemId, status]) => (
            <li key={itemId}>
              Item {itemId}: {status} in this jurisdiction
            </li>
          ))}
        </ul>
        {Object.keys(profile.citationOverrides).length > 0 && (
          <p className="text-xs text-amber-300">
            Some citations for this jurisdiction are pending primary-source verification.
          </p>
        )}
      </section>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 rounded-lg border border-slate-600 p-3 text-slate-200"
        >
          Back
        </button>
        <button
          type="button"
          disabled={unconfirmed && !acknowledged}
          onClick={onConfirm}
          className="flex-1 rounded-lg bg-sky-600 p-3 font-medium text-white disabled:bg-slate-700 disabled:text-slate-400"
        >
          Confirm &amp; begin
        </button>
      </div>
    </div>
  )
}
