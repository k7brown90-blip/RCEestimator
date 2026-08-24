// CRM sync layer — connects the offline-first PWA to the Red Cedar CRM backend.
// Auth: per-technician bearer token issued by the admin (CRM Settings page).
// Pushes are idempotent (inspection UUID is the primary key server-side) and
// queued in IndexedDB so completed inspections sync automatically when a
// connection is available.

import {
  db,
  type AssignmentRecord,
  type FindingRecord,
  type PhotoSyncRecord,
  type SyncQueueRecord,
} from '../db/database'
import type { CrmAssignment, Inspection, JurisdictionProfile, Property } from '../domain/types'
import { summarizeFindings } from '../domain/findings'
import { jurisdictions } from '../data/jurisdictions'
import { buildLedgerFindings } from '../domain/ledgerFindings'
import { buildReport } from '../domain/report'
import { toPushV2 } from '../domain/v2Types'

const BASE_URL_KEY = 'rce_crm_base_url'
const TOKEN_KEY = 'rce_crm_tech_token'

export interface CrmSettings {
  baseUrl: string
  token: string
}

/**
 * The PWA is served by the CRM itself (under /field), so the CRM is whatever
 * origin we were loaded from — no need to key a URL in on a phone. An explicitly
 * saved baseUrl still wins, for pointing a device at a different environment.
 */
export function defaultBaseUrl(): string {
  return window.location.origin
}

export function getCrmSettings(): CrmSettings | null {
  const baseUrl = localStorage.getItem(BASE_URL_KEY) || defaultBaseUrl()
  const token = localStorage.getItem(TOKEN_KEY)
  if (!token) return null
  return { baseUrl, token }
}

export function saveCrmSettings(settings: CrmSettings): void {
  localStorage.setItem(BASE_URL_KEY, settings.baseUrl.replace(/\/+$/, ''))
  localStorage.setItem(TOKEN_KEY, settings.token.trim())
}

export function clearCrmSettings(): void {
  localStorage.removeItem(BASE_URL_KEY)
  localStorage.removeItem(TOKEN_KEY)
}

/**
 * Enrollment via the QR code on the CRM's Team page, which encodes
 * /field/#t=<token>.
 *
 * The token arrives in the URL fragment rather than a query string because
 * fragments are never sent to the server — the credential stays out of the
 * request logs. We strip it from the URL immediately so it doesn't linger in
 * browser history or get handed on if the technician shares the address.
 *
 * Must run before React mounts: PropertyScreen reads the connection state in a
 * useState initializer, which only runs once.
 *
 * Returns true if a token was consumed from the fragment.
 */
export function consumeEnrollmentToken(): boolean {
  const hash = window.location.hash
  if (!hash) return false

  const token = new URLSearchParams(hash.slice(1)).get('t')?.trim()
  // Always clear the fragment, even on a malformed one — leaving a partial
  // credential in the address bar is worse than a no-op.
  if (hash.includes('t=')) {
    history.replaceState(null, '', window.location.pathname + window.location.search)
  }
  if (!token) return false

  // Overwrite any existing token: re-scanning is how a device is moved to a
  // different technician.
  saveCrmSettings({ baseUrl: defaultBaseUrl(), token })
  return true
}

async function crmRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const settings = getCrmSettings()
  if (!settings) throw new Error('CRM not configured')
  const response = await fetch(`${settings.baseUrl}/api/health-record${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.token}`,
      ...(init?.headers ?? {}),
    },
  })
  const body = (await response.json().catch(() => null)) as
    | { success?: boolean; data?: T; error?: { message?: string } }
    | null
  if (!response.ok || body?.success === false) {
    throw new Error(body?.error?.message ?? `CRM request failed (${response.status})`)
  }
  return body?.data as T
}

export interface CrmTechnician {
  id: string
  name: string
  role: string
  employeeNumber?: string | null
}

const ME_KEY = 'me'

/**
 * Who this device belongs to. Cached so the technician's name is available
 * offline — it goes on every report, so a dead signal can't block starting work.
 */
export async function fetchMe(): Promise<CrmTechnician> {
  const me = await crmRequest<CrmTechnician>('/me')
  await db.meta.put({ key: ME_KEY, value: me, updatedAt: new Date().toISOString() })
  return me
}

export async function cachedMe(): Promise<CrmTechnician | null> {
  const row = await db.meta.get(ME_KEY)
  return (row?.value as CrmTechnician | undefined) ?? null
}

export interface AssignmentsResult {
  assignments: CrmAssignment[]
  /** True when the network read failed and this came from the local cache. */
  stale: boolean
  cachedAt: string | null
  error?: string
}

/**
 * Refresh the technician's queue and cache it.
 *
 * On failure this returns the last cached copy rather than an error, because a
 * technician standing at a panel with no signal still needs to work. The caller
 * gets `stale: true` so the UI can say where the list came from.
 */
export async function syncAssignments(): Promise<AssignmentsResult> {
  const now = new Date().toISOString()
  try {
    const assignments = await crmRequest<CrmAssignment[]>('/assignments')
    const records: AssignmentRecord[] = assignments.map((a) => ({ ...a, cachedAt: now }))
    await db.transaction('rw', db.assignments, async () => {
      // Prune first: an assignment reassigned to someone else must disappear,
      // not linger because bulkPut only ever adds.
      await db.assignments.clear()
      if (records.length > 0) await db.assignments.bulkPut(records)
    })
    return { assignments, stale: false, cachedAt: now }
  } catch (error) {
    const cached = await db.assignments.toArray()
    return {
      assignments: cached,
      stale: true,
      cachedAt: cached[0]?.cachedAt ?? null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * The profile a record was assessed under. Falls back to the first profile only
 * so payload assembly can't throw on a phone — the jurisdiction itself came from
 * the office on the assignment, so an unknown id here means the app is older
 * than the profile list, not that the address is unknown.
 */
function profileFor(jurisdictionId: string): JurisdictionProfile {
  return jurisdictions.find((profile) => profile.id === jurisdictionId) ?? jurisdictions[0]
}

/**
 * Build the v2 push payload. `schemaVersion` is what the server and the PDF
 * generator branch on — v1 rows keep their headline score, v2 rows lead with
 * the per-result counts instead.
 *
 * `findings` carries each FAIL / MONITOR / BELOW STANDARD with its own title and
 * citations, because the server has no checklist to look them up in. See
 * domain/ledgerFindings.ts.
 */
export function buildPushPayload(inspection: Inspection, property: Property): object {
  const summary = summarizeFindings(inspection)
  const report = buildReport(inspection, profileFor(inspection.jurisdictionId))
  return {
    findings: buildLedgerFindings(report),
    inspectionId: inspection.id,
    visitId: property.crm.visitId,
    jurisdictionId: inspection.jurisdictionId,
    inspectionDate: inspection.date,
    schemaVersion: 'v2',
    scope: inspection.scope,
    itemsAssessed: summary.itemsAssessed,
    failCount: summary.failCount,
    monitorCount: summary.monitorCount,
    passCount: summary.passCount,
    belowStandardCount: summary.belowStandardCount,
    naCount: summary.naCount,
    criticalFindings: inspection.criticalFindings,
    contractorReviewed: inspection.contractorReviewed,
    items: inspection.items,
    loadCalc: inspection.loadCalc,
    // Structured protocol-v2 capture — optional; the server validates the
    // hard rules again on ingest and rejects the whole push on violation.
    ...(inspection.v2 ? { v2: toPushV2(inspection.v2) } : {}),
    // Per-section notes + on-site acknowledgment (2026-08-24). Optional on the
    // server for old bundles; this bundle always sends what it captured.
    ...(inspection.sectionNotes?.length ? { sectionNotes: inspection.sectionNotes } : {}),
    ...(inspection.acknowledgment ? { acknowledgment: inspection.acknowledgment } : {}),
    ...(inspection.ackSkippedReason ? { ackSkippedReason: inspection.ackSkippedReason } : {}),
    appVersion: 'phase-2',
  }
}

/**
 * Queue a completed inspection for CRM sync and attempt an immediate push.
 * Photo evidence is queued alongside — every critical finding's photo must
 * reach the office record, not stay on the technician's phone.
 */
export async function queueInspectionSync(inspection: Inspection, property: Property): Promise<void> {
  const payload = buildPushPayload(inspection, property)
  const record: SyncQueueRecord = {
    inspectionId: inspection.id,
    visitId: property.crm.visitId,
    payload: JSON.stringify(payload),
    attempts: 0,
    queuedAt: new Date().toISOString(),
  }
  await db.syncQueue.put(record)

  const photoIds = inspection.items.flatMap((item) => item.photoIds)
  const photoRecords: PhotoSyncRecord[] = photoIds.map((photoId) => ({
    photoId,
    inspectionId: inspection.id,
    attempts: 0,
    queuedAt: new Date().toISOString(),
  }))
  if (photoRecords.length > 0) {
    await db.photoSyncQueue.bulkPut(photoRecords)
  }
  void flushSyncQueue()
}

/** Upload one queued photo's bytes to the CRM (idempotent by photo UUID). */
async function pushPhoto(record: PhotoSyncRecord): Promise<void> {
  const settings = getCrmSettings()
  if (!settings) throw new Error('CRM not configured')
  const photo = await db.photos.get(record.photoId)
  if (!photo) {
    // Blob no longer on this device — nothing we can ever upload; drop the entry.
    await db.photoSyncQueue.delete(record.photoId)
    return
  }
  const response = await fetch(
    `${settings.baseUrl}/api/health-record/inspections/${record.inspectionId}/photos/${record.photoId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': photo.mimeType || 'image/jpeg',
        Authorization: `Bearer ${settings.token}`,
      },
      body: photo.blob,
    },
  )
  if (!response.ok) {
    throw new Error(`Photo upload failed (${response.status})`)
  }
  await db.photoSyncQueue.delete(record.photoId)
}

/** Push every queued inspection; leaves failures in the queue for retry. */
export async function flushSyncQueue(): Promise<{ pushed: number; remaining: number }> {
  if (!getCrmSettings()) {
    const remaining = await db.syncQueue.count()
    return { pushed: 0, remaining }
  }
  const pending = await db.syncQueue.orderBy('queuedAt').toArray()
  let pushed = 0
  for (const record of pending) {
    try {
      await crmRequest('/inspections', { method: 'POST', body: record.payload })
      await db.syncQueue.delete(record.inspectionId)
      pushed += 1
    } catch (error) {
      await db.syncQueue.update(record.inspectionId, {
        attempts: record.attempts + 1,
        lastError: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Photo evidence: uploaded after inspections so the server-side record exists.
  // Failures stay queued for the next flush (server 404s until the inspection lands).
  const pendingPhotos = await db.photoSyncQueue.orderBy('queuedAt').toArray()
  for (const record of pendingPhotos) {
    try {
      await pushPhoto(record)
    } catch (error) {
      await db.photoSyncQueue.update(record.photoId, {
        attempts: record.attempts + 1,
        lastError: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const remaining = await db.syncQueue.count()
  return { pushed, remaining }
}

export function pendingSyncCount(): Promise<number> {
  return db.syncQueue.count()
}

// ─── Finding ledger ─────────────────────────────────────────────────────────

export interface FindingsResult {
  findings: FindingRecord[]
  stale: boolean
  cachedAt: string | null
  error?: string
}

/**
 * What's already known at this address.
 *
 * Same degrade-to-cache contract as the assignment queue: standing in a
 * driveway with no bars, the last known list beats an error message. The caller
 * is told which it got.
 */
export async function fetchPropertyFindings(propertyId: string): Promise<FindingsResult> {
  const now = new Date().toISOString()
  const cached = () => db.findings.where('propertyId').equals(propertyId).toArray()

  try {
    const rows = await crmRequest<Omit<FindingRecord, 'cachedAt'>[]>(
      `/properties/${propertyId}/findings`,
    )
    const records: FindingRecord[] = rows.map((row) => ({ ...row, cachedAt: now }))
    await db.transaction('rw', db.findings, async () => {
      // Prune first — a finding closed at the office must disappear here, not
      // linger because bulkPut only ever adds.
      const stale = await cached()
      if (stale.length > 0) await db.findings.bulkDelete(stale.map((f) => f.id))
      if (records.length > 0) await db.findings.bulkPut(records)
    })
    return { findings: records, stale: false, cachedAt: now }
  } catch (error) {
    const rows = await cached()
    return {
      findings: rows,
      stale: true,
      cachedAt: rows[0]?.cachedAt ?? null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function cachedFindings(propertyId: string): Promise<FindingRecord[]> {
  return db.findings.where('propertyId').equals(propertyId).toArray()
}

/**
 * Claim that the technician fixed something on this visit.
 *
 * Queued, never sent directly, because the common cure happens in a crawlspace.
 * The claim does not close the finding — it drafts the close-out for the licence
 * holder to countersign. The UI says so; so does the server.
 */
export async function submitCureClaim(
  findingId: string,
  claim: { workPerformed: string; performedAt: string; visitId?: string; photoIds?: string[] },
): Promise<void> {
  const actionId = crypto.randomUUID()
  await db.findingActionQueue.put({
    actionId,
    findingId,
    kind: 'cure_claim',
    payload: JSON.stringify({ claimId: actionId, photoIds: [], ...claim }),
    attempts: 0,
    queuedAt: new Date().toISOString(),
  })
  void flushFindingActions()
}

/** Capture a refusal at the door, in the customer's own words. */
export async function submitDeclination(
  findingId: string,
  declination: {
    declinedByName: string
    declinedByRelation: 'owner' | 'tenant' | 'property_manager'
    declinedVerbatim: string
    declinedChannel?: 'in_person' | 'phone' | 'email' | 'sms'
  },
): Promise<void> {
  const actionId = crypto.randomUUID()
  await db.findingActionQueue.put({
    actionId,
    findingId,
    kind: 'declination',
    payload: JSON.stringify({ declinedChannel: 'in_person', ...declination }),
    attempts: 0,
    queuedAt: new Date().toISOString(),
  })
  // Reflect it locally so the tech doesn't re-pitch what they just recorded as
  // refused, even if the push hasn't gone out yet.
  await db.findings.update(findingId, {
    status: 'declined',
    declinedByName: declination.declinedByName,
    declinedByRelation: declination.declinedByRelation,
    declinedVerbatim: declination.declinedVerbatim,
  })
  void flushFindingActions()
}

/** Push every queued ledger action; leaves failures queued for retry. */
export async function flushFindingActions(): Promise<{ pushed: number; remaining: number }> {
  if (!getCrmSettings()) {
    return { pushed: 0, remaining: await db.findingActionQueue.count() }
  }
  const pending = await db.findingActionQueue.orderBy('queuedAt').toArray()
  let pushed = 0
  for (const record of pending) {
    const path = record.kind === 'cure_claim'
      ? `/findings/${record.findingId}/cure-claim`
      : `/findings/${record.findingId}/declination`
    try {
      await crmRequest(path, { method: 'POST', body: record.payload })
      await db.findingActionQueue.delete(record.actionId)
      pushed += 1
    } catch (error) {
      await db.findingActionQueue.update(record.actionId, {
        attempts: record.attempts + 1,
        lastError: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { pushed, remaining: await db.findingActionQueue.count() }
}

export function pendingFindingActionCount(): Promise<number> {
  return db.findingActionQueue.count()
}

// ─── Report delivery ────────────────────────────────────────────────────────

/**
 * Email the finished report to the customer, from the field (2026-08-24).
 *
 * Deliberately NOT queued offline: the server renders and sends the customer's
 * PDF, refuses an unreviewed critical report, and logs the delivery — none of
 * which should happen silently hours later from a retry queue. No signal means
 * the tech sees the failure and the office sends it from the CRM instead.
 */
export async function emailReportToCustomer(
  inspectionId: string,
): Promise<{ sentTo: string; documentId: string }> {
  return crmRequest(`/inspections/${inspectionId}/email`, { method: 'POST', body: '{}' })
}

// ─── Capacity checks ────────────────────────────────────────────────────────

export interface CapacityCheckPush {
  id: string
  visitId?: string | null
  propertyId: string
  serviceAmps: number
  floorAreaSqFt: number
  loads: unknown[]
  newLoads: unknown[]
  newLoadLabel?: string | null
}

/**
 * File a 220.83 calculation to the account.
 *
 * The server re-runs the calculation from these raw inputs rather than storing
 * the answer the phone computed — the 220.87 gate reads the stored verdict, so a
 * client that could write it could unlock a priced study by claiming failure.
 */
export async function submitCapacityCheck(
  check: CapacityCheckPush,
): Promise<{ id: string; fits: boolean; amps: number; nextStep: string }> {
  return crmRequest('/capacity-checks', {
    method: 'POST',
    body: JSON.stringify(check),
  })
}

/** Retry queued pushes whenever connectivity returns. */
export function registerSyncListener(): void {
  window.addEventListener('online', () => {
    void flushSyncQueue()
    void flushFindingActions()
  })
}
