import Dexie, { type Table } from 'dexie'
import type { Inspection, Property } from '../domain/types'
import { inspectionSchema, propertySchema } from '../domain/schemas'

export interface PhotoRecord {
  id: string
  blob: Blob
  mimeType: string
}

/** Pending CRM push — retried until the backend accepts it (idempotent by id). */
export interface SyncQueueRecord {
  inspectionId: string
  visitId: string
  payload: string // JSON push body
  attempts: number
  lastError?: string
  queuedAt: string
}

/** Pending photo-evidence upload — retried after its inspection has synced. */
export interface PhotoSyncRecord {
  photoId: string
  inspectionId: string
  attempts: number
  lastError?: string
  queuedAt: string
}

export class HealthRecordDatabase extends Dexie {
  properties!: Table<Property, string>
  inspections!: Table<Inspection, string>
  photos!: Table<PhotoRecord, string>
  syncQueue!: Table<SyncQueueRecord, string>
  photoSyncQueue!: Table<PhotoSyncRecord, string>

  constructor() {
    super('red-cedar-health-record')
    this.version(1).stores({
      properties: 'id, address, jurisdictionId, createdAt',
      inspections: 'id, propertyId, jurisdictionId, date, technician, status, [propertyId+date]',
      photos: 'id, mimeType',
    })
    this.version(2).stores({
      properties: 'id, address, jurisdictionId, createdAt',
      inspections: 'id, propertyId, jurisdictionId, date, technician, status, [propertyId+date]',
      photos: 'id, mimeType',
      syncQueue: 'inspectionId, queuedAt',
    })
    this.version(3).stores({
      properties: 'id, address, jurisdictionId, createdAt',
      inspections: 'id, propertyId, jurisdictionId, date, technician, status, [propertyId+date]',
      photos: 'id, mimeType',
      syncQueue: 'inspectionId, queuedAt',
      photoSyncQueue: 'photoId, inspectionId, queuedAt',
    })
  }
}

export const db = new HealthRecordDatabase()

export async function saveProperty(property: Property): Promise<void> {
  propertySchema.parse(property)
  await db.properties.put(property)
}

/**
 * One versioned record per property: every saved inspection is a NEW immutable
 * version — `add` (not `put`) so an existing id can never be overwritten.
 * Completed inspections are frozen; corrections require a new version.
 */
export async function saveInspectionVersion(inspection: Inspection): Promise<void> {
  inspectionSchema.parse(inspection)
  const existing = await db.inspections.get(inspection.id)
  if (existing) {
    throw new Error(
      `Inspection ${inspection.id} already exists — inspections are immutable versions; save a new inspection instead.`,
    )
  }
  await db.inspections.add(inspection)
}

/** Drafts may be updated in place until marked complete. */
export async function saveDraft(inspection: Inspection): Promise<void> {
  inspectionSchema.parse(inspection)
  const existing = await db.inspections.get(inspection.id)
  if (existing && existing.status === 'complete') {
    throw new Error(`Inspection ${inspection.id} is complete and immutable.`)
  }
  await db.inspections.put(inspection)
}

/** All versions for a property, newest first — the year-over-year record. */
export async function getInspectionHistory(propertyId: string): Promise<Inspection[]> {
  const versions = await db.inspections.where('propertyId').equals(propertyId).toArray()
  return versions.sort((a, b) => b.date.localeCompare(a.date))
}
