import Dexie, { type Table } from 'dexie'
import type { CrmAssignment, Inspection, ItemResult, Property } from '../domain/types'
import { inspectionSchema, propertySchema } from '../domain/schemas'
import { mergeLegacyGroundingItems, normalizeResultState } from '../domain/compat'
import type { DiagnosticCoverage, DiagnosticOutletPayload } from '../../../shared/diagnostics'
import type { FieldCatalogRow } from '../../../shared/quoteCatalog'
import type { EstimateOptionLetter } from '../../../shared/estimateOptions'
// Type-only (erased at build): the mirror holds the quote payload exactly as crmSync types it.
// crmSync imports this module for `db`; a runtime import the other way would be a cycle, a type
// import is not.
import type { QuoteState } from '../lib/crmSync'

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

/**
 * A circuit diagnostic, held on the phone while the walk happens (2026-09-20).
 *
 * The whole report — head plus every outlet — lives in ONE row because that is
 * how it is pushed: one idempotent POST whose outlets sync by their own ids. A
 * technician in a basement with no signal keeps adding outlets to this row; the
 * queue drains when the bars come back. Nothing about the capture depends on
 * being online, which is the point.
 */
export interface DiagnosticRecord {
  reportId: string
  visitId: string
  reportDate: string
  complaint: string
  circuitLabel: string
  circuitNumber: string | null
  panelLocation: string | null
  breakerRating: string | null
  breakerInspected: boolean
  coverage: DiagnosticCoverage
  coverageNote: string | null
  summary: string | null
  diagnosticItemId: string | null
  quotedNormal: number
  quotedDifficult: number
  quotedVeryDifficult: number
  status: 'in_progress' | 'complete'
  outlets: DiagnosticOutletPayload[]
  /** Set once the server has accepted this exact revision — drives "saved / waiting". */
  syncedAt: string | null
  updatedAt: string
}

/** Pending diagnostic push — retried until the backend accepts it (idempotent by reportId). */
export interface DiagnosticSyncRecord {
  reportId: string
  visitId: string
  payload: string
  attempts: number
  lastError?: string
  queuedAt: string
}

/**
 * A diagnostic photo queued for upload. Same durability contract as the receipt
 * queue and for the same reason (2026-09-11): the blob is written to db.photos
 * and this row BEFORE any network call, and the row is deleted only on a 2xx.
 * An outlet cannot be recorded without a photo, so losing one loses the proof
 * that the box was ever opened.
 */
export interface DiagnosticPhotoRecord {
  photoId: string
  reportId: string
  attempts: number
  lastError?: string
  queuedAt: string
}

/*
  ── ESTIMATING WITH NO SIGNAL (Phase 7, one-estimating-system plan, 2026-10-09) ──────────────────

  Kyle, 2026-09-22: "They would have to be able to do estimates and even the diagnostics,
  electrical assessment, without service." Four stores, Dexie v10, pure addition. The phone keeps
  a record of what the tech DID; the server sets every firm price and records every signature.

  NEVER ON THIS PHONE (pinned by key-set tests on the server routes that feed these stores, and by
  the source guard in tests/financingEstimator.test.ts, which is why none of the column names is
  spelled out here): labour hours or dollars, a labour unit basis, the billed labour rate, any
  company cost or cost basis, the per-unit sell price, supplier prices, markup tiers, Synchrony's
  discount rate or any other Synchrony rate. A phone is handed to the customer. What lands here is
  words, yes/no badges, the server's own customer figures, and the tech's edits.
*/

/**
 * One row of the price book as the picker sees it with no signal: the SAME `FieldCatalogRow` the
 * online picker is handed (shared/quoteCatalog.ts), plus its place in the server's order so the
 * offline list reads in the order the online one does (the server orders by itemId in the
 * database's collation; a JavaScript sort can differ for mixed-case codes — U2 finding).
 * The snapshot's version, time and section cards live in `meta` under QUOTE_CATALOG_META_KEY.
 */
export interface QuoteCatalogRecord extends FieldCatalogRow {
  position: number
}

/**
 * The last server answer to GET /quotes/:draftId for one quote — the exact payload the online
 * screen renders, saved so the screen can render it with no signal and overlay the tech's waiting
 * edits on it (lib/quoteSync.ts overlayQuote).
 *
 * `origin` 'phone' means the office has never received this quote (it was started with no
 * signal); 'server' means the payload came from the office. `visitId` is null when the save came
 * from a plain fetchQuote (the payload does not carry it); the flush and the assignment-sync cache
 * pass always know it and set it.
 */
export interface QuoteMirrorRecord {
  draftId: string
  visitId: string | null
  payload: QuoteState
  snapshotAt: string
  origin: 'phone' | 'server'
  /** Set when queued edits landed and the office's prices have not been looked at since (U6's "Check the prices" gate). */
  pricesNeedReview: boolean
  /** The office's draft for this visit when start-quote was refused 409 — the U6 "Add my lines to it" prompt. Null otherwise. */
  pendingRebase: string | null
}

export type QuoteOpKind =
  | 'start_quote'
  | 'add_line'
  | 'edit_line'
  | 'remove_line'
  | 'add_option'
  | 'remove_option'
  | 'set_option_meta'
  | 'set_discount'
  | 'set_mode'
  | 'set_details'
  | 'line_order'

export type QuoteOpDifficulty = 'NORMAL' | 'DIFFICULT' | 'VERY_DIFFICULT'

/** What a line edit may change, and `expected`: the same fields as the phone's screen last showed them. */
export interface QuoteLinePatch {
  quantity?: number
  difficulty?: QuoteOpDifficulty
  option?: EstimateOptionLetter
  note?: string | null
  location?: string | null
}

/**
 * One queued edit's body — item ids, quantities, letters, names, the discount programme, and
 * `expected` (what the tech saw, for the server's replay rule). Never money: a queued edit is
 * what the tech asked for, and the server prices it when it lands.
 */
export type QuoteOpBody =
  | { kind: 'start_quote'; title?: string }
  | { kind: 'add_line'; lineId: string; itemId: string; quantity: number; difficulty?: QuoteOpDifficulty; option?: EstimateOptionLetter; note?: string | null; location?: string | null }
  | { kind: 'edit_line'; lineId: string; patch: QuoteLinePatch; expected?: QuoteLinePatch }
  | { kind: 'remove_line'; lineId: string }
  | { kind: 'add_option'; option: EstimateOptionLetter }
  | { kind: 'remove_option'; option: EstimateOptionLetter; expectedLines?: number }
  | { kind: 'set_option_meta'; option: EstimateOptionLetter; label: string; note: string; expected?: { label?: string | null; note?: string | null } }
  | { kind: 'set_discount'; type: 'military' | 'senior' | 'custom' | null; percent: number | null; expected?: { type?: 'military' | 'senior' | 'custom' | null; percent?: number | null } }
  | { kind: 'set_mode'; exclusive: boolean; expected?: { exclusive?: boolean } }
  | { kind: 'set_details'; title?: string; jobDescription?: string | null; expected?: { title?: string | null; jobDescription?: string | null } }
  | { kind: 'line_order'; order: Array<{ lineId: string; option: EstimateOptionLetter; was?: EstimateOptionLetter }> }

/**
 * A quote edit waiting to reach the office. An edit is NEVER changed after it is queued: a replay
 * sends exactly what the tech asked for, under the id the phone minted, so a lost answer lands on
 * the same row (constants.md idempotency convention).
 *
 * `seq` orders the edits within ONE draft — they replay strictly in that order, because a later
 * edit may depend on an earlier one (edit a line that was added with no signal). Drafts are
 * independent of each other.
 *
 * `status`: 'queued' waits for signal; 'refused' means the server said no with words (`refusal`)
 * and that draft's later edits wait for the tech to Discard it — a refusal is never retried on
 * its own; 'delivered' means the server took it (2xx) and the row only waits for the saved copy
 * to be refreshed from the office, after which it is deleted. A row is deleted ONLY after a 2xx,
 * a 404 on a remove (already gone = done), or an explicit Discard.
 */
export interface QuoteOpRecord {
  /** Client-minted UUID — the idempotency key for the replay. */
  opId: string
  draftId: string
  visitId: string
  seq: number
  kind: QuoteOpKind
  body: QuoteOpBody
  status: 'queued' | 'refused' | 'delivered'
  attempts: number
  lastError?: string
  /** The server's own words when it refused this edit. */
  refusal?: string
  /** The server's error code on a refusal ('conflict', 'line_gone', ...). */
  refusalCode?: string
  /** On a refused start-quote: the office's draft for this visit (409 `existingDraftId`). */
  existingDraftId?: string
  queuedAt: string
}

/**
 * A signature captured on this phone with no signal, waiting to become a record (Phase 7.2, U8).
 * SCHEMA ONLY in U4 — nothing writes it until U8. The drawn image rides in the SAME row as the
 * signer's name and what they signed, so the image can never come apart from its record.
 * `capturedAt` is the phone's clock; the server keeps its own receipt time beside it.
 */
export interface SignatureQueueRecord {
  signatureId: string
  estimateId: string
  visitId: string | null
  signerName: string
  /** Data URL, 400,000 characters at most. */
  signatureImage: string
  selectedOptions: string[]
  revision: number
  figuresKey: string
  /** The consent sentence the customer was shown, verbatim — the server refuses a mismatch. */
  consentText: string
  capturedAt: string
  state: 'queued' | 'recorded' | 'refused' | 'cancelled'
  reason?: string
  attempts: number
  lastError?: string
  queuedAt: string
}

/** `meta` key under which the saved price book's version, time and section cards live. */
export const QUOTE_CATALOG_META_KEY = 'quoteCatalog'

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
  diagnostics!: Table<DiagnosticRecord, string>
  diagnosticSyncQueue!: Table<DiagnosticSyncRecord, string>
  diagnosticPhotoQueue!: Table<DiagnosticPhotoRecord, string>
  quoteCatalog!: Table<QuoteCatalogRecord, string>
  quoteMirrors!: Table<QuoteMirrorRecord, string>
  quoteOpQueue!: Table<QuoteOpRecord, string>
  signatureQueue!: Table<SignatureQueueRecord, string>

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

    // v9: the circuit diagnostic (2026-09-20). Three store additions — the
    // report itself, its push queue and its photo queue. Pure addition, same
    // shape as v6/v7/v8, so there is no .upgrade() and nothing existing to
    // break: an app that never opens a diagnostic behaves exactly as it did.
    this.version(9).stores({
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
      diagnostics: 'reportId, visitId, status, updatedAt',
      diagnosticSyncQueue: 'reportId, queuedAt',
      diagnosticPhotoQueue: 'photoId, reportId, queuedAt',
    })

    // v10: estimating with no signal (Phase 7, 2026-10-09). Four store additions — the saved price
    // book, the saved copy of each quote, the queue of quote edits, and the queue of signatures
    // taken with no signal (schema only until U8). Pure addition, same shape as v6-v9, so there is
    // no .upgrade() and nothing existing to break: a phone that never builds a quote offline
    // behaves exactly as it did.
    this.version(10).stores({
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
      diagnostics: 'reportId, visitId, status, updatedAt',
      diagnosticSyncQueue: 'reportId, queuedAt',
      diagnosticPhotoQueue: 'photoId, reportId, queuedAt',
      quoteCatalog: 'itemId, category, position',
      quoteMirrors: 'draftId, visitId',
      quoteOpQueue: 'opId, draftId, seq, status, [draftId+seq]',
      signatureQueue: 'signatureId, estimateId, state',
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
