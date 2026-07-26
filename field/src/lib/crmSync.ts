// CRM sync layer — connects the offline-first PWA to the Red Cedar CRM backend.
// Auth: per-technician bearer token issued by the admin (CRM Settings page).
// Pushes are idempotent (inspection UUID is the primary key server-side) and
// queued in IndexedDB so completed inspections sync automatically when a
// connection is available.

import { db, type PhotoSyncRecord, type SyncQueueRecord } from '../db/database'
import type { Inspection, Property } from '../domain/types'

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
}

export function fetchMe(): Promise<CrmTechnician> {
  return crmRequest<CrmTechnician>('/me')
}

export interface CrmAssignment {
  assignmentId: string
  assignmentStatus: string
  visitId: string
  customerId: string
  customerName: string
  propertyId: string
  address: string
  city: string
  state: string
  scheduledStart: string | null
  purpose: string
}

export function fetchAssignments(): Promise<CrmAssignment[]> {
  return crmRequest<CrmAssignment[]>('/assignments')
}

/** Build the push payload the CRM's /health-record/inspections endpoint expects. */
function buildPushPayload(inspection: Inspection, property: Property): object | null {
  if (!property.crm) return null
  return {
    inspectionId: inspection.id,
    visitId: property.crm.visitId,
    jurisdictionId: inspection.jurisdictionId,
    inspectionDate: inspection.date,
    score: inspection.score,
    itemsAssessed: inspection.itemsAssessed,
    criticalFindings: inspection.criticalFindings,
    contractorReviewed: inspection.contractorReviewed,
    items: inspection.items,
    loadCalc: inspection.loadCalc,
    appVersion: 'phase-1',
  }
}

/**
 * Queue a completed inspection for CRM sync and attempt an immediate push.
 * Photo evidence is queued alongside — every critical finding's photo must
 * reach the office record, not stay on the technician's phone.
 * No-op for properties that aren't CRM-linked (walk-up/local jobs).
 */
export async function queueInspectionSync(inspection: Inspection, property: Property): Promise<void> {
  const payload = buildPushPayload(inspection, property)
  if (!payload) return
  const record: SyncQueueRecord = {
    inspectionId: inspection.id,
    visitId: property.crm!.visitId,
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

/** Retry queued pushes whenever connectivity returns. */
export function registerSyncListener(): void {
  window.addEventListener('online', () => {
    void flushSyncQueue()
  })
}
