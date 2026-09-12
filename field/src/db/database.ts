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

/**
 * A receipt photo queued for upload — the durability fix for the 2026-09-11
 * incident, where four receipt photos were taken and discarded on failure
 * because nothing wrote them to IndexedDB first.
 *
 * `receiptId` is minted at capture time (queueReceiptUpload), not at send
 * time — the server upserts on it (health-record.ts), so every retry lands on
 * the same row and a double-flush cannot create a duplicate.
 *
 * `photoId` is the compressed copy actually uploaded; `originalPhotoId` is the
 * untouched full-resolution capture, kept until the server accepts so a bad
 * compression pass never loses the only copy.
 */
export interface ReceiptSyncRecord {
  receiptId: string
  photoId: string
  originalPhotoId: string
  visitId?: string
  purchaseOrderId?: string
  amount?: number
  vendor?: string
  category?: 'materials' | 'gas' | 'maintenance' | 'overhead' | 'permit' | 'inspection'
  attempts: number
  lastError?: string
  queuedAt: string
}

/**
 * A cached row of the barcode/SKU→material lookup (barcode/materials plan Unit 3,
 * 2026-09-12). Kyle scans in the aisle, where signal is worst, so this table must answer a
 * scan or a typed SKU instantly with no network round trip — refreshed on assignment sync
 * (lib/crmSync.ts syncMaterials), same degrade-to-cache contract as `assignments` and
 * `findings`. `upc` and `sku` are both indexed because a typed SKU must resolve exactly the
 * way a scanned barcode does, against this same cache (Kyle, 2026-09-12: "every one of them
 * has a SKU... typing a SKU must resolve a material exactly the same way scanning a barcode
 * does").
 */
export interface MaterialCacheRecord {
  id: string
  upc: string | null
  sku: string | null
  supplier: string | null
  description: string | null
  packQty: number | null
  packUnit: string | null
  lastCost: number | null
  itemId: string | null
  cachedAt: string
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
  receiptSyncQueue!: Table<ReceiptSyncRecord, string>
  materials!: Table<MaterialCacheRecord, string>

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

    // v7: the receipt-photo queue (2026-09-12, incident: four receipt photos
    // taken on 2026-09-11 were lost permanently because a failed upload
    // discarded the File instead of persisting it). Pure store addition — no
    // data migration, so there is no .upgrade() and nothing existing to break.
    this.version(7).stores({
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
      receiptSyncQueue: 'receiptId, queuedAt',
    })

    // v8: the barcode/SKU materials cache (2026-09-12, barcode/materials plan Unit 3). Pure
    // store addition — no data migration, same shape as v6/v7 — so there is no .upgrade()
    // and nothing existing to break.
    this.version(8).stores({
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
      receiptSyncQueue: 'receiptId, queuedAt',
      materials: 'id, upc, sku, itemId',
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
