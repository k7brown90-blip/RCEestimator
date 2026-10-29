/**
 * The Job completion report, field door - the logic the screen runs, kept out of the component so
 * the suite (static markup, no DOM) can pin it (Kyle, 2026-10-29: "Each separate line item can get
 * photos and an explination of what was done and why.").
 *
 * Types and limits come from app/shared (types as `import type` only - shared/jobCompletion.ts
 * pulls in zod and the field has its own zod; the limits file is zod-free). The API calls are the
 * crmSync ones; the rules (empty entry, limits, "photo of THIS job") are enforced by the server and
 * only mirrored here so the screen can say why a button is greyed.
 */

import type { CompletionEntryBody, CompletionLineView, CompletionReading } from '../../../shared/jobCompletion'
import {
  MAX_COMPLETION_PHOTOS,
  MAX_NEC_REFS,
  MAX_READINGS,
} from '../../../shared/jobCompletionLimits'
import { CrmRequestError, isNetworkFailure, uploadJobPhoto } from './crmSync'

/** What the tech is editing on one line. NEC refs and readings may hold half-typed rows. */
export interface CompletionDraft {
  explanation: string
  necRefs: string[]
  readings: CompletionReading[]
  photoIds: string[]
}

/** Shown when a save / clear / load cannot reach the office. Nothing is queued - the tech saves again. */
export const NO_SIGNAL_SAVE = 'No signal — save again when you have signal.'
export const NO_SIGNAL_PHOTO = 'No signal — add the photo again when you have signal.'
export const NO_SIGNAL_LIST = "No signal — this job's photos can't be listed until you have signal."
export const NO_SIGNAL_LOAD = 'No signal — the completion report needs signal to open. Try again when you have bars.'
export const NOT_WRITTEN_UP = 'Not written up yet'
export const CLEAR_NEEDS_ENTRY = 'Nothing is written up on this line yet, so there is nothing to clear.'

/** Opening a line: the saved entry, else a blank one that starts with the price book's NEC article. */
export function draftFromLine(line: CompletionLineView): CompletionDraft {
  const entry = line.entry
  return {
    explanation: entry?.explanation ?? '',
    // `entry?.necRefs ?? defaultNecRefs`: a saved entry with NO articles is a deliberate "no citation" and stays empty.
    necRefs: [...(entry?.necRefs ?? line.defaultNecRefs)],
    readings: (entry?.readings ?? []).map((r) => ({ ...r })),
    photoIds: [...(entry?.photoIds ?? [])],
  }
}

/** Rows the tech added and left blank are dropped, not sent. */
function filledReadings(readings: CompletionReading[]): CompletionReading[] {
  return readings.filter((r) => r.label.trim() !== '' || r.value.trim() !== '' || r.unit.trim() !== '')
}

/** Why Save is greyed, or null when it can be pressed. Mirrors the server's "not empty" rule and the readings rule. */
export function saveBlockReason(draft: CompletionDraft): string | null {
  const readings = filledReadings(draft.readings)
  if (readings.some((r) => r.label.trim() === '' || r.value.trim() === '')) {
    return 'Each reading needs a label and a value — finish it or remove it.'
  }
  if (draft.explanation.trim() === '' && readings.length === 0 && draft.photoIds.length === 0) {
    return 'Write what was done and why, add a reading or add a photo first.'
  }
  return null
}

/** The PUT body: trimmed, blank NEC articles and blank reading rows dropped. */
export function bodyFromDraft(draft: CompletionDraft): CompletionEntryBody {
  return {
    explanation: draft.explanation.trim(),
    necRefs: draft.necRefs.map((n) => n.trim()).filter((n) => n !== ''),
    readings: filledReadings(draft.readings).map((r) => ({ label: r.label.trim(), value: r.value.trim(), unit: r.unit.trim() })),
    photoIds: draft.photoIds,
  }
}

export function writtenUpCount(lines: CompletionLineView[]): number {
  return lines.filter((l) => l.entry !== null).length
}

/** "2 of 5 lines written up". */
export function writtenUpWords(lines: CompletionLineView[]): string {
  return `${writtenUpCount(lines)} of ${lines.length} line${lines.length === 1 ? '' : 's'} written up`
}

/** The row's title: the customer-facing name, with the change order's number when it is one. */
export function lineTitle(line: CompletionLineView): string {
  return line.quantity > 1 ? `${line.name} × ${line.quantity}` : line.name
}
export function lineSource(line: CompletionLineView): string | null {
  return line.documentKind === 'change_order' ? `change order ${line.documentNumber}` : null
}

export function canAddNecRef(draft: CompletionDraft): boolean {
  return draft.necRefs.length < MAX_NEC_REFS
}
export function canAddReading(draft: CompletionDraft): boolean {
  return draft.readings.length < MAX_READINGS
}
export function photoRoom(draft: CompletionDraft): number {
  return MAX_COMPLETION_PHOTOS - draft.photoIds.length
}
export const PHOTO_LIMIT_REASON = `A line holds at most ${MAX_COMPLETION_PHOTOS} photos — take one off to add another.`

/** The words for a failed call: no signal says so and that nothing was lost; a refusal keeps the office's own message. */
export function completionFailureWords(err: unknown, verb: 'save' | 'clear' | 'load' | 'photo' | 'list'): string {
  if (isNetworkFailure(err)) {
    return verb === 'load' ? NO_SIGNAL_LOAD : verb === 'photo' ? NO_SIGNAL_PHOTO : verb === 'list' ? NO_SIGNAL_LIST : NO_SIGNAL_SAVE
  }
  if (err instanceof CrmRequestError || err instanceof Error) return err.message
  return String(err)
}

/**
 * "Add photo": goes up through the SAME job-photo upload as the Job photos section (no second
 * uploader), and the new photo's id is put on the draft - the line saves it with Save. Throws
 * whatever the upload throws (the caller shows it). A photo already on the draft is not doubled.
 */
export async function addPhotoToDraft(visitId: string, file: Blob, draft: CompletionDraft, caption?: string): Promise<CompletionDraft> {
  if (photoRoom(draft) <= 0) throw new Error(PHOTO_LIMIT_REASON)
  const photoId = await uploadJobPhoto(visitId, file, caption)
  return draft.photoIds.includes(photoId) ? draft : { ...draft, photoIds: [...draft.photoIds, photoId] }
}
