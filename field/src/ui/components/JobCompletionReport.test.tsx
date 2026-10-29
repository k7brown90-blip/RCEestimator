/**
 * The Job completion report's rows and open line, as the tech sees them (Kyle, 2026-10-29). The
 * field suite renders static markup (no DOM), so the screen's pieces are pinned through the
 * presentational components; Save / Clear / Add photo themselves are pinned in
 * lib/completionReport.test.ts.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompletionLineEditor, CompletionLineRow } from './JobCompletionReport'
import { draftFromLine } from '../../lib/completionReport'
import type { CompletionLineView } from '../../../../shared/jobCompletion'

const line = (over: Partial<CompletionLineView> = {}): CompletionLineView => ({
  lineId: 'line-1',
  documentId: 'doc-1',
  documentNumber: '2026-1122',
  documentKind: 'invoice',
  option: 'A',
  name: 'Replace 20A GFCI receptacle',
  quantity: 1,
  defaultNecRefs: ['210.8(A)'],
  entry: null,
  ...over,
})
const entry = {
  explanation: 'Replaced and tested.',
  necRefs: ['210.8(A)'],
  readings: [{ label: 'Voltage', value: '121', unit: 'V' }],
  photoIds: ['p-1'],
  updatedBy: 'tech:t1',
  updatedAt: '2026-10-29T15:00:00.000Z',
}
const noop = () => undefined
const editor = (l: CompletionLineView, extra: Partial<Parameters<typeof CompletionLineEditor>[0]> = {}) =>
  renderToStaticMarkup(
    <CompletionLineEditor
      line={l}
      draft={draftFromLine(l)}
      onDraft={noop}
      visitId="visit-1"
      photos={[]}
      photosNote={null}
      busy={false}
      photoBusy={false}
      error={null}
      note={null}
      onSave={noop}
      onClear={noop}
      onPhoto={noop}
      {...extra}
    />,
  )

describe('CompletionLineRow', () => {
  it('a line with no write-up says "Not written up yet"', () => {
    const html = renderToStaticMarkup(<CompletionLineRow line={line()} open={false} onToggle={noop} />)
    expect(html).toContain('Replace 20A GFCI receptacle')
    expect(html).toContain('Not written up yet')
    expect(html).toContain('Write up')
  })
  it('a written-up line says so, with its readings and photos counted', () => {
    const html = renderToStaticMarkup(<CompletionLineRow line={line({ entry })} open={false} onToggle={noop} />)
    expect(html).toContain('Written up · 1 reading · 1 photo')
    expect(html).not.toContain('Not written up yet')
  })
  it('a change order line is named "change order NNNN"', () => {
    const html = renderToStaticMarkup(<CompletionLineRow line={line({ documentKind: 'change_order', documentNumber: '2026-1122-CO1' })} open={false} onToggle={noop} />)
    expect(html).toContain('change order 2026-1122-CO1')
  })
})

describe('CompletionLineEditor', () => {
  it('carries the labelled controls the tech uses', () => {
    const html = editor(line())
    for (const words of ['What was done and why', 'NEC articles', '+ Add article', 'Readings', '+ Add reading', 'Photos', 'Add photo — camera', 'Add photo — gallery', '>Save<', '>Clear<']) {
      expect(html).toContain(words)
    }
  })
  it("NEC articles start from the price book's article, each with a × to take it off", () => {
    const html = editor(line())
    expect(html).toContain('value="210.8(A)"')
    expect(html).toContain('Remove NEC article 210.8(A)')
  })
  it('Clear is greyed with its reason while nothing is written up, and live once something is', () => {
    const blank = editor(line())
    expect(blank).toMatch(/<button[^>]*disabled=""[^>]*>Clear<\/button>/)
    expect(blank).toContain('Nothing is written up on this line yet')
    expect(editor(line({ entry }))).not.toMatch(/<button[^>]*disabled=""[^>]*>Clear<\/button>/)
  })
  it('Save is greyed WITH the reason on the page when there is nothing to save', () => {
    const html = editor(line())
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/)
    expect(html).toContain('Write what was done and why, add a reading or add a photo first.')
  })
  it("shows a photo on the line with a ×, and the phone's other job photos to pick", () => {
    const l = line({ entry })
    const html = editor(l, { photos: [{ id: 'p-1', caption: 'before', tag: null, uploadedAt: '2026-10-29T14:00:00Z' }, { id: 'p-2', caption: 'after', tag: null, uploadedAt: '2026-10-29T14:05:00Z' }] })
    expect(html).toContain('Remove photo before')
    expect(html).toContain('Or pick a photo already taken on this job')
    expect(html).toContain('Add photo after')
    expect(html).not.toContain('Add photo before')
    // each photo is drawn as a thumbnail box (the picture itself loads with the bearer header)
    expect(html.match(/h-14 w-14/g)?.length).toBe(2)
  })
  it("says why when this job's photos cannot be listed", () => {
    expect(editor(line(), { photosNote: "No signal — this job's photos can't be listed until you have signal." })).toContain("can&#x27;t be listed until you have signal")
  })
  it("shows the server's refusal message on the open line", () => {
    const html = editor(line(), { error: 'A photo you picked is not on this job.' })
    expect(html).toContain('A photo you picked is not on this job.')
  })
})

describe('where it sits on the Job site screen', () => {
  const source = readFileSync(new URL('../screens/JobSiteScreen.tsx', import.meta.url), 'utf8')
  it('renders for a job only, above "Mark job complete"', () => {
    expect(source).toContain('{isJob && <JobCompletionReport visitId={assignment.visitId} />}')
    expect(source.indexOf('<JobCompletionReport visitId')).toBeLessThan(source.indexOf("'Mark job complete'"))
  })
})
