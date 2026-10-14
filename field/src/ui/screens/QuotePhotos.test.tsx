/**
 * "Photos for the estimate" on the field Quote screen, "Raise a change order" on the Job site
 * screen, and the photo count on the email button (2026-10-08, one-estimating-system plan, Phase 2
 * unit E). Static renders - the pieces a thumb lands on - plus the pure gate for the change-order
 * button. Every greyed control must carry its reason rather than disappear.
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QuotePhotos, PHOTOS_EMPTY, photosHint } from './QuotePhotos'
import { IssuedEstimatePanel } from './QuoteLifecycle'
import { changeOrderReasonFor } from './JobSiteScreen'
import { changeOrderBlockReason } from '../../../../shared/changeOrderBlock'
import { PHOTO_REMOVE_REFUSAL, type EstimatePhoto } from '../../../../shared/estimatePhotos'

const photo = (over: Partial<EstimatePhoto> = {}): EstimatePhoto => ({
  id: 'p1', caption: 'panel before', uploadedAt: '2026-10-08T15:00:00.000Z', visitId: 'v1', visitDate: '2026-10-08T15:00:00.000Z',
  jobLabel: 'Panel upgrade', address: '3 Extras Way, Murfreesboro', onThisVisit: true, canRemove: true, ...over,
})
const render = (over: Partial<Parameters<typeof QuotePhotos>[0]> = {}) =>
  renderToStaticMarkup(
    <QuotePhotos
      photos={[photo(), photo({ id: 'p2', caption: null, jobLabel: 'Service call', onThisVisit: false, canRemove: false })]}
      max={10}
      selected={[]}
      tickLockedReason={null}
      busy={false}
      loadPreview={async () => new Blob()}
      onToggle={() => {}}
      onAdd={async () => {}}
      onRemove={async () => {}}
      {...over}
    />,
  )

describe('QuotePhotos', () => {
  it('says what it is, what rides the email, and that nothing goes unless ticked', () => {
    const html = render()
    expect(html).toContain('Photos for the estimate')
    expect(html).toContain(photosHint(10).replace(/'/g, '&#x27;'))
    expect(html).toContain('None ticked - none will be sent (up to 10)')
  })

  it('offers the camera and the gallery - the existing job-photo picker, not a second one', () => {
    const html = render()
    expect(html).toContain('Take photo')
    expect(html).toContain('From gallery')
    expect(html).toContain('Caption for the next photo (optional)')
  })

  it('counts the ticked photos and marks each as sending', () => {
    const html = render({ selected: ['p1'] })
    expect(html).toContain('1 of 10 ticked to send')
    expect(html).toContain('sending')
  })

  it('a photo the tech took on this job has its remove button; other jobs and the office\'s do not, and the page says why', () => {
    const html = render()
    expect((html.match(/>remove</g) ?? []).length).toBe(1)
    expect(html).toContain('Photos from the job&#x27;s other visits, or added by the office, are removed from the office.')
    // The server's refusal sentence is the one the tech sees if the button is somehow pressed.
    expect(PHOTO_REMOVE_REFUSAL).toMatch(/Only the technician who took a photo can remove it/)
  })

  it('a signed estimate greys the ticks WITH the reason printed on the page', () => {
    const reason = 'This estimate is signed, so there is no estimate email left to send photos with.'
    const html = render({ tickLockedReason: reason })
    expect(html).toContain(reason)
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(2) // both thumbnails
  })

  it('at the cap of ten the unticked photos grey with the reason in their tooltip', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `x${i}`)
    const html = render({ selected: ten })
    expect(html).toContain('10 of 10 ticked to send')
    expect(html).toContain('Up to 10 photos ride one email - untick one first.')
  })

  it('when the JOB has more photos than the list, it says it shows only the newest', () => {
    const html = render({ total: 75 })
    expect(html).toContain('Showing the newest 2 of 75 photos on this job.')
    expect(render({ total: 2 })).not.toContain('Showing the newest')
  })

  it('ruling 2 (Kyle, 2026-10-09): the words say THIS JOB, never the account', () => {
    expect(photosHint(10)).toContain("Only this job's photos are here")
    expect(photosHint(10)).not.toMatch(/account/i)
    expect(PHOTOS_EMPTY).toMatch(/No photos on this job yet/)
    expect(PHOTOS_EMPTY).not.toMatch(/account/i)
  })

  it('empty job: says there is nothing to attach and how to add one; loading says loading', () => {
    expect(render({ photos: [] })).toContain(PHOTOS_EMPTY.replace(/'/g, '&#x27;'))
    expect(render({ photos: null })).toContain('Loading photos...')
  })
})

describe('IssuedEstimatePanel - the email button says how many photos ride it', () => {
  const issued = { estimateId: 'est-1', number: '2026-1098', revision: 1, status: 'sent', signedAt: null, issuedAt: '2026-10-01T12:00:00.000Z', validDays: 30, figuresKey: 'k', archived: false, customerUrl: 'https://x/e/t' }
  const panel = (photoCount?: number) =>
    renderToStaticMarkup(
      <IssuedEstimatePanel issued={issued} reviseReason={null} unpriced={[]} emailEstimate={async () => ({ to: 'x' })} emailFinancing={async () => ({ to: 'x' })} photoCount={photoCount} onEdit={() => {}} onBack={() => {}} />,
    )
  it('none ticked: the button reads as it always did', () => {
    expect(panel()).toContain('Email the estimate to the customer')
    expect(panel(0)).not.toContain('with 0 photo')
  })
  it('ticked: "(with N photos)", singular for one', () => {
    expect(panel(3)).toContain('(with 3 photos)')
    expect(panel(1)).toContain('(with 1 photo)')
    expect(panel(1)).not.toContain('(with 1 photos)')
  })
})

describe('changeOrderReasonFor - the Job site screen\'s "Raise a change order" gate', () => {
  const brief = (signedAt: string | null) => ({
    estimate: { number: '2026-1098', title: 'Panel', scopeText: null, signedAt, customerUrl: 'https://x/e/abc', lines: [] },
  })
  it('signed: available', () => {
    expect(changeOrderReasonFor(brief('2026-10-08T15:00:00Z'))).toBeNull()
  })
  it('issued but not signed: greyed with the office\'s sentence', () => {
    expect(changeOrderReasonFor(brief(null))).toBe(changeOrderBlockReason({ hasEstimate: true, signed: false }))
    expect(changeOrderReasonFor(brief(null))).toMatch(/Nothing is signed yet/)
  })
  it('no estimate, or the brief not loaded yet: greyed with a reason, never hidden', () => {
    expect(changeOrderReasonFor({ estimate: null })).toMatch(/No signed estimate on this record yet/)
    expect(changeOrderReasonFor(null)).toMatch(/Loading/)
  })
  it('the wording is the CRM button\'s, from one shared function', () => {
    expect(changeOrderBlockReason({ hasEstimate: true, status: 'void', signed: true })).toMatch(/void/)
    expect(changeOrderBlockReason({ hasEstimate: true, status: 'lost', signed: true })).toMatch(/marked lost/)
    expect(changeOrderBlockReason({ hasEstimate: true, status: 'signed', signed: true })).toBeNull()
  })
})

describe('QuotePhotos collapsible (builder) - 2026-10-08 review', () => {
  it('closed: one line naming how many are ticked, and none of the thumbnails or the upload controls', () => {
    const html = render({ collapsible: true, selected: ['p1'] })
    expect(html).toContain('Photos for the estimate (1 ticked)')
    expect(html).toContain('tap to open')
    expect(html).not.toContain('Caption for the next photo')
    expect(html).not.toContain('panel before')
  })
  it('not collapsible (the issued panel, next to the email button): open, as before', () => {
    const html = render()
    expect(html).toContain('Caption for the next photo')
    expect(html).not.toContain('tap to open')
  })
})
