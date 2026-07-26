import type { JurisdictionProfile } from '../../domain/types'

interface Props {
  profile: JurisdictionProfile
  onConfirm: () => void
  onBack: () => void
}

export function JurisdictionScreen({ profile, onConfirm, onBack }: Props) {
  const overrides = Object.entries(profile.requiredOverrides)

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <h1 className="text-xl font-semibold text-white">Confirm jurisdiction</h1>

      <section className="space-y-3 rounded-xl border border-slate-700 bg-slate-800/60 p-4 text-slate-200">
        <div className="flex items-baseline justify-between">
          <span className="text-lg font-medium text-white">{profile.label}</span>
          <span className="rounded bg-sky-900 px-2 py-1 text-sm text-sky-200">
            NEC {profile.necEdition}
          </span>
        </div>
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
          onClick={onConfirm}
          className="flex-1 rounded-lg bg-sky-600 p-3 font-medium text-white"
        >
          Confirm & begin
        </button>
      </div>
    </div>
  )
}
