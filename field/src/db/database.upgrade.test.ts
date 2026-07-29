/**
 * Dexie v3 → v4 upgrade.
 *
 * The riskiest code in the app: it runs unattended on a technician's phone, and
 * every write path validates with zod, so a row left half-migrated throws on the
 * next save — potentially mid-job. These tests exercise the upgrade against a
 * real v3 database rather than a mock.
 */

import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { propertySchema } from '../domain/schemas'

const DB_NAME = 'upgrade-test'

/** The v3 schema exactly as it shipped — properties had no CRM link required. */
async function seedV3(rows: Record<string, unknown>[]): Promise<void> {
  const legacy = new Dexie(DB_NAME)
  legacy.version(3).stores({
    properties: 'id, address, jurisdictionId, createdAt',
    inspections: 'id, propertyId, jurisdictionId, date, technician, status, [propertyId+date]',
    photos: 'id, mimeType',
    syncQueue: 'inspectionId, queuedAt',
    photoSyncQueue: 'photoId, inspectionId, queuedAt',
  })
  await legacy.open()
  await legacy.table('properties').bulkPut(rows)
  legacy.close()
}

/** The v4 schema + upgrade, mirroring src/db/database.ts. */
function openV4(): Dexie {
  const db = new Dexie(DB_NAME)
  db.version(3).stores({
    properties: 'id, address, jurisdictionId, createdAt',
    inspections: 'id, propertyId, jurisdictionId, date, technician, status, [propertyId+date]',
    photos: 'id, mimeType',
    syncQueue: 'inspectionId, queuedAt',
    photoSyncQueue: 'photoId, inspectionId, queuedAt',
  })
  db.version(4)
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
      for (const row of await properties.toArray()) {
        try {
          const patch: Record<string, unknown> = {}
          if (!row.crm) patch.legacy = true
          if (!row.jurisdictionSource) patch.jurisdictionSource = 'default'
          if (Object.keys(patch).length > 0) {
            await properties.update(row.id as string, patch)
          }
        } catch (error) {
          await tx.table('corrupt').put({
            id: String(row.id),
            table: 'properties',
            raw: JSON.stringify(row),
            error: error instanceof Error ? error.message : String(error),
            quarantinedAt: new Date().toISOString(),
          })
        }
      }
    })
  return db
}

/** v5 and v6 stores, mirroring src/db/database.ts. */
const STORES_V5 = {
  properties: 'id, address, jurisdictionId, createdAt, crm.visitId, legacy',
  inspections: 'id, propertyId, jurisdictionId, date, technician, status, scope, [propertyId+date]',
  photos: 'id, mimeType',
  syncQueue: 'inspectionId, queuedAt',
  photoSyncQueue: 'photoId, inspectionId, queuedAt',
  assignments: 'visitId, assignmentId, scheduledStart, cachedAt',
  meta: 'key',
  corrupt: 'id, table, quarantinedAt',
}

const STORES_V6 = {
  ...STORES_V5,
  findings: 'id, propertyId, itemId, status, track, [propertyId+status]',
  findingActionQueue: 'actionId, findingId, kind, queuedAt',
}

afterEach(async () => {
  await Dexie.delete(DB_NAME)
})

const crmProperty = {
  id: 'p-crm',
  address: '605 Green Farm Way, Murfreesboro, TN 37130',
  jurisdictionId: 'murfreesboro',
  createdAt: '2026-07-01T00:00:00.000Z',
  crm: { visitId: 'v1', propertyId: 'prop1', customerId: 'c1', customerName: 'Hollis' },
}

const freeTypedProperty = {
  id: 'p-free',
  address: '12hk jgv',
  jurisdictionId: 'rutherford',
  createdAt: '2026-06-01T00:00:00.000Z',
}

describe('v3 → v4 property migration', () => {
  it('marks a free-typed property legacy instead of deleting it', async () => {
    // Deleting would orphan the photo evidence hanging off it.
    await seedV3([freeTypedProperty])
    const db = openV4()
    await db.open()

    const row = await db.table('properties').get('p-free')
    expect(row.legacy).toBe(true)
    expect(row.address).toBe('12hk jgv')
    db.close()
  })

  it('leaves a CRM-linked property selectable', async () => {
    await seedV3([crmProperty])
    const db = openV4()
    await db.open()

    const row = await db.table('properties').get('p-crm')
    expect(row.legacy).toBeUndefined()
    expect(row.crm.visitId).toBe('v1')
    db.close()
  })

  it('backfills jurisdictionSource as default, so the app admits it was never set', async () => {
    await seedV3([crmProperty, freeTypedProperty])
    const db = openV4()
    await db.open()

    for (const id of ['p-crm', 'p-free']) {
      expect((await db.table('properties').get(id)).jurisdictionSource).toBe('default')
    }
    db.close()
  })

  it('produces rows the v4 schema actually accepts', async () => {
    // The real failure mode: an upgraded row that still fails propertySchema
    // would throw on the technician's next save.
    await seedV3([crmProperty])
    const db = openV4()
    await db.open()

    const row = await db.table('properties').get('p-crm')
    expect(() => propertySchema.parse(row)).not.toThrow()
    db.close()
  })

  it('does not claim a legacy row is a valid v4 property', async () => {
    await seedV3([freeTypedProperty])
    const db = openV4()
    await db.open()

    const row = await db.table('properties').get('p-free')
    // It survives in the database but must never be handed to the picker.
    expect(propertySchema.safeParse(row).success).toBe(false)
    expect(row.legacy).toBe(true)
    db.close()
  })

  it('migrates a mixed database in one pass without losing rows', async () => {
    await seedV3([crmProperty, freeTypedProperty, { ...freeTypedProperty, id: 'p-free-2' }])
    const db = openV4()
    await db.open()

    expect(await db.table('properties').count()).toBe(3)
    const legacyCount = (await db.table('properties').toArray()).filter((r) => r.legacy).length
    expect(legacyCount).toBe(2)
    db.close()
  })

  it('opens the new tables the offline queue needs', async () => {
    await seedV3([crmProperty])
    const db = openV4()
    await db.open()

    await db.table('assignments').put({ visitId: 'v1', assignmentId: 'a1', cachedAt: 'now' })
    await db.table('meta').put({ key: 'me', value: { name: 'Michael' }, updatedAt: 'now' })
    expect(await db.table('assignments').count()).toBe(1)
    expect((await db.table('meta').get('me')).value.name).toBe('Michael')
    db.close()
  })

  it('is idempotent — reopening an already-migrated database changes nothing', async () => {
    await seedV3([freeTypedProperty])
    const first = openV4()
    await first.open()
    const afterFirst = await first.table('properties').get('p-free')
    first.close()

    const second = openV4()
    await second.open()
    expect(await second.table('properties').get('p-free')).toEqual(afterFirst)
    second.close()
  })

  it('carries a v5 database up to v6 without losing anything', async () => {
    // v6 adds the finding-ledger stores and nothing else — no data migration, so
    // the risk isn't corruption, it's a version chain that fails to open at all
    // and takes the technician's queued work with it.
    await seedV3([crmProperty])
    const v5 = openV4()
    v5.version(5).stores(STORES_V5)
    await v5.open()
    await v5.table('syncQueue').put({
      inspectionId: 'insp-queued', visitId: 'v1', payload: '{}', attempts: 0, queuedAt: 'now',
    })
    v5.close()

    const v6 = openV4()
    v6.version(5).stores(STORES_V5)
    v6.version(6).stores(STORES_V6)
    await v6.open()

    // Nothing queued is lost by the upgrade.
    expect(await v6.table('syncQueue').count()).toBe(1)
    expect((await v6.table('properties').get('p-crm')).crm.visitId).toBe('v1')

    // And the new stores are usable.
    await v6.table('findings').put({
      id: 'f1', propertyId: 'prop1', itemId: 'C4', locationKey: '_default', cycle: 1,
      track: 'defect', title: 'MBJ', section: null, citations: [], citationsAvailable: false,
      severity: 'FAIL', critical: true, findingText: 'x', resolutionNote: null,
      expectedEolYear: null, status: 'open', openedAt: 'now', observedCount: 1,
      declinedByName: null, declinedByRelation: null, declinedVerbatim: null, cachedAt: 'now',
    })
    await v6.table('findingActionQueue').put({
      actionId: 'a1', findingId: 'f1', kind: 'cure_claim', payload: '{}', attempts: 0, queuedAt: 'now',
    })
    expect(await v6.table('findings').where('propertyId').equals('prop1').count()).toBe(1)
    expect(await v6.table('findingActionQueue').count()).toBe(1)
    v6.close()
  })

  it('preserves an inspection draft across the upgrade', async () => {
    await seedV3([crmProperty])
    const legacy = new Dexie(DB_NAME)
    legacy.version(3).stores({
      properties: 'id, address, jurisdictionId, createdAt',
      inspections: 'id, propertyId, jurisdictionId, date, technician, status, [propertyId+date]',
      photos: 'id, mimeType',
      syncQueue: 'inspectionId, queuedAt',
      photoSyncQueue: 'photoId, inspectionId, queuedAt',
    })
    await legacy.open()
    await legacy.table('inspections').put({
      id: 'insp-1', propertyId: 'p-crm', jurisdictionId: 'murfreesboro',
      technician: 'Michael', date: '2026-07-26T00:00:00.000Z',
      items: [], score: 87, itemsAssessed: 0, criticalFindings: [],
      contractorReviewed: false, status: 'draft',
    })
    legacy.close()

    const db = openV4()
    await db.open()
    const draft = await db.table('inspections').get('insp-1')
    expect(draft.status).toBe('draft')
    expect(draft.propertyId).toBe('p-crm')
    db.close()
  })
})
