import { useEffect, useState } from 'react'
import { jurisdictions } from '../../data/jurisdictions'
import { db, saveProperty } from '../../db/database'
import {
  clearCrmSettings,
  defaultBaseUrl,
  fetchAssignments,
  getCrmSettings,
  pendingSyncCount,
  saveCrmSettings,
  type CrmAssignment,
} from '../../lib/crmSync'
import type { Property } from '../../domain/types'

interface Props {
  onStart: (property: Property, technician: string) => void
}

// Best-effort jurisdiction guess from the CRM property's city; the technician
// confirms (or corrects) on the jurisdiction screen.
function guessJurisdiction(city: string): string {
  const normalized = city.trim().toLowerCase()
  const match = jurisdictions.find((j) => j.label.toLowerCase().includes(normalized))
  return match?.id ?? 'rutherford'
}

function CrmSection({ technician, onStart }: { technician: string; onStart: Props['onStart'] }) {
  const [configured, setConfigured] = useState(getCrmSettings() !== null)
  const [showSettings, setShowSettings] = useState(false)
  // Pre-filled with the origin we were served from — the technician normally
  // only needs to paste a token. Still editable for pointing at another environment.
  const [baseUrl, setBaseUrl] = useState(getCrmSettings()?.baseUrl ?? defaultBaseUrl())
  const [token, setToken] = useState('')
  const [assignments, setAssignments] = useState<CrmAssignment[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [pending, setPending] = useState(0)

  useEffect(() => {
    void pendingSyncCount().then(setPending)
    if (configured) void loadAssignments()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured])

  async function loadAssignments() {
    try {
      setStatus('Loading assignments…')
      setAssignments(await fetchAssignments())
      setStatus(null)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not reach the CRM')
    }
  }

  async function startAssignment(assignment: CrmAssignment) {
    // Reuse the linked local property if this assignment was opened before.
    const existing = (await db.properties.toArray()).find(
      (p) => p.crm?.visitId === assignment.visitId,
    )
    if (existing) {
      onStart(existing, technician)
      return
    }
    const property: Property = {
      id: crypto.randomUUID(),
      address: assignment.address,
      jurisdictionId: guessJurisdiction(assignment.city),
      createdAt: new Date().toISOString(),
      crm: {
        visitId: assignment.visitId,
        propertyId: assignment.propertyId,
        customerId: assignment.customerId,
        customerName: assignment.customerName,
      },
    }
    await saveProperty(property)
    onStart(property, technician)
  }

  return (
    <section className="space-y-3 rounded-xl border border-sky-800 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-sky-300">CRM assignments</h2>
        <button
          type="button"
          onClick={() => setShowSettings((s) => !s)}
          className="text-xs text-slate-400 underline"
        >
          {configured ? 'connection' : 'connect'}
        </button>
      </div>

      {pending > 0 && (
        <p className="rounded bg-amber-900/50 p-2 text-xs text-amber-200">
          {pending} completed inspection{pending > 1 ? 's' : ''} queued for sync — will push
          automatically when online.
        </p>
      )}

      {showSettings && (
        <div className="space-y-2">
          <input
            className="w-full rounded-lg border border-slate-600 bg-slate-800 p-2 text-sm text-white"
            placeholder="CRM server URL (e.g. https://crm.redcedarelectric.com)"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <input
            className="w-full rounded-lg border border-slate-600 bg-slate-800 p-2 text-sm text-white"
            placeholder="Technician access token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!baseUrl.trim() || !token.trim()}
              onClick={() => {
                saveCrmSettings({ baseUrl, token })
                setToken('')
                setConfigured(true)
                setShowSettings(false)
                void loadAssignments()
              }}
              className="flex-1 rounded-lg bg-sky-700 p-2 text-sm text-white disabled:opacity-40"
            >
              Save connection
            </button>
            {configured && (
              <button
                type="button"
                onClick={() => {
                  clearCrmSettings()
                  setConfigured(false)
                  setAssignments([])
                }}
                className="rounded-lg border border-slate-600 p-2 text-sm text-slate-300"
              >
                Disconnect
              </button>
            )}
          </div>
        </div>
      )}

      {configured && (
        <>
          {status && <p className="text-xs text-slate-400">{status}</p>}
          {assignments.map((assignment) => (
            <button
              key={assignment.assignmentId}
              type="button"
              disabled={technician.trim().length === 0}
              onClick={() => void startAssignment(assignment)}
              className="block w-full rounded-lg border border-sky-900 bg-slate-800 p-3 text-left text-white disabled:opacity-40"
            >
              <span className="font-medium">{assignment.customerName}</span>
              <span className="block text-xs text-slate-400">{assignment.address}</span>
              <span className="block text-xs text-sky-300">
                {assignment.purpose}
                {assignment.scheduledStart
                  ? ` · ${new Date(assignment.scheduledStart).toLocaleDateString()}`
                  : ''}
              </span>
            </button>
          ))}
          {assignments.length === 0 && !status && (
            <p className="text-xs text-slate-500">No open assignments.</p>
          )}
          <button
            type="button"
            onClick={() => void loadAssignments()}
            className="text-xs text-sky-300 underline"
          >
            Refresh
          </button>
        </>
      )}
    </section>
  )
}

export function PropertyScreen({ onStart }: Props) {
  const [properties, setProperties] = useState<Property[]>([])
  const [address, setAddress] = useState('')
  const [jurisdictionId, setJurisdictionId] = useState(jurisdictions[0].id)
  const [technician, setTechnician] = useState('')

  useEffect(() => {
    void db.properties.toArray().then(setProperties)
  }, [])

  const canCreate = address.trim().length > 0 && technician.trim().length > 0

  async function createAndStart() {
    const property: Property = {
      id: crypto.randomUUID(),
      address: address.trim(),
      jurisdictionId,
      createdAt: new Date().toISOString(),
    }
    await saveProperty(property)
    onStart(property, technician.trim())
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-sky-300">Red Cedar Electric</p>
        <h1 className="text-2xl font-semibold text-white">Electrical Health Record</h1>
      </header>

      <label className="block space-y-1">
        <span className="text-sm text-slate-300">Technician</span>
        <input
          className="w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-white"
          value={technician}
          onChange={(e) => setTechnician(e.target.value)}
          placeholder="Your name"
        />
      </label>

      <CrmSection technician={technician} onStart={onStart} />

      {properties.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-slate-300">Existing properties</h2>
          {properties.map((property) => (
            <button
              key={property.id}
              type="button"
              disabled={technician.trim().length === 0}
              onClick={() => onStart(property, technician.trim())}
              className="block w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-left text-white disabled:opacity-40"
            >
              <span className="font-medium">{property.address}</span>
              <span className="block text-xs text-slate-400">
                {jurisdictions.find((j) => j.id === property.jurisdictionId)?.label}
              </span>
            </button>
          ))}
        </section>
      )}

      <section className="space-y-3 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h2 className="text-sm font-medium text-slate-300">New property</h2>
        <input
          className="w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-white"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Street address"
        />
        <select
          className="w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-white"
          value={jurisdictionId}
          onChange={(e) => setJurisdictionId(e.target.value)}
        >
          {jurisdictions.map((j) => (
            <option key={j.id} value={j.id}>
              {j.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!canCreate}
          onClick={() => void createAndStart()}
          className="w-full rounded-lg bg-sky-600 p-3 font-medium text-white disabled:opacity-40"
        >
          Start inspection
        </button>
      </section>
    </div>
  )
}
