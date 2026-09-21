/**
 * THE CIRCUIT DIAGNOSTIC — the phone's half.
 *
 * Kyle, 2026-09-20: "he pulls up the diagnostics or run diagnostics, and can
 * click and add outlet button. This adds an outlet systematically as he is doing
 * the diagnostics, does the measurements at the outlet, takes the pictures,
 * notes if anything was fixed, and moves onto the next one."
 *
 * ── WHAT HAPPENS WHEN THE SIGNAL DROPS, WHICH IS MOST OF THE TIME ────────────
 * The answer is "nothing", and that is the design, not a happy accident:
 *
 *  1. The report is created LOCALLY with a phone-minted UUID. No network call
 *     starts a diagnostic, so a basement is not a blocker.
 *  2. Every edit — a new outlet, a reading, a note, a deletion — writes the
 *     whole report row to IndexedDB and re-queues ONE push row keyed by the
 *     report id (`put`, so the newest payload replaces the older one and the
 *     queue can never grow a tail of stale revisions).
 *  3. Every photo is written to db.photos and db.diagnosticPhotoQueue BEFORE
 *     any upload is attempted. The queue row is deleted only on a 2xx.
 *     (2026-09-11: four receipt photos were taken and lost because nothing did
 *     this. An outlet cannot exist without a photo, so this queue is the proof
 *     the box was ever opened.)
 *  4. Flushes fire on app start, on the browser `online` event, and after every
 *     local change. A failure records attempts/lastError and stays VISIBLE —
 *     `pendingDiagnosticCount()` is on the screen the whole time.
 *  5. The push is idempotent on the report id and its outlets sync by their own
 *     ids, so a retry lands on the same rows. The tech can walk the whole
 *     circuit offline and the finished report flushes whole.
 *
 * The one thing that needs signal is EMAILING the report to the homeowner: the
 * server renders the PDF, refuses an unfinished walk and logs the delivery, none
 * of which should happen silently hours later from a retry queue. Same call
 * Kyle's health report already makes.
 */

import { db, type DiagnosticPhotoRecord, type DiagnosticRecord, type DiagnosticSyncRecord } from '../db/database'
import { getCrmSettings } from './crmSync'
import {
  ZERO_TIERS,
  countByTier,
  coverageStatement,
  moneySummary,
  type DiagnosticDifficulty,
  type DiagnosticMoneySummary,
  type DiagnosticOutletPayload,
  type DiagnosticQuoteContext,
  type DiagnosticReportView,
} from '../../../shared/diagnostics'

export type {
  DiagnosticDifficulty,
  DiagnosticOutletPayload,
  DiagnosticQuoteContext,
  DiagnosticReportView,
} from '../../../shared/diagnostics'

async function diagnosticRequest<T>(path: string, init?: RequestInit): Promise<T> {
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

/** What the signed estimate bought, per tier — a PRE-FILL the tech confirms. */
export async function fetchDiagnosticContext(
  visitId: string,
): Promise<DiagnosticQuoteContext & { candidates: { itemId: string; description: string; quantity: number }[] }> {
  return diagnosticRequest(`/visits/${visitId}/diagnostic-context`, { method: 'GET' })
}

/** Diagnostics the office already has for this visit — so a tech resumes, never doubles up. */
export async function fetchDiagnosticReports(visitId: string): Promise<DiagnosticReportView[]> {
  const result = await diagnosticRequest<{ reports: DiagnosticReportView[] }>(
    `/visits/${visitId}/diagnostic-reports`,
    { method: 'GET' },
  )
  return result.reports
}

export function emptyOutlet(sequence: number): DiagnosticOutletPayload {
  return {
    id: crypto.randomUUID(),
    sequence,
    locationLabel: '',
    deviceType: 'receptacle',
    deviceLabel: null,
    enclosure: null,
    gangs: null,
    circuitNumber: null,
    difficulty: 'NORMAL',
    vPhaseGround: null,
    vPhaseNeutral: null,
    vPhasePhase: null,
    terminationsTightened: false,
    corrosion: false,
    corrosionNote: null,
    findings: null,
    fixed: null,
    equipmentDefective: false,
    defectDescription: null,
    photoIds: [],
  }
}

export interface StartDiagnosticInput {
  visitId: string
  complaint: string
  circuitLabel: string
  circuitNumber?: string | null
  panelLocation?: string | null
  breakerRating?: string | null
  diagnosticItemId?: string | null
  quoted?: { NORMAL: number; DIFFICULT: number; VERY_DIFFICULT: number }
}

/** Start one, locally. No network call — a diagnostic begins wherever the tech is standing. */
export async function startDiagnostic(input: StartDiagnosticInput): Promise<DiagnosticRecord> {
  const quoted = input.quoted ?? ZERO_TIERS
  const record: DiagnosticRecord = {
    reportId: crypto.randomUUID(),
    visitId: input.visitId,
    reportDate: new Date().toISOString(),
    complaint: input.complaint,
    circuitLabel: input.circuitLabel,
    circuitNumber: input.circuitNumber ?? null,
    panelLocation: input.panelLocation ?? null,
    breakerRating: input.breakerRating ?? null,
    breakerInspected: false,
    // The RCE standard is the default, because it is the standard: every box on
    // the circuit, breaker to last outlet. Claiming less is the deliberate act.
    coverage: 'whole_circuit',
    coverageNote: null,
    summary: null,
    diagnosticItemId: input.diagnosticItemId ?? null,
    quotedNormal: quoted.NORMAL,
    quotedDifficult: quoted.DIFFICULT,
    quotedVeryDifficult: quoted.VERY_DIFFICULT,
    status: 'in_progress',
    outlets: [],
    syncedAt: null,
    updatedAt: new Date().toISOString(),
  }
  await saveDiagnostic(record)
  return record
}

/**
 * Persist locally and re-queue the push. EVERY local change goes through here —
 * there is no path that edits a diagnostic without making it durable first.
 */
export async function saveDiagnostic(record: DiagnosticRecord): Promise<void> {
  const next: DiagnosticRecord = { ...record, updatedAt: new Date().toISOString(), syncedAt: null }
  await db.diagnostics.put(next)
  const queued: DiagnosticSyncRecord = {
    reportId: next.reportId,
    visitId: next.visitId,
    payload: JSON.stringify(buildDiagnosticPush(next)),
    attempts: 0,
    queuedAt: new Date().toISOString(),
  }
  // `put`, not `add`: one queue row per report. The newest payload replaces the
  // older one, so a circuit walked over an hour with no signal pushes once.
  await db.diagnosticSyncQueue.put(queued)
  void flushDiagnosticQueue()
}

export function buildDiagnosticPush(record: DiagnosticRecord): object {
  return {
    reportId: record.reportId,
    visitId: record.visitId,
    reportDate: record.reportDate,
    complaint: record.complaint,
    circuitLabel: record.circuitLabel,
    circuitNumber: record.circuitNumber,
    panelLocation: record.panelLocation,
    breakerRating: record.breakerRating,
    breakerInspected: record.breakerInspected,
    coverage: record.coverage,
    coverageNote: record.coverageNote,
    summary: record.summary,
    diagnosticItemId: record.diagnosticItemId,
    quotedNormal: record.quotedNormal,
    quotedDifficult: record.quotedDifficult,
    quotedVeryDifficult: record.quotedVeryDifficult,
    status: record.status,
    outlets: record.outlets,
    appVersion: `diagnostic · ${__BUILD_ID__}`,
  }
}

export function getDiagnostic(reportId: string): Promise<DiagnosticRecord | undefined> {
  return db.diagnostics.get(reportId)
}

export function localDiagnosticsForVisit(visitId: string): Promise<DiagnosticRecord[]> {
  return db.diagnostics.where('visitId').equals(visitId).toArray()
}

/**
 * Capture a photo at an outlet.
 *
 * The blob and the queue row are written BEFORE anything is attempted over the
 * wire, and the outlet gets the id immediately — so the photo counts as taken
 * from the moment the shutter closes, whatever the network does next.
 */
export async function captureOutletPhoto(
  reportId: string,
  outletId: string,
  blob: Blob,
): Promise<{ photoId: string }> {
  const photoId = crypto.randomUUID()
  await db.photos.put({ id: photoId, blob, mimeType: blob.type || 'image/jpeg' })
  const queued: DiagnosticPhotoRecord = {
    photoId,
    reportId,
    attempts: 0,
    queuedAt: new Date().toISOString(),
  }
  await db.diagnosticPhotoQueue.put(queued)

  const record = await db.diagnostics.get(reportId)
  if (record) {
    await saveDiagnostic({
      ...record,
      outlets: record.outlets.map((o) => (o.id === outletId ? { ...o, photoIds: [...o.photoIds, photoId] } : o)),
    })
  }
  void flushDiagnosticQueue()
  return { photoId }
}

/** A photo's exit, from the screen that shows it (Kyle's standing rule). */
export async function removeOutletPhoto(reportId: string, outletId: string, photoId: string): Promise<void> {
  const record = await db.diagnostics.get(reportId)
  if (record) {
    await saveDiagnostic({
      ...record,
      outlets: record.outlets.map((o) =>
        o.id === outletId ? { ...o, photoIds: o.photoIds.filter((id) => id !== photoId) } : o,
      ),
    })
  }
  await db.diagnosticPhotoQueue.delete(photoId)
  await db.photos.delete(photoId)
  // Best-effort on the server copy; the re-push above already detached it from
  // the outlet, so a failure here leaves an unreferenced row, never a wrong one.
  try {
    await diagnosticRequest(`/diagnostic-reports/${reportId}/photos/${photoId}`, { method: 'DELETE' })
  } catch {
    /* no signal — the outlet no longer points at it either way */
  }
}

/*
  A flush can be triggered from several places that overlap in time (every save,
  the online listener, app start). Two passes would both read the same pending
  row and push it twice — harmless, since the server upserts, but not free.

  THIS IS NOT THE RECEIPT QUEUE'S GUARD, AND THE DIFFERENCE MATTERS. A receipt is
  queued once and never again, so handing a second caller the in-flight promise
  is always right there. A DIAGNOSTIC is re-queued on every keystroke, so a run
  that started before the newest outlet existed can finish without ever having
  seen it — and a caller awaiting that run would be told "flushed" about data it
  had not written yet. (Caught by this file's own test, which pushed a photo and
  then asked for a flush: the report stayed queued and nothing ever came back
  for it.) So a request made DURING a run schedules one more pass, and every
  caller waits for the whole chain. Bounded: at most one extra pass per run,
  which converges because the queue only shrinks when pushes succeed.
*/
let diagnosticFlushInFlight: Promise<{ pushed: number; remaining: number }> | null = null
let diagnosticFlushRerun = false

export function flushDiagnosticQueue(): Promise<{ pushed: number; remaining: number }> {
  if (diagnosticFlushInFlight) {
    diagnosticFlushRerun = true
    return diagnosticFlushInFlight
  }
  const pass = (): Promise<{ pushed: number; remaining: number }> =>
    runDiagnosticFlush().then((result) => {
      if (!diagnosticFlushRerun) return result
      diagnosticFlushRerun = false
      return pass()
    })
  diagnosticFlushInFlight = pass().finally(() => {
    diagnosticFlushInFlight = null
    diagnosticFlushRerun = false
  })
  return diagnosticFlushInFlight
}

async function runDiagnosticFlush(): Promise<{ pushed: number; remaining: number }> {
  try {
    return await drainDiagnosticQueue()
  } catch {
    /*
      A DRAIN may fail; a CAPTURE may not. Nothing is swallowed here that was
      not already durable — every queue row stays exactly where it was and the
      next flush retries it. Catching matters because most calls are
      fire-and-forget (`void flushDiagnosticQueue()`), and an unhandled
      rejection from a background drain is noise that hides the failures the
      technician is actually shown (attempts / lastError, on screen).
    */
    return { pushed: 0, remaining: await db.diagnosticSyncQueue.count().catch(() => 0) }
  }
}

async function drainDiagnosticQueue(): Promise<{ pushed: number; remaining: number }> {
  if (!getCrmSettings()) {
    return { pushed: 0, remaining: await db.diagnosticSyncQueue.count() }
  }
  const pending = await db.diagnosticSyncQueue.orderBy('queuedAt').toArray()
  let pushed = 0
  for (const record of pending) {
    try {
      await diagnosticRequest('/diagnostic-reports', { method: 'POST', body: record.payload })
      // Only delete the queue row if the payload we just sent is still the
      // latest one. A save that landed mid-flight re-queued a newer payload and
      // that one must still go out.
      const current = await db.diagnosticSyncQueue.get(record.reportId)
      if (current && current.queuedAt === record.queuedAt) {
        await db.diagnosticSyncQueue.delete(record.reportId)
        const local = await db.diagnostics.get(record.reportId)
        if (local) await db.diagnostics.put({ ...local, syncedAt: new Date().toISOString() })
      }
      pushed += 1
    } catch (error) {
      await db.diagnosticSyncQueue.update(record.reportId, {
        attempts: record.attempts + 1,
        lastError: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Photos AFTER the reports, so the server-side report exists to hang them on.
  // A 404 here just means the report has not landed yet; the row stays queued.
  const settings = getCrmSettings()
  const pendingPhotos = await db.diagnosticPhotoQueue.orderBy('queuedAt').toArray()
  for (const record of pendingPhotos) {
    try {
      const photo = await db.photos.get(record.photoId)
      if (!photo) {
        // The bytes are gone from this device (IndexedDB eviction). The row is
        // NOT silently deleted — it stays visible with a reason, exactly as the
        // receipt queue does, because a human has to notice, not the retry loop.
        throw new Error('Photo bytes no longer on this device (evicted from local storage) — needs manual attention.')
      }
      const response = await fetch(
        `${settings!.baseUrl}/api/health-record/diagnostic-reports/${record.reportId}/photos/${record.photoId}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': photo.mimeType || 'image/jpeg',
            Authorization: `Bearer ${settings!.token}`,
          },
          body: photo.blob,
        },
      )
      if (!response.ok) throw new Error(`Photo upload failed (${response.status})`)
      await db.diagnosticPhotoQueue.delete(record.photoId)
    } catch (error) {
      await db.diagnosticPhotoQueue.update(record.photoId, {
        attempts: record.attempts + 1,
        lastError: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { pushed, remaining: await db.diagnosticSyncQueue.count() }
}

/** So the technician can SEE what has not gone up yet — the point of a queue. */
export async function pendingDiagnosticCount(): Promise<{ reports: number; photos: number }> {
  return {
    reports: await db.diagnosticSyncQueue.count(),
    photos: await db.diagnosticPhotoQueue.count(),
  }
}

/**
 * Hand the homeowner the report. Online only and deliberately NOT queued — the
 * server renders the PDF, refuses a walk that is not finished, and logs the
 * delivery. None of that should fire silently hours later from a retry.
 */
export async function emailDiagnosticToCustomer(reportId: string): Promise<{ sentTo: string; documentId: string }> {
  return diagnosticRequest(`/diagnostic-reports/${reportId}/email`, { method: 'POST', body: '{}' })
}

export interface ResolutionsResult {
  draftId: string
  resumed: boolean
  isChangeOrder: boolean
  changeOrderFor: string | null
  seeded: { difficulty: DiagnosticDifficulty; quantity: number; itemId: string }[]
  defects: { locationLabel: string; defectDescription: string }[]
  note: string | null
}

/** Build the resolutions change order from what was recorded. Needs signal (it prices). */
export async function buildResolutions(reportId: string): Promise<ResolutionsResult> {
  return diagnosticRequest(`/diagnostic-reports/${reportId}/resolutions`, { method: 'POST', body: '{}' })
}

/** Void it with a reason — the exit for a report that has been, or may have been, delivered. */
export async function voidDiagnostic(reportId: string, reason: string): Promise<DiagnosticReportView> {
  const view = await diagnosticRequest<DiagnosticReportView>(`/diagnostic-reports/${reportId}/void`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
  await db.diagnostics.delete(reportId)
  await db.diagnosticSyncQueue.delete(reportId)
  return view
}

/**
 * Delete one outright. The server refuses if the homeowner already has it (void
 * is the exit then) — so a local-only report is removed here even when the
 * server has never heard of it.
 */
export async function deleteDiagnostic(reportId: string): Promise<void> {
  try {
    await diagnosticRequest(`/diagnostic-reports/${reportId}`, { method: 'DELETE' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // "not found" means it never reached the office — dropping the local copy is
    // the whole delete. Anything else (already delivered) is a real refusal.
    if (!/not found/i.test(message)) throw error
  }
  const record = await db.diagnostics.get(reportId)
  for (const outlet of record?.outlets ?? []) {
    for (const photoId of outlet.photoIds) {
      await db.diagnosticPhotoQueue.delete(photoId)
      await db.photos.delete(photoId)
    }
  }
  await db.diagnostics.delete(reportId)
  await db.diagnosticSyncQueue.delete(reportId)
}

/** The money, computed the same way the server and the PDF compute it. */
export function localMoneySummary(record: DiagnosticRecord): DiagnosticMoneySummary {
  return moneySummary(
    {
      NORMAL: record.quotedNormal,
      DIFFICULT: record.quotedDifficult,
      VERY_DIFFICULT: record.quotedVeryDifficult,
    },
    countByTier(record.outlets),
  )
}

/** The sentence that will print on the face of the document, shown before it does. */
export function localCoverageStatement(record: DiagnosticRecord): string {
  return coverageStatement({
    coverage: record.coverage,
    coverageNote: record.coverageNote,
    circuitLabel: record.circuitLabel,
    breakerInspected: record.breakerInspected,
    examinedTotal: record.outlets.length,
  })
}

/**
 * What still has to be true before this can go to the homeowner. Shown on the
 * screen as a live list, so "mark complete" is never a guess — and the server
 * enforces the same rules again at the door.
 */
export function readyToComplete(record: DiagnosticRecord): string[] {
  const blockers: string[] = []
  if (record.outlets.length === 0) blockers.push('No outlets recorded yet.')
  if (record.coverage === 'partial' && !(record.coverageNote ?? '').trim()) {
    blockers.push('A partial walk has to say where it stopped and why.')
  }
  for (const outlet of record.outlets) {
    const where = outlet.locationLabel.trim() || `Outlet ${outlet.sequence}`
    if (!outlet.locationLabel.trim()) blockers.push(`Outlet ${outlet.sequence} has no location.`)
    if (outlet.photoIds.length === 0) blockers.push(`${where} has no photo — an outlet with no photo is a claim.`)
    if (outlet.equipmentDefective && !(outlet.defectDescription ?? '').trim()) {
      blockers.push(`${where}: say what is wrong with the equipment — that is what the change order quotes.`)
    }
  }
  return blockers
}

/** Retry queued diagnostics whenever connectivity returns. */
export function registerDiagnosticSyncListener(): void {
  window.addEventListener('online', () => {
    void flushDiagnosticQueue()
  })
}
