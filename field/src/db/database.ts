import Dexie, { type Table } from 'dexie'
import type { CrmAssignment, Inspection, ItemResult, Property } from '../domain/types'
import { inspectionSchema, propertySchema } from '../domain/schemas'
import { mergeLegacyGroundingItems, normalizeResultState } from '../domain/compat'

export interface PhotoRecord {
  id: string
  blob: Blob
  mimeType: string
}

/**
 * A technician's work queue, cached so a lost signal mid-job doesn't strand
 * them. `cachedAt` is surfaced in the UI so nobody works from a stale list
 * without knowing it.
 */
export interface AssignmentRecord extends CrmAssignment {
  cachedAt: string
}

/** Small key-value store for things like the enrolled technician. */
export interface MetaRecord {
  key: string
  value: unknown
  updatedAt: string
}

/**
 * Rows that failed to migrate. Quarantined rather than thrown, because a parse
 * error during an upgrade would otherwise brick the app on a technician's phone
 * mid-job — and the row is usually still recoverable by hand.
 */
export interface CorruptRecord {
  id: string
  table: string
  raw: string
  error: string
  quarantinedAt: string
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

/**
 * A ledger row cached for offline reading.
 *
 * What's already known at an address is most useful in the driveway, which is
 * exactly where signal is worst. Cached on assignment sync so the technician can
 * see the open list — and, more importantly, the declined list — before opening
 * a single cover.
 */
export interface FindingRecord {
  id: string
  propertyId: string
  itemId: string
  locationKey: string
  cycle: number
  track: 'defect' | 'upgrade'
  title: string
  section: string | null
  citations: string[]
  citationsAvailable: boolean
  severity: 'FAIL' | 'MONITOR' | 'BELOW_STANDARD'
  critical: boolean
  findingText: string
  resolutionNote: string | null
  expectedEolYear: number | null
  status: string
  openedAt: string
  observedCount: number
  declinedByName: string | null
  declinedByRelation: string | null
  declinedVerbatim: string | null
  cachedAt: string
}

/**
 * A cure claim or a declination taken in the field, queued for the office.
 *
 * Separate from syncQueue because these aren't inspections — a technician can
 * cure something on an ordinary service call with no assessment in progress, and
 * that is in fact the common case.
 */
export interface FindingActionRecord {
  /** Client-generated UUID — the idempotency key for the retry. */
  actionId: string
  findingId: string
  kind: 'cure_claim' | 'declination'
  payload: string // JSON body
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
  assignments!: Table<AssignmentRecord, string>
  meta!: Table<MetaRecord, string>
  corrupt!: Table<CorruptRecord, string>
  findings!: Table<FindingRecord, string>
  findingActionQueue!: Table<FindingActionRecord, string>

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
    // v4: inspections are always tied to a CRM job, so the technician's
    // assignments are cached for offline use and pre-v4 free-typed properties
    // are retired (kept for their evidence, hidden from the picker).
    this.version(4)
      .stores({
        properties: 'id, address, jurisdictionId, createdAt, crm.visitId, legacy',
        inspections: 'id, propertyId, jurisdictionId, date, technician, status, [propertyId+date]',
        photos: 'id, mimeType',
        syncQueue: 'inspectionId, queuedAt',
        photoSyncQueue: 'photoId, inspectionId, queuedAt',
        assignments: 'visitId, assignmentId, scheduledStart, cachedAt',
        meta: 'key',
        corrupt: 'id, table, quarantinedAt',
      })
      .upgrade(async (tx) => {
        const properties = tx.table<Record<string, unknown>, string>('properties')
        const rows = await properties.toArray()
        for (const row of rows) {
          try {
            const patch: Record<string, unknown> = {}
            if (!row.crm) patch.legacy = true
            if (!row.jurisdictionSource) patch.jurisdictionSource = 'default'
            if (Object.keys(patch).length > 0) {
              await properties.update(row.id as string, patch)
            }
          } catch (error) {
            // Never throw out of an upgrade — a single bad row must not lock a
            // technician out of the app.
            await tx.table<CorruptRecord, string>('corrupt').put({
              id: String(row.id),
              table: 'properties',
              raw: JSON.stringify(row),
              error: error instanceof Error ? error.message : String(error),
              quarantinedAt: new Date().toISOString(),
            })
          }
        }
      })

    // v5: the 0-100 score is retired, ACTION is renamed FAIL, and the three
    // grounding checks are merged into C1. Indexes are unchanged — this is a
    // pure data migration on the inspections table.
    this.version(5)
      .stores({
        properties: 'id, address, jurisdictionId, createdAt, crm.visitId, legacy',
        inspections: 'id, propertyId, jurisdictionId, date, technician, status, scope, [propertyId+date]',
        photos: 'id, mimeType',
        syncQueue: 'inspectionId, queuedAt',
        photoSyncQueue: 'photoId, inspectionId, queuedAt',
        assignments: 'visitId, assignmentId, scheduledStart, cachedAt',
        meta: 'key',
        corrupt: 'id, table, quarantinedAt',
      })
      .upgrade(async (tx) => {
        const inspections = tx.table<Record<string, unknown>, string>('inspections')
        for (const row of await inspections.toArray()) {
          try {
            const rawItems = Array.isArray(row.items) ? (row.items as ItemResult[]) : []
            const items = mergeLegacyGroundingItems(
              rawItems.map((item) => ({
                ...item,
                result: normalizeResultState(item.result) as ItemResult['result'],
              })),
            )
            await inspections.update(row.id as string, {
              items,
              scope: row.scope ?? 'full',
              itemsAssessed: items.length,
              // `score` is left in place on old rows rather than deleted: the
              // record of what was delivered is worth more than a tidy column.
            })
          } catch (error) {
            await tx.table<CorruptRecord, string>('corrupt').put({
              id: String(row.id),
              table: 'inspections',
              raw: JSON.stringify(row),
              error: error instanceof Error ? error.message : String(error),
              quarantinedAt: new Date().toISOString(),
            })
          }
        }
      })

    // v6: the finding ledger. Pure store addition — no data migration, so there
    // is no .upgrade() and nothing existing to break.
    this.version(6).stores({
      properties: 'id, address, jurisdictionId, createdAt, crm.visitId, legacy',
      inspections: 'id, propertyId, jurisdictionId, date, technician, status, scope, [propertyId+date]',
      photos: 'id, mimeType',
      syncQueue: 'inspectionId, queuedAt',
      photoSyncQueue: 'photoId, inspectionId, queuedAt',
      assignments: 'visitId, assignmentId, scheduledStart, cachedAt',
      meta: 'key',
      corrupt: 'id, table, quarantinedAt',
      findings: 'id, propertyId, itemId, status, track, [propertyId+status]',
      findingActionQueue: 'actionId, findingId, kind, queuedAt',
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
